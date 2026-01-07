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

// fallback (НЕ ок для прода) — слетает на холодных стартах
const mem = new Map();

function tryJsonParse(v) {
  if (v == null) return null;
  if (typeof v === "object") return v;
  if (typeof v !== "string") return v;
  const s = v.trim();
  if (!s) return v;
  if ((s.startsWith("{") && s.endsWith("}")) || (s.startsWith("[") && s.endsWith("]"))) {
    try {
      return JSON.parse(s);
    } catch {
      return v;
    }
  }
  return v;
}

function toStorable(value) {
  if (value == null) return value;
  if (typeof value === "string") return value;
  return JSON.stringify(value);
}

/**
 * get(key) -> any|null
 */
async function get(key) {
  if (redis) return tryJsonParse(await redis.get(key));
  return mem.has(key) ? tryJsonParse(mem.get(key)) : null;
}

/**
 * set(key, value, { ex?: seconds, nx?: boolean }) -> Redis result-like
 * - nx=true: set only if not exists (для дедупликации апдейтов)
 * - ex: TTL seconds
 */
async function set(key, value, opts = {}) {
  const v = toStorable(value);

  if (redis) {
    const params = {};
    if (opts.ex) params.ex = opts.ex;
    if (opts.nx) params.nx = true;
    // Upstash вернёт "OK" или null (если nx и ключ уже был)
    return await redis.set(key, v, Object.keys(params).length ? params : undefined);
  }

  if (opts.nx && mem.has(key)) return null;
  mem.set(key, v);

  if (opts.ex) {
    const t = setTimeout(() => mem.delete(key), opts.ex * 1000);
    if (t.unref) t.unref();
  }

  return "OK";
}

async function del(key) {
  if (redis) return await redis.del(key);
  mem.delete(key);
  return 1;
}

async function incr(key) {
  if (redis) return await redis.incr(key);
  const cur = Number(mem.get(key) || 0);
  const next = (Number.isFinite(cur) ? cur : 0) + 1;
  mem.set(key, String(next));
  return next;
}

module.exports = { get, set, del, incr, hasUpstash };
