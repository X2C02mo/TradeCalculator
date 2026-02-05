const TelegramBot = require('node-telegram-bot-api');
const http = require('http');

const TOKEN = process.env.TELEGRAM_TOKEN;
if (!TOKEN) {
  console.error('TELEGRAM_TOKEN is not set');
  process.exit(1);
}

const bot = new TelegramBot(TOKEN);

const MINI_APP_URL = (process.env.MINI_APP_URL || 'https://trade-calculator-five.vercel.app/').replace(/\/?$/, '/');
const CHANNEL_URL = process.env.CHANNEL_URL || 'https://t.me/ChalovCrypto';
const SUPPORT = process.env.SUPPORT || '@Trader_TradeSupportBot';
const START_IMAGE = process.env.START_IMAGE_FILE_ID || 'AgACAgIAAxkBAAMaaVaWeFmSspKIZuXdEQdNMFFv-gQAAhcTaxt-6rFKr0HOjIiv95gBAAMCAAN5AAM4BA';

function escapeHtml(s = '') {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function supportLink() {
  const raw = String(SUPPORT || '').trim();
  if (!raw) return '—';

  if (/^https?:\/\//i.test(raw)) {
    return `<a href="${escapeHtml(raw)}">${escapeHtml(raw)}</a>`;
  }

  const username = raw.replace(/^@/, '');
  return `<a href="https://t.me/${encodeURIComponent(username)}">${escapeHtml(raw.startsWith('@') ? raw : '@' + username)}</a>`;
}

function getLang(msg) {
  const code = msg?.from?.language_code ? String(msg.from.language_code) : '';
  return /^ru/i.test(code) ? 'ru' : 'en';
}

function buildCaption(lang) {
  if (lang === 'ru') {
    return (
      `📊 <b>Trader Calculator</b>\n\n` +
      `Мини-приложение для трейдеров:\n` +
      `• DCA калькулятор\n` +
      `• Risk / Reward\n` +
      `• Капитал и индикаторы рынка\n\n` +
      `🚀 Открой Mini App и считай сделки быстрее.\n\n` +
      `По вопросам — ${supportLink()}`
    );
  }

  return (
    `📊 <b>Trader Calculator</b>\n\n` +
    `Mini app for traders:\n` +
    `• DCA calculator\n` +
    `• Risk / Reward\n` +
    `• Capital & indicators\n\n` +
    `🚀 Open Mini App and calculate faster.\n\n` +
    `Support — ${supportLink()}`
  );
}

bot.onText(/^\/start(?:\s+.*)?$/i, async (msg) => {
  const chatId = msg.chat.id;
  const lang = getLang(msg);

  const replyMarkup = {
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
  };

  const caption = buildCaption(lang);

  try {
    await bot.sendPhoto(chatId, START_IMAGE, {
      caption,
      parse_mode: 'HTML',
      reply_markup: replyMarkup
    });
  } catch (e) {
    console.error('sendPhoto failed:', e?.message || e);
   
    try {
      await bot.sendMessage(chatId, caption, {
        parse_mode: 'HTML',
        reply_markup: replyMarkup,
        disable_web_page_preview: true
      });
    } catch (e2) {
      console.error('sendMessage failed:', e2?.message || e2);
    }
  }
});

bot.on('photo', (msg) => {
  const chatId = msg.chat.id;
  const photoFileId = msg.photo[msg.photo.length - 1].file_id;
  console.log('Получен file_id фотографии:', photoFileId);
  bot.sendMessage(chatId, `File_id фотографии: ${photoFileId}`);
});

bot.on('document', (msg) => {
  if (msg.document.mime_type && msg.document.mime_type.startsWith('image/')) {
    const documentFileId = msg.document.file_id;
    console.log('Получен file_id изображения-документа:', documentFileId);
    bot.sendMessage(msg.chat.id, `File_id изображения-документа: ${documentFileId}`);
  }
});

const PORT = process.env.PORT || 3000;
const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('ok');
}).listen(PORT, () => console.log('Health server listening on port', PORT));

bot.on('polling_error', (err) => console.error('Polling error:', err?.message || err));
bot.on('webhook_error', (err) => console.error('Webhook error:', err?.message || err));
process.on('unhandledRejection', (err) => console.error('UnhandledRejection:', err));
process.on('uncaughtException', (err) => console.error('UncaughtException:', err));

console.log('Bot is starting polling...');
bot.startPolling();