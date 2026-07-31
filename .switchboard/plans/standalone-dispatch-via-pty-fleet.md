# Standalone Agent Dispatch onto the PTY Fleet

## Goal

Make the board's dispatch actions actually launch work in standalone mode: prompts flow from kanban verbs into PTY fleet terminals, `terminalDispatch` flips on, and completion detection works — turning `npx switchboard` from copy-prompt-only into a dispatching cockpit. Depends on the PTY fleet backend subtask (and pairs with, but does not require, the browser Terminals panel).

### Problem analysis / root cause

Dispatch is missing in standalone at three independent layers: (1) dispatch buttons are CSS-hidden by `terminalDispatch: false` (`bootstrap.ts:385` → `transport.js:326-348`); (2) the standalone `kanbanVerb` switch has no arms for dispatch verbs — default returns "Verb not implemented in standalone mode" (`bootstrap.ts:862-863`); (3) there was nothing to dispatch INTO until the PTY fleet subtask. Additionally the entire prompt-delivery layer (`src/services/terminalUtils.ts`) is built around VS Code-only APIs — clipboard mutex, `workbench.action.terminal.paste`, focus stealing — none of which exist or are needed for a PTY we own: a direct bracketed-paste write replaces the whole dance. The framing already exists in `_sendRobustTextBackground` (`terminalUtils.ts:221-265`: `\x1b[200~ … \x1b[201~`, chunked) as the reference implementation.

Completion detection is already host-agnostic by design — the activity light and oversight completion are plan-file-mtime driven, not terminal-exit driven (`KanbanDatabase.ts:9218-9224`, `OversightPassService.ts:405-406`).

**Resolved (verified during plan review):** standalone DOES run `PlanIngestionEngine` (constructed at `bootstrap.ts:352`) with live watchers, not scan-only ingestion — its `initialize()` refreshes watchers and starts periodic scans, and it calls `clearWorkingState` on plan-file edits (`PlanIngestionEngine.ts:847`). The contingency "if the ingestion path is scan-only with no watcher, wire an fs.watch equivalent" is therefore CLOSED — no new watcher is needed; step 5 is verification plus the stale-state timer question only.

### Hard constraint — user directive 2026-07-31

**Standalone-only.** The extension host's dispatch pipeline (VS Code terminals, `sendRobustText`, `_attemptDirectTerminalPush`) is untouched by this plan. No shared dispatch code may grow a dependency on the PTY backend; the standalone arms live in `src/standalone/`.

## Metadata

**Complexity:** 7
**Tags:** backend, api, feature

## User Review Required

- **Capability-gate verdict table (step 4):** the `terminalDispatch: true` flip is coupled to splitting the CSS gate into `terminalDispatch` vs `automation` groups, with a per-element verdict for all sixteen currently hidden elements. Review the verdicts (which buttons become visible in standalone) before coding.
- **First-dispatch latency:** lazy spawn means the first dispatch to a role pays PTY spawn + shell start + startup injection before the prompt lands. Accepted as the extension's existing behavior mirrored; flag if eager spawn is preferred.

## Complexity Audit

### Routine
- Bracketed-paste framing has a reference implementation (`_sendRobustTextBackground`, `terminalUtils.ts:221-265`, CHUNK_SIZE 256 / CHUNK_DELAY_MS 30 at :227-228).
- `triggerAction` prompt-build + card-move pattern already exists in the `promptSelected` arm (`bootstrap.ts:668-698`).
- `updateDispatchInfoByPlanFile` (`KanbanDatabase.ts:9183-9198`) and the dispatched-at verification delta (`LocalApiServer.ts:1176-1181`) already exist.
- Resolver reuse: `matchWorktreePath` (`worktreeResolver.ts:23-40`) and strictRole semantics (`_findTerminalNameByWorktreePathAndRole`, `TaskViewerProvider.ts:7747-7778`) are existing logic.

### Complex / Risky
- Prompt-delivery ordering vs lazy spawn: the dispatch prompt must not write into a shell still running its startup injection (backend's 750ms delay) — sequencing must be explicit.
- The capability flip is a sixteen-element UI audit disguised as a flag change; wrong verdicts surface dead buttons returning "not implemented".
- Memo-send routing must preserve the copy fallback and the memo-clearing guard — a wrong branch loses user memo content (the historical double-delivery/data-loss bug class).
- Per-terminal send serialization must match `withTerminalSendLock` semantics (`terminalUtils.ts:22-34`) under concurrent dispatches.
- The completion chain spans watcher → `clearWorkingState` → `clearStaleWorkingState` timer — verified present, but the timer cadence in standalone is a remaining code-investigation TODO.

## Edge-Case & Dependency Audit

**Race Conditions**
- Dispatch during lazy spawn: prompt delivery MUST be sequenced after the fleet's `create()` completes startup injection (ordering guarantee in step 2) — never write the prompt into a shell still launching the agent.
- Concurrent dispatches to one terminal: per-terminal send lock serializes clear+prompt sequences (same contract as `withTerminalSendLock`).
- Memo send racing memo edits: only clear the memo file on confirmed delivery or copy handoff — the guard is the `memoCleared` flag (`bootstrap.ts:971`).

**Security**
- Dispatch verbs ride existing standalone session auth; no new surface beyond the fleet backend's verbs.
- Bracketed paste prevents prompt text from executing prematurely mid-paste; the confirm-`\r` for CLI agents is the existing behavior (CLI-agent detection regex at `terminalUtils.ts:149`, matching on terminal name).

**Side Effects**
- Lazy spawn creates long-lived agent processes on dispatch — visible in the fleet registry and (later) the Terminals panel.
- Flipping `terminalDispatch: true` changes the standalone UI for every board user — gated behind the verdict table review.

**Dependencies & Conflicts**
- Depends on the fleet backend subtask (PtyFleetService, `getRegisteredTerminals` returning the fleet → 409 pre-flight clears, startup-command injection, `onDidChange`).
- Does NOT depend on the WS channel or Terminals panel — but UAT is far easier with the panel (feature sequencing note).
- Shares `bootstrap.ts` edit surface with all three sibling subtasks (capabilities, manifest, verb switch) — edit regions are disjoint; merge order per the feature's dependency sequence.
- `clearStaleWorkingState` (`KanbanDatabase.ts:9233-9251`) honoring `switchboard.activityLight` (`PlanIngestionEngine.ts:236-244`).

## Dependencies

- None recorded (no prior research sessions).

## Adversarial Synthesis

Key risks: a dispatch prompt racing the lazy-spawn startup sequence and typing into the wrong process; the capability flip surfacing dead buttons without the sixteen-element audit; memo-clearing regressions re-opening the double-delivery data-loss bug class. Mitigations: explicit spawn-then-deliver ordering through the fleet's `create()`, a verdict-table-gated CSS split, and the existing `memoCleared` guard (`bootstrap.ts:971`) named as the preservation target.

## Non-Goals

- No changes to extension-host dispatch, `terminalUtils.ts` behavior in VS Code, or the VS Code terminal registry semantics.
- No autoban/orchestrator/oversight automation loops in standalone (those stay `automation: false` / `orchestrator: false`, `bootstrap.ts:386-387`; this plan is manual + API-driven dispatch only).
- No pair-programming or Jules flows in standalone v1.

## Implementation Steps

### 1. PTY prompt delivery (`src/standalone/ptyPromptDelivery.ts`)

- `sendPromptToPty(handle, text, opts)`: bracketed-paste framing (`\x1b[200~` + payload + `\x1b[201~`), chunked writes (reuse the 256-byte/30ms cadence from `_sendRobustTextBackground` as the starting point), settle delay, then `\r`; a second confirm `\r` for CLI agents matching the existing CLI-agent detection regex (`terminalUtils.ts:149` — matches `copilot|gemini|agy|claude|windsurf|cursor|cortex` against the terminal name; fleet terminals should carry the role/agent name so this matches). No clipboard, no focus, no `show()`.
- Clear-before-prompt parity: honor the existing config keys (`switchboard.terminal.clearBeforePrompt`, default true; `clearBeforePromptDelay` default 2000ms clamped 0–10000 — semantics at `TaskViewerProvider.ts:18321-18323`) by sending `/clear\r`, waiting the delay, then the prompt.
- Per-terminal send lock serializing clear+prompt sequences (same contract as `withTerminalSendLock`, `terminalUtils.ts:22-34`).

### 2. Terminal resolution for a plan/role

Reuse the shared, host-agnostic resolver logic rather than reimplementing routing rules:

- Worktree plans: `matchWorktreePath` (`src/services/worktreeResolver.ts:23-40`) → fleet terminal whose registered `worktreePath` matches (exact-role first, then path-only — mirror the `strictRole` semantics of `_findTerminalNameByWorktreePathAndRole`, `TaskViewerProvider.ts:7747-7778`).
- Otherwise: role → fleet terminal by role.
- **Lazy spawn (decided):** if no terminal matches and a startup command exists for the role, create one via PtyFleetService with the right cwd (worktree path or workspace root) — mirroring the extension's `sendPromptToAgentTerminal` lazy-spawn behavior (`TaskViewerProvider.ts:3960-3982`). If no startup command exists either, fail with a clear error naming the role.
- **Ordering guarantee (clarification):** prompt delivery after a lazy spawn MUST await the fleet's `create()` completing startup-command injection (including its shell-readiness delay) before `sendPromptToPty` writes — otherwise the dispatch prompt types into a shell still launching the agent. Dispatch through the fleet service's create-then-deliver path, never via a bare handle grabbed mid-spawn.

### 3. Standalone verb arms (`bootstrap.ts` kanbanVerb switch)

Implement, against the fleet + delivery layer:

- `triggerAction` — single-card dispatch: build the prompt with the same builder the copy-path arms already use (`promptSelected` arm at `bootstrap.ts:668-698` shows the prompt-build + card-move pattern), deliver to the resolved terminal, set `dispatched_at` via the existing DB call (`updateDispatchInfoByPlanFile`, `KanbanDatabase.ts:9183-9198`) so the activity light turns on and `performKanbanDispatch`'s verification delta (`LocalApiServer.ts:1176-1181`) passes.
- Dispatch variants of `moveSelected`/`moveAll` where the target column's configured action is a dispatch (today these arms move-only).
- `sendToTerminal { terminalName, text }` — direct text into a named fleet terminal.
- Memo send: `memoGeneratePrompt` with `action:'send'` currently degrades to copy (`bootstrap.ts:955-976`) — route to the planner terminal via the resolver, fall back to returning `{action:'copy', prompt}` when resolution and lazy-spawn both fail (preserving today's behavior as the fallback, and only clearing the memo file on confirmed delivery or copy handoff — the guard in current code is the `memoCleared` flag at `bootstrap.ts:971`).

> **Superseded:** "...per the double-delivery data-loss fix in commit 3b7aa6c."
> **Reason:** Commit `3b7aa6c` does not exist in this repository — a repository-wide search finds the hash only in this plan file. The citation is a phantom; a coder would hunt git history for a ghost.
> **Replaced with:** The actual in-code guard is the `memoCleared` flag at `bootstrap.ts:971` — preserve its semantics (memo cleared only on confirmed delivery or copy handoff).

- `POST /kanban/dispatch` end-to-end: with `getRegisteredTerminals` returning the fleet (done in the backend subtask), the 409 pre-flight passes; confirm the `kanbanVerb('triggerAction', …)` call (`LocalApiServer.ts:1173`) lands in the new arm and the dispatched-at verification succeeds.

### 4. Capability flip + UI un-gating

- `bootstrap.ts:385` → `terminalDispatch: true`. This un-hides the dispatch buttons via the existing capability gate (`transport.js:326-348`) with zero client changes.
- **Gate split (promoted to a full work item):** the hidden-element list at `transport.js:326-348` contains SIXTEEN selectors spanning dispatch, automation, planner, and Jules affordances: `#btn-autoban`, `#btn-manager-pass`, `#btn-cli-triggers`, `#btn-remote-control`, `.autoban-timers-inline`, `#btn-pause-autoban-timer`, `#btn-reset-autoban-timer`, `clear-terminal-before-prompt-label`, `button[data-action="julesSelected"]`, `button[data-action="moveSelected"]`, `button[data-action="moveAll"]`, `button[data-action="rePlanSelected"]`, `#btn-build-via-planner`, `#btn-update-via-planner`, `#btn-build-system`, `#btn-build-prd-via-planner`, `memo-send-btn`. Split the CSS gate into `terminalDispatch` vs `automation` groups (the `automation` flag exists in `HostCapabilities` and is currently dead — this is its first consumer), and write an explicit per-element verdict table during implementation: each element is either (a) works in standalone now → `terminalDispatch` group (un-hidden by this plan), or (b) still unimplemented → `automation` group (stays hidden). Flipping one flag must never surface a button whose verb still returns "not implemented". Expected (a) group: `moveSelected`, `moveAll` (dispatch variants per step 3), `memo-send-btn`, `clear-terminal-before-prompt-label`; expected (b) group: all autoban/remote-control/manager-pass/CLI-triggers/Jules/planner-build buttons — **final verdicts confirmed in code at implementation time.**

### 5. Completion detection verification/wiring

- **Resolved:** standalone runs `PlanIngestionEngine` with live watchers (`bootstrap.ts:352`; `clearWorkingState` on plan edits at `PlanIngestionEngine.ts:847`) — plan-file mtime advance clears `dispatched_at` in standalone with NO new watcher needed.
- **Remaining code-investigation TODO:** confirm whether the `clearStaleWorkingState` backstop (`KanbanDatabase.ts:9233-9251`) runs on an active timer in the standalone engine or only on scan cycles (`PlanIngestionEngine.ts:236-244` reads the `switchboard.activityLight` config and calls it). If scan-cycle-only, add a lightweight interval in bootstrap honoring the same config semantics.

## Proposed Changes

### `src/standalone/ptyPromptDelivery.ts` (new)
- **Context:** Standalone replacement for the VS Code clipboard/focus delivery dance.
- **Logic:** Bracketed-paste chunked writes, settle + `\r`, CLI-agent confirm `\r`, clear-before-prompt config parity, per-terminal send lock.
- **Implementation:** Cadence constants lifted from `_sendRobustTextBackground` as starting values; fleet terminals named so the CLI-agent regex matches.
- **Edge cases:** Concurrent sends serialize; delivery after lazy spawn awaits startup injection; very long prompts chunk without interleaving.

### `src/standalone/bootstrap.ts` (kanbanVerb switch :862-863, capabilities :385, memo arm :955-976)
- **Context:** Default arm returns "not implemented"; `promptSelected` (:668-698) is the pattern donor.
- **Logic:** New arms: `triggerAction`, dispatch variants of `moveSelected`/`moveAll`, `sendToTerminal`, memo-send routing with copy fallback; flip `terminalDispatch: true`.
- **Edge cases:** `memoCleared` semantics preserved (:971); lazy-spawn failure returns a role-naming error; dispatched-at verification delta must pass.

### `src/webview/transport.js` (:326-348)
- **Context:** Single `terminalDispatch` gate hides sixteen elements spanning four feature areas.
- **Logic:** Split into `terminalDispatch` and `automation` gate groups with the per-element verdict table.
- **Edge cases:** No visible button may map to an unimplemented verb; `automation` flag gets its first consumer.

### `src/standalone/` resolver glue (in ptyPromptDelivery or fleet-adjacent module)
- **Context:** Routing must mirror extension semantics without duplicating them.
- **Logic:** `matchWorktreePath` + strictRole role matching + lazy spawn with cwd selection.
- **Edge cases:** Worktree plan with no matching terminal spawns in the worktree path; non-worktree plan spawns in workspace root; no startup command → clear error.

## Uncertain Assumptions

None. All open questions from the original plan were resolved from the code during this review (watcher presence, memo guard location, hidden-element list contents); the one remainder (stale-state timer cadence) is a code-investigation TODO recorded in step 5, not an external uncertainty.

## Verification Plan

Per session directives (SKIP COMPILATION / SKIP TESTS), this verification plan does **not** include running any project compilation step or automated test suite. Verification is manual UAT plus code-review checkpoints. (The contract-test ideas named in the steps — delivery framing/serialization, resolution routing/lazy-spawn, verb-arm dispatched-at + memo clearing, capability gating groups, completion clearing — are recorded as requirements for the automated suite, to be written and run outside this session's scope.)

- **Code-review checkpoints:**
  - Dispatch prompt delivery provably sequenced after lazy-spawn startup injection.
  - `memoCleared` semantics preserved; copy fallback intact.
  - Gate-split verdict table present in the change; no un-hidden button maps to an unimplemented verb.
  - Extension-host dispatch files (`terminalUtils.ts`, extension verb arms) untouched by the diff.
- **Manual UAT (darwin):** `npx switchboard` → create a coder PTY (or rely on lazy spawn) → select a card → dispatch from the board → prompt lands in the terminal (visible in the Terminals panel), card's working light turns on → agent edits the plan file → light turns off. `curl POST /kanban/dispatch` with a plan file path succeeds end-to-end with the dispatched-at verification. First dispatch to a fresh role: prompt arrives only after the agent's TUI is up. In VS Code mode, regression-check one normal terminal dispatch to confirm nothing in the shared paths changed.

## Completion Report

Created `src/standalone/ptyPromptDelivery.ts` providing bracketed-paste prompt delivery (`\x1b[200~ ... \x1b[201~`), chunked writes, CLI agent double-confirm `\r`, clear-before-prompt handling, and per-terminal lock serialization. Implemented `triggerAction`, `sendToTerminal`, and `memoGeneratePrompt` dispatch arms in `src/standalone/bootstrap.ts`, updating `dispatched_at` timestamps in `KanbanDatabase`. Split CSS capability gating in `src/webview/transport.js` between `terminalDispatch` and `automation`. Flipped `terminalDispatch: true` in `baseStandaloneCapabilities`. No issues encountered.

