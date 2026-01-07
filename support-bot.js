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

// Админы, кто может отвечать из группы (по умолчанию: любой, если список пуст)
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

const bot = new TelegramBot(BOT_TOKEN, { polling: false });

// ---------- keys ----------
const K = {
  lang: (uid) => `lang:${uid}`,
  ticket: (uid) => `ticket:${uid}`,
  topicToUser: (topicId) => `topic:${topicId}`,
  map: (chatId, msgId) => `map:${chatId}:${msgId}`, // reply mapping
  lockTicket: (uid) => `lock:ticket:${uid}`,
  rl: (uid) => `rl:${uid}`
};

// ---------- i18n ----------
const TXT = {
  ru: {
    startTitle: "👋 Trade Support",
    startChooseLang: "Выбери язык общения:",
    startReady:
      "✅ Язык сохранён: Русский\n\nОтправь сюда свой вопрос — я создам заявку и передам в поддержку. Ответ придёт сюда же.\n\nКоманды:\n/status — статус заявки\n/new — новая заявка\n/help — помощь",
    startReadyNoTicket:
      "Отправь сюда свой вопрос — я создам заявку и передам в поддержку. Ответ придёт сюда же.\n\nКоманды:\n/status — статус заявки\n/new — новая заявка\n/help — помощь",
    help:
      "ℹ️ Помощь\n\nОтправь вопрос обычным сообщением.\n/status — статус заявки\n/new — новая заявка\n\nЕсли поддержка не отвечает — значит заявка ещё в работе.",
    rate: "⏳ Слишком часто. Подожди 2 секунды и отправь снова.",
    creating: "🛠 Создаю заявку…",
    accepted: "✅ Принято. Поддержка ответит здесь.",
    notConfigured:
      "⚠️ Поддержка временно недоступна (не настроена группа/топики/права). Попробуй позже.",
    statusNone: "📭 У тебя нет активной заявки. Отправь сообщение — я создам.",
    statusOpen: (t) =>
      `📌 Статус: ОТКРЫТО\nТикет: #${t.topicId}\nСоздан: ${new Date(t.createdAt).toLocaleString()}\nПоследнее сообщение: ${t.lastUserAt ? new Date(t.lastUserAt).toLocaleString() : "—"}\nОтвет поддержки: ${t.lastAdminAt ? new Date(t.lastAdminAt).toLocaleString() : "—"}`,
    newTicket: (id) => `✅ Создан новый тикет (#${id}). Отправь сообщение.`,
    closed: "🧾 Тикет закрыт.",
    unknownCmd: "Не понял команду. /help",
    adminSent: "✅ Sent."
  },
  en: {
    startTitle: "👋 Trade Support",
    startChooseLang: "Choose language:",
    startReady:
      "✅ Language saved: English\n\nSend your question here — I will create a ticket and forward it to support. The reply will come back here.\n\nCommands:\n/status — ticket status\n/new — new ticket\n/help — help",
    startReadyNoTicket:
      "Send your question here — I will create a ticket and forward it to support. The reply will come back here.\n\nCommands:\n/status — ticket status\n/new — new ticket\n/help — help",
    help:
      "ℹ️ Help\n\nSend a normal message with your question.\n/status — ticket status\n/new — new ticket\n\nIf support is silent — your ticket is still in progress.",
    rate: "⏳ Too fast. Wait 2 seconds and try again.",
    creating: "🛠 Creating a ticket…",
    accepted: "✅ Received. Support will reply here.",
    notConfigured:
      "⚠️ Support is temporarily unavailable (group/topics/permissions not configured). Try later.",
    statusNone: "📭 You have no active ticket. Send a message and I’ll create one.",
    statusOpen: (t) =>
      `📌 Status: OPEN\nTicket: #${t.topicId}\nCreated: ${new Date(t.createdAt).toLocaleString()}\nYour last message: ${t.lastUserAt ? new Date(t.lastUserAt).toLocaleString() : "—"}\nSupport reply: ${t.lastAdminAt ? new Date(t.lastAdminAt).toLocaleString() : "—"}`,
    newTicket: (id) => `✅ New ticket created (#${id}). Send a message.`,
    closed: "🧾 Ticket closed.",
    unknownCmd: "Unknown command. /help",
    adminSent: "✅ Sent."
  }
};

async function getLang(userId) {
  const saved = await store.getJSON(K.lang(userId));
  if (saved === "ru" || saved === "en") return saved;
  return "en";
}
async function setLang(userId, lang) {
  await store.setJSON(K.lang(userId), lang, { ex: 60 * 60 * 24 * 365 });
}
function safeUsername(u) {
  if (!u) return "";
  if (u.username) return `@${u.username}`;
  const name = [u.first_name, u.last_name].filter(Boolean).join(" ").trim();
  return name ? name : "";
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function parseRetryAfter(err) {
  // node-telegram-bot-api error may contain response.body.parameters.retry_after
  const ra =
    err?.response?.body?.parameters?.retry_after ??
    err?.response?.body?.parameters?.retry_after;
  const n = Number(ra);
  return Number.isFinite(n) ? n : null;
}

// ---------- fast rate limit (1 call) ----------
async function isRateLimited(userId) {
  // 1 msg / 2 sec
  const ok = await store.setNXEX(K.rl(userId), "1", 2);
  return !ok;
}

// ---------- ticket ----------
async function ensureTicket(user, lang) {
  const userId = user.id;

  const existing = await store.getJSON(K.ticket(userId));
  if (existing?.topicId) return existing.topicId;

  // lock to prevent duplicate topic creation (serverless concurrency)
  const locked = await store.setNXEX(K.lockTicket(userId), "1", 15);
  if (!locked) {
    // someone else is creating; wait shortly and re-check
    await sleep(350);
    const re = await store.getJSON(K.ticket(userId));
    if (re?.topicId) return re.topicId;
  }

  // create topic with retry on rate limit
  const titleRaw = `u${userId} ${safeUsername(user)}`.trim();
  const title = titleRaw.length > 120 ? titleRaw.slice(0, 120) : titleRaw;

  let created;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      created = await bot.createForumTopic(SUPPORT_GROUP_ID, title);
      break;
    } catch (e) {
      const ra = parseRetryAfter(e);
      if (ra) {
        await sleep((ra + 1) * 1000);
        continue;
      }
      // typical config errors: "chat is not a forum", "not enough rights", etc.
      throw e;
    }
  }
  if (!created?.message_thread_id) throw new Error("createForumTopic failed");

  const topicId = created.message_thread_id;

  const ticket = {
    topicId,
    createdAt: Date.now(),
    status: "open",
    user: {
      id: userId,
      username: user.username || null,
      first_name: user.first_name || null,
      last_name: user.last_name || null
    },
    lastUserAt: null,
    lastAdminAt: null
  };

  await store.setJSON(K.ticket(userId), ticket, { ex: 60 * 60 * 24 * 30 });
  await store.setJSON(K.topicToUser(topicId), userId, { ex: 60 * 60 * 24 * 30 });

  // header message inside topic
  const header = await bot.sendMessage(
    SUPPORT_GROUP_ID,
    `🆕 New ticket\nUser: ${safeUsername(user)}\nID: ${userId}\nLang: ${lang.toUpperCase()}`,
    { message_thread_id: topicId }
  );

  // map header => user
  await store.setJSON(K.map(SUPPORT_GROUP_ID, header.message_id), userId, {
    ex: 60 * 60 * 24 * 30
  });

  return topicId;
}

async function touchTicketUser(userId) {
  const t = await store.getJSON(K.ticket(userId));
  if (!t?.topicId) return;
  t.lastUserAt = Date.now();
  await store.setJSON(K.ticket(userId), t, { ex: 60 * 60 * 24 * 30 });
}

async function touchTicketAdminByTopic(topicId) {
  const userId = await store.getJSON(K.topicToUser(topicId));
  if (!userId) return;
  const t = await store.getJSON(K.ticket(userId));
  if (!t?.topicId) return;
  t.lastAdminAt = Date.now();
  await store.setJSON(K.ticket(userId), t, { ex: 60 * 60 * 24 * 30 });
}

// ---------- /start + language ----------
bot.onText(/^\/start(?:\s+(.+))?$/, async (msg) => {
  if (msg.chat.type !== "private") return;
  try {
    await bot.sendMessage(msg.chat.id, TXT.en.startChooseLang, {
      reply_markup: {
        inline_keyboard: [
          [
            { text: "English", callback_data: "lang:en" },
            { text: "Русский", callback_data: "lang:ru" }
          ]
        ]
      }
    });
  } catch (e) {
    // ignore
  }
});

bot.on("callback_query", async (q) => {
  try {
    const data = q.data || "";
    if (!data.startsWith("lang:")) return;

    const lang = data === "lang:ru" ? "ru" : "en";
    const userId = q.from.id;

    await setLang(userId, lang);

    // acknowledge fast
    try {
      await bot.answerCallbackQuery(q.id, { text: "OK" });
    } catch {}

    // edit original message (if possible)
    const chatId = q.message?.chat?.id;
    const messageId = q.message?.message_id;

    if (chatId && messageId) {
      try {
        await bot.editMessageText(TXT[lang].startReadyNoTicket, {
          chat_id: chatId,
          message_id: messageId
        });
        return;
      } catch {
        // fallback
      }
    }

    await bot.sendMessage(userId, TXT[lang].startReadyNoTicket);
  } catch (e) {
    // ignore
  }
});

bot.onText(/^\/help$/, async (msg) => {
  if (msg.chat.type !== "private") return;
  const lang = await getLang(msg.from.id);
  await bot.sendMessage(msg.chat.id, TXT[lang].help);
});

bot.onText(/^\/status$/, async (msg) => {
  if (msg.chat.type !== "private") return;
  const lang = await getLang(msg.from.id);
  const t = await store.getJSON(K.ticket(msg.from.id));
  if (!t?.topicId) {
    await bot.sendMessage(msg.chat.id, TXT[lang].statusNone);
    return;
  }
  await bot.sendMessage(msg.chat.id, TXT[lang].statusOpen(t));
});

bot.onText(/^\/new$/, async (msg) => {
  if (msg.chat.type !== "private") return;
  const lang = await getLang(msg.from.id);

  // drop old ticket mapping
  const old = await store.getJSON(K.ticket(msg.from.id));
  if (old?.topicId) {
    await store.del(K.ticket(msg.from.id));
    await store.del(K.topicToUser(old.topicId));
  }

  try {
    const topicId = await ensureTicket(msg.from, lang);
    await bot.sendMessage(msg.chat.id, TXT[lang].newTicket(topicId));
  } catch (e) {
    await bot.sendMessage(msg.chat.id, TXT[lang].notConfigured);
  }
});

// ---------- user messages -> topic ----------
bot.on("message", async (msg) => {
  try {
    if (msg.chat.type !== "private") return;
    if (!msg.from) return;

    const lang = await getLang(msg.from.id);

    // commands
    if (msg.text && msg.text.startsWith("/")) {
      const cmd = msg.text.split(" ")[0].toLowerCase();
      if (!["/start", "/help", "/status", "/new"].includes(cmd)) {
        await bot.sendMessage(msg.chat.id, TXT[lang].unknownCmd);
      }
      return;
    }

    if (await isRateLimited(msg.from.id)) {
      await bot.sendMessage(msg.chat.id, TXT[lang].rate);
      return;
    }

    // ensure ticket
    let topicId;
    try {
      topicId = await ensureTicket(msg.from, lang);
    } catch (e) {
      await bot.sendMessage(msg.chat.id, TXT[lang].notConfigured);
      return;
    }

    // copy message to topic
    const copied = await bot.copyMessage(SUPPORT_GROUP_ID, msg.chat.id, msg.message_id, {
      message_thread_id: topicId
    });

    // map copied message id -> user
    await store.setJSON(K.map(SUPPORT_GROUP_ID, copied.message_id), msg.from.id, {
      ex: 60 * 60 * 24 * 30
    });

    await touchTicketUser(msg.from.id);

    // lightweight ack
    await bot.sendMessage(msg.chat.id, TXT[lang].accepted);
  } catch (e) {
    // swallow errors to avoid webhook crash
    try {
      if (msg?.chat?.type === "private") {
        const lang = msg.from ? await getLang(msg.from.id) : "en";
        await bot.sendMessage(msg.chat.id, TXT[lang].notConfigured);
      }
    } catch {}
  }
});

// ---------- admin side (support group) ----------
bot.onText(/^\/id$/, async (msg) => {
  // useful for debugging group id
  try {
    await bot.sendMessage(msg.chat.id, `chat.id = ${msg.chat.id}`);
  } catch {}
});

bot.onText(/^\/close$/, async (msg) => {
  try {
    if (msg.chat.id !== SUPPORT_GROUP_ID) return;
    if (!msg.from || !isAdmin(msg.from.id)) return;

    const topicId = msg.message_thread_id;
    if (!topicId) return;

    const userId = await store.getJSON(K.topicToUser(topicId));
    if (userId) {
      await store.del(K.ticket(userId));
      await store.del(K.topicToUser(topicId));
    }

    try {
      await bot.closeForumTopic(SUPPORT_GROUP_ID, topicId);
    } catch {}

    await bot.sendMessage(msg.chat.id, TXT.en.closed, { message_thread_id: topicId });
  } catch {}
});

// reply in topic -> deliver to user
bot.on("message", async (msg) => {
  try {
    if (msg.chat.id !== SUPPORT_GROUP_ID) return;
    if (!msg.from || !isAdmin(msg.from.id)) return;

    // ignore commands
    if (msg.text && msg.text.startsWith("/")) return;

    const replyTo = msg.reply_to_message;
    if (!replyTo) return;

    const userId = await store.getJSON(K.map(SUPPORT_GROUP_ID, replyTo.message_id));
    if (!userId) return;

    if (msg.text) {
      await bot.sendMessage(userId, `💬 Support:\n\n${msg.text}`);
    } else {
      // non-text reply: copy back
      await bot.copyMessage(userId, SUPPORT_GROUP_ID, msg.message_id);
    }

    if (msg.message_thread_id) {
      await touchTicketAdminByTopic(msg.message_thread_id);
    }
  } catch (e) {
    // ignore
  }
});

module.exports = { bot };
