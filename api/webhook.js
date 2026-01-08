// api/webhook.js
import { getBot } from "../support-bot.js";

const bot = getBot();

function buildId() {
  return (
    process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 7) ||
    process.env.VERCEL_DEPLOYMENT_ID ||
    "dev"
  );
}

export default async function handler(request) {
  // healthcheck в браузере
  if (request.method === "GET") {
    return new Response(`ok ${buildId()}`, { status: 200 });
  }

  if (request.method !== "POST") {
    return new Response("method not allowed", { status: 405 });
  }

  const secretHeader = request.headers.get("x-telegram-bot-api-secret-token") || "";
  const expected = bot.context.webhookSecret || "";

  if (expected && secretHeader !== expected) {
    return new Response("unauthorized", { status: 401 });
  }

  const update = await request.json();
  await bot.handleUpdate(update);

  return new Response("ok", { status: 200 });
}
