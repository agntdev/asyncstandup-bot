/**
 * Standup scheduler — automated daily trigger engine. Runs every poll
 * interval, checks each team's schedule + member time zones, and fires standup
 * prompts / nudges / cutoff enforcement automatically.
 *
 * ALL time checks route through `now()` so tests can drive the scheduler
 * deterministically via setClock().
 */
import type { Api, RawApi } from "grammy";
import * as data from "./data.js";
import { now } from "./clock.js";
import * as standup from "./standup.js";
import { isPastLocalTime, getUtcOffsetMinutes } from "./timezone.js";
import type { Member, Team } from "./types.js";

type Logger = (msg: string) => void;

export interface SchedulerOpts {
  /** Poll interval in milliseconds. Default 30_000 (30 seconds). */
  pollIntervalMs?: number;
  /** Logger for scheduler events. Defaults to silent. */
  log?: Logger;
}

/**
 * Start the standup scheduler. Runs `pollIntervalMs` on a setInterval, checking
 * each team's schedule and firing standup-related actions as needed.
 *
 * Returns a stop function (clearInterval). Call it before process exit / in
 * tests.
 */
export function startScheduler(
  api: Api<RawApi>,
  opts: SchedulerOpts = {},
): () => void {
  const interval = opts.pollIntervalMs ?? 30_000;
  const log: Logger = opts.log ?? (() => {});

  const timer = setInterval(async () => {
    try {
      await tick(api, log);
    } catch (err) {
      log(`Scheduler tick error: ${err}`);
    }
  }, interval);

  log(`Scheduler started (poll every ${interval}ms)`);
  return () => clearInterval(timer);
}

/**
 * One scheduler tick. Checks every team and takes action:
 *  1. Prompt time arrived in member's local timezone → send prompt to that
 *     member (creates the daily run on first prompt per team)
 *  2. Cutoff time elapsed since the run was created → compile + post digest
 *  3. Nudge window open → send nudges to non-responders
 *
 * Idempotent — safe to call repeatedly at any cadence.
 */
export async function tick(
  api: Api<RawApi>,
  log: Logger,
): Promise<void> {
  const teamIds = await data.getAllTeamIds();
  if (teamIds.length === 0) return;

  const n = now(); // single consistent clock read for the entire tick

  for (const teamId of teamIds) {
    const team = await data.getTeam(teamId);
    if (!team) continue;

    // Guard: today must be a scheduled day
    const todayDay = n.getUTCDay(); // Sun=0 … Sat=6
    if (!team.scheduleDays.includes(todayDay)) continue;

    const date = n.toISOString().slice(0, 10);
    const run = await data.getRun(teamId, date);

    // === CASE 1: No run yet OR run is collecting — deliver prompts to ===
    // ===          members whose local time has reached the team hour  ===
    if (!run) {
      // Create the run first — triggerStandup handles dedup
      await data.createTodayRun(team.id);
    }

    await deliverTimezoneAwarePrompts(api, team, log);

    // Re-read the run after prompt delivery
    const currentRun = await data.getRun(teamId, date);
    if (!currentRun || currentRun.status !== "collecting") continue;

    const activeMembers = await data.getActiveMembers(team.id);

    // === CASE 2: Run is collecting — handle nudge + cutoff ===

    const runCreated = new Date(currentRun.createdAt);
    const elapsedMs = n.getTime() - runCreated.getTime();
    const elapsedMin = Math.floor(elapsedMs / 60_000);

    // --- 2a. Nudge window ---
    const nudgeWindowMin = Math.min(15, Math.max(5, Math.floor(team.cutoffWindowMinutes / 2)));
    if (elapsedMin >= nudgeWindowMin) {
      const pending = currentRun.responses.filter(
        (r) => r.status === "pending" && !currentRun.nudgedUserIds.includes(r.userId),
      );
      if (pending.length > 0) {
        log(`Sending nudges for team "${team.name}" (${pending.length} pending)`);
        const members = await data.getTeamMembers(teamId);
        try {
          await standup.sendNudges(api, team, currentRun, members);
        } catch (err) {
          log(`Nudge error for ${teamId}: ${err}`);
        }
      }
    }

    // --- 2b. Cutoff enforcement ---
    // Compute cutoff as: the latest member's prompt delivery time + window,
    // anchored to the RUN'S CREATION DATE (not the tick time). This ensures
    // the cutoff never shifts to a later calendar day after a restart.
    const cutoffDeadline = await computeCutoffDeadline(
      team, await data.getActiveMembers(team.id), currentRun.date,
    );
    if (n >= cutoffDeadline) {
      const pendingCount = currentRun.responses.filter(
        (r) => r.status === "pending",
      ).length;
      if (pendingCount > 0) {
        log(`Cutoff reached for "${team.name}" (${pendingCount} still pending) — compiling digest`);
        try {
          await standup.compileAndPostDigest(api, team);
        } catch (err) {
          log(`Cutoff digest error for ${teamId}: ${err}`);
        }
      }
    }
  }
}

/**
 * For each active member of the team, check if their local time has reached
 * the team's scheduled prompt time. If so and they haven't been prompted yet,
 * send the prompt.
 *
 * Uses each member's `timeZone` field; falls back to UTC for members without
 * a configured timezone.
 */
async function deliverTimezoneAwarePrompts(
  api: Api<RawApi>,
  team: Team,
  log: Logger,
): Promise<void> {
  const members = await data.getActiveMembers(team.id);
  const date = now().toISOString().slice(0, 10);
  const run = await data.getRun(team.id, date);
  if (!run) return;

  for (const member of members) {
    // Skip members already prompted or responded
    const resp = run.responses.find((r) => r.userId === member.id);
    if (!resp || resp.status !== "pending") continue;

    // Check if this member's local time has reached the scheduled hour
    const tz = member.timeZone || "UTC";
    if (!isPastLocalTime(team.localTime, tz)) continue;

    log(`Prompting member #${member.id} (${tz}) for team "${team.name}"`);
    try {
      await standup.promptMember(api, team, member);
    } catch (err) {
      log(`Prompt error for member #${member.id}: ${err}`);
    }
  }
}

/**
 * Compute the cutoff deadline as: the latest member's prompt delivery time +
 * the team's cutoff window. For members ahead of UTC (e.g. UTC+12), this
 * pushes the cutoff to avoid them being cut off before their local 09:00.
 *
 * Anchored to the RUN'S CREATION DATE, not the current tick time, so the
 * cutoff for a run created on day D never moves to day D+1 after a restart.
 *
 * Falls back to run creation time + cutoff if there are no members.
 */
async function computeCutoffDeadline(
  team: Team,
  members: Member[],
  runDate: string, // "YYYY-MM-DD" the run was created for
): Promise<Date> {
  if (members.length === 0) {
    const runDateObj = new Date(runDate + "T00:00:00Z");
    return new Date(runDateObj.getTime() + team.cutoffWindowMinutes * 60_000);
  }

  // Parse the run's date once — all member prompt times anchor to this date.
  const [runY, runM, runD] = runDate.split("-").map(Number);

  // Find the latest member's local prompt time (in UTC)
  let latestPromptUtc = new Date(0);
  for (const member of members) {
    const offsetMin = getUtcOffsetMinutes(member.timeZone || "UTC");
    const localH = parseInt(team.localTime.split(":")[0], 10);
    const localM = parseInt(team.localTime.split(":")[1], 10) || 0;
    // UTC = local time minus the offset
    const utcFromLocal = (localH * 60 + localM) - offsetMin;

    const promptUtc = new Date(Date.UTC(
      runY, runM - 1, runD, // months are 0-indexed in JS
      ...timeToHms(utcFromLocal),
    ));
    if (promptUtc > latestPromptUtc) latestPromptUtc = promptUtc;
  }

  return new Date(latestPromptUtc.getTime() + team.cutoffWindowMinutes * 60_000);
}

function timeToHms(totalMinutes: number): [number, number, number, number] {
  // Handle negative offsets (e.g. UTC-12 → local 09:00 = UTC 21:00 previous day)
  // Normalize into [0, 23] hours
  let mins = totalMinutes % (24 * 60);
  if (mins < 0) mins += 24 * 60;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return [h, m, 0, 0];
}