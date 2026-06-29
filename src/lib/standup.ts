/**
 * Standup engine — core business logic for running a daily standup.
 * Handles prompting, response tracking, nudge logic, and digest compilation.
 *
 * All durable I/O goes through src/lib/data.ts. This module is pure logic
 * (plus data calls) so it can be unit-tested with a faked store.
 */

import type { Api, RawApi } from "grammy";
import type { StandupRun, Member, Team, HistoryEntry } from "./types.js";
import { createHistoryEntry } from "./types.js";
import * as data from "./data.js";
import { now } from "./clock.js";
import { inlineButton, inlineKeyboard } from "../toolkit/ui/keyboard.js";

// ── Helpers ──────────────────────────────────────────────────────────────

function formatDate(date: string): string {
  const d = new Date(date + "T00:00:00Z");
  return d.toLocaleDateString("en-US", {
    weekday: "short",
    year: "numeric",
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}

export function todayDate(): string {
  return now().toISOString().slice(0, 10);
}

// ── Build prompt message text ────────────────────────────────────────────

export function buildPromptMessage(team: Team): string {
  const lines = [
    `☀️ Good morning! Here's your standup for ${formatDate(todayDate())}.\n`,
    "Reply to each question below:",
  ];
  team.questions.forEach((q, i) => {
    lines.push(`\n${i + 1}. ${q}`);
  });
  lines.push("\nTap a button to respond or skip today.");
  return lines.join("");
}

// ── Build prompt keyboard ────────────────────────────────────────────────

export function promptKeyboard() {
  return inlineKeyboard([
    [
      inlineButton("📝 Answer", "standup:answer"),
      inlineButton("⏭️ Skip today", "standup:skip"),
    ],
  ]);
}

// ── Build answer input prompt for a specific question ────────────────────

export function buildQuestionPrompt(
  team: Team,
  questionIndex: number,
  answers: Record<string, string>,
): string {
  const q = team.questions[questionIndex];
  if (!q) return "All done!";

  const lines: string[] = [];
  const keys = Object.keys(answers);
  if (keys.length > 0) {
    for (let i = 0; i < questionIndex; i++) {
      if (answers[String(i)]) {
        lines.push(`✅ ${i + 1}. ${team.questions[i]}`);
      }
    }
  }
  lines.push(
    `📋 Question ${questionIndex + 1} of ${team.questions.length}`,
  );
  lines.push(`\n${q}`);
  lines.push("\nType your answer below:");

  return lines.join("\n");
}

// ── Detect blockers from text ────────────────────────────────────────────

export function detectBlocker(text: string, keywords: string[]): boolean {
  const lower = text.toLowerCase();
  return keywords.some((kw) => lower.includes(kw.toLowerCase()));
}

// ── Compile digest ───────────────────────────────────────────────────────

export function compileDigest(
  team: Team,
  run: StandupRun,
  members: Member[],
): { digestText: string; blockerSummary: string } {
  const memberMap = new Map(members.map((m) => [m.id, m]));
  const answered = run.responses.filter((r) => r.status === "answered");
  const skipped = run.responses.filter((r) => r.status === "skipped");
  const pending = run.responses.filter((r) => r.status === "pending");
  const off = run.responses.filter((r) => r.status === "off");

  const lines: string[] = [];
  lines.push(`📊 Standup Digest — ${formatDate(run.date)}`);
  lines.push(`\nTeam: ${team.name}`);

  const totalActive = answered.length + skipped.length + pending.length;
  lines.push(
    `\n${answered.length}/${totalActive} responded · ${skipped.length} skipped · ${pending.length} pending`,
  );

  if (off.length > 0) {
    lines[lines.length - 1] += ` · ${off.length} unavailable`;
  }

  if (answered.length > 0) {
    lines.push("\n─── Responses ───");
    for (const r of answered) {
      const m = memberMap.get(r.userId);
      const name = m ? `Member #${m.id}` : `User ${r.userId}`;
      lines.push(`\n▸ ${name}:`);
      const questions = team.questions;
      for (let i = 0; i < questions.length; i++) {
        const a = r.answers[String(i)];
        if (a) {
          lines.push(`  ${i + 1}. ${a}`);
        }
      }
      if (r.flagsBlockers) {
        lines.push(`  ⚠️ Flagged blockers`);
      }
    }
  }

  if (skipped.length > 0) {
    lines.push("\n─── Skipped today ───");
    for (const r of skipped) {
      const m = memberMap.get(r.userId);
      lines.push(`▸ ${m ? `Member #${m.id}` : `User ${r.userId}`}`);
    }
  }

  if (pending.length > 0) {
    lines.push("\n─── No response ───");
    for (const r of pending) {
      const m = memberMap.get(r.userId);
      lines.push(`▸ ${m ? `Member #${m.id}` : `User ${r.userId}`}`);
    }
  }

  if (off.length > 0) {
    lines.push("\n─── Unavailable ───");
    for (const r of off) {
      const m = memberMap.get(r.userId);
      lines.push(`▸ ${m ? `Member #${m.id}` : `User ${r.userId}`} (couldn't reach — blocked or never started)`);
    }
  }

  const blockerSummary = compileBlockerSummary(run, team, memberMap);

  return { digestText: lines.join("\n"), blockerSummary };
}

function compileBlockerSummary(
  run: StandupRun,
  team: Team,
  memberMap: Map<number, Member>,
): string {
  const blockerLines: string[] = [];

  for (const r of run.responses) {
    if (r.status !== "answered") continue;
    const m = memberMap.get(r.userId);
    const name = m ? `Member #${m.id}` : `User ${r.userId}`;

    for (let i = 0; i < team.questions.length; i++) {
      const a = r.answers[String(i)];
      if (a && detectBlocker(a, team.blockerKeywords)) {
        blockerLines.push(`▸ ${name}: "${a.slice(0, 120)}"`);
        break;
      }
    }

    if (
      r.flagsBlockers &&
      !blockerLines.some((l) => l.startsWith(`▸ ${name}`))
    ) {
      blockerLines.push(`▸ ${name}: flagged blockers (no details yet)`);
    }
  }

  if (blockerLines.length === 0) {
    return "No blockers reported today.";
  }
  return blockerLines.join("\n");
}

// ── Nudge non-responders ─────────────────────────────────────────────────

export async function sendNudges(
  api: Api<RawApi>,
  team: Team,
  run: StandupRun,
  members: Member[],
): Promise<void> {
  const toNudge = run.responses.filter(
    (r) => r.status === "pending" && !run.nudgedUserIds.includes(r.userId),
  );

  for (const r of toNudge) {
    const member = members.find((m) => m.id === r.userId);
    if (!member) continue;

    try {
      await api.sendMessage(
        member.id,
        `⏰ Quick reminder — your standup for ${team.name} is still waiting. Tap below to answer or skip.`,
        { reply_markup: promptKeyboard() },
      );
      run.nudgedUserIds.push(r.userId);
    } catch (err) {
      const e = err as { error_code?: number };
      if (e.error_code === 403) continue;
      console.error(`Failed to nudge user ${r.userId}:`, err);
    }
  }

  await data.saveRun(run);
}

// ── Compile and post digest to channel ───────────────────────────────────

export async function compileAndPostDigest(
  api: Api<RawApi>,
  team: Team,
): Promise<string | null> {
  const date = todayDate();
  const run = await data.getRun(team.id, date);
  if (!run || run.status === "compiled") return run?.digestContent ?? null;

  const members = await data.getTeamMembers(team.id);
  const { digestText, blockerSummary } = compileDigest(team, run, members);

  run.status = "compiled";
  run.digestContent = digestText;
  run.blockerSummary = blockerSummary;
  await data.saveRun(run);

  let channelMessage = digestText;
  if (blockerSummary && blockerSummary !== "No blockers reported today.") {
    channelMessage += `\n\n─── ⚠️ Blocker Report ───\n${blockerSummary}`;
  }

  try {
    await api.sendMessage(team.channelId, channelMessage);
  } catch (err) {
    console.error(
      `Failed to post digest to channel ${team.channelId}:`,
      err,
    );
    return digestText;
  }

  const historyEntry = createHistoryEntry(run, digestText, blockerSummary);
  await data.saveHistoryEntry(historyEntry);
  await data.addHistoryDay(team.id, date);

  return digestText;
}

// ── Prompt a single member ───────────────────────────────────────────────

/**
 * Send a standup prompt to ONE member. Handles 403 (user never started bot /
 * blocked) gracefully by marking the response as "off". Creates the daily run
 * on first call.
 *
 * Returns true if the prompt was sent successfully.
 */
export async function promptMember(
  api: Api<RawApi>,
  team: Team,
  member: Member,
): Promise<boolean> {
  const date = todayDate();
  let run = await data.getRun(team.id, date);
  if (!run) {
    run = await data.createTodayRun(team.id);
  }

  try {
    await api.sendMessage(member.id, buildPromptMessage(team), {
      reply_markup: promptKeyboard(),
    });
    // Mark as prompted so the scheduler doesn't re-prompt on the next tick
    if (!run.promptedUserIds.includes(member.id)) {
      run.promptedUserIds.push(member.id);
    }
    await data.saveRun(run);
    return true;
  } catch (err) {
    const e = err as { error_code?: number };
    if (e.error_code === 403) {
      const resp = run.responses.find((r) => r.userId === member.id);
      if (resp) resp.status = "off";
      await data.saveRun(run);
    } else {
      console.error(`Failed to prompt user ${member.id}:`, err);
    }
    return false;
  }
}

// ── Manual standup trigger (admin/test) ──────────────────────────────────

export async function triggerStandup(
  api: Api<RawApi>,
  team: Team,
): Promise<string> {
  const run = await data.createTodayRun(team.id);
  const activeMembers = await data.getActiveMembers(team.id);

  let sent = 0;
  for (const member of activeMembers) {
    const ok = await promptMember(api, team, member);
    if (ok) sent++;
  }

  await data.saveRun(run);

  const names = activeMembers.map((m) => `Member #${m.id}`);

  return (
    `☀️ Standup started for ${team.name}!\n\n` +
    `Sent prompts to ${sent} member(s): ${names.join(", ")}\n` +
    `The digest will compile once everyone responds or at the cutoff.`
  );
}