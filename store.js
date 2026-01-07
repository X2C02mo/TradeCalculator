
const { Redis } = require("@upstash/redis");

const hasUpstash =
  !!process.env.UPSTASH_REDIS_REST_URL && !!process.env.UPSTASH_REDIS_REST_TOKEN;

const redis = hasUpstash
  ? new Redis({
      url: process.env.UPSTASH_REDIS_REST_URL,
      token: process.env.UPSTASH_REDIS_REST_TOKEN
    })
  : null;

// fallback (НЕ для продакшена) — слетает при рестартах/серверлесс-вызываниях
const mem = new Map();

function encode(value) {
  if (value === undefined) return null;
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function decode(raw) {
  if (raw === null || raw === undefined) return null;
  if (typeof raw !== "string") return raw; // на всякий случай (если клиент вернёт объект)
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

async function get(key) {
  const raw = redis ? await redis.get(key) : (mem.has(key) ? mem.get(key) : null);
  return decode(raw);
}

async function set(key, value) {
  const payload = encode(value);
  if (redis) {
    await redis.set(key, payload);
    return;
  }
  mem.set(key, payload);
}

async function del(key) {
  if (redis) {
    await redis.del(key);
    return;
  }
  mem.delete(key);
}

module.exports = { get, set, del, hasUpstash };
