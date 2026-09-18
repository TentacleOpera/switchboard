# Reverse the PTY standalone-only Constraint

## Goal

Rescind the "PTY terminals are standalone-only" directive across the plan corpus and the CI gate that enforces it, so the extension host can legitimately own a PTY fleet. This plan changes **records and one test's scope only** — no runtime behaviour changes here. It must land before the extension-host PTY work, or that work contradicts the repo's own recorded constraints and fails a green CI gate.

### Problem analysis / root cause

On 2026-07-31 the user directed that PTY terminals be standalone-only, and that directive was encoded in four places as a hard constraint:

- `.switchboard/features/standalone-browser-pty-terminal-fleet-b9f7d76d-a8bb-4a1a-aca1-82d90cae97bf.md:8` — "Hard constraint (user directive 2026-07-31): standalone-only — VS Code mode continues to use VS Code terminals, **the extension bundle must never import node-pty**, and the extension-hosted browser gets no Terminals panel."
- All four subtask plans carry a `### Hard constraint — user directive 2026-07-31` section saying the same thing.
- `pty-fleet-backend-standalone-terminal-registry.md` Non-Goals: "No PTY in the VS Code extension host, **ever**."
- `src/test/pty-standalone-only-contract.test.js`, wired into CI as `test:contract:pty-standalone-only`, **fails the build** if `dist/extension.js` contains a node-pty module reference.

Later the same day the user reversed the direction, for two reasons the original directive did not weigh: (1) the VS Code marketplace is the only distribution channel that actually exists — `switchboard` on npm is a third party's package (an event-listener library by `bryn.bellomy`), nothing has been published, and discoverability lives entirely in the marketplace; (2) a browser terminal surface Switchboard owns can do things VS Code's terminal panel structurally cannot — layouts, per-worktree tab switching, agent completion messages — so it is a better experience, not merely parity.

The records must be reversed explicitly rather than silently contradicted. A coder handed "add PTY to the extension host" against the current repo reads "never, ever" plus a passing gate that forbids it, and correctly stops.

## Metadata

**Complexity:** 2
**Tags:** documentation, infrastructure, ci
**Project:** Browser Switchboard

## User Review Required

- None. The direction is the user's own stated reversal (2026-07-31); this plan only records it.

## Non-Goals

- No runtime code changes. Capability flags, packaging and routing belong to `extension-host-pty-fleet-and-packaging.md`.
- The `isPtyAvailable()` probe and its capability derivation stay exactly as they are — they are already the right shape for a host-agnostic gate.
- Does NOT delete the contract test. Its import-location check (a) stays valuable; only the bundle-purity check (b) is rescoped.

## Implementation Steps

### 1. Feature file

- Replace the line-8 hard constraint with the new directive, dated, keeping the old one visible as superseded (the corpus convention — see the `> **Superseded:**` blocks in the existing subtask plans). New text: PTY terminals are available in BOTH hosts; the extension bundle MAY carry node-pty behind the availability probe; the extension-hosted browser gets the Terminals panel.
- Record the two reasons (marketplace-only distribution; owned-surface UX) so the reversal is self-explaining without this plan.

### 2. Four subtask plans

- In each `### Hard constraint — user directive 2026-07-31` section, mark superseded and point at this plan. Do not delete the original text — the code still carries comments justifying standalone-only decisions, and a reader needs to know why they existed.
- `pty-fleet-backend-standalone-terminal-registry.md` Non-Goals: replace "No PTY in the VS Code extension host, ever" with the packaging plan reference.

### 3. Rescope the contract test

`src/test/pty-standalone-only-contract.test.js` currently makes three assertions. Their fates differ:

- **(a) import location** — every node-pty *module reference* in `src/` lives under `src/standalone/`. **KEEP, but widen** the allowed set to include the new extension-host PTY module directory once plan 2 creates it. This check remains the cheap first line of defence and needs no build.
- **(b) bundle purity** — `dist/extension.js` carries no node-pty module reference. **INVERT.** Under the new direction the reference is expected. Replace with: node-pty is only ever reached through the availability-probe path, i.e. assert there is no *unguarded* construction site. A grep cannot prove "guarded", so this is a genuinely weaker check than what it replaces — state that limitation in the test's own header comment rather than pretending otherwise.
- **(c) webpack externals** — standaloneConfig externalizes node-pty. **KEEP and extend** to assert the extension config externalizes it too (it must not be bundled into the JS; the `.node` binary is loaded at runtime from `node_modules`).
- Rename the test and its npm script from `pty-standalone-only` to `pty-host-gating` so the name stops asserting a constraint that no longer holds. Update `.github/workflows/integration-tests.yml` in the same commit — a renamed script with a stale CI reference is a silently-skipped gate.

### 4. Record the honest trade

Add a note to the feature file: reversing this swaps a hard, mechanically-verifiable invariant ("never in the extension bundle") for a soft one ("only behind the gate"). The compensating control is that the availability probe is the single derivation point for `terminalDispatch`, `terminalFleet` and `availability.terminals` — so a reviewer has exactly one function to audit.

## Proposed Changes

### `.switchboard/features/standalone-browser-pty-terminal-fleet-*.md`
- **Logic:** Superseded-block the line-8 constraint; add the new directive with date + rationale; add the hard-invariant-to-soft-invariant note.

### `.switchboard/plans/pty-*.md`, `browser-terminals-panel-xterm.md`, `standalone-dispatch-via-pty-fleet.md`
- **Logic:** Superseded-block each hard-constraint section; fix the backend plan's "ever" non-goal.

### `src/test/pty-standalone-only-contract.test.js` → `src/test/pty-host-gating-contract.test.js`
- **Logic:** Keep (a) widened and (c) extended; invert (b) to an unguarded-construction check with an explicit note on its weakness.
- **Edge cases:** The test currently exempts itself from check (a) because it contains the very module-reference strings it searches for — preserve that exemption.

### `package.json` + `.github/workflows/integration-tests.yml`
- **Logic:** Rename `test:contract:pty-standalone-only` → `test:contract:pty-host-gating`; update the CI step in the same commit.
- **Edge cases:** A rename without the CI update is a silently-skipped gate — the exact "green while incomplete" hole this test exists to close.

## Verification Plan

### Automated
- `npm run test:contract:pty-host-gating` passes on the current tree (before plan 2 lands, there is still no node-pty in the extension bundle, so the inverted check must not *require* one — it asserts "no unguarded construction", which is vacuously true).
- `npm run catalog:check`, `parity:check`, `verb-returns:check`, `mirror:check` — unaffected, must stay green.
- Grep gate: zero occurrences of the old script name `pty-standalone-only` outside this plan's own superseded notes.

### Manual
- Read the feature file top-to-bottom as a newcomer: the current direction must be unambiguous on first read, with the old one clearly marked historical.

## Completion Report

Implemented 2026-07-31. Reversed the standalone-only directive in the feature file (new directive + both reasons + the hard-invariant-to-soft-invariant trade, with the original retained in a superseded block) and in all four subtask plans, each keeping its original text and gaining a note on what still holds — the WS plan now flags that `rejectWhenTokenEmpty` would reject every extension-host upgrade until §2b's terminal-scoped token lands, and the dispatch plan records that "extension-host dispatch untouched" is permanent under the per-surface model rather than temporary. Replaced `src/test/pty-standalone-only-contract.test.js` with `src/test/pty-host-gating-contract.test.js`: instead of the old bundle-purity grep (which node-pty in the extension bundle will legitimately violate), it pins the two structural facts that keep the soft invariant auditable — exactly one module performs a runtime node-pty load and it is `ptyBackend.ts`, and that module exports `isPtyAvailable()` with a catch — plus no `.node` binary is ever webpack-bundled and node-pty is externalized wherever a webpack config references it. Renamed the npm script to `test:contract:pty-host-gating` and updated the CI step and its now-contradictory comment in the same commit, so the gate cannot silently unwire.

Both new assertions were negative-controlled: planting a second `require('node-pty')` in `kanbanService.ts` trips check 1, and renaming the probe export trips check 2; both files were restored byte-identical afterwards. Validation: `tsc` clean of PTY errors (5 pre-existing TS2835 in untouched files remain), webpack 0 errors, lint 0 errors, 5/5 ratchets and 6 contract suites green. Deliberately NOT done, per the plan's design: check (a) was left as a single-entry `ALLOWED_LOAD_SITES` list rather than speculatively widened to a directory that plan 2 has not created, and the extension-config externals assertion is conditional rather than required, so this test passes both before and after plan 2 without needing a second edit.
