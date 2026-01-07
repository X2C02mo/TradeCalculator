// api/webhook.js
const { bot } = require("../support-bot");

module.exports = async (req, res) => {
  try {
    if (req.method === "GET") {
      res.status(200).send("OK");
      return;
    }
    if (req.method !== "POST") {
      res.status(405).send("Method Not Allowed");
      return;
    }

    // optional secret token check (быстро, до ответа)
    const secret = process.env.WEBHOOK_SECRET;
    if (secret) {
      const got = req.headers["x-telegram-bot-api-secret-token"];
      if (got !== secret) {
        res.status(401).send("Unauthorized");
        return;
      }
    }

    const update = typeof req.body === "string" ? JSON.parse(req.body) : req.body;

    res.status(200).send("OK");

    // и уже после ответа обрабатываем апдейт
    Promise.resolve()
      .then(() => bot.processUpdate(update))
      .catch((e) => console.error("processUpdate error:", e?.message || e));
  } catch (e) {
    console.error("webhook error:", e?.message || e);
    
    res.status(200).send("OK");
  }
};
