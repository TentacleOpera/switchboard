# Phase 2 (3/4): Continuous Sync Triggers + Remote-Tab Config & Controls

## Goal

Make codebase-docs → Notion sync (plans 1/4 + 2/4) actually *run* — on demand, on git commit, and on an optional timer — and give the user a control surface in the Kanban Remote tab to enable it, point it at a Notion location, set frequency, and trigger a manual sync, with progress/last-sync feedback.

### Problem & Background

Plans 1/4 and 2/4 produce a generator and a push pipeline but no caller. Without a trigger, the codebase docs in Notion go stale the moment the repo changes, defeating the "live codebase docs from Notion" outcome the epic specifies. There is a proven trigger precedent: the NotebookLM/Airlock export **already auto-runs on git commit** (`TaskViewerProvider._handleAirlockExport()` `18704-18763`, invoked on commit via `repo.state.onDidChange` at `10359-10366`). We reuse that hook rather than inventing a new file watcher.

### Root Cause

Codebase-docs sync has no entry point and no config. The Remote tab today configures plan-card remote control (`remote.config`: provider, boards, silentSync, pingFrequencySeconds — `RemoteControlService.ts:34-43`, the `RemoteConfig` interface) but nothing about doc sync. The continuous-sync rate-limit concern the epic raised is bounded by plan 2/4's serialized queue + the incremental hash diff (steady-state syncs touch only changed files), so the trigger layer can be simple.

## Metadata

**Complexity:** 5
**Tags:** backend, frontend, feature, devops
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
3. **Background, non-blocking, with a re-entrancy guard** mirroring `RemoteControlService._polling` (guard at line 177, declared at line 74): never run two doc syncs concurrently; a trigger during an in-flight sync is dropped (next trigger re-syncs from current state — idempotent).
4. **Reuse the Remote tab UI**, don't build a new panel. The Remote tab already houses remote-control config; codebase-docs sync is the same conceptual surface (push local state to a remote provider).

## What Gets Built

### 1. Orchestrator — `src/services/CodebaseDocsSyncService.ts` (extend from plan 2/4)

Add the trigger/scheduling layer around `syncCodebaseDocs()`:
- `runSyncNow(workspaceRoot, reason)` — generate (`generateCodebaseDocs`, stamping `generatedAt` here) → push (`syncCodebaseDocs`) → write `remote.codebaseDocs.lastSyncAt` → emit a result event for the webview. Guarded by an `_syncing` boolean (re-entrancy).
- `onGitCommit(workspaceRoot)` — if enabled and mode includes commit, debounce then `runSyncNow(..., 'commit')`.
- `startTimer()/stopTimer()` — if a timer interval is configured, schedule `runSyncNow(..., 'timer')`; clears on disable. Reuse the timer lifecycle shape from `RemoteControlService._scheduleTimer` (line 169).
- `restoreFromConfig()` — on startup, read the config keys, start the timer if configured. **Wiring note (corrected):** there is no `rc.restoreFromConfig()` sibling to sit alongside — remote control starts via the `startRemoteControl` message handler (`KanbanProvider.ts:5599-5613`, calling `rc.start()`), and the webview `ready` handler (`KanbanProvider.ts:5127-5151`) runs `switchboard.fullSync`. Call `codebaseDocsSyncService.restoreFromConfig()` from the `ready` handler (after `fullSync`), NOT by mirroring a nonexistent `rc.restoreFromConfig()` call.

### 2. Commit-hook wiring — `src/services/TaskViewerProvider.ts`

At the existing post-commit trigger (`TaskViewerProvider.ts:10359-10366`, where `repo.state.onDidChange` calls `_handleAirlockExport().catch(...)`), add a guarded parallel call into `CodebaseDocsSyncService.onGitCommit(workspaceRoot)`. The NotebookLM DOCX export and the codebase-docs Notion sync are independent and both fire on commit when their respective features are enabled — neither blocks the other.

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

In the existing webview-`ready` startup path (`KanbanProvider.ts:5127-5151`, which runs `switchboard.fullSync`), call `codebaseDocsSyncService.restoreFromConfig()` after `fullSync` so a configured timer resumes after a restart. **Do NOT mirror a nonexistent `rc.restoreFromConfig()` call** — remote control restores via the `startRemoteControl` message handler (`5599-5613` → `rc.start()`), not via a `restoreFromConfig` sibling. No second invocation elsewhere (avoid the double-init class of bug the epic's reconciler correction warns about).

## Key Reuse (do not reinvent)

| Reuse | Source |
|------|--------|
| Post-commit trigger hook | `TaskViewerProvider` `repo.state.onDidChange` → `_handleAirlockExport` at `10359-10366` (function body `18704-18763`) |
| Re-entrancy guard pattern | `RemoteControlService._polling` guard at line 177 (declared line 74) |
| Timer lifecycle | `RemoteControlService._scheduleTimer` line 169 |
| Startup wiring point | `KanbanProvider.ts` `ready` handler `5127-5151` (runs `switchboard.fullSync`); remote control starts via `startRemoteControl` `5599-5613` → `rc.start()` |
| Remote-tab UI shell + config-write message pattern | existing Remote tab in `kanban.html` (`2607-2664`, inline script handlers `6549-6556` / `7008-7125`) |
| DB `config` for all state | project state-source-of-truth rule (`RemoteControlService.ts:87` comment + `getConfig`/`setConfig` 89-121) |

## Complexity Audit

### Routine
- Config keys are additive rows in the DB `config` table (mirrors `remote.config` pattern).
- Remote-tab UI subsection (toggle, checkboxes, button, status line) in the existing self-contained `kanban.html` inline script.
- Backend message handlers (`codebaseDocs_setConfig`/`syncNow`/`getStatus`) alongside existing Remote-tab handlers.
- Timer lifecycle reuses `RemoteControlService._scheduleTimer` shape (line 169).

### Complex / Risky
- **Startup restore wiring:** the original plan referenced a nonexistent `rc.restoreFromConfig()` sibling. The corrected wiring calls `restoreFromConfig()` from the `ready` handler (5127-5151) after `fullSync` — getting this wrong causes either a missed timer (no restore) or a double-init (timer fires twice). Single invocation is the guard.
- **Commit-hook parallel call:** adding a second async call at the `repo.state.onDidChange` trigger (10359-10366) must not block the existing `_handleAirlockExport`. Both are fire-and-forget with `.catch(() => {})`; the new call follows the same shape.
- **Debounce + re-entrancy interaction:** a 30s debounce coalescing commit storms, combined with an `_syncing` guard dropping triggers during an in-flight sync, must not silently swallow the last commit in a burst. The next trigger (or timer tick) re-syncs from current state — idempotent — but the implementer must confirm a dropped trigger doesn't lose the "dirty" signal.

## Dependencies

- `sess_phase2-codebase-doc-generator` — Codebase Doc Generator (`runSyncNow` calls `generateCodebaseDocs`).
- `sess_phase2-notion-codebase-docs-sync` — Notion Codebase-Docs DB + Incremental Push (`runSyncNow` calls `syncCodebaseDocs` and consumes its counts).

## Adversarial Synthesis

Key risks: (1) the startup restore referenced a nonexistent method — corrected to hook the verified `ready` handler, but a double-init or missed-restore is the failure mode to test; (2) the commit-hook parallel call must not block NotebookLM export — both are fire-and-forget, low risk; (3) debounce + re-entrancy could drop the last commit in a burst — mitigated by idempotent re-sync on the next trigger. The trigger design is conservative (off by default, gated, debounced); the risk concentrates in the wiring correctness, now corrected to verified locations.

## Edge-Case & Dependency Audit

- **Commit storms:** rebases/squashes fire many commits fast → the 30 s debounce coalesces them into one sync. The re-entrancy guard prevents overlap if a sync is still running.
- **Big-repo first sync blocks nothing:** `runSyncNow` is async/background; the UI shows progress and the button is disabled while `_syncing`. No editor-thread blocking.
- **Disable mid-sync:** an in-flight sync completes; the timer is cleared so no *new* sync starts. Idempotent — partial completion resumes correctly next time (plan 2/4 commits per-page).
- **No Notion configured but feature enabled:** `runSyncNow` no-ops cleanly (plan 2/4's `ensureCodebaseDocsDatabase` early-returns); the status line shows "Notion not configured" rather than an error spew. (This is a genuine total-can't-proceed state, so a one-line status message is warranted — not a transient-race message.)
- **Multi-workspace:** sync is per-workspace-root (keyed by `workspace_id`), matching how remote control and `imported_docs` already scope. The Remote tab operates on the tab's selected workspace.
- **Interaction with NotebookLM export:** both fire on commit; they share the `ContextBundler` *discovery* helper (plan 1/4) but write to different targets (DOCX file vs. Notion). No shared mutable state.

## Proposed Changes

### `src/services/CodebaseDocsSyncService.ts` (extend from plan 2/4)
- **Context:** Plan 2/4 ships `syncCodebaseDocs()`; this plan adds the trigger/scheduling layer.
- **Logic:** `runSyncNow` (generate → push → write `lastSyncAt` → emit event, guarded by `_syncing`), `onGitCommit` (gated + debounced), `startTimer`/`stopTimer` (reuse `_scheduleTimer` shape), `restoreFromConfig` (read keys, start timer if configured).
- **Implementation:** Same file as plan 2/4's push pipeline. Re-entrancy guard mirrors `RemoteControlService._polling` (line 177).
- **Edge Cases:** Disable mid-sync → in-flight completes, timer cleared, no new sync. No Notion configured → clean no-op with status message.

### `src/services/TaskViewerProvider.ts`
- **Context:** `repo.state.onDidChange` (10359-10366) already fires `_handleAirlockExport` on commit.
- **Logic:** Add a guarded parallel `codebaseDocsSyncService.onGitCommit(workspaceRoot)` call at the same trigger point. Fire-and-forget with `.catch(() => {})`, mirroring the existing call.
- **Implementation:** One line alongside the existing `_handleAirlockExport().catch(...)`.
- **Edge Cases:** Feature disabled → `onGitCommit` is a no-op (gated on `enabled`).

### `src/services/KanbanProvider.ts`
- **Context:** The `ready` handler (5127-5151) runs `switchboard.fullSync`; remote control starts via `startRemoteControl` (5599-5613) → `rc.start()`. There is no `rc.restoreFromConfig()`.
- **Logic:** Call `codebaseDocsSyncService.restoreFromConfig()` in the `ready` handler after `fullSync`. Add the three backend message handlers (`codebaseDocs_setConfig`/`syncNow`/`getStatus`) alongside the existing Remote-tab handlers.
- **Implementation:** Single invocation (no double-init).
- **Edge Cases:** Timer not configured → `restoreFromConfig` schedules nothing.

### `src/webview/kanban.html` (Remote tab, 2607-2664 + inline script)
- **Context:** The Remote tab is a self-contained inline-script webview section.
- **Logic:** Add a "Codebase Docs Sync" subsection: enable toggle, trigger checkboxes, timer-minutes input, "Sync Now" button (no confirm — CLAUDE.md), read-only status line. Inline handlers post the three messages above.
- **Implementation:** Inline script only (not project.js — kanban.html has no external script).
- **Edge Cases:** Button disabled while `_syncing`; status shows "Notion not configured" when applicable.

## Verification Plan

### Automated Tests

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
