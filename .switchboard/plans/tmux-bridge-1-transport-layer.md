# tmux Bridge Part 1: Transport Layer

## Goal

Add a tmux transport that implements the existing `TerminalBackend` / `TerminalHandle` seam (`src/services/hostSeams.ts:208-243`), so Switchboard can write text into tmux panes it does not own. This plan delivers the module and its tests **only** — nothing is wired into the host seams, no dispatch path changes, and no behaviour changes for any existing user. Part 2 does the wiring.

### Problem Analysis

**Core problem.** Standalone Switchboard (`npx switchboard`) can only send text to PTYs it spawned itself. The host terminal seam is a deliberate no-op stub:

```ts
// src/standalone/hostServices.ts:323-347
terminal: {
    create: (name) => ({ name, sendText: () => {}, write: () => {}, … }),
    findByName: () => null,
    sendInput: () => false,
    …
}
```

and `vscodeShim.window.createTerminal` throws outright (`src/standalone/vscodeShim.ts:128-130`). So a user running standalone Switchboard alongside their own agent CLIs in tmux has no way to dispatch a prompt into those panes — the only reachable target is a Switchboard-spawned PTY rendered in the browser at `GET /terminals`.

**Root cause.** `vscode.Terminal.sendText` works in the extension host because the extension host *owns the pty* behind the integrated terminal — it holds a writable handle to a child process's stdin. Standalone holds no such handle on an external terminal emulator, and there is no portable OS mechanism to write into an unrelated process's stdin. This is a genuine capability gap, not an unimplemented stub.

**Why tmux specifically.** tmux is the one widely-deployed case where the gap is closable: the tmux *server* owns the pty and exposes a documented control surface (`send-keys`, `load-buffer`, `paste-buffer`) that any process on the same socket can drive. That control surface maps cleanly onto `TerminalHandle`, so the bridge slots in behind an interface that already exists and already has two implementations (`VscodeTerminalBackend`, `PtyTerminalBackend`).

**Why send-only.** `TerminalHandle.onData` / `onExit` have no meaningful tmux implementation without polling `capture-pane` or long-running `pipe-pane` plumbing. That is acceptable: `VscodeTerminalBackend._wrap()` already no-ops `onData`/`onExit`/`resize` (`hostSeams.ts:298-300`) because VS Code exposes no read side either, and Switchboard's completion signal is plan-file mtime advance, not terminal output. A read side is explicitly out of scope for the whole bridge.

## Dependencies

None. This plan adds new files and touches no existing call site.

## Metadata

**Tags:** backend, standalone, terminals, feature
**Complexity:** 6

## User Review Required

One design decision is asserted here rather than asked, and should be confirmed before coding:

**`dispose()` must not kill the pane.** Every other `TerminalBackend` treats dispose and kill as synonyms — `VscodeTerminalBackend.kill()` calls `handle.dispose()` (`hostSeams.ts:271-276`), and `PtyFleetService.disposeAll()` escalates SIGTERM→SIGKILL. For tmux those semantics are wrong: Switchboard did not create the user's pane and must never destroy their shell as a side effect of shutting down or of a `closeTerminal` verb. This plan makes `dispose()` unregister-only and `kill()` the sole destructive path. That asymmetry is intentional and needs to survive review.

## Complexity Audit

### Routine
- `TmuxPane` record type and the `list-panes -F` format string + parser.
- `resize()` → `resize-pane -x/-y`, `show()` → `select-pane` + `select-window`, `kill()` → `kill-pane`.
- Per-pane send serialization — copy the promise-chain lock from `ptyPromptDelivery.ts:9-14` verbatim.

### Complex / Risky
- **Large / multiline payload delivery.** `send-keys -l "<prompt>"` puts the whole prompt in argv, which hits `ARG_MAX` on real dispatch payloads and offers no bracketed-paste framing. The buffer route (`load-buffer` → `paste-buffer -p`) is the correct primitive but adds version-compatibility and temp-file handling.
- **tmux version compatibility.** `load-buffer -` (stdin) landed in tmux 3.2; `paste-buffer -p` in 2.6; `send-keys -H` around 2.4. The module must parse `tmux -V` and degrade, not assume a modern tmux.
- **Command injection surface.** Every invocation takes user- and plan-derived strings (pane titles, prompt bodies, aliases). Any `exec()` with an interpolated string here is a remote-code-execution hole, since prompt bodies come from plan files and HTTP verbs.
- **Availability probing is two-part and time-varying.** Unlike `isPtyAvailable()` (a one-shot native-module load), tmux availability = binary exists *and* a server is currently running. The server can start and stop while Switchboard runs, so a single cached boolean is wrong.
- **`dispose()` ≠ `kill()`** — see User Review Required.

## Edge-Case & Dependency Audit

### Security
- **Argv only, never a shell.** All tmux invocations use `execFile`/`spawn` with an argv array. No `exec`, no `execSync`, no template-literal command strings, no `shell: true`. A prompt body containing `; rm -rf ~` must reach the pane as literal text.
- **Pane-id validation.** Validate every id against `/^%\d+$/` before it reaches a `-t` argument. Never pass a `session:window.pane` string derived from user input as a target — those are re-numberable and parseable by tmux in ways `%id` is not.
- **Prompt bodies transit a temp file.** The `load-buffer <file>` fallback writes plan content to disk. Create with mode `0600` under `.switchboard/tmp/`, and unlink in a `finally` so a throw mid-paste does not leave prompt text readable.
- **Buffer namespacing.** Use a uniquely-named buffer (`switchboard-<pid>-<counter>`) with `paste-buffer -d`. This never touches the user's unnamed buffer stack — the tmux analogue of the clipboard save/restore in `pasteTextViaClipboard` (`terminalUtils.ts:69-102`), but without the mutation.

### Race Conditions
- Two concurrent sends to one pane interleaving their chunks — prevented by the per-pane lock, keyed on `paneId` (not friendly name, which a user can rename mid-send).
- A pane dying between discovery and send — `send-keys` exits non-zero with `can't find pane`. Treat as a normal "terminal not found" failure, not a crash.
- Concurrent `load-buffer` calls colliding on a buffer name — prevented by the per-process counter in the name.

### Side Effects
- `show()` moves the user's tmux focus (`select-pane`/`select-window`). Honour `preserveFocus` by skipping both, matching the `sendRobustText` background-mode contract that focus is never stolen for background work.
- `paste-buffer -p` only emits bracket codes when the pane's foreground application has *requested* bracketed paste mode. A plain `bash` pane gets no brackets, so a multiline payload submits line-by-line — each line running as a shell command. Delivery must flatten newlines when `caps.bracketedPaste` is false (tmux < 2.6). The `isCliAgent` flattening at `terminalUtils.ts:220` is a **terminal-name** check for the VS Code clipboard path — it is not applicable here. The PTY delivery path's `CLI_AGENT_REGEX` was deleted (confirm CR is now unconditional); the tmux path bases its flattening on the tmux version capability, not on a name regex.

### Platform
- **Windows:** no tmux. `isTmuxAvailable()` returns `false`; nothing else runs.
- **WSL:** a tmux server inside WSL is not reachable from a Windows-host node process. Out of scope; do not special-case.
- **Multiple sockets:** `list-panes -a` sees only the default socket. Support `-L <socketName>` / `-S <socketPath>` as a prepended argv prefix so a non-default socket is reachable, but do not attempt cross-socket discovery.

### Dependencies & Conflicts
- No new npm dependency — `child_process` only. tmux is an external binary, probed at runtime, exactly as optional as `node-pty` is (`webpack.config.js:24-26` marks node-pty external; tmux needs no build config at all).
- Does not touch `ptyBackend.ts`, `ptyFleetService.ts`, `ptyPromptDelivery.ts`, or `terminalUtils.ts`. Delivery logic is deliberately duplicated rather than abstracted — the PTY path writes bytes to an fd, the tmux path shells out to a control binary, and forcing them behind one helper would obscure both. Revisit only if a third transport appears.

## Proposed Changes

### Phase 1: `src/standalone/tmuxBackend.ts` (new)

**Registry owner tag** — mirrors `PTY_IDE_NAME` (`ptyFleetService.ts:14`), consumed in Part 2:

```ts
export const TMUX_IDE_NAME = 'switchboard-tmux';
```

**Availability probe** — the single derivation point, mirroring the `isPtyAvailable()` contract pinned by `pty-host-gating-contract.test.js`:

```ts
let _binaryChecked: boolean | null = null;   // immutable once known
let _serverSeenAt = 0;
let _serverLive = false;
const SERVER_PROBE_TTL_MS = 2000;

export async function isTmuxAvailable(socket?: TmuxSocket): Promise<boolean> {
    try {
        if (_binaryChecked === null) {
            await run(['-V'], socket);       // throws if tmux is absent
            _binaryChecked = true;
        }
        if (!_binaryChecked) return false;
        // Server liveness is time-varying — re-probe on a short TTL.
        if (Date.now() - _serverSeenAt > SERVER_PROBE_TTL_MS) {
            try { await run(['list-sessions'], socket); _serverLive = true; }
            catch { _serverLive = false; }
            _serverSeenAt = Date.now();
        }
        return _serverLive;
    } catch {
        _binaryChecked = false;              // never retry a missing binary
        return false;
    }
}
```

The `catch`-to-`false` is mandatory: a throwing probe must never surface as an unhandled rejection on a request path. `Date.now()` is fine here (runtime code, not a workflow script).

**Version gate** — parse once from `tmux -V` (`tmux 3.4` → `[3,4]`) and expose:

```ts
export async function tmuxCaps(socket?: TmuxSocket): Promise<{
    stdinBuffer: boolean;   // load-buffer -   (>= 3.2)
    bracketedPaste: boolean; // paste-buffer -p (>= 2.6)
    hexKeys: boolean;        // send-keys -H    (>= 2.4)
}>
```

Verify each floor against the tmux changelog during implementation — these are the version numbers to confirm, not to trust.

**Invocation helper** — the only place `child_process` is touched:

```ts
function run(args: string[], socket?: TmuxSocket, input?: string): Promise<string> {
    const argv = socket?.name ? ['-L', socket.name, ...args]
               : socket?.path ? ['-S', socket.path, ...args]
               : args;
    // execFile — argv array, no shell, no interpolation.
}
```

**Pane discovery** — `\x1f`-delimited so pane titles containing `|` or `:` cannot corrupt the parse:

```ts
const PANE_FORMAT = [
    '#{pane_id}', '#{session_name}', '#{window_index}', '#{window_name}',
    '#{pane_index}', '#{pane_title}', '#{pane_current_command}',
    '#{pane_current_path}', '#{pane_pid}',
].join('\x1f');

export async function listTmuxPanes(socket?: TmuxSocket): Promise<TmuxPane[]>
// tmux list-panes -a -F '<PANE_FORMAT>'
```

Friendly-name precedence: `pane_title` (user-settable, the natural place to write `coder-1`) → `window_name` → `session:window.pane`. Match callers' names with the same normalization the PTY path uses (`_normalizeAgentKey` / `_stripIdeSuffix` semantics) so `Coder-1` and `coder-1` resolve identically.

**`TmuxTerminalHandle implements TerminalHandle`** — plus a `paneId` member, the way `ExtendedTerminalHandle` extends the base for PTYs:

| Member | Implementation |
|---|---|
| `name` | friendly name (mutable on rename) |
| `paneId` | `%N`, validated `/^%\d+$/` |
| `sendText(text, addNewLine)` | `send-keys -t %id -l <text>`; then `send-keys -t %id Enter` unless `addNewLine === false` |
| `write(data)` | `send-keys -t %id -l <data>` when printable; `send-keys -t %id -H <hex bytes>` when `data` contains `/[\x00-\x1f\x7f]/` and `caps.hexKeys` — this is what makes raw `\x1b[200~` framing reachable |
| `onData(cb)` | no-op disposable — documented, matches `hostSeams.ts:298` |
| `onExit(cb)` | no-op disposable — pane death surfaces via re-discovery |
| `resize(cols, rows)` | `resize-pane -t %id -x <cols> -y <rows>` |
| `dispose()` | **unregister only — never `kill-pane`** |
| `kill()` | `kill-pane -t %id` |
| `show(preserveFocus)` | `select-pane -t %id` + `select-window -t %id`; both skipped when `preserveFocus` |

**`TmuxTerminalBackend implements TerminalBackend`** — `findByName` / `findByNameContains` over `listTmuxPanes()`, `sendInput` / `kill` / `resize` delegating to the resolved handle, `onClose` registering a callback fired by Part 2's reconcile pass (no tmux event stream exists to hook).

`create(name, shellPath?, cwd?)` creates in a dedicated session so Switchboard never injects windows into the user's working session:

```
tmux has-session -t switchboard || tmux new-session -d -s switchboard
tmux new-window -d -t switchboard -n <name> -c <cwd> -P -F '#{pane_id}'
```

`-P -F '#{pane_id}'` prints the new pane id on stdout — the only race-free way to get a handle on what was just created.

### Phase 2: `src/standalone/tmuxPromptDelivery.ts` (new)

Deliberately parallel to `ptyPromptDelivery.ts`, same options shape (`PromptDeliveryOptions`), same `CLI_AGENT_REGEX`, same lock pattern keyed on `paneId`:

```ts
export async function sendPromptToTmux(
    handle: TmuxTerminalHandle,
    text: string,
    opts?: PromptDeliveryOptions
): Promise<void>
```

Sequence inside the per-pane lock:

1. If `opts.clearBeforePrompt`: `send-keys -l '/clear'` + `Enter`, then wait `clearBeforePromptDelayMs ?? 2000`, clamped `0..10000` (identical clamp to `ptyPromptDelivery.ts:30`).
2. Deliver the payload:
   - **Preferred (`caps.bracketedPaste`)** — buffer route, no argv length limit and bracket framing for free:
     ```
     tmux load-buffer -b switchboard-<pid>-<n> <tmpfile>     # or `-` + stdin when caps.stdinBuffer
     tmux paste-buffer -b switchboard-<pid>-<n> -t %id -d -p
     ```
     `-d` deletes the buffer after pasting; `-p` requests bracket codes. Temp file is the primary route (works on tmux ≥ 1.9); stdin is an optimization on ≥ 3.2. Mode `0600`, unlink in `finally`.
   - **Fallback (no bracketed paste)** — when `caps.bracketedPaste` is false (tmux < 2.6, so `paste-buffer -p` is unavailable), flatten newlines to spaces, then chunked `send-keys -l` at 256 bytes / `TMUX_CHUNK_DELAY_MS` (30 ms). The flattening decision is based on the **tmux version capability** (`caps.bracketedPaste`), not on a CLI-agent name regex — the PTY path's `CLI_AGENT_REGEX` was deleted (`pty-prompt-delivery-framing.test.js:357-362` enforces its absence). When `caps.bracketedPaste` is true, the buffer route with `-p` is used and newlines are preserved; if the pane's foreground app did not enable bracketed paste mode, tmux emits no brackets and multiline text submits line-by-line — this is undetectable from outside and documented as a risk below.
3. Settle 100 ms → `send-keys -t %id Enter`.
4. Wait 200 ms → a second `Enter`, **unconditionally** (no name/role/regex gate). This matches the PTY path's current unconditional double-confirm (`ptyPromptDelivery.ts:257-259`). The old `CLI_AGENT_REGEX` gate was deleted — see the Superseded callout below.

Also export `clearTmuxPane(handle)` — the step-1 bytes lifted out for a UI button, under the same lock, mirroring `clearPty` including its swallow-on-dead-pane rationale.

> **Superseded:** "If `CLI_AGENT_REGEX` matches the handle's name **or** role: wait 200 ms → a second Enter. Same double-confirm the PTY and VS Code paths both need (`ptyPromptDelivery.ts:49-52`, `terminalUtils.ts:197-201`)."
> **Reason:** `CLI_AGENT_REGEX` was **deleted** from the codebase. The contract test `pty-prompt-delivery-framing.test.js:357-362` asserts it stays deleted — it tested `handle.name`/`handle.role`, which carry no CLI identity for role-named seats, and the confirm CR is now **unconditional**. Gating the second Enter on a deleted regex would fail to submit on non-allowlisted agent CLIs — the exact bug the deletion fixed.
> **Replaced with:** The second `Enter` is **unconditional** — always send it, no name/role/regex gate. This matches the PTY path's current behaviour (`ptyPromptDelivery.ts:257-259`: unconditional `handle.write('\r')` after `CONFIRM_ENTER_DELAY_MS`). The 200 ms delay between the two Enters is retained.

> **Superseded:** "chunked `send-keys -l` at 256 bytes / 30 ms, matching the PTY pacing constants."
> **Reason:** The PTY path uses `CHUNK_DELAY_MS = 8` (`ptyPromptDelivery.ts:9`), not 30 ms. The 30 ms value was the old VS Code IPC path. Claiming parity with a number from a different transport is misleading. For tmux, each chunk is a separate `execFile` call (orders of magnitude slower than an fd write), so 8 ms would be too aggressive.
> **Replaced with:** Chunk at 256 bytes with a **tmux-specific** delay of 30 ms, justified by the per-chunk `execFile` overhead (not by PTY parity). Name the constant `TMUX_CHUNK_DELAY_MS` so it is not confused with the PTY constant.

> **Superseded:** "wait `clearBeforePromptDelayMs ?? 2000`, clamped `0..10000` (identical clamp to `ptyPromptDelivery.ts:30`)."
> **Reason:** The PTY default is now `DEFAULT_CLEAR_SETTLE_MS = 600` (`ptyPromptDelivery.ts:16`), not 2000, and the PTY path uses a **clear-readiness tracker** (`clearAndAwaitReadinessLocked`) that waits for the CLI's actual re-render signal via `onData`. The tmux path is send-only (no `onData`), so it cannot use the readiness tracker — a fixed delay is the only option. This is a **functional gap**, not a parity claim.
> **Replaced with:** Use `clearBeforePromptDelayMs ?? 2000` with the same `0..10000` clamp. The 2000 ms default is **tmux-specific** — the `/clear` command goes through `send-keys` (external process) and the pane re-renders without a readiness signal, so a conservative default is warranted. Acknowledge explicitly: the tmux path cannot use the PTY clear-readiness tracker because it has no `onData` stream; a fixed delay is an inherent limitation of the send-only design.

### Phase 3: `src/test/tmux-backend-contract.test.js` (new)

Contract tests in the style of the existing `pty-*-contract.test.js` files:

1. **`isTmuxAvailable()` is the single derivation point** and swallows every failure mode (missing binary, no server, EACCES on the socket) → `false`, never throws. Mirrors `pty-host-gating-contract.test.js`.
2. **No shell interpolation** — static assertion over `tmuxBackend.ts` and `tmuxPromptDelivery.ts`: no `exec(`, no `execSync(`, no `shell: true`, no backtick-containing `child_process` call.
3. **Pane-id validation** — `/^%\d+$/` is enforced before any `-t` argument; feeding `%1; kill-server` is rejected, not passed through.
4. **`dispose()` never kills** — assert no `kill-pane` on the dispose path, and that `kill()` does issue it.
5. **Delivery shape** — a mocked `run()` records argv: bracketed-paste path uses both `-p` and `-d`; buffer names are unique across concurrent sends; a temp file created for `load-buffer` is unlinked even when `paste-buffer` throws.
6. **Newline flattening** — when `caps.bracketedPaste` is false, the fallback path delivers a payload containing no `\n` (flattened to spaces). When `caps.bracketedPaste` is true, the buffer route preserves newlines.
7. **Submit shape** — a trailing `Enter`, then exactly **two** Enters **unconditionally** (no name/role/regex gate). This mirrors the PTY path's unconditional double-confirm (`ptyPromptDelivery.ts:257-259`), not the deleted `CLI_AGENT_REGEX` gate.

## Files Changed

- `src/standalone/tmuxBackend.ts` — **new.** `TMUX_IDE_NAME`, `isTmuxAvailable()`, `tmuxCaps()`, `listTmuxPanes()`, `TmuxTerminalHandle`, `TmuxTerminalBackend`.
- `src/standalone/tmuxPromptDelivery.ts` — **new.** `sendPromptToTmux()`, `clearTmuxPane()`.
- `src/test/tmux-backend-contract.test.js` — **new.** Contract tests above.

No existing file is modified.

## Verification Plan

Manual verification needs a real tmux session; the contract tests cover the rest.

1. **Probe, no tmux** — `PATH` without tmux → `isTmuxAvailable()` resolves `false`, no throw, no stderr noise.
2. **Probe, tmux installed but no server** — `tmux kill-server` first → resolves `false`; start a session → resolves `true` within the 2 s TTL without a process restart.
3. **Discovery** — three panes across two sessions, one with `pane_title` set to `coder-1` → `listTmuxPanes()` returns all three with correct `%id`s; the titled one has friendly name `coder-1`.
4. **Short send** — `sendText('echo hi', true)` into a `bash` pane → `hi` appears. Confirms argv literal-mode plumbing.
5. **Injection-safe send** — `sendText('; touch /tmp/pwned', true)` into a pane where the foreground app is `cat` → the literal text appears, `/tmp/pwned` does not exist.
6. **Large multiline prompt into a CLI agent** — a real ~8 KB dispatch prompt into a pane running `claude` → arrives as one atomic paste, newlines preserved, submitted once, no fragment execution. This is the case the whole plan exists for.
7. **Large multiline prompt into bash** — same payload into a plain shell → newlines flattened to spaces, one command line, no line-by-line execution.
8. **Concurrent sends** — two 8 KB payloads to the same pane simultaneously → no interleaving; second waits. Then to two different panes → both proceed concurrently.
9. **`dispose()` safety** — resolve a handle on a user's pane, call `dispose()` → pane still alive. Call `kill()` → pane gone.
10. **Dead pane mid-send** — `kill-pane` between resolution and send → rejects with a not-found-shaped error, no unhandled rejection.
11. **Temp-file hygiene** — during a large paste, `.switchboard/tmp/` entry is mode `0600`; after completion and after a forced `paste-buffer` failure, no file remains.
12. **Buffer hygiene** — `tmux list-buffers` before and after a send is unchanged (no `switchboard-*` residue, user's unnamed stack untouched).
13. **Non-default socket** — a server on `-L alt` is discoverable when the socket is configured and invisible when it is not.

### Automated Tests

The seven contract tests in Phase 3, run under the existing test harness. All use a mocked `run()` — no test requires a live tmux server, so CI stays green on machines without tmux. Add one integration test guarded on `isTmuxAvailable()` that skips cleanly when tmux is absent.

## Risks

- **Version floors are asserted from memory.** The `3.2` / `2.6` / `2.4` floors for `load-buffer -`, `paste-buffer -p` and `send-keys -H` must be confirmed against the tmux changelog before relying on them. Guessing high strands users on older tmux; guessing low produces cryptic `unknown option` failures.
- **Bracketed paste is the pane's choice, not ours.** `paste-buffer -p` is a request. If a CLI agent does not enable bracketed paste mode, a multiline prompt submits line-by-line and the agent runs fragments — the exact failure the PTY path's framing exists to prevent. The newline-flattening fallback bounds the damage but degrades prompt fidelity; there is no way to *detect* the pane's bracketed-paste state from outside.
- **`send-keys -l` and control bytes.** Literal mode is specified for printable text; behaviour with embedded ESC varies by version, which is why `write()` routes control bytes through `-H`. If `-H` is unavailable on a target version there is no clean path for raw framing — fall back to the buffer route and accept it.
- **Temp files carry plan content.** A crash between create and unlink leaves prompt text on disk at `0600`. Acceptable, but the `finally` is load-bearing, not defensive decoration.
- **Duplicated delivery logic.** `tmuxPromptDelivery.ts` intentionally mirrors `ptyPromptDelivery.ts`. A future fix to the pacing/framing sequence must be applied to both, and nothing enforces that. The contract tests are the only coupling; keep their assertions parallel.
- **No clear-readiness tracker.** The PTY path uses `clearAndAwaitReadinessLocked` to wait for the CLI's actual re-render signal after `/clear`. The tmux path is send-only (no `onData`), so it cannot use this tracker — a fixed delay is the only option. This is an inherent limitation of the send-only design, not a parity gap that can be closed.

## Adversarial Synthesis

Key risks: (1) stale `CLI_AGENT_REGEX` references that would gate the confirm Enter on a deleted regex — corrected to unconditional; (2) tmux version floors asserted from memory that must be confirmed against the changelog; (3) bracketed paste is the pane's choice and undetectable from outside, so multiline prompts into non-bracketed panes submit line-by-line. Mitigations: unconditional double-confirm CR (matching the PTY path's current behaviour), `caps.bracketedPaste`-based flattening decision, temp-file `finally` cleanup, and contract tests that pin the corrected shapes.

## Uncertain Assumptions

The following are external facts about tmux's version history that cannot be confirmed from the codebase. The user was advised to run web research to confirm them before implementation:

- **tmux version floors:** `load-buffer -` (stdin) requires ≥ 3.2; `paste-buffer -p` requires ≥ 2.6; `send-keys -H` requires ≥ 2.4. These are asserted from memory and must be verified against the tmux changelog. Guessing high strands users on older tmux; guessing low produces cryptic `unknown option` failures.

## Recommendation

**Complexity: 6 → Send to Coder**

Self-contained new module against an interface that already exists and already has two implementations, with no call-site changes and no user-visible behaviour. The difficulty is concentrated in subprocess hygiene, version degradation, and the injection surface — all of which the contract tests can pin. The one judgement call needing sign-off is the `dispose()` / `kill()` asymmetry.
