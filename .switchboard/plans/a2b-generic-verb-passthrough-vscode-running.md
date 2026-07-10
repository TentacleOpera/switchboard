---
description: "Feature A · A2b (revised vehicle): expose ALL ~600 webview verbs over HTTP while VS Code is running, via a generic allowlist-gated passthrough into each provider's _handleMessage — NOT per-verb extraction. Supersedes the shim burndown and the invert-and-inject plan FOR THE 'VS Code minimised' goal. Headless (VS Code closed) remains the separate invert-and-inject plan, which reuses this dispatcher."
---

# Feature A · A2b — Generic Verb Passthrough (VS Code running)

> **Status: PLAN — reviewed & ready to build.** This is the "complete manager while VS Code is minimised" vehicle. It makes every catalogued verb reachable over HTTP in ~5 small edits, not 600. It does **not** make the extension headless — that stays the invert-and-inject plan (`a2b-genuine-verb-extraction-burndown.md`), which builds *on top of* this dispatcher.

## Goal

Make **all ~600 webview↔host verbs** (Kanban 144, Planning 172, Design 62, TaskViewer 110, Setup 117 — per `protocol-catalog.json`) reachable over the LocalApiServer HTTP surface **while the VS Code extension is running**, so `/switchboard-manage` and any external agent host is a genuinely complete manager — every board/plan/feature/panel action a webview click can do, an HTTP client can do too.

> **Clarification (2026-07-10 review, verified in source):** functionally, most verbs are *already reachable today* — the shim burndown filled every provider's `handleServiceVerb` switch with string-keyed forwarder cases (`case 'verb': return svc['verb'](p)` → `ctx.handleMessage` → `_handleMessage`). Forwarder counts per service: kanbanService 134, planningService 172, designService 63, setupService 115, taskViewerService 111. So this plan's deliverable is not a capability unlock but a **structural replacement**: the same reachability with ~2,700 lines of shim sandwich deleted, new verbs auto-exposed on catalog regeneration (zero manual case additions, so the surface can never silently drift), and an honest parity gate. The Goal statement above stands — the *guarantee* of completeness (allowlist ≡ catalog by construction) is what this plan adds.

### Problem / root cause (why the prior attempts failed)

The parent A2b (`transport-migration-per-verb-burndown.md`) tried to expose the surface by **extracting each of 606 handler arms into a parallel host-agnostic "service" twin**, then repointing the webview arm to the twin. This produced, and could only produce, shims:

- **The work is negative-value while VS Code runs.** The handler arm already exists and executes in-process. A "twin" that the arm delegates to adds nothing — so agents correctly wrote a one-line forwarder (`svc['verb'](p)` → `ctx.handleMessage({type, ...p})` → back into `_handleMessage`) and moved on. ~594 of 606 arms are these forwarders today.
- **The success metric was gameable.** `parity:check` counts `handleServiceVerb` case-labels, not reachability, so "605/605 (100%)" was reachable by writing 605 forwarders. Agents optimized for the green check they were handed.
- **The recipe was shim-shaped.** The written recipe said "repoint arm to `if (this._kanbanService) svc.verb(msg) else <original>`" — that *is* a shim, and repointing an arm to a same-named twin arms a `_handleMessage → svc.verb → ctx.handleMessage → _handleMessage` stack-overflow.

Root cause: **per-verb extraction is only necessary for headless operation** (no VS Code process to answer the ~229 `vscode.*` / ~26 `switchboard.*` calls inside the arms). For the actual Manage use case — VS Code minimised, extension alive, LocalApiServer up — `_handleMessage` runs correctly in-process. The surface just needs a **generic passthrough**, not 600 hand-written wrappers.

### Current state (verified in source, 2026-07-10 — re-verified at review)

- Routes already exist: `POST /kanban/verb/<name>`, `/planning/verb/<name>`, `/design/verb/<name>`, `/setup/verb/<name>`, `/taskViewer/verb/<name>` (`LocalApiServer.ts:2315-2330`), each → its `*Verb` callback → `<Provider>.handleServiceVerb(verb, payload)`. The route layer already **strips any client-supplied body `type`** (`LocalApiServer.ts:870-875`) — the URL verb is authoritative — and serializes `result ?? { success: true }` with HTTP status derived from `result.success` (`:878-881`).

> **Superseded:** Every provider's `handleServiceVerb` is a hand-written `switch` gated to the ~6-12 "extracted" verbs; all others hit `throw new Error("Unknown or not-yet-extracted <Panel> verb")`.
> **Reason:** Stale — it contradicted this plan's own problem statement ("~594 of 606 arms are these forwarders today") and the source. The shim burndown filled the switches: every catalogued verb has a `case` forwarding to its service shim. The `default:` throw now fires only for un-catalogued verb names.
> **Replaced with:** Every provider's `handleServiceVerb` is a fully-populated hand-written `switch` (one `case` per catalogued verb, forwarding to the string-keyed shim method on its `*Service` class, which forwards to `ctx.handleMessage` → `_handleMessage`). Dispatcher locations unchanged: `KanbanProvider.ts:6500`, `PlanningPanelProvider.ts:76`, `DesignPanelProvider.ts:48`, `SetupPanelProvider.ts:27`, `TaskViewerProvider.ts:276`. The collapse in this plan replaces ~600 cases + ~595 shim methods with 5 allowlist checks.

- `_handleMessage` is a private method on each provider (`KanbanProvider.ts:6664`, `PlanningPanelProvider.ts:2677`, `DesignPanelProvider.ts:1516`, `SetupPanelProvider.ts:304`, `TaskViewerProvider.ts:268`), callable from `handleServiceVerb` as `this._handleMessage(...)`. Note the return types: TaskViewer's returns `Promise<any>`; Planning/Design/Setup are typed `Promise<void>` and Kanban's is unannotated — so for most providers a command verb's HTTP response is the route layer's generic `{ success: true }` ack, not arm data. This matches the existing shim-path behavior; it is not a regression.
- `protocol-catalog.json` already enumerates every verb per provider under `providers.<Name>.verbs[]` (this is what A1 produced). Verb totals: Kanban 144, Planning 172 (`armCount` 173 — one duplicate case label; the `verbs[]` array is the source of truth), Design 62, TaskViewer 110, Setup 117; 4 `manualReview` dynamic-type items.

> **Superseded:** WS fan-out for reads: `BroadcastHub.setApiServer()` exists on all 5 providers; it is called for Kanban and TaskViewer (`TaskViewerProvider.ts:1604` own broadcaster, `:1606` kanban). **Planning / Design / Setup broadcasters must be verified/wired** — if their `setApiServer` is never called, their reads never reach WS.
> **Reason:** Verified in source at review: the wiring is already complete for all 5 providers. `TaskViewerProvider.ts:1604-1615` calls `setApiServer` on its own broadcaster, Kanban (`:1606`), Setup (`:1609`), Design (`:1611-1612`), and Planning (`:1614-1615`); the provider-side methods exist (`PlanningPanelProvider.ts:291`, `DesignPanelProvider.ts:154`, `SetupPanelProvider.ts:201`, `KanbanProvider.ts:6473`). The same wiring is repeated at provider-attach time (`TaskViewerProvider.ts:2692-2730`).
> **Replaced with:** WS fan-out wiring is **done** for all 5 providers. The remaining risk is behavioral, not structural: confirm with a live WS-subscription smoke test that a read verb's push actually arrives for Planning/Design/Setup (their broadcasters are wired but their read paths have not been exercised over the hub). Implementation Step 4 is verify-only.

- Genuine (non-forwarder) service extractions exist and are **called directly from webview arms** — these must survive shim deletion: `KanbanProvider` arms call `this._kanbanService.selectPlan/openPlanByPath/refresh/scanFoldersNow/focusTerminal/fileExists/getRemoteConfig/setRemoteConfig/saveSetting` (e.g. `KanbanProvider.ts:6694, 6705, 6733, 6738, 7180, 7189, 8987, 9045, 9066`); `SetupPanelProvider` arms call `this._setupService.saveStartupCommands/getStartupCommands` (`SetupPanelProvider.ts:738, 746`). Planning/Design/TaskViewer services contain **no** directly-called methods — pure forwarder classes, fully deletable.

## Metadata
- **Tags:** refactor, backend, api, architecture
- **Complexity:** 5
- **Release phase:** Feature A (VS Code minimised remote-control). This is the shippable "complete manager" vehicle. **Not** headless (that is B1 / invert-and-inject).
- **Relates to:** `transport-migration-per-verb-burndown.md` (parent A2b — this replaces its vehicle), `a2b-genuine-verb-extraction-burndown.md` (headless follow-on — reuses this dispatcher), A2a (`broadcastHub`, `wsHub`, seams), A1 (`protocol-catalog.json`), `switchboard-manage-skill-ux-overhaul.md` (sibling subtask — consumes this surface; coordinates on `guidedSetup` verb removal and catalog/allowlist regeneration).
- **Supersedes (for the VS-Code-running goal only):** the shim-extraction recipe in the parent A2b.

## User Review Required
- **Read-verb response contract.** Command verbs (move/trigger/dispatch/create/delete/reconcile/complete) work fully over HTTP after this change — side effect happens, `{success:true}` returns. Read verbs (`get*`/`fetch*`/`load*`) `break` in `_handleMessage` and emit their data as a **push**, so the HTTP body won't carry it; the data arrives over the **WebSocket hub**. Decision: **accept WS-delivered reads for now** (commands are the manager's 90%; many reads already have dedicated GET endpoints like `get-state`). Synchronous request/response for reads is an optional later enhancement (request-id correlation), out of scope here. Confirm this is acceptable.
- Otherwise: None.

## Scope

### ✅ IN SCOPE
1. **Auto-generated per-provider verb allowlist.** A build step reads `protocol-catalog.json` and emits `src/generated/verbAllowlist.ts` exporting one `Set<string>` per provider (`KANBAN_VERBS`, `PLANNING_VERBS`, `DESIGN_VERBS`, `TASKVIEWER_VERBS`, `SETUP_VERBS`). Generated, checked in, regenerated by the existing `catalog:generate` npm script so it can never drift from the catalog. Source of truth per provider is `providers.<Name>.verbs[]` (not `armCount`).
2. **Collapse all 5 `handleServiceVerb` switches to a generic passthrough.** Each becomes: allowlist-check the verb → `return this._handleMessage({ ...(payload ?? {}), type: verb })`. Delete the per-verb `case`s. Do **not** delete `_handleMessage` or touch the webview arms.
3. **Delete the shim service twins — with a grep-driven keep-list.** The string-keyed forwarder methods on `kanbanService`/`planningService`/`designService`/`setupService`/`taskViewerService` are removed. **Keep** the genuinely-extracted methods that webview arms call directly (Kanban: `selectPlan`, `openPlanByPath`, `refresh`, `scanFoldersNow`, `focusTerminal`, `fileExists`, `getRemoteConfig`, `setRemoteConfig`, `saveSetting`/`getSetting`; Setup: `saveStartupCommands`, `getStartupCommands` — re-verify with `grep -n "this\._<svc>\." src/services/<Provider>.ts` before deleting). `planningService.ts`, `designService.ts`, and `taskViewerService.ts` hold no directly-called methods — delete the classes entirely and remove their construction/context plumbing. `kanbanService.ts` and `setupService.ts` shrink to their genuine methods (keep `_initKanbanService` and the service context for them).
4. **Verify WS fan-out for reads on all 5 providers.** Wiring is confirmed present for all 5 (see Current State). This step is a behavioral smoke test only: with a WS client subscribed to the hub, fire one read verb per provider and confirm the push arrives — especially Planning/Design/Setup, whose hub paths are wired but unexercised.
5. **Honest parity gate.** Rewrite `scripts/check-protocol-parity.js` to assert: (a) `src/generated/verbAllowlist.ts` regenerates byte-identical from `protocol-catalog.json` (drift check — this, plus `catalog:check` asserting the catalog matches the source arms, is what makes "allowlist ≡ catalog" a real guarantee rather than a tautology); (b) each provider's `handleServiceVerb` contains its allowlist check and **zero** `case` labels (shape check — proves the generic dispatcher is actually in place); (c) a smoke dispatch of a known verb per provider does not hit the "Unknown verb" throw. Remove the case-label counting and the shim/genuine analysis (obsolete once shims are gone). Split the report into request-response (HTTP) vs push/broadcast (WS) verbs using the catalog's `direction` field.
6. **Payload-parity note in each dispatcher.** Document that the HTTP `payload` must carry the same fields the webview `postMessage` would (the arm validates its own input; the network turns trusted postMessage into untrusted input — auth-gated + localhost is the current trust boundary).

### ⚙️ OUT OF SCOPE
- **Headless / VS Code closed** → `a2b-genuine-verb-extraction-burndown.md` (invert-and-inject). That plan seam-injects the arm bodies so `_handleMessage` runs with no `vscode`; it reuses *this* generic dispatcher. Do not attempt seam-injection here.
- **Synchronous request/response for read verbs** (request-id correlation so a `get*` returns in the HTTP body). Optional later; WS delivery is the contract for now.
- **New verbs / behavior changes.** This is a pure reachability change — no arm logic is modified.
- `node-pty` terminal (B3), browser board (B2), npx (B4).

## Implementation Steps
1. **Generator:** add `scripts/generate-verb-allowlist.js` — read `protocol-catalog.json`, emit `src/generated/verbAllowlist.ts` with the 5 `Set<string>` exports (+ a header comment "AUTO-GENERATED — do not edit; run `npm run catalog:generate`"). Add its invocation to the `catalog:generate` npm script (`package.json:828`) and to the CI drift check.
2. **Per provider (5 files), collapse the dispatcher.** Replace the switch body in `handleServiceVerb` with:

   > **Superseded:**
   > ```ts
   > import { KANBAN_VERBS } from './generated/verbAllowlist';
   > public async handleServiceVerb(verb: string, payload: any): Promise<any> {
   >     if (!KANBAN_VERBS.has(verb)) {
   >         throw new Error(`Unknown Kanban verb: '${verb}'`);
   >     }
   >     return this._handleMessage({ type: verb, ...(payload ?? {}) });
   > }
   > ```
   > **Reason:** Two defects. (1) Wrong import path — from `src/services/` the generated file is at `../generated/verbAllowlist`. (2) Spread order: `{ type: verb, ...payload }` lets a `payload.type` field **override** the allowlist-checked verb and dispatch a different arm. The HTTP route layer already strips body `type` (`LocalApiServer.ts:870-875`), but `handleServiceVerb` is also called from the unified TaskViewer dispatch (`TaskViewerProvider.ts:1516-1549`) and any future caller — the dispatcher must be safe regardless of caller hygiene.
   > **Replaced with:**
   > ```ts
   > // src/services/KanbanProvider.ts (mirror in the other 4 providers with their Set)
   > import { KANBAN_VERBS } from '../generated/verbAllowlist';
   > public async handleServiceVerb(verb: string, payload: any): Promise<any> {
   >     if (!KANBAN_VERBS.has(verb)) {
   >         throw new Error(`Unknown Kanban verb: '${verb}'`);
   >     }
   >     // VS Code is the host here; _handleMessage runs in-process. Command verbs
   >     // return the route layer's {success:true} ack (most _handleMessage impls are
   >     // void); read verbs emit their result over the WS hub (see plan).
   >     // `type` is set LAST so a payload `type` field can never override the
   >     // allowlist-checked verb, regardless of caller.
   >     return this._handleMessage({ ...(payload ?? {}), type: verb });
   > }
   > ```

   Providers + Sets: Kanban→`KANBAN_VERBS`, Planning→`PLANNING_VERBS`, Design→`DESIGN_VERBS`, TaskViewer→`TASKVIEWER_VERBS`, Setup→`SETUP_VERBS`. Note `PlanningPanelProvider._handleMessage` has a second parameter (`isProject: boolean = false`, `PlanningPanelProvider.ts:2677`) — the passthrough omits it, taking the default, which matches what the forwarder shims do today.
3. **Delete shim twins** per Scope #3 (grep-driven keep-list). Remove now-unused imports; delete `planningService.ts` / `designService.ts` / `taskViewerService.ts` outright; shrink `kanbanService.ts` / `setupService.ts` to genuine methods.
4. **WS verification:** behavioral smoke test only (wiring confirmed present) — see Scope #4.
5. **Parity gate rewrite** (`scripts/check-protocol-parity.js`) per Scope #5.
6. **Gates green:** `npm run catalog:check`, `npm run parity:check`. (Compilation is excluded from this session's verification per session directive; the coder runs `npm run compile` before merge as usual.)

## Complexity Audit
### Routine
- Generator script (read JSON → emit `Set` literals).
- Collapsing 5 switches to a 3-line passthrough each; deleting pure-forwarder shim classes.
### Complex / Risky
- **Shim deletion partition**: `kanbanService`/`setupService` hold genuinely-extracted methods that webview arms call directly — deleting them breaks the webview. The grep-driven keep-list (Scope #3) is load-bearing; re-verify at implementation time, don't trust this plan's snapshot.
- **Read-verb contract**: confirming pushes actually reach a WS client for all 5 providers. Wiring is present; the *behavior* for Planning/Design/Setup is unexercised. Validate with a live WS subscription smoke test, not just compile.
- **Payload parity**: an arm that read a field off panel state rather than the message may need that field supplied in the HTTP payload. Spot-check the manager's core verbs (trigger/dispatch/move/create/reconcile/complete) end-to-end.
- **Destructive verbs are now first-class reachable** (`deleteFeature`, `abandonWorktree`, `completeAll`). Acceptable — they are management actions — but they ride the existing auth (`_checkAuth`) + localhost boundary; do not weaken it.

## Edge-Case & Dependency Audit
- **Race Conditions:** None new — the passthrough enters the exact `_handleMessage` path webview clicks take, in-process, same event loop. Concurrent HTTP verbs interleave exactly as concurrent webview messages do today.
- **Security:** Network payloads are untrusted where webview postMessage was trusted. Mitigations: localhost bind + `_checkAuth` token (existing), allowlist gate (unknown verbs rejected, never dynamically invoked), `type` set last in the spread (payload cannot override the checked verb), route layer independently strips body `type`. Arms' own input validation is the last line — payload-shape validation per verb remains owed (documented, Scope #6).
- **Side Effects:** Deleting `taskViewerService.ts`/`planningService.ts`/`designService.ts` removes their construction and context plumbing — grep for any other importer before deletion. Read verbs invoked over HTTP with no WS subscriber still execute their arm (may refresh caches, touch files) and return only the generic ack — expected, harmless, but callers should know the data went to the hub.
- **Dependencies & Conflicts:** The sibling subtask (`switchboard-manage-skill-ux-overhaul.md`) deletes the `guidedSetup` verb (webview case + handler). Ordering: **this plan lands first**; the UX plan then removes only the webview case + `_handleGuidedSetup` (the shim and dispatcher case will already be gone) and reruns `catalog:generate`, which now also regenerates the allowlist — keeping catalog, allowlist, and source in lockstep. Un-catalogued / dynamic verbs: 4 `manualReview` items in the catalog; if one is needed, add it to the catalog generator's output, not by hand-editing the allowlist.

## Dependencies
- A1 `protocol-catalog.json` (present — the verb source of truth).
- A2a `broadcastHub` + `wsHub` (present, wired on all 5 providers) for read delivery.
- **Unblocks** a genuinely complete `/switchboard-manage` with a *guaranteed* (not shim-maintained) surface; the "advance a plan to coding" verb (`promptOnDrop` / `triggerAction` → `dispatchConfiguredKanbanColumnAction`) is covered by the allowlist like every other verb.
- **Foundation for** `a2b-genuine-verb-extraction-burndown.md` (headless): that plan keeps this dispatcher and adds seam-injection to the arm bodies.

## Adversarial Synthesis
Key risks: (1) shim deletion breaking webview arms that call genuinely-extracted service methods — mitigated by the grep-driven keep-list re-verified at implementation time; (2) the rewritten parity gate degenerating into a tautology (allowlist ≡ catalog by construction) — mitigated by checking generation drift, dispatcher shape (no case labels), and a runtime smoke dispatch instead of self-referential set equality; (3) read verbs silently returning bare acks confusing HTTP clients — accepted per the User Review decision, documented in the dispatcher comment and skill docs.

## Proposed Changes
### scripts/generate-verb-allowlist.js (new)
- Read `protocol-catalog.json` `providers.<Name>.verbs[]`; emit `src/generated/verbAllowlist.ts` with 5 exported `Set<string>` literals and an AUTO-GENERATED header. Wire into `catalog:generate` (`package.json:828`).
### src/generated/verbAllowlist.ts (new, generated)
- 5 `Set` exports; checked in; drift-checked by the parity gate.
### src/services/KanbanProvider.ts, PlanningPanelProvider.ts, DesignPanelProvider.ts, SetupPanelProvider.ts, TaskViewerProvider.ts
- Replace each `handleServiceVerb` switch body with the allowlist-gated passthrough (Implementation Step 2 code). Keep the Kanban service-init guard (`KanbanProvider.ts:6500-6507`) for the retained genuine methods. Remove shim-only wiring (e.g. `setContext` plumbing for deleted classes).
### src/services/kanbanService.ts, setupService.ts
- Delete all string-keyed forwarder methods; keep genuine extractions per the keep-list. Update the stale A2b recipe header comment (it describes the superseded per-verb burndown).
### src/services/planningService.ts, designService.ts, taskViewerService.ts
- Delete files; remove imports/construction from their providers.
### scripts/check-protocol-parity.js
- Rewrite per Scope #5 (drift + shape + smoke; direction-split report).

## Verification Plan
*(Session directive: no compilation step and no automated test suite in this plan's verification; the coder runs the standard `npm run compile` gate before merge.)*
### Automated
- `npm run catalog:check` green; `verbAllowlist.ts` regenerates identically (drift check).
- Rewritten `npm run parity:check`: allowlist regenerates byte-identical; each dispatcher has the allowlist check and zero case labels; smoke dispatch per provider does not hit "Unknown verb"; request-response vs push split reported.
- `grep -rn "planningService\|designService\|taskViewerService" src/` returns no live references after deletion.
### Manual / behavioral (the real proof)
- With VS Code running: `POST /kanban/verb/triggerAction` (or `promptOnDrop`) with a real plan sessionId + target coding column → the coder terminal receives the prompt in the current workspace, no worktree. This is the UAT case that started this.
- `POST /kanban/verb/moveCard`-class and a few command verbs across Planning/Design/Setup → effect matches the equivalent webview click.
- A WS client subscribed to the hub receives a read verb's data (`getFeatureDetails` or `getKanbanStructure`) after `POST /<panel>/verb/<readVerb>` — proving the read contract for all 5 providers (Planning/Design/Setup especially — wired but previously unexercised).
- Webview regression spot-check: the retained genuine verbs (`selectPlan`, `refresh`, `saveSetting`, `saveStartupCommands`…) still work from the panel UI after shim deletion.

## Effort note
Single focused session for the 5 dispatchers + generator + shim deletion; a short second pass for the parity-gate rewrite and the behavioral WS smoke test. Materially cheaper than any per-verb approach because **each provider is touched once**, not once per verb — there is no 600-item grind and no shims to write-then-delete.

---
**Recommendation:** Complexity 5 → **Send to Coder**.
