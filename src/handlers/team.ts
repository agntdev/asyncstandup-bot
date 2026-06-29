import { Composer } from "grammy";
import type { Ctx } from "../bot.js";
import {
  inlineButton,
  inlineKeyboard,
  registerMainMenuItem,
} from "../toolkit/index.js";
import * as data from "../lib/data.js";
import { todayDate, compileAndPostDigest } from "../lib/standup.js";
import {
  createTeam,
  createMember,
  type Team,
} from "../lib/types.js";
import { COMMON_TIMEZONES } from "../lib/timezone.js";

registerMainMenuItem({
  label: "⚙️ Manage Team",
  data: "team:settings",
  order: 30,
});

const BACK_ROW = [inlineButton("⬅️ Back to menu", "menu:main")];

const composer = new Composer<Ctx>();

// ── Team: main settings view ─────────────────────────────────────────────

composer.callbackQuery("team:settings", async (ctx) => {
  await ctx.answerCallbackQuery();
  const userId = ctx.from!.id;
  const teamId = await data.getUserTeamId(userId);

  if (!teamId) {
    await ctx.editMessageText(
      "You're not in a team yet. Would you like to create one or join an existing team?",
      {
        reply_markup: inlineKeyboard([
          [inlineButton("✨ Create team", "team:create")],
          [inlineButton("🔗 Join with code", "team:join:prompt")],
          BACK_ROW,
        ]),
      },
    );
    return;
  }

  const team = await data.getTeam(teamId);
  if (!team) {
    await ctx.editMessageText(
      "Your team couldn't be found. It may have been removed.",
      { reply_markup: inlineKeyboard([BACK_ROW]) },
    );
    return;
  }

  const memberCount = team.memberIds.length;
  const scheduleDays = team.scheduleDays
    .map((d) =>
      ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][d],
    )
    .join(", ");

  const text =
    `⚙️ **${team.name}**\n\n` +
    `Schedule: ${scheduleDays} at ${team.localTime}\n` +
    `Cutoff: ${team.cutoffWindowMinutes} min after prompt\n` +
    `Questions: ${team.questions.length}\n` +
    `Members: ${memberCount}\n` +
    `Channel ID: ${team.channelId}\n\n` +
    `Tap a setting to change it, or share your team code with teammates.`;

  await ctx.editMessageText(text, {
    reply_markup: inlineKeyboard([
      [inlineButton("📝 Edit questions", "team:edit:questions")],
      [inlineButton("📅 Edit schedule", "team:edit:schedule")],
      [inlineButton("🕐 Edit local time", "team:edit:localtime")],
      [inlineButton("⏱️ Edit cutoff", "team:edit:cutoff")],
      [inlineButton("🔑 Edit blocker words", "team:edit:blockers")],
      [inlineButton("👥 Manage members", "team:members")],
      [inlineButton("🔗 Team invite code", "team:invite")],
      BACK_ROW,
    ]),
  });
});

// ── Create team flow ─────────────────────────────────────────────────────

composer.callbackQuery("team:create", async (ctx) => {
  await ctx.answerCallbackQuery();
  ctx.session.teamSetupStep = "create:awaiting_name";
  ctx.session.teamSetupData = {};

  await ctx.reply(
    "✨ Let's set up your team!\n\nFirst, what's your team called?",
    {
      reply_markup: { force_reply: true, input_field_placeholder: "e.g. Engineering, Design" },
    },
  );
});

composer.on("message:text", async (ctx, next) => {
  const step = ctx.session.teamSetupStep;
  if (!step || !step.startsWith("create:")) return next();
  if (!ctx.message?.text) return next();

  if (step === "create:awaiting_name") {
    const name = ctx.message.text.trim();
    if (name.length < 2) {
      await ctx.reply("Name too short — try again with at least 2 characters.");
      return;
    }
    ctx.session.teamSetupStep = "create:awaiting_channel";
    (ctx.session.teamSetupData ??= {})["name"] = name;

    await ctx.reply(
      "Got it! Now send me the Telegram channel ID where digests will be posted.\n\n" +
        "The channel ID is a negative number (e.g. -1001234567890). " +
        "You can get it by forwarding a message from the channel to @RawDataBot.",
      {
        reply_markup: {
          force_reply: true,
          input_field_placeholder: "e.g. -1001234567890",
        },
      },
    );
    return;
  }

  if (step === "create:awaiting_channel") {
    const channelId = parseInt(ctx.message.text.trim(), 10);
    if (isNaN(channelId)) {
      await ctx.reply(
        "That doesn't look like a valid channel ID. It should be a number like -1001234567890. Try again.",
      );
      return;
    }

    const name = (ctx.session.teamSetupData ?? {})["name"] as string;
    const teamId = name.toLowerCase().replace(/[^a-z0-9]/g, "-").slice(0, 32);

    const team = createTeam({
      id: teamId,
      name,
      channelId,
    });

    await data.saveTeam(team);
    await data.setTeamChannel(teamId, channelId);

    const userId = ctx.from!.id;
    const member = createMember({ id: userId, teamId });
    await data.saveMember(member);
    await data.setUserTeam(userId, teamId);

    team.memberIds.push(userId);
    await data.saveTeam(team);

    ctx.session.teamSetupStep = undefined;
    ctx.session.teamSetupData = undefined;

    await ctx.reply(
      `✅ Team "${name}" is all set!\n\n` +
        `Your team code is: \`${teamId}\`\n` +
        `Share this with teammates — they can join by tapping the Manage Team menu and entering the code.\n\n` +
        `Your invite link: t.me/${ctx.me.username}?start=${teamId}`,
      { reply_markup: inlineKeyboard([BACK_ROW]) },
    );
    return;
  }

  return next();
});

// ── Join team with code ──────────────────────────────────────────────────

composer.callbackQuery("team:join:prompt", async (ctx) => {
  await ctx.answerCallbackQuery();
  ctx.session.teamSetupStep = "join:awaiting_code";
  ctx.session.teamSetupData = {};

  await ctx.reply(
    "🔗 Enter the team code your admin shared with you:",
    {
      reply_markup: {
        force_reply: true,
        input_field_placeholder: "e.g. my-team",
      },
    },
  );
});

composer.on("message:text", async (ctx, next) => {
  if (ctx.session.teamSetupStep !== "join:awaiting_code") return next();
  if (!ctx.message?.text) return next();

  const code = ctx.message.text.trim().toLowerCase();

  const team = await data.getTeam(code);
  if (!team) {
    await ctx.reply(
      "Couldn't find a team with that code. Check the spelling and try again, or ask your admin for the right code.",
      {
        reply_markup: {
          force_reply: true,
          input_field_placeholder: "e.g. my-team",
        },
      },
    );
    return;
  }

  const userId = ctx.from!.id;
  const existingMember = await data.getMember(userId);
  if (existingMember && existingMember.teamId === code) {
    ctx.session.teamSetupStep = undefined;
    ctx.session.teamSetupData = undefined;
    await ctx.reply(
      `You're already a member of "${team.name}"!`,
      { reply_markup: inlineKeyboard([BACK_ROW]) },
    );
    return;
  }

  const member = createMember({ id: userId, teamId: code });
  await data.saveMember(member);
  await data.setUserTeam(userId, code);

  if (!team.memberIds.includes(userId)) {
    team.memberIds.push(userId);
    await data.saveTeam(team);
  }

  ctx.session.teamSetupStep = undefined;
  ctx.session.teamSetupData = undefined;

  await ctx.reply(
    `✅ You've joined "${team.name}"!\n\nHead back to the menu to start a standup or check the history.`,
    { reply_markup: inlineKeyboard([BACK_ROW]) },
  );
});

// ── Edit questions ───────────────────────────────────────────────────────

composer.callbackQuery("team:edit:questions", async (ctx) => {
  await ctx.answerCallbackQuery();
  const userId = ctx.from!.id;
  const teamId = await data.getUserTeamId(userId);
  if (!teamId) return;

  const team = await data.getTeam(teamId);
  if (!team) return;

  const qText = team.questions.map((q, i) => `${i + 1}. ${q}`).join("\n");

  await ctx.editMessageText(
    `Current questions:\n\n${qText}\n\nTo change them, send the new questions separated by a blank line (one per paragraph). Type /cancel to abort.`,
    {
      reply_markup: inlineKeyboard([
        [inlineButton("🔙 Cancel", "team:settings")],
      ]),
    },
  );

  ctx.session.teamSetupStep = "edit:awaiting_questions";
  ctx.session.teamSetupData = { teamId };
});

composer.on("message:text", async (ctx, next) => {
  if (ctx.session.teamSetupStep !== "edit:awaiting_questions") return next();
  if (!ctx.message?.text) return next();

  const teamId = (ctx.session.teamSetupData ?? {})["teamId"] as string;
  if (!teamId) return next();

  const team = await data.getTeam(teamId);
  if (!team) {
    ctx.session.teamSetupStep = undefined;
    ctx.session.teamSetupData = undefined;
    await ctx.reply("Team not found.");
    return;
  }

  const text = ctx.message.text.trim();
  const newQuestions = text
    .split(/\n{2,}/)
    .map((q) => q.trim())
    .filter((q) => q.length > 0);

  if (newQuestions.length === 0) {
    await ctx.reply(
      "Please send at least one question. Separate questions with a blank line.",
      {
        reply_markup: {
          force_reply: true,
          input_field_placeholder: "Question 1\n\nQuestion 2\n\nQuestion 3",
        },
      },
    );
    return;
  }

  team.questions = newQuestions;
  await data.saveTeam(team);

  ctx.session.teamSetupStep = undefined;
  ctx.session.teamSetupData = undefined;

  await ctx.reply(
    `✅ Questions updated! Now ${newQuestions.length} question(s):\n\n` +
      newQuestions.map((q, i) => `${i + 1}. ${q}`).join("\n"),
    { reply_markup: inlineKeyboard([BACK_ROW]) },
  );
});

// ── Edit schedule ────────────────────────────────────────────────────────

composer.callbackQuery("team:edit:schedule", async (ctx) => {
  await ctx.answerCallbackQuery();
  const userId = ctx.from!.id;
  const teamId = await data.getUserTeamId(userId);
  if (!teamId) return;

  const team = await data.getTeam(teamId);
  if (!team) return;

  await ctx.editMessageText(
    "Which days should standups run? Tap a day to toggle it on or off.",
    {
      reply_markup: buildScheduleKeyboard(team),
    },
  );
});

function buildScheduleKeyboard(team: Team) {
  const dayNames = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const rows = dayNames.map((name, i) => {
    const active = team.scheduleDays.includes(i);
    return [
      inlineButton(
        `${active ? "✅" : "⬜"} ${name}`,
        `team:toggle:day:${i}`,
      ),
    ];
  });
  rows.push([inlineButton("💾 Done", "team:schedule:done")]);
  rows.push(BACK_ROW);
  return inlineKeyboard(rows);
}

composer.callbackQuery(/^team:toggle:day:(\d)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const userId = ctx.from!.id;
  const teamId = await data.getUserTeamId(userId);
  if (!teamId) return;

  const team = await data.getTeam(teamId);
  if (!team) return;

  const day = parseInt(ctx.match![1], 10);
  if (team.scheduleDays.includes(day)) {
    team.scheduleDays = team.scheduleDays.filter((d) => d !== day);
  } else {
    team.scheduleDays.push(day);
    team.scheduleDays.sort((a, b) => a - b);
  }
  await data.saveTeam(team);

  try {
    await ctx.editMessageReplyMarkup({
      reply_markup: buildScheduleKeyboard(team),
    });
  } catch {
    // message may have been deleted — ignore
  }
});

composer.callbackQuery("team:schedule:done", async (ctx) => {
  await ctx.answerCallbackQuery();
  const userId = ctx.from!.id;
  const teamId = await data.getUserTeamId(userId);
  if (!teamId) return;

  const team = await data.getTeam(teamId);
  const days = team?.scheduleDays
    .map((d) => ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][d])
    .join(", ");

  await ctx.editMessageText(
    `✅ Schedule updated: ${days || "no days selected"}\n\nBack to settings:`,
    {
      reply_markup: inlineKeyboard([
        [inlineButton("⚙️ Back to settings", "team:settings")],
      ]),
    },
  );
});

// ── Edit local time ──────────────────────────────────────────────────────

composer.callbackQuery("team:edit:localtime", async (ctx) => {
  await ctx.answerCallbackQuery();
  const userId = ctx.from!.id;
  const teamId = await data.getUserTeamId(userId);
  if (!teamId) return;

  ctx.session.teamSetupStep = "edit:awaiting_localtime";
  ctx.session.teamSetupData = { teamId };

  await ctx.reply(
    "What time should standup prompts go out each day?\n\n" +
      "Send the time in 24-hour format (e.g. 09:00, 14:30):",
    {
      reply_markup: {
        force_reply: true,
        input_field_placeholder: "e.g. 09:00",
      },
    },
  );
});

// Handle local time input
composer.on("message:text", async (ctx, next) => {
  if (ctx.session.teamSetupStep !== "edit:awaiting_localtime") return next();
  if (!ctx.message?.text) return next();

  const teamId = (ctx.session.teamSetupData ?? {})["teamId"] as string;
  if (!teamId) return next();

  const raw = ctx.message.text.trim();
  const match = raw.match(/^([01]\d|2[0-3]):([0-5]\d)$/);
  if (!match) {
    await ctx.reply(
      "That doesn't look like a valid 24-hour time. Use HH:MM format (e.g. 09:00, 14:30).",
      {
        reply_markup: {
          force_reply: true,
          input_field_placeholder: "e.g. 09:00",
        },
      },
    );
    return;
  }

  const localTime = match[0];
  const team = await data.getTeam(teamId);
  if (team) {
    team.localTime = localTime;
    await data.saveTeam(team);
  }

  ctx.session.teamSetupStep = undefined;
  ctx.session.teamSetupData = undefined;

  await ctx.reply(
    `✅ Standup prompt time set to ${localTime} local time.`,
    { reply_markup: inlineKeyboard([BACK_ROW]) },
  );
});

// ── Edit cutoff ──────────────────────────────────────────────────────────

composer.callbackQuery("team:edit:cutoff", async (ctx) => {
  await ctx.answerCallbackQuery();
  const userId = ctx.from!.id;
  const teamId = await data.getUserTeamId(userId);
  if (!teamId) return;

  ctx.session.teamSetupStep = "edit:awaiting_cutoff";
  ctx.session.teamSetupData = { teamId };

  await ctx.reply(
    "How many minutes after the standup prompt should the digest be compiled?\n\n" +
      "Send a number (e.g. 60, 90, 120):",
    {
      reply_markup: {
        force_reply: true,
        input_field_placeholder: "e.g. 120",
      },
    },
  );
});

composer.on("message:text", async (ctx, next) => {
  if (ctx.session.teamSetupStep !== "edit:awaiting_cutoff") return next();
  if (!ctx.message?.text) return next();

  const teamId = (ctx.session.teamSetupData ?? {})["teamId"] as string;
  if (!teamId) return next();

  const minutes = parseInt(ctx.message.text.trim(), 10);
  if (isNaN(minutes) || minutes < 5 || minutes > 480) {
    await ctx.reply(
      "Please send a number between 5 and 480 minutes.",
      {
        reply_markup: {
          force_reply: true,
          input_field_placeholder: "e.g. 120",
        },
      },
    );
    return;
  }

  const team = await data.getTeam(teamId);
  if (team) {
    team.cutoffWindowMinutes = minutes;
    await data.saveTeam(team);
  }

  ctx.session.teamSetupStep = undefined;
  ctx.session.teamSetupData = undefined;

  await ctx.reply(
    `✅ Cutoff window set to ${minutes} minutes.`,
    { reply_markup: inlineKeyboard([BACK_ROW]) },
  );
});

// ── Edit blocker keywords ─────────────────────────────────────────────────

composer.callbackQuery("team:edit:blockers", async (ctx) => {
  await ctx.answerCallbackQuery();
  const userId = ctx.from!.id;
  const teamId = await data.getUserTeamId(userId);
  if (!teamId) return;

  const team = await data.getTeam(teamId);
  if (!team) return;

  const kwText = team.blockerKeywords.length > 0
    ? team.blockerKeywords.map((kw) => `▸ ${kw}`).join("\n")
    : "No keywords set yet.";

  await ctx.editMessageText(
    `🔑 Current blocker keywords:\n\n${kwText}\n\n` +
      `To change them, send new keywords separated by commas or one per line. ` +
      `Type /cancel to abort.`,
    {
      reply_markup: inlineKeyboard([
        [inlineButton("🔙 Cancel", "team:settings")],
      ]),
    },
  );

  ctx.session.teamSetupStep = "edit:awaiting_blockers";
  ctx.session.teamSetupData = { teamId };
});

// Handle blocker keywords input
composer.on("message:text", async (ctx, next) => {
  if (ctx.session.teamSetupStep !== "edit:awaiting_blockers") return next();
  if (!ctx.message?.text) return next();

  const teamId = (ctx.session.teamSetupData ?? {})["teamId"] as string;
  if (!teamId) return next();

  const team = await data.getTeam(teamId);
  if (!team) {
    ctx.session.teamSetupStep = undefined;
    ctx.session.teamSetupData = undefined;
    await ctx.reply("Team not found.");
    return;
  }

  const text = ctx.message.text.trim();
  const newKeywords = text
    .split(/[\n,]+/)
    .map((kw) => kw.trim().toLowerCase())
    .filter((kw) => kw.length > 1);

  if (newKeywords.length === 0) {
    await ctx.reply(
      "Please send at least one keyword. Separate keywords with commas or one per line.",
      {
        reply_markup: {
          force_reply: true,
          input_field_placeholder: "blocker, stuck, waiting on, dependency",
        },
      },
    );
    return;
  }

  team.blockerKeywords = newKeywords;
  await data.saveTeam(team);

  ctx.session.teamSetupStep = undefined;
  ctx.session.teamSetupData = undefined;

  await ctx.reply(
    `✅ Blocker keywords updated! Now tracking ${newKeywords.length} keyword(s):\n\n` +
      newKeywords.map((kw) => `▸ ${kw}`).join("\n"),
    { reply_markup: inlineKeyboard([BACK_ROW]) },
  );
});

// ── Manage members ───────────────────────────────────────────────────────

composer.callbackQuery("team:members", async (ctx) => {
  await ctx.answerCallbackQuery();
  const userId = ctx.from!.id;
  const teamId = await data.getUserTeamId(userId);
  if (!teamId) return;

  const team = await data.getTeam(teamId);
  if (!team) return;

  const members = await data.getTeamMembers(teamId);
  if (members.length === 0) {
    await ctx.editMessageText(
      "No team members yet. Share your team code so others can join!",
      { reply_markup: inlineKeyboard([BACK_ROW]) },
    );
    return;
  }

  const memberRows = members.map((m) => {
    const status = m.optInStatus === "active" ? "✅" : m.optInStatus === "paused" ? "⏸️" : "⛔";
    return [
      inlineButton(
        `${status} Member #${m.id} (${m.optInStatus}, ${m.timeZone})`,
        `team:member:${m.id}`,
      ),
    ];
  });

  memberRows.push(BACK_ROW);

  await ctx.editMessageText(
    `👥 ${team.name} — ${members.length} member(s)\n\n` +
      `Tap a member to toggle status. Tap your own member to set your timezone.`,
    { reply_markup: inlineKeyboard(memberRows) },
  );
});

// ── Member card: toggle status, set timezone, or remove ──────────────────

composer.callbackQuery(/^team:member:(\d+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const memberId = parseInt(ctx.match![1], 10);
  const userId = ctx.from!.id;
  const teamId = await data.getUserTeamId(userId);
  if (!teamId) return;

  const member = await data.getMember(memberId);
  if (!member || member.teamId !== teamId) {
    await ctx.editMessageText("That member isn't in your team.");
    return;
  }

  // Show member detail with actions
  const statusEmoji = member.optInStatus === "active" ? "✅" : member.optInStatus === "paused" ? "⏸️" : "⛔";
  const statusLabel = member.optInStatus === "active" ? "Active — receives prompts" : member.optInStatus === "paused" ? "Paused — no prompts, no nudges" : "Off — excluded from standups";

  const rows: ReturnType<typeof inlineButton>[][] = [
    [inlineButton(
      `Toggle status (currently ${member.optInStatus})`,
      `team:member:toggle:${memberId}`,
    )],
  ];

  // Only show timezone + remove for own member or any member (owner controls)
  if (memberId === userId) {
    rows.push([
      inlineButton(`🕐 Set timezone (now: ${member.timeZone})`, `team:member:timezone:${memberId}`),
    ]);
  }

  // Any member of the team can remove any other member (team self-management)
  rows.push([
    inlineButton(`🗑️ Remove from team`, `team:member:remove:${memberId}`),
  ]);

  rows.push([inlineButton("⬅️ Back to members", "team:members")]);

  await ctx.editMessageText(
    `${statusEmoji} Member #${member.id}\n\n` +
      `Status: ${statusLabel}\n` +
      `Timezone: ${member.timeZone}\n` +
      `Joined: ${member.joinedAt.slice(0, 10)}\n\n` +
      `Choose an action:`,
    { reply_markup: inlineKeyboard(rows) },
  );
});

// ── Toggle member status ─────────────────────────────────────────────────

composer.callbackQuery(/^team:member:toggle:(\d+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const memberId = parseInt(ctx.match![1], 10);
  const userId = ctx.from!.id;
  const teamId = await data.getUserTeamId(userId);
  if (!teamId) return;

  const member = await data.getMember(memberId);
  if (!member || member.teamId !== teamId) {
    await ctx.editMessageText("Member not found.");
    return;
  }

  // Cycle: active → paused → off → active
  const next: Record<string, "active" | "paused" | "off"> = {
    active: "paused",
    paused: "off",
    off: "active",
  };

  member.optInStatus = next[member.optInStatus];
  await data.saveMember(member);

  // Refresh member list
  const members = await data.getTeamMembers(teamId);
  const memberRows = members.map((m) => {
    const status = m.optInStatus === "active" ? "✅" : m.optInStatus === "paused" ? "⏸️" : "⛔";
    return [
      inlineButton(
        `${status} Member #${m.id} (${m.optInStatus}, ${m.timeZone})`,
        `team:member:${m.id}`,
      ),
    ];
  });
  memberRows.push(BACK_ROW);

  await ctx.editMessageText(
    `👥 Team — ${members.length} member(s)\n\nTap a member to view details, toggle status, or set timezone.`,
    { reply_markup: inlineKeyboard(memberRows) },
  );
});

// ── Remove member ────────────────────────────────────────────────────────

composer.callbackQuery(/^team:member:remove:(\d+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const memberId = parseInt(ctx.match![1], 10);
  const userId = ctx.from!.id;
  const teamId = await data.getUserTeamId(userId);
  if (!teamId) return;

  const member = await data.getMember(memberId);
  if (!member || member.teamId !== teamId) {
    await ctx.editMessageText("Member not found.");
    return;
  }

  await data.deleteMember(memberId);

  // After removing a member, check if today's standup run is now unblocked
  // (the removed member's pending response was cleaned up by deleteMember).
  const date = todayDate();
  const run = await data.getRun(teamId, date);
  if (run && run.status === "collecting") {
    const allDone = run.responses.every((r) => r.status !== "pending");
    const team = await data.getTeam(teamId);
    if (allDone && run.responses.length > 0 && team) {
      try {
        await compileAndPostDigest(ctx.api, team);
      } catch (err) {
        console.error("Failed to compile digest after member removal:", err);
      }
    }
  }

  // If the member was removed, refresh the list
  const members = await data.getTeamMembers(teamId);
  if (members.length === 0) {
    await ctx.editMessageText(
      "Member removed. No team members left.",
      { reply_markup: inlineKeyboard([BACK_ROW]) },
    );
    return;
  }

  const memberRows = members.map((m) => {
    const status = m.optInStatus === "active" ? "✅" : m.optInStatus === "paused" ? "⏸️" : "⛔";
    return [
      inlineButton(
        `${status} Member #${m.id} (${m.optInStatus}, ${m.timeZone})`,
        `team:member:${m.id}`,
      ),
    ];
  });
  memberRows.push(BACK_ROW);

  await ctx.editMessageText(
    `🗑️ Member #${memberId} removed.\n\nTeam now has ${members.length} member(s).`,
    { reply_markup: inlineKeyboard(memberRows) },
  );
});

// ── Set member timezone ──────────────────────────────────────────────────

composer.callbackQuery(/^team:member:timezone:(\d+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const memberId = parseInt(ctx.match![1], 10);
  const userId = ctx.from!.id;
  const teamId = await data.getUserTeamId(userId);
  if (!teamId) return;

  const member = await data.getMember(memberId);
  if (!member || member.teamId !== teamId) {
    await ctx.editMessageText("Member not found.");
    return;
  }

  const memberTz = member.timeZone || "UTC";

  // Show button grid of common timezones
  const tzRows = COMMON_TIMEZONES.map((tz) => [
    inlineButton(
      `${tz.code === memberTz ? "✅ " : ""}${tz.label}`,
      `team:member:settzone:${memberId}:${tz.code}`,
    ),
  ]);

  // Add a custom text-input option
  tzRows.push([inlineButton("✏️ Type custom timezone...", `team:member:customtz:${memberId}`)]);

  await ctx.editMessageText(
    `🕐 Set timezone for Member #${member.id}\n\nCurrent: ${memberTz}\n\nPick one:`,
    { reply_markup: inlineKeyboard(tzRows) },
  );
});

// ── Apply timezone from button ───────────────────────────────────────────

composer.callbackQuery(/^team:member:settzone:(\d+):(.+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const memberId = parseInt(ctx.match![1], 10);
  const tzCode = ctx.match![2];
  const userId = ctx.from!.id;
  const teamId = await data.getUserTeamId(userId);
  if (!teamId) return;

  const member = await data.getMember(memberId);
  if (!member || member.teamId !== teamId) {
    await ctx.editMessageText("Member not found.");
    return;
  }

  member.timeZone = tzCode;
  await data.saveMember(member);

  // Confirm and return to members
  const tzLabel = COMMON_TIMEZONES.find((t) => t.code === tzCode)?.label ?? tzCode;
  await ctx.editMessageText(
    `✅ Timezone set to ${tzLabel} (${tzCode}) for Member #${member.id}.\n\nThey'll now receive standup prompts at the correct local time.`,
    { reply_markup: inlineKeyboard([
      [inlineButton("⬅️ Back to members", "team:members")],
      BACK_ROW,
    ]) },
  );
});

// ── Custom timezone input prompt ─────────────────────────────────────────

composer.callbackQuery(/^team:member:customtz:(\d+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const memberId = parseInt(ctx.match![1], 10);

  ctx.session.teamSetupStep = "member:awaiting_timezone";
  ctx.session.teamSetupData = { memberId: String(memberId) };

  await ctx.reply(
    "Enter an IANA timezone code (e.g. Europe/Paris, Asia/Tokyo, America/Chicago):",
    {
      reply_markup: {
        force_reply: true,
        input_field_placeholder: "e.g. Europe/Paris",
      },
    },
  );
});

// Handle custom timezone text input
composer.on("message:text", async (ctx, next) => {
  if (ctx.session.teamSetupStep !== "member:awaiting_timezone") return next();
  if (!ctx.message?.text) return next();

  const rawTz = ctx.message.text.trim();
  const memberId = parseInt((ctx.session.teamSetupData ?? {})["memberId"] as string, 10);
  const userId = ctx.from!.id;

  // Basic validation: try formatting with the timezone to verify it's valid
  try {
    Intl.DateTimeFormat(undefined, { timeZone: rawTz }).format();
  } catch {
    await ctx.reply(
      `"${rawTz}" doesn't look like a valid timezone. Try again with a standard IANA code like "Europe/London" or "America/New_York".`,
      {
        reply_markup: {
          force_reply: true,
          input_field_placeholder: "e.g. America/New_York",
        },
      },
    );
    return;
  }

  const teamId = await data.getUserTeamId(userId);
  if (!teamId) {
    ctx.session.teamSetupStep = undefined;
    ctx.session.teamSetupData = undefined;
    await ctx.reply("Team not found.");
    return;
  }

  const member = await data.getMember(memberId);
  if (!member || member.teamId !== teamId) {
    ctx.session.teamSetupStep = undefined;
    ctx.session.teamSetupData = undefined;
    await ctx.reply("Member not found.");
    return;
  }

  member.timeZone = rawTz;
  await data.saveMember(member);

  ctx.session.teamSetupStep = undefined;
  ctx.session.teamSetupData = undefined;

  await ctx.reply(
    `✅ Timezone set to ${rawTz} for Member #${member.id}.`,
    { reply_markup: inlineKeyboard([BACK_ROW]) },
  );
});

// ── Invite code ──────────────────────────────────────────────────────────

composer.callbackQuery("team:invite", async (ctx) => {
  await ctx.answerCallbackQuery();
  const userId = ctx.from!.id;
  const teamId = await data.getUserTeamId(userId);
  if (!teamId) return;

  const team = await data.getTeam(teamId);
  if (!team) return;

  const link = teamId;

  await ctx.editMessageText(
    `🔗 Share this with your teammates:\n\n` +
      `Invite link: t.me/${ctx.me.username}?start=${link}\n` +
      `Or tell them to enter this code: \`${teamId}\`\n\n` +
      `They can join by tapping Manage Team → Join with code.`,
    { reply_markup: inlineKeyboard([BACK_ROW]) },
  );
});

export default composer;