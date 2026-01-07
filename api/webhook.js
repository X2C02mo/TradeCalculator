// api/webhook.js
const { bot } = require("../support-bot");

module.exports = async (req, res) => {
  try {
    if (req.method === "GET") {
      return res.status(200).send("ok");
    }

    if (req.method !== "POST") {
      return res.status(405).send("Method Not Allowed");
    }

    const update = req.body || {};
    bot.processUpdate(update);

    return res.status(200).send("OK");
  } catch (e) {
    return res.status(200).send("OK"); // Telegram важнее получить 200 быстро
  }
};
