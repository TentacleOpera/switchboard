# Connections in VS Code — Extension-Host Entry Point and Dual-Provider Forwarding

## Goal

Give the Connections panel a VS Code entry point — a command, a webview panel, and a message handler that forwards each verb to the provider that owns it — so the panel is reachable in the extension host as well as the browser cockpit, and the duplicated Remote Control form can collapse to one implementation.

### Problem & background

**Root cause: `connections` is the only panel in the manifest with no extension-host entry point.** Every other panel exists in both hosts. Verified against `getPanelsManifest()` (`src/services/headlessPanelHtml.ts:484-503`) and `src/extension.ts`:

| Panel | Manifest row | VS Code command |
|---|---|---|
| project, memo, tickets, planning, design, setup, terminals | ✓ | ✓ |
| **connections** | ✓ | **✗** |

There is no `switchboard.openConnectionsPanel` in `package.json` `contributes.commands`, no `ConnectionsPanelProvider`, and no reference to the panel anywhere in `extension.ts`. A grep for `openConnections|ConnectionsPanelProvider` across `src/` and `package.json` returns nothing.

**This is a gap, not a design decision.** The project PRD asks for a browser cockpit *at parity with* the VS Code experience. Parity is a claim about the browser catching up to the extension; nothing in it licenses a panel that exists only in the browser. Connections was built browser-first because the rail is a browser construct — `shell.js` renders the manifest — and the extension-host half was simply never written.

**It is also the root cause of a live PRD contract #1 violation.** Because Connections is unreachable in VS Code, the Remote Control form had to stay alive in `setup.html` for extension users, and a second copy was authored in `connections.html` for browser users. The two now have independent handlers and different field coverage — the Connections copy omits `remote-boards-list`, `remote-silent-sync`, the sync-health block, `btn-copy-linear-agent-skill` and `board-state-export-select`. That is a fork of shipped UI, which contract #1 ("never fork or SPA-rewrite the UI") forbids outright. The fork cannot be closed while one host has no way to open the panel, so this plan is a prerequisite for closing it.

**Why the sibling plan talked the last coder out of building this.** *Connections Panel — Rename Remote Control and Give It a Rail Entry* records, in its routing decision:

> Introducing a `ConnectionsPanelProvider` (old option b) remains rejected — new allowlist block, new schemas, new ratchet entry, no user-visible benefit.

That reasoning was aimed at a provider that would **own verb arms**. What this plan builds owns none: it creates a webview, serves the shared HTML, and forwards every message to `SetupPanelProvider` or `PlanningPanelProvider`. A forwarder introduces no verbs, so there is no new allowlist block, no new schema block, and no new ratchet entry — the rejection does not apply to it. Stating that explicitly is part of this plan's job, because the next coder reading the sibling plan would reasonably conclude the opposite.

**The routing problem repeats in the extension host, in a different shape.** In the browser it is solved: `transport.js:26` derives one route prefix per panel, and `/connections/verb/<name>` (`LocalApiServer.ts:3552-3583`) dispatches by generated allowlist — `SETUP_VERBS` first, then `PLANNING_VERBS`, 404 otherwise. In the extension host the analogous constraint is that a webview's `onDidReceiveMessage` goes to whichever provider registered it. A Connections webview created by `SetupPanelProvider` would send the six `createPlans*` Planning verbs into `SetupPanelProvider.handleServiceVerb`, which throws `Unknown Setup verb` for anything outside `SETUP_VERBS` (`SetupPanelProvider.ts:51`). Every Web Agents control in VS Code would fail. The forwarding table is therefore not a nicety — it is the thing that makes the panel work at all in this host.

---

## Metadata
**Complexity:** 4
**Tags:** ui, backend, refactor, frontend
**Project:** browser-switchboard

---

## User Review Required

**None.** Two decisions are made here rather than deferred:

* **A thin `ConnectionsPanelProvider`, not a second webview on `SetupPanelProvider`.** Chosen so `SetupPanelProvider` does not grow a second panel's lifecycle (`_panel`, `_disposables`, broadcaster re-pointing) for a surface it does not own, and so the forwarding table lives in one file next to the comment explaining why this provider is not a normal provider. The alternative was considered and rejected on those grounds alone; it is not otherwise unsafe.
* **The provider owns no arms and appears in no allowlist.** It forwards. This is what makes it exempt from the sibling plan's rejection.

---

## Complexity Audit
* **Score:** 4 / 10

### Routine
* A `contributes.commands` entry and a `registerSwitchboardCommand` call beside its six siblings (`extension.ts:1337-1340` is the exact shape).
* Webview panel creation copied from `SetupPanelProvider.open()` (`:212-266`) — `createWebviewPanel`, `iconPath`, `webview.html`, `onDidReceiveMessage`, `onDidDispose`.
* Serving `getConnectionsHtml(...)`, which already exists (`headlessPanelHtml.ts:444`).

### Complex / Risky
* **The forwarding table is a second copy of a routing decision.** The HTTP route already encodes "Setup first, then Planning". A hand-maintained duplicate in the provider drifts the moment either allowlist changes. Both must derive from the same generated sets and the same precedence, and a test must pin that they agree.
* **`handleServiceVerb` is not the webview path.** The two providers expose `handleServiceVerb(verb, payload)` (`SetupPanelProvider.ts:62`, `PlanningPanelProvider.ts:105`) for HTTP dispatch, and a separate `_handleMessage` arm set for webview messages. Forwarding into the wrong one either double-validates or skips validation. Pick deliberately and say which.
* **Push routing.** A forwarded verb's *response* and any broadcast must reach the Connections webview, not the Setup or Artifacts panel. Both providers push through a broadcaster bound to their own webview; a forwarded call must not silently deliver its reply to a different panel — the reply would land somewhere the user is not looking, which reads as a dead button.
* **Shipped-UI adjacency.** This plan does not itself move the Remote form, but it unblocks that move. Nothing here may change `setup.html`.

---

## Edge-Case & Dependency Audit

### Race Conditions
* None new. No timers, no polling, no file watching. The panel is opened and disposed on user action.
* One ordering note: `SetupPanelProvider._initSetupService()` re-points its broadcaster at the freshly-created webview on every `open()` (`:253-260`, fixing a documented stale-broadcaster bug). A forwarding host must not cause that re-point to aim at the Connections webview, or closing Connections leaves the Setup panel pushing into a dead webview.

### Security
* No new network surface, no new verbs, no new credentials. The panel inherits the CSP + nonce treatment `getConnectionsHtml` already applies; do not hand-roll a looser policy.
* The forwarder must not become a way to reach a verb that neither allowlist contains. Unknown verbs return a typed failure, never a silent no-op.

### Side Effects
* One new command in the palette. Name it so the old term stays searchable — the panel copy already carries "formerly Remote Control".
* The panel becomes openable in a host where the Providers tab currently renders a **subset** of the Remote form. Until the sibling plan ports the five missing controls, an extension user who opens Connections sees fewer settings than Setup → Remote offers. Acceptable and non-destructive — the merge guard in `connections.js` means a partial form cannot wipe the fields it does not render — but it is the reason the two plans must land in order.

### Dependencies & Conflicts
* **Sibling — Connections Panel (rename + rail entry).** Landed. This plan consumes its `getConnectionsHtml`, its manifest row, and its `/connections/verb/` route.
* **Sibling — Move the WEB AGENTS Tab into Connections.** Landed. Its six `createPlans*` verbs are precisely what makes dual-provider forwarding necessary; without them a single-provider host would have sufficed.
* HTTP dispatch precedent to mirror — `LocalApiServer.ts:3552-3583`.
* Generated allowlists — `src/generated/verbAllowlist.ts` (`SETUP_VERBS`, `PLANNING_VERBS`). Generated: regenerate via `npm run catalog:generate`, never hand-edit.
* Panel creation pattern — `SetupPanelProvider.ts:212-266`.
* Command registration pattern — `extension.ts:1337-1340`.
* Cross-panel switch map — `src/webview/transport.js:232-238` (`PANEL_SWITCH_VERBS`).
* Shared HTML — `headlessPanelHtml.ts:444` (`getConnectionsHtml`).

---

## Dependencies
* None blocking. Both prerequisite siblings have landed.

---

## Adversarial Synthesis

Key risks: (1) **forwarding-table drift** — the extension host and the HTTP route encode the same "Setup first, then Planning" decision in two places, and a divergence produces a verb that works in the browser and throws in VS Code (or the reverse), which no existing gate can see; (2) **replies delivered to the wrong panel** — both target providers push through a broadcaster bound to their own webview, so a naive forward returns the result somewhere the user is not looking and the control reads as dead; (3) **rebuilding rather than reusing** — hand-writing panel creation or, worse, a second copy of the Connections HTML repeats the fork this plan exists to end. Mitigations: derive the forwarding decision from the same generated sets in the same order as `LocalApiServer`, and add a contract test asserting the two agree for every verb the panel actually posts; forward through the path whose result returns to the caller and deliver it to the Connections webview explicitly rather than relying on the target provider's broadcaster; reuse `getConnectionsHtml` and copy `SetupPanelProvider.open()`'s structure rather than inventing one.

---

## Proposed Changes

**Build order:** (1) provider → (2) command → (3) forwarding + reply delivery → (4) cross-panel switch → (5) drift test.

### 1. `src/services/ConnectionsPanelProvider.ts` (new) — the webview host

**Context:** `SetupPanelProvider.open()` (`:212-266`) is the template: reveal-if-open, `createWebviewPanel` with `enableScripts: true` and `retainContextWhenHidden: false`, `iconPath` from the extension URI, `webview.html` from the shared getter, `onDidReceiveMessage`, `onDidDispose` clearing the panel ref.

**Implementation:**
* Constructor takes the extension URI plus references to `SetupPanelProvider` and `PlanningPanelProvider` — the two forwarding targets — and nothing else.
* `open()` mirrors the Setup shape. Serve `getConnectionsHtml(repoRoot, workspaceRoot, capabilities, themeClass)`; do not read `connections.html` directly, and do not author any HTML in this file.
* `dispose()` closes the panel and its disposables.

**Logic:** the class exists to own a webview and a routing table. Keeping it free of arms is what keeps it out of `protocol-catalog.json`, the allowlists, `verbSchemas.ts` and the return-contract baseline — the whole reason the sibling plan's rejection does not bite.

**Edge cases:** `retainContextWhenHidden: false`, matching Setup — the panel rehydrates on reveal and the memory cost of a resident hidden renderer is not worth paying. Confirm the panel re-requests its state on reopen rather than assuming the webview survived.

### 2. `package.json` + `src/extension.ts` — the command

**Implementation:** add `switchboard.openConnectionsPanel` to `contributes.commands` with a title naming both terms, e.g. *"Switchboard: Open Connections (Remote Control)"*, so users who know the old name still find it. Register it in `extension.ts` beside `openSetupPanel` (`:1337-1340`) using `registerSwitchboardCommand`, and push the disposable onto `context.subscriptions`.

**Edge cases:** the six sibling commands accept no arguments except Setup's optional `section`. Accept an optional sub-tab id here for symmetry (`providers` / `handoffs` / `jobs` / `web-agents`) and pass it through as Setup does with `_pendingSection` — cheap now, and it is what lets a future card link straight to a sub-tab.

### 3. Forwarding and reply delivery

**Context:** `SETUP_VERBS` and `PLANNING_VERBS` overlap on exactly one verb today — `openTicketsPanel`, where both arms do the same thing — so precedence is currently unobservable. It is declared anyway so a future overlap resolves deterministically rather than by branch order, and so the two hosts cannot disagree.

**Implementation:**
* `onDidReceiveMessage(msg)` resolves the target: `SETUP_VERBS.has(msg.type)` → `SetupPanelProvider`; else `PLANNING_VERBS.has(msg.type)` → `PlanningPanelProvider`; else post a typed failure back to the Connections webview naming both sets, exactly as the HTTP branch's 404 body does.
* Forward through the target's **`handleServiceVerb(verb, payload)`**, not its `_handleMessage`. Rationale: `handleServiceVerb` is the validated entry point — it applies the allowlist gate and `validateVerbPayload` — and, per the PRD's return-in-body contract, it **returns** its result, which is what lets this provider deliver the reply to the right webview. Routing into `_handleMessage` would rely on the target's own broadcaster and push the reply into the Setup or Artifacts panel instead.
* Deliver the returned body to the Connections webview via `this._panel.webview.postMessage(result)`, mirroring what `transport.js` does in the browser when it re-dispatches the HTTP response body as a `MessageEvent`. That symmetry is deliberate: the same panel script must work unchanged in both hosts.

**Logic:** using the same allowlist sets in the same order as `LocalApiServer` means there is one routing decision expressed twice mechanically, rather than two decisions that happen to agree today.

**Edge cases:** a verb that throws inside the target must come back as `{success:false, error}` rather than an unhandled rejection — the panel's transport surfaces typed failures and would show nothing for a silent throw. A message with no `type` is dropped with a console warning, matching the shim's behaviour.

### 4. `src/webview/transport.js` — cross-panel switch

**Implementation:** add `openConnectionsPanel: 'connections'` to `PANEL_SWITCH_VERBS` (`:232-238`) so a browser panel posting that verb switches the shell to Connections client-side instead of falling through to an HTTP post.

**Edge cases:** the map is a hand-maintained mirror of panel ids; the entry must match the manifest id `connections` exactly.

### 5. Drift test

**Implementation:** a contract test asserting that for every verb the Connections panel actually posts — scraped from `src/webview/connections.js` — the extension-host forwarding table and the `/connections/verb/` HTTP branch resolve to the **same** provider, and that no such verb resolves to neither.

**Logic:** this is the only gate that can see the failure mode. A verb present in one host's routing and absent from the other type-checks, lints, and passes every existing gate; it shows up as a control that works in the browser and dead-clicks in VS Code.

---

## Verification Plan

### Automated
* `npm run catalog:check`, `parity:check`, `push-routing:check`, `verb-returns:check`, `mirror:check`, `icons:parity` — all must stay green. In particular the return-contract baseline must be **unchanged**: this provider adds no arms, so any movement there means arms were added by accident.
* `npx tsc -p tsconfig.test.json --noEmit` and `npm run lint`.
* The new drift test from §5, added to `package.json` **and** invoked from `.github/workflows/integration-tests.yml`. A check defined but not wired into CI is the documented green-while-incomplete hole and does not count as done.
* A test asserting `ConnectionsPanelProvider` contributes no verbs — its class name appears in no allowlist and no `verbSchemas.ts` block.

### Manual
1. **Command opens the panel** from the palette in VS Code, with the sub-tab strip, correct fonts and palette.
2. **Providers tab round-trip:** change provider, mode and each visible toggle; reload the window; every setting persists, and `boards` / `silentSync` — which this tab does not render — are **unchanged**. This is the load-bearing check, because it is the exact regression the browser copy shipped.
3. **Web Agents tab, every control clicked:** choose folder, download zip, copy prompt (link), copy prompt (platform), paste back and create a card, improve docs. Six verbs, six clicks — a render check is not sufficient, and this is the specific way the forwarding table fails.
4. **Replies land in Connections,** not in Setup or Artifacts. Open all three and confirm a Connections action does not update a sibling panel.
5. **Unknown verb** returns a typed failure the panel surfaces, not silence.
6. **Both hosts unchanged elsewhere:** the Setup panel and the Artifacts panel behave exactly as before; no existing control regresses.
7. **Dispose:** close and reopen the panel repeatedly; no leaked disposables, and the Setup panel's broadcaster still pushes to the Setup webview.
8. **Plan import:** confirm the importer registers this plan on the board.

---

## Follow-on, explicitly out of scope

Closing the fork is the sibling panel plan's remaining work, not this plan's: port `remote-boards-list`, `remote-silent-sync`, the sync-health block, `btn-copy-linear-agent-skill` and `board-state-export-select` into `connections.html`, then replace the `setup.html` Remote tab with the signpost that plan already specifies. **Do not start it here** — it touches shipped `setup.html` markup and belongs in one change with its own round-trip verification. This plan's job is to remove the reason the fork exists.

---

## Recommendation

Complexity 4 → **Send to Coder.**

## Completion Summary

Implemented the new `ConnectionsPanelProvider` (`src/services/ConnectionsPanelProvider.ts`) as a thin extension-host webview that serves the shared `getConnectionsHtml` panel and forwards each posted verb to `SetupPanelProvider` or `PlanningPanelProvider` using the same generated-allowlist precedence as the HTTP branch. Side-pushes are redirected to the Connections webview during forwarded calls so replies land in the right panel. Registered `switchboard.openConnectionsPanel` in `package.json` and `src/extension.ts`, added `openConnectionsPanel` to `PANEL_SWITCH_VERBS` in `src/webview/transport.js`, and added a source-level contract test (`src/test/connections-routing-contract.test.js`) wired to both `package.json` and `.github/workflows/integration-tests.yml`. `npx tsc -p tsconfig.test.json --noEmit`, `npm run lint`, `npm run catalog:check`, `npm run parity:check`, `npm run push-routing:check`, `npm run verb-returns:check`, and the new contract test all passed.

---

## Review Findings

**Built as specified, with one CRITICAL fixed in this pass.** `ConnectionsPanelProvider.ts` lands as a forwarding-only host: it owns no arms, appears in no allowlist, resolves through the generated `SETUP_VERBS`/`PLANNING_VERBS` in the same Setup-first order as `/connections/verb/`, forwards through `handleServiceVerb` (not `_handleMessage`) and delivers the returned body to its own webview. The command is registered beside its siblings, `openConnectionsPanel: 'connections'` is in `PANEL_SWITCH_VERBS`, and the §5 drift test exists and is wired into both `package.json` and CI. `verb-returns:check` is unchanged, confirming no arms were added. Notably every API it calls is real — `mirrorToWs(surface, msg, explicitVerb)`, `postMessageToWebview`, `HostCapabilities`, `getThemeBodyClass` all verified against their declarations.

**CRITICAL (fixed): the push redirection corrupted `SetupPanelProvider` permanently.** The forwarder went beyond the plan and intercepted the target providers' push methods so side-pushes reach the Connections webview — a good idea implemented unsafely. It captured the "original" method *inside* each call and restored it in `finally`, while `_handleMessage` was not serialised. Under overlap, a second forward captures the first call's **patch** as its original and reinstalls it on completion, so `SetupPanelProvider.postMessage` stays redirected to the Connections webview forever; once that panel closes, the `postMessage` rejection is swallowed and Setup pushes vanish silently. Reproduced in isolation before fixing. Overlap is guaranteed, not hypothetical: `connections.js` polls `getRemoteHealth` on a 15 s interval whenever Remote Control is active. Fixed by serialising forwards on a promise chain (`_forwardChain`) and capturing the pristine methods once (`_pristineSetupPostMessage` / `_pristinePlanningPostMessage`) so restore can never reinstall a patch. Two assertions added to `connections-routing-contract.test.js`, including one that fails on the per-call-local shape that caused it.

**Remaining risk:** none identified. The de-fork stays out of scope as this plan specifies — `setup.html` is untouched, verified. Validation: tsc, lint, all six gates, and nine contract suites including `connections-routing` (7/7) all green.
