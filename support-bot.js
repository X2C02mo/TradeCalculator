// support-bot.js
const { Telegraf, Markup } = require("telegraf");
const { createStore } = require("./store");

const BUILD = process.env.BUILD_VERSION || "build-1"; // для диагностики

function parseAdminIds(raw) {
  if (!raw) return new Set();
  return new Set(
    raw
      .split(/[,\s]+/)
      .map((x) => x.trim())
      .filter(Boolean)
      .map((x) => Number(x))
      .filter((n) => Number.isFinite(n))
  );
}

function normChatId(raw) {
  if (raw == null) throw new Error("SUPPORT_GROUP_ID is missing");
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new Error("SUPPORT_GROUP_ID must be a number");
  return n;
}

function clampTopicName(s) {
  const clean = String(s).replace(/\s+/g, " ").trim();
  return clean.length > 120 ? clean.slice(0, 120) + "…" : clean;
}

function displayUser(u) {
  const parts = [];
  if (u.first_name) parts.push(u.first_name);
  if (u.last_name) parts.push(u.last_name);
  const name = parts.join(" ").trim() || `id:${u.id}`;
  const tag = u.username ? `@${u.username}` : "";
  return tag ? `${name} (${tag})` : name;
}

const I18N = {
  ru: {
    chooseLangTitle: "Выберите язык:",
    chooseLangHint: "Язык можно изменить позже в меню.",
    menuTitle: "Меню поддержки:",
    menuIntro: "Выберите действие кнопками ниже.",
    create: "🆘 Создать обращение",
    faq: "📌 FAQ",
    status: "ℹ️ Статус",
    contacts: "✉️ Контакты",
    lang: "🌐 Язык",
    back: "⬅️ Назад",
    cancel: "⬅️ Отмена",
    close: "✅ Закрыть обращение",
    closeAdmin: "✅ Закрыть тикет",
    sent: "✅ Отправлено в поддержку.",
    alreadyOpen: "У вас уже есть открытое обращение. Просто пишите сообщением — я пересылаю в поддержку.",
    pickCategory: "Выберите категорию:",
    cat_bug: "🐞 Баг / Ошибка",
    cat_pay: "💳 Оплата",
    cat_biz: "🤝 Партнёрство",
    cat_other: "❓ Другое",
    askOneMsg: "Ок. Теперь отправьте ОДНО сообщение с описанием проблемы.\nМожно текст/фото/файл.",
    created: "✅ Обращение создано. Пишите сюда — я буду пересылать в поддержку.\n\nЕсли вопрос решён — закройте обращение кнопкой.",
    closed: "✅ Обращение закрыто. Если нужно — создайте новое через меню.",
    noOpen: "Открытого обращения нет.",
    statusOpen: (cat) => `ℹ️ Статус: ОТКРЫТО\nКатегория: ${cat || "—"}`,
    statusNone: "ℹ️ Открытых обращений нет.",
    faqText:
      "📌 FAQ\n\n" +
      "• Как быстро отвечают? Обычно в течение дня.\n" +
      "• Что писать? Конкретно: что делали, что ожидали, что получили.\n" +
      "• Скрины/логи приветствуются.\n\n" +
      "Нажмите «Создать обращение», если нужна помощь.",
    contactsText:
      "✉️ Контакты\n\n" +
      "Если вопрос срочный — создайте обращение, поддержка увидит его в теме.\n" +
      "Если нужен другой канал — добавьте сюда нужные контакты (почта/чат) и я вставлю.",
    supportPrefix: "🧑‍💻 Поддержка:\n\n",
    supportAttachment: "🧑‍💻 Поддержка отправила вложение.",
    sendFail: "⚠️ Не удалось отправить в поддержку. Я попробую восстановить тему — повторите сообщение ещё раз."
  },
  en: {
    chooseLangTitle: "Choose language:",
    chooseLangHint: "You can change it later in the menu.",
    menuTitle: "Support menu:",
    menuIntro: "Use the buttons below.",
    create: "🆘 Create ticket",
    faq: "📌 FAQ",
    status: "ℹ️ Status",
    contacts: "✉️ Contacts",
    lang: "🌐 Language",
    back: "⬅️ Back",
    cancel: "⬅️ Cancel",
    close: "✅ Close ticket",
    closeAdmin: "✅ Close ticket",
    sent: "✅ Sent to support.",
    alreadyOpen: "You already have an open ticket. Just send messages here — I will forward them to support.",
    pickCategory: "Choose a category:",
    cat_bug: "🐞 Bug / Error",
    cat_pay: "💳 Payments",
    cat_biz: "🤝 Partnership",
    cat_other: "❓ Other",
    askOneMsg: "OK. Now send ONE message describing the issue.\nText/photo/file is fine.",
    created: "✅ Ticket created. Message me here — I will forward to support.\n\nIf solved — close it with the button.",
    closed: "✅ Ticket closed. If needed — create a new one from the menu.",
    noOpen: "No open ticket.",
    statusOpen: (cat) => `ℹ️ Status: OPEN\nCategory: ${cat || "—"}`,
    statusNone: "ℹ️ No open tickets.",
    faqText:
      "📌 FAQ\n\n" +
      "• Response time: usually within a day.\n" +
      "• What to send: steps, expected result, actual result.\n" +
      "• Screenshots/logs help a lot.\n\n" +
      "Press “Create ticket” if you need help.",
    contactsText:
      "✉️ Contacts\n\n" +
      "If urgent — create a ticket so support sees it in the topic.\n" +
      "If you need another channel — tell me (email/chat) and I’ll add it here.",
    supportPrefix: "🧑‍💻 Support:\n\n",
    supportAttachment: "🧑‍💻 Support sent an attachment.",
    sendFail: "⚠️ Failed to send to support. I’ll try to recover the topic — resend your message."
  }
};

function createSupportBot() {
  const token = process.env.SUPPORT_BOT_TOKEN;
  if (!token) throw new Error("SUPPORT_BOT_TOKEN is missing");

  const SUPPORT_CHAT_ID = normChatId(process.env.SUPPORT_GROUP_ID);
  const ADMIN_IDS = parseAdminIds(process.env.ADMIN_USERS_IDS);

  const store = createStore();
  const bot = new Telegraf(token);

  const keyState = (uid) => `state:user:${uid}`;
  const keyTicketByUser = (uid) => `ticket:user:${uid}`;
  const keyUserByThread = (threadId) => `ticket:thread:${SUPPORT_CHAT_ID}:${threadId}`;
  const keyDedup = (updateId) => `dedup:update:${updateId}`;
  const keyLang = (uid) => `user:lang:${uid}`;
  const keyMemberCache = (uid) => `cache:member:${SUPPORT_CHAT_ID}:${uid}`;

  const isPrivate = (ctx) => ctx.chat && ctx.chat.type === "private";
  const isSupportGroup = (ctx) => ctx.chat && ctx.chat.id === SUPPORT_CHAT_ID;

  async function getLang(uid) {
    const v = await store.getJson(keyLang(uid));
    return v === "en" || v === "ru" ? v : null;
  }
  async function setLang(uid, lang) {
    await store.setJson(keyLang(uid), lang);
  }

  function t(lang, key) {
    const pack = I18N[lang] || I18N.ru;
    return pack[key] ?? I18N.ru[key] ?? key;
  }
  function tFn(lang, key, ...args) {
    const pack = I18N[lang] || I18N.ru;
    const v = pack[key] ?? I18N.ru[key];
    return typeof v === "function" ? v(...args) : String(v);
  }

  function langKeyboard() {
    return Markup.inlineKeyboard([
      [Markup.button.callback("English", "lang:en"), Markup.button.callback("Русский", "lang:ru")]
    ]);
  }

  function userMenu(lang) {
    return Markup.inlineKeyboard([
      [Markup.button.callback(t(lang, "create"), "u:open")],
      [Markup.button.callback(t(lang, "faq"), "u:faq"), Markup.button.callback(t(lang, "status"), "u:status")],
      [Markup.button.callback(t(lang, "contacts"), "u:contacts")],
      [Markup.button.callback(t(lang, "lang"), "u:lang")]
    ]);
  }

  function categoryMenu(lang) {
    return Markup.inlineKeyboard([
      [Markup.button.callback(t(lang, "cat_bug"), "u:cat:bug")],
      [Markup.button.callback(t(lang, "cat_pay"), "u:cat:pay")],
      [Markup.button.callback(t(lang, "cat_biz"), "u:cat:biz")],
      [Markup.button.callback(t(lang, "cat_other"), "u:cat:other")],
      [Markup.button.callback(t(lang, "back"), "u:back")]
    ]);
  }

  function userTicketActions(lang) {
    return Markup.inlineKeyboard([
      [Markup.button.callback(t(lang, "close"), "u:close")],
      [Markup.button.callback(t(lang, "back"), "u:back")]
    ]);
  }

  function adminTicketActions(userId, langForLabel = "ru") {
    return Markup.inlineKeyboard([[Markup.button.callback(t(langForLabel, "closeAdmin"), `a:close:${userId}`)]]);
  }

  async function setState(uid, stateObj, ttlSec = 600) {
    await store.setJson(keyState(uid), stateObj, ttlSec);
  }
  async function clearState(uid) {
    await store.del(keyState(uid));
  }
  async function getState(uid) {
    return await store.getJson(keyState(uid));
  }

  async function getOpenTicket(uid) {
    const tk = await store.getJson(keyTicketByUser(uid));
    if (!tk || tk.status !== "open") return null;
    return tk;
  }

  async function isGroupAdmin(userId) {
    if (ADMIN_IDS.has(Number(userId))) return true;

    const cached = await store.getJson(keyMemberCache(userId));
    if (cached && typeof cached.isAdmin === "boolean") return cached.isAdmin;

    try {
      const m = await bot.telegram.getChatMember(SUPPORT_CHAT_ID, userId);
      const isAdmin = m && (m.status === "administrator" || m.status === "creator");
      await store.setJson(keyMemberCache(userId), { isAdmin }, 300);
      return isAdmin;
    } catch {
      await store.setJson(keyMemberCache(userId), { isAdmin: false }, 60);
      return false;
    }
  }

  async function createNewTopicForUser(userId, fromUser, category, lang) {
    const topicName = clampTopicName(`Ticket #${userId} — ${displayUser(fromUser)} — ${category || "other"}`);
    const topic = await bot.telegram.createForumTopic(SUPPORT_CHAT_ID, topicName);
    const threadId = topic.message_thread_id;

    const ticketObj = {
      status: "open",
      userId,
      threadId,
      category: category || "other",
      lang: lang || "ru",
      createdAt: Date.now()
    };

    await store.setJson(keyTicketByUser(userId), ticketObj, 60 * 60 * 24 * 14);
    await store.setJson(keyUserByThread(threadId), { userId }, 60 * 60 * 24 * 14);

    // notify admins
    try {
      await bot.telegram.sendMessage(
        SUPPORT_CHAT_ID,
        `🆕 New ticket\n👤 ${displayUser(fromUser)}\n🧾 Ticket: #${userId}\n🌐 Lang: ${lang}\n📂 ${ticketObj.category}\n\nReply inside THIS topic — bot will forward to the user.`,
        { message_thread_id: threadId, ...adminTicketActions(userId, lang) }
      );
    } catch (_) {}

    return ticketObj;
  }

  async function closeTicketEverywhere({ userId, closedBy, threadId }) {
    const lang = (await getLang(userId)) || "ru";

    const ticket = await store.getJson(keyTicketByUser(userId));
    if (ticket && ticket.status === "open") {
      ticket.status = "closed";
      ticket.closedBy = closedBy;
      ticket.closedAt = Date.now();
      await store.setJson(keyTicketByUser(userId), ticket, 60 * 60 * 24 * 7);
    } else {
      await store.del(keyTicketByUser(userId));
    }

    if (threadId) {
      await store.del(keyUserByThread(threadId));
      try { await bot.telegram.closeForumTopic(SUPPORT_CHAT_ID, threadId); } catch (_) {}
      try {
        await bot.telegram.sendMessage(SUPPORT_CHAT_ID, `✅ Ticket closed (${closedBy}).`, { message_thread_id: threadId });
      } catch (_) {}
    }

    try {
      await bot.telegram.sendMessage(userId, t(lang, "closed"), userMenu(lang));
    } catch (_) {}
  }

  bot.catch((err, ctx) => {
    console.error("BOT_ERROR", { build: BUILD, err: String(err?.stack || err), update: ctx?.update });
  });

  bot.use(async (ctx, next) => {
    const updateId = ctx.update && ctx.update.update_id;
    if (!updateId) return next();
    const first = await store.setOnce(keyDedup(updateId), "1", 120);
    if (!first) return;
    return next();
  });

  // ✅ start in any case: /start /START /Start
  async function showLangPicker(ctx) {
    if (!isPrivate(ctx) || !ctx.from) return;
    await clearState(ctx.from.id);
    await ctx.reply(`${I18N.ru.chooseLangTitle}\n${I18N.ru.chooseLangHint}\n\n(${BUILD})`, langKeyboard());
  }
  bot.start(showLangPicker);
  bot.hears(/^\/start(\s|$)/i, showLangPicker);

  bot.action(/^lang:(ru|en)$/, async (ctx) => {
    await ctx.answerCbQuery().catch(() => {});
    if (!isPrivate(ctx) || !ctx.from) return;

    const lang = ctx.match[1];
    await setLang(ctx.from.id, lang);
    await clearState(ctx.from.id);

    const text = `${t(lang, "menuTitle")}\n${t(lang, "menuIntro")}`;
    await ctx.editMessageText(text, userMenu(lang)).catch(async () => {
      await ctx.reply(text, userMenu(lang));
    });
  });

  bot.action("u:lang", async (ctx) => {
    await ctx.answerCbQuery().catch(() => {});
    if (!isPrivate(ctx) || !ctx.from) return;

    const lang = (await getLang(ctx.from.id)) || "ru";
    const text = `${t(lang, "chooseLangTitle")}\n${t(lang, "chooseLangHint")}`;
    await ctx.editMessageText(text, langKeyboard()).catch(async () => {
      await ctx.reply(text, langKeyboard());
    });
  });

  bot.action("u:back", async (ctx) => {
    await ctx.answerCbQuery().catch(() => {});
    if (!isPrivate(ctx) || !ctx.from) return;

    const lang = await getLang(ctx.from.id);
    if (!lang) return showLangPicker(ctx);

    await clearState(ctx.from.id);
    const text = `${t(lang, "menuTitle")}\n${t(lang, "menuIntro")}`;
    await ctx.editMessageText(text, userMenu(lang)).catch(async () => {
      await ctx.reply(text, userMenu(lang));
    });
  });

  bot.action("u:open", async (ctx) => {
    await ctx.answerCbQuery().catch(() => {});
    if (!isPrivate(ctx) || !ctx.from) return;

    const lang = await getLang(ctx.from.id);
    if (!lang) return showLangPicker(ctx);

    const openTicket = await getOpenTicket(ctx.from.id);
    if (openTicket) {
      await ctx.reply(t(lang, "alreadyOpen"), userTicketActions(lang));
      return;
    }

    await ctx.editMessageText(t(lang, "pickCategory"), categoryMenu(lang)).catch(async () => {
      await ctx.reply(t(lang, "pickCategory"), categoryMenu(lang));
    });
  });

  bot.action(/^u:cat:(.+)$/, async (ctx) => {
    await ctx.answerCbQuery().catch(() => {});
    if (!isPrivate(ctx) || !ctx.from) return;

    const lang = await getLang(ctx.from.id);
    if (!lang) return showLangPicker(ctx);

    const userId = ctx.from.id;
    const openTicket = await getOpenTicket(userId);
    if (openTicket) {
      await ctx.reply(t(lang, "alreadyOpen"), userTicketActions(lang));
      return;
    }

    const cat = ctx.match[1];
    await setState(userId, { mode: "AWAITING_DESCRIPTION", category: cat }, 600);

    await ctx.editMessageText(
      t(lang, "askOneMsg"),
      Markup.inlineKeyboard([[Markup.button.callback(t(lang, "cancel"), "u:back")]])
    ).catch(async () => {
      await ctx.reply(
        t(lang, "askOneMsg"),
        Markup.inlineKeyboard([[Markup.button.callback(t(lang, "cancel"), "u:back")]])
      );
    });
  });

  bot.action("u:faq", async (ctx) => {
    await ctx.answerCbQuery().catch(() => {});
    if (!isPrivate(ctx) || !ctx.from) return;

    const lang = await getLang(ctx.from.id);
    if (!lang) return showLangPicker(ctx);

    await ctx.editMessageText(
      t(lang, "faqText"),
      Markup.inlineKeyboard([[Markup.button.callback(t(lang, "back"), "u:back")]])
    ).catch(async () => {
      await ctx.reply(
        t(lang, "faqText"),
        Markup.inlineKeyboard([[Markup.button.callback(t(lang, "back"), "u:back")]])
      );
    });
  });

  bot.action("u:contacts", async (ctx) => {
    await ctx.answerCbQuery().catch(() => {});
    if (!isPrivate(ctx) || !ctx.from) return;

    const lang = await getLang(ctx.from.id);
    if (!lang) return showLangPicker(ctx);

    await ctx.editMessageText(
      t(lang, "contactsText"),
      Markup.inlineKeyboard([[Markup.button.callback(t(lang, "back"), "u:back")]])
    ).catch(async () => {
      await ctx.reply(
        t(lang, "contactsText"),
        Markup.inlineKeyboard([[Markup.button.callback(t(lang, "back"), "u:back")]])
      );
    });
  });

  bot.action("u:status", async (ctx) => {
    await ctx.answerCbQuery().catch(() => {});
    if (!isPrivate(ctx) || !ctx.from) return;

    const lang = await getLang(ctx.from.id);
    if (!lang) return showLangPicker(ctx);

    const tk = await store.getJson(keyTicketByUser(ctx.from.id));
    const text = tk && tk.status === "open" ? tFn(lang, "statusOpen", tk.category) : t(lang, "statusNone");

    await ctx.editMessageText(
      text,
      Markup.inlineKeyboard([[Markup.button.callback(t(lang, "back"), "u:back")]])
    ).catch(async () => {
      await ctx.reply(
        text,
        Markup.inlineKeyboard([[Markup.button.callback(t(lang, "back"), "u:back")]])
      );
    });
  });

  bot.action("u:close", async (ctx) => {
    await ctx.answerCbQuery().catch(() => {});
    if (!isPrivate(ctx) || !ctx.from) return;

    const lang = (await getLang(ctx.from.id)) || "ru";
    const tk = await getOpenTicket(ctx.from.id);
    if (!tk) {
      await ctx.reply(t(lang, "noOpen"), userMenu(lang));
      return;
    }
    await closeTicketEverywhere({ userId: ctx.from.id, closedBy: "user", threadId: tk.threadId });
  });

  bot.action(/^a:close:(\d+)$/, async (ctx) => {
    await ctx.answerCbQuery().catch(() => {});
    if (!isSupportGroup(ctx) || !ctx.from) return;

    const ok = await isGroupAdmin(ctx.from.id);
    if (!ok) return;

    const userId = Number(ctx.match[1]);
    const threadId = ctx.update?.callback_query?.message?.message_thread_id;
    if (!userId || !threadId) return;

    await closeTicketEverywhere({ userId, closedBy: "admin", threadId });
  });

  // ✅ Private messages -> forward / create ticket
  bot.on("message", async (ctx, next) => {
    if (!ctx.from) return next();
    if (!isPrivate(ctx)) return next();

    const userId = ctx.from.id;
    const lang = await getLang(userId);
    if (!lang) return showLangPicker(ctx);

    // If open ticket: forward to support. If thread broken -> recreate once.
    let tk = await getOpenTicket(userId);
    if (tk) {
      const tryForward = async (ticket) => {
        const header =
          `👤 ${displayUser(ctx.from)}\n` +
          `🧾 Ticket: #${userId}\n` +
          `🌐 Lang: ${lang}\n` +
          `📂 ${ticket.category || "—"}`;

        if (ctx.message.text) {
          await bot.telegram.sendMessage(
            SUPPORT_CHAT_ID,
            `${header}\n\n${ctx.message.text}`,
            { message_thread_id: ticket.threadId }
          );
        } else {
          await bot.telegram.copyMessage(
            SUPPORT_CHAT_ID,
            ctx.chat.id,
            ctx.message.message_id,
            { message_thread_id: ticket.threadId }
          );
          await bot.telegram.sendMessage(
            SUPPORT_CHAT_ID,
            `${header}\n\n(attachment)`,
            { message_thread_id: ticket.threadId }
          );
        }
      };

      try {
        await tryForward(tk);
        await ctx.reply(t(lang, "sent"), userTicketActions(lang));
      } catch (e1) {
        console.error("FORWARD_FAIL", { build: BUILD, e: String(e1?.description || e1?.message || e1) });

        // попытка восстановления темы (1 раз)
        try {
          // удалить старую привязку (на всякий)
          await store.del(keyUserByThread(tk.threadId));

          const repaired = await createNewTopicForUser(userId, ctx.from, tk.category, lang);
          tk = repaired;

          await tryForward(tk);
          await ctx.reply(t(lang, "sent"), userTicketActions(lang));
        } catch (e2) {
          console.error("FORWARD_REPAIR_FAIL", { build: BUILD, e: String(e2?.description || e2?.message || e2) });
          await ctx.reply(t(lang, "sendFail"), userTicketActions(lang));
        }
      }
      return;
    }

    // If waiting description: create ticket topic
    const state = await getState(userId);
    if (state && state.mode === "AWAITING_DESCRIPTION") {
      const category = state.category || "other";
      await clearState(userId);

      let newTicket;
      try {
        newTicket = await createNewTopicForUser(userId, ctx.from, category, lang);
      } catch (e) {
        console.error("CREATE_TOPIC_FAILED", { build: BUILD, e: String(e?.description || e?.message || e) });
        await ctx.reply("⚠️ Не смог создать тему в support-группе. Проверь: Topics включены, бот admin, can_manage_topics.", userMenu(lang));
        return;
      }

      // First user message into thread
      try {
        if (ctx.message.text) {
          await bot.telegram.sendMessage(
            SUPPORT_CHAT_ID,
            `👤 User message:\n\n${ctx.message.text}`,
            { message_thread_id: newTicket.threadId }
          );
        } else {
          await bot.telegram.copyMessage(
            SUPPORT_CHAT_ID,
            ctx.chat.id,
            ctx.message.message_id,
            { message_thread_id: newTicket.threadId }
          );
        }
      } catch (e) {
        console.error("FIRST_MESSAGE_TO_THREAD_FAILED", { build: BUILD, e: String(e?.description || e?.message || e) });
      }

      await ctx.reply(t(lang, "created"), userTicketActions(lang));
      return;
    }

    // default -> menu
    await ctx.reply(`${t(lang, "menuTitle")}\n${t(lang, "menuIntro")}`, userMenu(lang));
  });

  // ✅ Support group topic replies -> forward to user
  bot.on("message", async (ctx) => {
    if (!ctx.from || !ctx.message) return;
    if (!isSupportGroup(ctx)) return;

    const threadId = ctx.message.message_thread_id;
    if (!threadId) return;
    if (ctx.from.is_bot) return;

    const ok = await isGroupAdmin(ctx.from.id);
    if (!ok) return;

    const mapping = await store.getJson(keyUserByThread(threadId));
    const userId = mapping && mapping.userId;
    if (!userId) return;

    const lang = (await getLang(userId)) || "ru";

    try {
      if (ctx.message.text) {
        await bot.telegram.sendMessage(userId, `${t(lang, "supportPrefix")}${ctx.message.text}`, userTicketActions(lang));
      } else {
        await bot.telegram.copyMessage(userId, ctx.chat.id, ctx.message.message_id);
        await bot.telegram.sendMessage(userId, t(lang, "supportAttachment"), userTicketActions(lang));
      }
    } catch (e) {
      console.error("FORWARD_TO_USER_FAILED", { build: BUILD, e: String(e?.description || e?.message || e) });
    }
  });

  return bot;
}

module.exports = { createSupportBot };
