// support-bot.js
const { Telegraf, Markup } = require("telegraf");
const { createStore } = require("./store");

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

function buildUserMenu() {
  return Markup.inlineKeyboard([
    [Markup.button.callback("🆘 Создать обращение", "u:open")],
    [Markup.button.callback("📌 FAQ", "u:faq"), Markup.button.callback("ℹ️ Статус", "u:status")],
    [Markup.button.callback("✉️ Контакты", "u:contacts")]
  ]);
}

function buildCategoryMenu() {
  return Markup.inlineKeyboard([
    [Markup.button.callback("🐞 Баг / Ошибка", "u:cat:bug")],
    [Markup.button.callback("💳 Оплата", "u:cat:pay")],
    [Markup.button.callback("🤝 Партнёрство", "u:cat:biz")],
    [Markup.button.callback("❓ Другое", "u:cat:other")],
    [Markup.button.callback("⬅️ Назад", "u:back")]
  ]);
}

function buildTicketActionsForUser() {
  return Markup.inlineKeyboard([
    [Markup.button.callback("✅ Закрыть обращение", "u:close")],
    [Markup.button.callback("⬅️ В меню", "u:back")]
  ]);
}

function buildTicketActionsForAdmins(userId) {
  return Markup.inlineKeyboard([
    [Markup.button.callback("✅ Закрыть тикет", `a:close:${userId}`)]
  ]);
}

function createSupportBot() {
  const token = process.env.SUPPORT_BOT_TOKEN;
  if (!token) throw new Error("SUPPORT_BOT_TOKEN is missing");

  const SUPPORT_CHAT_ID = normChatId(process.env.SUPPORT_GROUP_ID);
  const ADMIN_IDS = parseAdminIds(process.env.ADMIN_USERS_IDS);

  const store = createStore();
  const bot = new Telegraf(token);

  // ---- helpers
  const keyState = (uid) => `state:user:${uid}`;
  const keyTicketByUser = (uid) => `ticket:user:${uid}`;
  const keyUserByThread = (threadId) => `ticket:thread:${SUPPORT_CHAT_ID}:${threadId}`;
  const keyDedup = (updateId) => `dedup:update:${updateId}`;

  async function getOpenTicket(uid) {
    const t = await store.getJson(keyTicketByUser(uid));
    if (!t || t.status !== "open") return null;
    return t;
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

  async function closeTicketEverywhere({ userId, closedBy, threadId }) {
    // mark closed + clean mappings
    const ticket = await store.getJson(keyTicketByUser(userId));
    if (ticket && ticket.status === "open") {
      ticket.status = "closed";
      ticket.closedBy = closedBy;
      ticket.closedAt = Date.now();
      await store.setJson(keyTicketByUser(userId), ticket, 60 * 60 * 24 * 7); // keep 7d as history
    } else {
      // still ensure keys removed
      await store.del(keyTicketByUser(userId));
    }

    if (threadId) {
      await store.del(keyUserByThread(threadId));
      // close forum topic (best-effort)
      try {
        await bot.telegram.closeForumTopic(SUPPORT_CHAT_ID, threadId);
      } catch (_) {}
      // notify admins in thread (best-effort)
      try {
        await bot.telegram.sendMessage(
          SUPPORT_CHAT_ID,
          `✅ Тикет закрыт (${closedBy}).`,
          { message_thread_id: threadId }
        );
      } catch (_) {}
    }

    // notify user (best-effort)
    try {
      await bot.telegram.sendMessage(
        userId,
        "✅ Обращение закрыто. Если нужно — создайте новое через меню.",
        buildUserMenu()
      );
    } catch (_) {}
  }

  async function ensurePrivateMenu(ctx) {
    return await ctx.reply(
      "Меню поддержки — кнопками ниже.",
      buildUserMenu()
    );
  }

  function isPrivate(ctx) {
    return ctx.chat && ctx.chat.type === "private";
  }

  function isSupportGroup(ctx) {
    return ctx.chat && (ctx.chat.id === SUPPORT_CHAT_ID);
  }

  function isAdminUserId(userId) {
    return ADMIN_IDS.has(Number(userId));
  }

  // ---- global catch
  bot.catch((err, ctx) => {
    console.error("BOT_ERROR", {
      err: String(err?.stack || err),
      update: ctx?.update
    });
  });

  // ---- dedup updates (avoid double-processing on Telegram retries)
  bot.use(async (ctx, next) => {
    const updateId = ctx.update && ctx.update.update_id;
    if (!updateId) return next();
    const first = await store.setOnce(keyDedup(updateId), "1", 120);
    if (!first) return; // skip duplicate
    return next();
  });

  // ---- entrypoints (no “командный UX”, но /start мы обрабатываем)
  bot.start(async (ctx) => {
    if (!isPrivate(ctx)) return;
    await clearState(ctx.from.id);
    await ctx.reply(
      "Привет! Это поддержка Trader продуктов.\n\nВыберите действие:",
      buildUserMenu()
    );
  });

  // Any private message -> route by state/ticket, else show menu
  bot.on("message", async (ctx) => {
    if (!ctx.from) return;

    // 1) Messages from support group thread (admin replies) handled below in separate block
    if (isSupportGroup(ctx) && ctx.message && ctx.message.message_thread_id) {
      return; // let group handler take it
    }

    // 2) Only private chat for user flow
    if (!isPrivate(ctx)) return;

    const userId = ctx.from.id;

    // If user has open ticket -> forward to thread
    const openTicket = await getOpenTicket(userId);
    if (openTicket) {
      const threadId = openTicket.threadId;

      // forward/copy message into support thread
      try {
        const u = ctx.from;
        const header = `👤 ${displayUser(u)}\n🧾 Ticket: #${userId}\n📂 ${openTicket.category || "—"}`;

        if (ctx.message.text) {
          await bot.telegram.sendMessage(
            SUPPORT_CHAT_ID,
            `${header}\n\n${ctx.message.text}`,
            { message_thread_id: threadId }
          );
        } else {
          // copy attachment
          await bot.telegram.copyMessage(
            SUPPORT_CHAT_ID,
            ctx.chat.id,
            ctx.message.message_id,
            { message_thread_id: threadId }
          );
          await bot.telegram.sendMessage(
            SUPPORT_CHAT_ID,
            `${header}\n\n(вложение)`,
            { message_thread_id: threadId }
          );
        }

        await ctx.reply("✅ Отправлено в поддержку.", buildTicketActionsForUser());
      } catch (e) {
        console.error("FORWARD_TO_SUPPORT_FAILED", e);
        await ctx.reply("⚠️ Не удалось отправить. Попробуйте ещё раз.", buildTicketActionsForUser());
      }
      return;
    }

    // If waiting for description -> create ticket
    const state = await getState(userId);
    if (state && state.mode === "AWAITING_DESCRIPTION") {
      const category = state.category || "other";
      await clearState(userId);

      // Create topic in support group
      let topic;
      try {
        const topicName = clampTopicName(`Ticket #${userId} — ${displayUser(ctx.from)} — ${category}`);
        topic = await bot.telegram.createForumTopic(SUPPORT_CHAT_ID, topicName);
      } catch (e) {
        console.error("CREATE_TOPIC_FAILED", e);
        await ctx.reply("⚠️ Не смог создать тему в support-группе. Проверьте: Topics включены, бот admin, can_manage_topics.", buildUserMenu());
        return;
      }

      const threadId = topic.message_thread_id;

      // Save mappings
      const ticketObj = {
        status: "open",
        userId,
        threadId,
        category,
        createdAt: Date.now()
      };
      await store.setJson(keyTicketByUser(userId), ticketObj, 60 * 60 * 24 * 14); // 14d
      await store.setJson(keyUserByThread(threadId), { userId }, 60 * 60 * 24 * 14);

      // Notify admins in thread
      try {
        const u = ctx.from;
        await bot.telegram.sendMessage(
          SUPPORT_CHAT_ID,
          `🆕 Новый тикет\n👤 ${displayUser(u)}\n🧾 Ticket: #${userId}\n📂 ${category}\n\nДальше отвечайте в ЭТОЙ теме — бот перешлёт пользователю.`,
          { message_thread_id: threadId, ...buildTicketActionsForAdmins(userId) }
        );
      } catch (e) {
        console.error("ADMIN_NOTIFY_FAILED", e);
      }

      // Send first user message into thread
      try {
        if (ctx.message.text) {
          await bot.telegram.sendMessage(
            SUPPORT_CHAT_ID,
            `👤 Сообщение пользователя:\n\n${ctx.message.text}`,
            { message_thread_id: threadId }
          );
        } else {
          await bot.telegram.copyMessage(
            SUPPORT_CHAT_ID,
            ctx.chat.id,
            ctx.message.message_id,
            { message_thread_id: threadId }
          );
        }
      } catch (e) {
        console.error("FIRST_MESSAGE_TO_THREAD_FAILED", e);
      }

      await ctx.reply(
        "✅ Обращение создано. Пишите сюда — я буду пересылать в поддержку.\n\nЕсли вопрос решён — закройте обращение кнопкой.",
        buildTicketActionsForUser()
      );
      return;
    }

    // Otherwise: show menu (no commands)
    await ensurePrivateMenu(ctx);
  });

  // ---- callback buttons (user)
  bot.action("u:back", async (ctx) => {
    await ctx.answerCbQuery().catch(() => {});
    if (!isPrivate(ctx)) return;
    await clearState(ctx.from.id);
    await ctx.editMessageText("Меню поддержки:", buildUserMenu()).catch(async () => {
      await ctx.reply("Меню поддержки:", buildUserMenu());
    });
  });

  bot.action("u:open", async (ctx) => {
    await ctx.answerCbQuery().catch(() => {});
    if (!isPrivate(ctx)) return;

    const userId = ctx.from.id;
    const openTicket = await getOpenTicket(userId);
    if (openTicket) {
      await ctx.reply("У вас уже есть открытое обращение. Просто пишите сообщением — я пересылаю в поддержку.", buildTicketActionsForUser());
      return;
    }

    await ctx.editMessageText("Выберите категорию:", buildCategoryMenu()).catch(async () => {
      await ctx.reply("Выберите категорию:", buildCategoryMenu());
    });
  });

  bot.action(/^u:cat:(.+)$/, async (ctx) => {
    await ctx.answerCbQuery().catch(() => {});
    if (!isPrivate(ctx)) return;

    const cat = ctx.match[1];
    const userId = ctx.from.id;

    const openTicket = await getOpenTicket(userId);
    if (openTicket) {
      await ctx.reply("У вас уже есть открытое обращение. Пишите сообщением — я пересылаю в поддержку.", buildTicketActionsForUser());
      return;
    }

    await setState(userId, { mode: "AWAITING_DESCRIPTION", category: cat }, 600);

    await ctx.editMessageText(
      "Ок. Теперь отправьте ОДНО сообщение с описанием проблемы.\nМожно текст/фото/файл.",
      Markup.inlineKeyboard([[Markup.button.callback("⬅️ Отмена", "u:back")]])
    ).catch(async () => {
      await ctx.reply(
        "Теперь отправьте ОДНО сообщение с описанием проблемы.\nМожно текст/фото/файл.",
        Markup.inlineKeyboard([[Markup.button.callback("⬅️ Отмена", "u:back")]])
      );
    });
  });

  bot.action("u:faq", async (ctx) => {
    await ctx.answerCbQuery().catch(() => {});
    if (!isPrivate(ctx)) return;

    const text =
      "📌 FAQ\n\n" +
      "• Как быстро отвечают? Обычно в течение дня.\n" +
      "• Что писать? Конкретно: что делали, что ожидали, что получили.\n" +
      "• Скрины/логи приветствуются.\n\n" +
      "Нажмите «Создать обращение», если нужна помощь.";
    await ctx.editMessageText(text, Markup.inlineKeyboard([[Markup.button.callback("⬅️ В меню", "u:back")]])).catch(async () => {
      await ctx.reply(text, Markup.inlineKeyboard([[Markup.button.callback("⬅️ В меню", "u:back")]]));
    });
  });

  bot.action("u:contacts", async (ctx) => {
    await ctx.answerCbQuery().catch(() => {});
    if (!isPrivate(ctx)) return;

    const text =
      "✉️ Контакты\n\n" +
      "Если вопрос срочный — создайте обращение, поддержка увидит его в теме.\n" +
      "Если нужен другой канал — добавьте сюда нужные контакты (почта/чат) и я вставлю.";
    await ctx.editMessageText(text, Markup.inlineKeyboard([[Markup.button.callback("⬅️ В меню", "u:back")]])).catch(async () => {
      await ctx.reply(text, Markup.inlineKeyboard([[Markup.button.callback("⬅️ В меню", "u:back")]]));
    });
  });

  bot.action("u:status", async (ctx) => {
    await ctx.answerCbQuery().catch(() => {});
    if (!isPrivate(ctx)) return;

    const t = await store.getJson(keyTicketByUser(ctx.from.id));
    const text = t && t.status === "open"
      ? `ℹ️ Статус: ОТКРЫТО\nКатегория: ${t.category || "—"}`
      : "ℹ️ Открытых обращений нет.";
    await ctx.editMessageText(text, Markup.inlineKeyboard([[Markup.button.callback("⬅️ В меню", "u:back")]])).catch(async () => {
      await ctx.reply(text, Markup.inlineKeyboard([[Markup.button.callback("⬅️ В меню", "u:back")]]));
    });
  });

  bot.action("u:close", async (ctx) => {
    await ctx.answerCbQuery().catch(() => {});
    if (!isPrivate(ctx)) return;

    const userId = ctx.from.id;
    const t = await getOpenTicket(userId);
    if (!t) {
      await ctx.reply("Открытого обращения нет.", buildUserMenu());
      return;
    }
    await closeTicketEverywhere({ userId, closedBy: "user", threadId: t.threadId });
  });

  // ---- callback buttons (admin)
  bot.action(/^a:close:(\d+)$/, async (ctx) => {
    await ctx.answerCbQuery().catch(() => {});
    if (!isSupportGroup(ctx)) return;

    const adminId = ctx.from?.id;
    if (!isAdminUserId(adminId)) {
      // если хочешь — расширим проверку до "любой админ группы" (с кэшем)
      return;
    }

    const userId = Number(ctx.match[1]);
    const threadId = ctx.update?.callback_query?.message?.message_thread_id;

    if (!userId || !threadId) return;
    await closeTicketEverywhere({ userId, closedBy: "admin", threadId });
  });

  // ---- group thread handler: forward admin replies to user
  bot.on("message", async (ctx) => {
    if (!ctx.from || !ctx.message) return;
    if (!isSupportGroup(ctx)) return;

    // ignore messages outside topics
    const threadId = ctx.message.message_thread_id;
    if (!threadId) return;

    // ignore bot messages
    if (ctx.from.is_bot) return;

    // only admins’ messages -> user
    if (!isAdminUserId(ctx.from.id)) return;

    const mapping = await store.getJson(keyUserByThread(threadId));
    const userId = mapping && mapping.userId;
    if (!userId) return;

    try {
      if (ctx.message.text) {
        await bot.telegram.sendMessage(userId, `🧑‍💻 Поддержка:\n\n${ctx.message.text}`, buildTicketActionsForUser());
      } else {
        await bot.telegram.copyMessage(userId, ctx.chat.id, ctx.message.message_id);
        await bot.telegram.sendMessage(userId, "🧑‍💻 Поддержка отправила вложение.", buildTicketActionsForUser());
      }
    } catch (e) {
      console.error("FORWARD_TO_USER_FAILED", e);
    }
  });

  return bot;
}

module.exports = { createSupportBot };
