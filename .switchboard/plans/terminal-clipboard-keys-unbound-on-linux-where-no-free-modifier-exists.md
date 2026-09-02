# Nothing tells xterm what Ctrl+Shift+C and Ctrl+Shift+V mean, so copying out of a pty terminal is impossible on the one platform with no free modifier

## Goal

Bind the terminal clipboard keys explicitly, so selecting text in a browser terminal and
pressing Ctrl+Shift+C copies it on Linux and Windows, as it does in every native terminal.
macOS keeps working through Cmd+C unchanged. This is the copy direction — the half no
button can rescue, because copying requires a selection and a selection requires a pointer.

### Problem Analysis

**The diagnosis is already recorded.** `.switchboard/memo.md:14`:

> *"cannot copy pty terminal text on linux as all the other commands clash. On macOS, Cmd+C
> and Cmd+V are unambiguous — nothing in the terminal uses Cmd, so xterm.js and the browser
> both pass them through cleanly. On Linux there's no equivalent free modifier. Ctrl+C is
> SIGINT, Ctrl+V is literal-next in some contexts, so xterm.js has to be told explicitly
> what to do with Ctrl+Shift+C/V. It doesn't handle that by default — you add a key
> handler."*

**Confirmed in source.** `src/webview/terminals.js` contains **no** `attachCustomKeyEventHandler`
call and **no** `getSelection` call, anywhere in the file. Nothing has ever told xterm what
those chords mean, so on Linux they mean nothing: Ctrl+Shift+C reaches no handler, and the
text stays on screen.

**This is a platform asymmetry, not a general bug.** On macOS the Cmd modifier is unused by
the terminal, so the browser's native Cmd+C copy passes through cleanly and the feature
appears to work. Linux and Windows have no equivalent: Ctrl+C is SIGINT and must remain
SIGINT, so the terminal convention everywhere is to move clipboard operations onto
Ctrl+Shift. That convention has to be implemented; it is not inherited.

**The selection already exists — only the copy does not.** xterm maintains its selection
model independently of the renderer, so `term.getSelection()` returns the selected text even
though the visible terminal is a canvas (`WebglAddon` at `terminals.js:530/562`, `CanvasAddon`
fallback at `:829/831`). Mouse selection on a desktop works today. The text is right there and
unreachable.

**And the write path is already solved and insecure-context-safe.**
`src/webview/clipboardFallback.js` installs `window.sbCopyToClipboard(text)`, which prefers
`navigator.clipboard.writeText` and falls back to a hidden `<textarea>` +
`document.execCommand('copy')` when there is no secure context. `docs/REMOTE_ACCESS.md:88-97`
documents that every copy button on the board already routes through it. So copy over the
plain-HTTP tailnet URL works, provided something calls it. That makes the copy half of this
plan genuinely small: read a selection, hand it to a function that already exists.

### Root Cause

xterm.js deliberately ships no opinion about clipboard chords, because the correct binding
is platform- and embedder-specific. Switchboard never supplied one. The gap stayed invisible
because the primary development platform is the one where the browser's own accelerator
happens to be unambiguous.

### Non-goals

- **Not the paste affordance for touch or insecure contexts.** A key handler requires a
  keyboard and, for Ctrl+Shift+V, a readable clipboard. Neither exists on an iPad on the
  tailnet URL. That is the paste-button plan's job; see Dependencies for how the two meet.
- **Not a change to Ctrl+C.** Ctrl+C sends SIGINT. See User Review.
- **Not a configurable keymap.** One conventional binding, matching native terminals. A
  preferences surface for chords is a different and much larger piece of work.
- **Not touch copy.** Copying on a touch device needs a selection gesture that canvas
  rendering does not provide. Out of scope, and not solved by this plan.

## Metadata

**Complexity:** 3
**Tags:** ui, ux, frontend, bugfix
**Project:** Browser Switchboard

## User Review Required (CONFIRMED)

**Decision: Always SIGINT (CONFIRMED by user).**
`Ctrl+C` strictly sends SIGINT (process interrupt) in all conditions, regardless of selection state. Copying selected text is handled via `Ctrl+Shift+C` (and `Ctrl+Insert` fallback). This ensures stopping runaway processes never fails due to accidental text selection.

## Complexity Audit

### Routine

- One `attachCustomKeyEventHandler` per terminal, at the existing construction site.
- `term.getSelection()` → `window.sbCopyToClipboard(text)`. Both already exist.

### Complex / Risky

- **Ctrl+Shift+C is Chrome's DevTools inspector shortcut on Linux and Windows.** This is the
  central risk of the plan and must be tested before anything else is built. Browser-reserved
  accelerators frequently cannot be suppressed from page script — `preventDefault()` on the
  keydown may simply not be honoured. If DevTools opens instead, the chord is unusable in
  Chrome and the plan needs a second binding (Ctrl+Insert is the traditional fallback and is
  not browser-reserved). **Establish this on day one**; the plan's shape depends on the
  answer.
- **`attachCustomKeyEventHandler` is all-or-nothing per key event.** Returning `false`
  suppresses xterm's handling entirely. A handler that is too broad silently eats keystrokes
  the shell needs; one that is too narrow lets the chord reach the pty as a control code.
  Match precisely on `ctrlKey && shiftKey` with the right `code`, and return `true` for
  everything else.
- **macOS must not regress.** Cmd+C works today because nothing intercepts it. The handler
  must not claim `metaKey` chords. A naive "copy on C with a modifier" check breaks the one
  platform that currently works.
- **Ctrl+Shift+V may or may not produce a native paste event.** In some browsers it is
  "paste as plain text" in editable contexts. Whether it reaches xterm's hidden textarea as
  a `paste` event is browser-dependent and must be measured, not assumed — it determines
  whether the paste half needs the Clipboard API at all.
- **Paste in an insecure context has no key-only answer.** On the tailnet URL
  `navigator.clipboard` is undefined, so a Ctrl+Shift+V handler has nothing to read. The
  correct behaviour is to open the paste control from the sibling plan rather than fail
  silently — which is a hard sequencing constraint, not a nicety.

## Edge-Case & Dependency Audit

**Behavioural**
- **No selection + Ctrl+Shift+C:** do nothing. Never write an empty string to the clipboard —
  that destroys whatever the operator had copied.
- **Selection spanning wrapped lines:** `getSelection()` returns the reflowed text. Confirm
  a copied long command pastes back as one line rather than with hard breaks inserted.
- **Trailing whitespace:** xterm pads selections to the cell grid. Copying a shell command
  with trailing spaces and pasting it into a shell is usually harmless but is visible in
  a diff-sensitive context. Decide and document rather than discovering it later.
- **Selection cleared by output:** a terminal producing output may clear the selection
  between the operator selecting and pressing the chord. Read the selection at keypress
  time, never cache it.
- **Multiple panes:** the handler is per-terminal and must copy from the focused pane's
  terminal, not a remembered one.

**Security**
- Clipboard writes carry terminal content, which routinely includes secrets. Never log the
  copied text, its length, or a prefix.
- No change to bind policy, guards, or the token model. Exposure-neutral.

**Both hosts — mandatory.** `CLAUDE.md` requires every feature to land in the VS Code
extension **and** the standalone host, and warns that the trap is composition-root wiring
rather than verbs, since `bootstrap.ts`'s `default:` arm makes verb audits pass regardless.
`terminals.js` is shared webview code, so the handler itself is common — but
`clipboardFallback.js` must be loaded on the terminals page in **both** hosts, and that is
exactly the kind of per-root wiring that silently exists in one and not the other. Check it
by hand in `src/extension.ts` and `src/standalone/bootstrap.ts`.

**No confirmation dialogs.** `CLAUDE.md`, absolutely. Nothing in this plan may add one.

**Migration**
- None. New key bindings, no persisted state, no format change.

## Dependencies

- **Sequencing:** land the **terminal paste-button plan first**. The copy half here is fully
  independent and could ship alone, but the paste half needs somewhere to send an operator
  whose context has no Clipboard API. Built in the other order, Ctrl+Shift+V works on
  localhost and dies silently on the tailnet URL — which is the exact environment the
  operator who reported this is using.
- **Uses, does not modify:** `src/webview/clipboardFallback.js`.
- **Related:** `feature_plan_20260803163802_bracketed-paste-mode-replay-for-pty-terminals.md`.

## Adversarial Synthesis

The likely failure is shipping this on macOS, where it will appear to work because Cmd+C
already worked and the new handler was never exercised. The whole plan exists for the
platform the developer is least likely to be sitting at, and its riskiest assumption —
that Ctrl+Shift+C is claimable at all in Chrome rather than being swallowed by DevTools —
is invisible on a Mac. Second, `attachCustomKeyEventHandler` is a blunt instrument: an
over-broad match eats keystrokes in a way that surfaces days later as "the terminal
sometimes drops characters", with no obvious link to a clipboard change. Third, an empty
selection copied over a full clipboard is a small, infuriating, easy-to-miss data loss.
Mitigations: verify the Chrome DevTools conflict on real Linux before building anything
else; match the chord narrowly and return `true` for every other event; guard the empty
selection explicitly; and test on Linux, Windows and macOS before calling it done.

**Key risks:** (1) Chrome DevTools may claim Ctrl+Shift+C — plan shape depends on the
answer. (2) Over-broad key matching silently eats keystrokes. (3) Two-path paste UX
asymmetry (instant vs. UI) may confuse operators. (4) Fallback status line when sibling
plan not shipped is under-specified. **Mitigations:** (1) Test on real Chrome/Linux first;
Ctrl+Insert contingency ready as primary. (2) Match on `event.code`, return `true` for
everything else, test with TUI apps. (3) Document the asymmetry as intentional in code.
(4) Write a buffer message directing operator to the Paste button.

## Proposed Changes

1. **Establish the Chrome conflict first.** On real Linux, determine whether a page can
   claim Ctrl+Shift+C from DevTools. If not, adopt Ctrl+Insert / Shift+Insert as the primary
   binding and treat Ctrl+Shift+C/V as a secondary that works where it is available. Record
   the finding in this plan before implementing. **If Chrome claims the chord, this item
   becomes the plan, not a footnote — restructure the Proposed Changes around Ctrl+Insert
   as primary.**
2. **`attachCustomKeyEventHandler` at the terminal construction site** in
   `src/webview/terminals.js` (`materializeTerminalView` at line 9969, `new window.Terminal({...})`
   at line 9973 — confirmed single construction site). Match precisely on
   `event.ctrlKey && event.shiftKey && event.code === 'KeyC'` (or `'KeyV'`) — use `event.code`
   (physical key) not `event.key` (which varies with shift state and layout). Return `true`
   for every event the handler does not explicitly claim, and never claim `metaKey` chords.
3. **Copy:** on the copy chord, read `term.getSelection()`; if non-empty, pass it to
   `window.sbCopyToClipboard(text)` and suppress xterm's handling. If empty, claim the
   event (return `false`) and write nothing — **never** call `sbCopyToClipboard('')`, which
   would destroy the operator's existing clipboard content. This guard is a one-line check
   that is easy to omit and catastrophic if missed.
4. **Paste:** on the paste chord, use `navigator.clipboard.readText()` where it exists;
   where it does not — the insecure tailnet context — call
   `window.sbOpenTerminalPaste(paneId)` (exposed by the sibling paste-button plan) to open
   the paste control. If the paste control is not yet available (sibling plan not shipped),
   write a temporary message to the terminal buffer
   (e.g., `\r\n[Paste: use the Paste button — clipboard API unavailable]\r\n`) — do not
   fail silently. Deliver via `term.paste(text)` so bracketed-paste wrapping and `onData`
   paste attribution both apply, matching that plan's delivery path exactly.
5. **A brief, non-blocking confirmation of the copy** (a transient status line or the
   existing toast idiom). Not a dialog, not a gate — the operator needs to know an invisible
   action happened, because nothing on screen changes when text is copied.
6. **Ctrl+C untouched**, per User Review.
7. **Document the paste asymmetry.** The paste chord's behavior is context-dependent:
   instant paste in secure contexts (Clipboard API reads and delivers), paste-control UI in
   insecure contexts (operator must perform their OS paste gesture into the textarea). This
   is by design, not a bug — script cannot read the clipboard in an insecure context. State
   this in a code comment so a future maintainer doesn't "fix" the asymmetry by adding a
   broken `readText()` call.

### Migration

None.

## Uncertain Assumptions (RESOLVED via Web Research)

The external browser/platform behaviors were researched and confirmed:

- **Chrome DevTools conflict with Ctrl+Shift+C on Linux/Windows (RESOLVED):** In Google Chrome on Linux/Windows, Ctrl+Shift+C is a browser accelerator for Inspect Element. While `attachCustomKeyEventHandler` with `preventDefault()` intercepts it in standard page contexts, Chrome DevTools can take precedence if active. **Resolution:** Implement Ctrl+Shift+C via `attachCustomKeyEventHandler`, and support `Ctrl+Insert` / `Shift+Insert` as the standard zero-conflict Linux terminal fallback.
- **Ctrl+Shift+V native paste event behavior (RESOLVED):** In xterm.js, Ctrl+Shift+V does not reliably fire a native DOM `paste` event into the hidden xterm textarea across all browsers. **Resolution:** The handler explicitly reads the clipboard via `navigator.clipboard.readText()` in secure contexts, or delegates to `window.sbOpenTerminalPaste(paneId)` in insecure contexts, delivering via `term.paste(text)`.

## Verification Plan

### Goal Invariants

- `attachCustomKeyEventHandler` is called at the terminal construction site in `src/webview/terminals.js` (`materializeTerminalView` at line 9969, `new window.Terminal({...})` at line 9973 — single construction site, confirmed).
- The copy chord calls `term.getSelection()` and, if non-empty, passes the result to `window.sbCopyToClipboard(text)`.
- The handler never claims `metaKey` chords — macOS Cmd+C remains unintercepted.
- No `confirm(`, `window.confirm`, or `showWarningMessage` call exists in the added code (per CLAUDE.md).
- An empty `term.getSelection()` does not call `sbCopyToClipboard` — the existing clipboard content survives.
- The handler returns `true` for every event it does not explicitly claim — no keystrokes are silently eaten.
- `clipboardFallback.js` is loaded on the terminals page in both hosts (extension via `TaskViewerProvider.ts:24374`, standalone via `headlessPanelHtml.ts:74` — verified present in both).
- The paste chord calls `window.sbOpenTerminalPaste(paneId)` when `navigator.clipboard` is absent — never fails silently.

1. **Chrome on Linux, the reported case.** Select terminal output, press the copy chord,
   paste elsewhere. Text matches. Explicitly confirm DevTools does **not** open — if it
   does, item 1 was skipped and the binding is wrong.
2. **Firefox on Linux.** Same, since its reserved-accelerator set differs from Chrome's.
3. **macOS unregressed.** Cmd+C and Cmd+V behave exactly as before. This is a regression
   gate, not a feature check.
4. **Windows**, if supported — same modifier situation as Linux, likely same result, and
   cheap to confirm.
5. **Ctrl+C still interrupts.** With a live selection and a running process, Ctrl+C sends
   SIGINT and does not copy.
6. **Empty selection is safe.** Copy something outside the terminal, press the copy chord
   with no selection, confirm the external clipboard content survives.
7. **Insecure context.** Over `http://100.x.y.z:port/`, confirm copy works via the
   `execCommand` fallback and that no code path assumed `navigator.clipboard` exists.
8. **Paste falls back correctly.** In the insecure context, confirm the paste chord opens
   the paste control rather than failing silently.
9. **No keystrokes eaten.** Run an interactive TUI (vim, htop, a full-screen agent CLI) and
   exercise Ctrl-chords, Shift-chords and arrows. Nothing is dropped, nothing is doubled.
10. **Wrapped-line fidelity.** Copy a command long enough to wrap and confirm it pastes back
    as a single line.
11. **Multi-pane focus.** With four panes open, confirm the chord copies from the focused
    pane every time.
12. **Both hosts, per `CLAUDE.md`.** Exercise copy and paste in an installed VSIX **and**
    under `npx switchboard`. Confirm by hand that `clipboardFallback.js` is loaded on the
    terminals page in both composition roots — a verb-level check will pass either way and
    prove nothing.
13. **No confirm gate, no secrets logged.** Grep the diff for `confirm(` and assert none;
    paste a sentinel string and confirm it appears in no console or server log.
