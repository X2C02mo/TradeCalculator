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

// fallback (не прод): слетает при рестартах
const mem = new Map();

function jparse(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === "object") return v; // Upstash иногда возвращает объект
  try {
    return JSON.parse(v);
  } catch {
    return null;
  }
}
function jstring(v) {
  return JSON.stringify(v);
}

async function getJSON(key) {
  if (redis) return jparse(await redis.get(key));
  return mem.has(key) ? mem.get(key) : null;
}

async function setJSON(key, value, opts = {}) {
  if (redis) {
    // opts: { ex, nx }
    return await redis.set(key, jstring(value), opts);
  }
  mem.set(key, value);
  return "OK";
}

async function del(key) {
  if (redis) return await redis.del(key);
  mem.delete(key);
}

async function setNXEX(key, value, exSeconds) {
  if (redis) {
    // one-call rate limit / lock
    const res = await redis.set(key, value, { nx: true, ex: exSeconds });
    return !!res; // true if lock acquired
  }
  const now = Date.now();
  const prev = mem.get(key);
  if (prev && now < prev.expiresAt) return false;
  mem.set(key, { value, expiresAt: now + exSeconds * 1000 });
  return true;
}

module.exports = { hasUpstash, getJSON, setJSON, del, setNXEX };
