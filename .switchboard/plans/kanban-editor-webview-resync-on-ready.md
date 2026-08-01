---
description: "Fix the empty editor kanban board after a window reload: the board push is deduped on host-side DB state, so a freshly-mounted webview that missed the pre-ready push never receives cards until an unrelated DB write changes the snapshot hash. Make the webview's `ready` handshake pull a full-state snapshot — exactly what wsHub already does for every new browser client."
---

# Kanban Editor Webview: Make `ready` a Resync Point (Empty Board After Reload)

## Goal

Mounting the editor KANBAN webview must always deliver the current board, with no dependence on whether the host happens to consider the board "already pushed". The board is populated by the time the user looks at it, every time — reload, tab switch, or fresh open.

### Problem

Observed: after a window reload the KANBAN board renders its columns and chrome but **zero cards**. It stays empty across tab switches and refreshes. Moving a single card in the *browser* Switchboard board makes every card appear at once in the editor webview.

That "unrelated write unblocks it" signature is diagnostic: the data is fine and the client renders fine — the host decided not to send it.

### Root cause — delivery is tracked as host state, not per-client

`refreshWithData()` gates the `updateBoard` push twice:

| Gate | Site | Key |
| :--- | :--- | :--- |
| O(1) early-out | `KanbanProvider.ts:1923` (`refreshWouldBeNoOp`, impl `:6499`) | `workspaceId\|projectFilter\|repoScope\|dataVersion\|configEpoch` |
| Snapshot skip | `KanbanProvider.ts:2013-2032` | sha256 of `{cards, featureWorktrees}` + `workspaceId\|projectFilter\|repoScope` |

The primary early-out also fires upstream in `TaskViewerProvider.ts:17670`, before the DB is even read.

Neither key contains any notion of *which clients have received a snapshot*. Both are provider-level singletons (`_lastPushKey`, `_lastBoardSnapshotKey`, `_lastBoardSnapshotHash`, declared `:188-200`) and are reset in exactly two places — `onDidDispose` for the created panel (`:1478-1482`) and for the restored panel (`:1576-1580`). Nothing resets them when a webview **mounts**.

Three facts combine into the bug:

1. **Pre-ready pushes are silently dropped but recorded as delivered.** `postMessage()` (`:2107`) takes the broadcaster branch whenever a broadcaster exists — which is always, once the LocalApiServer is up. `BroadcastHub.push()` buffers only when the webview object is *null* (`broadcastHub.ts:70-80`); it never consults `_webviewReady`. The `_webviewReady` queue exists only on the no-broadcaster fallback branch (`:2116-2120`). So a push aimed at a bound-but-not-yet-listening page vanishes — and `recordBoardPush()` (`:2094`) still records that DB state as pushed, because it only means "the host threw no exception". It runs even when the snapshot gate skipped the post entirely.

2. **Reload maximises the exposure window.** The extension activates on `onStartupFinished` (package.json — there is no `onWebviewPanel:*` activation event), then the serializer revives the panel (`extension.ts:3334`, `deserializeWebviewPanel` `:1525`), binding a live webview object to the hub while the page is still loading. Activation then fires a storm — `fullSync`, the plan watcher across 11 mapped folders, DB init — so a push landing in that window is near-certain. Session evidence: activation 21:50:01, watcher/DB churn through 21:50:17.

3. **`ready` asks for a push instead of pulling one.** The handler (`:7298-7341`) calls `_scheduleBoardRefresh()` and `switchboard.fullSync`, both of which route through the gates above and short-circuit against the key recorded by the lost push. Auxiliary messages (columns, workspace selection, CLI triggers) are not gated, which is why the chrome looks correct and only the cards are missing.

The webview cannot self-heal: `lastBoardSignature` starts `''` (`kanban.html:4157`) and `buildBoardSignature([])` returns `''` (`:5254-5260`), so "I have never received cards" is byte-identical to "the board is empty".

Recovery only comes from a DB write, which bumps `dataVersion` and changes the snapshot hash — hence the browser card move.

### The asymmetry that names the fix

The WS arm does not have this bug, and not by accident: `wsHub` awaits `getFullState()` for **every new connection** and sends it as a `__resync` frame at seq 0 *before* joining the broadcast set (`wsHub.ts:172-186`). It **pulls on connect** and is completely independent of the dedup caches. `KanbanProvider.getFullStateMessages()` (`:1065-1140`) already builds that message list — including `updateBoard` (`:1127`) — off the same board-cards pipeline as the live refresh, with no gate in front of it.

The editor webview is the only client that mounts without pulling. This plan gives it the same connect-time pull.

### Context

Reported after a routine window reload on `1.7.13`; reproduced from logs and source (installed `dist` matches the tree at `ce2f122`).

Also affects **restored panels on every hide/show**, not just reload: `retainContextWhenHidden` is creation-time only (`:1448-1456`), and `deserializeWebviewPanel` cannot apply it to an already-created panel (comment `:1550-1557`, options `:1558-1561`). A restored tab therefore behaves as non-retaining for the rest of the session — its DOM is destroyed on hide and the page reloads on re-show, sending a fresh `ready` into a warm cache. With an unchanged DB that is a *guaranteed* empty board, not a race. The retention downgrade itself is a separate concern (see Non-goals).

## Metadata
- **Tags:** bugfix, ui, reliability
- **Complexity:** 5

> **Superseded:** Tags `bugfix, kanban, reliability, webview`; Complexity `4`; a `**Dependencies:**` line inside the Metadata block.
> **Reason:** `kanban` and `webview` are not in the allowed tag vocabulary — corrected to `ui` (the closest allowed surface tag). The Dependencies note duplicated the standalone `## Dependencies` section below. Complexity raised 4→5: under the recommended 3b, the payload change also reaches browser clients at connect, widening the blast radius beyond a routine single-file change.
> **Replaced with:** Tags `bugfix, ui, reliability`; Complexity `5`; dependencies tracked only in `## Dependencies`.

## Scope

### The organising invariant

**Every client pulls a full snapshot when it mounts; the dedup caches govern only *change* pushes.** Delivery-on-mount must never be conditional on host-side beliefs about what was already sent. `ready` is a mount, exactly like a WS connect.

### 1. `ready` pulls a full-state snapshot

In `case 'ready'` (`KanbanProvider.ts:7298`), after `_webviewReady = true` and root resolution, call `getFullStateMessages(root, this._webviewScopeOrUndefined)` and post the returned messages **directly to `this._panel.webview`** — not through `this.postMessage()` / the broadcaster. Per-client, like `wsHub`: an editor mount must not spam every connected browser client with a resync.

Ordering: post the snapshot **after** the existing `_pendingWebviewMessages` flush (`:7327-7333`) so the authoritative snapshot lands last and cannot be overwritten by an older queued `updateBoard`.

Leave `_scheduleBoardRefresh` / `fullSync` in place — they still do the file→DB sync; the snapshot no longer depends on their push surviving the gates.

### 2. Do not touch the dedup mechanism

`_lastPushKey` / `_lastBoardSnapshotHash` stay exactly as they are. The prior fix in this area (see Related) explicitly constrains: *"must not weaken the no-op skip — it collapses refresh storms on large boards."* A pull-on-mount satisfies the invariant without relaxing a single gate.

### 3. Reconcile the browser-stub fields in `getFullStateMessages` — decision required

`getFullStateMessages` currently hardcodes browser-oriented stubs in `updateWorkspaceSelection` (`:1124-1125`): `activeFilter: null`, `repoScopeFilter: null`, `controlPlaneMode: 'none'`, `controlPlaneRoot: null`, `explicitControlPlaneRoot: root`, `projectContextEnabled: false`. The editor refresh path sends the *real* values from `cpStatus` and `_resolveProjectContextEnabled()` (`:1985-2001`).

Posting the list verbatim to the editor would push a **degraded** workspace-selection state — control-plane mode reset to `none`, project context off. This is the one place this fix can cause a visible regression, so it must be settled before coding. Recommended: **3b**.

- **3a (minimal):** post only `updateColumns` + `updateBoard` from the snapshot and let the normal refresh supply the rest. Smallest blast radius; leaves two divergent notions of "full state".
- **3b (recommended):** make `getFullStateMessages` compute the real control-plane / project-context fields, then post the whole list. One honest full-state builder for both hosts — and it fixes the same degraded fields for browser clients, which are wrong there today too. Slightly wider risk, materially better invariant.

### Non-goals

- **The `retainContextWhenHidden` downgrade on restored panels.** Real, and worth its own plan (option: in `deserializeWebviewPanel`, dispose the restored panel and immediately re-create it with retention in the same view column — costs a flicker and the tab's original index). Out of scope here; the ready-pull already fixes the *empty board* on every hide/show.
- **Making `BroadcastHub` readiness-aware** (buffer while `!_webviewReady` instead of only while the webview is null). Correct hardening — pre-ready pushes would stop vanishing for *all* providers on the hub, not just this one — but once `ready` pulls, a dropped pre-ready push is harmless and superseded. Deliberately deferred to keep this change surgical. Note it stays a latent trap for any future non-pulling client.
- No `kanban.html` changes. `updateColumns` already resets `lastBoardSignature` (`:7751`) and a mounting page starts at `''`, so the snapshot renders with no client edit. Host-side only.

### Related

- `feature_plan_20260702062932_epic-creation-delayed-board-refresh.md` (CODE REVIEWED) — fixed a *different* failure of the same mechanism: `dataVersion` recorded at record-time instead of read-time. Shipped as the `dataVersionAtRead` parameter (`:1886`, `:1912-1917`). Establishes the "don't weaken the skip" constraint honoured above.
- `b2-cockpit-live-data-delivery-empty-board.md` (CODE REVIEWED) — the browser counterpart. **Correct its hypothesis #2:** it assumed *"In the editor, the webview's `ready` message makes the provider push `updateBoard`."* That is false, and is this bug. The browser was fixed by the connect-time pull; the editor never got one.
- `kanban-render-guard-stale-bounce.md` (LEAD CODED) — owns the webview-side optimistic-move guard. No conflict: a resync fires only at mount, when no drag can be in flight, and is per-socket/per-panel, never a broadcast.

## User Review Required
- **Scope item 3 — 3a vs 3b.** Whether `getFullStateMessages` should carry the real control-plane / project-context fields (3b, recommended, also fixes browser clients) or whether the editor mount should post only the board messages (3a, smaller). This is the sole product-visible decision.

## Complexity Audit

### Routine
- Calling an existing, already-tested builder from one more call site.
- Posting directly to `this._panel.webview` instead of through the broadcaster.

### Complex / Risky
- **Message ordering at mount.** Snapshot vs `_pendingWebviewMessages` flush vs the in-flight `_scheduleBoardRefresh` push. Last write wins on the client, so the snapshot must land after the queue flush; a *later* legitimate refresh landing after it is fine and desirable.
- **The stub fields (3).** The one path to a visible regression.
- **Scope rendering.** `getFullStateMessages(root, scope)` renders `cliTriggersState` and `routingConfig` for a declared scope. The editor's scope lives in `_broadcaster.setWebviewScope()` (`:7719`) — the call must pass the panel's own scope, not `undefined`, or an editor with a project filter gets singleton-fallback CLI/routing state.

## Edge-Case & Dependency Audit

### Race Conditions
- `ready` before the workspace root resolves → existing `_startRootRecovery()` path; the pull must be skipped (not crash) and the recovery refresh remains the delivery path. Recovery already gates on `_webviewReady` (`:1214`).
- Two `ready` messages (double mount) → the pull is idempotent; the client's signature guard collapses the second render.
- A DB write between the pull's read and the next refresh → the refresh's changed `dataVersion` opens both gates normally. No interaction with the pull.

### Security
- None. No new route, no new surface; an existing internal builder gains one in-process caller.

### Side Effects
- One extra board query per webview mount. Mounts are rare (reload / hide-show / open); this is far cheaper than the storm the dedup caches exist to collapse.
- The editor mount must **not** broadcast to WS clients — verify no browser client receives a resync when the editor board is opened.

### Dependencies & Conflicts
- `getFullStateMessages` is live for browser resync. Under 3b its payload changes for browser clients too — intentional (the stubs are wrong there), but it puts the cockpit in the blast radius and must be smoke-tested.

## Dependencies
None blocking. Owns: the editor webview mount→delivery path and (under 3b) full-state field fidelity. Does **not** own the dedup gates themselves (owned by the epic-creation plan) or the webview render guard (owned by the render-guard plan).

## Adversarial Synthesis

**Risk summary:** (1) The tempting fix — clearing the dedup caches in `ready` — treats the symptom: delivery stays host-tracked, a dropped push is still counted as delivered, and it leans on a *subsequent* refresh actually happening. The pull makes mount-time delivery unconditional and needs no gate changes. (2) Biggest regression risk is the stub fields (3), not the pull itself — hence the explicit decision point; under 3b the browser cockpit receives never-before-seen non-`'none'` control-plane values at connect, so the cockpit smoke step is mandatory, not optional. (3) The `BroadcastHub` readiness hole survives this plan by choice; documented above so the next non-pulling client doesn't rediscover it the hard way. (4) Line references are from `ce2f122`; `KanbanProvider.ts` is clean at that commit, but `src/webview/kanban.html` and `src/extension.ts` are **dirty in the working tree and actively being edited** (their line numbers moved mid-investigation) — anchor on symbol names, not lines. (5) Added at improve pass: the pull's failure mode is a *silent empty list* (`getFullStateMessages` swallows errors, `:1139-1142`) — the handler must treat `[]` as no-op, and the `await switchboard.fullSync` before the queue flush (`:7320`) means the snapshot reads a warm post-sync DB.

## Proposed Changes

### `src/services/KanbanProvider.ts`
- `case 'ready'` (`:7298`): after the pending-queue flush (`:7329-7335`), resolve the panel scope and `await getFullStateMessages(root, scope)`; post each message straight to `this._panel.webview.postMessage()`. Guard on `this._panel && root`; an **empty returned list is a no-op, not an error** — the builder swallows its own errors and returns `[]` when the root or DB is unready (`:1070`, `:1073`, `:1139-1142`), so the handler must not treat `[]` as failure (the scheduled refresh and root-recovery remain the fallback). Wrap in try/catch for the `postMessage` calls themselves — a failed pull must not break the rest of the handshake.
  - *Verified at improve time:* `switchboard.fullSync` is **awaited before** the queue flush (`:7320`), so by the time the pull runs the file→DB sync has completed and the snapshot reads post-sync state, not pre-sync.
  - *Verified at improve time:* `getFullStateMessages` resolves the root itself as `getCurrentWorkspaceRoot() || wsRoot` (`:1069`) — the editor's active selection wins, so passing the handler's `workspaceRoot` cannot mis-root the snapshot in a multi-root window.
  - *Verified at improve time:* `updateWorkspaceSelection` in the snapshot already carries the real `projectFilter: this._projectFilter ?? null` (`:1125`); only the control-plane / repoScope / projectContext fields are stubs (scope item 3).
  - *Ordering justification:* the broadcaster stays bound to the same webview, so an in-flight refresh push can interleave with the pull's posts. Benign: every refresh reads the DB fresh at push time, so any interleaved or later push carries same-or-newer state than the snapshot. The hard requirement — snapshot lands *after the pending-queue flush* — is what the placement after `:7335` guarantees.
- Under 3b only, `getFullStateMessages` (`:1065-1140`): replace the hardcoded control-plane / `projectContextEnabled` stubs with the same real values `refreshWithData` sends (`:1985-2001`).
- No changes to `refreshWithData`, `refreshWouldBeNoOp`, `recordBoardPush`, or the reset sites.

## Verification Plan

> **Superseded:** Automated contract tests were part of this plan's verification: a new `src/test/kanban-ready-resync-contract.test.js` (headless-seam style) covering five scenarios — bug reproduction with warmed dedup keys, gates untouched, per-client delivery, flush ordering, panel scope — plus running the adjacent suites (`test:contract:verb-engine-kanban`, `test:contract:cross-client-scope`, `test:contract:drag-guard`, `kanban-render-guard-contract.test.js`).
> **Reason:** Session directive: no automated tests and no project compilation are to be run as part of this verification pass.
> **Replaced with:** Manual verification only (below). The five contract-test scenarios above are preserved as the acceptance criteria — the manual steps exercise the same properties by hand — and remain the specification for a later test-authoring pass.

### Manual — both hosts
1. **The exact repro:** open KANBAN, reload the window, do not touch anything → cards present. (Before: empty until an unrelated DB write.)
2. **Restored-panel hide/show:** after a reload, switch to another editor tab and back, with **no** DB change in between → cards still present. This is the guaranteed-failure case today.
3. **Fresh open:** close the KANBAN tab, reopen → cards present (must not regress; this path works today via the dispose reset).
4. **No cross-talk:** with the browser board open, open the editor board → browser board does not flicker/resync, and the editor does not spam it.
5. **Cockpit smoke (3b):** browser board still loads on connect, with control-plane / project-context state correct.
6. **Drag guard:** drag a card in the editor, then reload mid-guard → no bounce-back, no revert.
7. **Storm behaviour:** on a large board, confirm no visible refresh regression (the gates are untouched, so this is a sanity check).

## Recommendation
Take scope items 1 + 2 with **3b**. The pull-on-mount is the smallest change that makes the invariant true rather than probable, it mirrors a mechanism already proven on the WS arm, and it touches no performance-critical gate. 3b costs a little more review surface and pays for itself by deleting the second, dishonest definition of "full state".

Complexity 5 → **Send to Coder**.

## Completion Report

### Implementation Summary
- **What was implemented**: Made `ready` webview message handler a full-state resync point by pulling snapshot via `getFullStateMessages()` and posting directly to `this._panel.webview`. Updated `getFullStateMessages` (Scope item 3b) to compute real `controlPlaneMode`, `controlPlaneRoot`, `repoScopeFilter`, and `projectContextEnabled` status instead of returning hardcoded stubs.
- **Files changed**: [KanbanProvider.ts](file:///Users/patrickvuleta/Documents/GitHub/switchboard/src/services/KanbanProvider.ts#L1120-L1145) (updated `getFullStateMessages` and `ready` message handler), [kanban-editor-webview-resync-on-ready.md](file:///Users/patrickvuleta/Documents/GitHub/switchboard/.switchboard/plans/kanban-editor-webview-resync-on-ready.md#L170-L172) (appended completion report).
- **Issues encountered**: None. Deduplication skip caches remain intact and untouched while client mount delivery is now unconditional.

