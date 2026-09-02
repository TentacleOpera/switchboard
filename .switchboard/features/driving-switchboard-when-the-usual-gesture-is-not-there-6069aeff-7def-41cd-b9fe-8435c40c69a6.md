# Driving Switchboard When the Usual Gesture Is Not There

**Complexity:** 4

## Goal

Three interactions work on a desktop Mac and nowhere else: moving a card, copying text out of a terminal, and pasting into one. Each fails for a different platform reason. HTML5 drag events never fire from touch, so the board is inert on an iPad. Linux has no free modifier, so Ctrl+Shift+C and Ctrl+Shift+V were never bound and nothing tells xterm what they mean. The plain-HTTP tailnet URL is not a secure context, so navigator.clipboard does not exist at all. This feature supplies an explicit control for each case, and documents the one control that already works but that nobody can find.

## How the Subtasks Achieve This

- **Reaching the board from a tablet is documented; driving it is not**: The only
  subtask that ships no code. Any-direction card movement already works on a tablet —
  the Project panel's column badge dropdown does it — but nothing connects "I am on a
  tablet" to "use that control", so operators conclude the capability is missing and
  edit plan files or ask an agent instead. This documents the touch operating path, and
  states plainly which gestures are unavailable and why, so the remaining gaps are known
  rather than rediscovered.
- **Browser terminals have no paste affordance**: Supplies the one paste mechanism that
  works in every context — a visible textarea receiving the operator's own OS paste
  gesture, delivered through term.paste() so bracketed-paste wrapping and paste
  attribution both apply. This is the only subtask that helps where the Clipboard API is
  absent entirely, which is every tailnet URL.
- **Nothing tells xterm what Ctrl+Shift+C and Ctrl+Shift+V mean**: Binds the terminal
  clipboard chords, restoring copy-out on Linux and Windows where Ctrl is spoken for and
  no free modifier exists. This is the only subtask that addresses copying, because
  copying needs a selection and a selection needs a pointer — no button can substitute.

<!-- BEGIN SUBTASKS (auto-generated, do not edit) -->
## Subtasks
- [ ] [Reaching the board from a tablet is documented; driving it is not, and the control surface that works is the one nobody points at](../plans/ipad-board-control-undocumented-project-panel-is-the-touch-surface.md) — **PLAN REVIEWED** — ID: 702a3573-a0d5-4116-bf6d-6e88a0d53d1d
- [ ] [Browser terminals have no paste affordance, so paste works only where the browser and OS happen to cooperate — and on Linux and touch they do not](../plans/terminal-pane-paste-button-for-contexts-where-the-clipboard-is-unreachable.md) — **PLAN REVIEWED** — ID: 19f827f5-ce5b-4226-a6c3-eba4ae51944e
- [ ] [Nothing tells xterm what Ctrl+Shift+C and Ctrl+Shift+V mean, so copying out of a pty terminal is impossible on the one platform with no free modifier](../plans/terminal-clipboard-keys-unbound-on-linux-where-no-free-modifier-exists.md) — **PLAN REVIEWED** — ID: 6b5ca80a-6d90-4657-b0d2-6fefadf1658e
<!-- END SUBTASKS -->

## Dependencies & sequencing

The two terminal subtasks are ordered; the documentation subtask is independent.

1. **Paste affordance first.** Its control is the fallback the key-handler subtask needs:
   in an insecure context Ctrl+Shift+V has no clipboard to read, and the correct behaviour
   is to open the paste control rather than fail silently. Built in the other order, the
   shortcut works on localhost and dies on the tailnet URL — the exact environment that
   prompted this feature.
2. **Clipboard key handler second.** Its copy half is genuinely independent and could ship
   alone; only its paste half carries the ordering constraint.
3. **Documentation any time**, though it is most useful written last, so it can describe
   the controls the other two add rather than being amended twice.

**One cross-cutting check.** Three code paths now move a card — moveKanbanPlanColumn keyed
by plan file, moveCardForward/moveCardBackwards keyed by session id, and POST /kanban/move
keyed by either. Whether they produce identical run sheets, feature cascades and tracker
syncs is not established. It is a verification item in more than one plan; if the answer is
"they differ", that is worth its own plan rather than a footnote.

**Two project rules bind every subtask here.** No confirmation dialogs, ever — window.confirm
is a silent no-op in VS Code webviews, so a gate makes the control do nothing. And every
change must land in both the extension and the standalone host, verified by diffing the two
composition roots by hand, since verb-level checks pass regardless.

## Team Dispatch Instructions

### Reaching the board from a tablet is documented; driving it is not, and the control surface that works is the one nobody points at

- **Seat:** Intern (complexity 2 — documentation only, no code)
- **Acceptance:**
  - The document can be followed end-to-end on a real iPad over the tailnet URL, from a cold start, without touching a desktop.
  - A card moved backward via the documented Project-panel path lands in the intended column and stays after a refresh.
  - The dispatch warning is verified in both directions: CLI triggers on fires an agent, off does not.
  - The verb asymmetry between `moveKanbanPlanColumn` and `moveCardBackwards` (run sheets, side effects) is documented with whichever answer is true.
  - `git diff --stat` touches only `docs/` — no source files modified.
- **Must not touch:** No source files. The plan's Non-goals state "Not a code change" — no new control, no touch-drag shim, no responsive pass. If the writing reveals a control is genuinely unusable on touch, raise it as a finding, do not fix it inside this plan.

### Browser terminals have no paste affordance, so paste works only where the browser and OS happen to cooperate — and on Linux and touch they do not

- **Seat:** Coder (complexity 4 — single file, but focus management and iOS compatibility add moderate risk)
- **Acceptance:**
  - Paste button works on the affected Linux setup, including over the tailnet URL where no Clipboard API exists.
  - iPad over the tailnet URL: tapping Paste, long-pressing, confirms iOS offers the Paste callout and the text reaches the pty.
  - No code path touches `navigator.clipboard` — assert in a test, not by inspection.
  - No `confirm(`, `window.confirm`, or `showWarningMessage` in the added code; multi-line paste delivers on a single SEND with no interstitial.
  - Control works in both an installed VSIX and under `npx switchboard` (diff composition roots by hand).
- **Must not touch:** The input transport (frames, chunking, pacing — shipped and correct). No `navigator.clipboard.readText()` path, not even as a "nicer where available" branch. No image paste. No confirmation dialogs in any form. `clipboardFallback.js` is not modified by this plan.

### Nothing tells xterm what Ctrl+Shift+C and Ctrl+Shift+V mean, so copying out of a pty terminal is impossible on the one platform with no free modifier

- **Seat:** Coder (complexity 3 — single file, one API call, but Chrome DevTools conflict investigation and multi-platform testing push above Intern)
- **Acceptance:**
  - Chrome on Linux: select terminal output, press the copy chord, paste elsewhere — text matches, DevTools does not open.
  - macOS unregressed: Cmd+C and Cmd+V behave exactly as before (regression gate, not feature check).
  - Ctrl+C still sends SIGINT with a live selection and a running process.
  - Empty selection is safe: copying something outside the terminal, then pressing the copy chord with no selection, does not destroy the external clipboard content.
  - Both hosts: `clipboardFallback.js` is loaded on the terminals page in both `src/extension.ts` and `src/standalone/bootstrap.ts` (verify by hand, not by verb-level check).
- **Must not touch:** Ctrl+C (always SIGINT, per User Review — never copy-when-selection-exists). No configurable keymap. No touch copy. `src/webview/clipboardFallback.js` (uses `sbCopyToClipboard`, does not modify it). No confirmation dialogs.

