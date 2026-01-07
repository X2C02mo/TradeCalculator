// support-bot.js
const TelegramBot = require("node-telegram-bot-api");
const store = require("./store");

function mustInt(name, v) {
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`${name} must be a number`);
  return n;
}

const BOT_TOKEN = process.env.SUPPORT_BOT_TOKEN;
if (!BOT_TOKEN) throw new Error("SUPPORT_BOT_TOKEN is not set");

const SUPPORT_GROUP_ID = mustInt("SUPPORT_GROUP_ID", process.env.SUPPORT_GROUP_ID);

// optional: "123,456"
const ADMIN_USER_IDS = (process.env.ADMIN_USER_IDS || "")
  .split(",")
  .map((x) => x.trim())
  .filter(Boolean)
  .map((x) => Number(x))
  .filter((x) => Number.isFinite(x));

function isAdmin(userId) {
  if (!ADMIN_USER_IDS.length) return true;
  return ADMIN_USER_IDS.includes(Number(userId));
}

// UX / speed knobs
const RATE_LIMIT_MS = Number(process.env.RATE_LIMIT_MS || 1200);
const RATE_WARN_MS = Number(process.env.RATE_WARN_MS || 6000);
const ACK_COOLDOWN_MS = Number(process.env.ACK_COOLDOWN_MS || 15000);
const CLOCK_SKEW_RESET_MS = 30000;

// IMPORTANT: webhook mode
const bot = new TelegramBot(BOT_TOKEN, { polling: false });

// ---- wrapper to prevent crashes ----
const wrap = (fn) => async (...args) => {
  try {
    await fn(...args);
  } catch (e) {
    console.error("HANDLER_ERROR:", e?.message || e, e?.stack || "");
  }
};

// ---------- keys ----------
const kTicket = (userId) => `ticket:${userId}`;
const kTopic = (topicId) => `topic:${topicId}`;
const kMap = (chatId, messageId) => `map:${chatId}:${messageId}`;
const kLang = (userId) => `lang:${userId}`;
const kLastOk = (userId) => `rlok:${userId}`;
const kLastWarn = (userId) => `rlw:${userId}`;
const kLastAck = (userId) => `ack:${userId}`;

// ---------- helpers ----------
function safeUsername(u) {
  if (!u) return "";
  if (u.username) return `@${u.username}`;
  const name = [u.first_name, u.last_name].filter(Boolean).join(" ").trim();
  return name || "";
}

function detectDefaultLang(user) {
  const code = (user?.language_code || "").toLowerCase();
  if (/^ru|uk|be/.test(code)) return "ru";
  return "en";
}

function t(lang, key) {
  const dict = {
    ru: {
      chooseLang: "Выбери язык общения:",
      needLang: "Сначала выбери язык кнопками ниже.",
      ready: "Готово. Отправь вопрос сообщением — я передам в поддержку.\nКоманды: /new /status",
      startText:
        "👋 Trade Support\n\nОтправь сюда вопрос — я создам тикет и передам в поддержку. Ответ придёт сюда же.\n\nКоманды: /new /status",
      tooFast: "⏳ Слишком часто. Подожди пару секунд и отправь снова.",
      accepted: "✅ Принято. Передал в поддержку.",
      newTicket: "✅ Создан новый тикет. Отправь сообщение.\nTicket: #",
      statusNone: "У тебя нет активных заявок. Нажми /new или просто отправь сообщение.",
      statusOpen: "📌 Твой тикет активен",
      errForumOff:
        "⚠️ В группе поддержки выключены Темы (Forum topics) или боту не дали право создавать темы.\nАдмину: включить Topics и дать боту права.",
      errBusy: "⚠️ Поддержка сейчас перегружена. Попробуй чуть позже."
    },
    en: {
      chooseLang: "Choose language:",
      needLang: "Please choose language using buttons below first.",
      ready: "Done. Send your question as a message — I’ll forward it to support.\nCommands: /new /status",
      startText:
        "👋 Trade Support\n\nSend your question here — I’ll create a ticket and forward it to support. Reply will come here.\n\nCommands: /new /status",
      tooFast: "⏳ Too fast. Wait a moment and send again.",
      accepted: "✅ Received. Forwarded to support.",
      newTicket: "✅ New ticket created. Send a message.\nTicket: #",
      statusNone: "No active tickets. Use /new or just send a message.",
      statusOpen: "📌 Your ticket is active",
      errForumOff:
        "⚠️ Support group has Topics disabled, or bot lacks permissions.\nAdmin: enable Topics and allow the bot to manage topics.",
      errBusy: "⚠️ Support is busy right now. Try again later."
    }
  };
  return dict[lang]?.[key] || key;
}

async function getUserLang(userId, userObjForDetect = null) {
  const saved = await store.get(kLang(userId));
  if (saved === "ru" || saved === "en") return saved;
  return detectDefaultLang(userObjForDetect);
}

async function setUserLang(userId, lang) {
  if (lang !== "ru" && lang !== "en") return;
  await store.set(kLang(userId), lang);
}

// rate limit: returns { limited, warn }
async function rateLimit(userId) {
  const now = Date.now();
  const lastOkRaw = await store.get(kLastOk(userId));
  let lastOk = Number(lastOkRaw || 0);

  if (lastOk > now + CLOCK_SKEW_RESET_MS) {
    lastOk = 0;
    await store.set(kLastOk(userId), 0);
  }

  if (now - lastOk < RATE_LIMIT_MS) {
    const lastWarnRaw = await store.get(kLastWarn(userId));
    const lastWarn = Number(lastWarnRaw || 0);
    const shouldWarn = now - lastWarn >= RATE_WARN_MS;
    if (shouldWarn) await store.set(kLastWarn(userId), now);
    return { limited: true, warn: shouldWarn };
  }

  await store.set(kLastOk(userId), now);
  return { limited: false, warn: false };
}

async function maybeAck(userId) {
  const now = Date.now();
  const lastAckRaw = await store.get(kLastAck(userId));
  const lastAck = Number(lastAckRaw || 0);
  if (now - lastAck >= ACK_COOLDOWN_MS) {
    await store.set(kLastAck(userId), now);
    return true;
  }
  return false;
}

async function getTicket(userId) {
  return await store.get(kTicket(userId));
}

async function setTicket(userId, data) {
  await store.set(kTicket(userId), data);
}

async function ensureTicket(user, lang) {
  const userId = user.id;
  const existing = await getTicket(userId);
  if (existing?.topicId && existing?.status === "open") return existing.topicId;

  const titleRaw = `u${userId} ${safeUsername(user)}`.trim();
  const title = titleRaw.length > 120 ? titleRaw.slice(0, 120) : titleRaw;

  const created = await bot.createForumTopic(SUPPORT_GROUP_ID, title);
  const topicId = created.message_thread_id;

  const ticket = {
    topicId,
    createdAt: Date.now(),
    lastUserMsgAt: null,
    lastSupportMsgAt: null,
    status: "open"
  };

  await setTicket(userId, ticket);
  await store.set(kTopic(topicId), userId);

  const header = await bot.sendMessage(
    SUPPORT_GROUP_ID,
    `🆕 New ticket\nUser: ${safeUsername(user)}\nID: ${userId}`,
    { message_thread_id: topicId }
  );

  await store.set(kMap(SUPPORT_GROUP_ID, header.message_id), userId);
  return topicId;
}

async function copyUserMessageToTopic(msg, topicId) {
  const copied = await bot.copyMessage(SUPPORT_GROUP_ID, msg.chat.id, msg.message_id, {
    message_thread_id: topicId
  });

  await store.set(kMap(SUPPORT_GROUP_ID, copied.message_id), msg.from.id);

  const ticket = await getTicket(msg.from.id);
  if (ticket) {
    ticket.lastUserMsgAt = Date.now();
    await setTicket(msg.from.id, ticket);
  }
}

// ---------- /start with language choice ----------
bot.onText(/^\/start(?:\s+(.+))?$/, wrap(async (msg) => {
  if (msg.chat.type !== "private") return;

  const userId = msg.from.id;
  const saved = await store.get(kLang(userId));

  if (saved === "ru" || saved === "en") {
    await bot.sendMessage(msg.chat.id, t(saved, "startText"));
    return;
  }

  const d = detectDefaultLang(msg.from);
  await bot.sendMessage(msg.chat.id, t(d, "chooseLang"), {
    reply_markup: {
      inline_keyboard: [
        [{ text: "1) English", callback_data: "lang:en" }],
        [{ text: "2) Русский", callback_data: "lang:ru" }]
      ]
    }
  });
}));

bot.on("callback_query", wrap(async (cq) => {
  const data = cq.data || "";
  const chatId = cq.message?.chat?.id;
  const userId = cq.from?.id;
  if (!chatId || !userId) return;

  if (data === "lang:ru" || data === "lang:en") {
    const lang = data.split(":")[1];
    await setUserLang(userId, lang);

    await bot.answerCallbackQuery(cq.id, { text: "OK" });

    // безопасно: edit может упасть, не страшно
    try {
      await bot.editMessageText(t(lang, "ready"), {
        chat_id: chatId,
        message_id: cq.message.message_id
      });
    } catch {
      await bot.sendMessage(chatId, t(lang, "ready"));
    }
    return;
  }

  await bot.answerCallbackQuery(cq.id).catch(() => {});
}));

bot.onText(/^\/new$/, wrap(async (msg) => {
  if (msg.chat.type !== "private") return;

  const userId = msg.from.id;
  const lang = await getUserLang(userId, msg.from);

  const old = await getTicket(userId);
  if (old?.topicId) {
    await store.del(kTicket(userId));
    await store.del(kTopic(old.topicId));
  }

  try {
    const topicId = await ensureTicket(msg.from, lang);
    await bot.sendMessage(msg.chat.id, t(lang, "newTicket") + String(topicId));
  } catch {
    await bot.sendMessage(msg.chat.id, t(lang, "errForumOff"));
  }
}));

bot.onText(/^\/status$/, wrap(async (msg) => {
  if (msg.chat.type !== "private") return;

  const userId = msg.from.id;
  const lang = await getUserLang(userId, msg.from);

  const ticket = await getTicket(userId);
  if (!ticket?.topicId || ticket.status !== "open") {
    await bot.sendMessage(msg.chat.id, t(lang, "statusNone"));
    return;
  }

  const created = new Date(ticket.createdAt).toLocaleString();
  const updated = ticket.lastUserMsgAt ? new Date(ticket.lastUserMsgAt).toLocaleString() : "—";

  await bot.sendMessage(
    msg.chat.id,
    `${t(lang, "statusOpen")}\nTicket: #${ticket.topicId}\nCreated: ${created}\nLast: ${updated}`
  );
}));

// ---------- single message router ----------
bot.on("message", wrap(async (msg) => {
  if (!msg?.chat) return;

  // USER PRIVATE
  if (msg.chat.type === "private") {
    if (!msg.from) return;

    // команды игнорируем тут (onText обработает)
    if (msg.text && msg.text.startsWith("/")) return;

    const userId = msg.from.id;
    const saved = await store.get(kLang(userId));
    const lang = (saved === "ru" || saved === "en") ? saved : null;

    if (!lang) {
      const d = detectDefaultLang(msg.from);
      await bot.sendMessage(msg.chat.id, t(d, "needLang"), {
        reply_markup: {
          inline_keyboard: [
            [{ text: "1) English", callback_data: "lang:en" }],
            [{ text: "2) Русский", callback_data: "lang:ru" }]
          ]
        }
      });
      return;
    }

    const rl = await rateLimit(userId);
    if (rl.limited) {
      if (rl.warn) await bot.sendMessage(msg.chat.id, t(lang, "tooFast"));
      return;
    }

    let topicId;
    try {
      topicId = await ensureTicket(msg.from, lang);
    } catch {
      await bot.sendMessage(msg.chat.id, t(lang, "errForumOff"));
      return;
    }

    try {
      await copyUserMessageToTopic(msg, topicId);
    } catch {
      await bot.sendMessage(msg.chat.id, t(lang, "errBusy"));
      return;
    }

    if (await maybeAck(userId)) {
      await bot.sendMessage(msg.chat.id, t(lang, "accepted"));
    }

    return;
  }

  // SUPPORT GROUP
  if (msg.chat.id === SUPPORT_GROUP_ID) {
    if (!msg.from || !isAdmin(msg.from.id)) return;

    // reply-router: только reply и не команды
    if (msg.text && msg.text.startsWith("/")) return;

    const replyTo = msg.reply_to_message;
    if (!replyTo) return;

    const userId = await store.get(kMap(SUPPORT_GROUP_ID, replyTo.message_id));
    if (!userId) return;

    if (msg.text) {
      await bot.sendMessage(Number(userId), `💬 Support:\n\n${msg.text}`);
    } else {
      await bot.copyMessage(Number(userId), SUPPORT_GROUP_ID, msg.message_id);
    }

    const ticket = await getTicket(Number(userId));
    if (ticket) {
      ticket.lastSupportMsgAt = Date.now();
      await setTicket(Number(userId), ticket);
    }
  }
}));

module.exports = { bot };
