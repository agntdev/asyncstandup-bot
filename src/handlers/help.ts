import { Composer } from "grammy";
import type { Ctx } from "../bot.js";
import { inlineButton, inlineKeyboard } from "../toolkit/index.js";

const composer = new Composer<Ctx>();

const HELP =
  "ℹ️ I'm your team's async standup bot — no meetings, no interruptions.\n\n" +
  "Here's how it works:\n" +
  "• Each workday, I send you a standup prompt in private\n" +
  "• You reply with what you did, plan to do, and any blockers\n" +
  "• I compile answers into a digest posted to your team channel\n\n" +
  "**Setting up your channel:**\n" +
  "• Go to Manage Team → Share team channel\n" +
  "• Forward any message from your channel to me\n" +
  "• I'll grab the channel info — no need to look up IDs\n\n" +
  "Use the buttons to start a standup, view history, or manage your team.\n" +
  "Everything is reachable by tapping — no commands to remember.";

const backToMenu = inlineKeyboard([[inlineButton("⬅️ Back to menu", "menu:main")]]);

composer.command("help", async (ctx) => {
  await ctx.reply(HELP);
});

composer.callbackQuery("menu:help", async (ctx) => {
  await ctx.answerCallbackQuery();
  try {
    await ctx.editMessageText(HELP, { reply_markup: backToMenu });
  } catch {
    await ctx.reply(HELP, { reply_markup: backToMenu });
  }
});

export default composer;
