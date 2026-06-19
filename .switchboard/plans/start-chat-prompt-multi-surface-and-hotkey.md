# Relocate & Multi-Surface the "Start Chat" Prompt Action

> **Scope decisions (2026-06-19):**
> - **Tier 4** (true OS-global hotkey via headless command + on-disk config mirror) is **deferred / out of scope** — it is the only part requiring manual user-side OS setup (Raycast / macOS Shortcuts / Keyboard Maestro / Hammerspoon), which the user does not want to take on. Full analysis preserved in the **## Deferred — Tier 4** section.
> - **No default keyboard shortcut.** Picking a chord that doesn't collide across VS Code / Cursor / Antigravity and across OSes proved not worth the risk (a colliding default is a silent no-op). The keyboard need is already met by the existing **`/switchboard-chat`** slash-command workflow (`.agent/workflows/switchboard-chat.md`) — the same consultative-planning persona the prompt copies — which the user invokes directly in any agent chat. Tier 1 is therefore reduced to a **command-only** contribution (Command Palette, no shipped keybinding; user may bind it natively if they wish). See revised **## Tier 1**.
>
> Active scope is **Tiers 1–3** as revised below.

## Goal

Move the frequently-used, zero-consequence "copy chat prompt" action out of the dangerous Delete-Project neighborhood, surface it on the planning view (project.html), and expose it as a reusable command — across three tiers. (No default hotkey is shipped; the existing `/switchboard-chat` workflow already serves the keyboard-driven case. A fourth tier, a true OS-global hotkey, was explored and deferred; see the scope note above.)

Root-cause framing (preserved): the action's awkwardness is a **tempo mismatch** — a frequent, harmless clipboard copy wedged among rare, deliberate controls (only Delete Project is a genuinely dangerous misclick neighbor). The everyday (no-selection) prompt is a **pure function of `workspaceRoot` + config**, both reachable without the webview open.

## Problem & Context

The "copy chat prompt" button (`#btn-chat-copy-prompt`, `src/webview/kanban.html:2227`) is one of the user's most-frequently-used controls, but it lives in an awkward spot: the top `controls-strip`, wedged inside the *workspace/project* cluster between "Scan Folders" and "Start Automation", two buttons over from **Delete Project**.

Diagnosis from consultation:
- The action is **dual-mode**: with plans selected it copies a multi-plan prompt and clears selection; with nothing selected it copies a *general planning-chat prompt*.
- The user almost exclusively uses the **cold, no-selection mode** — to "apply brakes" on agents (Cursor, Antigravity) that jump straight from planning into coding, and to tell those agents *where to write plans* instead of repeating "write the plan to…" by hand.
- The action is a **pure clipboard copy** (`vscode.env.clipboard.writeText`) — paste into chat afterward. No dispatch, no side effects.
- The real awkwardness is **tempo mismatch**: a frequent, zero-consequence action is surrounded by rare, deliberate controls. Only **Delete Project** is a genuinely dangerous misclick neighbor; the others are harmless.
- Surface model: **kanban.html = execution view; project.html = planning view.** The project.html "Kanban plans" tab shows plan *content*, making it the natural home for the consult-on-a-plan flow.

### Confirmed code facts (investigation done + re-verified this pass)
- Handler: `KanbanProvider.ts:5286` (`chatCopyPrompt` case). No-selection path is:
  ```
  const chatPlanDestinations = this._taskViewerProvider?.resolveChatPlanDestinations(workspaceRoot);
  const prompt = buildKanbanBatchPrompt('chat', [], { workspaceRoot, chatPlanDestinations });
  await vscode.env.clipboard.writeText(prompt);
  ```
  **Re-verified:** the selection branch builds `chatPlans` from `this._lastCards` (live board state, `KanbanProvider.ts:5290-5300`); the no-selection branch passes `[]` and depends on nothing live. Confirmed at `KanbanProvider.ts:5286-5308`.
- A nearly identical no-selection variant already exists: `copyChatWorkflow` (`KanbanProvider.ts:5310-5319`). Its body is exactly `resolveChatPlanDestinations` → `buildKanbanBatchPrompt('chat', [], …)` → `clipboard.writeText`, plus a status-message post. **This is the path to promote into a shared, webview-free method.**
- `resolveChatPlanDestinations` (`TaskViewerProvider.ts:1403`) depends only on `workspaceRoot` + `_getPlanScannerConfig().chatPlanDestinations`, with `~`/`<repo>` expansion (`TaskViewerProvider.ts:1406-1415`). **No live board/card state.** Falls back to `<root>/.switchboard/plans` when nothing is configured.
- That config is read from VS Code settings: `vscode.workspace.getConfiguration('switchboard.planScanner')` → stored in a `settings.json`. **This is the one `vscode`-bound input** in the otherwise-pure path.
- Button wiring: `kanban.html:6669` posts `chatCopyPrompt` with `{ sessionIds, workspaceRoot }`.

#### NEW — purity confirmation for Tier 4 (the load-bearing risk, now resolved)
- `buildKanbanBatchPrompt` lives in `src/services/agentPromptBuilder.ts:388`. Its **only imports are `fs`, `path`, and `./agentConfig`** (`agentPromptBuilder.ts:8-10`). `agentConfig.ts` contains **no `vscode` import** (grep: zero matches). **Therefore `buildKanbanBatchPrompt` already runs outside the extension host with no factoring required.** The headless command can import it directly.
- The only `vscode`-bound input is `resolveChatPlanDestinations`'s config read. The plan's on-disk-mirror design isolates exactly this one dependency — correct and minimal.

**Key implication:** the everyday (no-selection) prompt is a pure function of `workspaceRoot` + config, both reachable without the webview open. This is what makes a headless/global trigger possible — and the builder is already importable headless.

## Metadata
**Tags:** ux, ui, frontend, feature
**Complexity:** 4

> **Complexity note (Clarification):** with Tier 4 deferred *and* the default keybinding dropped, scope is routine: relocate one button (Tier 2), add one button (Tier 3), and register one palette command that promotes the existing `copyChatWorkflow` body into a shared method (Tier 1). The only invariant to protect is prompt-text parity across the surfaces (one shared method, guarded by a test). No new keybinding contribution, no cross-process contract. Low–Medium band. (Earlier 7 → 5 → 4 as Tier 4 and then the keybinding came out of scope.)

## Goals
1. Make the frequent "start chat" action safe to fire repeatedly with zero risk of hitting Delete Project.
2. Expose the action as a reusable command (Command Palette, user-bindable) and confirm the existing `/switchboard-chat` slash-command workflow covers the keyboard-driven, no-button case. *(Revised from the original "ship a default in-editor keybinding" — see scope note.)*
3. Make it reachable on the **planning** surface (project.html plans tab), not just the execution surface.
4. ~~Explore a **true global hotkey** that works even when VS Code is not the focused app.~~ **Deferred** — explored, found feasible, but requires manual user OS-level setup; out of scope per user decision. See **## Deferred — Tier 4**.

## Non-Goals
- Changing the *content* of the generated prompt or `buildKanbanBatchPrompt` behavior.
- Touching the selection-aware multi-plan flow's logic (only its entry points/placement).
- Forcing the implementation.html sidebar to be open (explicitly rejected by user).

## User Review Required
- **Tier 1 — confirm command-only, no shipped keybinding** (decided 2026-06-19). The command appears in the Command Palette and is user-bindable via VS Code's native Keyboard Shortcuts editor; the `/switchboard-chat` workflow is the primary keyboard path. Confirm we are *not* shipping a default chord and *not* building a setup.html rebind UI.
- **Tier 2 placement — confirm (i) the `kanban-sub-bar`** (vs (ii) far-right of top strip). Plan assumes **(i)**, with the watch-item that the button must be a fixed control that survives status-message re-rendering in that strip.
- **Tier 3 — confirm cold-start-only, next to Import** (no plan-context/selection mode on the planning surface). Plan assumes yes.
- **Minor — `/switchboard-chat` destination parity (non-blocking).** The clipboard prompt bakes in the resolved, `~`/`<repo>`-expanded `chatPlanDestinations`; the static workflow file references a "PLAN DESTINATION directive … configured in Switchboard Setup." Confirm the slash-command path receives the same resolved destinations so the two entry points stay equivalent. Not a blocker for Tiers 1–3.

## Complexity Audit

### Routine
- Tier 2: relocate one button's markup + CSS within `kanban.html` and keep existing `chatCopyPrompt` wiring (`kanban.html:6669`). (~2)
- Tier 3: add one toolbar button to `project.html` next to `#btn-import-kanban-plans` (`project.html:1001`), wire it in `project.js` (~`:115` block), and have it dispatch the Tier 1 command — exactly mirroring the existing Import button, whose handler runs `vscode.commands.executeCommand('switchboard.importUnclaimedPlans')` (`PlanningPanelProvider.ts:1998-2002`). (~2)
- Tier 1 command registration: a new `registerCommand` in `src/extension.ts` alongside the existing `switchboard.*` commands (`extension.ts:667, 740, 900`) calling the promoted shared method. No keybinding contribution. (~2)
- Promoting `copyChatWorkflow`'s body (`KanbanProvider.ts:5310-5319`) into a shared, webview-free function — the builder it calls is already `vscode`-free. (~2)

### Complex / Risky
- Shared-method promotion: the no-selection prompt build becomes one path used by the command, the kanban webview, and (via the command) project.html. If a surface drifts to its own builder call, prompt text diverges — guard with a parity test. *(This is now the only non-routine item.)*

*(Deferred / dropped — earlier drafts carried keybinding-collision risk (no longer shipping a default chord) and Tier 4's on-disk-mirror/CLI risks (out of scope; retained in the Deferred section).)*

## Edge-Case & Dependency Audit

- **Race Conditions:**
  - None material in Tiers 1–3. The no-selection prompt build is synchronous and reads live VS Code config at fire time — no cross-process or cross-window state. (The mirror write/read race lived entirely in the deferred Tier 4.)
- **Security:**
  - No new files, no secrets, no shell interpolation. All paths are read from VS Code config and passed as strings to the pure builder. (The `~/.switchboard/` mirror file and `pbcopy` invocation were Tier 4 only — deferred.)
- **Side Effects:**
  - Tier 2 relocation must coexist with `kanban-sub-bar` status-message rendering (`kanban.html:2259+`) — the button must be a *fixed* element, not overwritten when status text is injected into that strip.
  - Adding the Tier 1 command is a `package.json` `contributes.commands` entry + an `extension.ts` registration; takes effect on reinstall/rebuild only (installed-extension reality — `dist/` not edited by hand). No `contributes.keybindings` change.
- **Dependencies & Conflicts:**
  - All three tiers share one prerequisite: a single reusable method that produces the no-selection chat prompt. `buildKanbanBatchPrompt` is already `vscode`-free (`agentPromptBuilder.ts:8-10`; `agentConfig.ts` has no `vscode`), and `resolveChatPlanDestinations`'s config read stays on the extension host — so for Tiers 1–3 the shared method simply wraps the existing `copyChatWorkflow` body. No factoring out of the extension host is needed.
  - `PlanningPanelProvider` (serves `project.html`, `PlanningPanelProvider.ts:326-328`) currently holds **no** reference to `TaskViewerProvider` or `buildKanbanBatchPrompt` (grep: zero matches). This is why Tier 3 should dispatch the Tier 1 command rather than re-wire the builder into the planning provider.
  - The `/switchboard-chat` workflow (`.agent/workflows/switchboard-chat.md`) is the consultative-planning persona the prompt embeds — it is the user's keyboard-driven entry point in agent chats, so no shipped keybinding is needed.

## Dependencies
- None external. Step 0 of the same effort is promoting the shared no-selection prompt method (a wrap of the existing `copyChatWorkflow` body); no separate session required.

## Adversarial Synthesis

**Risk Summary:** With Tier 4 deferred and the default keybinding dropped, this is now a low-risk UI/command change. The single residual risk is **prompt-text drift** if any surface re-introduces its own builder call instead of routing through the one shared method — guarded by a parity test. Sidestepping the keybinding entirely (relying on the existing `/switchboard-chat` workflow + a palette command the user can bind themselves) removes the only real source of cross-editor fragility. Tiers 1–2 are independently shippable.

---

## Tier 1 — Reusable command (no shipped keybinding) + the existing `/switchboard-chat` workflow

**What:** Register a VS Code command (e.g. `switchboard.copyChatPrompt`) that runs the no-selection chat-prompt copy — the same logic as `copyChatWorkflow` — independent of the webview. **Do not** contribute a default keybinding. The command is the reusable, palette-accessible handle that Tier 3 dispatches; the keyboard-driven case is already served by the `/switchboard-chat` slash-command workflow.

**Why no default keybinding (decided 2026-06-19):** a chord that doesn't collide across VS Code / Cursor / Antigravity *and* across macOS/Windows/Linux is hard to guarantee, and a colliding default is a silent no-op — worse than nothing. Rather than gamble on a default, ship the command unbound. Anyone who wants a shortcut binds it on a chord that's free on *their* machine via VS Code's native Keyboard Shortcuts editor (`@command:switchboard.copyChatPrompt`). No setup.html rebind UI is built.

**Why this still covers the stated need:** the original "fire it from the keyboard while focused in Cursor/Antigravity" goal is met by **`/switchboard-chat`** (`.agent/workflows/switchboard-chat.md`) — the identical consultative-planning persona, invoked as a slash command directly in the agent's chat pane. That is the natural keyboard path in those tools and needs nothing built here.

**Approach:**
- Extract the no-selection prompt build into a single reusable method on the extension host (the `copyChatWorkflow` body, `KanbanProvider.ts:5310-5319`, already is this — promote/share it) so the command and the webview message both call one path.
- Command resolves `workspaceRoot` from the active workspace (no webview needed) → calls the shared method → `clipboard.writeText` + info message.
- Contribute only `contributes.commands` in `package.json` (`package.json:48`). **No `contributes.keybindings` block** (the codebase has none today; we keep it that way).
- Register the command in `src/extension.ts` next to the existing `switchboard.*` registrations (`extension.ts:667, 740, 900`).

**Files (verified):** `package.json` (new command entry only), `src/extension.ts` (command registration), `src/services/KanbanProvider.ts` (promote `copyChatWorkflow` body to a shared/webview-free method). *(No `setup.html` / `SetupPanelProvider.ts` rebind work — dropped with the keybinding.)*

**Optional follow-up (not in scope, user-driven):** if the user later wants a fast key, they bind `switchboard.copyChatPrompt` themselves in the native Keyboard Shortcuts editor. We could add a one-line tip in setup.html pointing at that, but no code/UI is required.

**Sub-complexity:** ~2.

---

## Tier 2 — De-risk the existing button (kanban.html)

**What:** Pull `#btn-chat-copy-prompt` out of the dangerous neighborhood and make it the obvious, frequent target.

**Decided:** Label = **`CHAT PROMPT`** (labeled, not icon-only). Behavior unchanged — same `chatCopyPrompt` wiring (`kanban.html:6669`).

**Location — two candidates the user raised:**
  - **(i) The `kanban-sub-bar` (second strip, `kanban.html:2259`), directly below the dropdown.** The user notes this strip is mostly used for status messages — i.e. it has spare room and sits right under where attention falls. This gives the button maximal isolation from Delete Project (different strip entirely) and a stable, predictable home. **Recommended.**
  - **(ii) Far-right of the top `controls-strip`**, near the view controls. Also removes it from the Delete Project neighborhood, but keeps it competing with other top-strip controls.

  **Recommendation: (i) the sub-bar.** It is the cleanest separation from the dangerous cluster and uses an underutilized surface. Confirm i vs ii. (Watch-item: ensure the button coexists with the status-message rendering in that strip — it should sit as a fixed control, not be overwritten when status text appears. The sub-bar at `kanban.html:2259+` already hosts fixed controls like `#btn-pause-autoban-timer` / `#btn-reset-autoban-timer`, so add the button as a sibling fixed element, not inside the status-text container.)

- Tooltip can mention the Command Palette entry and `/switchboard-chat` as alternatives (no chord to advertise, since none is shipped).

**Files (verified):** `src/webview/kanban.html` (remove the button markup at `:2227`; add a labeled `CHAT PROMPT` control into the sub-bar region at `:2259+` + CSS).

**Sub-complexity:** ~2.

---

## Tier 3 — Additive surface in project.html plans tab (planning view)

**What:** Add a "start chat" affordance in the project.html Kanban-plans tab, where plan *content* is visible — the natural home for the consult-on-a-plan flow and for building the planning-view habit.

**Decided:** **Cold-start only** (no plan-context/selection mode here). **Placement: next to the existing Import button** in the plans-tab toolbar. (project.html already has a per-plan "link to plan" button on each plan; this new control is the toolbar-level cold-start trigger, sitting beside Import.)

**Approach (verified + simplified):**
- Add a `CHAT PROMPT` button next to `#btn-import-kanban-plans` (`project.html:1001`).
- **Reuse pattern, not the builder:** wire it in `project.js` (the import button is grabbed at `project.js:115`) to post a message that the planning provider turns into `vscode.commands.executeCommand('switchboard.copyChatPrompt')` — exactly mirroring how the Import button's `importPlans` message executes `switchboard.importUnclaimedPlans` (`PlanningPanelProvider.ts:1998-2002`). This avoids wiring `TaskViewerProvider`/`buildKanbanBatchPrompt` into `PlanningPanelProvider` (which has neither today) and guarantees identical prompt text with the Tier 1 command. *(This is exactly why Tier 1 keeps the command even with no keybinding — it is the clean bridge for this surface.)*

**Files (verified):** `src/webview/project.html` (button markup near `:1001`), `src/webview/project.js` (wiring near the `:115` element-grab block), `src/services/PlanningPanelProvider.ts` (new message case dispatching the Tier 1 command, alongside the existing `importPlans` case at `:1998`).

**Sub-complexity:** ~2.

---

## Deferred — Tier 4: True global hotkey (VS Code closed / any app focused)

> **DEFERRED / OUT OF SCOPE (2026-06-19).** Not part of the active build. Retained in full because the analysis is sound and it may be revived. **Why deferred:** it is the only tier that cannot be delivered turnkey — a VS Code extension cannot register an OS-global hotkey, so the user would have to wire the shipped headless command to a global shortcut themselves (Raycast / macOS Shortcuts / Keyboard Maestro / Hammerspoon). The user declined that manual setup. Tiers 1–3 already cover every "editor is focused" case, which is the bulk of the stated need.

**Honest constraint:** A VS Code extension **cannot** capture a system-wide hotkey when no VS Code-family editor is focused. There is no extension API for OS-global hotkeys. Tier 1 already covers "focused in VS Code / Cursor / Antigravity." Tier 4 is only about the **everything-closed / different-app-focused** case.

**Why it's feasible at all (now confirmed):** the no-selection prompt is a pure function of `workspaceRoot` + `switchboard.planScanner.chatPlanDestinations` (from a `settings.json`) + `buildKanbanBatchPrompt`. **`buildKanbanBatchPrompt` is already `vscode`-free** (`agentPromptBuilder.ts:8-10`; `agentConfig.ts` has no `vscode`), so it can run in a small headless command that ends in `pbcopy`. The only thing the headless process cannot do is read VS Code config — solved by the on-disk mirror below.

**Design simplification — mirror the effective config to a stable on-disk file.** Rather than have the headless command parse editor-specific `settings.json` (which reintroduces the "which editor — VS Code vs Cursor vs Antigravity — and which scope" problem), the extension **writes the resolved chat-prompt inputs to a single canonical location on disk** (e.g. `~/.switchboard/chat-prompt-config.json`) whenever the relevant settings/workspace change. Contents: the resolved `chatPlanDestinations` (already `~`/`<repo>`-expanded via `resolveChatPlanDestinations`, `TaskViewerProvider.ts:1403-1416`) and the active/primary workspace root. The headless command then reads only that one file — editor-agnostic, scope-agnostic, and trivially correct in the single-repo case.
  - **Multi-repo fallback:** the mirror records the *last-active* workspace; optionally a setting pins a default workspace, and/or the command accepts a workspace argument. Good enough given the user's "rare" assessment.
  - **Atomicity (NEW):** write the mirror via temp-file + atomic rename so the OS hotkey firing mid-write never reads a partial/corrupt JSON.

**Path:**
1. Extension mirrors effective config → `~/.switchboard/chat-prompt-config.json` on `onDidChangeConfiguration` (filtered to `switchboard.planScanner`) and on activation/workspace change. Atomic write.
2. Headless command (small Node entry importing the compiled `buildKanbanBatchPrompt`, or a documented shell script) reads that file, calls the shared pure `buildKanbanBatchPrompt('chat', [], …)`, and `pbcopy`s the result. No running extension host required.
3. User binds the command to an OS-level global shortcut (macOS Shortcuts / Raycast / Keyboard Maestro / Hammerspoon). Switchboard ships the command + documents the binding; it cannot register the OS hotkey itself.

**Must-confirm-in-code before building:**
- **Code reuse:** ✅ **CONFIRMED** — `buildKanbanBatchPrompt` runs outside the extension host (no `vscode` import in `agentPromptBuilder.ts` or `agentConfig.ts`). No factoring of the builder required; the headless entry imports it directly (from compiled `dist/` output).
- **Distribution (still open):** how the headless command lands on the user's PATH (npm `bin` — note `package.json` has no `bin` field today — install step, or a script shipped in the extension dir that the user symlinks). This is the one productization decision left.

**Sub-complexity:** ~5 (reduced from ~6 by the on-disk-mirror simplification; the confirmed builder purity removes the largest unknown but the new cross-process file contract + distribution keep it at ~5).

---

## Proposed Changes

> File-organized summary of the verified touch points. The Tier sections above carry the full rationale; this section is the implementation checklist with confirmed locations.

### `package.json`
- **Context:** `contributes.commands` array at `:48`; no `contributes.keybindings` block (kept that way).
- **Logic:** add a single `switchboard.copyChatPrompt` command entry (title e.g. "Switchboard: Copy Chat Prompt"). **No keybindings block.**
- **Edge cases:** command shows in the palette after reinstall/rebuild; the user may bind it themselves natively.

### `src/extension.ts`
- **Context:** existing `switchboard.*` command registrations (`:667`, `:740`, `:900`).
- **Logic:** register `switchboard.copyChatPrompt` → resolves active `workspaceRoot` → calls the promoted shared no-selection prompt method → `clipboard.writeText` + info message.
- **Edge cases:** no active workspace → resolve to first workspace root (matches `resolveChatPlanDestinations` fallback) or no-op with a clear message.

### `src/services/KanbanProvider.ts`
- **Context:** `chatCopyPrompt` (`:5286`) and `copyChatWorkflow` (`:5310`) cases; both already call `resolveChatPlanDestinations` → `buildKanbanBatchPrompt('chat', [], …)`.
- **Logic:** promote the `copyChatWorkflow` body into a shared, webview-free method that the new command, the webview message, and (indirectly) Tier 3 all call. Behavior unchanged.
- **Edge cases:** preserve the existing status-message post for the webview path; the command path uses an info message instead (no webview to post to).

### `src/webview/kanban.html`
- **Context:** button at `:2227` (top strip, beside Delete Project / Scan Folders / Start Automation); `kanban-sub-bar` at `:2259+` with existing fixed controls; existing `chatCopyPrompt` post at `:6669`.
- **Logic:** remove the icon button from the top strip; add a labeled `CHAT PROMPT` control as a fixed sibling in the sub-bar; keep the `:6669` wiring; tooltip may mention the palette command / `/switchboard-chat` (no chord shipped).
- **Edge cases:** must not be overwritten by status-message rendering in the sub-bar.

### `src/webview/project.html` + `src/webview/project.js`
- **Context:** Import button `#btn-import-kanban-plans` at `project.html:1001`, grabbed in `project.js:115`.
- **Logic:** add a `CHAT PROMPT` button beside Import; wire it to post a message that the provider turns into `executeCommand('switchboard.copyChatPrompt')`.
- **Edge cases:** cold-start only; no selection/plan-context mode on this surface.

### `src/services/PlanningPanelProvider.ts`
- **Context:** serves `project.html` (`:326-328`); existing `importPlans` case executes `switchboard.importUnclaimedPlans` (`:1998-2002`); holds no `TaskViewerProvider`/builder reference.
- **Logic:** add a new message case (e.g. `copyChatPrompt`) that executes the Tier 1 command — mirroring `importPlans`. No builder wiring needed.

*(No `setup.html` / `SetupPanelProvider.ts` changes — the rebind UI was dropped with the keybinding. Deferred — the Tier 4 headless command + on-disk mirror writer touch points are retained in the **## Deferred — Tier 4** section.)*

## Risks & Watch-Items
- **Installed-extension reality:** per project convention, source lives in `src/`; do not edit `dist/`. Changes won't appear until rebuilt/reinstalled.
- **Prompt-path parity:** the shared no-selection method must be the single source for the command, the kanban button, and the project.html button — guard with a parity test so the surfaces never drift. *(This is the one real risk left.)*
- **`/switchboard-chat` destination parity:** confirm the slash-command path receives the same resolved `chatPlanDestinations` the clipboard prompt bakes in (non-blocking; see User Review).
- **Scope creep:** Tier 3's selection-aware mode (and the deferred Tier 4) are the tempting over-builds; keep the cold-start-only contract.

## Recommended Sequencing (Tiers 1–3 in scope)
1. **Tier 2** (de-risk button → `CHAT PROMPT` in the sub-bar) — smallest, removes daily friction immediately.
2. **Tier 1** (reusable `switchboard.copyChatPrompt` command, no keybinding; includes the shared-method promotion in `KanbanProvider.ts`) — the bridge Tier 3 needs.
3. **Tier 3** (project.html cold-start button next to Import, dispatching the Tier 1 command) — planning-view reach.
   - Shared prerequisite for all three tiers: one reusable no-selection prompt method (a wrap of the existing `copyChatWorkflow` body), kept on the extension host.
   - *(Deferred: Tier 4 — true OS-global hotkey. See the Deferred section.)*

## Decisions — Final (all settled)
1. **No shipped keybinding** (revised 2026-06-19). Ship `switchboard.copyChatPrompt` as a Command Palette command only; the user may bind it natively if desired. The existing `/switchboard-chat` slash-command workflow is the primary keyboard path. (Supersedes the earlier `cmd/ctrl+alt+c` + setup.html-rebind decision, dropped because no default chord is safe across all editors/OSes.)
2. Button label `CHAT PROMPT`, placed in **(i)** the `kanban-sub-bar` (second strip, ~`kanban.html:2259`), below the dropdown. Must render as a fixed control that survives status-message updates in that strip.
3. project.html — cold-start only, next to the Import button (dispatches the Tier 1 command).
4. ~~Tier 4 — build now.~~ **Deferred / out of scope** (2026-06-19): requires manual user OS-level setup the user declined. Analysis retained in the Deferred section.

Shared prerequisite: one no-selection prompt method (a wrap of the existing `copyChatWorkflow` body) reused by the command and both webview surfaces, kept on the extension host. Builder confirmed `vscode`-free.

## Verification Plan

> Per session directive: **skip compilation and skip the test suite this session** (the user runs tests separately). The cases below define what those tests must cover; do not execute them now.

### Automated Tests
- **Shared prompt path parity:** assert the new command path, the webview `chatCopyPrompt` no-selection path (`KanbanProvider.ts:5286`), and `copyChatWorkflow` (`:5310`) produce byte-identical prompt text for the same `workspaceRoot` + config. (Builder is pure — easy to assert.) This is the key invariant guarding against surface drift.
- **`resolveChatPlanDestinations` expansion:** existing/extended unit coverage for `~`, `<repo>`, relative, and empty-config fallback (`TaskViewerProvider.ts:1403-1416`).
- **Webview regressions:** static-source assertions (in the style of the existing `setup-autosave-regression` / `plan-ingestion-target-regression` tests) that `kanban.html` no longer has the button in the top strip and now has it in the sub-bar; that `project.html` has a `CHAT PROMPT` button beside `#btn-import-kanban-plans`.
- **package.json contributions:** assert a `switchboard.copyChatPrompt` command entry exists; assert **no** `contributes.keybindings` block was added.

### Manual Verification (user, post-rebuild)
- Reinstall the extension; confirm "Switchboard: Copy Chat Prompt" appears in the Command Palette and copies the cold-start prompt.
- Confirm `/switchboard-chat` is available as a slash command in the agent chat (Cursor/Antigravity/Claude) and reflects the configured plan destinations.
- Confirm the kanban sub-bar button copies and survives a status-message update.
- Confirm the project.html button copies the cold-start prompt.

---

**Recommendation:** Complexity **4** → **Send to Coder.** With the keybinding dropped and Tier 4 deferred, this is routine UI relocation plus a thin reusable command. The single thing needing care is keeping the shared prompt method the one source of truth (parity test). The `/switchboard-chat` workflow already covers the keyboard-driven case at no build cost.
