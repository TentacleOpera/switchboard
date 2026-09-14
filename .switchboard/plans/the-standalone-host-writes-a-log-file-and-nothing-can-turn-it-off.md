# The Standalone Host Writes a Log File on Every Start, and Nothing Can Turn It Off

## Goal

Stop the board writing `.switchboard/logs/server.log`. The operator does not want log files on the
box; today there is no setting, no flag and no environment variable that prevents one, and the usual
way of silencing a daemon — pointing its output at `/dev/null` — does not work here by design.

### Problem analysis

`src/standalone/cli.ts:4518` calls file logging **unconditionally** on every start:

```ts
const isDetachedChild = isDetachedChildProcess();
const logsDir = path.join(switchboardDir, 'logs');
fs.mkdirSync(logsDir, { recursive: true });
const logFile = path.join(logsDir, 'server.log');
setupFileLogging(logFile, !isDetachedChild);
```

There is no condition on the call. `setupFileLogging` (`cli.ts:339`) then wraps `console.log`,
`console.info`, `console.debug`, `console.warn` and `console.error`, and appends every line to the
file.

**Redirecting stdout does not stop it, and the code says so.** From the function's own docblock:

> In foreground mode (`alsoStdout = true`) output goes to both the terminal and the file. In detached
> mode (`alsoStdout = false`, stdout is /dev/null) only the file is written.

So `> /dev/null` silences the terminal and leaves the file untouched — the one control an operator
would reach for is precisely the one the design routes around. An operator who has "turned logging
off" still has a growing log file, and no way to discover that from the outside.

**The write is synchronous, per line.**

```ts
fs.appendFileSync(logFile, msg);
```

Every `console.*` call in the host is a blocking filesystem write. On the Pi that is a synchronous
SD-card write on the event loop, in a process that also serves the board, the WebSocket gateway and
the PTY host. The cost is not the file's size — it is capped — it is that the event loop stops on
every log line.

**Size is bounded but not small.** `LOG_CAP_BYTES = 10 * 1024 * 1024`, rotated once to
`server.log.1`, so the ceiling is ~20 MiB per workspace on a 29 GB card.

**Observed 2026-09-09/10.** `~/.switchboard/logs/server.log` on the Pi, 21,702 bytes, written while
the board's stdout was pointed at `/dev/null` — the file the operator believed they had already
stopped.

#### Scope

Standalone only. This is `src/standalone/cli.ts`; the extension host logs through the VS Code output
channel and is not affected, so no second composition root needs touching and none should be added.

### The decision

**Delete the file logging.** Not a flag defaulting to on, not a quieter level — the operator's
requirement is no log files. A setting that defaults to writing one reproduces today's situation for
anybody who does not find the setting.

Console output itself stays: in the foreground the operator watches the terminal, and in detached
mode stdout already goes wherever the launch line points it. That is the operator's choice to make at
the command line, which is the right place for it.

## Metadata

**Complexity:** 2
**Tags:** standalone, cli, logging, pi

## User Review Required

None. The operator has stated the requirement: no logs.

## Complexity Audit

### Routine
- Deleting a function and its two call sites (`setupFileLogging`, the `:4515` and `:4432`
  `mkdirSync` blocks) — pure removal, no new logic.
- Deleting `LOG_CAP_BYTES` and the rotation body that references it.
- Removing or rewriting the `switchboard logs` subcommand tail.

### Complex / Risky
- The `--detach` parent at `:4432` constructs `logFile` and passes a stdio-redirected child; the
  child's `setupFileLogging` is what actually writes. Removing the parent's `mkdirSync` is safe
  only because the child no longer writes — verify the child does not depend on the dir existing
  for a different reason (it does not; `setupFileLogging` is the only consumer).
- Confirming no OTHER `logs/` creator was missed — the grep in the Verification Plan is the gate.

## Edge-Case & Dependency Audit

- **Race Conditions:** none — startup is single-threaded; the detach parent creates the dir before
  the child spawns, and the child writes synchronously. Removal is unconditional on both sides.
- **Security:** removing the log file removes a surface that captured console output (which can
  include tokens/paths per the `setupFileLogging` docblock). This is a security **improvement**,
  not a regression — no new exposure is introduced.
- **Side Effects:** the `switchboard logs` subcommand becomes a no-op; operators who relied on it
  to tail the host lose that affordance. The foreground terminal and the launch command's stdout
  redirect remain the operator's window.
- **Dependencies & Conflicts:** shares `cli.ts` with the CPU-attribution subtask (which touches the
  `stop` gating, a different region) and the heap/inotify subtask (which may add a `SIGUSR2` heap
  snapshot handler). Different regions of the same file — no edit conflict, but land order should
  avoid both editing the `setupFileLogging` neighborhood simultaneously. The `terminalLogWriter`
  was deliberately removed (e26ac375) — it is dead code by intent; no sibling revives it, so the
  "no `logs/` dir" verification is not re-scoped by any sibling.

## Dependencies

- None (no session IDs). The cross-subtask shared-surface notes are in the Edge-Case audit above
  and the feature's reconciliation map.

## Adversarial Synthesis

Key risks: a second `mkdirSync` in the `--detach` path and the `switchboard logs` subcommand were
both missed by the original plan, either of which leaves the complaint half-alive; and the plan's
"terminalLogWriter must keep working" constraint rested on a writer that is not wired. Mitigations:
both extra sites are now named with line numbers in change 2 and the Verification Plan, and the
writer framing is corrected with a Superseded callout so a coder does not preserve a non-existent
constraint.

## Proposed Changes

### 1. Remove the unconditional file-logging setup (`src/standalone/cli.ts:4510-4518`)

- **Logic:** Delete the `setupFileLogging` call and the `logsDir` / `logFile` construction around it,
  including the `fs.mkdirSync(logsDir)` that creates the directory whether or not anything writes to
  it. Delete `setupFileLogging` and `LOG_CAP_BYTES` with it — a function with no callers is the next
  reader's trap.
- **Edge cases:** The bootstrap `log()` calls that the current comment says must be captured still
  reach `console.*`; they simply are not written to a file. Foreground output is unchanged.

### 2. Leave nothing that recreates the directory

- **Logic:** `.switchboard/logs/` must not be created by the host at start. Check for other writers
  before assuming the call at `:4515` is the only one — there are **three** creators/dependents to
  account for, not one:
  1. **The foreground/detached-child `mkdirSync` at `cli.ts:4515-4516`** (the one change 1 names).
  2. **A second `mkdirSync` in the `--detach` parent at `cli.ts:4432-4433`** — the detach path creates
     `logsDir` and constructs `logFile` *before* spawning the child, so the child has a file to
     write. This is a separate call site from `:4515` and must be removed too, or a `--detach` launch
     still recreates the directory.
  3. **The `switchboard logs` subcommand at `cli.ts:4141-4143`** tails `server.log` directly. Once no
     `server.log` is ever written, this command tails a file that does not exist. It must either be
     removed or rewritten to say the host no longer keeps a log — leaving it silently reading
     nothing is a fallback that behaves like a working command.

> **Superseded:** "`terminalLogWriter.ts` writes into the same directory for per-session terminal
> logs and is a separate feature with a separate switch; it is out of scope here and must keep
> working."
> **Reason:** `new TerminalLogWriter(` was **deliberately removed** from both `bootstrap.ts` and
> `ptyHost.ts` in commit `e26ac375` (2026-09-07, "Go where it pays: static launcher, PTY host, and
> CLI client verbs") — the writer was cut as useless and memory-hungry during the Go PTY host
> migration. It is dead by intent, not an accidental divergence. `terminalLogWriter.ts` still
> exists as leftover dead code, and the contract test `terminal-session-log-contract.test.js`
> (line 525) still asserts the removed wiring — that test is stale and would fail if run. The
> per-terminal session-log **read** endpoints (`LocalApiServer.ts:8186`, `:8285`)
> `readdirSync(logsDir)` with a "dir may not exist" catch, so they already tolerate an absent
> directory.
> **Replaced with:** `setupFileLogging` is the **only** live creator of `.switchboard/logs/` and
> `server.log` today. Removing it (changes 1 and 2) leaves no host-side creator. The
> terminalLogWriter is dead code by design — no subtask revives it, and the "if a sibling wires
> it" caveat does not apply. The read endpoints stay (they are no-ops against an empty/missing
> dir and harm nothing). A coder must confirm no OTHER creator was missed by grepping
> `mkdirSync.*logs` after the change. The stale contract test
> (`test:contract:terminal-session-log`) is out of scope here but is flagged: it asserts wiring
> removed in e26ac375 and should be deleted or updated in a separate cleanup.

- **Rationale:** An empty `logs/` directory appearing on every start is the same complaint in a
  smaller form.

### 3. Delete the existing files on the operator's boxes

- **Logic:** `~/.switchboard/logs/server.log` and any `server.log.1`. Not code — a cleanup step that
  belongs with the change, because the change alone leaves yesterday's files sitting there.

## Verification Plan

### Automated Tests
- Start the standalone host in foreground: console output appears, and `.switchboard/logs/server.log`
  is not created.
- Start it detached: no `server.log`, and no `.switchboard/logs/` directory created by the host.
  (The terminalLogWriter was deliberately removed in e26ac375 — it is dead code and creates
  nothing. No "if a sibling wires it" caveat applies.)
- `grep -rn "setupFileLogging\|LOG_CAP_BYTES" src/` returns nothing.
- `grep -rn "mkdirSync.*logs" src/standalone/cli.ts` returns nothing — covers both `:4432` and `:4515`.
- The `switchboard logs` subcommand no longer tails a `server.log` that is never written: it either
  prints "the host no longer keeps a log file" or is removed.
- The stale contract test `test:contract:terminal-session-log` (asserts `new TerminalLogWriter(`
  wiring removed in e26ac375) is flagged for separate cleanup — NOT a gate this plan must keep green.

### Goal Invariants
- The host never creates or appends to a log file of its own.
- No `console.*` call performs a synchronous filesystem write.
- Where console output goes is decided by the launch command, not by the host.

### Manual
- Run the board on the Pi for an hour with seats active; confirm nothing appears under
  `~/.switchboard/logs/` that the host itself wrote.

## Outstanding Questions

- None. The terminalLogWriter was deliberately removed (e26ac375, 2026-09-07) as useless and
  memory-hungry — it is dead code by intent, not a decision pending. The leftover `terminalLogWriter.ts`
  file and the stale contract test (`test:contract:terminal-session-log`, which asserts the removed
  wiring) are separate cleanup, out of scope for this plan.

## Implementation Summary

File logging in the standalone host has been completely removed. `setupFileLogging`, `LOG_CAP_BYTES`, and all calls to `mkdirSync(logsDir)` across the detached and foreground paths in `src/standalone/cli.ts` were eliminated. The `switchboard logs` subcommand was updated to report that the host no longer writes a log file and directs output to stdout/stderr. Existing `server.log` files on disk were cleaned up.
