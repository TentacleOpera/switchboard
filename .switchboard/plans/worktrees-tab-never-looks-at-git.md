# The Worktrees Tab Never Looks at Git, So a Worktree It Did Not Create Is Unreachable Forever

## Goal

Reconcile the Worktrees tab against `git worktree list` so it shows what is actually on disk, and let Abandon act on a worktree that has no database row.

### The problem

A worktree created outside Switchboard — a plain `git worktree add` — is permanently invisible to the product and cannot be removed through it. Not hidden, not stale: unreachable, with no path to reachability short of hand-editing the database.

**Root cause: the tab's only source is the table.** `KanbanDatabase.ts:3908` reads

```sql
SELECT … FROM worktrees WHERE status = 'active' ORDER BY created_at DESC
```

and nothing anywhere calls `git worktree list`. There is no reconciliation in either direction — the table is never checked against git, and git is never scanned for worktrees the table does not know about. A worktree with no row therefore cannot be rendered, cannot be selected, and cannot be passed to Abandon, which is keyed on that row's id (`KanbanProvider.ts:12181`, `kanban.html:11586`).

Two failure directions, one missing pass:

* **In git, not in the table** — invisible and unmanageable. Observed: `switchboard-review-baseline`, a detached checkout from 2026-08-03. Zero rows matched its path; it survived every cleanup the product has and was only removable by hand.
* **In the table as `active`, not in git** — the inverse. Remove a worktree with `git worktree remove` and the row stays `active`, so the tab lists a directory that no longer exists and offers to abandon it.

**Verified against the source, 2026-08-17.** A repo-wide grep for `worktree list` returns zero hits in `src/` — the claim that nothing consults git is exact, not approximate. `getWorktrees()` is the sole producer for **two** consumers that matter here: `KanbanProvider._sendWorktreeConfig` (`KanbanProvider.ts:12877`, the tab's only feed) and the `GET /worktree/list` HTTP route (`LocalApiServer.ts:2781`, what fleet/orchestration agents read). Both are blind in exactly the same way.

**Residue note (2026-08-17).** The specific `switchboard-review-baseline` checkout described above has since been removed by hand — `git worktree list` on this install now returns only the main checkout. The observation stands as the report that produced this plan; the verification steps below therefore **create** an external worktree rather than assuming one is present.

**Not this plan:** the branch and feature-file residue that Abandon leaves behind. That is `abandon-worktree-leaves-a-branch-and-a-stale-feature-block.md`, and it fixes what Abandon does to rows it *can* see. This plan is about the rows it cannot. They touch the same arm and can land in either order — but **not concurrently** (see Dependencies).

## Metadata

- **Complexity:** 6
- **Tags:** bugfix, backend, ui, database, reliability
- **Project:** Browser Switchboard

## User Review Required

None.

## Complexity Audit

### Routine

- Parsing `git worktree list --porcelain` — a stable, blank-line-delimited record format.
- Adding a field to the `worktreeConfig` payload mapping in `_sendWorktreeConfig`.
- Widening one `verbSchemas.ts` field from required to optional.
- Rendering one extra label in a row that already exists.

### Complex / Risky

- **A destructive DB write driven by filesystem observation.** Tombstoning an `active` row is irreversible through the UI — there is no "un-abandon" control anywhere in the product. A transient condition (unmounted volume, control-plane child repo not yet cloned, path on external storage) that is mistaken for "gone" destroys a worktree's feature binding permanently and recreates this very bug in the opposite direction.
- **`id: null` propagates into six keying sites** in the webview and backend that all assume a number: `data-wt-id`, the status-badge match, `window._removingWorktreeIds`, `getWorktreeStatuses`'s `Number(wt.id)`, `cleanupWorktree`'s `find(w => w.id === worktreeId)`, and the abandon arm's `Number(worktreeId)`. Several fail *silently and successfully*, which is worse than throwing.
- **The row renders four action buttons, not one.** Three of them (`Open terminals`, `Merge prompt`, `Clean up`) resolve the worktree by id server-side. On an external row they cannot work, and `Clean up` in particular returns `{success: true}` after finding nothing — a dead button that fakes success, which PRD contract #6 forbids by name.
- **Multi-repo (control plane).** `git worktree list` run at one root only knows that root's repo. Rows belonging to a child repo must not be judged by it.

## Edge-Case & Dependency Audit

### Race Conditions

- **Reconcile vs. create.** `createWorktree` inserts the row and creates the checkout in two steps. A reconcile pass landing between them sees a git entry with no row and reports it as `external`. Harmless — it is advisory data, and the next pass corrects it — but it must not *write* on that basis. This is one more reason tombstoning is gated on "git says gone" rather than "no row".
- **Reconcile vs. abandon.** The webview already tracks in-flight abandons in `window._removingWorktreeIds` (`kanban.html:11700`) with a 30s self-heal. External rows must join that set under the same key scheme or an in-flight external abandon is not suppressed on re-render.
- **Two reconcile passes concurrently** (tab open + an agent polling `GET /worktree/list`). `updateWorktreeStatus(id, 'abandoned')` is idempotent, so a double tombstone is safe. No lock needed; do not add one.

### Security

- No new input reaches a shell: `cp.execFile` with an argument array is already the established pattern in this file (`_createSafetyWorktree`, `_pruneWorktrees`) — keep it, never `exec` with a string.
- `wtPath` arrives from the webview and is passed to `git worktree remove --force`. This is **pre-existing**, not introduced here, but the external path widens who can reach it: with `worktreeId` no longer required, `wtPath` becomes the sole identifier for one branch of the arm. Require that the resolved path appear in the *current* `git worktree list` output before removing it, so an arbitrary caller-supplied path is not a delete primitive.
- **Never offer Abandon on the main checkout.** Filtering it out of the reconciled list is a safety control, not cosmetics: a `git worktree remove --force` aimed at the main working copy is the worst outcome available in this change.

### Side Effects

- `getWorktrees()` stays a pure read. It has **25+ call sites** (`extension.ts:3257`, `bootstrap.ts:480/1372/1582`, `PlanIngestionEngine.ts:417`, `TaskViewerProvider.ts:1179/2916/10660`, and ~15 in `KanbanProvider.ts`, several on prompt-building paths). Anything added inside it is paid by all of them.
- `matchWorktreePath` (`worktreeResolver.ts:23`) routes by `feature_id` / `project`. External entries have neither, so they can never capture a dispatch. Confirmed by reading the resolver, not assumed.
- `_regenerateFeatureFile` (`KanbanProvider.ts:13086`) filters `getWorktrees()` by `feature_id`; external entries carry `null` and are excluded.

### Dependencies & Conflicts

- **`abandon-worktree-leaves-a-branch-and-a-stale-feature-block.md` edits the same arm** (`case 'abandonWorktree'`, `KanbanProvider.ts:12180`). PRD orchestration discipline: one agent stream per provider file. Serialise these two; do not run them in parallel.
- **Cross-plan constraint:** when that plan lands, Abandon deletes the worktree's branch. It must **not** do so for an `external` worktree — Switchboard did not create that branch and does not own it. Gate branch deletion on the presence of a DB row.
- Return-contract ratchet: `scripts/verb-return-contract-baseline.json` has `"Kanban": 1`. Every touched arm already `return`s; introduce no new `break`.

## Dependencies

- None (no prior session artefacts). Sequencing constraint against `abandon-worktree-leaves-a-branch-and-a-stale-feature-block.md` is recorded above.

## Adversarial Synthesis

Key risks: an irreversible tombstone fired by a transient filesystem condition; `id: null` silently corrupting six id-keyed sites, three of which fail as *success*; and a row that is visible but whose other three buttons dead-click, which satisfies "it appears" while missing "it works". Mitigations: tombstone only when git **and** disk agree the worktree is gone, and degrade to a read-only `stale` marker in every other case; carry an explicit `key` alongside `id` so nothing keys on `null`; render only Abandon on external rows. The reconciler is a pure function with the git output injected, so all four state combinations are testable without touching a real repository.

## Proposed Changes

### `src/services/worktreeReconciler.ts` *(new)* — the reconciliation pass, as a pure function

> **Superseded:** Reconcile inside `KanbanDatabase.getWorktrees()` (`KanbanDatabase.ts:3908`) — "keep the query, add a pass over `git worktree list --porcelain` before the result is returned".
> **Reason:** Three problems, each disqualifying on its own. (1) `getWorktrees()` has 25+ call sites, several on prompt-building and dispatch paths; every one would pay a `git` subprocess spawn per call. (2) It is a *read*; flipping rows to `abandoned` and calling `_persist()` inside it makes every consumer — `PlanIngestionEngine`, `TaskViewerProvider`, the standalone bootstrap — a silent mutator of user state. (3) `KanbanDatabase.ts` imports `fs` only and has no `child_process` dependency; it is the sql.js layer, loaded by both hosts. And it would still miss half the bug: `GET /worktree/list` (`LocalApiServer.ts:2781`) calls `getWorktrees()` directly, so a fix placed in the DB layer would cover agents but a fix placed in `_sendWorktreeConfig` would cover only the tab.
> **Replaced with:** A new `src/services/worktreeReconciler.ts` holding a **pure** reconcile function with the git output and an existence predicate injected. It is called by the two consumers that need reconciled data — `_sendWorktreeConfig` and `GET /worktree/list` — and by nothing else. This mirrors `worktreeResolver.ts` exactly: a free function extracted so both providers share one testable choke point without a circular import.

**Context.** `worktreeResolver.ts` is the established precedent in this codebase for "shared worktree logic that both providers need, kept host-agnostic and pure". This module is its sibling. Purity is what makes the four-way state matrix testable without a real git repository.

**Logic.** Git is authoritative for *registration*; the filesystem is authoritative for *content*. Cross them:

| git lists path | dir exists | verdict |
| :-- | :-- | :-- |
| yes | yes | healthy — return unchanged |
| yes | no | `stale: 'missing'` — checkout gone, git still registers it. Keep the row; Abandon prunes it. |
| no | no | **gone** — tombstone the row and drop it from the list |
| no | yes | `stale: 'unregistered'` — a directory is still there and may hold work. Keep the row, flag it, write nothing. |

Tombstoning requires **both** signals. That single rule is what stops an unmounted volume from destroying a feature binding.

**Implementation.**

```ts
// src/services/worktreeReconciler.ts
import type { WorktreeRow } from './KanbanDatabase';

export interface GitWorktreeEntry {
    path: string;
    branch: string | null;   // null for a detached checkout
    head: string | null;     // short sha, used as the display fallback
    isMain: boolean;
}

export interface ReconciledWorktree extends Omit<WorktreeRow, 'id'> {
    id: number | null;                                  // null ⇒ no DB row
    key: string;                                        // stable DOM/tracking key
    external: boolean;                                  // present in git, absent from the table
    stale: null | 'missing' | 'unregistered';
}

export interface ReconcileResult {
    list: ReconciledWorktree[];
    tombstone: number[];      // row ids the caller must flip to 'abandoned'
}

/**
 * `git worktree list --porcelain` emits blank-line-separated records. The FIRST
 * record is always the main worktree. A record is `worktree <path>` followed by
 * `HEAD <sha>` and then either `branch refs/heads/<name>` or the bare word
 * `detached`. Optional `bare` / `locked` / `prunable` lines are ignored — nothing
 * here depends on them, so the parser works on older git as well as new.
 */
export function parseWorktreePorcelain(stdout: string): GitWorktreeEntry[] { /* … */ }

/**
 * `gitEntries === null` means git could NOT be consulted (spawn failed, not a
 * repo, timeout). In that case pass every row through untouched, discover
 * nothing, and tombstone nothing. Reconciliation degrades to the current
 * behaviour rather than to data loss.
 */
export function reconcileWorktrees(
    rows: WorktreeRow[],
    gitEntries: GitWorktreeEntry[] | null,
    pathExists: (p: string) => boolean,
    normalise: (p: string) => string
): ReconcileResult { /* … */ }
```

- **`key`** is `String(row.id)` for DB rows — byte-identical to today's `data-wt-id` values, so shipped behaviour is preserved — and `ext:<normalised path>` for external entries.
- **Path comparison goes through `normalise`.** Callers pass a function that does `fs.realpathSync.native` inside a `try`, falling back to `path.resolve`. macOS `/tmp` → `/private/tmp` symlinking and case-insensitive volumes make raw string equality wrong, and a false mismatch here means a *tombstone*.
- **The main worktree is dropped** from the reconciled list before anything else runs. Take `isMain` from the porcelain's first record, and additionally exclude any entry whose normalised path equals the normalised repo root. Two independent checks, because this is the one mistake that deletes the user's working copy.
- **Detached external checkouts have no branch.** Display falls back to the directory basename plus the short head (`worktree-name (detached @ 1a2b3c4)`). The observed `switchboard-review-baseline` was detached, so this path is the *reported* case, not a hypothetical.
- External entries are synthesised with `status: 'active'`, `feature_id: null`, `project: null`, `subtask_plan_id: null`, `tier: null`, `agentsOpenWithGrid: false`, `created_at: ''`. `status: 'active'` matters: `extension.ts:3257` filters on it.

**Edge cases.** Empty git output; a single-worktree repo (main only → empty list, no external, no tombstones); duplicate rows pointing at the same path (tombstone each independently — they are separate rows); a row whose path is `''` (never tombstone on an empty path, treat as `stale: 'unregistered'`).

### `src/services/KanbanProvider.ts:12874` — feed the tab reconciled data

**Context.** `_sendWorktreeConfig` is the single producer of the `worktreeConfig` push, reached from both hosts through the `getWorktreeConfig` verb (`KanbanProvider.ts:11846`). It already holds `workspaceRoot`.

**Logic.** Run `git worktree list --porcelain` (via `promisify(cp.execFile)`, `cwd: workspaceRoot`, a short timeout, `catch → null`), hand the rows and the parsed entries to `reconcileWorktrees`, apply the returned tombstones with `db.updateWorktreeStatus(id, 'abandoned')`, then map as today.

**Implementation.** The existing mapping loop at `KanbanProvider.ts:12905-12925` builds a literal — any field not named there is dropped. Add `key`, `external` and `stale` to it, or the reconciler's output never reaches the webview. Feature-topic resolution stays keyed on `feature_id`, which external entries lack, so that block is untouched.

**Edge cases.** A tombstone write inside a push handler must not throw past the postMessage — wrap it; a failed tombstone is a cosmetic staleness, a thrown one is an empty tab.

### `src/services/LocalApiServer.ts:2781` — reconcile the agent-facing route too

**Context.** `GET /worktree/list` returns `await db.getWorktrees()` raw. Fleet and orchestration agents read this route (`switchboard-orchestration` skill); today it is blind in exactly the same way as the tab.

**Logic.** Route it through the same reconciler so both surfaces agree. Contract #4 (return-in-body) already holds — this changes the body's contents, not its shape, and the added fields are additive.

**Edge cases.** Consumers that expect a numeric `id` now receive `null` for external entries. The route is read-only and the field is additive, so nothing breaks; document `id: null ⇒ external` in the route's response.

### `src/services/KanbanDatabase.ts:29` — widen the row type

**Context.** `WorktreeRow.id` is `number`.

**Logic.** `WorktreeRow` stays exactly as it is — it describes a *table row*, and every table row has an id. `ReconciledWorktree` (which allows `id: null`) lives in the reconciler and is the only type that admits an external entry. Keeping the two separate is what stops `id: null` leaking into the 25 `getWorktrees()` consumers.

**Implementation.** No change to `KanbanDatabase.ts` beyond exporting `WorktreeRow` for the new module's `import type` (it is already exported).

### `src/services/verbSchemas.ts:539` — stop rejecting the external abandon

**Context.** The schema is

```ts
abandonWorktree: {
    fields: {
        worktreeId: { type: ['number', 'string'], required: true },
        …
```

and the validator (`verbSchemas.ts:64`) treats `null` as absent, so `required: true` turns `worktreeId: null` into `missing required field 'worktreeId'`.

**Logic.** This is the sharpest edge in the whole plan and the original draft did not mention this file. The webview `postMessage` path is **not** validated (byte-compat), so in VS Code the external abandon would appear to work — while the same click in the browser cockpit is rejected at the boundary. The bug would ship as "works in the extension, fails over `npx`", which is precisely the failure mode the Browser Switchboard PRD exists to prevent.

**Implementation.** Drop `required: true` from `worktreeId`. Do **not** compensate by making `wtPath` required — a normal DB-row abandon may legitimately omit it. The arm enforces the real rule ("one of the two must be present") and returns `{success: false, error}`; per contract #5 schemas require only the fields the arm dereferences, and neither field is unconditionally dereferenced.

### `src/services/KanbanProvider.ts:12180` — make the DB half optional

**Context.** The arm is already path-driven where it matters: it removes the checkout with `git worktree remove --force <wtPath>`. Only the status write needs the id.

> **Superseded:** The whole change on this file is a `if (worktreeId != null) { await db.updateWorktreeStatus(Number(worktreeId), 'abandoned'); }` guard in the success and catch branches.
> **Reason:** The guard is correct and necessary — `Number(null)` is `0`, which today updates nothing and reports success, so it removes a real lie — but it is not sufficient. It leaves the schema rejecting the call before the arm runs (see above), and it leaves `wtPath` as an unvalidated delete primitive on the branch where there is no row to cross-check against.
> **Replaced with:** The guard, **plus** an identifier precondition, **plus** a path check against live git before removal.

**Implementation.**

```ts
const hasRow = worktreeId !== null && worktreeId !== undefined
    && Number.isFinite(Number(worktreeId)) && Number(worktreeId) > 0;
if (!hasRow && !wtPath) {
    return { success: false, error: 'abandonWorktree requires worktreeId or wtPath' };
}
```

Before `git worktree remove --force`, confirm the normalised `wtPath` appears in the current `git worktree list --porcelain` output and is not the main worktree. Then:

```ts
if (hasRow) { await db.updateWorktreeStatus(Number(worktreeId), 'abandoned'); }
```

in **both** the success and the catch branch. With no row there is nothing to tombstone, and the abandon is complete once the checkout is gone.

**Edge cases.** `git worktree remove` fails while the path is still registered → existing catch path, unchanged. External abandon where the directory was deleted underneath us → `fs.existsSync` is false, removal is skipped, `git worktree prune` clears the registration; report success. When the sibling plan lands, its branch deletion must be gated on `hasRow`.

### `src/webview/kanban.html:11594` — key rows by `key`, not `id`

**Context.** Six sites key on `w.id`. With `id: null` they degrade as follows: `setAttribute('data-wt-id', null)` writes the string `"null"`; `getWorktreeStatuses` returns `Number(null) === 0`, so the badge selector never matches and the row's status stays `⋯` forever; and `_removingWorktreeIds.add(null)` gives **every** external row the same tracking key, so abandoning one hides all of them and the completion check `activeIds.has(null)` never clears.

**Logic.** Introduce `const k = w.key ?? String(w.id)` at the top of `renderWorktreeRow` and use it for `data-wt-id`, for `_removingWorktreeIds`, and for the 30s self-heal timer. For DB rows `w.key` is `String(w.id)`, so every produced value is byte-identical to today.

**Implementation.** Correspondingly, `getWorktreeStatuses` (`KanbanProvider.ts:12207`) must echo the key it was given instead of `Number(wt.id)` — the webview already sends `{id, path}` pairs at `kanban.html:12114`; send `{key, path}` and echo `key` back. The `worktreeStatuses` handler (`kanban.html:8814`) matches on `[data-wt-id="${s.id}"]`; match on `s.key ?? s.id` so an old in-flight payload still resolves.

### `src/webview/kanban.html:11648` — render external entries honestly

> **Superseded:** "Same row shape, one visual difference: an `external` entry is labelled as not created by Switchboard, and shows its path rather than a feature link… Abandon stays on it. No new controls, no confirm gate (repo rule)."
> **Reason:** The row does not have one action, it has four — `Open terminals`, `Merge prompt`, `Clean up`, `Abandon` (`kanban.html:11648-11706`). The first three resolve the worktree **by id** on the backend. On an external row `Open terminals` and `Merge prompt` error, and `Clean up` reaches `_cleanupWorktree`'s `allWorktrees.find(w => w.id === worktreeId)` (`KanbanProvider.ts:12773`), finds nothing, returns early, and the arm reports `{success: true}`. A button that does nothing and claims it worked is exactly what PRD contract #6 prohibits. "Abandon stays on it" is true and insufficient: shipping only that produces a row that is *reachable but not usable* — the bug's own signature, one layer up.
> **Replaced with:** On an `external` row, render **Abandon only**. Omit `Open terminals`, `Merge prompt` and `Clean up` rather than disabling them — there is no state in which they become valid, so a disabled control is just a permanent question. Everything else about the row is unchanged, including the absence of any confirm gate.

**Implementation.** External entries have no `featureTopic` and no `project`, so `createWorktreesPanel`'s existing partition (`kanban.html:11882-11885`) already files them under **unbound** — no grouping change needed. Replace the `Unbound` chip with `External — not created by Switchboard` (`chip.title` = the full path), and render the path in place of the feature link. A `stale` row (which *does* have a row id and keeps all four buttons) gets its own marker: `checkout missing` or `not registered in git`.

**Edge cases.** An external worktree whose branch is empty (detached) must not render a blank line — use the fallback label from the reconciler. Long paths already wrap via `word-break:break-all` on `branchSpan`.

## Verification Plan

*Compilation and automated-test execution are deliberately out of scope for this planning pass; the checks below are the specification the implementer runs.*

### Automated Tests

New contract test, in the idiom of `src/test/feature-worktree-guardrail-contract.test.js` (source-text layer plus a behavioural layer against the compiled output). The reconciler is pure, so the behavioural layer needs no git repository — feed it fixture entries.

1. **The four-state matrix.** `reconcileWorktrees` over one fixture per cell: listed+exists → unchanged, `stale: null`; listed+missing → kept, `stale: 'missing'`, **not** tombstoned; unlisted+missing → tombstoned and absent from `list`; unlisted+exists → kept, `stale: 'unregistered'`, **not** tombstoned.
2. **Git unreachable is not data loss.** `gitEntries === null` ⇒ `tombstone` is empty and `list` equals the input rows one-for-one, whatever the existence predicate returns.
3. **The main checkout never appears** in `list`, by `isMain` and by repo-root path equality, and never appears in `tombstone`.
4. **External discovery.** A git entry with no matching row yields `id: null`, `external: true`, `key === 'ext:' + path`, `status: 'active'`; and `tombstone` is empty (discovery never writes).
5. **Path normalisation.** A row recorded as `/tmp/x` and a git entry of `/private/tmp/x` reconcile as the *same* worktree — no external duplicate, no tombstone.
6. **Detached entry** yields a non-empty display label containing the short head.
7. **Schema.** `validateVerbPayload('kanban', 'abandonWorktree', { wtPath: '/x' })` returns `{ok: true}` — the regression that would otherwise ship as browser-only.
8. **Source-text guard on the arm** (`KanbanProvider.ts` `case 'abandonWorktree'`): contains a truthy/finite guard around `updateWorktreeStatus` and does not contain a bare `updateWorktreeStatus(Number(worktreeId)` outside it.
9. **Purity guard on the reconciler:** `worktreeReconciler.ts` source contains no `child_process`, no `import * as fs`, and no `vscode` — the seam property (PRD contract #3) asserted by construction.
10. **Ratchet unchanged:** no new `break` in any touched arm; `scripts/verb-return-contract-baseline.json` `"Kanban": 1` still holds.

### Manual

11. `git worktree add` a checkout outside Switchboard, open the tab: it is listed, marked external, shows its path, and offers **only** Abandon. The `worktrees` table is byte-identical before and after the render.
12. Abandon that external worktree: the directory is gone, the call returns success, and the table is still byte-identical.
13. `git worktree remove` a Switchboard-created worktree, reopen the tab: the row is gone from the list and its DB row now reads `abandoned`.
14. Rename a Switchboard worktree's directory out from under it (simulating the unlisted+exists case): the row stays, flagged `not registered in git`, and is **not** tombstoned.
15. With one external and one Switchboard worktree present, both are listed, each status badge resolves (neither stays `⋯`), and abandoning one does not visually remove the other.
16. `GET /worktree/list` returns the same reconciled set the tab shows.

---

**Recommendation: Send to Coder.** (Complexity 6 — multi-file, but every risky decision is pinned by a pure function with a fixture matrix.)
