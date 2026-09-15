# Standing-Order Fragment Bodies Belong in the Store, Like Every Other Control-Plane Document

## Goal

The text an agent is told lives in one place. Standing-order fragment **bodies** move into
`control_plane` alongside protocols, skills, workflows, personas and rules — versioned,
content-hashed, and overridable per workspace — instead of being TypeScript constants that need a
rebuild to change.

### Problem analysis

**Three kinds of system-authored text, three different homes, and only one has a stated reason.**

| Text | Where it lives today | Changeable without a rebuild? |
| :--- | :--- | :--- |
| Protocols, skills, workflows, personas, rules | **`control_plane`** table — `name, kind, version, content_hash, body, delivery, override_body, workspace_override` | yes |
| **Standing-order fragments** | **`src/services/standingOrderFragments.ts`** — 315 lines of constants | **no** |
| A composed standing order | nowhere — built at delivery from the fragments | n/a |

**Operator, 2026-09-14:** *"why not keep them in db like protocols. where else would they be kept."*

The third row is correct and settled: a composed order names this team and this seat, so persisting it
stores a snapshot that goes stale the moment the roster changes. That is the *"editing or replacing
them loses critical detail"* failure, and `standing-orders-additive-contract.test.js` invariant 4
already pins it — *"system protocol is composed at delivery, never persisted."*

The **second row has no such justification**. A fragment is a template. It contains no live state. It
is as static as a protocol document and it sits in source anyway.

**Why it cannot simply be moved, and this is the real constraint.** A fragment is not text — it is an
object carrying executable logic:

```ts
{ id: 'team.member.work', name: 'Team member work', order: 20, obligation: 'work',
  applies: ctx => ctx.inTeam && !ctx.isHead && !ctx.externalHead,        // predicate
  body:    ctx => ctx.headRole === 'lead' ? `Work your assigned subtask…` : '' }  // builder
```

`control_plane.body` is `TEXT`. A predicate cannot go in a text column without inventing an
interpreter, and inventing one to store twelve fragments is a worse outcome than leaving them in
source.

**So the split is between a fragment's parts, not between fragments.** Some bodies are already plain
constants — `TEAM_HEAD_COMMIT_FRAGMENT_BODY` (`:70`) and `GLOBAL_QUEUE_COMPLETION_FRAGMENT_BODY`
(`:250`) are exported as strings with no context argument. Those are indistinguishable from a protocol
document and can move today. Others are builders and must stay.

> **Superseded:** "Some bodies are already plain constants — `TEAM_HEAD_COMMIT_FRAGMENT_BODY` (`:70`) and `GLOBAL_QUEUE_COMPLETION_FRAGMENT_BODY` (`:250`) are exported as strings with no context argument. Those are indistinguishable from a protocol document and can move today. Others are builders and must stay."
> **Reason:** The census was undercounted and the "plain string constant" criterion was self-defeating. The `StandingOrderFragment.body` field is typed `(ctx: StandingOrderCompositionContext) => string` (`standingOrderFragments.ts:52`) — a function — so NO fragment has a plain-string body *by type*. The plan's own mechanical check ("verified by type rather than by eye") would yield zero fragments. The real criterion is semantic: a body that does not reference `ctx` returns the same string on every call, so its text is store-eligible. By that criterion **five** of the twelve fragments qualify, not two: `gitSafety` (`() => GIT_SAFETY_DIRECTIVE`), `reviewHead` (`() => REVIEW_HEAD_WORK`), `headCommit` (`() => TEAM_HEAD_COMMIT_FRAGMENT_BODY`), `orchestratorReport` (`() => 'When blocked…'`), and `globalCompletion` (`() => GLOBAL_QUEUE_COMPLETION_FRAGMENT_BODY`). The original count of "two" only saw the separately-**exported** string constants and missed the three whose bodies are `() => CONST` wrappers around non-exported or imported constants.
> **Replaced with:** The static/dynamic split is defined as "body does not reference `ctx`," verified by a mechanical check that rejects any `body` whose function body reads `ctx` (AST/text scan, see Proposed Changes §1). Five fragments move; seven stay. The plan's "if only two move, stop" gate is correspondingly superseded — the threshold is met by five.

**And the override mechanism already exists.** `control_plane` carries `override_body` and
`workspace_override`. A fragment body in the store inherits per-workspace override for free — which is
the capability an operator actually wants and cannot have while the text is a compiled constant.

### Root cause

Fragments were introduced as a refactor of prompt-building code, so they landed where prompt-building
code lives. The control-plane store arrived later and took the documents that were already documents.
Nothing revisited the fragments, because from the code's point of view they are functions, and from
the operator's point of view they are text — and only the operator's view makes the inconsistency
visible.

### Non-goals

- **Persisting composed orders.** Settled and correct: composed at delivery, never stored.
- **Storing predicates or builders.** `applies` and function-valued `body` stay in source. No
  interpreter, no expression language, no sandbox.
- **Changing the additive model.** Core composes at delivery, add-ons persist as human-authored rows.
  This moves where core *text* is authored, not who may replace it.
- **Editing fragments from the UI.** The Orders tab is read-only
  (`add-an-orders-tab-to-agent-control.md`). Store-backed does not mean operator-editable.

## Metadata

**Tags:** control-plane, standing-orders, storage, standalone
**Complexity:** 6

## User Review Required

**Which fragments move?** Asserted: only those whose `body` does not reference `ctx` — verified by a
mechanical check, not by eye. A fragment whose body reads `ctx` stays in source, and the split must be
enforced by a check, not a convention — otherwise the next fragment authored as a constant lands in
source because that is where its neighbours are.

Twelve fragment ids exist today (`STANDING_ORDER_FRAGMENT_IDS`, `standingOrderFragments.ts:55-68`).
The static/dynamic census is a prerequisite, not a detail: the corrected census is **five static,
seven dynamic** (see Proposed Changes §1 for the per-fragment table). Five clears the plan's
worth-doing threshold.

## Complexity Audit

### Routine
- Adding five `control_plane` rows of a new `kind: 'standing-order-fragment'` at seed time — same
  `seedControlPlane` path protocols already use (`KanbanDatabase.ts:7306`).
- Computing `content_hash` over the body text — same `crypto.createHash('sha256')` every other row
  uses (`ClaudeCodeMirrorService.ts:229`).
- Exporting three currently non-exported constants (`REVIEW_HEAD_WORK`, the `orchestratorReport`
  inline literal, and confirming `GIT_SAFETY_DIRECTIVE` is already exported from
  `agentPromptBuilder.ts:768`) so a seed table can reference them.

### Complex / Risky
- **Sync/async seam.** The entire composition→delivery path is synchronous:
  `composeStandingOrderFragments` (`standingOrderFragments.ts:301`) →
  `resolveStandingOrderInstruction` (`standingOrders.ts:647`) →
  `renderStandaloneOrdersBlock` (`standingOrders.ts:707`) →
  `applyStandingOrders` (`standingOrders.ts:773`). `getControlPlaneEntry`
  (`KanbanDatabase.ts:7244`) is `async`. A live store read cannot be inserted into the sync path
  without making the whole chain async (rippling through every caller and ~25 test call sites).
  Resolution: an in-memory cache of static bodies, pre-resolved at the async delivery seam and
  threaded in via the existing `options` object — see Proposed Changes §3.
- **Projection pollution.** `projectControlPlane` (`ClaudeCodeMirrorService.ts:318-369`) writes
  every non-`doc`, non-`protocol` kind to `.agents/<name>`. A `standing-order-fragment` row named
  `team.head.commit` would be projected as a junk file `.agents/team.head.commit`. An explicit skip
  is required — see Proposed Changes §4.
- **"No restart" invariant vs. cache freshness.** An operator's `override_body` edit must reach the
  next delivered prompt without a restart. A static cache defeats this unless it refreshes. The cache
  must be invalidated/reloaded on `setControlPlaneOverride` (`KanbanDatabase.ts:7297`) and on
  `upsertControlPlaneEntry` for fragment-kind rows.
- **Additive-contract test invariant 2.** `standing-orders-additive-contract.test.js:8-10` states
  "Editing a fragment body in src/ changes what an already-started team is told." After this change,
  a src edit to a *moved* static body is no longer the live source — the store is. The test's
  *executed* assertions (line 251) check a dynamic fragment (`memberCompletion`), so they still pass,
  but the stated invariant must be reconciled to "the live source for a moved fragment is the store,
  not src."

## Edge-Case & Dependency Audit

### Race Conditions
- **Cache load vs. first delivery.** If the cache is populated lazily on first delivery, the first
  prompt after host start may resolve from the compiled default before the store read completes. The
  cache must be warmed at startup (after `seedControlPlaneFromBundle`, `bootstrap.ts:878`) so the
  first delivery already sees store-backed bodies.
- **Override write vs. in-flight delivery.** An operator sets `override_body` while a prompt is
  mid-composition. The cache refresh is a single assignment (atomic in Node's single-threaded event
  loop), so a prompt either sees the old or the new body — never a torn read. Acceptable.

### Security
- `override_body` on a fragment row is operator-authored text delivered into agent prompts. This is
  the same trust boundary every other `control_plane` override already crosses — no new surface.

### Side Effects
- `projectControlPlane` runs on every host start (`bootstrap.ts:879`). Without the skip in §4, it
  creates stray files in `.agents/` on every launch — a persistent workspace-pollution side effect.

### Dependencies & Conflicts
- Depends on the existing `control_plane` table (V68/V69 migrations, `KanbanDatabase.ts:1024-1043`)
  — no schema change needed; `kind` is `TEXT`, not an enum.
- Conflicts with `projectControlPlane`'s "write everything to `.agents/`" default — must be patched
  in the same change.
- The `<cliPath>` token: `GLOBAL_QUEUE_COMPLETION_FRAGMENT_BODY` carries `node "<cliPath>" done`.
  `substituteCliPath` runs on the final block (`standingOrders.ts:758, 808, 810`), so store-backed
  bodies still receive substitution. A store body is plain text, so the token survives the move
  unchanged. Note for future maintainers: do not move `substituteCliPath` upstream of the store read.

## Dependencies

- `sess_20260914_standing_orders_store` — operator decision to move fragment bodies into `control_plane`.

## Adversarial Synthesis

Key risks: (1) the sync composition path cannot call the async store, so a naive "registry reads the
store" silently falls back to the compiled default and the live-edit capability the plan exists for is
never wired; (2) `projectControlPlane` writes the new kind as junk files into `.agents/`; (3) the
"no restart" invariant is unmet if the cache isn't invalidated on override writes. Mitigations: an
in-memory cache warmed at startup and invalidated on every fragment-kind `override_body`/`upsert`,
threaded into the sync path via the existing `options` object; an explicit projection skip for the
new kind.

## Proposed Changes

### 1. `src/services/standingOrderFragments.ts` — census + static/dynamic split

Add a mechanical census that classifies each fragment as `static` (body does not reference `ctx`) or
`dynamic` (body reads `ctx`). The check is a text/AST scan of the `body` function source: if the
function body references the `ctx` parameter, it is dynamic; otherwise static.

Per-fragment census (verified against `standingOrderFragments.ts:257-293`):

| # | id | body | references `ctx`? | class |
|---|---|---|---|---|
| 1 | `team.member.completion` | `buildMemberCompletionFragment` | yes (`ctx.teamId`, `ctx.headName`) | dynamic |
| 2 | `team.member.work` | `ctx => ctx.headRole === 'lead' ? …` | yes | dynamic |
| 3 | `team.external-member.callback` | `ctx => \`${ctx.headName}…\`` | yes | dynamic |
| 4 | `team.git-safety` | `() => GIT_SAFETY_DIRECTIVE` | no | **static** |
| 5 | `seat.subagent-policy` | `ctx => ctx.subagentPolicy === …` | yes | dynamic |
| 6 | `team.coding-head.work` | `ctx => ctx.hasRegisteredRounds ? …` | yes | dynamic |
| 7 | `team.review-head.work` | `() => REVIEW_HEAD_WORK` | no | **static** |
| 8 | `team.head.commit` | `() => TEAM_HEAD_COMMIT_FRAGMENT_BODY` | no | **static** |
| 9 | `team.head.completion` | `buildHeadCompletionFragment` | yes (`ctx.hasRegisteredRounds`) | dynamic |
| 10 | `team.head.next` | `buildHeadNextFragment` | yes (`ctx.teamId`) | dynamic |
| 11 | `team.head.orchestrator-report` | `() => 'When blocked…'` | no | **static** |
| 12 | `global.queue.completion` | `() => GLOBAL_QUEUE_COMPLETION_FRAGMENT_BODY` | no | **static** |

Export a `STATIC_STANDING_ORDER_FRAGMENT_IDS` set and a `isStaticFragment(id)` helper. The contract
test (§Verification) asserts this set matches the actual `body` source scan, so a future fragment
authored as `() => someConst` is automatically store-eligible and a fragment that starts reading `ctx`
is automatically removed.

- **Context:** `standingOrderFragments.ts:46-53` defines `StandingOrderFragment` with
  `body: (ctx) => string`. The interface stays unchanged — a static fragment's `body` becomes a
  resolver that reads the cached store body (see §3), so the type still holds.
- **Logic:** the census is derived, not hand-maintained. A `STATIC_FRAGMENT_BODIES` record maps each
  static id to its compiled-default string (the current `() => CONST` return value), used both as the
  seed source and as the sync fallback.
- **Implementation:** export `REVIEW_HEAD_WORK` (currently a local `const` at `:237`) and lift the
  `orchestratorReport` inline literal (`:291`) into a named exported constant so the seed table can
  reference them. `GIT_SAFETY_DIRECTIVE` is already exported (`agentPromptBuilder.ts:768`).
- **Edge Cases:** a fragment whose body is `() => ''` (empty) would classify as static; none exist
  today, but the contract test should not treat empty as a reason to skip seeding (an empty body is a
  valid store row that suppresses the fragment).

### 2. `src/services/standingOrderFragments.ts` — seed table + `kind: 'standing-order-fragment'`

Add a `BUNDLED_STANDING_ORDER_FRAGMENTS` record (mirroring `BUNDLED_PROTOCOLS` in
`bundledProtocols.ts`) keyed by fragment id, each entry carrying `{ name, body, version, contentHash }`.
The `contentHash` is `sha256(body)` computed at module load, same as
`ClaudeCodeMirrorService.ts:229`.

- **Context:** `seedControlPlaneFromBundle` (`ClaudeCodeMirrorService.ts:211`) already calls
  `ProtocolService.seedProtocols(db)` after scanning `.agents/` (`:278`). A parallel
  `seedStandingOrderFragments(db)` call is added there, OR the fragment entries are appended to the
  same `entries` array with `kind: 'standing-order-fragment'`.
- **Logic:** `seedControlPlane` (`KanbanDatabase.ts:7306`) already preserves `override_body` across
  re-seeds (`:7316-7320`), so an operator's override survives an upgrade that re-seeds — matching the
  plan's invariant 4.
- **Edge Cases:** the seed must be idempotent and must not clobber an existing `override_body`. The
  existing `seedControlPlane` logic already handles this; no new code needed beyond building the
  entries.

### 3. `src/services/standingOrderFragments.ts` + `standingOrders.ts` — in-memory cache threaded via `options`

This is the load-bearing change. The composition path is synchronous; the store is async. The
resolution is an in-memory cache of static bodies, populated at startup and invalidated on write,
threaded into the sync path through the existing `StandingOrderRenderOptions`
(`standingOrders.ts:537-560`).

- **Context:** `composeStandingOrderFragments` (`standingOrderFragments.ts:301`) calls
  `fragment.body(ctx)` synchronously. For a static fragment, `body` becomes a closure over the cache:
  `body: () => cachedBodies[id] ?? COMPILED_DEFAULTS[id]`. The cache is a module-level `Map<string,
  { body: string; source: 'store' | 'compiled-default' }>` populated by an async `loadStaticFragmentBodies(db)`.
- **Logic:**
  1. `loadStaticFragmentBodies(db)` reads every `kind: 'standing-order-fragment'` row via
     `getControlPlaneEntry` and populates the cache. For each id: if the row has `overrideBody`, use
     it with `source: 'store'`; else use `body` with `source: 'store'`; if no row, leave the cache
     entry absent (the `body` closure falls back to `COMPILED_DEFAULTS[id]` with `source:
     'compiled-default'`).
  2. The cache is warmed at startup, after `seedControlPlaneFromBundle` (`bootstrap.ts:878`), in the
     standalone root. (Per `CLAUDE.md` 2026-09-14, the extension host is being removed; no
     extension-specific wiring.)
  3. `setControlPlaneOverride` (`KanbanDatabase.ts:7297`) and `upsertControlPlaneEntry`
     (`KanbanDatabase.ts:7270`) for `kind: 'standing-order-fragment'` invalidate the cache entry (or
     reload it). This is the seam that satisfies "no restart."
  4. `composeStandingOrderFragments` records, per static fragment, whether the body came from the
     cache (`store`) or the compiled default (`compiled-default`) — returned alongside `text`/
     `unknown`/`applied` as a new `sources: Record<string, 'store' | 'compiled-default'>` field, and
     logged by the caller. This satisfies the repo's fallback rule ("records which source answered").
- **Implementation:** the `body` closure for static fragments reads the cache synchronously — no async
  in the composition path. The cache is a `Map`, assignment is atomic in Node's event loop, so
  in-flight deliveries see a consistent snapshot.
- **Edge Cases:** if `loadStaticFragmentBodies` fails (DB not ready), the cache stays empty and every
  static fragment falls back to its compiled default with `source: 'compiled-default'` — a visible,
  safe degradation (the fragment still delivers; the log says why). This is the "visible or safe"
  default the repo's fallback rule requires.

### 4. `src/services/ClaudeCodeMirrorService.ts` — projection skip

- **Context:** `projectControlPlane` (`ClaudeCodeMirrorService.ts:318-369`) writes every entry to
  disk. The `else` branch (`:332-334`) writes `kind !== 'doc' && kind !== 'protocol'` to
  `.agents/<name>`.
- **Logic:** add an explicit `else if (entry.kind === 'standing-order-fragment') { continue; }` before
  the final `else`, mirroring the protocol skip at `:326-328`. Fragment bodies are consumed by the
  registry at delivery, not projected to the workspace filesystem.
- **Edge Cases:** the `.switchboard-bundled.json` ledger (`:378`) filters `kind !== 'doc'`; fragment
  rows would appear in the ledger's `files` list. Either filter them out too, or accept them in the
  ledger (they are registry entries, not files — filtering is cleaner).

### 5. `src/standalone/bootstrap.ts` — warm the cache

- **Context:** after `seedControlPlaneFromBundle` (`bootstrap.ts:878`), call
  `loadStaticFragmentBodies(db)` to warm the cache before the first delivery.
- **Logic:** the warm is a fire-and-forget `Promise` that logs on failure; a delivery that races the
  warm falls back to compiled defaults (safe). Once the warm resolves, subsequent deliveries read the
  cache.
- **Edge Cases:** if the host restarts with a corrupt `control_plane` row (body is `NULL` or empty),
  `getControlPlaneEntry` returns the row but the body is empty; the cache stores the empty string and
  the fragment delivers nothing. This is the same behaviour as a protocol with an empty body —
  acceptable, and logged.

## Verification Plan

### Automated Tests

- **Contract (census gate)** — assert the `STATIC_STANDING_ORDER_FRAGMENT_IDS` set matches a live
  scan of every fragment's `body` source for `ctx` references. The split is mechanically enforced: a
  fragment whose body starts reading `ctx` is removed from the static set by the scan, not by a human.
- **Contract** — a static fragment body edited in `control_plane` (via `override_body` or a direct
  row update) reaches the next delivered prompt with no rebuild and no restart. This is the capability
  the plan exists for. The test must exercise the REAL sync delivery path
  (`renderStandaloneOrdersBlock`), not a direct store read — otherwise it proves the store is readable,
  not that the delivery path uses it.
- **Contract** — with no store row, the compiled constant is used and the resolution logs
  `source: 'compiled-default'`.
- **Contract** — `override_body` on a fragment row wins over the seeded body, and the override
  survives an upgrade that re-seeds (re-seed does not clobber `override_body`).
- **Contract** — `standing-orders-additive-contract` still passes. Moving where core text is authored
  must not alter the additive model or start persisting composed orders. Reconcile the test's stated
  invariant 2 ("Editing a fragment body in src/…") to "the live source for a moved static fragment is
  the store"; the executed assertions (which test a dynamic fragment) are unchanged.
- **Contract** — `projectControlPlane` does not write any `kind: 'standing-order-fragment'` row to
  `.agents/`. Assert no file exists at `.agents/team.head.commit` (or any static fragment id) after
  projection.

Run `npm run compile-tests` before any `test:contract:*` script.

> **Note (this run):** compilation and automated tests were not executed for this review pass, per
> session directives. The checks above remain the verification contract for the implementing coder.

### Goal Invariants

1. A static fragment body is changeable without a rebuild — assert that editing a `kind:
   'standing-order-fragment'` row's `override_body` in `control_plane` changes the next
   `renderStandaloneOrdersBlock` output for a seat that fragment applies to, with no recompile.
2. A dynamic fragment stays in source, and nothing can put one in the store — assert no
   `kind: 'standing-order-fragment'` row exists whose id is in the dynamic set (the census gate).
3. Every static fragment resolution records whether it came from the store or the compiled default —
   assert `composeStandingOrderFragments` returns a `sources` map and that a delivery with no store
   row logs `source: 'compiled-default'` while one with a row logs `source: 'store'`.
4. Composed orders remain unpersisted, and add-ons remain the only human-authored rows — assert
   `standing-orders-additive-contract` invariant 4 still holds (no system-authored row persisted after
   a team start). Paired positive: assert the five static fragment bodies ARE resolvable from
   `control_plane` after seeding.
5. (Negative, paired with 4) No `kind: 'standing-order-fragment'` row is projected to `.agents/` —
   assert the projection skip.

## Uncertain Assumptions

None. All uncertainties encountered during review (the sync/async composition path, the projection
behaviour, the seeding mechanism, the additive-contract test scope, the `<cliPath>` substitution
ordering) were resolved by reading the code — they are bucket-2 (code-answerable) and recorded in the
Proposed Changes above. No external, code-unanswerable assumption remains, so no web-research prompt is
needed.

---

**Recommendation:** Complexity 6 → Send to Coder.

---

## Implementation Summary

Implemented all five proposed changes. Five static fragment bodies (`gitSafety`, `reviewHead`, `headCommit`, `orchestratorReport`, `globalCompletion`) now live in the `control_plane` store as `kind: 'standing-order-fragment'` rows, seeded at startup alongside protocols. An in-memory cache (module-level `Map` in `standingOrderFragments.ts`) is warmed after `seedControlPlaneFromBundle` in `bootstrap.ts` and invalidated+reloaded on every fragment-kind `override_body`/`upsert` write in `KanbanDatabase.ts`, so an operator's override reaches the next delivered prompt with no rebuild and no restart. The sync composition path reads the cache via `resolveStaticFragmentBody` closures — no async in the delivery path. `composeStandingOrderFragments` returns a `sources` map (`'store'` vs `'compiled-default'`) per static fragment, logged by `resolveStandingOrderInstruction` to satisfy the repo's fallback rule. `projectControlPlane` skips the new kind to prevent junk `.agents/` files. A new contract test (`standing-order-fragment-store-contract.test.js`) covers the census gate, store-backed delivery through `renderStandaloneOrdersBlock`, compiled-default fallback, override-survives-reseed, and projection skip. The additive-contract test's invariant 2 comment was reconciled to reflect that the live source for a moved static fragment is the store, not src.

---

## Review Findings

Goal achieved: the five static bodies resolve from `control_plane` through the real sync delivery
path, and an `override_body` edit reaches the next prompt with no rebuild and no restart — verified,
not assumed, by mutating the compiled cache read in `out/` and confirming the store-backed-delivery
assertion fails. Files changed by this review: `src/services/standingOrderFragments.ts` (an empty
`override_body` was read as "unconfigured" and the compiled constant served instead — the exact quiet
fallback the repo's rule forbids, and the opposite of §1/§5; now only `NULL` falls through, via a new
`resolveStoredBody`), `src/services/teamWiring.ts` (the second composition site materialises
`member-orders.md` to disk and recorded no source), `src/test/standing-order-fragment-store-contract.test.js`
(its `test()` helper was never called, so the suite always printed `0 passed, 0 failed` and the
`failed > 0` exit gate was dead; plus new coverage that an empty override suppresses and that every
static id has a non-empty compiled default), and `.github/workflows/integration-tests.yml` (the suite
was defined in `package.json` and invoked by no workflow — the "green while incomplete" hole).
Validation: fragment-store 4/4, standing-orders-additive 9/9, `compile-tests` clean; the webpack build
was not run on this machine at the operator's instruction. Remaining risk: `GIT_SAFETY_DIRECTIVE` has
a second, un-overridable delivery channel at `agentPromptBuilder.ts:913`, so overriding
`team.git-safety` changes the standing-orders block but not the per-dispatch GIT POLICY block.

## Deferred Findings

- MAJOR `src/services/agentPromptBuilder.ts:913` — `GIT_SAFETY_DIRECTIVE` is emitted per-dispatch straight from the compiled constant, so an operator override of the `team.git-safety` row changes only one of its two delivery channels. Not fixed: routing it through the cache would make `agentPromptBuilder` import `standingOrderFragments`, which already imports `agentPromptBuilder` (import cycle), and `GIT_SAFETY_DIRECTIVE_WORKTREE_MODE` has no store row to pair with. Needs a plan of its own.
- NIT `src/services/teamWiring.ts:318` — `GLOBAL_QUEUE_DONE_ORDER_BODY` aliases the compiled constant, not the store. Referenced only by tests today, so no live divergence, but it is a latent second channel.
- NIT `src/services/teamWiring.ts:598` — `TEAM_HEAD_COMMIT_INSTRUCTION` likewise aliases the compiled constant; its docblock still claims an installer that no longer references it.
- NIT `src/services/teamWiring.ts:1502` — `member-orders.md` is a disk snapshot of composed fragments, so a later override does not reach it until the team is re-wired. Source logging was added; the staleness itself predates this plan.
- NIT `src/services/dbMerge.ts:1076` — `INSERT OR REPLACE INTO control_plane` bypasses `upsertControlPlaneEntry`, so it never invalidates the fragment cache. Harmless today because both callers run at startup (`bootstrap.ts:431`) before the warm at `:883`; it becomes a live staleness hole the moment a merge runs at runtime.
- NIT `src/services/standingOrders.ts:663` — the per-delivery `console.log` of fragment sources is unconditional, so it fires on every composed prompt even when every source is `store`.
