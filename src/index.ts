import { buildBot } from "./bot.js";
import { setDefaultCommands } from "./toolkit/index.js";
import { startScheduler } from "./lib/scheduler.js";
import { readFileSync } from "node:fs";

function resolveBotToken(): string {
  const direct = process.env.BOT_TOKEN?.trim();
  if (direct) return direct;
  const file = process.env.BOT_TOKEN_FILE;
  if (file) return readFileSync(file, "utf8").trim();
  throw new Error("BOT_TOKEN or BOT_TOKEN_FILE must be set");
}

async function main() {
  const token = resolveBotToken();
  const bot = await buildBot(token);
  // Publish the "/" command list to Telegram (discoverability). A button-first
  // bot exposes only /start + /help; everything else is reached via menu buttons.
  await setDefaultCommands(bot);
  bot.start();

  // Start the automated standup scheduler (runs every 30 seconds).
  const stopScheduler = startScheduler(bot.api, {
    log: (msg) => console.log(`[scheduler] ${msg}`),
    pollIntervalMs: 30_000,
  });

  // Clean shutdown
  const shutdown = () => {
    stopScheduler();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error("fatal:", err);
  process.exit(1);
});
