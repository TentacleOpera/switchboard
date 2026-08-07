# Doc-Parity Audit — `getting-started` Section (8 files, 488 lines)

## Metadata

**Complexity:** 4
**Tags:** audit, standalone, parity
**Project:** Browser Switchboard

## Goal

Audit every line of the `getting-started` documentation section against the running standalone host, recording a verdict and evidence class per feature claim into the shared register.

**Files** (`~/Documents/GitHub/switchboard-site/src/pages/docs/getting-started/`):

| File | Lines |
|---|---|
| `control-plane.md` | 102 |
| `plan-scanner.md` | 71 |
| `how-switchboard-compares.md` | 67 |
| `quick-start.md` | 66 |
| `installation.md` | 61 |
| `agentic-coding-apps.md` | 48 |
| `multi-repo.md` | 37 |
| `agent-auto-setup.md` | 36 |

**`headless-switchboard.md` (106 lines) is deliberately excluded from this subtask.** It is stale, contributes no requirements, and is rewritten in the closeout subtask.

### Problem analysis

The docs document the **extension's** feature set. Every user-facing feature described is one standalone is expected to have; every mismatch is a standalone defect.

This section carries the onboarding path, so a gap here is disproportionately visible — it is what a new user hits first. Two files are known to intersect defects already identified: `multi-repo.md` describes repo scoping, and standalone hardcodes `repoScopeFilter: null` / `activeFilter: null` in both state builders (`src/standalone/bootstrap.ts:341`, `:370`); `control-plane.md` describes control-plane selection, and standalone hardcodes `controlPlaneMode: 'none'` alongside it. Both are covered by `standalone-workspace-selection-fields-hardcoded.md` — link that plan rather than writing duplicates.

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
- **`how-switchboard-compares.md` is positioning, not feature documentation.** Most of it will be `N/A`. Mark each line explicitly as non-claim content rather than skipping, or line coverage cannot be verified. Do not manufacture rows to inflate the count.
- **`installation.md` and `quick-start.md` describe host setup**, including the `npx switchboard` launcher, its flags, Node version requirement, and the one-time-token sign-in. These are directly testable and should be exercised literally — run the documented commands rather than reading them.
- **`control-plane.md` requires a control-plane workspace.** If the harness workspace is not a control plane, these claims are untestable — provision one or record them as blocked, never as `LIVE` by inference.
- **`multi-repo.md` and `control-plane.md` overlap known defects.** Link `standalone-workspace-selection-fields-hardcoded.md`; do not re-plan.
- **`plan-scanner.md` and `agent-auto-setup.md` describe background behaviour** rather than clicked UI. Verify by inducing the trigger (drop a plan file, launch an agent) and observing the outcome in the browser, not by locating the watcher code.

## Edge-Case & Dependency Audit

**Race Conditions** — plan-scanner claims involve a filesystem watcher; allow settle time and re-observe before recording a verdict.

**Security** — the sign-in claims in `installation.md` involve one-time tokens and session cookies. Verify behaviour; never record token values.

**Side Effects** — exercising the launcher may start and stop hosts. Coordinate with any other section audit running concurrently against the same workspace, since standalone is a single writer.

**Dependencies & Conflicts** — overlaps `standalone-workspace-selection-fields-hardcoded.md`.

## Dependencies

- **Harness subtask** (`audit-standalone-against-extension-docs.md`).

## Implementation

For each file, largest first:

1. Read every line.
2. Extract each user-facing feature or behaviour claim as a register row; mark non-claim content `N/A` explicitly.
3. Exercise it against the running standalone host — run documented commands literally.
4. Record verdict, evidence class and the line-coverage figure.
5. For each `GAP` / `PARTIAL`, link the covering plan if one exists, else flag for closeout.

## Proposed Changes

### `.switchboard/audits/standalone-extension-parity.md`
- **Logic:** Append `getting-started` rows with verdicts, evidence classes and coverage figures.
- **Edge Cases:** Positioning prose marked `N/A` explicitly; control-plane claims need a control-plane workspace or a blocked verdict.

## Verification Plan

1. All 8 files carry a recorded line-coverage figure, each 100%.
2. No `LIVE` verdict on a user-facing feature rests on evidence class C alone.
3. Zero rows cite verb reachability, `{success:true}`, or a landed DB write.
4. Every documented `npx switchboard` flag in `installation.md` was actually run.
5. Control-plane claims are either verified against a real control-plane workspace or recorded as blocked — never inferred.
6. `headless-switchboard.md` has no rows in this section and is cited by none.
7. Independent re-check of a random 10% of `LIVE` rows; any failure invalidates the section for re-audit.

## Recommendation

Complexity 4 → **Send to Coder.** Straightforward once the harness exists; the judgement calls are marking positioning prose `N/A` honestly and not inferring control-plane behaviour.
