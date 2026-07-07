# Replace the Worktree Merge Button with an Agent-Driven "Merge Prompt" Button

**Plan ID:** 8d0c7a1f-c728-4975-a2c5-4369334dca16

## Goal

Replace the mechanical **Merge** button on each WORKTREES-tab row with a **Merge prompt** button that copies a ready-to-paste prompt to the clipboard. The prompt instructs a coding agent to merge the worktree's branch back into its correct target, **resolving any conflicts as it goes** — the thing the current button cannot do. A separate manual **Clean up** button and a new agent-callable **worktree-cleanup skill** close out the worktree afterward.

### Problem / background / root cause

Switchboard is an agent project-management tool, but the current worktree Merge button does the least agent-appropriate thing possible: it runs a bare `git merge <branch>` (`src/services/KanbanProvider.ts:8952`, inside the `case 'mergeWorktree'` handler at `:8901`; the subtask/integration variants at `:9659` and `:9678`) with a 30s timeout, wrapped in try/catch.

- **On conflict it dead-ends.** Git exits non-zero, the `catch` fires (`:8956` plain / `:9664` subtask / `:9687` integration), and the user gets a `Merge failed: <message>` toast. There is **no `git merge --abort`**, so the target checkout (the feature integration worktree, or the main repo checkout) is left in a half-merged, conflict-marked state — `MERGE_HEAD` set, files with `<<<<<<<` markers — that the user must discover and fix by hand.
- This means the button is only pleasant for clean / fast-forward merges. The moment there is a conflict it fails **and** leaves a mess in a checkout the user may not realize is the target.

The architecture is already 90% set up for the better primitive: the target worktrees already have agent terminals provisioned (`ensureWorktreeTerminals`, e.g. `KanbanProvider.ts:8896`/`:9446`), and a failed merge conveniently leaves the conflict *in* the worktree where an agent could resolve it. What is missing is the hand-off. The right primitive for this product is **"copy a prompt that tells an agent to do the merge and resolve conflicts,"** not a mechanical merge that dead-ends on a toast.

### Root-cause note on cleanup

The mechanical Merge handler does more than `git merge`: it also marks the worktree row `merged` and removes the worktree directory (`updateWorktreeStatus(..., 'merged')` at `KanbanProvider.ts:8954`; `_removeWorktreeRow`/`_cleanupFeatureWorktrees` at `:9594`/`:9631`). There is **no reconciliation** that flips a worktree row to `merged`/inactive when its on-disk directory disappears (confirmed: status transitions happen only inside the explicit merge/abandon handlers). So if an agent performs the merge in a terminal, Switchboard's board will keep showing that worktree as active forever unless an explicit cleanup action runs. Cleanup therefore must be an explicit, kind-aware action — it cannot be inferred.

## Metadata
**Complexity:** 6
**Tags:** frontend, backend, ui, api, cli, feature, refactor
**Project:** Switchboard

## User Review Required

Yes. Two judgment calls the user should sign off on before coding:

1. **Behavioral swap of a shipped button.** The Merge button currently *performs* the merge; after this change it *copies a prompt* and performs nothing. That is the intended change, but it is a user-visible discontinuity on a button that ships in released versions.
2. **The manual Clean up button is destructive if pressed prematurely.** Per the project's hard no-confirm rule, Clean up acts immediately. If the user clicks it while an agent is still mid-merge in that worktree, `git worktree remove --force` (`:9602`) rips the directory out from under the running agent. The design's mitigation is structural (Clean up is a *separate* button from Merge prompt, and the copied prompt explicitly tells the agent to *ask the user* before cleaning up), but the manual button itself has no such gate. Accepting that risk is a user decision.

## Complexity Audit

### Routine
- Excising the `git merge` calls from the existing kind-branched handler and reusing the already-correct `_removeWorktreeRow` / `_cleanupFeatureWorktrees` / `_pruneWorktrees` cleanup skeleton — this is the existing merge handler's structure with the `git merge` lines removed.
- Swapping one webview button for another and adding a sibling button in `renderWorktreeRow` (`kanban.html:9857-9864`).
- Adding a `POST /worktree/cleanup` route that mirrors the shape of the existing `/kanban/feature/*` handlers (`LocalApiServer.ts:1346-1355`, handler pattern at `:369-411`).
- Adding a flat shell skill `.md` that sources `sb_api_call.sh` and curls the new endpoint — mirrors `clickup_create_task.md` / `linear_api.md` exactly.

### Complex / Risky
- **Per-row clipboard round-trip.** The existing copy-prompt pattern (`antigravityPrompt` case, `kanban.html:6580-6604`) is **singleton-id-based** (`getElementById('antigravity-copy-prompt-btn')`). The Merge-prompt button is rendered **per row** by `renderWorktreeRow` (`:9793`), so the `mergePromptReady` handler cannot use a singleton lookup — it must locate the clicked row's button via a `data-wt-id` attribute selector (the precedent is the `wt-status-badge` lookup at `:6567`). Getting this selector wrong produces a silent no-op (button never flips to `COPIED!`).
- **Three undocumented touch-points for the API endpoint.** `LocalApiServer` holds no `KanbanProvider` reference — it receives injected callbacks via `LocalApiServerOptions` (`:9-100`), wired in `TaskViewerProvider._startLocalApiServer()` at `:968-1072`. So the endpoint requires: (a) a new optional `cleanupWorktree?` callback in the options interface, (b) wiring it at `TaskViewerProvider:1072` alongside `splitFeature` using the `if (!this._kanbanProvider) return { success: false, error }` guard pattern (`:985-987`), and (c) a **public** `KanbanProvider.cleanupWorktree(workspaceRoot, worktreeId)` entry point (the plan's `_cleanupWorktree` is private).
- **Prompt correctness for cross-checkout merges.** A subtask/tier worktree's agent terminal runs *in the subtask checkout*, but the merge must happen *in the integration checkout*. The prompt must give an explicit `git -C <integration path> merge <branch>` instruction, not prose ("in the integration checkout, run `git merge`") that an agent may execute in its CWD.
- **Name collision.** `TaskViewerProvider.copyMergePrompt(sessionIds, workspaceRoot)` already exists at `:3651-3663` — it copies the *plan-review* "merge prompt" (reviewer-role unified prompt). Reusing the name `copyMergePrompt` for the worktree git-merge prompt would create two methods with the same name and opposite meanings. Disambiguate (see Proposed Changes).

## Edge-Case & Dependency Audit

**Race Conditions**
- *Cleanup vs. in-progress agent.* See User Review Required #2. The manual Clean up button can `git worktree remove --force` a worktree while an agent is still working in it. Mitigation is structural (separate button + prompt instructs agent to ask first), not a code gate.
- *Cleanup re-entrancy.* `_cleanupFeatureWorktrees` (`:9631`) walks **all** worktrees matching `feature_id` — it is **not** filtered by `status === 'active'` (`:9633`). Re-running cleanup on already-merged rows is benign because `_removeWorktreeRow` is idempotent: it guards on `fs.existsSync(wt.path)` before removing (`:9601`) and log-and-continues on every failure (`:9605`, `:9610`). A coder must NOT "helpfully" add a `status === 'active'` filter — that would change behavior. Documented here so it is not mistaken for a bug.

**Security**
- The new endpoint inherits the existing boundary: `_handleRequest` rejects non-localhost (`LocalApiServer.ts:1291-1297`) and `_checkAuth` is currently a no-op that trusts that boundary (`:219-222`, `return true`). No bearer token is required by the server today; the skill script therefore passes only `Content-Type` + body (mirroring `clickup_create_task.md`), not an `Authorization` header. If `_checkAuth` is ever hardened, the skill must add the header — note this in the skill doc.

**Side Effects**
- Removing the `mergeWorktree` message type and its JS helper (`kanban.html:9773-9781`) — verified there is exactly **one** sender of `type: 'mergeWorktree'` in the webview (`kanban.html:9775`), so deleting the message type is safe after the sender is removed.
- Deleting the now-unused helpers `_mergeSubtaskIntoIntegration` (`:9650`) and `_mergeFeatureIntegrationIntoMain` (`:9675`) — grep for any other internal callers before deleting (the only current callers are the `mergeWorktree` handler at `:8918`/`:8928`/`:8940`).
- Clipboard write happens inside a `postMessage` response handler, async after the backend round-trip. The existing `antigravityPrompt` copy does exactly this and works, which empirically validates that the transient-activation chain survives the round-trip in this webview. The `mergePromptReady` handler reuses the same path.

**Dependencies & Conflicts**
- No dependency on other plan sessions. No schema/config change (`feature_worktree_mode` untouched); worktree rows keep the same `status` values (`active`/`merged`/`abandoned`). `WorktreeRow` already carries `base_branch` (`KanbanDatabase.ts:31`), `subtask_plan_id` (`:30`), `tier` (`:32`), `feature_id` (`:25`) — all the kind/target signals the prompt builder needs are on the backend row, even though the webview payload (`_sendWorktreeConfig` mapped output at `KanbanProvider.ts:9792-9802`) omits them.

## Dependencies

None. This plan is self-contained — no other plan session must complete first.

## Adversarial Synthesis

Key risks: (1) the per-row clipboard feedback cannot reuse the singleton-id copy-prompt pattern and needs a `data-wt-id` selector or it silently no-ops; (2) the API endpoint requires three undocumented touch-points (options-interface callback, TaskViewerProvider wiring, and a public KanbanProvider wrapper) because LocalApiServer holds no provider reference; (3) the merge prompt must emit explicit `git -C <path> merge <branch>` commands or an agent will merge in the wrong checkout. Mitigations: mirror the `wt-status-badge` selector for the label flip, wire `cleanupWorktree` alongside `splitFeature` at `TaskViewerProvider:1072` calling a new public `KanbanProvider.cleanupWorktree`, and build the prompt string with absolute `git -C` invocations using `wtRow.base_branch` (fallback `_resolveDefaultBranch`) for the target.

## Proposed Changes

### `src/services/KanbanProvider.ts` — prompt builder + shared cleanup

**Context.** The `case 'mergeWorktree'` handler (`:8901-8961`) branches on worktree kind (subtask `:8917`, tier `:8927`, integration `:8937-8939`, plain `:8945-8960`) and currently does the merge + cleanup inline via `_mergeSubtaskIntoIntegration` (`:9650`), `_mergeFeatureIntegrationIntoMain` (`:9675`), and the plain path at `:8952`. The webview payload from `_sendWorktreeConfig` (`:9765`, mapped at `:9792-9802`) does **not** include `subtask_plan_id`, `tier`, or `base_branch`, so the prompt must be generated backend-side where kind/target are resolvable.

**Logic — `copyWorktreeMergePrompt` message handler** (add near `:8901`; name it `copyWorktreeMergePrompt`, NOT `copyMergePrompt`, to avoid collision with `TaskViewerProvider.copyMergePrompt` at `:3651`):
1. Resolve `workspaceRoot` via `this._resolveWorkspaceRoot(msgRoot)`, get the DB, `db.getWorktrees()`, find the row by `worktreeId`.
2. Determine kind + target using the same branching as the old handler:
   - **subtask/tier worktree** (`subtask_plan_id && feature_id`, or `tier && feature_id`) → target = the feature **integration** worktree, found via `feature_id` excluding subtask/tier rows and requiring `status === 'active'` (the `:9652` lookup). If none, emit a plain "no active integration worktree found" prompt instead of a merge target (mirror the `:9653-9656` guard). Merge is performed **in the integration worktree's checkout**.
   - **integration worktree** (`feature_id`, no `subtask_plan_id`, no `tier`, has children — the `:8937-8938` test) → target = the repo default branch in the main checkout; note child worktrees converge first.
   - **plain / project worktree** → target = the main checkout's default branch.
3. Resolve the default branch preferentially from `wtRow.base_branch` (`KanbanDatabase.ts:31` — the branch the worktree was cut from, normally the default); fall back to `this._resolveDefaultBranch(workspaceRoot)` (`:9395`) when `base_branch` is null (legacy rows). Using `base_branch` is more accurate than the live default, which may have moved since the worktree was created.
4. Build the prompt string with **explicit `git -C <path> merge <branch>` commands** (see "The merge prompt" below) — never prose like "in the integration checkout, run `git merge`", which an agent may execute in its own CWD.
5. Post back: `this._panel?.webview.postMessage({ type: 'mergePromptReady', worktreeId, prompt })`.

**Logic — public `cleanupWorktree` + private `_cleanupWorktree` refactor.** Extract the removal tail of the old merge handler into a kind-aware `private async _cleanupWorktree(workspaceRoot, db, worktreeId)`:
- subtask/tier → `_removeWorktreeRow(..., 'merged')` for just that row + `_pruneWorktrees`.
- integration → `_removeWorktreeRow` for the integration row, then `_cleanupFeatureWorktrees(..., 'merged')` to walk and remove its remaining children (mirrors `_mergeFeatureIntegrationIntoMain`'s tail at `:9679-9683`, minus the `git merge`). The walk is intentionally status-agnostic and idempotent (see Edge-Case & Dependency Audit) — do not add a status filter.
- plain/project → close terminals + `git worktree remove --force` + `updateWorktreeStatus(..., 'merged')` + prune (mirrors `:8945-8960` minus the merge).

Add a **public** `async cleanupWorktree(workspaceRoot, worktreeId): Promise<{ success: boolean; error?: string }>` that resolves the DB, calls `_cleanupWorktree`, then `await this._sendWorktreeConfig(workspaceRoot)` to refresh the board. This is the single internal entry point used by BOTH the webview `cleanupWorktree` message handler and the LocalApiServer callback.

**Removal per "replace".** Delete the `git merge` invocations (`:8952`, `:9659`, `:9678`) and the now-unused helpers `_mergeSubtaskIntoIntegration` (`:9650`) and `_mergeFeatureIntegrationIntoMain` (`:9675`) after grepping for other internal callers (current callers: `:8918`, `:8928`, `:8940` only). Either delete the `mergeWorktree` message handler or repurpose it as the thin `cleanupWorktree` handler (verified: only one webview sender at `kanban.html:9775`).

**Edge cases.** Missing integration worktree → prompt says so plainly (no phantom target). Cleanup on an already-removed worktree → safe no-op via the `existsSync` guard and log-and-continue in `_removeWorktreeRow` (`:9601-9611`).

### `src/webview/kanban.html` — per-row buttons + clipboard feedback

**Context.** `renderWorktreeRow` (`:9793`) builds each row; the current Merge button is at `:9857-9864` calling the `mergeWorktree` JS helper (`:9773-9781`). The existing copy-prompt feedback is the `antigravityPrompt` onmessage case at `:6580-6604`, but it is **singleton-id-based** (`getElementById` at `:6581`) and cannot be reused verbatim for per-row buttons.

**Implementation.**
- In `renderWorktreeRow`, replace the `mergeBtn` block (`:9857-9864`) with a **Merge prompt** button carrying `data-wt-id="${w.id}"`, posting `{ type: 'copyWorktreeMergePrompt', worktreeId: w.id, workspaceRoot: currentWorkspaceRoot }`.
- Add a **Clean up** button (same `data-wt-id` convention) posting `{ type: 'cleanupWorktree', worktreeId: w.id, workspaceRoot: currentWorkspaceRoot }`. Immediate action, **no confirm dialog** (project hard rule — `window.confirm` is a silent no-op in webviews).
- Keep the existing **Abandon** button (`:9866-9873`) unchanged.
- Replace the `mergeWorktree(...)` JS helper (`:9773-9781`) with `copyWorktreeMergePrompt(...)` and `cleanupWorktree(...)` helpers.
- Add a `mergePromptReady` case to the `onmessage` switch that does `navigator.clipboard.writeText(msg.prompt)`, then locates the matching button via `document.querySelector([data-wt-id="${msg.worktreeId}"])` (mirror the `wt-status-badge` selector at `:6567`, NOT the singleton `getElementById` at `:6581`) and flips its label `Merge prompt` → `COPIED!` → back after 2s, with the same `ERROR` fallback as `:6589-6602`.

### `src/services/LocalApiServer.ts` — `POST /worktree/cleanup` route

**Context.** The router dispatches at `:1319-1379`; the `/kanban/feature/*` family sits at `:1346-1355`. The server holds no `KanbanProvider` — it calls injected callbacks from `LocalApiServerOptions` (`:9-100`), each guarded by `if (!this._kanbanProvider)` at the wiring site.

**Implementation.**
- Add to the options interface (`:9-100`): `cleanupWorktree?: (workspaceRoot: string, worktreeId: string | number) => Promise<{ success: boolean; error?: string }>;`
- Add a route in the `else if` chain (near `:1355`): `} else if (pathname === '/worktree/cleanup' && req.method === 'POST') { await this._handleWorktreeCleanup(req, res); }`
- Add `private async _handleWorktreeCleanup(req, res)` mirroring `_handleKanbanCreateFeature` (`:369-411`): call `this._checkAuth(req, true)` (currently a no-op, `:219-222`, but keep the call for consistency and future hardening), read `this._options.cleanupWorktree`, parse `{ workspaceRoot, worktreeId }` (accept `branch` as an alternative key), call the callback, return `{ ok: result.success }` / `{ ok: false, error: result.error }` JSON.

### `src/services/TaskViewerProvider.ts` — wire the callback

**Context.** `new LocalApiServer({ ... })` is constructed at `:968`; the callback block runs `:980-1072`; `splitFeature` is the last feature callback at `:1062-1072`, using the `if (!this._kanbanProvider) return { success: false, error: 'Kanban provider not available' }` guard (`:985-987`).

**Implementation.** Add a `cleanupWorktree` callback alongside `splitFeature` (after `:1072`), same guard pattern, calling `await this._kanbanProvider.cleanupWorktree(wsRoot, worktreeId)`. The existing `copyMergePrompt` at `:3651-3663` is unrelated (plan-review prompt) and is not touched.

### New agent skill — `.agents/skills/worktree_cleanup.md` (flat, inline bash)

**Context.** The shell-callable skills in `.agents/skills/` are **flat `.md`** files with a frontmatter `description`, a `# Title`, a `## When to Use`, and a `## Usage` bash block that sources `_lib/sb_api_call.sh` (see `clickup_create_task.md`, `linear_api.md`, `notion_api.md`). A directory + separate `.sh` would be inconsistent with these peers.

**Implementation.** Add `.agents/skills/worktree_cleanup.md` mirroring `clickup_create_task.md`'s structure:
```bash
CUR="$PWD"
while [ "$CUR" != "/" ] && [ ! -d "$CUR/.agents/skills" ]; do CUR=$(dirname "$CUR"); done
source "$CUR/.agents/skills/_lib/sb_api_call.sh"

sb_api_call POST /worktree/cleanup \
  -H "Content-Type: application/json" \
  -d '{ "worktreeId": "<id-or-branch>", "workspaceRoot": "/abs/path/to/workspace" }'
```
- **When to use:** ONLY after a merge the agent performed at the user's request, and ONLY when the user has confirmed they want the worktree cleaned up.
- **What it does:** tells Switchboard to mark the worktree merged and remove its directory (kind-aware: subtask/tier remove just that worktree; integration removes it + remaining children).
- **Extension required:** `sb_api_call.sh` health-checks the LocalApiServer and fails with a clear message if the port file isn't found. No bearer token is required today (`_checkAuth` is localhost-only); document that an `Authorization` header must be added if `_checkAuth` is ever hardened.
- Register the skill in the skills table in `CLAUDE.md` / `AGENTS.md` for discoverability (consistent with the other entries).

## The merge prompt (draft the backend generates)

Backend fills in the bracketed values. The prompt uses **explicit `git -C <path>` invocations** so the agent runs the merge in the correct checkout regardless of its CWD. Example for a subtask/tier worktree:

> You are working in the git worktree at `<worktree path>` on branch `<branch>`. Merge this branch back into its integration target and resolve any conflicts.
>
> 1. Ensure `<branch>` has all intended work committed.
> 2. In the integration checkout at `<integration path>` (branch `<integration branch>`), run: `git -C <integration path> merge <branch>`.
> 3. If there are conflicts, resolve them (keep both sides' intent; prefer the incoming feature work where they overlap), then commit the merge. Do not run `git merge --abort` unless the user tells you to.
> 4. Verify the result builds/tests as appropriate.
>
> After the merge succeeds, **ask the user whether they want you to clean up this worktree in Switchboard.** If they say yes, run the `worktree_cleanup` skill (`.agents/skills/worktree_cleanup.md`) — it calls the Switchboard local API to mark the worktree merged and remove it. Do not clean up without the user's confirmation.

For an integration or plain/project worktree, step 2 targets the default branch `<default branch>` (resolved from `wtRow.base_branch`, fallback `_resolveDefaultBranch`) in the main checkout via `git -C <main checkout path> merge <branch>`, and the prompt notes that child worktrees should be merged first (integration case).

## Verification Plan

### Automated Tests
*(Session directive: automated tests are NOT run during this review — listed here for the implementer.)*

- **Prompt builder** (`src/services/__tests__/KanbanProvider.test.ts`): returns the correct target (integration branch vs default branch) and explicit `git -C <path>` form for each of the four worktree kinds; missing-integration guard emits a no-target message; `base_branch` is preferred over the live `_resolveDefaultBranch` when present.
- **`_cleanupWorktree` kind-awareness** (extend `src/test/kanban-persistence.test.ts` + `KanbanProvider.test.ts`): subtask/tier removes only its own row; integration removes itself + children (status-agnostic walk, idempotent on re-run); plain removes itself. Re-running cleanup on an already-removed worktree is a no-op.
- **API** (`POST /worktree/cleanup`): returns `{ok:true}` and the row flips to `merged`; unknown id returns a clean error; `workspaceRoot` resolution matches the other handlers.

### Manual Verification
- WORKTREES tab: Merge prompt button copies a correct, paste-ready prompt for a subtask worktree AND for a plain worktree; the clicked row's button flips to `COPIED!` (per-row selector works, not just the first row).
- Clean up button removes the worktree and refreshes the board; no confirm dialog appears.
- The `worktree_cleanup.md` skill triggers cleanup end-to-end with the extension running (source the lib, curl the endpoint, observe the row flip to `merged`).
- Conflict path: paste the prompt into an agent in a worktree whose branch conflicts with the integration target; confirm the agent resolves and commits, then asks before cleaning up.

## Migration / compatibility

The worktree Merge button ships in released versions, but this change touches **behavior and UI, not persisted state**: no schema change, no config change (`feature_worktree_mode` is untouched), and worktree rows keep the same `status` values (`active`/`merged`/`abandoned`). So there is **no data migration** — it is a clean behavioral swap. The one user-visible discontinuity is that the button no longer performs the merge; that is the intended change. (Per project policy, when unsure whether something shipped we assume it did and migrate — here a migration would be a no-op, so omitting it is safe.)

## Out of scope

- Auto-reconciliation that detects a vanished worktree dir and marks it merged (the user chose an explicit cleanup button + agent-triggered skill instead).
- Any change to the mechanical **Abandon** button (discard path stays as-is).
- Changing how worktrees are *created* or the `feature_worktree_mode` selector.

---

**Recommendation:** Complexity 6 → **Send to Coder.** Majority of the work reuses the existing kind-branched cleanup skeleton; the moderate risks (per-row clipboard selector, three-point API wiring, `git -C` prompt correctness, name disambiguation) are well-scoped and documented above.

**Stage Complete:** LEAD CODED

## Review Findings

Reviewed the implementation in commit `a6a0bef` against the plan. Two MAJOR prompt-correctness issues fixed in `src/services/KanbanProvider.ts`: (1) the "no active integration worktree" case still emitted a `git -C <workspaceRoot> merge` command that would bypass the integration branch and land a subtask on main directly — now emits a no-target prompt that asks the user instead; (2) the prompt hardcoded "integration checkout" prose for all worktree kinds, mislabeling the main checkout for integration/plain worktrees — now uses a dynamic `checkoutLabel`. One NIT fixed in `src/webview/kanban.html`: dead ternary `msg.error ? 'ERROR' : 'ERROR'` collapsed to `'ERROR'`. No orphaned references to removed `mergeWorktree`/`_mergeSubtaskIntoIntegration`/`_mergeFeatureIntegrationIntoMain` in `src/`. The `data-wt-id` per-row selector, kind-aware `_cleanupWorktree`, three-point API wiring, and name disambiguation (`copyWorktreeMergePrompt` vs `TaskViewerProvider.copyMergePrompt`) all match the plan. Compilation and tests skipped per session directive. Remaining risk: the skill doc claims `switchboard.apiToken` is required, but `_checkAuth` is a no-op — consistent with peer skills, so left as-is.

**Stage Complete:** CODE REVIEWED
