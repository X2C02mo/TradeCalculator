// store.js
const { Redis } = require("@upstash/redis");

const hasUpstash =
  !!process.env.UPSTASH_REDIS_REST_URL && !!process.env.UPSTASH_REDIS_REST_TOKEN;

const redis = hasUpstash
  ? new Redis({
      url: process.env.UPSTASH_REDIS_REST_URL,
      token: process.env.UPSTASH_REDIS_REST_TOKEN
    })
  : null;

// fallback (не продакшен): слетает на рестартах/на серверлесах
const mem = new Map();

function nowMs() {
  return Date.now();
}

function memGet(key) {
  const rec = mem.get(key);
  if (!rec) return null;
  if (rec.exp && rec.exp <= nowMs()) {
    mem.delete(key);
    return null;
  }
  return rec.value;
}

function memSet(key, value, opts) {
  let exp = null;
  if (opts?.px) exp = nowMs() + Number(opts.px);
  else if (opts?.ex) exp = nowMs() + Number(opts.ex) * 1000;
  mem.set(key, { value, exp });
}

async function get(key) {
  if (redis) return await redis.get(key);
  return memGet(key);
}

async function set(key, value, opts) {
  if (redis) {
    // @upstash/redis умеет JSON values и opts типа { ex: 10 }
    if (opts && typeof opts === "object") return await redis.set(key, value, opts);
    return await redis.set(key, value);
  }
  memSet(key, value, opts);
}

async function del(key) {
  if (redis) return await redis.del(key);
  mem.delete(key);
}

module.exports = { get, set, del, hasUpstash };
