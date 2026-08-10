# Doc-Parity Audit — `board` Section (11 files, 775 lines)

## Metadata

**Complexity:** 5
**Tags:** audit, standalone, parity
**Project:** Browser Switchboard

## Goal

Audit every line of the `board` documentation section against the running standalone host, recording a verdict and evidence class per feature claim into the shared register.

**Files** (`~/Documents/GitHub/switchboard-site/src/pages/docs/board/kanban-board/`) — counts verified against the tree:

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

This section is the highest-risk for false-green verdicts, because the board is exactly where the fabricated-payload defect lives. A board feature can look wired end-to-end, return `{success:true}`, persist to the DB, and still be completely dead in the browser one frame later.

### The false-green mechanism (verified — do not re-derive)

1. **Every verb is reachable.** `bootstrap.ts:1140`'s `default:` arm delegates to `KanbanProvider.handleServiceVerb` (`src/services/KanbanProvider.ts:7365`), so every write lands.
2. **Both state builders fabricate the board payload** — `bootstrap.ts:404-410` (`pushFullState`) and `:433-439` (`getFullState`), publishing straight to WS via `server.broadcastWs` (`:411-413`):

   | Message | Fabricated value | Lines |
   |---|---|---|
   | `updateColumns` | `DEFAULT_KANBAN_COLUMNS` — no custom columns, visibility or ordering | `:405`, `:434` |
   | `updateWorkspaceSelection` | `activeFilter: null`, `controlPlaneMode: 'none'`, `controlPlaneRoot: null`, `repoScopeFilter: null`, `projectContextEnabled: false` | `:406`, `:435` |
   | `cliTriggersState` | `enabled: false` | `:407`, `:436` |
   | `switchboardThemeNameSetting` | `theme: 'afterburner'` | `:408`, `:437` |
   | `updateBoard` | `routingConfig: {}` | `:409`, `:438` |

3. **The literals are re-asserted ~40 ms later.** `schedulePushFullState()` at `:1156` fires for every non-read-only verb; `PUSH_COALESCE_MS = 40` at `:459`, trailing-edge coalesced at `:463-471`.

**The transport is not dead.** The claim that `KanbanProvider.postMessage` has no sink in standalone is **false**: `bootstrap.ts:692` constructs a shared `BroadcastHub`, `:758` assigns it to the Kanban provider, `:1757` forwards the API server into it, and `BroadcastHub.push` mirrors to WS regardless of webview binding (`src/services/broadcastHub.ts:80-91`). Stale UI in this section is the fabricated payload, not a missing bridge — but **record the observation, not the cause**.

`automation.md` deserves particular care: it documents autoban and CLI triggers, and `cliTriggersState.enabled` is hardcoded `false` in both builders. Whether that surface is *intentionally* absent in standalone is **not** to be decided from `headless-switchboard.md`, which contributes no requirements. Record the observed behaviour as a verdict and let the closeout subtask resolve intent.

### Evidence rules (binding — the register header is the authoritative copy)

- **A — Runtime observed** in a running browser host. **Required** for any `LIVE` verdict on a user-facing feature.
- **B — Passing contract test** naming the behaviour.
- **C — Code path traced end-to-end** including push path and UI render. Never sufficient alone.
- **Not evidence:** verb reachability, `{success:true}`, a landed DB write, or the presence of a handler.
- **Settle-and-reload:** re-observe any board-displayed state after ~1 s and after a page reload before recording `LIVE`.
- **Attribute observations, not causes.** Record what was seen; never write a root cause into a row unless independently confirmed against the tree at audit time.
- Record a line-coverage figure per file; under 100% means unfinished.
- `getting-started/headless-switchboard.md` contributes no requirements — it may not justify, excuse or close a gap on any page here.
- `BLOCKED` is not a verdict; resolve or escalate it, never count it as audited.

Where this restatement differs from the register header, the header wins.

## User Review Required

None.

## Complexity Audit

### Routine
- Reading each file and extracting claims.

### Complex / Risky
- **The revert-after-40 ms failure mode is this subtask's defining rule.** A toggle can appear to work and silently revert a moment later. **Every state-changing board claim must be re-observed after ~1 s and after a page reload**, never judged on the immediate click response. This is the single most important procedural rule in this subtask.
- **The scratch workspace must carry a custom column and a hidden role.** With only default columns, `updateColumns → DEFAULT_KANBAN_COLUMNS` is indistinguishable from correct behaviour and the highest-yield defect in the corpus is invisible. Confirm the harness provisioned both before recording any column verdict.
- **Heavy overlap with Standalone Push-Path Parity.** Columns, visibility, ordering, routing config, CLI triggers, theme and workspace-selection fields are all already planned. Link, do not duplicate. New findings only for what those plans do not cover.
- **Next-column resolution divergence is a separate, already-planned defect.** `standalone-kanban-column-parity-audit.md` (complexity 6, CREATED) covers `getNextKanbanColumn` — a hardcoded map in `bootstrap.ts` duplicating the extension's `_getNextColumnId`, with no visibility awareness. It is a **code-fix plan**, not a doc audit, so it is **linked, not folded in**: where a documented advance/move behaviour fails because the wrong next column was chosen, link that plan. Do not re-plan it, and do not execute it from this subtask — it carries its own unresolved design decision.
- **`icons.md` (109 lines) is largely visual.** Icon-parity claims need visual confirmation in the browser, not a code check. The `icons:parity` guard exists (`npm run icons:parity` → `scripts/check-icon-parity.js`) and a pass is class-B evidence for the icon *set*, but it does not cover browser rendering — that still requires class A.
- **`worktrees.md`** — worktree state is DB-backed with no reconciliation; verify displayed state against actual `git worktree list` output rather than trusting the panel.
- **`features.md` / `project-manager.md`** — feature operations are multi-step UUID choreography; a partially-working flow reads as `PARTIAL`, not `LIVE`.

## Edge-Case & Dependency Audit

**Race Conditions** — the 40 ms coalesced push is itself the trap; see the re-observation rule above. It is a race the audit must *lose* deliberately in order to see the defect: read too early and it reports a pass.

**Security** — none beyond scratch-workspace handling.

**Side Effects** — this section mutates the board heavily: creating plans, moving cards, creating features and worktrees. Scratch workspace only. Worktree creation touches real git state — clean up, and never point it at a repo with work in progress.

**Dependencies & Conflicts** — overlaps the **Standalone Push-Path Parity** feature, which has **three** subtasks, not seven. Five earlier plans (`standalone-column-structure-ignores-custom-columns-and-visibility.md`, `standalone-routing-config-hardcoded-empty.md`, `standalone-cli-triggers-state-hardcoded-off.md`, `standalone-theme-hardcoded-afterburner.md`, `standalone-workspace-selection-fields-hardcoded.md`) were merged into the delegation plan on 2026-08-07 and **no longer exist as files**. Use this mapping:

| Observed gap touches | Link this plan |
|---|---|
| columns / visibility / ordering, routing config, CLI triggers, theme, repo scope, control-plane mode, workspace-selection fields | `standalone-state-builders-delegate-to-getfullstatemessages.md` |
| wrong next column on advance / move | `standalone-kanban-column-parity-audit.md` |
| unbounded queue growth / messages never delivered to a bound webview | `restore-backlog-view-to-standalone-host.md` |
| absence of a CI number for a parity class | `standalone-push-parity-guard.md` |

## Dependencies

- **Harness subtask** (`audit-standalone-against-extension-docs.md`) — in particular its guarantee that the scratch workspace carries a custom column and a hidden role.

## Implementation

For each file, largest first:

1. Read every line.
2. Extract each user-facing feature or behaviour claim as a register row.
3. Exercise it against the running standalone host.
4. **Re-observe every state-changing claim after ~1 s and after a page reload** before recording `LIVE`. Record both observations in the row note.
5. Record verdict, evidence class and the line-coverage figure.
6. For each `GAP` / `PARTIAL`, apply the link mapping above, else flag for closeout.

## Proposed Changes

### `.switchboard/audits/standalone-extension-parity.md`
- **Logic:** Append `board` rows with verdicts, evidence classes and coverage figures.
- **Edge Cases:** State-changing claims require post-settle and post-reload re-observation; overlaps link rather than duplicate; no row links a merged-away plan file.

## Verification Plan

1. All 11 files carry a recorded line-coverage figure, each 100%.
2. No `LIVE` verdict on a user-facing feature rests on evidence class C alone.
3. Zero rows cite verb reachability, `{success:true}`, or a landed DB write.
4. Every state-changing claim records **both** the post-settle and the post-reload observation.
5. Column, visibility, routing, CLI-trigger, theme and workspace-selection rows link the delegation plan rather than duplicating it, and no row links one of the five merged-away files.
6. Column verdicts confirm a custom column and a hidden role were present in the workspace.
7. Any next-column / advance failure links `standalone-kanban-column-parity-audit.md` rather than opening a new plan.
8. `icons.md` rows distinguish guard evidence (class B, icon set) from browser rendering (class A).
9. Independent re-check of a random 10% of `LIVE` rows; any failure invalidates the section for re-audit.
10. Every `GAP` / `PARTIAL` links an existing plan or is flagged for closeout.

## Recommendation

Complexity 5 → **Send to Lead Coder.** Highest false-green risk in the feature; the post-settle re-observation discipline and a workspace with a custom column are what make the verdicts real.
