// api/webhook.js
const { bot } = require("../support-bot");

module.exports = async (req, res) => {
  try {
    // healthcheck
    if (req.method === "GET") {
      res.status(200).send("OK");
      return;
    }
    if (req.method !== "POST") {
      res.status(405).send("Method Not Allowed");
      return;
    }

    // optional secret token check
    const secret = process.env.WEBHOOK_SECRET;
    if (secret) {
      const got = req.headers["x-telegram-bot-api-secret-token"];
      if (got !== secret) {
        res.status(401).send("Unauthorized");
        return;
      }
    }

    // body
    const update = typeof req.body === "string" ? JSON.parse(req.body) : req.body;

    // IMPORTANT: process update
    await bot.processUpdate(update);

    res.status(200).send("OK");
  } catch (e) {
    // Telegram лучше вернуть 200, чтобы не зацикливать повторы на старых апдейтах.
    console.error("webhook error:", e?.message || e);
    res.status(200).send("OK");
  }
};
