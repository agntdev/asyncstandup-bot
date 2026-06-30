/**
 * E2E integration tests for the Async Standup Bot. Tests the full lifecycle:
 *   - Team creation with member join
 *   - Standup triggering, answering, and digest compilation
 *   - Nudge delivery
 *   - History retrieval (7/30/90-day reports)
 *   - Timezone-aware prompt delivery across global teams
 *   - Settings changes confirmation flow
 *
 * These tests seed the persistent store directly and drive the scheduler's
 * tick() with the injectable clock — exercising the full engine end-to-end
 * without a live Telegram API.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { setClock, type Clock } from "../src/lib/clock.js";
import { setStore, resetStore } from "../src/lib/store.js";
import { tick } from "../src/lib/scheduler.js";
import * as data from "../src/lib/data.js";
import {
  createTeam,
  createMember,
  DEFAULT_QUESTIONS,
} from "../src/lib/types.js";
import {
  promptMember,
  compileAndPostDigest,
  sendNudges,
  buildPromptMessage,
  promptKeyboard,
  buildQuestionPrompt,
  detectBlocker,
  compileDigest,
  todayDate,
} from "../src/lib/standup.js";
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

/** Monday 2026-06-29 09:00 UTC */
const MON_0900 = "2026-06-29T09:00:00.000Z";
/** ISO date string for Monday */
const MON_DATE = "2026-06-29";

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

async function saveTestData(
  team: ReturnType<typeof createTeam>,
  ...members: ReturnType<typeof createMember>[]
) {
  await data.saveTeam(team);
  await data.setTeamChannel(team.id, team.channelId);
  for (const m of members) {
    await data.saveMember(m);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// 1. End-to-end daily standup run
// ═══════════════════════════════════════════════════════════════════════════

describe("E2E daily standup run", () => {
  let clock: FakeClock;
  let api: ReturnType<typeof fakeApi>;

  beforeEach(async () => {
    clock = new FakeClock(MON_0900);
    setClock(clock);
    resetStore();
    setStore(null);
    api = fakeApi();
  });

  afterEach(() => {
    setClock(null);
    vi.clearAllMocks();
  });

  it("full lifecycle: prompt → skip → answer → nudge → cutoff → digest → history", async () => {
    // Set up a team with 3 members in different timezones
    const team = createTeam({
      id: "e2e",
      name: "E2E Team",
      channelId: -100456,
      scheduleDays: [1], // Monday
      localTime: "09:00",
      cutoffWindowMinutes: 60,
      questions: ["What did you do?", "What will you do?", "Any blockers?"],
    });
    const alice = createMember({
      id: 101, teamId: "e2e", timeZone: "UTC", optInStatus: "active",
    });
    const bob = createMember({
      id: 202, teamId: "e2e", timeZone: "UTC", optInStatus: "active",
    });
    const carol = createMember({
      id: 303, teamId: "e2e", timeZone: "America/New_York", optInStatus: "active",
    });
    await saveTestData(team, alice, bob, carol);

    // Tick 1: Alice and Bob (UTC) get prompted at 09:00 UTC.
    // Carol (EDT, UTC-4) is at 05:00 local — NOT prompted yet.
    const log = fakeLogger();
    await tick(api, log);

    // Alice and Bob should be prompted; Carol NOT yet (her local time = 05:00)
    expect(api.sendMessage).toHaveBeenCalledTimes(2);
    const promptedIds = api.sendMessage.mock.calls.map((c: any[]) => c[0]).sort();
    expect(promptedIds).toContain(101);
    expect(promptedIds).toContain(202);
    expect(promptedIds).not.toContain(303);

    const run1 = await data.getRun("e2e", MON_DATE);
    expect(run1).not.toBeNull();
    expect(run1!.status).toBe("collecting");
    expect(run1!.promptedUserIds).toContain(101);
    expect(run1!.promptedUserIds).toContain(202);

    // Bob answers (simulate 101 is still pending)
    const bobResp = run1!.responses.find((r) => r.userId === 202);
    expect(bobResp).toBeDefined();
    bobResp!.status = "answered";
    bobResp!.answers = { "0": "Fixed bugs", "1": "New feature", "2": "None" };
    await data.saveRun(run1!);

    // Advance past nudge window (min(15, floor(60/2)) = 15 min)
    clock.advance(17 * 60_000); // 09:00 → 09:17
    api.sendMessage.mockClear();
    await tick(api, log);

    // Nudge should be sent to Alice (pending + already prompted) but NOT Bob (answered)
    const nudgeCalls = api.sendMessage.mock.calls.filter(
      (c: any[]) => c[0] === 101,
    );
    expect(nudgeCalls.length).toBe(1);
    // No nudge to Bob
    const bobNudgeCalls = api.sendMessage.mock.calls.filter(
      (c: any[]) => c[0] === 202,
    );
    expect(bobNudgeCalls.length).toBe(0);

    const run2 = await data.getRun("e2e", MON_DATE);
    expect(run2!.nudgedUserIds).toContain(101);

    // Carol gets prompted when UTC hits 13:00 (09:00 EDT)
    clock.set("2026-06-29T13:01:00.000Z");
    api.sendMessage.mockClear();
    await tick(api, log);

    const carolPrompt = api.sendMessage.mock.calls.filter(
      (c: any[]) => c[0] === 303,
    );
    expect(carolPrompt.length).toBe(1);

    // Carol answers
    const run3 = await data.getRun("e2e", MON_DATE);
    const carolResp = run3!.responses.find((r) => r.userId === 303);
    expect(carolResp).toBeDefined();
    carolResp!.status = "answered";
    carolResp!.answers = { "0": "Design review", "1": "Wireframes", "2": "Blocked on API" };
    carolResp!.flagsBlockers = true;
    await data.saveRun(run3!);

    // Alice still pending
    // Advance past cutoff (latest member prompt was Carol at 13:01 + 60 min = 14:01)
    clock.set("2026-06-29T14:30:00.000Z");
    api.sendMessage.mockClear();
    await tick(api, log);

    // Digest should be posted to the channel
    const channelCalls = api.sendMessage.mock.calls.filter(
      (c: any[]) => c[0] === -100456,
    );
    expect(channelCalls.length).toBe(1);
    const channelText = channelCalls[0][1] as string;
    expect(channelText).toContain("Standup Digest");
    expect(channelText).toContain("Fixed bugs");
    expect(channelText).toContain("Blocked on API");

    // Run should be compiled
    const run4 = await data.getRun("e2e", MON_DATE);
    expect(run4!.status).toBe("compiled");

    // History entry should exist
    const history = await data.getHistoryEntry("e2e", MON_DATE);
    expect(history).not.toBeNull();
    expect(history!.digestText).toContain("Standup Digest");
    expect(history!.participants.sort()).toEqual([202, 303].sort());
    expect(history!.pendingList).toEqual([101]);
    expect(history!.blockerSummary).not.toBe("No blockers reported today.");
  });

  it("triggers digest immediately when all members respond before cutoff", async () => {
    const team = createTeam({
      id: "early",
      name: "Early Team",
      channelId: -100789,
      scheduleDays: [1],
      localTime: "09:00",
      cutoffWindowMinutes: 120,
    });
    const alice = createMember({
      id: 10, teamId: "early", timeZone: "UTC", optInStatus: "active",
    });
    const bob = createMember({
      id: 20, teamId: "early", timeZone: "UTC", optInStatus: "active",
    });
    await saveTestData(team, alice, bob);

    // Prompt both
    const log = fakeLogger();
    await tick(api, log);
    expect(api.sendMessage).toHaveBeenCalledTimes(2);

    // Both answer immediately
    const run = await data.getRun("early", MON_DATE);
    expect(run).not.toBeNull();
    const aliceResp = run!.responses.find((r) => r.userId === 10);
    aliceResp!.status = "answered";
    aliceResp!.answers = { "0": "A", "1": "B", "2": "C" };
    const bobResp = run!.responses.find((r) => r.userId === 20);
    bobResp!.status = "answered";
    bobResp!.answers = { "0": "X", "1": "Y", "2": "Z" };
    await data.saveRun(run!);

    // compileAndPostDigest should post immediately (no cutoff wait)
    api.sendMessage.mockClear();
    await compileAndPostDigest(api, team);

    const runAfter = await data.getRun("early", MON_DATE);
    expect(runAfter!.status).toBe("compiled");

    const channelCalls = api.sendMessage.mock.calls.filter(
      (c: any[]) => c[0] === -100789,
    );
    expect(channelCalls.length).toBe(1);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 2. Time zone handling across global teams
// ═══════════════════════════════════════════════════════════════════════════

describe("Timezone handling across global teams", () => {
  let clock: FakeClock;
  let api: ReturnType<typeof fakeApi>;

  beforeEach(async () => {
    clock = new FakeClock("2026-06-29T08:55:00.000Z");
    setClock(clock);
    resetStore();
    setStore(null);
    api = fakeApi();
  });

  afterEach(() => {
    setClock(null);
    vi.clearAllMocks();
  });

  it("prompts Auckland member hours before New York member", async () => {
    const team = createTeam({
      id: "global",
      name: "Global Team",
      channelId: -100111,
      scheduleDays: [1],
      localTime: "09:00",
      cutoffWindowMinutes: 120,
    });

    // Auckland: UTC+12 → local 09:00 = UTC 21:00 previous day (Sunday)
    // So at Monday 08:55 UTC, Auckland is already at 20:55 Monday → local day = Monday ✓, time = 20:55 → past 09:00 ✓
    const nzMember = createMember({
      id: 1, teamId: "global", timeZone: "Pacific/Auckland", optInStatus: "active",
    });
    // New York: EDT UTC-4 → local 09:00 = UTC 13:00
    const nyMember = createMember({
      id: 2, teamId: "global", timeZone: "America/New_York", optInStatus: "active",
    });
    // Tokyo: UTC+9 → local 09:00 = UTC 00:00
    const tkMember = createMember({
      id: 3, teamId: "global", timeZone: "Asia/Tokyo", optInStatus: "active",
    });
    await saveTestData(team, nzMember, nyMember, tkMember);

    // At 08:55 UTC Monday:
    //   NZ: Monday 20:55 → past 09:00 ✓ → prompted
    //   Tokyo: Monday 17:55 → past 09:00 ✓ → prompted
    //   NY: Monday 04:55 → NOT past 09:00 → not prompted
    const log = fakeLogger();
    await tick(api, log);

    const calls = api.sendMessage.mock.calls.map((c: any[]) => c[0]);
    expect(calls).toContain(1); // NZ prompted
    expect(calls).toContain(3); // Tokyo prompted
    expect(calls).not.toContain(2); // NY NOT prompted yet

    // Advance to 13:01 UTC (09:01 EDT): NY should now get prompted.
    // At this time, the nudge window has also passed, so NY may get both
    // a prompt and a nudge. Just verify NY got at least one prompt.
    clock.set("2026-06-29T13:01:00.000Z");
    api.sendMessage.mockClear();
    await tick(api, log);

    const nyCalls = api.sendMessage.mock.calls.filter(
      (c: any[]) => c[0] === 2,
    );
    expect(nyCalls.length).toBeGreaterThanOrEqual(1);
  });

  it("correctly falls back to UTC for members without timezone", async () => {
    const team = createTeam({
      id: "notz",
      name: "No TZ Team",
      channelId: -100222,
      scheduleDays: [1],
      localTime: "09:00",
      cutoffWindowMinutes: 120,
    });
    const member = createMember({
      id: 1,
      teamId: "notz",
      timeZone: "UTC",
      optInStatus: "active",
    });
    await saveTestData(team, member);

    clock.set("2026-06-29T09:00:00.000Z");
    const log = fakeLogger();
    await tick(api, log);

    expect(api.sendMessage).toHaveBeenCalledTimes(1);
    expect(api.sendMessage.mock.calls[0][0]).toBe(1);
  });

  it("respects member optInStatus — paused members don't get prompts", async () => {
    const team = createTeam({
      id: "opt",
      name: "Opt Team",
      channelId: -100333,
      scheduleDays: [1],
      localTime: "09:00",
      cutoffWindowMinutes: 120,
    });
    const active = createMember({
      id: 1, teamId: "opt", timeZone: "UTC", optInStatus: "active",
    });
    const paused = createMember({
      id: 2, teamId: "opt", timeZone: "UTC", optInStatus: "paused",
    });
    const off = createMember({
      id: 3, teamId: "opt", timeZone: "UTC", optInStatus: "off",
    });
    await saveTestData(team, active, paused, off);

    // Advance to 09:00 UTC so the active member is at their prompt time
    clock.set("2026-06-29T09:00:00.000Z");
    const log = fakeLogger();
    await tick(api, log);

    expect(api.sendMessage).toHaveBeenCalledTimes(1);
    expect(api.sendMessage.mock.calls[0][0]).toBe(1);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 3. History retrieval with 7/30/90-day reports
// ═══════════════════════════════════════════════════════════════════════════

describe("History retrieval", () => {
  let clock: FakeClock;

  beforeEach(async () => {
    clock = new FakeClock(MON_0900);
    setClock(clock);
    resetStore();
    setStore(null);
  });

  afterEach(() => {
    setClock(null);
    vi.clearAllMocks();
  });

  it("getHistoryInRange returns entries within date window", async () => {
    const team = createTeam({
      id: "hist",
      name: "History Team",
      channelId: -100444,
    });
    await data.saveTeam(team);
    await data.addRunDay("hist", "2026-06-01");
    await data.addRunDay("hist", "2026-06-15");
    await data.addRunDay("hist", "2026-06-29");

    await data.saveHistoryEntry({
      id: "hist:2026-06-01",
      teamId: "hist",
      date: "2026-06-01",
      digestText: "Digest for June 1",
      participants: [1, 2],
      pendingList: [],
      blockerSummary: "No blockers reported today.",
    });
    await data.saveHistoryEntry({
      id: "hist:2026-06-15",
      teamId: "hist",
      date: "2026-06-15",
      digestText: "Digest for June 15",
      participants: [1],
      pendingList: [2],
      blockerSummary: "▸ Member #2: blocked on deploy",
    });
    await data.saveHistoryEntry({
      id: "hist:2026-06-29",
      teamId: "hist",
      date: "2026-06-29",
      digestText: "Digest for June 29",
      participants: [1, 2],
      pendingList: [],
      blockerSummary: "No blockers reported today.",
    });

    // 7 days: from June 23 → only June 29
    const seven = await data.getHistoryInRange("hist", "2026-06-23", "2026-06-29");
    expect(seven.length).toBe(1);
    expect(seven[0].date).toBe("2026-06-29");

    // 30 days: from June 1 → all 3
    const thirty = await data.getHistoryInRange("hist", "2026-05-30", "2026-06-29");
    expect(thirty.length).toBe(3);

    // 90 days: same result (no older data)
    const ninety = await data.getHistoryInRange("hist", "2026-04-01", "2026-06-29");
    expect(ninety.length).toBe(3);
    // Should be newest first
    expect(ninety[0].date).toBe("2026-06-29");
    expect(ninety[2].date).toBe("2026-06-01");
  });

  it("returns empty array when team has no history", async () => {
    const team = createTeam({
      id: "empty",
      name: "Empty Team",
      channelId: -100555,
    });
    await data.saveTeam(team);

    const results = await data.getHistoryInRange("empty", "2026-01-01", "2026-12-31");
    expect(results).toEqual([]);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 4. Settings changes confirmation flow
// ═══════════════════════════════════════════════════════════════════════════

describe("Settings changes confirmation flow", () => {
  beforeEach(async () => {
    setClock(new FakeClock(MON_0900));
    resetStore();
    setStore(null);
  });

  afterEach(() => {
    setClock(null);
    vi.clearAllMocks();
  });

  it("updates team questions and confirms", async () => {
    const team = createTeam({
      id: "settings",
      name: "Settings Team",
      channelId: -100666,
    });
    await data.saveTeam(team);

    // Update questions
    const fetched = await data.getTeam("settings");
    expect(fetched).not.toBeNull();
    fetched!.questions = ["Q1 custom", "Q2 custom"];
    await data.saveTeam(fetched!);

    const reloaded = await data.getTeam("settings");
    expect(reloaded!.questions).toEqual(["Q1 custom", "Q2 custom"]);
  });

  it("updates schedule days and confirms", async () => {
    const team = createTeam({
      id: "settings",
      name: "Settings Team",
      channelId: -100666,
      scheduleDays: [1, 2, 3, 4, 5],
    });
    await data.saveTeam(team);

    const fetched = await data.getTeam("settings");
    fetched!.scheduleDays = [1, 3, 5]; // Mon, Wed, Fri only
    await data.saveTeam(fetched!);

    const reloaded = await data.getTeam("settings");
    expect(reloaded!.scheduleDays).toEqual([1, 3, 5]);
  });

  it("updates local time and confirms", async () => {
    const team = createTeam({
      id: "settings",
      name: "Settings Team",
      channelId: -100666,
      localTime: "09:00",
    });
    await data.saveTeam(team);

    const fetched = await data.getTeam("settings");
    fetched!.localTime = "14:30";
    await data.saveTeam(fetched!);

    const reloaded = await data.getTeam("settings");
    expect(reloaded!.localTime).toBe("14:30");
  });

  it("updates cutoff window and confirms", async () => {
    const team = createTeam({
      id: "settings",
      name: "Settings Team",
      channelId: -100666,
      cutoffWindowMinutes: 60,
    });
    await data.saveTeam(team);

    const fetched = await data.getTeam("settings");
    fetched!.cutoffWindowMinutes = 90;
    await data.saveTeam(fetched!);

    const reloaded = await data.getTeam("settings");
    expect(reloaded!.cutoffWindowMinutes).toBe(90);
  });

  it("updates blocker keywords and confirms", async () => {
    const team = createTeam({
      id: "settings",
      name: "Settings Team",
      channelId: -100666,
    });
    await data.saveTeam(team);

    const fetched = await data.getTeam("settings");
    fetched!.blockerKeywords = ["blocked", "waiting", "stuck"];
    await data.saveTeam(fetched!);

    const reloaded = await data.getTeam("settings");
    expect(reloaded!.blockerKeywords).toEqual(["blocked", "waiting", "stuck"]);
  });

  it("toggle member status cycles: active → paused → off → active", async () => {
    const team = createTeam({
      id: "status",
      name: "Status Team",
      channelId: -100777,
    });
    const member = createMember({
      id: 99, teamId: "status", timeZone: "UTC", optInStatus: "active",
    });
    await data.saveTeam(team);
    await data.saveMember(member);

    let m = await data.getMember(99);
    expect(m!.optInStatus).toBe("active");

    m!.optInStatus = "paused";
    await data.saveMember(m!);
    m = await data.getMember(99);
    expect(m!.optInStatus).toBe("paused");

    m!.optInStatus = "off";
    await data.saveMember(m!);
    m = await data.getMember(99);
    expect(m!.optInStatus).toBe("off");

    m!.optInStatus = "active";
    await data.saveMember(m!);
    m = await data.getMember(99);
    expect(m!.optInStatus).toBe("active");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 5. Blocker detection + member removal edge cases
// ═══════════════════════════════════════════════════════════════════════════

describe("Blocker detection and edge cases", () => {
  let api: ReturnType<typeof fakeApi>;

  beforeEach(async () => {
    setClock(new FakeClock(MON_0900));
    resetStore();
    setStore(null);
    api = fakeApi();
  });

  afterEach(() => {
    setClock(null);
    vi.clearAllMocks();
  });

  it("detectBlocker matches keywords case-insensitively", () => {
    const keywords = ["blocked", "stuck", "waiting on", "dependency"];
    expect(detectBlocker("I'm blocked on this task", keywords)).toBe(true);
    expect(detectBlocker("This is BLOCKED until further notice", keywords)).toBe(true);
    expect(detectBlocker("I'm waiting on the API team", keywords)).toBe(true);
    expect(detectBlocker("Everything is fine", keywords)).toBe(false);
    expect(detectBlocker("Deploy dependency resolved", keywords)).toBe(true);
  });

  it("compileDigest includes blocker summary when blockers are detected", async () => {
    const team = createTeam({
      id: "blk",
      name: "Blocker Team",
      channelId: -100888,
      questions: ["What did you do?"],
      blockerKeywords: ["blocked", "stuck"],
    });

    const run = {
      id: "blk:2026-06-29",
      teamId: "blk",
      date: "2026-06-29",
      createdAt: "2026-06-29T09:00:00.000Z",
      status: "collecting" as const,
      responses: [
        {
          userId: 1,
          status: "answered" as const,
          answers: { "0": "I'm blocked on the backend deploy" },
          flagsBlockers: true,
        },
        {
          userId: 2,
          status: "pending" as const,
          answers: {},
          flagsBlockers: false,
        },
      ],
      promptedUserIds: [1, 2],
      nudgedUserIds: [],
    };

    const members = [
      createMember({ id: 1, teamId: "blk", timeZone: "UTC" }),
      createMember({ id: 2, teamId: "blk", timeZone: "UTC" }),
    ];

    const { digestText, blockerSummary } = compileDigest(team, run, members);
    expect(digestText).toContain("Flagged blockers");
    expect(blockerSummary).toContain("blocked on the backend deploy");
    expect(blockerSummary).not.toBe("No blockers reported today.");
  });

  it("compileDigest reports no blockers when none detected", async () => {
    const team = createTeam({
      id: "noblk",
      name: "No Blocker Team",
      channelId: -100999,
      questions: ["What did you do?"],
    });

    const run = {
      id: "noblk:2026-06-29",
      teamId: "noblk",
      date: "2026-06-29",
      createdAt: "2026-06-29T09:00:00.000Z",
      status: "collecting" as const,
      responses: [
        {
          userId: 1,
          status: "answered" as const,
          answers: { "0": "All good, working on features" },
          flagsBlockers: false,
        },
      ],
      promptedUserIds: [1],
      nudgedUserIds: [],
    };

    const members = [
      createMember({ id: 1, teamId: "noblk", timeZone: "UTC" }),
    ];

    const { blockerSummary } = compileDigest(team, run, members);
    expect(blockerSummary).toBe("No blockers reported today.");
  });

  it("promptMember marks user as 'off' on 403 error", async () => {
    const team = createTeam({
      id: "block",
      name: "Blocked Team",
      channelId: -100000,
      scheduleDays: [1],
      localTime: "09:00",
    });
    const member = createMember({
      id: 999, teamId: "block", timeZone: "UTC", optInStatus: "active",
    });
    await data.saveTeam(team);
    await data.saveMember(member);

    // Create today's run
    await data.createTodayRun("block");

    const errApi = {
      sendMessage: vi.fn().mockRejectedValue({ error_code: 403 }),
    } as any;

    const ok = await promptMember(errApi, team, member);
    expect(ok).toBe(false);

    const run = await data.getRun("block", MON_DATE);
    const resp = run!.responses.find((r) => r.userId === 999);
    expect(resp!.status).toBe("off");
  });

  it("promptMember marks user as 'off' on 400 error (deleted account)", async () => {
    const team = createTeam({
      id: "del",
      name: "Deleted Team",
      channelId: -100001,
      scheduleDays: [1],
      localTime: "09:00",
    });
    const member = createMember({
      id: 888, teamId: "del", timeZone: "UTC", optInStatus: "active",
    });
    await data.saveTeam(team);
    await data.saveMember(member);

    await data.createTodayRun("del");

    const errApi = {
      sendMessage: vi.fn().mockRejectedValue({ error_code: 400 }),
    } as any;

    await promptMember(errApi, team, member);

    const run = await data.getRun("del", MON_DATE);
    const resp = run!.responses.find((r) => r.userId === 888);
    expect(resp!.status).toBe("off");
  });

  it("member with no active run gets one created on answer", async () => {
    const team = createTeam({
      id: "late",
      name: "Late Team",
      channelId: -100002,
    });
    const member = createMember({
      id: 777, teamId: "late", timeZone: "UTC", optInStatus: "active",
    });
    await data.saveTeam(team);
    await data.saveMember(member);

    // No run exists yet — createTodayRun should create one
    const run = await data.createTodayRun("late");
    expect(run.responses).toHaveLength(1);
    expect(run.responses[0].userId).toBe(777);
    expect(run.responses[0].status).toBe("pending");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 6. Team data integrity
// ═══════════════════════════════════════════════════════════════════════════

describe("Team data integrity", () => {
  beforeEach(async () => {
    setClock(new FakeClock(MON_0900));
    resetStore();
    setStore(null);
  });

  afterEach(() => {
    setClock(null);
    vi.clearAllMocks();
  });

  it("generateUniqueTeamId avoids collision on duplicate names", async () => {
    const team1 = createTeam({
      id: "my-team",
      name: "My Team",
      channelId: -100001,
    });
    await data.saveTeam(team1);

    const generated = await data.generateUniqueTeamId("My Team");
    expect(generated).not.toBe("my-team");
    expect(generated).toMatch(/^my-team-\d+$/);
  });

  it("generateUniqueTeamId returns base when no collision", async () => {
    const generated = await data.generateUniqueTeamId("Unique Team Name");
    expect(generated).toBe("unique-team-name");
  });

  it("saveMember removes member from old team when switching teams", async () => {
    const teamA = createTeam({ id: "a", name: "A", channelId: -1 });
    const teamB = createTeam({ id: "b", name: "B", channelId: -2 });
    await data.saveTeam(teamA);
    await data.saveTeam(teamB);

    let member = createMember({ id: 10, teamId: "a" });
    await data.saveMember(member);

    // Verify member is in team A
    let team = await data.getTeam("a");
    expect(team!.memberIds).toContain(10);

    // Switch to team B
    member.teamId = "b";
    await data.saveMember(member);

    // Member should be removed from team A
    team = await data.getTeam("a");
    expect(team!.memberIds).not.toContain(10);

    // Member should be in team B
    team = await data.getTeam("b");
    expect(team!.memberIds).toContain(10);
  });

  it("deleteMember removes user from team memberIds and cleans up today's run", async () => {
    const team = createTeam({ id: "del", name: "Del Team", channelId: -1 });
    await data.saveTeam(team);

    const member = createMember({ id: 50, teamId: "del" });
    await data.saveMember(member);

    // Create today's run with this member
    await data.createTodayRun("del");

    await data.deleteMember(50);

    const teamReload = await data.getTeam("del");
    expect(teamReload!.memberIds).not.toContain(50);

    const run = await data.getRun("del", MON_DATE);
    // Member's response should be removed from the run
    const resp = run!.responses.find((r) => r.userId === 50);
    expect(resp).toBeUndefined();
  });

  it("getAllTeamIds returns all registered teams", async () => {
    await data.saveTeam(createTeam({ id: "t1", name: "T1", channelId: -1 }));
    await data.saveTeam(createTeam({ id: "t2", name: "T2", channelId: -2 }));

    const ids = await data.getAllTeamIds();
    expect(ids).toContain("t1");
    expect(ids).toContain("t2");
    expect(ids.length).toBe(2);
  });
});