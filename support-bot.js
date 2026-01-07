const TelegramBot = require("node-telegram-bot-api");
const store = require("./store");

function mustInt(name, v) {
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`${name} must be a number`);
  return n;
}

const BOT_TOKEN = process.env.SUPPORT_BOT_TOKEN;
if (!BOT_TOKEN) throw new Error("SUPPORT_BOT_TOKEN is not set");

// IMPORTANT: group id can be undefined at first run (to allow /id + forward method)
const SUPPORT_GROUP_ID_RAW = process.env.SUPPORT_GROUP_ID;
const SUPPORT_GROUP_ID = SUPPORT_GROUP_ID_RAW ? mustInt("SUPPORT_GROUP_ID", SUPPORT_GROUP_ID_RAW) : null;

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

// ---------- helpers ----------
function safeUsername(u) {
  if (!u) return "";
  if (u.username) return `@${u.username}`;
  const name = [u.first_name, u.last_name].filter(Boolean).join(" ").trim();
  return name ? name : "";
}

function ticketKey(userId) {
  return `ticket:${userId}`;
}
function topicKey(topicId) {
  return `topic:${topicId}`;
}
function mapKey(chatId, messageId) {
  return `map:${chatId}:${messageId}`;
}

async function rateLimit(userId) {
  const key = `rl:${userId}`;
  const prev = await store.get(key);
  const now = Date.now();
  if (prev && now - Number(prev) < 2000) return true;
  await store.set(key, String(now));
  return false;
}

function requireSupportGroup() {
  if (!SUPPORT_GROUP_ID) {
    throw new Error("SUPPORT_GROUP_ID is not set yet. Get it via forward/getChat, then set ENV and redeploy.");
  }
}

async function ensureTicket(user) {
  requireSupportGroup();

  const userId = user.id;
  const existing = await store.get(ticketKey(userId));
  if (existing && existing.topicId) return existing.topicId;

  const titleRaw = `u${userId} ${safeUsername(user)}`.trim();
  const title = titleRaw.length > 120 ? titleRaw.slice(0, 120) : titleRaw;

  const created = await bot.createForumTopic(SUPPORT_GROUP_ID, title);
  const topicId = created.message_thread_id;

  await store.set(ticketKey(userId), {
    topicId,
    createdAt: Date.now(),
    status: "open",
    user: {
      id: userId,
      username: user.username || null,
      first_name: user.first_name || null,
      last_name: user.last_name || null
    }
  });

  await store.set(topicKey(topicId), userId);

  const header = await bot.sendMessage(
    SUPPORT_GROUP_ID,
    `🆕 New ticket\nUser: ${safeUsername(user)}\nID: ${userId}`,
    { message_thread_id: topicId }
  );

  await store.set(mapKey(SUPPORT_GROUP_ID, header.message_id), userId);
  return topicId;
}

async function copyUserMessageToTopic(msg, topicId) {
  requireSupportGroup();

  const copied = await bot.copyMessage(SUPPORT_GROUP_ID, msg.chat.id, msg.message_id, {
    message_thread_id: topicId
  });

  const newMessageId = copied.message_id;
  await store.set(mapKey(SUPPORT_GROUP_ID, newMessageId), msg.from.id);
}

// ---------- commands: /start, /new ----------
bot.onText(/^\/start(?:\s+(.+))?$/, async (msg, match) => {
  if (msg.chat.type !== "private") return;

  const param = match && match[1] ? String(match[1]) : "";
  const hint = param ? `\n\nSource: \`${param}\`` : "";

  await bot.sendMessage(
    msg.chat.id,
    "👋 Trade Support\n\nНапиши сюда вопрос — я создам тикет и отправлю в поддержку. Ответ придёт сюда же." + hint,
    { parse_mode: "Markdown" }
  );
});

bot.onText(/^\/new(?:@[\w_]+)?$/, async (msg) => {
  if (msg.chat.type !== "private") return;

  const old = await store.get(ticketKey(msg.from.id));
  if (old?.topicId) {
    await store.del(ticketKey(msg.from.id));
    await store.del(topicKey(old.topicId));
  }

  const topicId = await ensureTicket(msg.from);
  await bot.sendMessage(msg.chat.id, `✅ Создан новый тикет (#${topicId}). Пиши сообщение.`);
});

// ---------- /id (works in private and groups, supports /id@BotName) ----------
bot.onText(/^\/id(?:@[\w_]+)?$/, async (msg) => {
  const thread = msg.message_thread_id ? `\nthread_id = ${msg.message_thread_id}` : "";
  await bot.sendMessage(msg.chat.id, `chat.id = ${msg.chat.id}\nchat.type = ${msg.chat.type}${thread}`);
});

// ---------- forward method to get group id (ONLY in private) ----------
bot.on("message", async (msg) => {
  if (msg.chat.type !== "private") return;
  const fwd = msg.forward_from_chat;
  if (fwd?.id) {
    await bot.sendMessage(msg.chat.id, `forward_from_chat.id = ${fwd.id}`);
  }
});

// ---------- user side: any non-command message in private -> ticket ----------
bot.on("message", async (msg) => {
  if (msg.chat.type !== "private") return;
  if (!msg.from) return;
  if (msg.text && msg.text.startsWith("/")) return;

  if (await rateLimit(msg.from.id)) {
    await bot.sendMessage(msg.chat.id, "⏳ Слишком часто. Подожди пару секунд и отправь снова.");
    return;
  }

  const topicId = await ensureTicket(msg.from);
  await copyUserMessageToTopic(msg, topicId);
});

// ---------- admin side: reply in support group -> send to user ----------
bot.on("message", async (msg) => {
  if (!SUPPORT_GROUP_ID) return;
  if (msg.chat.id !== SUPPORT_GROUP_ID) return;
  if (!msg.from || !isAdmin(msg.from.id)) return;

  // ignore commands
  if (msg.text && msg.text.startsWith("/")) return;

  const replyTo = msg.reply_to_message;
  if (!replyTo) return;

  const userId = await store.get(mapKey(SUPPORT_GROUP_ID, replyTo.message_id));
  if (!userId) return;

  if (msg.text) {
    await bot.sendMessage(userId, `💬 Support:\n\n${msg.text}`);
    return;
  }

  try {
    await bot.copyMessage(userId, SUPPORT_GROUP_ID, msg.message_id);
  } catch (e) {
    await bot.sendMessage(msg.chat.id, "⚠️ Failed to deliver non-text reply.", {
      message_thread_id: msg.message_thread_id
    });
  }
});

// ---------- /reply and /close ----------
bot.onText(/^\/reply(?:@[\w_]+)?\s+(\d+)\s+([\s\S]+)/, async (msg, match) => {
  if (!SUPPORT_GROUP_ID) return;
  if (msg.chat.id !== SUPPORT_GROUP_ID) return;
  if (!msg.from || !isAdmin(msg.from.id)) return;

  const userId = Number(match[1]);
  const text = String(match[2]).trim();
  if (!text) return;

  await bot.sendMessage(userId, `💬 Support:\n\n${text}`);
  await bot.sendMessage(msg.chat.id, "✅ Sent.", { message_thread_id: msg.message_thread_id });
});

bot.onText(/^\/close(?:@[\w_]+)?$/, async (msg) => {
  if (!SUPPORT_GROUP_ID) return;
  if (msg.chat.id !== SUPPORT_GROUP_ID) return;
  if (!msg.from || !isAdmin(msg.from.id)) return;

  const topicId = msg.message_thread_id;
  if (!topicId) {
    await bot.sendMessage(msg.chat.id, "⚠️ Use /close inside a topic.");
    return;
  }

  const userId = await store.get(topicKey(topicId));
  if (userId) {
    await store.del(ticketKey(userId));
    await store.del(topicKey(topicId));
  }

  try {
    await bot.closeForumTopic(SUPPORT_GROUP_ID, topicId);
  } catch (e) {}

  await bot.sendMessage(msg.chat.id, "🧾 Ticket closed.", { message_thread_id: topicId });
});

module.exports = { bot };
