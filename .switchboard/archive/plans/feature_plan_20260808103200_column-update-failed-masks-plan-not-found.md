# "Column update failed" Is Returned When the Card Was Never Found, Making an Addressing Miss Read as a Refused Transition

## Goal

Make the kanban move path distinguish *"no such card in this workspace"* from *"the card was found and the write failed"*, so a caller — human or agent — can tell an addressing mistake from a real failure without reading the source.

### Problem

Every non-success outcome of a card move collapses into one string:

```ts
return { success: moved, error: moved ? undefined : 'Column update failed' };
```
— `TaskViewerProvider.ts:2190` (and the same literal at `PlanningPanelProvider.ts:3727`)

`moveCardToColumn` returns a bare `boolean`, so by the time the message is composed the reason is already gone. The message asserts that an update was attempted and failed. In the most common failure it was never attempted at all: `updateColumn` returns `false` immediately when `getPlanBySessionId` finds nothing (`KanbanDatabase.ts:2486-2488`).

The practical cost, observed 2026-08-08: a move from `CODE REVIEWED` to `PLAN REVIEWED` returned `Column update failed`, which read as a deliberate backwards-transition block. It took tracing five call sites across three files to establish that **no transition guard exists anywhere in the path** and the real cause was a wrong-workspace lookup. A caller acting on the literal message would conclude the board enforces a policy it does not have — and would work around a rule that isn't there.

### Root cause

The return type is a boolean, so every distinguishable failure is flattened at the point it occurs and reconstructed as a guess at the point it is reported. There are at least four distinct outcomes behind that one `false`:

1. Plan not found for the supplied key in the resolved workspace (`updateColumn`, `KanbanDatabase.ts:2486-2488`).
2. Invalid column name, already logged server-side but not surfaced (`updateColumnByPlanFile`, `KanbanDatabase.ts:2453-2456`).
3. The UPDATE matched no rows — plan addressed by `plan_file` + `workspace_id` that did not match the WHERE clause (`KanbanDatabase.ts:2459-2462`).
4. An exception, caught and logged, returning `false` (`moveCardToColumn`, `KanbanProvider.ts:6967-6970`).

> **Superseded:** *(line references throughout the original draft)* `TaskViewerProvider.ts:2188`; `moveCardToColumn` at `:6911` / `:2955-2958`; `moveCardToColumnByPlanFile` at `:6974`; provider call sites at `KanbanProvider.ts:5672`, `:5715`, `:6017`.
> **Reason:** The file has drifted since the draft was written; every one of those anchors is now off by 2–14 lines, and the case-4 anchor named the wrong file entirely (`:2955-2958` is inside `KanbanDatabase.ts`, not `KanbanProvider.ts`).
> **Replaced with:** Verified anchors at HEAD — `TaskViewerProvider.ts:2190`; `KanbanProvider.moveCardToColumn` at `:6923` with its `catch` at `:6967-6970`; `KanbanProvider.moveCardToColumnByPlanFile` at `:6986` with its `catch` at `:7036-7039`; provider call sites at `KanbanProvider.ts:5684`, `:5727`, `:6029`, plus `:2711`, `:3034`, `:3117`.

> **Superseded:** "Case 3 is worth calling out: the row carries `needs_path_fix = 1`, so a `plan_file` normalisation mismatch between the stored value and `_ensureRelativePlanFile` is a live possibility on this data, and today it would be indistinguishable from case 1."
> **Reason:** Case 3 is **not** indistinguishable from case 1 — it is invisible, which is worse. `updateColumnByPlanFile` delegates the write to `_persistedUpdate` (`KanbanDatabase.ts:9242-9251`), which returns `this._persist()`. `_persist()` (`:9154-9174`) returns `true` unconditionally whenever `this._db` exists; **nothing in that path inspects rows-modified**. A zero-row `UPDATE ... WHERE plan_file = ? AND workspace_id = ?` therefore returns `true`, `_fireColumnChanged` fires, the caller reports success, and the card silently snaps back on the next board refresh. The `VERIFY` block at `:2464-2477` logs `NOT FOUND in DB` *while the function returns true* — that log is the fossil of exactly this defect.
> **Replaced with:** Case 3 is a **false success**, not a `false`. It cannot be reported as a distinct reason until `updateColumnByPlanFile` actually checks rows-modified. The `needs_path_fix = 1` observation stands and is the natural repro candidate: a stored `plan_file` that does not match `_ensureRelativePlanFile`'s output produces a zero-row UPDATE that today reports success. This makes the rows-modified check a **prerequisite** of the plan, not an optional extra — a `no_rows_matched` reason threaded through an unchanged `_persistedUpdate` would be dead code.

The `VERIFY` logging already added at `KanbanDatabase.ts:2464-2477` exists because someone previously needed exactly this information and could only get it from a console. That is the tell: the diagnostic was bolted onto the log because the return channel could not carry it.

### Root cause, second half — the reason has nowhere to land

Widening the DB return type is only half the path. Three of the four reporting surfaces cannot carry a reason today for reasons independent of `moveCardToColumn`'s signature:

- **`POST /planning/verb/moveKanbanPlanColumn` returns HTTP 200 `{success:true}` for a failed move.** The arm at `PlanningPanelProvider.ts:3715-3732` posts its result to the webview and `break`s — it returns nothing. `handleServiceVerb` returns `await this._handleMessage(...)` (`:153`), so the verb resolves to `undefined`, and `LocalApiServer._handlePlanningVerb` maps that to `ok = true` → `200 {success:true}` (`:1830-1832`). An agent driving the board over HTTP is told the move succeeded when it did not. This is a harder failure than a misleading string, and editing the `postMessage` literal does not touch it.
- **The board's own drag-and-drop failure message is a different hardcoded literal.** `KanbanProvider` posts `moveCardsFailed` with `reason: "couldn't save — board may be out of sync"` at ten sites (`:5691`, `:5733`, `:8193`, `:8411`, `:8904`, `:8970`, `:8996`, `:9138`, and the surrounding batch loops). The kanban webview renders `failed[0]?.reason` verbatim in the status bar (`src/webview/kanban.html:7878`). This is the surface a human hits most often, and it is not one of the two literals the original draft names.
- **The webview path crosses a VS Code command boundary that is typed `boolean`.** `PlanningPanelProvider.ts:3724-3726` calls `this._seams().commands.executeCommand<boolean>('switchboard.moveKanbanCardByPlanFile', …)`, registered at `extension.ts:1715-1721`. Any reason object has to cross that boundary too.

## Metadata

- **Complexity:** 5
- **Tags:** backend, database, api, bugfix, reliability

> **Superseded:** `**Complexity:** 3` and `**Tags:** backend, kanban, api, diagnostics, bugfix`.
> **Reason:** (a) `kanban` and `diagnostics` are not in the permitted tag vocabulary and are silently dropped on import. (b) 3 assumed a single-file thread-a-string change. The verified work spans six files (`KanbanDatabase.ts`, `KanbanProvider.ts`, `TaskViewerProvider.ts`, `PlanningPanelProvider.ts`, `extension.ts`, `scripts/verb-return-contract-baseline.json`), includes one deliberate behaviour change (zero-row updates stop reporting success), touches ten `moveCardsFailed` literal sites, and must not trip three source-text regex tests that pin the current call shape.
> **Replaced with:** Complexity 5 (Mixed — majority routine, with two well-scoped risks: the zero-row behaviour change and the caller-truthiness blast radius). Tags drawn only from the permitted list.

## User Review Required

None.

## Complexity Audit

### Routine

- Adding a `…WithReason` sibling to two DB methods and two provider methods, with the existing boolean methods delegating to them.
- Replacing two hardcoded error literals with a propagated `detail` string.
- Reusing the rows-modified pattern that already exists in the same file (`updateFeatureStatus`, `KanbanDatabase.ts:2546-2562`).

### Complex / Risky

- **A result object under a truthiness check is a silent false success.** `moveCardToColumn` is consumed as `const ok = await …; if (ok)` (`KanbanProvider.ts:5684`, `:5727`), as `!!moved` (`PlanningPanelProvider.ts:3727`), as `success: moved` (`TaskViewerProvider.ts:2190`), and as `ok = await …; if (!ok)` in `ScheduledJobsService.ts:243-249`. `{ ok: false, reason: 'not_found' }` is **truthy**. TypeScript does not flag `if (obj)`, and `ScheduledJobsService` reaches the provider through an untyped duck-typed handle. Changing the existing methods' return type in place converts every current failure report into a success report across the whole board. This is the single highest-consequence decision in the plan and it is settled below in **Proposed Changes** — do not re-open it at implementation time.
- **Three tests pin the current call shape as source text.** `src/test/kanban-drag-confirm-before-dispatch.test.js:82` asserts `/const ok = await this\.moveCardToColumn\(/` against the `triggerAction` arm; `src/test/kanban-subtask-column-leak-regression.test.js:75,79` assert `.includes('moveCardToColumn(')`; `src/test/review-column-persistence-regression.test.js:35` asserts a block does **not** contain `await db.updateColumn(sessionId, column);`. Renaming or re-shaping the existing call sites breaks these. Keeping the boolean methods and their call sites textually intact is a hard constraint, not a preference.
- **The zero-row fix is a real behaviour change and must be stated as one.** After the fix, a move whose WHERE clause matches nothing reports failure instead of success, and `_fireColumnChanged` no longer fires for it. Both are corrections, but both will look like new failures in the field.
- **Do not leak internal detail into an API response.** The reason should name the failure class and the workspace, not SQL text or file-system paths beyond the plan file already supplied by the caller.
- **Four surfaces, not two.** `TaskViewerProvider.ts:2190` (HTTP `/kanban/move`), `PlanningPanelProvider.ts:3727` (webview message), `POST /planning/verb/moveKanbanPlanColumn` (HTTP, currently a false success), and the ten `moveCardsFailed` `reason` literals in `KanbanProvider.ts` (the board status bar). Fixing a subset reproduces the confusion in whichever surface was skipped.

> **Superseded:** "**`moveCardToColumn` has many callers and most only want the boolean.** … Prefer a shape that keeps truthiness usable, or add a parallel `…WithReason` entry point and migrate the reporting call sites only — decide once and apply it consistently rather than half-migrating."
> **Reason:** The instruction to "decide once" was correct but the decision was never made, which leaves the most dangerous choice in the plan open at implementation time. It also understates the failure mode: the bad option does not produce a compile error, it produces silent false successes.
> **Replaced with:** The decision is made — **parallel `…WithReason` entry points; existing boolean signatures and their call sites are untouched.** Rationale and the rejected alternatives are recorded in **Architecture Decision** below.

> **Superseded:** "**Two literals, two surfaces.** The same string exists in `TaskViewerProvider.ts:2188` (HTTP) and `PlanningPanelProvider.ts:3727` (webview message). Fixing one and not the other reproduces the confusion in whichever surface was skipped; the webview path is the one a human sees."
> **Reason:** Factually incomplete. There are four reporting surfaces, and the two that were missed are the two that matter most: the board's drag-drop status bar (ten `moveCardsFailed` literals rendered at `kanban.html:7878` — the surface a human actually sees) and `POST /planning/verb/moveKanbanPlanColumn`, which does not return a misleading string at all but an outright false success.
> **Replaced with:** The four-surface bullet above, and per-surface work in **Proposed Changes** §4–§6.

> **Superseded:** "**This plan changes no behaviour.** It must not alter which moves succeed. A move that fails today must still fail after the change — only the explanation changes. Any test that starts passing is a red flag, not a win."
> **Reason:** The zero-row `UPDATE` case (root cause #3) cannot be reported at all unless `updateColumnByPlanFile` starts checking rows-modified, and that check necessarily flips one class of outcome from "reported success" to "reported failure". A pure no-behaviour-change plan can only ever cover three of the four outcomes it exists to distinguish.
> **Replaced with:** The invariant is narrowed, not dropped: **no move that genuinely writes a row may change outcome.** Exactly one class changes — an `UPDATE` that matched zero rows, which was never a successful move and was only ever reported as one. Everything else is diagnostics. The original red-flag rule still holds for every other path: any *other* test that starts passing is a regression signal, not a win.

## Architecture Decision — how the reason is carried

**Chosen:** parallel `…WithReason` entry points returning a discriminated union; the existing boolean methods become one-line delegates (`return (await …WithReason(…)).ok`) and every current call site is left textually unchanged.

```ts
export type ColumnUpdateOutcome =
    | { ok: true }
    | {
          ok: false;
          reason: 'not_found' | 'invalid_column' | 'no_rows_matched' | 'cascade_failed' | 'not_ready' | 'error';
          detail: string;   // caller-safe sentence, no SQL, no paths beyond what the caller supplied
      };
```

Rejected alternatives, with the reason each loses:

| Alternative | Why rejected |
| --- | --- |
| Change the existing methods to return the object | `if (ok)` / `!!moved` on a failure object is truthy. Every current failure report becomes a success report, TypeScript flags none of it, and three source-text tests break. Catastrophic. |
| Union return `boolean \| { ok:false, reason }` | Same truthiness defect as above, plus a type every caller must narrow. Worst of both. |
| Keep boolean, add a `getLastMoveFailure()` accessor | The `errno` anti-pattern. Shared mutable state across concurrent moves — a batch drag of five cards races its own error channel. Untestable in the batch loops at `:5682-5693` and `:5725-5735`. |
| Throw a typed error instead of returning false | Cleanest propagation, but inverts control flow at ~15 call sites that currently branch on `false`. A single missed `catch` turns a benign failed move into a crashed handler or an HTTP 500 — strictly worse than the bug being fixed, in a plan whose whole value is legibility. |

The chosen shape costs one extra method per layer and buys zero blast radius. The duplication is bounded (four delegates, each one line) and mechanically obvious.

## Edge-Case & Dependency Audit

### Race conditions

- None introduced by the reason plumbing. The reason is derived at the point of failure, inside the same call that already made the determination.
- The rows-modified read is safe: `this._db.run(...)` and `this._db.getRowsModified()` are both synchronous with **no `await` between them**, so no other statement can land on the handle in between. This is the same guarantee `updateFeatureStatus` (`:2548-2552`) already relies on. Do not insert an `await` between the two calls.

### Security

- Error strings reach an HTTP client and a webview. Naming a workspace root exposes a local path, which is already visible on `/health` under the same auth, so no new exposure — but do not extend that to arbitrary filesystem detail.
- `detail` must never carry SQL text, the WHERE clause, or `workspace_id` UUIDs. Name the workspace root and the plan key the caller already supplied; nothing else.

### Side effects

- Improved messages will surface **pre-existing** failures that were previously invisible or misattributed. Expect reports of "new" errors that are in fact old ones finally legible. Do not treat that as a regression.
- `_fireColumnChanged` (`KanbanDatabase.ts:2479`) currently fires for zero-row updates. After the fix it fires only on a real row change. This removes a spurious board event; if anything downstream depends on that event firing for a no-op write, it was depending on a bug.
- `POST /planning/verb/moveKanbanPlanColumn` changes from always-200 to 200/502 depending on the move. Any caller that treats 200 as success will start seeing accurate failures. That is the point.

### Dependencies & conflicts

- **Should land before** `feature_plan_20260808103100_kanban-move-silently-defaults-to-first-root.md`. That plan introduces new failure modes (not-found-in-any-root, ambiguous match) whose whole value is in the message; without this plan they collapse into the same useless string. Build this one first, or build both together. Its `reason` vocabulary should extend the union defined here rather than invent a parallel one.
- **Related:** `feature_plan_20260808103000_move-card-script-sends-relative-workspace-root.md`. Had this plan already landed, that defect would have been a one-glance diagnosis instead of a five-file trace. That is the concrete argument for this plan's value.
- **Ratchet interaction (PRD).** Converting the `moveKanbanPlanColumn` arm from `break` to `return` lowers `PlanningPanelProvider`'s residual `break` count. `scripts/check-verb-return-contract.js` gates on `current > ceiling` (`:56`, `:96`), so a lower count never fails the gate — but per the project PRD the win must be locked in the same change: run `node scripts/check-verb-return-contract.js --write` and commit the lowered `Planning` ceiling in `scripts/verb-return-contract-baseline.json` (currently `154`).
- **`verbSchemas.ts:588`** already carries a `moveKanbanPlanColumn` schema. Returning from the arm does not change its payload, so the schema needs no edit — confirm rather than assume.
- No schema change, no migration, no new route.

## Dependencies

- None as session dependencies. Ordering dependencies are plan-file relative and listed in **Edge-Case & Dependency Audit → Dependencies & conflicts** above: this plan should land before `feature_plan_20260808103100_kanban-move-silently-defaults-to-first-root.md`, and is the diagnostic substrate for `feature_plan_20260808103000_move-card-script-sends-relative-workspace-root.md`.

## Adversarial Synthesis

**Risk summary.** The dominant risk is not the diagnostics work but the return-type choice: a result object returned from the existing `moveCardToColumn` is truthy, so every `if (ok)` / `!!moved` call site would silently invert failure into success with no compiler help — mitigated by the settled decision to add parallel `…WithReason` entry points and leave the boolean signatures and their three source-text-pinned call sites untouched. The second risk is that root cause #3 turns out to be a *false success* rather than a `false`: the fix requires a `getRowsModified()` check in `updateColumnByPlanFile`, which is a genuine behaviour change for zero-row updates — mitigated by narrowing the no-behaviour-change invariant to "no move that genuinely writes a row changes outcome" and by mirroring the pattern already used by `updateFeatureStatus` in the same file. The third risk is partial coverage: the plan's stated goal ("a caller — human or agent") is not met by editing two literals, because the agent-facing `POST /planning/verb/moveKanbanPlanColumn` returns a hard `200 {success:true}` on failure and the board's own status bar reads a third, different literal — mitigated by treating all four surfaces as in-scope and by asserting the HTTP body, not just the message text, in verification.

## Proposed Changes

### 1. `src/services/KanbanDatabase.ts` — make the reason available and stop the false success

**Context.** `updateColumnByPlanFile` (`:2452-2482`) validates the column, normalises the plan file, delegates the write to `_persistedUpdate` (`:9242-9251`), runs a VERIFY read that already computes the missing information, then returns a boolean that cannot carry it. `_persistedUpdate` never inspects rows-modified, so a zero-row UPDATE returns `true`.

**Logic.** Add `updateColumnByPlanFileWithReason(planFile, workspaceId, newColumn): Promise<ColumnUpdateOutcome>` as the real implementation. Keep `updateColumnByPlanFile` with its exact current signature, delegating.

**Implementation.**

- Export `ColumnUpdateOutcome` (shape above) from `KanbanDatabase.ts`; both the provider and the reporting surfaces import it.
- `updateColumnByPlanFileWithReason`:
  - Invalid column → `{ ok: false, reason: 'invalid_column', detail: \`Column name '${newColumn}' is not a valid kanban column.\` }`. Keep the existing `console.error` at `:2454` — the log is not the problem, the missing return channel is.
  - `!(await this.ensureReady()) || !this._db` → `{ ok: false, reason: 'not_ready', detail: 'Kanban database is not ready.' }`.
  - Run the `UPDATE` inline rather than through `_persistedUpdate`, mirroring `updateFeatureStatus` (`:2546-2562`) exactly:

    ```ts
    let affected = 0;
    try {
        this._db.run(
            'UPDATE plans SET kanban_column = ?, updated_at = ? WHERE plan_file = ? AND workspace_id = ?',
            [newColumn, new Date().toISOString(), normalized, workspaceId]
        );
        affected = this._db.getRowsModified();   // NO await between run() and this line
        await this._persist();
    } catch (error) {
        console.error('[KanbanDatabase] updateColumnByPlanFile failed:', error);
        return { ok: false, reason: 'error', detail: error instanceof Error ? error.message : String(error) };
    }
    ```
  - `affected === 0` → `{ ok: false, reason: 'no_rows_matched', detail: \`No plan row matched plan_file '${normalized}' in this workspace.\` }`. **Do not** call `_fireColumnChanged` on this branch.
  - `affected > 0` → `_fireColumnChanged(normalized, newColumn)`, return `{ ok: true }`.
  - Fold the VERIFY block (`:2464-2477`) into this branching. Its `NOT FOUND in DB` warning is now expressible as the returned `no_rows_matched` detail; keep the console lines if desired, but they are no longer the only carrier.
- `updateColumnByPlanFile` becomes `return (await this.updateColumnByPlanFileWithReason(planFile, workspaceId, newColumn)).ok;` — signature and semantics for existing callers unchanged except that a zero-row update now correctly returns `false`.
- Add `updateColumnWithReason(sessionId, newColumn)`: `getPlanBySessionId` miss → `{ ok: false, reason: 'not_found', detail: \`No plan found for key '${sessionId}'.\` }`; otherwise delegate to `updateColumnByPlanFileWithReason(plan.planFile, plan.workspaceId, newColumn)`. Keep the `@deprecated` tag.
- `updateColumn` becomes `return (await this.updateColumnWithReason(sessionId, newColumn)).ok;`.

**Edge cases.** `_persistedUpdate` itself is used by ~30 other methods and MUST NOT be changed — the inline write is deliberately local so the zero-row semantics change is confined to this one function. `getRowsModified()` is already declared on the local `SqlJsDatabase` type (`:147`) and used at `:2552`, `:4329`, `:9712`, `:9859`; the stale comment at `:2503` claiming the type does not expose it is wrong and should not be trusted.

### 2. `src/services/KanbanProvider.ts` — propagate rather than flatten

**Context.** `moveCardToColumn` (`:6923-6971`) and `moveCardToColumnByPlanFile` (`:6986-7040`) each resolve the plan, branch to a feature cascade or a column update, and return a boolean; both `catch` blocks log and return `false` (`:6967-6970`, `:7036-7039`).

**Logic.** Move each body into a `…WithReason` sibling; the existing methods delegate and return `.ok`.

**Implementation.**

- `moveCardToColumnWithReason(workspaceRoot, sessionId, targetColumn): Promise<ColumnUpdateOutcome>` — body moved verbatim from `:6923`, with the return points replaced:
  - `!sessionId` → `{ ok: false, reason: 'not_found', detail: 'No plan key supplied.' }`.
  - `!await db.ensureReady()` → `{ ok: false, reason: 'not_ready', detail: \`Kanban database for workspace '${workspaceRoot}' is not ready.\` }`.
  - Feature branch: `cascadeFeatureByPlanId` returns boolean → `false` maps to `{ ok: false, reason: 'cascade_failed', detail: \`Feature cascade for plan ${plan.planId} updated no rows.\` }`.
  - Non-feature branch: call `db.updateColumnWithReason(sessionId, targetColumn)` and use its outcome directly. Append the workspace to `detail` for the `not_found` case so the message answers "where did you look?" — e.g. `No plan found for key '<key>' in workspace '<workspaceRoot>'.`
  - `catch` → `{ ok: false, reason: 'error', detail: err instanceof Error ? err.message : String(err) }`, keeping the existing `console.error` at `:6968`.
- `moveCardToColumn` becomes `return (await this.moveCardToColumnWithReason(...)).ok;`.
- Same treatment for `moveCardToColumnByPlanFile` → `moveCardToColumnByPlanFileWithReason`, using `db.updateColumnByPlanFileWithReason(planFile, workspaceId, targetColumn)` in the non-feature branch (`:7014`) and keeping the `_refreshBoard` / integration-sync / feature-regeneration side effects gated on `ok` exactly as they are gated on `moved` today.

**Edge cases.** The call sites at `:2711`, `:3034`, `:3117`, `:5684`, `:5727`, `:6029` keep calling the boolean methods and MUST NOT be rewritten — `src/test/kanban-drag-confirm-before-dispatch.test.js:82` and `src/test/kanban-subtask-column-leak-regression.test.js:75,79` assert their exact source text. `ScheduledJobsService.ts:243-249` duck-types the provider handle and also keeps the boolean methods.

### 3. `src/extension.ts` — a reason-carrying command, alongside the existing one

**Context.** `switchboard.moveKanbanCardByPlanFile` (`:1715-1721`) returns `moveCardToColumnByPlanFile`'s boolean and has exactly one in-repo caller (`PlanningPanelProvider.ts:3724`), but is a publicly registered command.

**Logic.** Register a second command rather than changing the existing one's contract.

**Implementation.** Add `switchboard.moveKanbanCardByPlanFileWithReason` returning `await kanbanProvider!.moveCardToColumnByPlanFileWithReason(workspaceRoot, planFile, targetColumn)`. Push its disposable alongside the existing one. Leave `switchboard.moveKanbanCardByPlanFile` byte-identical.

**Edge cases.** Do not change `executeCommand<boolean>` on the existing command anywhere — an object returned through a `<boolean>` type parameter would pass `!!` and read as success.

### 4. `src/services/TaskViewerProvider.ts:2183-2190` — HTTP `/kanban/move` says what happened

**Context.** The `moveCard` option handed to `LocalApiServer` resolves a plan-file-shaped key to a session id, calls `moveCardToColumn`, and returns `{ success: moved, error: moved ? undefined : 'Column update failed' }`.

**Logic.** Call the reason-carrying method and return both a human sentence and a machine-readable class.

**Implementation.**

```ts
const outcome = await this._kanbanProvider.moveCardToColumnWithReason(wsRoot, targetSessionId, targetColumn);
if (outcome.ok && targetPlanFile) { /* existing updatePlanFile block, unchanged */ }
return outcome.ok
    ? { success: true }
    : { success: false, error: outcome.detail, reason: outcome.reason };
```

**Edge cases.** `LocalApiServer._handleKanbanMove` (`:1349-1351`) writes `result.success ? 200 : 502` and serialises `result` — the added `reason` field rides along with no route change. **Keep 502.** A `404` for `not_found` would be more correct but is a behaviour change to a status code that `move-card.js` and other bridge clients already branch on; the class belongs in the body, not in a new status code. The existing `catch` at `:2191-2193` stays as-is.

### 5. `src/services/PlanningPanelProvider.ts:3715-3732` — the webview surface, and the verb that lies

**Context.** The `moveKanbanPlanColumn` arm posts `kanbanPlanColumnChanged` to the project webview and `break`s. Because it returns nothing, `handleServiceVerb` (`:153`) resolves to `undefined` and `LocalApiServer._handlePlanningVerb` (`:1830-1832`) answers `200 {success:true}` — a false success on the agent-facing route, in direct violation of the project PRD's return-in-body contract.

**Logic.** Switch to the reason-carrying command, post the real detail to the webview, and **return** the result so the HTTP caller sees it too.

**Implementation.**

```ts
const outcome = await this._seams().commands.executeCommand<ColumnUpdateOutcome>(
    'switchboard.moveKanbanCardByPlanFileWithReason', wsRoot, planFile, newColumn
);
const ok = !!outcome?.ok;
const payload = ok
    ? { success: true }
    : { success: false, error: outcome?.detail ?? 'Column update failed', reason: outcome?.reason };
this.postMessageToProjectWebview({ type: 'kanbanPlanColumnChanged', ...payload });
return payload;
```

Keep the two early-exit branches (`:3719-3722` missing-field, `:3728-3730` catch) posting as they do, but make them `return { success: false, error: … }` as well — the aggregate catch returning nothing is the same false-success defect.

**Edge cases.** Converting this arm from `break` to `return` lowers `PlanningPanelProvider`'s residual `break` count; run `node scripts/check-verb-return-contract.js --write` and commit the lowered `Planning` ceiling (from `154`) in `scripts/verb-return-contract-baseline.json`. `verbSchemas.ts:588` is unaffected — the payload shape does not change; confirm this rather than assume it. `optional chaining on outcome` matters: under a host where the command is not registered, `executeCommand` resolves `undefined`, and `!!undefined?.ok` is correctly `false`.

### 6. `src/services/KanbanProvider.ts` — the board status bar stops guessing

**Context.** `moveCardsFailed` payloads carry `reason: "couldn't save — board may be out of sync"` at `:5691`, `:5733`, `:8193`, `:8411`, `:8904`, `:8970`, `:8996`, `:9138` and the surrounding batch loops. `src/webview/kanban.html:7878` renders `failed[0]?.reason` verbatim: `` `${failed.length} plan(s) not advanced: ${failed[0]?.reason || 'database update failed'}` ``. This is the message a user gets when a drag-drop fails.

**Logic.** Where the loop already has an outcome in hand, use its `detail`; where it does not, leave the literal.

**Implementation.** At each site whose loop can switch to `moveCardToColumnWithReason` without changing the `const ok = await this.moveCardToColumn(` text that the regex tests pin — i.e. the loops that are *not* inside `triggerAction`, `triggerBatchAction`, or the subtask-cascade blocks named by those tests — capture the outcome and push `reason: outcome.detail`. Where the pinned text must be preserved, keep the existing literal unchanged and do not contort the call site to route a reason through it.

**Edge cases.** The webview already falls back when `reason` is absent, so a partially-migrated set of sites degrades to today's behaviour rather than to an empty message. Do not change `moveCardsFailed`'s payload shape — `kanban.html:7834-7880` and `src/test/kanban-render-guard-contract.test.js:63-92` both depend on `{ id, sourceColumn, reason }`.

## Verification Plan

Compilation and automated tests are out of scope for this session; the steps below are manual/observational. Perform them against a running extension with the local API server up.

1. **Not found.** Move a `planId` that exists in another workspace with an explicit wrong root, via `POST /kanban/move`. Body must read as not-found **in the named workspace** and carry `reason: "not_found"` — and must not claim an update failed.
2. **Invalid column.** Move to a column name failing both `VALID_KANBAN_COLUMNS` and `SAFE_COLUMN_NAME_RE`. Body says the column name is invalid with `reason: "invalid_column"`. Confirm the server-side `console.error` at `KanbanDatabase.ts:2454` is no longer the only place that information exists.
3. **No rows matched — the false success is gone.**

   > **Superseded:** "Force case 3 — a plan resolvable by ID whose stored `plan_file` does not match `_ensureRelativePlanFile`'s output. The row with `needs_path_fix = 1` is the natural candidate. Error must be distinguishable from case 1."
   > **Reason:** As written this step is unrunnable — today case 3 produces no error at all, so there is nothing to distinguish from case 1. The step assumed a `false` that the code does not produce.
   > **Replaced with:** Call `updateColumnByPlanFileWithReason` with a `plan_file` / `workspace_id` pair that matches no row (the `needs_path_fix = 1` row is the natural candidate). **Before the change**, confirm the current code returns `true` and logs `VERIFY: … NOT FOUND in DB` — this is the false success being fixed, and observing it first is what makes the rest of the step meaningful. **After the change**, confirm the outcome is `{ ok: false, reason: 'no_rows_matched', … }`, that it is distinguishable from `not_found`, and that no `kanbanColumnChanged` event fires for it.
4. **Exception path.** Induce a DB error mid-move. The outcome carries `reason: "error"` with the exception message, and the existing `console.error` still fires.
5. **Success is unchanged.** A normal move returns `{ success: true }` with the same shape as before. No caller that checks only `success` needs to change.
6. **Behaviour is unchanged where it writes a row.** Re-run the full set of moves that succeed today and confirm every one still succeeds. The only permitted difference is the zero-row class from step 3, which was never a real move.
7. **All four surfaces.** Trigger the same not-found through (a) `POST /kanban/move`, (b) the project-panel column dropdown (webview `kanbanPlanColumnChanged`), (c) `POST /planning/verb/moveKanbanPlanColumn` — the body must now be `{ success: false, … }`, **not** `200 {success:true}` — and (d) a board drag-drop, checking the status-bar text at `kanban.html:7878`. A surface that still shows the old literal is an unfinished surface.
8. **The original symptom.** `CODE REVIEWED` → `PLAN REVIEWED` with a wrong workspace. The error must make it obvious the card was not found, so no reader concludes the board blocks backwards transitions. This is the test that represents the actual reported bug.
9. **Ratchet locked.** `scripts/verb-return-contract-baseline.json` shows a `Planning` ceiling lower than `154`, and `npm run verb-returns:check` passes. Confirm by inspection of the committed diff.

### Automated Tests

Deferred — this session runs no automated tests. For the implementing agent, the coverage that should exist alongside the change:

- A `KanbanDatabase` unit test asserting `updateColumnByPlanFileWithReason` returns `no_rows_matched` (not `ok`) for a non-matching `plan_file`/`workspace_id` pair — the regression guard for the false success, and the one assertion that would have caught this class of bug earlier.
- A test asserting `updateColumnByPlanFile` (the boolean delegate) returns `false` for the same input, pinning the delegation.
- A headless test on `POST /planning/verb/moveKanbanPlanColumn` asserting the **body** carries `success:false` for a failed move (per the project PRD: a data-asserting body test, not a `success`-only smoke test).
- Do **not** modify `src/test/kanban-drag-confirm-before-dispatch.test.js`, `src/test/kanban-subtask-column-leak-regression.test.js`, or `src/test/review-column-persistence-regression.test.js` — they must pass unchanged. If one of them goes red, the implementation rewrote a call site it was required to leave alone.

## Recommendation

Build it first, ahead of the two addressing fixes. It is the smallest of the three and it is what makes the other two diagnosable — this defect is the reason a simple wrong-database lookup presented as a policy decision and cost a multi-file code trace to resolve.

Guard two properties in review: (1) no move that genuinely writes a row may change outcome; (2) no existing boolean call site may be re-shaped into a truthiness check on an object. This plan buys legibility, plus one honest correction to a write that was reporting success without writing anything.

**Send to Coder** (Complexity 5).

## Review Findings

Reviewed 2026-08-10. Files changed: `KanbanDatabase.ts` (`ColumnUpdateOutcome`, inline UPDATE + `getRowsModified()` with no intervening `await`, `…WithReason` siblings), `KanbanProvider.ts`, `TaskViewerProvider.ts`, `PlanningPanelProvider.ts`, `extension.ts`, `verb-return-contract-baseline.json` (Planning 154→152). The settled architecture decision is honoured exactly — boolean delegates preserved and the three source-text-pinned call sites untouched (`kanban-drag-confirm-before-dispatch` green; the subtask-leak test's `moveCardToColumn(` assertions green, its only failure being assertion #7 on `kanban.html`'s `getAllInColumn`, verified byte-identical at HEAD and unrelated). Two MAJOR findings fixed: (1) `verbSchemas.ts:589` declared `column` **required** and omitted `planFile`/`newColumn` — the two fields the arm actually dereferences and the only shape any real sender posts — so `POST /planning/verb/moveKanbanPlanColumn`, the exact route §5 exists to de-lie, 400'd at the boundary before the honest body could be produced (the plan said "confirm rather than assume"; the schema is now permissive and field-accurate); (2) `KanbanMigration._migrateLegacyCodedRows` aborted the entire legacy-CODED migration on any falsy `updateColumn`, so the newly-honest zero-row class would permanently pin a shipped workspace's schema version — it now skips only `no_rows_matched` and still aborts on every pre-existing failure class. Live DB validation: `no_rows_matched` returned (and the boolean delegate false) for a non-matching `plan_file`/`workspace_id` pair, `invalid_column` and `not_found` distinguishable, a real move `ok:true`, and an idempotent same-column re-move still `ok:true` (SQLite counts no-op UPDATEs as changed, so there is no false `no_rows_matched`). Remaining risk: the VERIFY block is now duplicated into the `affected === 0` branch — harmless, deferred.
