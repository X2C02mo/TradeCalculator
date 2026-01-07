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

const ADMIN_USER_IDS = (process.env.ADMIN_USER_IDS || "")
  .split(",")
  .map((x) => x.trim())
  .filter(Boolean)
  .map((x) => Number(x))
  .filter((x) => Number.isFinite(x));

function isAdmin(userId) {
  if (!ADMIN_USER_IDS.length) return true; // если не задано — любой админ группы ок
  return ADMIN_USER_IDS.includes(Number(userId));
}

const bot = new TelegramBot(BOT_TOKEN, { polling: false });

/** ---------- keys ---------- */
const K = {
  lang: (uid) => `u:${uid}:lang`,
  state: (uid) => `u:${uid}:state`,
  rl: (uid) => `u:${uid}:rl`,
  rlWarn: (uid) => `u:${uid}:rlwarn`,
  openTicketByUser: (uid) => `ticket:u:${uid}:open`, // ticketNo
  ticketByNo: (no) => `ticket:no:${no}`,
  userTicketsList: (uid) => `ticket:u:${uid}:list`, // [{no,status,createdAt,closedAt,topicId}]
  topicToNo: (topicId) => `ticket:topic:${topicId}:no`,
  mapMsgToUser: (chatId, msgId) => `map:${chatId}:${msgId}:uid`,
  seqTicket: () => `seq:ticket`,
};

/** ---------- i18n ---------- */
const I18N = {
  ru: {
    chooseLang: "Выбери язык общения:",
    menuTitle: "Trade Support",
    menuText:
      "Выбери действие кнопками ниже.\n\nЕсли хочешь написать в поддержку — жми «Отправить вопрос».",
    btnAsk: "📩 Отправить вопрос",
    btnStatus: "🧾 Мои заявки",
    btnNew: "➕ Новый тикет",
    btnLang: "🌐 Язык",
    btnBack: "⬅️ Назад",
    btnClose: "✅ Закрыть тикет",
    askHint:
      "Отправь сообщение (текст/фото/видео/файл/голос) — я передам в поддержку.\n\nСовет: в одном сообщении опиши проблему и приложи скрины.",
    sent: (no) => `✅ Отправлено в поддержку. Тикет #${no}.`,
    created: (no) => `✅ Создан новый тикет #${no}. Теперь отправь сообщение.`,
    cannotSend:
      "⚠️ Не получилось передать в поддержку. Попробуй ещё раз через 10–20 секунд.",
    tooFast: "⏳ Слишком часто. Подожди пару секунд и отправь снова.",
    noTickets: "Пока нет заявок.",
    statusHeader: "Твои заявки:",
    openOne: (no) => `🟢 Открыт: #${no}`,
    closedOne: (no) => `⚪ Закрыт: #${no}`,
    closeConfirm: "Закрыть текущий тикет?",
    closedOk: (no) => `🧾 Тикет #${no}: ЗАКРЫТ`,
    newConfirm:
      "Создать новый тикет? Текущий (если есть) будет закрыт.",
    yes: "Да",
    no: "Нет",
    adminNew: (no, u) => `🆕 New ticket #${no}\nUser: ${u.name}\nID: ${u.id}`,
    adminCloseBtn: "✅ Close ticket",
    adminClosedInTopic: (no) => `🧾 Ticket #${no} closed.`,
    userClosedByAdmin: (no) => `🧾 Тикет #${no} закрыт поддержкой.`,
    badContent:
      "Я получил сообщение, но не вижу текста/файла. Отправь текст или приложи файл/скрин.",
  },
  en: {
    chooseLang: "Choose language:",
    menuTitle: "Trade Support",
    menuText:
      "Use buttons below.\n\nTo contact support, tap “Send question”.",
    btnAsk: "📩 Send question",
    btnStatus: "🧾 My tickets",
    btnNew: "➕ New ticket",
    btnLang: "🌐 Language",
    btnBack: "⬅️ Back",
    btnClose: "✅ Close ticket",
    askHint:
      "Send a message (text/photo/video/file/voice) — I will forward it to support.\n\nTip: describe the issue + attach screenshots.",
    sent: (no) => `✅ Sent to support. Ticket #${no}.`,
    created: (no) => `✅ New ticket #${no} created. Now send your message.`,
    cannotSend:
      "⚠️ Failed to forward to support. Try again in 10–20 seconds.",
    tooFast: "⏳ Too fast. Wait a couple seconds and send again.",
    noTickets: "No tickets yet.",
    statusHeader: "Your tickets:",
    openOne: (no) => `🟢 Open: #${no}`,
    closedOne: (no) => `⚪ Closed: #${no}`,
    closeConfirm: "Close current ticket?",
    closedOk: (no) => `🧾 Ticket #${no}: CLOSED`,
    newConfirm:
      "Create a new ticket? Current one (if exists) will be closed.",
    yes: "Yes",
    no: "No",
    adminNew: (no, u) => `🆕 New ticket #${no}\nUser: ${u.name}\nID: ${u.id}`,
    adminCloseBtn: "✅ Close ticket",
    adminClosedInTopic: (no) => `🧾 Ticket #${no} closed.`,
    userClosedByAdmin: (no) => `🧾 Ticket #${no} was closed by support.`,
    badContent:
      "I got your message but it contains no text/file. Please send text or attach a file/screenshot.",
  },
};

async function getLang(uid) {
  const saved = await store.get(K.lang(uid));
  return saved === "ru" || saved === "en" ? saved : null;
}
async function setLang(uid, lang) {
  await store.set(K.lang(uid), lang);
}
async function T(uid) {
  const lang = (await getLang(uid)) || "en";
  return I18N[lang];
}

function userLabel(u) {
  const uname = u?.username ? `@${u.username}` : "";
  const name = [u?.first_name, u?.last_name].filter(Boolean).join(" ").trim();
  return { id: u.id, name: (uname || name || `u${u.id}`) };
}

/** ---------- rate limit (soft) ---------- */
async function rateLimit(uid) {
  // 1 msg / 1.2 sec
  const key = K.rl(uid);
  const now = Date.now();
  const prev = await store.get(key);
  const prevN = Number(prev);
  if (Number.isFinite(prevN) && now - prevN < 1200) return true;
  await store.set(key, String(now));
  return false;
}

async function warnTooFastOnce(uid, chatId) {
  const key = K.rlWarn(uid);
  const now = Date.now();
  const prev = Number(await store.get(key));
  if (Number.isFinite(prev) && now - prev < 4000) return; // не спамим предупреждением
  await store.set(key, String(now));
  const tr = await T(uid);
  await bot.sendMessage(chatId, tr.tooFast);
}

/** ---------- retries for Telegram 429 ---------- */
async function withRetry(fn, { tries = 3 } = {}) {
  let lastErr = null;
  for (let i = 0; i < tries; i++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      const retryAfter =
        e?.response?.body?.parameters?.retry_after ||
        e?.response?.body?.parameters?.retry_after_seconds ||
        null;

      // 429 flood control
      if (e?.response?.statusCode === 429 && retryAfter) {
        const ms = Math.min(1500, Number(retryAfter) * 1000);
        await new Promise((r) => setTimeout(r, ms));
        continue;
      }
      // network-ish retry once
      if (i < tries - 1) continue;
      throw e;
    }
  }
  throw lastErr;
}

/** ---------- tickets ---------- */
async function getOpenTicketNo(uid) {
  const no = await store.get(K.openTicketByUser(uid));
  const n = Number(no);
  return Number.isFinite(n) ? n : null;
}

async function getTicketByNo(no) {
  return await store.get(K.ticketByNo(no));
}

async function saveTicket(ticket) {
  await store.set(K.ticketByNo(ticket.no), ticket);
}

async function addToUserList(uid, ticket) {
  const key = K.userTicketsList(uid);
  const list = (await store.get(key)) || [];
  const next = Array.isArray(list) ? list.filter((x) => x?.no !== ticket.no) : [];
  next.unshift({
    no: ticket.no,
    status: ticket.status,
    createdAt: ticket.createdAt,
    closedAt: ticket.closedAt || null,
    topicId: ticket.topicId || null,
  });
  await store.set(key, next.slice(0, 20));
}

async function closeTicket(uid, reason = "user") {
  const openNo = await getOpenTicketNo(uid);
  if (!openNo) return null;

  const ticket = await getTicketByNo(openNo);
  if (!ticket) {
    await store.del(K.openTicketByUser(uid));
    return null;
  }

  ticket.status = "closed";
  ticket.closedAt = Date.now();
  await saveTicket(ticket);
  await addToUserList(uid, ticket);

  await store.del(K.openTicketByUser(uid));
  if (ticket.topicId) {
    await store.del(K.topicToNo(ticket.topicId));
    // пытаемся закрыть topic (если есть право)
    try {
      await withRetry(() => bot.closeForumTopic(SUPPORT_GROUP_ID, ticket.topicId));
    } catch (_) {}
  }

  const tr = await T(uid);
  if (reason === "admin") {
    await withRetry(() => bot.sendMessage(uid, tr.userClosedByAdmin(ticket.no)));
  } else {
    await withRetry(() => bot.sendMessage(uid, tr.closedOk(ticket.no)));
  }

  return ticket.no;
}

async function ensureTicket(u) {
  const uid = u.id;

  const openNo = await getOpenTicketNo(uid);
  if (openNo) {
    const existing = await getTicketByNo(openNo);
    if (existing && existing.status === "open") return existing;
  }

  const no = await store.incr(K.seqTicket());
  const uinfo = userLabel(u);

  // создаём topic
  const title = `#${no} ${uinfo.name}`.slice(0, 120);

  let topicId = null;
  try {
    const created = await withRetry(() => bot.createForumTopic(SUPPORT_GROUP_ID, title));
    topicId = created.message_thread_id;
  } catch (e) {
    // если topics не включены/нет прав — topicId останется null
    topicId = null;
  }

  const ticket = {
    no,
    userId: uid,
    topicId,
    status: "open",
    createdAt: Date.now(),
    lastUserMessageAt: null,
    lastAdminMessageAt: null,
  };

  await saveTicket(ticket);
  await store.set(K.openTicketByUser(uid), String(no));
  if (topicId) await store.set(K.topicToNo(topicId), no);
  await addToUserList(uid, ticket);

  // сообщение в группе (в topic, если есть)
  try {
    const tr = await T(uid);
    const headerText = tr.adminNew(no, uinfo);
    const opts = topicId ? { message_thread_id: topicId } : undefined;

    const header = await withRetry(() =>
      bot.sendMessage(SUPPORT_GROUP_ID, headerText, {
        ...(opts || {}),
        reply_markup: topicId
          ? {
              inline_keyboard: [
                [{ text: tr.adminCloseBtn, callback_data: `AC:${no}` }],
              ],
            }
          : undefined,
      })
    );

    await store.set(K.mapMsgToUser(SUPPORT_GROUP_ID, header.message_id), uid);
  } catch (_) {}

  return ticket;
}

async function forwardUserMessageToSupport(msg, ticket) {
  const uid = msg.from.id;
  const uinfo = userLabel(msg.from);

  const threadOpt = ticket.topicId ? { message_thread_id: ticket.topicId } : undefined;

  // если нет content вообще
  const hasContent =
    !!msg.text ||
    !!msg.caption ||
    !!msg.photo ||
    !!msg.document ||
    !!msg.video ||
    !!msg.voice ||
    !!msg.audio ||
    !!msg.sticker ||
    !!msg.video_note;

  if (!hasContent) {
    const tr = await T(uid);
    await withRetry(() => bot.sendMessage(uid, tr.badContent));
    return false;
  }

  try {
    // копируем оригинальное сообщение пользователя
    const copied = await withRetry(() =>
      bot.copyMessage(SUPPORT_GROUP_ID, msg.chat.id, msg.message_id, threadOpt || {})
    );

    await store.set(K.mapMsgToUser(SUPPORT_GROUP_ID, copied.message_id), uid);

    // обновляем тикет
    ticket.lastUserMessageAt = Date.now();
    await saveTicket(ticket);
    await addToUserList(uid, ticket);

    const tr = await T(uid);
    await withRetry(() => bot.sendMessage(uid, tr.sent(ticket.no)));
    return true;
  } catch (e) {
    const tr = await T(uid);
    await withRetry(() => bot.sendMessage(uid, tr.cannotSend));
    return false;
  }
}

/** ---------- UI (buttons) ---------- */
async function sendLangChooser(chatId) {
  await withRetry(() =>
    bot.sendMessage(chatId, I18N.en.chooseLang, {
      reply_markup: {
        inline_keyboard: [
          [
            { text: "English", callback_data: "L:en" },
            { text: "Русский", callback_data: "L:ru" },
          ],
        ],
      },
    })
  );
}

async function sendMenu(uid) {
  const tr = await T(uid);
  await withRetry(() =>
    bot.sendMessage(uid, `*${tr.menuTitle}*\n\n${tr.menuText}`, {
      parse_mode: "Markdown",
      reply_markup: {
        inline_keyboard: [
          [{ text: tr.btnAsk, callback_data: "M:ASK" }],
          [
            { text: tr.btnStatus, callback_data: "M:STATUS" },
            { text: tr.btnNew, callback_data: "M:NEW" },
          ],
          [
            { text: tr.btnClose, callback_data: "M:CLOSE" },
            { text: tr.btnLang, callback_data: "M:LANG" },
          ],
        ],
      },
    })
  );
}

async function sendAskHint(uid) {
  const tr = await T(uid);
  await store.set(K.state(uid), "ASK");
  await withRetry(() =>
    bot.sendMessage(uid, tr.askHint, {
      reply_markup: {
        inline_keyboard: [
          [{ text: tr.btnBack, callback_data: "M:MENU" }],
          [{ text: tr.btnStatus, callback_data: "M:STATUS" }],
        ],
      },
    })
  );
}

async function sendStatus(uid) {
  const tr = await T(uid);
  const list = (await store.get(K.userTicketsList(uid))) || [];
  if (!Array.isArray(list) || list.length === 0) {
    await withRetry(() =>
      bot.sendMessage(uid, tr.noTickets, {
        reply_markup: { inline_keyboard: [[{ text: tr.btnBack, callback_data: "M:MENU" }]] },
      })
    );
    return;
  }

  const lines = list.slice(0, 10).map((x) => {
    if (!x?.no) return null;
    return x.status === "open" ? tr.openOne(x.no) : tr.closedOne(x.no);
  }).filter(Boolean);

  await withRetry(() =>
    bot.sendMessage(uid, `${tr.statusHeader}\n\n${lines.join("\n")}`, {
      reply_markup: { inline_keyboard: [[{ text: tr.btnBack, callback_data: "M:MENU" }]] },
    })
  );
}

async function sendNewConfirm(uid) {
  const tr = await T(uid);
  await withRetry(() =>
    bot.sendMessage(uid, tr.newConfirm, {
      reply_markup: {
        inline_keyboard: [
          [
            { text: tr.yes, callback_data: "N:Y" },
            { text: tr.no, callback_data: "N:N" },
          ],
        ],
      },
    })
  );
}

async function sendCloseConfirm(uid) {
  const tr = await T(uid);
  await withRetry(() =>
    bot.sendMessage(uid, tr.closeConfirm, {
      reply_markup: {
        inline_keyboard: [
          [
            { text: tr.yes, callback_data: "C:Y" },
            { text: tr.no, callback_data: "C:N" },
          ],
        ],
      },
    })
  );
}

/** ---------- handlers ---------- */

// /start только запускает UI, не создаёт тикеты
bot.onText(/^\/start(?:\s+(.+))?$/, async (msg) => {
  if (msg.chat.type !== "private") return;
  const uid = msg.from.id;

  const lang = await getLang(uid);
  if (!lang) {
    await sendLangChooser(uid);
    return;
  }
  await sendMenu(uid);
});

// (не рекламируем команды, но оставим для диагностики)
bot.onText(/^\/status$/, async (msg) => {
  if (msg.chat.type !== "private") return;
  await sendStatus(msg.from.id);
});
bot.onText(/^\/new$/, async (msg) => {
  if (msg.chat.type !== "private") return;
  await sendNewConfirm(msg.from.id);
});

// callback кнопки
bot.on("callback_query", async (q) => {
  try {
    const uid = q.from.id;
    const data = q.data || "";
    await bot.answerCallbackQuery(q.id).catch(() => {});

    // language chooser
    if (data === "L:ru" || data === "L:en") {
      const lang = data.slice(2);
      await setLang(uid, lang);
      await store.set(K.state(uid), "MENU");
      await sendMenu(uid);
      return;
    }

    // menu
    if (data === "M:MENU") return await sendMenu(uid);
    if (data === "M:ASK") return await sendAskHint(uid);
    if (data === "M:STATUS") return await sendStatus(uid);
    if (data === "M:NEW") return await sendNewConfirm(uid);
    if (data === "M:CLOSE") return await sendCloseConfirm(uid);
    if (data === "M:LANG") return await sendLangChooser(uid);

    // new confirm
    if (data === "N:N") return await sendMenu(uid);
    if (data === "N:Y") {
      // анти-спам по созданию тикетов
      const limited = await rateLimit(uid);
      if (limited) return await warnTooFastOnce(uid, uid);

      await closeTicket(uid, "user").catch(() => {});
      const t = await ensureTicket(q.from);
      const tr = await T(uid);
      await withRetry(() => bot.sendMessage(uid, tr.created(t.no)));
      await sendAskHint(uid);
      return;
    }

    // close confirm
    if (data === "C:N") return await sendMenu(uid);
    if (data === "C:Y") {
      await closeTicket(uid, "user");
      await sendMenu(uid);
      return;
    }

    // admin close from topic
    if (data.startsWith("AC:")) {
      const no = Number(data.split(":")[1]);
      if (!Number.isFinite(no)) return;

      // только из группы и только админ
      if (q.message?.chat?.id !== SUPPORT_GROUP_ID) return;
      if (!isAdmin(q.from.id)) return;

      const ticket = await getTicketByNo(no);
      if (!ticket || ticket.status !== "open") return;

      // закрываем
      ticket.status = "closed";
      ticket.closedAt = Date.now();
      await saveTicket(ticket);
      await addToUserList(ticket.userId, ticket);

      await store.del(K.openTicketByUser(ticket.userId));
      if (ticket.topicId) {
        await store.del(K.topicToNo(ticket.topicId));
        try { await withRetry(() => bot.closeForumTopic(SUPPORT_GROUP_ID, ticket.topicId)); } catch (_) {}
      }

      // уведомления
      const trUser = await T(ticket.userId);
      await withRetry(() => bot.sendMessage(ticket.userId, trUser.userClosedByAdmin(no)));
      const trAny = I18N.en; // в группе можно английский
      await withRetry(() =>
        bot.sendMessage(SUPPORT_GROUP_ID, trAny.adminClosedInTopic(no), {
          message_thread_id: ticket.topicId || undefined,
        })
      );
      return;
    }
  } catch (_) {}
});

// private messages -> forward (без команд)
bot.on("message", async (msg) => {
  try {
    if (msg.chat.type !== "private") return;
    if (!msg.from) return;

    // команды игнорим (кроме /start, /status, /new — они отдельно)
    if (msg.text && msg.text.startsWith("/")) return;

    const uid = msg.from.id;

    // если язык не выбран — попросим выбрать
    const lang = await getLang(uid);
    if (!lang) {
      await sendLangChooser(uid);
      return;
    }

    // мягкий rate limit на контент (не на кнопки)
    if (await rateLimit(uid)) {
      await warnTooFastOnce(uid, uid);
      return;
    }

    const ticket = await ensureTicket(msg.from);
    await forwardUserMessageToSupport(msg, ticket);
  } catch (_) {}
});

// admin replies in group -> to user
bot.on("message", async (msg) => {
  try {
    if (msg.chat.id !== SUPPORT_GROUP_ID) return;
    if (!msg.from || !isAdmin(msg.from.id)) return;

    // команды в группе пропускаем
    if (msg.text && msg.text.startsWith("/")) return;

    const replyTo = msg.reply_to_message;
    if (!replyTo) return;

    const uid = await store.get(K.mapMsgToUser(SUPPORT_GROUP_ID, replyTo.message_id));
    const userId = Number(uid);
    if (!Number.isFinite(userId)) return;

    // отправляем ответ пользователю
    if (msg.text) {
      await withRetry(() => bot.sendMessage(userId, `💬 Support:\n\n${msg.text}`));
    } else {
      // фото/файл/стикер и т.п.
      await withRetry(() => bot.copyMessage(userId, SUPPORT_GROUP_ID, msg.message_id));
    }
  } catch (_) {}
});

// debug: /id в группе (не для пользователя)
bot.onText(/^\/id$/, async (msg) => {
  if (msg.chat.id !== SUPPORT_GROUP_ID) return;
  await bot.sendMessage(msg.chat.id, `chat.id = ${msg.chat.id}`);
});

module.exports = { bot };
