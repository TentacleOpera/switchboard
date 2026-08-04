# Capability gating: stop the headless Board from showing controls that cannot work

## Goal

Make the browser Board's capability gating honest: consume the two flags the host already declares but
the webview ignores, gate whole tabs rather than 13 hand-listed selectors, add flags for the surfaces
that have none, and stop `featureManagement: true` over-reporting.

### Root problem / background (verified 2026-08-04 against a booted standalone server)

The served board page carries a real capability manifest —
read live from `/board`'s `data-host-capabilities` attribute:

```json
{"terminalDispatch":true,"automation":false,"orchestrator":false,"terminalFleet":true,
 "mcpTerminals":false,"secretsEntry":true,"featureManagement":true,
 "integrationsConfigured":{"clickup":true,"linear":true,"notion":false,"stitch":true}}
```

`applyCapabilityGating` (`src/webview/transport.js:346-484`) is the **only** consumer of that
manifest anywhere in the webviews — a grep for `hostCapabilities` across `src/webview/*.js` and
`*.html` returns exactly one hit (`transport.js:348`). `kanban.html` contains **no host detection of
its own**: no `__sbHost`, no `isHeadless`, no read of the `host-*-false` body classes. Whatever
`applyCapabilityGating` does not hide stays fully clickable.

Four concrete defects follow:

1. **Two declared flags are never read.** `applyCapabilityGating` branches on `terminalDispatch`
   (`:352`), `automation` (`:366`), `secretsEntry` (`:389`), `featureManagement` (`:441`) and
   `integrationsConfigured` (`:460`). **`orchestrator` and `mcpTerminals` have no branch at all.**
   Standalone declares both `false`, so the orchestrator and MCP-monitor controls render normally and
   their verbs (`stopOrchestrator`, `launchMcpMonitorTerminal`, `startMcpMonitorPolling`,
   `stopMcpMonitorPolling`, `stopMcpMonitorTerminal`, `checkMcpMonitorAuth`) are dead. The host is
   telling the truth and the page is not listening.

2. **`automation: false` hides 13 named selectors, not the AUTOMATION tab.** The injected CSS
   (`:369-385`) hides `#btn-autoban`, `#btn-manager-pass`, `#btn-cli-triggers`, `#btn-remote-control`,
   `.autoban-timers-inline`, `#btn-pause-autoban-timer`, `#btn-reset-autoban-timer`,
   `button[data-action="julesSelected"]`, `button[data-action="rePlanSelected"]`,
   `#btn-build-via-planner`, `#btn-update-via-planner`, `#btn-build-system`,
   `#btn-build-prd-via-planner`. It does **not** hide `data-tab="automation"` (`kanban.html:2694`) or
   `#automation-tab-content` (`:2783`). Confirmed by fetching `/board`: `data-tab="automation"` is
   present in the served markup. So the tab opens onto a live panel whose remaining verbs
   (`setAutomationMode`, `getAutobanConfig`, `updateAutobanConfig`, `addAutobanTerminal`,
   `removeAutobanTerminal`, `resetAutobanPools`, `getSchedulerConfig`, `setSchedulerConfig`,
   `schedulerPrompt`, `getSchedulerTargetContracts`) all fail. A selector allowlist cannot keep up
   with a tab; it drifts every time a control is added.

3. **Whole tabs have no flag at all.** `data-tab="worktrees"` (`:2695`) and `data-tab="uat"` (`:2697`)
   are served intact with every one of their verbs dead (10 and 3 respectively). There is no
   `worktrees` or `uat` capability to gate on.

4. **`featureManagement: true` over-reports.** The three create/promote/assign verbs work in
   standalone (`bootstrap.ts:970-976`), but `suggestFeatures` and `setFeatureWorkflowMode` do not.
   The flag's own design note in the capability-gate plan says a partially-wired host must report
   `false` because "a capability flag that overstates what is wired turns a dead control into one
   that claims support" — that is precisely what is happening.

Two design principles already in the codebase should be honoured rather than reinvented: the flags
are **fail-closed** (gating keys on `=== false`, and the default object sets `featureManagement:
false` so a host that forgets gates honestly), and the existing `secretsEntry` branch shows the good
pattern — hide the action, disable the input, and *explain why* ("Keys are entered in the editor and
used from there — open this workspace in VS Code to set it.", `:427`).

## Metadata
- **Tags:** frontend, ui, ux, reliability, bugfix
- **Complexity:** 5

### Verification note (2026-08-04 source re-check)

Every claim in this plan was re-verified against source and all of it holds:
`applyCapabilityGating` at `transport.js:346`, with branches at `:352` (`terminalDispatch`), `:366`
(`automation`), `:389` (`secretsEntry`), `:441` (`featureManagement`), `:460-473`
(`integrationsConfigured`), registered at `DOMContentLoaded` (`:488`) plus an immediate call (`:490`)
and re-applied on 500ms timers at `:438` and `:456`. A grep for `orchestrator` / `mcpTerminals` across
`transport.js` returns **zero** hits — both flags are declared and unread, exactly as stated.
`DEFAULT_HOST_CAPABILITIES` (`headlessPanelHtml.ts:27-34`) is fail-closed with `orchestrator: false`,
`mcpTerminals: false`, `featureManagement: false`; caps are merged at `:175` and serialised into
`data-host-capabilities` at `:176`.

One addition: `data-host-capabilities` is emitted by **every** panel getter (`:176` board, `:247`
project, `:285` planning, `:323` design, `:348` setup, `:372` memo, and the remaining two), so new
flags reach all panels automatically once added to the interface and the default object. That is
convenient for the Board work and it means a carelessly-named flag leaks into panels this plan
declares out of scope — keep the new names Board-specific (`worktrees`, `uat`, `boardStructure`,
`featureAdvanced` all are).

## Architecture Review — the approach was challenged

**The plan's chosen approach:** keep `applyCapabilityGating` as the single consumer of the manifest and
extend it — consume the two unread flags, widen the `automation` gate from 13 selectors to the tab, add
per-surface flags for `worktrees` / `uat` / `boardStructure`, and split `featureManagement`.

**Alternatives:**

1. **Extend `applyCapabilityGating` (chosen).** One consumer, one pattern repeated five times, four
   existing branches to copy. Both hosts keep rendering byte-identical HTML (PRD contract #1) and the
   gate stays a client-side affordance over an honest server error.
2. **Server-side conditional HTML** — omit the tab markup from `headlessPanelHtml` when a flag is
   false. Genuinely stronger (nothing to un-hide via devtools, no flash of ungated content) but it
   forks the panel HTML per host, which contract #1 forbids outright: "Both hosts render byte-identical
   panel HTML from the shared module."
3. **Declarative markup — `data-requires-capability="worktrees"` on tabs and controls, one generic
   sweep.** Structurally the nicest: it moves the knowledge into the markup next to the control, so a
   new control cannot be forgotten, which is the drift this plan is fixing. But it touches every
   gated control in `kanban.html` and turns a five-branch change into a markup migration, and it would
   have to co-exist with the four existing selector-based branches during the transition.

**Justification.** (1) ships the fix now; (3) is the right *eventual* shape and should be recorded as
the follow-up, because (1) fixes today's drift (a tab-level gate cannot be outrun by adding a button
inside the tab) without fixing the general case (a new *tab* still needs a new branch). (2) is
excluded by contract, not by taste.

**Goal-vs-appearance probe.** The goal is "no visible control that cannot work". The gating pass can
*look* complete while missing it in three ways, and each maps to a test below: (a) a control rendered
**after** the gate runs stays visible — hence the existing 500ms re-apply, which the new branches must
adopt; (b) a flag that is `true` because a host hardcoded it rather than deriving it from wiring —
which is precisely today's `featureManagement: true` defect, so re-committing it for `worktrees`/`uat`
would reproduce the bug the plan is fixing; (c) hiding a surface that actually works, which is a
capability regression dressed as honesty. The dead-click sweep test is the only assertion that closes
(a) and (b) together, and it is only as good as the triage list it cross-references — which is why the
soft dependency on `standalone-editor-bound-verb-triage` is load-bearing for everything except the
`orchestrator`/`mcpTerminals` subset.

## User Review Required (decisions, with defaults)

1. **Gate tabs by hiding them, or by showing them disabled with an explanation?**
   **Default (recommended): hide the tab.** A disabled tab full of disabled controls is noise; the
   Board already has seven tabs. Exception: keep the `secretsEntry` precedent for any surface where
   the user might reasonably look for the setting — there, an explanatory hint beats disappearance.

2. **New flag granularity: one `boardAdvanced` flag, or one per surface?**
   **Default: one per surface** — `worktrees`, `uat`, `boardStructure`, `automation` (existing),
   `orchestrator` (existing), `mcpTerminals` (existing). Per-surface flags let the triage plan's
   results flip individual surfaces on as they are implemented, without a single coarse flag that is
   wrong in both directions.

3. **Does `featureManagement` become `false` in standalone, or split?**
   **Default: split into `featureManagement` (create/promote/assign — stays `true`) and
   `featureAdvanced` (suggest/workflow-mode — `false`).** Flipping the whole flag to `false` would
   hide three verbs that genuinely work, which is a regression in capability to fix a
   misrepresentation. If the split is judged over-engineering, the fallback is `false` plus a
   follow-up to re-enable.

## Complexity Audit

### Routine
- Adding branches to `applyCapabilityGating` follows four existing examples in the same function.
- Adding fields to the capability type and `DEFAULT_HOST_CAPABILITIES` in
  `src/services/headlessPanelHtml.ts` (caps merged at `:175`, serialised at `:176`) is mechanical.
- The fail-closed default (`=== false` checks, defaults set to `false`) is already the convention.

### Complex / Risky
- **Selector list → tab gating is a behaviour change for the extension host too.** Both hosts render
  the same `kanban.html` through the same `transport.js`. The extension declares these flags `true`,
  so nothing should change there — but that must be asserted, not assumed, or a mis-set default hides
  the AUTOMATION tab in the editor.
- **Determining who sets the flags.** `LocalApiServer` derives some capabilities from whether option
  hooks are wired (the `hasFeatureManagement()` all-six pattern). New flags must be derived the same
  honest way — from what is actually wired — rather than hardcoded per host, or they become the next
  thing that over-reports.
- **Ordering against triage.** Gating a surface the triage plan is about to make work wastes effort
  and then has to be reverted.

## Edge-Case & Dependency Audit

- **Race Conditions.** `applyCapabilityGating` runs at `DOMContentLoaded` (`:487-491`) while the
  existing `featureManagement` and `secretsEntry` branches also re-run on a 500ms timer (`:438`,
  `:456`) because controls are rendered late. Tab gating must use the same belt-and-braces approach
  (CSS class on `body` plus a delayed re-apply) or a tab rendered after the pass stays visible.
- **Security.** `secretsEntry: false` currently disables token inputs client-side only. Client-side
  gating is a UX affordance, never an authorisation boundary — the server must still reject verbs it
  cannot serve. Keep the honest server-side error from the fallthrough plan in place; do not treat
  gating as the enforcement.
- **Side Effects.** Hiding a tab changes which tab is selected on load if the hidden one was default;
  ensure the tab controller falls back to `kanban`.
- **Dependencies & Conflicts.** Should land **after** `standalone-editor-bound-verb-triage` produces
  the verified editor-only list, so the flags reflect measurement rather than expectation. Can land
  before it for `orchestrator` and `mcpTerminals`, which are already declared `false` and already
  measured dead — that subset is safe to do immediately.

## Dependencies

- `standalone-editor-bound-verb-triage` — supplies the verified per-surface list (soft dependency;
  the `orchestrator`/`mcpTerminals` subset does not need it).
- (No session IDs cited; IDs are assigned on import.)

## Adversarial Synthesis

**Risk summary.** The main risk is gating too much: this file is shared by both hosts, so a flag that
defaults wrong or a selector that over-matches removes working functionality from the editor Board —
a far worse outcome than the dead clicks being fixed. The second risk is gating instead of fixing:
`worktrees` and `uat` are DB-and-git surfaces that probably *can* work headlessly, so hiding them
should be explicitly temporary and tied to the triage result, not quietly permanent.

## Proposed Changes

### `src/services/headlessPanelHtml.ts`

- **Context.** `HostCapabilities` and `DEFAULT_HOST_CAPABILITIES`; caps merge at `:175`; the
  `data-host-capabilities` attribute written at `:176` (and the equivalent for each other panel,
  `:247`, `:285`, `:323`, `:348`, `:372`, `:401`, `:430`).
- **Logic.** Add `worktrees`, `uat`, `boardStructure` and `featureAdvanced`, all defaulting to
  `false` (fail-closed, matching the documented `featureManagement` precedent).
- **Implementation.** Extend the interface and the default object; no call-site changes needed since
  hosts spread their own capabilities over the defaults.
- **Edge Cases.** Because defaults are `false`, the **extension** must now explicitly declare these
  `true` or it will gate its own working surfaces. That declaration is the paired change below and
  must land in the same commit.

### `src/services/TaskViewerProvider.ts` (extension host)

- **Context.** The extension's `LocalApiServer` construction at `:1966` onward, which supplies the
  capability inputs.
- **Logic.** Declare `worktrees: true`, `uat: true`, `boardStructure: true`, `featureAdvanced: true`
  for the editor host, derived from wired-ness where a hook exists (as `hasFeatureManagement()` does)
  rather than hardcoded `true`.
- **Implementation.** Mirror the existing derivation style so the flags stay honest as hooks change.
- **Edge Cases.** If a derivation is not available for a surface, a literal `true` with a comment is
  acceptable for the editor host — it is the host where those surfaces demonstrably work.

### `src/webview/transport.js`

- **Context.** `applyCapabilityGating:346-484`; the `automation` branch at `:366-387`; the
  `secretsEntry` explain-why pattern at `:410-438`; `featureManagement` at `:441-457`; the
  DOMContentLoaded + 500ms re-apply pattern.
- **Logic.** (a) Extend the `automation === false` CSS to hide the tab button and panel
  (`[data-tab="automation"]`, `#automation-tab-content`, `#automation-panel-root`) in addition to the
  13 selectors, so the gate stops drifting as controls are added. (b) Add `orchestrator === false`
  and `mcpTerminals === false` branches hiding their controls. (c) Add `worktrees === false` and
  `uat === false` branches hiding `[data-tab="worktrees"]` / `[data-tab="uat"]` and their panels.
  (d) Add `boardStructure === false` to hide column add/edit/delete affordances. (e) Add
  `featureAdvanced === false` to disable `#btn-suggest-features` with a tooltip, following the
  `featureManagement` pattern at `:443-449`.
- **Implementation.** One `body` class plus one injected style block per flag, consistent with the
  existing branches. Where a control is rendered late, re-apply on the same 500ms timer already used
  twice in this function.
- **Edge Cases.** After hiding tabs, ensure the tab controller selects `kanban` if the previously
  active tab is now hidden (persisted tab selection is a real possibility). Do not hide a tab by
  removing it from the DOM — `display:none` keeps any JS that queries it from throwing.

## Verification Plan

### Automated Tests

- **Serialisation test (extend the existing fail-closed suite).**
  `headless-feature-management-contract.test.js` already asserts that a caps object with no
  `featureManagement` key serialises as `false`; add the same assertion for `worktrees`, `uat`,
  `boardStructure` and `featureAdvanced`.
- **Extension-host regression.** Assert the board HTML produced for the editor host declares all new
  flags `true`, so the shared gating cannot hide working editor surfaces. This is the test that
  protects against the primary risk.
- **DOM test — tab gating.** With jsdom, load the board markup with `automation:false`,
  run `applyCapabilityGating`, and assert `[data-tab="automation"]` and `#automation-tab-content`
  compute to `display:none` while `[data-tab="kanban"]` does not. Repeat for `worktrees` and `uat`.
- **DOM test — newly consumed flags.** With `orchestrator:false` and `mcpTerminals:false`, assert
  their controls are hidden; assert they are visible when the flags are `true`.
- **Dead-click sweep.** Cross-reference the triage plan's editor-only verb list against the gated
  selectors and assert every editor-only verb's control is hidden — the test that "no visible control
  sends a verb this host cannot serve".
- **Manual smoke.** Open the standalone board and click through every visible control on every visible
  tab; nothing should produce a `not implemented in standalone mode` toast.

## Uncertain Assumptions

- That `worktrees` and `uat` deserve gating at all rather than implementation. They are DB/git
  surfaces with existing provider arms, so triage may well flip them to working — treat gating them
  as provisional.
- That no persisted UI state re-selects a hidden tab. Board tab selection may be stored via
  `saveSetting`, which in standalone does not survive restart today — **and will after
  `standalone-persist-ui-settings` lands**, since that plan retires the process-local Map so
  `saveSetting` reaches the durable `kanban.db` config tiers. This plan is sequenced last, so assume
  the symptom **is** reachable and implement the fall-back-to-`kanban` behaviour rather than treating
  it as theoretical.

## Out of Scope

- Implementing any gated surface.
- Gating panels other than the Board (`project`, `planning`, `setup`, `tickets`, `design` measured
  clean).
- The declarative `data-requires-capability` migration (Architecture Review alternative 3) — the right
  eventual shape, recorded here as the follow-up. This plan's tab-level gates stop a *new control*
  from escaping the gate; only the declarative form stops a *new tab* from needing a new branch.

## Completion Summary
Extended capability gating system by defining `worktrees`, `uat`, `boardStructure`, and `featureAdvanced` flags in `src/services/headlessPanelHtml.ts`, reporting them as `true` in `src/services/TaskViewerProvider.ts` for extension host, and updating `src/webview/transport.js` to consume `orchestrator`, `mcpTerminals`, `worktrees`, `uat`, `boardStructure`, `featureAdvanced`, and tab-level `automation` gating rules.
- Files changed: `src/services/headlessPanelHtml.ts`, `src/services/TaskViewerProvider.ts`, `src/webview/transport.js`
- Issues encountered: None.

