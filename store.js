// store.js
const { Redis } = require("@upstash/redis");

function safeJsonParse(s) {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

function createStore() {
  const hasUpstash =
    !!process.env.UPSTASH_REDIS_REST_URL && !!process.env.UPSTASH_REDIS_REST_TOKEN;

  const redis = hasUpstash
    ? new Redis({
        url: process.env.UPSTASH_REDIS_REST_URL,
        token: process.env.UPSTASH_REDIS_REST_TOKEN
      })
    : null;

  // fallback (не надёжен в serverless, но лучше чем падать)
  const mem = new Map();

  async function getRaw(key) {
    if (redis) return await redis.get(key);
    return mem.get(key);
  }

  async function setRaw(key, value, exSeconds) {
    if (redis) {
      if (exSeconds) return await redis.set(key, value, { ex: exSeconds });
      return await redis.set(key, value);
    }
    mem.set(key, value);
    if (exSeconds) {
      setTimeout(() => mem.delete(key), exSeconds * 1000).unref?.();
    }
    return "OK";
  }

  async function del(key) {
    if (redis) return await redis.del(key);
    mem.delete(key);
    return 1;
  }

  async function getJson(key) {
    const v = await getRaw(key);
    if (v == null) return null;
    if (typeof v === "string") return safeJsonParse(v) ?? v;
    return v;
  }

  async function setJson(key, obj, exSeconds) {
    const payload = JSON.stringify(obj);
    return await setRaw(key, payload, exSeconds);
  }

  // set if not exists (для дедупликации апдейтов и т.п.)
  async function setOnce(key, value, exSeconds) {
    if (redis) {
      // NX поддерживается через опции
      const res = await redis.set(key, value, { nx: true, ex: exSeconds ?? 60 });
      // Upstash вернёт "OK" или null
      return res === "OK";
    }
    if (mem.has(key)) return false;
    await setRaw(key, value, exSeconds ?? 60);
    return true;
  }

  return { getJson, setJson, del, setOnce };
}

module.exports = { createStore };
