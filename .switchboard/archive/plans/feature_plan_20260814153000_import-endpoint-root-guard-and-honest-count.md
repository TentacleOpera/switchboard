# `POST /kanban/plans/import` Duplicates the Entire Board From One Mis-Cased Root, and Reports That Nothing Happened

## Goal

Stop `POST /kanban/plans/import` from silently duplicating every plan on the board when a caller passes a workspace root that differs from the canonical one only in spelling, and make its response tell the truth about what it wrote.

Two small guards at the boundary. The deeper cause — that a plan row's identity is the caller's literal spelling of a file path — is named at the end as a follow-up, because fixing it is a schema-wide change and this card is the containment.

> **Superseded:** "The deeper cause … is a schema-wide change."
> **Reason:** Verified against the live DB and the write path. `plan_file` is **not** a free-for-all column: `KanbanDatabase._ensureRelativePlanFile` (`KanbanDatabase.ts:10068-10104`) is the single authoritative normalizer applied at every DB write boundary, and all 2347 rows in the live board are stored relative (`SELECT` by shape: 2347 relative, 0 absolute). There is no schema-wide format war to migrate. The deeper cause is one **fail-open** branch inside that normalizer plus one **un-canonicalised cache key** in `KanbanDatabase.forWorkspace`.
> **Replaced with:** The deeper cause is that the path normalizer *stores the absolute path as-is* (with only a `console.warn`) when its case-sensitive prefix strip fails, and that `forWorkspace` keys its instance cache on `path.resolve()` rather than a canonical identity. Both are small, local fixes — recorded as follow-ups because they are the durable fix, not because they are large. See "Follow-up recorded, not planned here".

### Problem & background — a reproduction, not a theory

On 2026-08-14 a single call inserted **1537 duplicate plan rows** into a live board (2345 real plans → 3882) and reported success with `count: 0`. The call was:

```bash
curl -X POST "$BASE/kanban/plans/import" -d '{"workspaceRoot":"'"$PWD"'"}'
```

`$PWD` was `/Users/patrickvuleta/documents/github/switchboard` — the same directory as the canonical `/Users/patrickvuleta/Documents/GitHub/switchboard`, differing only in case. macOS resolves both to the same files. Switchboard treated them as different, imported every plan and feature file in the repo a second time, and returned `{"success":true,"count":0}`.

Recovery required identifying the bad rows by path prefix and deleting 1537 of them one at a time. Nothing on disk was damaged and no second workspace was created — `workspace_id` resolved identically both times, because it comes from `.switchboard/workspace-id`. **The entire failure was in the `plan_file` column.**

*(Corroborated at improve time: the board today holds exactly one `workspace_id` (`038bffef-…`) across 2348 rows, so the duplication was keyed on `plan_file`, not on workspace identity. `.switchboard/plans` + `.switchboard/features` currently hold 1857 `.md` files, consistent with a per-file insert of that magnitude.)*

Three defects compose. Each alone is survivable; together, one wrong string doubles the board invisibly.

**Defect 1 — the handler accepts any string as a workspace root.** `LocalApiServer.ts:3173`:

```ts
const root = String(body?.workspaceRoot || this._options.workspaceRoot || '').trim();
```

That is the whole of the validation. The value is never canonicalised (`fs.realpathSync`), never compared against the registered roots, and never checked for existence beyond `importPlanFiles` bailing when `.switchboard/plans` is missing — which a mis-cased path on a case-insensitive filesystem passes. The server already knows the correct answer: `_allRoots` is published on `GET /health` as `roots`, and `selectedWorkspaceRoot` names the canonical one. The handler simply does not consult it.

This is also inconsistent with its immediate neighbours. `_handleCreatePlan` resolves and confines the target path (`:2980-2986`), and `_handleDeletePlan` guards with `abs.startsWith(plansDir + path.sep)` (`:3070`). The one endpoint that walks an entire directory tree and writes a row per file has no guard at all.

**Defect 1b — `POST /kanban/plans` is the same unguarded door (found during the improve pass).** `_handleCreatePlan` reads the root with the identical unvalidated expression (`LocalApiServer.ts:2979`), writes the new plan file under `path.join(root, '.switchboard', 'plans')`, and then calls `await importPlanFiles(root)` (`:3028`) — the same full-tree walk, the same row-per-file write. Its `resolved !== path.join(resolvedDir, …)` check at `:2997` is a **slug** traversal guard; it constrains the filename, not the root. A mis-cased `$PWD` sent to *create-plan* reproduces this incident exactly, with a new plan file as the trigger. Guarding only `/kanban/plans/import` closes one of two identical doors.

**Defect 2 — row identity is the caller's spelling of the path.** `PlanFileImporter.ts:69` states the key outright: *"session_id is no longer the unique key; plan_file+workspace_id is"*. And `:92` builds that key:

```ts
let planFileNormalized = filePath.replace(/\\/g, '/');
```

`filePath` is absolute, derived from `path.join(workspaceRoot, '.switchboard', 'plans')`. It is backslash-normalised and nothing more.

> **Superseded:** "So the identity of a plan is *how the caller happened to spell the path to it*. The board's existing rows are stored **relative** (`.switchboard/plans/foo.md`), written by a different code path. So there are already two key formats in one column for the same kind of object, and a third appears the moment anyone calls this endpoint with an absolute root."
> **Reason:** There is no second writer and there are no coexisting formats. `PlanFileImporter.ts:92` does not set the storage key — it hands an absolute path to `db.insertFileDerivedPlan`, which normalises it at `KanbanDatabase.ts:2311` via `_ensureRelativePlanFile`. That normalizer converts absolute → workspace-relative for **every** write path (`upsertPlans :2254`, `insertFileDerivedPlan :2311`, and every read/lookup: `:2426`, `:2469`, `:2482`, `:2609`, `:2670`). Verified on the live board: 2347/2347 rows relative, one `workspace_id`, and a `UNIQUE INDEX idx_plans_plan_file_workspace ON plans(plan_file, workspace_id)` backing the `ON CONFLICT` clause. The importer's absolute path is normally relativised correctly, which is why ordinary imports are idempotent.
> **Replaced with:** **The identity break is a fail-open branch in the normalizer.** `_ensureRelativePlanFile` (`KanbanDatabase.ts:10091-10103`) strips the workspace-root prefix with a **case-sensitive** `startsWith`:
>
> ```ts
> const workspaceNormalized = this._workspaceRoot.replace(/\\/g, '/');
> if (normalized.startsWith(workspaceNormalized)) {
>     const relative = normalized.slice(workspaceNormalized.length);
>     return relative.startsWith('/') ? relative.slice(1) : relative;
> }
> console.warn(`[KanbanDatabase] _ensureRelativePlanFile: absolute path outside workspace, storing as-is …`);
> return normalized;   // ← fail-open: stores the absolute path as the row key
> ```
>
> When the prefix comparison misses — a differently-cased root, or a root that resolves elsewhere — the function does not refuse and does not throw. It logs a warning nobody reads and stores the **absolute** path, which cannot collide with the existing relative key, so `ON CONFLICT` never fires and every file inserts as a new row. That single `return normalized;` is the line that turned a spelling into 1537 rows.
>
> Two live artefacts confirm this class has fired before: the board still carries two malformed rows of shape `.switchboard/plans/Users/patrickvuleta/Documents/GitHub/switchboard/{reviewer,lead}` (created 2026-04-12 and 2026-05-12), and `plans` still carries a `needs_relative_conversion` column from the migration that cleaned up an earlier absolute-path era. The guard at `:10076-10087` that rejects absolute-looking segments in *relative* input is the scar tissue from that round; the absolute branch was left failing open.

**Defect 2b — a mis-cased root also forks the database instance (found during the improve pass).** `KanbanDatabase.forWorkspace` (`:1075-1085`) validates via `isValidWorkspaceRoot` (`:1299-1325`), which uses **`path.resolve` only — never `fs.realpathSync`** — and then keys the `_instances` map on that string. A mis-cased root is therefore a cache **miss**: a second `KanbanDatabase` object is constructed, with its own in-memory sql.js image, pointed at the *same physical file* (`.switchboard/db-pointer` here resolves to `/Users/patrickvuleta/Documents/GitHub/switchboard/.switchboard/kanban.db`, and a case-insensitive filesystem resolves the default path to the same inode). Two live images over one file persist whole-image snapshots — last writer wins. That is a **data-loss** vector strictly wider than duplication, reachable from the same unvalidated string, and it is why the fix has to canonicalise the root rather than merely compare it.

**Defect 3 — partial failure is reported as total failure, after committing.** `PlanFileImporter.ts:143-150`:

```ts
let allOk = true;
for (const record of records) {
    const ok = await db.insertFileDerivedPlan(record);   // writes
    if (!ok) allOk = false;
}
if (!allOk) {
    return { count: 0, planFiles: [], columns: {} };     // reports nothing happened
}
```

Every insert is committed as it goes. If any single one returns false, the function discards the true count and reports `count: 0`, `planFiles: []` for the whole batch. There is no rollback and no partial report. This is why the 1537-row insertion announced itself as a no-op: the one signal that would have made the mistake visible within seconds said nothing had happened.

> **Superseded:** "if any single one returns false" — read as *that record was rejected*.
> **Reason:** `insertFileDerivedPlan` ends `const result = await this._persist(); … return result;` (`KanbanDatabase.ts:2404-2408`). Its boolean is the **disk-persist** result for the entire in-memory image, not a per-row verdict. The row is already in the committed transaction; a `false` means "the snapshot did not reach the file *this time*", and the row still lands on the next successful persist. (`.switchboard/` currently holds ~30 orphaned `kanban.db.*.tmp` files — persist churn is real on this machine, not hypothetical.) So `count: 0` is not just a discarded count; it reports a **whole-image, transient** condition as a per-batch zero, for rows that are already in the database.
> **Replaced with:** Model the two failure kinds separately: a per-record `insert` outcome (currently unobservable through this API) and a batch-level `persisted: boolean`. `count`/`written` must report the records the loop actually wrote to the image; `persisted: false` reports that the snapshot did not reach disk. Never return zero for either.

**Defect 3b — a zero-length `planFiles` silently disables integration sync.** `extension.ts:1539` (`switchboard.syncImportedPlans`) returns early on `!importResult.planFiles.length`, and both call sites gate on it (`extension.ts:1526`, `ControlPlaneMigrationService.ts:288`). So the all-or-nothing early return does not merely misreport — it skips ClickUp/Linear/Notion queueing for every plan the import actually wrote.

**Why this is worth fixing rather than treating as caller error.** The caller was wrong to pass an unnormalised path. But the endpoint is reachable by any external agent holding the API token, is documented in `switchboard-orchestration/SKILL.md` for exactly that audience, and `$PWD`-shaped roots are the obvious thing such a caller will pass. A boundary that turns a plausible input into silent, board-wide duplication — and then reports success with a zero count — is a defect at the boundary.

**PRD alignment.** The Browser Switchboard PRD's contract #4 (*"Failure branches — including the aggregate `catch` — return `{success:false, error}` so an HTTP caller sees the failure, never a false success"*) and #5 (*schema validation at the HTTP boundary; permissive and field-accurate*) are precisely what this card enforces for these two endpoints. `{"success":true,"count":0}` after 1537 writes is the exact false-success the contract forbids. The standalone host (`src/standalone/bootstrap.ts:1847`) passes `allRoots: [workspaceRoot]`, so the guard must behave correctly with a single-entry root set — see the root-set decision below.

---

## Metadata

**Complexity:** 5
**Tags:** bugfix, backend, api, reliability, security

> **Superseded:** **Complexity:** 4
> **Reason:** Scope grew by one endpoint (`_handleCreatePlan`) and by a verified breakage in the guard's proposed source of truth (`_allRoots` excludes mapped child roots — nine real roots on this machine). The change now spans three files, touches the create-plan path, and must be correct under workspace-database mappings and under the standalone host's single-root construction.
> **Replaced with:** **Complexity:** 5 — still "Send to Coder", but with the mapped-roots case as a mandatory pre-landing check rather than an optional one.

---

## User Review Required

**None.** Five decisions made here:

* **Reject an unregistered root rather than normalising it into one.** A canonicalised root that does not match a known root is refused with 400. Silently "correcting" a caller's root would hide the same class of mistake instead of surfacing it.
* **Case-insensitive comparison is used only for *matching* against known roots, never for storage.** The stored value is always the matched root's own canonical spelling.
* **Both write endpoints are guarded, not just import.** `POST /kanban/plans` (`_handleCreatePlan`) calls the same importer with the same unvalidated string; guarding one and not the other leaves the incident fully reproducible.
* **The valid-root set is *not* `_allRoots`.** It is the unfiltered workspace-root list **plus** every mapped child root. See the superseded callout in Proposed Changes §2 — this is a verified breakage, not a caution.
* **Scope is containment, not the identity refactor.** Defects 1, 1b and 3 are fixed here and either the guard or the honest count alone would have made the incident visible. The `_ensureRelativePlanFile` fail-open (Defect 2) and the `forWorkspace` cache-key canonicalisation (Defect 2b) are the durable fixes and are recorded as follow-ups — they are small, but they are DB-layer changes affecting every write path and deserve their own verification pass.

---

## Complexity Audit

* **Score:** 5 / 10

### Routine

* Canonicalising a path and comparing it against an existing in-memory list.
* Changing a return shape to carry counts that are already computed.
* Applying the same guard to a second handler in the same file.

### Complex / Risky

* **This endpoint is on the create-plan path.** `_handleCreatePlan` calls `importPlanFiles(root)` immediately after writing a file. A root guard that is too strict breaks plan creation for every caller, including the board's own.
* **`_allRoots` provably does not contain every legitimate root.** `TaskViewerProvider._startLocalApiServer` builds it as `this._filterMappedRoots(this._getWorkspaceRoots())` (`:2040`), and `_filterMappedRoots` (`:3040-3070`) **removes every root listed in a workspace-database mapping's `workspaceFolders`**. On this machine that filter drops nine real workspace roots (`Gitlab/{ai,be,fe,viaapp,viaapp-web,funnel-sandbox}`, `GitHub/autism360-analytics`, `GitHub/patrickwork`, `GitHub/switchboard-site`). A guard keyed on `_allRoots` would 400 every import **and** every plan creation for all nine.
* **Changing `count` semantics changes an existing contract.** Any caller that treats `count: 0` as "nothing was written" is currently being lied to, but a caller that treats a non-zero count as "everything succeeded" would newly be wrong if partial success reports a positive count. The shape has to distinguish written from persisted explicitly.
* **Two hosts construct the server differently.** The extension host filters roots; `src/standalone/bootstrap.ts:1847` passes `allRoots: [workspaceRoot]`. The guard must be correct in both, and must never be *stricter* than the host's own notion of what it serves.

---

## Edge-Case & Dependency Audit

### Race Conditions

* None introduced. Both changes are validation and reporting around an existing sequential write loop.
* Note the write loop is *not* transactional and this card does not make it so. It becomes honest about partial writes rather than preventing them.
* **Pre-existing, and narrowed by this card:** a mis-cased root forks a second `KanbanDatabase` instance over the same file (Defect 2b), producing two in-memory images that persist whole-image snapshots — a genuine last-writer-wins race. Canonicalising the root at the boundary removes the reachable trigger; the durable fix is in `forWorkspace` (follow-up).

### Security

* **The guard is the security control.** Today any token-holding caller can direct a full directory walk and a row-per-file write at an arbitrary path — via **two** endpoints, one of which also writes a file there. Confining the root to the known set closes that, and is the same discipline `_handleDeletePlan`'s traversal guard already applies.
* Refuse and report; never widen the check to accommodate a path that fails it. Widening the *source of truth* to include mapped child roots is not widening the check — those roots are legitimate registered workspaces that a display-oriented filter removed.
* The 400 message names the acceptable roots. That is deliberate: the endpoint already requires a bearer token, so the caller is authorised to know which workspaces the server serves — the same list `GET /health` already returns.

### Side Effects

* Callers passing a non-canonical root that currently "works" (by silently duplicating) will start receiving a 400. That is the intended change and the error message must say exactly what to pass instead.
* No existing rows are altered. This card prevents new duplicates; it does not clean up any that exist (including the two malformed `.switchboard/plans/Users/…` rows).
* `planFiles` becoming non-empty on a partial import re-enables integration sync for the rows that were actually written (`extension.ts:1539`) — a behaviour change in the correct direction, and one a coder must expect to see fire.

### Dependencies & Conflicts

* **`src/services/LocalApiServer.ts`** — `_handleImportPlans` (`:3166-3187`), `_handleCreatePlan` (`:2972-3048`, root read at `:2979`, importer call at `:3028`), `_allRoots` (`:399`, `:413`), `GET /health` roots publication (`:3853-3863`).
* **`src/services/PlanFileImporter.ts`** — `importPlanFiles` (`:30`), the identity comment (`:69`), `planFileNormalized` (`:92`), the write loop and early return (`:143-150`), `ImportPlanFilesResult` (`:15-20`).
* **`src/services/KanbanDatabase.ts`** — read-only for this card, but the mechanism lives here: `insertFileDerivedPlan` (`:2309-2409`), `_ensureRelativePlanFile` (`:10068-10104`), `forWorkspace` / `isValidWorkspaceRoot` (`:1075`, `:1299`).
* **`src/services/TaskViewerProvider.ts`** — `_filterMappedRoots` (`:3040-3070`) and the `allRoots` construction at `:2040`. **This is the file that decides whether the guard is correct.**
* **`src/standalone/bootstrap.ts:1847`** — the standalone host's `allRoots: [workspaceRoot]`.
* **Result-shape consumers** — `extension.ts:1518-1546` (reset-DB command + `switchboard.syncImportedPlans`), `ControlPlaneMigrationService.ts:283-289`, `KanbanProvider.ts:3081`, `:3164`, `:13706`, and `src/services/__tests__/PlanFileImporter.noStateSection.test.ts`. All read `count` / `planFiles` / `columns`; adding fields is additive.
* **`GET /health`** — already publishes `roots` and `selectedWorkspaceRoot`; the error message should point callers at it. If the guard's root set is widened beyond `_allRoots`, `/health` must publish the same widened set or the error message sends callers to a list that will not work.
* **`.agents/skills/switchboard-orchestration/SKILL.md:87`** — the import row (`| POST /kanban/plans/import | { workspaceRoot? } | …`) documents this endpoint for external agents; the root requirement belongs there and on the create-plan row. Regenerate the `.claude/` mirror and verify with `npm run mirror:check`.

---

## Dependencies

* None. Lands against HEAD; no schema change, no migration.

---

## Adversarial Synthesis

Key risks: (1) **the guard's source of truth is wrong out of the box** — `_allRoots` is `_filterMappedRoots(_getWorkspaceRoots())` and deliberately drops mapped child roots (nine on this machine), so a naive `_allRoots` guard 400s legitimate imports *and* breaks plan creation for those workspaces; (2) **guarding only the import endpoint leaves the incident reproducible** through `POST /kanban/plans`, which reads the root identically and calls the same importer; (3) **case-insensitive matching applied to storage rather than only to matching** would introduce a second spelling of the same bug on case-sensitive filesystems; (4) **an honest count that conflates written with persisted** replaces one misleading number with another, since `insertFileDerivedPlan`'s boolean is a whole-image disk-persist result, not a per-row verdict. Mitigations: build the valid-root set from the **unfiltered** roots plus mapped `workspaceFolders`, and verify against a mapped-child workspace before landing; guard both handlers through one shared helper; match roots by device+inode identity on POSIX and by case-folded `fs.realpathSync.native()` output on Windows — never by plain `fs.realpathSync`, which is documented to perform no case conversion and would have been a no-op against this incident — and store the matched root's own spelling; report `written` and `persisted` as distinct fields and never return zero for a transient persist failure.

---

## Proposed Changes

**Build order:** (1) honest count → (2) shared root guard applied to both handlers → (3) docs. The count fix lands first so that if the guard's edge cases need iteration, any mistake is at least visible. Land (1) and (2) together in the same change set — the count fix alone does not stop duplication, and the guard alone leaves the next failure invisible.

### 1. Make the import result honest — `src/services/PlanFileImporter.ts`

**Context:** `ImportPlanFilesResult` (`:15-20`) is `{ count, planFiles, columns }`. Five call sites read it; `extension.ts:1539` gates integration sync on `planFiles.length`.

**Implementation:** replace the all-or-nothing early return at `:143-150` with per-record accounting plus a batch-level persist flag:

```ts
const written: string[] = [];
let persisted = true;
for (const record of records) {
    const ok = await db.insertFileDerivedPlan(record);
    written.push(record.planFile);   // the row is in the committed image either way
    if (!ok) persisted = false;      // ok === the whole-image disk persist, not this row
}
```

Return `{ count: written.length, written, persisted, planFiles: written, columns }`.

> **Superseded:** `const failed: string[] = []; … (ok ? written : failed).push(record.planFile); … return { count: written.length, written, failed, planFiles: written, columns }`.
> **Reason:** `ok` is `this._persist()`'s return value for the entire sql.js image (`KanbanDatabase.ts:2404-2408`), not a verdict on that record. Bucketing records into `failed` on a `false` would label rows that **are** in the database as failures — the mirror image of the bug being fixed, and it would drop them from `planFiles`, re-suppressing integration sync for rows that exist.
> **Replaced with:** every record the loop processed is `written` (it is in the committed transaction); a `false` sets a single batch-level `persisted: false`, which the endpoint surfaces so the caller knows the snapshot may not have reached disk yet.

**Logic:** the writes are already committed when the current code reports zero. Reporting `count: 0` after committing 1537 rows is worse than reporting an error — it actively tells the caller the board is unchanged, and it silently disables integration sync for everything the import wrote.

**Edge cases:** keep `count` meaning **written**, so an existing caller reading `count` gets a truthful number in the same field rather than a differently-wrong one. `records.length === 0` still returns zero legitimately — that path is correct and stays. `columns` continues to be keyed by `record.planFile` (the importer's absolute spelling) — unchanged here, but note that `queueIntegrationSyncForPlanFile` re-normalises via `getPlanByPlanFile` → `_ensureRelativePlanFile`, so the lookup succeeds as long as the root prefix matches; a root that fails the prefix match fails this lookup too, which is one more reason the guard belongs upstream.

### 2. Validate and canonicalise the root — `src/services/LocalApiServer.ts`

**Context:** `_handleImportPlans` reads the root at `:3173`; `_handleCreatePlan` reads it identically at `:2979` and calls `importPlanFiles(root)` at `:3028`.

**Implementation:** add one private helper, `_resolveKnownRoot(given: string): { root: string } | { error: string }`, and call it from **both** handlers immediately after the existing empty-string check:

* canonicalise the input: `fs.realpathSync.native()` first, falling back to `fs.realpathSync()` on throw, then to `path.resolve()` (which then fails the next check anyway). The fallback chain is mandatory, not defensive padding — `realpathSync.native` throws where the JS implementation succeeds on Windows `subst` drives, RAM disks, and paths over `MAX_PATH`, and throws `ELOOP` on deep symlink chains the JS version resolves;
* compare against the **valid-root set** (below) by filesystem identity, **platform-split**:
  * **POSIX (macOS/Linux) — primary:** `fs.statSync(candidate)` and compare `dev` + `ino` (guarding `ino !== 0`). This is authoritative: it sees through case, symlinks, Linux bind mounts, and APFS firmlinks (`/tmp` ≡ `/private/tmp`, `/Users` ≡ `/System/Volumes/Data/Users`).
  * **Windows — primary:** canonical-path comparison of the `realpathSync.native()` results, case-folded. Do **not** trust `ino` there: Node truncates ReFS's 128-bit file IDs into a colliding 64-bit value, SMB shares and FAT32/exFAT/WSL paths report `0` or a per-handle value, so `dev`+`ino` produces both false matches and false misses.
  * **Fallback (either platform):** case-folded comparison of the canonicalised paths on Windows and macOS, exact comparison on Linux, used when `stat` throws or reports an unusable inode;
* if none matches, return **400** naming the acceptable roots and pointing at `GET /health`, e.g. *"workspaceRoot '<given>' is not a known workspace root. Known roots: [...]. See GET /health."*;
* if one matches, hand **that root's own canonical spelling** to `importPlanFiles`/the file write, never the caller's.

`_handleCreatePlan` must use the resolved root for `plansDir` as well as for the importer call — resolving only the importer argument would still write the file under the caller's spelling.

> **Superseded:** "find the registered root in `this._allRoots` whose own realpath matches, compared **case-insensitively**".
> **Reason:** Two problems, one fatal. (a) `_allRoots` is not the set of valid roots: `TaskViewerProvider.ts:2040` builds it as `this._filterMappedRoots(this._getWorkspaceRoots())`, and `_filterMappedRoots` (`:3040-3070`) strips every root listed in a mapping's `workspaceFolders`. With mappings enabled — as they are on this machine — that removes nine legitimate workspace roots, and the guard would 400 every import *and* every plan creation for all of them. (b) Case-insensitive string comparison of realpaths presumes `fs.realpathSync` canonicalises **case** on macOS, which is not documented and is not something to bet a guard on (flagged under Uncertain Assumptions).
> **Replaced with:** the valid-root set is `this._allRoots` **∪** every `workspaceFolders` entry from `getMappingsFromIndex()` (expanded for `~`, `path.resolve`d) — i.e. the roots the host serves *before* the display filter. Match by `dev`+`ino` from `fs.statSync` on POSIX, which is filesystem truth and immune to both case and symlink spelling; on Windows match on case-folded `fs.realpathSync.native()` output instead (see the platform split above). Store the matched root's own spelling.
>
> *Research confirms point (b) was not paranoia:* `fs.realpathSync()` explicitly performs **no case conversion on case-insensitive filesystems** (documented in the Node.js `fs` API), so the superseded rule's canonicalisation step would have been a no-op against this exact incident — the mis-cased root would have come back mis-cased and the case-insensitive string compare would have been carrying the whole guard. `fs.realpathSync.native()` *does* canonicalise case on macOS (it delegates to libuv → `realpath(3)`, which resolves through kernel vnodes) and on Windows (`GetFinalPathNameByHandleW`), but **not** on Linux with a case-insensitive mount (`ciopfs`, exFAT, CIFS), where glibc's `realpath(3)` resolves symlinks without correcting per-component case. That residual Linux gap is exactly why inode identity is the POSIX primary rather than a fallback.

**Logic:** the server already knows the correct set and already publishes most of it. Matching by inode catches exactly the failure that occurred — and every other spelling of it (trailing slash, symlinked path, `~` expansion, `/private/tmp` vs `/tmp`) — without depending on any case heuristic. Storing the known root's spelling ensures every import produces the same key regardless of how the caller spelled it, which is what keeps `_ensureRelativePlanFile`'s prefix strip on its happy path.

**Edge cases:**

* A caller that omits `workspaceRoot` keeps falling back to `this._options.workspaceRoot`, which is canonical by construction — that path is unaffected. Run it through the same helper anyway so the two paths cannot diverge; if the default root somehow fails its own guard, that is a real misconfiguration worth surfacing.
* **Standalone host:** `bootstrap.ts:1847` passes `allRoots: [workspaceRoot]` and there is no mappings index — the union degrades to the single root, which is correct. Confirm the mappings lookup is wrapped so its absence is a no-op, not a throw (`_filterMappedRoots` already models this with a bare `try/catch`).
* **Do not** apply case-insensitive comparison on a case-sensitive filesystem for anything but selecting the known root — two directories differing only in case are genuinely distinct there. Inode matching sidesteps this entirely: on a case-sensitive filesystem two differently-cased directories have different inodes and correctly fail to match.
* If `_allRoots` is empty (server constructed before roots are known), refuse with 503 rather than accepting anything — an empty allowlist must fail closed.
* If the widened set is used, `GET /health`'s `roots` should publish the same set (or the 400 message must name the union explicitly), or the error message points callers at a list that will not work.

### 3. Document the requirement

**Implementation:** in `.agents/skills/switchboard-orchestration/SKILL.md`, amend the import row (`:87`) and the create-plan row: `workspaceRoot` must be a root the server serves, as published by `GET /health` → `roots`; anything else is refused with 400. State plainly that a differently-cased or symlinked spelling of the right directory is *not* the right root. Regenerate the `.claude/` mirror; verify with `npm run mirror:check`.

---

## Verification Plan

Tests are skipped per session directive, and compilation is skipped per session directive. The cases below are the specification for whoever runs them.

### Automated Tests

* **The incident, as a regression test:** importing with a root that differs from a known root only in case returns **400** and writes **zero** rows.
* The same case, via `POST /kanban/plans`: returns 400, writes no plan file, and creates no rows.
* Importing with the exact known root succeeds and is idempotent — running it twice does not change the row count.
* Importing with a root outside the valid set entirely returns 400.
* Omitting `workspaceRoot` still works via the `_options.workspaceRoot` fallback, on both handlers.
* A trailing-slash and a symlinked spelling of a known root both resolve and import to the same rows (inode matching).
* The canonicalisation fallback chain is exercised: when `fs.realpathSync.native()` throws, the helper falls through to `fs.realpathSync()` and then `path.resolve()` rather than rejecting the root. Stub the throw — this is the Windows `subst` / long-path / `ELOOP` case, which cannot be reproduced on macOS.
* A root whose `fs.statSync().ino` is `0` still matches via the canonical-path fallback rather than being refused (the network-share / virtual-filesystem case).
* **Mapped child root:** with a workspace-database mapping enabled, importing a root listed in `workspaceFolders` succeeds — this is the case a `_allRoots`-only guard breaks.
* A batch where the image persist fails reports `count` = number written and `persisted: false` — never `count: 0`, never an empty `planFiles`.
* `_handleCreatePlan` still creates a plan and returns its `planId` (this path calls `importPlanFiles` internally and is the most likely thing to break).
* Standalone host: with `allRoots: [workspaceRoot]` and no mappings index, import of that root succeeds.
* Multi-root: importing each known root in turn works and targets only that root.

### Manual Verification

1. **Reproduce the original failure on the current build** — call import with a mis-cased `$PWD` and observe the duplicate rows and the `count: 0` response. Anchor the fix on observed behaviour. (`SELECT COUNT(*) FROM plans WHERE plan_file LIKE '/%'` isolates the bad rows for cleanup.)
2. Apply the change and repeat: 400, no rows written, message names the canonical root.
3. Repeat both against `POST /kanban/plans` with a mis-cased root.
4. **Create a plan from the board** and confirm it still appears — the create path uses this importer.
5. **Mapped-workspace check (mandatory):** with `workspace_mappings.enabled = true`, import one mapped child root (e.g. `Documents/Gitlab/fe`) and confirm it is accepted. If it 400s, the guard is using `_allRoots` and is wrong.
6. **Shared-database / multi-root setup:** confirm import still works for every root the user actually has registered.

---

## Resolved Research Findings

Three assumptions were flagged as uncertain during this pass and resolved by web research before this plan was finalised. They are recorded because the guard's implementation depends on all three; a coder should not re-derive them. (Findings hold for Node.js 18.x–22.x.)

1. **`fs.realpathSync()` does NOT canonicalise case on case-insensitive filesystems** — the Node.js `fs` docs state it outright: *"No case conversion is performed on case-insensitive file systems."* It is a JS implementation over `lstat`/`readlink` that resolves only symlinks and `.`/`..`. **`fs.realpathSync.native()` DOES** canonicalise case on macOS (libuv → `realpath(3)` → kernel vnodes via `F_GETPATH`) and on Windows (`GetFinalPathNameByHandleW`, which also normalises the drive letter). **Neither** corrects case on Linux with a case-insensitive mount (`ciopfs`, exFAT, CIFS). ⇒ Use `.native()` for canonicalisation; never rely on the JS variant to fix a mis-cased root.
2. **`dev`+`ino` is authoritative on macOS/Linux and unreliable on Windows.** On POSIX it correctly identifies bind mounts and APFS firmlinks as the same directory, and `statSync` follows symlinks so `/tmp` and `/private/tmp` compare equal. On Windows, Node populates `ino` from `BY_HANDLE_FILE_INFORMATION`, which **truncates ReFS's 128-bit file IDs to 64 bits (collisions)**, and returns `0` or a per-handle value on SMB shares, FAT32/exFAT, mapped/virtual drives, and WSL 9P paths. ⇒ Inode identity is the POSIX primary; Windows uses canonical-path comparison instead.
3. **`fs.realpathSync.native()` throws where `fs.realpathSync()` succeeds** — on Windows `subst` drives and RAM disks (`GetFinalPathNameByHandleW` needs volume-manager backing), on paths over `MAX_PATH` without the long-path policy (the JS variant applies `\\?\` internally), and with `ELOOP` on deep symlink chains that the JS variant resolves. Both throw `EACCES`/`EPERM` on inaccessible paths. ⇒ The canonicalisation step needs a `native → JS → path.resolve` fallback chain, not a single try/catch.

Everything else in this plan — the handler code, the normalizer's fail-open branch, the instance-cache keying, the `_filterMappedRoots` exclusion, the live column format, the unique index, and the result-shape consumers — was read directly from the source or queried from the live database during this pass.

---

## Recommendation

Complexity 5 → **Send to Coder.**

Land the honest count and the shared root guard together. Either change alone would have made the incident survivable — the guard stops the bad input, the count makes any future occurrence visible within one response — and together they contain the whole failure mode at the boundary.

**The thing to get right:** the valid-root set. `_allRoots` is `_filterMappedRoots(_getWorkspaceRoots())`, and that filter exists to keep mapped children out of a *display* list, not to define who may import. Using it as the guard's source of truth 400s nine real workspaces on the developer's own machine and breaks plan creation for them. Build the set from the unfiltered roots plus the mapping `workspaceFolders`, and test a mapped child before landing.

**The second thing:** guard both handlers. `_handleCreatePlan` reads the root the same way and calls the same importer; a guard on `/kanban/plans/import` alone leaves the incident fully reproducible through `/kanban/plans`.

**Migration:** none. No schema change and no data change. Existing duplicate rows created by this bug are not cleaned up by this card — that is a one-off data repair, not a code change.

---

## Follow-up recorded, not planned here

**1. `_ensureRelativePlanFile` fails open on a prefix miss.** `KanbanDatabase.ts:10091-10103` strips the workspace-root prefix with a case-sensitive `startsWith`, and on a miss logs a warning and **stores the absolute path as the row key**. That single `return normalized;` is what converts a spelling difference into a full-board duplicate set, and it is reachable from every write path, not just this endpoint. The fix is small — compare by canonical identity (or at minimum case-fold on case-insensitive platforms), and **fail closed**: refuse the write and surface an error rather than storing a key no reader will ever match. It needs its own plan because it is the DB layer's single normalizer and every write path depends on its behaviour.

> **Superseded:** "A real fix normalises `plan_file` to a single canonical form (relative to the workspace root is the obvious choice, since it is already the majority format …), migrates existing rows, and audits every reader that matches on the column. It needs its own plan, its own migration, and its own verification pass."
> **Reason:** That work is already done. `_ensureRelativePlanFile` *is* the single canonical form, relative *is* the format, every reader already routes through it (`:2426`, `:2469`, `:2482`, `:2609`, `:2670`), and the migration already ran — the `needs_relative_conversion` column is its residue. The live board is 2347/2347 relative with a `UNIQUE INDEX` on `(plan_file, workspace_id)`. Framing this as a schema-wide migration overstates it by an order of magnitude and would have sent a coder looking for a format war that does not exist.
> **Replaced with:** two small, local follow-ups (this item and the next), plus a one-off data repair of the two surviving malformed rows (`.switchboard/plans/Users/patrickvuleta/Documents/GitHub/switchboard/{reviewer,lead}`), which are a data question, not a code change.

**2. `KanbanDatabase.forWorkspace` keys its instance cache on an un-canonicalised path.** `isValidWorkspaceRoot` (`:1299-1325`) uses `path.resolve` only, so two spellings of one directory produce two `KanbanDatabase` objects over the same physical file — two in-memory sql.js images, each persisting whole-image snapshots, last writer wins. Canonicalising there (realpath, or `dev`+`ino`) fixes the class for **every** caller, including internal ones that no HTTP guard can protect (`extension.ts:1518`, `ControlPlaneMigrationService.ts:283`, `KanbanProvider.ts:3081`/`:3164`/`:13706`). This is the durable fix; the endpoint guard in this card is the containment.

**3. Cross-parent mapped children may already store absolute paths.** A mapping whose `workspaceFolders` include roots outside its `parentFolder` (here: `GitHub/autism360-analytics` and `GitHub/patrickwork` mapped to parent `Documents/Gitlab`) resolve their DB to the parent, so `_workspaceRoot` is the parent while their plan files live elsewhere — the prefix strip misses and item 1's fail-open stores absolute keys. Worth auditing the Gitlab board for absolute `plan_file` values when item 1 is planned. The same class of inconsistency is already recorded elsewhere in the product for `imported_docs`, which stores absolute paths where its readers expect otherwise — worth investigating together.

## Review Findings

Both guards are in place and correct: `_resolveKnownRoot` (`LocalApiServer.ts:6790`) matches by `dev`+`ino` on POSIX and case-folded native realpath on Windows, returns the *registered* spelling, fails closed with 503 on an empty root set, and is called from both write doors — and `_getKnownRoots` correctly unions `_allRoots` with the unfiltered mapping folders rather than the display-filtered set, so mapped children still import. `/health` publishes the same widened set; no code consumer of that field exists beyond `standalone/cli.ts:1241` (display only). One fix applied: `importPlanFiles`'s `!ready` branch returned `persisted: true` with `count: 0`, so a database that never opened reported as a clean no-op — the exact false success this card exists to remove; it now returns `persisted: false` (the three other zero returns are legitimate no-ops and stay `true`). The plan specified twelve automated cases and zero were written, so `src/test/workspace-root-write-path-contract.test.js` was added (11 cases: root identity via a symlinked alias, trailing slash, unregistered root → 400 naming the roots, subdirectory refused, empty set → 503, standalone single-root, and the full written/persisted split) and wired into `package.json` plus `.github/workflows/integration-tests.yml`. All named gates re-run green; `mirror:check` is red on an unrelated pre-existing `switchboard-remote` orphan, and the doc rows for both endpoints landed in `switchboard-orchestration` and `switchboard-mission-control-http`.

## Deferred Findings

- NIT — `_resolveKnownRoot` re-runs `fs.statSync(given)` once per known root rather than hoisting it above the loop. `src/services/LocalApiServer.ts:6807`
- NIT — The response ships the same file list twice: `written` and `planFiles` are the same array, ~1857 paths each on this board. `src/services/PlanFileImporter.ts:166`
- NIT — A `~`-prefixed `workspaceRoot` from a caller is refused: `_getKnownRoots` expands `~` in the known list but the given string is never expanded, so `statSync` throws and `path.resolve('~/x')` yields `<cwd>/~/x`. The 400 message is clear, so this is a usability edge, not a correctness one. `src/services/LocalApiServer.ts:6801`
- NIT — `{success: true, persisted: false}` still reads as success to a caller that only checks `success`. The plan chose to surface the persist failure as its own field rather than change the endpoint's success contract; noting it because PRD contract 4 is the card's own justification. `src/services/LocalApiServer.ts:7228`
- MAJOR (pre-existing, not this work) — Three `importPlanFiles` result-shape consumers are defined but never invoked by CI (`PlanFileImporter.noStateSection.test.ts`, `duplicate-switchboard-state-regression.test.js`, `custom-lane-roundtrip-regression.test.js`), and the first is red on a stub that predates the `getWorkspaceMappings` call added to the importer in June 2026. `src/services/PlanFileImporter.ts:61`
- NIT (historical) — `c0140527` deleted the `const body = await this._parseJsonBody(req)` binding from `_handleImportPlans` while still dereferencing `body?.workspaceRoot`. Repaired in `80d5f933`; HEAD compiles. `src/services/LocalApiServer.ts:7212`
