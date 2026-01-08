const TelegramBot = require('node-telegram-bot-api');

const TOKEN = process.env.TELEGRAM_TOKEN;
if (!TOKEN) {
  console.error('TELEGRAM_TOKEN is not set');
  process.exit(1);
}

const bot = new TelegramBot(TOKEN, { polling: true });

const MINI_APP_URL = (process.env.MINI_APP_URL || 'https://trade-calculator-five.vercel.app/').replace(/\/?$/, '/');
const CHANNEL_URL = process.env.CHANNEL_URL || 'https://t.me/InvestTraderTrade';
const SUPPORT = process.env.SUPPORT || '@Trader_TradeSupportBot';

const START_IMAGE = process.env.START_IMAGE_FILE_ID || 'AgACAgIAAxkBAAMaaVaWeFmSspKIZuXdEQdNMFFv-gQAAhcTaxt-6rFKr0HOjIiv95gBAAMCAAN5AAM4BA';

const TEXT = {
  ru: `📊 *Trader Calculator*

Мини-приложение для трейдеров:
• DCA калькулятор
• Risk / Reward
• Капитал и индикаторы рынка

🚀 Открой Mini App и считай сделки быстрее.

По вопросам — ${SUPPORT}`,
  en: `📊 *Trader Calculator*

Mini app for traders:
• DCA calculator
• Risk / Reward
• Capital & indicators

🚀 Open Mini App and calculate faster.

Support — ${SUPPORT}`
};

function getLang(msg) {
  const code = (msg.from && msg.from.language_code) ? String(msg.from.language_code) : '';
  return /^ru/i.test(code) ? 'ru' : 'en';
}

bot.onText(/\/start/, async (msg) => {
  const chatId = msg.chat.id;
  const lang = getLang(msg);

  await bot.sendPhoto(chatId, START_IMAGE, {
    caption: TEXT[lang],
    parse_mode: 'Markdown',
    reply_markup: {
      inline_keyboard: [
        [
          {
            text: lang === 'ru' ? '🚀 Открыть калькулятор' : '🚀 Open calculator',
            web_app: { url: MINI_APP_URL }
          }
        ],
        [
          {
            text: lang === 'ru' ? '📢 Telegram канал' : '📢 Telegram channel',
            url: CHANNEL_URL
          }
        ]
      ]
    }
  });
});

console.log('Bot is running...');

bot.on('polling_error', (err) => console.error('Polling error:', err?.message || err));
bot.on('webhook_error', (err) => console.error('Webhook error:', err?.message || err));

// Railway-friendly health endpoint (не мешает polling)
const http = require('http');
const PORT = process.env.PORT || 3000;
http.createServer((req, res) => {
  res.writeHead(200, {'Content-Type': 'text/plain'});
  res.end('ok');
}).listen(PORT, () => console.log('Health server on', PORT));



