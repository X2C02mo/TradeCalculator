// support-bot.js
const TelegramBot = require("node-telegram-bot-api");
const store = require("./store");

const BOT_TOKEN = process.env.SUPPORT_BOT_TOKEN;
if (!BOT_TOKEN) throw new Error("SUPPORT_BOT_TOKEN is not set");

function mustInt(name, v) {
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`${name} must be a number`);
  return n;
}

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

// Важно: no polling
const bot = new TelegramBot(BOT_TOKEN, { polling: false });

/* ---------------- keys ---------------- */
const K = {
  lang: (uid) => `lang:${uid}`,
  open: (uid) => `open:${uid}`,
  tickets: (uid) => `tickets:${uid}`,
  topic2user: (topicId) => `topic2user:${topicId}`,
  map: (msgId) => `map:${msgId}`,
  rl: (uid) => `rl:${uid}`
};

/* ---------------- small helpers ---------------- */
function safeUsername(u) {
  if (!u) return "";
  if (u.username) return `@${u.username}`;
  const name = [u.first_name, u.last_name].filter(Boolean).join(" ").trim();
  return name || "";
}

function txt(lang, ru, en) {
  return lang === "ru" ? ru : en;
}

async function getLang(uid) {
  const v = await store.get(K.lang(uid));
  return v === "ru" || v === "en" ? v : null;
}
async function setLang(uid, lang) {
  await store.set(K.lang(uid), lang);
}

function langKeyboard() {
  return {
    inline_keyboard: [
      [{ text: "English", callback_data: "LANG_EN" }],
      [{ text: "Русский", callback_data: "LANG_RU" }]
    ]
  };
}

async function askLanguage(chatId) {
  await bot.sendMessage(chatId, "Choose language / Выбери язык:", {
    reply_markup: langKeyboard()
  });
}

async function rateLimited(uid) {
  // 1 msg / 2 sec
  const ok = await store.setNX(K.rl(uid), 1, 2);
  return !ok;
}

function is429(e) {
  const code = e?.response?.body?.error_code;
  const desc = e?.response?.body?.description || e?.message || "";
  return code === 429 || /Too Many Requests/i.test(desc);
}
function errDesc(e) {
  return e?.response?.body?.description || e?.message || "Unknown error";
}
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

/* ---------------- tickets ---------------- */
async function getOpen(uid) {
  const t = await store.get(K.open(uid));
  return t && typeof t === "object" ? t : null;
}
async function setOpen(uid, obj) { await store.set(K.open(uid), obj); }

async function pushHistory(uid, ticket) {
  const arr = (await store.get(K.tickets(uid))) || [];
  const list = Array.isArray(arr) ? arr : [];
  list.unshift(ticket);
  if (list.length > 30) list.pop();
  await store.set(K.tickets(uid), list);
}

async function createTopicOrFallback(user) {
  const titleRaw = `u${user.id} ${safeUsername(user)}`.trim();
  const title = titleRaw.length > 120 ? titleRaw.slice(0, 120) : titleRaw;

  try {
    return await bot.createForumTopic(SUPPORT_GROUP_ID, title);
  } catch (e) {
    if (is429(e)) {
      await sleep(600);
      return await bot.createForumTopic(SUPPORT_GROUP_ID, title);
    }
    throw e;
  }
}

async function ensureTicket(user) {
  const uid = user.id;
  const existing = await getOpen(uid);
  if (existing?.status === "open" && typeof existing.topicId === "number") {
    return existing.topicId;
  }

  let topicId = 0; // 0 = fallback в общий чат группы
  try {
    const created = await createTopicOrFallback(user);
    topicId = created.message_thread_id;
    await store.set(K.topic2user(topicId), uid);
  } catch (e) {
    // темы не создаются — fallback
    topicId = 0;
    try {
      await bot.sendMessage(
        SUPPORT_GROUP_ID,
        `⚠️ Can't create forum topic for user ${uid} (${safeUsername(user)}).\nReason: ${errDesc(e)}\nCheck: group is Forum + bot has “Manage Topics”.`
      );
    } catch (_) {}
  }

  const ticket = {
    topicId,
    createdAt: Date.now(),
    lastAt: Date.now(),
    status: "open",
    user: { id: uid, username: user.username || null, first_name: user.first_name || null, last_name: user.last_name || null }
  };

  await setOpen(uid, ticket);
  await pushHistory(uid, { ...ticket });

  // header в поддержку
  try {
    const header = await bot.sendMessage(
      SUPPORT_GROUP_ID,
      `🆕 New ticket\nUser: ${safeUsername(user)}\nID: ${uid}`,
      topicId ? { message_thread_id: topicId } : undefined
    );
    await store.set(K.map(header.message_id), uid);
  } catch (_) {}

  return topicId;
}

async function forwardUserMessageToSupport(msg, topicId) {
  const copied = await bot.copyMessage(
    SUPPORT_GROUP_ID,
    msg.chat.id,
    msg.message_id,
    topicId ? { message_thread_id: topicId } : undefined
  );
  await store.set(K.map(copied.message_id), msg.from.id);

  const open = await getOpen(msg.from.id);
  if (open?.status === "open") {
    await setOpen(msg.from.id, { ...open, lastAt: Date.now() });
  }
}

/* ---------------- parsing commands ---------------- */
function parseCommand(text) {
  if (!text || typeof text !== "string") return null;
  if (!text.startsWith("/")) return null;
  const [cmd, ...rest] = text.trim().split(" ");
  return { cmd: cmd.toLowerCase(), args: rest.join(" ").trim() };
}

/* ---------------- main handler ---------------- */
async function handleUpdate(update) {
  // callback query (язык)
  if (update.callback_query) {
    const q = update.callback_query;
    const uid = q.from?.id;
    if (!uid) return;

    if (q.data === "LANG_RU" || q.data === "LANG_EN") {
      const lang = q.data === "LANG_RU" ? "ru" : "en";
      await setLang(uid, lang);

      try { await bot.answerCallbackQuery(q.id, { text: "✅" }); } catch (_) {}

      await bot.sendMessage(
        uid,
        txt(
          lang,
          "Готово. Отправь вопрос сообщением — я передам в поддержку.\nКоманды: /new /status",
          "Done. Send your question — I will forward it to support.\nCommands: /new /status"
        )
      );
    } else {
      try { await bot.answerCallbackQuery(q.id); } catch (_) {}
    }
    return;
  }

  const msg = update.message;
  if (!msg) return;

  // --- USER private chat ---
  if (msg.chat?.type === "private") {
    if (!msg.from) return;

    const c = parseCommand(msg.text);

    // /start
    if (c?.cmd === "/start") {
      const lang = await getLang(msg.from.id);
      if (!lang) {
        await askLanguage(msg.chat.id);
        return;
      }
      await bot.sendMessage(
        msg.chat.id,
        txt(
          lang,
          "👋 Trade Support\n\nОтправь сюда вопрос — я создам заявку и передам в поддержку. Ответ придёт сюда же.\n\nКоманды: /new /status",
          "👋 Trade Support\n\nSend your question here — I will create a ticket and forward it to support. The reply will come here.\n\nCommands: /new /status"
        )
      );
      return;
    }

    // язык ещё не выбран
    const lang = await getLang(msg.from.id);
    if (!lang) {
      await askLanguage(msg.chat.id);
      return;
    }

    // /new
    if (c?.cmd === "/new") {
      const prev = await getOpen(msg.from.id);
      if (prev?.status === "open") {
        await setOpen(msg.from.id, { ...prev, status: "closed", closedAt: Date.now() });
      }
      await setOpen(msg.from.id, { status: "open" });

      const topicId = await ensureTicket(msg.from);
      await bot.sendMessage(
        msg.chat.id,
        txt(
          lang,
          `✅ Создан новый тикет. Отправь сообщение.\nTicket: ${topicId ? "#" + topicId : "(no topic)"}`,
          `✅ New ticket created. Send a message.\nTicket: ${topicId ? "#" + topicId : "(no topic)"}`
        )
      );
      return;
    }

    // /status
    if (c?.cmd === "/status") {
      const open = await getOpen(msg.from.id);
      const hist = (await store.get(K.tickets(msg.from.id))) || [];
      const count = Array.isArray(hist) ? hist.length : 0;

      if (!open?.createdAt) {
        await bot.sendMessage(
          msg.chat.id,
          txt(
            lang,
            `📌 Активных заявок нет.\nИстория: ${count}\n\nНовая: /new`,
            `📌 No active tickets.\nHistory: ${count}\n\nNew: /new`
          )
        );
        return;
      }

      const tid = open.topicId ? `#${open.topicId}` : "(no topic)";
      await bot.sendMessage(
        msg.chat.id,
        txt(
          lang,
          `📌 Текущая заявка: ${open.status.toUpperCase()} ${tid}\nСоздана: ${new Date(open.createdAt).toLocaleString()}\nОбновлена: ${new Date(open.lastAt || open.createdAt).toLocaleString()}\nИстория: ${count}`,
          `📌 Current ticket: ${open.status.toUpperCase()} ${tid}\nCreated: ${new Date(open.createdAt).toLocaleString()}\nUpdated: ${new Date(open.lastAt || open.createdAt).toLocaleString()}\nHistory: ${count}`
        )
      );
      return;
    }

    // другие команды — игнор
    if (c) return;

    // rate limit
    if (await rateLimited(msg.from.id)) {
      await bot.sendMessage(
        msg.chat.id,
        txt(lang, "⏳ Слишком часто. Подожди 2 секунды и отправь снова.", "⏳ Too fast. Wait 2 seconds and send again.")
      );
      return;
    }

    // обычное сообщение: создаём тикет и копируем в поддержку
    const topicId = await ensureTicket(msg.from);
    try {
      await forwardUserMessageToSupport(msg, topicId);
    } catch (e) {
      await bot.sendMessage(
        msg.chat.id,
        txt(lang, "⚠️ Не удалось передать сообщение. Отправь ещё раз.", "⚠️ Failed to forward. Please send again.")
      );
    }
    return;
  }

  // --- SUPPORT group ---
  if (msg.chat?.id === SUPPORT_GROUP_ID) {
    if (!msg.from || !isAdmin(msg.from.id)) return;

    const c = parseCommand(msg.text);

    if (c?.cmd === "/id") {
      const tid = msg.message_thread_id ? `\nthread_id = ${msg.message_thread_id}` : "";
      await bot.sendMessage(msg.chat.id, `chat.id = ${msg.chat.id}${tid}`);
      return;
    }

    if (c?.cmd === "/reply") {
      // /reply <userId> <text>
      const m = (msg.text || "").match(/^\/reply\s+(\d+)\s+([\s\S]+)/);
      if (!m) return;
      const userId = Number(m[1]);
      const text = String(m[2]).trim();
      if (!text) return;

      await bot.sendMessage(userId, `💬 Support:\n\n${text}`).catch(() => {});
      await bot.sendMessage(
        msg.chat.id,
        "✅ Sent.",
        msg.message_thread_id ? { message_thread_id: msg.message_thread_id } : undefined
      ).catch(() => {});
      return;
    }

    if (c?.cmd === "/close") {
      const topicId = msg.message_thread_id;
      if (!topicId) {
        await bot.sendMessage(msg.chat.id, "⚠️ Use /close inside a topic.");
        return;
      }

      const userId = await store.get(K.topic2user(topicId));
      if (userId) {
        const open = await getOpen(Number(userId));
        if (open?.status === "open") {
          await setOpen(Number(userId), { ...open, status: "closed", closedAt: Date.now() });
        }
        await store.del(K.topic2user(topicId));
      }

      try { await bot.closeForumTopic(SUPPORT_GROUP_ID, topicId); } catch (_) {}
      await bot.sendMessage(msg.chat.id, "🧾 Ticket closed.", { message_thread_id: topicId });
      return;
    }

    // reply-to-user logic
    if (!msg.reply_to_message) return;
    if (c) return; // не пересылаем команды

    const mappedUser = await store.get(K.map(msg.reply_to_message.message_id));
    if (!mappedUser) return;

    const userId = Number(mappedUser);

    if (msg.text) {
      await bot.sendMessage(userId, `💬 Support:\n\n${msg.text}`).catch(() => {});
      return;
    }

    try {
      await bot.copyMessage(userId, SUPPORT_GROUP_ID, msg.message_id);
    } catch (_) {
      // молча
    }
  }
}

module.exports = { bot, handleUpdate };
