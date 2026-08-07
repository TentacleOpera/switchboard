# Doc-Parity Audit — `board` Section (11 files, 775 lines)

## Metadata

**Complexity:** 5
**Tags:** audit, standalone, parity
**Project:** Browser Switchboard

## Goal

Audit every line of the `board` documentation section against the running standalone host, recording a verdict and evidence class per feature claim into the shared register.

**Files** (`~/Documents/GitHub/switchboard-site/src/pages/docs/board/kanban-board/`):

| File | Lines |
|---|---|
| `icons.md` | 109 |
| `agents.md` | 94 |
| `index.md` | 83 |
| `prompts.md` | 75 |
| `features.md` | 71 |
| `projects.md` | 68 |
| `worktrees.md` | 64 |
| `creating-plans.md` | 63 |
| `setup.md` | 51 |
| `automation.md` | 49 |
| `project-manager.md` | 48 |

### Problem analysis

The docs document the **extension's** feature set. Every user-facing feature described is one standalone is expected to have; every mismatch is a standalone defect.

This section is the highest-risk for false-green verdicts, because the board is exactly where the known transport defect lives. `KanbanProvider.postMessage` has no sink in standalone (`KanbanProvider.ts:2105-2120`), and both state builders fabricate the board payload from hardcoded literals (`bootstrap.ts:341-346`, `:370-375`) — including the raw default column set, an empty routing config, and CLI triggers forced off. A board feature can look wired end-to-end, return `{success:true}`, persist to the DB, and still be completely dead in the browser.

`automation.md` deserves particular care: it documents autoban and CLI triggers. Whether that surface is intentionally absent in standalone is **not** to be decided from `headless-switchboard.md`, which is stale and contributes no requirements. Record the observed behaviour as a verdict and let the closeout subtask resolve intent.

### Evidence rules (binding — from the harness subtask)

- **A — Runtime observed** in a running browser host. **Required** for any `LIVE` verdict on a user-facing feature.
- **B — Passing contract test** naming the behaviour.
- **C — Code path traced end-to-end** including push path and UI render. Never sufficient alone.
- **Not evidence:** verb reachability, `{success:true}`, a landed DB write, or the presence of a handler.
- Record a line-coverage figure per file; under 100% means unfinished.
- No requirement may be sourced from `getting-started/headless-switchboard.md`.

## User Review Required

None.

## Complexity Audit

### Routine
- Reading each file and extracting claims.

### Complex / Risky
- **The revert-after-40ms failure mode.** Standalone schedules a coalesced board push after every non-read-only verb (`bootstrap.ts:1078`, `PUSH_COALESCE_MS = 40` at `:395`), and that push re-asserts the fabricated literals. A toggle can appear to work and silently revert a moment later. **Every state-changing board claim must be re-observed after ~1 s and after a page reload**, not judged on the immediate click response. This is the single most important procedural rule in this subtask.
- **Massive overlap with Standalone Push-Path Parity.** Columns, visibility, ordering, routing config, CLI triggers and backlog are all already planned. Link those plans; do not write duplicates. New findings only for what those seven do not cover.
- **`icons.md` (109 lines) is largely visual.** Icon-parity claims need visual confirmation in the browser, not a code check. There is an existing `icons:parity` guard — a passing guard is class B evidence for the icon set, but it does not cover browser rendering.
- **`worktrees.md`** — worktree state is DB-backed with no reconciliation; verify displayed state against actual git worktrees rather than trusting the panel.
- **`features.md` / `project-manager.md`** — feature operations are multi-step UUID choreography; a partially-working flow reads as `PARTIAL`, not `LIVE`.

## Edge-Case & Dependency Audit

**Race Conditions** — the coalesced push is itself the trap; see the re-observation rule above.

**Security** — none beyond scratch-workspace handling.

**Side Effects** — this section mutates the board heavily: creating plans, moving cards, creating features and worktrees. Scratch workspace only.

**Dependencies & Conflicts** — heavy overlap with the seven Standalone Push-Path Parity plans.

## Dependencies

- **Harness subtask** (`audit-standalone-against-extension-docs.md`).

## Implementation

For each file, largest first:

1. Read every line.
2. Extract each user-facing feature or behaviour claim as a register row.
3. Exercise it against the running standalone host.
4. **Re-observe every state-changing claim after ~1 s and after a page reload** before recording `LIVE`.
5. Record verdict, evidence class and the line-coverage figure.
6. For each `GAP` / `PARTIAL`, link the covering Standalone Push-Path Parity plan if one exists, else flag for closeout.

## Proposed Changes

### `.switchboard/audits/standalone-extension-parity.md`
- **Logic:** Append `board` rows with verdicts, evidence classes and coverage figures.
- **Edge Cases:** State-changing claims require post-settle re-observation; overlaps link rather than duplicate.

## Verification Plan

1. All 11 files carry a recorded line-coverage figure, each 100%.
2. No `LIVE` verdict on a user-facing feature rests on evidence class C alone.
3. Zero rows cite verb reachability, `{success:true}`, or a landed DB write.
4. Every state-changing claim records that it was re-observed post-settle and post-reload.
5. Column, visibility, routing, CLI-trigger and backlog rows link their existing plans rather than duplicating them.
6. Independent re-check of a random 10% of `LIVE` rows; any failure invalidates the section for re-audit.
7. Every `GAP` / `PARTIAL` links an existing plan or is flagged for closeout.

## Recommendation

Complexity 5 → **Send to Lead Coder.** Highest false-green risk in the feature; the post-settle re-observation discipline is what makes the verdicts real.
