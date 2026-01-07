const { bot } = require("../support-bot");

module.exports = async (req, res) => {
  // отвечаем мгновенно
  res.status(200).send("OK");

  try {
    if (req.method !== "POST") return;
    const update = typeof req.body === "string" ? JSON.parse(req.body) : req.body;
    bot.processUpdate(update);
  } catch (e) {
    console.error("[api/webhook] error:", e);
  }
};
