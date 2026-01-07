
const { bot } = require("../support-bot");

module.exports = async (req, res) => {
  try {
    if (req.method !== "POST") {
      res.status(200).send("ok");
      return;
    }


    const secretExpected = process.env.WEBHOOK_SECRET;
    if (secretExpected) {
      const secretGot = req.headers["x-telegram-bot-api-secret-token"];
      if (secretGot !== secretExpected) {
        res.status(401).send("unauthorized");
        return;
      }
    }

    // быстро принять update
    const update = req.body;
    bot.processUpdate(update);

    res.status(200).send("ok");
  } catch (e) {

    res.status(200).send("ok");
  }
};
