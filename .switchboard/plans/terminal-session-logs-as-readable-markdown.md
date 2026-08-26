# Terminal session logs as readable markdown documents

## Goal

Persist each terminal session as a markdown document and let a button in the terminal frame open it full-screen in the existing docs viewer, with a sidebar for browsing other sessions' logs — so terminal history stops being bounded by a replay buffer sized for something else.

### Problem Analysis

**One undersized buffer is doing two incompatible jobs.** `MAX_SCROLLBACK_BYTES = 256 * 1024` (`terminalWsGateway.ts:5`) is a per-terminal in-memory ring, replayed when a client attaches. As an attach mechanism the small size is correct: opening a multi-pane grid replays every pane at once, so the cap is really a bound on attach cost — most acute over the tunnelled link the remote setup depends on. As a *history* mechanism it is far too small, and raising it makes the attach burst worse. The two goals pull in opposite directions, which is why the current value satisfies neither.

**And the ring is lossy by design in ways already worked around.** The DEC private-mode tracking exists precisely because *"the ring cannot be relied on to carry the last transition: it evicts at MAX_SCROLLBACK_BYTES, so an enable can outlive its own reset inside the replay."* Mouse-mode state had to be tracked separately to survive a reattach the ring could not cover. That is a buffer being asked for durability it cannot provide.

**History is also destroyed on the normal path.** `queue/done` clears a member's terminal by design — the standing-order text in `teamWiring.ts:322-349` instructs the seat to POST `queue/done`, which calls `clearTerminalContext` (`LocalApiServer.ts:2488-2490` for kanban seats, `:3000-3002` for team seats), so on the ordinary completion route the record of how the work went is gone. Nothing writes it anywhere first.

> **Superseded:** `queue/done` clears a member's terminal by design (`teamWiring.ts:318`)
> **Reason:** Line 318 is `return next;` — the clearing is described in the standing-order comments at `teamWiring.ts:322-349` but executed via the `clearTerminalContext` callback in `LocalApiServer.ts`, not in `teamWiring.ts` at all. The original citation pointed at the wrong file and line.
> **Replaced with:** `queue/done` clears a member's terminal by design — the standing-order text in `teamWiring.ts:322-349` instructs the seat to POST `queue/done`, which calls `clearTerminalContext` (`LocalApiServer.ts:2488-2490` for kanban seats, `:3000-3002` for team seats).

**Nothing logs pty output to disk today.** A grep for `appendFile` / `createWriteStream` across the standalone host finds a rotation-aware line logger in `cli.ts:212-223` — *"reopened on every line via `appendFileSync`, so rotation never loses the…"* — but nothing tees terminal output.

**The volume problem is real and is not solved by existing coalescing.** `OUTPUT_FLUSH_MS = 6` (`terminalWsGateway.ts:91`) joins node-pty's many tiny reads into one frame, which the comment is explicit about: *"One flush per window collapses that into a single frame, a single scrollback entry, and a single backpressure check."* (`terminalWsGateway.ts:84-86`). That is a rendering optimisation. It does **not** collapse redraws — a spinner rewriting one line still emits every version — so a naive tee produces megabytes representing a few dozen useful lines.

**Both halves of the presentation already exist.** `renderMarkdown` is a shared renderer (`sharedUtils.js:122`) with its own contract test, and `tickets.html` implements the sidebar-list-plus-detail layout — `#tree-pane` inside a `.content-row` with a `.sidebar-toggle-row` and a `collapsed` state (`:364-366`) — the same pattern the Mission Control panel spec reuses rather than reinventing. And the mission-control spec already specifies this exact interaction for schedules: a **Logs** control that *"switches the content view to the log markdown file, with a link to it."* (`mission-control-panel-ui-specification.md:184`).

### Root Cause

Terminal output was treated as a stream to render, never as a record to keep. Everything downstream therefore reads from the only place it exists — an in-memory ring whose size is set by rendering concerns — and every durability need since (mode state, completion evidence, "what did that agent actually do") has been met by working around the ring rather than by writing the stream down.

## Metadata

**Complexity:** 6
**Tags:** feature, frontend, backend, devops

## User Review Required

Yes — this plan introduces a new durable record of terminal output (including secrets that pass through agent terminals). The security posture (gitignored by default, authenticated route, never negated in `.gitignore`) is documented below but the user should confirm the threat model is acceptable before implementation proceeds.

## Settled Design

- **Markdown on disk, one document per terminal session**, under `.switchboard/logs/`.
- **ANSI is stripped.** A markdown document rendered by the docs viewer cannot carry escape sequences, so colour and TUI structure are deliberately lost here. The live terminal remains the place for those; the log is for reading.
- **Carriage-return redraws are collapsed at write time** — only the final state of a rewritten line is kept. Mandatory rather than optional: a document made of spinner frames is unreadable, and the bloat is almost entirely here.
- **Dispatch boundaries become headings.** The delivery layer knows when it injects a prompt, so each delivery opens a `##` section. That turns a session from an undifferentiated stream into a navigable document with an outline.
- **The ring buffer is left alone.** It keeps its job and its size; this plan removes the pressure to grow it.
- **Retention is deferred** to `retention-and-archive-for-unbounded-growth.md`; the writer rotates, the policy lives there.

## Complexity Audit

### Routine

- Teeing pty output to a rotating per-terminal file, following the `cli.ts:212-223` append-and-reopen pattern.
- A button in the terminal frame that opens the log view.
- Reusing `renderMarkdown` and the `.content-row` / `#tree-pane` sidebar layout.

### Complex / Risky

- **Agent output contains code fences, and they will break the document.** Coding agents print ```` ``` ```` constantly, so wrapping raw output in a fenced block is broken by construction on roughly the first interesting line. Use a longer fence than anything in the payload, or escape at write time. This is the single most likely defect and it will look like "the log renders fine until it doesn't".
- **Chunk boundaries must not split a character.** The gateway already holds this discipline for frames — `MAX_FLUSH_BYTES` (`terminalWsGateway.ts:100`), *"Whole chunks only — never split one — so a surrogate pair can't be cut across two separately-UTF-8-encoded payloads"* (`terminalWsGateway.ts:96-97`) — and the log writer needs the same rule, plus a carry for a partial CR-collapse run across a flush.
- **`renderMarkdown` on a large document will choke the viewer.** Serve tail-first with ranged reads and paginate; do not hand the renderer a multi-megabyte string. This is the same attach-burst mistake one layer up, and the reason for the cap this plan exists to route around.
- **A durable on-disk log is a new place secrets land.** Agent terminals echo tokens, env and paths. `.gitignore:60` is `.switchboard/*` with explicit `!` negations for `reviews/`, `plans/`, `features/`, `sessions/` and three files (`CLIENT_CONFIG.md`, `README.md`, `SWITCHBOARD_PROTOCOL.md`) — so `.switchboard/logs/` is ignored **by default** and needs no gitignore change. The hazard is the opposite direction: nobody may add a negation for it, and the route serving it must sit behind the same auth as everything else. State both, because "we didn't have to touch .gitignore" reads like the question was never asked.

> **Superseded:** `.gitignore:52` is `.switchboard/*` with explicit `!` negations for `reviews/`, `plans/`, `features/`, `sessions/` and two files
> **Reason:** The `.switchboard/*` glob is at line 60, not 52. There are three negated files (`CLIENT_CONFIG.md`, `README.md`, `SWITCHBOARD_PROTOCOL.md`), not two — `SWITCHBOARD_PROTOCOL.md` was added later and the count drifted.
> **Replaced with:** `.gitignore:60` is `.switchboard/*` with explicit `!` negations for `reviews/`, `plans/`, `features/`, `sessions/` and three files (`CLIENT_CONFIG.md`, `README.md`, `SWITCHBOARD_PROTOCOL.md`).

- **Stripping ANSI is a real loss, so do not oversell the log as a terminal replacement.** A TUI-heavy session renders as a mess of positioning artefacts even with CR-collapse. The log answers "what happened"; the terminal answers "what does it look like now".
- **Session boundaries need defining.** `queue/done` clears a terminal but the process lives on — so is that one session or two? A cleared terminal starting fresh work is a new session to a reader, and rolling the file there is what makes the document match what the user thinks they are reading.
- **Two-host parity: the hook points must be shared, not host-specific.** `TerminalWsGateway` is constructed in both hosts — in-process at `bootstrap.ts:2722` (standalone) and in the pty-host child at `ptyHost.ts:45` (extension) — so the output tee lives in the gateway and reaches both hosts automatically. But the heading-write hook on prompt delivery must go in `sendPromptToPty` (`ptyPromptDelivery.ts`, imported by both `bootstrap.ts` and `ptyHost.ts`), NOT in `deliverPrompt` (`bootstrap.ts:257`, standalone-only). Hooking in `deliverPrompt` would leave the extension host with no headings — the exact composition-root divergence the project rules forbid.

## Edge-Case & Dependency Audit

**Migration.** None. New files in an already-ignored directory; nothing existing changes shape. Sessions before this ships simply have no log.

**Security.** A new durable record of terminal output. Ignored by git by default, served only through the authenticated route, and never negated in `.gitignore`. Worth an explicit test on the auth gate rather than assuming the route inherits it.

**Side effects.** Disk growth per terminal per session, bounded by rotation. Write cost is one append per flush window, on a path that already coalesces at 6 ms — so the write rate is the flush rate, not the node-pty read rate.

**Ordering.** Independent. It reduces the pressure to raise `MAX_SCROLLBACK_BYTES`, so it should land before anyone tunes that constant.

**Race conditions.** The flush path is shared across all terminals via a single `setInterval` (`terminalWsGateway.ts:535`). The log writer must not block the flush — if `appendFileSync` stalls on a slow disk, every terminal's output stalls. Use an async write queue per terminal, or accept that the log write is fire-and-forget (a lost flush window is a few ms of output, not a crash). The existing `cli.ts` logger uses `appendFileSync` on the console path, which is already blocking and acceptable there because console volume is low; terminal output volume is orders of magnitude higher, so the blocking trade-off is different.

**Dependencies & conflicts.** No existing code writes to `.switchboard/logs/`. The `cli.ts` logger writes to `.switchboard/logs/server.log` — the per-terminal logs must use a different naming scheme (e.g. `<terminal-name>-<session-id>.md`) to avoid collision with the server log.

## Dependencies

- **Reuses** `renderMarkdown` (`sharedUtils.js:122`) and the `tickets.html` sidebar-list-plus-detail layout.
- **Retention deferred to** `retention-and-archive-for-unbounded-growth.md`.
- **Aligns with** `mission-control-panel-ui-specification.md`, whose schedules tab already specifies a Logs control that switches the content view to a log markdown file — the same interaction, so the two should look alike.
- **Helps** `completion-is-asserted-never-inferred.md`: a halt reason recorded on the state can point at a log that still exists after the terminal is cleared.

## Adversarial Synthesis

Key risks: (1) the heading-write hook placed in `deliverPrompt` (standalone-only) instead of `sendPromptToPty` (shared), silently leaving the extension host with no document outline — the exact composition-root divergence the project rules forbid; (2) `renderMarkdown` handed a multi-megabyte string because the ranged-read endpoint was added but the viewer wasn't wired to paginate, repeating the attach-burst mistake one layer up; (3) `appendFileSync` on the flush path blocking all terminals when disk I/O stalls. Mitigations: name the shared hook points explicitly, wire the viewer to request tail-first ranged reads, and use a per-terminal async write queue that never blocks the flush interval.

## Proposed Changes

### `src/standalone/terminalWsGateway.ts` — tee pty output to per-terminal markdown

**Context.** The gateway's `flushAllPending` / `flushOutput` path (`terminalWsGateway.ts:532-570`) is where coalesced output is committed to the scrollback ring and shipped to WS clients. This is the single tap point for the output tee — it already holds the whole-chunk discipline (`MAX_FLUSH_BYTES`, `:100`) and the flush window (`OUTPUT_FLUSH_MS = 6`, `:91`). The gateway is constructed in both hosts (standalone: `bootstrap.ts:2722`; extension: `ptyHost.ts:45`), so a tee hook here reaches both automatically.

**Logic.** Add a `LogWriter` class (new file `src/standalone/terminalLogWriter.ts`) that:
- Receives flushed output chunks per terminal name.
- Strips ANSI escape sequences (CSI, OSC, charset designation, simple escapes — a comprehensive regex, no `strip-ansi` dependency).
- Collapses carriage-return redraws: for each line, tracks the last `\r`-overwritten state and keeps only the final version. A carry buffer holds a partial CR-collapse run across flush boundaries.
- Writes to `.switchboard/logs/<terminal-name>-<session-id>.md` using the `appendFileSync`-and-reopen pattern from `cli.ts:225`, or an async write queue per terminal to avoid blocking the shared flush interval.
- Escapes or fences agent-printed code blocks: use a fence longer than any fence in the payload (scan for the longest ```` ```+ ```` run and add one backtick), or escape backtick fences at write time.

**Implementation.**
- Add `onFlush(cb: (terminal: string, data: string) => void): void` to `TerminalWsGateway` — a flush observer, same pattern proposed by `pty-screen-state-idle-detection-headless-vt.md`. The `LogWriter` subscribes to it.
- In `flushOutput`, after appending to the scrollback ring, invoke registered flush observers with the terminal name and the coalesced chunk.
- The `LogWriter` is constructed and subscribed in both `bootstrap.ts` (after the gateway is created, `:2722`) and `ptyHost.ts` (after the gateway is created, `:45`).

**Edge cases.**
- Partial UTF-8 across flush boundaries: the gateway already guarantees whole chunks (`:96-97`), but the CR-collapse carry must also not split a character.
- Terminal rename: the `LogWriter` must rekey on rename, same as `rekeyTerminal` (`terminalWsGateway.ts:737-750`). Subscribe to the fleet's `renamed` event.
- Terminal close: flush and close the log file handle. Subscribe to the fleet's `closed` event.
- Session boundary on `queue/done` clear: roll the file (close current, start new session ID) when `clearTerminalContext` fires. This requires a hook in `LocalApiServer._runQueueDone` or in the `clearTerminalContext` callback itself.

### `src/standalone/ptyPromptDelivery.ts` — write `##` heading on prompt delivery

**Context.** `sendPromptToPty` is the shared function imported by both `bootstrap.ts:41` and `ptyHost.ts:10`. It is the sole chokepoint for prompt delivery in both hosts. The standalone-only `deliverPrompt` (`bootstrap.ts:257`) wraps it but is NOT shared — hooking there would leave the extension host with no headings.

**Logic.** Before writing the prompt to the pty, call the `LogWriter` to emit a `## ` heading with a timestamp and a truncated version of the prompt's first line. This gives the document an outline keyed to dispatch boundaries.

**Implementation.**
- Add an optional `onPromptDelivered?: (terminalName: string, promptText: string) => void` callback to `sendPromptToPty`'s options, or export a separate `notifyPromptDelivered` function that `sendPromptToPty` calls.
- The `LogWriter` registers as the callback in both hosts.
- The heading text: `## <ISO timestamp> — <first 80 chars of prompt, single line>`. Truncate at 80 chars to match the existing `slice(0, 80)` pattern in `PlanIngestionEngine.ts`.

**Edge cases.**
- A bare `/clear` or `/model` command is also a prompt delivery — should it open a heading? Yes: it is a dispatch boundary, and the reader benefits from knowing when context was reset. Label it accordingly (e.g. `## <timestamp> — /clear`).
- A prompt delivered to a terminal with no active log (pre-feature sessions, or a terminal created before the writer was wired) is a no-op — the `LogWriter` checks for an active session file before writing.

### `src/services/LocalApiServer.ts` — ranged tail endpoint for log reads

**Context.** No HTTP byte-range pattern exists in `LocalApiServer` today (the `Range` matches are git revision ranges, not HTTP byte ranges). This is a new endpoint pattern. The endpoint must sit behind the same auth as every other route.

**Logic.** Add `GET /terminals/:name/log?tail=<bytes>&offset=<bytes>` (or similar) that:
- Reads the tail of the log file (last N bytes) using `fs.createReadStream` with `{ start, end }`.
- Returns the content as `text/markdown` with a `Content-Range` header indicating the byte range served.
- Defaults to a reasonable tail size (e.g. 256 KB) to avoid handing `renderMarkdown` a multi-megabyte string.
- Returns 404 if no log exists for the terminal.

**Implementation.**
- Register the route in the `LocalApiServer` request handler, following the existing route registration pattern.
- Auth: use the same `authorizeRequest` / token check that every other route uses. Do NOT assume inheritance — test it explicitly.

**Edge cases.**
- A ranged request for bytes beyond the file size returns an empty body or a 416, not a 500.
- Concurrent rotation (the writer renames the file while a read is in flight): the read should open by path, and a rotation between open and read is harmless because `appendFileSync` reopens on every write.
- The endpoint must work in both hosts: `LocalApiServer` is shared, but the log files are on the filesystem of whichever process runs the gateway. In the extension host, the gateway is in the pty-host child — the log files are on the child's filesystem, which is the same machine. The `LocalApiServer` reads from the same filesystem. No cross-process issue.

### `src/webview/terminals.js` — log button in the terminal pane header

**Context.** Each terminal pane has a `.pane-header` (`terminals.js:6058`) containing a `.pane-actions` div (`:6064`) with pin, clear, model, and unassign buttons. A log button joins this row.

**Logic.** Add a "log" button to `.pane-actions` that, when clicked, opens the docs viewer (or a dedicated log view) showing the current pane's terminal log, rendered as markdown with the sidebar-list-plus-detail layout from `tickets.html`.

**Implementation.**
- Create the button in the same `renderPaneGrid` function that builds the other pane-action buttons (`terminals.js:6063-6142`).
- On click, post a message (or fetch the ranged tail endpoint) to load the log content, then render it with `renderMarkdown` into a full-screen view.
- Reuse the `.content-row` / `#tree-pane` sidebar layout from `tickets.html:364-366` for browsing other sessions' logs.
- The button is disabled when no log exists (terminal created before the feature shipped, or terminal not yet seated).

**Edge cases.**
- The button must re-read the pane's current assignment (same pattern as `paneClearBtn` at `:6090-6094`), not close over a stale `assignedName`.
- Opening the log view should not dispose the terminal pane or interrupt the WS connection.

### `src/standalone/terminalLogWriter.ts` — new file: the log writer

**Context.** No existing module tees pty output to disk. The `cli.ts` logger (`cli.ts:225`) is the closest precedent — rotation-aware, `appendFileSync`-and-reopen — but it logs console output, not pty output, and uses a blocking write.

**Logic.** A class that:
- Maintains a per-terminal file handle (or path, given the append-and-reopen pattern) under `.switchboard/logs/`.
- Subscribes to the gateway's flush observer for output chunks.
- Subscribes to prompt-delivery notifications for heading writes.
- Strips ANSI, collapses CR redraws, fences safely, and writes markdown.
- Rotates on size (following `cli.ts`'s `LOG_CAP_BYTES` pattern) and on session boundary (when `clearTerminalContext` fires).
- Uses a per-terminal async write queue to avoid blocking the shared flush interval.

**Implementation.**
- Exported class `TerminalLogWriter` with `subscribe(gateway)`, `onFlush(terminal, data)`, `onPrompt(terminal, promptText)`, `onSessionBoundary(terminal)`, and `dispose()` methods.
- Constructed and subscribed in both `bootstrap.ts` (after gateway creation, `:2722`) and `ptyHost.ts` (after gateway creation, `:45`).

**Edge cases.**
- File naming: `<terminal-name>-<session-id>.md` where session ID is a timestamp or UUID. Must not collide with `server.log` (the `cli.ts` logger's file).
- Concurrent writes from the flush observer and the prompt notifier: serialize per terminal (a simple mutex or sequential async queue).
- Disk full: the write fails silently (log a warning to console), never crashes the gateway. Same posture as `cli.ts`'s `catch { /* logging must never crash the server */ }`.

### `.gitignore` — no change needed, but add a defensive comment

**Context.** `.switchboard/*` at line 60 ignores `.switchboard/logs/` by default. The negations at lines 61-66 do NOT include `logs/`. This is correct — logs should never be committed.

**Logic.** No change to the ignore rules. Optionally add a comment noting that `logs/` is deliberately ignored (terminal output may contain secrets) and must never be negated.

**Edge cases.** The "never committed" test (see Verification Plan) asserts both that `logs/` is ignored AND that no `!` negation for it exists — catching the day someone adds one.

### Migration

None.

## Verification Plan

### Goal Invariants

- Every terminal session has a readable log covering more than the ring holds.
- A log never breaks its own markdown rendering.
- No log is reachable without auth, and none is ever committed.
- The live attach path is unchanged.
- Both hosts (standalone and extension) produce logs with dispatch headings — the heading-write hook is in the shared `sendPromptToPty`, not the standalone-only `deliverPrompt`.

### Automated Tests

- **History outlives the ring:** emit more than 256 KB, then assert the log contains output the replay buffer has evicted. This is the whole point and it fails today.
- **History outlives the clear:** run `queue/done`, then assert the log still holds the cleared session. The deliberate clear is the most common way history is lost.
- **Agent code fences do not break the document:** write output containing ```` ``` ```` and assert the rendered result is intact. This is the likeliest defect, so it needs the test that would catch it on line one.
- **Redraws collapse:** emit a spinner sequence and assert one final line, not N frames — and assert the byte size is a small fraction of the raw stream.
- **No split characters:** emit multi-byte characters straddling a flush boundary and assert the log is valid UTF-8, mirroring the frame-level guarantee.
- **Large logs are served ranged:** assert a tail request does not read or return the whole file.
- **Auth is enforced:** request a log unauthenticated and assert refusal.
- **Never committed:** assert `.switchboard/logs/` is ignored, and that no `!` negation for it exists — a test on the ignore result alone would pass the day someone adds one.
- **Attach is unchanged:** assert replay behaviour and `MAX_SCROLLBACK_BYTES` are untouched.
- **Dispatch headings are emitted in both hosts:** deliver a prompt via `sendPromptToPty` and assert a `##` heading appears in the log. This test must run against the shared function, not the standalone-only `deliverPrompt` wrapper, so it covers both composition roots.
- **Heading hook is in the shared path, not the standalone-only path:** assert that `deliverPrompt` (`bootstrap.ts`) does NOT contain the heading-write call, and that `sendPromptToPty` (`ptyPromptDelivery.ts`) does. This is a static source assertion — the composition-root divergence the project rules forbid is otherwise invisible to every runtime gate.
- **Session boundary rolls the file:** trigger `clearTerminalContext` (via `queue/done`), then assert a new log file is started and the old one is preserved.
- **Flush path is not blocked:** assert that a slow log write (mocked) does not delay the flush interval for other terminals. This catches the `appendFileSync`-on-the-hot-path mistake.

### Manual Verification

- Run a long agent session, clear the terminal, then open the log and confirm the whole session reads as a document with per-dispatch headings.
- Open the sidebar and confirm other terminals' sessions are browsable.
- Run a TUI-heavy session (e.g. `vim`, `htop`) and confirm the log is imperfect but readable — positioning artefacts are expected, but the dispatch headings and final line states should still be legible.
- Verify in BOTH hosts: run the standalone host and the extension host, deliver a prompt, and confirm headings appear in the log in both. The composition-root divergence is invisible to automated gates that don't diff the two roots by hand.

## Outstanding Questions

None.

## Review Findings

Reviewed and fixed. **CRITICAL:** `fenceSafe` used the plan's "longer fence than the payload" option, but `renderMarkdown` delimits on *exactly* three backticks with a non-line-anchored regex — verified empirically that an agent-printed ``` dropped the rest of the session out of its code block and rendered it as prose, and that consecutive per-chunk fences concatenated into a merged backtick run. Replaced with one open block per dispatch section, a zero-width-space payload sanitizer, an info-string opening fence, and `normalizeLogSlice` so a ranged tail (which can start inside one block and end inside the live one) is balanced before it is served. **MAJOR:** queued writes read `state.filePath` lazily so a session roll misrouted pre-roll output; a rolled session got no header; `.md.1` rotation was unreachable from the endpoint and `.md` filter (now rolls to a new session file); `offset` ignored `tail` so `offset=0` returned the whole file; `tail` was unbounded; a `session=` query could read another terminal's log; the CR carry could grow without bound on a newline-free TUI; `dispose()` was never wired in either host; the ESC handler leaked one document listener per open; **and the plan's 13 automated tests did not exist** — added `src/test/terminal-session-log-contract.test.js` (23 tests, all passing) plus `npm run test:contract:terminal-session-log`, wired into `.github/workflows/integration-tests.yml`. `protocol-catalog.json` was stale from the two new endpoints and would have failed `catalog:check` in CI; regenerated.

Files changed: `src/standalone/terminalLogWriter.ts`, `src/standalone/bootstrap.ts`, `src/standalone/ptyHost.ts`, `src/services/LocalApiServer.ts`, `src/webview/terminals.js`, `src/test/terminal-session-log-contract.test.js`, `package.json`, `.github/workflows/integration-tests.yml`, `protocol-catalog.json`. Validation: `tsc -p tsconfig.test.json` clean, eslint 0 errors, 25 contract tests + 9 repo gates pass. Pre-existing red at HEAD and untouched here: `mirror:check`, `verb-engine`, `browser-panel-verb-routing`, `terminal-replay-gap`, `terminal-focus-affordance`.

Remaining risks: a neutralized agent fence renders as an empty `<code>` span rather than visible backticks (shared-renderer limitation, code between the fences is intact); the sidebar shows only the current terminal's sessions, not other terminals'; and manual UAT in both hosts — including a TUI-heavy session — has not been run.
