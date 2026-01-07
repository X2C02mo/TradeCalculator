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

// Tunables (ускорение UX, меньше спама)
const RATE_LIMIT_MS = Number(process.env.RATE_LIMIT_MS || 1200); // ограничение отправки
const RATE_WARN_MS = Number(process.env.RATE_WARN_MS || 6000);   // предупреждать не чаще
const ACK_COOLDOWN_MS = Number(process.env.ACK_COOLDOWN_MS || 15000); // "✅ Принято" не чаще
const CLOCK_SKEW_RESET_MS = 30000; // анти-залипание

const bot = new TelegramBot(BOT_TOKEN, { polling: false });

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

function detectDefaultLang(user, tgLangCode) {
  const code = (tgLangCode || user?.language_code || "").toLowerCase();
  if (/^ru|uk|be/.test(code)) return "ru";
  return "en";
}

function t(lang, key, vars = {}) {
  const dict = {
    ru: {
      chooseLang: "Выбери язык общения:",
      english: "English",
      russian: "Русский",
      ready: "Готово. Отправь вопрос сообщением — я передам в поддержку.\nКоманды: /new /status",
      startText:
        "👋 Trade Support\n\nОтправь сюда вопрос — я создам тикет и передам в поддержку. Ответ придёт сюда же.\n\nКоманды: /new /status",
      needLang: "Сначала выбери язык кнопками ниже.",
      tooFast: "⏳ Слишком часто. Подожди пару секунд и отправь снова.",
      accepted: "✅ Принято. Передал в поддержку.",
      newTicket: "✅ Создан новый тикет. Отправь сообщение.\nTicket: #",
      statusNone: "У тебя нет активных заявок. Нажми /new или просто отправь сообщение.",
      statusOpen: "📌 Твой тикет активен",
      statusId: "Ticket",
      statusCreated: "Создан",
      statusUpdated: "Последнее сообщение",
      statusTopic: "Thread",
      statusHint: "Чтобы открыть новый тикет: /new",
      errBusy: "⚠️ Поддержка сейчас перегружена. Попробуй чуть позже.",
      errForumOff:
        "⚠️ В группе поддержки выключены Темы (Forum topics) или боту не дали право создавать темы.\nАдмину: включить Topics и дать боту права.",
      adminNewTicket: "🆕 New ticket",
      adminUser: "User",
      adminId: "ID",
      adminSent: "✅ Sent.",
      adminCloseUse: "⚠️ Используй /close внутри темы (topic).",
      adminClosed: "🧾 Ticket closed.",
      adminDeliverFail: "⚠️ Failed to deliver non-text reply."
    },
    en: {
      chooseLang: "Choose language:",
      english: "English",
      russian: "Русский",
      ready: "Done. Send your question as a message — I’ll forward it to support.\nCommands: /new /status",
      startText:
        "👋 Trade Support\n\nSend your question here — I’ll create a ticket and forward it to support. Reply will come here.\n\nCommands: /new /status",
      needLang: "Please choose language using buttons below first.",
      tooFast: "⏳ Too fast. Wait a moment and send again.",
      accepted: "✅ Received. Forwarded to support.",
      newTicket: "✅ New ticket created. Send a message.\nTicket: #",
      statusNone: "No active tickets. Use /new or just send a message.",
      statusOpen: "📌 Your ticket is active",
      statusId: "Ticket",
      statusCreated: "Created",
      statusUpdated: "Last message",
      statusTopic: "Thread",
      statusHint: "To create a new ticket: /new",
      errBusy: "⚠️ Support is busy right now. Try again later.",
      errForumOff:
        "⚠️ Support group has Topics disabled, or bot lacks permissions.\nAdmin: enable Topics and allow the bot to manage topics.",
      adminNewTicket: "🆕 New ticket",
      adminUser: "User",
      adminId: "ID",
      adminSent: "✅ Sent.",
      adminCloseUse: "⚠️ Use /close inside a topic.",
      adminClosed: "🧾 Ticket closed.",
      adminDeliverFail: "⚠️ Failed to deliver non-text reply."
    }
  };

  const str = (dict[lang] && dict[lang][key]) ? dict[lang][key] : key;
  return str.replace(/\{(\w+)\}/g, (_, k) => (vars[k] ?? ""));
}

async function getUserLang(msg) {
  const userId = msg?.from?.id;
  if (!userId) return "en";
  const saved = await store.get(kLang(userId));
  if (saved === "ru" || saved === "en") return saved;
  const detected = detectDefaultLang(msg.from, msg.from?.language_code);
  return detected;
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

  // анти-залипание, если где-то записалось время "из будущего"
  if (lastOk > now + CLOCK_SKEW_RESET_MS) {
    lastOk = 0;
    await store.set(kLastOk(userId), 0);
  }

  const delta = now - lastOk;

  if (delta < RATE_LIMIT_MS) {
    const lastWarnRaw = await store.get(kLastWarn(userId));
    const lastWarn = Number(lastWarnRaw || 0);
    const shouldWarn = (now - lastWarn) >= RATE_WARN_MS;

    if (shouldWarn) {
      await store.set(kLastWarn(userId), now);
    }
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

  let created;
  try {
    created = await bot.createForumTopic(SUPPORT_GROUP_ID, title);
  } catch (e) {
    // типичные причины: нет Topics или нет прав
    throw e;
  }

  const topicId = created.message_thread_id;

  const ticket = {
    topicId,
    createdAt: Date.now(),
    lastUserMsgAt: null,
    lastSupportMsgAt: null,
    status: "open",
    user: {
      id: userId,
      username: user.username || null,
      first_name: user.first_name || null,
      last_name: user.last_name || null
    }
  };

  await setTicket(userId, ticket);
  await store.set(kTopic(topicId), userId);

  // header in topic
  const header = await bot.sendMessage(
    SUPPORT_GROUP_ID,
    `${t(lang, "adminNewTicket")}\n${t(lang, "adminUser")}: ${safeUsername(user)}\n${t(lang, "adminId")}: ${userId}`,
    { message_thread_id: topicId }
  );

  await store.set(kMap(SUPPORT_GROUP_ID, header.message_id), userId);

  return topicId;
}

async function copyUserMessageToTopic(msg, topicId) {
  const copied = await bot.copyMessage(SUPPORT_GROUP_ID, msg.chat.id, msg.message_id, {
    message_thread_id: topicId
  });

  const newMessageId = copied.message_id;
  await store.set(kMap(SUPPORT_GROUP_ID, newMessageId), msg.from.id);

  // update ticket timestamps
  const ticket = await getTicket(msg.from.id);
  if (ticket) {
    ticket.lastUserMsgAt = Date.now();
    await setTicket(msg.from.id, ticket);
  }
}

// ---------- /start with language choice ----------
bot.onText(/^\/start(?:\s+(.+))?$/, async (msg, match) => {
  if (msg.chat.type !== "private") return;

  const userId = msg.from.id;
  const saved = await store.get(kLang(userId));

  const param = (match && match[1]) ? String(match[1]) : "";
  const hint = param ? `\n\nSource: ${param}` : "";

  if (saved === "ru" || saved === "en") {
    const lang = saved;
    await bot.sendMessage(msg.chat.id, t(lang, "startText") + hint);
    return;
  }

  const langDefault = detectDefaultLang(msg.from, msg.from?.language_code);
  await bot.sendMessage(msg.chat.id, t(langDefault, "chooseLang"), {
    reply_markup: {
      inline_keyboard: [
        [{ text: "1) English", callback_data: `lang:en` }],
        [{ text: "2) Русский", callback_data: `lang:ru` }]
      ]
    }
  });
});

// handle lang selection
bot.on("callback_query", async (cq) => {
  try {
    const data = cq.data || "";
    const chatId = cq.message?.chat?.id;
    const userId = cq.from?.id;
    if (!chatId || !userId) return;

    if (data === "lang:ru" || data === "lang:en") {
      const lang = data.split(":")[1];
      await setUserLang(userId, lang);

      await bot.answerCallbackQuery(cq.id, { text: "OK" });

      // replace the message, keep it clean
      await bot.editMessageText(t(lang, "ready"), {
        chat_id: chatId,
        message_id: cq.message.message_id
      });
      return;
    }

    await bot.answerCallbackQuery(cq.id);
  } catch (e) {
    try { await bot.answerCallbackQuery(cq.id); } catch {}
  }
});

// /new — force new ticket
bot.onText(/^\/new$/, async (msg) => {
  if (msg.chat.type !== "private") return;

  const lang = await getUserLang(msg);
  const userId = msg.from.id;

  const old = await getTicket(userId);
  if (old?.topicId) {
    await store.del(kTicket(userId));
    await store.del(kTopic(old.topicId));
  }

  try {
    const topicId = await ensureTicket(msg.from, lang);
    await bot.sendMessage(msg.chat.id, t(lang, "newTicket") + String(topicId));
  } catch (e) {
    await bot.sendMessage(msg.chat.id, t(lang, "errForumOff"));
  }
});

// /status — ticket info for user
bot.onText(/^\/status$/, async (msg) => {
  if (msg.chat.type !== "private") return;

  const lang = await getUserLang(msg);
  const userId = msg.from.id;

  const ticket = await getTicket(userId);
  if (!ticket?.topicId || ticket.status !== "open") {
    await bot.sendMessage(msg.chat.id, t(lang, "statusNone"));
    return;
  }

  const created = new Date(ticket.createdAt).toLocaleString();
  const updated = ticket.lastUserMsgAt
    ? new Date(ticket.lastUserMsgAt).toLocaleString()
    : "—";

  const text =
    `${t(lang, "statusOpen")}\n` +
    `${t(lang, "statusId")}: #${ticket.topicId}\n` +
    `${t(lang, "statusCreated")}: ${created}\n` +
    `${t(lang, "statusUpdated")}: ${updated}\n` +
    `${t(lang, "statusHint")}`;

  await bot.sendMessage(msg.chat.id, text);
});

// ---------- single message router ----------
bot.on("message", async (msg) => {
  if (!msg || !msg.chat) return;

  // ===== USER PRIVATE =====
  if (msg.chat.type === "private") {
    if (!msg.from) return;

    // ignore commands here (handled by onText)
    if (msg.text && msg.text.startsWith("/")) return;

    const userId = msg.from.id;
    const langSaved = await store.get(kLang(userId));
    const lang = (langSaved === "ru" || langSaved === "en") ? langSaved : null;

    if (!lang) {
      // если язык не выбран — просим выбрать
      await bot.sendMessage(msg.chat.id, t(detectDefaultLang(msg.from, msg.from?.language_code), "needLang"), {
        reply_markup: {
          inline_keyboard: [
            [{ text: "1) English", callback_data: `lang:en` }],
            [{ text: "2) Русский", callback_data: `lang:ru` }]
          ]
        }
      });
      return;
    }

    const rl = await rateLimit(userId);
    if (rl.limited) {
      if (rl.warn) await bot.sendMessage(msg.chat.id, t(lang, "tooFast"));
      // иначе молча режем, чтобы не спамить
      return;
    }

    // ensure ticket + forward
    let topicId;
    try {
      topicId = await ensureTicket(msg.from, lang);
    } catch (e) {
      await bot.sendMessage(msg.chat.id, t(lang, "errForumOff"));
      return;
    }

    try {
      await copyUserMessageToTopic(msg, topicId);
    } catch (e) {
      await bot.sendMessage(msg.chat.id, t(lang, "errBusy"));
      return;
    }

    if (await maybeAck(userId)) {
      await bot.sendMessage(msg.chat.id, t(lang, "accepted"));
    }
    return;
  }

  // ===== SUPPORT GROUP (ADMIN SIDE) =====
  if (msg.chat.id === SUPPORT_GROUP_ID) {
    // /id works for admins too
    if (msg.text === "/id") {
      await bot.sendMessage(msg.chat.id, `chat.id = ${msg.chat.id}`);
      return;
    }

    if (!msg.from || !isAdmin(msg.from.id)) return;

    // ignore commands for reply-router (let onText handle)
    if (msg.text && msg.text.startsWith("/")) return;

    // must be reply to mapped message
    const replyTo = msg.reply_to_message;
    if (!replyTo) return;

    const userId = await store.get(kMap(SUPPORT_GROUP_ID, replyTo.message_id));
    if (!userId) return;

    // deliver
    if (msg.text) {
      await bot.sendMessage(Number(userId), `💬 Support:\n\n${msg.text}`);
    } else {
      try {
        await bot.copyMessage(Number(userId), SUPPORT_GROUP_ID, msg.message_id);
      } catch (e) {
        await bot.sendMessage(msg.chat.id, t("en", "adminDeliverFail"), {
          message_thread_id: msg.message_thread_id
        });
      }
    }

    // update ticket support timestamp
    const ticket = await getTicket(Number(userId));
    if (ticket) {
      ticket.lastSupportMsgAt = Date.now();
      await setTicket(Number(userId), ticket);
    }
  }
});

// /reply <userId> <text>
bot.onText(/^\/reply\s+(\d+)\s+([\s\S]+)/, async (msg, match) => {
  if (msg.chat.id !== SUPPORT_GROUP_ID) return;
  if (!msg.from || !isAdmin(msg.from.id)) return;

  const userId = Number(match[1]);
  const text = String(match[2] || "").trim();
  if (!text) return;

  await bot.sendMessage(userId, `💬 Support:\n\n${text}`);
  await bot.sendMessage(msg.chat.id, "✅ Sent.", { message_thread_id: msg.message_thread_id });

  // update ticket timestamp
  const ticket = await getTicket(userId);
  if (ticket) {
    ticket.lastSupportMsgAt = Date.now();
    await setTicket(userId, ticket);
  }
});

// /close (inside topic)
bot.onText(/^\/close$/, async (msg) => {
  if (msg.chat.id !== SUPPORT_GROUP_ID) return;
  if (!msg.from || !isAdmin(msg.from.id)) return;

  const topicId = msg.message_thread_id;
  if (!topicId) {
    await bot.sendMessage(msg.chat.id, t("en", "adminCloseUse"));
    return;
  }

  const userId = await store.get(kTopic(topicId));
  if (userId) {
    const ticket = await getTicket(Number(userId));
    if (ticket) {
      ticket.status = "closed";
      await setTicket(Number(userId), ticket);
    }
    await store.del(kTopic(topicId));
  }

  try {
    await bot.closeForumTopic(SUPPORT_GROUP_ID, topicId);
  } catch {}

  await bot.sendMessage(msg.chat.id, "🧾 Ticket closed.", { message_thread_id: topicId });
});

module.exports = { bot };
