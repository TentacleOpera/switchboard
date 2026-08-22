# Scheduled jobs get their own panel

## Goal

Move the scheduler out of the kanban AUTOMATION tab into its own shell panel (`jobs`), because recurring jobs and standing jobs are a different subsystem from board automation and are the only part of that tab missions do not supersede.

### Problem Analysis

The AUTOMATION tab mixes two unrelated things. Enumerated from `createAutobanPanel` (`kanban.html:11568`), its controls are:

| Control | What it answers |
|---|---|
| `DRAIN` / `WATCH` / `ON DONE` / `AGENT-MANAGED` modes | how to pick and pace work out of columns |
| `COLUMN RULES`, `QUEUE POP` | which columns advance, and when |
| `MAX BATCH SIZE`, `COMPLEXITY` | how much to take per sweep |
| `STARTS WITH`, `WAKE EVERY` | which agent, how often |
| **Recurring jobs (`fetch-plans`, `reconcile`)** | **a schedule, unrelated to the board's columns** |

Everything above the last row is column-sweeping configuration — the question missions answer by carrying explicit membership and a stream map (`staging-streams-parallel-dispatch-and-worktrees.md`, `scope-automation-to-missions.md`). The last row is a scheduler that happens to live in the same tab.

**The panel already admits they are different mechanisms.** Its own note reads: *"Recurring jobs (fetch-plans, reconcile) are paused while External mode is selected — external mode runs no clock. Switch back to Scheduled to re-arm them."* So a board-automation mode selection silently arms and disarms a scheduler, which is coupling with no reason behind it beyond shared tab real estate.

**And the scheduler is a substantial subsystem in its own right**, none of which has a home in the UI:
- `ScheduledJobsService` — writes reports, manages claim markers, lazily creates `.switchboard/orchestrator/reports/claimed/` and `.switchboard/teams/<teamId>/reports/claimed/`.
- **Standing jobs** in `.switchboard/instructions/standing/`, each a markdown file with `job:`, `schedule: <daily|hourly|…>`, `reads:` and `writes:` frontmatter — **user-authored**, not Switchboard's own automation.
- **The instruction inbox** at `.switchboard/instructions/inbox/`, with claim markers and a 24-hour claim window.
- **Declared board moves** at `.switchboard/instructions/moves/`, watched at `KanbanProvider.ts:945`.
- Run logs.

All of that is file-based, inspectable, and currently visible nowhere. A user's standing job runs, writes a report, and the only way to know is to read the filesystem.

### Root Cause

The scheduler was added where the existing clock lived. The AUTOMATION tab owned the only timer in the product, so anything with a cadence went there — and the tab became "things that happen without me" rather than a coherent surface.

## Metadata

**Complexity:** 4
**Tags:** ui, frontend, devops, reliability

## User Review Required

- **Panel name and scope.** `jobs` covers recurring jobs, standing jobs, the inbox and run history. Alternatives: `schedule` (narrower, excludes the inbox) or `jobs` including declared moves (wider). Recommending `jobs` with the inbox included, since a claimed inbox item and a standing job share the claim/report mechanics.
- **Does this panel also own the inbox as a write surface?** Reading it is clearly useful. Letting a user *place* an instruction there is a different feature and probably belongs later.

## Complexity Audit

### Routine

- A new panel: `jobs.html` + `jobs.js`, a `getPanelsManifest` entry (`headlessPanelHtml.ts:511`), a `getPanelHtmlById` case, and a `LocalApiServer` route. `shell.html` renders the rail icon from the manifest with no edit.
- Moving the recurring-jobs controls out of `createAutobanPanel`.

### Complex / Risky

- **Standing jobs are user-authored and must not be treated as product config.** A panel that offers to "turn off" a standing job is editing the user's file. Read, show status and last run, and surface the file path — but any mutation needs to be an explicit file edit, not a toggle that rewrites frontmatter behind the user's back.
- **The mode/scheduler coupling must be cut, not carried across.** Today selecting External mode pauses recurring jobs. If the panel ships while that coupling stands, a user disarms their scheduler by changing a board setting in a different panel — worse than the current single-tab version, because the cause is now invisible.
- **Claim markers make "is this running" ambiguous.** A claim is active for 24 hours; an older one means the item is `stuck` and retryable. The panel must show *claimed-and-live* separately from *claimed-and-stale*, or a stuck job reads as a running one. This is the display detail that decides whether the panel is useful or misleading.
- **Two report directories, not one.** `.switchboard/orchestrator/reports/` and `.switchboard/teams/<teamId>/reports/` both exist (`ScheduledJobsService:175`, `:194`). A panel showing only the first hides team-scoped reports.
- **Do not build a second scheduler.** The panel is a view over `ScheduledJobsService`; cadence stays where it is.

## Edge-Case & Dependency Audit

**Migration.** None. No stored state moves — the panel reads what already exists on disk and in config.

**Security.** Read-only over `.switchboard/instructions/**` and the report directories. Report bodies are agent-written text: render as text, never as HTML. Same rule as the Orders tab.

**Side effects.** The AUTOMATION tab loses its recurring-jobs section. If `scope-automation-to-missions.md` has not landed, the tab keeps its mode machinery and simply gets smaller.

**Ordering.** Independent of missions. Shippable now, and worth shipping before the tab is emptied so the scheduler has somewhere to be.

## Dependencies

- **Pairs with** `scope-automation-to-missions.md`, which handles what missions supersede. This plan takes only what they do not.
- **Precedent:** `extract-agent-control-into-its-own-panel-file.md` documents the panel-registration path and the companion-`.js` convention. Follow it; do not repeat the `data-view` projection that plan exists to undo.
- Independent of the missions work.

## Adversarial Synthesis

**"The AUTOMATION tab works — splitting it is churn."** It couples a board setting to a scheduler for no reason but shared real estate: change a mode and a user's recurring jobs silently disarm. And after missions land, the tab's remaining content is *only* the scheduler, so the split is the difference between one coherent panel and a tab named after a concept the product no longer uses.

**"Put scheduled jobs in Setup."** Setup is configuration; jobs have state — last run, claimed, stuck, reports. A surface with live state does not belong in a settings tab, which is how it ended up beside the automation modes in the first place.

**"Wait for missions, then decide."** The scheduler is unrelated to missions and invisible today. Its panel is useful before missions and unchanged after.

## Proposed Changes

1. **New `jobs` panel** — `jobs.html` + `jobs.js`, manifest entry, `getPanelHtmlById` case, route. Companion-`.js` convention.
2. **Show standing jobs** from `.switchboard/instructions/standing/`: name, schedule, `reads`/`writes`, last run, file path. Read-only.
3. **Show the inbox** with claim state, distinguishing **claimed-and-live** from **claimed-and-stale** (>24h ⇒ `stuck`).
4. **Show recurring jobs** (`fetch-plans`, `reconcile`) with their cadence and last run, moved out of `createAutobanPanel`.
5. **Show run history** from **both** report directories — orchestrator and per-team.
6. **Cut the mode/scheduler coupling**: a board-automation mode selection must not arm or disarm recurring jobs.
7. **Report bodies render as text**, never HTML.

### Migration

None.

## Verification Plan

### Goal Invariants

- Standing jobs, the inbox, recurring jobs and run history are all visible in one panel.
- No board-automation setting arms or disarms a scheduler.
- No panel action rewrites a user-authored standing job.
- A stale claim is distinguishable from a live one.

### Automated Tests

- **Coupling cut:** change the board automation mode; assert recurring-job arming is unaffected. This is the behaviour that is wrong today, so it is the test that proves the split did something rather than just moving markup.
- **Stale vs live claim:** seed a claim marker 25 hours old and one 1 hour old; assert they render distinctly. Without this the panel reports a stuck job as running, which is worse than no panel.
- **Both report directories:** seed a report under the orchestrator path and one under a team path; assert both appear.
- **Standing jobs are read-only:** assert no panel path writes to `.switchboard/instructions/standing/`.
- **Report bodies are text:** seed a report containing `<script>`; assert it renders literally.
- **Panel registered in both hosts:** assert `/jobs` serves over HTTP and the rail icon comes from the manifest with no `shell.html` edit.

### Manual Verification

- Open the panel with a standing job configured and confirm its schedule and last run read correctly.
- Confirm the AUTOMATION tab no longer shows recurring jobs and says nothing that implies it still governs them.

## Outstanding Questions

- **[user]** Panel name — `jobs`, `schedule`, or something else?
- **[user]** Does the panel show declared board moves (`.switchboard/instructions/moves/`) too? They are instruction-shaped and file-based like the rest, but they are a write channel for agents rather than a schedule.
- Is there an existing plan for this? `scheduled-automation-targeted-at-a-team-lead.md` is in this directory and may overlap — worth reading before building, since two plans over one subsystem is how the standing-orders contradiction happened.
