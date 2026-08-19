# Switchboard Launcher: Fix Sandbox False-Negative Health Check

## Goal

The `/switchboard` launcher's Step 1 health check treats any non-200 `curl` result as "board is dead" and auto-launches `npx switchboard`. In sandboxed agent environments (e.g. Antigravity's bash tool), loopback connections are blocked, so `curl` returns `000` even when the board IS running. This causes a false negative — the launcher spawns a second server, overwrites `.switchboard/api-server-port.txt`, and hijacks the active session.

Fix the launcher to fail safe: when a port file exists and `curl` cannot confirm liveness, do NOT spawn a second server. Use the port from the file and proceed to Step 2. This is hijack-proof without requiring any signal the sandbox cannot provide.

## Root Cause

The health check at `.agents/workflows/switchboard.md` lines 25–57 collapses three distinct realities into two outcomes:

| `curl` result | Reality | Current behavior | Correct behavior |
|---|---|---|---|
| `200` | Board running | Use existing | Use existing |
| `000` (connection refused) | Board dead | Launch | Launch |
| `000` (sandbox blocked) | Board IS running | **Launch (HIJACK)** | **Don't launch** |
| `404`/`502`/`403` | Alien/broken | Launch | Launch |

The `000`-sandbox case is the destructive one. `curl` cannot distinguish "nobody listening" from "I was blocked from connecting."

> **Superseded:** Add a non-network secondary liveness check (`lsof -nP -iTCP:$PORT -sTCP:LISTEN`) that queries the kernel's socket tables directly, bypassing the sandbox entirely. When `curl` returns `000` but something is listening on the port, do NOT launch.
> **Reason:** Web research (see `## Resolved Assumptions`) confirmed that `lsof` FAILS inside AI coding-agent sandboxes on both macOS and Linux. On macOS, Seatbelt blocks the `proc_pidinfo`/`proc_pidfdinfo` syscalls `lsof` needs — the kernel returns `EPERM` for any PID outside the sandbox sub-tree, so `lsof` returns zero rows for host listening sockets. On Linux, network namespace isolation (`CLONE_NEWNET`) virtualizes `/proc/net/tcp` per namespace — the sandboxed shell sees only its own (empty) socket table, not the host's. Same-UID does not bypass MAC or namespace boundaries. The `lsof` check is a no-op in the exact environment that motivated this plan. Antigravity's suggested alternative (`pgrep`/`ps` port scan) fails for the same reason — Seatbelt blocks `process-info*` on macOS, and `CLONE_NEWPID` hides host processes on Linux.
> **Replaced with:** A fail-safe launcher behavior change: when a port file exists and `curl` returns non-200, do NOT auto-launch. Print a warning, use the port from the file, and proceed to Step 2. The port file's existence is a strong "board might be alive" signal (it is written atomically on server start by both hosts and cleaned up on clean shutdown by both hosts). The cost is a worse UX for the stale-port-file + dead-board case (user must manually delete the port file and re-run) — but this is a recoverable failure, whereas the hijack is destructive. A follow-up plan should add a host-side file-lock mechanism (`.switchboard/daemon.lock` held via `flock`/`fcntl` while the server runs) to give the launcher an accurate sandbox-surviving liveness signal; file locks are filesystem ops, not network or process-table ops, and the research confirmed they survive both Seatbelt and network-namespace isolation when the lockfile path is accessible (the workspace `.switchboard/` dir is accessible from inside the sandbox).

## Metadata
- **Complexity:** 2
- **Tags:** bugfix, reliability, cli
- **Project:** Browser Switchboard

## User Review Required

This plan replaces the original `lsof`-based approach (which web research proved does not work in AI-agent sandboxes) with a simpler fail-safe: don't auto-launch when a port file exists and curl fails. The user should confirm this trade-off is acceptable: the launcher will refuse to spawn a new board whenever a port file is present and curl cannot reach it, even if the board is genuinely dead. Recovery is manual (delete the port file, re-run). A follow-up plan for a host-side file-lock mechanism is recommended to eliminate this false-positive.

## Complexity Audit

### Routine
- Replace one bash block in `.agents/workflows/switchboard.md` (lines 25–57) with a fail-safe decision tree.
- Apply the identical change to the mirror file `.claude/skills/switchboard/SKILL.md` (lines 27–58).
- No new files, no new dependencies, no external binary requirements (`lsof` is no longer needed).
- The change is strictly subtractive in the launch path (adds a guard, removes nothing else).

### Complex / Risky
- **Stale port file + dead board false positive.** When the board crashes (port file survives) or the standalone host is killed without clean shutdown, the launcher will refuse to start a new board. The user must manually delete `.switchboard/api-server-port.txt` and re-run. This is a UX regression for the non-sandboxed crash case, traded for hijack prevention in the sandboxed case.
- **Mirror drift.** Two files must stay byte-identical; no automated sync enforcement exists today.

## Edge-Case & Dependency Audit

- **Race Conditions:** Between the `curl` call and the launch decision, the board could exit or start. The fail-safe approach is race-tolerant: if the board exits after curl fails, the launcher still refuses to launch (safe — user re-runs after deleting the stale port file). If a new board starts after curl fails, the launcher still refuses (safe — the new board is the one to use). No mutex needed.
- **Security:** No new external commands, no process-table queries, no network egress beyond the existing `curl`. Strictly safer than the `lsof` approach (which invoked an external binary).
- **Side Effects:** Refusing to launch when a port file exists + curl fails changes launcher behavior for ALL non-200 curl results when a port file is present. Previously: launch (risk hijack if board alive). Now: refuse (risk false positive if board dead). The trade-off favors the non-destructive failure mode.
- **Dependencies & Conflicts:**
  - No new dependencies. `lsof` dependency removed.
  - No conflict with the post-launch retry loop — the retry loop only runs inside the launch branch, which no longer executes when the port file exists and curl fails.
  - No conflict with Step 2 (orchestration start) — Step 2 reads the port file directly. When the launcher refuses to launch, it still has a port (from the file) and Step 2 proceeds. If the board is actually dead, Step 2's `curl POST /orchestration/start` fails silently — same as today (Step 2 has no error handling, out of scope).
  - No conflict with the extension's watchdog (`_startApiServerWatchdog`) — the watchdog is in-process and does not interact with the launcher.

## Dependencies
- None. This plan is self-contained.

## Adversarial Synthesis

Key risks: (1) stale-port-file false positive — when the board crashes and the port file survives, the launcher refuses to start a new board, requiring manual port-file deletion; (2) Step 2 silent failure — if the board is actually dead but the launcher used the stale port, Step 2's orchestration-start POST fails silently with no user feedback (pre-existing issue, out of scope); (3) two-file mirror has no automated sync enforcement, inviting future drift. Mitigations: clear user-facing message on the refuse path with recovery instructions; sync check documented in verification (manual) and a CI-based sync check proposed as an Outstanding Question; a follow-up plan for a host-side file-lock mechanism to eliminate the false positive.

## Proposed Changes

### `.agents/workflows/switchboard.md` — Step 1 health check (lines 25–57)

Replace the current health-check block with a fail-safe decision tree. The `curl` 200 path is unchanged; the non-200 path now checks for a port file before deciding to launch.

```bash
ROOT="$PWD"
PORT_FILE="$ROOT/.switchboard/api-server-port.txt"

if [ -f "$PORT_FILE" ]; then
  PORT=$(tr -d '[:space:]' < "$PORT_FILE")
  HEALTH=$(curl -s -o /dev/null -w "%{http_code}" "http://127.0.0.1:$PORT/health" 2>/dev/null)
else
  HEALTH="000"
  PORT=""
fi

if [ "$HEALTH" = "200" ]; then
  echo "Switchboard is already running (port $PORT). Using the existing board."
elif [ -n "$PORT" ]; then
  # curl could not confirm liveness (returned $HEALTH), but a port file
  # exists — the board may be running but unreachable from this sandbox
  # (loopback blocked), or the port file may be stale (board crashed).
  # FAIL SAFE: do NOT spawn a second server. Spawning overwrites the port
  # file and hijacks the active session if the board IS alive. The cost of
  # not spawning when the board is actually dead is recoverable (delete the
  # port file and re-run); the cost of spawning when the board is alive is
  # destructive (session hijack).
  echo "Health check returned $HEALTH for port $PORT, but a port file exists."
  echo "The board may be running but unreachable from this sandbox (loopback blocked),"
  echo "or the port file may be stale (board crashed without cleanup)."
  echo "Using the existing port. If the board is NOT running, delete"
  echo "  $PORT_FILE"
  echo "and re-run /switchboard."
else
  # No port file — no board was ever started (or was cleaned up). Launch.
  echo "No board answering. Starting npx switchboard..."
  npx switchboard &
  for i in 1 2 3 4 5 6 7 8 9 10; do
    sleep 1
    if [ -f "$PORT_FILE" ]; then
      PORT=$(tr -d '[:space:]' < "$PORT_FILE")
      HEALTH=$(curl -s -o /dev/null -w "%{http_code}" "http://127.0.0.1:$PORT/health" 2>/dev/null)
      if [ "$HEALTH" = "200" ]; then
        echo "Switchboard is up (port $PORT). Board URL: http://127.0.0.1:$PORT"
        break
      fi
    fi
  done
  if [ "$HEALTH" != "200" ]; then
    echo "Switchboard did not come up within 10s. Check npx output above."
  fi
fi
```

Key behavioral changes:
- **`curl` 200** → use existing board (unchanged).
- **`curl` non-200 + port file exists** → do NOT launch. Print a warning explaining both possibilities (sandbox-blocked or stale) and the recovery action (delete port file, re-run). Proceed to Step 2 using the port from the file.
- **`curl` non-200 + no port file** → launch (no board was ever started, or was cleaned up on shutdown).
- **Defensive port trim:** `PORT=$(tr -d '[:space:]' < "$PORT_FILE")` replaces `PORT=$(cat "$PORT_FILE")` to guard against trailing whitespace/newlines in the port file across POSIX shells. Applied in both the initial read and the retry-loop read for consistency.

> **Superseded:** `PORT=$(cat "$PORT_FILE")` (used in the original block for both the initial read and the retry-loop read).
> **Reason:** `cat`-into-variable strips a trailing newline in most POSIX shells but is not guaranteed across all `/bin/sh` implementations (e.g. some Busybox variants). A port file with trailing whitespace would cause `curl` to construct an invalid URL, returning `000` and triggering a false launch.
> **Replaced with:** `PORT=$(tr -d '[:space:]' < "$PORT_FILE")` — explicit whitespace strip, shell-independent, same result for well-formed input.

### `.claude/skills/switchboard/SKILL.md` — Step 1 health check (lines 27–58)

Apply the identical change. This file is a mirror of the workflow and must stay in sync. The `diff`-based sync check in the Verification Plan enforces this for the current change; a permanent automated sync check is proposed as an Outstanding Question.

### No changes needed to the post-launch retry loop

The retry loop (inside the launch branch above) also uses `curl` and would return `000` in a sandbox. However, this loop only runs when there is no port file — i.e., no board was ever started. In that case, the newly-launched board is genuinely the only instance, and the retry loop's failure to detect it via curl is a cosmetic issue (misleading "did not come up" message), not a destructive one. Step 2 reads the port file directly, so orchestration start still works. Out of scope for this plan.

### Recommended follow-up: host-side file-lock mechanism (NOT part of this plan)

The fail-safe approach has a false positive: stale port file + dead board → launcher refuses to launch. A host-side file-lock mechanism eliminates this:

1. **Host-side (Switchboard code change):** Both hosts (`TaskViewerProvider._startLocalApiServer` in the extension, `bootstrap.ts` in the standalone) acquire an exclusive `flock`/`fcntl` lock on `.switchboard/daemon.lock` while the server is running. On clean shutdown, release the lock. On crash, the kernel auto-releases the lock.
2. **Launcher-side (bash):** Before deciding to launch, try to acquire the lock non-blocking. If the lock is held (exit code 1), the board is alive — don't launch. If the lock is free (exit code 0), the board is dead — launch. Cross-platform via Python3's `fcntl.flock` (preinstalled on macOS and most Linux).

Web research confirmed file locks survive both macOS Seatbelt and Linux network-namespace isolation when the lockfile path is accessible — and `.switchboard/` is accessible from inside the sandbox (the agent works there). This should be a separate plan because it touches Switchboard source code (`TaskViewerProvider.ts`, `bootstrap.ts`), not just the launcher bash block.

## Verification Plan

### Automated Tests
- None. This is a bash block inside a markdown workflow file; there is no test harness for workflow bash. Verification is manual.

### Manual — Reproduce the original bug, then verify the fix

1. Start the Switchboard extension in VS Code. Confirm `curl http://127.0.0.1:<port>/health` returns 200 from a normal terminal.
2. Simulate the sandbox condition: in an environment where loopback curl is blocked (or mock it by temporarily replacing curl with a script that always returns 000), run the `/switchboard` workflow.
3. **Before fix:** a second `npx switchboard` spawns, port file is overwritten.
4. **After fix:** no second server spawns. The message "Health check returned 000 for port $PORT, but a port file exists" is printed. The workflow proceeds to Step 2 using the existing port.

### Manual — Genuinely dead board + stale port file (false-positive case)

1. Kill the Switchboard extension. Leave a stale `.switchboard/api-server-port.txt`.
2. Run `/switchboard`.
3. `curl` returns 000, port file exists → launcher refuses to launch → prints the stale-port-file message with recovery instructions.
4. Delete `.switchboard/api-server-port.txt`. Re-run `/switchboard`.
5. No port file → `npx switchboard` launches. Board comes up normally.

### Manual — No port file

1. Delete `.switchboard/api-server-port.txt`. Ensure no board is running.
2. Run `/switchboard`.
3. Launches `npx switchboard` as before.

### Manual — Normal (non-sandboxed) 200

1. Start the Switchboard extension. Run `/switchboard` from a normal terminal.
2. `curl` returns 200 → "Switchboard is already running" → no launch. Unchanged from today.

### Sync check

1. `diff` the Step 1 bash block between `.agents/workflows/switchboard.md` and `.claude/skills/switchboard/SKILL.md` — they must be identical.

## Resolved Assumptions

The following assumption was flagged as uncertain in the prior version of this plan and has since been resolved by web research (findings supplied by the user):

- **`lsof` syscall availability inside AI coding-agent sandboxes — RESOLVED (assumption was wrong).** Research confirmed `lsof` FAILS in AI-agent sandboxes on both macOS and Linux. On macOS (Seatbelt), `(deny process-info* (target others))` blocks the `proc_pidinfo`/`proc_pidfdinfo` syscalls `lsof` needs — the kernel returns `EPERM` for PIDs outside the sandbox, so `lsof` returns zero rows for host listening sockets. On Linux (network namespaces via `CLONE_NEWNET`), `/proc/net/tcp` is virtualized per namespace — the sandboxed shell sees only its own socket table, not the host's. Same-UID does not bypass MAC or namespace boundaries. `pgrep`/`ps` fail for the same reasons (Seatbelt blocks `process-info*`; `CLONE_NEWPID` hides host PIDs). The only sandbox-surviving liveness signals are filesystem-based: file locks (`flock`/`fcntl`) and Unix domain sockets — both require host-side code changes to implement. This finding superseded the plan's original `lsof`-based approach and replaced it with the fail-safe launcher behavior change.

## Outstanding Questions
- **[user]** Should a permanent automated mirror-sync check (CI `diff` between `.agents/workflows/switchboard.md` and `.claude/skills/switchboard/SKILL.md`, or a single-source-of-truth refactor that generates one from the other) be added to prevent future drift? — proceeding on the assumption that the manual sync check in the Verification Plan is sufficient for this change and that a CI check is a separate, follow-up task.
- **[user]** Should a follow-up plan be created for the host-side file-lock mechanism (`.switchboard/daemon.lock` held via `flock`/`fcntl` by both hosts) to eliminate the stale-port-file false positive? — proceeding on the assumption that the fail-safe approach is sufficient for now and the file-lock mechanism is a separate, follow-up plan.

## Completion Report

Updated Step 1 health-check in both `.agents/workflows/switchboard.md` and `.claude/skills/switchboard/SKILL.md` to fail safe when a port file exists and `curl` returns a non-200 status. The launcher now avoids spawning a second server and overwriting the port file in sandboxed environments where loopback traffic is blocked, falling back to the recorded port with a clear user warning and recovery instruction. The port-reading logic also defensibly trims whitespace (`tr -d '[:space:]'`). No issues were encountered during implementation.
