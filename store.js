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

// fallback (не прод) — слетает при рестартах
const mem = new Map();

function safeParse(v) {
  if (v === null || v === undefined) return null;
  if (typeof v !== "string") return v;
  try { return JSON.parse(v); } catch { return v; }
}

async function get(key) {
  if (redis) return safeParse(await redis.get(key));
  return mem.has(key) ? mem.get(key) : null;
}

async function set(key, value, ttlSec = null) {
  if (redis) {
    const payload = JSON.stringify(value);
    if (ttlSec) await redis.set(key, payload, { ex: ttlSec });
    else await redis.set(key, payload);
    return;
  }
  mem.set(key, value);
  if (ttlSec) setTimeout(() => mem.delete(key), ttlSec * 1000);
}

async function del(key) {
  if (redis) { await redis.del(key); return; }
  mem.delete(key);
}

// атомарный rate limit: SET key NX EX ttl
async function setNX(key, value, ttlSec) {
  if (redis) {
    const payload = JSON.stringify(value);
    const ok = await redis.set(key, payload, { nx: true, ex: ttlSec });
    return ok === "OK";
  }
  if (mem.has(key)) return false;
  mem.set(key, value);
  setTimeout(() => mem.delete(key), (ttlSec || 1) * 1000);
  return true;
}

module.exports = { get, set, del, setNX, hasUpstash };
