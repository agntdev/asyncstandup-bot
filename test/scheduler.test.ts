/**
 * Scheduler + timezone unit tests. Uses the injectable clock (setClock) and
 * the in-memory store to drive tick() deterministically, verifying:
 *   a) Timezone-aware prompt delivery
 *   b) Nudge firing after configured window
 *   c) Digest compilation at cutoff deadline
 *   d) DST boundary offset computation
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { setClock, type Clock } from "../src/lib/clock.js";
import { setStore, resetStore } from "../src/lib/store.js";
import { tick } from "../src/lib/scheduler.js";
import * as data from "../src/lib/data.js";
import { createTeam, createMember } from "../src/lib/types.js";
import {
  isPastLocalTime,
  getLocalDay,
  getUtcOffsetMinutes,
} from "../src/lib/timezone.js";

// ── Fake clock ──────────────────────────────────────────────────────────────

class FakeClock implements Clock {
  private _ms: number;
  constructor(iso: string) {
    this._ms = new Date(iso).getTime();
  }
  epochMs(): number {
    return this._ms;
  }
  date(): Date {
    return new Date(this._ms);
  }
  advance(ms: number): void {
    this._ms += ms;
  }
  set(iso: string): void {
    this._ms = new Date(iso).getTime();
  }
}

// ── Test constants ──────────────────────────────────────────────────────────

/** Monday 2026-06-29 09:00 UTC */
const MON_0900_UTC = "2026-06-29T09:00:00.000Z";

// ── Helpers ─────────────────────────────────────────────────────────────────

function fakeApi() {
  return {
    sendMessage: vi.fn().mockResolvedValue({
      message_id: 1,
      date: 0,
      chat: { id: 1, type: "private" },
      text: "ok",
    }),
  } as any;
}

function fakeLogger() {
  return vi.fn();
}

/** Save a team + its members to the persistent store (in-memory in tests). */
async function saveTestData(team: ReturnType<typeof createTeam>, ...members: ReturnType<typeof createMember>[]) {
  await data.saveTeam(team);
  await data.setTeamChannel(team.id, team.channelId);
  for (const m of members) {
    await data.saveMember(m);
  }
}

// ── Timezone helpers (pure unit tests) ──────────────────────────────────────

describe("getUtcOffsetMinutes", () => {
  it("returns 0 for UTC", () => {
    const d = new Date("2026-06-29T12:00:00Z");
    expect(getUtcOffsetMinutes("UTC", d)).toBe(0);
  });

  it("returns correct offset for US Eastern summer (EDT, UTC-4)", () => {
    const d = new Date("2026-06-29T12:00:00Z");
    expect(getUtcOffsetMinutes("America/New_York", d)).toBe(-240);
  });

  it("returns different offset for US Eastern winter (EST, UTC-5)", () => {
    const summer = new Date("2026-06-29T12:00:00Z");
    const winter = new Date("2026-01-15T12:00:00Z");
    expect(getUtcOffsetMinutes("America/New_York", summer)).toBe(-240);
    expect(getUtcOffsetMinutes("America/New_York", winter)).toBe(-300);
  });

  it("returns 0 for unknown timezone (fallback)", () => {
    expect(getUtcOffsetMinutes("Mars/Olympus", new Date())).toBe(0);
  });
});

describe("isPastLocalTime", () => {
  it("true when local time equals the target", () => {
    const at = new Date("2026-06-29T09:00:00Z");
    expect(isPastLocalTime("09:00", "UTC", at)).toBe(true);
  });

  it("true when local time is after the target", () => {
    const at = new Date("2026-06-29T10:30:00Z");
    expect(isPastLocalTime("09:00", "UTC", at)).toBe(true);
  });

  it("false when local time is before the target", () => {
    const at = new Date("2026-06-29T08:30:00Z");
    expect(isPastLocalTime("09:00", "UTC", at)).toBe(false);
  });

  it("respects timezone — 09:00 UTC is 05:00 EDT, before 09:00 local", () => {
    const at = new Date("2026-06-29T09:00:00Z");
    expect(isPastLocalTime("09:00", "America/New_York", at)).toBe(false);
  });

  it("respects timezone — 13:00 UTC is 09:00 EDT, at the target", () => {
    const at = new Date("2026-06-29T13:00:00Z");
    expect(isPastLocalTime("09:00", "America/New_York", at)).toBe(true);
  });
});

describe("getLocalDay", () => {
  it("returns 1 (Monday) for Monday in UTC", () => {
    const mon = new Date("2026-06-29T00:00:00Z");
    expect(getLocalDay("UTC", mon)).toBe(1);
  });

  it("returns Tuesday for late Monday UTC in Tokyo (UTC+9)", () => {
    // Monday 23:00 UTC = Tuesday 08:00 JST
    const lateMon = new Date("2026-06-29T23:00:00Z");
    expect(getLocalDay("Asia/Tokyo", lateMon)).toBe(2);
  });

  it("returns Sunday for early Monday UTC in New York (UTC-4)", () => {
    // Monday 01:00 UTC = Sunday 21:00 EDT
    const earlyMon = new Date("2026-06-29T01:00:00Z");
    expect(getLocalDay("America/New_York", earlyMon)).toBe(0);
  });
});

// ── Scheduler tick() integration tests ──────────────────────────────────────

describe("Scheduler tick()", () => {
  let clock: FakeClock;
  let api: ReturnType<typeof fakeApi>;
  let log: ReturnType<typeof fakeLogger>;

  beforeEach(async () => {
    clock = new FakeClock(MON_0900_UTC);
    setClock(clock);
    resetStore();
    setStore(null);
    api = fakeApi();
    log = fakeLogger();
  });

  afterEach(() => {
    setClock(null);
    vi.clearAllMocks();
  });

  it("prompts a member when local time reaches the scheduled hour", async () => {
    const team = createTeam({
      id: "test-team",
      name: "Test Team",
      channelId: -100123,
      scheduleDays: [1],
      localTime: "09:00",
      cutoffWindowMinutes: 120,
    });
    const member = createMember({
      id: 1, teamId: "test-team", timeZone: "UTC", optInStatus: "active",
    });
    await saveTestData(team, member);

    await tick(api, log);

    expect(api.sendMessage).toHaveBeenCalledTimes(1);
    expect(api.sendMessage.mock.calls[0][0]).toBe(1);

    const run = await data.getRun("test-team", "2026-06-29");
    expect(run).not.toBeNull();
    expect(run!.promptedUserIds).toContain(1);
    expect(run!.status).toBe("collecting");
  });

  it("does NOT prompt a member whose local time hasn't reached the scheduled hour", async () => {
    const team = createTeam({
      id: "test-team",
      name: "Test",
      channelId: -100123,
      scheduleDays: [1],
      localTime: "09:00",
      cutoffWindowMinutes: 120,
    });
    // US Eastern summer (EDT = UTC-4): 09:00 UTC = 05:00 local → not yet 09:00
    const member = createMember({
      id: 1, teamId: "test-team", timeZone: "America/New_York", optInStatus: "active",
    });
    await saveTestData(team, member);

    await tick(api, log);
    expect(api.sendMessage).not.toHaveBeenCalled();
  });

  it("prompts a member in US Eastern when UTC reaches 13:00 (09:00 EDT)", async () => {
    const team = createTeam({
      id: "test-team",
      name: "Test",
      channelId: -100123,
      scheduleDays: [1],
      localTime: "09:00",
      cutoffWindowMinutes: 120,
    });
    const member = createMember({
      id: 1, teamId: "test-team", timeZone: "America/New_York", optInStatus: "active",
    });
    await saveTestData(team, member);

    // Advance to 13:00 UTC = 09:00 EDT
    clock.advance(4 * 60 * 60_000); // 09:00 → 13:00
    await tick(api, log);

    expect(api.sendMessage).toHaveBeenCalledTimes(1);
  });

  it("does NOT re-prompt an already prompted member", async () => {
    const team = createTeam({
      id: "test-team",
      name: "Test",
      channelId: -100123,
      scheduleDays: [1],
      localTime: "09:00",
      cutoffWindowMinutes: 120,
    });
    const member = createMember({
      id: 1, teamId: "test-team", timeZone: "UTC", optInStatus: "active",
    });
    await saveTestData(team, member);

    // First tick sends prompt
    await tick(api, log);
    expect(api.sendMessage).toHaveBeenCalledTimes(1);

    // Second tick must not re-prompt
    await tick(api, log);
    expect(api.sendMessage).toHaveBeenCalledTimes(1);
  });

  it("sends nudge to prompted-but-pending member after nudge window", async () => {
    const team = createTeam({
      id: "test-team",
      name: "Test",
      channelId: -100123,
      scheduleDays: [1],
      localTime: "09:00",
      cutoffWindowMinutes: 120,
    });
    const member = createMember({
      id: 1, teamId: "test-team", timeZone: "UTC", optInStatus: "active",
    });
    await saveTestData(team, member);

    // Tick 1 at 09:00: prompt sent
    await tick(api, log);
    expect(api.sendMessage).toHaveBeenCalledTimes(1);

    // Advance past nudge window (floor(120/2)=60, capped at 15 min)
    clock.advance(17 * 60_000); // 09:00 → 09:17
    api.sendMessage.mockClear();

    await tick(api, log);

    // Nudge should have been sent to member 1
    const nudgeCalls = api.sendMessage.mock.calls.filter(
      (c: any[]) => c[0] === 1,
    );
    expect(nudgeCalls.length).toBe(1);

    const run = await data.getRun("test-team", "2026-06-29");
    expect(run!.nudgedUserIds).toContain(1);
  });

  it("does NOT nudge members who have already been nudged", async () => {
    const team = createTeam({
      id: "test-team",
      name: "Test",
      channelId: -100123,
      scheduleDays: [1],
      localTime: "09:00",
      cutoffWindowMinutes: 120,
    });
    const member = createMember({
      id: 1, teamId: "test-team", timeZone: "UTC", optInStatus: "active",
    });
    await saveTestData(team, member);

    // Tick 1: prompt
    await tick(api, log);

    // Tick 2 at 09:17: nudge fires
    clock.advance(17 * 60_000);
    await tick(api, log);
    const runAfterNudge = await data.getRun("test-team", "2026-06-29");
    expect(runAfterNudge!.nudgedUserIds).toContain(1);

    // Tick 3 at 09:25: nudge should NOT fire again
    clock.advance(8 * 60_000);
    api.sendMessage.mockClear();
    await tick(api, log);

    // Only calls to channel or other members would be unexpected — none expected
    const memberCalls = api.sendMessage.mock.calls.filter(
      (c: any[]) => c[0] === 1,
    );
    expect(memberCalls.length).toBe(0);
  });

  it("compiles digest at cutoff deadline and saves history entry", async () => {
    const team = createTeam({
      id: "test-team",
      name: "Test",
      channelId: -100123,
      scheduleDays: [1],
      localTime: "09:00",
      cutoffWindowMinutes: 60,
    });
    const member = createMember({
      id: 1, teamId: "test-team", timeZone: "UTC", optInStatus: "active",
    });
    await saveTestData(team, member);

    // Tick 1 at 09:00: prompt sent
    await tick(api, log);
    expect(api.sendMessage).toHaveBeenCalledTimes(1);

    // Advance past cutoff (09:00 + 60 min = 10:00)
    clock.advance(65 * 60_000); // 09:00 → 10:05
    api.sendMessage.mockClear();

    await tick(api, log);

    // Digest should be posted to the channel
    const channelCalls = api.sendMessage.mock.calls.filter(
      (c: any[]) => c[0] === -100123,
    );
    expect(channelCalls.length).toBeGreaterThan(0);

    // Run should be marked as compiled
    const run = await data.getRun("test-team", "2026-06-29");
    expect(run!.status).toBe("compiled");
    expect(run!.digestContent).toBeTruthy();

    // History entry should exist
    const history = await data.getHistoryEntry("test-team", "2026-06-29");
    expect(history).not.toBeNull();
    expect(history!.digestText).toContain("Standup Digest");
    expect(history!.participants).toEqual([]);
    expect(history!.pendingList).toEqual([1]);
  });

  it("does NOT compile digest before cutoff deadline", async () => {
    const team = createTeam({
      id: "test-team",
      name: "Test",
      channelId: -100123,
      scheduleDays: [1],
      localTime: "09:00",
      cutoffWindowMinutes: 60,
    });
    const member = createMember({
      id: 1, teamId: "test-team", timeZone: "UTC", optInStatus: "active",
    });
    await saveTestData(team, member);

    // Tick 1 at 09:00: prompt
    await tick(api, log);

    // Advance 30 min — still before 10:00 cutoff
    clock.advance(30 * 60_000); // 09:30
    api.sendMessage.mockClear();

    await tick(api, log);

    // No channel message yet
    const channelCalls = api.sendMessage.mock.calls.filter(
      (c: any[]) => c[0] === -100123,
    );
    expect(channelCalls.length).toBe(0);

    const run = await data.getRun("test-team", "2026-06-29");
    expect(run!.status).toBe("collecting");
  });

  it("computes DST boundary offsets correctly (unit-level verification)", () => {
    const summer = new Date("2026-06-29T12:00:00Z");
    const winter = new Date("2026-01-15T12:00:00Z");

    const summerOffset = getUtcOffsetMinutes("America/New_York", summer);
    const winterOffset = getUtcOffsetMinutes("America/New_York", winter);

    expect(summerOffset).toBe(-240); // EDT = UTC-4
    expect(winterOffset).toBe(-300); // EST = UTC-5
    expect(summerOffset - winterOffset).toBe(60);
  });

  it("skips teams not scheduled on the current day", async () => {
    const team = createTeam({
      id: "test-team",
      name: "Test",
      channelId: -100123,
      scheduleDays: [2, 3, 4, 5], // Tue–Fri only (Monday is not scheduled)
      localTime: "09:00",
      cutoffWindowMinutes: 120,
    });
    const member = createMember({
      id: 1, teamId: "test-team", timeZone: "UTC", optInStatus: "active",
    });
    await saveTestData(team, member);

    await tick(api, log);

    // Today is Monday but the team only runs Tue–Fri
    expect(api.sendMessage).not.toHaveBeenCalled();
  });

  it("skips paused members when delivering prompts", async () => {
    const team = createTeam({
      id: "test-team",
      name: "Test",
      channelId: -100123,
      scheduleDays: [1],
      localTime: "09:00",
      cutoffWindowMinutes: 120,
    });
    const paused = createMember({
      id: 2, teamId: "test-team", timeZone: "UTC", optInStatus: "paused",
    });
    await saveTestData(team, paused);

    await tick(api, log);

    // Paused member should NOT be prompted (getActiveMembers filters them out)
    expect(api.sendMessage).not.toHaveBeenCalled();
  });
});
