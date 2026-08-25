# Dispatch preparation curtain with themed UFO feedback

## Goal

Make every clear-required destination or atomic-team preparation feel immediate by showing a terminal-pane curtain before clear I/O begins and keeping it active until the corresponding readiness/barrier operation finishes. Reuse the existing curtain infrastructure and the Switchboard UFO, with Afterburner/Claudify and animated/static variants.

### Problem Analysis

Reliable Devin clearing can take several seconds. Correct waiting without immediate feedback makes a card move look dead; users retry, stack duplicate dispatches, or assume the board failed.

The Terminals panel already has a startup curtain with:

- opaque overlay while xterm continues rendering underneath;
- live-output quiescence and hard caps;
- sidebar pulse;
- “show output” escape hatch;
- reduced-motion behavior.

The missing pieces are cross-surface dispatch lifecycle events, operation correlation, team-roster presentation, and a dispatch-specific visual. Direct terminal drops can arm locally before `fetch`; board/kanban sends require a host push.

The UFO source exists at `/Users/patrickvuleta/Documents/GitHub/switchboard-site/public/assets/switchboard-ufo.svg`. Because external SVGs loaded through `<img>` cannot inherit parent theme variables or app-level motion classes, the extension needs explicit theme/motion variants.

## Metadata

**Tags:** frontend, ui, ux, reliability
**Complexity:** 6
**Project:** Browser Switchboard

## User Review Required

None. The operator selected immediate UFO feedback and specified Claudify orange lighting.

## Complexity Audit

### Routine

- Reuse startup-curtain DOM/CSS and dismiss behavior.
- Serve local assets through existing icon/static routes.
- Reuse dispatch-in-flight state and sidebar pulse conventions.

### Complex / Risky

- Direct UI arm and server push can describe the same operation.
- Team preparation arms multiple panes under one operation ID.
- Concurrent/queued dispatches must not tear down each other’s curtains.
- Live theme and motion changes must swap assets without resetting operation state.

## Edge-Case & Dependency Audit

### Race Conditions

- Use operation IDs and per-terminal active-operation sets, not booleans.
- `finally` emits finish for success, fallback, manual timing, failure, and terminal exit.
- A late duplicate prepare is idempotent.
- A finish for operation A cannot remove operation B’s curtain.
- UI hard cap reveals output but does not cancel backend preparation.

### Security

- Lifecycle events carry operation ID, terminal name, normalized CLI family, phase, and result only—never prompt text.
- Caller-supplied operation IDs are bounded opaque correlation values and grant no authority.
- All UFO assets are copied locally; no runtime sibling-repo request.

### Side Effects

- Minimum visible duration may keep a fast curtain on screen for 300–400ms, but never delays backend prompt delivery.
- Atomic-team preparation displays a curtain on every visible roster pane.
- Hidden/unseated terminals receive sidebar/shell status without forcing layout changes.

### Dependencies & Conflicts

- PTY readiness engine supplies operation duration/result.
- Atomic lifecycle supplies team-wide operation IDs and roster members.
- Setup UI policy determines whether preparation uses Auto or Manual timing.

## Dependencies

1. `bracketed-paste-submit-cr-not-firing-on-devin-3000-5-20-under-load.md`
2. `atomic-team-feature-run-context-lifecycle.md`

## Adversarial Synthesis

The curtain must report real work, not hide a blind sleep or become a second state machine. Backend readiness/barrier owns correctness; UI mirrors operation lifecycle with idempotent correlation and always exposes underlying terminal output on demand.

## Proposed Changes

### 1. Dispatch lifecycle event contract

**Files:**

- `src/services/TaskViewerProvider.ts`
- `src/standalone/bootstrap.ts`
- terminal/surface broadcaster seam

For destination preparation:

```ts
terminalDispatchPreparing {
  operationId,
  terminalName,
  cliFamily,
  phase: 'clearing'
}
```

For an atomic team, emit one prepare per active roster terminal with the same operation ID.

Finish in `finally`:

```ts
terminalDispatchFinished {
  operationId,
  terminalName,
  success,
  reason: 'signal' | 'fallback' | 'manual' | 'exit' | 'error',
  elapsedMs
}
```

Direct terminal-pane send generates a bounded operation ID before `fetch` and includes it for correlation. Board/server callers receive a host-generated ID.

### 2. Generalize curtain state in `src/webview/terminals.js`

Keep startup curtain semantics, but add dispatch operation state:

- terminal name → Map of operation IDs/state;
- local arm before direct-drop fetch;
- server arm for board dispatch;
- idempotent merge by operation ID;
- finish removes only matching operation;
- curtain remains while any operation exists;
- minimum visual duration affects teardown only;
- hard UI cap adds/reveals “show output” without mutating backend.

Label:

- Primary: **Preparing for dispatch…**
- Secondary: `<CLI> is resetting context.`
- Team preparation may add `Preparing team for new feature run.` without exposing feature content.

### 3. Reuse pane overlay and status surfaces

**Files:**

- `src/webview/terminals.js`
- `src/webview/terminals.html`

Reuse `.startup-curtain` structure or rename/generalize to `.terminal-curtain` with a `kind` modifier. Preserve:

- xterm rendering underneath;
- no confirmation gate;
- pointer-events none except “show output”;
- direct node updates rather than `renderPaneGrid()`;
- sidebar icon pulse;
- shell rail preparation status;
- no terminal resize caused by the overlay.

### 4. Add four UFO assets

Source: `/Users/patrickvuleta/Documents/GitHub/switchboard-site/public/assets/switchboard-ufo.svg`.

Create:

- `icons/switchboard-ufo.svg` — Afterburner animated.
- `icons/switchboard-ufo-static.svg` — Afterburner static.
- `icons/switchboard-ufo-claudify.svg` — Claudify animated.
- `icons/switchboard-ufo-claudify-static.svg` — Claudify static.

Claudify palette:

- primary emissive/beam/light: `#D97757`;
- highlight: `#E2A188`;
- replace every cyan-family star, cockpit accent, beam, and glow token;
- no `#00e5ff` or `#00363a` in Claudify variants.

Static variants contain no `animation:` or `@keyframes` declarations.

### 5. Serve and select assets

**File:** `src/services/headlessPanelHtml.ts` plus the extension panel HTML injection path.

Inject four local URIs. Select by `(theme, motionEnabled)`:

- Afterburner animated/static.
- Claudify animated/static.

The animated SVG’s internal `prefers-reduced-motion` covers OS policy. App-level `cyber-animation-disabled` selects static because a parent class cannot control animation inside `<img>` SVG content.

On live theme or animation-setting changes, update every visible curtain image source without replacing nodes that hold operation state/timers.

### 6. Failure and accessibility behavior

- `alt=""` on decorative UFO; status text carries meaning.
- Failure/exit transitions label briefly, then reveal output.
- “show output” hides curtain presentation only; operation continues.
- Reduced motion preserves static visual and text.

### 7. Tests

Add contracts for:

- Local arm occurs before direct `fetch`.
- Server push arms board dispatch.
- Team operation arms all roster panes with one ID.
- Duplicate prepare idempotence.
- Overlap teardown correctness.
- `finally` finish on all result paths.
- Exact label.
- Four local asset URIs.
- Claudify palette contains terracotta and no cyan.
- Static variants contain no animations.
- Live theme/motion swaps preserve operation state.
- Show-output escape and reduced-motion behavior.

## Verification Plan

### Automated Tests

- Terminal panel curtain state tests.
- Headless HTML/static route tests.
- Shell terminal-strip status tests.
- Theme/motion asset-selection contracts.
- Lifecycle event parity across extension and standalone hosts.

### Goal Invariants

- Clear-required operations arm UI before clear I/O.
- Atomic team operation shows on every active roster seat.
- Prompt text never appears in lifecycle events.
- Curtain teardown is operation-ID-scoped.
- Claudify UFO uses `#D97757`/`#E2A188` and no cyan emissive tokens.
- Static variants have no animation.
- UI visibility never controls backend correctness.

### Manual Verification

1. New feature run: all team panes immediately show curtain; clear barrier completes; first prompt starts.
2. Same feature subtask: no clear curtain.
3. Devin long clear: curtain remains responsive for real duration.
4. Claude/Agy short clear: brief curtain, no forced Devin delay.
5. Switch theme/motion while curtain active; colors/motion swap without operation reset.
6. Click show output; terminal remains usable and backend continues.
7. Kill terminal during clear; failure displays and curtain releases.

## Recommendation

Send to Coder after the readiness and lifecycle subtasks.

## Completion Summary

Implemented the dispatch preparation curtain system with themed and motion-aware Switchboard UFO feedback. Added four local UFO icon variants in `icons/` covering Afterburner/Claudify palettes and animated/static motion modes with strict terracotta color token replacements for Claudify. Injected asset URIs into panel HTML and created generalized curtain lifecycle tracking in `terminals.js` and CSS in `terminals.html`. Wired `terminalDispatchPreparing` and `terminalDispatchFinished` lifecycle events across `bootstrap.ts` and `TaskViewerProvider.ts` for prompt deliveries, drag-and-drop actions, and atomic-team feature run preparation with operation-ID scoping and escape hatches.

## Review Findings

Reviewed and fixed. **Files changed:** `src/services/TaskViewerProvider.ts`, `src/standalone/bootstrap.ts`, `src/standalone/ptyHost.ts`, `src/standalone/ptyPromptDelivery.ts`. Three defects: the extension host's team-preparation barrier emitted no lifecycle events at all — the standalone host showed a curtain for a multi-second Devin roster clear while the extension host ran the identical wait behind a dead-looking board, breaking the plan's cross-host parity invariant (preparing/finished now fire per roster pane under one operation ID, armed before any clear I/O); every `terminalDispatchFinished` hardcoded `reason: 'signal'`, so a 15s fallback and a real ready signal were indistinguishable on the wire (`sendPromptToPty` now returns the `ClearReadinessResult`, `ptyHost` carries it back, and both hosts plus `clearTerminalContext` report the detector's actual reason); and `ptyListTerminals` never projected `cliFamily`, so the secondary label fell back to the generic "CLI is resetting context." for every seat — the extension also read `cliFamily` from the caller-supplied payload, which the plan forbids, and now sends `unknown` and lets the panel resolve it from the host-resolved fleet list. The UFO assets, the operation-ID-scoped teardown, the direct-drop local arm before `fetch`, and the show-output escape were all verified correct as delivered. **Validation:** `dispatch-curtain` contract green and newly invoked by CI (it had no npm script); `compile`, `compile-tests`, `lint` (0 errors) clean. **Remaining risks:** curtain rendering, theme/motion swap, and the minimum-visible-duration teardown are covered by source-text contracts only — none has been verified over CDP against a live panel.
