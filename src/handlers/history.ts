import { Composer } from "grammy";
import type { Ctx } from "../bot.js";
import {
  inlineButton,
  inlineKeyboard,
  registerMainMenuItem,
  paginate,
} from "../toolkit/index.js";
import * as data from "../lib/data.js";
import { todayDate } from "../lib/standup.js";

registerMainMenuItem({
  label: "📋 View History",
  data: "history:show",
  order: 20,
});

const BACK_ROW = [inlineButton("⬅️ Back to menu", "menu:main")];

const composer = new Composer<Ctx>();

// ── Show history period picker (button-only; no slash command) ────────────

composer.callbackQuery("history:show", async (ctx) => {
  await ctx.answerCallbackQuery();
  const userId = ctx.from!.id;
  const teamId = await data.getUserTeamId(userId);

  if (!teamId) {
    await ctx.editMessageText(
      "You're not in a team yet. Use Manage Team to set one up."
    );
    return;
  }

  ctx.session.historyTeamId = teamId;

  await ctx.editMessageText(
    "📋 How far back would you like to go?",
    {
      reply_markup: inlineKeyboard([
        [inlineButton("Last 7 days", "history:period:7")],
        [inlineButton("Last 30 days", "history:period:30")],
        [inlineButton("Last 90 days", "history:period:90")],
        [inlineButton("⚠️ Recurring blockers", "history:blockers")],
        BACK_ROW,
      ]),
    },
  );
});

// ── Period selected → show digests ───────────────────────────────────────

composer.callbackQuery(/^history:period:(\d+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const teamId = ctx.session.historyTeamId;
  if (!teamId) {
    await ctx.editMessageText("Session expired. Tap View History again.");
    return;
  }

  const days = parseInt(ctx.match![1], 10);
  // Persist the period so pagination uses the correct range
  ctx.session.historyDays = days;

  const toDate = todayDate();
  const d = new Date(toDate + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() - days);
  const fromDate = d.toISOString().slice(0, 10);

  const entries = await data.getHistoryInRange(teamId, fromDate, toDate);

  if (entries.length === 0) {
    await ctx.editMessageText(
      `No standups recorded in the last ${days} days.\n\nStart one from the menu — digests appear here after they compile.`,
      { reply_markup: inlineKeyboard([BACK_ROW]) },
    );
    return;
  }

  // Paginate: 5 per page
  const page = 0;
  const perPage = 5;
  const { pageItems, totalPages, controls } = paginate(
    entries.map((e) => ({
      text: `📅 ${e.date} — ${e.participants.length} answered, ${e.blockerSummary.startsWith("No blockers") ? "no blockers" : "⚠️ blockers"}`,
      data: `history:detail:${e.date}`,
    })),
    { page, perPage, callbackPrefix: "history:pg" },
  );

  const rows = pageItems.map((it) => [inlineButton(it.text, it.data)]);
  const keyboard = inlineKeyboard([...rows, ...controls.inline_keyboard, BACK_ROW]);

  await ctx.editMessageText(
    `📋 Standups — last ${days} days (${entries.length} total)`,
    { reply_markup: keyboard },
  );
});

// ── History pagination ────────────────────────────────────────────────────

composer.callbackQuery(/^history:pg:(prev|next):(\d+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const teamId = ctx.session.historyTeamId;
  if (!teamId) return;

  const newPage = parseInt(ctx.match![2], 10);
  // Use the persisted period from the original selection (default 90 for back-navigation)
  const days = ctx.session.historyDays ?? 90;

  const toDate = todayDate();
  const d = new Date(toDate + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() - days);
  const fromDate = d.toISOString().slice(0, 10);
  const entries = await data.getHistoryInRange(teamId, fromDate, toDate);

  const perPage = 5;
  const { pageItems, totalPages, controls } = paginate(
    entries.map((e) => ({
      text: `📅 ${e.date} — ${e.participants.length} answered`,
      data: `history:detail:${e.date}`,
    })),
    { page: newPage, perPage, callbackPrefix: "history:pg" },
  );

  const rows = pageItems.map((it) => [inlineButton(it.text, it.data)]);
  const keyboard = inlineKeyboard([...rows, ...controls.inline_keyboard, BACK_ROW]);

  await ctx.editMessageText(
    `📋 Standups — last ${days} days (${entries.length} total)\nPage ${newPage + 1} of ${totalPages}`,
    { reply_markup: keyboard },
  );
});

// ── Detail view ──────────────────────────────────────────────────────────

composer.callbackQuery(/^history:detail:(.+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const teamId = ctx.session.historyTeamId;
  if (!teamId) return;

  const date = ctx.match![1];
  const entry = await data.getHistoryEntry(teamId, date);
  if (!entry) {
    await ctx.editMessageText("Couldn't find that standup. It may have been removed.", {
      reply_markup: inlineKeyboard([
        [inlineButton("⬅️ Back to history", "history:period:90")],
        BACK_ROW,
      ]),
    });
    return;
  }

  const text = `${entry.digestText}\n\n─── ⚠️ Blocker Summary ───\n${entry.blockerSummary}`;

  // Truncate if too long for one message
  const truncated = text.length > 4000 ? text.slice(0, 3997) + "..." : text;

  const backDays = ctx.session.historyDays ?? 90;

  await ctx.editMessageText(truncated, {
    reply_markup: inlineKeyboard([
      [inlineButton("⬅️ Back to list", `history:period:${backDays}`)],
      BACK_ROW,
    ]),
  });
});

// ── Recurring blockers report ────────────────────────────────────────────

composer.callbackQuery("history:blockers", async (ctx) => {
  await ctx.answerCallbackQuery();
  const teamId = ctx.session.historyTeamId;
  if (!teamId) {
    await ctx.editMessageText("Session expired. Tap View History again.");
    return;
  }

  const toDate = todayDate();
  const d = new Date(toDate + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() - 90);
  const fromDate = d.toISOString().slice(0, 10);

  const entries = await data.getHistoryInRange(teamId, fromDate, toDate);

  // Collect blocker keywords across all entries
  const keywordCounts = new Map<string, number>();
  const team = await data.getTeam(teamId);
  const blockerKws = team?.blockerKeywords ?? [];

  for (const entry of entries) {
    if (entry.blockerSummary === "No blockers reported today.") continue;
    for (const kw of blockerKws) {
      const count = (
        entry.blockerSummary.toLowerCase().match(
          new RegExp(kw.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi"),
        ) ?? []
      ).length;
      if (count > 0) {
        keywordCounts.set(kw, (keywordCounts.get(kw) ?? 0) + count);
      }
    }
  }

  // Also count how many entries have blockers
  const entriesWithBlockers = entries.filter(
    (e) => e.blockerSummary !== "No blockers reported today.",
  );

  const sorted = [...keywordCounts.entries()].sort((a, b) => b[1] - a[1]);

  let text = "⚠️ Recurring Blocker Report — last 90 days\n\n";
  if (entriesWithBlockers.length === 0) {
    text += "No blockers reported in this period. Great job! 🎉";
  } else {
    text += `${entriesWithBlockers.length} of ${entries.length} standups had blockers.\n\n`;
    text += "Top keywords:\n";
    for (const [kw, count] of sorted.slice(0, 10)) {
      text += `▸ ${kw}: ${count} occurrence(s)\n`;
    }
  }

  await ctx.editMessageText(text, {
    reply_markup: inlineKeyboard([
      [inlineButton("⬅️ Back to history", "history:show")],
      BACK_ROW,
    ]),
  });
});

export default composer;