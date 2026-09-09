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
  before assuming this call is the only one — `terminalLogWriter.ts` writes into the same directory
  for per-session terminal logs and is a separate feature with a separate switch; it is out of scope
  here and must keep working.
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
- `grep -rn "setupFileLogging\|LOG_CAP_BYTES" src/` returns nothing.
- Per-session terminal logs (`terminalLogWriter`) still write when that feature is enabled.

### Goal Invariants
- The host never creates or appends to a log file of its own.
- No `console.*` call performs a synchronous filesystem write.
- Where console output goes is decided by the launch command, not by the host.

### Manual
- Run the board on the Pi for an hour with seats active; confirm nothing appears under
  `~/.switchboard/logs/` that the host itself wrote.

## Outstanding Questions

- None.
