
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

/* ---------------- i18n ---------------- */
const I18N = {
  en: {
    chooseLang: "Choose support language:",
    langSaved: "Done. Language: English.\n\nSend your question as a message — I will forward it to support.\nCommands: /new /status",
    welcome: "Send your question as a message — I will forward it to support.\nCommands: /new /status",
    rate: "⏳ Too fast. Wait ~2 seconds and send again.",
    newTicket: (n) => `✅ New ticket created. Ticket #${n}\nSend your message.`,
    sent: (n) => `✅ Sent to support. Ticket #${n}`,
    noTicket: "No active tickets.",
    statusOpen: (n, last) => `🧾 Ticket #${n}: OPEN\nLast message: ${last}`,
    statusClosed: (n) => `🧾 Ticket #${n}: CLOSED`,
    errSend: "⚠️ Failed to forward. Try again.",
    misconfig: "⚠️ Support chat is misconfigured (topics/forum). Message forwarded without topic.",
    adminOnly: "⚠️ Admin only.",
    unknownCmd: "Unknown command. Available: /new /status",
    closedBySupport: (n) => `🧾 Ticket #${n} was closed by support. Use /new to open a new one.`
  },
  ru: {
    chooseLang: "Выбери язык поддержки:",
    langSaved: "Готово. Язык: Русский.\n\nОтправь вопрос сообщением — я передам в поддержку.\nКоманды: /new /status",
    welcome: "Отправь вопрос сообщением — я передам в поддержку.\nКоманды: /new /status",
    rate: "⏳ Слишком часто. Подожди ~2 секунды и отправь снова.",
    newTicket: (n) => `✅ Создан новый тикет. Тикет #${n}\nОтправь сообщение.`,
    sent: (n) => `✅ Отправлено в поддержку. Тикет #${n}`,
    noTicket: "Активных тикетов нет.",
    statusOpen: (n, last) => `🧾 Тикет #${n}: ОТКРЫТ\nПоследнее сообщение: ${last}`,
    statusClosed: (n) => `🧾 Тикет #${n}: ЗАКРЫТ`,
    errSend: "⚠️ Не получилось отправить в поддержку. Попробуй ещё раз.",
    misconfig: "⚠️ Чат поддержки настроен без Topics/форума. Сообщение отправлено без темы.",
    adminOnly: "⚠️ Только для админов.",
    unknownCmd: "Неизвестная команда. Доступно: /new /status",
    closedBySupport: (n) => `🧾 Тикет #${n} закрыт поддержкой. Используй /new чтобы открыть новый.`
  }
};

const LANG_KEY = (userId) => `lang:${userId}`;
const PENDING_START_KEY = (userId) => `startp:${userId}`;

// маленький кэш в памяти для скорости
const langCache = new Map(); // userId -> { lang, exp }
async function getLang(userId) {
  const now = Date.now();
  const c = langCache.get(userId);
  if (c && c.exp > now) return c.lang;

  const v = await store.get(LANG_KEY(userId));
  const lang = v === "ru" ? "ru" : v === "en" ? "en" : null;
  if (lang) langCache.set(userId, { lang, exp: now + 10 * 60 * 1000 });
  return lang;
}
async function setLang(userId, lang) {
  const v = lang === "ru" ? "ru" : "en";
  await store.set(LANG_KEY(userId), v);
  langCache.set(userId, { lang: v, exp: Date.now() + 10 * 60 * 1000 });
  return v;
}

function langKeyboard() {
  return {
    inline_keyboard: [[
      { text: "English", callback_data: "lang:en" },
      { text: "Русский", callback_data: "lang:ru" }
    ]]
  };
}

function safeUsername(u) {
  if (!u) return "";
  if (u.username) return `@${u.username}`;
  const name = [u.first_name, u.last_name].filter(Boolean).join(" ").trim();
  return name ? name : "";
}

/* ---------------- tickets ---------------- */
const ticketKey = (userId) => `ticket:${userId}`;
const topicKey = (topicId) => `topic:${topicId}`;
const mapKey = (chatId, messageId) => `map:${chatId}:${messageId}`;
const seqKey = `ticket:seq`;

async function closeTicketForUser(userId, reason = "closed") {
  const t = await store.get(ticketKey(userId));
  if (!t) return;

  t.status = reason;
  t.closedAt = Date.now();
  await store.set(ticketKey(userId), t);

  if (t.topicId) {
    try {
      await bot.closeForumTopic(SUPPORT_GROUP_ID, t.topicId);
    } catch {}
  }
}

async function ensureTicket(user) {
  const userId = user.id;
  const existing = await store.get(ticketKey(userId));
  if (existing && existing.status === "open") {
    return { ...existing, isNew: false };
  }

  const ticketNo = await store.incr(seqKey);

  // пробуем создать Topic
  let topicId = null;
  let forumOk = true;

  const titleRaw = `#${ticketNo} u${userId} ${safeUsername(user)}`.trim();
  const title = titleRaw.length > 120 ? titleRaw.slice(0, 120) : titleRaw;

  try {
    const created = await bot.createForumTopic(SUPPORT_GROUP_ID, title);
    topicId = created.message_thread_id;
  } catch (e) {
    forumOk = false;
  }

  const ticket = {
    ticketNo,
    topicId,               // null если форум не доступен
    status: "open",
    createdAt: Date.now(),
    lastUserMsgAt: Date.now(),
    user: {
      id: userId,
      username: user.username || null,
      first_name: user.first_name || null,
      last_name: user.last_name || null
    }
  };

  await store.set(ticketKey(userId), ticket);
  if (topicId) await store.set(topicKey(topicId), userId);

  // Заголовок в поддержку (и маппинг reply -> user)
  const userTag = safeUsername(user);
  const userLine = userTag ? `${userTag} (id ${userId})` : `id ${userId}`;

  const headerText = `🆕 Ticket #${ticketNo}\nUser: ${userLine}`;

  let headerMsg;
  try {
    headerMsg = await bot.sendMessage(
      SUPPORT_GROUP_ID,
      headerText,
      topicId ? { message_thread_id: topicId } : undefined
    );
    await store.set(mapKey(SUPPORT_GROUP_ID, headerMsg.message_id), userId, { ex: 60 * 60 * 24 * 30 });
  } catch {}

  return { ...ticket, isNew: true, forumOk };
}

async function forwardUserMessageToSupport(msg, ticket) {
  const userId = msg.from.id;
  const topicId = ticket.topicId || null;

  // Обновляем lastUserMsgAt
  ticket.lastUserMsgAt = Date.now();
  await store.set(ticketKey(userId), ticket);

  // Текст — быстрее слать sendMessage (и читаемо), медиа — copyMessage
  try {
    let sent;

    if (msg.text) {
      const userTag = safeUsername(msg.from);
      const prefix = userTag ? `${userTag} (id ${userId})` : `id ${userId}`;
      const text = `👤 ${prefix}\n\n${msg.text}`;
      sent = await bot.sendMessage(
        SUPPORT_GROUP_ID,
        text,
        topicId ? { message_thread_id: topicId } : undefined
      );
    } else {
      sent = await bot.copyMessage(
        SUPPORT_GROUP_ID,
        msg.chat.id,
        msg.message_id,
        topicId ? { message_thread_id: topicId } : undefined
      );
    }

    // sent может быть {message_id} или полноценное сообщение
    const mid = sent?.message_id;
    if (mid) {
      await store.set(mapKey(SUPPORT_GROUP_ID, mid), userId, { ex: 60 * 60 * 24 * 30 });
    }
    return true;
  } catch (e) {
    return false;
  }
}

/* ---------------- anti-spam (без спама ботом) ---------------- */
const RL_MS = 1800;         // “~2 секунды”
const RL_NOTIFY_MS = 6000;  // предупреждать не чаще раза в 6 сек

async function rateLimitCheck(userId) {
  const now = Date.now();
  const k = `rl:${userId}`;
  const nk = `rln:${userId}`;

  const last = await store.get(k);
  if (last && now - Number(last) < RL_MS) {
    const lastN = await store.get(nk);
    const shouldNotify = !lastN || now - Number(lastN) > RL_NOTIFY_MS;
    if (shouldNotify) await store.set(nk, String(now), { ex: 60 });
    return { limited: true, notify: shouldNotify };
  }

  await store.set(k, String(now), { ex: 60 });
  return { limited: false, notify: false };
}

// “✅ отправлено” не спамим каждое сообщение
async function shouldAck(userId) {
  const k = `ack:${userId}`;
  const v = await store.get(k);
  if (v) return false;
  await store.set(k, "1", { ex: 12 }); // не чаще, чем раз в 12 секунд
  return true;
}

/* ---------------- /start language picker ---------------- */
bot.onText(/^\/start(?:\s+(.+))?$/, async (msg, match) => {
  if (msg.chat.type !== "private") return;

  const param = (match && match[1]) ? String(match[1]) : "";
  if (param) await store.set(PENDING_START_KEY(msg.from.id), param, { ex: 3600 });

  const lang = await getLang(msg.from.id);
  if (!lang) {
    await bot.sendMessage(msg.chat.id, I18N.en.chooseLang, {
      reply_markup: langKeyboard()
    });
    return;
  }

  await bot.sendMessage(msg.chat.id, I18N[lang].welcome);
});

bot.on("callback_query", async (q) => {
  try {
    const data = q.data || "";
    if (!data.startsWith("lang:")) return;

    const userId = q.from.id;
    const chosen = data.endsWith("ru") ? "ru" : "en";
    const lang = await setLang(userId, chosen);

    // Ответим на callback (чтобы Telegram не крутил “loading”)
    try { await bot.answerCallbackQuery(q.id); } catch {}

    // Обновим сообщение или просто отправим новое
    const chatId = q.message?.chat?.id;
    if (chatId) {
      await bot.sendMessage(chatId, I18N[lang].langSaved);
    }
  } catch (e) {}
});

/* ---------------- user commands ---------------- */
bot.onText(/^\/new$/, async (msg) => {
  if (msg.chat.type !== "private") return;

  const lang = await getLang(msg.from.id);
  if (!lang) {
    await bot.sendMessage(msg.chat.id, I18N.en.chooseLang, { reply_markup: langKeyboard() });
    return;
  }

  await closeTicketForUser(msg.from.id, "closed_by_user");
  const ticket = await ensureTicket(msg.from);

  await bot.sendMessage(msg.chat.id, I18N[lang].newTicket(ticket.ticketNo));
});

bot.onText(/^\/status$/, async (msg) => {
  if (msg.chat.type !== "private") return;

  const lang = (await getLang(msg.from.id)) || "en";
  const t = await store.get(ticketKey(msg.from.id));
  if (!t) {
    await bot.sendMessage(msg.chat.id, I18N[lang].noTicket);
    return;
  }

  const last = t.lastUserMsgAt ? new Date(t.lastUserMsgAt).toLocaleString() : "—";
  if (t.status === "open") {
    await bot.sendMessage(msg.chat.id, I18N[lang].statusOpen(t.ticketNo, last));
  } else {
    await bot.sendMessage(msg.chat.id, I18N[lang].statusClosed(t.ticketNo));
  }
});

/* ---------------- main message router ---------------- */
bot.on("message", async (msg) => {
  // 1) support group side
  if (msg.chat && msg.chat.id === SUPPORT_GROUP_ID) {
    // /id в группе
    if (msg.text === "/id") {
      await bot.sendMessage(
        msg.chat.id,
        `chat.id = ${msg.chat.id}\nthread = ${msg.message_thread_id || "—"}`
      );
      return;
    }

    // /close внутри темы
    if (msg.text === "/close") {
      if (!msg.from || !isAdmin(msg.from.id)) {
        await bot.sendMessage(msg.chat.id, I18N.en.adminOnly);
        return;
      }
      const topicId = msg.message_thread_id;
      if (!topicId) return;

      const userId = await store.get(topicKey(topicId));
      if (userId) {
        const t = await store.get(ticketKey(userId));
        if (t) {
          t.status = "closed_by_support";
          t.closedAt = Date.now();
          await store.set(ticketKey(userId), t);
          try {
            await bot.sendMessage(Number(userId), I18N[(await getLang(userId)) || "en"].closedBySupport(t.ticketNo));
          } catch {}
        }
        await store.del(topicKey(topicId));
      }

      try { await bot.closeForumTopic(SUPPORT_GROUP_ID, topicId); } catch {}
      return;
    }

    // /reply <userId> <text>
    if (msg.text && msg.text.startsWith("/reply")) {
      if (!msg.from || !isAdmin(msg.from.id)) {
        await bot.sendMessage(msg.chat.id, I18N.en.adminOnly);
        return;
      }
      const m = msg.text.match(/^\/reply\s+(\d+)\s+([\s\S]+)/);
      if (!m) return;
      const userId = Number(m[1]);
      const text = String(m[2]).trim();
      if (!text) return;

      await bot.sendMessage(userId, `💬 Support:\n\n${text}`);
      return;
    }

    // reply в теме -> пользователю
    if (!msg.from || !isAdmin(msg.from.id)) return;
    if (msg.text && msg.text.startsWith("/")) return; // команды не пересылаем

    const replyTo = msg.reply_to_message;
    if (!replyTo) return;

    const userId = await store.get(mapKey(SUPPORT_GROUP_ID, replyTo.message_id));
    if (!userId) return;

    try {
      if (msg.text) {
        await bot.sendMessage(Number(userId), `💬 Support:\n\n${msg.text}`);
      } else {
        await bot.copyMessage(Number(userId), SUPPORT_GROUP_ID, msg.message_id);
      }
    } catch (e) {
      // ничего
    }
    return;
  }

  // 2) private user side
  if (!msg.chat || msg.chat.type !== "private") return;
  if (!msg.from) return;

  // /id в личке тоже полезен
  if (msg.text === "/id") {
    await bot.sendMessage(msg.chat.id, `chat.id = ${msg.chat.id}`);
    return;
  }

  // неизвестные команды
  if (msg.text && msg.text.startsWith("/")) {
    const known = ["/start", "/new", "/status", "/id"];
    if (!known.includes(msg.text.split(" ")[0])) {
      const lang = (await getLang(msg.from.id)) || "en";
      await bot.sendMessage(msg.chat.id, I18N[lang].unknownCmd);
    }
    return;
  }

  const lang = await getLang(msg.from.id);
  if (!lang) {
    await bot.sendMessage(msg.chat.id, I18N.en.chooseLang, { reply_markup: langKeyboard() });
    return;
  }

  const rl = await rateLimitCheck(msg.from.id);
  if (rl.limited) {
    if (rl.notify) await bot.sendMessage(msg.chat.id, I18N[lang].rate);
    return;
  }

  const ticket = await ensureTicket(msg.from);

  const ok = await forwardUserMessageToSupport(msg, ticket);
  if (!ok) {
    await bot.sendMessage(msg.chat.id, I18N[lang].errSend);
    return;
  }

  // если Topics не создались — предупредим один раз
  if (ticket.isNew && ticket.topicId == null) {
    await bot.sendMessage(msg.chat.id, I18N[lang].misconfig);
  }

  // подтверждение — не спамим каждое сообщение
  if (ticket.isNew) {
    await bot.sendMessage(msg.chat.id, I18N[lang].newTicket(ticket.ticketNo));
  } else {
    if (await shouldAck(msg.from.id)) {
      await bot.sendMessage(msg.chat.id, I18N[lang].sent(ticket.ticketNo));
    }
  }
});

/* ---------------- webhook entry ----------------
   ВАЖНО: это то, чего не хватало — handleUpdate экспортируется
   и webhook.js больше не падает.
------------------------------------------------- */
async function handleUpdate(update) {
  if (!update || typeof update !== "object") return;

  // дедупликация апдейтов (на случай ретраев Telegram при 500)
  if (typeof update.update_id === "number") {
    const key = `upd:${update.update_id}`;
    const r = await store.set(key, "1", { nx: true, ex: 600 });
    if (r === null) return; // уже обрабатывали
  }

  await bot.processUpdate(update);
}

module.exports = { bot, handleUpdate };
