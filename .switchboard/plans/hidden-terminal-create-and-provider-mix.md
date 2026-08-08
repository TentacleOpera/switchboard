# Hidden Terminal Creation with Mixed-Provider Allocation

## Goal

Add an HTTP endpoint that creates agent terminals which do **not** render in the pty/terminals interface, and let a caller request a mix of providers in one batch (e.g. 10 Claude terminals + 10 Devin terminals) via configuration rather than by hand-assembling each one.

### The problem

Nothing in `LocalApiServer.ts` creates a terminal. Every dispatch path targets a *pre-existing, registered* terminal and fails when none is live: `_handleResearchDispatch` returns `404 no researcher agent configured`, and `POST /kanban/dispatch` returns `409` when there is no live terminal agent. The capability exists — `PtyFleetService.create(role, friendlyName, cwd, worktreePath)` (`src/standalone/ptyFleetService.ts:75`) — but only the webview can reach it, so a planner agent cannot spin up workers for a batch.

### Root cause

Terminal creation was built for a human clicking in the UI. Two assumptions are baked in that break for agent-created workers:

1. **Everything created is rendered.** `PtyFleetService.updateRegistryState()` persists the fleet into `runtime.terminals` "so /health, the board and worktree routing all see PTY terminals," and only `purpose:'pty'` rows are rewritten. Twenty workers created this way flood the terminals interface with sessions nobody intends to watch.
2. **One terminal at a time, one role at a time.** There is no notion of "give me N terminals split across these roles."

### Why mixed providers matter

A role already determines the CLI, the auth, and therefore the bill (`GlobalIntegrationConfigService.getAgentStartupCommands()` is a `Record<role, command>`, and roles are user-extensible via `CustomAgentConfig` / `parseCustomAgents`). Splitting a batch across roles spreads the work across independent subscriptions and independent rate limits — which is also why this design needs no concurrency cap: twenty improvers drawn from two or three providers are not contending for one budget, and plan improvement is not token-intensive enough to warrant throttling.

## Metadata

**Complexity:** 5
**Tags:** backend, api, infrastructure, cli, feature

## Reconcile Before Building

Local unpushed work has added a **linkup** feature (terminal-to-terminal messaging) and may already have added terminal-creation or addressing endpoints. **No trace of it exists in this branch**, so before writing any code:

1. `curl -s "$BASE/catalog"`; `grep -rn "linkup" src/`; `grep -n "terminals\|spawn" src/services/LocalApiServer.ts`.
2. If linkup already exposes terminal creation or a terminal identifier scheme, **build on it** — adopt its identifiers and its addressing model rather than minting a parallel one. Two terminal-identity schemes would make the notification wiring in the sibling plan ambiguous about who to message.
3. Record what was found and any resulting deviation in the implementation summary.

## Design

### Endpoint

```
POST /terminals/create
{
  "workspaceRoot": "/repo",
  "cwd": "/repo",
  "hidden": true,
  "allocation": [
    { "role": "improver-claude", "count": 10 },
    { "role": "improver-devin",  "count": 10 }
  ]
}
```

Returns the created terminals so the caller can address them:

```
200 { terminals: [{ name, role, hidden }], created, failed: [{ role, reason }] }
400 { error }   // unknown role, no startup command configured, bad allocation
503 { error }   // host unavailable (headless/test harness)
```

Report partial failure honestly in `failed[]` rather than wrapping it in a blanket success — the convention documented at `LocalApiServer.ts:2102-2114` exists because a hollow `{success:true}` leads agents to announce a hand-off that never happened.

A single `{ role, count: 1 }` allocation is the degenerate case, so this one endpoint covers both "make me a terminal" and "make me a batch."

### Allocation

Allocation is explicit counts per role, not a ratio or a scheduler. The caller says what it wants; the endpoint creates it. Reject an allocation whose roles lack a configured startup command **before creating any terminal** — a batch that half-creates and then fails leaves orphaned sessions the caller did not ask for and may not clean up.

Also expose a workspace-level default allocation setting so the board action and the planner can say "the usual mix" without restating it each time. That setting is the config option that makes "10 Claude + 10 Devin" a one-time decision rather than a per-batch chore.

### Hidden terminals

`hidden: true` must keep the terminal out of the terminals interface while leaving it fully functional and addressable. Two existing mechanisms apply:

1. **Registry `purpose`.** `updateRegistryState` only owns and rewrites `purpose:'pty'` rows and explicitly preserves entries belonging to other writers. Register hidden workers with a distinct `purpose` (e.g. `'batch'`) so the pty UI does not render them, or omit the registry entry entirely. Prefer a distinct `purpose` over omission: the registry is also how the extension finds terminals to address and to clean up, and an unregistered terminal is one nothing can reach or reap.
2. **Role picker suppression.** `GlobalIntegrationConfigService.SYSTEM_ONLY_ROLES` (line 436 — currently `orchestrator`, `mcp_monitor`, `jules_monitor`, `scheduler`) is stripped from the role picker and the OPEN AGENT TERMINALS path precisely because those roles are "launched by automation, not selectable by users." Batch-only improver roles belong in that set.

Audit every consumer of `runtime.terminals` for the new `purpose` value — `/health`, the board, worktree routing, and the terminals webview each read it. A consumer that assumes every row is renderable will surface hidden workers anyway, which is the whole failure this flag exists to prevent.

### Lifecycle

Creation only. Termination is the planner's job (see the improver-prompt-and-planner-lifecycle plan) — but expose `POST /terminals/kill { name }` here alongside creation, since the planner cannot kill what it cannot address, and a create endpoint without a matching kill guarantees orphaned sessions.

Boot reconcile must reap hidden workers left behind by a crashed extension. `PtyFleetService.purgePtyTerminals` (line 273) establishes the precedent — "drop every `purpose:'pty'` registry entry left over from a previous run" — and hidden rows need the same treatment or they accumulate invisibly across restarts, which is strictly worse than visible orphans because nobody will notice them.

## Verification Plan

1. **Unit — allocation.** `[{role:A,count:10},{role:B,count:10}]` creates 20 terminals, 10 per role, each carrying its own role's startup command.
2. **Unit — validation precedes creation.** An allocation containing one role with no configured startup command returns `400` and creates **zero** terminals.
3. **Unit — hidden is not rendered.** Assert hidden terminals are registered with the non-`pty` purpose and that the terminals webview payload excludes them. Assert visible terminals created the normal way are unaffected.
4. **Unit — hidden is still addressable.** Assert a hidden terminal can be looked up by name and killed via `POST /terminals/kill`.
5. **Unit — registry consumers.** For each consumer of `runtime.terminals` (`/health`, board, worktree routing, terminals webview), assert hidden rows are excluded from rendering paths and retained in addressing paths.
6. **Unit — role picker.** Assert batch-only roles added to `SYSTEM_ONLY_ROLES` are absent from the role picker and OPEN AGENT TERMINALS.
7. **Unit — boot reap.** Persist hidden registry rows from a prior run; assert boot reconcile drops them and starts no replacements.
8. **Contract — partial failure.** A mixed allocation where one role fails returns `created` plus a populated `failed[]`; assert no path returns success with a non-empty `failed[]` and no other signal.
9. **Manual (VSIX).** Create a 6-terminal batch split across two provider roles. Confirm: nothing new appears in the terminals sidebar, `/health` does not list them, both providers actually launched (check each session's CLI), and `POST /terminals/kill` removes them.

## Dependencies

None — ships standalone. The notification wiring and planner protocol build on it.
