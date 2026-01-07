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
  if (!ADMIN_USER_IDS.length) return true; // если не задано — считаем тебя админом везде
  return ADMIN_USER_IDS.includes(Number(userId));
}

const bot = new TelegramBot(BOT_TOKEN, { polling: false });

/* ---------------- keys ---------------- */
const K = {
  lang: (uid) => `lang:${uid}`,
  open: (uid) => `open:${uid}`,                 // текущий тикет
  tickets: (uid) => `tickets:${uid}`,           // история
  topic2user: (topicId) => `topic2user:${topicId}`,
  map: (chatId, msgId) => `map:${chatId}:${msgId}`,
  rl: (uid) => `rl:${uid}`
};

/* ---------------- i18n ---------------- */
function msgText(lang, ru, en) {
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
  await bot.sendMessage(
    chatId,
    "Choose language / Выбери язык:",
    { reply_markup: langKeyboard() }
  );
}

/* ---------------- helpers ---------------- */
function safeUsername(u) {
  if (!u) return "";
  if (u.username) return `@${u.username}`;
  const name = [u.first_name, u.last_name].filter(Boolean).join(" ").trim();
  return name || "";
}

function tgDesc(e) {
  return e?.response?.body?.description || e?.message || "Unknown error";
}

function is429(e) {
  const code = e?.response?.body?.error_code;
  return code === 429 || /Too Many Requests/i.test(tgDesc(e));
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function rateLimited(uid) {
  // 1 сообщение / 2 сек (атомарно, быстро)
  const ok = await store.setNX(K.rl(uid), 1, 2);
  return !ok;
}

/* ---------------- tickets ---------------- */
async function getOpenTicket(uid) {
  const t = await store.get(K.open(uid));
  return t && typeof t === "object" ? t : null;
}

async function setOpenTicket(uid, ticket) {
  await store.set(K.open(uid), ticket);
}

async function pushTicketHistory(uid, ticket) {
  const arr = (await store.get(K.tickets(uid))) || [];
  const next = Array.isArray(arr) ? arr : [];
  next.unshift(ticket);
  if (next.length > 30) next.pop();
  await store.set(K.tickets(uid), next);
}

async function updateOpenTicket(uid, patch) {
  const t = (await getOpenTicket(uid)) || {};
  const next = { ...t, ...patch };
  await setOpenTicket(uid, next);
  return next;
}

async function createTopic(title) {
  // 1 retry на 429
  try {
    return await bot.createForumTopic(SUPPORT_GROUP_ID, title);
  } catch (e) {
    if (is429(e)) {
      await sleep(900);
      return await bot.createForumTopic(SUPPORT_GROUP_ID, title);
    }
    throw e;
  }
}

async function ensureTicket(user) {
  const uid = user.id;

  const existing = await getOpenTicket(uid);
  if (existing?.status === "open" && existing?.topicId) return existing.topicId;
  if (existing?.status === "open" && existing?.topicId === 0) return 0; // fallback режим без темы

  const titleRaw = `u${uid} ${safeUsername(user)}`.trim();
  const title = titleRaw.length > 120 ? titleRaw.slice(0, 120) : titleRaw;

  // пытаемся создать тему
  let topicId = null;
  try {
    const created = await createTopic(title);
    topicId = created.message_thread_id;
  } catch (e) {
    // fallback: если темы не создаются — пишем в общий чат группы (topicId=0)
    topicId = 0;

    // сообщаем в группу, что темы сломаны
    try {
      await bot.sendMessage(
        SUPPORT_GROUP_ID,
        `⚠️ Can't create forum topic.\nReason: ${tgDesc(e)}\nCheck: group is a forum + bot has “Manage Topics”.`
      );
    } catch (_) {}
  }

  const ticket = {
    topicId,
    createdAt: Date.now(),
    lastAt: Date.now(),
    status: "open",
    user: {
      id: uid,
      username: user.username || null,
      first_name: user.first_name || null,
      last_name: user.last_name || null
    }
  };

  await setOpenTicket(uid, ticket);
  await pushTicketHistory(uid, { ...ticket });

  if (topicId && topicId !== 0) {
    await store.set(K.topic2user(topicId), uid);
  }

  // header
  try {
    const headerText = `🆕 New ticket\nUser: ${safeUsername(user)}\nID: ${uid}`;
    const header = await bot.sendMessage(
      SUPPORT_GROUP_ID,
      headerText,
      topicId && topicId !== 0 ? { message_thread_id: topicId } : undefined
    );
    await store.set(K.map(SUPPORT_GROUP_ID, header.message_id), uid);
  } catch (_) {}

  return topicId;
}

async function copyUserMessageToSupport(msg, topicId) {
  const opts = (topicId && topicId !== 0) ? { message_thread_id: topicId } : undefined;

  const copied = await bot.copyMessage(SUPPORT_GROUP_ID, msg.chat.id, msg.message_id, opts);
  const newMessageId = copied.message_id;

  await store.set(K.map(SUPPORT_GROUP_ID, newMessageId), msg.from.id);
  await updateOpenTicket(msg.from.id, { lastAt: Date.now() });
}

/* ---------------- commands: user ---------------- */
bot.onText(/^\/start(?:\s+(.+))?$/, async (msg) => {
  if (msg.chat.type !== "private") return;

  const lang = await getLang(msg.from.id);
  if (!lang) {
    await askLanguage(msg.chat.id);
    return;
  }

  await bot.sendMessage(
    msg.chat.id,
    msgText(
      lang,
      "👋 Trade Support\n\nОтправь сюда вопрос — я создам заявку и передам в поддержку. Ответ придёт сюда же.\n\nКоманды: /new /status",
      "👋 Trade Support\n\nSend your question here — I will create a ticket and forward it to support. The reply will come here.\n\nCommands: /new /status"
    )
  );
});

bot.onText(/^\/new$/, async (msg) => {
  if (msg.chat.type !== "private") return;

  const lang = await getLang(msg.from.id);
  if (!lang) {
    await askLanguage(msg.chat.id);
    return;
  }

  // закрываем текущий open-ticket локально (в группе можно /close)
  const old = await getOpenTicket(msg.from.id);
  if (old?.status === "open") {
    await setOpenTicket(msg.from.id, { ...old, status: "closed", closedAt: Date.now() });
  }

  await setOpenTicket(msg.from.id, { status: "open" }); // сброс
  const topicId = await ensureTicket(msg.from);

  await bot.sendMessage(
    msg.chat.id,
    msgText(
      lang,
      `✅ Создан новый тикет. Отправь сообщение.\nTicket: ${topicId && topicId !== 0 ? "#" + topicId : "(no topic)"}`,
      `✅ New ticket created. Send a message.\nTicket: ${topicId && topicId !== 0 ? "#" + topicId : "(no topic)"}`
    )
  );
});

bot.onText(/^\/status$/, async (msg) => {
  if (msg.chat.type !== "private") return;

  const lang = await getLang(msg.from.id);
  if (!lang) {
    await askLanguage(msg.chat.id);
    return;
  }

  const open = await getOpenTicket(msg.from.id);
  const hist = (await store.get(K.tickets(msg.from.id))) || [];
  const count = Array.isArray(hist) ? hist.length : 0;

  if (!open || !open.createdAt) {
    await bot.sendMessage(
      msg.chat.id,
      msgText(
        lang,
        `📌 Активных заявок нет.\nИстория: ${count}\n\nНовая: /new`,
        `📌 No active tickets.\nHistory: ${count}\n\nNew: /new`
      )
    );
    return;
  }

  const isOpen = open.status === "open";
  const tid = open.topicId && open.topicId !== 0 ? `#${open.topicId}` : "(no topic)";

  await bot.sendMessage(
    msg.chat.id,
    msgText(
      lang,
      `📌 Текущая заявка: ${isOpen ? "OPEN" : "CLOSED"} ${tid}\nСоздана: ${new Date(open.createdAt).toLocaleString()}\nОбновлена: ${new Date(open.lastAt || open.createdAt).toLocaleString()}\nИстория: ${count}`,
      `📌 Current ticket: ${isOpen ? "OPEN" : "CLOSED"} ${tid}\nCreated: ${new Date(open.createdAt).toLocaleString()}\nUpdated: ${new Date(open.lastAt || open.createdAt).toLocaleString()}\nHistory: ${count}`
    )
  );
});

/* ---------------- language buttons ---------------- */
bot.on("callback_query", async (q) => {
  try {
    const uid = q.from.id;
    if (q.data === "LANG_RU" || q.data === "LANG_EN") {
      const lang = q.data === "LANG_RU" ? "ru" : "en";
      await setLang(uid, lang);
      await bot.answerCallbackQuery(q.id, { text: "✅" });

      await bot.sendMessage(
        uid,
        msgText(
          lang,
          "Готово. Отправь вопрос сообщением — я передам в поддержку.\nКоманды: /new /status",
          "Done. Send your question — I will forward it to support.\nCommands: /new /status"
        )
      );
    } else {
      await bot.answerCallbackQuery(q.id).catch(() => {});
    }
  } catch (_) {}
});

/* ---------------- message router (fast) ---------------- */
bot.on("message", (msg) => {
  // не ждём, чтобы webhook отвечал быстро
  void (async () => {
    // USER PRIVATE
    if (msg.chat.type === "private") {
      if (!msg.from) return;

      // команды пропускаем (их ловит onText)
      if (msg.text && msg.text.startsWith("/")) return;

      const lang = await getLang(msg.from.id);
      if (!lang) {
        await askLanguage(msg.chat.id);
        return;
      }

      if (await rateLimited(msg.from.id)) {
        await bot.sendMessage(
          msg.chat.id,
          msgText(lang, "⏳ Слишком часто. Подожди 2 секунды и попробуй снова.", "⏳ Too fast. Wait 2 seconds and try again.")
        );
        return;
      }

      let topicId = null;
      try {
        topicId = await ensureTicket(msg.from);
      } catch (e) {
        await bot.sendMessage(
          msg.chat.id,
          msgText(
            lang,
            "⚠️ Поддержка временно недоступна. Попробуй позже.",
            "⚠️ Support is temporarily unavailable. Try again later."
          )
        );
        return;
      }

      try {
        await copyUserMessageToSupport(msg, topicId);
        // автоответ только при первом сообщении можно добавить, но это тормозит — оставляем молчаливым
      } catch (e) {
        await bot.sendMessage(
          msg.chat.id,
          msgText(
            lang,
            "⚠️ Не удалось передать сообщение. Попробуй ещё раз.",
            "⚠️ Failed to forward your message. Try again."
          )
        );
      }
      return;
    }

    // ADMIN GROUP
    if (msg.chat.id === SUPPORT_GROUP_ID) {
      if (!msg.from || !isAdmin(msg.from.id)) return;

      // reply -> отправляем юзеру
      const replyTo = msg.reply_to_message;
      if (!replyTo) return;

      // команды игнор
      if (msg.text && msg.text.startsWith("/")) return;

      const userId = await store.get(K.map(SUPPORT_GROUP_ID, replyTo.message_id));
      if (!userId) return;

      // текст
      if (msg.text) {
        await bot.sendMessage(Number(userId), `💬 Support:\n\n${msg.text}`).catch(() => {});
        await updateOpenTicket(Number(userId), { lastAt: Date.now() }).catch(() => {});
        return;
      }

      // медиа/файлы
      try {
        await bot.copyMessage(Number(userId), SUPPORT_GROUP_ID, msg.message_id);
        await updateOpenTicket(Number(userId), { lastAt: Date.now() }).catch(() => {});
      } catch (_) {}
      return;
    }
  })();
});

/* ---------------- commands: admin ---------------- */
bot.onText(/^\/id$/, async (msg) => {
  if (!msg.from || !isAdmin(msg.from.id)) return;
  await bot.sendMessage(msg.chat.id, `chat.id = ${msg.chat.id}`);
});

bot.onText(/^\/reply\s+(\d+)\s+([\s\S]+)/, async (msg, match) => {
  if (msg.chat.id !== SUPPORT_GROUP_ID) return;
  if (!msg.from || !isAdmin(msg.from.id)) return;

  const userId = Number(match[1]);
  const text = String(match[2]).trim();
  if (!text) return;

  await bot.sendMessage(userId, `💬 Support:\n\n${text}`).catch(() => {});
  await updateOpenTicket(userId, { lastAt: Date.now() }).catch(() => {});
  await bot.sendMessage(msg.chat.id, "✅ Sent.", msg.message_thread_id ? { message_thread_id: msg.message_thread_id } : undefined).catch(() => {});
});

bot.onText(/^\/close$/, async (msg) => {
  if (msg.chat.id !== SUPPORT_GROUP_ID) return;
  if (!msg.from || !isAdmin(msg.from.id)) return;

  const topicId = msg.message_thread_id;
  if (!topicId) {
    await bot.sendMessage(msg.chat.id, "⚠️ Use /close inside a topic.");
    return;
  }

  const userId = await store.get(K.topic2user(topicId));
  if (userId) {
    const open = await getOpenTicket(Number(userId));
    if (open?.status === "open") {
      await setOpenTicket(Number(userId), { ...open, status: "closed", closedAt: Date.now() });
    }
    await store.del(K.topic2user(topicId));
  }

  try {
    await bot.closeForumTopic(SUPPORT_GROUP_ID, topicId);
  } catch (_) {}

  await bot.sendMessage(msg.chat.id, "🧾 Ticket closed.", { message_thread_id: topicId });
});

module.exports = { bot };
