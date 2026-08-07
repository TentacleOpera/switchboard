# Standalone Push-Parity Guard — Make "Is the Browser Host at Parity?" a CI Number

## Metadata

**Complexity:** 5
**Tags:** infrastructure, testing, ci, standalone, parity
**Project:** Browser Switchboard

## Goal

Add `scripts/check-standalone-push-parity.js` (npm script `standalone-parity:check`, wired into `.github/workflows/integration-tests.yml`) that mechanically answers "can the standalone host actually deliver every message the shared board handles?" — and fails when it cannot. Replace repeated manual parity assessments, which have been wrong every time, with a ratcheted number that trends to zero.

### Problem analysis and root cause

Standalone migration has been declared complete several times and has not been complete. The failures were not random oversights; they share one structural cause, and a guard already exists that should be adjacent to catching it but sits on the wrong end of the pipe.

**Why manual audits kept passing.** `bootstrap.ts`'s `default:` arm (`src/standalone/bootstrap.ts:1062-1087`) delegates every unmatched verb to `kanbanProvider.handleServiceVerb` → `_handleMessage` (`src/services/KanbanProvider.ts:7261-7291`). So in standalone **every verb is reachable and every DB write lands**. Auditing "is the verb wired?" or "does the write persist?" returns green for features that are entirely dead in the browser. The dead half is the **read-back path**.

**Why the existing guard passes.** `scripts/check-push-routing.js` is a ratchet asserting that providers push through the broadcast transport rather than calling `panel.webview.postMessage` directly — its header states the purpose as ensuring "external WS/browser clients get live updates instead of going stale." `KanbanProvider` sits at baseline 1, effectively compliant, and the check runs in CI (`integration-tests.yml:38`) and passes.

It passes because it verifies the provider correctly routes into the broadcaster **abstraction**. Nothing verifies that any host **installs** one. `KanbanProvider.postMessage` (`:2105-2120`) delivers to `this._broadcaster` or `this._panel`; `bootstrap.ts` sets neither. Every correctly-routed push in standalone falls off the end of a compliant call into nothing. The sending side's shape is guarded; the receiving side's existence is not.

**The second cause.** `pushFullState` (`bootstrap.ts:345`) and `getFullState` (`:374`) build the `updateBoard` payload from hardcoded literals — `showingBacklog: false`, `routingConfig: {}`, `columns: DEFAULT_KANBAN_COLUMNS` (raw defaults, ignoring custom columns, visibility and order), plus `cliTriggersState {enabled:false}`, `theme:'afterburner'`, `repoScopeFilter: null`, `projectContextEnabled: false` in sibling entries. Each silently disables its feature, and because the `default:` arm schedules a push after every non-read-only verb (`:1078`, coalesced at `PUSH_COALESCE_MS = 40`, `:395`), the literal is re-asserted ~40 ms after any user toggle.

**Why the guard must use an AST, not regex.** Hand-written greps produced three wrong counts while scoping this work: a whole-file `case '...'` sweep of `kanban.html` returned 88 message types when the actual message-handler switch (`kanban.html:7465-8467`) contains **59**; and a single-line `this.postMessage({ type: '...'` regex undercounted provider-emitted types because many are multi-line object literals or carry `as const` (e.g. `KanbanProvider.ts:2046`, `:2068`, `:2815`, `:11117`). A guard whose whole value is being more reliable than a human read cannot be built on the technique that produced the wrong reads. Parse with the `typescript` package's AST (established precedent — `node --check` gives false negatives on `.ts`).

### Measured state at time of writing

| Quantity | Value |
|---|---|
| Message types the board's handler switch handles | 59 |
| Types `bootstrap.ts` broadcasts as literals | 7 |
| Types reaching the browser via provider `postMessage` | 0 (no broadcaster installed) |

The gap is dominated by the single missing bridge, not by dozens of unimplemented features — which is why a guard is worth more than another audit: it converts "unknown residual" into a listed, reviewed number.

## User Review Required

None.

## Complexity Audit

### Routine
- New script following the established shape of `check-push-routing.js` / `check-protocol-parity.js`.
- npm script registration beside the existing `parity:check` family (`package.json:846-851`).
- CI step in `integration-tests.yml` beside the other guards.

### Complex / Risky
- **Anchoring the webview extraction.** The board handler must be located structurally — the `window.addEventListener('message', ...)` at `kanban.html:7465` and its `switch (msg.type)` at `:7467` — not by sweeping the file for `case` labels. `kanban.html` contains many unrelated switches; a file-wide sweep over-reports by ~50%. There is a **second** message listener at `:11319`; decide explicitly whether it is in scope and record the decision, rather than silently capturing or missing it.
- **Parsing an inline script out of HTML.** `kanban.html` is not parseable as TypeScript. Extract the `<script>` body first, then parse. A brittle extraction that silently yields zero cases makes the guard pass vacuously — the worst outcome, since it re-creates the false-green this plan exists to end. Assert a non-zero floor on every extracted set.
- **Establishing set B correctly.** "Types standalone can deliver" = literal broadcasts in `bootstrap.ts` ∪ provider `postMessage` types **conditional on a broadcaster being installed**. The conditional is the crux: without asserting installation, the guard silently credits standalone with 38+ types it cannot actually send. This assertion must be explicit and must fail loudly if a future refactor drops the bridge.
- **Ratchet semantics, not a zero-check.** Today's gap is large and the fixes land across several plans. Following `check-push-routing.js`'s convention, the guard ships with a baseline capturing today's true gap so CI is green, and the baseline may only ever be **lowered**. A guard that goes red on landing gets disabled within a day.
- **Allowlist discipline.** Some types are legitimately extension-only (editor-panel focus and reveal). Each belongs in an allowlist with a one-line justification, so the residual is a reviewed list rather than an unknown. An allowlist without required reasons degrades into a dumping ground.

## Edge-Case & Dependency Audit

**Race Conditions** — none; static analysis at build time.

**Security** — no runtime surface. Reads repo sources only.

**Side Effects**
- Adds a CI step that can block merges. Intended. Baseline sizing must be right on landing or the first unrelated PR is blocked by an unrelated failure.
- The guard reports on the shared board today. If it is later pointed at other shared panels (planning, tickets, design), scope that as separate work — those panels have their own providers and listeners.

**Dependencies & Conflicts**
- Complements `check-push-routing.js`; does not replace it. Both should run.
- No conflict with `restore-backlog-view-to-standalone-host.md`, but see sequencing.

## Dependencies

- **None (hard).** This plan should land **first**, so `restore-backlog-view-to-standalone-host.md` and the sibling hardcoded-literal plans are each verified by lowering a baseline rather than by another manual assessment. Sequencing recommendation only — no code dependency.

## Implementation

### 1. The guard script

**File:** `scripts/check-standalone-push-parity.js` (new)

Follow the structure and tone of `scripts/check-push-routing.js` — a self-describing header, explicit baselines, "never raise" comment, clear pass/fail output.

**Set A — types the shared board handles.**
- Read `src/webview/kanban.html`; extract the inline script body.
- Parse with the `typescript` package (`ts.createSourceFile`, script kind JS).
- Walk to the `window.addEventListener('message', …)` callback at `kanban.html:7465`, find its `switch` on `msg.type`, and collect string-literal `case` clause values.
- Assert the set is non-empty and at least a floor value; a zero or near-zero result means extraction broke and must fail the run, not pass it.

**Set B — types standalone can deliver.**
- Literal broadcasts: AST-collect `type:` string literals in the state arrays fed to `server.broadcastWs` in `bootstrap.ts` (`:340-346`, `:369-375`).
- Provider-emitted: AST-collect the `type` property of object literals passed to `postMessage(...)` across `src/services/KanbanProvider.ts` and `src/services/TaskViewerProvider.ts`, handling multi-line literals and `as const` (`KanbanProvider.ts:2046`, `:2068`, `:2815`, `:11117` are representative shapes that a naive regex misses).
- **Include the provider-emitted set only if** the broadcaster-installation assertion below passes.

**Assertion — broadcaster installed.**
- Verify `bootstrap.ts` assigns a broadcaster to each provider it constructs (the sink `KanbanProvider.postMessage` requires at `:2106`). If absent, report it as the single highest-severity finding and treat the provider-emitted set as undeliverable.

**Assertion — no hardcoded view state in the board payload.**
- For a named list of `updateBoard` / state-array fields that must reflect live state — `showingBacklog`, `routingConfig`, `columns`, `cliTriggersState.enabled`, `theme`, `repoScopeFilter`, `projectContextEnabled` — fail if the AST value is a literal (`false`, `{}`, `null`, a bare identifier for raw defaults) rather than a call or property access. Ratcheted with a baseline count.

**Output.**
- Print set sizes, the sorted `A \ B` difference, and each allowlisted exemption with its reason. Fail when the difference exceeds the baseline or when either assertion regresses.

### 2. Allowlist with mandatory reasons

**File:** `scripts/standalone-parity-allowlist.json` (new)

`{ "<messageType>": "<why this is legitimately extension-only>" }`. The guard fails on an entry with an empty reason, so the file cannot silently absorb real gaps.

### 3. Registration

**File:** `package.json`
- Add `"standalone-parity:check": "node scripts/check-standalone-push-parity.js"` beside the existing guards (`:846-851`).

**File:** `.github/workflows/integration-tests.yml`
- Add a step running it, adjacent to the `push-routing:check` step (`:38`), so the two related guards fail together and read together.

## Proposed Changes

### `scripts/check-standalone-push-parity.js` (new)
- **Logic:** AST-derive set A (board handler cases) and set B (standalone-deliverable types); assert broadcaster installation and non-literal view-state fields; ratchet on baselines.
- **Edge Cases:** Extraction must fail loudly rather than yield an empty set; the second listener at `kanban.html:11319` needs an explicit in/out decision.

### `scripts/standalone-parity-allowlist.json` (new)
- **Logic:** Reviewed exemptions with mandatory justifications.

### `package.json` / `.github/workflows/integration-tests.yml`
- **Logic:** Register and run the guard beside the existing parity family.
- **Edge Cases:** Baseline must match today's true gap on landing so CI is green from the first commit.

## Verification Plan

### The acceptance criterion that matters
**The guard must FAIL when run against the current tree with baselines set to zero.** A parity guard that passes on known-broken code is worthless — this is precisely the failure mode of the existing `push-routing` check for this class of bug. Demonstrate the red run, record the true gap as the baseline, then confirm green.

### Automated
1. Zero-baseline run on current `HEAD` → fails, and its report names `showingBacklog` and the missing broadcaster explicitly.
2. Baselined run on current `HEAD` → passes.
3. Fixture test: a board handler case with no possible sender → guard fails.
4. Fixture test: an allowlist entry with an empty reason → guard fails.
5. Fixture test: broken HTML script extraction yielding zero cases → guard fails (does not pass vacuously).
6. Fixture test: broadcaster assignment removed from `bootstrap.ts` → guard fails.
7. AST-vs-regex regression: a multi-line `postMessage({\n type: 'x' as const, …})` is collected — the exact shape hand-greps missed.

### Manual
8. Land `restore-backlog-view-to-standalone-host.md` on a branch and confirm the baseline can be **lowered** — the guard measures real progress rather than staying constant.
9. Confirm the CI step's failure output is actionable on its own: a reader who has never seen this plan can tell what is missing and where.

## Recommendation

Complexity 5 → **Send to Lead Coder.** The script is not large, but it must be AST-based, must fail correctly on today's tree, and must not pass vacuously — and it is the artefact every subsequent standalone plan will be judged by.
