// store.js
const URL = process.env.UPSTASH_REDIS_REST_URL;
const TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;

function must(v, name) {
  if (!v) throw new Error(`Missing env: ${name}`);
  return v;
}

must(URL, "UPSTASH_REDIS_REST_URL");
must(TOKEN, "UPSTASH_REDIS_REST_TOKEN");

// Upstash REST: https://<host>/<command>/<arg1>/<arg2> with Bearer token :contentReference[oaicite:4]{index=4}
async function redis(cmd, ...args) {
  const path = [cmd, ...args].map(a => encodeURIComponent(String(a))).join("/");
  const res = await fetch(`${URL}/${path}`, {
    method: "GET",
    headers: { Authorization: `Bearer ${TOKEN}` }
  });
  const json = await res.json();
  if (!res.ok || json?.error) throw new Error(json?.error || `Upstash error (${res.status})`);
  return json.result;
}

async function pipeline(commands) {
  const res = await fetch(`${URL}/pipeline`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(commands)
  });
  const json = await res.json();
  if (!res.ok) throw new Error(`Upstash pipeline error (${res.status})`);
  // each item: { result } or { error } :contentReference[oaicite:5]{index=5}
  for (const item of json) {
    if (item?.error) throw new Error(item.error);
  }
  return json.map(i => i.result);
}

export async function getJSON(key) {
  const val = await redis("get", key);
  if (val == null) return null;
  try { return JSON.parse(val); } catch { return null; }
}

export async function setJSON(key, obj) {
  return redis("set", key, JSON.stringify(obj));
}

export async function setJSONEX(key, seconds, obj) {
  // SETEX key seconds value :contentReference[oaicite:6]{index=6}
  return redis("setex", key, seconds, JSON.stringify(obj));
}

export async function delKey(key) {
  return redis("del", key);
}

export async function multi(commands) {
  return pipeline(commands);
}
