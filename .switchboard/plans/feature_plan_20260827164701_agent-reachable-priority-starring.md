# Agent-Reachable Priority Starring Endpoint

## Goal

### Problem

An agent in a discussion cannot ask another agent (or itself) to set priority or star a plan. The user reports: "priority or starring is not agent reachable — I cannot ask an agent to set priority or star plans during a discussion."

### Root Cause

The priority-star feature (V63) is fully implemented in the webview and DB layer — `KanbanProvider.setPriorityStarred()` writes `priority_starred` via `KanbanDatabase.setPriorityStarred()`, and the `setPriorityStarred` verb is in the `KANBAN_VERBS` allowlist. However, it is **only reachable through the generic verb rail** (`POST /kanban/verb/setPriorityStarred`), which has three problems that make it effectively unreachable for agents:

1. **No first-class REST endpoint.** Unlike complexity (`PUT /kanban/plans/complexity`) and project (`PUT /kanban/plans/project`), which have dedicated, payload-validated, honest-response endpoints, priority/starring has none. The generic verb rail is explicitly discouraged in the agent skill (`switchboard-orchestration/SKILL.md` §4a) because of silent no-op traps.

2. **No validation on the kanban verb rail.** `verbSchemas.ts` has no entry for `setPriorityStarred`, and `_handleKanbanVerb` in `LocalApiServer.ts` (line 4069) does **not call `validateVerbPayload` at all** — it passes the body straight through to the `kanbanVerb` callback after `delete body.type`. (Only the `taskViewer` verb rail validates, and only for `pty*` verbs — line 3931.) An agent sending wrong field names (e.g. `id` instead of `planId`) gets a silent no-op with a hollow `{success:true}` response. Additionally, the `setPriorityStarred` arm in `KanbanProvider._handleMessage` (line 12565) coerces with `!!msg.starred`, so `starred: "false"` (string) becomes `true` — the star turns ON when the agent asked to turn it OFF.

   > **Superseded:** `verbSchemas.ts` has no entry for `setPriorityStarred`, so `validateVerbPayload('kanban', 'setPriorityStarred', payload)` is a pass-through.
   > **Reason:** The plan implied the validation runs but doesn't catch errors. In reality, `_handleKanbanVerb` never calls `validateVerbPayload` for any kanban verb — the validation does not run at all. Adding a schema entry would have zero effect on the verb rail.
   > **Replaced with:** The kanban verb rail performs NO payload validation. The first-class endpoint is the only validated write path. A verb schema entry is not added (it would be dead code — the verb rail never consults `verbSchemas.ts`).

3. **Not documented in the agent skill.** The `switchboard-orchestration/SKILL.md` documents `PUT /kanban/plans/complexity` and `PUT /kanban/plans/project` in its "Plan lifecycle" table but does not mention priority/starring at all. An agent consulting the skill has no way to discover the capability. `GET /catalog` lists the verb name but not its payload shape.

The read side works: `priorityStarred` is in `PLAN_COLUMNS` and mapped in `_readRows()`, so `GET /kanban/board` and `GET /kanban/plan?planId=<id>` already return the field. The gap is purely on the write side.

## Metadata

**Complexity:** 3
**Tags:** backend, api, feature
**Project:** Browser Switchboard

## User Review Required

This plan needs user review before coding begins. Key decisions to confirm:
- The first-class endpoint is the sole validated write path; the generic verb rail remains unvalidated for `setPriorityStarred` (and all other kanban verbs). A systemic fix to validate all kanban verbs is out of scope and should be a separate plan.
- Boolean coercion policy: strict validation (reject non-boolean-like with 400) rather than lenient `!!` coercion, to close the silent-trap class of bug this plan exists to fix.

## Complexity Audit

### Routine
- Adding a `PUT /kanban/plans/priority` endpoint follows the exact pattern of `_handleSetPlanProject` / `_handleSetPlanComplexity` — same auth check, same DB resolution, same 400/404/503 error envelope. The handler is standalone (not a third `field` case in `_handlePlanFieldUpdate`) because it needs session-id fallback that the shared handler does not provide.
- Documenting the endpoint in `switchboard-orchestration/SKILL.md` is a table-row addition in the "Plan lifecycle" section.
- Regenerating the catalog via `npm run catalog:generate` — the generator (`scripts/generate-protocol-catalog.js`) scans `LocalApiServer.ts` for `pathname ===` route arms via regex, so the new route is picked up automatically.

### Complex / Risky
- None. The DB write path (`KanbanDatabase.setPriorityStarred`) already exists, is idempotent, and is tested. The `KanbanProvider.setPriorityStarred` method already resolves session-id keys. No new DB columns, no migrations, no new state.

## Edge-Case & Dependency Audit

- **Session-id keyed cards:** `KanbanProvider.setPriorityStarred` already resolves `planId || sessionId` by falling back to `getPlanBySessionId` (line 8710). The first-class endpoint must do the same — accept `planId` OR `sessionId` in the body, resolve to a canonical plan record, and 404 if neither matches. The existing `_handlePlanFieldUpdate` only checks `getPlanByPlanId` (line 6509), so the priority endpoint needs its own handler (not a third `field` case in the shared method) to add the session-id fallback.
- **Boolean coercion (strict):** The webview sends `starred: !currentlyStarred` (a boolean). An agent might send `starred: 1`, `starred: "true"`, or `starred: "1"`. The endpoint must coerce known truthy/falsy string and number forms to a boolean, and reject unrecognized values with 400. This is critical: `!!starredRaw` would coerce `starred: "false"` → `true`, reproducing the exact silent trap this plan exists to fix.

  > **Superseded:** The endpoint must coerce truthy/falsy to a boolean before calling `db.setPriorityStarred`, and reject non-boolean-like values with 400.
  > **Reason:** The original code (`const starred = !!starredRaw`) only did the coercion — it never rejected anything. `!!"false"` is `true`, so an agent sending `starred: "false"` to unstar would silently star the plan instead. The stated requirement (reject non-boolean-like) and the code (`!!starredRaw`) contradicted each other.
  > **Replaced with:** Strict boolean validation: accept `true`/`false` (boolean), `1`/`0` (number), and `"true"`/`"false"` (string, case-insensitive). Reject all other values with 400. This closes the silent-trap class of bug.

- **Standalone parity:** `LocalApiServer` is shared by both hosts (extension via `TaskViewerProvider`, standalone via `bootstrap.ts`). The new route is registered in `LocalApiServer._handleRequest`'s routing chain, which both hosts use. No separate standalone wiring is needed — the endpoint calls `db.setPriorityStarred` directly (same as `_handlePlanFieldUpdate` calls `db.updateComplexityByPlanFile` directly), bypassing the `kanbanVerb` callback entirely.
- **Board refresh:** The webview `setPriorityStarred` arm calls `this._refreshBoard(workspaceRoot)` after the write (line 8714). The first-class endpoint does not have access to the provider's refresh method. This is acceptable — the existing `PUT /kanban/plans/complexity` and `PUT /kanban/plans/project` endpoints also do not trigger a board refresh, and the WS hub push (if wired) handles live updates. The board auto-pulls on its interval.
- **No confirm gate:** Per project rules, no confirmation dialog. The endpoint is a direct write.

## Dependencies

- None. This plan is self-contained — the DB write path (`KanbanDatabase.setPriorityStarred`), the session-id resolution pattern (`getPlanBySessionId`), and the endpoint pattern (`_handlePlanFieldUpdate`) all already exist in the codebase.

## Adversarial Synthesis

Key risks: (1) lenient `!!` boolean coercion would reproduce the silent-trap class of bug the plan exists to fix — mitigated by strict validation that rejects non-boolean-like values with 400; (2) a verb schema entry in `verbSchemas.ts` would be dead code because `_handleKanbanVerb` never calls `validateVerbPayload` — mitigated by dropping the schema entry and making the first-class endpoint the sole validated path; (3) the session-id fallback diverges from `_handlePlanFieldUpdate`'s planId-only lookup — mitigated by using a dedicated handler rather than extending the shared method.

## Proposed Changes

### 1. `src/services/LocalApiServer.ts` — Add `PUT /kanban/plans/priority` endpoint

Add a new handler method and route registration, following the `_handleSetPlanComplexity` pattern but with session-id fallback and strict boolean validation:

```typescript
/** PUT /kanban/plans/priority — set a plan's priority star ({ planId, starred }). */
private async _handleSetPlanPriority(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    if (!await this._checkAuth(req, true)) {
        this._sendUnauthorized(res);
        return;
    }
    try {
        const body = await this._parseJsonBody(req);
        const planId = String(body?.planId || body?.sessionId || '').trim();
        if (!planId) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Missing required field: planId' }));
            return;
        }
        // Strict boolean validation — reject non-boolean-like values to prevent
        // the silent-trap class of bug (e.g. starred: "false" → true with !!).
        const starredRaw = body?.starred;
        if (starredRaw === undefined || starredRaw === null) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Missing required field: starred (boolean)' }));
            return;
        }
        let starred: boolean;
        if (typeof starredRaw === 'boolean') {
            starred = starredRaw;
        } else if (starredRaw === 1 || starredRaw === 0) {
            starred = starredRaw === 1;
        } else if (typeof starredRaw === 'string') {
            const lower = starredRaw.trim().toLowerCase();
            if (lower === 'true') { starred = true; }
            else if (lower === 'false') { starred = false; }
            else {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Field "starred" must be a boolean, 1/0, or "true"/"false"' }));
                return;
            }
        } else {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Field "starred" must be a boolean, 1/0, or "true"/"false"' }));
            return;
        }

        const db = await this._resolveDbForRoot(String(body?.workspaceRoot || '').trim() || undefined);
        if (!db) {
            res.writeHead(503, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Kanban database not available' }));
            return;
        }
        // Resolve planId OR sessionId (the card key is planId || sessionId,
        // matching KanbanProvider.setPriorityStarred line 8710).
        let record = await db.getPlanByPlanId(planId);
        if (!record) { record = await db.getPlanBySessionId(planId); }
        if (!record) {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: `Plan not found: ${planId}` }));
            return;
        }
        const wsId = await this._wsId(db);
        const ok = await db.setPriorityStarred(record.planId, wsId, starred);
        res.writeHead(ok ? 200 : 500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: ok, planId: record.planId, starred }));
    } catch (err) {
        console.error('[LocalApiServer] setPlanPriority error:', err);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err instanceof Error ? err.message : 'update failed' }));
    }
}
```

Register the route in the routing chain, adjacent to the existing `plans/project` and `plans/complexity` routes (insert before the `plans/complexity` arm at line 7509):

```typescript
} else if (pathname === '/kanban/plans/priority' && req.method === 'PUT') {
    await this._handleSetPlanPriority(req, res);
} else if (pathname === '/kanban/plans/complexity' && req.method === 'PUT') {
```

### 2. `.agents/skills/switchboard-orchestration/SKILL.md` — Document the endpoint

Add a row to the "Plan lifecycle" table in §3 (after the `plans/complexity` row at line 103):

```
| `PUT /kanban/plans/priority` | `{ planId, starred, workspaceRoot? }` | Set a plan's priority star (`starred: true/false/1/0/"true"/"false"`). Starred cards sort first in every consumer. Idempotent. Accepts `sessionId` as an alias for `planId`. Returns `{ success, planId, starred }`. |
```

Add a usage example in the bash block (after the existing `plans/project` curl example at line 116):

```bash
curl -s -X PUT "$BASE/kanban/plans/priority" -H "Content-Type: application/json" \
  -d '{"planId":"a1b2c3d4","starred":true}'
```

> **Superseded:** Add a schema entry in `verbSchemas.ts` for `setPriorityStarred` so the generic verb rail validates its payload.
> **Reason:** `_handleKanbanVerb` (line 4069) never calls `validateVerbPayload` — it passes the body straight through to the `kanbanVerb` callback. Only `pty*` verbs on the `taskViewer` rail get validated (line 3931). A schema entry for `setPriorityStarred` would be dead code: never consulted, never enforced, never rejecting a bad payload.
> **Replaced with:** No verb schema entry. The first-class `PUT /kanban/plans/priority` endpoint is the sole validated write path. The generic verb rail (`POST /kanban/verb/setPriorityStarred`) remains unvalidated for all kanban verbs — a systemic fix to validate all kanban verbs should be a separate plan.

### 3. `protocol-catalog.json` — Regenerate

Run `npm run catalog:generate` to regenerate `src/generated/verbAllowlist.ts` and update the catalog with the new endpoint. The catalog generator (`scripts/generate-protocol-catalog.js`) scans `LocalApiServer.ts` for `pathname ===` route arms via regex, so the new `PUT /kanban/plans/priority` route will be picked up automatically.

## Verification Plan

### Automated Tests
1. **Existing contract test:** `src/test/card-priority-and-column-order-contract.test.js` already asserts `setPriorityStarred` exists in the verb allowlist and in `KanbanProvider`. Run `node src/test/card-priority-and-column-order-contract.test.js` — should still pass.
2. **New endpoint test:** Add a test that verifies the `PUT /kanban/plans/priority` route is registered and returns honest errors (400 on missing planId, 404 on unknown planId, 200 on valid call). Model it on the existing complexity/project endpoint tests.
3. **Boolean coercion test:** Verify `starred: "false"` returns 400 (not silently coerced to `true`), `starred: 1` returns `{starred: true}`, `starred: 0` returns `{starred: false}`, `starred: "true"` returns `{starred: true}`, and `starred: "maybe"` returns 400.
4. **Catalog check:** Run `npm run catalog:check` to verify the regenerated catalog matches the server's actual routes.

### Goal Invariants
- Assert `PUT /kanban/plans/priority` route arm exists in `src/services/LocalApiServer.ts` (regex: `pathname === '/kanban/plans/priority'`).
- Assert `_handleSetPlanPriority` method exists in `src/services/LocalApiServer.ts`.
- Assert the handler calls `db.getPlanBySessionId` as a fallback (regex in handler body: `getPlanBySessionId`).
- Assert the handler does NOT use `!!starredRaw` as its sole boolean coercion (the strict validation path must be present).
- Assert no new entry for `setPriorityStarred` exists in `src/services/verbSchemas.ts` (the schema is intentionally omitted — dead code).
- Assert `PUT /kanban/plans/priority` appears in `.agents/skills/switchboard-orchestration/SKILL.md` §3 table.

### Manual
1. Start the extension, create a plan, and `curl -X PUT http://127.0.0.1:$PORT/kanban/plans/priority -H "Content-Type: application/json" -d '{"planId":"<id>","starred":true}'` — verify the star appears on the board.
2. `curl -X PUT ... -d '{"planId":"<id>","starred":false}'` — verify the star clears.
3. `curl -X PUT ... -d '{"sessionId":"<sid>","starred":true}'` — verify session-id alias works.
4. `curl -X PUT ... -d '{"planId":"nonexistent","starred":true}'` — verify 404.
5. `curl -X PUT ... -d '{"starred":true}'` — verify 400 on missing planId.
6. `curl -X PUT ... -d '{"planId":"<id>","starred":"false"}'` — verify 400 (string "false" is rejected, not coerced to `true`).
7. `curl -X PUT ... -d '{"planId":"<id>","starred":"maybe"}'` — verify 400 on non-boolean-like value.
8. Verify `GET /kanban/board` returns `priorityStarred: 1` for the starred plan.

---

**Recommendation:** Complexity 3 → Send to Intern.

---

## Implementation Summary

Implemented the first-class `PUT /kanban/plans/priority` endpoint in `src/services/LocalApiServer.ts` following the `_handleSetPlanComplexity`/`_handlePlanFieldUpdate` pattern, but as a dedicated handler (`_handleSetPlanPriority`) to support the session-id fallback that the shared field-update method lacks. The handler performs strict boolean validation (accepts `true`/`false`, `1`/`0`, `"true"`/`"false"` case-insensitively; rejects all other values with 400) to close the silent-trap class of bug where `!!"false"` would coerce to `true`. It resolves `planId` OR `sessionId` via `getPlanByPlanId` then `getPlanBySessionId`, returning 404 on no match. No `verbSchemas.ts` entry was added (the kanban verb rail never calls `validateVerbPayload`, so it would be dead code). The endpoint was documented in `.agents/skills/switchboard-orchestration/SKILL.md` §3 (table row + bash example), and `npm run catalog:generate` regenerated `protocol-catalog.json` and `src/generated/verbAllowlist.ts`; `npm run catalog:check` confirmed no drift.

## Review Findings

Three MAJOR findings, all fixed: (1) the write was keyed to the server's workspace id rather than the resolved row's, and since the plan lookups are unscoped while the UPDATE is `WHERE plan_id = ? AND workspace_id = ?` and `_persistedUpdate` returns true on zero rows changed, a plan in a DB holding more than one workspace got `200 {success:true}` for a star that never landed — the exact silent no-op this endpoint exists to close (`src/services/LocalApiServer.ts:6553`); (2) `.agents/protocols/switchboard-mission-control-http/SKILL.md` is a byte-identical live duplicate of the skill doc that was updated and self-describes as the *complete* HTTP contract for external/discussion agents — the very reader named in this plan's Problem statement — and was left stale, so half the agent surface stayed blind to the endpoint; (3) no tests were added at all, leaving the plan's Automated items 2–3 and all six Goal Invariants unimplemented while the one cited test passed identically with or without this work. Files changed: `src/services/LocalApiServer.ts`, `.agents/protocols/switchboard-mission-control-http/SKILL.md`, `src/test/card-priority-and-column-order-contract.test.js` (+6 goal-invariant checks), `src/test/plan-priority-endpoint.test.js` (new, 15 behavioural cases), `package.json`, `.github/workflows/integration-tests.yml`. Validation: `compile-tests` (tsc) clean, `catalog:check` no drift, both priority suites green, `parity/standalone-parity/standalone-fork/host-seam-parity/push-routing` all pass, eslint 0 errors; both new detectors were mutation-tested (reverting the fix turns them red). Remaining risk: the plan's Manual steps 1–8 could not be run — the live host on port 52924 serves the installed VSIX build and returns 404 for the new route until the extension is rebuilt and reloaded.

## Deferred Findings

- NIT — Plan self-contradiction on `starred: "false"`: the Verification Plan (Automated item 3, Manual step 6) demands a 400, while the authoritative "Replaced with" block, the Proposed Changes code, and the shipped SKILL.md row all accept `"true"`/`"false"` case-insensitively. The implementation follows the code/doc, which is the coherent reading — refusing `"false"` while accepting `"true"` would treat one type two ways. Pinned by test; no code change. `.switchboard/plans/feature_plan_20260827164701_agent-reachable-priority-starring.md:1`
- NIT — A failed write returns `500 {success:false, planId, starred}` with no `error` key, unlike every other error path on this endpoint, so a caller branching on `error` sees nothing to report. `src/services/LocalApiServer.ts:6555`
- MAJOR (pre-existing, out of scope) — `KanbanProvider.setPriorityStarred` keys its write to the DB-level workspace id rather than the resolved row's, the same defect fixed in the endpoint; the webview star has the same hollow-success exposure on a multi-workspace DB. `src/services/KanbanProvider.ts:8703`
- NIT (pre-existing, shared with the provider) — `getPlanByPlanId`/`getPlanBySessionId` fall back to the cold archive and restore on access, so a star write can silently rehydrate an archived plan; and when `restoreToHot` fails they return the archive record, whose row is absent from the hot store, re-opening the zero-row hollow-success path. `src/services/KanbanDatabase.ts:5192`
- MAJOR (pre-existing, out of scope) — `test:contract:task-complete` and several other LocalApiServer endpoint suites are defined in `package.json` but invoked by no CI step: defined-but-ungated is the green-while-incomplete hole. `package.json:1029`
- MAJOR (pre-existing, untouched by this work) — `test:contract:skill-preconditions` is red at HEAD with 5 failures, all in `query-kanban/SKILL.md` and `kanban-operations/SKILL.md`. Already covered by the red-gate triage plan. `src/test/skill-preconditions-contract.test.js:144`
- NIT — The API write triggers no board refresh or WS push, so a star set by an agent appears only on the board's next poll. Explicitly accepted by the plan's Edge-Case audit; noted so it is not rediscovered as a bug. `src/services/LocalApiServer.ts:6555`
