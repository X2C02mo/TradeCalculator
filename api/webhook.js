// api/webhook.js
const { bot } = require("../support-bot");

module.exports = async (req, res) => {
  try {
    if (req.method !== "POST") {
      res.status(200).send("OK");
      return;
    }

    const update = typeof req.body === "string" ? JSON.parse(req.body) : req.body;
    bot.processUpdate(update);

    res.status(200).send("OK");
  } catch (e) {
    console.error("[api/webhook] error:", e);
    res.status(200).send("OK"); // Telegram должен получить 200
  }
};
