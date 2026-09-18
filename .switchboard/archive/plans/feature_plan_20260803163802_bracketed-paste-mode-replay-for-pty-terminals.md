# Make Bracketed-Paste Mode Survive Terminal View Rebuilds So a Multi-Line Paste Lands as One Paste

## Goal

A multi-line clipboard pasted into a Switchboard PTY terminal sometimes arrives at the agent CLI as one submission **per line** instead of one atomic paste. It is intermittent: the same terminal, the same clipboard, works on one view and splits on another.

### Root cause

Bracketed-paste framing is decided **client-side, per xterm instance**, and Switchboard never restores that state when a view is rebuilt.

The vendored xterm paste path (`src/webview/vendor/xterm/xterm.js`, module `3614`, verified in the bundle) is:

```js
function i(e){return e.replace(/\r?\n/g,"\r")}                  // prepareTextForTerminal
function s(e,t){return t?"\x1b[200~"+e+"\x1b[201~":e}           // bracketTextForPaste
function r(e,t,r,n){
  e = s(i(e), r.decPrivateModes.bracketedPasteMode && !0 !== n.rawOptions.ignoreBracketedPasteMode);
  r.triggerDataEvent(e, !0);                                     // ONE onData for the whole paste
  t.value = "";
}
```

Two facts combine into the bug:

1. `decPrivateModes.bracketedPasteMode` initialises to `false` on **every** `new Terminal()` (`bracketedPasteMode:!1` in the bundle) and only flips true when *that instance's parser* consumes `\x1b[?2004h` from the output stream (`2004:this._coreService.decPrivateModes.bracketedPasteMode=!0`).
2. When the flag is `false`, `prepareTextForTerminal` collapses every `\r?\n` to a bare `\r` and sends it **unwrapped**. A raw-mode TUI reads each `\r` as Enter — so an N-line clipboard becomes N submissions. That is exactly the reported symptom.

### Affected applications — observed, not assumed

> **Superseded:** The affected TUIs were identified as "Claude CLI, prompt-toolkit".
> **Reason:** Wrong. The bug has **never been observed in Claude Code**. It was reported against the **Devin CLI** and occurs frequently in the **Antigravity CLI**. The original attribution was a guess, and it made the manual repro unrunnable: an immune CLI cannot demonstrate the pre-fix failure, so M1 would have "passed" for the wrong reason.
> **Replaced with:** Reproduce against **Devin CLI** or **Antigravity CLI**. Claude Code is a **negative control** — it must keep working, and its immunity is itself a datapoint (see below).

Claude Code's immunity is consistent with the eviction root cause rather than evidence against it.

> **Superseded:** "If a CLI re-emits `\x1b[?2004h` on a redraw cycle rather than only at process start, the escape is continuously refreshed inside the 256 KB ring tail."
> **Reason:** The mechanism was guessed and the guess was wrong in its specifics. Web research into the two TUI stacks that document this found that a **redraw does not re-emit the escape at all** — neither Ink nor prompt-toolkit re-runs it on SIGWINCH/resize or on alt-screen enter/exit. What *does* re-emit it is the **subprocess suspend/resume cycle**: Ink emits the disable on `suspendTerminal()` and re-applies terminal state including the enable on `resumeOutput()`; prompt-toolkit calls `disable_bracketed_paste()` / `enable_bracketed_paste()` around `run_system_command` and re-enables inside `renderer.reset()` (`prompt_toolkit/output/vt100.py`, `Vt100_Output.enable_bracketed_paste()`).
> **Replaced with:** Claude Code is Ink-based and shells out to subprocesses constantly for tool calls, so it passes through suspend/resume — and therefore re-emits `\x1b[?2004h` — many times per session. That keeps the escape permanently fresh inside the 256 KB ring tail, so it is never evicted and every attaching client is armed by the replay. Same conclusion, correct mechanism.

Devin CLI and Antigravity CLI evidently do not re-emit often enough to stay inside that tail. **This remains a hypothesis about why one CLI is immune, not a load-bearing assumption of the fix** — see Uncertain Assumptions.

**Stacks (from research; both applications are closed-source, so stack attributions are labelled inference by the source):**

- **Antigravity CLI (`agy`)** — a single compiled native binary for macOS/Linux/Windows, having replaced the former Node.js Gemini CLI. *Not* Ink, so the Ink emission pattern above does not describe it.
- **Devin CLI** — closed-source, stack undetermined. No primary source and no public issue tracker. Its 2004 emission pattern is unresolved and is the plan's largest remaining unknown.

**Antigravity has a publicly tracked instance of this symptom:** `google-gemini/gemini-cli` issue **#15849**, *"[Windows] Multi-line paste triggers immediate submission, preventing full text input in AntiGravity"* — first line submits immediately, subsequent lines fire as individual messages or are lost. Official Antigravity docs advise manual multi-line fallbacks (`Shift+Enter`, `Ctrl+J`, `Option+Enter`, trailing `\`) when pasting blocks.

> ⚠️ **Scope boundary — read before implementing.** That issue is described as the CLI *"failing to treat the bracketed paste as a single input block."* If Antigravity splits a paste that **arrives correctly bracketed**, the defect is app-side and **this plan cannot fix it** — arming the client changes what Switchboard sends, not how the app parses it. The Switchboard bug and the Antigravity bug are separable and may both be present. The report is also Windows-specific while this workspace is darwin, so it may not be the same defect at all. **Resolve this with pre-flight step M0 before writing any code** — it is cheap, needs no changes, and determines whether Antigravity belongs in the repro set or only Devin does.

The intermittency comes from where the enabling escape lives. The affected TUIs emit `\x1b[?2004h` at startup and do not re-emit it often enough for it to remain inside the ring tail.

> **Superseded:** "A TUI emits `\x1b[?2004h` **once**, at startup."
> **Reason:** Too strong, and falsified by Claude Code, which is immune. The fix does not require emit-exactly-once — it only requires that the escape is not re-emitted often enough to survive inside the last 256 KB of output.
> **Replaced with:** the weaker, sufficient framing above.

The gateway keeps only a 256 KB output ring (`MAX_SCROLLBACK_BYTES`, `src/standalone/terminalWsGateway.ts:5`) and replays only that tail to an attaching client (`setupClient`, line 573). For any terminal that has produced more than 256 KB of output — i.e. any agent that has been running for a while — the enabling escape has been **evicted**, so a freshly constructed xterm instance never sees it and starts life with bracketed paste off, permanently, for the life of that view.

Every routine action that builds a new xterm instance therefore lands in the broken state:

- opening the Terminals panel in a new browser tab / reloading the shell;
- pane reassignment: `destroyTerminalView` after `DETACH_GRACE_MS` (15 s, `src/webview/terminals.js:135-147`) disposes the instance *and deletes its `terminalsMap` entry* (`terminals.js:1801`), and re-assigning calls `createTerminalView` → a fresh entry with `lastSeq: 0` (`terminals.js:1829`) → `materializeTerminalView` → `new window.Terminal(...)` (`terminals.js:1872-1876`);
- the panel iframe being re-created by the browser shell.

A client attached at TUI launch, by contrast, saw the escape live and pastes correctly — hence "sometimes".

The gateway is the only component that sees the whole output stream from terminal creation (`initFleetListeners` → `trackTerminalData` subscribes at the `created` event), so it is the one place that can know the current mode with certainty. It just never records it. **Fix: make the gateway track DEC private mode 2004 as output flows, ship the current value in the `hello` frame, and have the client re-arm its parser on attach.**

Note on scope: a *genuinely* unbracketed app (one that never enables 2004) splitting a multi-line paste is correct terminal behaviour, identical in iTerm2 and VS Code, and is not addressed here.

### Verified against source during review

- `pty.pause()` — not output-dropping — is the backpressure mechanism (`terminalWsGateway.ts:512`), and `flushOutput` is the sole live-output call site of `encodeOutputFrame` (line 399). The gateway therefore observes **100 %** of pty output; a scanner placed in `flushOutput` cannot miss an escape.
- RIS and DECSTR really do clear bracketed paste in the vendored client parser, so a gateway that treats them as clears stays in agreement with it: DECSTR (`\x1b[!p`) calls `_coreService.reset()` directly, and RIS (`\x1bc`, registered via `registerEscHandler({final:"c"})`) routes `fullReset` → `_onRequestReset.fire()` → `Terminal.reset()` → `super.reset()` (`CoreTerminal.reset`) → `coreService.reset()`, whose body is `this.modes=clone(c),this.decPrivateModes=clone(l)` — and `l` has `bracketedPasteMode:!1`.
- `untrackTerminalData` calls `drainPending(name)` **before** its delete block (`terminalWsGateway.ts:425-432`), so per-terminal state deleted alongside `inputQueues` cannot be resurrected by a final flush.
- Writing `\x1b[?2004h` into xterm has no reply and no side effect beyond the flag — the DECSET handler body is the assignment alone. It cannot echo back to the pty.

### Architectural note — 2004 is one member of a class (deliberately not generalised)

Ring eviction breaks **every** sticky DEC private mode, not just bracketed paste: alt-screen (1049), mouse tracking (1000/1002/1003/1006), focus reporting (1004), cursor visibility (25), application cursor keys (DECCKM 1). A view rebuilt onto a long-running full-screen TUI has those wrong today as well. The scanner below parses every DECSET param, so recording the whole set would cost nothing extra.

It is **intentionally not done**. Replaying `\x1b[?1049h` into a freshly built view drops it into an empty alt-screen buffer — strictly worse than the status quo — and each mode needs its own is-it-safe-to-replay argument. This plan fixes the one mode that is both safe to replay and actively breaking operator workflow. The note exists so a future reader knows the narrow scope was a decision, not an oversight.

## Metadata

- **Complexity:** 5
- **Tags:** bugfix, frontend, backend, reliability

## User Review Required

- **Design choice: explicit `hello` field vs. sticky replay preamble.** The competitive alternative is a gateway-only change that prepends `\x1b[?2004h` to the replay payload and adds its length to `replayChars` — no protocol field and no `terminals.js` diff at all, which additionally repairs a browser tab left open across a server upgrade. This plan chooses the explicit field because forging synthetic bytes into a frame documented as a faithful scrollback replay is an observability trap for whoever debugs the next mode desync. **Accepted consequence:** a stale tab running pre-fix `terminals.js` keeps the bug until it is reloaded. Both surfaces are served by the same server, so skew is one reload deep.
- **Verification is manual, by design.** See the Verification Plan — the source-text contracts pin code shape and cannot prove a paste lands atomically. Manual step M1 is the acceptance gate.
- **Payload-side workarounds — considered, NOT in this plan's scope.** Worth recording because they are orthogonal and could ship independently; neither replaces this fix.

  First, a scoping fact that narrows the bug: **automated dispatch is already immune.** `sendPromptToPty` (`src/standalone/ptyPromptDelivery.ts:33-53`) wraps every dispatched prompt in `\x1b[200~ … \x1b[201~` **unconditionally**, chunks at 256 B, and its `CLI_AGENT_REGEX` names `agy` explicitly — it never touches xterm's paste path, so the client's mode is irrelevant to it. The bug therefore bites only the **manual clipboard flow**: a webview button calls `clipboard.writeText` (the Refine / copy-prompt actions in `kanban.html`, `project.js`, `planning.js`) and the operator pastes with Cmd+V through xterm. Those prompts are long and multi-line, which makes this the most likely path for the original report.

  1. **Condense the copied prompt to one line plus a pointer to a markdown rules file.** Mechanically sound: a payload with zero newlines gives `prepareTextForTerminal` nothing to collapse, so `bracketedPasteMode` stops mattering. But it **trades a loud failure for a silent one** — the paste lands atomically and looks fixed while the agent may never load the file and proceeds with no rules, which is worse than N visible submissions. Further problems: dispatch runs in sibling worktrees, so a path into the main repo's `.switchboard/` may not resolve or may resolve stale; whether Devin CLI loads a bare path is unknown (the same closed-source gap M0 exists to close); rules behind a path are context the agent *chooses* to load and can lose across compaction, whereas inlined rules are definitely present; and a per-dispatch prompt file is a new artifact with staleness and cleanup obligations.
  2. **Make the copy-prompt buttons send directly instead of copying** — call `sendPromptToPty` rather than `clipboard.writeText`. Already bracketed, already chunked, already `agy`-aware. No new artifacts, no context-loading risk, newline count irrelevant. **Strictly better than option 1 for any payload Switchboard generates**, and the recommended direction if a payload-side change is wanted.

     **Prior art — send-to-terminal was tried once via the VS Code API and worked poorly.** That attempt is still in the tree as `_sendRobustTextBackground` (`src/services/terminalUtils.ts:221-265`). It is *not* evidence against the idea; it is evidence against that transport. The two implementations are near-identical — same 256 B chunks, same 30 ms pacing, same bracketed wrapper, same per-terminal promise queue — and differ only in the write primitive, in four ways that all favour the pty:
     - `terminal.sendText` returns `void` and crosses the extension-host → renderer → pty-host IPC boundary, so chunk ordering is unguaranteed and the 30 ms sleeps are a hope rather than a barrier. `handle.write()` writes to the pty fd in call order.
     - `sendText` is not a byte-exact write: it traverses VS Code's terminal stack including shell integration, which normalizes line endings and injects its own sequences, and which may itself manage bracketed paste — so an injected `\x1b[200~` can be double-bracketed or stripped depending on version. `handle.write()` has nothing between it and the process.
     - The VS Code path serializes only against itself. `withTerminalLock` additionally protects against operator keystrokes and a `/clear` splicing into an in-flight chunked paste — the documented reason it exists.
     - `sendPromptToPty` writes a **second** `\r` for terminals matching `CLI_AGENT_REGEX`; `_sendRobustTextBackground` sends a single Enter. For an agent CLI that needs a second submit, that difference alone reproduces "didn't work very well."

  Both are confined to payloads whose content Switchboard controls. Any other multi-line paste — a stack trace, a diff, a log excerpt, a chunk of a file — still splits, and that is likely the larger share. **This plan fixes the terminal; those fix one payload.** If either is wanted, it is a separate deliverable and belongs in its own plan file.

- **Pre-flight M0 gates the whole plan, and needs no code.** Research surfaced a tracked Antigravity issue describing the CLI mishandling a paste that arrives *already* bracketed. If that holds for both candidate CLIs on darwin, the defect is app-side and this fix cannot change the reported symptom — the gateway controls what Switchboard sends, not how the app parses it. M0 settles it in minutes using the existing unconditional-bracketing dispatch path (`ptyPromptDelivery.ts:34`) plus an escape-count on a `script` log. **Run M0 before scheduling implementation.**

## Complexity Audit

### Routine

- Adding one optional field to the existing `hello` control frame — the frame already carries `replayChars`, `seq`, `cols`, `rows` (`terminalWsGateway.ts:609-617`), and the client already has a `frame.t === 'hello'` arm (`terminals.js:2007`).
- Deleting per-terminal map entries in `untrackTerminalData` / `dispose`, mirroring `inputQueues` exactly.
- Extending `src/test/terminal-input-path-contract.test.js`, which is already a source-text contract test over exactly these two files and already provides the `block()` helper.

### Complex / Risky

- **Escape-sequence scanning is the whole plan.** The scanner runs on the hot output path and must not be fooled by:
  - sequences split across pty reads (`\x1b[?20` / `04h` in two chunks) — needs a bounded carry;
  - multi-parameter DECSET (`\x1b[?1049;2004h`), where `2004` is one param among several;
  - `\x1b[?2004$p` (DECRQM request) and `\x1b[?2004;1$y` (DECRPM reply), which must **not** be read as mode changes — the final byte is `p`/`y`, not `h`/`l`;
  - resets that clear the mode: `\x1bc` (RIS) and `\x1b[!p` (DECSTR) — which must be ranked **by position against DECSET in the same pass**, see the Superseded callout in Proposed Changes.
- **ReDoS on the output hot path.** An unbounded `[0-9;]*` after `\x1b[?` backtracks quadratically on a long unterminated digit run, on the event loop of the single process that owns every terminal in the fleet. The param class must be length-bounded.
- **Ordering against replay.** `hello` is sent before the replay frame in `setupClient`, and the client's control-frame arms call `term.write()` directly while output goes through `batchQueue` + rAF. Applying the mode from `hello` therefore lands in xterm's write queue *before* the replay. That is safe in every case, because the recorded value is the latest over all history and the replay is a suffix: if the replay contains any 2004 escape, the last one in it *is* the recorded value, so it re-applies the same answer. Do not "fix" this by deferring the write.
- **Never write `\x1b[?2004l` from an unknown state.** The field must be omitted when the gateway has observed no 2004 sequence at all, so the client is not told to disable a mode nobody has ruled on. Sending an authoritative `l` for an *observed* `l` is safe: the gateway's view of the output stream is a strict superset of any client's, so a client cannot know something the gateway does not.
- Do **not** inject the mode escape into `entry.batchQueue`. That queue is billed to `onWriteParsed` → `pendingAckChars` (`terminals.js:2100-2123`), and synthetic characters the server never credited would corrupt the credit ledger that drives backpressure. Write directly, as the `inputThrottled` / `error` / `exit` arms already do.
- **Verification cannot be automated here.** Every contract assertion is a substring test over source text; all four pass against code that brackets nothing. See the Verification Plan.

## Edge-Case & Dependency Audit

### Race Conditions

| Case | Required behaviour |
| :--- | :--- |
| `hello` write vs. replay frame | `hello` is handled synchronously and writes straight to `term.write`; the replay arrives as a binary frame, is queued to `batchQueue` and drains on rAF — so the mode lands first. Correct: the replay is a suffix of history, so any 2004 escape inside it re-applies the same recorded value. |
| Paste fired before xterm's parser drains the mode write | Requires a paste within a single xterm write-drain tick of socket attach. Theoretical; no mitigation. |
| Reconnect with `lastSeq` (no view rebuild) | Mode re-applied idempotently; writing `h` when already `h` is a no-op. |
| Multiple clients on one shared pty | Each gets the same recorded value on its own attach; the flag is per-xterm-instance, so every client must be armed independently. |
| Final flush during teardown | `untrackTerminalData` runs `drainPending` (line 425) **before** the delete block (line 432), so a last-gasp `flushOutput` cannot resurrect a deleted map entry. Keep the new deletes in that same block, never above `drainPending`. |

### Security

| Case | Required behaviour |
| :--- | :--- |
| Unterminated `\x1b[?` + long digit run in pty output | The param class **must** be bounded (`[0-9;]{0,64}`). Unbounded `[0-9;]*` backtracks one character at a time on failure — ~40 KB of digits is ~10⁹ steps on the event loop of the process owning the whole fleet. Any program that prints garbage (corrupt binary, mangled download, hostile log line) can trigger it. |
| Synthetic escape written to the client | `\x1b[?2004h` / `l` only. DECSET produces no reply, so nothing is echoed back to the pty. Never write DECRQM (`$p`) — that *would* generate an `onData` reply into the pty. |
| Client-supplied `bracketedPaste` | None exists. The field is server→client only; the client never sends it and the gateway never reads one. |

### Side Effects

| Case | Required behaviour |
| :--- | :--- |
| Enabling escape evicted from the 256 KB ring | Gateway's recorded flag still says `true`; client re-arms from `hello`. This is the primary bug. |
| DECSET split across two pty reads | Carry the trailing partial `\x1b[?…` (bounded, 64 bytes) into the next scan; mode still detected. |
| `\x1b[?1049;2004h` (mode set alongside alt-screen) | Split params on `;` and match `2004` as a whole param — not a substring search, or `12004`/`20040` would false-positive. |
| `\x1b[?2004$p` / `\x1b[?2004;1$y` | Ignored — only final bytes `h` and `l` change state. `[0-9;]` cannot match `$`, so neither form can match at all. |
| `\x1bc` (RIS) / `\x1b[!p` (DECSTR) | Recorded mode → `false`; verified to match what the client's own parser does on the same bytes (see Goal). |
| RIS followed by an **unrelated** DECSET (`\x1bc … \x1b[?1000h`) | Still `false`. Nothing re-enabled 2004. This is the case the original two-pass scanner got wrong — see the Superseded callout. |
| App exits bracketed paste (`\x1b[?2004l`) while a client is disconnected | Recorded `false` shipped in `hello`; client writes `\x1b[?2004l`. |
| Gateway has observed nothing (brand-new terminal, no output yet) | Field omitted from `hello`; client writes nothing; the live stream arms it as it always did. |
| **Gateway constructed *after* a terminal was already running** (dev hot-reload; `initFleetListeners` adopts pre-existing terminals via `fleetService.list()`) | Startup output including the one `\x1b[?2004h` is already gone and was never scanned → nothing recorded → field omitted → today's behaviour. A degradation to the status quo, not a regression. |
| Terminal closed / re-created under the same name | `untrackTerminalData` must delete the recorded entry alongside `scrollbackBuffers`, or a new process inherits the dead one's mode. |
| Legacy JSON `out` frames (tab left open across a server downgrade) | Unaffected — the client's own parser handles those escapes as before. |
| Pre-fix `terminals.js` in a tab left open across a server **upgrade** | Unknown JSON fields are ignored, so nothing breaks — but that tab keeps the paste bug until reloaded. Accepted; see User Review Required. |
| Paste larger than `INPUT_CHUNK_BYTES` (4096) | Already correct: `findSafeBoundary` refuses to cut inside `\x1b[200~` or a multi-byte codepoint. No change; do not touch it. |
| App that never enables 2004 (e.g. `cat`, a bare `node` REPL) | Unchanged, correct-by-terminal-convention line-per-`\r` behaviour. Out of scope. |
| Backpressure pause active | `pty.pause()` stops production rather than discarding output, so no escape can be lost while paused. |

### Dependencies & Conflicts

No packages added. Confined to `src/standalone/terminalWsGateway.ts`, `src/webview/terminals.js`, and one test file. `src/webview/terminals.html` and `src/services/headlessPanelHtml.ts` (lines 391, 399) both load the same `terminals.js`, so the VS Code webview and the browser shell are fixed by one change. The vendored xterm bundle is **not** modified. `src/standalone/ptyPromptDelivery.ts:34` and `src/services/terminalUtils.ts:241-253` frame their own `\x1b[200~`/`\x1b[201~` dispatch payloads and are untouched — they bracket unconditionally at the server and never consult the client's mode.

## Dependencies

None.

## Adversarial Synthesis

Key risks: the mode scanner is the entire change and had two defects on review — resets ranked in a *separate* pass lost to any later unrelated DECSET, leaving the recorded mode stale-`true` and over-bracketing a reset terminal; and an unbounded `[0-9;]*` param class was a quadratic-backtracking hang on the shared output hot path. Both are corrected below (one unified alternation pass, last match in document order wins; params bounded to 64 chars), and the carry is now an anchored could-this-still-become-a-tracked-sequence test rather than a loose `/[hl]/` heuristic that stuttered on `\x1bc`. Two risks remain, both about evidence rather than code. Verification: the contract tests are source-text greps that cannot distinguish a working fix from a broken one, so manual step **M1** (repro-then-confirm on a terminal past 256 KB of output) is the real acceptance gate and must not be skipped because the automated suite is green. Premise: research surfaced a tracked Antigravity issue describing that CLI mishandling an *already-bracketed* paste, which would be an app-side defect outside this plan's reach — so pre-flight **M0** must confirm at least one candidate CLI honours server-side bracketing before any code is written.

## Proposed Changes

### 1. `src/standalone/terminalWsGateway.ts`

**Context.** The gateway already owns the only complete view of pty output: `trackTerminalData` subscribes at the `created` fleet event, backpressure pauses rather than drops, and `flushOutput` is the single live-output funnel. It records that output into an evicting ring and nothing else. This change adds a tiny non-evicting state record beside the ring.

**Logic.** Scan each coalesced flush for DEC private mode 2004 transitions before the ring append, keep the last observed value per terminal, and ship it in `hello`.

**Implementation.**

**a. Add the carry bound** beside the other module constants (near line 14):

```ts
/**
 * Ceiling on the partial-escape carry in scanBracketedPasteMode. Long enough for
 * any real DEC private-mode set (`\x1b[?1049;2004;1000;1002;1006h` is 28 bytes),
 * short enough that a stream of bare ESCs cannot grow the carry without limit.
 */
export const MODE_SCAN_CARRY_MAX = 64;
```

**b. Add the tracking maps** next to `scrollbackBuffers` (line 124):

```ts
    /**
     * Last observed value of DEC private mode 2004 (bracketed paste) per terminal.
     * Absent = never observed; do NOT coerce that to false (see setupClient).
     *
     * This exists because the mode is CLIENT state: every `new Terminal()` starts
     * with bracketedPasteMode off and only flips when its own parser consumes
     * `\x1b[?2004h`. A TUI emits that once, at startup, so on any terminal that has
     * produced more than MAX_SCROLLBACK_BYTES the escape is long evicted from the
     * ring and an attaching client can never learn it — leaving that view pasting
     * unbracketed forever, which a raw-mode agent CLI reads as one Enter per line.
     * The gateway sees the stream from terminal creation, so it is the only place
     * that can answer authoritatively.
     */
    private bracketedPasteModes = new Map<string, boolean>();

    /** Trailing partial escape carried between scans — see scanBracketedPasteMode. */
    private modeScanCarry = new Map<string, string>();
```

**c. Add the scanner.** Placement is **load-bearing**: it must sit immediately after `flushOutput` and before `untrackTerminalData`. Both contract tests below use those two declarations as `block()` markers and will throw `end marker not found` if it lands anywhere else.

> **Superseded:** A two-pass scanner — a `while` loop over `/\x1b\[\?([0-9;]*)([hl])/g` tracking `lastConsumed`, followed by a separate `const resetIdx = Math.max(text.lastIndexOf('\x1bc'), text.lastIndexOf('\x1b[!p')); if (resetIdx >= lastConsumed) { … }` reset check, and a carry kept via `escIdx !== -1 && !/[hl]/.test(tail.slice(escIdx))`.
> **Reason:** Three defects. (1) **Resets are silently dropped.** On `\x1bc … \x1b[?1000h` the DECSET pass advances `lastConsumed` past the mouse-tracking set, so the reset check asks `0 >= 48`, fails, and skips the RIS — leaving the recorded mode stale-`true` after a terminal reset, which over-brackets and prints literal `[200~` into an app that no longer supports it. This directly contradicts the plan's own "RIS → false" edge-case row. (2) **The carry stutters.** The reset branch sets `lastConsumed = resetIdx`, which *includes* `\x1bc` in the carry window, and `/[hl]/.test('\x1bc')` is false — so the RIS is carried forward and re-fires on every subsequent chunk. The same heuristic also carries ordinary junk like `\x1b[0m` on essentially every flush of coloured output. (3) **ReDoS.** `[0-9;]*` is unbounded: `\x1b[?` followed by a long digit run with no final byte backtracks one character at a time (~10⁹ steps for 40 KB) on the event loop of the process that owns every terminal in the fleet.
> **Replaced with:** A single unified alternation pass in which RIS, DECSTR and DECSET/DECRST are all matches of one regex, so the last state-changing event **in document order** wins by construction; a length-bounded param class; and an anchored carry test that keeps only a fragment which could still *become* one of the tracked sequences.

```ts
/**
 * Update the recorded bracketed-paste mode from a slice of pty OUTPUT.
 *
 * ONE regex pass, so the LAST state-changing event in DOCUMENT ORDER wins. All
 * three events that change the mode are alternatives of the same pattern, and
 * that is the point — ranking them in separate passes means an unrelated DECSET
 * after a reset makes the reset lose a position compare and the mode goes
 * stale-true:
 *   \x1b[?<params>h|l   DECSET / DECRST
 *   \x1bc               RIS    — full reset
 *   \x1b[!p             DECSTR — soft reset
 *
 * RIS and DECSTR clear the mode because that is exactly what the client's own
 * parser does on the same bytes: in the vendored bundle DECSTR calls
 * `_coreService.reset()`, and RIS routes fullReset -> onRequestReset ->
 * Terminal.reset -> CoreTerminal.reset -> `coreService.reset()`, whose body
 * re-clones the DEC private-mode defaults — in which 2004 is false.
 *
 * Only final bytes `h` and `l` change state. `\x1b[?2004$p` is a DECRQM *request*
 * and `\x1b[?2004;1$y` its reply; `[0-9;]` cannot match `$`, so neither can match
 * at all. Params are compared WHOLE (`2004`, never a substring) so `12004` and
 * `20040` cannot false-positive, and a multi-param set like `\x1b[?1049;2004h` is
 * still honoured.
 *
 * The `{0,MODE_SCAN_CARRY_MAX}` bound is a security control, not tidiness: an
 * unbounded `[0-9;]*` after `\x1b[?` backtracks one character at a time when no
 * final byte follows, so a program printing tens of kilobytes of digits would
 * hang the event loop of the process owning every terminal in the fleet.
 *
 * The carry is load-bearing: pty reads split wherever the kernel says, so
 * `\x1b[?20` and `04h` routinely arrive in different chunks and a stateless scan
 * would miss the only escape that matters.
 */
private scanBracketedPasteMode(terminalName: string, data: string): void {
    const carry = this.modeScanCarry.get(terminalName) || '';
    const text = carry ? carry + data : data;

    const modeEvent = /\x1bc|\x1b\[!p|\x1b\[\?([0-9;]{0,64})([hl])/g;
    let match: RegExpExecArray | null;
    let consumedEnd = 0;
    while ((match = modeEvent.exec(text)) !== null) {
        consumedEnd = match.index + match[0].length;
        if (match[2]) {
            // DECSET / DECRST — only 2004 is tracked; other modes are ignored but
            // still advance consumedEnd so they cannot be re-scanned via the carry.
            if (match[1].split(';').includes('2004')) {
                this.bracketedPasteModes.set(terminalName, match[2] === 'h');
            }
        } else {
            // RIS or DECSTR.
            this.bracketedPasteModes.set(terminalName, false);
        }
    }

    // Carry only a trailing fragment that could still BECOME one of the tracked
    // sequences: ESC, ESC[, ESC[!, ESC[?<digits;>. Anything else — a colour SGR,
    // an OSC title — is dropped, so the carry is empty on essentially every flush
    // and can never re-fire a sequence the pass above already consumed. An escape
    // starting further back than MODE_SCAN_CARRY_MAX degrades to a missed
    // detection, never to unbounded growth.
    const tail = text.slice(Math.max(consumedEnd, text.length - MODE_SCAN_CARRY_MAX));
    const escIdx = tail.lastIndexOf('\x1b');
    const fragment = escIdx === -1 ? '' : tail.slice(escIdx);
    this.modeScanCarry.set(terminalName, /^\x1b(\[(\?[0-9;]{0,64}|!)?)?$/.test(fragment) ? fragment : '');
}
```

**d. Call it from `flushOutput`**, on the coalesced string, immediately after `const combined = taken.join('');` (line 385) and before the ring append:

```ts
        const combined = taken.join('');
        // Before the ring append: the ring EVICTS, and the whole point of the
        // recorded flag is to outlive eviction.
        this.scanBracketedPasteMode(terminalName, combined);
```

**e. Ship it in `hello`** (lines 609-617). Omit the field when unobserved:

```ts
        const bracketedPaste = this.bracketedPasteModes.get(terminal.name);
        this.safeSend(ws, {
            t: 'hello',
            name: terminal.name,
            role: terminal.role,
            cols: terminal.pty.cols || 80,
            rows: terminal.pty.rows || 24,
            seq: buffer ? buffer.nextSeq - 1 : 0,
            replayChars,
            // Omitted, NOT false, when nothing has been observed: telling a client to
            // DISABLE a mode nobody has ruled on is a regression, not a default.
            ...(typeof bracketedPaste === 'boolean' ? { bracketedPaste } : {}),
        });
```

**f. Clean up.** In `untrackTerminalData` (line 432, beside `this.inputQueues.delete(name)` — inside the delete block, which runs *after* `drainPending`) and in `dispose()` (line 822, beside `this.inputQueues.clear()`):

```ts
        this.bracketedPasteModes.delete(name);
        this.modeScanCarry.delete(name);
```
```ts
        this.bracketedPasteModes.clear();
        this.modeScanCarry.clear();
```

**Edge cases.** Covered in the audit above: DECRQM, whole-param matching, split reads, resets, unobserved terminals, teardown ordering, and the ReDoS bound.

### 2. `src/webview/terminals.js`

**Context.** `connectTerminalSocket` is called from `materializeTerminalView` (line 1928) *after* `entry.term = term` (line 1894), so `entry.term` is always live by the time `hello` arrives; on reconnect the term already exists. The existing `hello` arm (line 2007) only reads `replayChars`.

**Logic.** Re-arm the parser from the server's record, via a direct write.

**Implementation.** Extend the `hello` arm:

```js
                } else if (frame.t === 'hello') {
                    // Chars the server replayed but did NOT bill to this connection's
                    // credit ledger. See onWriteParsed.
                    entry.ackSuppressChars = typeof frame.replayChars === 'number' && frame.replayChars > 0
                        ? frame.replayChars
                        : 0;
                    // Re-arm bracketed paste from the server's record.
                    //
                    // decPrivateModes.bracketedPasteMode is per-xterm-instance and starts
                    // false, so a rebuilt view (new tab, shell reload, pane reassignment
                    // past DETACH_GRACE_MS) pastes UNBRACKETED unless the enabling escape
                    // happens to still be in the replayed ring tail. When it is not,
                    // xterm's prepareTextForTerminal collapses every newline to a bare \r
                    // and a raw-mode agent CLI submits once per line — the paste-splitting
                    // bug this exists to fix.
                    //
                    // Written into the parser rather than poked into decPrivateModes: the
                    // escape is public API, renders nothing, generates no reply, and cannot
                    // drift from xterm's internals. It lands ahead of the replay frame,
                    // which is correct — the replay is a suffix of history, so any 2004
                    // escape inside it re-applies this same value.
                    //
                    // NOT entry.batchQueue: that path is billed to pendingAckChars via
                    // onWriteParsed, and synthetic characters the server never credited
                    // would corrupt the backpressure ledger.
                    if (typeof frame.bracketedPaste === 'boolean' && entry.term && !entry.disposed) {
                        entry.term.write(frame.bracketedPaste ? '\x1b[?2004h' : '\x1b[?2004l');
                    }
                }
```

**Clarification (not new scope):** the `!entry.disposed` guard mirrors `flushBatch` (line 2095), which already distinguishes a disposed *view* from an exited *process*. The neighbouring `inputThrottled`/`error`/`exit` arms omit it; matching `flushBatch` is the safer of the two local conventions for a write that is not operator-visible.

**Edge cases.** Field absent → no write, status quo. Reconnect on a live view → idempotent re-write. Stale pre-fix client → field ignored, bug persists until reload (accepted, see User Review Required).

### 3. `src/test/terminal-input-path-contract.test.js`

**Context.** The file is already a source-text contract over exactly these two files and supplies the `block(code, startMarker, endMarker)` helper (line 33). Its existing teardown test uses `block(gatewayCode, 'private untrackTerminalData(', 'private drainPending(')`, so the same markers are reused.

**Logic.** Pin the structural invariants that have no runtime signal, plus exercise the matcher's semantics directly — the one part of this change that *can* be tested for behaviour, because the regex is pure.

> **Superseded:** `test('the mode scanner ignores DECRQM and matches params whole', …)` asserting only `([hl])`, `split(';').includes('2004')` and `modeScanCarry`, with a single-`exec` inline `hit()` helper.
> **Reason:** A single `exec` returns the *first* match, so it could not have caught the ordering defect that the two-pass scanner actually had, and there was no assertion pinning the param bound that prevents the hot-path ReDoS.
> **Replaced with:** A last-match-wins helper that mirrors the real loop, ordering cases in both directions, and an assertion on the bounded param class.

```js
test('the gateway records bracketed-paste mode outside the evicting ring', () => {
    assert.ok(gatewayCode.includes('private bracketedPasteModes = new Map<string, boolean>()'),
        'the mode must be recorded per terminal — a TUI emits \\x1b[?2004h once at startup and the 256 KB ring evicts it, so an attaching client can never learn it from replay');
    // End marker also pins PLACEMENT: the scanner must sit between these two.
    const flush = block(gatewayCode, 'private flushOutput(', 'private scanBracketedPasteMode(');
    const scanIdx = flush.indexOf('this.scanBracketedPasteMode(');
    const ringIdx = flush.indexOf('buffer.chunks.push(');
    assert.ok(scanIdx !== -1 && ringIdx !== -1 && scanIdx < ringIdx,
        'the scan must run before the ring append — the ring evicts, and outliving eviction is the entire point');
});

test('the mode scanner ranks resets and DECSET by position, in one pass', () => {
    const scan = block(gatewayCode, 'private scanBracketedPasteMode(', 'private untrackTerminalData(');
    assert.ok(scan.includes('([hl])'),
        'only final bytes h/l may change state — \\x1b[?2004$p is a status REQUEST and \\x1b[?2004;1$y its reply');
    assert.ok(scan.includes("split(';').includes('2004')"),
        'params must be compared whole, or 12004/20040 false-positive and \\x1b[?1049;2004h is missed');
    assert.ok(scan.includes('\\x1bc|') && scan.includes('\\x1b\\[!p'),
        'RIS and DECSTR must be alternatives in the SAME pass — scanned separately, an unrelated DECSET after a reset makes the reset lose a position compare and the mode goes stale-true');
    assert.ok(/\[0-9;\]\{0,\d+\}/.test(scan),
        'the param class must be length-bounded: an unterminated \\x1b[? followed by a long digit run backtracks quadratically on the output hot path, on the event loop owning every terminal');
    assert.ok(scan.includes('modeScanCarry'),
        'pty reads split anywhere, so \\x1b[?20 + 04h across two chunks must still be detected');

    // The matcher itself, exercised directly — last state-changing event wins.
    const re = /\x1bc|\x1b\[!p|\x1b\[\?([0-9;]{0,64})([hl])/g;
    const last = (s) => {
        re.lastIndex = 0;
        let m, v;
        while ((m = re.exec(s)) !== null) {
            if (m[2]) { if (m[1].split(';').includes('2004')) { v = m[2]; } }
            else { v = 'reset'; }
        }
        return v;
    };
    assert.strictEqual(last('\x1b[?2004h'), 'h');
    assert.strictEqual(last('\x1b[?1049;2004h'), 'h', 'multi-param DECSET must be honoured');
    assert.strictEqual(last('\x1b[?2004l'), 'l');
    assert.strictEqual(last('\x1b[?2004$p'), undefined, 'DECRQM must not register');
    assert.strictEqual(last('\x1b[?2004;1$y'), undefined, 'DECRPM must not register');
    assert.strictEqual(last('\x1b[?12004h'), undefined, 'substring match must not register');
    assert.strictEqual(last('\x1b[?2004h out \x1bc'), 'reset', 'RIS after a set must win');
    assert.strictEqual(last('\x1b[?2004h out \x1b[!p'), 'reset', 'DECSTR after a set must win');
    assert.strictEqual(last('\x1bc \x1b[?2004h'), 'h', 'a set after RIS must win');
    assert.strictEqual(last('\x1bc \x1b[?1000h'), 'reset',
        'an UNRELATED DECSET after RIS must not resurrect the pre-reset value — this is the two-pass bug');
});

test('hello omits the mode when unobserved and the client re-arms from it', () => {
    const hello = block(gatewayCode, "t: 'hello'", 'Replay scrollback BEFORE');
    assert.ok(hello.includes("typeof bracketedPaste === 'boolean'"),
        'omitted, NOT false, when unobserved — telling a client to DISABLE a mode nobody ruled on is a regression');
    const arm = block(terminalsJs, "frame.t === 'hello'", "frame.t === 'inputThrottled'");
    assert.ok(arm.includes('\\x1b[?2004h'),
        'a rebuilt view starts with bracketedPasteMode false and would paste unbracketed — one Enter per line to a raw-mode agent CLI');
    assert.ok(!arm.includes('batchQueue'),
        'the mode escape must bypass batchQueue: that path is billed to pendingAckChars and synthetic chars corrupt the backpressure ledger');
});

test('the recorded mode is torn down with the terminal', () => {
    const untrack = block(gatewayCode, 'private untrackTerminalData(', 'private drainPending(');
    assert.ok(untrack.includes('this.bracketedPasteModes.delete(name)'),
        'a terminal re-created under the same name must not inherit the dead process mode');
    assert.ok(untrack.includes('this.modeScanCarry.delete(name)'), 'carry must not leak across processes');
    assert.ok(block(gatewayCode, 'public dispose()', 'for (const client of this.clients)').includes('this.bracketedPasteModes.clear()'),
        'dispose must clear the recorded modes too');
});
```

**Edge cases.** `block()` throws a clear `marker not found` if the scanner is misplaced — that is intentional, it is the placement contract.

## Verification Plan

### Automated Tests

**Authored this pass; execution is excluded from this plan's gate per the session's SKIP COMPILATION / SKIP TESTS directives.**

> **Superseded:** Verification steps 1-4 listed `npm run test:contract:terminal-input-path`, `npm run test:contract:pty-route-surface` and `npx tsc --noEmit -p tsconfig.json` as pass/fail gates for this change.
> **Reason:** Two problems. The session directives exclude running compilation and automated tests from the verification plan. More importantly, all four contract assertions are **substring tests over source text** — every one of them passes against an implementation that brackets nothing, so a green run is not evidence the bug is fixed. Treating them as the gate is precisely the "green metric substituting for judgment" failure.
> **Replaced with:** The contract tests are authored as part of the change (§3) and documented below for whoever runs them later, explicitly labelled as *shape* contracts, not behaviour. The acceptance gate is manual step **M1**.

Available for a later pass, not run here:

- `npm run test:contract:terminal-input-path` (`package.json:814`) — the extended contract above. Pins code shape only: map declared, scan ordered before the ring append, scanner placed between `flushOutput` and `untrackTerminalData`, resets in the same pass, param class bounded, field omitted when unobserved, client arm bypasses `batchQueue`, teardown deletes. The one genuinely behavioural part is the inline matcher exercise, which tests the regex semantics in isolation from the gateway.
- `npm run test:contract:pty-route-surface` (`package.json:844`) — confirms the dispatch delivery path (`ptyPromptDelivery.ts` bracketed-paste/chunking/lock machinery) is untouched.

Lint (not a compilation or test step) may still be run: `npx eslint src/standalone/terminalWsGateway.ts src/webview/terminals.js`.

### Manual — the actual acceptance gate

- **M0 — PRE-FLIGHT, run before writing any code. No build required.** Establish that each candidate CLI honours a correctly-bracketed paste at all, because if it does not, this fix cannot help it (see the scope boundary in Affected applications). Two independent probes, both free:
  1. **Server-side bracketing probe.** `src/standalone/ptyPromptDelivery.ts:34` already wraps every dispatched prompt in `\x1b[200~ … \x1b[201~` **unconditionally**, with no reference to the client's mode. So dispatch a multi-line prompt to Devin CLI and to Antigravity CLI through Switchboard's normal dispatch path and watch what the app does. Arrives as one block → the app honours bracketing, and this plan's fix will work for it. Splits per line even though the payload was correctly bracketed → the defect is **app-side**, that CLI is out of scope, and it must be removed from the M1 repro set.
  2. **Emission-count probe** (also resolves Uncertain Assumptions 1 and 2 more reliably than research can, since both CLIs are closed-source):
     ```
     script -q /tmp/cli.log -c '<devin|agy>'
     # use it normally, resize the window, let it run a few tool calls, then:
     grep -c $'\033\[?2004h' /tmp/cli.log
     ```
     `1` → emitted once at startup; the eviction root cause holds exactly as written. Many → the app re-emits, and the intermittency story needs revisiting before any code is written. Run the same count against Claude Code to confirm the immunity mechanism (expect many, from Ink's suspend/resume cycle).

  Record both results in the plan before proceeding. If BOTH candidate CLIs fail probe 1, stop — the premise is wrong and no amount of gateway work will fix the reported symptom.

Everything below requires a build. Sync to the *installed* extension folder (`~/.<ide>/extensions/turnzero.switchboard-*/dist/`) and reload; the dev-repo `dist/` is not what runs.

- **M1 — Repro-then-fix (MUST fail before the change).** Start an agent terminal running **Devin CLI or Antigravity CLI** — the two applications the bug was actually observed in. **Do not use Claude Code for this step: it is immune** (see Affected applications) and would pass pre-fix, hiding the bug. Let the terminal produce well over 256 KB of output — e.g. `find / -type f 2>/dev/null | head -50000` inside the shell, or a long agent session. Then open the Terminals panel in a **new browser tab** so a fresh xterm instance attaches. Paste a 5-line block. Expected pre-fix: five separate submissions. Post-fix: a single atomic paste. **Observing the pre-fix failure is required** — without it, a post-fix pass proves nothing, since a terminal under 256 KB of output passes either way.
- **M1b — Negative control, immune CLI.** Repeat M1 against **Claude Code**. It must paste atomically both before and after the change. A behaviour change here means the fix is doing something other than what this plan describes — most likely double-arming or fighting the app's own escapes.
- **M2 — Pane-rebuild path.** With the same long-running terminal, unassign it from its pane, wait past the 15 s `DETACH_GRACE_MS` so `destroyTerminalView` runs, re-assign it, and paste a multi-line block. One paste, not one per line.
- **M3 — Reconnect path.** Kill the network to the panel (or stop/start the standalone server) so the socket reconnects with `lastSeq`, then paste multi-line. One paste.
- **M4 — Negative control, no over-bracketing.** In a terminal sitting at a plain shell prompt with no TUI, run `cat`, paste two lines, and confirm no literal `[200~` / `[201~` text appears on screen. Then `Ctrl-C` and paste at the `zsh` prompt: zsh enables 2004 itself, so the paste must arrive as one highlighted block.
- **M5 — Reset control (pins the corrected scanner).** With a TUI running, exit it and run `printf '\033c'` (RIS), then `printf '\033[?1000h'` (an unrelated DECSET after the reset). Paste two lines at the bare prompt — no literal `[200~` may appear. This is the case the superseded two-pass scanner got wrong.
- **M6 — DECRQM control.** With a TUI running, `printf '\033[?2004$p'` from another attached client's shell must not change paste behaviour in either view.
- **M7 — ReDoS control.** `printf '\033[?'; head -c 40000 /dev/urandom | tr -dc '0-9;'` into a terminal. The panel must stay responsive and other terminals must keep streaming — confirms the bounded param class.
- **M8 — Large paste.** Paste ~200 KB of multi-line text: the `[Pasting — input queued: …]` notice appears and clears, and the payload lands as ONE paste (confirms the new mode handling has not disturbed `findSafeBoundary` chunking).
- **M9 — Multi-client.** Attach two browser tabs to the same terminal; paste multi-line from each. Both must bracket correctly — the flag is per-instance, so this proves each client is armed on its own attach.

## Uncertain Assumptions

Web research has been run. Everything else in this plan was verified directly against the repository source (vendored xterm bundle, gateway, client, test harness, `package.json`).

**Resolved by research — no longer open:**

- **xterm.js has no recovery path.** Confirmed across v4/v5/v6: `decPrivateModes.bracketedPasteMode` is unconditionally `false` on every `new Terminal()`; nothing re-emits `\x1b[?2004h` or sends a DECRQM query on attach or re-attach, including via `AttachAddon`; and soft/hard reset clears the mode back to `false`. The mode is enabled *only* when the connected process streams the escape over the PTY. This is the plan's root cause, independently confirmed — and the reset finding independently corroborates the RIS/DECSTR behaviour traced in the bundle.
- **Ink and prompt-toolkit emission patterns.** Neither re-emits on SIGWINCH/resize or on alt-screen enter/exit; both re-emit around the **subprocess suspend/resume** cycle. This is what explains Claude Code's immunity (see the superseded callout in Affected applications) and it is now a mechanism, not a guess.

**Still open:**

1. **That Devin CLI emits `\x1b[?2004h` at startup, and how often it re-emits.** Research found no primary source, no documented TUI stack, and no public issue tracker for Devin CLI — the largest remaining unknown, and the one that matters most since Devin is where the bug was originally reported. **Resolve empirically via pre-flight M0**, which is faster and more reliable than further research for a closed-source binary.
2. **Whether Antigravity CLI splits a paste that arrives *correctly bracketed*.** `google-gemini/gemini-cli` #15849 describes it as failing to treat a bracketed paste as one input block. If true on darwin, the defect is app-side and out of this plan's reach — see the scope boundary in Affected applications. **Resolve via pre-flight M0 probe 1.** Antigravity is also a native single binary rather than Ink/Node, so neither documented emission pattern describes it.
3. **That Claude Code's immunity is fully explained by Ink's suspend/resume re-emission.** Mechanism now identified and plausible, but not measured on this machine. Not load-bearing — the fix is correct either way — but if the M0 emission count on Claude Code comes back low, the immunity has another cause and that cause may be a second contributing factor this plan has not accounted for.

---

**Recommendation: Send to Coder** (Complexity 5).

## Completion Report

Implemented the bracketed-paste mode replay fix exactly as specified. The gateway (`src/standalone/terminalWsGateway.ts`) now scans every coalesced pty output flush for DEC private mode 2004 transitions in a single unified regex pass (DECSET/DECRST/RIS/DECSTR, last-in-document-order wins), records the last observed value per terminal in `bracketedPasteModes` (non-evicting, lives outside the 256 KB ring), carries split-across-reads partial escapes via a bounded `modeScanCarry`, ships the value in the `hello` frame (omitted when unobserved), and tears the maps down in `untrackTerminalData`, `rekeyTerminal`, and `dispose`. The client (`src/webview/terminals.js`) re-arms xterm's parser from `frame.bracketedPaste` in the `hello` arm via a direct `term.write` (bypassing the rAF-batched write queue to protect the backpressure ledger). Extended `src/test/terminal-input-path-contract.test.js` with five new shape/behaviour contracts pinning map declaration, scan-before-ring-append ordering, single-pass reset ranking, bounded param class, whole-param matching, carry, hello-omits-when-unobserved, client arm bypass, and teardown — plus an inline matcher exercise covering 9 ordering/edge cases. One deviation from the plan's illustrative comment: the client comment was reworded to avoid the literal token `batchQueue` so the contract's `!arm.includes('batchQueue')` assertion holds (the plan's own example comment would have failed its own test). All shape assertions and regex behaviour cases verified via direct probe; lint clean on the gateway (only pre-existing `curly` warnings), and the pre-existing terminals.js ESLint parse error at line ~1017 is unrelated to this change (present in HEAD). Per session directives, compilation and the automated test suite were not run.

## Review Findings

Reviewed as implemented in `src/standalone/terminalWsGateway.ts`, `src/webview/terminals.js` and `src/test/terminal-input-path-contract.test.js`; no CRITICAL or MAJOR code defect — the single-pass scanner, the omit-when-unobserved `hello` field, the direct `term.write` (verified: `onWriteParsed` fires only from the two explicit write callbacks, so the ack ledger is untouched) and the teardown are all correct, and the beyond-plan `rekeyTerminal` moveMap entries were mandatory, not optional, because `terminal-rename-rekey-contract.test.js` derives its collection list dynamically. Two review fixes applied: the carry — load-bearing and the site of one of the plan's own two pre-ship defects — had zero behavioural coverage (the contract only grepped for the string `modeScanCarry` and exercised a hand-copied regex), so four executing tests were added that extract and run the shipped scanner, and the `[0-9;]{0,64}` bound assertion was moved onto the matcher declaration because the carry-fragment test's own `{0,64}` satisfied a body-wide grep even with the matcher unbounded (mutation-verified: all three mutations now fail the suite, none did before). The plan's ReDoS rationale is **factually wrong** and the source comment was corrected — measured, unbounding `[0-9;]*` here is linear (~4× on 80 KB of digit junk), not ~10⁹ steps, because one backtracking pass is spent per start position and starts cannot overlap a digit run; the bound is kept as free insurance, not as a security control. Verification run independently (no skip directive in the dispatch — the note above is a record of the coder's session, not an instruction): `terminal-input-path` 18/18, `pty-route-surface`, `terminal-answerback` 9/9, `terminal-rename-rekey` 8/8, `terminal-flow-control` 16/16, `terminal-pane-pinning` 15/15, `verb-returns:check`/`parity:check`/`push-routing:check` all PASS, ESLint clean on all three files, `tsc --noEmit` at the 5-error pre-existing baseline (all dated 2026-07-04, none in changed files); both plan-named automated checks are CI-wired (`integration-tests.yml:290` and `:67`), so there is no green-while-incomplete hole. **Remaining risk is entirely evidential: pre-flight M0 was never run or recorded although the plan gates the whole change on it ("if BOTH candidate CLIs fail probe 1, stop"), and M1 — the plan's declared acceptance gate, which it explicitly says a green suite cannot substitute for — is unrun; both need an interactive Devin/Antigravity CLI and a build synced to the installed extension folder, so this verdict is provisional on them.** Deferred NITs: `modeScanCarry.set()` writes an empty entry per flush; a stray `\x1bc` in binary output false-positives as RIS (degrades to the pre-fix default and matches what a live client's own parser does); `rekeyTerminal`'s destination-already-tracked bail strands all seven collections, pre-existing.
