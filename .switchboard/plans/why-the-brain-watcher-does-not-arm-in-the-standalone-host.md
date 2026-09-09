# Establish when the brain watcher and plan scanner arm in each host, and whether standalone arms them at all

## Goal

Determine, with evidence rather than inference, which of `TaskViewerProvider`'s deferred
initialisation actually runs in the standalone host — the brain watcher, the configured-plan
watcher, and the periodic plan scanner — and wire whatever does not. The immediate trigger is a
measurement that cannot be explained by the code as read; the underlying concern is that a whole
block of initialisation may be reachable only from a VS Code webview that the standalone host
does not have.

### The problem — a 17,196-watch difference with no code change to explain it

On 2026-09-05, two standalone hosts on the same machine and the same workspace:

| | old host (22 h uptime, pre-storage-overhaul build) | new host (fresh, current build) |
|---|---|---|
| inotify descriptors | **17,196** | **3,133** |
| sampled watched paths | `~/.gemini/antigravity-cli/brain/<uuid>/.user_uploaded` | `.switchboard/plans/*.md` only |

The brain watcher was armed in one and not the other. `_setupBrainWatcher`
(`src/services/TaskViewerProvider.ts:15911`) has not been modified since June — `git log -L` over
its opening lines returns nothing newer — so the difference is in **when it is reached**, not in
what it does.

A config change made during the same session (`switchboard.planScanner.presets.antigravity` =
false) was initially credited with the drop. It was not the cause: the count was already 3,133
after the first restart, *before* the setting was written, and `_setupBrainWatcher` contains no
preset check. That config row has since been reverted. This plan exists partly because a
plausible-looking explanation was accepted once already without a controlled measurement.

### What the code says, and the gap it leaves

`_setupBrainWatcher()` is reached by exactly two paths:

1. **`_runDeferredConstructorInit()`** (`:5132`), which also calls `_refreshConfiguredPlanWatcher()`
   and **`startPlanScanner()`**. It is guarded by `_constructorInitDeferred` and has **one**
   caller in the entire tree: inside `resolveWebviewView()` at `:13863` — the VS Code sidebar
   webview resolving. The constructor comment at `:2093` states the intent plainly: "Heavy init
   (ownership registry, brain watcher, file sync) deferred to `_runDeferredConstructorInit()`,
   called from `resolveWebviewView()` or other entry points."
2. **`reinitializeBrainWatcher()`** (`:16192`), whose only caller is
   `reinitializePlanWatcher(workspaceRoot)` (`:8705`), documented as "Called by KanbanProvider
   when the workspace changes via selectWorkspace".

The standalone host has no `resolveWebviewView`. A search of `src/standalone/` for
`_runDeferredConstructorInit` returns nothing. So path 1 is unreachable there, and the brain
watcher can only arm through path 2 — a workspace selection driven from the board UI. The old
host had board panels connected for 22 hours; the new one has had none. That is a coherent
explanation and it is **a hypothesis, not a finding** — it has not been tested.

### The larger question this exposes

`startPlanScanner()` sits in the same deferred block. Its callers are `src/extension.ts:1134`
(the extension's composition root) and three sites inside `TaskViewerProvider`. There is **no
call in `src/standalone/bootstrap.ts`**. If path 1 is genuinely unreachable in standalone and no
other path fires, the periodic plan scanner — the sweep that ingests plans written by Antigravity,
Cursor, Windsurf and Devin — never runs in the standalone host at all. Plans authored in
`.switchboard/plans/` still import, because that is the file *watcher*, not the scanner, which is
why the gap would not be obvious from the board.

This is precisely the composition-root divergence the repository's own rules describe: a seam
wired in one host and not the other, where "never wired" and "working" look identical from
outside. Verb-reachability audits stay green because no verb is involved.

## Proposed changes

This plan's deliverable is an answer plus whatever wiring the answer requires.

1. **Instrument the arming paths.** Log once, at the point of arming, which entry point armed the
   brain watcher, the configured-plan watcher and the plan scanner, with the host name. A watcher
   that never arms must be visible as an absence, not inferred from a descriptor count.
2. **Measure, controlled.** Start a standalone host with no board client, record the descriptor
   count; open the board and select the workspace; record again. Do the same in the extension
   host. This settles the hypothesis rather than assuming it.
3. **Establish what else is in the deferred block.** Enumerate everything
   `_runDeferredConstructorInit()` performs and determine, per item, whether the standalone host
   reaches it by any path. The registry init, the configured-plan watcher and the plan scanner are
   the known members; the audit is the deliverable, not a spot check.
4. **Wire what is missing in `bootstrap.ts`**, at the composition root, next to the other
   `taskViewerProvider.*` wiring already there (`:1249-1251`, `:1319`). Do not add a second
   deferred-init trigger inside the service — the two roots must be diffable by hand.
5. **Record the arming contract** where the next reader will find it: which host arms which
   watcher, by which path, and what a board-less standalone host does and does not do.

**Both hosts.** The point of this plan is the difference between them. Both composition roots
(`src/extension.ts`, `src/standalone/bootstrap.ts`) are diffed by hand for every seam in the
deferred block, in both directions — the extension may also wire something standalone does not,
and standalone may wire something the extension does not.

## Metadata

**Complexity:** 4
**Tags:** backend, reliability, standalone, watchers, parity

## User Review Required

None — the approach is fully specified.

## Verification Plan

1. A standalone host started with no board client logs, explicitly, that the brain watcher, the
   configured-plan watcher and the plan scanner were not armed — or that they were, and by which
   path. Absence is stated, not inferred.
2. Descriptor counts are recorded for four states: standalone before board connect, standalone
   after workspace select, extension before sidebar resolve, extension after. The brain watcher's
   arming path in each host is identified from those four numbers plus the logs.
3. A plan written to `~/.gemini/antigravity-cli/brain/<session>/` is ingested by a standalone host
   that has never had a board client connected. This is the user-visible behaviour the wiring gap
   would break, and it must pass without opening the board.
4. The same check for a Cursor plan and a Devin plan, which travel via the periodic scanner rather
   than the brain watcher.
5. An enumeration of `_runDeferredConstructorInit()`'s members exists, each marked reachable or
   not reachable in standalone, with the path named.
6. A contract test asserts the standalone composition root wires every deferred-block seam the
   extension root wires, failing if a future edit adds one to `extension.ts` alone.
7. Re-run item 2 after the wiring lands and assert standalone's pre-board-connect state now
   matches its post-connect state for these three services.
