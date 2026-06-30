/**
 * Data access layer for the Async Standup Bot. Every durable operation
 * (Team, Member, StandupRun, HistoryEntry) goes through the persistent
 * JsonStore. NO keyspace enumeration — all collection reads use explicit
 * index fields (Team.memberIds, etc.).
 */

import { getStore, type JsonStore } from "./store.js";
import { now } from "./clock.js";
import type {
  Team,
  Member,
  StandupRun,
  HistoryEntry,
  MemberResponse,
} from "./types.js";
import { createTeam, createMember, createStandupRun } from "./types.js";

// ── Key constructors (private — do not export) ───────────────────────────

const K = {
  team: (id: string) => `team:${id}`,
  member: (userId: number) => `member:${userId}`,
  run: (teamId: string, date: string) => `run:${teamId}:${date}`,
  history: (teamId: string, date: string) => `history:${teamId}:${date}`,
};

// ── Team CRUD ────────────────────────────────────────────────────────────

export async function getTeam(id: string): Promise<Team | null> {
  return getStore().get<Team>(K.team(id));
}

export async function saveTeam(team: Team): Promise<void> {
  await getStore().set(K.team(team.id), team);
  // Maintain the teams index
  await addTeamId(team.id);
}

export async function deleteTeam(id: string): Promise<void> {
  await getStore().del(K.team(id));
  await removeTeamId(id);
}

/** Find a team by the channel id it posts to. Returns the team if found. */
export async function getTeamByChannel(channelId: number): Promise<Team | null> {
  // Channels are unique per team, so store a reverse index.
  const id = await getStore().get<string>(`channel:${channelId}`);
  if (!id) return null;
  return getTeam(id);
}

/** Register the channel → team reverse index. Call when saving a team. */
export async function setTeamChannel(teamId: string, channelId: number): Promise<void> {
  await getStore().set(`channel:${channelId}`, teamId);
}

/** Remove a channel → team reverse index entry (e.g. when channel changes). */
export async function removeTeamChannel(channelId: number): Promise<void> {
  await getStore().del(`channel:${channelId}`);
}

// ── Member CRUD ──────────────────────────────────────────────────────────

export async function getMember(userId: number): Promise<Member | null> {
  return getStore().get<Member>(K.member(userId));
}

export async function saveMember(member: Member): Promise<void> {
  await getStore().set(K.member(member.id), member);
  await setUserTeam(member.id, member.teamId);
  // Ensure member is in the team's memberIds index
  const team = await getTeam(member.teamId);
  if (team && !team.memberIds.includes(member.id)) {
    team.memberIds.push(member.id);
    await saveTeam(team);
  }
}

export async function deleteMember(userId: number): Promise<void> {
  const member = await getMember(userId);
  if (member) {
    const teamId = member.teamId;

    // Remove from team's memberIds index
    const team = await getTeam(teamId);
    if (team) {
      team.memberIds = team.memberIds.filter((id) => id !== userId);
      await saveTeam(team);
    }

    // Clean up today's active StandupRun so the removed member's pending
    // response doesn't block early digest compilation (prevents the allDone
    // check from failing because a ghost response stays "pending" forever).
    const date = now().toISOString().slice(0, 10);
    const run = await getRun(teamId, date);
    if (run && run.status === "collecting") {
      // Remove the response entry entirely — if the member is gone, their
      // response no longer matters for the "all responded" condition.
      run.responses = run.responses.filter((r) => r.userId !== userId);
      await saveRun(run);
    }

    // Clear reverse index
    await getStore().del(`userteam:${userId}`);
  }
  await getStore().del(K.member(userId));
}

/** Get which team a user belongs to using the reverse index. */
export async function getUserTeamId(userId: number): Promise<string | null> {
  return getStore().get<string>(`userteam:${userId}`);
}

export async function setUserTeam(userId: number, teamId: string): Promise<void> {
  await getStore().set(`userteam:${userId}`, teamId);
}

/** Get ALL members of a team via the explicit memberIds index. */
export async function getTeamMembers(teamId: string): Promise<Member[]> {
  const team = await getTeam(teamId);
  if (!team) return [];
  const members: Member[] = [];
  for (const userId of team.memberIds) {
    const m = await getMember(userId);
    if (m) members.push(m);
  }
  return members;
}

/** Get active members only (opted-in, not off/paused). */
export async function getActiveMembers(teamId: string): Promise<Member[]> {
  const all = await getTeamMembers(teamId);
  return all.filter((m) => m.optInStatus === "active");
}

// ── StandupRun CRUD ──────────────────────────────────────────────────────

export async function getRun(teamId: string, date: string): Promise<StandupRun | null> {
  return getStore().get<StandupRun>(K.run(teamId, date));
}

export async function saveRun(run: StandupRun): Promise<void> {
  await getStore().set(K.run(run.teamId, run.date), run);
}

/** List runs for a team within a date range. Uses an explicit days index
 *  (team:${id}:days → string[] of YYYY-MM-DD) so we never scan keys. */
export async function getRunsInRange(
  teamId: string,
  fromDate: string,
  toDate: string,
): Promise<StandupRun[]> {
  const days = await getStore().get<string[]>(`days:${teamId}`);
  if (!days) return [];
  const runs: StandupRun[] = [];
  for (const d of days) {
    if (d >= fromDate && d <= toDate) {
      const run = await getRun(teamId, d);
      if (run) runs.push(run);
    }
  }
  return runs;
}

/** Record that a team has a run for a given day (index maintenance). */
export async function addRunDay(teamId: string, date: string): Promise<void> {
  const days = await getStore().get<string[]>(`days:${teamId}`);
  const list = days ?? [];
  if (!list.includes(date)) {
    list.push(date);
    list.sort();
    await getStore().set(`days:${teamId}`, list);
  }
}

// ── HistoryEntry CRUD ────────────────────────────────────────────────────

export async function getHistoryEntry(
  teamId: string,
  date: string,
): Promise<HistoryEntry | null> {
  return getStore().get<HistoryEntry>(K.history(teamId, date));
}

export async function saveHistoryEntry(entry: HistoryEntry): Promise<void> {
  await getStore().set(K.history(entry.teamId, entry.date), entry);
}

export async function getHistoryInRange(
  teamId: string,
  fromDate: string,
  toDate: string,
): Promise<HistoryEntry[]> {
  const days = await getStore().get<string[]>(`days:${teamId}`);
  if (!days) return [];
  const entries: HistoryEntry[] = [];
  for (const d of days) {
    if (d >= fromDate && d <= toDate) {
      const entry = await getHistoryEntry(teamId, d);
      if (entry) entries.push(entry);
    }
  }
  // Newest first
  entries.sort((a, b) => b.date.localeCompare(a.date));
  return entries;
}

export async function addHistoryDay(teamId: string, date: string): Promise<void> {
  const days = await getStore().get<string[]>(`days:${teamId}`);
  const list = days ?? [];
  if (!list.includes(date)) {
    list.push(date);
    list.sort();
    await getStore().set(`days:${teamId}`, list);
  }
}

// ── Convenience: create a new standup run for today ──────────────────────

export async function createTodayRun(teamId: string): Promise<StandupRun> {
  const date = now().toISOString().slice(0, 10);
  const existing = await getRun(teamId, date);
  if (existing) return existing;

  const members = await getActiveMembers(teamId);
  const responses: MemberResponse[] = members.map((m) => ({
    userId: m.id,
    status: "pending" as const,
    answers: {},
    flagsBlockers: false,
  }));

  const run = createStandupRun(teamId, date, responses);
  await saveRun(run);
  await addRunDay(teamId, date);
  return run;
}

// ── Override for testing ─────────────────────────────────────────────────

// ── Teams index — explicit list of all team IDs (no keyspace scan) ────────

export async function addTeamId(teamId: string): Promise<void> {
  const ids = await getStore().get<string[]>("teams");
  const list = ids ?? [];
  if (!list.includes(teamId)) {
    list.push(teamId);
    list.sort();
    await getStore().set("teams", list);
  }
}

export async function removeTeamId(teamId: string): Promise<void> {
  const ids = await getStore().get<string[]>("teams");
  if (!ids) return;
  const list = ids.filter((id) => id !== teamId);
  await getStore().set("teams", list);
}

export async function getAllTeamIds(): Promise<string[]> {
  const ids = await getStore().get<string[]>("teams");
  return ids ?? [];
}

export function _resetAll(): void {
  // No-op — store reset is handled by setStore in tests
}
