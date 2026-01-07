// lib/store.js
const { Redis } = require("@upstash/redis");

const hasUpstash =
  !!process.env.UPSTASH_REDIS_REST_URL && !!process.env.UPSTASH_REDIS_REST_TOKEN;

const redis = hasUpstash
  ? new Redis({
      url: process.env.UPSTASH_REDIS_REST_URL,
      token: process.env.UPSTASH_REDIS_REST_TOKEN
    })
  : null;

// fallback (НЕ для продакшена) — слетает при рестартах
const mem = new Map();

async function get(key) {
  if (redis) return await redis.get(key);
  return mem.has(key) ? mem.get(key) : null;
}

async function set(key, value) {
  if (redis) {
    // храним JSON
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

module.exports = { get, set, del, hasUpstash };
