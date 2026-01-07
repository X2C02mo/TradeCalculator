// api/webhook.js
const { bot } = require("../support-bot.js");

function readRaw(req) {
  return new Promise((resolve) => {
    let data = "";
    req.on("data", (chunk) => (data += chunk));
    req.on("end", () => resolve(data));
    req.on("error", () => resolve(""));
  });
}

module.exports = async (req, res) => {
  // Быстрый ответ Telegram — даже если внутри ошибка
  try {
    if (req.method === "GET") {
      res.status(200).send("OK");
      return;
    }

    if (req.method !== "POST") {
      res.status(405).send("Method Not Allowed");
      return;
    }

    // Vercel иногда даёт уже распарсенный body, иногда нет — делаем безопасно
    let update = req.body;

    if (!update || typeof update !== "object") {
      const raw = await readRaw(req);
      if (raw) {
        try {
          update = JSON.parse(raw);
        } catch (e) {
          update = null;
        }
      }
    }

    if (!update) {
      res.status(200).send("OK");
      return;
    }

    // обработку запускаем, и сразу отвечаем
    bot.processUpdate(update);
    res.status(200).send("OK");
  } catch (e) {
    // Telegram не должен получать 500
    res.status(200).send("OK");
  }
};
