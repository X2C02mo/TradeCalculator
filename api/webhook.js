// api/webhook.js
const { createSupportBot } = require("../support-bot");

const bot = createSupportBot();
const BUILD = process.env.BUILD_VERSION || "no-build";

async function readJson(req) {
  if (req.body && typeof req.body === "object") return req.body;

  const chunks = [];
  for await (const c of req) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c));
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw) return null;

  try { return JSON.parse(raw); } catch { return null; }
}

module.exports = async (req, res) => {
  try {
    if (req.method === "GET") {
      return res.status(200).send(`ok ${BUILD}`);
    }
    if (req.method !== "POST") return res.status(405).send("Method Not Allowed");

    const expected = process.env.WEBHOOK_SECRET;
    if (expected) {
      const got = req.headers["x-telegram-bot-api-secret-token"];
      if (got !== expected) return res.status(401).send("Unauthorized");
    }

    const update = await readJson(req);
    if (!update) return res.status(400).send("Bad Request");

    await bot.handleUpdate(update);
    return res.status(200).send("OK");
  } catch (e) {
    console.error("WEBHOOK_FATAL", e);
    // чтобы Telegram не долбил ретраями бесконечно во время фикса:
    return res.status(200).send("OK");
  }
};
