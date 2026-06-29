# Async Standup Bot for Telegram — Bot specification

**Archetype:** workflow

**Voice:** professional and approachable — write every user-facing message, button label, error, and empty state in this voice.

Automates asynchronous daily standups for teams via Telegram. Sends private prompts to each member, collects answers, compiles a complete digest with blockers, and posts to a team channel. Supports time zones, nudges, skipping, and searchable history. Team members manage settings and membership directly.

> This is the complete contract for the bot. Implement EVERY entry point, flow, feature, integration, and edge case below. The completeness review checks the bot against this document after each build pass.

## Primary audience

- small-to-medium teams
- remote teams
- team managers

## Success criteria

- Daily standup digests posted to team channel with all responses or after cutoff
- Members can view past standups and recurring blockers via command
- Non-responders receive single nudge reminder
- Time zones respected for all member notifications

## Entry points

Every feature must be reachable from the bot's command/button surface (button-first; only /start and /help are slash commands).

- **/start** (command, actor: user, command: /start) — Open main menu with team dashboard, history, and settings
- **Start Standup** (button, actor: user, callback: standup:init) — Manually trigger immediate standup run for testing or overrides
- **View History** (button, actor: user, callback: history:show) — Request past standup digests and blocker reports
- **Manage Team** (button, actor: user, callback: team:settings) — Edit schedule, questions, or member roles

## Flows

### Daily Standup Run
_Trigger:_ scheduled cron job

1. Send prompts to active members at local time
2. Track responses/skips/off status
3. Send single nudge to non-responders after configured window
4. Compile digest at cutoff or when all respond
5. Post digest to team channel as single message

_Data touched:_ Team, Member, Standup run

### History Review
_Trigger:_ /history command

1. Request history period (7/30/90 days)
2. Generate digest list with clickable summaries
3. Show top recurring blockers report

_Data touched:_ History entry

### Settings Management
_Trigger:_ team:settings callback

1. Display current schedule/questions
2. Confirm changes via private message
3. Update persistent data

_Data touched:_ Team, Standup schedule, Questions set

## Data entities

Durable data (must survive a restart) uses the toolkit's persistent store, never in-memory maps.

- **Team** _(retention: persistent)_ — Telegram group with configured members and channel
  - fields: name, telegram_channel_id, schedule_days, local_time, cutoff_window, questions
- **Member** _(retention: persistent)_ — Team participant with preferences and status
  - fields: telegram_id, time_zone, opt_in_status, preferred_language
- **Standup run** _(retention: persistent)_ — Single day's standup execution
  - fields: date, responses, nudged_users, digest_content, blockers_flagged
- **History entry** _(retention: persistent)_ — Archived digest with metadata
  - fields: digest_text, participants, pending_list, blocker_summary

## Integrations

- **Telegram** (required) — Private prompts, channel digests, and settings confirmation messages
Call external APIs against their real contract (correct endpoints, ids, params); credentials from env. Do not fake responses.

## Owner controls

- Edit team schedule and questions
- Add/remove members
- View and search historical digests
- Configure cutoff windows and blocker keywords

## Notifications

- Private prompt messages with quick-reply buttons
- Single nudge reminder for non-responders
- Channel digest post with formatted answers and blockers

## Permissions & privacy

- Private messages only sent to active members
- Channel digests visible to team members only
- Time zone data stored securely per member
- Opt-in/off status respected for all interactions

## Edge cases

- Members without set time zones fall back to server time
- Digest compilation during DST transitions
- Cutoff time expiration while collecting responses
- Partial responses when some members skip

## Required tests

- End-to-end daily run with nudge and digest posting
- History retrieval with 7/30/90-day reports
- Time zone handling across global teams
- Settings changes confirmation flow

## Assumptions

- Default questions are editable by any team member
- Digest posting waits for full responses or cutoff
- Blocker detection uses both keyword matching and explicit flags
