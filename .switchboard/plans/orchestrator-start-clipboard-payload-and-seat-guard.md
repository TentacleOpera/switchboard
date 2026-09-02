# The standalone clipboard payload is unusable by the hosts it exists for, and the create-race guard is patched in one client instead of the server

## Goal

Fix two live defects on the Mission Control start path. A user who has no agent CLI configured gets handed a string that only works if their host already has Switchboard's skills registered — the one thing that user almost certainly lacks. And the double-spawn race is guarded server-side in standalone but only client-side in the browser shell, so any other caller of the extension host's endpoint can still produce two agents each told they are the Mission Control.

### Problem Analysis

**Defect 1 — the clipboard payload is not portable.**

`bootstrap.ts:3471` is the only producer of clipboard mode, and its entire payload is:

```js
return { success: true, mode: 'clipboard', prompt: 'Run /switchboard workflow to start Mission Control' };
```

It is reached only after the terminal path is refused — step 2 (`:3429-3430`) reads `startupCommands['lead'] || startupCommands['coder']` and the terminal branch requires `startupCommand && startupCommand.trim() && ptyReady`. So the trigger is **no lead or coder startup command configured, or pty not ready.**

That text names a slash command. It works only in a host where the `/switchboard` skill is already registered — and the user reaching this branch has configured no agent CLI at all, making them the least likely person to have one. Paste it into an IDE chat panel without Switchboard's skills and nothing happens, silently.

The VS Code side already builds the portable version. `_handleDispatchProjectManager` (`TaskViewerProvider:28694`) builds the prompt inline at `:28712` — it names the file to read (`${workspaceRoot}/.agents/workflows/switchboard.md`), pins the root explicitly — *"use it as `$ROOT` directly (this is the board's selected workspace; do not derive the root from your terminal's working directory)"* — and supplies the port. That works in any host that can read a file, skill registered or not. The `$ROOT` warning matters *more* in a chat panel, where there may be no meaningful working directory at all.

> **Superseded:** The plan originally said "reusing the builder the VS Code path already uses rather than a second copy." The VS Code path does not use a shared builder — it constructs the prompt inline at `TaskViewerProvider:28712`. The standalone path already calls `buildMissionControlKickoffPrompt` (`:3417`, `:3447`, `:3463`) for the terminal case, which returns a `{ mode, prompt }` pair where `mode: 'self'` is the clipboard-equivalent delivery mode (`:12177`).
> **Reason:** The inline string in `_handleDispatchProjectManager` and the `buildMissionControlKickoffPrompt` method are two different prompt builders, not one shared one. The correct fix is to call `buildMissionControlKickoffPrompt(root, undefined, 'self', missionId)` in the clipboard fallback and use its `prompt` — or extract the inline string into a shared method. Either way, the clipboard payload becomes a file-reading instruction, not a slash-command reference.
> **Replaced with:** Call `buildMissionControlKickoffPrompt` with `deliveryMode: 'self'` in the clipboard fallback, or extract the portable prompt from `_handleDispatchProjectManager:28712` into a shared builder both hosts call.

The comment at `bootstrap.ts:2459-2461` shows how this survived: it describes the clipboard branch as *"no agent configured, or pty unavailable"* and then says *"The agent that receives it follows the chat-agent launcher flow."* Two different intents collapsed into one sentence — a degraded fallback and the deliberate chat-panel path. The deliberate path is why clipboard delivery exists at all: an IDE user may want Mission Control in a chat panel (Claude Code, Codex, a right-rail agent) that no terminal can reach, and Mission Control is a chatting role, so that is a legitimate host rather than a failure. The degraded path is a different case that happens to reuse the same mode name and inherited the weaker text.

**Defect 2 — the create-race guard lives in the wrong layer.**

The race is real and documented at `bootstrap.ts:3432-3453`: the server never seats Mission Control — the agent adopts later via `POST /mission-control/adopt`, *"seconds or minutes after start"* — so two rapid starts both see an empty seat, and `ptyFleetService.create` renames on collision, *"producing 'Mission Control' AND 'mission-control-2' — two agents each told they are the Mission Control."*

Standalone defends twice, server-side: a seat guard at step 1 (`_autobanState.missionControlSeat` plus a live-handle check at `:3411-3427`) and a canonical-name check at step 3 (`:3444`) against `MISSION_CONTROL_TERMINAL_NAME` (imported from `autobanState.ts` at `:51`), *"rather than hardcoded to avoid drift vs the extension host."*

The extension host has neither. Its `missionControlStart` seam (`TaskViewerProvider:4370`) calls `startMissionControlFromKanban` and returns `{ success: true, mode: 'terminal' }` unconditionally. The only protection is the browser shell's button-disable pattern (`shell.js:867` sets `startBtn.disabled = true` during the fetch, `:893` re-enables in `finally`). So the guard applies exactly when the caller is that one webview. An external agent POSTing `/mission-control/start` against the extension host — a first-class entry point, and the one an agentic app uses to drive everything remotely — is unguarded.

The name did not drift. The guard did.

> **Superseded:** The plan originally said "the only protection is `orchestrationStartInFlight`, a module flag in `src/webview/shell.js`."
> **Reason:** `orchestrationStartInFlight` no longer exists. The shell now uses `startBtn.disabled = true` (line `:867`) during the fetch and `startBtn.disabled = false` (line `:893`) in the `finally` block as its debounce mechanism.
> **Replaced with:** The button-disable pattern in `startDockTerminal` (`shell.js:866-895`) is the current client-side debounce. It serves the same purpose but is even thinner — it only prevents the button from firing twice, not the endpoint from being called twice.

**A related asymmetry worth recording:** because the extension host always returns `mode: 'terminal'`, shell.js's `mode === 'clipboard'` branch (`:881`) is dead under the extension host and reachable only in standalone. So the chat-panel delivery route is available from implementation.html's Manage button but not from the shell rail when running under VS Code.

### Root Cause

Two implementations of one action grew in two hosts. Standalone got the guards because the race was found there; the extension host kept a thinner seam and the browser client patched around it. The clipboard payload was written for the degraded case and then documented as if it also served the chat-panel case, so nobody compared it against the better text sitting in the other host.

### Non-goals

- **Not changing which surface creates a terminal.** implementation.html resolving rather than creating is correct: in an IDE the user's preferred host may be a chat panel, and auto-spawning a terminal would presume otherwise. The browser shell creating a pty terminal is correct because no chat panel exists there.
- Not consolidating the two hosts onto one implementation. The behavioural difference is deliberate.
- Not removing clipboard mode. Both of its meanings are legitimate.

## Metadata

**Complexity:** 4
**Tags:** orchestrator, reliability, standalone, api

## User Review Required

None.

## Complexity Audit

### Routine
- Replacing a hardcoded prompt string with the portable builder.

### Complex / Risky
- **Mirroring the guards into the extension host** touches the path ~4,000 installs use to start Mission Control. The failure mode of getting it wrong is refusing a legitimate start, which is worse than the double-spawn it prevents.
- **A recorded seat whose terminal is dead must still recover.** Standalone deliberately falls through to create a fresh terminal in that case rather than reporting failure (`:3424-3427`); a mirrored guard that returns an error instead would strand the user with an unusable seat.

## Edge-Case & Dependency Audit

- **Redeliver, do not refuse.** Standalone's guards redeliver the persona prompt to the live terminal and return `mode: 'terminal'`. The mirrored guard must match that, not return an error.
- **`MISSION_CONTROL_TERMINAL_NAME` must stay the single source** for the canonical name in both hosts. Hardcoding it in the extension host reintroduces exactly the drift the standalone comment guards against.
- **Keep shell.js's button-disable pattern.** It suppresses a duplicate request before it leaves the browser, which is still worth having once the server is safe. Removing it makes the UI flicker on double-click even if the outcome is correct.
- **The two clipboard meanings need distinguishing in the response**, not just in a comment — a caller cannot tell "no agent configured" from "deliberately not spawning" today, and the browser shows the same toast for both.
- **The portable prompt must not leak a token.** It carries a root path and a port, both already present in the VS Code version; do not extend it with the session secret.
- `startMissionControlFromKanban` also serves the Manage path indirectly. Do not change its behaviour — add the guard at the seam.
- The extension host returning `mode: 'terminal'` unconditionally means its clipboard branch is untestable there. Any test for the portable payload must run against standalone.

## Dependencies

- Independent of the other subtasks in this feature. No shared files with the `queueSequencing` removal, the instructions column, or the comment-dispatch retirement.

## Adversarial Synthesis

Key risks: mirroring the guard incorrectly could refuse legitimate starts (worse than the double-spawn); a dead seat that returns an error instead of recovering strands the user; the portable prompt leaking a token would be a security regression. Mitigations: match standalone's redeliver-and-fall-through pattern exactly; keep `MISSION_CONTROL_TERMINAL_NAME` as the single source; never extend the prompt with the session secret.

The tempting fix for defect 1 is to make the string longer — add the root and port to `'Run /switchboard workflow…'`. That keeps a slash-command reference as the instruction, which is the part that does not travel. The prompt must tell the agent what to *read*, not what command to invoke.

The tempting fix for defect 2 is to keep patching clients: add a debounce flag wherever a caller appears. That does not help the external POST caller, which is the case that matters most, and it multiplies the number of places the invariant lives.

## Proposed Changes

1. **Replace the standalone clipboard payload** (`bootstrap.ts:3471`) with the portable prompt — file to read, root pinned with the do-not-derive-from-cwd warning, port — by calling `buildMissionControlKickoffPrompt(root, undefined, 'self', missionId)` and using its `prompt`, or by extracting the inline prompt from `_handleDispatchProjectManager:28712` into a shared builder both hosts call.
2. **Distinguish the two clipboard meanings in the response** so a caller can tell "no agent CLI configured" from "deliberately not spawning", and surface the reason in the shell's message.
3. **Mirror standalone's seat guard and canonical-name check into the extension host's `missionControlStart` seam** (`TaskViewerProvider:4370`), redelivering to a live terminal rather than refusing, and falling through to create when a recorded seat is dead.
4. **Keep `MISSION_CONTROL_TERMINAL_NAME` as the single source** for the canonical name in both hosts.
5. **Leave shell.js's button-disable pattern in place** as UI-level debounce.

### Migration

None. No persisted state or settings change; both changes affect only what a start call returns and how it guards.

## Verification Plan

1. **Portable payload works in a bare host.** With no lead or coder startup command configured, start from the browser board, paste the copied prompt into an agent with **no Switchboard skills registered**, and confirm it reads the workflow and reaches the entry protocol.
2. **Root is not derived from cwd.** Run the pasted prompt from a working directory other than the workspace root and confirm the agent uses the pinned root.
3. **The two clipboard reasons are distinguishable.** Trigger the no-agent case and confirm the response and the shell message say why.
4. **Extension host double-start is refused server-side.** POST `/mission-control/start` twice in rapid succession against the extension host **without going through shell.js**, and confirm exactly one Mission Control terminal exists and no `mission-control-2`.
5. **Redelivery, not refusal.** With a live seated Mission Control, POST start again and confirm the persona prompt is redelivered and `mode: 'terminal'` returned.
6. **Dead seat recovers.** Record a seat, kill its terminal, POST start, and confirm a fresh terminal is created rather than an error returned.
7. **Standalone unchanged.** Re-run the standalone start paths and confirm both guards still behave as before.
8. **Canonical name single-sourced.** Confirm neither host hardcodes the terminal name.

### Goal Invariants

- **Negative:** The string `'Run /switchboard workflow'` does not appear in the clipboard payload at `bootstrap.ts`.
- **Positive:** The clipboard payload at `bootstrap.ts` contains a file path to `.agents/workflows/switchboard.md` and the workspace root.
- **Negative:** `TaskViewerProvider.missionControlStart` (`:4370`) does not unconditionally return `{ success: true, mode: 'terminal' }` — it checks for an existing live seat first.
- **Positive:** `MISSION_CONTROL_TERMINAL_NAME` is imported from `autobanState.ts` in both `bootstrap.ts` and `TaskViewerProvider.ts`.

## Outstanding Questions

None.
