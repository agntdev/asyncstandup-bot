/**
 * Domain data types for the Async Standup Bot. Durable data lives in the
 * persistent store (Redis-backed), never in-memory or in grammY sessions.
 */

import { now } from "./clock.js";

// ── Team ─────────────────────────────────────────────────────────────────

export interface Team {
  id: string; // join-code / slug
  name: string;
  channelId: number; // Telegram channel/group chat id where digests are posted
  scheduleDays: number[]; // 0=Sun … 6=Sat
  localTime: string; // "HH:MM" in the team's default timezone
  cutoffWindowMinutes: number; // how long after prompt before digest compiles
  questions: string[]; // default: ["What did you do?", "What will you do?", "Any blockers?"]
  blockerKeywords: string[];
  memberIds: number[]; // INDEX — do NOT enumerate keyspace
  createdAt: string; // ISO timestamp
}

// ── Member ───────────────────────────────────────────────────────────────

export type OptInStatus = "active" | "paused" | "off";

export interface Member {
  id: number; // Telegram user id
  teamId: string;
  timeZone: string; // IANA tz, e.g. "America/New_York"
  optInStatus: OptInStatus;
  preferredLanguage: string; // e.g. "en"
  joinedAt: string;
}

// ── Standup run ──────────────────────────────────────────────────────────

export type ResponseStatus = "pending" | "answered" | "skipped" | "off";

export interface MemberResponse {
  userId: number;
  status: ResponseStatus;
  answers: Record<string, string>; // question → answer
  flagsBlockers: boolean;
  respondedAt?: string;
}

export interface StandupRun {
  id: string; // "teamId:YYYY-MM-DD"
  teamId: string;
  date: string; // "YYYY-MM-DD"
  createdAt: string;
  status: "collecting" | "compiled";
  responses: MemberResponse[];
  promptedUserIds: number[]; // members who have received their prompt this run
  nudgedUserIds: number[]; // members who have received a nudge this run
  digestContent?: string;
  blockerSummary?: string;
}

// ── History entry ────────────────────────────────────────────────────────

export interface HistoryEntry {
  id: string; // same as StandupRun id
  teamId: string;
  date: string;
  digestText: string;
  participants: number[];
  pendingList: number[];
  blockerSummary: string;
}

// ── Defaults ─────────────────────────────────────────────────────────────

export const DEFAULT_QUESTIONS = [
  "What did you work on since the last standup?",
  "What do you plan to work on today?",
  "Any blockers or issues?",
];

export const DEFAULT_BLOCKER_KEYWORDS = [
  "blocker",
  "blocked",
  "stuck",
  "waiting on",
  "dependency",
  "can't proceed",
];

export const DEFAULT_CUTOFF_MINUTES = 120;

// ── Factory helpers ──────────────────────────────────────────────────────

export function createTeam(partial: Partial<Team> & Pick<Team, "id" | "name" | "channelId">): Team {
  return {
    scheduleDays: [1, 2, 3, 4, 5], // Mon–Fri
    localTime: "09:00",
    cutoffWindowMinutes: DEFAULT_CUTOFF_MINUTES,
    questions: [...DEFAULT_QUESTIONS],
    blockerKeywords: [...DEFAULT_BLOCKER_KEYWORDS],
    memberIds: [],
    createdAt: now().toISOString(),
    ...partial,
  };
}

export function createMember(partial: Partial<Member> & Pick<Member, "id" | "teamId">): Member {
  return {
    timeZone: "UTC",
    optInStatus: "active",
    preferredLanguage: "en",
    joinedAt: now().toISOString(),
    ...partial,
  };
}

export function createStandupRun(
  teamId: string,
  date: string,
  responses: MemberResponse[],
): StandupRun {
  return {
    id: `${teamId}:${date}`,
    teamId,
    date,
    createdAt: now().toISOString(),
    status: "collecting",
    responses,
    promptedUserIds: [],
    nudgedUserIds: [],
  };
}

export function createHistoryEntry(
  run: StandupRun,
  digestText: string,
  blockerSummary: string,
): HistoryEntry {
  return {
    id: run.id,
    teamId: run.teamId,
    date: run.date,
    digestText,
    participants: run.responses
      .filter((r) => r.status === "answered")
      .map((r) => r.userId),
    pendingList: run.responses
      .filter((r) => r.status === "pending")
      .map((r) => r.userId),
    blockerSummary,
  };
}