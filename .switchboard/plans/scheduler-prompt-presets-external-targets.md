# Scheduler Prompt Presets & External-Target (Antigravity/Cloud) Handoff

## Goal

Give the scheduler its **source presets** (board-batch, reconciliation, comms, custom) and its **external execution targets** (Antigravity and Cloud), where external targets produce a portable, copyable prompt **plus the explicit setup instructions the current Antigravity mode is missing**. No third-party integration is added; the cloud path relies only on capabilities that already ship.

**Problem & background.** Two gaps motivate this plan:

1. **The Antigravity mode is dishonest about scheduling.** Its UI says *"copy a one-shot batch prompt… Run once daily or as needed"* ([TaskViewerProvider.ts:8878](src/services/TaskViewerProvider.ts#L8878)), but the generated prompt assumes it is *"running on a scheduled Antigravity timer"* and even instructs the agent to `manage_task kill` future runs ([KanbanProvider.ts:5000](src/services/KanbanProvider.ts#L5000)). The tab never tells the user this is meant to be scheduled via **Antigravity's own Scheduled Tasks feature** — so the recurrence is invisible and confusing.
2. **Board-automation should not require the laptop to be on.** A cloud job (Claude cowork/routine) can run laptop-off, but floors out at ~1 poll/hour, so it suits board automation, not sub-hourly comms. Crucially, the read side already exists: `BoardSnapshotPublisher` force-pushes `board.json`/`board.md`/`board.html` to the `switchboard/board` orphan branch on `origin` ([BoardSnapshotPublisher.ts](src/services/BoardSnapshotPublisher.ts), gated by `boardStateExport === 'read-only-snapshot'`, default `none`). So a cloud job with repo access can *read* the board today with zero new code.

**Root cause / design.** "Scheduling" has been an implicit, host-borrowed afterthought. This plan makes each **source** a first-class authored prompt and each **target** an explicit contract with its prerequisites and interval floor surfaced to the user. Only `local-terminal` (plan 2) owns a live timer; `antigravity` and `cloud` are **prompt-handoff** targets — Switchboard emits prompt + instructions and the external scheduler owns recurrence.

**Reconciliation is a prompt, not a subsystem.** Because plan files are git-tracked (`.gitignore` un-ignores `.switchboard/plans/`), a cloud/off-machine agent writes its results into the standard `## Completion Report` / `## Review Findings` sections and commits. Reconciliation is then just a copyable IDE-agent prompt that pulls recent branches, scans those sections, and advances cards **via the sanctioned `kanban_operations` skill** (`move-card.js` / `POST /kanban/move`) — never raw SQL, which strands cards (per CLAUDE.md).

## Implementation Steps

1. **Source preset builders.** Add a prompt builder per `source`:
   - `board-batch` — the existing Antigravity batch prompt, generalized out of `generateAntigravityPrompt`/[KanbanProvider.ts:5000](src/services/KanbanProvider.ts#L5000) so it is target-agnostic (agent + column + batchSize inputs).
   - `reconcile` — **new authored prompt**: "fetch recent remote branches → pull → scan pulled plan files under `.switchboard/plans/` for new `## Completion Report` / `## Review Findings` → for each, move the card **forward-only** via the `kanban_operations` skill → report what moved and skip cards a human already advanced."
   - `comms` — the existing read-only comms builder (from plan 2).
   - `custom` — free-text `promptOverride`.
2. **Target contracts.** For each `target`, define: interval floor (`local` = 1 min, `cloud` ≥ 60 min, `antigravity` = n/a/handoff), and a **prerequisites block** shown to the user:
   - `antigravity` — "Paste into **Antigravity → Scheduled Tasks**; set the recurrence there. Switchboard does not run this timer." (the honesty fix).
   - `cloud` — "Requires `boardStateExport = read-only-snapshot` (Setup) and an `origin` remote so the cloud job can read `board.json` from the `switchboard/board` branch. Read-only jobs need nothing else; card moves happen when you next reconcile locally."
   - `local-terminal` — "Runs in an interactive Claude terminal on this machine; the laptop must be on. Supports sub-hourly intervals."
3. **Export/copy path.** For `antigravity`/`cloud` targets, wire a "Copy prompt" action that returns the built prompt **plus** the prerequisites block, reusing the existing clipboard round-trip used by `generateAntigravityPrompt` ([KanbanProvider.ts](src/services/KanbanProvider.ts) message `antigravityPrompt`). Rename/generalize the message to `schedulerPrompt` with a `target` discriminator; keep the old message name as a shim.
4. **Retire the confusing copy.** Update the `antigravity-batch` mode description so it no longer says "run manually as needed" without context — it now points at Antigravity Scheduled Tasks (or is fully absorbed into the Scheduler UI in plan 4).
5. **Docs.** Add a short "Scheduler targets & prerequisites" note to the switchboard-site Remote Control / Cloud Coding Agents pages, cross-linking the existing `switchboard/board` snapshot mechanism. Docs only; no new hosting path.

## Metadata

- **Complexity:** 5
- **Tags:** backend, feature, docs

## Verification Plan

### Automated Tests
- Unit test: `board-batch` builder output is identical (snapshot) to the current `generateAntigravityPrompt` output for the same agent/column/batchSize.
- Unit test: `reconcile` prompt contains the forward-only + `kanban_operations` (no-SQL) instructions.
- Unit test: each target returns the correct interval floor and a non-empty prerequisites block; `cloud` names the `read-only-snapshot` + `origin` requirement.

### Manual Acceptance
- Select `antigravity` target → copied text includes explicit "schedule via Antigravity Scheduled Tasks" instructions (the honesty fix is visible).
- Select `cloud` target with `board-batch` → copied prompt is self-contained and the prerequisites block names board-state-export + origin.
- Paste the `reconcile` prompt into an IDE agent after a cloud branch is merged: it pulls, detects a `## Completion Report`, and moves that card forward via `kanban_operations` (verify the card moved and no SQL was used).
- Confirm no Linear/Notion/ClickUp configuration is required for any of the above.
