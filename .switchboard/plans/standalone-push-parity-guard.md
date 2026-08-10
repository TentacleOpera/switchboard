# Standalone Push-Parity Guard — Make "Is the Browser Host at Parity?" a CI Number

## Metadata

**Complexity:** 6
**Tags:** infrastructure, test, devops, reliability
**Project:** Browser Switchboard

## Goal

Add `scripts/check-standalone-push-parity.js` (npm script `standalone-parity:check`, wired into `.github/workflows/integration-tests.yml`) that mechanically answers "can the standalone host actually deliver every message the shared board handles, and is any of its board payload fabricated?" — and fails when the answer is no. Replace repeated manual parity assessments, which have been wrong every time, with a ratcheted number that trends to zero.

### Problem analysis and root cause

Standalone migration has been declared complete several times and has not been complete. The failures were not random oversights; they share one structural cause, and a guard already exists that should be adjacent to catching it but sits on the wrong end of the pipe.

**Why manual audits kept passing.** `bootstrap.ts`'s `default:` arm delegates every unmatched verb to `kanbanProvider.handleServiceVerb` → `_handleMessage`. So in standalone **every verb is reachable and every DB write lands**. Auditing "is the verb wired?" or "does the write persist?" returns green for features that are entirely dead in the browser. The dead half is the **read-back path**.

**Why the existing guard passes.** `scripts/check-push-routing.js` is a ratchet asserting that providers push through the broadcast transport rather than calling `panel.webview.postMessage` directly — its header states the purpose as ensuring "external WS/browser clients get live updates instead of going stale." `KanbanProvider` sits at baseline 1, effectively compliant, and the check runs in CI (`integration-tests.yml:38`) and passes. It verifies that the provider correctly routes into the broadcaster **abstraction**; nothing in it verifies that any host **installs** one, or that the payload the host builds contains real values. The sending side's shape is guarded; the receiving side's existence and the payload's honesty are not.

**The second cause.** `pushFullState` (`bootstrap.ts:365-371`) and `getFullState` (`:394-400`) build the board payload from hardcoded literals — `routingConfig: {}`, `columns: DEFAULT_KANBAN_COLUMNS` (raw defaults, ignoring custom columns, visibility and order), `cliTriggersState { enabled: false }`, `theme: 'afterburner'`, and seven fabricated fields in `updateWorkspaceSelection` (`activeFilter`, `controlPlaneMode`, `controlPlaneRoot`, `effectiveControlPlaneRoot`, `explicitControlPlaneRoot`, `pendingCandidate`, `repoScopeFilter`, `projectContextEnabled`). Each silently disables its feature, and because the `default:` arm schedules a push after every non-read-only verb (coalesced at `PUSH_COALESCE_MS = 40`, `bootstrap.ts:420`), the literal is re-asserted ~40 ms after any user toggle. See `standalone-state-builders-delegate-to-getfullstatemessages.md`.

**Why the guard must use an AST, not regex.** Hand-written greps produced three wrong counts while scoping this work: a whole-file `case '...'` sweep of `kanban.html` returned 88 message types when the actual message-handler switch contains roughly 60; and a single-line `this.postMessage({ type: '...'` regex undercounted provider-emitted types because many are multi-line object literals, carry `as const`, or are **scoped-payload factories** — `this.postMessage((scope) => ({ type: 'updateBoard', … }))` (`KanbanProvider.ts:2025-2034`, `:2043-2046`) — where the object literal is a function return and no regex anchored on `postMessage({` will ever see it. A guard whose whole value is being more reliable than a human read cannot be built on the technique that produced the wrong reads. Parse with the `typescript` package's AST — `node --check` gives false negatives on `.ts`, so it is not an alternative.

**`typescript` must be added to `devDependencies` in the same change.** It resolves today (`typescript@5.9.3` at `node_modules/typescript`) but it is **not declared** in `package.json` — it is hoisted transitively. No existing script in `scripts/` requires it. A CI guard whose parser can disappear on an unrelated lockfile change is a guard that will one day fail-open or crash on a PR that has nothing to do with standalone parity. Declare it explicitly.

### Measured state — corrected 2026-08-07

> **Superseded:** The table below previously read: *Message types the board's handler switch handles: 59 · Types `bootstrap.ts` broadcasts as literals: 7 · Types reaching the browser via provider `postMessage`: **0 (no broadcaster installed)*** — with the conclusion that "the gap is dominated by the single missing bridge."
> **Reason:** The bridge is not missing. `bootstrap.ts:639` constructs `new BroadcastHub({ webview: null, apiServer: null })`, `:705` assigns it to the Kanban provider (and `:651`/`:656`/`:667`/`:683`/`:749` to the other five), and `:1660` calls `kanbanProvider.setApiServer(server)`, which forwards to `BroadcastHub.setApiServer` (`KanbanProvider.ts:7207`). Provider pushes reach `wsHub.broadcast` and, untagged, are delivered to every connection by design (`wsHub.ts:303-316`). The broadcaster wiring landed 2026-07-22 (`0f2e55d6`) — i.e. **before** this plan was written, and the hand-derived table was wrong on its most load-bearing row. The anchor line numbers were also stale by ~110 lines (`kanban.html`'s listener is at `:7577`, not `:7465`; its switch at `:7579`; the second listener at `:11443`, not `:11319`).
> **Replaced with:** The gap is dominated by the **fabricated payload**, not by a missing transport. That strengthens rather than weakens the case for this guard: a hand-built table of "what standalone can deliver" was wrong within three weeks of being written, in the direction of over-reporting the problem, while a *different* real defect in the same transport (the unbounded headless webview queue — see `restore-backlog-view-to-standalone-host.md`) went unnoticed by the same hand read. **This plan must not restate a hand-derived count as fact.** The guard's first job is to derive these numbers itself; whatever it reports on its first red run becomes the baseline.

| Quantity | Value |
|---|---|
| Message types the board's handler switch handles | **derive** — approximately 60 (`kanban.html:7579`+); the guard's own extraction is authoritative |
| Types `bootstrap.ts` broadcasts as literals | 5 (`updateColumns`, `updateWorkspaceSelection`, `cliTriggersState`, `switchboardThemeNameSetting`, `updateBoard`) plus `showStatusMessage` on the no-workspace path (`:350`) |
| Broadcaster installed for all six headless providers | **yes** — assert and lock, do not re-litigate |
| Hardcoded / fabricated board-payload fields | 11 across two builders (`columns`, `routingConfig`, `cliTriggersState.enabled`, `theme`, and 7 `updateWorkspaceSelection` fields), plus a wrong `workspaces` item shape (`{value,label}` where the board reads `item.workspaceRoot`) |

## User Review Required

None.

## Complexity Audit

### Routine
- New script following the established shape of `check-push-routing.js` / `check-protocol-parity.js`.
- npm script registration beside the existing `parity:check` family (`package.json:847-850`).
- CI step in `integration-tests.yml` beside the other guards (`:35`, `:38`, `:41`).

### Complex / Risky
- **Anchoring the webview extraction.** The board handler must be located structurally — the `window.addEventListener('message', …)` at `kanban.html:7577` and its `switch (msg.type)` at `:7579` — not by sweeping the file for `case` labels. `kanban.html` contains many unrelated switches; a file-wide sweep over-reports by ~50%. There is a **second** message listener at `:11443`; decide explicitly whether it is in scope and record the decision, rather than silently capturing or missing it. **Anchor on structure, not on line numbers** — the numbers in this plan were already stale once.
- **Parsing an inline script out of HTML.** `kanban.html` is not parseable as TypeScript. Extract the `<script>` body first, then parse. A brittle extraction that silently yields zero cases makes the guard pass vacuously — the worst outcome, since it re-creates the false-green this plan exists to end. Assert a non-zero floor on every extracted set.
- **Establishing set B correctly.** "Types standalone can deliver" = literal broadcasts in `bootstrap.ts` ∪ provider `postMessage` types, conditional on a broadcaster being installed. That condition now **passes**, so the assertion's role changes from "find the missing bridge" to "lock the bridge in place": it must fail loudly if a future refactor drops the assignment at `bootstrap.ts:705` or the `setApiServer` call at `:1660`. A guard that only ever reports known-bad states is not a ratchet.
- **Collecting factory-form pushes.** `this.postMessage((scope) => ({ type: 'x', … }))` is the extension's standard shape for scope-dependent state. The AST walk must follow arrow-function bodies and parenthesised object expressions, or set B silently under-counts and the guard over-reports the gap — the failure mode of the original hand count, reproduced in code.
- **From field-literal detection to a delegation assertion.** The straightforward check — "fail if a named payload field's AST value is a literal (`false`, `{}`, `null`, a bare identifier)" — is a per-field ratchet with a maintained list, and every entry is a line the guard's author has to keep in sync with `bootstrap.ts`. Once `standalone-state-builders-delegate-to-getfullstatemessages.md` lands, a strictly stronger and much cheaper invariant is available: **`bootstrap.ts`'s state builders must not hand-construct board payload entries at all — they must derive from `kanbanProvider.getFullStateMessages(...)`**, with a short allowlist of deliberate host-specific overrides. Ship the field ratchet now (it must go red today, which is the acceptance criterion) and add the delegation assertion as the ratchet's floor. Structure the script so the field list is data, not control flow, so the swap is a deletion.
- **Ratchet semantics, not a zero-check.** Today's gap is large and the fixes land across two plans. Following `check-push-routing.js`'s convention (`scripts/check-push-routing.js:13-17` — "Baselines must never be raised — they should only ever be lowered"), the guard ships with a baseline capturing today's true gap so CI is green, and the baseline may only ever be **lowered**. A guard that goes red on landing gets disabled within a day.
- **Allowlist discipline.** Some types are legitimately extension-only (editor-panel focus and reveal), and two payload fields are legitimately host-specific (`dispatchAnalyzeAvailable`, gated on `ptyReady` rather than the provider's unconditional `true`; the deliberate `'afterburner'` theme fallback). Each belongs in an allowlist with a one-line justification, so the residual is a reviewed list rather than an unknown. An allowlist without required reasons degrades into a dumping ground.

## Edge-Case & Dependency Audit

**Race Conditions** — none; static analysis at build time.

**Security** — no runtime surface. Reads repo sources only.

**Side Effects**
- Adds a CI step that can block merges. Intended. Baseline sizing must be right on landing or the first unrelated PR is blocked by an unrelated failure.
- The guard reports on the shared board today. If it is later pointed at other shared panels (planning, tickets, design), scope that as separate work — those panels have their own providers and listeners. Note that untagged provider pushes already reach every subscribed surface (`wsHub.ts:303-316`), so "which panel handles what" is not inferable from the surface tag alone.

**Dependencies & Conflicts**
- Complements `check-push-routing.js`; does not replace it. Both should run.
- No code conflict with the two sibling plans, but see sequencing.

## Dependencies

- **None (hard).** This plan should land **first**, so `standalone-state-builders-delegate-to-getfullstatemessages.md` and `restore-backlog-view-to-standalone-host.md` are each verified by lowering a baseline rather than by another manual assessment. Sequencing recommendation only — no code dependency.

## Adversarial Synthesis

**Risk Summary.** The dominant risk is a guard that passes vacuously — a broken HTML script extraction yielding zero cases, or an AST walk that misses the factory-form and multi-line `postMessage` shapes — because a green vacuous guard is strictly worse than no guard: it converts an unknown into a false assurance, which is the precise failure this plan exists to end. The second risk is a baseline mis-sized on landing, which blocks an unrelated PR and gets the check disabled within a day. Mitigations: assert a non-zero floor on every extracted set; fixture-test each failure mode including the extraction break; demonstrate the red run at zero baselines before recording the real numbers.

## Implementation

### 1. The guard script

**File:** `scripts/check-standalone-push-parity.js` (new)

Follow the structure and tone of `scripts/check-push-routing.js` — a self-describing header, explicit baselines, a "never raise" comment, clear pass/fail output.

**Set A — types the shared board handles.**
- Read `src/webview/kanban.html`; extract the inline script body.
- Parse with the `typescript` package (`ts.createSourceFile`, script kind JS).
- Walk to the `window.addEventListener('message', …)` callback (structurally located; currently `kanban.html:7577`), find its `switch` on `msg.type`, and collect string-literal `case` clause values.
- Assert the set is non-empty and at least a floor value; a zero or near-zero result means extraction broke and must fail the run, not pass it.

**Set B — types standalone can deliver.**
- Literal broadcasts: AST-collect `type:` string literals in the state arrays fed to `server.broadcastWs` in `bootstrap.ts` (`:365-374`, `:394-400`), plus direct `server.broadcastWs('<type>', …)` call sites elsewhere in the file.
- Provider-emitted: AST-collect the `type` property of object literals passed to `postMessage(...)` across `src/services/KanbanProvider.ts` and `src/services/TaskViewerProvider.ts`, handling multi-line literals, `as const`, and **arrow-function factory arguments** whose body is a parenthesised object expression.
- Include the provider-emitted set only if the broadcaster-installation assertion below passes.

**Assertion — broadcaster installed (currently PASSES; lock it).**
- Verify `bootstrap.ts` constructs a `BroadcastHub` and assigns it to each provider it constructs (`:639`, `:651`, `:656`, `:667`, `:683`, `:705`, `:749`), and that the API server is attached (`setApiServer` at `:1656-1660`) so the hub's WS fan-out has a target. If any of it is absent, report it as the single highest-severity finding and treat the provider-emitted set as undeliverable.

**Assertion — no hardcoded view state in the board payload.**
- For a named, data-driven list of state-array fields that must reflect live state — `columns`, `routingConfig`, `cliTriggersState.enabled`, `theme`, `activeFilter`, `controlPlaneMode`, `controlPlaneRoot`, `effectiveControlPlaneRoot`, `explicitControlPlaneRoot`, `pendingCandidate`, `repoScopeFilter`, `projectContextEnabled` — fail if the AST value is a literal (`false`, `{}`, `null`, a bare identifier for raw defaults) rather than a call or property access. Ratcheted with a baseline count. Keep the list as data so it can be deleted wholesale when the delegation assertion replaces it.

**Assertion — state builders delegate (the ratchet's floor).**
- Assert that `pushFullState` and `getFullState` obtain their message list from `kanbanProvider.getFullStateMessages(...)` rather than constructing entries inline, allowing only allowlisted host-specific overrides. This is the invariant that makes the field list unnecessary; it is expected to go green when `standalone-state-builders-delegate-to-getfullstatemessages.md` lands.

**Output.**
- Print set sizes, the sorted `A \ B` difference, and each allowlisted exemption with its reason. Fail when the difference exceeds the baseline or when any assertion regresses.

### 2. Allowlist with mandatory reasons

**File:** `scripts/standalone-parity-allowlist.json` (new)

`{ "<messageType or payloadField>": "<why this is legitimately extension-only or host-specific>" }`. The guard fails on an entry with an empty reason, so the file cannot silently absorb real gaps. Seed it with the two known-deliberate payload overrides: `dispatchAnalyzeAvailable` (standalone gates on `ptyReady`; the provider hardcodes `true`) and the theme's explicit `'afterburner'` fallback.

### 3. Registration

**File:** `package.json`
- Add `"standalone-parity:check": "node scripts/check-standalone-push-parity.js"` beside the existing guards (`:847-850`).
- Add `typescript` to `devDependencies` (currently undeclared and resolved only transitively — see the AST rationale above).

**File:** `.github/workflows/integration-tests.yml`
- Add a step running it, adjacent to the `push-routing:check` step (`:38`), so the two related guards fail together and read together.

## Proposed Changes

### `scripts/check-standalone-push-parity.js` (new)
- **Logic:** AST-derive set A (board handler cases) and set B (standalone-deliverable types); assert broadcaster installation, non-literal view-state fields, and (as the floor) state-builder delegation; ratchet on baselines.
- **Edge Cases:** Extraction must fail loudly rather than yield an empty set; factory-form `postMessage` arguments must be collected; the second listener at `kanban.html:11443` needs an explicit in/out decision; anchors must be structural, since every line number in this plan has already drifted once.

### `scripts/standalone-parity-allowlist.json` (new)
- **Logic:** Reviewed exemptions with mandatory justifications, covering both message types and deliberately host-specific payload fields.

### `package.json` / `.github/workflows/integration-tests.yml`
- **Logic:** Register and run the guard beside the existing parity family; declare `typescript` in `devDependencies`.
- **Edge Cases:** Baseline must match today's true gap on landing so CI is green from the first commit. Without the explicit `typescript` dependency the guard's parser is a transitive hoist and can vanish on an unrelated lockfile change.

## Verification Plan

This session skips compilation and automated test execution; the checks below are specified for the implementing change, not run here.

### The acceptance criterion that matters
**The guard must FAIL when run against the current tree with baselines set to zero**, and its report must name the fabricated payload fields explicitly. A parity guard that passes on known-broken code is worthless — this is precisely the failure mode of the existing `push-routing` check for this class of bug. Demonstrate the red run, record the true gap as the baseline, then confirm green.

> **Superseded:** "…its report names `showingBacklog` and the missing broadcaster explicitly."
> **Reason:** Both are now closed — `showingBacklog` reads the live provider getter (`bootstrap.ts:370`, `:399`) and the broadcaster is installed (`:639`, `:705`, `:1660`). A guard demanded to name them would have to be written to fail on already-fixed code.
> **Replaced with:** The red run must name the still-fabricated fields — `columns`, `routingConfig`, `cliTriggersState.enabled`, `theme`, and the seven `updateWorkspaceSelection` fields — and must report the broadcaster assertion as **passing**, proving the guard distinguishes a fixed sub-problem from an open one rather than reporting a blanket failure.

### Automated
1. Zero-baseline run on current `HEAD` → fails, naming the fabricated payload fields; the broadcaster assertion reports pass.
2. Baselined run on current `HEAD` → passes.
3. Fixture: a board handler case with no possible sender → guard fails.
4. Fixture: an allowlist entry with an empty reason → guard fails.
5. Fixture: broken HTML script extraction yielding zero cases → guard fails (does not pass vacuously).
6. Fixture: broadcaster assignment removed from `bootstrap.ts` → guard fails.
7. AST-vs-regex regression: a multi-line `postMessage({\n type: 'x' as const, … })` **and** a factory `postMessage((scope) => ({ type: 'y', … }))` are both collected — the exact shapes hand-greps missed.

### Manual
8. Land `standalone-state-builders-delegate-to-getfullstatemessages.md` on a branch and confirm the hardcoded-field baseline can be **lowered to its floor** — the guard measures real progress rather than staying constant.
9. Confirm the CI step's failure output is actionable on its own: a reader who has never seen this plan can tell what is missing and where.

## Recommendation

Complexity 6 → **Send to Lead Coder.** The script is not large, but it must be AST-based (including factory-form pushes), must fail correctly on today's tree while reporting the already-fixed broadcaster as green, must not pass vacuously, and it is the artefact every subsequent standalone plan will be judged by. Raised from 5: the corrected measured state shows the guard must distinguish fixed from open sub-problems rather than report a single blanket gap, and the delegation assertion is a second, structurally different check.

## Completion Summary

Implemented `scripts/check-standalone-push-parity.js` — an AST-based ratchet guard using the `typescript` package. Set A (61 board handler types) is extracted structurally from `kanban.html`'s `switch (msg.type)` and the second listener's `if/else-if` chain. Set B (116 standalone-deliverable types) combines bootstrap.ts literal broadcasts, KanbanProvider/TaskViewerProvider `postMessage` types (including factory-form `(scope) => ({ type: '...' })`), and `getFullStateMessages` return-array types. Three assertions: broadcaster installation (passes, locked), message-type gap (ratcheted at 13), and hardcoded view-state fields (ratcheted at 0 after delegation). The guard fails at zero baselines (acceptance criterion met), reports the broadcaster as green, and names fabricated fields explicitly. Added `typescript@^5.9.3` to devDependencies, registered `standalone-parity:check` in package.json, and wired the CI step in `integration-tests.yml`. Files changed: `scripts/check-standalone-push-parity.js` (new), `scripts/standalone-parity-allowlist.json` (new), `package.json`, `.github/workflows/integration-tests.yml`.

## Review Findings

Two MAJOR defects fixed in the guard itself. (1) Set B under-counted through three emission shapes — `this.postMessage(msgVariable)`, cross-provider pushes (`this._kanbanProvider.postMessage`, `broadcastToWebviews`), and four sibling providers sharing the same headless hub that were never scanned — so the reported 13-type gap was almost entirely phantom, reproducing in code the same over-report the hand greps produced. Fixed by variable-binding resolution, a push-method name set, and scanning all six headless providers; the true residual is 6, each now an allowlisted entry with a stated reason (5 delivered by verb return body, 1 — `liveSyncUpdate` — genuinely extension-only), so `BASELINE_MESSAGE_TYPE_GAP` was lowered 13 → 0. (2) The broadcaster assertion was a one-of-six presence regex that stayed green with four assignments deleted; it now counts all five direct assignments, asserts the TaskViewer `initHeadlessVerbServing` hand-off, and asserts the `headless: true` declaration. Validation: `standalone-parity:check` green (gap 0/0, hardcoded fields 0/0, delegation detected) and demonstrated red on a seeded regression; `push-routing:check` unaffected. Remaining risk: verb-return-body types are allowlisted rather than mechanically derived, so a type that loses its verb would be missed.
