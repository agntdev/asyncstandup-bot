import { buildBot } from "./bot.js";
import { setDefaultCommands } from "./toolkit/index.js";
import { startScheduler } from "./lib/scheduler.js";

async function main() {
  const token = process.env.BOT_TOKEN;
  if (!token) {
    console.error("BOT_TOKEN is required");
    process.exit(1);
  }
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
