# POST /kanban/move is unwired in the standalone host, so every remote card move fails 503 and the only recovery path is a raw DB write

## Goal

Make `POST /kanban/move` work on the standalone/npx host, and reduce card moves to **exactly
one path** by deleting `move-card.js`'s direct-DB fallback. After this plan, moving a card from
the command console, the CLI, or an agent script behaves identically on both hosts, and a move
that cannot go through the board's own code does not happen at all.

### Problem analysis

On a running standalone host, every card move over HTTP fails:

```
$ curl -s -X POST "http://127.0.0.1:7777/kanban/move" \
    -d '{"planId":"fbae8502-…","targetColumn":"CREATED"}'
{"error":"Kanban move not available"}
```

`GET /health` confirms the host is the standalone CLI (`dist/standalone/cli.js tailnet`), and
`/kanban/move` **is** listed in `GET /catalog` — so the route exists and answers; only its
dependency is missing. Reads (`/kanban/board`, `/kanban/columns`, `/kanban/plan`) all work,
which is what makes the gap invisible until something writes.

Three observed consequences:

1. **The command console's Move view is dead.** `src/webview/command.js:1461` POSTs
   `/kanban/move`, gets a non-OK response, and lands in the `else` arm at `:1475-1480`:
   the optimistic `pendingMoves` entry is rolled back and the chip reads "Move failed on
   server". The operator is told the *server* rejected the move, not that this host cannot
   move cards at all. With the advance path dead, the only working action button on the
   surface is DISPATCH — which starts a coding agent (see
   `command-console-dispatch-reads-as-an-advance.md`).
2. **`move-card.js` fails, and it is right to.** The script exits 1 at
   `.agents/skills/kanban_operations/move-card.js:184-197` rather than reaching its
   direct-DB path, which is gated on the server being *unreachable*. That gate did its job:
   it surfaced a wiring defect instead of papering over it.
3. **The direct-DB fallback should not exist.** It is a second move path with weaker
   guarantees — no integration-sync fan-out, no board refresh — whose result is
   *indistinguishable* from a real move once written. That is the `CLAUDE.md` fallback rule
   violated at the level of a whole code path: nothing afterwards can answer "did this move
   reach the tracker?". It also contradicts two of this repo's own rules — that agents move
   cards through "the API path a human's click takes", never SQL — while being exactly a SQL
   move wearing a helper script's clothes. Widening it to cover the 503 (the obvious
   reading of this bug) would make every future unwired seam survivable and silent.

### Root cause

`moveCard` is an **optional callback on the options object** handed to the shared
`LocalApiServer`, and only one of the two composition roots sets it.

- Declared optional: `src/services/LocalApiServer.ts:226-232`.
- Handler early-returns 503 when absent: `src/services/LocalApiServer.ts:4024-4028`.
- Wired by the extension: `src/services/TaskViewerProvider.ts:3997-4030`, delegating to
  `this._kanbanProvider.moveCardToColumnWithReason(...)`.
- **Not wired by standalone:** the options object built at `src/standalone/bootstrap.ts:3592`
  never sets `moveCard`.

This is exactly the composition-root trap named in `CLAUDE.md`: a service seam on an options
object where "never wired" and "working" are the same value — `undefined`. No gate catches it.
The verb-reachability audit comes back green because `bootstrap.ts`'s `default:` arm answers
the verb; the route is in `/catalog`; the handler compiles; the type is `?`-optional so the
omission is legal TypeScript.

Two details make the gap look deliberate rather than accidental, and both are wrong:

- **The docblock at `LocalApiServer.ts:219-225` says the callback exists to reach "the
  integration token, which lives in VS Code secret storage" and is "absent in headless/test
  harnesses."** Read literally, that presents standalone as a host that *should* not have it.
  But standalone constructs the same `KanbanProvider` class
  (`src/standalone/bootstrap.ts:1188`), so `moveCardToColumnWithReason` — cascade and all —
  is available there. The docblock is a stale claim about a shipped seam, not a design
  constraint.
- **The neighbouring auto-dispatch seam *is* wired in both roots** —
  `resolveAutoDispatchColumn` at `src/standalone/bootstrap.ts:3347-3348` and
  `src/services/TaskViewerProvider.ts:3985-3989`. So the standalone options object already
  delegates column decisions to its provider; `moveCard` was simply skipped.

## Metadata

- **Complexity:** 3
- **Tags:** backend, reliability, bugfix

## Complexity Audit (Routine vs Complex/Risky)

**Routine.** The provider method already exists, is already used by the extension for the
identical purpose, and the standalone root already holds a `KanbanProvider` instance and
already delegates a sibling seam to it. The change is wiring plus two error-path corrections.

**The one risky edge** is the plan-file/sessionId resolution the extension does inline before
calling the provider (`TaskViewerProvider.ts:4007-4019`): a caller may address a card by plan
file path, plan id, or legacy session id. Duplicating that logic by hand in `bootstrap.ts` is
how the two roots drift a second time, so it is extracted to a shared helper rather than
copied.

## Edge-Case & Dependency Audit

- **Feature cards must still cascade.** `moveCardToColumnWithReason` owns the
  feature→subtask cascade; calling it (not the DB) preserves that on standalone.
- **Key shapes.** The route accepts `sessionId` *or* `planId`, and `move-card.js` may pass a
  plan-file path as the key. The shared helper must resolve all three, exactly as the
  extension does today.
- **Batch moves.** The console selects multiple cards (see
  `command-console-dispatch-reads-as-an-advance.md`), so `/kanban/move` should accept `planIds[]`
  alongside today's single `planId` and move them under one call — the board's `moveSelected`
  already takes an array of ids. Keep the single-id form working for existing callers, and have
  the response report the count so a partial batch cannot read as a full one.
- **`workspaceRoot` contract is unchanged.** The route's documented omitted-vs-supplied
  search behaviour (`LocalApiServer.ts:4005-4016`) lives above the seam and is untouched.
- **Integration sync on standalone.** Standalone has no VS Code secret storage. Where no
  integration token is reachable, the move must still succeed locally and report that
  external sync did not run — it must not silently claim a synced move, and it must not fail
  the local move because sync was unavailable.
- **No new fallback that hides a failure.** The 503 body must name the host and the missing
  seam so an unwired root is diagnosable from the response alone, rather than reading as a
  transient outage.
- **One path, no second semantics.** After this change `move-card.js` has a single outcome
  shape: the API moved the card, or nothing moved and the reason is printed. "Did this move
  sync to the tracker?" stops being a question, because there is no path where the answer is
  no. A host that is not running is a host to start, not a reason to write its database
  behind its back.
- **Depends on:** nothing. This plan unblocks the Move-view half of
  `command-console-dispatch-reads-as-an-advance.md`.

## Proposed Changes

### 1. `src/services/kanbanMoveTarget.ts` (new) — one resolution, both roots

Extract the extension's inline key resolution so neither root hand-rolls it.

```ts
// Resolve a caller-supplied move key (plan file path | plan id | legacy session id)
// to the sessionId the provider expects, plus the plan file to re-stamp afterwards.
export async function resolveMoveTarget(
    key: string,
    planFile: string | undefined,
    getDb: () => Promise<{ ensureReady(): Promise<boolean>; getWorkspaceId(): Promise<string>;
                           getDominantWorkspaceId(): Promise<string>;
                           getPlanByPlanFile(f: string, wsId: string): Promise<any>; } | undefined>
): Promise<{ sessionId: string; planFile?: string }> {
    if (!(key.includes('/') || key.endsWith('.md'))) {
        return { sessionId: key, planFile };
    }
    const db = await getDb();
    if (db && await db.ensureReady()) {
        const wsId = await db.getWorkspaceId() || await db.getDominantWorkspaceId() || '';
        const plan = await db.getPlanByPlanFile(key, wsId);
        if (plan) return { sessionId: plan.sessionId || plan.planId, planFile: key };
    }
    return { sessionId: key, planFile: key };
}
```

### 2. `src/standalone/bootstrap.ts` — wire the seam (next to `resolveAutoDispatchColumn`, ~line 3347)

```ts
moveCard: async (wsRoot: string, key: string, targetColumn: string, planFile?: string) => {
    const target = await resolveMoveTarget(key, planFile, () => getKanbanDb(wsRoot));
    const outcome = await kanbanProvider.moveCardToColumnWithReason(
        wsRoot, target.sessionId, targetColumn
    );
    if (!outcome.ok) {
        return { success: false, error: outcome.detail, reason: outcome.reason };
    }
    if (target.planFile) {
        const db = await getKanbanDb(wsRoot);
        if (db && await db.ensureReady()) {
            await db.updatePlanFile(target.sessionId, target.planFile);
        }
    }
    return { success: true };
},
```

### 3. `src/services/TaskViewerProvider.ts:3997-4030` — call the shared helper

Replace the inline resolution block with `resolveMoveTarget(...)`. Behaviour is unchanged;
the point is that the two roots now share one implementation.

### 4. `src/services/LocalApiServer.ts` — correct the docblock, make the 503 diagnosable

- `:219-225` — drop the "absent in headless harnesses" framing and the secret-storage
  rationale for *omitting* it; state that both hosts wire it and that external sync is
  best-effort per host.
- `:4024-4028` — name the seam and the host:

```ts
res.end(JSON.stringify({
    error: 'Kanban move not available: the moveCard seam is not wired in this host\'s '
         + 'composition root. Reads work; writes do not. This is a wiring defect, not an outage.',
    seam: 'moveCard'
}));
```

### 5. `.agents/skills/kanban_operations/move-card.js` — delete the direct-DB fallback

Remove `viaDirectDb()` entirely (and the `out/services/KanbanDatabase` require it needs), so the
script has one path and one outcome shape:

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

Update the skill's own docs (`.agents/skills/kanban_operations/SKILL.md`, the two-path preamble
at the top of the script) to describe one path. Both mirrors of the skill must move together —
`.claude/skills/` is generated from `.agents/`.

## Verification Plan

**Standalone host** (`node dist/standalone/cli.js tailnet --no-open`):
1. `POST /kanban/move` with `{planId, targetColumn}` returns `{success:true}`; the card's
   column changes in `GET /kanban/plan?planId=…`.
2. Move a **feature** card; every subtask cascades to the same column.
3. Command console → Move view: pick a card, pick a column, press MOVE — the chip settles to
   "Moved to <column>" and the optimistic move is not rolled back.
4. `node .agents/skills/kanban_operations/move-card.js <plan.md> CREATED` prints `OK`, and
   the move is visible in `GET /kanban/plan` — one path, one outcome.
5. `POST /kanban/move` with `planIds: [a, b, c]` moves all three and reports `count: 3`; the
   single-`planId` form still moves one. Move view with three cards selected moves all three.

**Extension host** (installed VSIX):
6. Repeat 1–5 — all still pass, proving the shared-helper refactor did not regress the
   working root.

**Both roots, the audit that would have caught this:**
7. Diff the two options objects (`TaskViewerProvider.ts:3889…` vs `bootstrap.ts:3592…`) and
   assert every optional callback declared in `LocalApiServerOptions` is either set in both
   or explicitly justified in a comment naming the other root.
8. Regression: with the seam deliberately unset, `POST /kanban/move` returns the new 503 body
   naming `moveCard`, and `move-card.js` exits 1 printing that error — it must **not** succeed
   by another route.
9. With no host running at all, `move-card.js` exits 1 telling the operator to start the board,
   and the kanban DB is byte-identical afterwards (`md5sum` before/after).

**User Review Required:** None.
