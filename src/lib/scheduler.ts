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
import { isPastLocalTime, getLocalDay, getUtcOffsetMinutes } from "./timezone.js";
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

  // Guard: use recursive setTimeout so concurrent ticks can never overlap.
  // setInterval would fire the next tick even if the previous one hasn't
  // finished, which can cause double prompts/nudges and inconsistent state.
  let running = false;
  let cancelled = false;

  function scheduleNext() {
    if (cancelled) return;
    setTimeout(async () => {
      if (running) return; // safety belt — should never happen with the guard
      running = true;
      try {
        await tick(api, log);
      } catch (err) {
        log(`Scheduler tick error: ${err}`);
      } finally {
        running = false;
        if (!cancelled) scheduleNext();
      }
    }, interval);
  }

  scheduleNext();

  log(`Scheduler started (poll every ${interval}ms)`);
  return () => {
    cancelled = true;
  };
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

    // Guard: Must be a scheduled day somewhere in the team. Use a ±1 day window
    // because members in far-ahead/far-behind timezones may already be on the next
    // or still on the previous calendar day relative to UTC. The per-member
    // prompt delivery below rejects members whose local day isn't scheduled.
    const todayUtcDay = n.getUTCDay(); // Sun=0 … Sat=6
    const yesterdayDay = (todayUtcDay + 6) % 7;
    const tomorrowDay = (todayUtcDay + 1) % 7;
    if (
      !team.scheduleDays.includes(todayUtcDay) &&
      !team.scheduleDays.includes(yesterdayDay) &&
      !team.scheduleDays.includes(tomorrowDay)
    )
      continue;

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

    // --- 2a. Nudge window: only nudge members who have been PROMPTED ---
    // Nudging a member who hasn't received their prompt yet (e.g. they're in a
    // far-ahead timezone and their prompt hour hasn't arrived) is nonsensical.
    const nudgeWindowMin = Math.min(15, Math.max(5, Math.floor(team.cutoffWindowMinutes / 2)));
    if (elapsedMin >= nudgeWindowMin) {
      const pending = currentRun.responses.filter(
        (r) =>
          r.status === "pending" &&
          currentRun.promptedUserIds.includes(r.userId) &&
          !currentRun.nudgedUserIds.includes(r.userId),
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

    // Skip if this member was already prompted this run (prevents dupes on every tick)
    if (run.promptedUserIds.includes(member.id)) continue;

    // Check if this member's local time has reached the scheduled hour
    const tz = member.timeZone || "UTC";
    if (!isPastLocalTime(team.localTime, tz)) continue;

    // Check if today is a scheduled day in this member's LOCAL timezone
    const localDay = getLocalDay(tz);
    if (!team.scheduleDays.includes(localDay)) continue;

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
  const [localH, localMin] = team.localTime.split(":").map(Number);

  // Construct a Date at the team's scheduled local time ON THE RUN'S DATE.
  // We don't know the UTC instant yet (that depends on the timezone), but we
  // use midnight UTC of the run date as the base and let getUtcOffsetMinutes
  // compute the real offset for that date. We construct a Date at noon UTC
  // on the run date as a safe representative instant — any DST transition for
  // that date will be reflected, and noon avoids midnight edge cases.
  const runDateAtNoon = new Date(Date.UTC(runY, runM - 1, runD, 12, 0, 0));

  // Find the latest member's local prompt time (in UTC)
  let latestPromptUtc = new Date(0);
  for (const member of members) {
    // Compute the offset for the RUN'S DATE (at noon UTC), NOT at now().
    // This is correct during DST transitions: the offset matches the calendar
    // date the standup is scheduled for, regardless of when the scheduler tick
    // actually fires.
    const offsetMin = getUtcOffsetMinutes(member.timeZone || "UTC", runDateAtNoon);
    const utcFromLocal = (localH * 60 + localMin) - offsetMin;

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