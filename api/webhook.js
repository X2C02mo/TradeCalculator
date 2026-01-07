// api/webhook.js
const { handleUpdate } = require("../support-bot");

async function readJson(req) {
  // Vercel иногда даёт req.body, иногда нет — делаем надёжно.
  if (req.body && typeof req.body === "object") return req.body;

  let raw = "";
  for await (const chunk of req) raw += chunk;
  if (!raw) return null;

  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

module.exports = async (req, res) => {
  // Telegram шлёт POST. На GET просто отвечаем 200.
  if (req.method !== "POST") {
    res.status(200).send("OK");
    return;
  }

  // (опционально) защита webhook секретом
  const secret = process.env.WEBHOOK_SECRET;
  if (secret) {
    const hdr = req.headers["x-telegram-bot-api-secret-token"];
    if (hdr !== secret) {
      res.status(401).send("unauthorized");
      return;
    }
  }

  const update = await readJson(req);

  try {
    await handleUpdate(update);
    res.status(200).send("OK");
  } catch (err) {
    console.error("webhook error:", err);
    // Важно: 500 => Telegram ретраит, и апдейты не теряются.
    res.status(500).send("ERR");
  }
};
