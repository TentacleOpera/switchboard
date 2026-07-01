# Part 1 — Epic Worktree Mode Selector + Config Foundation

**Plan ID:** dc38d838-36fd-4290-a41a-1ed157c5ef18
**Epic ID:** 8b50c095-b7c6-40b5-a9d6-2155b26fe4b6

## Metadata

**Complexity:** 5
**Tags:** backend, frontend, ui, feature

---

## Goal

Add a global "Epic Worktree Auto Mode" selector in the WORKTREES tab, persisted as a single config
value (`epic_worktree_mode`), applied to newly created epics. This is the config foundation that
Parts 2 & 3 build their provisioning logic on.

### Core problem & background

There is no global selector for *what automatic worktree provisioning happens* when an epic is
created. Today the only options are manual ("Create Epic Worktree" button) or delegating to the
agent via `WORKTREES_PER_PLAN_DIRECTIVE`. A persisted mode value lets Parts 2 & 3 read it at
epic-creation/subtask-add time and provision accordingly.

---

## User Review Required

No — defaults are migration-safe (`none` = current behavior). The D-table decisions (D1) are
captured in the epic file.

## Complexity Audit

### Routine
- Config key `epic_worktree_mode` in the existing `config` table (no migration needed) — reader/
  writer via existing `db.getConfig` / `setConfig`. Default `'none'` when unset.
- Message handlers `getEpicWorktreeMode` / `setEpicWorktreeMode` — mirror existing handler pattern.
- WORKTREES-tab Epics section UI — mirrors existing project/epic worktree form controls in
  `createWorktreesPanel()`.

### Complex / Risky
- None significant. The selector is purely a config write/read; no provisioning logic lives here.

## Edge-Case & Dependency Audit

- **Race Conditions:** mode is read once at the start of a create/assign operation in Parts 2 & 3;
  a mid-flight toggle uses the snapshot. No race in Part 1 itself (config read/write is atomic).
- **Security:** mode value validated against the enum `{none, per-subtask, high-low}` in
  `setEpicWorktreeMode` — rejects arbitrary strings.
- **Side Effects:** none — `none` is the default and preserves current behavior exactly.
- **Dependencies & Conflicts:** independent of V42 schema. Parts 2 & 3 depend on this plan. Part 0
  is independent.

## Dependencies

- `sess_epicworktree_directive_scope_fix` (Part 0) — recommended to ship first to de-risk the
  prompt path, but not a hard dependency for Part 1's config work.

## Proposed Changes

### `src/services/KanbanProvider.ts`
- **Context:** `_sendWorktreeConfig()` (~8403) builds the worktree config payload posted to the
  webview; the message-handler switch dispatches worktree messages.
- **Logic:**
  1. **Config key** `epic_worktree_mode` in the existing `config` table (no migration needed).
     Reader/writer via existing `db.getConfig` / `setConfig`. Default `'none'` when unset.
  2. **Message handlers:** `getEpicWorktreeMode` (include `epicWorktreeMode` in the worktree config
     payload sent by `_sendWorktreeConfig` — add to the `postMessage` at ~8461) and
     `setEpicWorktreeMode` (validate ∈ `{none, per-subtask, high-low}`, persist via `db.setConfig`,
     echo back via `_sendWorktreeConfig`).
- **Edge Cases:** unset config key → default `'none'`; invalid value on set → reject + warn.

### `src/webview/kanban.html`
- **Context:** `createWorktreesPanel()` (~9261) renders the WORKTREES tab; the manual "Create Epic
  Worktree" form lives at ~9428.
- **Logic:** new **Epics** section in `createWorktreesPanel()` with a 3-option "Auto Mode" control
  (segmented radio or dropdown) bound to `epic_worktree_mode` — `none` / `per-subtask` /
  `high-low`, each with a one-line description. Posts `setEpicWorktreeMode`; reflects state from
  `worktreeConfig.epicWorktreeMode`. The existing manual "Create Epic Worktree" controls stay in
  the panel regardless of the selected mode.
- **Edge Cases:** control must reflect persisted state on panel re-render (read from
  `config.epicWorktreeMode`).

## Verification Plan

### Automated Tests
- **SKIP for this session** per session directives. Tests to author for the separate run:
  - Assert `setEpicWorktreeMode` persists and `getEpicWorktreeMode` reads back the value; assert
    invalid values are rejected; assert unset defaults to `'none'`.

### Manual / Static Verification (this session)
- **Compilation SKIP** per session directives.
- Static cross-check (done during review): confirmed `_sendWorktreeConfig` payload structure
  (~8461) and `createWorktreesPanel` location (~9261) against current `src/`.
- Pre-merge checklist: grep for any new `confirm(`/`window.confirm` — forbidden per CLAUDE.md.

## Acceptance
- Selecting a mode persists across reloads; value is read at epic-creation time.
- The manual "Create Epic Worktree" button remains available in all modes.

## Recommendation

Complexity 5 → **Send to Coder.** Config read/write + a UI control; no schema, no provisioning
logic. Ships after Part 0, before Parts 2 & 3.

---

## Review Findings

Reviewed `src/services/KanbanProvider.ts` (`getEpicWorktreeMode`/`setEpicWorktreeMode` handlers, enum validation, `epicWorktreeMode` added to the `_sendWorktreeConfig` payload) and `src/webview/kanban.html` (Epics radio section). Implementation matches the plan: the `epic_worktree_mode` config key uses existing `getConfig`/`setConfig`, defaults to `'none'` when unset, and rejects invalid values via a non-modal `showWarningMessage` notification (a passive rejection notice, not a confirm gate). One fix applied: the `high-low` radio description was factually wrong ("low-complexity ones share the epic worktree") and contradicted Part 3's two-tier model — corrected to describe two tier worktrees off the integration branch plus planner consolidation (`src/webview/kanban.html`). Validation: static grep clean (no confirm gates); the payload field threads through to the webview and the control reflects persisted state on re-render. Remaining risk: none — `none` default preserves current behavior, migration-safe for the ~4k install base.
