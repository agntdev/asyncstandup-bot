import { Composer } from "grammy";
import type { Ctx } from "../bot.js";
import {
  inlineButton,
  inlineKeyboard,
  registerMainMenuItem,
} from "../toolkit/index.js";
import * as data from "../lib/data.js";
import * as standup from "../lib/standup.js";
import { now } from "../lib/clock.js";

registerMainMenuItem({
  label: "🚀 Start Standup",
  data: "standup:init",
  order: 10,
});

const composer = new Composer<Ctx>();

// ── Initiate standup ─────────────────────────────────────────────────────

composer.callbackQuery("standup:init", async (ctx) => {
  await ctx.answerCallbackQuery();
  const userId = ctx.from!.id;
  const teamId = await data.getUserTeamId(userId);

  if (!teamId) {
    await ctx.editMessageText(
      "You're not in a team yet. Use Manage Team to set one up first.",
    );
    return;
  }

  const team = await data.getTeam(teamId);
  if (!team) {
    await ctx.editMessageText("Your team couldn't be found. It may have been removed.");
    return;
  }

  await ctx.editMessageText("☀️ Starting standup...");

  try {
    const result = await standup.triggerStandup(ctx.api, team);
    await ctx.editMessageText(result);
  } catch (err) {
    console.error("standup:init failed:", err);
    await ctx.editMessageText(
      "Something went wrong starting the standup. Try again in a moment.",
    );
  }
});

// ── Answer button (member starts answering) ──────────────────────────────

composer.callbackQuery("standup:answer", async (ctx) => {
  await ctx.answerCallbackQuery();
  const userId = ctx.from!.id;

  // Get the user's team
  const teamId = await data.getUserTeamId(userId);
  if (!teamId) {
    await ctx.reply("You're not in a team yet.");
    return;
  }

  const team = await data.getTeam(teamId);
  if (!team) {
    await ctx.reply("Your team couldn't be found.");
    return;
  }

  // Start the answer flow
  ctx.session.step = "standup:answering";
  ctx.session.answerQuestionIndex = 0;
  ctx.session.answerResponses = {};
  ctx.session.answerTeamId = teamId;

  const prompt = standup.buildQuestionPrompt(team, 0, {});
  await ctx.reply(prompt, {
    reply_markup: { force_reply: true, input_field_placeholder: "Type your answer..." },
  });
});

// ── Skip button ──────────────────────────────────────────────────────────

composer.callbackQuery("standup:skip", async (ctx) => {
  await ctx.answerCallbackQuery();
  const userId = ctx.from!.id;
  const teamId = await data.getUserTeamId(userId);
  if (!teamId) {
    await ctx.reply("You're not in a team yet.");
    return;
  }

  const date = standup.todayDate();
  const run = await data.getRun(teamId, date);
  if (!run) {
    await ctx.reply("There's no active standup today. Your team admin can start one.");
    return;
  }

  const resp = run.responses.find((r) => r.userId === userId);
  if (resp) {
    resp.status = "skipped";
    resp.respondedAt = now().toISOString();
  }
  await data.saveRun(run);

  // MEDIUM FIX: After a skip, check if all members have now responded. If the
  // last pending member taps "Skip", the digest should compile immediately
  // (matching the blueprint's "or when all respond" contract) rather than
  // waiting until the scheduler cutoff fires — potentially hours later.
  const allDone = run.responses.every((r) => r.status !== "pending");
  if (allDone && run.responses.length > 0) {
    const team = await data.getTeam(teamId);
    if (team) {
      try {
        await standup.compileAndPostDigest(ctx.api, team);
      } catch (err) {
        console.error("Failed to compile digest after skip:", err);
      }
    }
  }

  await ctx.reply("👍 Got it — you're marked as skipped for today's standup.");
});

// ── Handle text answers during the answer flow ───────────────────────────

composer.on("message:text", async (ctx, next) => {
  if (ctx.session.step !== "standup:answering") return next();
  if (!ctx.message?.text) return next();

  const teamId = ctx.session.answerTeamId;
  if (!teamId) {
    ctx.session.step = undefined;
    await ctx.reply("Your answer session expired. Start again from the menu.");
    return;
  }

  const team = await data.getTeam(teamId);
  if (!team) {
    ctx.session.step = undefined;
    await ctx.reply("Your team couldn't be found.");
    return;
  }

  const idx = ctx.session.answerQuestionIndex ?? 0;
  const answer = ctx.message.text.trim();
  const responses = ctx.session.answerResponses ?? {};

  responses[String(idx)] = answer;
  ctx.session.answerResponses = responses;

  const nextIdx = idx + 1;
  if (nextIdx >= team.questions.length) {
    // All questions answered — save response
    const userId = ctx.from!.id;
    const date = standup.todayDate();
    const run = await data.getRun(teamId, date);

    let blockerDetected = false;
    for (const key of Object.keys(responses)) {
      if (standup.detectBlocker(responses[key], team.blockerKeywords)) {
        blockerDetected = true;
        break;
      }
    }

    if (run) {
      const resp = run.responses.find((r) => r.userId === userId);
      if (resp) {
        resp.status = "answered";
        resp.answers = { ...responses };
        resp.flagsBlockers = blockerDetected;
        resp.respondedAt = now().toISOString();
      }
      await data.saveRun(run);

      // If all have responded, compile digest
      const allDone = run.responses.every(
        (r) => r.status !== "pending",
      );
      if (allDone) {
        await standup.compileAndPostDigest(ctx.api, team);
      }
    } else {
      // No active run for today — create one now so these answers are saved.
      // This can happen when a member starts answering right at midnight or
      // when a manual standup was never triggered.
      const newRun = await data.createTodayRun(teamId);
      const resp = newRun.responses.find((r) => r.userId === userId);
      if (resp) {
        resp.status = "answered";
        resp.answers = { ...responses };
        resp.flagsBlockers = blockerDetected;
        resp.respondedAt = now().toISOString();
      }
      await data.saveRun(newRun);

      // If all active members have now responded, compile the digest
      // immediately (matching the "or when all respond" contract from the
      // blueprint), even though this run was just created.
      const allDone = newRun.responses.every(
        (r) => r.status !== "pending",
      );
      if (allDone) {
        await standup.compileAndPostDigest(ctx.api, team);
      }
    }

    ctx.session.step = undefined;
    ctx.session.answerQuestionIndex = undefined;
    ctx.session.answerResponses = undefined;
    ctx.session.answerTeamId = undefined;

    let reply = "✅ All done! Your standup answers are recorded.";
    if (blockerDetected) {
      reply += "\n\n⚠️ Blockers were detected in your responses — they'll be highlighted in the digest.";
    }
    await ctx.reply(reply);
  } else {
    // Move to next question
    ctx.session.answerQuestionIndex = nextIdx;
    const prompt = standup.buildQuestionPrompt(team, nextIdx, responses);
    await ctx.reply(prompt, {
      reply_markup: { force_reply: true, input_field_placeholder: "Type your answer..." },
    });
  }
});

// ── Handle non-text messages during answer flow ──────────────────────────
// If a user sends a photo, sticker, voice note, etc. while answering, don't
// let them fall through to the global "Sorry, I didn't understand" fallback —
// instead, guide them back to typing their answer.

composer.on("message", async (ctx, next) => {
  if (ctx.session.step !== "standup:answering") return next();
  // Text messages are handled by the message:text handler above.
  if (ctx.message?.text) return next();

  await ctx.reply(
    "I'm waiting for your text answer. Tap /cancel if you want to stop, or type your response below.",
    {
      reply_markup: { force_reply: true, input_field_placeholder: "Type your answer..." },
    },
  );
});

export default composer;