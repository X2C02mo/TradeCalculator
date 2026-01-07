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

// fallback (для тестов). На Vercel может сбрасываться при холодном старте.
const mem = new Map();

function encode(v) {
  return JSON.stringify(v);
}
function decode(v) {
  if (v === null || v === undefined) return null;
  if (typeof v !== "string") return v;
  try { return JSON.parse(v); } catch { return v; }
}

async function get(key) {
  if (redis) return decode(await redis.get(key));
  return mem.has(key) ? mem.get(key) : null;
}

async function set(key, value) {
  if (redis) {
    await redis.set(key, encode(value));
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
