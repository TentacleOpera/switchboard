# A Prompt Sent To A PTY Terminal Does Not Submit

## Goal

Make `ptySendPrompt` actually deliver — text pasted **and** submitted — to a PTY fleet terminal, and give the delivery path a recovery route when it does not.

> **Scope note (operator decision, 2026-08-13).** The recovery-route half of this goal is **cut from this card**. Once the framing defect (root cause 5) is fixed there is no stranded state left to recover from, and no agent can detect one anyway — a recovery verb would have had no caller. The goal statement is preserved above verbatim; only the delivery half is in scope here.

### The problem

Reported from a live eight-subtask dispatch run, three times in one session:

> *"the message did not land for some reason… it appeared in the terminal input, but enter was not pressed."*
> *"but the terminal is not accepting any input now. it is like your send landed too soon after the clear?"*
> *"i had to press enter myself it actually input it again."*

`POST /terminals/verb/ptySendPrompt` returned `{"success":true}` on every one of those sends. The prompt reached the terminal's input buffer and sat there. A head agent driving coders through this route therefore waits forever on a callback that cannot come, with a success response as its only evidence — the single worst failure shape for an attended dispatch pattern, because nothing distinguishes it from a coder that is simply thinking.

One coder sat 675 seconds with zero output before the condition was noticed by hand.

### Root cause 1 — the confirm-Enter gate can never fire on a fleet terminal

`src/standalone/ptyPromptDelivery.ts:49`:

```ts
if (CLI_AGENT_REGEX.test(handle.name) || CLI_AGENT_REGEX.test(handle.role)) {
    await new Promise(r => setTimeout(r, 200));
    handle.write('\r');
}
```

with `CLI_AGENT_REGEX = /copilot|gemini|agy|claude|windsurf|cursor|cortex/i` (`:3`).

The gate tests the terminal's **name** and **role**. PTY fleet terminals are named `${parent.friendlyName}-${label||role}${suffix}` by `spawnDelegates`, and their roles come from the role registry — `coder`, `lead`, `planner`, `analyst`, `reviewer`. **No fleet terminal name or role can ever match that regex**, whatever CLI it is actually running. Verified against the live fleet:

| terminal | role | confirm CR |
| :-- | :-- | :-- |
| `Feature Implementation-coder-1` | `coder` | never fires |
| `Feature Implementation` | `lead` | never fires |
| `planner-1` | `planner` | never fires |
| `analyst-1` | `analyst` | never fires |

So a fleet terminal gets exactly **one** `\r`, 100 ms after the bracketed-paste close. When the TUI is still rendering the paste, that single CR is consumed by the paste handler and there is no second one behind it. The prompt stays in the buffer.

### Why this works in VS Code and not here — the same bug, hidden by a naming convention

`sendRobustText` (`src/services/terminalUtils.ts`) runs the same heuristic at `:149`:

```ts
const isCliAgent = /\b(copilot|gemini|agy|claude|windsurf|cursor|cortex)\b/i.test(terminal.name);
```

It works there for an incidental reason: a VS Code terminal running Claude Code is *named* `Claude CLI`, so the regex hits and the confirm Enter fires. The heuristic was never a CLI detector — it was a filename match that happened to be true in one host. Carried into a host that names terminals after their **role**, it silently evaluates false forever.

This is the answer to *"we fixed it inside VS Code but it is back in the pty terminals"*. It was never fixed in a way that could survive the move; the fix was load-bearing on VS Code's terminal-naming convention.

### Root cause 2 — a fixed 2000 ms guess in place of a readiness check

`ptyPromptDelivery.ts:27-31`:

```ts
handle.write('/clear\r');
const delay = opts.clearBeforePromptDelayMs ?? 2000;
await new Promise(r => setTimeout(r, Math.min(10000, Math.max(0, delay))));
```

No readiness detection. `/clear` on a large Claude Code context takes longer than 2 s to tear down and repaint, so the bracketed paste is written into a TUI that is mid-reset. Observed result: text lands, input enters a state a subsequent bare `\r` cannot submit, and the terminal appears wedged.

This branch was effectively dormant until now — `.agents/skills/terminal-coder-dispatch/SKILL.md` mandated `clearBeforePrompt: false` on every send, so nothing exercised it. The sibling subtask *Clear The Coder Between Subtasks* changed that rule to `true` on the first prompt of each subtask, which lit up an untested path on its first real run.

> **Superseded:** The conclusion that the fixed 2000 ms is too short, that `/clear` on a large context outlasts it, and that this is why the cleared path wedges — *"The skill rule is correct; the transport cannot honour it. Until this plan lands, driving agents must keep passing `false` and accept the context bleed."*
> **Reason:** Operator observation, 2026-08-13: **`/clear` completes very quickly in the PTY terminals; 2000 ms is more than enough.** The 2000 ms was never the problem. The user's own report — *"it is like your send landed too soon after the clear?"* — was a hypothesis offered while diagnosing, not a measurement, and this plan mistook it for one. Root cause 5 explains the cleared-path wedge without any timing claim: the marker split is deterministic on payload **length**, so it strands prompts on the cleared and uncleared paths alike. Nothing about `/clear` needed to be slow for the reported failure to occur.
> **Replaced with:** The code facts above stand — there is no readiness detection and the delay is a fixed guess. But the guess is an adequate one, so it stays exactly as it is. No readiness wait, no change to `clearBeforePromptDelayMs`, no change to the `switchboard.terminal.clearBeforePromptDelay` setting. The skill's `clearBeforePrompt: true` rule becomes safe to follow as soon as the framing fix lands, with no transport change behind it.

### Root cause 3 — there is no recovery route

Once a prompt is stranded in the buffer there is no supported way to clear it. `ptyWrite` with a bare `\r` did not submit it. `ptyWrite` with `Ctrl-U` (`chr(21)`) did not remove it either — so a subsequent re-dispatch **appended to the residue**, which is the *"it actually input it again"* half of the report. Recovery currently requires a human pressing keys in the terminal, which defeats the point of an unattended-capable route.

> **Superseded:** The explanation that `Ctrl-U` fails because *"a bracketed paste in Claude Code's TUI is a single multi-line 'pasted text' pill, and Ctrl-U does not remove it"* — i.e. that the pill is a special object outside Ctrl-U's reach.
> **Reason:** Operator observation, 2026-08-13: **Ctrl-U does clear unsubmitted input in Claude Code.** So the keybinding works and the pill is not exempt. The reason the keystroke had no effect is root cause 5: a terminal left in bracketed-paste mode by a split close marker absorbs **every** subsequent byte as literal pasted text. `\x15` never reaches the keybinding layer — it is appended to the paste, exactly as `\r` is. This single mechanism accounts for all four reported symptoms at once: Enter does not submit, the terminal "is not accepting any input", Ctrl-U does not clear, and the re-dispatch appends. There is one bug here, not three.
> **Replaced with:** The observation stands — recovery is currently manual. But the missing piece was never a mystery keystroke; it was that the paste was still open. **No recovery verb is built** (operator decision, 2026-08-13): the framing fix removes the state that needed recovering, and nothing in the system can detect a stranded prompt to trigger a verb with — a lead agent cannot distinguish "stuck" from "thinking", which is why the original incident cost 675 seconds. If a stranding mode ever survives the framing fix, the recovery is recorded here for whoever needs it: write `\x1b[201~` to force-close any open paste, then `\x15` to discard the input. Both bytes are idempotent no-ops on a healthy terminal. Detecting a stalled coder is a separate problem at a separate layer — see *Proposed Changes → Split out*.

### Root cause 4 — the VS Code gate is itself incomplete

Independent of the fleet, `Devin CLI` does not match `/\b(copilot|gemini|agy|claude|windsurf|cursor|cortex)\b/i` either. Any VS Code terminal running Devin — a configuration this project explicitly supports — has been getting no confirm Enter the whole time. The hardcoded vendor list is a maintenance trap: every new agent CLI silently regresses delivery until someone edits a regex.

### Root cause 5 — the bracketed-paste markers are chunked with the payload *(found during this improve pass)*

`ptyPromptDelivery.ts:34-43` frames **first** and chunks **second**:

```ts
const framed = `\x1b[200~${text}\x1b[201~`;
for (let i = 0; i < framed.length; i += CHUNK_SIZE) { handle.write(framed.slice(i, i + CHUNK_SIZE)); … }
```

The 6-byte close marker `\x1b[201~` therefore straddles a 256-byte boundary whenever `(6 + text.length) % 256` falls in the last five bytes of a chunk — the `6` is the open marker `\x1b[200~`'s own width, which precedes the payload in the framed string and offsets the close marker's start; equivalently `text.length % 256 ∈ [245,249]`. This is roughly a 1-in-50 chance per send, and *deterministic for a given prompt length*. When it splits, the two halves arrive in separate reads **30 ms apart**. A TUI whose stdin paste parser works per-read (rather than as a byte-stream state machine) never sees a paste close, and the input stays in paste mode — where a subsequent bare `\r` is buffered as literal text rather than treated as submit. That is an exact mechanical match for *"the message… appeared in the terminal input, but enter was not pressed"* and for *"the terminal is not accepting any input now"*.

> **Correction (2026-08-13, post-implementation).** The original text above gave the split condition as `text.length % 256 ∈ [251,255]`, omitting the 6-byte open marker that precedes the payload in the framed string. The close marker starts at index `6 + text.length`, so the correct condition is `(6 + text.length) % 256 ∈ [251,255]`, i.e. `text.length % 256 ∈ [245,249]`. The real stranding lengths are therefore 245, 501, 757, 1013, 1269, 1525 (`% 256 = 245`), not 507, 763, 1019, 1275 (`% 256 = 251`, which do not split — their close marker starts at chunk position 1). **This does not change the fix**: the ported write sequence emits the markers as standalone writes regardless of length, so no length can split. It also does not change why the behavioural test caught the bug against the pre-fix code — every behavioural check fails at *any* length there, because the open marker was never a standalone write in the old implementation either, so the "whole marker" assertion fails universally. The wrong lengths still caught the bug for the right structural reason; they were just not the lengths that exercise the *specific* close-marker split this root cause describes.

The VS Code background path does **not** have this defect: `_sendRobustTextBackground` (`terminalUtils.ts:241-253`) writes `\x1b[200~` and `\x1b[201~` as their own standalone `sendText` calls and chunks only the payload between them. This is a fourth divergence between the two implementations of one contract, and unlike the other three it can strand a prompt even when every delay and every gate is correct.

### Provenance

`git log` puts `CLI_AGENT_REGEX`, the bracketed-paste framing and the chunked write all in one commit — `cfd90944`, *"Standalone Browser PTY Terminal Fleet"*, 2026-07-31. The module has been touched twice since (`9087436f`, `1c7de0f6`), neither time on the submission path.

The delivery module was written from scratch for the standalone fleet rather than reused, because `sendRobustText` takes a `vscode.Terminal` and could not be called directly. The reimplementation copied the **shape** of `sendRobustText` — chunking, a CLI-agent regex, a confirm Enter — without its **robustness**: no clipboard path, no adaptive delays, no remote detection, and no adaptation of the regex to a host where names do not carry CLI identity. Two implementations of one contract, and only one of them was ever hardened.

| | `sendRobustText` (VS Code) | `sendPromptToPty` (fleet) |
| :-- | :-- | :-- |
| large payload | clipboard paste via `pasteTextViaClipboard` | raw bracketed-paste escapes, 256-byte chunks / 30 ms |
| settle before Enter | 300 ms (600 ms remote) | 100 ms, fixed |
| confirm Enter | +150 ms (300 ms remote), gated on name | +200 ms, gated on name **or role** — never true |
| remote awareness | `isRemoteTerminal()` | none |
| paste markers | standalone whole writes, payload chunked between them | inside the chunked stream — can split across a 30 ms gap |

### The proven implementation already existed, 11 days before this module was written

`git log` on `src/services/terminalUtils.ts`: `_sendRobustTextBackground` landed in **`cf8846b0`, 2026-07-20**. `ptyPromptDelivery.ts` was written in **`cfd90944`, 2026-07-31** — eleven days later, from scratch, without reusing it.

That function is the portable half of `sendRobustText`: it delivers a payload of any size to a raw-mode TUI using **only** writes to the terminal's stdin, with no `vscode.env.clipboard`, no `workbench.action.terminal.paste`, and no VS Code command at all. `terminal.sendText(x, false)` maps 1:1 onto `handle.write(x)`. It has been in continuous use for real prompt dispatch (`TaskViewerProvider.ts:25255,25282,25697`) since it landed.

```ts
// terminalUtils.ts:241-258 — the shipped, proven sequence
terminal.sendText('\x1b[200~', false);                       // marker: its OWN write
for (let i = 0; i < text.length; i += CHUNK_SIZE) {          // payload only, 256 / 30 ms
    terminal.sendText(text.substring(i, i + CHUNK_SIZE), false);
    if (i + CHUNK_SIZE < text.length) { await new Promise(r => setTimeout(r, CHUNK_DELAY_MS)); }
}
terminal.sendText('\x1b[201~', false);                       // marker: its OWN write
await new Promise(r => setTimeout(r, SUBMIT_DELAY_MS));      // 100 ms
terminal.sendText('', true);                                 // ONE Enter. No regex. No second CR.
```

### One Enter is what a paste takes — the confirm CR belongs to the *non*-paste path

Tabulating what each VS Code delivery path actually does resolves root cause 1 without leaving the repository:

| path | mechanism | Enters sent | identity check |
| :-- | :-- | :-- | :-- |
| clipboard (`terminalUtils.ts:157-166`) | real clipboard paste | **1** | none |
| background (`:241-258`) | bracketed-paste escapes | **1** | none |
| flattened chunks (`:178-201`) | no paste — newlines stripped, chunked `sendText` | **2** | `isCliAgent` |
| `sendPromptToPty` (`ptyPromptDelivery.ts`) | bracketed-paste escapes | **2** (gate never true) | `CLI_AGENT_REGEX` |

Every VS Code path that delivers text **as a paste** submits it with exactly one Enter. The second Enter exists only on the fallback that does **not** paste — the one that strips newlines and streams raw chunks, where a CLI's own input handling can consume the first CR. `sendPromptToPty` copied the confirm CR onto a *paste* path, where the proven implementations do not use one, and then gated it on a regex that cannot match a fleet terminal. The dead gate is real (root cause 1 is a correct observation) but it was hiding a defect, not causing one: with the confirm CR permanently off, `sendPromptToPty` is a **paste path sending one Enter — which is correct** — and it still strands prompts. So the second CR was never the missing piece.

What actually differs between the working implementation and the broken one is the **framing**, and only the framing: root cause 5.

### The fix already existed, 11 days before this module was written

`git log` on `src/services/terminalUtils.ts`: `_sendRobustTextBackground` landed in **`cf8846b0`, 2026-07-20**. `ptyPromptDelivery.ts` was written in **`cfd90944`, 2026-07-31** — eleven days later, from scratch, without reusing it.

That function is the portable half of `sendRobustText`. It delivers a payload of any size to a raw-mode TUI using **only** writes to the terminal's stdin — no `vscode.env.clipboard`, no `workbench.action.terminal.paste`, no VS Code command of any kind. `terminal.sendText(x, false)` maps 1:1 onto `handle.write(x)`. It has been in continuous use for real prompt dispatch (`TaskViewerProvider.ts:25255,25282,25697`) since the day it landed.

```ts
// terminalUtils.ts:241-258 — the shipped, proven sequence
terminal.sendText('\x1b[200~', false);                       // marker: its OWN write
for (let i = 0; i < text.length; i += CHUNK_SIZE) {          // payload only, 256 / 30 ms
    terminal.sendText(text.substring(i, i + CHUNK_SIZE), false);
    if (i + CHUNK_SIZE < text.length) { await new Promise(r => setTimeout(r, CHUNK_DELAY_MS)); }
}
terminal.sendText('\x1b[201~', false);                       // marker: its OWN write
await new Promise(r => setTimeout(r, SUBMIT_DELAY_MS));      // 100 ms
terminal.sendText('', true);                                 // ONE Enter. No regex. No second CR.
```

Nothing in this plan needs to be invented. The whole change is making `sendPromptToPty` emit those bytes.

### One Enter is what a paste takes — the confirm CR belongs to the *non*-paste path

Tabulating what each delivery path actually does resolves root cause 1 without leaving the repository:

| path | mechanism | Enters sent | identity check |
| :-- | :-- | :-- | :-- |
| clipboard (`terminalUtils.ts:157-166`) | real clipboard paste | **1** | none |
| background (`:241-258`) | bracketed-paste escapes | **1** | none |
| flattened chunks (`:178-201`) | no paste — newlines stripped, chunked `sendText` | **2** | `isCliAgent` |
| `sendPromptToPty` (`ptyPromptDelivery.ts`) | bracketed-paste escapes | **2** (gate never true) | `CLI_AGENT_REGEX` |

Every path that delivers text **as a paste** submits it with exactly one Enter. The second Enter exists only on the fallback that does **not** paste — where newlines are stripped and raw chunks are streamed, and a CLI's own input handling can eat the first CR. `sendPromptToPty` copied the confirm CR onto a paste path, then gated it on a regex that cannot match a fleet terminal.

That dead gate is the reason the real defect stayed hidden. With the confirm CR permanently off, `sendPromptToPty` has been a paste path sending one Enter — **structurally correct** in the respect the gate governs — and it still stranded prompts. So the second CR was never the missing piece, and repairing its gate would have added an Enter the proven implementations do not send while leaving the actual divergence in place.

### One mechanism explains the entire bug report

The split close marker leaves the terminal in bracketed-paste mode, where every subsequent byte is absorbed as literal pasted text rather than interpreted:

| reported symptom | mechanism |
| :-- | :-- |
| *"it appeared in the terminal input, but enter was not pressed"* | `\r` absorbed as literal text |
| *"the terminal is not accepting any input now"* | still inside an unterminated paste |
| `Ctrl-U` did not clear it | `\x15` absorbed as literal text — the keybinding is fine, the byte never reached it |
| *"it actually input it again"* — re-dispatch appended | the next paste concatenates onto the open one |

Four symptoms, one cause, one fix.

## Metadata

**Complexity:** 4
**Tags:** backend, bugfix, reliability

> **Superseded:** `**Complexity:** 6` and `**Tags:** backend, bugfix, terminals, reliability`.
> **Reason:** `terminals` is not in the allowed tag vocabulary, so it is silently dropped at import — the plan reads as tagged and is not. On complexity: this pass ended up *removing* almost everything it initially proposed. What survives is one function's write sequence brought into line with a shipped one, plus two deletions. Small, but not trivial: the port must be byte-exact, and getting it wrong reproduces a silent, length-dependent failure that no smoke test would catch.
> **Replaced with:** Complexity 4; tags `backend, bugfix, reliability`.

## User Review Required

None.

## Plan Sizing

> **Superseded:** *"One plan, deliberately. The three delivery defects share a single root cause… fixing submission without fixing the clear still wedges on the first cleared dispatch, and fixing the clear without submission still requires a human to press Enter."*
> **Reason:** There are not three defects. Root cause 2's timing conclusion is withdrawn (operator: `/clear` is fast, 2000 ms is ample) and root cause 3's is withdrawn (operator: Ctrl-U works; the byte was being swallowed by the open paste). Both were symptoms of root cause 5 read as separate causes. Root cause 1 is real but is dead code, not a cause. Root cause 4 is in the other host, in a different function, on the one path where a confirm CR legitimately belongs.
> **Replaced with:** One plan, one file, one change. Root cause 4's one-token `devin` fix is **split out** to its own card — it shares no code, no host and no mechanism with this, and bundling it puts the delivery path that currently works inside a hotfix for the one that does not.

## Complexity Audit

### Routine

- The write sequence is a three-line restructure of an existing loop, copying a shape shipped on 2026-07-20 and in continuous use since. It can be diffed against its source by eye.
- Deleting `CLI_AGENT_REGEX` and the confirm-CR branch is pure removal.
- No new files, no new verbs, no interface changes, no config changes, no schema or migration surface.

### Complex / Risky

- **The port must be byte-exact.** The failure this fixes is silent and depends on payload length — a subtly wrong port passes every hand test and strands roughly one prompt in fifty, deterministically, on whichever lengths happen to land badly. The test must parameterise over the failing lengths; a single smoke send proves nothing.
- **Removing the confirm CR is a behaviour change on a technically live path.** The branch is unreachable for fleet terminals today, but `/agy/i` matches `Legacy` — a user-renamed terminal could reach it. Removing it is the intended outcome (one Enter is what the proven paste paths send), but it should be stated rather than discovered.

## Edge-Case & Dependency Audit

### Race Conditions

- `withTerminalLock` (`:9-14`) already serialises sends per terminal name and must keep doing so. Lock hold time is unchanged — the clear sleep, the chunk pacing and the settle all keep their current values.
- A terminal that exits mid-delivery: `handle.write` on a dead pty throws. `clearPty`/`modelPty` swallow this deliberately; `sendPromptToPty` does not, and should not start — a failed prompt must surface, unlike a failed clear.

### Security

- None. No new surface, no new verb, no new field. The change is which bytes go out in which writes.

### Side Effects

- Dropping the confirm CR removes one potential stray blank line per send. Strictly fewer bytes reach every terminal.
- Delivery timing is unchanged end to end. No throughput or latency effect in either direction.
- `clearBeforePrompt: true` becomes safe to use once this lands — not because anything about the clear changed, but because the paste that follows it stops stranding. The sibling *Clear The Coder Between Subtasks* plan needs no revision and no longer has a transport blocker.

### Dependencies & Conflicts

- Touches one file that nothing else in flight edits. With `ptyFleetService.ts` out of the change set, the `spawnDelegates` overlap with *The Spawn Primitive Must Wire The Team* is gone.
- **PRD scope note.** The `pty*` verbs are deliberately outside the generated verb surface (`src/test/pty-route-surface-contract.test.js:11-16`), so `verb-returns:check`, `parity:check` and `push-routing:check` are structurally blind to this change. A green ratchet is not evidence here.

## Dependencies

- `sess_20260813103000 — pty prompt submission (paste framing)`

## Adversarial Synthesis

The dominant risk on this plan is not a bug — it is the one that produced the original defect and then produced two rounds of over-design on top of it: reaching for a new mechanism when the repository already contains a proven one. Every remedy this plan considered and discarded — CLI identity resolution from startup commands, a retained `startupCommand` field, a submission-verification feedback loop, a clear-readiness detector, an abort verb — was invented here, and each was withdrawn on contact with evidence already in the repo or held by the operator. What remains is a port. The residual technical risks are that the port is not byte-exact (mitigated by parameterising the test over the payload lengths that fail today, and by asserting the emitted byte sequence matches `_sendRobustTextBackground`'s for the same input) and that removing the confirm CR changes behaviour for a terminal whose name happens to match the old regex (intended, and stated). Anything larger than this belongs in a different card with its own evidence.

## Design

### Port the proven write sequence. Delete the rest.

> **Superseded:** The original Design's four-part remedy — resolve CLI identity from the startup command, send the confirm Enter for every agent CLI, adopt `terminalUtils.ts`'s `NEWLINE_DELAY`/`CLI_CONFIRM_ENTER_DELAY` constants into the existing structure, and keep the frame-then-chunk write. Also the improve pass's own later additions: a `startupCommand` field on `ExtendedTerminalHandle`, a verify-and-retry submit loop reading `lastDataAt`, a bounded clear-readiness wait, a `ptyAbortInput` verb, and a `PromptDeliveryRecord` return type.
> **Reason:** All of it is machinery built to prop up a structure that should simply be replaced. The repository solved this problem on 2026-07-20 (`cf8846b0`); `ptyPromptDelivery.ts` was written eleven days later without reusing the solution, and every proposal above compounded that by inventing a *third* implementation rather than adopting the working one. Each was withdrawn for its own reason — the identity scheme reads a field both hosts deliberately leave `undefined`; the readiness wait answers a timing problem the operator reports does not exist; the abort verb recovers from a state the framing fix eliminates and that no agent can detect anyway; the delivery record reports facts no caller can act on. The common thread is the original error repeating itself.
> **Replaced with:** Make `sendPromptToPty`'s write sequence a byte-for-byte port of `_sendRobustTextBackground`, substituting `handle.write(x)` for `terminal.sendText(x, false)` and `handle.write('\r')` for `terminal.sendText('', true)`:
>
> ```ts
> handle.write('\x1b[200~');                                   // marker: its OWN write
> for (let i = 0; i < text.length; i += CHUNK_SIZE) {          // payload only
>     handle.write(text.slice(i, i + CHUNK_SIZE));
>     if (i + CHUNK_SIZE < text.length) { await new Promise(r => setTimeout(r, CHUNK_DELAY_MS)); }
> }
> handle.write('\x1b[201~');                                   // marker: its OWN write
> await new Promise(r => setTimeout(r, SUBMIT_DELAY_MS));      // 100 ms — the proven value
> handle.write('\r');                                          // ONE Enter
> ```
>
> `CHUNK_SIZE` 256 and `CHUNK_DELAY_MS` 30 already match — leave them. `SUBMIT_DELAY_MS` stays 100, the value the working implementation uses, **not** the 300 ms `NEWLINE_DELAY` from the non-paste path. Delete `CLI_AGENT_REGEX` (`:3`) and the confirm-CR branch (`:48-52`). Leave the `clearBeforePrompt` branch (`:27-31`) exactly as it is.

### Record why, in the code

The reason this bug existed for six weeks is that the next person to need prompt delivery in a new host had no way to know the answer already existed. Put it in the file:

```ts
// PORTED VERBATIM from _sendRobustTextBackground (src/services/terminalUtils.ts:241-258),
// the VS Code path that has delivered prompts of arbitrary size to raw-mode agent CLIs
// since 2026-07-20 (cf8846b0). That function is the reference implementation for prompt
// delivery over a raw stdin: it needs no vscode API, so it ports to any host that can
// write bytes to a terminal. Two rules it encodes, both load-bearing:
//   1. The bracketed-paste markers are their OWN writes. Chunking the FRAMED string
//      splits \x1b[201~ across a 30 ms gap whenever (6 + text.length) % 256 lands in
//      the last five bytes — the 6 is the open marker \x1b[200~'s own width, which
//      precedes the payload and offsets the close marker's start; equivalently
//      text.length % 256 ∈ [245,249]. The TUI never leaves paste mode and every
//      later byte — \r, Ctrl-U, the next prompt — is absorbed as literal text.
//   2. A paste is submitted with ONE \r. The second "confirm" Enter belongs to the
//      flattened-chunk path (terminalUtils.ts:197-201), which does not paste at all.
// If a third host ever needs this, port that function again. Do not write a new one.
```

## Implementation Notes

- **Port, do not paraphrase.** The whole point of this change is that a second implementation of one contract diverged. Keep the line reference so the two can be diffed by eye.
- Do not reintroduce a confirm CR "just in case". A blank line into a `shell` terminal executes an empty command; into some REPLs it does more. And no proven paste path in this codebase sends one.
- Do not touch `clearPty`, `modelPty`, the `clearBeforePrompt` branch, `ptyFleetService.ts`, or either host's verb switch. They are not implicated.
- Do not port the clipboard path or the remote-delay branch. `vscode.env.clipboard`, `workbench.action.terminal.paste` and `vscode.env.remoteName` are all unreachable from the pty child and the standalone host, and a PTY this process spawned is local by construction. The background path was written to need none of them — that is exactly why it is the portable one.
- `sendPromptToPty` currently lets `handle.write` throw. Keep that: unlike a clear, a prompt that could not be written must fail loudly.
- Do not touch `_sendRobustTextBackground`. It is now the reference implementation two hosts are measured against.

## Proposed Changes

### `src/standalone/ptyPromptDelivery.ts`

- **Context.** `:3` `CLI_AGENT_REGEX`; `:34-43` the frame-then-chunk write; `:45` the 100 ms settle; `:46` the Enter; `:48-52` the dead confirm-CR branch.
- **Logic.** Emit the bracketed-paste markers as standalone writes with only the payload chunked between them; submit with a single Enter; remove the identity check.
- **Implementation.** Replace the `framed` string and its loop with marker-write / payload-chunk / marker-write. Keep `CHUNK_SIZE`, `CHUNK_DELAY_MS` and the 100 ms settle at their current values. Delete `CLI_AGENT_REGEX` and lines 48-52. Add the provenance comment from *Design → Record why, in the code*.
- **Edge Cases.** Leave the `clearBeforePrompt` branch untouched. Keep `withTerminalLock` wrapping the whole operation. Let `handle.write` throw as it does today. The function's signature and return type are unchanged — no caller, host or verb arm is affected.

**Nothing else changes.** `ptyFleetService.ts`, `ptyHost.ts`, `bootstrap.ts` and `terminalUtils.ts` are all out of scope.

### Split out — not this card

- **Root cause 4 (`terminalUtils.ts:149`).** `Devin CLI` does not match the vendor regex, so VS Code terminals running Devin have never received the confirm Enter on the flattened-chunk path. Real, but a different host, a different function, and the one path where a confirm CR legitimately belongs. One-token fix; its own card.
- **Detecting a stalled coder.** The reason a stranded prompt cost 675 seconds is that a lead agent cannot distinguish "stuck" from "thinking". That is a real gap and it is **not** a delivery-layer concern — `PlanIngestionEngine.ts:307-315` already sweeps the fleet's `lastDataAt` for terminals silent past `turnEndSilenceMs`. If a lead needs that signal exposed, that is where it comes from, and it is its own card.

## Verification Plan

1. **The failing lengths — run this against the CURRENT build first and watch it fail.** Dispatch prompts whose length puts the close marker across a chunk boundary: `(6 + text.length) % 256` in `[251,255]` (the `6` is the open marker's width, which offsets the close marker's start in the framed string), i.e. `text.length % 256` in `[245,249]`, e.g. 245, 501, 757, 1013, 1269, 1525 chars. These strand today, deterministically. After the change they must be indistinguishable from any other length.

> **Correction (2026-08-13, post-implementation).** The original step gave `text.length % 256 ∈ [251,255]` (e.g. 507, 763, 1019, 1275), omitting the 6-byte open marker. Those lengths do not split the close marker — their `(6 + len) % 256 = 1`, so the close marker starts at chunk position 1 and sits wholly inside one chunk. The behavioural test still failed against the pre-fix code at those lengths because the open marker was also never a standalone write in the old implementation, so the "whole marker" assertion fails at every length — but they were not exercising the specific close-marker split this step describes. The corrected lengths above are the ones that actually strand via the split mechanism. **The fix is unchanged**: standalone marker writes eliminate the split at every length.
2. **The reported case.** Dispatch a >1500-char prompt to a fleet coder with `clearBeforePrompt: false`. It must submit with no human keypress. Ten times, ten submissions.
3. **The cleared case.** Same with `clearBeforePrompt: true` against a coder holding a large context. The clear is unchanged; the paste must land after it and submit unaided.
4. **Byte-sequence parity.** Capture every write `sendPromptToPty` makes against a stub handle and diff against `_sendRobustTextBackground`'s sequence for the same payload. They must differ only in the call used to write.
5. **One Enter, never two.** Exactly one `\r` per delivery, for a `coder` and a `shell`-role terminal alike, and no code path consults a terminal name or role.
6. **Both hosts.** Repeat 1 and 2 under `npx` as well as the extension host.
7. **No VS Code regression.** `sendRobustText` dispatch to a `Claude CLI` terminal still submits, clipboard path still used above the 100-char threshold, background-mode dispatch (`TaskViewerProvider.ts:25255,25282,25697`) unchanged.

### Automated Tests

The guard must reproduce the failing **lengths**. The shipped bug returns `success:true`, so any test asserting the call succeeded passes against the broken code — and a single fixed-length smoke send passes against it too, most of the time.

**Behavioural test (the real guard).** Drive `sendPromptToPty` against a stub handle that records every `write` call:

- `\x1b[200~` and `\x1b[201~` each arrive as a **single, whole** write. Parameterise over payload lengths including `(6 + text.length) % 256 ∈ [251,255]` (i.e. `text.length % 256 ∈ [245,249]` — the `6` is the open marker's width, which offsets the close marker's start in the framed string) — these fail against the current implementation and are the regression case.
- Exactly one `\r` follows, after the settle.
- The emitted sequence is byte-identical to `_sendRobustTextBackground`'s for the same input.

**Contract assertions** (source-text, matching `pty-route-surface-contract.test.js`'s existing style):

- `ptyPromptDelivery.ts` contains no `CLI_AGENT_REGEX` and no second `handle.write('\r')`.
- No `` `\x1b[200~${ `` template concatenation remains.

## Recommendation

Complexity 4 → **Send to Coder**.

> **Superseded:** *"Complexity 6 → Send to Coder."*
> **Reason:** Follows the complexity revision in Metadata. Routing is unchanged; the score moved because everything this pass initially proposed was withdrawn in favour of porting a function that already works.
> **Replaced with:** Complexity 4 → Send to Coder.

## Completion Summary

Ported `sendPromptToPty`'s write sequence byte-for-byte from `_sendRobustTextBackground` (`terminalUtils.ts:241-258`): the bracketed-paste open and close markers are now standalone `handle.write` calls with only the payload chunked between them, and submission is a single `\r` after a 100 ms settle (`SUBMIT_DELAY_MS`). Deleted `CLI_AGENT_REGEX` and the dead confirm-CR branch that gated a second Enter on a name/role regex no fleet terminal could ever match; added the provenance comment from the Design section so the next host can diff against the reference by eye. The `clearBeforePrompt` branch, `withTerminalLock`, `clearPty`/`modelPty`, and all timing constants are untouched, and no other file was modified. The length-parameterised behavioural test (`src/test/pty-prompt-delivery-framing.test.js`) drives `sendPromptToPty` against a stub handle across the failing lengths (`(6 + text.length) % 256 ∈ [251,255]`, i.e. `text.length % 256 ∈ [245,249]` — 501, 757, 1013, 1269) and safe lengths, asserting whole markers, exactly one `\r`, and byte-sequence parity with the reference algorithm; it also carries source-text contract assertions (no `CLI_AGENT_REGEX`, no framed template concatenation, exactly one `handle.write('\r')`). Verified the guard catches the bug: every behavioural check fails against the pre-fix code at any length (the open marker was never a standalone write there either) and all checks pass against the fix. No compilation step was run — Node's native type stripping loads the `.ts` source directly.

### Head-agent review addendum

Reviewing the correction pass, `SAFE_LENGTHS` in the test still carried 245–249 as safe controls. Those are themselves stranding lengths — 245 is the *first* failing length in the product (close marker at index 251, spanning the 256 boundary), not a control. Moved 245–249 into `FAILING_LENGTHS`, left 250 as the first residue genuinely clear of the band, and annotated both arrays with why 507/763/1019/1275 are listed as safe despite being the lengths the plan originally named as failing. Test now runs 44 checks, all passing. Coverage was never affected — both arrays feed the same assertions — but the labels were the same off-by-six the correction pass existed to remove, and the arrays are what the next reader will trust. The completion summary above lists the pre-edit `FAILING_LENGTHS`.

## Review Findings

The plan's actual deliverable is correct and present: `ptyPromptDelivery.ts:74,81` emit `\x1b[200~` and `\x1b[201~` as standalone writes with only the payload chunked between them, so root cause 5 cannot recur at any length, and `CLI_AGENT_REGEX` is gone from the code. But the guard shipped with it was **41 of 44 checks red** — a sibling plan (`feature_plan_20260812093000`, completion summary) had since restored the confirm CR **unconditionally** on operator evidence that devin seats show pasted text land unsent, superseding this plan's "one Enter" design, and the test still asserted one `\r` plus byte-parity with `_sendRobustTextBackground`; a third assertion failed on the word `CLI_AGENT_REGEX` appearing in this file's own explanatory *comments*. Fixed `src/test/pty-prompt-delivery-framing.test.js` to guard what the product actually intends — framing invariant unchanged and still byte-identical to the reference through the close marker, submission now via a single `CONFIRM_CR_COUNT` knob, source-text assertions run against comment-stripped code, a new "no identity gate of any kind" check, and the clear-path close-marker index no longer hardcoded to `-2` (where it was silently measuring a `\r`); also repaired the framed-template assertion, which used a regex-escape `\x1b` that could never match the literal source text and was passing vacuously. Separately, the guard was defined at `package.json:902` but invoked by **nothing** in `.github/workflows/` — the green-while-incomplete hole — so it is now wired into `integration-tests.yml` beside `pty-route-surface`. Verification: 44/44 framing checks pass via the exact CI invocation, `pty-route-surface` still green, and `tsc --noEmit` reports zero errors in `src/standalone/` (the 5 project-wide TS2835 extensionless-dynamic-import errors are pre-existing at HEAD in ClickUp/Notion/Kanban/TaskViewer services and unrelated).

**Remaining risks.** The Completion Summary above is now factually stale where it says "submission is a single `\r`" and `SUBMIT_DELAY_MS` 100 — the tree ships two CRs at 40 ms + 200 ms, per the sibling plan; treat that paragraph as a record of this card's state before the supersession, not as current behaviour. The Edge-Case audit's claim that "lock hold time is unchanged" is also no longer true: `withTerminalLock` now holds ~200 ms longer per send for the confirm CR, which serialises back-to-back dispatch to one seat. The open mechanism question is now **half-settled by measurement** and the result is recorded in the code. `scripts/capture-cli-modes.js` was run against both seats on 2026-08-14: claude emits `?2004h` (after `?1049h` alt-screen and mouse `1000/1002/1003/1006`), devin emits `?2004h` **first**, on the normal screen with no mouse and synchronized output (`?2026`). Both enable bracketed paste, so the markers this path writes are honoured on both — the "we frame blind and an unnegotiated escape swallows the CR" theory is refuted and must not be revived. What survives is the settle budget: this path waits `SUBMIT_SETTLE_MS` (40 ms) before the Enter where the clipboard branch waits ~400 ms (`POST_PASTE_SETTLE_MS` + `NEWLINE_DELAY`), and the devin observation was made *after* that constant was cut 100 → 40 — devin has never been tested at 100 ms with a single CR, which is the next experiment. If it still needs two at a long settle, the remaining candidate is post-paste Enter semantics (a TUI treating the first Enter after a paste as newline, not submit). If the second CR ever goes away, `CONFIRM_CR_COUNT` in the test is the single knob.
