# Serialize feature-file subtask-block regeneration so the file can't silently lose subtasks the DB has

## Goal

Make the `<!-- BEGIN SUBTASKS -->` block in a feature's markdown file a faithful, self-healing projection of the `plans` table. Today it is a lossy write-time snapshot: a feature can hold 10 linked subtasks in the database and on the board while its file lists only 8, with no error, no warning, and no path back to consistency short of a manual edit.

### The observed failure

`.switchboard/features/tickets-panel-extraction-b374fd5a-faef-4ad9-9ad0-0fbf3d0174d3.md` lists **8** subtasks. The board reports **10**. The database is correct — all ten rows carry `feature_id = b374fd5a-faef-4ad9-9ad0-0fbf3d0174d3`, `status = 'active'`, in the same workspace:

| rowid | plan | column | in file? |
|---|---|---|---|
| 3360 | tickets-panel-1-lift-shared-webview-helpers-into-sharedutils | CODE REVIEWED | yes |
| 3361 | tickets-panel-2-extract-tickets-tab-into-standalone-panel | CODE REVIEWED | yes |
| 3362 | tickets-panel-3-decollide-duplicate-tickets-folder-verbs | CODE REVIEWED | yes |
| 3363 | tickets-panel-4-move-clickup-and-linear-config-out-of-setup | CODE REVIEWED | yes |
| 3384 | tickets-panel-2a-tickets-panel-foundation-and-state | CREATED | **no** |
| 3385 | tickets-panel-2b-source-selection-and-ticket-folders | CREATED | **no** |
| 3386 | tickets-panel-2c-ticket-list-and-local-file-load | CREATED | yes |
| 3387 | tickets-panel-2d-ticket-detail-and-mutations | CREATED | yes |
| 3388 | tickets-panel-2e-comments-mentions-and-attachments | CREATED | yes |
| 3389 | tickets-panel-2f-sync-import-cleanup-and-migration | CREATED | yes |

The two missing rows are not a filter artefact. Both are `active`, both are linked, and both appear on the board and in `.switchboard/kanban-state-created.md` with `subtask-of:"Tickets Panel Extraction"`.

### Root cause — the board's FEATURE button fans one click out into N racing whole-file rewrites

The user selected the feature plus six plans and pressed the FEATURE button once. That button does **not** send one batched request. `src/webview/kanban.html:12369-12375` loops the selection and fires one fire-and-forget message per card, all in a single synchronous tick:

```js
nonFeatures.forEach(sub => {
    ...
    postKanbanMessage({ type: 'addSubtaskToFeature', featureSessionId, subtaskSessionId: subCard.planId || subCard.sessionId, workspaceRoot: featureCard.workspaceRoot });
});
```

The host handler (`KanbanProvider.ts:10906-10937`) treats every message as a standalone operation and rewrites the **entire** feature file for each one:

```ts
await db.updateFeatureStatus(subtask.planId, 0, feature.planId);
await this._regenerateFeatureFile(workspaceRoot, feature.planId, db);   // full-file read-modify-write
await this._refreshBoard(workspaceRoot);
```

Six handlers therefore run concurrently — each with roughly eight `await` points before its write — and each performs an independent three-step read-modify-write on one path:

1. `await db.getSubtasksByFeatureId(featurePlanId)` — snapshot the DB (`KanbanDatabase.ts:6009`)
2. `await fs.promises.readFile(featureAbsPath)` — snapshot the file
3. `await fs.promises.writeFile(featureAbsPath, newContent)` — overwrite the whole file

There is no lock of any kind. **Whichever handler writes last wins, regardless of which read last** — a classic lost update, and the loser's extra subtasks are gone from the file permanently.

The timestamps confirm the interleaving. The six `updateFeatureStatus` writes landed within a 4 ms window, in reverse selection order:

```
2f  updated_at 2026-08-03T06:54:37.766Z   ← first DB link
2e  updated_at 2026-08-03T06:54:37.766Z
2d  updated_at 2026-08-03T06:54:37.767Z
2c  updated_at 2026-08-03T06:54:37.767Z
2b  updated_at 2026-08-03T06:54:37.768Z   ← missing from the file
2a  updated_at 2026-08-03T06:54:37.769Z   ← last DB link, missing from the file
```

The two rows the file lost are exactly the **last two linked**. The regeneration that won the file race had taken its DB snapshot before `.768`/`.769` landed, so it emitted 8 of 10 and then overwrote the handler output that had all ten. The feature file's mtime (`06:54:37`) and the single `[GlobalPlanWatcher] Changed:` burst in the extension log confirm one surviving write, and it was a stale one. With six racers the surviving count is scheduling-dependent — 8 here, any value from 5 to 10 on a re-run.

### The correct batch primitive already exists — the button doesn't use it

`KanbanProvider.assignPlansToFeature` (`12340`) links every plan in a loop and regenerates **once** afterwards (`12391-12393`); its own docstring says "Regenerates the feature file + refreshes the board ONCE after the loop." It is reachable only from the LocalApiServer endpoint `/kanban/features/assign` (the path `.agents/skills/kanban_operations/assign-to-feature.js` uses) and from the reconcile path at `12669`. The board's FEATURE button never touches it. **That asymmetry is the bug**: attaching six subtasks from the CLI is safe, attaching the same six from the board is not.

The two other UI surfaces that post `addSubtaskToFeature` — `planning.js:7805` and `project.js:2730` — are both single-card dropdown pickers, so they cannot self-race. Only `kanban.html`'s multi-select FEATURE button fans out.

### The same unserialized method is reachable from 20+ other places

Fixing the button removes the reported trigger but not the hazard. `_regenerateFeatureFile` has **25 call sites in `KanbanProvider.ts` alone** (4771, 6786, 6788, 6854, 6856, 9498, 9502, 9529, 9533, 9571, 9575, 9623, 9628, 9642, 9647, 9954, 9958, 10942, 11014, 11893, 11912, 11952, 12313, 12399), plus the public wrapper `regenerateFeatureFile` at `11908` that `src/extension.ts:810` injects into `PlanIngestionEngine` — the *file watcher* — where it fires from two more (`PlanIngestionEngine.ts:512` on purge, `:607` on a `**Feature:**` frontmatter link). A board move that cascades a feature, a watcher import, and a manual attach can still overlap. So the button fix and the mutex are both required, and neither substitutes for the other.

> **Line-reference note:** All citations in this plan were re-verified against current `main` on 2026-08-04. Earlier drafts referenced lines offset by up to ~190 (e.g. `PlanningPanelProvider` `4008`→`3816`, `_regenerateFeatureFile` body `11708`→`11715`, `addSubtaskToFeature` case `10906`→`10913`, `assignPlansToFeature` `12340`→`12347`, wrapper `11901`→`11908`). An implementer should re-resolve each citation at edit time regardless — the file is large and active.

### Two compounding defects found alongside it

- **A guaranteed-drift path with no regeneration at all.** `PlanningPanelProvider.ts:3816` (`addSubtaskToFeature` in the project webview) calls `db.updateFeatureStatus(...)` (`:3842`) and then only re-posts `kanbanPlansReady` (`:3845`). It never regenerates the feature file. Every subtask attached from that surface drifts on the first attach — no race required. The sibling handler two cases below it (`removeSubtaskFromFeature`, `:3851`) was already fixed by delegating to `KanbanProvider._removeSubtaskFromFeature`, and its comment records that the previous local body "only did `updateFeatureStatus` and omitted regen" — the same bug, fixed on the remove side and left standing on the add side.
- **The file and the board badge count subtasks with different predicates (out of scope — noted, not addressed).** The file lists `status = 'active'` only (`KanbanDatabase.ts:6009`); the board badge counts `status IN ('active','completed')` (`getSubtaskCountsByFeature`, `KanbanDatabase.ts:6030`, whose comment states the choice deliberately). A completed subtask therefore shows in the badge and never in the file. This is a long-standing design choice, not the race, and the drift detector (change 4) compares the file against `getSubtasksByFeatureId` (both `active` only) — the badge is not involved in drift detection, so the two predicates coexist without interfering with the fix. Left unchanged.

### Why it never self-corrects *within a session* — and does self-correct on restart

`_regenerateFeatureFile` is only ever reached as a side effect of a *mutation* within a running session, so once a write is lost the file stays wrong for the rest of that session until the feature happens to be mutated again. Agents are instructed to **preserve** the block verbatim (`agentPromptBuilder.ts:756`, `PlanningPanelProvider.ts:6811`, `.agents/skills/improve-feature/SKILL.md`) — so an `improve-feature` pass reading a drifted file *within that same session* copies the drift forward into its rewrite, laundering a transient race into a session-scoped record.

> **Superseded:** "Nothing compares the file's block against the DB on scan, on activation, or on board refresh, so once a write is lost the file stays wrong until the feature happens to be mutated again... laundering a transient race into a permanent record."
> **Reason:** A full self-heal sweep already runs on every extension startup. `regenerateAllFeatureFiles` (`KanbanProvider.ts:11885`) is invoked on a 3-second startup timer from `TaskViewerProvider.ts:4126-4128` and re-derives every feature file from the DB through the same `_regenerateFeatureFile` (no-op-guarded, so clean files are skipped and the watcher is not re-fired). The drifted `tickets-panel-extraction` file in the wild would have been repaired on the user's next restart — no fix required. The drift is therefore **transient-until-next-restart**, not permanent, and the "permanent record" framing over-states the severity.
> **Replaced with:** The drift is session-scoped: it persists for the remainder of the running session and through any same-session agent pass that preserves the block, but the existing restart sweep heals it. The load-bearing fixes (kill the race at its source, serialize the writer, fix the missing-regen path) are still required to prevent the race from re-occurring *every time the button is pressed*; the restart sweep only limits the blast radius, it does not prevent the race. Change 4 below is accordingly reworked to **extend the existing sweep with drift logging** rather than introduce a parallel method.

## Metadata

**Complexity:** 6
**Tags:** bugfix, reliability, backend, database

## Complexity Audit (Routine vs Complex/Risky)

**Routine**

- Batching the FEATURE button into one message and routing it to `assignPlansToFeature`. The primitive already exists, is already used by `/kanban/features/assign`, and already regenerates once at the tail — this is a wiring change, not new logic.
- Adding a per-feature-file promise-chain mutex — a standard `Map<string, Promise<void>>` tail-chain. No new dependency, no schema change.
- Adding the missing `_regenerateFeatureFile` call to `PlanningPanelProvider`'s `addSubtaskToFeature`. The sibling `removeSubtaskFromFeature` case already shows the exact delegation shape to copy.
- Backfilling the currently-drifted `tickets-panel-extraction` file — one regeneration call once the fix is in.

**Complex / Risky**

- **The per-card warning surface changes shape.** The old fan-out gave one `showWarningMessage` per rejected card; the batch gives `skipped[]`. Six invalid cards used to mean six modals — arguably an improvement — but any test or user habit keyed to the per-card message will change. Verify the summary warning actually names the count, or a partially-failed batch looks like a success.

- **The mutex must not deadlock or re-enter.** `_regenerateFeatureFile` is called from inside methods that themselves call `_refreshBoard`, which can reach further regeneration paths. If the critical section transitively re-enters the same key while holding it, the chain never settles. The section must be strictly the DB-read → file-read → file-write, with no board refresh, no outbound sync, and no `await` on anything that can call back into regeneration.
- **The key must be the resolved absolute file path, not the planId.** Two features cannot share a file, but the same feature is addressed by planId in some call sites and by `feature.planFile` in others; keying on planId while a rename is in flight would leave two chains on one file. Resolve the path first, key on that.
- **Moving the DB read inside the critical section changes what a caller observes.** After the change, `assignPlansToFeature`'s tail regeneration reflects the DB *at the moment the lock is acquired*, not at call time — which is the point, but it means a caller can no longer assume the file it just triggered matches the array it just wrote. Nothing currently relies on that, but the reconcile path (`KanbanProvider.ts:12650`) diffs `getSubtasksByFeatureId` against a desired set and must keep reading the DB itself, not the file.
- **The content-no-op guard and the bodyless-husk guard must both stay inside the lock.** They compare against `existingContent`, which is only meaningful if no other writer can interleave between the read and the write. Leaving either outside the lock reintroduces the race in a narrower window.
- **A drift detector that auto-writes is itself a writer.** Any reconciliation pass must go through the same mutex, must respect the existing bodyless-husk refusal, and must not fire on features whose file is legitimately absent.

## Edge-Case & Dependency Audit

- **Re-entrancy through `_refreshBoard`.** `assignPlansToFeature` calls `_regenerateFeatureFile` then `_refreshBoard` (`12392–12393`). Keep the refresh outside the lock. Verify no path inside the critical section awaits a board refresh.
- **The watcher-injected callback.** `extension.ts:810` hands `regenerateFeatureFile` to `PlanIngestionEngine`. That callback goes through the public wrapper at `11901`, which delegates to the private method — so locking the private method covers the watcher path automatically. Confirm no other module holds a direct reference to the private method.
- **`registerPendingCreation` ordering.** `GlobalPlanWatcherService.registerPendingCreation(featureAbsPath)` is called immediately before the write specifically so the watcher ignores the self-write. It must stay immediately before `writeFile`, inside the lock. The existing comment at `11855–11863` explains why it must come *after* the no-op check; preserve that ordering exactly.
- **Multi-workspace.** `_regenerateFeatureFile` takes `workspaceRoot` and resolves `path.resolve(workspaceRoot, feature.planFile)`. Two workspaces can hold same-named feature files; the absolute path as key handles this. Do not key on basename.
- **Features with zero subtasks.** The generator emits `- [ ] (no subtasks)`. The drift check must treat that as "0 subtasks", not as one malformed entry.
- **Concurrent extension hosts.** Two editor windows on the same workspace hold separate `KanbanProvider` instances, so an in-process mutex does not cover cross-process racing. This is out of scope — but the drift detector is what makes it survivable, so do not drop the detector on the grounds that the mutex "already fixes it".
- **The WORKTREES block.** `_regenerateFeatureFile` also splices a `<!-- BEGIN WORKTREES -->` block from `db.getWorktrees()` in the same read-modify-write. It has the identical race and must be inside the same critical section — it already is, by virtue of living in the same method. Do not split the two blocks into separate locked sections.
- **The derived `**Complexity:**` line.** Recomputed from subtask scores in the same pass (`11828–11835`). A regeneration that saw 8 of 10 subtasks also wrote a complexity derived from 8. Backfilling the drifted file will correct the complexity line as a side effect; expect that diff and don't treat it as unrelated churn.
- **Agent-preserved blocks.** Fixing the writer does not fix files an `improve-feature` pass has already laundered. The backfill step is what closes those; it must run against every feature, not just the one reported.
- **`status = 'active'` vs `active + completed` (out of scope).** The file and the badge use different predicates by long-standing design (see "Two compounding defects" above). The drift detector compares the file against `getSubtasksByFeatureId` — both `active` only, already aligned — so the badge's predicate does not affect drift detection. No change to either predicate in this plan.

## Dependencies

- None. This plan is self-contained; no other plan or session must land first. The fix touches `KanbanProvider.ts`, `PlanningPanelProvider.ts`, `kanban.html`, and the startup hook in `TaskViewerProvider.ts` — all within the same module graph.

## Adversarial Synthesis

**Key risks:** (1) the plan originally over-stated severity by missing the existing `regenerateAllFeatureFiles` restart self-heal — corrected; the real risk is intra-session drift, not permanent corruption; (2) the per-file mutex must not re-enter through `_refreshBoard`/outbound sync — keep the critical section strictly DB-read → file-read → file-write, with refresh outside the lock. **Mitigations:** extend the existing sweep with drift logging instead of a parallel method (one authority); key the mutex on the resolved abs path and chain on settle so one throwing regen can't wedge the file; re-verify every line citation at edit time.

## Proposed Changes

### 1. `src/webview/kanban.html` + `src/services/KanbanProvider.ts` — make the FEATURE button one batched request

This is the primary fix: stop fanning one click into N whole-file rewrites. Replace the `forEach` at `kanban.html:12369-12375` with a single message carrying the whole selection:

```js
} else if (features.length === 1 && nonFeatures.length > 0) {
    const featureEntry = Array.from(selectedCards.entries()).find(([, v]) => v.isFeature);
    const featureId = featureEntry ? featureEntry[0] : '';
    const featureCard = currentCards.find(c => (c.planId || c.sessionId) === featureId);
    const featureSessionId = featureCard ? (featureCard.planId || featureCard.sessionId) : '';
    // ONE message for the whole selection. The previous per-card forEach fired N
    // independent addSubtaskToFeature messages, and each host handler rewrote the entire
    // feature file from its own DB snapshot — N racing read-modify-writes on one path,
    // last writer wins, silently dropping whichever subtasks the winner hadn't yet seen.
    const subtaskIds = nonFeatures
        .map(sub => Array.from(selectedCards.entries()).find(([, v]) => v === sub)?.[0])
        .map(id => currentCards.find(c => (c.planId || c.sessionId) === id))
        .filter(Boolean)
        .map(card => card.planId || card.sessionId);
    if (subtaskIds.length > 0) {
        postKanbanMessage({ type: 'addSubtasksToFeature', featureSessionId, subtaskIds, workspaceRoot: featureCard.workspaceRoot });
    }
    selectedCards.clear();
    ...
}
```

Add the matching host verb next to the existing `addSubtaskToFeature` case (`KanbanProvider.ts:10906`), delegating to the primitive that already does this correctly:

```ts
case 'addSubtasksToFeature': {
    const workspaceRoot = this._resolveWorkspaceRoot(msg.workspaceRoot);
    const subtaskIds = Array.isArray(msg.subtaskIds) ? msg.subtaskIds.map((s: any) => String(s)) : [];
    if (!workspaceRoot || !msg.featureSessionId || subtaskIds.length === 0) {
        return { success: false, error: 'workspaceRoot, featureSessionId and subtaskIds are required' };
    }
    // assignPlansToFeature links every plan, THEN regenerates the file and refreshes the
    // board once (KanbanProvider.ts:12391-12393). Same primitive /kanban/features/assign
    // already uses — which is why the CLI attach path never exhibited this bug.
    const result = await this.assignPlansToFeature(workspaceRoot, String(msg.featureSessionId), subtaskIds);
    if (!result.success) {
        void this._seams().ui.showWarningMessage(result.error || 'Failed to add subtasks to feature.');
        return result;
    }
    if (result.skipped.length > 0) {
        void this._seams().ui.showWarningMessage(
            `${result.assigned.length} subtask(s) added; ${result.skipped.length} skipped (already on another feature, missing, or itself a feature).`
        );
    }
    return result;
}
```

Two behaviour differences to carry deliberately, not by accident:

- **Skip-and-report replaces abort-on-first-bad.** The per-card handler surfaced a distinct warning per rejected card (`10915`, `10921`, `10927`, `10931`); `assignPlansToFeature` collects them into `skipped`. The single summary warning above preserves the feedback. The locked-column guard still hard-fails the whole batch, which matches the old behaviour where every card would have failed it anyway.
- **The lock check moves to once-per-batch.** `assignPlansToFeature` evaluates `feature_lock_columns` once up front (`12361-12365`) instead of once per card. Same outcome, one fewer `getConfig` per card.

Keep the existing single-card `addSubtaskToFeature` case — `planning.js:7805` and `project.js:2730` still use it, and both are single-card by construction.

### 2. `src/services/KanbanProvider.ts` — serialize regeneration per feature file

Add a static (or instance-level, if a single provider instance is guaranteed) chain map and wrap the existing body. Rename the current implementation to `_regenerateFeatureFileLocked` and make `_regenerateFeatureFile` the gate:

```ts
/** Tail of the in-flight regeneration chain, keyed by resolved absolute feature-file path. */
private static _featureRegenChains = new Map<string, Promise<void>>();

private async _regenerateFeatureFile(workspaceRoot: string, featurePlanId: string, db: KanbanDatabase): Promise<void> {
    // Resolve the file path BEFORE taking the lock — the key must be the file, not the
    // planId, because call sites address the same feature both ways.
    const feature = await db.getPlanByPlanId(featurePlanId);
    if (!feature || !feature.isFeature) {
        console.warn(`[KanbanProvider] _regenerateFeatureFile: not a feature (planId=${featurePlanId}), aborting.`);
        return;
    }
    const key = path.resolve(workspaceRoot, feature.planFile);
    const prev = KanbanProvider._featureRegenChains.get(key) ?? Promise.resolve();
    // Chain on settle, not on success: one throwing regen must not wedge the file forever.
    const next = prev
        .catch(() => { /* previous link's failure is its own to report */ })
        .then(() => this._regenerateFeatureFileLocked(workspaceRoot, featurePlanId, db));
    KanbanProvider._featureRegenChains.set(key, next);
    try {
        await next;
    } finally {
        // Only the last link clears the entry, so the map can't grow without bound and a
        // still-queued follow-up isn't orphaned.
        if (KanbanProvider._featureRegenChains.get(key) === next) {
            KanbanProvider._featureRegenChains.delete(key);
        }
    }
}
```

`_regenerateFeatureFileLocked` is the *current* body of `_regenerateFeatureFile` (`11715–11876`) moved verbatim, with one required change: **it must re-read the DB inside the lock**, which it already does — `getSubtasksByFeatureId` is its first statement. That is precisely what makes the fix work: the loser of a former race now runs *after* the winner, re-queries, and writes the full set. Keep the second `getPlanByPlanId` call in the locked body (the row may have changed while queued); the pre-lock resolve exists only to derive the key.

Do **not** move `_refreshBoard`, `_syncFeatureOutbound`, or `queueIntegrationSyncFor*` inside the lock. They already sit outside it at every call site.

### 3. `src/services/PlanningPanelProvider.ts:3816` — the missing regeneration on attach

`addSubtaskToFeature` links the subtask and never regenerates. Delegate to the shared provider method, mirroring the `removeSubtaskFromFeature` case immediately below it:

```ts
await db.updateFeatureStatus(subtask.planId, 0, feature.planId);
// Regenerate the feature file — the DB link alone leaves the markdown's SUBTASKS block
// stale forever (nothing reconciles it on read). Same delegation shape as the
// removeSubtaskFromFeature case below, which was fixed for exactly this reason.
if (this._kanbanProvider) {
    await this._kanbanProvider.regenerateFeatureFile(wsRoot, feature.planId);
}
const allPlans = await this._getKanbanPlans(wsRoot);
```

Use the public wrapper (`KanbanProvider.ts:11908`) — it re-resolves the DB handle and is the same entry point `extension.ts:810` uses.

Audit the remaining `updateFeatureStatus` call sites for the same omission while here: `ClickUpSyncService.ts:3424`, `LinearSyncService.ts:2906`, `NotionBackupService.ts:184`, and `RemoteControlService.ts:695` all establish a parent link from an inbound sync. Each needs the same regeneration call or an explicit comment stating why the file is regenerated elsewhere on that path.

### 4. `src/services/KanbanProvider.ts` — add drift logging to the *existing* startup sweep (do not add a parallel method)

> **Superseded:** "Add a public method `reconcileFeatureFiles` that reconciles every feature in a workspace, and call it once per workspace on activation... nothing else ever re-derives it, so a single lost write... is permanent without this."
> **Reason:** A full self-heal sweep already exists and already runs on activation. `regenerateAllFeatureFiles` (`KanbanProvider.ts:11885`) is called on a 3-second startup timer from `TaskViewerProvider.ts:4126-4128` and re-derives every feature file from the DB through `_regenerateFeatureFile` (no-op-guarded). Adding a second parallel method (`reconcileFeatureFiles`) duplicates the activation hook and guarantees two code paths doing the same thing diverge over time. The original draft missed this because it didn't grep for existing self-heal before proposing a new one.
> **Replaced with:** Extend the **existing** `regenerateAllFeatureFiles` with drift detection + logging so the heal is *visible* (a silent heal hides a regression in the writer), and optionally add a cheap intra-session guard. Do not introduce a second sweep method.

The existing method already heals; it just heals *silently*. The only net-new value is (a) a drift log line per repaired file so a writer regression surfaces in the extension log, and (b) optional intra-session healing that doesn't wait for a restart. Both are added to the existing method, not a new one:

```ts
/**
 * Self-heal pass: regenerate every feature file in the workspace so the subtask
 * list stays in sync with the DB. Called once on startup after the board is
 * first activated (TaskViewerProvider.ts:4126, 3s deferred) AND optionally from
 * the board-refresh path behind a cheap guard. Catches feature files that got
 * out of sync due to bugs, manual edits, watcher races, or extension upgrades.
 *
 * Now drift-aware: compares each file's SUBTASKS block against the DB *before*
 * regenerating and logs every repair with both counts, so a regression in the
 * writer is visible in the extension log instead of healing silently. The
 * regenerate call itself is unchanged — it still re-reads the DB inside the
 * per-file lock and still respects the no-op skip and bodyless-husk refusal.
 * Returns the repair list so callers (e.g. a startup diagnostic) can surface it.
 */
public async regenerateAllFeatureFiles(workspaceRoot: string): Promise<{ checked: number; repaired: string[] }> {
    const repaired: string[] = [];
    const db = this._getKanbanDb(workspaceRoot);
    if (!db || !(await db.ensureReady())) return { checked: 0, repaired };
    const workspaceId = await db.getWorkspaceId();
    if (!workspaceId) return { checked: 0, repaired };
    const features = await db.getFeaturePlans(workspaceId);
    for (const feature of features) {
        // Drift pre-check: compare the file's listed subtask basenames against the
        // DB before regenerating, so a repair is LOGGED rather than silent. Compare
        // by basename set, not by count — a same-size set with one substitution is
        // still drift. Uses the SAME predicate as getSubtasksByFeatureId (active
        // only) — both sides already agree; the board badge's active+completed
        // predicate is not involved in drift detection.
        let drifted = false;
        try {
            const abs = path.resolve(workspaceRoot, feature.planFile);
            const src = await fs.promises.readFile(abs, 'utf8');
            const block = /<!-- BEGIN SUBTASKS[\s\S]*?<!-- END SUBTASKS -->/.exec(src);
            if (block) {
                const listed = [...block[0].matchAll(/\]\(\.\.\/plans\/([^)]+)\)/g)].map(m => m[1]).sort();
                const expected = (await db.getSubtasksByFeatureId(feature.planId)).map(st => path.basename(st.planFile)).sort();
                if (JSON.stringify(listed) !== JSON.stringify(expected)) {
                    drifted = true;
                    console.warn(
                        `[KanbanProvider] regenerateAllFeatureFiles: drift in ${feature.planFile} — ` +
                        `file lists ${listed.length}, DB has ${expected.length}. Rewriting.`
                    );
                }
            }
        } catch { /* file absent or no block yet — creation paths own that; regen will handle or skip */ }
        try {
            await this._regenerateFeatureFile(workspaceRoot, feature.planId, db);
            if (drifted) repaired.push(feature.planFile);
        } catch (err) {
            console.warn(`[KanbanProvider] regenerateAllFeatureFiles: failed for ${feature.planId} (${feature.topic}):`, err);
        }
    }
    return { checked: features.length, repaired };
}
```

The signature change (now returns `{ checked, repaired }`) is backward-compatible — the existing `void` call site at `TaskViewerProvider.ts:4127` ignores the return value. Do not add a second call site for a parallel method; the startup timer already fires this one.

**Optional intra-session guard (only if the user wants heal-without-restart):** add a single debounced call to `regenerateAllFeatureFiles` from the board-refresh path, gated by a per-workspace "did the last refresh include a feature mutation?" flag so a quiescent board doesn't re-sweep. This is a nice-to-have, not load-bearing — the restart sweep already covers it. If added, it MUST go through the same method (inheriting the per-file lock via `_regenerateFeatureFile`), never a parallel sweep.

### 5. Backfill the drifted file (same-session; also auto-healed on next restart)

Once 1–4 are in, run `regenerateAllFeatureFiles` once for the switchboard workspace (or simply restart the extension — the 3-second startup timer fires it automatically). The `tickets-panel-extraction` file should regain `tickets-panel-2a-tickets-panel-foundation-and-state.md` and `tickets-panel-2b-source-selection-and-ticket-folders.md` in rowid position (between plan 4 and 2c), and its derived `**Complexity:**` line should recompute across all ten subtasks. Expect other features to be repaired in the same pass — inspect the drift log line for each before accepting.

Do not hand-edit the feature file to add the two lines. A manual patch proves nothing about the fix and leaves the next race free to re-drop them.

## Verification Plan

> **Session directive:** Compilation (`npm run compile`) and automated test suites are **skipped** per the user's session directive. Verification below is manual repro + inspection only. The implementer should still run the existing suites before merge outside this session.

1. **Reproduce from the UI first — this is the actual repro and it must be seen to fail.** On a scratch feature with 4 existing subtasks, multi-select the feature plus 6 loose plans on the board and press FEATURE once. On current `main` the file ends with fewer than 10 subtasks while the badge reads 10. Repeat 3–5 times and record the surviving count each run — it varies with scheduling (that variance is the signature of the race, and a single lucky run showing 10 is not a pass). **Do this within a single session without restarting** — the existing `regenerateAllFeatureFiles` startup sweep would heal the file on restart and mask the bug.
2. **Same UI repro after change 1.** All 10 must land in the file, in every run, and the badge must agree. Assert exactly **one** `writeFile` to the feature path per click — instrument or watch mtime count, because "the right answer" can also come from six racing writes that happened to order favourably.
3. **Reproduce the race at the unit level.** Call `_regenerateFeatureFile` twice concurrently for one feature with the first invocation's `getSubtasksByFeatureId` artificially delayed past the second's write. Assert the file ends with the *smaller* set — must demonstrate the bug on current `main`.
4. **Same unit repro after the mutex.** Both invocations must produce the full set regardless of scheduling. Run with 6 concurrent invocations to match the observed fan-out width.
5. **Cross-surface overlap.** With the mutex in, trigger a board cascade move on the feature while a watcher-side regeneration for the same feature is in flight (touch a subtask plan file). Assert the file converges to the full set. This is the case change 1 alone does not cover.
6. **Batch-assign end to end via the API.** On a scratch feature, `POST /kanban/features/assign` with six plan refs while a plan-file import for those same six is still settling. Assert the feature file lists all six plus any pre-existing subtasks.
7. **The `PlanningPanelProvider` attach path.** Attach a subtask from the project webview's `addSubtaskToFeature` and assert the feature file gains the line without any further mutation. Before the fix this must fail.
8. **The surviving single-card path.** Attach one subtask from `planning.js:7805`'s feature-accordion dropdown and from `project.js:2730`'s overlay. Both must still work and still regenerate — change 1 keeps the single-card verb alive and must not have broken either caller.
9. **Partial batch.** Include one plan already attached to a *different* feature in the selection. Assert the rest attach, the file lists exactly the successful ones, and the user sees a warning naming the skipped count rather than a silent partial success.
10. **Drift logging on the existing sweep.** Hand-corrupt a feature file by deleting one subtask line, run `regenerateAllFeatureFiles`, and assert the line returns, the drift warning is logged with both counts, the return value lists the file in `repaired`, and a second run reports zero repairs (idempotent — the content-no-op guard prevents a second write).
11. **No-op safety.** Run `regenerateAllFeatureFiles` against a clean workspace and assert **zero** files are written — check mtimes, not just the return value. A sweep that rewrites every feature on every activation would re-fire the plan watcher workspace-wide.
12. **Husk guard intact.** Delete a feature's `.md` while its DB row survives, run the sweep, and assert it neither creates a husk nor throws (the drift pre-check's `catch` on read failure plus the existing bodyless-husk refusal inside `_regenerateFeatureFile` must both hold).
13. **Backfill result.** Confirm `.switchboard/features/tickets-panel-extraction-b374fd5a-faef-4ad9-9ad0-0fbf3d0174d3.md` lists all ten subtasks in rowid order and that its `**Complexity:**` marker matches the max across all ten. (This also happens automatically on the next restart via the startup sweep; the manual run is to close it same-session.)
14. **Existing suites (deferred — skipped this session).** Before merge outside this session, run `npm run compile-tests` and the feature-management suites — `src/test/headless-feature-management-destructive.test.js` in particular asserts against the SUBTASKS block regex directly and will catch a splice regression. Skipped now per session directive.
