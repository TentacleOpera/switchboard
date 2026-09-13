# A Seat's pty Inherits `TERM`, So the Fleet Depends on Who Launched the Board

## Goal

Set a valid `TERM` on every pty the host creates, instead of passing along whatever the process that
started the board happened to have. A seat's ability to run should not depend on how the board was
launched.

### Problem analysis

**Reproduced verbatim.** A tmux client attaching with `TERM` unset fails with exactly the error an
operator sees when starting a team:

```
TERM=<unset>          -> open terminal failed: terminal does not support clear
TERM=dumb             -> open terminal failed: terminal does not support clear
TERM=nonexistent-term -> missing or unsuitable terminal: nonexistent-term
TERM=xterm-256color   -> attaches fine
```

The failing call is the tail of the seating command — `exec tmux attach -t ${view}`
(`goPtyFleetProjection.ts`) — which attaches a *client*, and a client needs a terminfo entry.
`tmux new-session -d` does not, which is why the fault is invisible until a seat actually starts.

**The pty inherits the host's environment wholesale.** `ptyFleetService.ts:545`:

```ts
env: { ...claudeEnvDefaults, ...process.env, ...switchboardEnv }
```

`switchboardEnv` sets `SWITCHBOARD_TERMINAL` and friends (`:497`); the Go host does the same
(`cmd/switchboard-pty-host/main.go:151`). Neither sets `TERM`. So `TERM` arrives from `process.env`
— that is, from whoever started the board.

**Which means the fleet works or fails by launcher:**

| launched from | `TERM` | tmux seats |
|---|---|---|
| an interactive terminal | real value | work |
| inside tmux | `tmux-256color` | work |
| a systemd unit | **unset** | fail |
| cron, or an agent's tool shell | **unset** | fail |

Observed live on 2026-09-10: a host started from a non-interactive shell had `TERM` empty in
`/proc/<pid>/environ`, and every team start failed with the message above. The same board had been
starting teams for agents without error all day, because it had been launched from a terminal — who
*initiates* a start is irrelevant, only who launched the **host** matters.

**And this blocks the obvious next step.** A systemd unit for the board — the fix for "nothing brings
LABCOM back after a reboot" — has no `TERM` either, so it would break every tmux seat on the first
boot after being installed.

### Architecture note: the TS fleet is retired

The `ptyFleetService.ts:545` env spread quoted above is **retired code** — no production path
executes it. `src/test/pty-host-gating-contract.test.js:90-91` asserts that neither composition root
constructs `PtyFleetService`:

```js
assert.ok(!bootstrap.includes('new PtyFleetService('), 'standalone still constructs Node fleet');
assert.ok(!extension.includes('new PtyFleetService('), 'extension constructs Node fleet');
```

`src/standalone/ptyHost.ts` is a 7-line stub that throws. Both the extension (`extension.ts` via
`TaskViewerProvider` → `PtyHostSupervisor`) and the standalone (`bootstrap.ts:3891` via
`GoPtyFleetProjection` → `PtyHostSupervisor`) delegate pty creation to the same Go binary
(`cmd/switchboard-pty-host/main.go`). The fix lands in **one place** and serves both hosts — there is
no divergence risk because both roots share the same Go child.

## Metadata

**Complexity:** 3
**Tags:** bugfix, reliability
**Dependencies:** none.

## User Review Required

None.

## Complexity Audit

### Routine
- Single-file change in the Go pty host (`cmd/switchboard-pty-host/main.go`).
- Setting an env var in the pty's environment — a well-understood pattern.
- Both composition roots (extension and standalone) delegate to the same Go binary, so one fix serves both — no second site to touch.

### Complex / Risky
- **Env deduplication (Go).** `os.Environ()` returns a `[]string`. A naive `append(env, "TERM=xterm-256color")` does NOT override an existing `TERM=dumb` — in `execve`, the first occurrence wins and `getenv` returns it. The fix must strip any existing `TERM=` entry before appending, or build the env via a map that deduplicates by key.
- **Terminfo validation.** No Go terminfo library is vendored (`go.mod` has only `creack/pty` and `gorilla/websocket`). Validating whether a `TERM` value resolves requires either shelling out to `infocmp` or checking terminfo database paths (`/usr/share/terminfo/<first-char>/<term>`, `/lib/terminfo/...`). The validation must degrade gracefully if `infocmp` is absent.

## Edge-Case & Dependency Audit

### Race Conditions
- None. `TERM` is resolved once at startup (or on first seat creation) before any pty spawns. No concurrent access to the decision.

### Security
- No security implications. `TERM` is a terminal capability descriptor, not a credential or routing value.

### Side Effects
- Overriding an operator's deliberately-set `TERM` (e.g. `TERM=vt100` for a specific workflow) would change behaviour. The validate-then-substitute approach preserves valid inherited values, mitigating this. Only invalid or absent values are replaced.

### Dependencies & Conflicts
- `infocmp` (from `ncurses-bin`) is the cleanest terminfo validator. If absent, fall back to checking terminfo database file paths directly. If neither is available, assume the inherited value is valid — the default `xterm-256color` is itself verified at startup, so the worst case is keeping a value that might be wrong, not substituting a known-broken one.
- The default `xterm-256color` must itself resolve in terminfo. If it doesn't (a stripped-down system), the host must **fail loudly** (per the CLAUDE.md fallback rule) rather than silently substituting one broken value for another.

## Dependencies

None.

## Adversarial Synthesis

Key risks: (1) a naive `append(env, "TERM=xterm-256color")` does NOT override an existing `TERM` in `os.Environ()` because first occurrence wins in `execve` — the inherited `TERM=dumb` silently persists and the fix is invisible; (2) the original plan's "both hosts" framing targets a retired code path (`ptyFleetService.ts:545`) that no production path executes, which would waste effort and mask the single live fix site; (3) the default `xterm-256color` must itself be verified, or the fix substitutes one broken value for another. Mitigations: strip any existing `TERM` before appending; fix only the Go host; verify the default resolves at startup and fail loudly if it doesn't.

## Proposed Changes

### 1. Set `TERM` when creating a pty in the Go host

- **Logic:** default `TERM` to a known-good value in the pty's environment rather than inheriting it.
  `xterm-256color` is present on a stock Pi OS and is the safe choice; keep an inherited value only if
  it resolves in terminfo.
- **Where:** `cmd/switchboard-pty-host/main.go:146-151`. The `create` function currently does:

  ```go
  env := os.Environ()
  // ...
  env = append(env, "SWITCHBOARD_TERMINAL="+name, "SWITCHBOARD_AGENT_INSTANCE_ID="+agentID)
  ```

  Neither `TERM` nor any deduplication is applied. The fix must:
  1. Resolve the effective `TERM` once (at startup or on first call) — see change 2.
  2. Strip any existing `TERM=` entry from `env` before appending the effective value. A helper that
     filters `os.Environ()` by prefix is the cleanest shape:

     ```go
     func withoutEnvKey(env []string, key string) []string {
         prefix := key + "="
         out := env[:0]
         for _, e := range env {
             if strings.HasPrefix(e, prefix) { continue }
             out = append(out, e)
         }
         return out
     }
     ```

  3. Append `"TERM=" + effectiveTerm` after stripping.

  This is the critical implementation detail: **without stripping, the append is a no-op against an
  inherited `TERM=dumb`** because `execve` resolves the first occurrence.

> **Superseded:** `ptyFleetService.ts:545` (the `env` spread) and `cmd/switchboard-pty-host/main.go:151`, which already assembles `SWITCHBOARD_TERMINAL` and can set `TERM` in the same place.
> **Reason:** The plan's original "both hosts" framing assumed both the TS fleet (`ptyFleetService.ts`) and the Go host are live pty-creation paths. They are not. The TS `PtyFleetService` class is retired — `pty-host-gating-contract.test.js:90-91` asserts neither composition root constructs it, `ptyHost.ts` is a 7-line stub that throws, and both roots delegate to the Go binary via `PtyHostSupervisor`. Fixing `ptyFleetService.ts:545` would modify dead code: no production path executes that `create()` method. The file survives only as a source of TypeScript type exports (`CreateOptions`, `ExtendedTerminalHandle`, etc.) consumed by `goPtyFleetProjection.ts`.
> **Replaced with:** Fix only `cmd/switchboard-pty-host/main.go:146-151`. One fix site serves both the extension and the standalone because both roots spawn the same Go binary. The `ptyFleetService.ts:545` env spread may optionally be updated for defense-in-depth (if the class is ever un-retired), but it is not a required change and should not be treated as a live fix site.

### 2. Validate rather than assume

- **Logic:** if an inherited `TERM` does not resolve in terminfo, replace it and say so once at
  startup. `TERM=dumb` and `TERM=nonexistent-term` both fail, differently, and neither message names
  `TERM`.
- **Implementation:** at startup in `main()` (or lazily on first `create` call), resolve the effective
  `TERM`:
  1. Read `os.Getenv("TERM")`.
  2. If non-empty, validate it by shelling out to `infocmp <term>` (exit 0 = resolves). If `infocmp`
     is unavailable, check for the terminfo database file at
     `/usr/share/terminfo/<term[0]>/<term>` or `/lib/terminfo/<term[0]>/<term>`.
  3. If the inherited `TERM` resolves, keep it. If it doesn't (or is empty or `dumb`), substitute
     `xterm-256color`.
  4. Verify the substitute itself resolves (same check). If it doesn't, **fail loudly** — `log.Fatal`
     with a message naming both the inherited value and the missing default.
  5. Log the decision once: `effective TERM=<value> (inherited|substituted from <original>)`.
- **Store** the effective `TERM` as a field on `fleet` (e.g. `f.effectiveTerm`) so `create` can use it
  without re-validating per seat.

### 3. Log the effective `TERM` for diagnostics

- **Logic:** `open terminal failed: terminal does not support clear` names neither `TERM` nor the
  board. This cost an hour of misdiagnosis; the message is the whole reason.
- **Reframed approach:** the tmux error is printed to the pty's output stream — the Go host cannot
  easily intercept and augment it without fragile pattern-matching. Instead, the startup log line
  from change 2 (naming the effective `TERM` and whether it was substituted) gives the operator the
  diagnostic context. With the fix in place, the attach failure due to `TERM` should not occur at
  all; the log line is the defence-in-depth for any residual failure.
- **Where:** `cmd/switchboard-pty-host/main.go`, in `main()` after the `TERM` resolution, before the
  ready handshake (line 619). The existing `fmt.Printf` ready line is the natural neighbour.

## Verification Plan

### Automated Tests

- A host started with `TERM` unset still spawns working tmux seats.
- A host started with `TERM=dumb` likewise, and logs that it substituted a default.
- A host started from an interactive terminal keeps that terminal's `TERM`, unchanged.
- A seat that cannot attach reports its `TERM` in the failure.
- Regression guard: assert the pty env contains a `TERM` that resolves in terminfo, in both hosts.
- Contract guard: `cmd/switchboard-pty-host/main.go` `create` function strips any inherited `TERM`
  before appending the effective value (no duplicate `TERM=` entries in `cmd.Env`).

### Goal Invariants

- Assert `cmd/switchboard-pty-host/main.go` contains a `TERM=` assignment in the `create` function's
  env assembly (the env built for `cmd.Env`).
- Assert `cmd/switchboard-pty-host/main.go` does NOT pass `os.Environ()` through to `cmd.Env` without
  stripping an existing `TERM` entry — i.e., a `withoutEnvKey(env, "TERM")` call (or equivalent
  deduplication) precedes the `TERM=` append.
- Assert the `TERM` value set is neither empty nor `dumb` in the default path.
- Assert `ptyFleetService.ts:545` is NOT the only fix site — the Go host's `create` function carries
  the fix, not the retired TS fleet.

## Resolved Assumptions

- **`xterm-256color` (not `screen-256color`) is the correct default.** The pty is an xterm-compatible
  terminal (rendered by xterm.js in the board, or by an SSH client's terminal over SSH). The `TERM`
  on the pty describes the pty itself, not the tmux session inside it. `tmux attach` reads `TERM` to
  know how to talk to the pty — `xterm-256color` accurately describes an xterm.js pty. Inside the tmux
  session, tmux sets its own `TERM` (`screen-256color` or `tmux-256color`) for programs running in the
  session; that is tmux's job, not the pty's. `screen-256color` would describe a terminal running
  inside screen/tmux, which the pty is not. `xterm-256color` is also the more widely present terminfo
  entry across distributions.
- **The TS `PtyFleetService` is retired.** Verified by `pty-host-gating-contract.test.js:90-91`,
  `ptyHost.ts` (7-line stub), and the absence of `new PtyFleetService(` in both composition roots. The
  fix targets the Go host only.
