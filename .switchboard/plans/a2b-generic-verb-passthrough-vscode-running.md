---
description: "Feature A · A2b (revised vehicle): expose ALL ~600 webview verbs over HTTP while VS Code is running, via a generic allowlist-gated passthrough into each provider's _handleMessage — NOT per-verb extraction. Supersedes the shim burndown and the invert-and-inject plan FOR THE 'VS Code minimised' goal. Headless (VS Code closed) remains the separate invert-and-inject plan, which reuses this dispatcher."
---

# Feature A · A2b — Generic Verb Passthrough (VS Code running)

> **Status: PLAN — ready to build.** This is the "complete manager while VS Code is minimised" vehicle. It makes every catalogued verb reachable over HTTP in ~5 small edits, not 600. It does **not** make the extension headless — that stays the invert-and-inject plan (`a2b-genuine-verb-extraction-burndown.md`), which builds *on top of* this dispatcher.

## Goal

Make **all ~600 webview↔host verbs** (Kanban 144, Planning 173, Design 62, TaskViewer 110, Setup 117 — per `protocol-catalog.json`) reachable over the LocalApiServer HTTP surface **while the VS Code extension is running**, so `/switchboard-manage` and any external agent host is a genuinely complete manager — every board/plan/feature/panel action a webview click can do, an HTTP client can do too.

### Problem / root cause (why the prior attempts failed)

The parent A2b (`transport-migration-per-verb-burndown.md`) tried to expose the surface by **extracting each of 606 handler arms into a parallel host-agnostic "service" twin**, then repointing the webview arm to the twin. This produced, and could only produce, shims:

- **The work is negative-value while VS Code runs.** The handler arm already exists and executes in-process. A "twin" that the arm delegates to adds nothing — so agents correctly wrote a one-line forwarder (`svc['verb'](p)` → `ctx.handleMessage({type, ...p})` → back into `_handleMessage`) and moved on. ~594 of 606 arms are these forwarders today.
- **The success metric was gameable.** `parity:check` counts `handleServiceVerb` case-labels, not reachability, so "605/605 (100%)" was reachable by writing 605 forwarders. Agents optimized for the green check they were handed.
- **The recipe was shim-shaped.** The written recipe said "repoint arm to `if (this._kanbanService) svc.verb(msg) else <original>`" — that *is* a shim, and repointing an arm to a same-named twin arms a `_handleMessage → svc.verb → ctx.handleMessage → _handleMessage` stack-overflow.

Root cause: **per-verb extraction is only necessary for headless operation** (no VS Code process to answer the ~229 `vscode.*` / ~26 `switchboard.*` calls inside the arms). For the actual Manage use case — VS Code minimised, extension alive, LocalApiServer up — `_handleMessage` runs correctly in-process. The surface just needs a **generic passthrough**, not 600 hand-written wrappers.

### Current state (verified in source, 2026-07-10)

- Routes already exist: `POST /kanban/verb/<name>`, `/planning/verb/<name>`, `/design/verb/<name>`, `/setup/verb/<name>`, `/taskViewer/verb/<name>` (`LocalApiServer.ts:2315-2330`), each → its `*Verb` callback → `<Provider>.handleServiceVerb(verb, payload)`.
- Every provider's `handleServiceVerb` is a hand-written `switch` gated to the ~6-12 "extracted" verbs; all others hit `throw new Error("Unknown or not-yet-extracted <Panel> verb")`. Locations: `KanbanProvider.ts:6500`, `PlanningPanelProvider.ts:76`, `DesignPanelProvider.ts:48`, `SetupPanelProvider.ts:27`, `TaskViewerProvider.ts:276`.
- `_handleMessage` is a private method on each provider (`KanbanProvider.ts:6664`, `DesignPanelProvider.ts:1516`, etc.), callable from `handleServiceVerb` as `this._handleMessage(...)`.
- `protocol-catalog.json` already enumerates every verb per provider under `providers.<Name>.verbs[]` (this is what A1 produced).
- WS fan-out for reads: `BroadcastHub.setApiServer()` exists on all 5 providers; it is called for Kanban and TaskViewer (`TaskViewerProvider.ts:1604` own broadcaster, `:1606` kanban). **Planning / Design / Setup broadcasters must be verified/wired** — if their `setApiServer` is never called, their reads never reach WS.

## Metadata
- **Tags:** refactor, backend, api, architecture, remote-control
- **Complexity:** 5
- **Release phase:** Feature A (VS Code minimised remote-control). This is the shippable "complete manager" vehicle. **Not** headless (that is B1 / invert-and-inject).
- **Relates to:** `transport-migration-per-verb-burndown.md` (parent A2b — this replaces its vehicle), `a2b-genuine-verb-extraction-burndown.md` (headless follow-on — reuses this dispatcher), A2a (`broadcastHub`, `wsHub`, seams), A1 (`protocol-catalog.json`).
- **Supersedes (for the VS-Code-running goal only):** the shim-extraction recipe in the parent A2b.

## User Review Required
- **Read-verb response contract.** Command verbs (move/trigger/dispatch/create/delete/reconcile/complete) work fully over HTTP after this change — side effect happens, `{success:true}` returns. Read verbs (`get*`/`fetch*`/`load*`) `break` in `_handleMessage` and emit their data as a **push**, so the HTTP body won't carry it; the data arrives over the **WebSocket hub**. Decision: **accept WS-delivered reads for now** (commands are the manager's 90%; many reads already have dedicated GET endpoints like `get-state`). Synchronous request/response for reads is an optional later enhancement (request-id correlation), out of scope here. Confirm this is acceptable.
- Otherwise: None.

## Scope

### ✅ IN SCOPE
1. **Auto-generated per-provider verb allowlist.** A build step reads `protocol-catalog.json` and emits `src/generated/verbAllowlist.ts` exporting one `Set<string>` per provider (`KANBAN_VERBS`, `PLANNING_VERBS`, `DESIGN_VERBS`, `TASKVIEWER_VERBS`, `SETUP_VERBS`). Generated, checked in, regenerated by the existing `catalog:generate` npm script so it can never drift from the catalog.
2. **Collapse all 5 `handleServiceVerb` switches to a generic passthrough.** Each becomes: allowlist-check the verb → `return this._handleMessage({ type: verb, ...(payload ?? {}) })`. Delete the per-verb `case`s. Do **not** delete `_handleMessage` or touch the webview arms.
3. **Delete the shim service twins.** The string-keyed forwarder methods on `kanbanService`/`planningService`/`designService`/`setupService`/`taskViewerService` are removed. Keep only genuinely host-agnostic domain logic already extracted (e.g. `getSetting`/`saveSetting` if the arm calls it directly) — if a service class holds no real shared logic after deletion, remove the class.
4. **Wire WS fan-out for reads on all 5 providers.** Verify `setApiServer(localApiServer)` is called for every provider's broadcaster (Kanban + TaskViewer confirmed; wire Planning/Design/Setup if missing). This is what lets read-verb pushes reach an HTTP client over the WS hub.
5. **Honest parity gate.** Rewrite `scripts/check-protocol-parity.js` to assert: for each provider, `allowlist Set === catalog verbs[]` (equal by construction, so the check is that generation ran) AND a smoke pass where every catalogued verb dispatches without hitting the "Unknown verb" throw. Remove the case-label counting. Split the report into request-response (HTTP) vs push/broadcast (WS) verbs using the catalog's `direction` field.
6. **Payload-parity note in each dispatcher.** Document that the HTTP `payload` must carry the same fields the webview `postMessage` would (the arm validates its own input; the network turns trusted postMessage into untrusted input — auth-gated + localhost is the current trust boundary).

### ⚙️ OUT OF SCOPE
- **Headless / VS Code closed** → `a2b-genuine-verb-extraction-burndown.md` (invert-and-inject). That plan seam-injects the arm bodies so `_handleMessage` runs with no `vscode`; it reuses *this* generic dispatcher. Do not attempt seam-injection here.
- **Synchronous request/response for read verbs** (request-id correlation so a `get*` returns in the HTTP body). Optional later; WS delivery is the contract for now.
- **New verbs / behavior changes.** This is a pure reachability change — no arm logic is modified.
- `node-pty` terminal (B3), browser board (B2), npx (B4).

## Implementation Steps
1. **Generator:** add `scripts/generate-verb-allowlist.js` — read `protocol-catalog.json`, emit `src/generated/verbAllowlist.ts` with the 5 `Set<string>` exports (+ a header comment "AUTO-GENERATED — do not edit; run `npm run catalog:generate`"). Add its invocation to the `catalog:generate` npm script and to CI drift check.
2. **Per provider (5 files), collapse the dispatcher.** Replace the switch body in `handleServiceVerb` with:
   ```ts
   // src/services/KanbanProvider.ts (mirror in the other 4 providers with their Set)
   import { KANBAN_VERBS } from './generated/verbAllowlist';
   public async handleServiceVerb(verb: string, payload: any): Promise<any> {
       if (!KANBAN_VERBS.has(verb)) {
           throw new Error(`Unknown Kanban verb: '${verb}'`);
       }
       // VS Code is the host here; _handleMessage runs in-process. Command verbs
       // return {success:...}; read verbs emit their result over the WS hub (see plan).
       return this._handleMessage({ type: verb, ...(payload ?? {}) });
   }
   ```
   Providers + Sets: Kanban→`KANBAN_VERBS`, Planning→`PLANNING_VERBS`, Design→`DESIGN_VERBS`, TaskViewer→`TASKVIEWER_VERBS`, Setup→`SETUP_VERBS`.
3. **Delete shim twins** in the `*Service` classes (the `abandonWorktree`/`addAutobanTerminal`/... string-keyed forwarders). Keep real domain methods. Remove now-unused imports; delete a service class if it is left empty.
4. **WS wiring:** confirm/add `<provider>.setApiServer(this._localApiServer)` for all 5 in `TaskViewerProvider` where the api server is attached (near `:1604`). Kanban + TaskViewer confirmed present; add Planning/Design/Setup if absent.
5. **Parity gate rewrite** (`scripts/check-protocol-parity.js`) per Scope #5.
6. **Build + catalog + parity gates green:** `npm run compile`, `npm run catalog:check`, `npm run parity:check`.

## Complexity Audit
### Routine
- Generator script (read JSON → emit `Set` literals).
- Collapsing 5 switches to a 3-line passthrough each; deleting shim twins.
### Complex / Risky
- **Read-verb contract**: confirming pushes actually reach a WS client for all 5 providers (the `setApiServer` wiring for Planning/Design/Setup is the risk — if inert, reads silently vanish). Validate with a live WS subscription smoke test, not just compile.
- **Payload parity**: an arm that read a field off panel state rather than the message may need that field supplied in the HTTP payload. Spot-check the manager's core verbs (trigger/dispatch/move/create/reconcile/complete) end-to-end.
- **Destructive verbs are now reachable** (`deleteFeature`, `abandonWorktree`, `completeAll`). Acceptable — they are management actions — but they ride the existing auth (`_checkAuth`) + localhost boundary; do not weaken it.

## Edge cases & risks
- **No recursion trap.** The webview arms are untouched; the HTTP path calls `this._handleMessage` directly. There is no arm→twin→`_handleMessage` cycle because there are no twins.
- **Un-catalogued / dynamic verbs.** `protocol-catalog.json` has 4 `manualReview` items (genuine dynamic `type`). If a needed verb isn't in the catalog, add it to the catalog generator's output, not by hand-editing the allowlist.
- **Reads without a WS client** return `{success:true}`-ish with no data — that is expected; the client must subscribe to the WS hub (or use the dedicated GET endpoints) to read.
- **This does not run headless.** Every arm still calls `vscode.*` internally; those resolve only because VS Code is alive. Documented, intentional.

## Dependencies
- A1 `protocol-catalog.json` (present — the verb source of truth).
- A2a `broadcastHub` + `wsHub` (present) for read delivery.
- **Unblocks** a genuinely complete `/switchboard-manage`; the "advance a plan to coding" verb (`promptOnDrop` / `triggerAction` → `dispatchConfiguredKanbanColumnAction`) becomes reachable as one of the ~600.
- **Foundation for** `a2b-genuine-verb-extraction-burndown.md` (headless): that plan keeps this dispatcher and adds seam-injection to the arm bodies.

## Verification Plan
### Automated
- `npm run compile` green.
- `npm run catalog:check` green; `verbAllowlist.ts` regenerates identically (drift check).
- Rewritten `npm run parity:check`: every catalogued verb per provider is in its allowlist and dispatches without "Unknown verb"; request-response vs push split reported.
### Manual / behavioral (the real proof)
- With VS Code running: `POST /kanban/verb/triggerAction` (or `promptOnDrop`) with a real plan sessionId + target coding column → the coder terminal receives the prompt in the current workspace, no worktree. This is the UAT case that started this.
- `POST /kanban/verb/moveCard`-class and a few command verbs across Planning/Design/Setup → effect matches the equivalent webview click.
- A WS client subscribed to the hub receives a read verb's data (`getFeatureDetails` or `getKanbanStructure`) after `POST /<panel>/verb/<readVerb>` — proving the read contract for all 5 providers.

## Effort note
Single focused session for the 5 dispatchers + generator + WS wiring; a short second pass for the parity-gate rewrite and the behavioral WS smoke test. Materially cheaper than any per-verb approach because **each provider is touched once**, not once per verb — there is no 600-item grind and no shims to write-then-delete.
