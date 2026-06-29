# Phase 2 (3/4): Continuous Sync Triggers + Remote-Tab Config & Controls

## Goal

Make codebase-docs → Notion sync (plans 1/4 + 2/4) actually *run* — on demand, on git commit, and on an optional timer — and give the user a control surface in the Kanban Remote tab to enable it, point it at a Notion location, set frequency, and trigger a manual sync, with progress/last-sync feedback.

### Problem & Background

Plans 1/4 and 2/4 produce a generator and a push pipeline but no caller. Without a trigger, the codebase docs in Notion go stale the moment the repo changes, defeating the "live codebase docs from Notion" outcome the epic specifies. There is a proven trigger precedent: the NotebookLM/Airlock export **already auto-runs on git commit** (`TaskViewerProvider._handleAirlockExport()` `18107-18166`, invoked on commit ~`18115`). We reuse that hook rather than inventing a new file watcher.

### Root Cause

Codebase-docs sync has no entry point and no config. The Remote tab today configures plan-card remote control (`remote.config`: provider, boards, pingMode, frequency — `RemoteControlService.ts:55-60`) but nothing about doc sync. The continuous-sync rate-limit concern the epic raised is bounded by plan 2/4's serialized queue + the incremental hash diff (steady-state syncs touch only changed files), so the trigger layer can be simple.

## Metadata

**Complexity:** 5
**Tags:** backend, frontend, remote-control, notion, feature, devops
**Depends on:** `phase2-codebase-doc-generator.md` (1/4), `phase2-notion-codebase-docs-sync.md` (2/4).
**Parent epic:** `epic-remote-planning-infrastructure-7421946e-dea1-4d2b-985d-5de52d088f4d.md`

## User Review Required

None. Defaults below are conservative (sync **off** by default; commit-trigger only when explicitly enabled). No behavior changes for existing users until they opt in.

## Decisions (made, not deferred)

1. **Off by default.** Codebase-docs sync ships disabled. Existing installs see no new background activity until they enable it in the Remote tab — consistent with the epic's "new side effect should be opt-in" guidance for Manual-mode users.
2. **Three trigger modes, all gated on the enable flag:**
   - **Manual** — a "Sync Codebase Docs" button (always available when enabled).
   - **On commit** — reuse the existing post-commit hook path that already fires `_handleAirlockExport`; add a parallel call to the codebase-docs sync when enabled. Debounced so a rapid commit burst coalesces into one sync (default 30 s debounce).
   - **Timer** — optional interval (default off; if set, min 15 min) for repos where commits are infrequent but the working tree changes.
3. **Background, non-blocking, with a re-entrancy guard** mirroring `RemoteControlService._polling` (`193`): never run two doc syncs concurrently; a trigger during an in-flight sync is dropped (next trigger re-syncs from current state — idempotent).
4. **Reuse the Remote tab UI**, don't build a new panel. The Remote tab already houses remote-control config; codebase-docs sync is the same conceptual surface (push local state to a remote provider).

## What Gets Built

### 1. Orchestrator — `src/services/CodebaseDocsSyncService.ts` (extend from plan 2/4)

Add the trigger/scheduling layer around `syncCodebaseDocs()`:
- `runSyncNow(workspaceRoot, reason)` — generate (`generateCodebaseDocs`, stamping `generatedAt` here) → push (`syncCodebaseDocs`) → write `remote.codebaseDocs.lastSyncAt` → emit a result event for the webview. Guarded by an `_syncing` boolean (re-entrancy).
- `onGitCommit(workspaceRoot)` — if enabled and mode includes commit, debounce then `runSyncNow(..., 'commit')`.
- `startTimer()/stopTimer()` — if a timer interval is configured, schedule `runSyncNow(..., 'timer')`; clears on disable. Reuse the timer lifecycle shape from `RemoteControlService` (`_scheduleTimer`).
- `restoreFromConfig()` — on startup, read the config keys, start the timer if configured. Called from the same `ready` path that restores remote control (`KanbanProvider.ts:5153`).

### 2. Commit-hook wiring — `src/services/TaskViewerProvider.ts`

At the existing post-commit trigger (~`18115`, where `_handleAirlockExport` is invoked), add a guarded parallel call into `CodebaseDocsSyncService.onGitCommit(workspaceRoot)`. The NotebookLM DOCX export and the codebase-docs Notion sync are independent and both fire on commit when their respective features are enabled — neither blocks the other.

### 3. Config keys (DB `config` table)

| Key | Default | Purpose |
|-----|---------|---------|
| `remote.codebaseDocs.enabled` | `false` | Master on/off |
| `remote.codebaseDocs.triggers` | `["manual","commit"]` | Subset of manual/commit/timer |
| `remote.codebaseDocs.timerMinutes` | `0` (off) | Timer interval; min 15 if > 0 |
| `remote.codebaseDocs.parentPageId` | (unset → falls back to `remote.notion.setup` page) | Override Notion parent (the plan-2/4 review item) |
| `remote.notion.codebaseDocsDatabaseId` | (set by 2/4) | Provisioned docs DB |
| `remote.codebaseDocs.lastSyncAt` | (set by 2/4) | Last completed sync ISO |

State lives in the DB `config` table — never `settings.json` (per the project's state-source-of-truth rule). All keys are additive.

### 4. Remote-tab UI — `src/webview/kanban.html` (Remote tab section) + its inline script

Add a "Codebase Docs Sync" subsection to the existing Remote tab:
- Enable toggle (writes `remote.codebaseDocs.enabled`).
- Trigger checkboxes (manual / on commit / timer) and a timer-minutes input (shown only when timer checked).
- A "Sync Codebase Docs Now" button (immediate; no confirm dialog — per CLAUDE.md, buttons act immediately).
- A read-only status line: last-sync time + last result counts (created/updated/archived/skipped) + an in-progress indicator while `_syncing`.

Message handlers go in **kanban.html's own inline script** (kanban.html is a self-contained webview — sub-bar/Remote-tab handlers do not live in project.js). Backend handlers (`codebaseDocs_setConfig`, `codebaseDocs_syncNow`, `codebaseDocs_getStatus`) are added where the other Remote-tab message handlers live (`KanbanProvider`).

### 5. Startup restore — `src/services/KanbanProvider.ts`

In the existing webview-`ready` startup path (~`5153`, alongside `rc.restoreFromConfig()`), call `codebaseDocsSyncService.restoreFromConfig()` so a configured timer resumes after a restart. No second invocation elsewhere (avoid the double-init class of bug the epic's reconciler correction warns about).

## Key Reuse (do not reinvent)

| Reuse | Source |
|------|--------|
| Post-commit trigger hook | `TaskViewerProvider._handleAirlockExport` invocation ~`18115` |
| Re-entrancy guard pattern | `RemoteControlService._polling` `193` |
| Timer lifecycle | `RemoteControlService._scheduleTimer` |
| Startup `restoreFromConfig` wiring point | `KanbanProvider.ts:5153` |
| Remote-tab UI shell + config-write message pattern | existing Remote tab in `kanban.html` |
| DB `config` for all state | project state-source-of-truth rule |

## Edge-Case & Dependency Audit

- **Commit storms:** rebases/squashes fire many commits fast → the 30 s debounce coalesces them into one sync. The re-entrancy guard prevents overlap if a sync is still running.
- **Big-repo first sync blocks nothing:** `runSyncNow` is async/background; the UI shows progress and the button is disabled while `_syncing`. No editor-thread blocking.
- **Disable mid-sync:** an in-flight sync completes; the timer is cleared so no *new* sync starts. Idempotent — partial completion resumes correctly next time (plan 2/4 commits per-page).
- **No Notion configured but feature enabled:** `runSyncNow` no-ops cleanly (plan 2/4's `ensureCodebaseDocsDatabase` early-returns); the status line shows "Notion not configured" rather than an error spew. (This is a genuine total-can't-proceed state, so a one-line status message is warranted — not a transient-race message.)
- **Multi-workspace:** sync is per-workspace-root (keyed by `workspace_id`), matching how remote control and `imported_docs` already scope. The Remote tab operates on the tab's selected workspace.
- **Interaction with NotebookLM export:** both fire on commit; they share the `ContextBundler` *discovery* helper (plan 1/4) but write to different targets (DOCX file vs. Notion). No shared mutable state.

## Verification Plan

> Suite run separately by the user.

1. **Unit — gating:** with `enabled=false`, `onGitCommit` and the timer are no-ops; no generate/push calls.
2. **Unit — debounce/re-entrancy:** N rapid `onGitCommit` calls → one `runSyncNow`; a trigger during an in-flight sync is dropped.
3. **Unit — startup restore:** with timer configured, `restoreFromConfig` schedules exactly one timer; with it off, none.
4. **Unit — config round-trip:** UI `codebaseDocs_setConfig` writes the keys; `getStatus` reads them back; no `settings.json` writes.
5. **Manual:** enable in Remote tab, commit a change, confirm a sync runs and the status line updates; click "Sync Now", confirm counts; set a 15-min timer, confirm it fires; disable, confirm activity stops.

## Out of Scope

- Doc generation internals (1/4) and push internals (2/4).
- The remote-agent orientation skill (4/4).
- Confirmation dialogs of any kind (forbidden by CLAUDE.md).
- Linear/ClickUp doc targets.

## Recommendation

Complexity 5 → **Send to Coder.** Mostly wiring proven hooks (commit trigger, timer, startup restore) plus a Remote-tab UI subsection. The care points are the debounce + re-entrancy guard and keeping the commit hook from blocking the NotebookLM export.
