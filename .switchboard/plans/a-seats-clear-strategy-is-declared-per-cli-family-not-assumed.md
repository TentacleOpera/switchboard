# A seat's clear strategy is declared per CLI family, not assumed

## Goal

Stop pretending `/clear` means the same thing on every CLI. Declare per family
what a context reset *is*, and use the mechanism that matches:

- **In-process reset** (Claude, Antigravity) — keep `/clear`. It is cheap and
  correct, and respawning would only add a cold boot.
- **Restart under the hood** (Devin) — stop driving the restart through the
  input box. Respawn the CLI with the prompt as an exec argument.

### Problem analysis

`/clear` is treated as one mechanism across 19 CLI families. Measured on this
box, 2026-09-11, from the session logs in `.switchboard/logs/`:

| seat | `/clear` issued | CLI startup banner reprints |
|---|---|---|
| `analyst-1` (Claude) | 26 | **0** |
| `planner-1` (Devin) | 114 | **197** |

Claude never restarts — 26 clears, not one banner. Devin restarts on every
clear, and more often besides. Three consequences, all observed:

**1. A failed restart destroys the pane.** Devin's `/clear` tears down the
session and starts a new child. When that child fails (`Error: failed to start
the ACP agent child`), the seat is left with a dead process — and because a
seat runs `exec tmux attach` against a one-window session, the window dies with
it and takes the error message with it. The operator sees `[exited]` and no
cause. This is the planner-4 crash reported 2026-09-11.

**2. Every Devin seat inherits the model, declared or not.**

Measured manually, 2026-09-11: **the model is global, not per-session.** On a
clear, the new session takes the last model set by *any* running Devin CLI.
That is read at restart, so a startup command carrying `--model` does **not**
protect the seat — `/clear` restarts Devin's session internally and never goes
back through the startup command. Choosing a model in one seat silently moves
every other Devin seat onto it at that seat's next clear.

This is the reason respawn is required for Devin rather than merely cheaper.
The startup command is the only place the seat's model is declared, and the
only way to make it hold across a reset is for the reset to *be* a respawn that
re-applies it. No amount of setting flags at first spawn survives a clear.

Every Devin seat is exposed today: the configured startup commands are
`devin --permission-mode bypass` for planner, lead, coder, intern,
project_manager and phone_a_friend — no `--model` on any of them.

**3. The delivery machinery is only fragile where it is also unnecessary.** The
input-box path carries Ctrl+U, bracketed-paste framing, chunked writes, an
isolated submit CR, a confirm CR, and per-family readiness ceilings — and every
one of those exists to compensate for driving a TUI composer. On the Devin
clear path we pay all of it to reach a process that is about to be replaced
anyway.

**4. The submitting CR is blind.** `writeSlashCommandLocked` writes `\x15`,
then the command, then `\r` as three separate writes with settles between —
correct framing, and the separation is load-bearing (a concatenated CR lands as
a literal newline on Devin 3000.5.20). But the final `\r` is sent without
reading what is on screen. On Devin, typing `/clear` opens a **completion
menu**; the captured log shows it listing two entries:

```
/clear                   Clear conversation history
/claude:manage-features  Create, group, and rearrange Switchboard features…
```

The CR accepted the highlighted one. It happened to be `/clear`. Nothing
guarantees that.

**5. The menu grows with this project's own skills.** `devin skills list` shows
Devin ingesting BOTH skill trees — 18 entries, of which 8 come from
`./.claude/skills` and 7 from `./.agents/skills`, several the same skill twice
under different prefixes (`/agents:query-kanban` and `/claude:query-kanban`,
`/kanban_operations` and `/kanban-operations`, `/agents:manage-features` and
`/claude:manage-features`). Every skill added, and every skill mirrored, widens
the set of entries a blind CR can land on. This is the already-recorded failure
mode — a blind CR answering a dialog — reached through a menu the project
itself populates.

### Root cause

Clear was modelled on the CLI where it is cheapest. On Claude-family agents
`/clear` empties an input buffer, so "send the command, send a return" is
complete and safe. Devin's `/clear` is a session lifecycle operation with a
completion UI in front of it, and neither property is represented anywhere in
the delivery path — it sends the same three writes to every family and assumes
the same outcome.

**The root cause is that Switchboard drives a session restart through the input
box.** The input box is a TUI composer with a completion menu, bracketed-paste
mode, and a process that is about to be replaced. Every piece of delivery
machinery — Ctrl+U, bracketed-paste framing, chunked writes, the isolated
submit CR, the confirm CR, the per-family readiness ceilings — exists to
compensate for driving a TUI composer. On the Devin clear path we pay all of it
to reach a process that is about to be replaced anyway. Respawn removes the
mechanism: the CLI is killed and re-exec'd with the prompt as an argument, so
no text is typed, no menu opens, no CR is sent, and no readiness scraping is
needed.

### Architecture decision

**Respawn-with-prompt replaces `/clear` + prompt only where `/clear` is already
a restart.** It is not a general replacement for prompt delivery: a follow-up
message into a live session must still reach a running process, so the input
box path stays for every prompt that is not a reset.

**The strategy is a declared property of the family, never inferred.** Add it
beside the existing family windows in `firstReadinessWindows` /
`clearReadinessWindows` (`cmd/switchboard-pty-host/prompt.go`) rather than
deriving it from observed behaviour. Guessing intent from observable bytes is
what produced the keystroke defect fixed in `7cd3ac1a`.

**The argv shape is declared per family too, and the shapes differ in a way
that fails silently if guessed:**

- `claude [options] [prompt]` — prompt is positional, interactive by default.
- `devin [OPTIONS] [PATH]... [-- <PROMPT>...]` — prompt only after `--`.
  Before `--`, a bare string is read as a **PATH**, so a mis-shaped call does
  not error; it treats the prompt as a directory.

**The startup command is re-injected the same way it was at initial spawn.**
The Go host spawns a login shell (`shell -l`); Node writes the startup command
to the pty as text via `handle.sendText(effectiveStartupCommand, true)`
(`goPtyFleetProjection.ts:349`). This works because the shell is fresh — no
completion menu, no leftover buffer, no running TUI composer. Respawn reuses
the same mechanism: the Go host kills the old process and starts a new login
shell, then Node writes `startupCommand + prompt-in-argv-shape + \r` to the
pty. The Go host never needs to store or parse the startup command — it
provides a fresh shell, Node injects into it, exactly as at creation.

**The model stays where it already lives — the startup command.** No model
field, no picker, no per-seat model setting threaded through both roots. The
startup command is already the seat's declaration of what it runs and with
which flags. Defect 2 is closed by having the respawn re-apply that
declaration, not by building a second place to say the same thing.

**The pty is reused, not recreated.** Respawn the CLI *inside* the existing
pty. The terminal name, tmux session and window, session log, fleet registry
row and WebSocket clients all key on the pty; recreating it would churn every
one of them for a context reset. The underlying pty fd is replaced (a new
process needs a new pty pair), but the terminal name, listeners, and
WebSocket clients stay the same — `readOutput` emits to `t.emit(chunk)` and
`f.publish(name, chunk)`, both keyed by name, not by fd.

### Non-goals

- Fixing Devin's ACP spawn failure. That is the agent's defect.
- The seat dying when the agent exits. Its own card
  (`an-agent-exit-destroys-the-seat-and-its-error-with-it.md`).
- Replacing `/clear` with a different Devin command. **No cheaper alternative
  is known** (confirmed 2026-09-12 from a live Devin seat). `/clear` is the only
  context-reset command; it always restarts the session. Respawn is not a
  different command — it is a different *mechanism* for achieving the same
  reset without typing into the composer.
- Changing the three-write framing for CLIs that stay on the `/clear` path
  (Claude, Antigravity). It is correct and measured for in-process resets.

### Relationship to the sibling plan

`clear-on-devin-is-a-session-restart-and-a-blind-cr-answers-its-menu.md`
originally proposed patching the `/clear` delivery path (confirm the
submission, mark a family property, report failures). It was rewritten to
argue for the same respawn approach, then merged into this plan. This plan
holds the architecture (declared per-family strategy, argv templates, model
re-application, Node/Go boundary); the sibling's evidence (blind CR, completion
menu, timing-by-name, skill dedup) is folded in above. The sibling plan is now
a stub pointing here.

## Metadata

**Complexity:** 7
**Tags:** cli, reliability, ux, bugfix

## User Review Required

None.

## Complexity Audit

### Routine

- Declaring the per-family clear strategy (`in-process` | `respawn`) in the Go
  pty host: a new record beside the existing `firstReadinessWindows` /
  `clearReadinessWindows` tables in `prompt.go`.
- Skipping the readiness tracker for `respawn` families in `ptyPromptDelivery.ts`:
  a conditional that bypasses `clearAndAwaitReadinessLocked` when the family
  strategy is `respawn`.
- Change #7 (Agents tab startup command field): a placeholder or one line of
  help text in a field that already exists. Both composition roots render it.
- Skill tree deduplication (Change #6): removing mirrored entries from
  `.claude/skills/` is a file change with no runtime logic. Secondary —
  respawn eliminates the blind CR that made duplicates dangerous, but fewer
  menu entries is still good hygiene.

### Complex / Risky

- **Pty fd replacement in the Go host.** The Go host kills the process group
  (`killProcessTree` in `proc_unix.go:15`), closes the old master fd, starts a
  new `exec.Command(shell, "-l")` with `pty.StartWithSize`, updates the
  terminal struct in place (`t.cmd`, `t.file`, `t.pid`), and starts a new
  `readOutput` goroutine. The terminal name, listeners, and WebSocket clients
  stay the same — `readOutput` emits to `t.emit(chunk)` and `f.publish(name,
  chunk)`, both keyed by name, not by fd. This is feasible but is process
  lifecycle management, not a byte-write change.
- **Both composition roots.** The standalone's `clearTerminalContext`
  (`bootstrap.ts:4575`) calls the fire-and-forget `ptyClearTerminal` verb; the
  extension's (`TaskViewerProvider.ts:12213`) calls the readiness-gated
  `ptySendPrompt` verb. Both must consult the declared strategy. The
  `ptyClearTerminal` and `ptyClearAllTerminals` verbs (`main.go:410-434`) call
  `writeSlashLocked(t, "/clear")` directly and do NOT take the per-terminal
  lock — a respawn from the clear button could splice into an in-flight
  delivery.
- **Respawn requires a startup command, and does not fall back.** The command
  is the thing being re-injected; without one there is nothing to type into the
  fresh shell. Only the `shell` role (`NO_ROLE`) is legitimately CLI-less, and
  it is not a `respawn` family. A non-`shell` role reaching this path with an
  empty startup command is a seat that should never have been created — see
  `a-role-with-no-startup-command-can-still-be-seated.md`. Fail loudly here and
  name the role; do not substitute `/clear` to paper over it.

## Edge-Case & Dependency Audit

- **Race Conditions:** The `ptyClearTerminal` and `ptyClearAllTerminals` verbs
  (`main.go:410-434`) call `writeSlashLocked` directly without taking the
  per-terminal lock. A respawn from the clear button could splice into an
  in-flight chunked paste from `deliverPrompt`. The per-terminal lock
  (`withTerminalLock` in `ptyPromptDelivery.ts`) serializes delivery against
  clear on the `ptySendPrompt` path, but the clear button bypasses it. Respawn
  must take the same lock or serialize against in-flight delivery.
- **Security:** Respawn re-injects the startup command into a fresh login
  shell. The command goes through the shell, same as at initial spawn — no new
  attack surface. The prompt is appended in the family's argv shape (e.g.
  `-- "prompt text"` for Devin), so a prompt containing shell metacharacters is
  passed as a quoted argument, not interpreted by the shell.
- **Side Effects:** A failed respawn (the new child exits immediately) leaves a
  dead pane. Unlike the `/clear` path — where `clearTerminalContext` returns
  `{cleared: true}` even on failure (the standalone) — respawn must report the
  failure. The Go pty host's `deliverPrompt` path already detects exit
  (`prompt.go:186-192`); the respawn path must do the same.
- **Dependencies & Conflicts:**
  - `clear-on-devin-is-a-session-restart-and-a-blind-cr-answers-its-menu.md` —
    merged into this plan; the sibling is now a stub pointing here.
  - `a-seats-cli-family-is-frozen-at-spawn-so-devin-timing-fixes-never-reach-it.md`
    — the family re-derivation on every delivery (`ptyPromptDelivery.ts:214-220`)
    already corrects the family at delivery time. The clear strategy must be
    re-derived the same way.
  - `a-delay-setting-must-not-be-able-to-defeat-known-cli-readiness.md` — the
    manual-mode floor in `clearReadiness.ts:172` enforces `max(delay,
    readiness)` for known families. Respawn families skip the readiness tracker
    entirely, so this floor does not apply — but `in-process` families must not
    regress.
  - `a-role-with-no-startup-command-can-still-be-seated.md` — a respawn family
    with no startup command must fail loudly, not substitute `/clear`.

## Dependencies

- `clear-on-devin-is-a-session-restart-and-a-blind-cr-answers-its-menu.md` —
  merged into this plan; the sibling is now a stub.
- `a-seats-cli-family-is-frozen-at-spawn-so-devin-timing-fixes-never-reach-it.md`
  — the family re-derivation pattern the clear strategy must follow.
- `a-role-with-no-startup-command-can-still-be-seated.md` — the no-fallback rule
  for respawn families with no startup command.

## Adversarial Synthesis

Key risks: (1) The `ptyClearTerminal` verb does not take the per-terminal lock,
so a respawn from the clear button races in-flight delivery — the respawn path
must serialize against `deliverPrompt`. (2) The pty fd is replaced on respawn
(new process needs a new pty pair), but the terminal name, listeners, and
WebSocket clients stay the same — the `readOutput` goroutine and `publish`
path are keyed by name, not by fd, so this works, but the fd replacement must
be atomic under the lock. (3) The startup command is re-injected by Node after
the Go host provides a fresh shell — the Go host signals "shell is up" and Node
writes `startupCommand + prompt + \r`, same as `injectStartupCommand` at initial
spawn. Mitigations: take the per-terminal lock in the respawn path; update the
terminal struct in place under the lock; reuse the existing
`injectStartupCommand` pattern for the re-injection.

> **Superseded:** The original sibling plan proposed patching the `/clear`
> delivery path: confirm the submission with a pre-CR screen read, mark
> `restartsOnClear` on the family record for timing selection, report failed
> clears, and deduplicate the skill menu.
> **Reason:** Patching the delivery path compensates for a mechanism that
> should not exist. The blind CR, the completion menu, and the timing-by-name
> problem are all symptoms of driving a session restart through a TUI
> composer. Respawn removes the mechanism: no text is typed, no menu opens, no
> CR is sent, and readiness is the child coming up (observed directly by the
> host, not scraped from output). The patches are fragile (screen-reading is
> not a stable contract) and incomplete (a confirmed `/clear` can still fail
> to start the ACP agent child). Skill dedup survives as a secondary hygiene
> change but is no longer load-bearing.
> **Replaced with:** Respawn the CLI inside the pty for families whose Clear is
> a session restart. Declare the clear strategy (`in-process` | `respawn`) and
> argv template per family. Both composition roots' clear paths consult the
> strategy. The `/clear` input-box path stays for `in-process` families
> (Claude, Antigravity) where it is cheap and correct.

## Proposed Changes

### 1. Declare the per-family clear strategy and argv template in the Go pty host

**Target file:** `cmd/switchboard-pty-host/prompt.go` (beside
`clearReadinessWindows`, line 63).

Add a declared per-family record: clear strategy (`in-process` | `respawn`)
and, for `respawn`, the argv template (where the prompt goes relative to the
startup command). Defaults to `in-process`: an unrecognised family keeps
today's behaviour rather than being respawned on a guessed argv shape.

**Argv shapes (declared, not guessed):**
- `claude [options] [prompt]` — prompt is positional, interactive by default.
- `devin [OPTIONS] [PATH]... [-- <PROMPT>...]` — prompt only after `--`. Before
  `--`, a bare string is read as a PATH, so a mis-shaped call does not error;
  it treats the prompt as a directory.

The argv template is a suffix appended to the startup command: for Devin, ` --
"<prompt>"`; for Claude (if it were respawn, which it is not), ` "<prompt>"`.
The template is applied by Node when it re-injects the command, not by the Go
host — the Go host does not know the startup command and does not need to.

### 2. `deliverPrompt`'s clear branch consults the declared strategy

**Target file:** `cmd/switchboard-pty-host/main.go` (`deliverPrompt` clear
branch, lines 194-223) and `cmd/switchboard-pty-host/prompt.go`.

`deliverPrompt`'s clear branch consults the declared strategy. `respawn` kills
the CLI in the pty and starts a fresh login shell; `in-process` takes the
existing `/clear` path unchanged.

**Respawn mechanism in the Go host:**
1. Kill the process group: `killProcessTree(t)` (already exists in
   `proc_unix.go:15` — kills the session leader and all children via
   `syscall.Kill(-pid, SIGTERM)` with a SIGKILL fallback after 500ms).
2. Close the old master fd: `t.file.Close()`.
3. Start a new login shell: `exec.Command(shell, "-l")` with `pty.StartWithSize`
   (same as `create` at `main.go:144-164`). This creates a new pty pair.
4. Update the terminal struct in place: `t.cmd`, `t.file`, `t.pid`,
   `t.promptCount = 0`.
5. Start a new `readOutput` goroutine for the new fd. The terminal name,
   listeners, and WebSocket clients stay the same — `readOutput` emits to
   `t.emit(chunk)` and `f.publish(name, chunk)`, both keyed by name.
6. Signal the Node side that the shell is up (the existing first-readiness gate
   in `deliverPrompt` already waits for output before proceeding).

**Node re-injects the startup command with the prompt appended.** After the
Go host signals the shell is up, Node writes `startupCommand + argv-suffix +
\r` to the pty via `ptyWrite` — the same `sendText` path used at initial spawn
(`goPtyFleetProjection.ts:349`). For Devin: `devin --permission-mode bypass --
"do the thing"\r`. The Go host does not store or parse the startup command; it
provides a fresh shell, Node injects into it.

This is the same mechanism that works at initial spawn, with two differences:
(a) the old process is killed first, and (b) the prompt is appended to the
startup command in the family's argv shape. Neither requires the Go host to
know the startup command.

### 3. The `ptyClearTerminal` and `ptyClearAllTerminals` arms consult the same strategy

**Target file:** `cmd/switchboard-pty-host/main.go` (`ptyClearTerminal`, lines
423-434; `ptyClearAllTerminals`, lines 410-422).

Both call `writeSlashLocked(t, "/clear")` directly today. Both consult the same
declared strategy, so the operator-facing **clear button respawns a Devin seat**
instead of driving a hidden restart through its composer — which is what makes
the button stop inheriting the global model.

This needs no webview change. All four clear affordances — the pane header
button, the sidebar per-terminal button, and the two other render sites in
`terminals.js` — funnel through `clearTerminal()` to `ptyClearTerminal`, so
one hook in the host covers every one of them.

**The button keeps the label "clear".** The operator's intent is unchanged
and, on Devin, clicking it is already a restart today — so the word is no less
accurate afterwards. A per-family label would put a conditional in four render
sites to describe an implementation detail.

**The `ptyClearTerminal` verb must take the per-terminal lock** before
respawning, to avoid splicing into an in-flight `deliverPrompt` paste. Today
it calls `writeSlashLocked` which takes `t.mu` (the per-terminal mutex), but
that only serializes writes to the pty fd — it does not serialize against the
`deliverPrompt` delivery path, which holds the lock via `withTerminalLock` in
Node. The respawn path must either take the same lock or be routed through
`ptySendPrompt` (which already takes it).

**Composition-root divergence to close:** the standalone's `clearTerminalContext`
(`bootstrap.ts:4575`) calls the local `clearPty` (`bootstrap.ts:1619`), which
invokes the fire-and-forget `ptyClearTerminal` verb — no readiness gate, no exit
detection. The extension's `clearTerminalContext` (`TaskViewerProvider.ts:12213`)
calls `ptySendPrompt` with `clearBeforePrompt: true`, which runs the
readiness-gated path. With respawn, both paths must consult the strategy. The
cleanest approach: the `ptyClearTerminal` verb itself consults the strategy
and respawns internally, so every caller (the clear button, the roster reset,
the queue/done clear, the lead-acceptance clear) gets respawn without knowing
which families respawn.

### 4. Respawn re-injects the seat's startup command verbatim

Respawn re-injects the seat's startup command verbatim, appending only the
prompt in the family's argv shape. This is what makes a declared `--model`
hold: the flag is re-applied on every reset, so the seat stops inheriting the
global last-set model. Nothing re-derives the model and no flag is injected
that the operator did not write — a seat whose startup command names no model
still inherits, which is correct, because it declared nothing.

**A `respawn` family requires a startup command, and does not fall back.** The
command is the thing being re-injected; without one there is nothing to type
into the fresh shell. Only the `shell` role (`NO_ROLE`) is legitimately
CLI-less, and it is not a `respawn` family. A non-`shell` role reaching this
path with an empty startup command is a seat that should never have been
created — see `a-role-with-no-startup-command-can-still-be-seated.md`. Fail
loudly here and name the role; do not substitute `/clear` to paper over it.

### 5. Skip the readiness tracker for respawn families

**Target file:** `src/standalone/ptyPromptDelivery.ts`
(`clearAndAwaitReadinessLocked`, line 114).

`clearAndAwaitReadinessLocked` skips the readiness tracker for `respawn`
families: readiness is the child coming up, which the host observes directly
(the new process produces output or exits), not a signal scraped from
post-clear output. The existing `awaitFirstReadiness` gate
(`clearReadiness.ts:365`) already handles cold-boot detection — respawn is a
cold boot, so it reuses the same gate.

### 6. Reduce the menu surface where it is ours (secondary)

**Target:** `.claude/skills/` and `.agents/skills/` directories.

Respawn eliminates the blind CR that made duplicate menu entries dangerous. But
fewer entries is still good hygiene — any future slash command typed into
Devin's composer hits the same menu, and a smaller menu is a smaller
wrong-answer surface.

**Current state (verified 2026-09-12):**

| Skill | `.agents/skills/` | `.claude/skills/` |
|---|---|---|
| kanban-operations | `kanban_operations` | `kanban-operations` |
| manage-features | `manage-features` | `manage-features` |
| query-kanban | `query-kanban` | `query-kanban` |
| worktree-cleanup | `worktree-cleanup` | `worktree-cleanup` |

Four skills are duplicated across the two trees. Devin ingests both, producing
`/agents:query-kanban` and `/claude:query-kanban` etc. in the completion menu.

**Implementation:** Pick one tree as canonical and remove the mirrors. The
`.agents/skills/` tree is the one the AGENTS.md/CLAUDE.md protocol references.
Remove the four duplicated entries from `.claude/skills/`, keeping the ones
that have no `.agents/` counterpart (`switchboard`, `switchboard-cloud`,
`switchboard-memo`, `switchboard-remote`). Verify after removal that
`devin skills list` no longer shows duplicates.

**Edge cases:**
- Some skills may have diverged between the two trees. Before removing, diff
  each pair and confirm the `.agents/` version is the canonical one. If the
  `.claude/` version has content the `.agents/` version lacks, merge it first.
- The `.claude/skills/` directory is read by Claude-compatible agents (Claude
  Code, Cursor). Removing skills from it may affect those agents' skill
  discovery. If both trees must be kept for compatibility, the alternative is to
  make one tree a symlink to the other.

### 7. Agents tab startup command field

**Target files:** both composition roots' Agents tab rendering.

Show that it takes flags, with the model as the example: a placeholder or one
line of help reading `devin --model claude-opus-4.6`. One line of text in the
field that already exists. No model dropdown, no separate model setting, no
per-role matrix — the startup command is the seat definition and stays the
only one. Both composition roots, since both render the field. On its own this
changes nothing (the flag does not survive a clear); it is what gives change
#4 something to re-apply.

## Verification Plan

- **Respawn replaces `/clear` on Devin:** clear a seat on a `respawn` family,
  assert a new child pid (not the same process), assert the prompt arrives, and
  assert the pty, terminal name and WebSocket client survive. Run against BOTH
  composition roots.
- **Clear button respawns a Devin seat:** the same probe runs against the
  `ptyClearTerminal` verb with no prompt — the clear button's path. A respawn
  with nothing to deliver must still leave a live seat at the same terminal
  name, not a dead pane.
- **Declared model survives a clear:** spawn two seats whose startup commands
  name different models, change the model in seat A, clear seat B, and assert
  B came back on B's own declared model. This fails today for every mechanism
  except respawn, because the model is global and re-read at restart.

  Note for whoever writes it: session logs cannot stand in for this. The model
  strip in `planner-1`'s log reads the same value across all 197 restarts only
  because no model was changed during that session.
- **`in-process` families unchanged:** assert `/clear` on a Claude-family seat
  behaves exactly as today — the input-box path, the readiness tracker, the
  three-write framing. Nothing about that path is broken.
- **Respawn with no startup command fails loudly:** assert a `respawn` family
  with an empty startup command returns an error naming the role, not a silent
  `/clear` fallback.
- **Composition-root parity:** assert both hosts' clear path respawns a Devin
  seat and reports failure on a dead child. Today the standalone always returns
  `{cleared: true}` — after the fix, both must agree.
- **Respawn takes the per-terminal lock:** assert a respawn from the clear
  button does not splice into an in-flight `deliverPrompt` paste.
- **Menu breadth (secondary):** assert the skill set Devin ingests contains no
  entry twice under two prefixes.

### Automated Tests

- `test:contract:pty-host-blackbox` — add a respawn probe: clear a seat on a
  `respawn` family, assert a new child pid, assert the prompt arrives, and
  assert the pty, terminal name and WebSocket client survive. Run the same
  probe against `ptyClearTerminal` with no prompt.
- `test:contract:pty-host-gating` — assert every family in the declared table
  has both a strategy and, for `respawn`, an argv template. A family added
  without one must fail the gate, not fall back to a guess.
- `test:contract:standalone-fleet-seam` — assert the standalone
  `clearTerminalContext` respawns a Devin seat (not fire-and-forget
  `ptyClearTerminal`), and reports failure on a dead child.

### Goal Invariants

- **No Clear on a restart-family CLI types into the composer:** assert no
  `writeSlashLocked` call is made for a `respawn` family. Negative pairing:
  assert `writeSlashLocked` is absent from the respawn path and present on the
  `in-process` path.
- **Respawn produces a new child process:** assert the child pid after a
  respawn differs from the pid before. Negative pairing: assert the old pid is
  absent from the live process table and the new pid is present.
- **The pty survives respawn:** assert the terminal name, tmux session, and
  WebSocket client are unchanged after a respawn. Negative pairing: assert no
  fleet-registry churn (no unregister/re-register) occurs on a respawn.
- **A failed respawn is reported:** assert a respawn where the new child exits
  immediately returns `{cleared: false}` with the error. Negative pairing:
  assert `{cleared: true}` is absent from the failure path.
- **`in-process` families are unchanged:** assert a Claude-family clear still
  calls `writeSlashLocked(t, "/clear")` and runs the readiness tracker.
  Negative pairing: assert the respawn path is absent from the Claude-family
  clear.
- **No duplicate skill entries in Devin's completion menu (secondary):** assert
  the ingested skill set contains no entry twice under two prefixes. Negative
  pairing: assert the removed mirror directory is absent from `.claude/skills/`
  and the canonical copy is resolvable in `.agents/skills/`.

## Deferred

`writeSlashLocked`'s Ctrl+U stays. It is there because the composer may hold
leftover text and the write would otherwise concatenate into
`how do I fix the/clear`, submitted as a prompt while `clearPty` reports
success (`feature_plan_20260817091718`). Removing it means fixing whatever
leaves text in the composer, which is its own investigation and does not block
this.

---

## Completion Summary

Implemented per-family clear strategy: Devin respawns (kill + fresh login shell + startup-command re-inject), Claude/Antigravity keep `/clear`, unknown defaults in-process. Go host (`prompt.go`, `main.go`) declares `clearStrategy`/`respawnArgvSuffix`/`shellQuote`, records `startupCommand`+`env` at create, and routes `ptyClearTerminal`/`ptyClearAllTerminals`/`deliverPrompt`'s clear branch through `respawnAndReinject` for respawn families — failing loudly when a respawn seat has no startup command. Node mirror added to `cliIdentity.ts` (`clearStrategyForFamily`); `ptyPromptDelivery.ts` skips the in-process readiness tracker for respawn families; `goPtyFleetProjection.ts` passes `startupCommand` in the `ptyCreateTerminal` payload. Agents tab placeholders (`kanban.html`, `dock.html`) now show `devin --model claude-opus-4.6` so operators see flags survive clear. Contract tests added to `pty-host-gating`, `pty-host-blackbox`, and `standalone-fleet-seam` covering strategy declarations, respawn pid change, name/pty survival, loud failure on missing startup command, and in-process unchanged. Skill dedup (Change #6) dropped — removing from `.claude/skills/` breaks Claude Code/Cursor discovery; mirrors retained.

