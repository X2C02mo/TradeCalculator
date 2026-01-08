// support-bot.js
import { Telegraf, Markup } from "telegraf";
import { getJSON, setJSON, setJSONEX, delKey } from "./store.js";

const BOT_TOKEN = process.env.SUPPORT_BOT_TOKEN;
const SUPPORT_GROUP_ID = Number(process.env.SUPPORT_GROUP_ID);
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || "";
const ADMIN_USERS_IDS = String(process.env.ADMIN_USERS_IDS || "")
  .split(",")
  .map(s => s.trim())
  .filter(Boolean)
  .map(Number);

function must(v, name) {
  if (!v) throw new Error(`Missing env: ${name}`);
  return v;
}
must(BOT_TOKEN, "SUPPORT_BOT_TOKEN");
must(SUPPORT_GROUP_ID, "SUPPORT_GROUP_ID");

const TICKET_TTL = 60 * 60 * 24 * 30; // 30 дней

const K = {
  lang: (uid) => `u:${uid}:lang`,
  session: (uid) => `u:${uid}:session`,
  ticket: (uid) => `u:${uid}:ticket`,
  ticketById: (tid) => `t:${tid}`,
  ticketByThread: (threadId) => `thread:${threadId}`,
};

const I18N = {
  ru: {
    hello: "Привет! Это поддержка Trader продуктов.\n\nВыберите действие:",
    chooseLang: "Выберите язык / Choose language:",
    menuTitle: "Меню поддержки:",
    create: "🆘 Создать обращение",
    faq: "📌 FAQ",
    status: "ℹ️ Статус",
    contacts: "✉️ Контакты",
    language: "🌐 Язык",
    back: "⬅️ В меню",
    cancel: "↩️ Отмена",
    close: "✅ Закрыть тикет",
    sendOne: "Ок. Теперь отправьте **ОДНО** сообщение с описанием проблемы.\nМожно текст/фото/файл.",
    alreadyOpen: "У вас уже есть открытое обращение. Просто пишите сообщением — я пересылаю в поддержку.",
    sent: "Принято. Переслал в поддержку.",
    sendFail: "⚠️ Не удалось отправить. Попробуйте ещё раз.",
    noTicket: "Открытых обращений нет.",
    openTicket: (id) => `Открыто обращение #${id}.`,
    closed: "Тикет закрыт.",
    adminOnly: "Только для админов.",
    faqText: "FAQ:\n• Опиши проблему одним сообщением\n• Прикрепляй скрины/видео, если нужно\n• Мы отвечаем в этом чате",
    contactsText: "Контакты:\n• Поддержка: в этом боте\n• Канал: (впиши свой контакт/ссылку)",
  },
  en: {
    hello: "Hi! This is Trader product support.\n\nChoose an action:",
    chooseLang: "Choose language / Выберите язык:",
    menuTitle: "Support menu:",
    create: "🆘 Create ticket",
    faq: "📌 FAQ",
    status: "ℹ️ Status",
    contacts: "✉️ Contacts",
    language: "🌐 Language",
    back: "⬅️ Back",
    cancel: "↩️ Cancel",
    close: "✅ Close ticket",
    sendOne: "Ok. Now send **ONE** message describing the issue.\nText/photo/file is fine.",
    alreadyOpen: "You already have an open ticket. Just message me — I’ll forward it to support.",
    sent: "Got it. Forwarded to support.",
    sendFail: "⚠️ Failed to send. Please try again.",
    noTicket: "No open tickets.",
    openTicket: (id) => `Ticket #${id} is open.`,
    closed: "Ticket closed.",
    adminOnly: "Admins only.",
    faqText: "FAQ:\n• Describe the issue in one message\n• Attach screenshots/videos if needed\n• We’ll reply here",
    contactsText: "Contacts:\n• Support: via this bot\n• Channel: (put your link here)",
  }
};

function genTicketId() {
  // 10-значный
  return String(Math.floor(1000000000 + Math.random() * 9000000000));
}

async function getLang(uid) {
  const rec = await getJSON(K.lang(uid));
  return rec?.lang === "en" ? "en" : rec?.lang === "ru" ? "ru" : null;
}
async function setLang(uid, lang) {
  await setJSONEX(K.lang(uid), TICKET_TTL, { lang });
}

async function getSession(uid) {
  return (await getJSON(K.session(uid))) || {};
}
async function setSession(uid, s) {
  await setJSONEX(K.session(uid), TICKET_TTL, s);
}

async function getOpenTicket(uid) {
  return await getJSON(K.ticket(uid));
}
async function setOpenTicket(uid, ticket) {
  await setJSONEX(K.ticket(uid), TICKET_TTL, ticket);
}

async function clearOpenTicket(uid, ticketId, threadId) {
  await delKey(K.ticket(uid));
  if (ticketId) await delKey(K.ticketById(ticketId));
  if (threadId) await delKey(K.ticketByThread(threadId));
}

function langKeyboard() {
  return Markup.inlineKeyboard([
    [Markup.button.callback("Русский", "LANG:ru"), Markup.button.callback("English", "LANG:en")]
  ]);
}

function menuKeyboard(t) {
  return Markup.inlineKeyboard([
    [Markup.button.callback(t.create, "MENU:CREATE")],
    [Markup.button.callback(t.faq, "MENU:FAQ"), Markup.button.callback(t.status, "MENU:STATUS")],
    [Markup.button.callback(t.contacts, "MENU:CONTACTS")],
    [Markup.button.callback(t.language, "MENU:LANG")]
  ]);
}

function ticketKeyboard(t) {
  return Markup.inlineKeyboard([
    [Markup.button.callback(t.close, "TICKET:CLOSE")],
    [Markup.button.callback(t.back, "MENU:HOME")]
  ]);
}

function awaitKeyboard(t) {
  return Markup.inlineKeyboard([[Markup.button.callback(t.cancel, "FLOW:CANCEL")]]);
}

async function apiCreateForumTopic(bot, name) {
  return bot.telegram.callApi("createForumTopic", {
    chat_id: SUPPORT_GROUP_ID,
    name
  });
}
async function apiCloseForumTopic(bot, threadId) {
  return bot.telegram.callApi("closeForumTopic", {
    chat_id: SUPPORT_GROUP_ID,
    message_thread_id: threadId
  });
}
async function apiSendToTopic(bot, threadId, text, extra = {}) {
  return bot.telegram.callApi("sendMessage", {
    chat_id: SUPPORT_GROUP_ID,
    message_thread_id: threadId,
    text,
    ...extra
  });
}
async function apiCopyToTopic(bot, threadId, fromChatId, messageId, extra = {}) {
  return bot.telegram.callApi("copyMessage", {
    chat_id: SUPPORT_GROUP_ID,
    message_thread_id: threadId,
    from_chat_id: fromChatId,
    message_id: messageId,
    ...extra
  });
}
async function apiCopyToUser(bot, userId, fromChatId, messageId, extra = {}) {
  return bot.telegram.callApi("copyMessage", {
    chat_id: userId,
    from_chat_id: fromChatId,
    message_id: messageId,
    ...extra
  });
}

async function ensureThread(bot, ticket, user) {
  // если топик умер/закрыт — пересоздадим и перелинкуем
  try {
    await apiSendToTopic(bot, ticket.threadId, "—", { disable_notification: true });
    return ticket;
  } catch {
    const created = await apiCreateForumTopic(bot, `Ticket #${ticket.ticketId}`);
    const newThreadId = created.message_thread_id;

    // перелинкуем
    ticket.threadId = newThreadId;
    await setJSONEX(K.ticketByThread(newThreadId), TICKET_TTL, { ticketId: ticket.ticketId });

    await setJSONEX(K.ticketById(ticket.ticketId), TICKET_TTL, ticket);
    await setOpenTicket(user.id, ticket);

    // шапка
    await apiSendToTopic(
      bot,
      newThreadId,
      `🆕 Ticket #${ticket.ticketId}\nUser: ${user.first_name || ""} (@${user.username || "no_username"})\nUserId: ${user.id}`,
      {
        reply_markup: {
          inline_keyboard: [[{ text: "✅ Close ticket", callback_data: `ADMIN:CLOSE:${ticket.ticketId}` }]]
        }
      }
    );

    return ticket;
  }
}

let _bot = null;

export function getBot() {
  if (_bot) return _bot;

  const bot = new Telegraf(BOT_TOKEN);

  // ========== START / LANGUAGE ==========
  async function showStart(ctx) {
    const uid = ctx.from.id;
    const lang = await getLang(uid);
    if (!lang) {
      return ctx.reply(I18N.ru.chooseLang, langKeyboard());
    }
    const t = I18N[lang];
    return ctx.reply(t.menuTitle, menuKeyboard(t));
  }

  bot.hears(/^\/start/i, showStart);

  // ========== CALLBACKS ==========
  bot.on("callback_query", async (ctx) => {
    try {
      const uid = ctx.from.id;
      const data = ctx.callbackQuery.data || "";
      const lang = (await getLang(uid)) || "ru";
      const t = I18N[lang];

      // lang set
      if (data.startsWith("LANG:")) {
        const chosen = data.split(":")[1] === "en" ? "en" : "ru";
        await setLang(uid, chosen);
        const tt = I18N[chosen];
        await ctx.answerCbQuery("OK");
        return ctx.editMessageText(tt.menuTitle, menuKeyboard(tt));
      }

      if (data === "MENU:HOME") {
        await ctx.answerCbQuery();
        return ctx.editMessageText(t.menuTitle, menuKeyboard(t));
      }

      if (data === "MENU:LANG") {
        await ctx.answerCbQuery();
        return ctx.editMessageText(I18N.ru.chooseLang, langKeyboard());
      }

      if (data === "MENU:FAQ") {
        await ctx.answerCbQuery();
        return ctx.editMessageText(t.faqText, Markup.inlineKeyboard([[Markup.button.callback(t.back, "MENU:HOME")]]));
      }

      if (data === "MENU:CONTACTS") {
        await ctx.answerCbQuery();
        return ctx.editMessageText(t.contactsText, Markup.inlineKeyboard([[Markup.button.callback(t.back, "MENU:HOME")]]));
      }

      if (data === "MENU:STATUS") {
        await ctx.answerCbQuery();
        const ticket = await getOpenTicket(uid);
        const text = ticket?.status === "open" ? t.openTicket(ticket.ticketId) : t.noTicket;
        return ctx.editMessageText(text, Markup.inlineKeyboard([[Markup.button.callback(t.back, "MENU:HOME")]]));
      }

      if (data === "MENU:CREATE") {
        await ctx.answerCbQuery();
        const ticket = await getOpenTicket(uid);
        if (ticket?.status === "open") {
          return ctx.editMessageText(t.alreadyOpen, ticketKeyboard(t));
        }
        const session = await getSession(uid);
        session.awaitingFirstMessage = true;
        await setSession(uid, session);
        return ctx.editMessageText(t.sendOne, awaitKeyboard(t));
      }

      if (data === "FLOW:CANCEL") {
        await ctx.answerCbQuery();
        const session = await getSession(uid);
        session.awaitingFirstMessage = false;
        await setSession(uid, session);
        return ctx.editMessageText(t.menuTitle, menuKeyboard(t));
      }

      if (data === "TICKET:CLOSE") {
        await ctx.answerCbQuery();
        const ticket = await getOpenTicket(uid);
        if (!ticket?.ticketId) return ctx.editMessageText(t.noTicket, menuKeyboard(t));

        ticket.status = "closed";
        await clearOpenTicket(uid, ticket.ticketId, ticket.threadId);
        try { await apiCloseForumTopic(bot, ticket.threadId); } catch {}
        return ctx.editMessageText(t.closed, menuKeyboard(t));
      }

      // admin close from group
      if (data.startsWith("ADMIN:CLOSE:")) {
        const fromId = ctx.from.id;
        if (!ADMIN_USERS_IDS.includes(fromId)) {
          await ctx.answerCbQuery(t.adminOnly, { show_alert: true });
          return;
        }
        const ticketId = data.split(":")[2];
        const ticket = await getJSON(K.ticketById(ticketId));
        if (ticket?.userId) {
          await clearOpenTicket(ticket.userId, ticketId, ticket.threadId);
          try { await apiCloseForumTopic(bot, ticket.threadId); } catch {}
          try { await bot.telegram.sendMessage(ticket.userId, I18N[(await getLang(ticket.userId)) || "ru"].closed); } catch {}
        }
        await ctx.answerCbQuery("Closed");
        return;
      }

      await ctx.answerCbQuery();
    } catch (e) {
      try { await ctx.answerCbQuery("Error"); } catch {}
    }
  });

  // ========== PRIVATE CHAT MESSAGES ==========
  bot.on("message", async (ctx) => {
    const chatType = ctx.chat?.type;
    if (chatType !== "private") return;

    const uid = ctx.from.id;
    const lang = (await getLang(uid)) || null;
    if (!lang) {
      return ctx.reply(I18N.ru.chooseLang, langKeyboard());
    }
    const t = I18N[lang];

    const session = await getSession(uid);
    const openTicket = await getOpenTicket(uid);

    // если ждём первое сообщение — создаём тикет
    if (session.awaitingFirstMessage) {
      session.awaitingFirstMessage = false;
      await setSession(uid, session);

      const ticketId = genTicketId();
      const created = await apiCreateForumTopic(bot, `Ticket #${ticketId}`);
      const threadId = created.message_thread_id;

      const ticket = {
        ticketId,
        userId: uid,
        threadId,
        status: "open",
        createdAt: Date.now()
      };

      await setJSONEX(K.ticketByThread(threadId), TICKET_TTL, { ticketId });
      await setJSONEX(K.ticketById(ticketId), TICKET_TTL, ticket);
      await setOpenTicket(uid, ticket);

      // шапка + кнопка закрытия (админам)
      await apiSendToTopic(
        bot,
        threadId,
        `🆕 Ticket #${ticketId}\nUser: ${ctx.from.first_name || ""} (@${ctx.from.username || "no_username"})\nUserId: ${uid}`,
        {
          reply_markup: {
            inline_keyboard: [[{ text: "✅ Close ticket", callback_data: `ADMIN:CLOSE:${ticketId}` }]]
          }
        }
      );

      // копируем первое сообщение пользователя в топик
      try {
        await apiCopyToTopic(bot, threadId, ctx.chat.id, ctx.message.message_id);
      } catch {}

      await ctx.reply(`Ticket #${ticketId} created.`, ticketKeyboard(t));
      return;
    }

    // если тикет открыт — пересылаем всё в поддержку
    if (openTicket?.status === "open") {
      try {
        const fixedTicket = await ensureThread(bot, openTicket, ctx.from);
        await apiCopyToTopic(bot, fixedTicket.threadId, ctx.chat.id, ctx.message.message_id);
        await ctx.reply(t.sent, ticketKeyboard(t));
      } catch {
        await ctx.reply(t.sendFail, ticketKeyboard(t));
      }
      return;
    }

    // иначе — показываем меню
    await ctx.reply(t.menuTitle, menuKeyboard(t));
  });

  // ========== SUPPORT GROUP MESSAGES -> USER ==========
  bot.on("message", async (ctx) => {
    if (ctx.chat?.id !== SUPPORT_GROUP_ID) return;

    const msg = ctx.message;
    const threadId = msg.message_thread_id;
    if (!threadId) return;

    // игнорим сообщения самого бота, чтобы не зациклиться
    if (msg.from?.is_bot) return;

    const map = await getJSON(K.ticketByThread(threadId));
    const ticketId = map?.ticketId;
    if (!ticketId) return;

    const ticket = await getJSON(K.ticketById(ticketId));
    if (!ticket?.userId) return;

    try {
      await apiCopyToUser(bot, ticket.userId, ctx.chat.id, msg.message_id);
    } catch {
      // пользователь мог заблокировать бота — тут можно пометить тикет, но не обязательно
    }
  });

  // expose secret for webhook handler
  bot.context.webhookSecret = WEBHOOK_SECRET;

  _bot = bot;
  return bot;
}
