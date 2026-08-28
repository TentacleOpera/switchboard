# Make the standalone push-parity gate reachability-aware

## Goal

`scripts/check-standalone-push-parity.js` reported green while eight board-state messages were undeliverable in the standalone host, including the one whose absence disabled forward drag-drop. The gate counts message types by **emission site**, not by whether that site is reachable from the standalone composition root. Close that blind spot so the next occurrence fails CI instead of shipping.

### Problem Analysis

The guard's own header states its assertion:

> MESSAGE-TYPE COVERAGE (ratcheted): the set of message types the shared board handles (Set A, extracted from `kanban.html`'s message listener) minus the types standalone can actually deliver (Set B: literal broadcasts in `bootstrap.ts` ∪ **provider postMessage types, conditional on a broadcaster being installed**).

The parenthetical is the defect. `updateAgentNames` is emitted by `this.postMessage({ type: 'updateAgentNames', agentNames })` at `KanbanProvider.ts:2502`, so the AST walk adds it to Set B. But that call site sits inside `refreshWithData`, whose only caller is `TaskViewerProvider._refreshRunSheetsImpl:21259` — the extension refresh path. Standalone's `switchboard.refreshUI` is registered to `schedulePushFullState()` (`bootstrap.ts:1130`), which reaches `getFullStateMessages` and nothing else. The type is emittable in principle and unreachable in fact, and the gate cannot tell the difference.

The same reasoning covers seven more types (`visibleAgents`, `updateColumnDragDropModes`, `dynamicComplexityRoutingState`, `allowUnknownComplexityAutoMoveState`, `collapseCodersState`, `clearTerminalBeforePromptState`, `liveSyncStates`) — all emitted from the same unreachable cluster at `KanbanProvider.ts:2470-2520`.

Worse, "a broadcaster being installed" is asserted separately and correctly (assertion 2), which makes the parenthetical read like a genuine reachability condition. It is not: a broadcaster makes `postMessage` *able* to fan out, not the method containing it *able to run*.

### Root Cause

The guard was written to replace manual verb-reachability audits — which "cannot fail, because bootstrap.ts's `default:` arm delegates every unmatched verb to the provider" — with a mechanical count of the read-back path. It succeeded at the read-back path in one direction (are the payload fields live, not hardcoded?) and reproduced the original error in the other: it substituted *symbol presence* for *reachability*, exactly as the verb audits substituted *verb presence* for *wiring*. `CLAUDE.md` names the general form: "the seams each host wires are the audit — not the verbs each host answers." A message type is a seam; its emission site is not evidence the seam is wired.

Assertion 3's floor already points at the right primitive — "the state builders must obtain their message list from `kanbanProvider.getFullStateMessages(...)`". That makes `getFullStateMessages` the single standalone read-back route, and therefore the only honest basis for Set B.

## Metadata

**Complexity:** 5
**Tags:** test, devops, reliability, refactor

## Approach

1. **Redefine Set B as what the standalone route actually produces.** Since assertion 3 pins `pushFullState` to `getFullStateMessages`, Set B becomes: literal broadcasts in `bootstrap.ts` ∪ the types returned by `getFullStateMessages`. Prefer *executing* the builder against a fixture workspace and reading `msg.type` off the result over AST-walking it — a runtime set cannot be fooled by a conditional spread, a helper, or a message built into a local first (the three shapes the current walk already documents as under-counting).

2. **Keep provider `postMessage` types, but only reachable ones.** Some verbs legitimately push from inside `handleServiceVerb` (which standalone *does* reach through the `default:` arm). The distinction is the enclosing method: reachable if standalone can call it. Implement as a reachability walk from the standalone entry points (`kanbanVerb`, `pushFullState`, `getFullState`, the registered `switchboard.*` commands) rather than a hand-maintained method allowlist — a list will rot the way the `boardStructure` justification comment rotted.

3. **Re-baseline the ratchet honestly.** Fixing Set B raises the measured gap. Record the new, true number as the baseline in `standalone-parity-allowlist.json` with a dated note explaining that the jump is a measurement correction, not a regression. Then lower it as the state-parity plan lands. Do not tune the baseline to keep CI green — the point of the correction is that the number was wrong.

4. **Add a targeted, non-vacuous pin for the drag-drop path specifically.** A contract test asserting that the message types the board's forward-drop gate depends on — `updateAgentNames`, `visibleAgents`, `updateColumnDragDropModes` — are present in `getFullStateMessages` output. Named for what breaks when they are absent ("forward drag-drop is silently discarded without these"), so the next reader knows what the test is protecting, not just that it passes.

5. **Extend the same reasoning to capability flags.** The board is gated in two ways: by pushed state and by injected `data-host-capabilities` CSS. The second has no gate at all, and one of its rationales had already expired (`transport.js:563-570` cites `bootstrap.ts:334, :363` for a hardcode that no longer exists there). Add an assertion that every selector in `applyCapabilityGating`'s CSS blocks matches at least one element in at least one shipped panel — the guard's own comments record two branches that matched nothing and were therefore decorative. Scope this step out into its own change if it grows.

## Complexity Audit

### Routine

- Reading the existing script; it is well-commented and already ratchet-shaped.
- Re-recording a baseline.

### Complex / Risky

- **Executing `getFullStateMessages` in a CI script needs a workspace and a DB.** It reads `vscode.workspace.getConfiguration` (`KanbanProvider.ts:1345-1346`), so a runtime approach needs the shim or a seam. If that proves too heavy for a lint-style script, the fallback is an AST walk *scoped to the enclosing method* — strictly better than today's file-wide walk, but weaker than execution. Decide deliberately and record which was chosen and why.
- **A reachability walk can over-approximate.** `handleServiceVerb` is a giant switch; treating every `postMessage` inside it as reachable is roughly right (the `default:` arm reaches the whole method) but will admit types pushed from arms standalone shadows with its own case (`createFeature`, `triggerAction`, `sendToTerminal`, the `pty*` family). Handle the shadowed arms explicitly — `bootstrap.ts`'s switch is the authority on which verbs never reach the provider.
- **Raising a ratchet baseline is the one move the convention forbids** ("may only ever be LOWERED, never raised"). This change requires it, because the old number measured the wrong thing. That needs an explicit, reviewed exception with the reason recorded in the allowlist file — not a quiet edit.
- **Step 5 could balloon.** Selector-existence checking across every panel is a second guard wearing the first one's clothes. If it does not land cleanly in the same change, split it.

## Edge-Case & Dependency Audit

**Migration.** None — CI tooling only. No user-facing behaviour, no persisted state.

**Interaction with the fix plans.** This gate must be able to *fail* on today's `HEAD` before the state-parity plan lands, and pass after. Verify in that order: a gate that only ever passes proves nothing. Run it against the commit before the fix and assert a non-zero gap for the eight types.

**Both hosts.** The gate is standalone-directed by construction, but assertion 3's delegation floor touches shared code. Confirm the extension's board is not implicated by any change here — this plan should produce no runtime diff at all.

**False-negative risk after the change.** The new Set B is narrower, so previously-"covered" types will surface as gaps. Some may be genuinely extension-only and belong in the existing allowlist. Each such entry needs a one-line reason; an unexplained allowlist entry is how the next blind spot gets recorded as intentional.

## Verification Plan

1. **The gate fails before the fix.** Check out the commit preceding the state-parity change, run `npm run standalone-parity:check` with the new Set B, and assert it reports `updateAgentNames`, `visibleAgents` and `updateColumnDragDropModes` as gaps. Record the output — this is the deliverable that proves the gate is non-vacuous.
2. **The gate passes after the fix**, with a lowered baseline.
3. **Mutation test the pin.** Delete the `updateAgentNames` entry from `getFullStateMessages` and assert the new contract test (step 4) fails with a message naming the drag-drop consequence. Restore.
4. **Shadowed-arm handling:** assert a type pushed only from an arm `bootstrap.ts` shadows (e.g. inside the provider's `triggerBatchAction`) is not counted as standalone-deliverable unless standalone's own arm delivers it.
5. **Baseline exception is documented:** `standalone-parity-allowlist.json` carries the dated note explaining the raise, and every allowlist entry has a reason.
6. `npm run compile` clean; the full contract suite green; the gate itself runs in CI in under the time budget the other ratchets use.

## Dependencies

- Companion to **the eight-missing-pushes plan** (which this gate must fail on, then pass) and **the drag-drop UI plan** (whose stale capability rationale motivates step 5).
- Follows the ratchet convention established by `scripts/check-push-routing.js` and the precedent recorded in `CLAUDE.md`'s 2026-08 queue-seam note, which is the same failure this gate exists to catch.
