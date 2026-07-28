---
description: "PROMOTE TO FEATURE renders, enables, opens a modal and accepts a name in the browser cockpit — then does nothing, because feature management is unwired in the standalone host. No capability flag covers it: transport.js's applyCapabilityGating hides a fixed list of terminal-bound controls and #btn-feature-action is not among them. Add a featureManagement capability DERIVED from whether the LocalApiServer hooks are actually supplied, and disable the controls when false. Restores PRD contract #6 immediately, before the wiring lands."
---

# Capability-Gate Feature Management in the Browser

## Goal

**Definition of done: no feature-management control in the browser cockpit is enabled unless the host it is talking to has actually wired feature management — and when it is disabled, the user is told why.**

### Core problem (root-cause analysis)

PRD contract #6 (*capability-gating honesty*) is explicit: *"A panel or verb with no headless route/wiring is **absent or disabled**, never a control that dead-clicks and never a stub that fakes success. The `/panels` manifest reflects what each host has actually wired."*

Feature management violates this today.

`src/webview/kanban.html:2751` defines the control:

```html
<button class="strip-btn is-teal" id="btn-feature-action"
        data-tooltip="Convert selected plans to feature or manage existing feature"
        disabled>PROMOTE TO FEATURE</button>
```

`updateFeatureActionButton()` (`:8173-8202`) enables it purely on selection shape, relabelling it *PROMOTE TO FEATURE* / *ADD n TO FEATURE* / *GROUP INTO FEATURE*. The click handler (`:11952-11981`) posts `addSubtaskToFeature` per subtask, or opens the feature-create modal whose submit (`:12002-12005`) posts `promoteToFeature` or `createFeature`.

**None of that is host-aware.** `transport.js`'s `applyCapabilityGating` (`:225-335`) hides controls by a hardcoded selector list keyed on `caps.terminalDispatch === false` — `#btn-autoban`, `#btn-manager-pass`, `#btn-cli-triggers`, `#btn-remote-control`, `#btn-build-via-planner`, `button[data-action="moveSelected"]`, and so on. `#btn-feature-action` is not in that list, and **no capability flag covers feature management at all.**

In the standalone host none of the three verbs is implemented (`bootstrap.ts`'s `kanbanVerb` switch handles twenty verbs and none of them are these), so the user selects cards, the button enables, a modal opens, they type a name, they submit — and the action is inert.

**Why this is worth its own plan rather than waiting for the wiring.** The wiring (tracked separately) is a large extraction with real risk to ~4,000 shipped installs. Contract-#6 compliance does not have to wait for it: disabling a control that cannot work is correct *today*, ships in isolation, and is the honest state of the product until the wiring lands. When the wiring does land, the flag flips to `true` and the control enables — with no further UI change.

**The flag must be derived, not declared.** Hardcoding `featureManagement: true` per host would convert a dead button into a *lying* button the moment any single hook is missing — strictly worse than the current state. The value must come from whether the `LocalApiServer` feature hooks are actually supplied.

## Metadata
- **Tags:** bugfix, ui, ux, reliability
- **Complexity:** 4
- **Project:** browser-switchboard

## User Review Required

- **None.** Disable-with-tooltip is chosen over hide, per contract #6's own wording and because a control the user knows exists reading as "missing" is itself a bug report.

## Scope

### ✅ IN SCOPE
1. A `featureManagement` boolean on the host-capabilities payload, **derived** from whether `LocalApiServer` received the feature-management option hooks (`createFeature`, `assignToFeature`, `removeSubtaskFromFeature`, `deleteFeature`, `splitFeature`, `reconcileFeatures`).
2. Gating in `transport.js`'s `applyCapabilityGating`: when `featureManagement === false`, **disable** `#btn-feature-action` and the Features-tab feature-mutation controls, with an explanatory tooltip.
3. A guard in `updateFeatureActionButton()` so the per-selection enable logic cannot re-enable a capability-disabled control.
4. Tests that force the flag both ways.

### ⚙️ OUT OF SCOPE
- Wiring any feature-management operation into the standalone host. This plan makes the product honest about the gap; the companion plans close it.
- Read-only feature surfaces. Viewing features, the Features tab's list, and `GET /kanban/features` are unaffected — only mutation controls gate.
- Feature **worktree** controls (`Create Feature Worktree`, `kanban.html:11751`). Different subsystem, already gated by git/terminal capability.
- Extending the capability model to other unwired verbs. Worth doing later; out of scope here to keep the change small and reviewable.

## Implementation Steps

1. **Derive the flag.** Where the host-capabilities payload is assembled, compute `featureManagement` from the presence of the six `LocalApiServerOptions` hooks rather than a literal. A single `hasFeatureManagement()` helper on `LocalApiServer` (returning whether all six are supplied) keeps the derivation in one place and makes a partially-wired host report `false`.
2. **Thread it into the payload** that reaches `document.body.dataset.hostCapabilities`, which `applyCapabilityGating` already parses (`:227-229`).
3. **Gate in `transport.js`.** Add a `caps.featureManagement === false` branch that disables the controls and sets a tooltip. Disable via a `disabled` attribute plus a body class so the state is inspectable and testable.
4. **Guard the re-enable path.** `updateFeatureActionButton()` sets `btn.disabled = false` on selection; it must early-return when the capability class is present, or the next selection change silently re-enables the control.
5. Add the tests below.

## Proposed Changes

### `src/services/LocalApiServer.ts` — capability derivation

- **Context.** The six hooks are optional members of `LocalApiServerOptions` (`:43-118`), each documented *"Optional — absent in headless/test harnesses"*.
- **Logic.** Expose whether they are all present so the capability payload can be honest without duplicating the list.
- **Implementation.**
  ```ts
  /** True only when every feature-management hook is supplied. A partially
   *  wired host reports false — a capability flag that overstates what is
   *  wired turns a dead control into one that claims support. */
  public hasFeatureManagement(): boolean {
      const o = this._options;
      return !!(o.createFeature && o.assignToFeature && o.removeSubtaskFromFeature
          && o.deleteFeature && o.splitFeature && o.reconcileFeatures);
  }
  ```
- **Edge cases.** All-six, not any-of — a host with `createFeature` but no `deleteFeature` must not advertise feature management.

### `src/webview/transport.js` — `applyCapabilityGating` (`:225-335`)

- **Context.** Parses `document.body.dataset.hostCapabilities` and applies per-capability CSS/attribute changes.
- **Logic.** Disable rather than hide, with a tooltip stating the reason.
- **Implementation.**
  ```js
  if (caps.featureManagement === false) {
      document.body.classList.add('host-feature-management-false');
      const disableFeatureControls = () => {
          const btn = document.getElementById('btn-feature-action');
          if (btn) {
              btn.disabled = true;
              btn.setAttribute('data-tooltip',
                  'Feature management is not available in this host — open this workspace in VS Code.');
          }
      };
      if (document.readyState === 'loading') {
          document.addEventListener('DOMContentLoaded', disableFeatureControls);
      } else {
          disableFeatureControls();
      }
      setTimeout(disableFeatureControls, 500);
  }
  ```
  Mirror the existing `secretsEntry` block's shape (`:258-308`), including its `DOMContentLoaded` + delayed re-apply, which exists because panels populate controls asynchronously.
- **Edge cases.** The delayed re-apply matters here for the same reason it does for secrets: the Features tab builds its controls after first paint.

### `src/webview/kanban.html` — `updateFeatureActionButton()` (`:8173-8202`)

- **Context.** Recomputes `btn.disabled` from selection shape on every selection change and every board refresh (called from eight sites).
- **Logic.** A capability-disabled control must stay disabled regardless of selection.
- **Implementation.** Early-return after the `if (!btn) return;` guard:
  ```js
  if (document.body.classList.contains('host-feature-management-false')) {
      btn.disabled = true;
      btn.textContent = 'PROMOTE TO FEATURE';
      return;
  }
  ```
- **Edge cases.** This is the load-bearing half of the fix. Without it, gating "works" until the user clicks a card, at which point the button re-enables and dead-clicks again — a fix that appears to hold in a static screenshot and fails in use.

## Complexity Audit

### Routine
- One derived boolean, one gating block mirroring an existing one, one early-return.

### Complex / Risky
- **The re-enable race is the trap.** Eight call sites drive `updateFeatureActionButton()`; gating only in `transport.js` leaves all eight able to undo it. Test 3 exists specifically for this.
- **An overstated flag is worse than no flag.** Deriving from all six hooks — not from a per-host literal, not from any-of — is what keeps this honest as the wiring lands incrementally.
- **Timing.** Capability gating runs on `DOMContentLoaded`; the Features tab builds controls later. The existing `setTimeout(…, 500)` pattern is a known workaround in this file and should be reused rather than reinvented.

## Edge-Case & Dependency Audit

- **Race conditions:** the gating pass and the async panel build race; mitigated by reusing the existing DOMContentLoaded + delayed re-apply pattern, and structurally by the `updateFeatureActionButton()` guard, which re-asserts the state on every recompute.
- **Security:** none — no new input, no new endpoint.
- **Side effects:** the control becomes non-interactive in hosts without the wiring. That is the intent, and it is a visible behaviour change for standalone users who previously saw an enabled (but inert) button.
- **Migration / shipped state:** the extension supplies all six hooks, so `featureManagement` is `true` there and the extension's behaviour is unchanged. `transport.js` is browser-only and never loaded in the VS Code webview. No migration.
- **Dependencies & conflicts:** touches `kanban.html`, which other plans in this set also touch — serialise file access. No logical dependency in either direction.
- **No confirmation dialogs** are added.

## Dependencies

- None hard. Best sequenced after *Surface Verb Failures in the Browser Transport* so that any control which slips through the gate reports its failure rather than dead-clicking — the two together make the gap fully diagnosable.

## Verification Plan

### Automated Tests
1. `hasFeatureManagement()` returns `true` when all six hooks are supplied, and `false` when any single one is missing.
2. With `featureManagement: false` in the capabilities payload, `#btn-feature-action` is `disabled` after gating and carries the explanatory tooltip.
3. **Re-enable guard.** With `featureManagement: false`, invoking `updateFeatureActionButton()` with a two-plan selection leaves the button disabled. This is the regression guard for the eight recompute call sites.
4. With `featureManagement: true`, selection-based enable/relabel behaves exactly as today (*PROMOTE TO FEATURE* / *ADD n TO FEATURE* / *GROUP INTO FEATURE*).
5. Read-only feature surfaces are unaffected when the flag is `false`.

### Manual
- Run `npx switchboard`, select two plans, and confirm the button is disabled with the tooltip rather than opening an inert modal.
- In VS Code, confirm the button behaves exactly as it does today.

---

**Recommendation:** Complexity 4 → **Send to Coder.**

**Stage Complete:** CREATED
