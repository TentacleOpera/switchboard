# Find and Fix Why a Valid `**Project:**` Pin Resolves to Unassigned on Every Fresh Plan Import

## Goal

Establish why `_resolveProjectForInsert` returns `('', null)` for a pin that names an existing project in the plan's own workspace, and fix it — so a plan authored with a PROJECT PIN lands in that project on first import.

### Problem

Every fresh plan import carrying a valid pin currently lands unassigned. Measured live on this board: **9 of 9** throwaway plan files pinned to a real project imported with `project=''` and `project_id=null`.

The consequence is worse than "no project": a plan can end up with a non-empty `project` string and a null `project_id`, which is filtered out of the project view (no id to join on) **and** out of the Unassigned view (non-empty string) — invisible on the board in both directions. That is how three real plans went missing earlier today.

### Root cause — narrowed, not yet identified

The code path is correct on inspection, in both `src/` and the build that is actually running. `_resolveProjectForInsert` ([KanbanDatabase.ts:1933](../../src/services/KanbanDatabase.ts#L1933)) has exactly three exits that yield unassigned:

1. the placeholder guard — `/^<.*>$/.test(pin)` (line 1971)
2. the workspace-name guard — `_isWorkspaceName(pin, record.workspaceId)` (line 1979)
3. the resolve miss — `getProjectIdByName(record.workspaceId, pin)` returning null (line 1989)

One of those three fires on every import — **or the pin never reaches the function at all** (see "Zeroth exit" below). Which is unknown, because none of them is observable from outside the process. The same lookup SQL, run directly against the DB file, resolves correctly:

```
sqlite3 .switchboard/kanban.db \
  "SELECT id FROM projects WHERE name='Browser Switchboard' AND workspace_id='038bffef-…';"
→ 11
```

**Zeroth exit (added in review — previously unobservable):** if `parsePlanMetadata` returns an empty `project` (or the value is lost between parse and record), `_resolveProjectForInsert` skips the pin branch entirely, falls to precedence #2 (`kanban.activeProjectFilter`, currently **empty** in this DB), and lands at precedence #3 — unassigned. The originally proposed instrumentation only logged **inside** the pin branch, so this failure mode would have produced *no output at all* and stalled the diagnosis. The parser regex (`planMetadataUtils.ts:102`) was inspected and tolerates plain, list-item, numbered, and blockquote forms case-insensitively — a parse miss is *unlikely*, but it costs one log line to make it observable instead of assumed away (Proposed Change 1b).

**Leading hypothesis (sharpened in review):** the lookup runs on an in-memory sql.js image that differs from the file. Review of the instance lifecycle constrains how that can happen:

- `ensureReady()` calls `_reloadIfStale()` on **every** access (KanbanDatabase.ts:1747-1785 → 6143-6225): stat-debounced at 500ms, it reloads whenever the file's mtime is **strictly newer** than what this instance loaded. A long-lived stale image therefore self-heals on the next access — plain staleness cannot persist for weeks past the projects row's creation (2026-07-13/17) unless the reload is persistently failing (that failure logs `"Reload from disk failed"` / `"External modification detected"` via `console.*`).
- **The write-side inference that makes this decisive:** the *same* `insertFileDerivedPlan` call that misses the lookup persists the plan row moments later via a **full-image export** (`_persist()` writes the whole DB image, not a delta). The failing rows demonstrably reached the on-disk file, and the user's post-failure disk query shows the `projects` row **present** in that same file. So the image that performed the write **contained the projects row**. If exit 3 is firing on an image *without* the row, the lookup and the write are running on **two different `KanbanDatabase` instances** — which is exactly the "path-resolution divergence yielding two instances for one file" hazard the code itself documents (KanbanDatabase.ts:6156-6159; `_instancesByDbPath` dedupes per resolved path *string*, so two different path spellings of one file create two instances). The `instanceId` diagnostic (`#N(kanban.db)`) already exists from the is_feature-clobber investigation (docs/investigation-feature-is_feature-clobber.md) precisely to expose this — the `[pin]` instrumentation must therefore include `this.instanceId` in every line (Proposed Change 1).
- Supporting observation for out-of-lockstep behavior: after ten `DELETE /kanban/plans` calls returned `{"success":true}`, the on-disk DB still showed all ten rows for roughly six seconds before converging. Note the persist layer is debounced/coalesced by design (`PERSIST_DEBOUNCE_MS = 300`, Workstream B), so *some* disk lag is expected behavior, not itself the bug.

### Hypotheses already excluded — do not re-test these

| Hypothesis | Why it's dead |
| :--- | :--- |
| Watcher read a partially-written file | Pin byte-offset does not predict failure (failures at offset 106 and 14054; successes at 134 and 5588). Every failing row had `created_at == updated_at`, i.e. a single insert pass — no create-then-change double import. |
| The `projects` row didn't exist yet | `Website` id 10 created 2026-07-13, `Browser Switchboard` id 11 created 2026-07-17; every affected plan imported after both. |
| Pin syntax / list-item prefix | Across 1,395 files: list-item form 7 applied / 7 empty, plain form 7 applied / 5 empty — no correlation. Both styles failed live. Parser regex additionally inspected in review (`planMetadataUtils.ts:102`): tolerant of both forms, case-insensitive, trims the capture. |
| Stale installed build (src fixed, build old) | The running bundle's `insertFileDerivedPlan`, `_resolveProjectForInsert`, `getProjectIdByName`, `_isWorkspaceName` and `getDistinctWorkspaceNamesUnion` were disassembled and are logically identical to `src/`. Repo and installed both report 1.7.13. |
| Write mechanics | In-place single-shot write and atomic rename from outside the watched directory behave identically — both fail. |
| The workspace-name guard matching by accident | All `workspace_name` values for this workspace are empty, and `getDistinctWorkspaceNamesUnion` filters `!= ''`, so the guard should no-op. Ranked unlikely but **not** conclusively excluded — the union also reads the cold/archive instance, which was not inspected. |

### Historical note

Of 26 corpus files whose pin names a real project, 14 show the pinned project. Given the pin demonstrably does not work now, those are more consistent with precedence #2 — `kanban.activeProjectFilter`, the active board project at insert time (KanbanDatabase.ts:1994-2010) — having been populated when those plans imported. That key is currently empty in this DB, which is why nothing rescues the miss today. Worth confirming during the fix, since it determines whether this ever worked or has always been masked. (This masking also fits the zeroth exit: if the pin never reaches the resolver, precedence #2 was the only thing that ever assigned projects — and it stopped when the filter went empty.)

## Metadata

- **Complexity:** 7
- **Tags:** backend, database, bugfix, reliability
- **Project:** Browser Switchboard

## User Review Required

- **The fix cannot be pre-approved in detail** — it is gated on the diagnosis (Step 1 must produce its `[pin]` line before any fix is written). The fix *shapes* per outcome are enumerated in Proposed Change 3; if the diagnosis lands outside them (e.g. a cross-process writer from a second IDE window), expect a follow-up plan rather than an improvised fix.
- **Instrumentation reading location changed during review:** the decisive `[pin]` lines from `KanbanDatabase` are read from the **editor's extension-host log**, not the Switchboard output channel (see the superseded callout in Proposed Change 2). The engine-side line (Change 1b) *does* go to the Switchboard output channel.

## Complexity Audit

### Routine

- The instrumentation itself: five log lines plus one debug helper, all removed or downgraded before merge.
- The regression test follows the existing contract-test pattern and registration.

### Complex / Risky

- **This is a diagnosis before it is a fix**, and the fix cannot be specified until step 1 produces its answer.
- **The failure is invisible.** Nothing logs, nothing throws, no test fails; the plan simply lands unassigned. Whatever fix lands must come with an assertion that fails loudly if it regresses, or the next occurrence is equally silent.
- **Two of the three candidate exits are shared code.** `getProjectIdByName` is used by `resolveProjectId`, `addProject`, `ensureProjectExists` and the board's own filters; `_isWorkspaceName` guards every insert path. A fix aimed at the watcher must not weaken resolve-only semantics for the others.
- **If the leading hypothesis is right, the bug is not in this function at all** — it is DB-instance lifecycle (two instances per file via path divergence, or a persistently failing `_reloadIfStale`). That is a wider fix than a null check, and the plan must not paper over it with a re-read that hides a coherency problem.

## Edge-Case & Dependency Audit

### Race Conditions

- `_reloadIfStale`'s 500ms stat debounce means an external write can be invisible to a lookup that lands inside the debounce window. That window is far too short to explain misses against a projects row created weeks ago, but the instrumentation's `visibleProjects` dump plus `instanceId` will distinguish it from instance divergence if the timing is ever that tight.
- Reproduction runs against a live watcher — write one file at a time so `[pin]` lines correlate unambiguously with files.

### Security

- No new input surface; instrumentation logs values already in memory. Do not log file contents wholesale — pin, wsId, instanceId, and the visible project names are sufficient and keep the exthost log readable.

### Side Effects

- **Instrumentation must be temporary and explicit.** The log lines added in step 1 exist to answer one question. Either remove them before merge or downgrade to `console.debug` behind an existing verbosity flag — a permanent per-import log on a 1,395-plan board is noise that will be ignored within a day.
- **Reproduction pollutes the board.** Each test plan file becomes a card. Use an obvious throwaway prefix, and clean up with `DELETE /kanban/plans?planId=…` plus removing the file. Note that the DELETE's on-disk effect lags (debounced/coalesced persist) — verify via `GET /kanban/plans` (what the board renders) **and** the file, and re-check the file after a pause before declaring cleanup complete.

### Dependencies & Conflicts

- **Do not "fix" it by auto-creating the project.** Resolve-only is deliberate: only the user creates projects, via `addProject`. An unknown pin must still drop to unassigned. The import guard is the backstop against phantom projects and must survive.
- **If the fix is a re-read from disk before resolution**, it runs on every plan import — 1,395 files on this board. Measure it, and prefer resolving `project_id` inside the same SQL statement (the `SELECT id FROM projects WHERE projects.name = plans.project` subquery pattern already used at KanbanDatabase.ts:670-672) over an extra async round trip per record. The subquery-in-`VALUES` shape is verified viable on the vendored sql.js (see Resolved Assumptions).
- **Multi-workspace interaction.** `record.workspaceId` is the value bound to the row's `workspace_id`, so it is observable after the fact and matched the projects row in every failing case examined. If step 1 shows it differing at call time, the bug is upstream in the ingestion engine's workspace resolution, not here — a different fix with different blast radius.
- **The cold/archive instance.** `getDistinctWorkspaceNamesUnion` reads it when `hasArchiveInstance(this._workspaceRoot)`. If exit 2 turns out to be the culprit, inspect what workspace names the archive contributes before changing the guard.
- **Recoverability is handled separately.** The sibling subtask (landing **first**) makes a pin apply when the stored project is empty. That does not fix this bug — it only means a second save of the file works around it — so do not treat the two as substitutes. Any fix here must keep the sibling's `test:contract:project-pin-fill` green; note the sibling adds CASE expressions to `insertFileDerivedPlan`'s ON CONFLICT clause, and `excluded.project_id` composes with a subquery-computed value if that fix shape is chosen.
- **Sibling overlap surfaces:** `PlanIngestionEngine.ts` (sibling edits ~line 795; this plan adds a log after line 705) and `package.json` (both append one script line) — trivial merges, sibling lands first. This plan's instrumentation owns `_resolveProjectForInsert`; the sibling no longer touches that function (its subtask decision moved into the SQL CASE).
- **Build/deploy dependency.** The running extension serves from `~/.devin/extensions/turnzero.switchboard-1.7.13/dist/`. Instrumentation is not live until built, synced there, and the window reloaded. Confirmed for this investigation that the installed bundle matches src, so there is no version skew to chase.

## Dependencies

- None (no session dependencies; the sibling-subtask ordering is recorded in the feature file's Dependencies & sequencing).

## Adversarial Synthesis

Key risks: (1) writing a fix before the diagnosis line exists — the enumerated fix shapes look actionable enough to tempt skipping step 1, and a wrong guess papers over a coherency bug; (2) instrumentation blind spots — logging only inside the pin branch (or reading the wrong log surface) yields silence and a stalled diagnosis; (3) a fix that weakens resolve-only or the shared lookup helpers. Mitigations: a hard gate on the `[pin]` line, entry/exit logging on both sides of the parse→resolve seam with `instanceId` in every line, and a regression test asserting the applied path plus resolve-only plus the unrepresentability of the stranded name-without-id state.

## Resolved Assumptions

Settled empirically this session (2026-07-30) — do not re-flag or re-research:

- Vendored sql.js bundles **SQLite 3.49.1**; a scalar subquery inside `INSERT … VALUES` works, and `excluded.project_id` in the ON CONFLICT clause reflects the subquery-computed value — so preferred fix shape 3a is viable as written, and it composes with the sibling's apply-if-empty CASE (probe verified fill / no-move / subtask-skip against this exact statement shape).
- `parsePlanMetadata`'s project regex (`planMetadataUtils.ts:102`) accepts plain, list-item, numbered, and blockquote pin forms, case-insensitively, and trims the capture (CRLF-safe).

## Proposed Changes

### 1. `src/services/KanbanDatabase.ts` — instrument the exits (temporary, first commit)

In `_resolveProjectForInsert`, log which exit fires and the values that decided it. **Every line carries `this.instanceId`** — if the `[pin]` lines and the board's writes show different instance ids for the same `kanban.db`, the two-instance hypothesis is confirmed in one repro run:

```ts
        if (record.project && record.project.trim() !== '') {
            const pin = record.project.trim();
            if (/^<.*>$/.test(pin)) {
                console.warn(`[pin] ${this.instanceId} DROP placeholder pin=${JSON.stringify(pin)} file=${record.planFile}`);
                return { project: '', projectId: null };
            }
            const isWsName = await this._isWorkspaceName(pin, record.workspaceId);
            if (isWsName) {
                console.warn(`[pin] ${this.instanceId} DROP workspace-name-guard pin=${JSON.stringify(pin)} wsId=${record.workspaceId} names=${JSON.stringify(await this.getDistinctWorkspaceNamesUnion(record.workspaceId))}`);
                return { project: '', projectId: null };
            }
            let projectId = record.projectId ?? null;
            if (projectId === null) {
                projectId = await this.getProjectIdByName(record.workspaceId, pin);
            }
            if (projectId === null) {
                // The decisive line: dump what THIS in-memory instance can see, so a
                // miss here can be compared against the same query run on the file.
                const visible = await this.getAllProjectNamesForDebug?.(record.workspaceId);
                console.warn(`[pin] ${this.instanceId} DROP resolve-miss pin=${JSON.stringify(pin)} wsId=${record.workspaceId} visibleProjects=${JSON.stringify(visible)}`);
                return { project: '', projectId: null };
            }
            console.log(`[pin] ${this.instanceId} APPLY pin=${JSON.stringify(pin)} -> id=${projectId} file=${record.planFile}`);
            return { project: pin, projectId };
        }
        // Zeroth-exit observability: the pin branch was never entered.
        console.warn(`[pin] ${this.instanceId} NO-PIN record.project=${JSON.stringify(record.project ?? null)} file=${record.planFile} (falls through to activeProjectFilter/unassigned)`);
```

Add the debug helper next to `getProjectIdByName` (also temporary):

```ts
    public async getAllProjectNamesForDebug(workspaceId: string): Promise<string[]> {
        if (!(await this.ensureReady()) || !this._db) return ['<db-not-ready>'];
        const stmt = this._db.prepare('SELECT name FROM projects WHERE workspace_id = ?', [workspaceId]);
        const out: string[] = [];
        try { while (stmt.step()) { out.push(String(stmt.getAsObject().name)); } } finally { stmt.free(); }
        return out;
    }
```

`visibleProjects` + `instanceId` together are the whole point: an empty/incomplete list on the instance that *also* persists the plan rows means the in-memory image genuinely lacks the row (coherency bug); a complete list means the miss is in the arguments; and mismatched instance ids across the repro mean two instances share one file.

### 1b. `src/services/PlanIngestionEngine.ts` — log the parse output (temporary, same commit)

Immediately after `parsePlanMetadata` (line 705), log what the parser actually produced, via the host logger so it lands in the **Switchboard output channel**:

```ts
            this._host.logger.appendLine(
                `[GlobalPlanWatcher] [pin-parse] project=${JSON.stringify(metadata.project ?? null)} file=${relativePath}`
            );
```

This closes the zeroth-exit blind spot: if `[pin-parse]` shows `null` for a file whose bytes carry a valid pin, the bug is in parse/plumbing and the `KanbanDatabase` exits are irrelevant; if it shows the pin but `KanbanDatabase` logs `NO-PIN`, the value is lost between the engine and the resolver (record construction).

### 2. Reproduce and read the answer

Build → sync to the install folder → reload the window. Write one throwaway plan pinned to an existing project, then read the logs. Clean up the card and file afterwards.

> **Superseded:** "read the Switchboard output channel for the `[pin]` line."
> **Reason:** `KanbanDatabase` logs via `console.*`, which does **not** reach the Switchboard output channel (only `_host.logger.appendLine` writes there). In a packaged (non-debug) window, `console.*` from the extension host lands in the editor's extension-host log files — the same surface used successfully in the earlier board-push investigation (grep the editor's `logs/**/window*/` for `renderer`/`exthost` logs).
> **Replaced with:** Read the `[pin-parse]` line in the **Switchboard output channel** (it uses the host logger), and the `[pin]` lines by grepping the **editor's extension-host log** for `[pin]`. If the exthost log proves awkward on the target editor, temporarily route the four `[pin]` lines through a logger callback passed into `KanbanDatabase` instead — the reading surface must be confirmed *before* the repro, not discovered during it.

### 3. Fix, per what step 2 shows

- **`resolve-miss` with `visibleProjects` empty or incomplete** → DB-instance coherency. First compare `instanceId` across the repro's `[pin]` lines and the board's own writes: two ids for one `kanban.db` = path-resolution divergence (fix the path normalization at `forWorkspace`/`_instancesByDbPath`, per the documented hazard at KanbanDatabase.ts:6156-6159); one id = the image itself is stale despite `_reloadIfStale` (check the exthost log for `"Reload from disk failed"` — fix the reload failure). Preferred belt-and-braces fix either way: resolve `project_id` inside the INSERT statement via the existing name-join subquery pattern (KanbanDatabase.ts:670-672) so resolution reads the same snapshot the write commits to (shape verified viable — see Resolved Assumptions).
- **`resolve-miss` with `visibleProjects` containing the name** → the mismatch is in the arguments: compare the logged `wsId` against the row's stored `workspace_id` and fix the upstream workspace resolution in `PlanIngestionEngine`.
- **`workspace-name-guard`** → inspect the archive's contribution to `getDistinctWorkspaceNamesUnion` and tighten the guard so a project name can never collide with an archived workspace name.
- **`placeholder`** → the pin text is arriving malformed; fix the parse in `planMetadataUtils.parsePlanMetadata`.
- **`NO-PIN` (with `[pin-parse]` null)** → the parser is failing on real files despite the inspected regex; fix `parsePlanMetadata` against the exact failing file bytes.
- **`NO-PIN` (with `[pin-parse]` showing the pin)** → the value is dropped between parse and record construction in `PlanIngestionEngine._handlePlanFile`; fix the plumbing there.

### 4. Regression test — assert the applied path, not the absence of a crash

```js
'use strict';
/**
 * Contract: a pin naming an existing project in the plan's workspace RESOLVES
 * on first insert. Measured before the fix: 9 of 9 fresh imports with a valid
 * pin landed project='' / project_id=null, silently.
 */
await db.addProject(wsId, 'Contract Project');
await db.insertFileDerivedPlan({ ...rec, project: 'Contract Project', projectId: null });
const row = await db.getPlanByPlanId(rec.planId);
assert.strictEqual(row.project, 'Contract Project', 'valid pin did not resolve on first insert');
assert.ok(row.projectId != null, 'project name stored with null project_id — strands the card on both filter paths');

// Resolve-only survives the fix.
await db.insertFileDerivedPlan({ ...rec2, project: 'Phantom Project', projectId: null });
const row2 = await db.getPlanByPlanId(rec2.planId);
assert.strictEqual(row2.project, '');
assert.strictEqual(await db.getProjectIdByName(wsId, 'Phantom Project'), null, 'resolve-only broken: pin minted a projects row');

// The stranded state is unrepresentable: non-empty name always has an id.
const stranded = await db.allPlansWithProjectButNoId?.(wsId) ?? [];
assert.strictEqual(stranded.length, 0, `${stranded.length} plans have a project name with no project_id`);
```

### 5. Remove the instrumentation, or gate it

Final commit strips the `[pin] APPLY`, `[pin] NO-PIN`, `[pin-parse]` lines and `getAllProjectNamesForDebug`, keeping the three `DROP` warnings at `console.debug` so the next silent failure has a trail.

### 6. `package.json` — register the test

```json
    "test:contract:project-pin-resolve": "node src/test/project-pin-resolve-contract.test.js",
```

(The sibling subtask adds its own script line here first — trivial merge.)

## Verification Plan

Per session directive (SKIP COMPILATION / SKIP TESTS), compilation and automated-test execution are **not** part of this plan's verification pass; the regression test is authored as a deliverable and runs in CI / the implementer's pipeline.

**Step 1 — diagnosis (gate: do not write the fix before this produces a line)**

1. With the instrumented build live (build/sync/reload is a deployment prerequisite outside this plan's verification scope), import one throwaway pinned plan.
2. The Switchboard output channel shows one `[pin-parse]` line, and the exthost log shows exactly one `[pin]` line for that file. Record which exit fired and the `visibleProjects` / `wsId` / `instanceId` values. Clean up the card and file; verify via `GET /kanban/plans` and the file, re-checking the file after a pause.

### Automated Tests

Authored, not run in this workflow:

3. `test:contract:project-pin-resolve` — first-insert resolution, resolve-only survival, stranded-state unrepresentability. Mutation check for the implementer's pipeline: revert the fix and confirm the first assertion fails.
4. `test:contract:project-pin-fill` (the sibling's recoverability contract) — must stay green after this fix.
5. The repo's standing gates (`verb-returns:check`, `push-routing:check`, `catalog:check`, `lint`) run in the implementer's pipeline; `catalog.json` line numbers shift with this edit.

### Manual Verification

6. Author a plan file with `**Project:** Browser Switchboard` and let the watcher import it. `sqlite3 .switchboard/kanban.db "SELECT project, project_id FROM plans WHERE plan_file LIKE '%<name>%';"` → `Browser Switchboard | 11` on the **first** import, with no API call.
7. The card appears on the board under Browser Switchboard without a refresh-and-hope cycle.
8. Author a plan pinned to `No Such Project` → lands unassigned, appears under Unassigned, and `SELECT * FROM projects` gained no row.
9. Board-wide invariant: `SELECT COUNT(*) FROM plans WHERE project <> '' AND project_id IS NULL;` → `0`.
10. Backfill the 7 known-stuck cards by touching their files; each resolves to its pinned project with a non-null id (exercises the sibling's fill path against this fix).

---

**Recommendation:** Complexity 7 → **Send to Lead Coder**.
