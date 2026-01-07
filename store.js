
const { Redis } = require("@upstash/redis");

const hasUpstash =
  !!process.env.UPSTASH_REDIS_REST_URL && !!process.env.UPSTASH_REDIS_REST_TOKEN;

const redis = hasUpstash
  ? new Redis({
      url: process.env.UPSTASH_REDIS_REST_URL,
      token: process.env.UPSTASH_REDIS_REST_TOKEN
    })
  : null;


const mem = new Map();


function encode(value) {
  if (value === undefined) return null;
  if (typeof value === "string") return value;
  return JSON.stringify(value);
}

function decode(value) {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") return value;

  const s = value.trim();
  if (!s) return "";

  const c = s[0];
  // JSON/number/bool/null
  if (
    c === "{" ||
    c === "[" ||
    c === '"' ||
    c === "-" ||
    (c >= "0" && c <= "9") ||
    s === "true" ||
    s === "false" ||
    s === "null"
  ) {
    try {
      return JSON.parse(s);
    } catch (_) {
      // если не JSON — вернём как строку
      return value;
    }
  }

  return value;
}

async function get(key) {
  if (redis) return decode(await redis.get(key));
  return mem.has(key) ? mem.get(key) : null;
}

async function set(key, value, opts = undefined) {
  const v = encode(value);
  if (redis) {
    // opts: { ex: seconds }
    await redis.set(key, v, opts);
    return;
  }
  mem.set(key, decode(v));
}

async function del(key) {
  if (redis) {
    await redis.del(key);
    return;
  }
  mem.delete(key);
}

module.exports = { get, set, del, hasUpstash };
