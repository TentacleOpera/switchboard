---
description: "PROMOTE TO FEATURE renders, enables, opens a modal and accepts a name in the browser cockpit — then does nothing, because feature management is unwired in the standalone host. No capability flag covers it: transport.js's applyCapabilityGating hides a fixed list of terminal-bound controls and #btn-feature-action is not among them. Add a featureManagement capability DERIVED (late-bound) from whether the six LocalApiServer hooks are actually supplied, thread it through HostCapabilities and both host assembly sites, and disable the controls when false. Restores PRD contract #6 immediately, before the wiring lands."
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

`updateFeatureActionButton()` (`:8173-8202`) enables it purely on selection shape, relabelling it *PROMOTE TO FEATURE* / *ADD n TO FEATURE* / *GROUP INTO FEATURE*. The click handler (`:11952-11982`) posts `addSubtaskToFeature` once per selected subtask, or opens the feature-create modal whose submit (`:12000-12005`) posts `promoteToFeature` (single selection) or `createFeature` (multi).

**None of that is host-aware.** `transport.js`'s `applyCapabilityGating` (`:225-335`) hides controls by a hardcoded selector list keyed on `caps.terminalDispatch === false` — `#btn-autoban`, `#btn-manager-pass`, `#btn-cli-triggers`, `#btn-remote-control`, `#btn-build-via-planner`, `button[data-action="moveSelected"]`, and so on. `#btn-feature-action` is not in that list, and **no capability flag covers feature management at all.**

In the standalone host none of the three verbs is implemented (`bootstrap.ts`'s `kanbanVerb` switch at `:578-838` handles exactly twenty verbs and none of them are these), so the user selects cards, the button enables, a modal opens, they type a name, they submit — and the action is inert.

**Why this is worth its own plan rather than waiting for the wiring.** Contract-#6 compliance does not have to wait: disabling a control that cannot work is correct *today*, ships in isolation, and is the honest state of the product until the wiring lands. When the wiring does land, the flag flips to `true` and the control enables — with no further UI change.

**The flag must be derived, not declared.** Hardcoding `featureManagement: true` per host would convert a dead button into a *lying* button the moment any single hook is missing — strictly worse than the current state. The value must come from whether the `LocalApiServer` feature hooks are actually supplied.

**The flag must also be late-bound.** In both hosts the capabilities payload is assembled *inside* the options object that is itself passed to `new LocalApiServer(...)`:

- Extension: `TaskViewerProvider.ts:1599` constructs the server; the capabilities live in the `serveStatic` option's IIFE at `:1809-1852`, whose `getBoardHtml` / `getProjectHtml` / `getPanelHtml` getters are **async and invoked per request**.
- Standalone: `bootstrap.ts:388-409` builds `baseStandaloneCapabilities` + `getStandaloneCaps()`, both defined *before* `server` exists (the options object is assembled around `:980`).

So the derivation must be read at **request time** through the host's server handle (`this._localApiServer` at `TaskViewerProvider.ts:526`; a `let server` binding in bootstrap), never captured at options-construction time — a captured read is `undefined`/null and silently gates the control off in the extension too.

## Metadata
- **Tags:** bugfix, ui, ux, reliability
- **Complexity:** 4
- **Project:** browser-switchboard

## User Review Required

- **None.** Disable-with-tooltip is chosen over hide, per contract #6's own wording and because a control the user knows exists reading as "missing" is itself a bug report.

## Scope

### ✅ IN SCOPE
1. A `featureManagement` boolean on the `HostCapabilities` interface and on `DEFAULT_HOST_CAPABILITIES`, defaulting to `false` (fail-closed).
2. A `hasFeatureManagement()` helper on `LocalApiServer` returning whether **all six** feature-management option hooks (`createFeature`, `assignToFeature`, `removeSubtaskFromFeature`, `deleteFeature`, `splitFeature`, `reconcileFeatures`) are supplied.
3. Late-bound wiring of that helper into **both** capability assembly sites — `TaskViewerProvider.ts` and `bootstrap.ts`.
4. Gating in `transport.js`'s `applyCapabilityGating`: when `featureManagement === false`, **disable** `#btn-feature-action` with an explanatory tooltip.
5. A guard in `updateFeatureActionButton()` so the per-selection enable logic cannot re-enable a capability-disabled control.
6. Tests that force the flag both ways.

### ⚙️ OUT OF SCOPE
- Wiring any feature-management operation into the standalone host. This plan makes the product honest about the gap; the companion plan closes it.
- Read-only feature surfaces. Viewing features, the Features tab's list, and `GET /kanban/features` are unaffected — only mutation controls gate.
- Feature **worktree** controls (`Create Feature Worktree`, `kanban.html:11751`). Different subsystem, already gated by git/terminal capability.
- Extending the capability model to other unwired verbs. Worth doing later; out of scope here to keep the change small and reviewable.

## Implementation Steps

1. **Extend the capability type.** Add `featureManagement?: boolean` to `HostCapabilities` and `featureManagement: false` to `DEFAULT_HOST_CAPABILITIES` in `headlessPanelHtml.ts`.
2. **Add the derivation** as `hasFeatureManagement()` on `LocalApiServer`.
3. **Thread it into both assembly sites**, read late (per request), never captured.
4. **Gate in `transport.js`.** Add a `caps.featureManagement === false` branch that disables the control and sets a tooltip, mirroring the existing `secretsEntry` block's DOMContentLoaded + delayed re-apply shape.
5. **Guard the re-enable path** in `updateFeatureActionButton()`.
6. Add the tests below.

## Proposed Changes

### `src/services/headlessPanelHtml.ts` — capability type and default (`:16-32`)

- **Context.** `HostCapabilities` (`:16-24`) declares the flags; `DEFAULT_HOST_CAPABILITIES` (`:26-32`) is spread under every caller's object at five sites (`:116`, `:187`, `:225`, `:263`, `:287`) via `{ ...DEFAULT_HOST_CAPABILITIES, ...capabilities }`, then serialised into `data-host-capabilities`.
- **Logic.** Add the field and default it to `false`.
- **Implementation.**
  ```ts
  export interface HostCapabilities {
      // …existing fields…
      /** True only when the serving host supplied every feature-management hook. */
      featureManagement?: boolean;
  }

  const DEFAULT_HOST_CAPABILITIES: HostCapabilities = {
      // …existing fields…
      featureManagement: false,
  };
  ```
- **Edge cases.** The default is **`false` on purpose (fail-closed)**. Because gating keys on `=== false`, omitting the field entirely would leave the control enabled; defaulting to `false` means a host that forgets to set it gates honestly rather than dead-clicking. This file was missing from the original plan's change list and is the load-bearing piece that makes the flag reach the DOM at all.

### `src/services/LocalApiServer.ts` — capability derivation

- **Context.** The six hooks are optional members of `LocalApiServerOptions` (`:43-118`), each documented *"Optional — absent in headless/test harnesses"*, and stored as `private _options: LocalApiServerOptions` (`:342`, assigned `:355`). Seven POST routes read them and 503 when absent (`:1267`, `:1313`, `:1359`, `:1408`, `:1446`, `:1485`, `:1539`).
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
- **Edge cases.** All-six, not any-of — a host with `createFeature` but no `deleteFeature` must not advertise feature management. Note this deliberately tracks the *six option hooks* (the script/API rail), not the three UI verbs; the companion wiring plan lands both together, so a state where the hooks exist but the verbs do not is transient and only under-reports.

### `src/services/TaskViewerProvider.ts` — extension capability assembly (`:1809-1852`)

- **Context.** `baseHostCapabilities` is a literal inside the `serveStatic` IIFE; `integrationsConfigured` is already computed per request inside each async getter precisely because it cannot be resolved synchronously at IIFE time.
- **Logic.** Compute `featureManagement` the same way — per request, from the live server handle.
- **Implementation.** Add alongside the existing per-request computation:
  ```ts
  const caps = {
      ...baseHostCapabilities,
      featureManagement: this._localApiServer?.hasFeatureManagement() ?? false,
      integrationsConfigured: await computeIntegrationsConfigured(),
  };
  ```
  applied in all three getters (`getBoardHtml`, `getProjectHtml`, `getPanelHtml`).
- **Edge cases.** Do **not** put `featureManagement` in `baseHostCapabilities` — that literal is evaluated while the options object for `new LocalApiServer(...)` (`:1599`) is still being built, so `this._localApiServer` is null and the extension would gate its own working button off.

### `src/standalone/bootstrap.ts` — standalone capability assembly (`:388-409`)

- **Context.** `getStandaloneCaps()` spreads `baseStandaloneCapabilities` and awaits `computeIntegrationsConfigured()`; it is defined well before the server.
- **Logic.** Same late-bound read via the server binding.
- **Implementation.**
  ```ts
  const getStandaloneCaps = async (): Promise<HostCapabilities> => ({
      ...baseStandaloneCapabilities,
      featureManagement: server?.hasFeatureManagement() ?? false,
      integrationsConfigured: await computeIntegrationsConfigured(),
  });
  ```
- **Edge cases.** `server` must be declared (e.g. `let server: LocalApiServer | undefined`) before `getStandaloneCaps` closes over it; the getters only run once a browser requests a page, by which point it is assigned. If the existing binding is a `const` declared at the construction site, hoist the declaration rather than capturing a value.

### `src/webview/transport.js` — `applyCapabilityGating` (`:225-335`)

- **Context.** Parses `document.body.dataset.hostCapabilities` (`:227-229`) and applies per-capability CSS/attribute changes.
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
- **Edge cases.** The companion *Surface Verb Failures* plan edits a different function in this same file — **serialise the two edits**.

### `src/webview/kanban.html` — `updateFeatureActionButton()` (`:8173-8202`)

- **Context.** Recomputes `btn.disabled` from selection shape on every selection change and every board refresh. It is called from **ten** sites: `:5586`, `:6236`, `:6372`, `:6790`, `:7065`, `:8239`, `:8296`, `:8754`, `:11976`, `:12010`.
- **Logic.** A capability-disabled control must stay disabled regardless of selection.
- **Implementation.** Early-return after the `if (!btn) return;` guard:
  ```js
  if (document.body.classList.contains('host-feature-management-false')) {
      btn.disabled = true;
      btn.textContent = 'PROMOTE TO FEATURE';
      return;
  }
  ```
- **Edge cases.**
  - This is the load-bearing half of the fix. Without it, gating "works" until the user clicks a card, at which point the button re-enables and dead-clicks again — a fix that appears to hold in a static screenshot and fails in use.
  - Place the early-return **after** the `if (!btn) return;` line, which itself sits after the function's three unrelated leading calls (`recomputeWorktreeIndicator()`, `updateCreateWorktreeButton()`, `updateManagerPassButton()`). Those must still run on every invocation — returning before them would break the worktree indicator and the manager-pass button.

## Complexity Audit

### Routine
- One derived boolean, one interface field, one gating block mirroring an existing one, one early-return.

### Complex / Risky
- **Late binding is the trap that breaks the extension.** Both capability literals are evaluated before their `LocalApiServer` exists. A naive `featureManagement: apiServer.hasFeatureManagement()` in the base literal throws or yields `false`, disabling the button in VS Code — a visible regression on ~4,000 installs' browser view.
- **The re-enable race is the trap that breaks the fix.** Ten call sites drive `updateFeatureActionButton()`; gating only in `transport.js` leaves all ten able to undo it. Test 3 exists specifically for this.
- **An overstated flag is worse than no flag.** Deriving from all six hooks — not from a per-host literal, not from any-of — is what keeps this honest as the wiring lands.
- **Timing.** Capability gating runs on `DOMContentLoaded`; the Features tab builds controls later. The existing `setTimeout(…, 500)` pattern is a known workaround in this file and should be reused rather than reinvented.

## Edge-Case & Dependency Audit

- **Race conditions:** the gating pass and the async panel build race; mitigated by reusing the existing DOMContentLoaded + delayed re-apply pattern, and structurally by the `updateFeatureActionButton()` guard, which re-asserts the state on every recompute.
- **Security:** none — no new input, no new endpoint.
- **Side effects:** the control becomes non-interactive in hosts without the wiring. That is the intent, and it is a visible behaviour change for standalone users who previously saw an enabled (but inert) button.
- **Migration / shipped state:** the extension supplies all six hooks, so `featureManagement` is `true` there and the extension's behaviour is unchanged — *provided the late-binding requirement above is honoured*. `transport.js` is browser-only and never loaded in the VS Code webview. No persisted state, no migration.
- **Dependencies & conflicts:** touches `transport.js` (also edited by *Surface Verb Failures*) and `bootstrap.ts` (also edited by the wiring plan) — serialise file access in both cases. No logical dependency in either direction.
- **No confirmation dialogs** are added.

## Dependencies

- None hard. Best sequenced after *Surface Verb Failures in the Browser Transport* so that any control which slips through the gate reports its failure rather than dead-clicking — the two together make the gap fully diagnosable.

## Verification Plan

### Automated Tests
1. `hasFeatureManagement()` returns `true` when all six hooks are supplied, and `false` when any single one is missing (six cases).
2. A `HostCapabilities` object with no `featureManagement` field serialises into `data-host-capabilities` as `featureManagement:false` — the fail-closed default.
3. With `featureManagement: false` in the capabilities payload, `#btn-feature-action` is `disabled` after gating and carries the explanatory tooltip.
4. **Re-enable guard.** With `featureManagement: false`, invoking `updateFeatureActionButton()` with a two-plan selection leaves the button disabled. This is the regression guard for the ten recompute call sites.
5. With `featureManagement: true`, selection-based enable/relabel behaves exactly as today (*PROMOTE TO FEATURE* / *ADD n TO FEATURE* / *GROUP INTO FEATURE*).
6. **Late binding.** A capability getter invoked after server construction reports `true` for a fully-hooked server; the base capability literal itself contains no `featureManagement` key.
7. Read-only feature surfaces are unaffected when the flag is `false`.

### Manual
- Run `npx switchboard`, select two plans, and confirm the button is disabled with the tooltip rather than opening an inert modal.
- In VS Code, open the browser view and confirm the button behaves exactly as it does today (enabled, relabelling on selection).

---

**Recommendation:** Complexity 4 → **Send to Coder.**

**Stage Complete:** CREATED

## Completion Summary
Added derived late-bound `featureManagement` capability flag to `HostCapabilities`, `LocalApiServer.hasFeatureManagement()`, `TaskViewerProvider`, and `bootstrap.ts`. Disabled `#btn-feature-action` with explanatory tooltip in `transport.js` when `featureManagement` is false, and guarded `updateFeatureActionButton()` in `kanban.html`. Files modified: `src/services/headlessPanelHtml.ts`, `src/services/LocalApiServer.ts`, `src/services/TaskViewerProvider.ts`, `src/standalone/bootstrap.ts`, `src/webview/transport.js`, `src/webview/kanban.html`. No issues encountered.

