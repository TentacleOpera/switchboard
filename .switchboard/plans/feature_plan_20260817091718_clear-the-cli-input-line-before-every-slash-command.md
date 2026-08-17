# Press Ctrl+U before anything that sends a slash command to a terminal

## Goal

One rule, applied everywhere: **before writing a slash command to a terminal, write `\x15`
(Ctrl+U) first.** No exceptions, no CLI detection, no role gate.

### Problem

An agent CLI's input box is a persistent buffer. If anything is already sitting in it — the user
typed half a question and walked away, a paste landed without a submit — the next write
concatenates:

```
how do I fix the/clear      ← submitted as a PROMPT, not a command
```

The CLI never sees a slash command, so the context is not reset. On the dispatch path the plan
prompt that follows a few hundred milliseconds later then runs against exactly the stale context
the clear was supposed to remove. The same concatenation breaks `/model`: it lands as literal
prompt text instead of opening the model picker. Every failure is silent — `clearPty` returns
`{ success: true }` because the *write* succeeded.

### Root cause

Every writer assumes the input line is empty. `grep -rn "x15" src/` returns nothing — there is no
input-line reset anywhere in the codebase.

`\x15` is `unix-line-discard`, the emacs binding agent CLIs implement for line editing. It is a
no-op on an empty line and harmless in a plain shell, so it is safe to send unconditionally.

**The binding is confirmed on the seat that matters.** `feature_plan_20260813103000_pty-prompt-delivery-never-submits.md`
records an operator measurement (2026-08-13): *"Ctrl-U does clear unsubmitted input in Claude
Code."* That plan initially concluded the opposite — that a bracketed-paste "pill" was exempt from
Ctrl-U — and superseded it once measured: the byte had been failing to reach the keybinding layer
because a split close marker left the terminal inside an open paste, where every subsequent byte is
literal text. **That framing defect has since shipped fixed** — `ptyPromptDelivery.ts:87,94` now
writes `\x1b[200~` and `\x1b[201~` as their own whole writes, pinned by
`pty-prompt-delivery-framing.test.js:125-152`. So the precondition for `\x15` reaching the
keybinding layer is already in place on this path, and the only thing missing is that nothing ever
sends the byte.

That prior plan also records the manual recovery sequence for a terminal stuck in an open paste
(`\x1b[201~` then `\x15`) and explicitly declines to build a verb for it. This plan does **not**
revive that: it sends `\x15` alone, because the framing fix removed the state a leading `\x1b[201~`
would have been recovering from. Nothing here depends on that decision being revisited.

### Two different bugs share the name "slash-command concatenation" — keep them apart

The codebase already carries an *existing* concatenation theory, and it is **not** this one.
`terminalUtils.ts:86-93` and `TaskViewerProvider.ts:20258-20260`/`:20286-20288` both document that
delivering `/clear` via `terminal.sendText` lets the command concatenate with the **prompt that
follows it**, and both refuse to fall back to `sendText` for that reason — which is why the VS Code
path pastes `/clear` through the clipboard instead.

- **Existing theory (writer-side):** the *outgoing* `/clear` and the *next outgoing* write merge.
  Mitigated today by clipboard paste.
- **This plan (reader-side):** whatever the **user already left** in the input box merges with the
  outgoing `/clear`. Nothing in the codebase mitigates this — the clipboard paste does not help,
  because pasted text lands *after* the residue exactly as typed text would.

Ctrl+U addresses the second and does not claim to address the first. Where a site is exposed to
both (see `## Outstanding Questions`), that is called out rather than silently conflated.

### Every site that writes a slash command

> **Superseded:** the original five-writer table, listing `TaskViewerProvider.ts:14086` (`ptyWrite`)
> as the single writer behind implementation.html's four clear buttons, and asserting "No webview
> edits: every button in terminals.html and implementation.html reaches one of the writers above."
> **Reason:** the enumeration was read from the PTY branch of `sendToTerminal` only. That handler
> has **two further fallback legs** for targets that are not PTY seats — `sendRobustText(terminal,
> input, …)` at `TaskViewerProvider.ts:14157` and `terminal.sendText(input, true)` at `:14159` —
> and both deliver the same `/clear` with no input-line reset. A registered `vscode.Terminal` agent
> in the Implementation panel therefore stays broken under the original table while every listed
> site is "done". The table also omitted `ptyHost.ts:183`, the child-process handler that actually
> performs the write for `ptyWrite`, and `ptyHost.ts:169/175/180` + `bootstrap.ts:1409/1416/1467`,
> the two hosts that reach `clearPty`/`modelPty`.
> **Replaced with:** the corrected table below — **eight** write legs across two hosts, with the
> rule pushed down to three chokepoints instead of patched at seven callers (see `## Proposed
> Changes`).

`grep -rnE "(write|sendText|input:|data:)[^\n]*'/[a-z]+" src/`, plus the generic relay branch on
each host and its non-PTY fallbacks:

| # | Write leg | Reached from | Covered by |
| :-- | :--- | :--- | :--- |
| 1 | `ptyPromptDelivery.ts:43` — `sendPromptToPty` clear branch | every auto-send with `clearBeforePrompt: true` | helper (change 1) |
| 2 | `ptyPromptDelivery.ts:114` — `clearPty` | terminals.js `ptyClearTerminal` / `ptyClearAllTerminals` → `ptyHost.ts:169,180` **and** `bootstrap.ts:1409,1467` | helper (change 1) |
| 3 | `ptyPromptDelivery.ts:128` — `modelPty` | terminals.js `ptySendModel` → `ptyHost.ts:175` **and** `bootstrap.ts:1416` | helper (change 1) |
| 4 | `ptyHost.ts:183` — `ptyWrite`, `handle.write(payload.data)` | `TaskViewerProvider.ts:14086`, the only caller of the `ptyWrite` verb; itself reached from implementation.html's four `sendToTerminal` `/clear` sends (`:1744`, `:2921`, `:2956`, `:3361`) | **chokepoint (change 2)** |
| 5 | `bootstrap.ts:1670` — `handle.write(text + '\r')` | same four buttons, standalone host | helper (change 3) |
| 6 | `TaskViewerProvider.ts:14157` — `sendRobustText(terminal, '/clear', …)` | **same four buttons when the target is a registered `vscode.Terminal`, not a PTY seat** | **change 5 — was missing** |
| 7 | `TaskViewerProvider.ts:14159` — `terminal.sendText('/clear', true)` | **same four buttons via the `HostTerminal` seam** | **change 5 — was missing** |
| 8 | `TaskViewerProvider.ts:5586` + `:20278` — `pasteTextViaClipboard(terminal, '/clear', …)` | phone-a-friend / kanban batch dispatch to a VS Code terminal | change 4 |
| 9 | `extension.ts:2906` — `sendRobustText(terminal, '/clear', false)` | `switchboard.clearAllTerminals` command | change 6 |

Legs 4 and 5 are the generic control-string branch: single-line, leading `/`, any command. Fixing
them covers "anything that sends a slash command" by rule rather than by enumeration — today that
set is `/clear` and `/model`, and it stays covered if a sixth command is added tomorrow. Legs 6 and
7 are the same content rule on the non-PTY fallback of the same handler.

No webview edits: every button in terminals.js and implementation.html reaches one of the legs
above. **`sendToTerminal` reaches three of them** depending on what kind of terminal the name
resolves to, which is why the rule is applied to the handler's control-string decision rather than
to one of its branches.

## Metadata

- **Complexity:** 5
- **Tags:** bugfix, reliability, cli, backend
- **Project:** Browser Switchboard

> **Superseded:** **Complexity:** 3 ("Two small helpers — one per host family — and seven call
> sites").
> **Reason:** 3 routes the card to an Intern. The corrected scope is 7 files across **two hosts and
> a process boundary** (`ptyPromptDelivery.ts`, `ptyHost.ts`, `bootstrap.ts`, `terminalUtils.ts`,
> `TaskViewerProvider.ts`, `extension.ts`, plus a test with source-text contract assertions), it
> changes the signature of a **shared** helper (`pasteTextViaClipboard`) that a prompt path also
> calls, and it must land a control byte in the correct position relative to two different framing
> mechanisms (bracketed paste on the PTY path, clipboard paste + focus acquisition on the VS Code
> path). Getting the *position* wrong is silent in both cases. That is a 5.
> **Replaced with:** **Complexity:** 5 → Send to Coder.

## User Review Required

None.

## Complexity Audit

### Routine

- One helper per host family, both trivially small; no new verbs, no new config keys, no new state.
- No persisted state, no settings, no file formats, no schema — nothing to migrate.
- `\x15` is a plain byte on every path. `terminal.sendText` already ships `\x1b[200~` / `\x1b[201~`
  as literal control writes in `_sendRobustTextBackground` (`terminalUtils.ts:274,286`), so the VS
  Code leg has a shipped precedent for passing raw control bytes through `sendText` unmodified.
- `ptyWrite` has exactly **one** caller in the entire tree (`TaskViewerProvider.ts:14086`), so
  adding a content rule inside it cannot over-apply to an unknown caller.

### Complex / Risky

- **Position, not presence, is the whole bug.** `\x15` must land **outside** any paste framing:
  before `\x1b[200~` on the PTY path, and after focus acquisition but before
  `workbench.action.terminal.paste` on the VS Code path. A control byte inside a bracketed-paste
  block is absorbed as literal text (see the framing rules at `ptyPromptDelivery.ts:48-86`), so a
  misplaced Ctrl+U silently prefixes the payload instead of clearing the line. Pinned by a test
  assertion on the PTY leg.
- **A shared helper gains an option.** `pasteTextViaClipboard` is also called by `sendRobustText`
  (`terminalUtils.ts:193`) for prompts over 100 chars. The new option must default **off** so the
  prompt path is byte-identical to today.
- **The Ctrl+U must be adjacent to the command it protects.** Sending it from the caller, before
  `pasteTextViaClipboard`, puts it on the far side of `_clipboardLock` (unbounded wait — under
  kanban batch dispatch the pastes for N terminals serialise) plus up to three focus-acquisition
  retries plus `PRE_PASTE_SETTLE_MS`. It would still be a "reset" that ran, hundreds of ms to
  seconds before the `/clear` it was meant to protect, with the user free to type in between.
- **Two hosts, one behaviour.** The extension host reaches PTYs through a child process; standalone
  owns them in-proc. Both must get the rule, and neither can be verified by the other's test.

## Edge-Case & Dependency Audit

### Race Conditions

- **Splice into an in-flight chunked paste.** `ptyHost.ts:183` (`ptyWrite`) and `bootstrap.ts:1670`
  currently call `handle.write()` **outside `withTerminalLock`** — a pre-existing hazard, since a
  `/clear` issued while `sendPromptToPty` is mid-chunk lands inside the paste block. Routing both
  through `writeSlashCommand` (which takes the lock) closes that gap as a side effect of this
  change. This is the reason the rule goes in the child rather than in the caller's payload.
- **Residue typed during the gap.** Mitigated by moving the Ctrl+U inside `pasteTextViaClipboard`,
  after focus is acquired and immediately before the paste. Residual window is
  `PRE_PASTE_SETTLE_MS` (200 ms) — irreducible without reordering the shipped paste sequence.
- **Focus lost mid-sequence.** `pasteTextViaClipboard` throws if it cannot acquire focus after 3
  attempts. Emitting the Ctrl+U *after* that check means a failed acquisition never leaves a stray
  control byte in an unrelated terminal.

### Security

- None. No new input surface, no user-controlled data added to any write. `\x15` is a fixed
  literal; the command text is unchanged from today.

### Side Effects

- **Input line already empty (the normal case).** Ctrl+U is a no-op. No visible change.
- **Target is a plain shell, not an agent CLI.** `\x15` kills the shell's input line — harmless.
  It must NOT be gated on CLI name or role: `ptyPromptDelivery` has an explicit no-identity-gate
  contract (`coder and shell roles receive identical framing`, asserted at
  `pty-prompt-delivery-framing.test.js:215`). Do not add a detection list.
- **Cursor is mid-line.** `unix-line-discard` kills from the cursor to the start of the line, so
  text to the right of the cursor survives. Typing leaves the cursor at the end, which is the
  reported case.
- **A CLI that does not bind `\x15`.** Claude Code is measured (see `## Goal` → Root cause). For
  the other CLI brands Switchboard drives, see `## Uncertain Assumptions`. Expected degradation is
  a silent no-op (control chars filtered), i.e. no worse than today; literal insertion would be
  worse than today.
- **PTY died between the active check and the write.** `clearPty`/`modelPty` already swallow write
  errors; the Ctrl+U goes inside the same `try`, so a dead PTY still resolves successfully.
- **Prompt path unchanged.** `clearBeforePrompt: false` deliveries and every `pasteTextViaClipboard`
  call from `sendRobustText` keep today's exact byte sequence — the new option defaults off.
- **Standing orders.** Untouched. Control strings never carried them and still don't.

### Dependencies & Conflicts

- **Timing.** +30 ms per PTY command (additive to the 600 ms PTY settle) and +30 ms per VS Code
  command (inside the existing 200 ms `PRE_PASTE_SETTLE_MS`, so effectively free there). The
  webview's `withClearingFeedback` disables the button for 600 ms; +30 ms stays inside that window,
  so no UI constant changes.
- **Migration.** None — byte-level delivery only. No persisted state, settings, or file formats.
- **Test contract.** `pty-prompt-delivery-framing.test.js:256` asserts the *source text* contains
  exactly `CONFIRM_CR_COUNT` occurrences of the literal `handle.write('\r')`. `writeSlashCommand`
  writes `command + '\r'` as a variable expression, not that literal, so the count is unaffected.
- `dist/` is not used for testing (installed VSIX only) — no build-artifact work.

## Dependencies

- None.

## Adversarial Synthesis

Key risks: (1) the fix is **positional** — a Ctrl+U inside a bracketed-paste block, or emitted
before the clipboard lock and focus dance, "runs" while the bug survives, and both failures are
silent; (2) the original site enumeration missed `sendToTerminal`'s two non-PTY fallback legs, so a
by-site fix would report complete while VS Code terminal agents stayed broken; (3) on CLI brands
other than Claude Code — where the binding is already measured — an unbound `\x15` inserted
literally rather than filtered would make those seats worse, not better.
Mitigations: push the rule to three chokepoints (`writeSlashCommand`, `ptyWrite`'s content rule,
`pasteTextViaClipboard`'s post-focus option) so coverage is structural rather than enumerated; pin
the Ctrl+U's position relative to `\x1b[200~` with a test assertion; run one manual step on a
non-Claude seat before rollout (`## Uncertain Assumptions`).

## Proposed Changes

### 1. `src/standalone/ptyPromptDelivery.ts` — the PTY helper (legs 1–3, and 4–5 via export)

```ts
// Ctrl+U (unix-line-discard). Agent CLIs keep a persistent input buffer: anything
// already sitting in it concatenates with the next write, so `/clear` lands as
// `…text/clear` — a prompt, not a command, and the context is never reset. This
// byte empties the line first. No-op when empty, harmless in a plain shell, so it
// is sent unconditionally — no CLI detection, no role gate.
// It MUST land OUTSIDE any bracketed-paste block — i.e. before `\x1b[200~`, never
// after it. Inside the block it is absorbed as literal text and silently prefixes
// the payload (see the framing rules below). It is written on its own so it
// arrives as a keypress rather than as part of a burst the TUI may treat as paste.
const CLEAR_INPUT_LINE = '\x15';
// Just enough for the TUI to process the kill before the command arrives. Not a
// clipboard/focus settle — this path writes straight to the pty master fd.
const CLEAR_INPUT_SETTLE_MS = 30;

/**
 * Write a single-line slash command with the input line reset first.
 *
 * Takes the per-terminal lock, so a slash command can never splice into an
 * in-flight chunked paste from sendPromptToPty. Callers that ALREADY hold the
 * lock (sendPromptToPty's clear branch) must call writeSlashCommandLocked.
 */
export async function writeSlashCommand(handle: ExtendedTerminalHandle, command: string): Promise<void> {
    return withTerminalLock(handle.name, () => writeSlashCommandLocked(handle, command));
}

/** Lock-free body. Callers must already hold the terminal lock. */
export async function writeSlashCommandLocked(handle: ExtendedTerminalHandle, command: string): Promise<void> {
    handle.write(CLEAR_INPUT_LINE);
    await new Promise(r => setTimeout(r, CLEAR_INPUT_SETTLE_MS));
    handle.write(command.replace(/[\r\n]+$/, '') + '\r');
}
```

> **Superseded:** a single `writeSlashCommand` whose doc comment reads *"Callers must already hold
> the terminal lock."*
> **Reason:** two of its four intended callers — `ptyHost.ts:183` (`ptyWrite`) and
> `bootstrap.ts:1670` — do **not** hold the lock today, and that is a pre-existing splice hazard
> this change is well positioned to close. A helper that silently requires a lock its callers do
> not take converts a documented invariant into a latent bug.
> **Replaced with:** a locking `writeSlashCommand` plus a `writeSlashCommandLocked` body for the
> one caller (`sendPromptToPty`) that is already inside the lock. `withTerminalLock` is a
> promise-chain, not a reentrant mutex — calling the locking variant from inside the lock would
> deadlock, so the split is required, not stylistic.

Use it at all three in-module sites:

```ts
// sendPromptToPty — clear branch, already inside withTerminalLock (was: handle.write('/clear\r'))
if (opts?.clearBeforePrompt) {
    await writeSlashCommandLocked(handle, '/clear');
    const delay = opts.clearBeforePromptDelayMs ?? DEFAULT_CLEAR_SETTLE_MS;
    await new Promise(r => setTimeout(r, Math.min(10000, Math.max(0, delay))));
}

// clearPty  (was: handle.write('/clear\r'))
try { await writeSlashCommandLocked(handle, '/clear'); }
catch { /* PTY died between check and write — nothing to clear */ }

// modelPty  (was: handle.write('/model\r'))
try { await writeSlashCommandLocked(handle, '/model'); }
catch { /* PTY died between check and write — nothing to model */ }
```

`clearPty` and `modelPty` keep their existing `withTerminalLock(handle.name, …)` wrappers, so the
`Locked` variant is correct in all three.

### 2. `src/standalone/ptyHost.ts:183` — `ptyWrite` gets the content rule (leg 4)

> **Superseded:** editing `TaskViewerProvider.ts:14086` to prepend the byte into the IPC payload —
> `ptyRes = await this._ptyHostVerb('ptyWrite', { name: …, data: '\x15' + input + '\r' })`.
> **Reason:** three problems. (a) It contradicts the plan's own stated invariant that `\x15` is its
> own write with a settle behind it — one concatenated 8-byte write with no settle is a *different*
> delivery than the helper's, so the two hosts would not behave identically. (b) It leaves
> `ptyWrite` writing outside `withTerminalLock`, so the `/clear` can still splice into an in-flight
> chunked paste — the reset lands, and then gets absorbed as literal text inside the paste block,
> which is the exact failure mode the plan warns about. (c) It puts the rule in the *caller*, one
> layer above the write, so any future `ptyWrite` caller silently opts out.
> **Replaced with:** the rule moves into the child, at the write itself. `ptyWrite` has exactly one
> caller in the tree, so this cannot over-apply. `TaskViewerProvider.ts:14086` needs **no edit at
> all** for the PTY leg.

```ts
case 'ptyWrite': {
    const handle = fleet.get(payload.name);
    if (!handle) { return { success: false, error: `No such terminal: ${payload.name}` }; }
    if (handle.status === 'active') {
        const data: string = payload.data || '';
        // Content rule, mirroring sendToTerminal / bootstrap: a single-line
        // leading-slash write is a slash command, and every slash command gets
        // the input line reset first. writeSlashCommand also takes the
        // per-terminal lock, so the command cannot splice into an in-flight
        // chunked paste from sendPromptToPty (it previously could).
        const body = data.replace(/[\r\n]+$/, '');
        if (body && !body.includes('\n') && body.trimStart().startsWith('/')) {
            await writeSlashCommand(handle, body);
        } else {
            handle.write(data);
        }
        return { success: true };
    }
    return { success: false, error: `Terminal ${payload.name} is not active` };
}
```

Add `writeSlashCommand` to the existing `import { clearPty, modelPty, sendPromptToPty } from
'./ptyPromptDelivery'` at `ptyHost.ts:10`.

### 3. `src/standalone/bootstrap.ts:1670` — `sendToTerminal` control-string branch (leg 5)

Already imports from `ptyPromptDelivery` (`bootstrap.ts:39`); add `writeSlashCommand` to that
import.

```ts
if (!text.includes('\n') && text.trimStart().startsWith('/')) {
    await writeSlashCommand(handle, text);   // was: handle.write(text + '\r')
} else {
    await deliverPrompt(handle, text, { clearBeforePrompt: false }, payload.standingOrders !== false);
}
```

### 4. `src/services/terminalUtils.ts` — the VS Code helpers (legs 6–9)

Two exports: an option on the clipboard helper (for the paste legs) and a standalone function (for
the `sendText` legs).

```ts
// Ctrl+U (unix-line-discard) — see ptyPromptDelivery.ts for the full rationale.
// sendText writes straight to the terminal's stdin without stealing focus, the same
// way _sendRobustTextBackground writes its bracketed-paste markers below.
export const CLEAR_INPUT_LINE = '\x15';
const CLEAR_INPUT_SETTLE_MS = 30;

/**
 * Reset a terminal's CLI input line. For the sendText-based legs; the clipboard
 * leg uses pasteTextViaClipboard's `clearInputLine` option instead, because the
 * byte must land AFTER focus acquisition, not before the clipboard lock.
 */
export async function clearTerminalInputLine(terminal: vscode.Terminal): Promise<void> {
    try {
        terminal.sendText(CLEAR_INPUT_LINE, false);
        await new Promise(r => setTimeout(r, CLEAR_INPUT_SETTLE_MS));
    } catch { /* terminal closed — nothing to reset */ }
}
```

And inside `pasteTextViaClipboard`, a **default-off** option:

```ts
export async function pasteTextViaClipboard(
    terminal: vscode.Terminal,
    text: string,
    options?: { acquireFocus?: boolean; clearInputLine?: boolean }
): Promise<void> {
```

> **Superseded:** calling `clearTerminalInputLine(terminal)` from the caller, immediately before
> `await pasteTextViaClipboard(terminal, '/clear', { acquireFocus: true })`.
> **Reason:** everything expensive in `pasteTextViaClipboard` happens *after* the caller returns
> from `clearTerminalInputLine` — `withClipboardLock` (unbounded: `TaskViewerProvider.ts:20255-20259`
> documents that batch dispatch deliberately serialises every terminal's paste on this one lock),
> up to three 20–50 ms focus-acquisition retries, and `PRE_PASTE_SETTLE_MS` (200 ms). Under a
> multi-terminal batch the Ctrl+U precedes its own `/clear` by seconds, with the user free to type
> in the gap. It would also fire on a terminal whose focus acquisition then *fails* and throws,
> leaving a stray control byte behind.
> **Replaced with:** the byte is emitted inside the helper, after focus is settled and immediately
> before `workbench.action.terminal.paste`, so it is adjacent to the command it protects and is
> never sent on the throw path.

Emit it at the single point where both focus branches have converged, just before the paste
command:

```ts
        if (acquireFocus) {
            // …existing 3-attempt focus loop, throw-on-failure, PRE_PASTE_SETTLE_MS…
        } else {
            terminal.show(false);
            await new Promise(r => setTimeout(r, PRE_PASTE_SETTLE_MS));
        }

        // Reset the CLI input line immediately before the paste — never as part of
        // the pasted text. workbench.action.terminal.paste delivers the clipboard
        // inside a bracketed-paste block when the TUI has enabled ?2004h, where a
        // control byte is literal text, so '\x15' + text in the clipboard is wrong.
        if (options?.clearInputLine) {
            terminal.sendText(CLEAR_INPUT_LINE, false);
            await new Promise(r => setTimeout(r, CLEAR_INPUT_SETTLE_MS));
        }

        await vscode.commands.executeCommand('workbench.action.terminal.paste');
```

The option defaults off, so `sendRobustText`'s large-prompt call at `terminalUtils.ts:193` — which
forwards `options` straight through — is byte-identical to today.

### 5. `src/services/TaskViewerProvider.ts` — the four VS Code legs

**5a. The two clipboard clears (leg 8).** Phone-a-friend (`:5586`) and kanban batch dispatch
(`:20278`), both inside their existing `if (clearBeforePrompt)` block:

```ts
await pasteTextViaClipboard(terminal, '/clear', { acquireFocus: true, clearInputLine: true });
```

**5b. `sendToTerminal`'s non-PTY fallbacks (legs 6–7) — the gap the original plan missed.** When
the name resolves to a registered `vscode.Terminal` or a `HostTerminal` seam instead of a PTY seat,
control flow reaches `:14153-14159` and sends `/clear` with no reset. Reuse the branch's own
content rule by hoisting it above the PTY block so both branches share one decision:

```ts
// Hoisted out of the PTY block (was declared at :14083) — the non-PTY fallbacks
// below deliver the same control strings and need the same rule.
const isControlString = !input.includes('\n') && input.trimStart().startsWith('/');
```

then at the delivery site:

```ts
if ('processId' in terminal) {
    const soOpt = data.standingOrders === false
        ? false
        : await this._resolveStandingOrdersForVsCode();
    // Same rule as the PTY leg: reset the input line before a slash command, or
    // the CLI concatenates it with whatever the user left in the box.
    if (isControlString) { await clearTerminalInputLine(terminal); }
    await sendRobustText(terminal, input, paced, undefined, { standingOrders: soOpt });
} else {
    if (isControlString && typeof terminal.sendText === 'function') {
        terminal.sendText(CLEAR_INPUT_LINE, false);
        await new Promise(r => setTimeout(r, 30));
    }
    terminal.sendText(input, true);
}
```

Import `clearTerminalInputLine` and `CLEAR_INPUT_LINE` from `terminalUtils` alongside the existing
`pasteTextViaClipboard` / `sendRobustText` imports.

The seam leg writes the byte directly rather than calling `clearTerminalInputLine`, because
`HostTerminal` is not a `vscode.Terminal` — its `sendText(text, addNewLine)` is the seam's own
two-arg signature, and passing `false` for the second argument is what keeps the byte from being
submitted as its own line.

### 6. `src/extension.ts:2906` — `switchboard.clearAllTerminals` (leg 9)

```ts
clearPromises.push(
    clearTerminalInputLine(terminal).then(() => sendRobustText(terminal, '/clear', false))
);
```

(`/clear` is 6 chars, under `CLIPBOARD_PASTE_THRESHOLD` at `terminalUtils.ts:189`, so
`sendRobustText` takes the `sendText` branch — the Ctrl+U must precede it or the command
concatenates exactly as reported. See `## Outstanding Questions` for the separate, pre-existing
question about this leg using `sendText` at all.)

### 7. `src/test/pty-prompt-delivery-framing.test.js`

The `clearBeforePrompt: true` case (`:187-212`) currently asserts `writes[0] === '/clear\r'`:

```js
assert.strictEqual(writes[0], '\x15', 'first write must reset the CLI input line (Ctrl+U)');
assert.strictEqual(writes[1], '/clear\r', 'second write must be the /clear command');
// Ctrl+U must never land inside the paste block — there it is literal text.
const pasteStart = writes.indexOf('\x1b[200~');
assert.ok(!writes.slice(pasteStart).includes('\x15'), 'no Ctrl+U after the open marker');
```

The bare-`'\r'` count assertion (`submitCrCount === CONFIRM_CR_COUNT`, `:206-211`) is unchanged and
must still pass — `\x15` is not `\r`, and the command still carries its own `\r` inside the string.
The source-text assertion at `:256` (`code.match(/handle\.write\('\\r'\)/g).length === 2`) is also
unchanged: `writeSlashCommandLocked` writes `command + '\r'`, an expression, not that literal.

The `clearBeforePrompt: false` byte-parity cases (`:125-184`) are untouched: with the flag off there
is no slash command, so the framing stays byte-identical to `_sendRobustTextBackground`. The
no-identity-gate case at `:215` is likewise untouched — `writeSlashCommand` branches on message
content, never on `handle.name` or `handle.role`.

## Verification Plan

### Automated Tests

*(This improve pass did not compile or run anything — the session carried SKIP COMPILATION / SKIP
TESTS. The gates below are the implementer's.)*

1. `npx tsc --noEmit -p tsconfig.json` (or `npm run compile-tests`) — clean.
2. `node src/test/pty-prompt-delivery-framing.test.js` — green, including the updated clear-branch
   assertions, the unchanged `clearBeforePrompt: false` parity cases, the unchanged
   `handle.write('\r')` source count, and the unchanged no-identity-gate case.
3. `node src/test/pty-route-surface-contract.test.js` — unchanged, must stay green (no verb surface
   change: `ptyWrite` keeps its name, payload shape, and return shape).
4. `node src/test/browser-direct-terminal-helpers.test.js` — unchanged; it asserts
   `_tryFleetDeliveryForRole` does **not** hand-roll a `ptyWrite`, and this change adds no new
   `ptyWrite` call site.
5. Stash-verify first: five regression tests are red at HEAD independently of this work. Confirm
   the same five, and only those five, are red before attributing any failure to this change.

### Manual (installed VSIX)

6. **Run this one first, before writing any code** (see `## Outstanding Questions` — it decides
   whether the plan is needed at all). Open a claude seat in the cockpit. Type `how do I` into the
   input box **by hand**, without pressing Enter, and without dispatching anything to that seat —
   the residue must be human-typed, not left by a stranded paste. Click `clear` on that pane. On
   current `HEAD` this should reproduce the bug: the CLI answers `how do I/clear` instead of
   resetting. After the change: the typed text disappears and the CLI performs a real context
   reset.
7. Same residue, click `model` → the model picker opens.
8. Same residue on two seats, click `CLEAR ALL TERMINALS` → both reset.
9. Same residue in a coder seat, dispatch a card with `switchboard.terminal.clearBeforePrompt`
   enabled → residue gone, `/clear` executes, prompt arrives clean against fresh context.
10. Same residue in an Implementation-panel agent backed by a **PTY seat**, click its per-agent
    `clear` → real reset (the `ptyWrite` → `writeSlashCommand` path).
11. **Same residue in an Implementation-panel agent backed by a registered `vscode.Terminal`**
    (not a PTY seat), click its per-agent `clear` → real reset. This is the leg the original plan
    missed; step 10 passing does **not** imply this one passes.
12. Same residue in a registered `vscode.Terminal` agent, run `Switchboard: Clear All Terminals`
    → real reset (the `sendText` path).
13. Batch dispatch to **two or more** VS Code terminals at once with residue in each → both reset.
    This is the case that fails if the Ctrl+U is emitted before `_clipboardLock` rather than inside
    `pasteTextViaClipboard`.
14. Control case: clear a seat whose input box is already empty → identical behaviour to today,
    no stray blank line.
15. Regression case: dispatch a **long** prompt (>100 chars) to a VS Code terminal with
    `clearBeforePrompt` **off** → byte-identical to today, no Ctrl+U anywhere (proves the
    `clearInputLine` option defaulted off on `sendRobustText`'s clipboard call).

## Uncertain Assumptions

The user was advised to run web research to confirm the following before implementation. Everything
else in this plan was verified directly against the code in this repo.

> **Superseded:** an open question over whether agent CLIs bind `\x15` at all, Claude Code
> included, flagged as the single load-bearing assumption of the change.
> **Reason:** already measured and recorded in this repo. `feature_plan_20260813103000_pty-prompt-delivery-never-submits.md`
> carries an operator observation (2026-08-13) that Ctrl-U **does** clear unsubmitted input in
> Claude Code, and that plan superseded its own contrary conclusion — that a bracketed-paste "pill"
> was exempt from Ctrl-U — on the strength of it. Raising it again re-litigates a settled finding
> and revives a theory that plan already killed.
> **Replaced with:** the narrower residual question below — the *other* CLI brands, and what
> happens when a CLI does not bind the byte.

1. **CLIs other than Claude Code either bind `\x15` or discard it — never insert it literally.**
   Claude Code is measured (see `## Goal` → Root cause) and is not in question. Switchboard drives
   19 CLI brands, and the two TUI families differ in principle: `prompt-toolkit` ships emacs
   bindings including Ctrl+U, while Ink-based inputs implement their own key handling and may not.
   The failure mode matters more than the binding — a TUI that *filters* an unbound control byte
   degrades to today's behaviour (no worse), whereas one that *inserts* it literally turns `/clear`
   into `^U/clear` and makes that seat **worse** than today, silently. Proceeding on the assumption
   that unbound control bytes are filtered rather than inserted, which is the near-universal
   convention for terminal line editors. Manual steps 6 and 10 on a **non-Claude** seat are the
   cheapest confirmation; run one before rollout.

## Outstanding Questions

- **[user]** **Is the residue this plan targets human-typed or machine-stranded?** The sibling plan
  `feature_plan_20260813103000_pty-prompt-delivery-never-submits.md` describes the same
  concatenation shape under its root cause 3 — *"`ptyWrite` with `Ctrl-U` (`chr(21)`) did not
  remove it either — so a subsequent re-dispatch **appended to the residue**"* — and resolved it
  differently: the residue there was **machine-made**, a prompt stranded by a split bracketed-paste
  close marker, and the framing fix (now shipped) removes it at the source. Two readings therefore
  exist, with different verdicts:
  - *Machine-stranded* — already fixed upstream. Ctrl+U would be re-fixing a dead cause, and would
    not have worked alone anyway: inside an open paste `\x15` is absorbed as literal text, which is
    precisely why it "did not remove it" in the earlier incident. That plan's recorded recovery is
    `\x1b[201~` **then** `\x15`, not `\x15` alone.
  - *Human-typed* — the user types into the box and walks away. No framing fix touches this and
    none can; the writers genuinely assume an empty line, and nothing resets it.

  Proceeding on the **human-typed** reading, which this plan's `## Goal` states explicitly and
  which the `/model` symptom corroborates: a stranded paste cannot explain `/model` failing to open
  the model picker on an otherwise healthy terminal, because that path never pastes. Confirmation
  is manual step 6 — type into a seat by hand, do not dispatch to it, then click `clear`. If that
  step cannot reproduce the bug on current `HEAD`, **stop and re-scope**: the reported failure was
  then the already-fixed stranding mode, and this plan is not needed. That check costs one minute
  and should be run before any code is written.

- **[user]** `switchboard.clearAllTerminals` (leg 9) delivers `/clear` through
  `sendRobustText`'s `sendText` branch, while two other places in this codebase
  (`terminalUtils.ts:86-93`, `TaskViewerProvider.ts:20286-20288`) explicitly refuse to fall back to
  `sendText('/clear')` because it "re-introduces slash-command concatenation in CLI agents" — the
  *writer-side* bug described under `## Goal`, distinct from the residue bug this plan fixes.
  Should leg 9 also be switched to the `pasteTextViaClipboard` path those two sites use? —
  proceeding on the assumption that it should **not**: that is a second, pre-existing defect with
  its own blast radius (focus stealing on every registered terminal at once), and widening this
  plan to cover it would change a working command's delivery mechanism under cover of a byte-level
  fix. Ctrl+U is added to leg 9 either way, and it is correct on either delivery path.

---

**Recommendation: Send to Coder** (Complexity 5).

## Review Findings

All 9 write legs land the rule at the prescribed position, and no leg was missed (`grep` for `'/clear'`/`'/model'` across `src/` returns only helper call sites plus the four `implementation.html` buttons that route into them). One MAJOR gap: the plan's own "two hosts, one behaviour — neither can be verified by the other's test" was left unenforced — only `pty-prompt-delivery-framing.test.js` was updated, so the `ptyWrite` content rule, bootstrap's leg, and all four VS Code legs had no regression guard; fixed by adding a cross-host source-contract test to `pty-route-surface-contract.test.js` (already CI-wired) that pins both hosts' routing *and* the Ctrl+U's ordering between focus-settle and `workbench.action.terminal.paste`. One NIT fixed: the `HostTerminal` seam leg hardcoded `30` instead of `CLEAR_INPUT_SETTLE_MS`, which is now exported and used. Files changed by this review: `src/test/pty-route-surface-contract.test.js`, `src/services/terminalUtils.ts`, `src/services/TaskViewerProvider.ts`. Verification: `tsc --noEmit` and `npm run compile-tests` clean (5 pre-existing TS2835 dynamic-import errors confirmed present at `HEAD`, unchanged); `pty-prompt-delivery-framing`, `pty-route-surface`, `browser-direct-terminal-helpers`, `terminal-rest-clear`, `seat-safeguards`, `standing-orders-marker`, `minimal-prompt` all green. Remaining risks: manual steps 6–15 are unrun (no VSIX in this pass), and a CLI brand that inserts an unbound `\x15` literally rather than filtering it would regress that seat — run one manual clear on a non-Claude seat before rollout.

## Completion Report

Implemented unconditional input-line reset (`\x15` / Ctrl+U) across all 9 terminal slash command write legs. Added `writeSlashCommand` and `writeSlashCommandLocked` in `ptyPromptDelivery.ts`, integrated them into `ptyHost.ts` (`ptyWrite`) and `bootstrap.ts` (`sendToTerminal`), added `clearTerminalInputLine` and `clearInputLine` clipboard option in `terminalUtils.ts`, updated `TaskViewerProvider.ts` clipboard and non-PTY fallback delivery sites, updated `extension.ts` `clearAllTerminals` command, and updated assertions in `pty-prompt-delivery-framing.test.js`. Files changed: `src/standalone/ptyPromptDelivery.ts`, `src/standalone/ptyHost.ts`, `src/standalone/bootstrap.ts`, `src/services/terminalUtils.ts`, `src/services/TaskViewerProvider.ts`, `src/extension.ts`, `src/test/pty-prompt-delivery-framing.test.js`. No issues encountered.

**Reviewer pass (2026-08-17).** Verified all 9 legs against the plan and traced every caller of the changed signatures: `ptyWrite` still has exactly one caller, `pasteTextViaClipboard`'s new option is structurally default-off (`sendRobustText`'s options type carries no `clearInputLine`), `writeSlashCommandLocked` is used by exactly the three in-lock callers so `withTerminalLock`'s promise chain cannot self-deadlock, and both seat-block cache invalidations still key on a `/clear` that trims correctly. Added the missing cross-host regression guard to `src/test/pty-route-surface-contract.test.js` and replaced the seam leg's hardcoded `30` with an exported `CLEAR_INPUT_SETTLE_MS` (`src/services/terminalUtils.ts`, `src/services/TaskViewerProvider.ts`). All gates green; no new type errors.

