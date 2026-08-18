# Scheduled Automation Targeted at a Team Lead

## Goal
Let an operator attach a recurring automation to a specific team's lead — and trigger it on demand from the team cockpit. Scheduled work currently cannot address a team at all: it spawns its own anonymous terminal, outside any team, with no way to say "run this on *that* lead".

### The problem, and the root cause
The scheduler still ticks, but its targeting was gutted and never rebuilt.

`_tickSurvivorSchedulerJobs` (`src/services/TaskViewerProvider.ts:26472`) is the surviving clock. Its own comment (`TaskViewerProvider.ts:26475`) states the position plainly: *"`job.target` is vestigial: the target picker is deleted and the external-handoff surface (COPY PROMPT) went with it, so a stale 'antigravity'/'cloud' target has nowhere else to go. Local terminal is the only target now, for every surviving job."* The `target` field is still on the type (`GlobalIntegrationConfigService.ts:50`) and still persisted, but nothing reads it.

Worse for teams: delivery spawns a **fresh, unaffiliated terminal**. `_ensureSurvivorTerminal` (`TaskViewerProvider.ts:26440`) calls `vscode.window.createTerminal`, waits 2s, sends a startup command, waits 3s, and sends the prompt. That terminal belongs to no team, carries no team standing orders, and appears in no team's roster. So even today's working automations cannot be *about* a team — they run beside it.

Two further constraints shape any fix:
- **`source: 'custom'` is unusable.** `DROPPED_SOURCES` (`GlobalIntegrationConfigService.ts:481`) filters `comms`, `board-batch` and `custom` out on every read. A team job typed as `custom` would silently vanish on the next config read — no error, no job. A new source id is required.
- **The tick filters by an allowlist.** `survivorSources` is `new Set(['fetch-plans', 'reconcile'])` (`TaskViewerProvider.ts:26478`). A new source that is not added there is stored, enabled, and never fires.

The resolver needed to target a lead already exists and is unused by this path: `resolveTeamScopedRoleTerminal` (`src/services/teamWiring.ts:1412`) resolves a role within a team's registered roster, reading `terminals.groups` as the authoritative membership record.

## Metadata
- **Complexity:** 6
- **Tags:** backend, frontend, api, devops, feature

## Dependencies
- **Team identity foundation** — a stable `groupId`/`head` to target and to survive a re-spawn.
- **Team cockpit** — the surface for the per-team automation list and the run-now button.

## Approach

### 1. A real target, typed and honoured
Extend `ScheduledJob`:
- `source: … | 'team-automation'` — a new id, deliberately **not** `custom`, and deliberately absent from `DROPPED_SOURCES`.
- `teamTarget?: { groupId: string; role?: string }` — a new optional field rather than an overload of the vestigial `target` string. `target` stays untouched and unread; do not repurpose a field the codebase has already documented as dead, and do not delete it either (it is persisted on shipped installs, and `loadGlobal`/`saveGlobal` round-trip unknown keys — leave it inert, as the module already does for the legacy `mcpMonitor` blob, `GlobalIntegrationConfigService.ts:506`).
- Omitting `role` means the head.

Do **not** bump `SCHEDULER_SCHEMA_VERSION`. The change is purely additive, old code ignores unknown fields, and the forward-compat branch at `GlobalIntegrationConfigService.ts:500` warns and returns as-is for a newer version — bumping would make every older install log that warning for no benefit.

### 2. Deliver into the team, not beside it
Add a delivery arm that resolves the target through `resolveTeamScopedRoleTerminal` (`teamWiring.ts:1412`) and sends via the fleet path, so the prompt lands in the real lead terminal with the team's standing orders applied. The pattern to copy is `_tryFleetDeliveryForRole`, already used by the Project Manager dispatch (`TaskViewerProvider.ts`, `_deliverPromptToPmTerminal`) — it resolves registered-then-open-by-name and falls back rather than spawning.

Resolution order, and what each failure means:
1. Team's registered roster → the named role (or `head`) → live terminal. Send.
2. Roster resolves but the terminal is dead. **Do not spawn a replacement.** Skip the run and record "lead not live" — silently starting an unaffiliated terminal is the exact behaviour being fixed.
3. Team not registered (never started, or group deleted). Skip and surface it.

`_ensureSurvivorTerminal`'s spawn-a-terminal behaviour stays for the two existing sources (`fetch-plans`, `reconcile`) — they are workspace-level jobs with no team, and changing them is out of scope.

### 3. Wire the tick
- Add `'team-automation'` to `survivorSources` (`TaskViewerProvider.ts:26478`).
- Keep the per-job in-flight guard (`_schedulerInFlight`) and keep claiming it **before the first await** — the comment at `TaskViewerProvider.ts:26491` records that `_ensureSurvivorTerminal` can spend ~5s booting a CLI, long enough for a second tick to spawn a duplicate. The team arm is faster but the guard costs nothing and the hazard is identical.
- Prompt resolution keeps existing precedence exactly: `promptOverride` first, then the source preset (`TaskViewerProvider.ts:26483`). Add a `buildTeamAutomationPrompt` preset in `src/services/schedulerPresets.ts` alongside the two that live there, and have it include `BOARD_DRIVING_CONTRACT` (`schedulerPresets.ts:19`) if the automation may move cards — that constant exists so every board-driving prompt carries one copy of the `move-card.js`-not-SQL rule.

### 4. UI: per-team automations in the cockpit
In the team cockpit:
- List automations whose `teamTarget.groupId` is this team: label, interval, enabled, last run, last outcome.
- Add / edit / enable / disable / delete. Delete acts immediately, no confirm gate.
- **RUN NOW** — fire the job once, off-schedule, against the resolved target. This is the control the original complaint named, and it is worth having even for a job whose schedule is disabled.
- Show the resolved target explicitly ("→ `lead-1` (head)") or the reason it cannot resolve. A schedule pointing at a dead lead must look broken in the UI, not just fail quietly at 3am.

Interval granularity: reuse `intervalMinutes` as-is. Do not introduce cron here — the run-sheet clock is interval-based and a second scheduling vocabulary is a bigger change than this plan.

### 5. Report outcomes
The old per-job output-capture watcher is gone; `buildFetchPlansPrompt` still writes `.switchboard/scheduler-<job.id>-latest.md` as an inert artifact with no consumer (`schedulerPresets.ts:24`). Rather than resurrect a watcher, record run outcomes where the cockpit can read them: last-run timestamp, resolved target, and skip reason, in the job's own config or a small per-team run log. An automation with no visible history is one the operator cannot trust.

## Edge cases
- **Team re-spawned between ticks.** Member names change; `groupId` does not. Resolving through the roster each tick (never caching a terminal name in the job) is what makes this correct — this is precisely why the job stores `groupId` and not a terminal name.
- **Two teams, same head role.** `startTeamById` refuses a second live head for a role (`teamWiring.ts:805`), so within a workspace this cannot collide. Across workspaces, `groupId` disambiguates.
- **Group deleted, job left behind.** Job stays stored and inert, showing "team not registered". Do not auto-delete the job — an operator who deletes a group record has not asked to lose their automation.
- **Lead busy.** Respect the same idle check the team queue uses; if a queue exists for the team, enqueue instead of pasting into a working agent. If not, skip this run rather than interrupting.
- **`role` naming a member that does not exist in the roster.** Skip with a clear reason. Do not silently fall back to the head — an operator who typed `reviewer` did not mean the lead.
- **Job enabled while no team has ever started.** Ticks resolve nothing and skip. Cheap, and it must not spawn anything.
- **`DROPPED_SOURCES` regression risk.** If anyone later adds `team-automation` to that set, every team automation disappears on read with no error. Add a test asserting `team-automation` is not filtered, so the failure is caught rather than discovered.

## Verification Plan
1. `npm run compile` — clean.
2. Unit: a `team-automation` job survives `_ensureSchedulerMigration` / `_filterDroppedSources` round-tripping (the `DROPPED_SOURCES` regression guard).
3. Unit: `schemaVersion` is unchanged by this feature, and a config carrying `teamTarget` loads on the current schema version without warnings.
4. Unit: target resolution — head by default; named role when given; "not live" when the terminal is dead; "not registered" when the group is absent; "no such role" when the role is not in the roster. Assert **no terminal is created** in any failure arm.
5. Unit: the tick includes `team-automation` and honours `promptOverride` over the preset.
6. Unit: the in-flight guard prevents a second concurrent run of the same job.
7. Unit: `buildTeamAutomationPrompt` includes `BOARD_DRIVING_CONTRACT` when board-moving is enabled for the job.
8. Manual, installed VSIX: create an automation on a live team's lead, RUN NOW → the prompt lands in the actual lead terminal, with the team's standing-orders block appended, and no new terminal appears anywhere.
9. Manual: set a short interval, confirm it fires on the clock, and confirm last-run/outcome updates in the cockpit.
10. Manual: kill the lead, wait for a tick → the run is skipped, the cockpit shows "lead not live", and no unaffiliated terminal is spawned. Restart the team → the next tick resolves and delivers.
11. Manual: re-spawn the team so member names change → the automation still resolves via `groupId`.
12. Regression: the two existing sources (`fetch-plans`, `reconcile`) still tick and still spawn their own terminals exactly as before.
