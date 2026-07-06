# Replace the Worktree Merge Button with an Agent-Driven "Merge Prompt" Button

## Metadata
**Complexity:** 6
**Tags:** frontend, backend, ui, feature, refactor
**Project:** Switchboard

## Goal

Replace the mechanical **Merge** button on each WORKTREES-tab row with a **Merge prompt** button that copies a ready-to-paste prompt to the clipboard. The prompt instructs a coding agent to merge the worktree's branch back into its correct target, **resolving any conflicts as it goes** — the thing the current button cannot do. A separate manual **Clean up** button and a new agent-callable **worktree-cleanup skill** close out the worktree afterward.

### Problem / background / root cause

Switchboard is an agent project-management tool, but the current worktree Merge button does the least agent-appropriate thing possible: it runs a bare `git merge <branch>` (`src/services/KanbanProvider.ts:8859`, `:9566`, `:9585`) with a 30s timeout, wrapped in try/catch.

- **On conflict it dead-ends.** Git exits non-zero, the `catch` fires, and the user gets a `Merge failed: <message>` toast. There is **no `git merge --abort`**, so the target checkout (the feature integration worktree, or the main repo checkout) is left in a half-merged, conflict-marked state — `MERGE_HEAD` set, files with `<<<<<<<` markers — that the user must discover and fix by hand.
- This means the button is only pleasant for clean / fast-forward merges. The moment there is a conflict it fails **and** leaves a mess in a checkout the user may not realize is the target.

The architecture is already 90% set up for the better primitive: the target worktrees already have agent terminals provisioned (`ensureWorktreeTerminals`), and a failed merge conveniently leaves the conflict *in* the worktree where an agent could resolve it. What is missing is the hand-off. The right primitive for this product is **"copy a prompt that tells an agent to do the merge and resolve conflicts,"** not a mechanical merge that dead-ends on a toast.

### Root-cause note on cleanup

The mechanical Merge handler does more than `git merge`: it also marks the worktree row `merged` and removes the worktree directory (`updateWorktreeStatus(..., 'merged')` at `KanbanProvider.ts:8861`, `_removeWorktreeRow`/`_cleanupFeatureWorktrees` at `:9501`/`:9538`). There is **no reconciliation** that flips a worktree row to `merged`/inactive when its on-disk directory disappears (confirmed: status transitions happen only inside the explicit merge/abandon handlers). So if an agent performs the merge in a terminal, Switchboard's board will keep showing that worktree as active forever unless an explicit cleanup action runs. Cleanup therefore must be an explicit, kind-aware action — it cannot be inferred.

## Design overview

Three cooperating pieces:

1. **UI (`src/webview/kanban.html`)** — swap the per-row **Merge** button for a **Merge prompt** button (copy-to-clipboard), and add a separate **Clean up** button next to it.
2. **Backend (`src/services/KanbanProvider.ts`)** — a new `copyMergePrompt` message handler that resolves the worktree's *kind* and correct merge *target* and returns a tailored prompt; and a refactor that extracts the removal/cleanup tail of the old merge handler into a shared, kind-aware `_cleanupWorktree` used by both a new `cleanupWorktree` message handler and the API endpoint.
3. **Agent-callable cleanup (`src/services/LocalApiServer.ts` + a new skill)** — a `POST /worktree/cleanup` endpoint that triggers `_cleanupWorktree`, and a new `worktree_cleanup` agent skill that calls it via the shared `sb_api_call.sh` lib. The merge prompt references this skill and tells the agent to **ask the user** whether to run it after a successful merge.

## Why the prompt is built in the backend

The webview worktree payload (`_sendWorktreeConfig`, `KanbanProvider.ts:9699-9709`) does **not** include `subtask_plan_id`, `tier`, or `base_branch`. The correct merge target depends on the worktree kind, and that kind is only known in the backend (it is exactly what the current `mergeWorktree` handler branches on at `:8824-8846`). So the prompt must be generated backend-side, where the target can be resolved, then posted to the webview to copy. This mirrors the existing copy-prompt pattern (`antigravity-copy-prompt-btn`: backend posts a message carrying `msg.prompt`, webview does `navigator.clipboard.writeText` — `kanban.html:6503-6524`).

## Detailed changes

### 1. Backend — prompt builder (`src/services/KanbanProvider.ts`)

Add a `copyMergePrompt` message handler (near the existing `mergeWorktree` handler at `:8808`). It:

1. Resolves `workspaceRoot`, gets the DB, loads `getWorktrees()`, finds the row by `worktreeId`.
2. Determines the worktree **kind** and **merge target** using the same branching the old merge handler used:
   - **subtask worktree** (`subtask_plan_id && feature_id`) → target = the feature **integration** worktree (found via `feature_id`, excluding subtask/tier rows — the `:9559` lookup). Merge is performed *in the integration worktree's checkout*.
   - **tier worktree** (`tier && feature_id`) → same target as a subtask worktree (converges into integration first).
   - **integration worktree** (`feature_id`, no `subtask_plan_id`, no `tier`, has children) → target = the repo's default branch in the main checkout; note that its child worktrees converge first.
   - **plain / project worktree** → target = the repo's default branch in the main checkout.
   - Resolve the default branch via the existing `_resolveDefaultBranch(workspaceRoot)` (`:9316`).
3. Builds a prompt string (see draft below) with concrete branch names, worktree paths, and the resolved target.
4. Posts it back to the webview: `this._panel?.webview.postMessage({ type: 'mergePromptReady', worktreeId, prompt })`.

Add a `cleanupWorktree` message handler that calls the new shared `_cleanupWorktree(workspaceRoot, db, worktreeId)`.

**Refactor:** extract the removal tail of the current merge handler into `private async _cleanupWorktree(...)` that is kind-aware:
- subtask/tier worktree → `_removeWorktreeRow(..., 'merged')` for just that row + `_pruneWorktrees`.
- integration worktree → `_removeWorktreeRow` for the integration row, then `_cleanupFeatureWorktrees(..., 'merged')` to walk and remove its remaining children (mirrors `_mergeFeatureIntegrationIntoMain`'s tail at `:9586-9591`, minus the `git merge`).
- plain/project worktree → close terminals + `git worktree remove --force` + `updateWorktreeStatus(..., 'merged')` + prune (mirrors `:8852-8861` minus the merge).
This is the existing merge handler's structure with the `git merge` calls removed.

**Remove** the mechanical merge behavior per "replace": delete the `git merge` invocations and the now-unused merge helpers `_mergeSubtaskIntoIntegration` (`:9557`) and `_mergeFeatureIntegrationIntoMain` (`:9582`), and either delete the `mergeWorktree` message handler or repurpose it as the thin `cleanupWorktree` handler. (Grep for any other `mergeWorktree` senders before deleting the message type.)

### 2. UI (`src/webview/kanban.html`)

In `renderWorktreeRow` (`:9745`):
- Replace the `mergeBtn` block (`:9809-9816`) with a **Merge prompt** button that posts `{ type: 'copyMergePrompt', worktreeId: w.id, workspaceRoot: currentWorkspaceRoot }`.
- Add a **Clean up** button that posts `{ type: 'cleanupWorktree', worktreeId: w.id, branch: w.branch, wtPath: w.path, workspaceRoot: currentWorkspaceRoot }`. Immediate action, no confirm dialog (per project rule — confirm gates are a no-op in webviews and are banned).
- Keep the existing **Abandon** button unchanged (discard path).

Add a `mergePromptReady` message handler in the webview's `onmessage` switch that does `navigator.clipboard.writeText(msg.prompt)` and flips the matching button label to `COPIED!` briefly (reuse the `antigravity-copy-prompt-btn` label-flip pattern at `:6503-6524`).

Replace the `mergeWorktree(...)` JS helper (`:9725`) with `copyMergePrompt(...)` and `cleanupWorktree(...)` helpers.

### 3. API endpoint (`src/services/LocalApiServer.ts`)

Add to the router (`:1252+`, alongside the `/kanban/feature/*` family):
```
} else if (pathname === '/worktree/cleanup' && req.method === 'POST') {
    await this.handleWorktreeCleanup(req, res);
```
`handleWorktreeCleanup` parses `{ workspaceRoot, worktreeId }` (accept `branch` as an alternative key), resolves the KanbanProvider for that root, and calls a public wrapper that runs `_cleanupWorktree` then refreshes the board and re-sends worktree config. Return `{ ok: true }` / `{ ok: false, error }` JSON, matching the other handlers' response shape.

### 4. New agent skill — `worktree_cleanup`

Add `.agents/skills/worktree_cleanup/SKILL.md` plus a small `cleanup-worktree.sh` that sources `.agents/skills/_lib/sb_api_call.sh` and calls `sb_api_call POST /worktree/cleanup` with a JSON body containing the worktree id/branch. SKILL.md documents:
- **When to use:** ONLY after a merge the agent performed at the user's request, and ONLY when the user has confirmed they want the worktree cleaned up.
- **What it does:** tells Switchboard to mark the worktree merged and remove its directory (kind-aware: subtask/tier remove just that worktree; integration removes it + remaining children).
- **Extension required:** it hits the LocalApiServer; if the port file isn't found it fails with a clear message (the shared lib already handles this).

Register the skill in the skills table in `CLAUDE.md` for discoverability (optional but consistent with the other entries).

## The merge prompt (draft the backend generates)

Backend fills in the bracketed values. Example for a subtask/tier worktree:

> You are working in the git worktree at `<worktree path>` on branch `<branch>`. Merge this branch back into its integration target and resolve any conflicts.
>
> 1. Ensure `<branch>` has all intended work committed.
> 2. In the integration checkout at `<integration path>` (branch `<integration branch>`), run `git merge <branch>`.
> 3. If there are conflicts, resolve them (keep both sides' intent; prefer the incoming feature work where they overlap), then commit the merge. Do not run `git merge --abort` unless the user tells you to.
> 4. Verify the result builds/tests as appropriate.
>
> After the merge succeeds, **ask the user whether they want you to clean up this worktree in Switchboard.** If they say yes, run the `worktree_cleanup` skill (`.agents/skills/worktree_cleanup/`) — it calls the Switchboard local API to mark the worktree merged and remove it. Do not clean up without the user's confirmation.

For an integration or plain/project worktree, step 2 targets the default branch `<default branch>` in the main checkout, and the prompt notes that child worktrees should be merged first (integration case).

## Edge cases & constraints

- **Kind-aware target is mandatory.** A subtask/tier branch must merge into its integration branch, never straight into main (the old handler enforced this at `:8829-8838`; the prompt must preserve it or the integration branch is bypassed).
- **No confirm dialogs anywhere** (project hard rule) — the Clean up button acts immediately; `window.confirm()` is a silent no-op in the webview.
- **Missing integration worktree.** If a subtask/tier row's integration worktree is gone, the prompt builder should say so plainly rather than emitting a merge target that doesn't exist (mirror the `:9560` guard).
- **Clipboard availability.** Reuse the existing `navigator.clipboard.writeText` path already used by the copy-prompt button; keep the same error-label fallback.
- **Cleanup idempotency.** `_cleanupWorktree` on an already-removed worktree should be a safe no-op (log-and-continue, like `_removeWorktreeRow` at `:9501`).

## Migration / compatibility

The worktree Merge button ships in released versions, but this change touches **behavior and UI, not persisted state**: no schema change, no config change (`feature_worktree_mode` is untouched), and worktree rows keep the same `status` values (`active`/`merged`/`abandoned`). So there is **no data migration** — it is a clean behavioral swap. The one user-visible discontinuity is that the button no longer performs the merge; that is the intended change.

## Testing

- Unit/logic: prompt builder returns the correct target (integration branch vs default branch) for each of the four worktree kinds; missing-integration guard fires.
- `_cleanupWorktree` kind-awareness: subtask/tier removes only its own row; integration removes itself + children; plain removes itself. Extend the existing worktree tests (`src/test/kanban-persistence.test.ts`, `src/services/__tests__/KanbanProvider.test.ts`).
- API: `POST /worktree/cleanup` returns `{ok:true}` and the row flips to `merged`; unknown id returns a clean error.
- Manual: WORKTREES tab — Merge prompt copies a correct, paste-ready prompt for a subtask worktree and for a plain worktree; Clean up removes the worktree and refreshes the board; the skill script triggers cleanup end-to-end with the extension running.

## Out of scope

- Auto-reconciliation that detects a vanished worktree dir and marks it merged (the user chose an explicit cleanup button + agent-triggered skill instead).
- Any change to the mechanical **Abandon** button (discard path stays as-is).
- Changing how worktrees are *created* or the `feature_worktree_mode` selector.
