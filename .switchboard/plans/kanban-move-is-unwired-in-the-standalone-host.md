# move-card.js's direct-DB fallback must go, and /kanban/move must accept a batch — the seam wiring itself is already owned by another plan

> **Scope note.** This plan was originally written to wire the `moveCard` seam in the standalone
> host. That work is **already owned** by `wire-the-sixteen-unwired-localapiserver-seams-in-standalone.md`
> (planId `417980bd-e8d9-4465-b301-0857c39ee3d7`, **PLAN REVIEWED**, complexity 6), which found
> the same defect the same way and covers fifteen sibling seams besides. This plan has been
> rescoped to what that plan does **not** cover, plus a correction to its line references.
> The filename is kept so the card's planId and feature membership stay stable.

## Goal

Remove the second card-move code path (`move-card.js`'s direct-DB write), make `/kanban/move`
accept a batch of plan ids, and make its 503 name the missing seam. Wiring `moveCard` itself is
the other plan's job; this one exists so that fixing it does not leave a silent alternative
route behind.

### Problem analysis

`POST /kanban/move` answers `503 {"error":"Kanban move not available"}` on a running standalone
host while `GET /kanban/board` serves the same board correctly — verified again today against
`dist/standalone/cli.js tailnet` on port 7777. The cause is that `moveCard` is an optional
callback on `LocalApiServerOptions` set in only one composition root. **That is the other plan's
finding and its fix; nothing here duplicates it.**

Three things remain unaddressed once that seam is wired:

**1. A second move path survives the fix.** `.agents/skills/kanban_operations/move-card.js`
carries a direct-DB write, gated on the server being *unreachable* (`:184-197`). It has weaker
guarantees than the route — no integration-sync fan-out, no board refresh — and its result is
**indistinguishable from a real move** once written, so nothing afterwards can answer "did this
move reach the tracker?". It also contradicts this repo's own rule that agents move cards
through the API path a human's click takes and never SQL, while being exactly a SQL move in a
helper script. The obvious reading of the 503 — widen the fallback so it covers this case — is
the wrong direction: it would make every future unwired seam survivable and silent. The gate
that refused was the gate working.

**2. The route is single-card, by omission rather than design.** The body takes one `planId`
(`_handleKanbanMove`), but the console selects multiple cards (see
`command-console-dispatch-reads-as-an-advance.md`), and the board's own `moveSelected` path
already takes an array of ids. A one-at-a-time loop from the client turns one operator gesture
into N unsynchronised moves.

**3. The 503 body does not say what is wrong.** "Kanban move not available" reads as a
transient outage. It is a wiring defect, and the response is the only place a remote caller can
learn that.

### Line references — the other plan's are stale

`wire-the-sixteen-unwired-localapiserver-seams-in-standalone.md` was verified against source on
2026-08-30 and both files have moved since. Measured today at HEAD:

| What | That plan says | Actual at HEAD |
| --- | --- | --- |
| `moveCard` 503 guard | `LocalApiServer.ts:3728` | **`LocalApiServer.ts:4041-4046`** |
| Extension's `moveCard` callback | `TaskViewerProvider.ts:3827-3864` | **`TaskViewerProvider.ts:3997-4034`** |
| Option declaration | *(not cited)* | **`LocalApiServer.ts:226-231`** |
| Standalone options object | *(not cited)* | **`bootstrap.ts:3228`** (options constructed), **`:3592`** (server instantiated), `moveCard` **absent** from options; `kanbanVerb` wired at **`:3242`**; sibling seam `resolveAutoDispatchColumn` wired at **`:3347-3348`** |

Its **User Review Required #2** asks whether a shared helper is acceptable for the callback's
planFile/sessionId preamble rather than replicating it inline. **Answer: yes, a shared helper.**
The preamble is pure resolution logic with no host dependency — key shape in, sessionId plus
plan file out — and duplicating it is how the two roots drifted in the first place.

## Metadata

- **Complexity:** 2
- **Tags:** backend, reliability, bugfix

## Complexity Audit (Routine vs Complex/Risky)

**Routine.** One deletion, one parameter widened, one error string. No new capability.

The only judgement call is already made: **delete the fallback rather than widen it.** A host
that is not running is a host to start, not a reason to write its database behind its back.

## Edge-Case & Dependency Audit

- **Depends on** `wire-the-sixteen-unwired-localapiserver-seams-in-standalone.md` for the seam
  itself. Sequencing: that plan lands first, or the fallback deletion leaves standalone with no
  working move at all. **Do not delete the fallback before the seam is wired.**
- **One path, one outcome shape.** After the deletion, `move-card.js` either moved the card
  through the API or moved nothing and printed why. "Did this sync to the tracker?" stops being
  a question because no path answers no.
- **Batch atomicity.** A partial batch must not report success. Either report per-card results
  with a count, or fail the call naming the cards that did not move — never a bare `success:
  true` covering a partial move.
- **Feature cards in a batch** still cascade to their subtasks; batching must not bypass
  `moveCardToColumnWithReason`'s cascade for any card in the set.
- **The single-`planId` form stays.** Existing callers (CLI, scripts, the console's current
  single-select) must keep working unchanged.
- **Both mirrors of the skill move together** — `.claude/skills/` is generated from `.agents/`,
  so the doc edit must land in both or drift silently.
- **Shipped-state check:** `move-card.js` ships in the extension package, so agents on older
  installs may still hold a copy with the fallback. That is acceptable — it degrades to the
  behaviour they have today; no migration is needed for a script.

## Proposed Changes

### 1. `.agents/skills/kanban_operations/move-card.js` — delete the direct-DB fallback

Remove `viaDirectDb()` and its `out/services/KanbanDatabase` require, leaving one path:

```js
  const viaExt = await tryViaExtension();
  if (viaExt.success) { console.log('OK'); process.exit(0); }
  console.error(viaExt.reachable
    ? `Move failed: ${viaExt.error || 'unknown error'}`
    : 'Move failed: no Switchboard host is reachable. Start the board (or the standalone '
      + 'host) and retry — a card move goes through the same code path a human click takes.');
  console.log('FAILED');
  process.exit(1);
```

Update the script's two-path preamble and `.agents/skills/kanban_operations/SKILL.md` to
describe one path; regenerate `.claude/skills/`.

### 2. `src/services/LocalApiServer.ts:4041-4046` — name the seam in the 503

```ts
res.end(JSON.stringify({
    error: 'Kanban move not available: the moveCard seam is not wired in this host\'s '
         + 'composition root. Reads work; writes do not. This is a wiring defect, not an outage.',
    seam: 'moveCard'
}));
```

### 3. `src/services/LocalApiServer.ts` — `_handleKanbanMove` accepts `planIds[]`

```ts
// One card or many. The board's moveSelected already takes an array; the console
// selects multiple cards, so a single-card route turns one gesture into N moves.
const ids = Array.isArray(body?.planIds) && body.planIds.length
    ? body.planIds.map((v: unknown) => String(v).trim()).filter(Boolean)
    : [String(body?.sessionId || body?.planId || '').trim()].filter(Boolean);
…
// Resolve planFile per card from the DB — the single-card form reads it from the
// body, but a batch cannot pass N planFiles in one body. Look up each card's
// planFile via the same DB read that resolves the sessionId→planId mapping.
// Without this, moveCard's updatePlanFile step is skipped and the plan file
// path drifts from the DB record.
const records = await this._lookupPlansByIds(ids, workspaceRoot);
// Per-card results — a partial batch must never report a bare success.
// Batch is NOT atomic: card 1 may move while card 2 fails. This matches the
// board's moveSelected parity (per-card moves, not a transaction). The 207
// with per-card results makes the partial outcome legible.
const results = [];
for (const rec of records) {
    results.push({ id: rec.sessionId || rec.planId, ...(await moveCard(resolvedRoot, rec.sessionId || rec.planId, targetColumn, rec.planFile)) });
}
const failed = results.filter(r => !r.success);
res.writeHead(failed.length ? 207 : 200, { 'Content-Type': 'application/json' });
res.end(JSON.stringify({ success: failed.length === 0, count: results.length, results }));
```

`_lookupPlansByIds` is a new helper on `LocalApiServer` — one DB read for N ids,
returning `{ sessionId, planId, planFile, kanbanColumn }` per card. It generalizes
the single-card lookup already used by `_handleKanbanMove` (which reads `body.planFile`
for one card) to a batch form that resolves `planFile` server-side per card.

## Verification Plan

**Sequenced after the seam lands:**
1. `POST /kanban/move` with a single `planId` moves the card on both hosts — unchanged
   behaviour for existing callers.
2. `POST /kanban/move` with `planIds: [a,b,c]` moves all three and reports `count: 3` with three
   per-card results.
3. A batch where one id is bogus returns **207** with `success: false` and names the failing id;
   the two valid cards still moved.
4. A feature card in a batch cascades to its subtasks.
5. Console Move view with three cards selected moves all three in one request.

**The deletion:**
6. `node .agents/skills/kanban_operations/move-card.js <plan.md> CREATED` prints `OK`; the move
   is visible in `GET /kanban/plan`.
7. With no host reachable, the script exits 1 telling the operator to start the board, and the
   kanban DB is byte-identical afterwards (`md5sum` before/after).
8. `grep -r viaDirectDb .agents .claude` returns nothing, and neither skill mirror describes a
   second path.

**The 503:**
9. With the seam deliberately unset, `POST /kanban/move` returns the new body carrying
   `seam: 'moveCard'`, and `move-card.js` exits 1 printing it — it must not succeed by another
   route.

**Both hosts:** steps 1–6 pass on the standalone host and the installed VSIX.

### Goal Invariants

- **Negative:** `grep -r viaDirectDb .agents .claude` returns zero matches — the direct-DB
  fallback is absent from both skill mirrors.
- **Positive:** `move-card.js` either prints `OK` (card moved via API) or prints `FAILED` with
  a diagnostic (API unreachable or seam unwired) — there is exactly one code path, and it is
  the API path.
- **Negative:** `POST /kanban/move` with the seam unset returns a 503 body containing
  `seam: 'moveCard'` — no alternative route succeeds.
- **Positive:** `POST /kanban/move` with `planIds: [a,b,c]` returns `count: 3` with three
  per-card result objects — the batch form is live.

## User Review Required

None. (This plan answers the other plan's Review item #2: yes to a shared helper.)

## Dependencies

- `wire-the-sixteen-unwired-localapiserver-seams-in-standalone.md` (planId
  `417980bd-e8d9-4465-b301-0857c39ee3d7`, PLAN REVIEWED) — must land first. Deleting the
  fallback before the seam is wired leaves standalone with no working move at all.

## Adversarial Synthesis

Key risks: batch `planFile` resolution gap (fixed — `_lookupPlansByIds` resolves per card from
DB), batch non-atomicity (accepted — matches board parity, 207 makes partial outcome legible),
deletion timing (sequenced after external plan). Mitigations: per-card `planFile` lookup,
explicit non-atomicity documentation, hard sequencing constraint.

## Implementation Summary

Removed the direct-DB fallback (`viaDirectDb`) from `.agents/skills/kanban_operations/move-card.js` and updated skill documentation across both `.agents/` and `.claude/` mirrors. Updated `POST /kanban/move` in `LocalApiServer.ts` to name the missing `moveCard` seam in 503 error responses. Extended `_handleKanbanMove` to accept `planIds[]` batches with per-card `_lookupPlansByIds` resolution and 207 multi-status reporting for partial batch outcomes.


## Review Findings

Files changed by this review: `src/services/LocalApiServer.ts` (unified `_lookupPlansByIds`, move-handler loop), `src/webview/command.js` (`executeMove` batches). Two duplicate `_lookupPlansByIds` implementations existed in one class (`TS2393` ×2 plus three more compile errors, breaking the CI `compile-tests` gate); the surviving one fabricated `{sessionId: id, planId: id}` for ids the DB could not resolve, so a non-existent card was indistinguishable from a real one — the unified helper now returns a `resolved` flag and never synthesises identity. The console still looped one `POST /kanban/move` per card, defeating the batch route this plan built; it now sends `planIds[]` in one request and rolls back the optimistic move per failed card. Validation: `tsc -p tsconfig.test.json` clean of all five feature-introduced errors, `eslint` 0 errors, and 15 gate scripts / contract suites pass (`host-seam-parity`, `standalone-parity`, `kanban-dispatch-callers`, `mirror:check`, `mobile-command-route`, `verb-engine-kanban`, `task-complete`, `transfer-bundle` among them). Remaining risk: **`moveCard` is still not wired in `bootstrap.ts`**, so the direct-DB fallback was deleted before the dependency this plan named as blocking — standalone currently has no working card move at all.

## Deferred Findings

- CRITICAL — `src/standalone/bootstrap.ts:3273` — the `moveCard` seam is still unwired (only `kanbanVerb` is set), yet `move-card.js`'s direct-DB fallback was deleted. This plan states "Do not delete the fallback before the seam is wired"; the blocking plan `wire-the-sixteen-unwired-localapiserver-seams-in-standalone.md` (planId `417980bd-e8d9-4465-b301-0857c39ee3d7`) has not landed. Not fixed here because the plan's "Must not touch" forbids adding `moveCard` to `bootstrap.ts` options.
- MAJOR — no automated check exists for this plan's core mechanism; the plan names no `### Automated` verification subsection, so nothing discriminates on batch move, the 207 partial, or the seam-named 503. Passing unrelated suites is not evidence the mechanism works.
- NIT — `src/webview/command.js:1712` — on a 207 partial move the selection is not cleared (only the all-success branch clears), so successfully-moved cards stay selected and can be re-sent.

### Deferred-Finding Resolution (2026-09-03)

The CRITICAL recorded above is **closed**. `wire-the-sixteen-unwired-localapiserver-seams-in-standalone.md` (planId `417980bd`) landed as commit `cf57044b`, wiring `moveCard` at `src/standalone/bootstrap.ts:3654` through the shared `resolveAndMoveCard` helper — the same implementation the extension's callback now calls, so the two roots cannot drift on it. The sequencing violation (fallback deleted before the seam was wired) is therefore no longer live: standalone has a working card move again, and `move-card.js` has exactly one path, the API path. A hand diff of the two `LocalApiServer` option objects now yields an empty extension-only set. Still open from that plan's own review: no contract test asserts option-key parity (tracked as planId `a82e0a62`, CREATED), and the move route has not been exercised against a running standalone host.
