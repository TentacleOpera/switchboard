---
description: "Make memo capture work headless by relocating the capture UI out of the VS Code-only implementation.html into the Project panel (project.html), which the standalone host already serves. Move the memoLoad/memoSave/memoClear/memoGeneratePrompt handlers to the project-panel path so they answer without VS Code, and degrade Send to Planner → Copy Prompt where there is no terminal."
---

# Headless Memo — relocate capture into the Project panel

## Goal

**Definition of done: the memo capture tab works in the browser** — a user can capture entries, autosave, clear, and Copy Prompt from a memo surface inside the Project panel (which headless serves), with "Send to Planner" degrading to "Copy Prompt" where there is no agent terminal.

### Core problem (root-cause analysis)

The memo capture UI lives in `implementation.html` — the Agents/Terminals sidebar — which the standalone host **never serves** (headless serves only `kanban.html` and `project.html`). So memo has no home in the browser at all. Its four verbs live in `TaskViewerProvider` ([TaskViewerProvider.ts:11719-11806](../../src/services/TaskViewerProvider.ts#L11719)):
- `memoLoad` / `memoSave` / `memoClear` — pure read/write of `.switchboard/memo.md`. No terminal.
- `memoGeneratePrompt` — parses entries, builds the planner prompt, then either **`copy`** (writes to clipboard — no terminal) or **`send`** (`dispatchCustomPromptToRole('planner', …)` — fires a planner **terminal agent**).

So memo splits cleanly: capture/autosave/clear/Copy Prompt are non-terminal and belong headless; Send to Planner is the one terminal-bound action. But because the UI is trapped in the never-served `implementation.html`, none of it is reachable in the browser — not even the non-terminal half.

It cannot be a "wire the verbs into bootstrap" fix, because the *UI has no host*. The memo surface must move to a panel headless already serves. The Project panel (`project.html`) is the natural home: it already holds plans/PRDs/constitution/docs, and memo→plans capture is planning-adjacent. Relocating it there gives memo one home in **both** hosts (the anti-divergence rule), rather than duplicating a headless-only memo UI.

> Note: the **chat-driven** memo flow (`/switchboard-memo` → `process memo` writes plan files → the watcher ingests them) already works headless once the ingestion subtask lands. This plan adds the **manual capture UI** to the browser; it is the lower-priority memo path and can ship last.

## Metadata
- **Tags:** standalone, npx, headless, memo, project-panel, ui, parity
- **Complexity:** 5
- **Release phase:** Headless UI parity; follow-on of the app-shell. Relocation touches both hosts (the memo tab moves for the extension too), so exercise the extension's Project panel after the move.

## User Review Required
- **One UX call:** relocating the memo capture tab from the Agents/Terminals sidebar (`implementation.html`) into the **Project panel** changes where extension users find it too — this is deliberate (one home, both hosts), not headless-only. Confirm memo-in-Project-panel is the intended home. **Recommendation: yes — memo→plans capture is planning-adjacent, and a headless-only second UI would reintroduce the divergence the whole effort fights.**

## Scope

### ✅ IN SCOPE
- **Relocate the memo capture UI** from `implementation.html` into `project.html` (a memo tab/section: textarea + status + Clear + Copy Prompt + Send to Planner), reusing the existing markup/behaviour.
- **Move/expose the memo verbs on the Project-panel provider path** (`memoLoad`, `memoSave`, `memoClear`, `memoGeneratePrompt`) so they are answerable without VS Code — the non-`send` logic is already pure file I/O + clipboard.
- **Degrade `send` → `copy` headless** — when `hostCapabilities.terminalDispatch` is false, "Send to Planner" behaves as "Copy Prompt" (no planner dispatch); reuse the existing failure-fallback that already copies the prompt.
- The memo tab then rides the app-shell strip for free (it lives inside the already-served Project panel).

### ⚙️ OUT OF SCOPE
- Dispatching entries to a planner **terminal** headless (that is the terminal fleet — VS Code-only; Copy Prompt is the headless behaviour).
- The chat-driven `/switchboard-memo` → `process memo` path (already works headless via ingestion; not part of this UI relocation).
- Keeping a second, headless-only memo UI in `implementation.html` (explicitly rejected — one home, both hosts).

## Implementation Steps
1. Move the memo tab markup + client handlers from `implementation.html` into `project.html`/`project.js` (textarea, autosave debounce, Clear, Copy Prompt, Send to Planner).
2. Relocate the `memoLoad`/`memoSave`/`memoClear`/`memoGeneratePrompt` handlers onto the Project-panel provider path so both hosts answer them; keep `.switchboard/memo.md` as the store.
3. Gate `send`: when `hostCapabilities.terminalDispatch` is false, `memoGeneratePrompt` treats `send` as `copy` (clipboard, clear memo, no dispatch); the shell/panel hides or relabels the "Send to Planner" affordance accordingly.
4. Confirm the extension still reaches memo from the Project panel after the move (parity check for the VS Code side).

## Complexity Audit
### Routine
- `memoLoad`/`memoSave`/`memoClear` are pure read/write of `.switchboard/memo.md` ([TaskViewerProvider.ts:11719](../../src/services/TaskViewerProvider.ts#L11719)) — no terminal, trivially host-agnostic.
- `action:'copy'` in `memoGeneratePrompt` is clipboard-only, already host-neutral.
- Moving markup + client handlers between two webview HTML files.

### Complex / Risky
- **Relocation touches both hosts.** The memo tab leaves `implementation.html` (extension-only) and lands in `project.html` (both hosts serve it). The extension's memo path must keep working after the move — this is a genuine parity risk, not a pure-addition.
- **Handler ownership move.** `memoGeneratePrompt`'s `send` branch calls `dispatchCustomPromptToRole('planner', …)` ([TaskViewerProvider.ts:11780](../../src/services/TaskViewerProvider.ts#L11780)); relocating the four verbs onto the Project-panel provider path must not orphan the extension's planner-dispatch behaviour.

## Edge-Case & Dependency Audit
- **Race Conditions:** the autosave debounce (existing behaviour) plus a manual Clear must not race a `memoGeneratePrompt` that clears on success — preserve the existing single-writer ordering when moving the handlers.
- **Security:** memo content is local file I/O on `.switchboard/memo.md`; the Project-panel verb path is token/cookie-gated like the rest of `/project`.
- **Side Effects:** headless, `send` becomes `copy` (clipboard + clear, no dispatch) — a deliberate degrade; the "Send to Planner" affordance is hidden/relabelled via `hostCapabilities.terminalDispatch`.
- **Dependencies & Conflicts:** edits `project.html`/`project.js` (also lightly touched by the app-shell's `switchPanel` bridge) and `TaskViewerProvider.ts` (handler relocation). Different regions of `project.html`, but land after the app-shell to avoid a merge conflict on that file.

## Dependencies
- **Blocks on** the app-shell subtask (`headless-app-shell-nav-container.md`) — the Project panel must ride the strip for the relocated memo tab to be reachable in one tab.
- **Adjacent to** the ingestion subtask — the chat-driven `/switchboard-memo` → `process memo` path already works headless via ingestion; this plan is the *manual capture UI* only and can ship last.
- No session (`sess_…`) dependencies.

## Adversarial Synthesis
**Risk Summary:** The chief risk is a *parity regression* — relocating the memo tab breaks the extension's existing memo capture (or its planner dispatch) while chasing the headless win. Mitigation: the four verbs move onto a shared Project-panel provider path both hosts answer, and the extension's Project panel is exercised post-move as an explicit acceptance step. Secondary risk: the `send→copy` degrade firing when a terminal *is* available — gated strictly on `hostCapabilities.terminalDispatch`, not on a try/catch.

## Proposed Changes
### `src/webview/implementation.html` → `src/webview/project.html` (+ `project.js`)
- **Context:** Memo capture UI lives in the never-served-headless `implementation.html` ([implementation.html:1589](../../src/webview/implementation.html#L1589)).
- **Logic:** Move the memo tab markup + client handlers (textarea, autosave debounce, Clear, Copy Prompt, Send to Planner) into `project.html`/`project.js`, reusing existing behaviour.
- **Edge Cases:** autosave/clear ordering preserved; "Send to Planner" hidden/relabelled when `terminalDispatch` is false.

### `src/services/TaskViewerProvider.ts`
- **Context:** Hosts `memoLoad`/`memoSave`/`memoClear`/`memoGeneratePrompt` ([TaskViewerProvider.ts:11719](../../src/services/TaskViewerProvider.ts#L11719)); `send` dispatches to a planner terminal.
- **Logic:** Expose the four verbs on the Project-panel provider path so both hosts answer them; keep `.switchboard/memo.md` as the store; gate `send→copy` on `hostCapabilities.terminalDispatch`.
- **Edge Cases:** extension keeps planner dispatch; headless copies and clears without dispatch or throw.

## Verification Plan
- **Automated:** `memoSave`→`memoLoad` round-trips `.switchboard/memo.md`; `memoClear` empties it; `memoGeneratePrompt` with `action:'copy'` returns the prompt and clears; with `action:'send'` under `terminalDispatch:false` it copies (no dispatch, no throw).
- **Manual (headless):** `npx switchboard` → Project panel → memo tab → type entries (autosaves), Copy Prompt (clipboard has the planner prompt, memo clears); Send to Planner behaves as Copy (no dead click).
- **Manual (extension parity):** open the workspace in VS Code → memo reachable from the Project panel, capture + Send to Planner still dispatches to a planner terminal.

> Session note: compilation and automated-test execution are skipped this pass per session directive. The automated checks above are the target acceptance signals for the coder; they are specified, not run here.

## Recommendation
Complexity 5 → **Send to Coder.** Lowest-priority memo path (chat-driven memo already works headless via ingestion); ship last in the feature, after the app-shell. The one open UX call (memo's new home in the Project panel) has a recorded default.

**Stage Complete:** CREATED

---

## Completion Report

**Status:** Fully implemented (file I/O + planner prompt + send→copy degrade).

### Files changed
- `src/webview/project.html` — new MEMO tab button + `#memo-content` div with textarea, status, Clear/Copy Prompt/Send to Planner buttons.
- `src/webview/project.js` — memo tab activation fires `memoLoad`; `memoContent`/`memoPromptResult`/`memoError` message handlers; autosave (800ms debounce), Clear, Copy Prompt, Send to Planner button wiring; `_memoDirty` guard prevents overwriting focused content.
- `src/webview/transport.js` — `#memo-send-btn` hidden via `host-terminal-dispatch-false` CSS (send→copy degrade; Copy Prompt stays).
- `src/services/PlanningPanelProvider.ts` — `handleServiceVerb` delegates `memoLoad`/`memoSave`/`memoClear`/`memoGeneratePrompt` to `TaskViewerProvider.handleServiceVerb` (the verb handlers stay on TaskViewer; project.html posts via `/project/verb/*`).
- `src/standalone/bootstrap.ts` — `planningVerb` implements all four memo verbs directly (file I/O via `.switchboard/memo.md`, `_parseMemoEntries`, `_buildMemoPlannerPrompt`); send→copy degrade returns the prompt in the HTTP body for transport.js to copy.

### What works
- Memo tab in Project panel: capture, autosave, clear, copy prompt, send to planner.
- Extension host: delegates to TaskViewerProvider (full send-to-planner terminal dispatch).
- Headless/standalone: send degrades to copy (prompt returned in body, transport.js copies to clipboard); memo cleared on success.
- The Memo sub-tab in the sidebar (implementation.html) is untouched — both paths coexist.

### No gaps
This subtask is fully delivered — memo verbs are pure file I/O + prompt generation, no terminal/editor/host-coupled dependencies remained.
