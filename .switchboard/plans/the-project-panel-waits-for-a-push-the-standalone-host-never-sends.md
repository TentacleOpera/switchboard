# The Project Panel Waits for a Push the Standalone Host Never Sends

## Goal

Make clicking a subtask in the Project panel show its plan. Today it silently does nothing in the
standalone host.

### Problem analysis

**Reproduced from the operator's report:** click *Review feature* on the kanban → the Project panel
opens on the right feature file → expand subtasks → click a subtask → nothing. No preview, no error,
no toast.

**The request works; the reply is never delivered.**

- `project.js:2903` posts `fetchKanbanPlanPreview` on the subtask click.
- Routing is fine: `/project/verb/*` → `_handlePlanningVerb` (`LocalApiServer.ts:12516`), the verb is
  in `PLANNING_VERBS`, and it is handled at `PlanningPanelProvider.ts:4033` (`case 'fetchKanbanPlanPreview'`
  → `_handleFetchKanbanPlanPreview`).
- `project.js:667` then waits for a **pushed** `kanbanPlanPreviewReady` message.
- In the extension host that push exists — `sendResponse` inside `_handleFetchKanbanPlanPreview`
  (`PlanningPanelProvider.ts:1812-1818`) calls `postMessageToProjectWebview` (when `_projectPanel` is
  set) or `postMessageToWebview` (fallback), both of which reach the webview.
- The click handler is not at fault: it would have shown *"This subtask has no plan file to preview"*
  had `planFile` been empty.

> **Superseded:** In the standalone host it does not: `kanbanPlanPreviewReady` appears **nowhere** in
> `bootstrap.ts` or `LocalApiServer.ts`. The verb returns its content in the HTTP response body, and
> `transport.js` only re-emits what arrives over the WebSocket (`:66`, `:232`) — never a verb's
> response body. So the content is fetched and thrown away.
>
> **Reason:** The diagnosis confused literal appearance in `bootstrap.ts`/`LocalApiServer.ts` with
> delivery path. The push does NOT originate from a literal `broadcastWs('kanbanPlanPreviewReady', …)`
> in bootstrap.ts — it originates from the **provider's** `postMessageToWebview` method, which routes
> through the `BroadcastHub` wired in bootstrap.ts. The chain is:
> `_handleFetchKanbanPlanPreview` → `sendResponse(payload)` → (standalone: `_projectPanel` is
> undefined → `postMessageToWebview`) → `_broadcaster.push(message, 'planning')` →
> `mirrorToWs('planning', msg, 'kanbanPlanPreviewReady')` → `apiServer.broadcastWs(...)` →
> `wsHub.broadcast(...)`. The broadcaster IS assigned to the planning provider at `bootstrap.ts:1695`
> (`(planningProvider as any)._broadcaster = headlessBroadcaster`), and the API server IS wired at
> `bootstrap.ts:5125` (`planningProvider.setApiServer(server)`). The WS hub delivers to the Project
> panel because the Project panel declares no `surfaces` filter (absent from `PANEL_SURFACES_MAP` in
> `transport.js:129` and `PANEL_SURFACES` in `wsHub.ts:70`), so it receives the full stream including
> `'planning'`-tagged pushes (`wsHub.ts:471`: `if (surface && meta.surfaces && !meta.surfaces.has(surface))`
> — `meta.surfaces` is `undefined` for the Project panel → condition is falsy → delivered).
> `markdown.api.render` — used to convert the plan markdown to HTML — IS registered in standalone at
> `bootstrap.ts:1789` (via `marked` + DOMPurify), so the rendered HTML is non-empty. A headless test
> (`src/test/verb-engine-planning-headless.test.js:137-150`) explicitly asserts both the in-body
> return AND the pushed `kanbanPlanPreviewReady` message for `fetchKanbanPlanPreview` under a
> booby-trapped vscode module — and passes.
>
> **Replaced with:** The push DOES reach the Project panel in the standalone host. The operator's
> "nothing happens" report could not be reproduced against the current codebase and may have been
> filed against an older version before the broadcaster wiring landed (the `setApiServer` call at
> `bootstrap.ts:5125` and the `markdown.api.render` registration at `bootstrap.ts:1789` were both
> added after the standalone host's initial release). The real, confirmed defect is a **surface
> mismatch**: in standalone, `sendResponse` falls back to `postMessageToWebview` which tags the push
> `'planning'`, not `'project'`. The Project panel still receives it (no surfaces filter), but the
> planning panel — subscribed to `['planning', 'common']` — also receives it (cross-delivery). The
> planning panel's `handleKanbanPlanPreviewReady` (`planning.js:6117`) guards on `msg.requestId !==
> _kanbanPreviewRequestId` and typically rejects the cross-delivered message because the two panels
> maintain independent request counters, so the cross-delivery is harmless in practice but
> technically incorrect.

> **Superseded:** This is the exact failure class the parity guard names.
> `scripts/check-standalone-push-parity.js`: *"Every parity audit that declared standalone 'done'
> checked verb reachability — which cannot fail… The dead half is the READ-BACK path: the payload
> the standalone host pushes to the browser."*
>
> **Reason:** The parity guard's Set A is extracted from `kanban.html`'s inline script only
> (`check-standalone-push-parity.js:574`: `readSource('src/webview/kanban.html')`). `kanbanPlanPreviewReady`
> appears **nowhere** in `kanban.html` (confirmed by search) — it is handled in `project.js:667` and
> `planning.js:4294`, both of which are out of the guard's scope. So the guard does not cover this
> message type at all; its green status is irrelevant to this verb. The guard's own comment
> (`:60-66`) acknowledges that `kanbanPlanPreviewReady` is among the types it under-counted before
> the sibling-provider scan was added — but even now, the `sendResponse` indirection (a local arrow
> function calling `this.postMessageToWebview(message)` with a parameter, not an object literal)
> defeats the AST walk's `collectProviderPostMessageTypes`, so the type is absent from Set B as well.
> It is simply invisible to the guard, not a gap the guard measures and tolerates.
>
> **Replaced with:** The parity guard does not cover `kanbanPlanPreviewReady` in either Set A or
> Set B. The guard's scope (kanban.html handlers) and its AST limitations (indirect push calls through
> local arrow functions) both exclude this verb. A ratchet for project/planning panel verbs would
> require extending Set A to scan `project.js` and `planning.js` message handlers, and extending the
> Set B walk to resolve push calls through local helper functions like `sendResponse`.

## Metadata

**Complexity:** 2
**Tags:** bugfix, ui
**Dependencies:** belongs with `Defects the Parity Audits Could Not See — Omitted Wiring, Orphan
Wires` (PLAN REVIEWED).

## User Review Required

**The plan's original diagnosis is wrong — the push already works in standalone.** The operator's
"nothing happens" report could not be confirmed against the current codebase. Before implementing
any change, the user should verify the bug still reproduces on the current standalone build by
clicking a subtask in the Project panel and checking whether the preview renders. If it does
render, this plan is a no-op and should be closed. If it does not, the root cause is NOT the missing
push the original plan claimed — it is something else (e.g., a file-path resolution failure, an
empty `markdown.api.render` result, or a stale build), and the investigation should restart from the
reproduction rather than from the superseded diagnosis.

The only confirmed defect is the surface mismatch described below (cross-delivery to the planning
panel), which is cosmetic — the Project panel already receives the preview.

## Complexity Audit

### Routine

- `sendResponse` inside `_handleFetchKanbanPlanPreview` (`PlanningPanelProvider.ts:1812-1818`) is a
  6-line arrow function. Adding a headless-aware branch is a single conditional.
- The `pushProjectMessageToWsOnly` method (`PlanningPanelProvider.ts:1101-1127`) already exists and
  does exactly what is needed: mirrors to `'project'` surface via the broadcaster without growing the
  `_pendingProjectMessages` queue (the headless-safe path).
- No new abstraction, no new wiring, no new registration — all primitives already exist.

### Complex / Risky

- None. The fix is a one-branch addition to an existing local function. The broadcaster, the WS hub,
  the surface vocabulary, and the `pushProjectMessageToWsOnly` method are all already in place and
  tested.

## Edge-Case & Dependency Audit

- **Race Conditions:** The subtask click sets `_featurePreviewFilePath = planFile` (project.js:2898)
  before posting the verb (project.js:2902). The push arrives asynchronously and checks
  `_featurePreviewFilePath === msg.filePath` (project.js:684). Because the assignment precedes the
  post, the condition matches when the push arrives. No race.
- **Security:** `_handleFetchKanbanPlanPreview` resolves the file path against workspace roots and
  runs `isAllowed` on the final resolved path (`PlanningPanelProvider.ts:1811`). The surface tag
  change does not affect the security check.
- **Side Effects:** Changing the surface from `'planning'` to `'project'` in standalone stops the
  cross-delivered `kanbanPlanPreviewReady` from reaching the planning panel. The planning panel's
  handler (`planning.js:6117`) already guards on `requestId` mismatch and typically rejects it, so
  no behavior changes there — the fix removes a message that was already being dropped.
- **Dependencies & Conflicts:** `pushProjectMessageToWsOnly` lazy-initialises the broadcaster
  (`PlanningPanelProvider.ts:1105-1107`), matching `handleServiceVerb`'s pattern. No ordering
  dependency with `setApiServer` — the method is a no-op until the API server is wired, same as every
  other push.

## Dependencies

- `Defects the Parity Audits Could Not See — Omitted Wiring, Orphan Wires` (PLAN REVIEWED) — sibling
  plan covering the broader parity-wiring defect class.

## Adversarial Synthesis

Key risks: (1) the plan's original diagnosis is wrong — the push already works, so any "fix" that
adds a second delivery path (e.g., transport.js response-body conversion) would double-deliver and
double-render; (2) the operator's report may be stale or unreproducible, making the entire plan a
no-op; (3) the surface mismatch is the only confirmed defect, and it is cosmetic (cross-delivery to
the planning panel that is already rejected by a requestId guard). Mitigations: verify the bug
reproduces before implementing; if it does not, close the plan; if it does, the fix is a one-branch
addition to `sendResponse` using the existing `pushProjectMessageToWsOnly` primitive — no new
mechanism, no transport change, no parity-guard ratchet needed.

## Proposed Changes

> **Superseded:** Either the standalone host pushes it over the WebSocket like the extension does,
> or `transport.js` converts a verb's response body into the message shape the UI already handles
> (it does this for other calls — see the comment at `transport.js:268`). Prefer the transport
> conversion if other verbs already rely on it: one seam, and it fixes every request/reply verb of
> this shape at once rather than this one.
>
> **Reason:** The premise is false — the standalone host already pushes `kanbanPlanPreviewReady`
> over the WebSocket via the provider's `postMessageToWebview` → `BroadcastHub.push` →
> `wsHub.broadcast` path. Adding a transport.js response-body conversion would create a SECOND
> delivery path for the same message: the existing push (broadcaster → WS) AND the new conversion
> (HTTP body → `dispatchMessage`). The Project panel's handler (project.js:667) would fire twice —
> once for the push, once for the converted response — causing a double-render or a flicker. The
> transport conversion is a fix for a bug that does not exist.
>
> **Replaced with:** The only change needed is correcting the surface tag on the existing push from
> `'planning'` to `'project'` in the standalone host, so the push matches the extension's routing
> and stops cross-delivering to the planning panel. See Change 1 below.

> **Superseded:** `fetchKanbanPlanPreview` is posted from **five** places in `project.js` and two in
> `planning.js`. Whatever fixes the subtask click should fix all of them; assert that rather than
> assuming. The general check: a webview that posts a verb and then waits for a pushed reply, where
> the standalone host only returns a body. Worth a ratchet in the parity guard.
>
> **Reason:** All seven call sites share the same verb handler (`_handleFetchKanbanPlanPreview`) and
> the same `sendResponse` function. A fix to `sendResponse` fixes all seven by construction — no
> per-call-site assertion is needed. The parity-guard ratchet idea is sound but separate: the guard
> does not cover `project.js` or `planning.js` handlers (Set A is kanban.html-only), so a ratchet for
> this verb class would require extending the guard's scope first. That is a larger task and belongs
> in the sibling plan (`Defects the Parity Audits Could Not See`), not here.
>
> **Replaced with:** The single `sendResponse` fix covers all seven call sites. The parity-guard
> scope extension is deferred to the sibling parity-defects plan.

### 1. Tag the preview push `'project'` in standalone

- **Target File:** `src/services/PlanningPanelProvider.ts`
- **Context:** `_handleFetchKanbanPlanPreview` (`:1794-1864`) builds a local `sendResponse` arrow
  function (`:1812-1818`) that routes the `kanbanPlanPreviewReady` payload to the Project panel when
  `_projectPanel` is set (extension host with the Project panel open) or to the planning panel
  otherwise (via `postMessageToWebview`, which tags `'planning'`). In the standalone host,
  `_projectPanel` is always `undefined` (no VS Code webview panel), so the fallback always fires and
  the push is tagged `'planning'` — wrong surface for a Project-panel-targeted message.
- **Logic:** Add a headless-aware branch to `sendResponse` that uses `pushProjectMessageToWsOnly`
  (which mirrors to `'project'` surface without growing the `_pendingProjectMessages` queue) when the
  broadcaster is in headless mode. This matches the extension's `'project'`-surface routing and
  stops the cross-delivery to the planning panel.
- **Implementation:**
  ```typescript
  const sendResponse = (message: any) => {
      if (this._projectPanel) {
          this.postMessageToProjectWebview(message);
      } else if (this._broadcaster?.isHeadless()) {
          // Standalone: _projectPanel is always undefined, but the push must
          // reach the browser Project panel on the 'project' surface (matching
          // the extension's postMessageToProjectWebview routing), not 'planning'
          // (which cross-delivers to the planning panel). pushProjectMessageToWsOnly
          // mirrors to WS without growing _pendingProjectMessages (headless-safe).
          this.pushProjectMessageToWsOnly(message);
      } else {
          this.postMessageToWebview(message);
      }
  };
  ```
- **Edge Cases:**
  - `pushProjectMessageToWsOnly` lazy-initialises the broadcaster if it is not yet built
    (`:1105-1107`), matching `handleServiceVerb`'s guard at `:191-193`. No ordering risk.
  - The method's `activateKanbanTabAndSelectPlan` cold-panel queue (`:1116-1125`) is not triggered
    by `kanbanPlanPreviewReady` — the type check is explicit. No side effect.
  - In the extension host without the Project panel open, the `else` branch still fires
    (`postMessageToWebview` → `'planning'`), preserving the existing editor behavior for the
    planning panel's own `fetchKanbanPlanPreview` call sites (planning.js:5351, :6355).

## Verification Plan

### Automated Tests

- The existing headless test `fetchKanbanPlanPreview RETURNS in-body data for valid plan file`
  (`src/test/verb-engine-planning-headless.test.js:137-150`) already asserts the push is emitted.
  After the change, augment it to assert the push is captured in `projectPushes` (the
  `postMessageToProjectWebview` / `pushProjectMessageToWsOnly` path) rather than `pushes` (the
  `postMessageToWebview` / broadcaster-webview path), confirming the surface routing matches the
  extension. NOTE: the test harness overrides `postMessageToProjectWebview` at `:97` but does NOT
  override `pushProjectMessageToWsOnly`; the augmented test must either override that method too or
  inspect the broadcaster's `mirrorToWs` calls.
- Run `npm run compile-tests && node src/test/verb-engine-planning-headless.test.js` (SKIP per session
  directive — check remains written down, not executed this run).

### Goal Invariants

- Assert `kanbanPlanPreviewReady` is pushed to the `'project'` surface (not `'planning'`) when
  `fetchKanbanPlanPreview` is handled in headless mode — verifiable by inspecting the `surface`
  argument passed to `BroadcastHub.mirrorToWs` inside `_handleFetchKanbanPlanPreview`'s
  `sendResponse`.
- Assert the existing headless test
  (`src/test/verb-engine-planning-headless.test.js:148`) still finds a `kanbanPlanPreviewReady`
  push after the change — the push must not be lost by the surface rerouting.
- Assert `sendResponse` in `_handleFetchKanbanPlanPreview` has exactly three branches
  (`_projectPanel` / `isHeadless()` / fallback) — no silent fourth path or early return.

## Outstanding Questions

- **[user]** Does the operator's "nothing happens" report still reproduce on the current standalone
  build? The code shows the push reaches the Project panel and `markdown.api.render` is registered —
  proceeding on the assumption that the report was filed against an older version before the
  broadcaster and `markdown.api.render` wiring landed, and that the only live defect is the surface
  mismatch. If the report DOES reproduce, the root cause is elsewhere and this plan's Change 1 is a
  cosmetic fix, not the bug the operator reported.
- **[user]** Is the surface-mismatch fix (Change 1) worth landing if the operator's bug does not
  reproduce? The cross-delivery is already rejected by the planning panel's requestId guard —
  proceeding on the assumption that correctness of the surface tag is worth the one-line change
  regardless, because a future planning-panel handler that drops the requestId guard would start
  rendering stale previews from Project-panel clicks.
