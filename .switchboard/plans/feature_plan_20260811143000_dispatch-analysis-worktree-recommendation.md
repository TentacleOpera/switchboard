# Dispatch analysis should recommend (and be able to create) per-feature worktrees when candidates are too entangled

## Goal

Make the dispatch-analysis pass turn its "these plans conflict" verdict into an actionable escape hatch: when the entangled candidates are mostly **features**, recommend the per-feature worktree topology that already exists, and give the analysing agent an API path to actually create those worktrees instead of leaving the user with a dead-ended report.

### Problem analysis

Today `Analyze` on the Planned column runs `.agents/skills/dispatch-analysis/SKILL.md`. That skill builds a file-overlap graph (step 3), greedily selects the largest non-conflicting subset (step 4), moves that subset to DISPATCH, and reports the rest as "remaining in Planned (conflicts)" with a recommended next step of *"Resolve conflicts and re-analyze"* (step 6).

That recommendation is a dead end in the common case. The reason two plans conflict is that they touch the same files **in the same working tree** — which is precisely the problem per-feature worktrees solve. Switchboard already has that topology:

- `feature_worktree_mode` config in `kanban.db` with values `'none' | 'per-feature'` (`src/services/KanbanProvider.ts:11520` `setFeatureWorktreeMode`, read at `:4893`, `:12333`, `:13042`).
- A working per-feature worktree creator: `createWorktreeForFeature` (`src/services/KanbanProvider.ts:11339`) — resolves the default branch, calls `_createSafetyWorktree`, records the row via `db.addWorktree(branch, path, featureId, …)`, and seats agent terminals inside it.
- Orchestration mode flips `feature_worktree_mode` to `'per-feature'` automatically (`src/services/KanbanProvider.ts:8176-8188`) precisely because fanning several features out in one tree does not work.

### Root cause (two composing gaps)

1. **The skill has no worktree concept at all.** Grep `.agents/skills/dispatch-analysis/SKILL.md` for "worktree": zero hits. Conflict is modelled as a terminal property of the plan pair, never as a property of *the tree they would run in*. So the analysis cannot distinguish "genuinely sequential work" from "concurrent work that just needs isolation".
2. **The analysing agent has no create path.** `LocalApiServer` exposes only `POST /worktree/cleanup` (`src/services/LocalApiServer.ts:3709`) and `GET /worktree/list` (`:3745`). Worktree *creation* is reachable only from the webview via the `createWorktreeForFeature` / `createWorktreeForProject` / `createWorktree` postMessage handlers (`src/webview/kanban.html:4505-4517`, `:12286-12404`). An agent running the analysis pass over HTTP therefore cannot act on its own recommendation even if it makes one — so a recommendation without an endpoint would just be advice the user has to hand-execute per feature in the Worktrees tab.

Both hosts build the analysis prompt from one shared resolver pair (`buildAnalysisScopeLine` in `src/services/agentPromptBuilder.ts:360`, consumed by `KanbanProvider.generateUnifiedPrompt` and `src/standalone/bootstrap.ts:143 buildDispatchAnalysisPrompt`), so anything the prompt must carry has to be threaded through both or it drifts.

### Scope decision

Deliberately **not** a new automation mode and **not** a confirmation dialog. The deliverable is: a create endpoint, the entanglement classification + recommendation in the skill, and the mode line in the prompt so the agent knows the current topology. The agent *offers* in its report; when the user says go, the same agent (or the user's next message) creates the worktrees via the new endpoint. No modal, no two-click gate — per project rules.

## Metadata

- **Complexity:** 6
- **Tags:** backend, api, feature, reliability
- **Project:** Browser Switchboard

## Complexity Audit

**Routine**
- Adding one `POST /worktree/feature` route to the existing `LocalApiServer` dispatch chain — the chain is a flat `else if` ladder and `_handleWorktreeCleanup` is a directly analogous precedent.
- Appending the `FEATURE_WORKTREE_MODE=` line to both prompt builders via a shared resolver, mirroring exactly how `PROJECT=` is already done.
- Skill-file prose edits (new step, new rule, extended report section).

**Complex / risky**
- **The endpoint must not re-implement worktree creation.** `createWorktreeForFeature` carries an already-active-worktree guard, default-branch resolution, `addWorktree` bookkeeping, and terminal seating. Duplicating any of that in the API handler produces orphan worktrees or DB rows with no tree. The route must delegate to a KanbanProvider method extracted from the existing `case`, so the webview path and the API path share one implementation (the standing lesson: verb delegation hides push-path gaps — here the *provider* method is the single implementation and the message case becomes a thin caller).
- **Terminal seating from a headless/API caller.** `createWorktreeForFeature` force-creates agent terminals via `_taskViewerProvider.ensureWorktreeTerminals(...)`. In the standalone/headless host `_taskViewerProvider` may be absent. The extracted method must treat terminal seating as best-effort and never fail the creation on it.
- **Conservatism must survive.** The analysis's core safety property is "uncertain overlap ⇒ conflicting". Worktree isolation removes *file-level* conflict but not *logical dependency* (plan A depends on B) and not conflicts *within* one feature's own subtasks. The classification must only relax the recommendation, never the promotion decision — plans still go to DISPATCH only when parallel-safe in whatever tree they will actually run in.

## Edge-Case & Dependency Audit

- **Mixed candidate sets.** If entangled candidates are a mix of features and loose plans, worktree isolation only helps the feature-bound ones (a loose plan has no `feature_id` and so no per-feature worktree). Recommendation must be gated on "the entangled set is *mostly features*" and must name the loose plans that the recommendation does not cover.
- **Feature already has an active worktree.** `getWorktrees()` rows with `status === 'active'` and matching `feature_id` mean nothing to do; the endpoint already rejects with `Feature already has worktree: <branch>`. The skill must call `GET /worktree/list` first and skip those features rather than treating the rejection as a failure.
- **`feature_worktree_mode` already `'per-feature'`.** Then the conflicts are *not* explained by shared-tree contention (each feature is meant to run isolated already) and the recommendation must be suppressed — otherwise the report tells the user to enable something already on.
- **Orchestration mode active.** `feature_worktree_mode` is force-set to `'per-feature'` and a `orchestration_prior_feature_worktree_mode` prior is stashed (`KanbanProvider.ts:8174-8196`). The endpoint must never write `feature_worktree_mode`, only create worktrees — otherwise it can clobber the stashed-prior restore dance. Mode changes stay the user's, via `setFeatureWorktreeMode`.
- **Intra-feature conflict.** Two subtasks of the *same* feature overlapping on a file is not fixed by a per-feature worktree (they share it). The skill must not claim worktrees resolve that case.
- **Non-git or dirty workspace.** `_createSafetyWorktree` can throw (detached HEAD, missing default branch, existing branch name). The endpoint returns `success: false` with the message; a failed create for one feature must not abort the loop over the others.
- **Dual-host prompt drift.** `FEATURE_WORKTREE_MODE=` must come from one exported resolver in `agentPromptBuilder.ts` consumed by both `KanbanProvider.generateUnifiedPrompt` and `bootstrap.ts:143`, exactly like `buildAnalysisScopeLine`. A one-host edit is the known drift trap.
- **Positional-argument hazard.** Do **not** add the mode as a new positional arg to `switchboard.triggerBatchAgentFromKanban` — the existing scope contract test pins the *seventh* positional as `analysisScope` and a misplaced value lands in `targetTerminalOverride` and silently breaks Analyze. Resolve the mode from the DB inside the prompt builder's call site instead of threading a new positional.
- **No migrations needed.** `feature_worktree_mode` already exists in shipped versions; no new persisted state is introduced. The endpoint is additive.
- **`/catalog`** advertises the HTTP surface to fleet agents — a new route that is not listed there is invisible to them.

## Proposed Changes

### 1. `src/services/KanbanProvider.ts` — extract the feature-worktree creator

Lift the body of `case 'createWorktreeForFeature'` (line 11339) into a public method, leaving the message case as a caller:

```ts
/**
 * THE single implementation of per-feature worktree creation, shared by the
 * webview `createWorktreeForFeature` message and the API's POST /worktree/feature.
 * Terminal seating is best-effort: a headless host with no TaskViewerProvider
 * still gets a valid worktree + DB row.
 */
public async createWorktreeForFeature(
    workspaceRoot: string,
    args: { featureId: string; featureTopic: string; repoName?: string }
): Promise<{ success: boolean; branch?: string; path?: string; error?: string }> {
    const db = this._getKanbanDb(workspaceRoot);
    if (!db || !await db.ensureReady()) { return { success: false, error: 'Database unavailable' }; }

    const existing = (await db.getWorktrees())
        .find(w => String(w.feature_id) === String(args.featureId) && w.status === 'active');
    if (existing) { return { success: false, error: `Feature already has worktree: ${existing.branch}` }; }

    try {
        const defaultBranch = await this._resolveDefaultBranch(workspaceRoot);
        const { branch, path: wtPath } =
            await this._createSafetyWorktree(workspaceRoot, args.featureTopic, args.repoName, defaultBranch);
        await db.addWorktree(branch, wtPath, String(args.featureId), undefined, undefined, defaultBranch);

        if (this._taskViewerProvider) {
            try {
                const visibleAgents = await this._getVisibleAgents(workspaceRoot);
                const activeAgents = Object.entries(visibleAgents).filter(([, on]) => on).map(([role]) => role);
                await this._taskViewerProvider.ensureWorktreeTerminals(wtPath, activeAgents, true, true);
            } catch (e: any) {
                console.warn(`[KanbanProvider] worktree created but terminal seating failed: ${e?.message}`);
            }
        }
        await this._refreshBoard(workspaceRoot);
        await this._sendWorktreeConfig(workspaceRoot);
        return { success: true, branch, path: wtPath };
    } catch (e: any) {
        return { success: false, error: `Failed to create worktree: ${e.message}` };
    }
}
```

The message case keeps its user-facing toasts (they belong to the webview path, not the API path):

```ts
case 'createWorktreeForFeature': {
    const workspaceRoot = this._resolveWorkspaceRoot(msg.workspaceRoot);
    if (!workspaceRoot) { return { success: false, error: 'No workspace root resolved' }; }
    const r = await this.createWorktreeForFeature(workspaceRoot, msg);
    if (r.success) { void this._seams().ui.showInformationMessage(`Worktree created for feature: ${r.branch}`); }
    else { void this._seams().ui.showWarningMessage(r.error!); }
    return r;
}
```

### 2. `src/services/LocalApiServer.ts` — `POST /worktree/feature`

Register alongside the existing worktree routes (near line 3709):

```ts
} else if (pathname === '/worktree/feature' && req.method === 'POST') {
    await this._handleCreateFeatureWorktree(req, res);
} else if (pathname === '/worktree/cleanup' && req.method === 'POST') {
```

Handler modelled on `_handleWorktreeCleanup`: parse the JSON body, require `workspaceRoot` + `featureId`, resolve `featureTopic` from the features table when the caller omits it, delegate to `kanbanProvider.createWorktreeForFeature(...)`, and return the provider's result verbatim (HTTP 200 with `success:false` on a guard rejection so a loop over features can continue). Add the route to `_handleGetCatalog`'s advertised surface with a one-line description ("create the per-feature worktree for an entangled feature").

### 3. `src/services/agentPromptBuilder.ts` — carry the current topology into the prompt

Add a sibling to `buildAnalysisScopeLine` (line 360):

```ts
/**
 * THE single resolver for the dispatch-analysis prompt's `FEATURE_WORKTREE_MODE=`
 * line, shared verbatim by both hosts. The skill reads the exact spelling:
 * 'none' means shared-tree contention explains file conflicts and the worktree
 * recommendation is live; 'per-feature' means it is already on and the
 * recommendation must be suppressed.
 */
export function buildFeatureWorktreeModeLine(mode: string | null | undefined): string {
    const cleaned = (mode ?? '').replace(/[\r\n]/g, '').trim();
    if (cleaned !== 'none' && cleaned !== 'per-feature') { return 'FEATURE_WORKTREE_MODE=none\n'; }
    return `FEATURE_WORKTREE_MODE=${cleaned}\n`;
}
```

Emit it immediately after the `PROJECT=` line in the dispatch-analysis prompt arm.

### 4. Both prompt call sites — resolve the mode from the DB, not from a new positional

- `src/services/KanbanProvider.ts` (the `generateUnifiedPrompt` dispatch-analysis arm, alongside the existing `feature_worktree_mode` reads at `:4893` / `:12333`): read `(await db.getConfig('feature_worktree_mode')) || 'none'` and pass it to `buildFeatureWorktreeModeLine`.
- `src/standalone/bootstrap.ts:143 buildDispatchAnalysisPrompt`: same resolver, mode read from the same config key.

No change to `switchboard.triggerBatchAgentFromKanban`'s positional signature.

### 5. `.agents/skills/dispatch-analysis/SKILL.md` — classify entanglement and offer the escape hatch

- **Inputs:** document `FEATURE_WORKTREE_MODE` (`none` | `per-feature`).
- **New step 4a — classify the held-back set.** After the maximum-independent-set selection, partition the held-back candidates:
  - *worktree-resolvable* — held back purely because of **file overlap with candidates outside their own feature**, and they are feature cards (have subtasks / a `feature_id`);
  - *not worktree-resolvable* — declared plan dependencies, overlap **between subtasks of the same feature**, unreadable plan files, and loose (non-feature) plans.
  The recommendation fires only when `FEATURE_WORKTREE_MODE=none` **and** worktree-resolvable candidates are the majority of the held-back set. Otherwise say nothing about worktrees.
- **New step 6a — the offer.** In the report, after the conflicts list:

  > `N` of the `M` held-back candidates are features held back only by file overlap with work outside themselves. Enabling **per-feature worktrees** would let them run concurrently in isolated trees. Reply `create worktrees` and I will create one worktree per feature listed above; the following are *not* fixed by isolation and stay sequential regardless: `<list with reasons>`.

  State plainly that the promotion decision does not change in this run — cards stay in Planned until the worktrees exist and a re-analysis is run.
- **New step 6b — acting on the offer.** On the user's go-ahead: `GET /worktree/list?workspaceRoot=…`, skip features with an `active` row, then per remaining feature `POST /worktree/feature` with `{ workspaceRoot, featureId, featureTopic }`, printing the outcome per feature as it returns; a failure never aborts the loop. Then tell the user to flip **Agent-Managed Worktrees / per-feature worktree mode** on the board if they want it as the standing topology — the agent never writes `feature_worktree_mode` itself (orchestration stashes a prior under that key and a stray write clobbers the restore).
- **Rules section:** add *"Worktrees relax the recommendation, never the promotion."* and *"Never write `feature_worktree_mode`."*

### 6. `.agents/skills/switchboard-orchestration/SKILL.md`

Document `POST /worktree/feature` in the HTTP surface table (request/response shape, the already-has-a-worktree rejection) so fleet agents see it. `.agents/.switchboard-bundled.json` already lists `skills/dispatch-analysis/SKILL.md`, so no manifest change is needed; `dispatch-analysis` is extension-read-by-path and has no `.claude/skills` mirror, so no mirror edit either.

### 7. `src/test/dispatch-analysis-scope-contract.test.js`

Extend the existing contract test (it is already the home for the prompt-line/skill-spelling contracts):
- `buildFeatureWorktreeModeLine` emits exactly `FEATURE_WORKTREE_MODE=none\n` / `=per-feature\n`, and defaults unknown/empty/null to `none`.
- Both hosts' dispatch-analysis prompt text contains the line (source-level assertion over `KanbanProvider.ts` and `bootstrap.ts`, matching how the `PROJECT=` resolver sharing is already pinned).
- `switchboard.triggerBatchAgentFromKanban`'s positional arity is unchanged (guards the `targetTerminalOverride` hazard).
- `SKILL.md` mentions both spellings and `POST /worktree/feature`.

## Verification Plan

1. `npm run compile-tests && node out/test/... ` — run `src/test/dispatch-analysis-scope-contract.test.js`; the new assertions pass and the pre-existing scope assertions stay green. (Note the known set of red tests at HEAD — stash-verify before attributing any failure to this change.)
2. `npx tsc --noEmit` clean for the touched TypeScript files.
3. **Endpoint, happy path:** with the extension running, read the port from `.switchboard/api-server-port.txt`, then `curl -X POST localhost:$PORT/worktree/feature -d '{"workspaceRoot":"…","featureId":"<uuid>"}'`. Expect `success:true` with a `branch` and `path`; confirm `git worktree list` shows the tree, `GET /worktree/list` shows an `active` row bound to that `feature_id`, and the Worktrees tab lists it under **Active feature worktrees**.
4. **Endpoint, guard path:** repeat the same call — expect `success:false` with `Feature already has worktree: <branch>`, and no second tree on disk.
5. **Webview parity:** create a worktree for a different feature via the board's per-feature button; confirm it still creates the tree, records the row, seats agent terminals, and toasts — i.e. the extraction did not drop the UI path's behaviour.
6. **Prompt:** press **Copy dispatch prompt** on the Planned column with `feature_worktree_mode` = `none`, then again with `per-feature`; the clipboard text carries the matching `FEATURE_WORKTREE_MODE=` line directly below `PROJECT=`. Repeat under the standalone host to confirm no drift.
7. **Recommendation fires:** with `mode=none` and a Planned column holding two features whose file sets overlap across features, press **Analyze**. The report holds them back *and* prints the worktree offer naming both features. Reply `create worktrees` — one worktree per feature is created, each outcome printed as it returns, and no card moves and no `feature_worktree_mode` write occur.
8. **Recommendation suppressed:** set `mode=per-feature` and re-run Analyze on the same set — the report contains no worktree offer.
9. **Recommendation correctly narrowed:** with a Planned column whose conflicts are (a) a declared plan dependency and (b) two subtasks of one feature overlapping, confirm the report does **not** claim worktrees would resolve either, and names both reasons.
