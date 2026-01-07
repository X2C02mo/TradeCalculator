// support-bot.js
const TelegramBot = require("node-telegram-bot-api");
const store = require("./store");

function mustNum(name, v) {
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`${name} must be a number`);
  return n;
}

const BOT_TOKEN = process.env.SUPPORT_BOT_TOKEN;
if (!BOT_TOKEN) throw new Error("SUPPORT_BOT_TOKEN is not set");

const SUPPORT_GROUP_ID = mustNum("SUPPORT_GROUP_ID", process.env.SUPPORT_GROUP_ID);

// ADMIN_USER_IDS = "123,456"
const ADMIN_USER_IDS = (process.env.ADMIN_USER_IDS || "")
  .split(",")
  .map((x) => x.trim())
  .filter(Boolean)
  .map((x) => Number(x))
  .filter((x) => Number.isFinite(x));

function isAdmin(userId) {
  if (!ADMIN_USER_IDS.length) return true; // если список пуст — считаем всех админами (как было у тебя)
  return ADMIN_USER_IDS.includes(Number(userId));
}

// Webhook mode (Vercel): polling must be false
const bot = new TelegramBot(BOT_TOKEN, { polling: false });

/* -------------------- FAST CACHES (in-memory) -------------------- */
const CACHE_TTL_MS = 60 * 60 * 1000; // 1h
function cacheGet(map, key) {
  const it = map.get(key);
  if (!it) return null;
  if (it.exp <= Date.now()) {
    map.delete(key);
    return null;
  }
  return it.v;
}
function cacheSet(map, key, value, ttlMs = CACHE_TTL_MS) {
  map.set(key, { v: value, exp: Date.now() + ttlMs });
}

const ticketCache = new Map(); // userId -> { topicId }
const topicUserCache = new Map(); // topicId -> userId
const msgMapCache = new Map(); // groupMsgId -> userId
const langCache = new Map(); // userId -> "ru"/"en"

/* -------------------- Redis keys -------------------- */
const TICKET_TTL_SEC = 60 * 60 * 24 * 180; // 180 days
const MAP_TTL_SEC = 60 * 60 * 24 * 30; // 30 days
const LANG_TTL_SEC = 60 * 60 * 24 * 365; // 1 year

const kTicket = (userId) => `ticket:${userId}`; // => {topicId, createdAt, mode:"forum"|"plain"}
const kTopic = (topicId) => `topic:${topicId}`; // => userId
const kMap = (msgId) => `map:${SUPPORT_GROUP_ID}:${msgId}`; // => userId
const kLang = (userId) => `lang:${userId}`; // => "ru"|"en"

/* -------------------- Ultra-fast rate limit (no Redis) -------------------- */
const rl = new Map(); // userId -> lastTs
function rateLimitFast(userId) {
  const t = Date.now();
  const prev = rl.get(userId) || 0;
  if (t - prev < 900) return true; // ~1 msg per 0.9s
  rl.set(userId, t);
  return false;
}

/* -------------------- i18n -------------------- */
const TEXT = {
  ru: {
    chooseLang: "Выбери язык общения:",
    start:
      "👋 *Trade Support*\n\nОтправь сюда вопрос — я создам заявку и передам в поддержку. Ответ придёт сюда же.",
    started: "✅ Язык установлен: Русский.",
    statusNone: "📭 У тебя нет активной заявки. Напиши сообщение — я создам новую.",
    statusHas: (topicId, mode) =>
      mode === "forum"
        ? `📌 Активная заявка: *#${topicId}*\nСтатус: *open*`
        : "📌 Активная заявка: *open* (без Topics)",
    ticketCreated: (topicId) => `✅ Заявка создана: *#${topicId}*. Отправляй сообщения сюда.`,
    received: "✅ Принято.",
    slowDown: "⏳ Слишком часто. Подожди секунду и попробуй снова."
  },
  en: {
    chooseLang: "Choose language:",
    start:
      "👋 *Trade Support*\n\nSend your question here — I will create a ticket and forward it to support. Reply will come here.",
    started: "✅ Language set: English.",
    statusNone: "📭 No active ticket. Send a message — I will create one.",
    statusHas: (topicId, mode) =>
      mode === "forum"
        ? `📌 Active ticket: *#${topicId}*\nStatus: *open*`
        : "📌 Active ticket: *open* (no Topics)",
    ticketCreated: (topicId) => `✅ Ticket created: *#${topicId}*. Send messages here.`,
    received: "✅ Received.",
    slowDown: "⏳ Too fast. Wait a second and try again."
  }
};

function safeUserLabel(u) {
  if (!u) return "";
  if (u.username) return `@${u.username}`;
  const name = [u.first_name, u.last_name].filter(Boolean).join(" ").trim();
  return name || `id:${u.id}`;
}

async function getUserLang(user) {
  const uid = user.id;
  const c = cacheGet(langCache, uid);
  if (c) return c;

  const saved = await store.get(kLang(uid));
  if (saved === "ru" || saved === "en") {
    cacheSet(langCache, uid, saved, CACHE_TTL_MS);
    return saved;
  }

  // default: based on telegram language_code
  const code = (user.language_code || "").toLowerCase();
  const lang = code.startsWith("ru") || code.startsWith("uk") || code.startsWith("be") ? "ru" : "en";
  cacheSet(langCache, uid, lang, CACHE_TTL_MS);
  return lang;
}

async function setUserLang(userId, lang) {
  if (lang !== "ru" && lang !== "en") return;
  cacheSet(langCache, userId, lang, CACHE_TTL_MS);
  // не блокируемся на этом (ускорение)
  void store.set(kLang(userId), lang, { ex: LANG_TTL_SEC });
}

/* -------------------- Ticket logic -------------------- */
async function getTicket(userId) {
  const c = cacheGet(ticketCache, userId);
  if (c) return c;

  const t = await store.get(kTicket(userId));
  if (t && (t.topicId || t.mode === "plain")) {
    cacheSet(ticketCache, userId, t, CACHE_TTL_MS);
    if (t.topicId) cacheSet(topicUserCache, t.topicId, userId, CACHE_TTL_MS);
    return t;
  }
  return null;
}

async function setTicket(userId, ticketObj) {
  cacheSet(ticketCache, userId, ticketObj, CACHE_TTL_MS);
  if (ticketObj.topicId) cacheSet(topicUserCache, ticketObj.topicId, userId, CACHE_TTL_MS);
  await store.set(kTicket(userId), ticketObj, { ex: TICKET_TTL_SEC });
  if (ticketObj.topicId) {
    // reverse map for /close
    void store.set(kTopic(ticketObj.topicId), userId, { ex: TICKET_TTL_SEC });
  }
}

async function clearTicket(userId, topicId) {
  ticketCache.delete(userId);
  if (topicId) topicUserCache.delete(topicId);
  await store.del(kTicket(userId));
  if (topicId) await store.del(kTopic(topicId));
}

async function mapGroupMessage(msgId, userId) {
  cacheSet(msgMapCache, msgId, userId, CACHE_TTL_MS);
  // для надёжности — в Redis (но не тормозим критический путь лишним await при возможности)
  void store.set(kMap(msgId), userId, { ex: MAP_TTL_SEC });
}

async function resolveMappedUser(msgId) {
  const c = cacheGet(msgMapCache, msgId);
  if (c) return c;
  const u = await store.get(kMap(msgId));
  if (Number.isFinite(Number(u))) {
    const uid = Number(u);
    cacheSet(msgMapCache, msgId, uid, CACHE_TTL_MS);
    return uid;
  }
  return null;
}

async function ensureTicketForUser(user, lang) {
  const uid = user.id;
  const existing = await getTicket(uid);
  if (existing) return { ticket: existing, created: false };

  // try create forum topic
  const titleRaw = `u${uid} ${safeUserLabel(user)}`.trim();
  const title = titleRaw.length > 120 ? titleRaw.slice(0, 120) : titleRaw;

  try {
    const created = await bot.createForumTopic(SUPPORT_GROUP_ID, title);
    const topicId = created.message_thread_id;

    const ticket = {
      mode: "forum",
      topicId,
      createdAt: Date.now()
    };

    await setTicket(uid, ticket);

    // 1 extra message in topic (admin header) — полезно и почти не влияет на скорость
    const header = await bot.sendMessage(
      SUPPORT_GROUP_ID,
      `🆕 New ticket\nUser: ${safeUserLabel(user)}\nID: ${uid}`,
      { message_thread_id: topicId }
    );
    await mapGroupMessage(header.message_id, uid);

    return { ticket, created: true };
  } catch (e) {
    // fallback: group without topics (still supports reply routing)
    const ticket = {
      mode: "plain",
      createdAt: Date.now()
    };
    await setTicket(uid, ticket);

    // notify admins once (no blocking for user experience)
    void bot.sendMessage(
      SUPPORT_GROUP_ID,
      `⚠️ Cannot create forum topic.\nCheck: Topics enabled + bot admin rights "Manage Topics".\nError: ${String(
        e?.message || e
      )}`
    );

    return { ticket, created: true };
  }
}

async function copyUserMessageToSupport(msg, ticket, lang) {
  const uid = msg.from.id;

  // If forum mode: copy into topic. Else: copy into group (no topic).
  const options = {};
  if (ticket.mode === "forum" && ticket.topicId) {
    options.message_thread_id = ticket.topicId;
  }

  // Copy original user message
  const copied = await bot.copyMessage(SUPPORT_GROUP_ID, msg.chat.id, msg.message_id, options);
  const newMsgId = copied.message_id;

  await mapGroupMessage(newMsgId, uid);
}

/* -------------------- Commands / UI -------------------- */
bot.onText(/^\/start(?:\s+(.+))?$/, async (msg) => {
  if (msg.chat.type !== "private") return;

  const preLang = await getUserLang(msg.from);
  const t = TEXT[preLang];

  // Always ask language via buttons (быстро и понятно)
  await bot.sendMessage(msg.chat.id, t.chooseLang, {
    reply_markup: {
      inline_keyboard: [
        [{ text: "English", callback_data: "lang:en" }],
        [{ text: "Русский", callback_data: "lang:ru" }]
      ]
    }
  });

  await bot.sendMessage(msg.chat.id, t.start, { parse_mode: "Markdown" });
});

bot.on("callback_query", async (cq) => {
  try {
    const data = String(cq.data || "");
    if (!data.startsWith("lang:")) return;

    const lang = data.split(":")[1];
    const uid = cq.from.id;
    await setUserLang(uid, lang);

    const t = TEXT[lang === "ru" ? "ru" : "en"];
    await bot.answerCallbackQuery(cq.id, { text: t.started, show_alert: false });

    // Optional: show short confirmation
    await bot.sendMessage(cq.message.chat.id, t.started);
  } catch (e) {
    // ignore
  }
});

bot.onText(/^\/status$/, async (msg) => {
  if (msg.chat.type !== "private") return;
  const lang = await getUserLang(msg.from);
  const t = TEXT[lang];

  const ticket = await getTicket(msg.from.id);
  if (!ticket) {
    await bot.sendMessage(msg.chat.id, t.statusNone);
    return;
  }

  await bot.sendMessage(
    msg.chat.id,
    t.statusHas(ticket.topicId, ticket.mode),
    { parse_mode: "Markdown" }
  );
});

bot.onText(/^\/new$/, async (msg) => {
  if (msg.chat.type !== "private") return;
  const lang = await getUserLang(msg.from);
  const t = TEXT[lang];

  const old = await getTicket(msg.from.id);
  if (old?.topicId) {
    await clearTicket(msg.from.id, old.topicId);
  } else {
    await clearTicket(msg.from.id, null);
  }

  const { ticket } = await ensureTicketForUser(msg.from, lang);
  if (ticket.mode === "forum" && ticket.topicId) {
    await bot.sendMessage(msg.chat.id, t.ticketCreated(ticket.topicId), { parse_mode: "Markdown" });
  } else {
    await bot.sendMessage(msg.chat.id, t.received);
  }
});

// Admin: show chat.id
bot.onText(/^\/id$/, async (msg) => {
  await bot.sendMessage(msg.chat.id, `chat.id = ${msg.chat.id}`);
});

// Admin: close ticket inside topic
bot.onText(/^\/close$/, async (msg) => {
  if (msg.chat.id !== SUPPORT_GROUP_ID) return;
  if (!msg.from || !isAdmin(msg.from.id)) return;

  const topicId = msg.message_thread_id;
  if (!topicId) {
    await bot.sendMessage(msg.chat.id, "⚠️ Use /close inside a topic.");
    return;
  }

  const userId = cacheGet(topicUserCache, topicId) || (await store.get(kTopic(topicId)));
  if (userId) {
    await clearTicket(Number(userId), topicId);
    void bot.sendMessage(Number(userId), "🧾 Ticket closed.");
  }

  try {
    await bot.closeForumTopic(SUPPORT_GROUP_ID, topicId);
  } catch (_) {}

  await bot.sendMessage(msg.chat.id, "🧾 Ticket closed.", { message_thread_id: topicId });
});

/* -------------------- Single message handler (FAST) -------------------- */
bot.on("message", async (msg) => {
  try {
    if (!msg || !msg.chat) return;

    // 1) Private user messages -> to support
    if (msg.chat.type === "private") {
      if (!msg.from) return;

      // skip commands
      if (msg.text && msg.text.startsWith("/")) return;

      const lang = await getUserLang(msg.from);
      const t = TEXT[lang];

      if (rateLimitFast(msg.from.id)) {
        await bot.sendMessage(msg.chat.id, t.slowDown);
        return;
      }

      const { ticket, created } = await ensureTicketForUser(msg.from, lang);

      // Copy user message into support group (topic or plain)
      await copyUserMessageToSupport(msg, ticket, lang);

      // One-time confirmation only when a ticket was created now (cheap)
      if (created && ticket.mode === "forum" && ticket.topicId) {
        await bot.sendMessage(msg.chat.id, t.ticketCreated(ticket.topicId), { parse_mode: "Markdown" });
      }
      return;
    }

    // 2) Support group messages -> route replies back to user
    if (msg.chat.id === SUPPORT_GROUP_ID) {
      if (!msg.from || !isAdmin(msg.from.id)) return;

      // ignore commands
      if (msg.text && msg.text.startsWith("/")) return;

      // only when admin replies
      const replyTo = msg.reply_to_message;
      if (!replyTo) return;

      const userId = await resolveMappedUser(replyTo.message_id);
      if (!userId) return;

      // send back
      if (msg.text) {
        await bot.sendMessage(userId, `💬 Support:\n\n${msg.text}`);
      } else {
        // non-text -> copy as-is
        await bot.copyMessage(userId, SUPPORT_GROUP_ID, msg.message_id);
      }
      return;
    }
  } catch (e) {
    console.error("[support-bot] message handler error:", e);
  }
});

module.exports = { bot };
