# Doc-Parity Audit — `getting-started` Section (9 files, 594 lines)

## Metadata

**Complexity:** 5
**Tags:** audit, standalone, parity
**Project:** Browser Switchboard

## Goal

Audit every line of the `getting-started` documentation section against the running standalone host, recording a verdict and evidence class per feature claim into the shared register. This section carries the onboarding path **and** the standalone product page itself.

**Files** (`~/Documents/GitHub/switchboard-site/src/pages/docs/getting-started/`) — counts verified against the tree:

| File | Lines |
|---|---|
| `headless-switchboard.md` | 106 |
| `control-plane.md` | 102 |
| `plan-scanner.md` | 71 |
| `how-switchboard-compares.md` | 67 |
| `quick-start.md` | 66 |
| `installation.md` | 61 |
| `agentic-coding-apps.md` | 48 |
| `multi-repo.md` | 37 |
| `agent-auto-setup.md` | 36 |

### `headless-switchboard.md` is audited here — scope change from the first draft

The first draft of this feature **excluded** this file, on the grounds that it was "written when standalone was substantially less capable and describes limits that no longer hold." That characterisation is wrong in both directions and the exclusion has been reversed.

- **It is not stale.** Last revised **2026-08-01** (`5a13705`, *"Docs: document the browser PTY terminal fleet, correct headless parity claims"*) — a week old.
- **Its error runs the other way.** It is **over-confident, not stale-restrictive**. It asserts that standalone columns "reflect *your configured* set, not the built-in default" — directly contradicted by `bootstrap.ts:405`/`:434`, which emit `DEFAULT_KANBAN_COLUMNS` — and scopes the entire remaining gap to "Automation and the Orchestrator."
- **It is the most standalone-specific page in the corpus.** 106 lines of concrete, testable claims *about the thing being audited*: launcher flags, the Node 22+ requirement, one-time-token sign-in and session-cookie attributes, `Host`-header rejection, single-writer exclusivity, the left-rail inventory, the theme toggle, hash deep links (`/#board`, `/#terminals`), fail-closed PTY on macOS/Windows only, per-host secret-entry behaviour, the `secrets set/list/delete` CLI, surface-routed dispatch, and the claim that the Implementation view has no rail entry.

Excluding 106 lines of unverified standalone claims from a standalone audit is indefensible. **It is audited like every other file, under one special rule:**

> **It contributes no requirements.** It may never be cited to justify, excuse or close a gap on any other page, in this section or any other. Its own claims are checked against runtime, never treated as specification. Where it disagrees with observed behaviour, the observation wins and the row is a `GAP` **against the doc**, flagged for the closeout rewrite.

It remains the closeout subtask's rewrite target — now rewritten from its own verdicts as well as the register's.

### Problem analysis

The docs document the **extension's** feature set. Every user-facing feature described is one standalone is expected to have; every mismatch is a standalone defect.

This section carries the onboarding path, so a gap here is disproportionately visible — it is what a new user hits first. Two files are known to intersect defects already identified: `multi-repo.md` describes repo scoping, and both standalone state builders hardcode `repoScopeFilter: null` / `activeFilter: null` (`src/standalone/bootstrap.ts:406`, `:435`); `control-plane.md` describes control-plane selection, and the same two lines hardcode `controlPlaneMode: 'none'`. Both are covered by `standalone-state-builders-delegate-to-getfullstatemessages.md` — link that plan rather than writing duplicates.

### The false-green mechanism (verified — do not re-derive)

1. **Every verb is reachable.** `bootstrap.ts:1140`'s `default:` arm delegates to `KanbanProvider.handleServiceVerb` (`src/services/KanbanProvider.ts:7365`), so every write lands.
2. **Both state builders fabricate the board payload** — `bootstrap.ts:404-410` and `:433-439`: `updateColumns` → `DEFAULT_KANBAN_COLUMNS` (`:405`/`:434`); `updateWorkspaceSelection` → `activeFilter: null`, `controlPlaneMode: 'none'`, `controlPlaneRoot: null`, `repoScopeFilter: null`, `projectContextEnabled: false` (`:406`/`:435`); `cliTriggersState` → `enabled: false` (`:407`/`:436`); `switchboardThemeNameSetting` → `theme: 'afterburner'` (`:408`/`:437`); `updateBoard` → `routingConfig: {}` (`:409`/`:438`).
3. **The literals are re-asserted ~40 ms later** — `schedulePushFullState()` at `:1156`, `PUSH_COALESCE_MS = 40` at `:459`.

**The transport is not dead.** The claim that `KanbanProvider.postMessage` has no sink in standalone is **false**: `bootstrap.ts:692/758/1757` wire a shared `BroadcastHub` with the API server, and `BroadcastHub.push` mirrors to WS regardless of webview binding (`src/services/broadcastHub.ts:80-91`). Do not attribute stale UI to a missing transport.

### Evidence rules (binding — the register header is the authoritative copy)

- **A — Runtime observed** in a running browser host. **Required** for any `LIVE` verdict on a user-facing feature.
- **B — Passing contract test** naming the behaviour.
- **C — Code path traced end-to-end** including push path and UI render. Never sufficient alone.
- **Not evidence:** verb reachability, `{success:true}`, a landed DB write, or the presence of a handler.
- **Settle-and-reload:** re-observe any board-displayed state after ~1 s and after a page reload before recording `LIVE`.
- **Attribute observations, not causes.** Record what was seen; never write a root cause into a row unless independently confirmed against the tree at audit time.
- Record a line-coverage figure per file; under 100% means unfinished.
- `headless-switchboard.md` contributes no requirements (see above) — audited, never cited.
- `BLOCKED` is not a verdict; resolve or escalate it, never count it as audited.

Where this restatement differs from the register header, the header wins.

## User Review Required

None.

## Complexity Audit

### Routine
- Reading each file and extracting claims.

### Complex / Risky
- **Auditing `headless-switchboard.md` without citing it.** This is the subtlest trap in the feature: the auditor is reading a page full of confident standalone claims while auditing standalone. Every one of its claims is a row to test, and none of them may be used as the basis for a verdict elsewhere. Where a claim in it is contradicted by observation, the row is a `GAP` **against the doc**, not a pass for the feature.
- **The column claim in `headless-switchboard.md` is a predicted, specific failure.** "Columns reflect *your configured* set, not the built-in default" versus `DEFAULT_KANBAN_COLUMNS` at `:405`/`:434`. Test it with a real custom column in the workspace — with only defaults present, the claim looks true.
- **`installation.md`, `quick-start.md` and `headless-switchboard.md` describe host setup** including the `npx switchboard` launcher, its flags (`--workspace`, `--port`, `--no-open`, `--help`), the Node 22+ engine requirement, and one-time-token sign-in. These are directly testable and must be exercised **literally** — run the documented commands, do not read them.
- **`how-switchboard-compares.md` is positioning, not feature documentation.** Most of it will be `N/A`. Mark each line explicitly as non-claim content rather than skipping, or line coverage cannot be verified. Do not manufacture rows to inflate the count.
- **`control-plane.md` requires a control-plane workspace.** If the harness workspace is not a control plane, these claims are `BLOCKED` — provision one or record them blocked, never `LIVE` by inference.
- **`multi-repo.md` and `control-plane.md` overlap known defects.** Link `standalone-state-builders-delegate-to-getfullstatemessages.md`; do not re-plan.
- **`plan-scanner.md` and `agent-auto-setup.md` describe background behaviour** rather than clicked UI. Verify by inducing the trigger (drop a plan file, launch an agent) and observing the outcome in the browser, not by locating the watcher code.
- **The single-writer claim constrains the audit itself.** `npx switchboard` refuses to start when the extension already serves the workspace. That claim is testable *and* it is the constraint the harness had to work around — verify it, and record which arrangement was used.

## Edge-Case & Dependency Audit

**Race Conditions** — plan-scanner claims involve a filesystem watcher; allow settle time and re-observe before recording a verdict. Board-displayed outcomes are additionally subject to the 40 ms coalesced push.

**Security** — the sign-in claims involve one-time tokens and session cookies (`HttpOnly`, `SameSite=Strict`) and a `Host`-header rebinding guard. Verify behaviour; **never record token or cookie values**. The register feeds a public doc rewrite.

**Side Effects** — exercising the launcher starts and stops hosts, and `--port` / `--workspace` change what is being served. Coordinate with any other section audit running concurrently, since standalone is an exclusive single writer — this section is the most likely to disrupt a sibling section mid-run.

**Dependencies & Conflicts** — overlaps the **Standalone Push-Path Parity** feature, which has **three** subtasks, not seven. `standalone-workspace-selection-fields-hardcoded.md` was cited by the first draft of this plan and **no longer exists** — it was merged into the delegation plan on 2026-08-07. Use this mapping:

| Observed gap touches | Link this plan |
|---|---|
| repo scope, control-plane mode, workspace-selection fields, columns, routing config, CLI triggers, theme | `standalone-state-builders-delegate-to-getfullstatemessages.md` |
| unbounded queue growth / messages never delivered to a bound webview | `restore-backlog-view-to-standalone-host.md` |
| absence of a CI number for a parity class | `standalone-push-parity-guard.md` |

## Dependencies

- **Harness subtask** (`audit-standalone-against-extension-docs.md`) — the register, evidence rules, both audited build artefacts, and the documented single-writer arrangement.

## Implementation

For each file, largest first (starting with `headless-switchboard.md`):

1. Read every line.
2. Extract each user-facing feature or behaviour claim as a register row; mark non-claim content `N/A` explicitly.
3. Exercise it against the running standalone host — run documented commands and flags **literally**.
4. For `headless-switchboard.md`, record each claim as a row and mark contradicted claims `GAP` against the doc, flagged for the closeout rewrite. Cite none of them elsewhere.
5. Re-observe board-displayed outcomes after ~1 s and after reload.
6. Record verdict, evidence class and the line-coverage figure.
7. For each `GAP` / `PARTIAL`, apply the link mapping above, else flag for closeout.

## Proposed Changes

### `.switchboard/audits/standalone-extension-parity.md`
- **Logic:** Append `getting-started` rows — now including `headless-switchboard.md` — with verdicts, evidence classes and coverage figures.
- **Edge Cases:** Positioning prose marked `N/A` explicitly; control-plane claims need a control-plane workspace or a `BLOCKED` row; `headless-switchboard.md` rows are audited but never cited; no row links a merged-away plan file.

## Verification Plan

1. All 9 files — including `headless-switchboard.md` — carry a recorded line-coverage figure, each 100%.
2. No `LIVE` verdict on a user-facing feature rests on evidence class C alone.
3. Zero rows cite verb reachability, `{success:true}`, or a landed DB write.
4. Every documented `npx switchboard` flag was actually run, and the Node 22+ requirement was tested rather than assumed.
5. Control-plane claims are either verified against a real control-plane workspace or recorded `BLOCKED` — never inferred.
6. `headless-switchboard.md` has rows of its own, **and** no row anywhere in the register cites it as the basis for a verdict.
7. The "columns reflect your configured set" claim was tested against a workspace containing a real custom column, and the result recorded.
8. No token or cookie value appears anywhere in the register.
9. Independent re-check of a random 10% of `LIVE` rows; any failure invalidates the section for re-audit.
10. Every `GAP` / `PARTIAL` links an existing plan or is flagged for closeout — and no row links a merged-away plan file.

## Recommendation

Complexity 5 → **Send to Lead Coder.** Raised from 4 by the addition of `headless-switchboard.md`: the section now audits the standalone product page itself, and the audited-but-never-cited discipline is the subtlest rule in the feature.
