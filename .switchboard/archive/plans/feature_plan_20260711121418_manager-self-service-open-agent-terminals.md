---
description: "When no agent terminals are live, the manager should offer to open the saved agent grid itself via POST /taskViewer/verb/createAgentGrid (with a selectWorkspace pre-step when the board's selection differs from $ROOT) instead of telling the user to go click in the IDE. Adds selectedWorkspaceRoot to /health so the manager can make that comparison."
---

# Manager Self-Service: Open Agent Terminals via the API Instead of Sending the User to the IDE

## Goal

When the manage-skill entry check (or a dispatch pre-flight) finds no live agent terminals,
the manager currently tells the user to go into the IDE and open them ("open your agent
terminal(s) — AGENT SETUP tab / saved grid"). The endpoint to do this already exists and is
allowlisted — the manager should **offer to do it itself**: one confirmation, then
`POST /taskViewer/verb/createAgentGrid`, then proceed with the original action.

### Problem / root cause

The plumbing is complete; only the prose is missing. Verified chain (2026-07-11):

- `createAgentGrid` is in `TASKVIEWER_VERBS` (`src/generated/verbAllowlist.ts:13`), routed at
  `LocalApiServer.ts:2547` (`POST /taskViewer/verb/<name>` — note camelCase path) through the
  `taskViewerVerb` callback (`TaskViewerProvider.ts:1444`) into the same webview arm the IDE's
  OPEN AGENT TERMINALS button uses (`TaskViewerProvider.ts:10946`), which executes
  `switchboard.createAgentGrid` (`extension.ts:2662`) — the full saved grid: visible agents,
  custom agents, planner count, startup commands, worktree grid terminals.
- **Registration is synchronous**: each terminal is added to `registeredTerminals`
  immediately after `createTerminal` (`extension.ts:~2880`), inside the awaited command — so
  when the verb returns `{success:true}`, the dispatch pre-flight
  (`getRegisteredTerminals()`) already passes. **No polling loop** (normal kanban operations
  never poll `/health`; CLI boot-up inside the terminal is handled by the existing send
  machinery — send locks, robust send, clear-before-prompt delay).

Two pieces of guidance actively steer the agent away from this path:
1. The manage skill's setup-gap nudge (§1 step 4): "open your agent terminal(s) (AGENT SETUP
   tab / saved grid) to re-register them" — user-facing instructions only.
2. The dispatch pre-flight 409 message (`LocalApiServer.ts:635`): same manual instruction.

One real gap in the plumbing: `createAgentGrid` opens the grid for the **board's currently
selected workspace** (`kanbanProvider.getCurrentWorkspaceRoot()`), not the caller's `$ROOT`,
and `/health` (`LocalApiServer.ts:2482-2493`) exposes `roots` but not which one is selected —
so the manager cannot currently tell whether a pre-switch is needed. The board switch itself
is already a rail verb: `POST /kanban/verb/selectWorkspace` (`KanbanProvider.ts:6791` — the
exact dropdown arm: sets root, project filter, repo-scope, re-arms watchers).

## Metadata
- **Tags:** feature, api, ux
- **Complexity:** 3
- **Feature:** 66ca830c-43b2-4406-974f-334b750c2208

## User Review Required

- `selectWorkspace` fired by the manager visibly switches the human's kanban view (shared
  board state). The plan gates it behind a genuine root mismatch + user confirmation — flag
  here so the reviewer explicitly accepts that a chat "yes" can move the IDE's board dropdown.

## Scope

### ✅ IN SCOPE
1. **`/health` gains `selectedWorkspaceRoot`** — new optional options callback
   (`getSelectedWorkspaceRoot`) wired in TaskViewerProvider's LocalApiServer options
   (alongside `getRegisteredTerminals`, `TaskViewerProvider.ts:1271`) returning
   `this._kanbanProvider?.getCurrentWorkspaceRoot() ?? null`; health handler includes it with
   the same never-fail guard as `terminals`. Additive response field — non-breaking.
2. **Dispatch 409 message** (`LocalApiServer.ts:635`): append the self-service hint so any
   API consumer learns the recovery path from the error itself.
3. **Manage skill §1 step 4 nudge rewrite (both copies)** — the "no live terminal but
   plans/constitution exist" nudge becomes an offer: *"⚠ No agent terminal is live — want me
   to open your saved agent grid? (Or open them in the IDE yourself.)"* Offer is a question;
   act only on an answer (terminals opening in the user's window is a visible UI action).
4. **New compact reference block in the skill** — "Opening agent terminals yourself":
   - Compare `health.selectedWorkspaceRoot` to `$ROOT`. If different, first
     `POST /kanban/verb/selectWorkspace` with `{"workspaceRoot": "$ROOT"}` (pass `"project"`
     too if a filter should survive — the verb otherwise resets the filter to unassigned).
     Never fire it when the roots already match (same-root re-selection still resets the
     project filter). If `selectedWorkspaceRoot` is absent (older extension), say so and fall
     back to the manual nudge.
   - `POST /taskViewer/verb/createAgentGrid` (empty body; workspaceRoot is injected but the
     grid follows the board selection — hence the pre-step).
   - On `{success:true}`: registration is synchronous — proceed directly. Do ONE confirming
     `GET /health` read to report the now-live terminal list and to catch the edge where the
     grid opened nothing (e.g. suppress-main with no grid worktrees returns success with a
     warning toast the API caller never sees). This is a confirmation read, not a wait loop.
   - Note that `selectWorkspace` mutates shared board state — the human's kanban view follows.

### ⚙️ OUT OF SCOPE
- Auto-opening terminals without asking (entry) — the offer/confirm shape is mandatory.
- Making the `createAgentGrid` arm honor a per-request `workspaceRoot` (board-selection
  semantics are what the IDE button has; the selectWorkspace pre-step covers the mismatch
  without forking the command's behavior).
- §6/§6a oversight passes: a mid-pass no-terminal 409 stays a halt condition (unattended
  passes must not silently open UI terminals).
- Guided Setup (§5) — unchanged; the offer targets users who have a saved grid already.
- MCP surface / Claude Desktop parity — the MCP server proxies the same endpoints; no change.

## Complexity Audit
### Routine
- One additive `/health` field + options callback (mirrors the existing `terminals` pattern).
- One error-message string edit; skill prose in both copies.
### Complex / Risky
- **Offer-gate phrasing:** must not license eager action — the manager asks once, acts on the
  answer, and never fires `selectWorkspace` reflexively (shared-state mutation + project-filter
  reset side effect). Phrase the "only when roots differ" condition as absolute.
- **Honest success reporting:** `createAgentGrid` returns `{success:true}` even when it opens
  nothing (suppress-main edge, all agents unticked). The single confirming `/health` read is
  the honesty check — if `terminalCount` is still 0, report that and stop; do not loop.

## Edge-Case & Dependency Audit
- **User declines the offer** → current manual-nudge behavior, verbatim fallback.
- **Older extension build** (no `selectedWorkspaceRoot` in `/health`) → skill says
  "can't verify the board's selected workspace" and falls back to the manual nudge rather
  than firing `selectWorkspace` blind.
- **Suppress-main on, no grid worktrees** → verb succeeds, nothing opens; caught by the
  confirming `/health` read (`terminalCount` still 0) → honest report, no dispatch attempt.
- **All agents unticked in visibleAgents** → same detection path as above.
- **Multi-root**: `selectWorkspace` changes what the human sees — acceptable and intended
  (it is the same action the user would take), but only fired on a genuine mismatch.
- **Race with a human clicking the dropdown mid-sequence** → last write wins, same as two
  humans; the confirming read reports the terminals that actually registered.
- **Dependencies:** none on other plans. No new verbs → `catalog:check`/`parity:check`
  unchanged. `mirror:check` gates the skill copies. The `switchboard-orchestration` skill
  documents the `/health` response shape — update its response example to include
  `selectedWorkspaceRoot` (doc-only touch, both copies).
- **Synchronous-registration claim (verified 2026-07-11, improve-feature pass):** inside
  `createAgentGrid` (`extension.ts:2662`), `vscode.window.createTerminal(gridTermOpts)`
  (rel. `extension.ts:~2880`) is followed by `registeredTerminals.set(suffixedName(agent.name),
  terminal)` (`:~2895`) within the same awaited command — the verb's `{success:true}` really
  does imply the dispatch pre-flight (`getRegisteredTerminals()`) will pass. Note the shell
  *inside* the terminal (CLI agent boot) is still async — covered, as the plan states, by the
  existing send machinery (send locks, clear-before-prompt delay), not by this plan.
- **Options-interface line drift:** `getRegisteredTerminals` sits at `LocalApiServer.ts:143`
  (not `:134` as first noted) — place `getSelectedWorkspaceRoot` beside it.

## Dependencies

- None — no `sess_` dependencies; self-contained within this feature.

## Adversarial Synthesis

Key risks: (1) `selectWorkspace` mutates shared board state and resets the project filter —
mitigated by firing it only on a genuine root mismatch, passing `project` through, and never
on same-root re-selection; (2) `createAgentGrid` returns `{success:true}` even when nothing
opens (suppress-main / all-agents-unticked) — mitigated by exactly one confirming `GET
/health` read and an honest "0 terminals" report, never a poll loop; (3) older extension
builds lack `selectedWorkspaceRoot` — skill falls back to the manual nudge instead of firing
`selectWorkspace` blind.

## Proposed Changes
### src/services/LocalApiServer.ts
```ts
// options interface (near getRegisteredTerminals, :134)
getSelectedWorkspaceRoot?: () => string | null;

// /health handler (:2482)
let selectedWorkspaceRoot: string | null | undefined;
try { selectedWorkspaceRoot = this._options.getSelectedWorkspaceRoot?.(); } catch { /* never fail */ }
res.end(JSON.stringify({
    status: 'ok',
    port: this._port,
    roots: this._allRoots,
    ...(terminals !== undefined ? { terminals, terminalCount: terminals.length } : {}),
    ...(selectedWorkspaceRoot !== undefined ? { selectedWorkspaceRoot } : {})
}));

// dispatch pre-flight 409 (:635) — append:
// '…run Guided setup only if you have never configured one. API callers can open the saved
// grid themselves: POST /taskViewer/verb/createAgentGrid (check /health.selectedWorkspaceRoot
// matches your root first; POST /kanban/verb/selectWorkspace if not).'
```
### src/services/TaskViewerProvider.ts
```ts
// LocalApiServer options (near :1271)
getSelectedWorkspaceRoot: () => this._kanbanProvider?.getCurrentWorkspaceRoot() ?? null,
```
### .agents/skills/switchboard-manage/SKILL.md (+ .claude copy)
- §1 step 4: nudge line becomes the offer (Scope #3 wording).
- New reference block "Opening agent terminals yourself" (Scope #4 sequence, incl. the
  no-polling rule and the one-confirming-read rule).
### .agents/skills/switchboard-orchestration/SKILL.md (+ .claude copy)
- `/health` response example gains `selectedWorkspaceRoot`.

## Verification Plan
### Automated
- `npm run catalog:check`, `parity:check` unchanged (no verb changes); `mirror:check` green
  after skill-copy sync.
### Manual / behavioral
- With zero terminals open: `GET /health` shows `terminalCount: 0` and the correct
  `selectedWorkspaceRoot`; invoke the manage skill → entry nudge is the offer, nothing opens
  until the user says yes.
- Accept the offer (roots matching) → no `selectWorkspace` call fires; grid opens; the
  confirming `/health` shows the registered terminals; a follow-up `POST /kanban/dispatch`
  succeeds with no manual IDE interaction.
- Mismatch case: board dropdown on workspace B, `$ROOT` = A → manager fires `selectWorkspace`
  for A first (visible board switch), then the grid opens under A.
- Suppress-main edge: enable suppress-main with no grid worktrees, accept the offer → manager
  reports "grid opened nothing (0 terminals)" and does not dispatch.
- `curl POST /kanban/dispatch` with zero terminals → 409 body contains the createAgentGrid
  hint.

---
**Recommendation:** Complexity 3 → Send to Intern.

## Review Findings

Direct reviewer pass (2026-07-11). `getSelectedWorkspaceRoot` added to the `LocalApiServer` options interface and wired in `TaskViewerProvider.ts` (`() => this._kanbanProvider?.getCurrentWorkspaceRoot() ?? null`); `/health` surfaces it with the same never-fail `try/catch … ?? null` guard as `terminals` and conditionally spreads it so headless harnesses omit the field (older-extension fallback intact); the dispatch 409 body now teaches the `createAgentGrid` recovery path; the orchestration skill `/health` example + endpoint table updated in both copies. Both referenced verbs confirmed present in the allowlist (`selectWorkspace`∈KANBAN_VERBS, `createAgentGrid`∈TASKVIEWER_VERBS). No CRITICAL/MAJOR findings, so no code fixes applied. NIT (deferred): `$ROOT`-vs-`selectedWorkspaceRoot` is an exact string compare in skill prose, so a trailing-slash/normalization mismatch could fire a spurious `selectWorkspace` — bounded by the plan's already-accepted shared-state risk and the `project` pass-through. Files changed: `src/services/LocalApiServer.ts`, `src/services/TaskViewerProvider.ts`, both skill copies. Validation: `catalog:check` ✅ / `parity:check` ✅ (no new verbs); mirror bodies in sync.
