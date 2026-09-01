# Switching Between Group And Team Views Intermittently Corrupts Pane Glyphs

## Goal

Make a group or team view switch leave every seated terminal painting correctly. Today the switch intermittently leaves one or more panes with garbled text, and the repair the code arms for exactly this case is either never run in the switch path or run with the wrong tuning.

### Problem Analysis & Root Cause

**Reported symptom.** Intermittent glyph corruption when switching between group or team views. Intermittent, not universal — consistent with a defect that only fires when a terminal actually changes slot, which depends on group membership and ordering.

**The call chain.** `switchToGroup` (`terminals.js:3589`) does, in this order:

```js
setLayoutMode(layoutForGroupSwitch(group), { keepLock: true });   // → renderPaneGrid(); applyLayoutFloor();
seatActiveGroupPage();                                            // → rewrites paneAssignments; → renderPaneGrid();
```

`seatActiveGroupPage` (`terminals.js:3637`) replaces `paneAssignments` wholesale — `assignments = members.slice(start, start + rendered)`, padded with nulls — so terminals move between slots. `setLayoutMode` can also change the slot count, which makes `renderPaneGrid` `removeChild`/`appendChild` pane elements outright.

**Finding 1 — the resync flags are armed after the only ladder that consumes them.** `renderPaneGrid` arms the repair on a structural delta:

```js
const structureKey = JSON.stringify([effectiveLayout, paneAssignments.slice(0, slotCount), paneModes.slice(0, slotCount), peekTerminalName || null]);
if (structureKey !== lastGridStructureKey) {
    lastGridStructureKey = structureKey;
    for (...) { entry.needsRendererResync = true; }
}
```

`paneAssignments` is in the key, so the switch does arm it. But the consumption happens in the fit ladder reached via `applyLayoutFloor() → batchFitVisiblePanes()`, and in `switchToGroup` the only `applyLayoutFloor()` runs **inside `setLayoutMode`, before `seatActiveGroupPage` has changed the assignments**. So:

1. `setLayoutMode` → `renderPaneGrid` (old assignments) → `applyLayoutFloor` → ladder consumes whatever was armed then.
2. `seatActiveGroupPage` → new `paneAssignments` → `renderPaneGrid` → arms the flags **that matter** — and nothing runs a ladder afterwards.

Those flags then sit until the next 5-second fleet poll (`fetchTerminalList` → `renderPaneGrid` → `applyLayoutFloor` → `batchFitVisiblePanes`), whose own `applyLayoutFloor()` eventually consumes them. A repair that lands up to five seconds late, or not at all if the pane is not `isRendered` at that moment, is exactly the reported intermittency.

**Finding 1b — a second site with the identical defect.** The layout picker change handler (`terminals.js:978-987`) has the exact same sequence:

```js
setLayoutMode(requested, { keepLock });
if (keepLock) {
    // Same ordering as switchToGroup: layout first, then seat.
    seatActiveGroupPage();
}
```

No `batchFitVisiblePanes()` follows. The comment at line 986 says "Same ordering as switchToGroup" — same ordering, same bug. A locked-group operator who grows the layout (2h → 2x2 for a 4-member group) triggers the same stranded-flag defect. This site is reachable whenever a group lock is active and the operator picks a new layout from the picker.

**Finding 2 — when the repair does run, it runs with the wrong tuning.** The consumption site (`terminals.js:8065-8067`):

```js
if (entry.needsRendererResync && entry.term && isRendered(entry.container)) {
    entry.needsRendererResync = false;
    resyncPaneRenderer(entry, 'stale-canvas', { rebuildAtlas: false });
    refreshTerminalScrollbar(entry);
}
```

Its comment says *"rebuildAtlas:false — the atlas is intact on this path"*. That is true of the visibility-regain path it was written for. It is not obviously true after a re-seat, where the pane element may have been destroyed and recreated.

> **Superseded:** Finding 2 as an independent defect requiring its own repair (step 3 of the original plan: "Only if step 1 shows the atlas genuinely goes stale here, widen the tuning").
> **Reason:** `db17215d`'s §3 already introduces `entry.needsAtlasRebuild` and changes the consumption site to read it: `const rebuildAtlas = entry.needsAtlasRebuild === true`. The `needsAtlasRebuild` flag is set `true` ONLY in the `onContextLoss` handler and `swapRenderer` — the paths where the renderer is actually replaced. The structural-delta latch in `renderPaneGrid` (6017-6026) sets `needsRendererResync = true` but does NOT set `needsAtlasRebuild`, which is correct: a same-slot-count re-seat re-parents the container (atlas intact, `rebuildAtlas: false` is right), and a different-slot-count switch that triggers WebGL context loss sets `needsAtlasRebuild` via the `onContextLoss` handler (not via the latch). So the atlas-rebuild question is already handled by `db17215d` through the context-loss path, and this plan's step 3 is expected to be a no-op once `db17215d` lands.
> **Replaced with:** The diagnostic gate (step 1) still runs to CONFIRM this — but the plan now states the expected outcome: `db17215d`'s §3 covers the atlas-rebuild need via the context-loss path, and no additional `rebuildAtlas` widening is required on the re-seat path. If the gate contradicts this, step 3 is the fallback.

**Relationship to `db17215d`** (*Seating a Terminal Into an Empty Grid Slot Corrupts the Glyphs in Its Neighbours*, PLAN REVIEWED). That plan attributes its trigger to **a WebGL context budget counted per document while the browser enforces it per renderer process** (`terminals.js:349-354`), and its own table already names the `rebuildAtlas: false` consumption as a gap — for a different trigger. A group switch that changes slot count destroys and creates pane elements, so it plausibly hits the same context budget.

**This is written as a separate plan at the user's direction, and the first thing it must do is establish whether `db17215d`'s fix already covers this trigger.** If it does, this plan reduces to the ordering defect in Finding 1 (both sites) plus verification, and must not add a second repair for a cause already fixed. Two independent repairs for one root cause is how this area accumulated four partial fixes already.

**Paths analyzed.** `switchToGroup` (3624) and the layout picker `keepLock` branch (987) are the two sites with the ordering defect. The team path (`switchToTeamGroup` at 8553) calls `switchToGroup` and inherits the gap; `focusSeatedTerminal` (8572) then calls `renderPaneGrid` but does NOT re-arm the latch (`focusedPaneIndex` is not in `structureKey`) and does NOT call `batchFitVisiblePanes`, so the team path adds no additional defect beyond what `switchToGroup` already has. `dismissPeek` (6078), called at the top of `switchToGroup`, runs `afterPeekTransition` → `batchFitVisiblePanes` when a peek is active — but that runs BEFORE `setLayoutMode`/`seatActiveGroupPage`, so it consumes pre-switch flags, not post-switch. When no peek is active (the common case), `dismissPeek` early-returns and no ladder runs at all. Either way, the post-switch flags are unconsumed.

## Metadata
**Topic:** Group/team view switch leaves panes with corrupted glyphs
**Tags:** frontend, ui, bugfix, reliability
**Complexity:** 5
**Project:** Browser Switchboard

## User Review Required

None.

## Complexity Audit

### Routine
- Adding `batchFitVisiblePanes()` after `seatActiveGroupPage()` at two call sites — a one-line fix at each, matching the existing pattern at the banner page click (`terminals.js:7808-7810`).
- The structural-delta latch (`structureKey` / `lastGridStructureKey`) is correct and untouched — the flag IS armed, the defect is in when it is consumed.
- `renderPaneGrid`'s no-unconditional-fit invariant is preserved — the fix adds a ladder at the switch call sites, not inside `renderPaneGrid`.

### Complex / Risky
- The diagnostic gate against `db17215d` (step 1) requires applying or scratch-building a plan that is itself PLAN REVIEWED and not yet coded. The gate's outcome determines whether step 3 is needed at all.
- Verifying that the fix does not introduce a repaint storm — the latch exists precisely to prevent the 5-second poll from firing `resyncPaneRenderer` on every visible pane forever. Adding `batchFitVisiblePanes` at the switch sites must not weaken that invariant.
- The layout picker `keepLock` branch (987) is a second site that the original report did not name; missing it leaves half the defect live.

## Edge-Case & Dependency Audit

**Race Conditions:**
- The fit ladder's attempt-0 is a double-rAF (`requestAnimationFrame(() => requestAnimationFrame(() => attempt(0)))`), which converges through the IntersectionObserver non-intersecting window that a re-parent creates. This is the same machinery every other repair in this file uses; no new race is introduced.
- `startFitLadder` uses a generation counter (`fitLadderGen`) — a newer ladder supersedes an older one. If the fleet poll fires while the switch's ladder is still running, the poll's ladder supersedes it cleanly. No double-repair.

**Security:**
- None. This is a paint-layer fix with no input, auth, or data-handling surface.

**Side Effects:**
- Adding `batchFitVisiblePanes()` after `seatActiveGroupPage()` starts a fit ladder for every seated pane. Each ladder's attempt-0 consumes `needsRendererResync` (if armed) and then checks `inspectPaneFit`. For panes that did not move slots and whose geometry is unchanged, `inspectPaneFit` returns `'ok'` and the ladder returns immediately — no repaint. The cost is one `proposeDimensions()` call per pane (a `getComputedStyle` flush), which is the same cost the banner page click already pays.
- The latch invariant: `renderPaneGrid`'s structural-delta gate is NOT weakened. The fix does not make `renderPaneGrid` fit unconditionally; it adds a `batchFitVisiblePanes` call at the switch call sites, which is a one-shot consumption, not a per-poll perpetual trigger.

**Dependencies & Conflicts:**
- **`db17215d` (PLAN REVIEWED, not yet coded).** This plan's step 1 requires applying `db17215d`'s fix (or a scratch build) to determine overlap. If `db17215d` lands first, its §3 (`needsAtlasRebuild` discrimination) already handles the atlas-rebuild question, and this plan's step 3 is expected to be a no-op. If this plan lands first, the consumption site still uses `{ rebuildAtlas: false }` and step 3 may be needed — but the diagnostic gate determines that.
- **Both plans edit `src/webview/terminals.js`.** Under the one-stream-per-file rule they serialise. `db17215d` should land first (it introduces `needsAtlasRebuild` in the entry literal at `createTerminalView`, which this plan's step 3 would also need to set on the re-seat path if the gate says it's required).
- **The layout picker handler (978-987) and `switchToGroup` (3624) are independent call sites** — fixing one does not fix the other. Both must be patched in the same change.

## Dependencies

- `db17215d` — *Seating a Terminal Into an Empty Grid Slot Corrupts the Glyphs in Its Neighbours* (PLAN REVIEWED). The diagnostic gate in step 1 depends on having `db17215d`'s fix available to test against. Its §3 (`needsAtlasRebuild` discrimination) is expected to subsume this plan's step 3.

## Adversarial Synthesis

Key risks: (1) the layout picker `keepLock` branch (987) is a second site with the identical ordering defect — missing it leaves half the corruption live, and the original plan named only `switchToGroup`; (2) the fix must not weaken the structural-delta latch's no-perpetual-repaint invariant — the fix adds a one-shot `batchFitVisiblePanes` at the switch call sites, not an unconditional fit inside `renderPaneGrid`; (3) step 3 (atlas widening) is expected to be a no-op once `db17215d` lands, because `db17215d`'s `onContextLoss` handler already sets `needsAtlasRebuild = true` on the context-loss path — the diagnostic gate confirms this. Mitigations: fix both sites, preserve the latch, run the gate before writing any atlas tuning, and expect the gate to say "already covered."

## Proposed Changes

### `src/webview/terminals.js` — `switchToGroup` (line 3624)

**Context.** `switchToGroup` calls `setLayoutMode(layoutForGroupSwitch(group), { keepLock: true })` then `seatActiveGroupPage()`. The `setLayoutMode` call runs `applyLayoutFloor()` → `batchFitVisiblePanes()` with the OLD assignments. `seatActiveGroupPage` then sets NEW assignments and calls `renderPaneGrid`, which arms `needsRendererResync` for the new seating — but no ladder consumes those flags.

**Logic.** Add `batchFitVisiblePanes()` after `seatActiveGroupPage()` so the flags armed by the post-seat `renderPaneGrid` are consumed within the switch, not stranded for the 5-second fleet poll.

**Implementation.**

```js
setLayoutMode(layoutForGroupSwitch(group), { keepLock: true });
seatActiveGroupPage();
batchFitVisiblePanes();          // <-- ADD: consume the flags armed by seatActiveGroupPage's renderPaneGrid
```

Do NOT do this by making `renderPaneGrid` fit unconditionally — its own comment (5997-6008) explains why that is refused: the 5-second fleet poll would then fire a full repaint of every visible pane forever, which is exactly what the boolean latch exists to prevent.

Do NOT do this by making `seatActiveGroupPage` call `batchFitVisiblePanes()` itself — `applyLayoutFloor`'s floor-change branch (7823-7825) already calls `seatActiveGroupPage()` + `batchFitVisiblePanes()`, so that would double-fit on that path. The generation counter in `startFitLadder` makes it wasteful rather than harmful, but the site-by-site fix is cleaner and does not change `seatActiveGroupPage`'s contract.

**Edge Cases.** If the floor changed inside `setLayoutMode`'s `applyLayoutFloor`, `seatActiveGroupPage` already ran there (7823) and `batchFitVisiblePanes` consumed those flags. The second `seatActiveGroupPage` (from `switchToGroup`) recomputes assignments against the same floored `effectiveLayout` — if the assignments are identical, the structureKey is unchanged and the latch does NOT re-arm, so the extra `batchFitVisiblePanes` is a no-op (every pane's `inspectPaneFit` returns `'ok'`). If the assignments differ, the latch re-arms and the new `batchFitVisiblePanes` consumes them — which is the fix.

### `src/webview/terminals.js` — layout picker `keepLock` branch (line 987)

**Context.** The layout picker change handler calls `setLayoutMode(requested, { keepLock })` then, if `keepLock` is true, `seatActiveGroupPage()`. The comment at line 986 says "Same ordering as switchToGroup: layout first, then seat." Same ordering, same stranded-flag defect. No `batchFitVisiblePanes()` follows.

**Logic.** Add `batchFitVisiblePanes()` after `seatActiveGroupPage()` — the identical fix as `switchToGroup`.

**Implementation.**

```js
setLayoutMode(requested, { keepLock });
if (keepLock) {
    seatActiveGroupPage();
    batchFitVisiblePanes();      // <-- ADD: same fix as switchToGroup
}
```

**Edge Cases.** Same as `switchToGroup`: if the floor changed inside `setLayoutMode`, `seatActiveGroupPage` already ran there and the extra call is a no-op. If the floor did not change, the new call consumes the post-seat flags.

### Step 1 — diagnostic gate (run before writing any repair beyond the ordering fix)

Apply `db17215d`'s fix (or a scratch build of it) and re-test this trigger. Record the answer in this plan before writing any atlas tuning. Three outcomes:
- **Fully covered** — `db17215d`'s §3 (`needsAtlasRebuild` discrimination) + its context-loss ladder handle the atlas-rebuild need on the different-slot-count path, and the ordering fix handles the same-slot-count path. This plan becomes the ordering fix (both sites) plus verification. **This is the expected outcome.**
- **Partially covered** — some atlas staleness remains on the re-seat path even with `db17215d` landed. Proceed to step 3.
- **Independent** — the corruption is not context-budget-related at all. Re-diagnose.

### Step 3 — only if the gate shows atlas staleness that `db17215d` does not cover

> **Superseded:** Pass `rebuildAtlas: true` on the re-seat path specifically — not globally, and not on the visibility-regain path.
> **Reason:** `db17215d`'s §3 already carries the atlas-rebuild distinction on the entry (`entry.needsAtlasRebuild`), set `true` by the `onContextLoss` handler and `swapRenderer`. The structural-delta latch in `renderPaneGrid` correctly does NOT set it (a re-parent has an intact atlas). A different-slot-count switch that triggers context loss sets `needsAtlasRebuild` via the `onContextLoss` handler, not via the latch. So the atlas-rebuild need is already routed through the correct path by `db17215d`.
> **Replaced with:** If the diagnostic gate shows atlas staleness that `db17215d` does not cover, set `entry.needsAtlasRebuild = true` in the structural-delta latch's arming loop (`renderPaneGrid`, 6019-6025) — but ONLY if the gate confirms it. The expected outcome is that this step is not needed. Do NOT pass `rebuildAtlas: true` globally or on the visibility-regain path, whose comment correctly states the atlas is intact there.

### Step 4 — do not add a fifth partial repair

`db17215d` enumerates four existing fixes, each still correct for its own trigger and none covering the next one. If step 1 says the cause is shared, extend the shared fix rather than adding a parallel one here.

### Step 5 — leave the structural-delta latch alone

`structureKey` and `lastGridStructureKey` are correct — the flag is armed. The defect is in when and how it is consumed, not in how it is armed.

## Verification Plan

### Automated Tests

- `node src/test/terminal-pane-fit-verification-contract.test.js` — must stay green. It slices `readRenderedGrid → inspectPaneFit → resyncPaneRenderer → startFitLadder → batchFitVisiblePanes`; the fix adds a call site for `batchFitVisiblePanes` but does not declare any new function inside that span.
- `node src/test/terminal-pane-grid-reconcile-contract.test.js` — regression floor. The fix adds a call at `switchToGroup` (3624) and the layout picker (987), both outside any span this suite slices.
- `node src/test/terminal-renderer-lifecycle-contract.test.js` — must stay green. The ordering fix does not touch `attachRenderer`, `onContextLoss`, or `swapRenderer`. If step 3 is needed and sets `needsAtlasRebuild` in the latch, verify the entry-literal assertion still holds.
- `node --check src/webview/terminals.js` — clean.

### Goal Invariants

- Assert `batchFitVisiblePanes` is called at `src/webview/terminals.js` immediately after the `seatActiveGroupPage()` call inside `switchToGroup` (within 3 lines).
- Assert `batchFitVisiblePanes` is called at `src/webview/terminals.js` immediately after the `seatActiveGroupPage()` call inside the layout picker `keepLock` branch (within 3 lines).
- Assert `renderPaneGrid` does NOT call `batchFitVisiblePanes` or `startFitLadder` directly (the latch invariant — the fix is at the call sites, not inside the render).
- Assert the `structureKey` comparison and `lastGridStructureKey` assignment are unchanged in `renderPaneGrid` (the arming logic is untouched).

### Manual / Instrumented

Intermittent bugs need a repeatable trigger before anything else. Do not accept "I switched a few times and it looked fine."

1. **Build a deterministic reproduction.** Two groups whose membership forces terminals to change slot (member ordering differs, or slot counts differ). Switch back and forth and record the corruption rate over at least 20 switches on the current build. That rate is the baseline every later step is measured against.
2. **Identify which pane corrupts** — the one that moved slots, one that did not, or the newly seated one. This distinguishes Finding 1 from Finding 2 and from `db17215d`'s context budget.
3. **Answer step 1 of the changes**: does `db17215d`'s fix alone drop the corruption rate to zero on this trigger? Record it either way. Expected: yes, via the context-loss path for different-slot-count and the ordering fix for same-slot-count.
4. **Same-slot-count switch** vs **different-slot-count switch**, separately. Only the latter adds and removes pane elements, so only the latter can hit the WebGL context budget. Different rates across the two is strong evidence about the cause.
5. **Both trigger paths.** Test switching via the group tab (`switchToGroup`) AND via the layout picker while a group lock is active (the `keepLock` branch at 987). Both must be corruption-free after the fix. A coder who tests only the group tab leaves the layout-picker site unverified.
6. **Timing.** Instrument when `needsRendererResync` is armed and when it is consumed across a switch. Confirm the post-`seatActiveGroupPage` flags are consumed within the switch (the ladder's double-rAF, ~32 ms), not five seconds later on the fleet poll.
7. **No repaint storm.** With the fix in, sit idle on a 3×3 for two minutes and confirm the 5-second poll is not firing `resyncPaneRenderer` on every visible pane. This is the regression the latch exists to prevent and the most likely way a fix here goes wrong.
8. **Paging within a group** — `activeGroupPage` changes also re-seat via the same function (banner page click at 7808 already calls `batchFitVisiblePanes`; verify that path too, as a regression check that the existing pattern still works).
9. **Peek.** `peekTerminalName` is in `structureKey`; peek and dismiss across a group switch and confirm no corruption and no blank grid. Verify both with a peek active during the switch (dismissPeek runs a ladder pre-switch) and without (the common case).
10. **Team path.** `switchToTeamGroup` → `switchToGroup` → `focusSeatedTerminal`. Verify no corruption after a team-group switch.
11. **The other four triggers still work** — the repairs `db17215d` enumerates must not regress. Re-run its own reproduction (seating into an empty slot) after this change.
12. **Both hosts** — VS Code webview and browser cockpit. WebGL context limits differ between an Electron renderer and a browser tab, so a clean run in one says nothing about the other.

---

## Implementation Summary

Implemented the ordering fix at both call sites named in Finding 1 / Finding 1b: added `batchFitVisiblePanes()` immediately after `seatActiveGroupPage()` in `switchToGroup` (src/webview/terminals.js:3630) and in the layout picker `keepLock` branch (src/webview/terminals.js:990). This consumes the `needsRendererResync` flags armed by `seatActiveGroupPage`'s `renderPaneGrid` within the switch instead of stranding them for the 5 s fleet poll — the root cause of the reported intermittent glyph corruption. The structural-delta latch (`structureKey` / `lastGridStructureKey`) and `renderPaneGrid`'s no-unconditional-fit invariant are untouched; the fix is site-by-site, matching the existing banner-page-click pattern. `node --check` clean. Step 3 (atlas widening) was not applied: `db17215d` is not yet coded (`needsAtlasRebuild` absent from the file), so the diagnostic gate could not be run, and the plan's expected outcome is that `db17215d`'s context-loss path covers the atlas-rebuild need — the consumption site's `{ rebuildAtlas: false }` remains correct for the re-seat path (atlas intact on re-parent).

## Review Findings

Reviewed the committed fix (both one-line additions landed in `99d1337f`): `batchFitVisiblePanes()` after `seatActiveGroupPage()` in `switchToGroup` (src/webview/terminals.js:3630) and in the layout picker `keepLock` branch (src/webview/terminals.js:990) — both are the first executable statement after the seat, the latch arming logic in `renderPaneGrid` is byte-unchanged, and `renderPaneGrid` still starts no ladder of its own. Audited every whole-array `paneAssignments` writer (847, 855, 2207, 2231, 2236, 3551, 3656, 5660) and both `applyLayoutFloor` re-seat branches (7828, 7843): all others already end in a fit, so these two were the only sites with the ordering defect and the fix is complete. One MAJOR finding fixed: the plan's four Goal Invariants were asserted nowhere, so deleting either line would have reverted the bug with every gate green — added three contract tests to the CI-wired `test:contract:terminal-pane-fit` suite and mutation-verified that each of the three regressions (drop either call, or make `renderPaneGrid` fit unconditionally) turns it red. Files changed: `src/test/terminal-pane-fit-verification-contract.test.js` (+3 tests) and this plan file; `node --check src/webview/terminals.js` clean, the three plan-named suites green and all three confirmed invoked by `.github/workflows/integration-tests.yml` (lines 903, 911, 864). **The verdict on the core mechanism is provisional**: the plan's Manual/Instrumented items 1–12 (the 20-switch corruption-rate baseline, same- vs different-slot-count split, the two-minute no-repaint-storm idle, and the VS Code-webview-vs-browser-cockpit split) require a live host and were not executed here — the contract suites pin that the call sites exist, which is not evidence that the glyph corruption is gone.

## Deferred Findings

- NIT — `src/webview/terminals.js:3630`: the switch now runs two `batchFitVisiblePanes()` passes in one synchronous tick, because `setLayoutMode` (5470) ends in `applyLayoutFloor()` which itself ends in a fit (7845/7850). `fitLadderGen` supersedes the first, so it costs two inert rAF callbacks per seated pane per switch. Plan-sanctioned in *Side Effects*; not changed.
- NIT — `src/webview/terminals.js:990`: both one-line fixes were committed inside `99d1337f feat(prompt-rail): fix three agent-prompt-rail contract defects`, an unrelated commit. Traceability only; not correctable without history rewriting.
- NIT — step 1 diagnostic gate not run: `needsAtlasRebuild` is absent from `src/webview/terminals.js`, so `db17215d` is not yet coded and the gate had nothing to test against. Step 3 correctly not applied and the consumption site's `{ rebuildAtlas: false }` (src/webview/terminals.js:8087) is untouched. Re-run the gate when `db17215d` lands.
- NIT — pre-existing red gates, unrelated to this change and outside its scope: `test:contract:panel-scrollbars`, `test:contract:terminal-focus-affordance` (`entry.inputQueue` assertion, src/test/terminal-focus-affordance-contract.test.js:111), `test:contract:shell-terminal-strip`, `test:contract:shell-modal-panel`, `test:contract:terminal-operations-no-periodic-reopen`. `99d1337f` touches none of the files they assert on.
