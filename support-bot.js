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

// CSV: "123,456"
const ADMIN_USER_IDS = (process.env.ADMIN_USER_IDS || "")
  .split(",")
  .map((x) => x.trim())
  .filter(Boolean)
  .map((x) => Number(x))
  .filter((x) => Number.isFinite(x));

function isAdmin(userId) {
  // если не задано — считаем админом всех (не рекомендую в проде)
  if (!ADMIN_USER_IDS.length) return true;
  return ADMIN_USER_IDS.includes(Number(userId));
}

const bot = new TelegramBot(BOT_TOKEN, { polling: false });

// ---------- helpers ----------
function safeUsername(u) {
  if (!u) return "";
  if (u.username) return `@${u.username}`;
  const name = [u.first_name, u.last_name].filter(Boolean).join(" ").trim();
  return name ? name : "";
}

function userKey(userId) {
  return `user:${userId}`;
}
function ticketKey(userId) {
  return `ticket:${userId}`; // current ticket
}
function ticketLogKey(userId) {
  return `ticketlog:${userId}`; // history array
}
function topicKey(topicId) {
  return `topic:${topicId}`; // topicId -> userId
}
function mapKey(chatId, messageId) {
  return `map:${chatId}:${messageId}`; // group message id -> userId
}

function now() {
  return Date.now();
}

function fmtTime(ts) {
  try {
    return new Date(ts).toLocaleString();
  } catch {
    return String(ts);
  }
}

function langFromTelegram(msg) {
  const code = msg?.from?.language_code || "";
  return /^ru|uk|be/i.test(code) ? "ru" : "en";
}

const TEXT = {
  chooseLang: {
    ru: "🌍 Выбери язык общения:",
    en: "🌍 Choose language:"
  },
  welcome: {
    ru:
      "👋 *Trade Support*\n\n" +
      "Отправь сюда вопрос — я создам заявку и передам в поддержку.\n" +
      "Ответ придёт сюда же.\n\n" +
      "Команды:\n" +
      "• /status — статус заявки\n" +
      "• /new — новая заявка\n" +
      "• /lang — сменить язык",
    en:
      "👋 *Trade Support*\n\n" +
      "Send your question here — I will create a ticket and forward it to support.\n" +
      "The reply will arrive here.\n\n" +
      "Commands:\n" +
      "• /status — ticket status\n" +
      "• /new — new ticket\n" +
      "• /lang — change language"
  },
  ack: {
    ru: "✅ Принято. Поддержка ответит здесь.",
    en: "✅ Received. Support will reply here."
  },
  tooFast: {
    ru: "⏳ Слишком часто. Подожди пару секунд и отправь снова.",
    en: "⏳ Too fast. Wait a couple seconds and send again."
  },
  topicBusy: {
    ru: (sec) => `⚠️ Сейчас перегрузка при создании темы. Подожди ${sec} сек и отправь ещё раз.`,
    en: (sec) => `⚠️ Topic creation is rate-limited. Wait ${sec}s and try again.`
  },
  noTicket: {
    ru: "📭 Активной заявки нет. Отправь сообщение — я создам новую.",
    en: "📭 No active ticket. Send a message — I will create one."
  }
};

async function getUserSettings(userId) {
  const u = (await store.get(userKey(userId))) || {};
  return {
    lang: u.lang || null
  };
}

async function setUserLang(userId, lang) {
  const u = (await store.get(userKey(userId))) || {};
  u.lang = lang;
  u.updatedAt = now();
  await store.set(userKey(userId), u);
}

function langKeyboard() {
  return {
    inline_keyboard: [
      [
        { text: "English", callback_data: "lang:en" },
        { text: "Русский", callback_data: "lang:ru" }
      ]
    ]
  };
}

async function sendChooseLanguage(chatId, preferredLang) {
  // preferredLang нужен только чтобы текст сверху был понятнее
  const msg = preferredLang === "ru" ? TEXT.chooseLang.ru : TEXT.chooseLang.en;
  await bot.sendMessage(chatId, msg, {
    reply_markup: langKeyboard()
  });
}

// ---------- rate limits ----------
async function rateLimitUser(userId) {
  // 1 msg / 2 sec (настрой под себя)
  const key = `rl:user:${userId}`;
  const prev = await store.get(key);
  const t = now();
  if (prev && t - Number(prev) < 2000) return true;
  await store.set(key, String(t));
  return false;
}

async function getTopicBlockUntil() {
  const v = await store.get("rl:topic:blockUntil");
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

async function setTopicBlock(seconds) {
  const until = now() + seconds * 1000;
  await store.set("rl:topic:blockUntil", String(until));
  return until;
}

// ---------- tickets ----------
async function appendTicketLog(userId, entry) {
  const log = (await store.get(ticketLogKey(userId))) || [];
  log.unshift(entry);
  // держим последние 10
  while (log.length > 10) log.pop();
  await store.set(ticketLogKey(userId), log);
}

async function markTicketClosed(userId, ticket, reason = "closed") {
  const updated = { ...(ticket || {}), status: "closed", closedAt: now(), closeReason: reason };
  await store.set(ticketKey(userId), updated);
  await appendTicketLog(userId, {
    topicId: updated.topicId,
    status: "closed",
    createdAt: updated.createdAt,
    closedAt: updated.closedAt,
    messageCount: updated.messageCount || 0
  });
  return updated;
}

function parseRetryAfterSeconds(err) {
  const p = err?.response?.body?.parameters?.retry_after;
  if (typeof p === "number" && Number.isFinite(p)) return p;
  const m = String(err?.message || "").match(/retry after (\d+)/i);
  if (m) return Number(m[1]);
  return null;
}

async function ensureTicketForUser(user) {
  const userId = user.id;

  const existing = await store.get(ticketKey(userId));
  if (existing?.topicId && existing?.status !== "closed") return existing.topicId;

  // если система знает, что сейчас topic-create в блоке (429)
  const blockUntil = await getTopicBlockUntil();
  if (blockUntil && now() < blockUntil) {
    const sec = Math.max(1, Math.ceil((blockUntil - now()) / 1000));
    const e = new Error("TOPIC_BLOCKED");
    e._topicBlockedSeconds = sec;
    throw e;
  }

  // Создаём форум-топик (один на пользователя)
  const titleRaw = `u${userId} ${safeUsername(user)}`.trim();
  const title = titleRaw.length > 120 ? titleRaw.slice(0, 120) : titleRaw;

  try {
    const created = await bot.createForumTopic(SUPPORT_GROUP_ID, title);
    const topicId = created.message_thread_id;

    const ticket = {
      topicId,
      createdAt: now(),
      updatedAt: now(),
      status: "open",
      messageCount: 0,
      user: {
        id: userId,
        username: user.username || null,
        first_name: user.first_name || null,
        last_name: user.last_name || null
      }
    };

    await store.set(ticketKey(userId), ticket);
    await store.set(topicKey(topicId), userId);

    const header = await bot.sendMessage(
      SUPPORT_GROUP_ID,
      `🆕 New ticket\nUser: ${safeUsername(user)}\nID: ${userId}`,
      { message_thread_id: topicId }
    );

    // reply-map на header (чтобы reply на него тоже работал)
    await store.set(mapKey(SUPPORT_GROUP_ID, header.message_id), userId);

    return topicId;
  } catch (err) {
    const retry = parseRetryAfterSeconds(err);
    if (retry) {
      await setTopicBlock(retry);
    }
    console.error("[ensureTicketForUser] createForumTopic failed:", err?.response?.body || err);
    throw err;
  }
}

async function copyUserMessageToTopic(msg, topicId) {
  const copied = await bot.copyMessage(SUPPORT_GROUP_ID, msg.chat.id, msg.message_id, {
    message_thread_id: topicId
  });
  const newMessageId = copied.message_id;

  await store.set(mapKey(SUPPORT_GROUP_ID, newMessageId), msg.from.id);

  // update ticket stats
  const ticket = (await store.get(ticketKey(msg.from.id))) || {};
  ticket.messageCount = (ticket.messageCount || 0) + 1;
  ticket.updatedAt = now();
  ticket.lastUserMsgAt = now();
  await store.set(ticketKey(msg.from.id), ticket);
}

// ---------- language callbacks ----------
bot.on("callback_query", async (q) => {
  try {
    const data = q.data || "";
    const msg = q.message;
    const userId = q.from?.id;

    if (!userId) return;

    if (data.startsWith("lang:")) {
      const lang = data.split(":")[1] === "ru" ? "ru" : "en";
      await setUserLang(userId, lang);

      try {
        await bot.answerCallbackQuery(q.id, { text: lang === "ru" ? "Готово" : "Done" });
      } catch {}

      // можно отредактировать исходное сообщение, чтобы было красиво
      if (msg?.chat?.id) {
        try {
          await bot.editMessageText(TEXT.welcome[lang], {
            chat_id: msg.chat.id,
            message_id: msg.message_id,
            parse_mode: "Markdown"
          });
        } catch {
          // если edit не удался — просто отправим новое
          await bot.sendMessage(msg.chat.id, TEXT.welcome[lang], { parse_mode: "Markdown" });
        }
      }
    }
  } catch (e) {
    console.error("[callback_query] error:", e);
  }
});

// ---------- user commands ----------
bot.onText(/^\/start(?:\s+(.+))?$/, async (msg) => {
  if (msg.chat.type !== "private") return;

  const settings = await getUserSettings(msg.from.id);
  const preferred = settings.lang || langFromTelegram(msg);

  // всегда показываем выбор языка на /start (как ты просил)
  await sendChooseLanguage(msg.chat.id, preferred);
});

bot.onText(/^\/lang$/, async (msg) => {
  if (msg.chat.type !== "private") return;
  const settings = await getUserSettings(msg.from.id);
  const preferred = settings.lang || langFromTelegram(msg);
  await sendChooseLanguage(msg.chat.id, preferred);
});

bot.onText(/^\/new$/, async (msg) => {
  if (msg.chat.type !== "private") return;

  const settings = await getUserSettings(msg.from.id);
  const lang = settings.lang || langFromTelegram(msg);

  // закрываем старую (если была)
  const old = await store.get(ticketKey(msg.from.id));
  if (old?.topicId && old?.status !== "closed") {
    await markTicketClosed(msg.from.id, old, "new_ticket");
    await store.del(topicKey(old.topicId));
  }

  try {
    const topicId = await ensureTicketForUser(msg.from);
    await bot.sendMessage(
      msg.chat.id,
      lang === "ru"
        ? `✅ Создана новая заявка (#${topicId}). Отправь сообщение.`
        : `✅ New ticket created (#${topicId}). Send your message.`
    );
  } catch (err) {
    const sec = err?._topicBlockedSeconds;
    if (sec) {
      await bot.sendMessage(msg.chat.id, TEXT.topicBusy[lang](sec));
      return;
    }
    await bot.sendMessage(
      msg.chat.id,
      lang === "ru"
        ? "⚠️ Не удалось создать тему. Проверь права бота (Manage Topics) и включены ли Topics в группе."
        : "⚠️ Failed to create topic. Check bot permissions (Manage Topics) and make sure Topics are enabled."
    );
  }
});

bot.onText(/^\/status$/, async (msg) => {
  if (msg.chat.type !== "private") return;

  const settings = await getUserSettings(msg.from.id);
  const lang = settings.lang || langFromTelegram(msg);

  const current = await store.get(ticketKey(msg.from.id));
  const log = (await store.get(ticketLogKey(msg.from.id))) || [];

  if (!current?.topicId || current?.status === "closed") {
    // если есть история — покажем последние
    if (!log.length) {
      await bot.sendMessage(msg.chat.id, TEXT.noTicket[lang]);
      return;
    }

    const lines = log
      .slice(0, 5)
      .map((t, i) => {
        const st = t.status === "closed" ? (lang === "ru" ? "закрыта" : "closed") : "open";
        return `#${i + 1} • topic ${t.topicId} • ${st} • ${fmtTime(t.createdAt)}`;
      })
      .join("\n");

    await bot.sendMessage(
      msg.chat.id,
      lang === "ru"
        ? `📄 Последние заявки:\n${lines}\n\nНужно создать новую? Отправь сообщение или /new`
        : `📄 Recent tickets:\n${lines}\n\nNeed a new one? Send a message or /new`
    );
    return;
  }

  const statusText =
    current.status === "open" ? (lang === "ru" ? "открыта" : "open") : (lang === "ru" ? "закрыта" : "closed");

  const summary =
    lang === "ru"
      ? `📌 Текущая заявка\n• Topic: ${current.topicId}\n• Статус: ${statusText}\n• Создана: ${fmtTime(current.createdAt)}\n• Обновлена: ${fmtTime(current.updatedAt)}\n• Сообщений: ${current.messageCount || 0}\n\nИстория (последние): ${log.length}`
      : `📌 Current ticket\n• Topic: ${current.topicId}\n• Status: ${statusText}\n• Created: ${fmtTime(current.createdAt)}\n• Updated: ${fmtTime(current.updatedAt)}\n• Messages: ${current.messageCount || 0}\n\nHistory (count): ${log.length}`;

  await bot.sendMessage(msg.chat.id, summary);
});

// ---------- main message handler ----------
bot.on("message", async (msg) => {
  try {
    // USER SIDE
    if (msg.chat.type === "private") {
      if (!msg.from) return;

      // пропускаем команды
      if (msg.text && msg.text.startsWith("/")) return;

      const settings = await getUserSettings(msg.from.id);
      const lang = settings.lang || langFromTelegram(msg);

      if (await rateLimitUser(msg.from.id)) {
        await bot.sendMessage(msg.chat.id, TEXT.tooFast[lang]);
        return;
      }

      let topicId;
      try {
        topicId = await ensureTicketForUser(msg.from);
      } catch (err) {
        const sec = err?._topicBlockedSeconds;
        if (sec) {
          await bot.sendMessage(msg.chat.id, TEXT.topicBusy[lang](sec));
          return;
        }
        console.error("[private message] ensureTicket error:", err?.response?.body || err);
        await bot.sendMessage(
          msg.chat.id,
          lang === "ru"
            ? "⚠️ Сейчас не могу создать заявку. Попробуй чуть позже. (Проверь: Topics ON и права Manage Topics.)"
            : "⚠️ I can't create a ticket right now. Try later. (Check: Topics ON and Manage Topics permission.)"
        );
        return;
      }

      await copyUserMessageToTopic(msg, topicId);

      // авто-ответ (всегда полезен)
      await bot.sendMessage(msg.chat.id, TEXT.ack[lang]);
      return;
    }

    // ADMIN/SUPPORT GROUP SIDE
    if (msg.chat.id === SUPPORT_GROUP_ID) {
      if (!msg.from || !isAdmin(msg.from.id)) return;

      // /id — узнать chat.id
      if (msg.text && /^\/id$/.test(msg.text.trim())) {
        await bot.sendMessage(msg.chat.id, `chat.id = ${msg.chat.id}`, {
          message_thread_id: msg.message_thread_id
        });
        return;
      }

      // команды не форвардим
      if (msg.text && msg.text.startsWith("/")) {
        // /close — закрыть тикет (внутри темы)
        if (/^\/close$/.test(msg.text.trim())) {
          const topicId = msg.message_thread_id;
          if (!topicId) {
            await bot.sendMessage(msg.chat.id, "⚠️ Use /close inside a topic.");
            return;
          }

          const userId = await store.get(topicKey(topicId));
          if (userId) {
            const ticket = await store.get(ticketKey(userId));
            await markTicketClosed(userId, ticket, "manual_close");
            await store.del(topicKey(topicId));

            // попробуем закрыть форум-топик
            try {
              await bot.closeForumTopic(SUPPORT_GROUP_ID, topicId);
            } catch (e) {
              console.error("[closeForumTopic] error:", e?.response?.body || e);
            }

            // уведомим пользователя
            await bot.sendMessage(
              userId,
              "🧾 Ticket closed. If you need more help, send /new or just send a message."
            );
          }

          await bot.sendMessage(msg.chat.id, "🧾 Ticket closed.", { message_thread_id: topicId });
        }

        // /reply <userId> <text> — запасной канал
        const m = msg.text.match(/^\/reply\s+(\d+)\s+([\s\S]+)/);
        if (m) {
          const userId = Number(m[1]);
          const text = String(m[2] || "").trim();
          if (userId && text) {
            await bot.sendMessage(userId, `💬 Support:\n\n${text}`);
            await bot.sendMessage(msg.chat.id, "✅ Sent.", {
              message_thread_id: msg.message_thread_id
            });
          }
        }
        return;
      }

      // Главная магия: админ отвечает реплаем на сообщение бота в теме
      const replyTo = msg.reply_to_message;
      if (!replyTo) return;

      const userId = await store.get(mapKey(SUPPORT_GROUP_ID, replyTo.message_id));
      if (!userId) return;

      // отправляем пользователю
      if (msg.text) {
        await bot.sendMessage(userId, `💬 Support:\n\n${msg.text}`);
      } else {
        try {
          await bot.copyMessage(userId, SUPPORT_GROUP_ID, msg.message_id);
        } catch (e) {
          await bot.sendMessage(
            msg.chat.id,
            "⚠️ Failed to deliver non-text reply.",
            { message_thread_id: msg.message_thread_id }
          );
        }
      }

      // обновим ticket stats
      const ticket = (await store.get(ticketKey(userId))) || {};
      ticket.updatedAt = now();
      ticket.lastAdminMsgAt = now();
      await store.set(ticketKey(userId), ticket);

      return;
    }
  } catch (e) {
    console.error("[message handler] error:", e?.response?.body || e);
  }
});

module.exports = { bot };
