// api/webhook.js
const { bot } = require("../support-bot");

async function readJson(req) {
  if (req.body && typeof req.body === "object") return req.body;

  const chunks = [];
  for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

module.exports = async (req, res) => {
  try {
    if (req.method === "GET") {
      return res.status(200).send("ok");
    }
    if (req.method !== "POST") {
      return res.status(405).send("Method Not Allowed");
    }

    const update = await readJson(req);

    // Очень важно: быстро отдаём 200.
    // processUpdate запускает хендлеры, но мы их не await'им.
    bot.processUpdate(update);

    return res.status(200).send("OK");
  } catch (e) {
    // Telegram должен получить 200, иначе будет долбить ретраями
    return res.status(200).send("OK");
  }
};
