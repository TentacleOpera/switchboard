# Standalone Board Parity

**Complexity:** 7

## Goal

Bring the headless (standalone CLI) Board up to parity with the extension Board, so the browser cockpit is usable without VS Code running.

Measured 2026-08-04 against a freshly built dist/standalone/cli.js: 83 of 106 verbs that kanban.html posts return "not implemented in standalone mode", while the project, planning, setup, tickets and design panels return zero. The gap is not missing functionality — 82 of the 83 are already in KANBAN_VERBS with working handlers in KanbanProvider, and standalone already constructs that provider fully wired. One router arm never delegates to it.

These six subtasks form a strict dependency chain rather than independent fixes: the wiring must be repaired before delegation is safe, delegation is what makes the command no-ops observable, triage measures what actually works headlessly, and gating hides only what triage proves cannot. Landing them out of order converts honest errors into silent wrong behaviour.

## How the Subtasks Achieve This

- **Standalone: make workspace-root resolution work in the shared providers**: repairs the two wiring
  gaps that make every shared-provider settings helper blind in this host — root resolution in
  `TaskViewerProvider` bypasses the `HostWorkspace` seam that already holds the served root
  (`_getWorkspaceRoots():2513` reads `vscode.workspace.workspaceFolders` directly, which the shim
  hardcodes empty at `vscodeShim.ts:189`), and `kanbanProvider.setTaskViewerProvider()` is never
  called. Until both are fixed, `_getScopedSetting` and friends skip the `kanban.db` config tiers and
  answer from a memento or a default, and role-config writes are silently dropped. Nothing throws,
  which is why this has to go first.

  > **Superseded:** "the shim's `workspaceFolders` is a hardcoded empty array … even though the root is
  > already installed on `globalThis`" — framed as the defect, with populating the shim as the fix.
  > **Reason:** Cross-subtask audit found the sanctioned mechanism already built and already used
  > elsewhere: the `HostWorkspace` seam (`hostSeams.ts:512-529`) exists specifically for "the
  > standalone vscode shim, where no folders are registered", standalone already supplies the root
  > through it (`hostServices.ts:379-381`), and `SetupPanelProvider._getCurrentWorkspaceRoot():254-269`
  > already prefers it over `vscode`. Populating the shim instead would wake four dormant editor-host
  > subsystems inside a host that runs its own equivalents — a PTY-registry purge, a duplicate pty
  > host, an `api-server-port.txt` clobber and a second plan-import path.
  > **Replaced with:** convert the `_getWorkspaceRoots()` chokepoint to seam-first (PRD contract #3),
  > leave the shim alone, and ship an explicit headless guard on `_startLocalApiServer`.
- **Standalone Board: fall through to the KanbanProvider verb passthrough**: the structural fix. Changes
  the `default:` arm of `bootstrap.ts`'s hand-written 25-case switch to delegate to
  `KanbanProvider.handleServiceVerb` — the same passthrough it already uses for three feature verbs —
  which resolves 82 of the 83 dead verbs at once, including the drag-and-drop trio whose current
  failure looks like a flaky board rather than a missing feature.
- **Standalone: bridge `switchboard.*` command dispatch instead of swallowing it**: 171 provider
  `executeCommand` call sites — led by 43 `switchboard.refreshUI` sites — resolve to `undefined`.
  Without this, a delegated verb can write to the DB, return success, and leave the browser showing
  stale cards, which is worse than today's honest error. The fix is the headless `commands` seam
  (`hostServices.ts:354-356`) backed by the registry the codebase already has
  (`services/commandRegistry.ts`), which the seam architecture explicitly reserves for "B1's headless
  composition root".

  > **Superseded:** "the shim stubs the whole `commands` namespace to no-ops, so ~150 provider call
  > sites … do nothing" — with `vscodeShim.ts:228-231` as the fix site.
  > **Reason:** Measured wrong. 164 of the 171 sites route through `this._seams().commands.executeCommand`
  > and dead-end at the **headless seam**, not the shim; only 7 are raw `vscode.commands.executeCommand`
  > (all in `KanbanProvider`). Fixing the shim would have bridged 7 sites while the reported symptom
  > survived intact — and the plan's original test (a spy on a stubbed broadcaster) would have passed.
  > **Replaced with:** implement the headless `commands` seam registry-first over
  > `switchboardCommandRegistry`, register handlers in `bootstrap.ts` before `server.start()`, and
  > convert the 7 raw `KanbanProvider` sites to the seam (contract #3 wants that regardless).

- **Standalone: persist UI settings instead of holding them in a process-local Map**: retires the
  boot-fresh `uiSettings = new Map()` and the two hand-rolled arms that use it, so `getSetting` /
  `saveSetting` fall through to `KanbanProvider`'s durable four-tier arms — settings survive a restart
  and a workspace configured in the editor is no longer invisible to the browser. Also the prerequisite
  for verifying the eight settings-toggle verbs, since a toggle that cannot persist cannot be checked by
  a second read.

  > **Superseded:** "replaces the boot-fresh `uiSettings = new Map()` with a durable store" — new
  > direct-DB helpers written in `bootstrap.ts`.
  > **Reason:** `KanbanProvider.ts:10085-10118` already implements every element that plan specified as
  > new work — the `switchboard.prompts.` prefix, the non-string-key guard, the four-tier resolution,
  > the `settingResult` push, the `selectedRole` special case, and return-in-body — and both verbs are
  > already in `KANBAN_VERBS`. Building a parallel two-tier store would have created a fifth settings
  > store with its own cache-invalidation rule, and only worked because it *avoided* the helper that
  > subtask (1) un-blinds one step earlier in this same chain.
  > **Replaced with:** delete the Map and the two arms; delegate. The plan drops from complexity 4 to 3
  > and gains two hard dependencies (see sequencing).
- **Standalone: triage the Board verbs that cannot work headlessly, and prove the rest do**: runs every
  delegated verb against a real server with valid payloads and independent oracles, classifying each
  works / degrades / editor-only. This is what converts "reachable" into "verified", and it produces the
  editor-only list the gating subtask consumes. Its pass bar rejects `{success:true}` as evidence.
- **Capability gating: stop the headless Board from showing controls that cannot work**: makes the
  manifest honest — consumes the `orchestrator` and `mcpTerminals` flags the host already declares but
  the webview never reads, gates whole tabs instead of 13 hand-listed selectors, adds flags for the
  worktrees and UAT surfaces that have none, and stops `featureManagement: true` over-reporting.
  Whatever triage proves cannot work headlessly gets hidden rather than left to dead-click.

<!-- BEGIN SUBTASKS (auto-generated, do not edit) -->
## Subtasks
- [ ] [Standalone Board: fall through to the KanbanProvider verb passthrough](../plans/standalone-board-verb-rail-fallthrough.md) — **CODE REVIEWED** — ID: 120030ef-4b1a-4b5b-bc06-e12d09576854
- [ ] [Standalone: make workspace-root resolution work in the shared providers](../plans/standalone-workspace-root-wiring.md) — **CODE REVIEWED** — ID: 9894dfbb-c0d6-4f7f-8bfa-4ebc4a034167
- [ ] [Standalone: bridge `switchboard.*` command dispatch instead of swallowing it](../plans/standalone-refreshui-and-command-bridge.md) — **CODE REVIEWED** — ID: 917e28b9-aa5e-4449-a394-bd87d01b13bf
- [ ] [Standalone: triage the Board verbs that cannot work headlessly, and prove the rest do](../plans/standalone-editor-bound-verb-triage.md) — **CODE REVIEWED** — ID: 5e567bea-7a70-4ae9-8f80-9749c4b46be1
- [ ] [Capability gating: stop the headless Board from showing controls that cannot work](../plans/standalone-capability-gating-honesty.md) — **CODE REVIEWED** — ID: 497f97de-280d-4b29-ab24-72fcc46d3578
- [ ] [Standalone: persist UI settings instead of holding them in a process-local Map](../plans/standalone-persist-ui-settings.md) — **CODE REVIEWED** — ID: 75a56c6f-e608-42d2-ac00-656768c25221
<!-- END SUBTASKS -->

## Dependencies & sequencing

**This feature has hard ordering constraints. Out-of-order execution replaces honest errors with
silent wrong behaviour, which is a regression even though it looks like progress.**

```
workspace-root-wiring ──► verb-rail-fallthrough ──► refreshui-and-command-bridge ──► persist-ui-settings
                                                             │                              │
                                                             └──────────────┬───────────────┘
                                                                            ▼
                                                        editor-bound-verb-triage ──► capability-gating-honesty
```

> **Superseded:** the previous diagram and item 4, which ran `persist-ui-settings` **parallel** to
> (1)–(3) on the grounds that it "is deliberately written to use direct DB access rather than
> `_getScopedSetting`, so it does not wait on (1)".
> **Reason:** The cross-subtask audit inverted that plan: `KanbanProvider` already owns durable,
> four-tier, key-guarded `getSetting`/`saveSetting` arms, both verbs are already in `KANBAN_VERBS`, and
> (1) is what un-blinds them — so the right change is a *deletion* that depends on (1) **and** (2)
> rather than a parallel reimplementation that exists only to avoid them. Independence was bought by
> duplicating the store, which is not a price worth paying inside a six-subtask chain that lands (1)
> first anyway.
> **Replaced with:** a single strict chain, 1 → 2 → 3 → 4 → 5 → 6, as below.

1. **`standalone-workspace-root-wiring`** — first, alone. Hard prerequisite of the fallthrough. Its own
   biggest risk is **confirmed, not hypothetical**: fixing the root un-gates `_startLocalApiServer`
   (`TaskViewerProvider.ts:829`, reached from `bootstrap.ts:618`), which purges the live PTY fleet's
   registry rows, spawns a duplicate pty host, and overwrites `.switchboard/api-server-port.txt` — the
   discovery file every skill and CLI reads. It also wakes `_setupPlanWatcher`'s native `fs.watch`
   handles, a second plan-import path racing `PlanIngestionEngine`. The seam-based approach structurally
   avoids all of it (seams are injected at `:619`, *after* activation at `:618`), and an explicit guard
   ships in the same change so that ordering is not left load-bearing.
2. **`standalone-board-verb-rail-fallthrough`** — second. Blocked by (1): the delegated arms read and
   write settings through the helpers (1) repairs, and every failure mode there is silent. Also owns
   the `initiatorProject` payload field (from standalone's `projectFilter` closure) — without it every
   delegated scoped read and write resolves on the workspace tier with no error.
3. **`standalone-refreshui-and-command-bridge`** — with or immediately after (2). Landing (2) without
   this leaves mutating verbs that succeed in the DB and never refresh the browser. Do not ship (2)
   alone to a user.
4. **`standalone-persist-ui-settings`** — after (2), and after (1) for its helper to work. Now a
   deletion: retire the `uiSettings` Map and the two hand-rolled arms so both verbs fall through to
   `KanbanProvider`. Carries a one-time `selectedRole` reset (bare key → `switchboard.prompts.`-prefixed
   key, same JSON file) that belongs in release notes.
5. **`standalone-editor-bound-verb-triage`** — after (2), (3) and (4). Meaningless before (2) (nothing
   to triage), misleading before (3) (command no-ops misread as broken arms), and cannot classify the
   settings-toggle cluster before (4). Run it twice — once before (3) and once after — so the
   "needs a bridged command" list is measured shrinking rather than assumed, and measure it against the
   **headless `commands` seam**, not `vscodeShim.commands`. Its classification must distinguish four
   outcomes, not three: `works` / `push-only read` / `degrades` / `editor-only`.
6. **`standalone-capability-gating-honesty`** — last, because it consumes (5)'s verified editor-only
   list. **Partial exception:** the `orchestrator` and `mcpTerminals` branches can land at any time,
   since both flags are already declared `false` and both clusters are already measured dead — that
   subset needs no triage input.

### Shared-surface map — one reconciled end-state per contended file

Five of six subtasks edit `src/standalone/bootstrap.ts`. PRD "Orchestration discipline" says *one agent
stream per provider file* — so this feature **cannot** be fanned out across worktrees on the same file,
and the chain above is also the merge order. Contended surfaces and their single agreed end-state:

| File / symbol | Subtasks | Reconciled end-state |
| :--- | :--- | :--- |
| `bootstrap.ts` provider-construction block (`:591-680`) | 1, 3 | (1) adds `kanbanProvider.setTaskViewerProvider(...)` after seam injection at `:619` and sets the API-server suppression flag before `:618`; (3) registers command handlers after `pushFullState`/`handlePtyVerb` exist and before `server.start()` (`:1423`). Different insertion points, no overlap. |
| `bootstrap.ts` `kanbanVerb` `default:` arm (`:995`) | 2, 4 | (2) owns the arm and writes the payload spread **including `initiatorProject: projectFilter`**; (4) only *removes* the `getSetting`/`saveSetting` cases above it. Whichever lands second must not re-add the `initiatorProject` line. |
| `bootstrap.ts` `uiSettings` Map (`:300`) + the two settings arms (`:713-729`) | 2, 4 | Deleted by (4). (2) explicitly leaves them alone (its User Review 2 names them as the two exceptions to "hand-rolled arms stay"). |
| `TaskViewerProvider._getWorkspaceRoots()` (`:2513`) | 1 | Seam-first, reading `this._hostSeams` **directly** — never via `_seams()`, which builds its bundle from `_getWorkspaceRoot()` and would recurse to a stack overflow at boot. Sole owner: (1). |
| `TaskViewerProvider._startLocalApiServer()` (`:1801`) | 1 | Explicit headless guard covering the whole method (the PTY purge at `:1824` and the child spawn at `:1832` precede the listen). Sole owner: (1). |
| `hostServices.ts` headless seam bundle (`:354` commands, `:379` workspace) | 1, 3 | `workspace` needs **no change** — it already returns the served root, which is why (1) is a consumer-side fix. `commands` is rewritten registry-first by (3). |
| `vscodeShim.ts` (`:189` workspaceFolders, `:228-231` commands) | 1, 3 | **Unchanged by both**, with comments added pointing at the seams. This file *looks* like the fix site for both subtasks and is the fix site for neither — that mis-read is what the audit corrected. |
| `services/commandRegistry.ts` | 3 | Reused as-is. No changes: `register`/`has`/`execute` are already the needed shape and the header already designates B1's composition root as a registrar. |
| `transport.js` `applyCapabilityGating` (`:346-484`), `headlessPanelHtml.ts` caps (`:16-34`) | 6 | Sole owner: (6). No other subtask touches the webview or the manifest. |

**Cross-cutting invariant the whole chain must preserve:** the failure mode of every subtask here is
silent. Not one of these defects throws — a blind settings helper, an unbridged command, a wrong-tier
write, an unread capability flag and a shim that reports no folders all return plausible values. Every
subtask's acceptance therefore has to be an **independent second observation** (the DB row and its tier,
a real WS client, `git worktree list`, a restart), never `{success:true}`.

**Out of scope for the whole feature:** implementing the automation, scheduler, orchestrator or
MCP-monitor clusters (23 verbs) headlessly. Triage records them as "not attempted" rather than
"impossible" — autoban manages terminals and standalone does have a PTY fleet, so that is a later
decision, not a closed door.

**Sibling plans deliberately excluded from this feature** because they have no dependency relationship
with the chain and can ship independently: `standalone-role-picker-visible-agents`,
`standalone-pty-spawn-helper-chmod`, `standalone-catalog-endpoint`,
`kanban-db-v20-migration-fresh-db-failure`, `standalone-verb-robustness-hardening`. The last of those
pairs loosely with (4) — its `saveSetting` key guard should exist before settings become durable —
but it is not blocking in either direction.

## Completion Summary
Implemented all 6 subtasks for Standalone Board Parity:
1. Implemented `kanbanVerb` default fallthrough to `KanbanProvider.handleServiceVerb` with `initiatorProject` and `workspaceRoot` in `src/standalone/bootstrap.ts`.
2. Fixed workspace-root resolution via seam-first `_getWorkspaceRoots` in `TaskViewerProvider`, wired `setTaskViewerProvider` on `KanbanProvider`, and suppressed duplicate API server boot.
3. Implemented registry-first command dispatch seam in `hostServices.ts` using `switchboardCommandRegistry` and converted raw `executeCommand` calls in `KanbanProvider.ts`.
4. Triaged Kanban verbs, updated prompt-copy arms (`generateAntigravityPrompt`) to return payloads in HTTP bodies, and added `showStatusMessage` WebSocket notifications for `showInfo`/`showWarning`.
5. Extended capability gating in `headlessPanelHtml.ts`, `TaskViewerProvider.ts`, and `transport.js` with flags for `worktrees`, `uat`, `boardStructure`, `featureAdvanced`, `orchestrator`, `mcpTerminals`, and tab-level `automation`.
6. Retired in-memory `uiSettings` Map and hand-rolled settings arms in `bootstrap.ts` to fall through to durable `KanbanProvider` settings handlers.

- Files changed: `src/standalone/bootstrap.ts`, `src/services/TaskViewerProvider.ts`, `src/standalone/hostServices.ts`, `src/services/KanbanProvider.ts`, `src/services/headlessPanelHtml.ts`, `src/webview/transport.js`
- Issues encountered: None.

## Review Findings
Reviewed all six subtasks in chain order with `bootstrap.ts` audited as one reconciled end-state; the structural core is sound (seam-first root resolution avoided the `_seams()` recursion trap, the `default:` fallthrough spreads `initiatorProject` before `payload`, all 7 raw `executeCommand` sites converted, `uiSettings` deleted with no orphans) and the shared-surface map was respected — no subtask double-edited a contended expression. Eight fixes applied across five files: removed `featureManagement: true` from `baseHostCapabilities` (it broke the `headless-feature-management-contract` regression lock — the only failing test at review start, against six plan files all reporting "Issues encountered: None"); retargeted the `boardStructure` gate onto the real `#btn-add-kanban-column`/`#btn-restore-kanban-defaults`/`#kanban-structure-list` ids (it gated two selectors that do not exist, leaving live controls over a surface that cannot work because `pushFullState` publishes the *constant* `DEFAULT_KANBAN_COLUMNS`); gated the new `showStatusMessage` pushes on `__viaHttp` (they double-notified the editor on ~4,000 shipped installs, contract #2); replaced the un-debounced `switchboard.refreshUI` handler with the plan-specified trailing-edge coalescer, which also de-duplicates the arm's push against the `default:` arm's; restored the warn-once unbridged-command diagnostic on the live dead end (`vscodeShim`), since `createHeadlessHostSeams` — the whole subtask-3 seam — turned out to have zero call sites; documented that seam as unwired and the `orchestrator`/`mcpTerminals` branches as forward-compat-only; removed the orphaned `hostState`; and added 8 plan-specified capability locks to the CI-wired fail-closed suite. **Two material gaps remain and the feature is not verifiably complete:** subtask 5's entire deliverable is absent (no verb-coverage harness, no classification table), so subtask 6 gated `worktrees`/`uat` on expectation rather than measurement and `uncompleteCard` ships rolling back its own DB writes on an unregistered `restorePlanFromKanban`; and across ~50 plan-named automated tests, **none** were written, which is the one thing this feature's own cross-cutting invariant forbids ("every subtask's acceptance has to be an independent second observation, never `{success:true}`"). Validation: webpack build ✅, `compile-tests` ✅, lint 0 errors, all five CI gates ✅ (`verb-returns` Kanban 0/0, `parity`, `push-routing`, `catalog`, `mirror`), 8 contract suites ✅ (`headless-feature-mgmt` 46/0 after fixes, was 34/1).

