# Spike: Find Out Whether a VS Code Editor-Area Terminal Grid Is Actually Usable

## Goal

Answer one question with working code rather than assumption: can `vscode.window.createTerminal` place N agent terminals into a usable grid in the editor area, and does it feel like a fleet cockpit or like a pile of tabs? Deliver a throwaway command behind a hidden setting, a written findings note, and a recommendation. **No production path changes.**

### Problem Analysis

"The terminal grid is browser-only" has been treated as settled in design discussion. It is not established — it has never been attempted in this repo. Every `createTerminal` call site hardcodes the panel:

| Site | |
| :--- | :--- |
| `TaskViewerProvider.ts:6047` | `location: TerminalLocation.Panel` |
| `:11132` | `location: TerminalLocation.Panel` |
| `:11481` | `location: TerminalLocation.Panel` |
| `:27720` | `location: TerminalLocation.Panel` |
| `extension.ts:3563` | `location: TerminalLocation.Panel` |

And `parentTerminal` appears nowhere in the source. Meanwhile `TerminalOptions.location` accepts three shapes, two of them unused here:

- `TerminalLocation.Panel` / `.Editor`
- `TerminalEditorLocationOptions` — `{ viewColumn, preserveFocus }`: a terminal as an **editor tab in a specific column**
- `TerminalSplitLocationOptions` — `{ parentTerminal }`: a **split beside an existing terminal**

Terminals as editor tabs across split view columns is, on its face, a grid. Before anyone writes "browser-only" into a plan or a doc, it should be tried.

**The seam blocks it before the API does.** `TerminalBackend.create(name, shellPath?, cwd?)` (`hostSeams.ts:229`) has no location parameter, so today no seam-routed caller *could* request a location even if it wanted one. Widening that signature is the spike's only production-shaped change, and it is additive — an optional fourth argument that every existing caller omits.

### What this spike is for, and what it is not

It is for retiring an assumption. It is **not** a step toward moving teams into VS Code: the address-and-observe rule (a seat is usable where Switchboard can both write to it and see it) is unaffected by layout. `VscodeTerminalBackend._wrap()` no-ops `onData`/`onExit` (`hostSeams.ts:293`) whatever column the terminal sits in. A pretty grid of unobservable seats is still unobservable — the spike answers the layout question only, and the findings note must say so explicitly so a positive result is not misread as a green light.

## Metadata

**Complexity:** 2
**Tags:** ui, ux, frontend, refactor

## User Review Required

- **Nothing to decide up front.** The output is a findings note and a recommendation; the decision comes after. Reviewers should agree the *question* is worth an afternoon, not pre-approve an outcome.

## Complexity Audit

### Routine

- One command, `switchboard.experimentalTerminalGrid`, registered only when a hidden setting is on. Not in `contributes.commands` — palette-invisible.
- It reads the configured agents (the same list `createAgentGrid` uses at `extension.ts:3520-3560`), creates one terminal per agent at `{ viewColumn }`, and reports what it observes.
- An optional `location?` on `TerminalBackend.create` plus its pass-through in `VscodeTerminalBackend.create` (`hostSeams.ts:245`). Every existing caller omits it.

### Complex / Risky

- **The findings, not the code, are the deliverable.** A spike that lands code and no written answer has failed. The note must record each item in the checklist below with a verdict, and it must be committed alongside — a spike whose conclusions live only in a chat log gets re-litigated in three months.
- **Pane sizing is expected to be the blocker; confirm it rather than assume it.** The cockpit's `LAYOUTS` set explicit geometry (`1`, `2h`, `2v`, `1x3`, `2x2`, `2x3`, `3x3` — `TERMINALS_LAYOUT_MODES`, `teamWiring.ts:519`). VS Code exposes no API for split ratios. Establish what the *defaults* actually produce for 2, 4, 6 and 9 terminals before concluding.
- **Re-layout after creation is the other likely blocker.** You can create at a location; there is no API to move an existing terminal. The `workbench.action.terminal.*` commands act on the **active** terminal, so a deterministic arrangement means a focus-then-command sequence that fights the user's own layout. Try it and record how badly.
- **Do not touch `createAgentGrid`.** It is the shipped door for ~4,000 installs and is deliberately ungated (a user pressing a button, not a dispatch spawning behind them). The spike is a separate command.
- **Delete-or-promote, explicitly.** The command and the setting come out in the same release that acts on the findings. A hidden experimental command left behind becomes a support surface nobody owns.

## Edge-Case & Dependency Audit

**Race Conditions**
- Creating N terminals in a loop with `preserveFocus` unset steals focus N times. Use `preserveFocus: true` and record whether shell startup still fires reliably — `extension.ts:3547` pre-subscribes to `onDidStartTerminalShellExecution` precisely because focus/show ordering causes a 5s timeout fallback.

**Security**
- None. No new route, no new persisted state beyond one boolean setting.

**Side Effects**
- Terminals in the editor area occupy editor tabs, displacing the user's files. That is itself a finding: record whether the grid is tolerable to live in or something you open and immediately close.

**Dependencies & Conflicts**
- Independent of every other plan in flight. Touches `src/extension.ts`, `src/services/hostSeams.ts` (one optional parameter), and adds one findings note under `docs/`.
- **Related but not blocked by:** `tmux-bridge-1-transport-layer.md`. tmux is the other candidate answer to the grid question and it also yields survive-a-restart, so the findings note should compare against it rather than pretend the choice is grid-or-nothing.

## The checklist the findings note must answer

1. **Geometry.** What arrangement do 2, 4, 6 and 9 terminals actually produce at default sizes? Is a 3x3 reachable at all?
2. **Sizing.** Can panes be made even without the user dragging? If not, how uneven is the default?
3. **Determinism.** Run it twice from a clean window — is the arrangement the same both times?
4. **Re-layout.** Can a terminal be moved into a slot after creation, by any command sequence? At what cost to focus?
5. **Identity.** Are the tabs legible as agent seats — is the terminal name enough, or is a nine-seat grid nine indistinguishable tabs?
6. **Coexistence.** What happens to the user's open files? Is the grid something you can leave up while working?
7. **Persistence.** After a window reload, does the arrangement come back? (VS Code has terminal persistence; the extension does not own the layout.)
8. **The honest comparison.** Against the cockpit, and against tmux: which of the seven above does each actually win?

## Verification Plan

### Automated
- One test asserting the optional `location` parameter on `TerminalBackend.create` is genuinely optional: existing callers compile and behave unchanged, and `VscodeTerminalBackend.create` passes it through only when supplied.
- A guard asserting `switchboard.experimentalTerminalGrid` is absent from `contributes.commands` — it must not be palette-reachable.

### Manual
The eight checklist items above, each with a written verdict, on at least two platforms (one macOS, one Windows — split behaviour and default sizing are not guaranteed to match).
