// store.js
const { Redis } = require("@upstash/redis");

function createStore() {
  const redis = new Redis({
    url: process.env.UPSTASH_REDIS_REST_URL,
    token: process.env.UPSTASH_REDIS_REST_TOKEN
  });

  async function getJson(key) {
    const v = await redis.get(key);
    if (v == null) return null;
    if (typeof v === "string") {
      try { return JSON.parse(v); } catch { return null; }
    }
    return v;
  }

  async function setJson(key, obj, exSeconds) {
    const payload = JSON.stringify(obj);
    if (exSeconds) return redis.set(key, payload, { ex: exSeconds });
    return redis.set(key, payload);
  }

  async function del(key) {
    return redis.del(key);
  }

  async function setOnce(key, value, exSeconds = 120) {
    const res = await redis.set(key, value, { nx: true, ex: exSeconds });
    return res === "OK";
  }

  return { getJson, setJson, del, setOnce };
}

module.exports = { createStore };
