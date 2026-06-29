import { Composer } from "grammy";
import type { Ctx } from "../bot.js";
import { inlineButton, inlineKeyboard } from "../toolkit/index.js";

/**
 * /cancel handler — exits any in-progress flow and returns the user to a
 * clean state. Addresses anti-pattern #19: never tell a user "Reply /cancel"
 * without actually handling /cancel.
 */
const composer = new Composer<Ctx>();

composer.command("cancel", async (ctx) => {
  // Clear ALL flow state
  ctx.session.step = undefined;
  ctx.session.teamSetupStep = undefined;
  ctx.session.teamSetupData = undefined;
  ctx.session.answerQuestionIndex = undefined;
  ctx.session.answerResponses = undefined;
  ctx.session.answerTeamId = undefined;
  ctx.session.historyTeamId = undefined;

  await ctx.reply("Cancelled. Tap /start to begin again, or use the menu below.", {
    reply_markup: inlineKeyboard([
      [inlineButton("⬅️ Back to menu", "menu:main")],
    ]),
  });
});

export default composer;
