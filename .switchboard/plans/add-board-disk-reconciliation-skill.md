# A Reconciliation Skill for When the Board and Disk Disagree

## Goal

Add a `reconcile-board` skill that reports — and on request fixes — mismatches between the plan rows in `kanban.db` and the plan files on disk, so an agent that meets a card pointing at a file that no longer exists knows what to do instead of guessing.

### Problem & background

Switchboard has no disk-versus-database reconciliation on a populated workspace. `PlanIngestionEngine`'s only delete path is the live watcher event (`_setupWatcherForFolder` `:543` → `_debounceHandleDelete` `:720` → `_handlePlanDelete` `:1074`); its scans (`triggerScan` `:1118`, `_scanForNewFiles` `:439`) walk the plans/features directories and import what exists, never enumerating rows to check for absent files.

The one real reconciler, `KanbanDatabase.purgeOrphanedPlans` (`:5871`), has a single non-test caller — `TaskViewerProvider._syncKanbanDbFromSheetsSnapshot` (`:4531`, purge at `:4553`) — reachable only from a startup branch gated on an empty database:

```ts
const hasPlans = await db.hasActivePlans(wsId);
if (hasPlans) { /* DB-first: DB already has data … do NOT re-sync from files */ }
else { await this._collectAndSyncKanbanSnapshot(workspaceRoot, true); }  // ← only path
```
(`TaskViewerProvider.ts:4632-4648`)

So if a plan file disappears while nothing is watching that root — the extension is closed, the removal happened in a remote session and arrived later via `git pull` with the window shut, or it ran against a checkout no window has open — the row stays `status='active'` and the card stays on the board indefinitely. Nothing later notices.

That is what produced three stranded cards on 2026-08-14 (`d548ee36`, `352684b3`, `1eedb80d`), all still `active`, two of them `git rm`'d days earlier. They were cleared by hand, by reading raw SQL, because no tool existed to answer "which cards point at files that are gone?".

**The asymmetry matters.** The reverse mismatch — a plan file on disk with no row — self-heals: the watcher imports on create, and `_runStartupScan` imports anything created while the extension was down. Only row-without-file is a trap.

### Why a skill rather than a code fix

Calling `purgeOrphanedPlans` from the engine's scan tick would stop most stranded cards appearing. That is the durable fix and it is **not** this plan — it is a source change to shipped behaviour with its own blast radius (it tombstones rows automatically, including any row whose file is temporarily absent mid-git-operation). The skill is useful regardless: it works remotely, needs no release, and answers the diagnostic question ("is anything wrong?") that an automatic sweep never surfaces to the agent.

---

## Metadata

**Tags:** cli, reliability, devops

**Complexity:** 5

> **Superseded:** **Complexity:** 4
> **Reason:** The improve pass established that `--fix` cannot be one call to one route. The delete vehicle has to branch three ways on the row's kind (feature / subtask / loose plan) because `DELETE /kanban/plans` is the only delete path in the codebase that skips `regenerateFeatureFile`, and the orphan-file half needs a different endpoint entirely (`importPlanFiles` never reads `.switchboard/features/`). That is "majority routine with two moderate, well-scoped risks" — the Mixed band — not a single-file routine change.
> **Replaced with:** **Complexity:** 5. Recommendation is unchanged (4–6 → Send to Coder).

---

## User Review Required

**None.** Three decisions made here:

* **Report by default, act on `--fix`.** Not a confirmation gate — an agent investigating a weird card needs to run this to *answer* "is anything wrong?", and a diagnostic that deletes on sight cannot be used that way. `--fix` is one flag, takes no prompt, and acts immediately.
* **Its own skill, not a script inside `kanban_operations`.** Discovery is the whole point: an agent hits this when a card looks wrong, and `kanban_operations` is documented as "MANUAL FALLBACK ONLY, use only when the user explicitly requests a card move" — a description that would hide it. The new skill's description leads with the symptom.
* **Both directions reported; each has its own fix vehicle.**

  > **Superseded:** "Both directions reported, only one is a trap. File-without-row is listed and fixed with a single import call; the skill says plainly that it self-heals, so nobody treats it as urgent."
  > **Reason:** The "single import call" was `POST /kanban/plans/import` → `importPlanFiles` (`PlanFileImporter.ts:30-39`), which reads `.switchboard/plans/` **only**. An orphaned *feature* file is never imported by it, so the script would have printed `fixed: true` over a board that did not change. The self-heals claim also holds only while something is watching — the whole premise of this plan is a workspace where nothing was.
  > **Replaced with:** File-without-row is still the benign direction and the skill still says so, but the fix is `POST /kanban/verb/scanFoldersNow` (covers plans **and** features, recursively, in both hosts) — see Proposed Changes step 6. Row-without-file remains the trap and gets the three-way delete routing.

---

## Complexity Audit

* **Score:** 5 / 10

### Routine

* The script is a close variant of `.agents/skills/kanban_operations/reconcile-features.js` — same `findApiPort` walk, same `httpJson` helper, same `{ ok, … }` JSON-on-stdout contract, same `_lib/workspace-root` resolution with inline fallback.
* Every endpoint it needs already exists. No source change to `LocalApiServer`, `KanbanDatabase`, or the engine.
* `.vscodeignore:57` (`!.agents/**`) already ships any new `.agents/skills/` directory — no packaging step.

### Complex / Risky

* **Skill discovery is host-split.** Antigravity reads `.agents/skills/` from the filesystem; Claude Code reads the generated `.claude/skills/` mirror, which is built from `MIRROR_MANIFEST` in `src/services/ClaudeCodeMirrorService.ts:47`. A new skill directory that is not added to that array is invisible to Claude Code — the mirror generator iterates the manifest, not the directory (`:449-466`). This is the one step that silently half-works.
* **The mirror copies `SKILL.md` and nothing else.** `resolveSourceFile` (`:397-409`) resolves a directory source to its `SKILL.md`, and the generator writes exactly that one file into `.claude/skills/<name>/` (`:461-466`). Sibling `.js` files are **not** copied. Every command in the skill body must therefore name the script by its `.agents/` path, exactly as `kanban_operations/SKILL.md` does (`node .agents/skills/kanban_operations/move-card.js …`).
* **`workspaceRoot` must be threaded through every call.** Each root in a multi-root window writes the same port into its own `.switchboard/api-server-port.txt`, and the read/delete handlers fall back to one arbitrary root (`_resolveDbFromQuery` `:2874-2880`, `_handleDeletePlan` `:3064`). Omit it and the script reconciles the wrong board and reports a clean bill of health.
* **The delete vehicle is not interchangeable.** Three of the four delete paths in the codebase regenerate the parent feature's `## Subtasks` block after removing a subtask row (`PlanIngestionEngine` purge sweep `:673-679`, `TaskViewerProvider._handleDeletePlan` `:18530`, `PlanningPanelProvider` `deleteKanbanPlan` `:3810`). `DELETE /kanban/plans` (`LocalApiServer.ts:3051-3095`) is the one that does not. Picking it for a subtask row makes the reconciler manufacture a fresh instance of the defect it exists to clear.

---

## Edge-Case & Dependency Audit

### Race Conditions

* **A file mid-atomic-write reads as missing.** External editors save via temp+rename. `_handlePlanDelete` guards this with a 300 ms debounce plus an existence re-check (`:1079`); the script must do the equivalent — re-check each missing candidate after a short delay before reporting it, the same shape as `purgeOrphanedPlans`'s `ORPHAN_PURGE_CONFIRMATION_DELAY_MS` (350 ms, `KanbanDatabase.ts:853`).
* **A row soft-deleted seconds ago is invisible to the read.** `GET /kanban/plans` resolves through `getBoard`, which filters `status='active'` (`KanbanDatabase.ts:3630`). Rows already tombstoned are en route to the purge sweep and correctly excluded — the script must not try to "fix" them. Note the two tombstone values differ by path: the watcher writes `status='missing'` (`markPlanMissingByPlanFile`, `PlanIngestionEngine.ts:1108`), `purgeOrphanedPlans` writes `status='deleted'` (`KanbanDatabase.ts:5915`). Neither is `'active'`, so both are already excluded — the script never needs to distinguish them.
* **The DB write-back to disk is debounced.** `_persist` arms a 300 ms trailing timer (`KanbanDatabase.ts:9217-9237`, `PERSIST_DEBOUNCE_MS` `:1566`), so a `sqlite3` read of `kanban.db` taken immediately after `--fix` can still show a deleted row.

  > **Superseded:** "The script reports what the API returned; it must not verify itself by re-reading the file."
  > **Reason:** Half right, and the wrong half is load-bearing. Re-reading `kanban.db` **from disk** is indeed unreliable (the 300 ms `_persist` debounce). But re-reading `GET /kanban/plans` is not — that serves the in-memory sql.js state, which `_persistedUpdate` mutates synchronously before arming the debounce. And the script *must* re-read, because one of its three delete vehicles (`deleteKanbanPlan`) returns `{success:true}` unconditionally (see Side Effects), so the HTTP body alone cannot tell it whether the row went.
  > **Replaced with:** Never re-read `kanban.db` from disk to verify. **Always** re-read `GET /kanban/plans?workspaceRoot=<abs>` after the `--fix` pass and derive each row's `deleted` flag from whether its `planId` is still on the board. That is the only honest verification available.

### Security

* None. Reads plus existing delete/scan routes, all localhost-only. No new surface.
* **Auth is host-dependent.** `_checkAuth` (`LocalApiServer.ts:590-593`) returns `true` immediately when no token is configured — the extension host's loopback-trust behaviour. The **standalone** host (`npx switchboard`) does configure a token, so every request there needs `Authorization: Bearer <token>`. The sibling scripts send no token, so this script is extension-host-only by the same convention; say so in the SKILL.md rather than letting it fail as an opaque 401.

### Side Effects

* **`--fix` hard-deletes rows; it does not tombstone.** All three vehicles below end in `deletePlanByPlanId` (`DELETE FROM plans WHERE plan_id = ?`, `KanbanDatabase.ts`), which is what the human's Delete button does too. `deleteFile` / `planFile` is never passed — the file is already gone by definition, and passing it would be a no-op unlink that muddies intent and, on the `deleteKanbanPlan` path, triggers a pointless ENOENT warning.
* **The vehicle branches on the row's kind.**

  > **Superseded:** "`--fix` hard-deletes rows via `DELETE /kanban/plans?planId=` **without** `deleteFile`" — for every stranded row.
  > **Reason:** `DELETE /kanban/plans` (`LocalApiServer.ts:3051-3095`) removes the row and does nothing else. For a **subtask** row it leaves the parent feature's auto-generated `## Subtasks` block listing a subtask that now has neither a file nor a DB row — a board/disk disagreement created by the tool whose job is to clear board/disk disagreements. For a **feature** row it leaves every child with `feature_id` pointing at a feature that no longer exists, and leaves the `**Feature:** <deadId>` carrier line in each child's `.md` so the link is re-applied on the next import. Both are silent.
  > **Replaced with:** Route by kind (full request shapes in Proposed Changes step 6): `isFeature` row → `POST /kanban/verb/deleteFeature` with `deleteSubtasks:false`, which calls `clearFeatureIdForFeature` and strips the `**Feature:**` carrier from each kept subtask file (`KanbanProvider.ts:13083-13123`); row with a non-empty `featureId` → `POST /planning/verb/deleteKanbanPlan`, the only delete route that calls `regenerateFeatureFile` (`PlanningPanelProvider.ts:3810`); loose plan row → `DELETE /kanban/plans` as originally planned.

* **`deleteKanbanPlan` cannot report its own failure.** Its arm ends in `break`, not `return` (`PlanningPanelProvider.ts:3819`) — it posts `kanbanPlanDeleted` to the webview and falls through, so `_handlePlanningVerb` sees `undefined` and answers `{success:true}` on both the success and the `catch` branch. This is a known PRD contract #4 residue for that arm, not a new defect and not this plan's to fix. It is why the post-fix board re-read is mandatory rather than nice-to-have.
* Unlike the watcher's purge sweep, none of these routes archive a ClickUp/Linear/Notion counterpart even when that provider's `deleteSyncEnabled` is on (compare `runPurgeSweep` `:627-679`). A reconciled card can leave a live remote issue behind. Report the row's `clickupTaskId` / `linearIssueId` / `notionPageId` when present so the operator can see it; do not attempt the archive.
* **`scanFoldersNow` is wider than `importPlanFiles` on the extension host.** The extension arm routes through `KanbanProvider.triggerPlanScan` (`:1787-1800`), which scans **every** watch folder, not just the root in the payload; the standalone arm scans only the passed root (`bootstrap.ts:949-958`). The operation is import-only — it adds rows for files that exist — so the wider scope is additive, never destructive. Note it in the report line rather than pretending the call is root-scoped.

### Dependencies & Conflicts

* **New: `.agents/skills/reconcile-board/SKILL.md`** and **`.agents/skills/reconcile-board/reconcile-plans.js`**.
* **`src/services/ClaudeCodeMirrorService.ts:47`** — `MIRROR_MANIFEST` needs one entry. Source change, one array element.
* **`AGENTS.md`** — one row in the "Available Skills" table. `CLAUDE.md` inherits it via the same source (edit `.agents/` + `AGENTS.md`, never the generated `CLAUDE.md` / `.claude/skills/`).
* **`.agents/skills/_lib/workspace-root.js`** — reused as-is, with the same inline fallback the sibling scripts carry.
* **`.agents/.switchboard-bundled.json` — do NOT hand-edit.** It is a generated ledger written by `ControlPlaneMigrationService` (`:1174-1288`) from a recursive walk of the shipped bundle. A locally added skill is neither in `currentBundlePaths` nor in `previousFiles`, so the prune loop (`:1195-1240`) never touches it; it is counted in the diagnostic `extra` tally and nothing more.
* Read-only references, no change: `LocalApiServer.ts` (`_handleReadEndpoint` `:2744`, `_handleGetPlans` `:2801`, `_resolveDbFromQuery` `:2874`, `_resolveBoard` `:2883`, `_handleKanbanVerb` `:2015`, `_handleDeletePlan` `:3051-3095`, route table `:3913`/`:3917`/`:3989`/`:4019`), `KanbanDatabase.ts` (`getBoard` `:3630`, `PLAN_COLUMNS` `:855`, `_readRows` `:10106`, `_resolveAbsolutePlanFile` `:10036`), `PlanFileImporter.ts` (`listImportablePlanFiles` `:162`, `isRuntimeMirrorPlanFile` `:238`), `PlanIngestionEngine.ts`, `KanbanProvider.ts` (`scanFoldersNow` arm `:7966-7969`, `_deleteFeature` `:13083`), `PlanningPanelProvider.ts` (`deleteKanbanPlan` `:3765-3820`), `verbSchemas.ts` (`deleteKanbanPlan` `:591`), `TaskViewerProvider.ts:4632-4648`.
* **Sequencing:** independent of the `improve-feature` wording fix (`fix-improve-feature-plan-deletion-instruction.md`). Either can land first. The wording fix tells an agent a remote `git rm` leaves the card behind; this skill is what it uses to clean up after one.

---

## Dependencies

* None.

---

## Adversarial Synthesis

Key risks: (1) **the manifest entry is forgotten**, leaving a skill that works in Antigravity and does not exist in Claude Code — the one failure here that produces no error; (2) **the wrong delete vehicle is used for a subtask or feature row**, which succeeds, clears the card, and silently leaves the parent feature file (or the orphaned children) describing a plan that no longer exists — the reconciler manufacturing the defect it exists to clear; (3) **`workspaceRoot` omitted from a call**, which returns a confident empty result rather than an error and reads as "nothing wrong"; (4) **transient misses reported as stranded**, if the existence check is single-shot against a file being atomically rewritten. Mitigations: the manifest entry is a numbered step with its own verification; `--fix` routes on `isFeature`/`featureId` before choosing an endpoint and re-reads the board afterwards to derive every `deleted` flag rather than trusting the response body; every request carries `workspaceRoot` from the resolved root; missing candidates are re-checked after a short delay before being reported or deleted.

---

## Proposed Changes

### `.agents/skills/reconcile-board/reconcile-plans.js` (new)

**Context:** model on `.agents/skills/kanban_operations/reconcile-features.js` — copy its `findApiPort` walk, `httpJson` helper, workspace-root resolution with inline fallback, and the "single JSON object on stdout, diagnostics to stderr" contract.

**Usage:**

```
node .agents/skills/reconcile-board/reconcile-plans.js [workspace_root] [--fix]
```

**Logic:**

1. Resolve `workspaceRoot` (`_lib/workspace-root`, falling back to `process.cwd()`), then `findApiPort` by walking up for `.switchboard/api-server-port.txt`. If no port, exit with `{ ok: false, error: 'Switchboard extension not reachable …' }` — same message shape as the siblings.

2. `GET /kanban/plans?workspaceRoot=<abs>` → the active board.

   > **Superseded:** "Each row carries `plan_id`, `plan_file`, `topic`, `kanban_column`, `status`, `is_feature`, `feature_id` and the provider ids (`PLAN_COLUMNS`, `KanbanDatabase.ts:855`)." — and, in step 3, "resolve `plan_file` against the workspace root (it is stored relative)".
   > **Reason:** `PLAN_COLUMNS` is the SQL column list, not the wire shape. `_readRows` (`KanbanDatabase.ts:10106-10160`) maps every row to a camelCase `KanbanPlanRecord` **and** expands `plan_file` to an absolute path via `_resolveAbsolutePlanFile` (`:10036`) at the read boundary. `_handleReadEndpoint` (`LocalApiServer.ts:2755-2757`) then wraps the array as `{ success: true, data: [...] }`. A script written to the superseded description reads `parsed[i].plan_file` → `undefined` → `path.resolve(root, undefined)` throws `TypeError: Path must be a string`. It does not degrade; it crashes.
   > **Replaced with:** Parse the envelope as `{ success, data }` and read rows from `data`. Fields are `planId`, `planFile` (**already absolute**), `topic`, `kanbanColumn`, `status`, `isFeature` (number), `featureId`, `clickupTaskId`, `linearIssueId`, `notionPageId`. Feed `planFile` straight to `fs.existsSync` — no `path.resolve` against the root (harmless if added, since `path.resolve` ignores earlier arguments once a later one is absolute, but it misrepresents the contract).

3. **Stranded rows:** `fs.existsSync(row.planFile)` for each row. Collect misses, `await` ~400 ms, re-check, and keep only those still absent. Skip any row whose `planFile` is empty.

4. **Orphan files:** enumerate the same set the importer considers importable, or the report lists files no `--fix` can ever clear:
   * `.switchboard/plans/*.md`, **plus one immediate `<repoName>/*.md` layer** — `listImportablePlanFiles` (`PlanFileImporter.ts:162-202`) walks exactly that shape, and a sub-repo plan file is a real orphan candidate in a multi-root workspace.
   * `.switchboard/features/*.md`.
   * **Exclude** `isRuntimeMirrorPlanFile` names — `brain_<64 hex>.md` and `ingested_<64 hex>.md` (`PlanFileImporter.ts:238-241`). These are runtime mirrors that no import path ever ingests; listing them would report permanent, unfixable orphans on every run.
   * Collect any surviving path that matches no row's `planFile` (compare resolved-absolute to resolved-absolute).

5. **Report** (default): print
   `{ ok: true, stranded: [{ planId, planFile, topic, column, isFeature, featureId, clickupTaskId?, linearIssueId?, notionPageId? }], orphanFiles: [path], fixed: false }`.
   Include the provider ids only when non-empty — their presence is the operator's cue that a live remote issue will be left behind.

6. **`--fix`:** route each stranded row by kind, then verify.

   > **Superseded:** "for each stranded row, `DELETE /kanban/plans?planId=<id>&workspaceRoot=<abs>` — no `deleteFile`, the file is already gone. If any orphan files were found, one `POST /kanban/plans/import` with `{ workspaceRoot }` covers them all."
   > **Reason:** Two independent failures. (a) `DELETE /kanban/plans` is the only delete path that skips `regenerateFeatureFile` and has no feature-detach step, so it silently corrupts feature membership for subtask and feature rows (see Side Effects). (b) `POST /kanban/plans/import` runs `importPlanFiles`, which reads `.switchboard/plans/` only (`PlanFileImporter.ts:34-39`) — an orphaned feature file is never imported, and the script would print `fixed: true` over an unchanged board.
   > **Replaced with:** the four calls below.

   * **`isFeature` row** → `POST /kanban/verb/deleteFeature` with `{ sessionId: <planId>, workspaceRoot, deleteSubtasks: false }` (the arm keys the feature on `msg.sessionId`, `KanbanProvider.ts:12181-12188`). `_deleteFeature` (`:13083-13123`) detaches the children via `clearFeatureIdForFeature` and strips the `**Feature:** <deadId>` carrier line from each kept subtask file, so nothing re-links on the next import. Returns `{success, error?}` honestly.
   * **Row with a non-empty `featureId`** (a subtask) → `POST /planning/verb/deleteKanbanPlan` with `{ planId, workspaceRoot }`. Pass **no** `planFile`: the field is absent from the verb's schema (`verbSchemas.ts:591-597`) and would only drive an ENOENT unlink of a file that is already gone. This is the only route that regenerates the parent feature's `## Subtasks` block (`PlanningPanelProvider.ts:3806-3814`). Ignore its response body — it is `{success:true}` either way.
   * **Loose plan row** (no `featureId`, not a feature) → `DELETE /kanban/plans?planId=<id>&workspaceRoot=<abs>`, no `deleteFile`. Returns `{ success, fileDeleted }`.
   * **Orphan files** → one `POST /kanban/verb/scanFoldersNow` with `{ workspaceRoot }`. `triggerScan` (`PlanIngestionEngine.ts:1118-1152`) recurses `.switchboard/plans/` **and** `.switchboard/features/`, which is what the board's own Scan Folders button does (`kanban.html:5094` → `kanbanService.scanFoldersNow` `:129` → `KanbanProvider.triggerPlanScan` `:1787`), and it is wired in both hosts (standalone: `bootstrap.ts:949-958`). Skip the call entirely when `orphanFiles` is empty.

   Then **re-read `GET /kanban/plans?workspaceRoot=<abs>`** and set each stranded entry's `deleted` to `!board.some(r => r.planId === entry.planId)`. Print the same object with `fixed: true`, the per-row `deleted` flag, the HTTP status on any non-2xx, and `rescanned: true|false`. A failed call never aborts the rest of the pass.

**Edge cases:** rows already tombstoned (`status='missing'` or `'deleted'`) never appear — the board read excludes them (`getBoard` filters `status='active'`) — and must not be synthesised from anywhere else. `isFeature` rows live under `.switchboard/features/`; their `planFile` is absolute like any other, so no special resolution is needed, only the special delete vehicle. Never write to `.switchboard/` directly; every mutation goes through the API.

### `.agents/skills/reconcile-board/SKILL.md` (new)

Symptom-led, short. It must cover:

* **When to use:** a card points at a plan file that does not exist; a plan was deleted or `git rm`'d and its card is still on the board; the board and `.switchboard/plans/` disagree; after a restructure done in a remote session.
* **Why it exists:** nothing reconciles disk against the DB on a populated workspace (`TaskViewerProvider.ts:4632-4648`), so a file removed while nothing was watching leaves its row `active` forever.
* **How:** `node .agents/skills/reconcile-board/reconcile-plans.js <workspace_root>` to report, `--fix` to act. Write the path in full — the Claude Code mirror ships only `SKILL.md`, never the sibling `.js`, so a bare `node reconcile-plans.js` is unrunnable. This matches `kanban_operations/SKILL.md`, which spells out every script path.
* **Requires the extension running** (`.switchboard/api-server-port.txt`), and specifically the **extension** host: the standalone `npx switchboard` host requires a bearer token that this script, like its siblings, does not send.
* **What it will not do:** archive a linked ClickUp/Linear/Notion issue — report the id, leave the remote alone.
* **What `--fix` does to feature structure:** deleting a stranded feature card detaches its subtasks (they stay on the board, unlinked) rather than deleting them; deleting a stranded subtask rewrites the parent feature file's `## Subtasks` block.

### `src/services/ClaudeCodeMirrorService.ts`

Add one entry to `MIRROR_MANIFEST` (`:47`):

```ts
{
    source: 'skills/reconcile-board', name: 'reconcile-board', invocation: 'default', allowedTools: 'Bash',
    descriptionFallback: 'Reconcile the kanban board against the plan files on disk — find and clear cards whose plan file no longer exists'
},
```

Two details that a copy-the-neighbour edit gets wrong:

* **`invocation: 'default'`, not `'no-model'`.** Every other script-bearing entry in the manifest — `clickup-*`, `kanban-operations`, `worktree-cleanup`, `get-tickets`, `generate-diagram` — is `'no-model'` (slash-only, hidden from model auto-invoke). Pattern-matching to them here would produce a skill that exists, that `/reconcile-board` runs, and that **no agent ever discovers on its own** — which is the entire stated rationale for making this a separate skill rather than a script inside `kanban_operations`. `'default'` is slash **plus** model-auto. This divergence is deliberate.
* **`allowedTools: 'Bash'`** — the skill's only action is shelling out to node; every sibling that shells out declares it.

Without the manifest entry at all, the skill is invisible to Claude Code; the generator iterates the manifest, not the directory (`:449-466`).

### `AGENTS.md`

One row in the "Available Skills" table:

| `reconcile-board` | A card points at a plan file that no longer exists, or the board and `.switchboard/plans/` disagree — report the mismatches and optionally clear the stranded rows. |

---

## Verification Plan

Automated tests and compilation are skipped per session directive.

### Automated Tests

* Not run (session directive).

### Manual Verification

1. **Reproduce a stranded card:** with the extension **closed**, `rm` a throwaway plan file. Reopen the workspace. The card is still on the board and its row is still `status='active'` — this is the state the skill exists for.
2. **Report:** `node .agents/skills/reconcile-board/reconcile-plans.js <root>` lists exactly that plan under `stranded`, with its `planId` and column, and `fixed: false`. Confirm the output parsed the `{success, data}` envelope — a report of zero stranded rows on a board that visibly has one means the envelope or the camelCase field names were missed.
3. **Fix a loose plan:** re-run with `--fix`. The card leaves the board and the entry reports `deleted: true`, derived from the post-fix board re-read rather than the delete response.
4. **Fix a stranded subtask:** repeat with a plan that belongs to a feature. After `--fix`, open the parent `.switchboard/features/<feature>.md` and confirm the `## Subtasks` block no longer lists the deleted subtask. This is the check that distinguishes the correct vehicle from `DELETE /kanban/plans`.
5. **Fix a stranded feature:** delete a feature file with the extension closed, reopen, `--fix`. Confirm the feature card is gone, its former subtasks are still on the board as loose plans, and each of their `.md` files no longer carries a `**Feature:** <deadId>` line.
6. **Orphan file:** drop a `.md` into `.switchboard/features/` with the extension closed, reopen, run `--fix`, and confirm a card appears. `POST /kanban/plans/import` would not have produced one — this step is what proves the endpoint change landed.
7. **Runtime mirrors are not reported:** confirm any `brain_<hash>.md` / `ingested_<hash>.md` present in `.switchboard/plans/` is absent from `orphanFiles`.
8. **Multi-root:** run from a window with two roots open and confirm the report covers the root passed as `workspace_root`, not whichever root the API happens to default to.
9. **Claude Code discovery:** after the manifest entry lands, confirm `.claude/skills/reconcile-board/SKILL.md` is generated and its frontmatter carries the description and `allowed-tools: Bash`. Confirm the skill body names the script by its full `.agents/` path — the `.js` is not mirrored alongside it.

---

## Recommendation

Complexity 5 → **Send to Coder.**

**Follow-up, not in scope:** calling `purgeOrphanedPlans` from the engine's periodic scan tick would stop most stranded cards occurring at all. That is a source change to shipped behaviour and deserves its own plan; this skill is useful either way.

**Migration:** none. Two new files, one manifest entry, one docs row. No state change.
