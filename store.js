// store.js
const { Redis } = require("@upstash/redis");

const hasUpstash =
  !!process.env.UPSTASH_REDIS_REST_URL && !!process.env.UPSTASH_REDIS_REST_TOKEN;

const redis = hasUpstash
  ? new Redis({
      url: process.env.UPSTASH_REDIS_REST_URL,
      token: process.env.UPSTASH_REDIS_REST_TOKEN,
    })
  : null;

// fallback (не для продакшена)
const mem = new Map();
let memCounters = new Map();

async function get(key) {
  if (redis) return await redis.get(key);
  return mem.has(key) ? mem.get(key) : null;
}

async function set(key, value) {
  if (redis) {
    await redis.set(key, value);
    return;
  }
  mem.set(key, value);
}

async function del(key) {
  if (redis) {
    await redis.del(key);
    return;
  }
  mem.delete(key);
}

async function incr(key) {
  if (redis) return await redis.incr(key);
  const cur = Number(memCounters.get(key) || 0) + 1;
  memCounters.set(key, cur);
  return cur;
}

module.exports = { get, set, del, incr, hasUpstash };
