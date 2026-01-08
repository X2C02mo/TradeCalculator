// api/webhook.js
const { createSupportBot } = require("../support-bot");

const bot = createSupportBot();

async function readJsonBody(req) {
  if (req.body && typeof req.body === "object") return req.body;
  if (typeof req.body === "string" && req.body.length) {
    try { return JSON.parse(req.body); } catch { return null; }
  }
  // fallback: read stream
  const chunks = [];
  for await (const c of req) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c));
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

module.exports = async (req, res) => {
  try {
    if (req.method === "GET") {
      return res.status(200).send("ok");
    }

    if (req.method !== "POST") {
      return res.status(405).send("Method Not Allowed");
    }

    // Verify secret token header (Telegram sends it if you set secret_token in setWebhook)
    const expected = process.env.WEBHOOK_SECRET;
    if (expected) {
      const got =
        req.headers["x-telegram-bot-api-secret-token"] ||
        req.headers["X-Telegram-Bot-Api-Secret-Token"];

      if (!got || got !== expected) {
        return res.status(401).send("Unauthorized");
      }
    }

    const update = await readJsonBody(req);
    if (!update) return res.status(400).send("Bad Request");

    await bot.handleUpdate(update);
    return res.status(200).send("OK");
  } catch (e) {
    console.error("WEBHOOK_ERROR", e);
    // важно: 200, чтобы Telegram не долбил ретраями бесконечно.
    return res.status(200).send("OK");
  }
};
