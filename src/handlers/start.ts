import { Composer } from "grammy";
import type { Ctx } from "../bot.js";
import { mainMenuKeyboard } from "../toolkit/index.js";
import * as data from "../lib/data.js";
import { createMember } from "../lib/types.js";

// The /start handler renders the bot's MAIN MENU and handles deep-link
// join codes (t.me/<bot>?start=<teamId>).
const composer = new Composer<Ctx>();

const WELCOME = "👋 Hey! I'm your team's async standup bot. Tap a button to get started.";

composer.command("start", async (ctx) => {
  const payload = ctx.match?.trim();
  if (payload) {
    // Deep link: join a team with the invite code from the URL
    const team = await data.getTeam(payload);
    const userId = ctx.from!.id;

    if (team) {
      // Check if already a member
      const existing = await data.getMember(userId);
      if (existing && existing.teamId === team.id) {
        return ctx.reply(
          `You're already in "${team.name}"! Tap below to get started.`,
          { reply_markup: mainMenuKeyboard() },
        );
      }

      const member = createMember({ id: userId, teamId: team.id });
      await data.saveMember(member);
      await data.setUserTeam(userId, team.id);

      if (!team.memberIds.includes(userId)) {
        team.memberIds.push(userId);
        await data.saveTeam(team);
      }

      return ctx.reply(
        `✅ You've joined "${team.name}"!\n\nTap a button to get started.`,
        { reply_markup: mainMenuKeyboard() },
      );
    }

    return ctx.reply(
      `🔗 Couldn't find team "${payload}". Ask your admin for the right code, or create a new team from the Manage Team menu.`,
      { reply_markup: mainMenuKeyboard() },
    );
  }

  await ctx.reply(WELCOME, { reply_markup: mainMenuKeyboard() });
});

// "Back to menu" — re-render the main menu in place from any sub-view.
composer.callbackQuery("menu:main", async (ctx) => {
  await ctx.answerCallbackQuery();
  // Clear any in-progress flows
  ctx.session.step = undefined;
  ctx.session.teamSetupStep = undefined;
  ctx.session.teamSetupData = undefined;
  ctx.session.channelShareTeamId = undefined;
  ctx.session.answerQuestionIndex = undefined;
  ctx.session.answerResponses = undefined;
  ctx.session.answerTeamId = undefined;
  try {
    await ctx.editMessageText(WELCOME, { reply_markup: mainMenuKeyboard() });
  } catch {
    await ctx.reply(WELCOME, { reply_markup: mainMenuKeyboard() });
  }
});

export default composer;