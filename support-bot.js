// support-bot.js (CommonJS)
const { Telegraf, Markup } = require("telegraf");
const { createStore } = require("./store");

const BUILD = process.env.BUILD_VERSION || "no-build";
const SUPPORT_CHAT_ID = Number(process.env.SUPPORT_GROUP_ID);
const ADMIN_IDS = new Set(
  String(process.env.ADMIN_USERS_IDS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map(Number)
    .filter(Number.isFinite)
);

if (!process.env.SUPPORT_BOT_TOKEN) throw new Error("SUPPORT_BOT_TOKEN missing");
if (!Number.isFinite(SUPPORT_CHAT_ID)) throw new Error("SUPPORT_GROUP_ID must be a number");

const PREFIX = "sb:v2:"; // чтобы старые ключи не ломали логику

const TTL_TICKET = 60 * 60 * 24 * 14; // 14 дней
const TTL_LANG = 60 * 60 * 24 * 365;  // 1 год
const TTL_FLOW = 60 * 15;             // 15 минут

const I18N = {
  ru: {
    chooseLangTitle: "Выберите язык:",
    chooseLangHint: "Язык можно сменить позже в меню.",
    menuTitle: "Меню поддержки:",
    menuIntro: "Выберите действие:",
    create: "🆘 Создать обращение",
    faq: "📌 FAQ",
    status: "ℹ️ Статус",
    contacts: "✉️ Контакты",
    lang: "🌐 Язык",
    back: "⬅️ В меню",
    cancel: "↩️ Отмена",
    close: "✅ Закрыть обращение",
    closeAdmin: "✅ Закрыть тикет",
    pickCategory: "Выберите категорию:",
    cat_bug: "🐞 Баг / Ошибка",
    cat_pay: "💳 Оплата",
    cat_biz: "🤝 Партнёрство",
    cat_other: "❓ Другое",
    askOne: "Ок. Отправьте ОДНО сообщение с описанием проблемы (текст/фото/файл).",
    alreadyOpen: "У вас уже есть открытое обращение. Просто пишите сообщением — я пересылаю в поддержку.",
    sent: "✅ Отправлено в поддержку.",
    sendFail: "⚠️ Не удалось отправить. Попробуйте ещё раз.",
    created: "✅ Обращение создано. Пишите сюда — я пересылаю в поддержку.",
    closed: "✅ Обращение закрыто.",
    statusOpen: (cat) => `ℹ️ Статус: ОТКРЫТО\nКатегория: ${cat || "—"}`,
    statusNone: "ℹ️ Открытых обращений нет.",
    faqText: "FAQ:\n• Опиши проблему конкретно\n• Скрины/логи помогают\n• Ответ придёт сюда",
    contactsText: "Контакты:\n• Поддержка — через этого бота\n• (добавь свои контакты сюда)",
    supportPrefix: "🧑‍💻 Поддержка:\n\n",
    supportAttachment: "🧑‍💻 Поддержка отправила вложение."
  },
  en: {
    chooseLangTitle: "Choose language:",
    chooseLangHint: "You can change it later in the menu.",
    menuTitle: "Support menu:",
    menuIntro: "Choose an action:",
    create: "🆘 Create ticket",
    faq: "📌 FAQ",
    status: "ℹ️ Status",
    contacts: "✉️ Contacts",
    lang: "🌐 Language",
    back: "⬅️ Back",
    cancel: "↩️ Cancel",
    close: "✅ Close ticket",
    closeAdmin: "✅ Close ticket",
    pickCategory: "Choose a category:",
    cat_bug: "🐞 Bug / Error",
    cat_pay: "💳 Payments",
    cat_biz: "🤝 Partnership",
    cat_other: "❓ Other",
    askOne: "OK. Send ONE message describing the issue (text/photo/file).",
    alreadyOpen: "You already have an open ticket. Just message me — I’ll forward it to support.",
    sent: "✅ Sent to support.",
    sendFail: "⚠️ Failed to send. Please try again.",
    created: "✅ Ticket created. Message me here — I will forward to support.",
    closed: "✅ Ticket closed.",
    statusOpen: (cat) => `ℹ️ Status: OPEN\nCategory: ${cat || "—"}`,
    statusNone: "ℹ️ No open tickets.",
    faqText: "FAQ:\n• Describe the issue clearly\n• Screenshots/logs help\n• We’ll reply here",
    contactsText: "Contacts:\n• Support — via this bot\n• (add your contacts here)",
    supportPrefix: "🧑‍💻 Support:\n\n",
    supportAttachment: "🧑‍💻 Support sent an attachment."
  }
};

function clamp(s, n = 120) {
  s = String(s).replace(/\s+/g, " ").trim();
  return s.length > n ? s.slice(0, n) + "…" : s;
}
function displayUser(u) {
  const name = [u.first_name, u.last_name].filter(Boolean).join(" ").trim() || `id:${u.id}`;
  const tag = u.username ? `@${u.username}` : "";
  return tag ? `${name} (${tag})` : name;
}

function createSupportBot() {
  const store = createStore();
  const bot = new Telegraf(process.env.SUPPORT_BOT_TOKEN);

  const key = {
    dedup: (updateId) => `${PREFIX}dedup:${updateId}`,
    lang: (uid) => `${PREFIX}lang:${uid}`,
    flow: (uid) => `${PREFIX}flow:${uid}`,       // {mode, category}
    pending: (uid) => `${PREFIX}pending:${uid}`, // {screen, payload}
    ticket: (uid) => `${PREFIX}ticket:${uid}`,   // {status, threadId, category, lang, createdAt}
    threadMap: (threadId) => `${PREFIX}thread:${SUPPORT_CHAT_ID}:${threadId}` // {userId}
  };

  const isPrivate = (ctx) => ctx.chat?.type === "private";
  const isSupportGroup = (ctx) => ctx.chat?.id === SUPPORT_CHAT_ID;

  async function getLang(uid) {
    const v = await store.getJson(key.lang(uid));
    return v === "en" || v === "ru" ? v : null;
  }
  async function setLang(uid, lang) {
    await store.setJson(key.lang(uid), lang, TTL_LANG);
  }

  function t(lang, k) {
    const pack = I18N[lang] || I18N.ru;
    return pack[k] ?? I18N.ru[k] ?? k;
  }
  function tFn(lang, k, ...args) {
    const pack = I18N[lang] || I18N.ru;
    const v = pack[k] ?? I18N.ru[k];
    return typeof v === "function" ? v(...args) : String(v);
  }

  function kbLang() {
    return Markup.inlineKeyboard([
      [Markup.button.callback("Русский", "LANG:ru"), Markup.button.callback("English", "LANG:en")]
    ]);
  }
  function kbMenu(lang) {
    return Markup.inlineKeyboard([
      [Markup.button.callback(t(lang, "create"), "U:OPEN")],
      [Markup.button.callback(t(lang, "faq"), "U:FAQ"), Markup.button.callback(t(lang, "status"), "U:STATUS")],
      [Markup.button.callback(t(lang, "contacts"), "U:CONTACTS")],
      [Markup.button.callback(t(lang, "lang"), "U:LANG")]
    ]);
  }
  function kbCategories(lang) {
    return Markup.inlineKeyboard([
      [Markup.button.callback(t(lang, "cat_bug"), "U:CAT:bug")],
      [Markup.button.callback(t(lang, "cat_pay"), "U:CAT:pay")],
      [Markup.button.callback(t(lang, "cat_biz"), "U:CAT:biz")],
      [Markup.button.callback(t(lang, "cat_other"), "U:CAT:other")],
      [Markup.button.callback(t(lang, "back"), "U:HOME")]
    ]);
  }
  function kbTicket(lang) {
    return Markup.inlineKeyboard([
      [Markup.button.callback(t(lang, "close"), "U:CLOSE")],
      [Markup.button.callback(t(lang, "back"), "U:HOME")]
    ]);
  }
  function kbCancel(lang) {
    return Markup.inlineKeyboard([[Markup.button.callback(t(lang, "cancel"), "U:HOME")]]);
  }
  function kbAdminClose(userId, lang = "ru") {
    return Markup.inlineKeyboard([[Markup.button.callback(t(lang, "closeAdmin"), `A:CLOSE:${userId}`)]]);
  }

  async function getOpenTicket(uid) {
    const tk = await store.getJson(key.ticket(uid));
    return tk && tk.status === "open" ? tk : null;
  }

  async function createTopic(threadTitle) {
    return bot.telegram.callApi("createForumTopic", {
      chat_id: SUPPORT_CHAT_ID,
      name: threadTitle
    });
  }
  async function closeTopic(threadId) {
    return bot.telegram.callApi("closeForumTopic", {
      chat_id: SUPPORT_CHAT_ID,
      message_thread_id: threadId
    });
  }
  async function sendToTopic(threadId, text, extra = {}) {
    return bot.telegram.sendMessage(SUPPORT_CHAT_ID, text, { message_thread_id: threadId, ...extra });
  }
  async function copyToTopic(threadId, fromChatId, messageId, extra = {}) {
    return bot.telegram.copyMessage(SUPPORT_CHAT_ID, fromChatId, messageId, { message_thread_id: threadId, ...extra });
  }
  async function copyToUser(userId, fromChatId, messageId, extra = {}) {
    return bot.telegram.copyMessage(userId, fromChatId, messageId, extra);
  }

  async function isAdminUser(userId) {
    if (ADMIN_IDS.has(userId)) return true;
    try {
      const m = await bot.telegram.getChatMember(SUPPORT_CHAT_ID, userId);
      return m && (m.status === "administrator" || m.status === "creator");
    } catch {
      return false;
    }
  }

  async function showLangPicker(ctx, pendingScreen) {
    if (!ctx.from) return;
    if (pendingScreen) {
      await store.setJson(key.pending(ctx.from.id), pendingScreen, TTL_FLOW);
    }
    const text = `${I18N.ru.chooseLangTitle}\n${I18N.ru.chooseLangHint}\n(${BUILD})`;
    await ctx.reply(text, kbLang());
  }

  // ---- Dedup (Telegram retries)
  bot.use(async (ctx, next) => {
    const id = ctx.update?.update_id;
    if (!id) return next();
    const first = await store.setOnce(key.dedup(id), "1", 120);
    if (!first) return;
    return next();
  });

  // ---- /start: ВСЕГДА язык + сброс flow, чтобы не было "липких" шагов
  async function onStart(ctx) {
    if (!isPrivate(ctx) || !ctx.from) return;
    await store.del(key.flow(ctx.from.id));
    await store.del(key.pending(ctx.from.id));
    await showLangPicker(ctx, { screen: "MENU" });
  }
  bot.start(onStart);
  bot.hears(/^\/start(\s|$)/i, onStart);

  // ---- callback_query
  bot.on("callback_query", async (ctx) => {
    const uid = ctx.from.id;
    const data = ctx.callbackQuery.data || "";

    await ctx.answerCbQuery().catch(() => {});

    // Язык выбирается всегда, даже если его ещё нет
    if (data.startsWith("LANG:")) {
      const chosen = data.endsWith("en") ? "en" : "ru";
      await setLang(uid, chosen);

      // куда вернуться после выбора языка
      const pending = await store.getJson(key.pending(uid));
      await store.del(key.pending(uid));

      const lang = chosen;
      if (pending?.screen === "ASK_ONE") {
        await store.setJson(key.flow(uid), { mode: "AWAIT", category: pending.category || "other" }, TTL_FLOW);
        return ctx.editMessageText(t(lang, "askOne"), kbCancel(lang)).catch(async () => {
          await ctx.reply(t(lang, "askOne"), kbCancel(lang));
        });
      }

      // default -> menu
      return ctx.editMessageText(`${t(lang, "menuTitle")}\n${t(lang, "menuIntro")}`, kbMenu(lang)).catch(async () => {
        await ctx.reply(`${t(lang, "menuTitle")}\n${t(lang, "menuIntro")}`, kbMenu(lang));
      });
    }

    // всё остальное — только если язык уже выбран
    const lang = await getLang(uid);
    if (!lang) {
      // запомним “куда хотел”, и попросим язык
      if (data === "U:OPEN") await showLangPicker(ctx, { screen: "MENU" });
      else if (data.startsWith("U:CAT:")) await showLangPicker(ctx, { screen: "MENU" });
      else await showLangPicker(ctx, { screen: "MENU" });
      return;
    }

    if (data === "U:LANG") {
      return ctx.editMessageText(`${t(lang, "chooseLangTitle")}\n${t(lang, "chooseLangHint")}`, kbLang()).catch(async () => {
        await ctx.reply(`${t(lang, "chooseLangTitle")}\n${t(lang, "chooseLangHint")}`, kbLang());
      });
    }

    if (data === "U:HOME") {
      return ctx.editMessageText(`${t(lang, "menuTitle")}\n${t(lang, "menuIntro")}`, kbMenu(lang)).catch(async () => {
        await ctx.reply(`${t(lang, "menuTitle")}\n${t(lang, "menuIntro")}`, kbMenu(lang));
      });
    }

    if (data === "U:FAQ") {
      return ctx.editMessageText(
        t(lang, "faqText"),
        Markup.inlineKeyboard([[Markup.button.callback(t(lang, "back"), "U:HOME")]])
      ).catch(async () => {
        await ctx.reply(
          t(lang, "faqText"),
          Markup.inlineKeyboard([[Markup.button.callback(t(lang, "back"), "U:HOME")]])
        );
      });
    }

    if (data === "U:CONTACTS") {
      return ctx.editMessageText(
        t(lang, "contactsText"),
        Markup.inlineKeyboard([[Markup.button.callback(t(lang, "back"), "U:HOME")]])
      ).catch(async () => {
        await ctx.reply(
          t(lang, "contactsText"),
          Markup.inlineKeyboard([[Markup.button.callback(t(lang, "back"), "U:HOME")]])
        );
      });
    }

    if (data === "U:STATUS") {
      const tk = await getOpenTicket(uid);
      const text = tk ? tFn(lang, "statusOpen", tk.category) : t(lang, "statusNone");
      return ctx.editMessageText(
        text,
        Markup.inlineKeyboard([[Markup.button.callback(t(lang, "back"), "U:HOME")]])
      ).catch(async () => {
        await ctx.reply(
          text,
          Markup.inlineKeyboard([[Markup.button.callback(t(lang, "back"), "U:HOME")]])
        );
      });
    }

    if (data === "U:OPEN") {
      const tk = await getOpenTicket(uid);
      if (tk) return ctx.reply(t(lang, "alreadyOpen"), kbTicket(lang));
      return ctx.editMessageText(t(lang, "pickCategory"), kbCategories(lang)).catch(async () => {
        await ctx.reply(t(lang, "pickCategory"), kbCategories(lang));
      });
    }

    if (data.startsWith("U:CAT:")) {
      const tk = await getOpenTicket(uid);
      if (tk) return ctx.reply(t(lang, "alreadyOpen"), kbTicket(lang));

      const category = data.split(":")[2] || "other";
      await store.setJson(key.flow(uid), { mode: "AWAIT", category }, TTL_FLOW);

      return ctx.editMessageText(t(lang, "askOne"), kbCancel(lang)).catch(async () => {
        await ctx.reply(t(lang, "askOne"), kbCancel(lang));
      });
    }

    if (data === "U:CLOSE") {
      const tk = await getOpenTicket(uid);
      if (!tk) return ctx.reply(t(lang, "statusNone"), kbMenu(lang));

      await store.del(key.ticket(uid));
      await store.del(key.threadMap(tk.threadId));
      try { await closeTopic(tk.threadId); } catch {}
      return ctx.reply(t(lang, "closed"), kbMenu(lang));
    }

    if (data.startsWith("A:CLOSE:")) {
      const ok = await isAdminUser(ctx.from.id);
      if (!ok) return;

      const userId = Number(data.split(":")[2]);
      const threadId = ctx.callbackQuery.message?.message_thread_id;

      if (userId && threadId) {
        await store.del(key.ticket(userId));
        await store.del(key.threadMap(threadId));
        try { await closeTopic(threadId); } catch {}
        try {
          const userLang = (await getLang(userId)) || "ru";
          await bot.telegram.sendMessage(userId, t(userLang, "closed"), kbMenu(userLang));
        } catch {}
      }
      return;
    }
  });

  // ---- ЕДИНСТВЕННЫЙ message handler (и для группы, и для лички)
  bot.on("message", async (ctx) => {
    // A) support group -> user
    if (isSupportGroup(ctx)) {
      const msg = ctx.message;
      const threadId = msg.message_thread_id;
      if (!threadId) return;
      if (msg.from?.is_bot) return;

      const ok = await isAdminUser(ctx.from.id);
      if (!ok) return;

      const map = await store.getJson(key.threadMap(threadId));
      const userId = map?.userId;
      if (!userId) return;

      try {
        await copyToUser(userId, ctx.chat.id, msg.message_id);
      } catch {}
      return;
    }

    // B) private
    if (!isPrivate(ctx) || !ctx.from) return;

    const uid = ctx.from.id;
    const lang = await getLang(uid);

    // если язык не выбран — НЕ продолжаем логику, а просим выбрать
    if (!lang) {
      // если пользователь писал “описание”, запомним и вернём его в этот шаг после выбора языка
      const flow = await store.getJson(key.flow(uid));
      if (flow?.mode === "AWAIT") {
        await showLangPicker(ctx, { screen: "ASK_ONE", category: flow.category || "other" });
      } else {
        await showLangPicker(ctx, { screen: "MENU" });
      }
      return;
    }

    // если ждём одно сообщение — создаём тикет
    const flow = await store.getJson(key.flow(uid));
    if (flow?.mode === "AWAIT") {
      await store.del(key.flow(uid));

      const category = flow.category || "other";
      const topic = await createTopic(clamp(`Ticket #${uid} — ${displayUser(ctx.from)} — ${category}`));
      const threadId = topic.message_thread_id;

      const tk = { status: "open", userId: uid, threadId, category, lang, createdAt: Date.now() };
      await store.setJson(key.ticket(uid), tk, TTL_TICKET);
      await store.setJson(key.threadMap(threadId), { userId: uid }, TTL_TICKET);

      await sendToTopic(
        threadId,
        `🆕 Новый тикет\n👤 ${displayUser(ctx.from)}\n🧾 #${uid}\n📂 ${category}\n🌐 ${lang}\n\nОтвечайте в ЭТОЙ теме — бот перешлёт пользователю.`,
        kbAdminClose(uid, lang)
      );

      try { await copyToTopic(threadId, ctx.chat.id, ctx.message.message_id); } catch {}
      await ctx.reply(t(lang, "created"), kbTicket(lang));
      return;
    }

    // если тикет открыт — пересылаем
    const tk = await getOpenTicket(uid);
    if (tk) {
      try {
        await copyToTopic(tk.threadId, ctx.chat.id, ctx.message.message_id);
        await ctx.reply(t(lang, "sent"), kbTicket(lang));
      } catch {
        await ctx.reply(t(lang, "sendFail"), kbTicket(lang));
      }
      return;
    }

    // иначе меню
    await ctx.reply(`${t(lang, "menuTitle")}\n${t(lang, "menuIntro")}`, kbMenu(lang));
  });

  bot.catch((err) => {
    console.error("BOT_ERROR", { build: BUILD, err: String(err?.stack || err) });
  });

  return bot;
}

module.exports = { createSupportBot };
