---
description: "Root-cause guard: turn the existing analyze-verb-migration2 return/break measurement into an enforced ratchet gate so a provider whose read arms still `break` (return no data) can no longer pass as green. This is the missing check that let the Design/Setup/TaskViewer/Planning burndowns reach CODE REVIEWED with the return-in-body contract unmet."
---

# Verb Engine — Return-Contract Ratchet (CI Gate)

## Metadata
- **Project:** browser-switchboard
- **Tags:** backend, testing, api, architecture
- **Complexity:** 4
- **Release phase:** B1 headless prerequisite (process guard). Underwrites the two Layer-1 completion plans (`a2b-verb-engine-layer1-completion-return-schemas-tests.md`, `a2b-verb-engine-layer1-completion-planning.md`): those drive the break counts to 0; this plan makes the counts *enforceable* and monotonic so they can never regress.

## Goal

Add an enforced CI ratchet that fails when a verb provider's `_handleMessage` switch contains read/query arms that `break` instead of `return`-ing their result. Seed it at the current per-provider counts (so it is green today) and forbid any increase, so incomplete Layer-1 work can no longer reach CODE REVIEWED green. As each completion plan lands, the ceiling for that provider ratchets down to 0.

### Problem / root-cause analysis

Every verb-engine burndown that "passed review while unfinished" passed for the **same structural reason**: the CI ratchets that gate dispatch verify dispatch **shape** and `vscode`-**absence**, but *nothing* asserts an arm **returns** its data. Verified:

- The gate scripts are `catalog:check`, `parity:check` ([check-protocol-parity.js]), and `push-routing:check` ([check-push-routing.js]) — none inspect `return` vs `break`.
- `scripts/analyze-verb-migration2.js` **already computes** the exact signal — per-provider `break=<n>, return=<n>` inside each switch block ([analyze-verb-migration2.js:45-49](../../scripts/analyze-verb-migration2.js#L45)) — but it only `console.log`s; it never exits non-zero, and it is not wired into any `npm run *:check` gate.

So a provider can show `return=2 / break=123` (Setup), `return=0 / break=146` (TaskViewer), or ~`break=340` (Planning) and still be "green," because the one script that sees the gap doesn't enforce it. This is the root cause of the weeks of "looks done, isn't" — the board's CODE REVIEWED tag was earned against checks that structurally cannot detect the missing return contract. This plan closes that hole once, for all providers.

## User Review Required
- **One product call (default recorded):** should the ratchet require **all** touched arms to `return` (Kanban's `break=0` template — simplest, strictest) or only *read-classified* arms (`get*`/`fetch*`/`load*`/`list*`/`browse*`/`read*`) to return data while pure command arms may keep the ack? **Recommendation: ratchet on total in-switch `break` count per provider (baseline-and-lower), with a read-verb classifier used only to make the failure message precise.** Total-break is unambiguous, matches the Kanban template, and avoids arguing per-arm whether a result is "meaningful."

## Scope

### ✅ IN SCOPE
- **A gate script** `scripts/check-verb-return-contract.js` that reuses `analyze-verb-migration2.js`'s switch-extraction to compute the per-provider in-switch `break` count, compares each against a checked-in **baseline ceiling**, and exits non-zero if any count **exceeds** its ceiling (ratchet: counts may only decrease). On failure it names the provider, its count, its ceiling, and (via the read-verb classifier) how many *read* arms still `break`.
- **A committed baseline file** (e.g. `scripts/verb-return-contract-baseline.json`) seeded at today's counts — Kanban `0`, plus Design/Setup/TaskViewer/Planning at their current numbers — so the gate is green on introduction and only ever tightens.
- **`npm run verb-returns:check`** in `package.json`, added to the same aggregate gate the coder/reviewer preflight runs alongside `parity:check` / `push-routing:check`.
- **A drop-the-ceiling step**: when a completion plan migrates a provider, it lowers that provider's baseline entry (to `0` for a fully-migrated provider) in the same change, so the ratchet locks in the win.
- Docs: a one-paragraph note in the verb-engine contract/docs explaining the gate and how to lower a ceiling.

### ⚙️ OUT OF SCOPE
- Actually converting arms `break→return` → the two Layer-1 completion plans. This plan only measures and enforces.
- Schema-presence enforcement (a sibling idea) — could be a follow-on ratchet; not required here.
- Any provider behaviour change.

## Implementation Steps
1. Factor the switch-block extraction + `break`/`return` counting out of `analyze-verb-migration2.js` into a small shared helper (or import it) so the gate and the analyzer agree exactly.
2. Write `scripts/check-verb-return-contract.js`: load the baseline JSON, compute current per-provider break counts, `process.exit(1)` with a clear diff if any exceeds baseline; print the read-arm subset for actionable messaging.
3. Generate and commit `verb-return-contract-baseline.json` at current counts (run the analyzer once to seed).
4. Add `"verb-returns:check"` to `package.json` scripts and to the aggregate preflight/CI gate list.
5. Verify: gate is green now; artificially adding a `break` to a migrated provider (or raising a count) makes it red; lowering a ceiling below the current count makes it red until arms are converted.

## Complexity Audit
### Routine
- Reusing existing extraction logic; JSON baseline compare; one npm script + gate wiring.
### Complex / Risky
- **False negatives from naive counting** — `break` inside nested `switch`/loops *within* an arm would inflate the count. Reuse `analyze-verb-migration2.js`'s existing block bounds (it already isolates the top-level `_handleMessage` switch) so the measure matches the numbers the completion plans target; if the analyzer already over/undercounts, the ratchet inherits the same definition (consistency matters more than absolute truth here).
- **Baseline drift** — the baseline must be regenerated deliberately (a reviewed commit), never auto-written by the gate, or the ratchet stops ratcheting.

## Dependencies
- `scripts/analyze-verb-migration2.js` (present) — the measurement source of truth.
- Independent of the completion plans, but most valuable landed **before or with** them so their progress is locked in and can't regress.

## Verification Plan
### Automated
- `npm run verb-returns:check` exits 0 at introduction (baseline == current).
- Injecting a spurious `break` into `KanbanProvider` (whose ceiling is 0) makes it exit 1; reverting restores green.
- `npm run compile-tests` unaffected.
### Manual / behavioral
- Lowering Setup's ceiling in the baseline to 0 fails until the Layer-1 Setup arms are converted, then passes — proving the ratchet tracks real completion.
- The failure message names the provider, current count, ceiling, and read-arm subset.

## Completion Report
Implemented the CI return-contract ratchet gate for verb engine providers. Added `scripts/verb-switch-helper.js` for shared switch block parsing, `scripts/verb-return-contract-baseline.json` for ceiling baselines, and `scripts/check-verb-return-contract.js` for ratchet enforcement. Wired `npm run verb-returns:check` in `package.json` and documented in `docs/VERB_ENGINE_RECIPE.md`. Files created/modified: `scripts/verb-switch-helper.js`, `scripts/analyze-verb-migration2.js`, `scripts/verb-return-contract-baseline.json`, `scripts/check-verb-return-contract.js`, `package.json`, `docs/VERB_ENGINE_RECIPE.md`. No issues encountered; gate passes baseline verification cleanly.

