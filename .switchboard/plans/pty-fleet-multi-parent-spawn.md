# PTY Fleet: Spawn Into the Active Parent Workspace

## Goal

Make a browser-panel terminal open in the parent workspace the board is currently on, the same way the VS Code `OPEN AGENT TERMINALS` button already does. Today the PTY fleet uses the root it was handed at boot, so after switching parents on the board the operator gets a shell in the repo they just left.

### Problem & Background

The pty host is spawned **once per extension-host lifetime**, guarded by `!this._ptyHostChild` (`src/services/TaskViewerProvider.ts:1820`), with `--workspace effectiveRoot` resolved at that moment (`:1831`). That guard is deliberate and correct — the comment at `:1811-1818` explains that re-constructing would orphan child processes, leak gateway intervals, purge the live registry and mint a token that 401s every open browser terminal.

The consequence is that the fleet's fallback root is frozen at boot. `selectWorkspace` (`src/services/KanbanProvider.ts:7549`) never notifies the host; it clears `_registeredTerminals`, which is the VS Code dispatch map, not the PTY fleet. So `+ New` and `OPEN AGENT TERMINALS` in the browser panel post `{ role }` with no `cwd` (`src/webview/terminals.js:1341-1346`, `:1459-1463`), `create()` falls through to `this.workspaceRoot` (`ptyFleetService.ts:81`), and the operator silently gets the wrong repo.

### Root Cause

The VS Code extension has never had this problem, and the reason is instructive. `createAgentGrid` (`src/extension.ts:3056-3064`) resolves its target **live, at click time**:

```ts
const currentWorkspaceRoot = kanbanProvider!.getCurrentWorkspaceRoot()
    ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
const effectiveWorkspaceRoot = kanbanProvider!.resolveEffectiveWorkspaceRoot(currentWorkspaceRoot);
let effectiveCwd = effectiveWorkspaceRoot;
```

Two calls: read the board's current selection, collapse it to its parent through the setup.html mappings. That is the whole mechanism, and it has worked for as long as the grid button has existed.

The PTY fleet does not do this — not because the information is unavailable, but because the fleet resolves its root **once at process spawn** instead of **once per create**. The root cause is the *timing* of the resolution, not a missing capability.

> **Superseded:** the original plan's approach — add a `parentRoot` parameter to `ptyCreateTerminal`, ship the full configured parent set into the pty child process as a `--parents` JSON argument plus a `ptySetParents` refresh verb, and resolve the target inside `PtyFleetService`.
> **Reason:** it solves "get the parent list into the child process," a problem that only exists if the child is made responsible for choosing the directory. It does not need to be. Every browser-originated `ptyCreateTerminal` already passes through one function in the extension host — `TaskViewerProvider.handlePtyVerb` (`:1930`) — which holds `this._kanbanProvider` and can make the same two calls `createAgentGrid` makes. Resolving there deletes the boot argument, the refresh verb, the mapping-normalisation helper, the `mappingsChanged` wiring, and every staleness concern that came with them.
> **Replaced with:** resolve the target directory in the extension-side proxy, immediately before forwarding to the child. The child's `create()` signature does not change at all.

## Implementation

### 1. Resolve the target in the proxy

In `TaskViewerProvider.handlePtyVerb` (`:1930`), before the `_ptyHostVerb` call, fill in a missing `cwd` for creates:

```ts
if (verb === 'ptyCreateTerminal' && !payload.cwd && !payload.worktreePath) {
    const selected = this._kanbanProvider?.getCurrentWorkspaceRoot();
    if (selected) {
        payload = { ...payload, cwd: resolveEffectiveWorkspaceRootFromMappings(selected) };
    }
}
```

`resolveEffectiveWorkspaceRootFromMappings` is already imported in this file (used at `:1807`). Mutate a copy, not the caller's object.

Precedence is deliberate: an explicit `cwd` or `worktreePath` from the caller still wins, so worktree dispatch is untouched. Only the "no target named" case — which is every `+ New` and every `OPEN AGENT TERMINALS` click today — changes, and it changes from *boot root* to *active parent*.

When nothing is selected, leave `cwd` unset and let the child fall back to its boot root exactly as today.

### 2. Let the client name a parent explicitly

The sidebar's per-parent `+` (hierarchy plan) sends `{ role, parentRoot }`. Translate it in the same place:

```ts
if (verb === 'ptyCreateTerminal' && payload.parentRoot && !payload.cwd && !payload.worktreePath) {
    payload = { ...payload, cwd: payload.parentRoot };
}
```

Strip `parentRoot` before forwarding. The child never learns the concept exists — it receives a `cwd` like any other caller. This is what keeps the child's signature, both host copies and the route contract untouched.

### 3. Stop `create()` mislabelling an injected cwd as a worktree

`ptyFleetService.ts:95` currently stamps the handle as:

```ts
worktreePath: worktreePath || (cwd !== this.workspaceRoot ? cwd : undefined),
```

It infers "this is a worktree" from "this cwd is not the boot root." That inference is wrong today for external callers, and step 1 makes it wrong *constantly*: once the proxy injects the active parent as `cwd`, every terminal opened while the board is on the non-boot parent gets stamped with a `worktreePath` pointing at a parent directory, and the sidebar renders a phantom worktree group for it.

Replace with:

```ts
worktreePath: worktreePath || undefined,
```

Both in-repo callers that pass `cwd` also pass `worktreePath` (`terminals.js:1349-1352`; `bootstrap.ts:1088` passes `matchedWtPath` as both), so this is a no-op for them. This one line is load-bearing for the whole feature — without it, step 1 trades a wrong directory for a wrong grouping.

### 4. Standalone host

No change. `bootstrap.ts` has a fixed CLI `--workspace` root and no board selection to track, so there is no "active parent" to resolve. Its terminals already open in the root it was given.

### Out of scope

- **Path validation.** `cwd` reaching `node-pty` unchecked from localhost HTTP is a real pre-existing hole, but it is not this feature and folding it in is what turned this plan into a 6. File it separately.
- Running more than one pty host.
- Re-pointing the child's `workspaceRoot` on workspace switch. It stays the boot default and is now only a last-resort fallback.

## Metadata

**Complexity:** 3
**Tags:** backend, bugfix

**Depends on:** possibly already covered — the operator reports an in-flight plan carrying the active-parent resolution. Reconcile against it before starting; if that plan already injects the cwd in the proxy, this plan reduces to step 3 alone.

## User Review Required

No. The only behaviour change is that a terminal opened with no explicit target now lands in the board's active parent instead of the boot root — which is the stated goal, and matches what the VS Code grid button has always done. Explicit `cwd` / `worktreePath` callers are unaffected.

## Complexity Audit

### Routine

- A conditional assignment in one existing function.
- Deleting an inference from one line.

### Complex / Risky

- **Step 3 is a silent-failure guard, not a nicety.** Skip it and the feature appears to work while filing every terminal under a phantom worktree.
- The proxy is on the hot path for three verbs; the injection must not run for non-create verbs or for payloads that already name a target.

## Edge-Case & Dependency Audit

**Race Conditions**
- Operator switches workspace between clicking `+` and the request landing. The resolution happens proxy-side at request time, so the terminal lands in whichever parent was active when the request arrived — the same guarantee `createAgentGrid` gives.

**Security**
- No new input surface. Step 2 accepts a client-supplied `parentRoot`, but it is written into `cwd`, which is already accepted unvalidated today. Neither widens nor closes the existing hole — see Out of scope.

**Side Effects**
- `create()` no longer back-fills `worktreePath` from `cwd`. The `runtime.terminals` mirror (`ptyFleetService.ts:201`, `TaskViewerProvider.ts:1917`) will record `undefined` where it previously recorded a directory, for callers passing a bare `cwd`. Worktree-matched dispatch keys off the worktrees table (`matchWorktreePath`), not this field, so routing is unaffected.

**Dependencies & Conflicts**
- Touches `TaskViewerProvider.ts` and one line of `ptyFleetService.ts`. Does not touch `ptyHost.ts`, `bootstrap.ts`, the route contract, or the verb allowlist.

## Dependencies

- Independent of the reporting plan; they touch different code and can land in either order.
- The hierarchy plan's per-parent `+` needs step 2.

## Adversarial Synthesis

Key risks: injecting a `cwd` on every create makes the pre-existing `worktreePath` back-stamp fire constantly, converting a directory bug into a grouping bug; and the injection running on verbs or payloads it should not touch. Mitigations: step 3 removes the inference in the same change rather than deferring it, and the injection is gated on both the verb name and the absence of any caller-supplied target. The resolution itself is a copy of a mechanism that has been in production in `createAgentGrid` for as long as the grid button has existed.

## Proposed Changes

### `src/services/TaskViewerProvider.ts`

- **Context:** `handlePtyVerb` at `:1930` — the sole route from the browser panel to the pty child; `resolveEffectiveWorkspaceRootFromMappings` already imported and used at `:1807`; `this._kanbanProvider` already referenced at `:1973`.
- **Logic:** Resolve the target directory at request time, mirroring `extension.ts:3057-3064`.
- **Implementation:** Steps 1 and 2 above, both gated on `verb === 'ptyCreateTerminal'`; strip `parentRoot` from the forwarded payload.
- **Edge Cases:** no board selection → leave unset; explicit `cwd` or `worktreePath` → untouched; non-create verbs → untouched.

### `src/standalone/ptyFleetService.ts`

- **Context:** handle construction at `:86-96`.
- **Logic:** A worktree is a worktree only when the caller says so.
- **Implementation:** `worktreePath: worktreePath || undefined` at `:95`.
- **Edge Cases:** callers passing both fields (all in-repo callers) are unaffected.

## Verification Plan

### Automated Tests

1. **Active-parent spawn:** with the host booted on Gitlab and the board switched to Switchboard, `ptyCreateTerminal { role: 'coder' }` produces a shell whose cwd is the Switchboard root.
2. **Parity with the grid button:** the directory chosen matches what `createAgentGrid` chooses for the same board state.
3. **Explicit target wins:** a payload with `cwd` or `worktreePath` is forwarded unmodified.
4. **Explicit parent:** `{ role, parentRoot: '<switchboard root>' }` produces a shell there, and `parentRoot` is not present in the payload the child receives.
5. **No selection:** with `getCurrentWorkspaceRoot()` null, behaviour is unchanged from today.
6. **No phantom worktree:** a terminal created with an injected `cwd` reports `worktreePath: undefined`.
7. **Worktree regression:** worktree-scoped dispatch still spawns correctly and still reports its `worktreePath`.
8. **Non-create verbs:** `ptyCloseTerminal` / `ptyRenameTerminal` payloads are forwarded unmodified.
9. **Regression:** the existing terminal contract suites still pass — `terminal-input-path-contract`, `terminal-solo-popout-contract`, `shell-terminal-strip`, `pty-route-surface-contract`, `terminal-flow-control-contract`, `terminal-token-transport-contract`, `pty-host-gating-contract`, `terminal-operations-no-periodic-reopen`.

## Recommendation

Complexity 3 → **Send to Intern**, with step 3 called out explicitly in the dispatch so it is not dropped as an unrelated tidy-up.

## Completion Report

Implemented live active parent workspace resolution in `TaskViewerProvider.handlePtyVerb` for `ptyCreateTerminal` requests lacking an explicit target, translating client `parentRoot` into `cwd`. Additionally removed `create()`'s inference that non-boot-root `cwd` implies a worktree in `PtyFleetService.ts`.
Files changed: `src/services/TaskViewerProvider.ts`, `src/standalone/ptyFleetService.ts`.
No issues encountered during implementation.

## Review Findings

Two MAJOR issues found and fixed. (1) **Grid-button parity broken** — the proxy called the bare `resolveEffectiveWorkspaceRootFromMappings(selected)`, but `createAgentGrid` resolves via `kanbanProvider.resolveEffectiveWorkspaceRoot()` (`extension.ts:3127`), which honours the legacy `kanban.controlPlaneRoot` override *first*; the two buttons therefore opened different repos for anyone with a control-plane root set, failing this plan's verification step 2. Fixed at `TaskViewerProvider.ts:1945-1959` to call the wrapper with the module function as fallback. (2) **Standalone host ignored `parentRoot`** — `bootstrap.ts` serves the same browser sidebar with its own multi-parent `parents[]`, but its `ptyCreateTerminal` read only `cwd`/`worktreePath`, so the per-parent `+` under `npx switchboard` spawned in the boot root and reported success (PRD contract #6, no lying buttons); fixed at `bootstrap.ts:1045-1052`. Step 3 verified correct and its caller audit confirmed — all three bare-`cwd` `create()` callers pass `root === workspaceRoot`, and dispatch matches on name + `ideName` (`extension.ts:2139`), not the mirrored `worktreePath`, so routing is unaffected. Validation: `compile-tests`/`compile` clean, `lint` 0 errors, all five PRD gates pass, 16 terminal contract suites pass, plus 29 new assertions in `multi-parent-terminals-contract`; remaining risk is the deferred pre-existing hole this plan correctly scoped out — `cwd` still reaches `node-pty` unvalidated.

