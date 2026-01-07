// support-bot.js
// Fast + resilient Telegram support bot for Vercel webhook runtime.
// - Language selection via buttons (RU/EN)
// - Main actions via buttons (New ticket / Status / Close / Help / Change language)
// - Forum topics in support group (fallback if forum disabled)
// - Robust retries for "socket hang up"/ECONNRESET + timeouts + keep-alive
// - No duplicate handlers, no spammy rate-limit replies

const TelegramBot = require("node-telegram-bot-api");
const store = require("./store");
const https = require("https");

/* ----------------- safety nets ----------------- */
process.on("unhandledRejection", (e) => console.error("unhandledRejection:", e?.message || e));
process.on("uncaughtException", (e) => console.error("uncaughtException:", e?.message || e));

/* ----------------- env ----------------- */
const BOT_TOKEN = process.env.SUPPORT_BOT_TOKEN;
if (!BOT_TOKEN) throw new Error("SUPPORT_BOT_TOKEN is not set");

const SUPPORT_GROUP_ID = Number(process.env.SUPPORT_GROUP_ID);
if (!Number.isFinite(SUPPORT_GROUP_ID)) throw new Error("SUPPORT_GROUP_ID must be a number");

// Optional: comma-separated admin user IDs. If empty -> everyone in group is treated as admin.
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

/* ----------------- bot init (keep-alive + timeout) ----------------- */
const keepAliveAgent = new https.Agent({ keepAlive: true, maxSockets: 50 });

const bot = new TelegramBot(BOT_TOKEN, {
  polling: false,
  request: {
    agent: keepAliveAgent,
    timeout: 10000,
    forever: true,
  },
});

/* ----------------- i18n ----------------- */
const I18N = {
  en: {
    hello: "👋 Trade Support",
    pickLang: "Choose language:",
    menuTitle: "What do you want to do?",
    btnNew: "🆕 New ticket",
    btnStatus: "📌 Status",
    btnClose: "✅ Close ticket",
    btnHelp: "ℹ️ Help",
    btnLang: "🌐 Language",
    help:
      "Send your question here — I will forward it to support and you will receive the reply here.\n\nTips:\n• One ticket = one conversation thread.\n• If you send many messages too fast, I may ask you to slow down.",
    noLang: "Please choose language first.",
    created: (n) => `✅ New ticket created. Ticket #${n}\nNow send your message.`,
    sent: (n) => `✅ Sent to support. Ticket #${n}`,
    busy: "⚠️ Support channel is busy right now. Try again in a few seconds.",
    tooFast: (sec) => `⏳ Too fast. Wait ${sec}s and send again.`,
    statusNone: "You have no open ticket right now.",
    statusOpen: (n, since, last) =>
      `📌 Ticket #${n}\nCreated: ${since}\nLast activity: ${last}\n\nSend a message to continue.`,
    closed: (n) => `🧾 Ticket #${n}: CLOSED`,
    closedNone: "You don't have an open ticket to close.",
    langSet: (lng) => `✅ Language set: ${lng === "ru" ? "Русский" : "English"}`,
  },
  ru: {
    hello: "👋 Trade Support",
    pickLang: "Выбери язык:",
    menuTitle: "Что сделать дальше?",
    btnNew: "🆕 Новый тикет",
    btnStatus: "📌 Статус",
    btnClose: "✅ Закрыть тикет",
    btnHelp: "ℹ️ Помощь",
    btnLang: "🌐 Язык",
    help:
      "Отправь вопрос сюда — я передам его в поддержку, а ответ придёт сюда же.\n\nПодсказки:\n• Один тикет = один диалог.\n• Если отправляешь слишком часто, я попрошу замедлиться.",
    noLang: "Сначала выбери язык.",
    created: (n) => `✅ Создан новый тикет. Тикет #${n}\nТеперь отправь сообщение.`,
    sent: (n) => `✅ Отправлено в поддержку. Тикет #${n}`,
    busy: "⚠️ Канал поддержки сейчас перегружен. Попробуй ещё раз через несколько секунд.",
    tooFast: (sec) => `⏳ Слишком часто. Подожди ${sec}с и отправь снова.`,
    statusNone: "У тебя сейчас нет открытого тикета.",
    statusOpen: (n, since, last) =>
      `📌 Тикет #${n}\nСоздан: ${since}\nПоследняя активность: ${last}\n\nОтправь сообщение, чтобы продолжить.`,
    closed: (n) => `🧾 Тикет #${n}: ЗАКРЫТ`,
    closedNone: "У тебя нет открытого тикета, который можно закрыть.",
    langSet: (lng) => `✅ Язык установлен: ${lng === "ru" ? "Русский" : "English"}`,
  },
};

function pickLangDefault(user) {
  const c = String(user?.language_code || "").toLowerCase();
  if (/^ru|uk|be/.test(c)) return "ru";
  return "en";
}

function t(lang, key, ...args) {
  const dict = I18N[lang] || I18N.en;
  const v = dict[key];
  return typeof v === "function" ? v(...args) : v;
}

/* ----------------- store helpers (robust JSON) ----------------- */
async function getAny(key) {
  return await store.get(key);
}

async function getJSON(key) {
  const v = await getAny(key);
  if (v == null) return null;
  if (typeof v === "string") {
    try {
      return JSON.parse(v);
    } catch {
      return v; // string raw
    }
  }
  return v; // object/number/etc
}

async function setJSON(key, val) {
  // Upstash SDK usually serializes objects fine, but we keep it safe.
  // For in-memory Map, object is perfect.
  await store.set(key, val);
}

async function delKey(key) {
  await store.del(key);
}

/* ----------------- keys ----------------- */
const kUser = (uid) => `user:${uid}`;
const kTicket = (uid) => `ticket:${uid}`; // open ticket pointer
const kTopicToUser = (topicId) => `topic:${topicId}`;
const kMap = (chatId, msgId) => `map:${chatId}:${msgId}`;
const kSeq = `ticketSeq`;
const kRL = (uid) => `rl:${uid}`;
const kRLWarn = (uid) => `rlw:${uid}`;
const kAck = (uid) => `ack:${uid}`;
const kForumFlag = `forum_ok`; // boolean

/* ----------------- formatting ----------------- */
function safeUsername(u) {
  if (!u) return "";
  if (u.username) return `@${u.username}`;
  const name = [u.first_name, u.last_name].filter(Boolean).join(" ").trim();
  return name || "";
}

function fmtTime(ts) {
  try {
    return new Date(ts).toLocaleString();
  } catch {
    return String(ts);
  }
}

/* ----------------- resilient tg calls ----------------- */
function isSocketHangup(e) {
  const msg = String(e?.message || "");
  return e?.code === "ECONNRESET" || msg.includes("socket hang up") || msg.includes("ETIMEDOUT");
}

function parseRetryAfter(e) {
  // Telegram 429: e.response.body.parameters.retry_after
  const ra = e?.response?.body?.parameters?.retry_after;
  const n = Number(ra);
  return Number.isFinite(n) ? n : null;
}

async function withRetry(fn, tries = 4) {
  let lastErr = null;
  for (let i = 0; i < tries; i++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;

      const retryAfter = parseRetryAfter(e);
      if (retryAfter) {
        await new Promise((r) => setTimeout(r, Math.min(8000, retryAfter * 1000)));
        continue;
      }

      if (isSocketHangup(e)) {
        await new Promise((r) => setTimeout(r, 200 * (i + 1)));
        continue;
      }

      // other errors -> don't hammer
      await new Promise((r) => setTimeout(r, 120 * (i + 1)));
    }
  }
  throw lastErr;
}

/* ----------------- UX buttons ----------------- */
function langKeyboard() {
  return {
    inline_keyboard: [
      [
        { text: "English", callback_data: "lang:en" },
        { text: "Русский", callback_data: "lang:ru" },
      ],
    ],
  };
}

async function menuKeyboard(uid, lang) {
  const ticket = await getJSON(kTicket(uid));
  const hasOpen = !!ticket?.open;

  const row1 = [
    { text: t(lang, "btnNew"), callback_data: "act:new" },
    { text: t(lang, "btnStatus"), callback_data: "act:status" },
  ];
  const row2 = [
    { text: t(lang, "btnHelp"), callback_data: "act:help" },
    { text: t(lang, "btnLang"), callback_data: "act:lang" },
  ];
  const kb = [row1, row2];
  if (hasOpen) kb.unshift([{ text: t(lang, "btnClose"), callback_data: "act:close" }]);

  return { inline_keyboard: kb };
}

async function sendLangPicker(chatId, lang) {
  await withRetry(() =>
    bot.sendMessage(chatId, `${t(lang, "hello")}\n\n${t(lang, "pickLang")}`, {
      reply_markup: langKeyboard(),
    })
  );
}

async function sendMenu(chatId, uid, lang) {
  await withRetry(() =>
    bot.sendMessage(chatId, `${t(lang, "menuTitle")}`, {
      reply_markup: await menuKeyboard(uid, lang),
    })
  );
}

/* ----------------- rate limit (no spam replies) ----------------- */
const RL_MS = 900; // fast, but avoids flood; tune as needed

async function rateLimit(uid) {
  const now = Date.now();
  const prev = Number(await getAny(kRL(uid))) || 0;
  const delta = now - prev;
  if (delta < RL_MS) return RL_MS - delta;
  await store.set(kRL(uid), String(now));
  return 0;
}

async function maybeWarnRateLimited(chatId, uid, lang, waitMs) {
  // warn at most once per ~2 seconds
  const now = Date.now();
  const prev = Number(await getAny(kRLWarn(uid))) || 0;
  if (now - prev < 1900) return;
  await store.set(kRLWarn(uid), String(now));
  const sec = Math.max(1, Math.ceil(waitMs / 1000));
  await withRetry(() => bot.sendMessage(chatId, t(lang, "tooFast", sec)));
}

/* ----------------- ticket seq ----------------- */
async function nextTicketNo() {
  const raw = await getAny(kSeq);
  const n = Number(raw) || 0;
  const next = n + 1;
  await store.set(kSeq, String(next));
  return next;
}

/* ----------------- forum topic + fallback ----------------- */
async function ensureForumAllowed() {
  const v = await getJSON(kForumFlag);
  if (v === false) return false;
  if (v === true) return true;
  // unknown -> assume true until first failure
  return true;
}

async function markForumAllowed(ok) {
  await setJSON(kForumFlag, !!ok);
}

async function createTopicIfPossible(ticketNo, user) {
  const forumOk = await ensureForumAllowed();
  if (!forumOk) return null;

  const titleRaw = `#${ticketNo} u${user.id} ${safeUsername(user)}`.trim();
  const title = titleRaw.length > 120 ? titleRaw.slice(0, 120) : titleRaw;

  try {
    const created = await withRetry(() => bot.createForumTopic(SUPPORT_GROUP_ID, title), 3);
    await markForumAllowed(true);
    return created?.message_thread_id || null;
  } catch (e) {
    // If group is not a forum or forbidden, stop trying later
    const msg = String(e?.message || "");
    if (msg.includes("CHAT_NOT_FORUM") || msg.includes("not a forum") || msg.includes("TOPIC")) {
      await markForumAllowed(false);
    }
    return null;
  }
}

/* ----------------- ticket lifecycle ----------------- */
async function getUserLang(uid, userObj) {
  const u = await getJSON(kUser(uid));
  if (u?.lang === "ru" || u?.lang === "en") return u.lang;
  return pickLangDefault(userObj || {});
}

async function setUserLang(uid, lang) {
  const prev = (await getJSON(kUser(uid))) || {};
  await setJSON(kUser(uid), { ...prev, lang });
}

async function getOpenTicket(uid) {
  const ptr = await getJSON(kTicket(uid));
  if (!ptr?.open) return null;
  return ptr.open;
}

async function setOpenTicket(uid, ticket) {
  await setJSON(kTicket(uid), { open: ticket });
}

async function clearOpenTicket(uid) {
  await delKey(kTicket(uid));
}

async function ensureTicket(uid, user, { forceNew = false } = {}) {
  if (!forceNew) {
    const open = await getOpenTicket(uid);
    if (open?.ticketNo) return open;
  }

  const ticketNo = await nextTicketNo();
  const lang = await getUserLang(uid, user);

  const topicId = await createTopicIfPossible(ticketNo, user);

  // Save open ticket pointer
  const ticket = {
    ticketNo,
    topicId: topicId || null,
    createdAt: Date.now(),
    lastAt: Date.now(),
    user: {
      id: uid,
      username: user?.username || null,
      first_name: user?.first_name || null,
      last_name: user?.last_name || null,
    },
  };
  await setOpenTicket(uid, ticket);

  if (topicId) await setJSON(kTopicToUser(topicId), uid);

  // Header in support group (topic if available)
  const headerText = `🆕 New ticket #${ticketNo}\nUser: ${safeUsername(user)}\nID: ${uid}`;

  const header = await withRetry(() =>
    bot.sendMessage(SUPPORT_GROUP_ID, headerText, topicId ? { message_thread_id: topicId } : undefined)
  );

  // Map header message -> user (so admins can reply to it)
  if (header?.message_id) await setJSON(kMap(SUPPORT_GROUP_ID, header.message_id), uid);

  return ticket;
}

async function closeTicket(uid, lang, { byAdmin = false, topicId = null } = {}) {
  const ticket = await getOpenTicket(uid);
  if (!ticket) return { ok: false, ticketNo: null };

  await clearOpenTicket(uid);

  // close forum topic if possible
  if (ticket.topicId) {
    try {
      await withRetry(() => bot.closeForumTopic(SUPPORT_GROUP_ID, ticket.topicId), 2);
    } catch {}
    await delKey(kTopicToUser(ticket.topicId));
  }

  const msgText = t(lang, "closed", ticket.ticketNo);

  // notify user
  await withRetry(() => bot.sendMessage(uid, msgText, { reply_markup: undefined })).catch(() => {});

  // notify group (in same topic if possible)
  try {
    await withRetry(() =>
      bot.sendMessage(
        SUPPORT_GROUP_ID,
        `🧾 Ticket #${ticket.ticketNo} CLOSED${byAdmin ? " (by admin)" : ""}`,
        ticket.topicId ? { message_thread_id: ticket.topicId } : undefined
      )
    );
  } catch {}

  return { ok: true, ticketNo: ticket.ticketNo, topicId: ticket.topicId || topicId || null };
}

/* ----------------- copy user msg -> support ----------------- */
async function copyUserMessageToSupport(uid, msg, ticket) {
  const opts = ticket.topicId ? { message_thread_id: ticket.topicId } : undefined;

  const copied = await withRetry(
    () => bot.copyMessage(SUPPORT_GROUP_ID, msg.chat.id, msg.message_id, opts),
    4
  );

  const newMessageId = copied?.message_id;
  if (newMessageId) await setJSON(kMap(SUPPORT_GROUP_ID, newMessageId), uid);

  // bump lastAt
  const open = await getOpenTicket(uid);
  if (open?.ticketNo) {
    open.lastAt = Date.now();
    await setOpenTicket(uid, open);
  }

  return true;
}

/* ----------------- ack throttling ----------------- */
async function maybeAckSent(chatId, uid, lang, ticketNo) {
  const now = Date.now();
  const prev = Number(await getAny(kAck(uid))) || 0;
  if (now - prev < 25000) return; // no ack spam (once / 25s)
  await store.set(kAck(uid), String(now));
  await withRetry(() => bot.sendMessage(chatId, t(lang, "sent", ticketNo)));
}

/* ----------------- handlers ----------------- */
function safe(fn) {
  return async (...args) => {
    try {
      await fn(...args);
    } catch (e) {
      console.error("handler error:", e?.message || e);
    }
  };
}

/* ===== callbacks (buttons) ===== */
bot.on(
  "callback_query",
  safe(async (q) => {
    const data = String(q.data || "");
    const msg = q.message;
    const from = q.from;
    if (!msg || !from) return;

    const uid = from.id;
    let lang = await getUserLang(uid, from);

    // always answer callback quickly
    try {
      await bot.answerCallbackQuery(q.id);
    } catch {}

    if (data.startsWith("lang:")) {
      const chosen = data.split(":")[1];
      if (chosen === "ru" || chosen === "en") {
        await setUserLang(uid, chosen);
        lang = chosen;
        await withRetry(() => bot.sendMessage(uid, t(lang, "langSet", lang)));
      }
      await sendMenu(uid, uid, lang);
      return;
    }

    if (data === "act:lang") {
      await sendLangPicker(uid, lang);
      return;
    }

    if (data === "act:help") {
      await withRetry(() => bot.sendMessage(uid, t(lang, "help"), { reply_markup: await menuKeyboard(uid, lang) }));
      return;
    }

    if (data === "act:new") {
      const ticket = await ensureTicket(uid, from, { forceNew: true });
      await withRetry(() => bot.sendMessage(uid, t(lang, "created", ticket.ticketNo), { reply_markup: await menuKeyboard(uid, lang) }));
      return;
    }

    if (data === "act:status") {
      const ticket = await getOpenTicket(uid);
      if (!ticket) {
        await withRetry(() => bot.sendMessage(uid, t(lang, "statusNone"), { reply_markup: await menuKeyboard(uid, lang) }));
        return;
      }
      await withRetry(() =>
        bot.sendMessage(
          uid,
          t(lang, "statusOpen", ticket.ticketNo, fmtTime(ticket.createdAt), fmtTime(ticket.lastAt)),
          { reply_markup: await menuKeyboard(uid, lang) }
        )
      );
      return;
    }

    if (data === "act:close") {
      const ticket = await getOpenTicket(uid);
      if (!ticket) {
        await withRetry(() => bot.sendMessage(uid, t(lang, "closedNone"), { reply_markup: await menuKeyboard(uid, lang) }));
        return;
      }
      await closeTicket(uid, lang, { byAdmin: false });
      await sendMenu(uid, uid, lang);
      return;
    }
  })
);

/* ===== /start (kept for compatibility; UX uses buttons) ===== */
bot.onText(
  /^\/start(?:\s+(.+))?$/,
  safe(async (msg) => {
    if (msg.chat.type !== "private") return;

    const uid = msg.from.id;
    const lang = await getUserLang(uid, msg.from);
    const u = await getJSON(kUser(uid));

    // If language wasn't chosen before, show picker first
    if (!u?.lang) {
      await sendLangPicker(msg.chat.id, lang);
      return;
    }

    await withRetry(() => bot.sendMessage(msg.chat.id, `${t(lang, "hello")}\n\n${t(lang, "help")}`));
    await sendMenu(msg.chat.id, uid, lang);
  })
);

/* ===== optional admin helper in group: /id ===== */
bot.onText(
  /^\/id$/,
  safe(async (msg) => {
    // works anywhere, but mainly for group debug
    await withRetry(() => bot.sendMessage(msg.chat.id, `chat.id = ${msg.chat.id}`));
  })
);

/* ===== optional: /status (kept, but UI buttons are primary) ===== */
bot.onText(
  /^\/status$/,
  safe(async (msg) => {
    if (msg.chat.type !== "private") return;
    const uid = msg.from.id;
    const lang = await getUserLang(uid, msg.from);
    const ticket = await getOpenTicket(uid);
    if (!ticket) {
      await withRetry(() => bot.sendMessage(uid, t(lang, "statusNone"), { reply_markup: await menuKeyboard(uid, lang) }));
      return;
    }
    await withRetry(() =>
      bot.sendMessage(uid, t(lang, "statusOpen", ticket.ticketNo, fmtTime(ticket.createdAt), fmtTime(ticket.lastAt)), {
        reply_markup: await menuKeyboard(uid, lang),
      })
    );
  })
);

/* ===== optional: /new (kept) ===== */
bot.onText(
  /^\/new$/,
  safe(async (msg) => {
    if (msg.chat.type !== "private") return;
    const uid = msg.from.id;
    const lang = await getUserLang(uid, msg.from);
    const ticket = await ensureTicket(uid, msg.from, { forceNew: true });
    await withRetry(() => bot.sendMessage(uid, t(lang, "created", ticket.ticketNo), { reply_markup: await menuKeyboard(uid, lang) }));
  })
);

/* ===== admin: /close in topic (kept) ===== */
bot.onText(
  /^\/close$/,
  safe(async (msg) => {
    if (msg.chat.id !== SUPPORT_GROUP_ID) return;
    if (!msg.from || !isAdmin(msg.from.id)) return;

    const topicId = msg.message_thread_id;
    if (!topicId) return;

    const uid = await getJSON(kTopicToUser(topicId));
    if (!uid) return;

    const lang = await getUserLang(uid, null);
    await closeTicket(Number(uid), lang, { byAdmin: true, topicId });
  })
);

/* ===== main message router (ONE handler) ===== */
bot.on(
  "message",
  safe(async (msg) => {
    // 1) Private user messages -> forward to support
    if (msg.chat.type === "private") {
      const uid = msg.from?.id;
      if (!uid) return;

      // ignore commands (we keep them for compatibility)
      if (msg.text && msg.text.startsWith("/")) return;

      // If user didn't pick language yet -> show picker and stop
      const u = await getJSON(kUser(uid));
      const lang = await getUserLang(uid, msg.from);
      if (!u?.lang) {
        await sendLangPicker(uid, lang);
        return;
      }

      // rate limit (no spam)
      const waitMs = await rateLimit(uid);
      if (waitMs > 0) {
        await maybeWarnRateLimited(uid, uid, lang, waitMs);
        return;
      }

      // ensure/open ticket
      let ticket;
      try {
        ticket = await ensureTicket(uid, msg.from, { forceNew: false });
      } catch (e) {
        console.error("ensureTicket error:", e?.message || e);
        await withRetry(() => bot.sendMessage(uid, t(lang, "busy"), { reply_markup: await menuKeyboard(uid, lang) }));
        return;
      }

      // forward (copy) to support
      try {
        await copyUserMessageToSupport(uid, msg, ticket);
        await maybeAckSent(uid, uid, lang, ticket.ticketNo);
      } catch (e) {
        console.error("copyUserMessageToSupport error:", e?.message || e);
        await withRetry(() => bot.sendMessage(uid, t(lang, "busy"), { reply_markup: await menuKeyboard(uid, lang) }));
      }

      return;
    }

    // 2) Support group messages -> deliver admin replies back to user
    if (msg.chat.id === SUPPORT_GROUP_ID) {
      if (!msg.from || !isAdmin(msg.from.id)) return;

      // ignore commands in group
      if (msg.text && msg.text.startsWith("/")) return;

      // only process replies
      const replyTo = msg.reply_to_message;
      if (!replyTo) return;

      const uid = await getJSON(kMap(SUPPORT_GROUP_ID, replyTo.message_id));
      if (!uid) return;

      const userId = Number(uid);
      if (!Number.isFinite(userId)) return;

      const lang = await getUserLang(userId, null);

      try {
        if (msg.text) {
          await withRetry(() => bot.sendMessage(userId, `💬 Support:\n\n${msg.text}`), 4);
        } else {
          // copy any attachment/other content
          await withRetry(() => bot.copyMessage(userId, SUPPORT_GROUP_ID, msg.message_id), 4);
        }

        // bump lastAt
        const open = await getOpenTicket(userId);
        if (open?.ticketNo) {
          open.lastAt = Date.now();
          await setOpenTicket(userId, open);
        }
      } catch (e) {
        console.error("deliver to user error:", e?.message || e);
        // notify admin in-thread if possible
        try {
          await withRetry(
            () =>
              bot.sendMessage(
                SUPPORT_GROUP_ID,
                `⚠️ Failed to deliver reply to user ${userId}. Try again.`,
                msg.message_thread_id ? { message_thread_id: msg.message_thread_id } : undefined
              ),
            2
          );
        } catch {}
        // also notify user (optional, minimal)
        try {
          await withRetry(() => bot.sendMessage(userId, t(lang, "busy")), 2);
        } catch {}
      }

      return;
    }
  })
);

module.exports = { bot };
