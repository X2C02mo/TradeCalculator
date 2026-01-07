const { bot } = require("../support-bot");

module.exports = async (req, res) => {
  if (req.method === "GET") {
    res.status(200).send("OK");
    return;
  }

  if (req.method !== "POST") {
    res.status(405).send("Method Not Allowed");
    return;
  }

  try {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const raw = Buffer.concat(chunks).toString("utf8");
    const update = raw ? JSON.parse(raw) : {};

    bot.processUpdate(update);
    res.status(200).send("ok");
  } catch (e) {
    console.error("webhook error:", e);
    // Telegram должен получить 200, иначе будут ретраи
    res.status(200).send("ok");
  }
};
