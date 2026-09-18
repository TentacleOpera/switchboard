# "Claude Artifacts" Terminal-Only Agent + Send-to-Terminal Buttons

## Goal

Add a **terminal-only "Claude Artifacts" agent** to the Switchboard roster (a spawnable `claude` terminal in the agent-terminals grid, with **no kanban column**), and add **"⇨ Send to Claude" buttons** to the planning.html HTML-tab artifact round-trip controls that push the download/upload prompts **directly into that terminal and submit them** — instead of (in addition to) copying them to the clipboard.

This is the second layer on top of the artifact round-trip feature: that plan gives you the prompts; this plan gives you a one-click "run it in Claude" path and a dedicated, always-there terminal to run it in.

### Core problem & background

The round-trip plan (`feature_plan_20260629121023_artifact-roundtrip-in-html-tab.md`) generates two prompts (download via `WebFetch`, upload via the `Artifact` tool) and copies them to the clipboard. Clipboard-paste works but is two manual steps and, more importantly, **"paste into Claude" has no defined destination** — the user has to find/keep a Claude terminal around.

The fix is a **named, stable send-target**. Switchboard already has the entire substrate:

1. **Spawnable roster agents.** The agent-terminals grid is built in `extension.ts:2663` from `allBuiltInAgents`, gated per-role by `visibleAgents` and fed a per-role startup command from `getStartupCommands`. Each becomes a named VS Code terminal (`createTerminal`, `extension.ts:2807`) running its command (`sendText(cmd, true)`, `:2891`).

2. **A role can exist WITHOUT a kanban column — there is direct precedent.** The true precedent is **`analyst`**: it is registered in `allBuiltInAgents` (`extension.ts:2675`), listed in `VALID_ROLES` (`agentConfig.ts:397`), and in the visibility defaults (`TaskViewerProvider.ts:3695`) — yet it is **completely absent from `DEFAULT_KANBAN_COLUMNS`** (`agentConfig.ts:105-117`). So `analyst` gets a spawnable grid terminal with **no board column and no card lifecycle** — exactly the shape "Claude Artifacts" needs. (Note: the `extension.ts:2666` comment claims Orchestrator has "no kanban column," but that comment is **stale** — Orchestrator actually DOES have the `ORCHESTRATING` column, `agentConfig.ts:112`, it is merely `epicOnly: true` + `hideWhenNoAgent: true`. Do NOT model on Orchestrator; model on `analyst`.) The pitfall to avoid: do NOT add "Claude Artifacts" as a *custom agent*, because custom agents are folded into `buildKanbanColumns(customAgents, …)` — `KanbanProvider.ts:511` — and would spawn a board column with no card lifecycle.

3. **Sending a prompt into a named terminal is already solved; find-or-spawn is a small extension.** `TaskViewerProvider._executeLocal(terminalName, command)` (`:15008`) resolves a terminal from `_registeredTerminals` (with suffix + VS Code-name fallbacks) and sends it. The robust delivery helper `sendRobustText(terminal, text, paced, log)` (`terminalUtils.ts:93`) handles chunking, clipboard-paste for large payloads, newline-flattening, and submission — and **already recognizes `claude` as a CLI agent** (`terminalUtils.ts:103`, regex tests `terminal.name`; "Claude Artifacts" contains the word "Claude" so it matches). Note: `dispatchCustomPromptToRole` (`:2692`) only **resolves existing** terminals (it errors out if none is registered — `:2717`); the **spawn** happens separately in `createAgentGrid` (`extension.ts:2797`). So the "auto-spawn-then-send" piece is **genuinely new**, but a proven fallback pattern already exists in `PlanningPanelProvider`: the constitution-builder cases (`:3751-3760`) try `dispatchCustomPromptToRole`, then fall back to `vscode.window.createTerminal` + `sendRobustText`. The new `sendPromptToAgentTerminal` generalizes that fallback for an arbitrary role.

So the work is: register one new terminal-only role, default its command to `claude`, and wire two webview buttons to the existing terminal-send path.

### Root cause

There is no first-class "ad-hoc Claude terminal" target. Dispatch always sends to *column-bound* role terminals driven by card movement; there is no roster entry for a stateless helper terminal you can push arbitrary prompts to from a webview. The `analyst` role proved the "role without a column" shape exists (terminal, no board column); this extends it to a user-facing send-target.

## Metadata

- **Tags:** [frontend, backend, ui, feature]
- **Complexity:** 6

## User Review Required

- None. Decisions made:
  1. **Terminal-only role, modeled on `analyst`** (the real no-column precedent) — spawnable/configurable, **no kanban column**, not a custom agent. (Orchestrator was initially cited but actually has the `ORCHESTRATING` column — see Core problem #2.)
  2. **Default startup command `claude`** (editable in the Agents tab like every other role's command).
  3. **Buttons augment, not replace, the copy-prompt buttons** — copy stays as the fallback (and the *edit* step still goes to Gemini/any agent by hand). Send-to-Claude is the fast path for the Claude-specific download/upload steps.
  4. **Auto-spawn-then-send** — if the Claude Artifacts terminal isn't running when a Send button is pressed, spawn it (run `claude`), wait for it to settle, then send. No "open the terminal first" dead-end.

## Complexity Audit

### Routine
- Add a roster row in the kanban.html Agents tab (visibility toggle + command input, default `claude`), cloned from the Orchestrator/researcher row (`kanban.html:2746-2748`).
- Add `{ name: 'Claude Artifacts', role: 'claude_artifacts' }` to `allBuiltInAgents` (`extension.ts:2663`), gated by `visibleAgents` like the rest.
- Add `claude_artifacts: false` to the hardcoded `defaults` map in `getVisibleAgents` (`TaskViewerProvider.ts:3688-3701`) so the role is opt-in. (Without this, `visibleAgents['claude_artifacts']` is `undefined` and the grid gate `!== false` at `extension.ts:2680` makes it visible by default — the opposite of intent.)
- Add a `claude_artifacts` → `'claude'` fallback in `getAgentStartupCommand` (`TaskViewerProvider.ts:3654-3662`), mirroring the existing `jules_monitor` → `'jules'` fallback at `:3658-3661`. (There is no general per-role startup-defaults table; the jules_monitor special case is the only precedent.)
- Add two "⇨ Send to Claude" buttons to the HTML-tab round-trip controls (next to the Copy buttons from the round-trip plan).

### Complex / Risky
- **Cross-provider reach.** The round-trip buttons live in planning.html → `PlanningPanelProvider`, but the terminal registry (`_registeredTerminals`) and send logic live in `TaskViewerProvider`. Need a clean public entry point — expose `TaskViewerProvider.sendPromptToAgentTerminal(role, text)` (find-or-spawn + `sendRobustText`) and call it from the new `PlanningPanelProvider` message handler. Model it on the existing constitution-builder dispatch+fallback-create pattern (`PlanningPanelProvider.ts:3751-3760`): try resolving an existing terminal, fall back to `createTerminal` + `sendRobustText`. Avoid duplicating terminal logic.
- **Find-or-spawn + readiness.** If the terminal isn't running, spawn it via `vscode.window.createTerminal` (as the constitution-builder fallback does, `:3756`), send the startup command, then wait for `claude` to reach its input prompt before sending the prompt. Reuse `sendRobustText`'s pacing (`paced=true`); do not invent a new readiness protocol. NOTE: `dispatchCustomPromptToRole` (`:2692`) only resolves EXISTING terminals and errors if none exists (`:2717`) — it does NOT spawn, so it cannot be the sole mechanism.
- **`/clear` avoidance (critical).** The obvious reuse candidate, `_attemptDirectTerminalPush` (`:15547`), runs a `/clear` before every prompt (`:15617-15634`, gated by `terminal.clearBeforePrompt` default `true`). For artifact sends this would **wipe Claude's conversation context** mid-session. The send path MUST call `sendRobustText` directly (bypassing `_attemptDirectTerminalPush`), and must NOT be "refactored" back through the dispatch path. State this reasoning in the code comment.
- **No-column invariant.** Must verify the new role does NOT leak into `buildKanbanColumns` / `VALID_KANBAN_COLUMNS` / `DEFAULT_KANBAN_COLUMNS` (per the `analyst` precedent — `analyst` is in `allBuiltInAgents` but absent from `DEFAULT_KANBAN_COLUMNS`, `agentConfig.ts:105-117`). A role string that accidentally maps to a column would create a ghost board column. Verified: a role only gets a column if a matching `DEFAULT_KANBAN_COLUMNS`/custom entry exists; we add none.

## Edge-Case & Dependency Audit

- **Terminal not yet spawned:** find-or-spawn (Decision #4). The existing `_executeLocal` *warns* when a terminal is missing (`TaskViewerProvider.ts:15024`); the new send path must instead spawn-then-send so the button always works.
- **Terminal busy / mid-task:** `terminalUtils` already serializes per-terminal sends via `withTerminalSendLock` (`:22`) — reuse it so a second Send queues behind the first instead of interleaving. Do not bypass the lock.
- **`claude` not on PATH / different invocation:** the command is the user-editable roster command (defaulting to `claude`); if the user runs Claude differently (e.g. `claude --dangerously-skip-permissions`), their edit is honored exactly like other roles. No hardcoded binary in the send path.
- **Large prompts:** `sendRobustText` routes payloads >100 chars through clipboard-paste to dodge PTY truncation (`terminalUtils.ts:110-120`) — the artifact prompts are well within what this already handles for dispatch.
- **Newlines in prompts:** `sendRobustText` flattens newlines for CLI agents including `claude` (`:103,127`) so the prompt submits as one input rather than firing early. Keep the prompts single-submission-friendly (they already are).
- **Visibility off by default?** The default `visibleAgents` state for `claude_artifacts` is **false (opt-in)**, like `tester`/`ticket_updater`/`researcher` (`kanban.html:2740,2744,2746`, and the `defaults` map `TaskViewerProvider.ts:3693,3697,3698`). CRITICAL: this opt-in default is ONLY achieved by adding `claude_artifacts: false` to the `defaults` map in `getVisibleAgents` (`TaskViewerProvider.ts:3688-3701`) — without that entry, `visibleAgents['claude_artifacts']` resolves to `undefined` and the grid gate `visibleAgents[role] !== false` (`extension.ts:2680`) treats `undefined` as visible, surprising existing users with a new terminal. Surfacing the round-trip Send buttons should prompt/auto-enable visibility on first use.
- **No confirmation dialogs** (house rule): Send buttons act immediately; no confirm gate (and `confirm()` is a webview no-op anyway).
- **Migration:** This is net-new roster state. `visibleAgents`/`startupCommands` are existing config maps that already tolerate added keys (`GlobalIntegrationConfigService.ts:37` treats them as open maps) — a missing `claude_artifacts` key must default cleanly (treated as the chosen default-visibility), so older configs without the key behave predictably. No destructive migration.

## Dependencies

- **Builds on** `feature_plan_20260629121023_artifact-roundtrip-in-html-tab.md` — that plan adds the HTML-tab round-trip controls and the `ARTIFACT_DOWNLOAD_PROMPT` / `ARTIFACT_UPLOAD_PROMPT` builders. This plan reuses those exact prompt strings; the Send buttons sit beside the Copy buttons. Land the round-trip plan first (or together).

## Adversarial Synthesis

Key risks and mitigations: (1) **Ghost kanban column** from registering the role wrong — mitigated by modeling on `analyst` (in `allBuiltInAgents` but absent from `DEFAULT_KANBAN_COLUMNS`, `agentConfig.ts:105-117`), NOT Orchestrator (which has the `ORCHESTRATING` column, `:112`); never add it as a *custom agent*. (2) **Wrong visibility default** — mitigated by adding `claude_artifacts: false` to the `defaults` map in `getVisibleAgents` (`TaskViewerProvider.ts:3688`); without it `undefined !== false` makes the role visible by default. (3) **`/clear` wipes Claude's context** — mitigated by calling `sendRobustText` directly and bypassing `_attemptDirectTerminalPush` (which clears before every prompt, `:15617-15634`). (4) **Send fires before `claude` is ready** — mitigated by find-or-spawn with paced delivery (model on the constitution-builder fallback, `PlanningPanelProvider.ts:3751-3760`). (5) **Two overlapping Sends interleave** — mitigated by the existing per-terminal send lock (`withTerminalSendLock`, `terminalUtils.ts:22`). (6) **`claude` binary/flags differ per user** — mitigated by the `getAgentStartupCommand` fallback + editable roster command. (7) **No startup default ships** — mitigated by adding a `claude_artifacts`→`'claude'` fallback mirroring `jules_monitor` (`TaskViewerProvider.ts:3658-3661`).

## Proposed Changes

### 1. `src/extension.ts` — register the terminal-only role in the grid
In `allBuiltInAgents` (`:2663`), add `{ name: 'Claude Artifacts', role: 'claude_artifacts' }`, mirroring the `analyst` entry (`:2675` — `analyst` is the proven terminal-without-column role). It is spawned and gated by `visibleAgents[role] !== false` (`:2680`), and has **no kanban column** (no entry added to `DEFAULT_KANBAN_COLUMNS`, `agentConfig.ts:105-117`). Confirm it flows through the existing `createTerminal`/startup-command spawn (`:2807`, `:2891`) unchanged. Do NOT model on Orchestrator — Orchestrator has the `ORCHESTRATING` column (`agentConfig.ts:112`); the `extension.ts:2666` comment claiming otherwise is stale.

### 2. Startup-command + visibility defaults
- **Visibility:** Add `claude_artifacts: false` to the hardcoded `defaults` map in `getVisibleAgents` (`TaskViewerProvider.ts:3688-3701`), alongside `tester: false`, `ticket_updater: false`, `researcher: false` (`:3693,3697,3698`). This is the ONLY mechanism that makes the role opt-in — without it, `undefined !== false` at the grid gate (`extension.ts:2680`) makes the terminal visible by default.
- **Startup command:** Add a `claude_artifacts` → `'claude'` fallback in `getAgentStartupCommand` (`TaskViewerProvider.ts:3654-3662`), mirroring the existing `jules_monitor` → `'jules'` fallback at `:3658-3661`. There is no general per-role startup-defaults table; this special-case fallback is the only precedent. The command remains user-editable in the Agents tab.

### 3. `src/webview/kanban.html` — Agents tab roster row
Add a roster row in the Agents tab (after the Orchestrator row, `:2748`): a `agents-tab-visible-toggle` checkbox (`data-role="claude_artifacts"`), a "Claude Artifacts" label, and a command input (`id="agents-tab-cmd-claude-artifacts"`, `data-role="claude_artifacts"`, placeholder `e.g. claude`). Wire its read/write into the same Agents-tab save path the other rows use (no special-casing).

### 4. `src/services/TaskViewerProvider.ts` — public send entry point
Add `public async sendPromptToAgentTerminal(role: string, text: string): Promise<void>` that:
- Resolves the agent name for the role (e.g. `claude_artifacts` → "Claude Artifacts") via `_getAgentNameForRole` (`:6083`).
- Finds the terminal in `_registeredTerminals` (suffix + VS Code-name fallbacks, as in `_executeLocal`, `:15015`, and `_attemptDirectTerminalPush`, `:15556-15581`).
- If not found, spawns it via `vscode.window.createTerminal` (model on the constitution-builder fallback, `PlanningPanelProvider.ts:3756`), sends the startup command from `getAgentStartupCommand` (`:3654`), and waits for settle.
- Delivers via `sendRobustText(terminal, text, true, log)` (`terminalUtils.ts:93`) inside `withTerminalSendLock(normalizedName, …)` (`:22`).
- **CRITICAL — do NOT route through `_attemptDirectTerminalPush` (`:15547`):** that method runs a `/clear` before the prompt (`:15617-15634`, config `terminal.clearBeforePrompt` default `true`), which would wipe Claude's conversation context mid-session. Call `sendRobustText` directly. Add a code comment stating this reasoning so a future refactor doesn't "consolidate" it back through the dispatch path.

(Refactor `_executeLocal` to share the resolve/spawn helper if convenient — do not fork the logic. The resolve step is read-only and intentionally outside the send lock, matching `_attemptDirectTerminalPush`'s pattern at `:15589-15592`.)

### 5. `src/webview/planning.html` + `planning.js` — Send buttons
- In the HTML-tab round-trip controls (added by the round-trip plan), add `#btn-send-artifact-download` and `#btn-send-artifact-upload` beside the Copy buttons, labeled "⇨ Send to Claude".
- In planning.js, on click, build the same prompt (reuse `ARTIFACT_DOWNLOAD_PROMPT` / `ARTIFACT_UPLOAD_PROMPT` from the round-trip plan) and post `{ type: 'sendArtifactPromptToTerminal', prompt, kind }`.
- Add a confirmation handler (button flashes "Sent ✓") mirroring the `artifactPromptCopied` pattern.

### 6. `src/services/PlanningPanelProvider.ts` — message handler
In `_handleMessage` (`:1935`), add:
```ts
case 'sendArtifactPromptToTerminal': {
    await this._taskViewerProvider.sendPromptToAgentTerminal('claude_artifacts', msg.prompt || '');
    const targetPanel = isProject ? this._projectPanel : this._panel;
    targetPanel?.webview.postMessage({ type: 'artifactPromptSent', kind: msg.kind });
    break;
}
```
(`PlanningPanelProvider` already holds a `TaskViewerProvider` reference — declared at `:134`, assigned at `:168`, and already used by the constitution-builder cases at `:3751,3768,3791`. No construction change needed.)

## Verification Plan

### Automated Tests
- No automated tests run in this session (test suite is run separately by the user). No compilation step run in this session (project is pre-compiled / compilation-free for this session).

### Manual Verification
- **Roster:** Agents tab shows a "Claude Artifacts" row with editable command defaulting to `claude`; toggling visibility on adds its terminal to the grid; the command edit persists.
- **No ghost column:** The kanban board shows **no** "Claude Artifacts" column (verify against the `analyst` precedent — role registered, column absent from `DEFAULT_KANBAN_COLUMNS`).
- **Opt-in default:** A config with no `claude_artifacts` key behaves as visibility-off (no surprise terminal for existing users) — confirms the `defaults` map entry at `getVisibleAgents` (`TaskViewerProvider.ts:3688`) is present and effective.
- **Send (terminal already open):** With the Claude Artifacts terminal running, click "⇨ Send to Claude" on the download control → the prompt lands in that terminal and submits; Claude begins the `WebFetch`. Claude's prior conversation context is preserved (no `/clear`).
- **Send (terminal closed):** With it closed, clicking Send spawns `claude`, waits, then sends — no "terminal not found" warning.
- **Concurrency:** Rapid double-click / two sends queue via the per-terminal lock; no interleaved/corrupted input.
- **Fallback intact:** The Copy-prompt buttons still work for pasting elsewhere.

## Recommendation

Complexity is 6 (mixed: mostly routine wiring, with the visibility-default footgun and `/clear`-avoidance as two well-scoped risks). **Send to Coder.**

---

## Code Review (Reviewer Pass)

### Stage 1 — Grumpy Principal Engineer

> *"A terminal-only role with no kanban column, modeled on `analyst`. A visibility-default footgun that makes `undefined !== false` spawn a surprise terminal. A `/clear` trap that would nuke Claude's context. Three landmines, and the plan drew a map around each one. Let me see if the coder followed the map."*

**Finding #1 — MAJOR: Missing `/clear`-avoidance comment.**

`TaskViewerProvider.ts:2731-2739` (`sendPromptToAgentTerminal`) correctly calls `sendRobustText` directly, bypassing `_attemptDirectTerminalPush`. **But the plan explicitly required a code comment stating this reasoning** — quote: *"Add a code comment stating this reasoning so a future refactor doesn't 'consolidate' it back through the dispatch path."* The comment was absent. The codebase already has this exact pattern at `TaskViewerProvider.ts:10052` (`// NOTE: Do NOT use _attemptDirectTerminalPush here — it has clearBeforePrompt side effects...`), proving the convention exists. Without the comment, the very next "let's reduce duplication" refactor routes this through `_attemptDirectTerminalPush` and silently wipes Claude's conversation context on every artifact send. **The code works today; the comment is the load-bearing guard against tomorrow's refactor.**

> *"You dodged the landmine but left the map in your pocket. Someone else is going to step on it."*

**Finding #1b — MAJOR (user-identified): Original `/clear`-avoidance rationale was based on a false premise.**

The plan's stated reason for avoiding `/clear` was: *"For artifact sends this would wipe Claude's conversation context mid-session."* This assumes single-session continuity — but the round-trip workflow explicitly spans multiple sessions (download → edit with Gemini for hours/days → upload). The artifact prompts are **already self-contained**: the upload prompt carries the file path (`${folder}/${filename}`), the expected source URL (`${url}`), and instructs Claude to read the `switchboard-artifact-source:` marker from the file itself. The round-trip identity lives in the file, not in conversation history. So `/clear` would NOT break round-trip correctness — the prompt works from a blank slate. The real (weaker) rationale for avoiding `/clear` is that the Claude Artifacts terminal is a general-purpose helper terminal where the user may have unrelated ongoing conversation that shouldn't be nuked before every artifact send. **Fix applied** — the comment was reworded to state the correct rationale (UX preference for not clearing unrelated conversation, not round-trip correctness).

**Finding #2 — NIT: Unrelated changes bundled into the commit.**

The epic commit (`9a3705b`) includes a diagnostic `console.log` in `_refreshRunSheets` (`TaskViewerProvider.ts:14925`, marked "DIAGNOSTIC (temporary)"), a Jules polling early-return (`TaskViewerProvider.ts:17175`), and a `?? undefined` type fix (`TaskViewerProvider.ts:2974`). None of these are part of either plan. They're harmless but muddy the commit scope. Not fixing — out of plan scope.

**Everything else — verified correct:**

- **`allBuiltInAgents` entry** (`extension.ts:2670`): `{ name: 'Claude Artifacts', role: 'claude_artifacts' }` — exact match. Gated by `visibleAgents[builtIn.role] !== false` at `:2675`. **No ghost column** — `claude_artifacts` is absent from `DEFAULT_KANBAN_COLUMNS` (`agentConfig.ts:104-115`), matching the `analyst` precedent. Verified.
- **Visibility default** (`TaskViewerProvider.ts:3786`): `claude_artifacts: false` in the `defaults` map. Without this, `undefined !== false` at the grid gate would make the terminal visible by default. **Footgun defused.**
- **Startup command fallback** (`TaskViewerProvider.ts:3750-3754`): `claude_artifacts` → `'claude'` when blank, mirroring `jules_monitor` → `'jules'` at `:3739`. **No missing default.**
- **Agents tab roster row** (`kanban.html:2749-2750`): Checkbox with `data-role="claude_artifacts"`, label "Claude Artifacts", command input `id="agents-tab-cmd-claude-artifacts"` with `placeholder="e.g. claude"`. Uses the same `agents-tab-visible-toggle` class and `data-role` pattern as all other rows — automatically picked up by the save path (`kanban.html:3635-3640`) and load path (`kanban.html:6529-6534`). **No special-casing needed.**
- **`sendPromptToAgentTerminal`** (`TaskViewerProvider.ts:2688-2740`): Resolves agent name (with `claude_artifacts` → `'Claude Artifacts'` fallback at `:2693`), finds terminal in `_registeredTerminals` (suffix-aware at `:2698`), falls back to open VS Code terminals (`:2701-2704`), spawns via `createTerminal` if not found (`:2710-2726`), delivers via `sendRobustText(terminal, text, true)` inside `withTerminalSendLock` (`:2736-2739`). Resolve step is outside the send lock, matching `_attemptDirectTerminalPush`'s pattern. **Correct architecture.**
- **Send buttons** (`planning.html:3504,3506`): `#btn-send-artifact-download` and `#btn-send-artifact-upload`, both labeled "⇨ Send to Claude", beside their respective Copy buttons. **Augments, not replaces.**
- **Send handlers** (`planning.js:6950-6963,6976-6990`): Build the same prompt via `ARTIFACT_DOWNLOAD_PROMPT` / `ARTIFACT_UPLOAD_PROMPT` (reused from the round-trip plan), post `{ type: 'sendArtifactPromptToTerminal', prompt, kind, workspaceRoot }`. **No prompt duplication.**
- **Message handler** (`PlanningPanelProvider.ts:2789-2796`): `case 'sendArtifactPromptToTerminal'` calls `this._taskViewerProvider.sendPromptToAgentTerminal('claude_artifacts', msg.prompt || '', msg.workspaceRoot)` and posts `artifactPromptSent`. Uses the existing `_taskViewerProvider` reference. **No construction change.**
- **Sent confirmation** (`planning.js:4322-4331`): `case 'artifactPromptSent'` flashes the relevant Send button to `Sent ✓` for 2s. **No confirm dialog.**
- **No `BuiltInAgentRole` type entry needed:** `claude_artifacts` is used as a `string` role throughout (not typed to `BuiltInAgentRole`), matching the `mcp_monitor` and `jules` precedents which are also absent from the `BuiltInAgentRole` union. The role is terminal-only with no prompt customization, so absence from `BUILT_IN_AGENT_LABELS` (both TS and webview) is correct — it should not appear in the prompt-customization UI or kanban board sorting.

**Findings by severity:**
- **CRITICAL:** None.
- **MAJOR:** #1 — Missing `/clear`-avoidance code comment in `sendPromptToAgentTerminal` (`TaskViewerProvider.ts:2731`).
- **MAJOR:** #1b — Original `/clear`-avoidance rationale was based on a false premise (assumed single-session continuity; prompts are actually self-contained). Comment reworded with correct rationale.
- **NIT:** #2 — Unrelated diagnostic/polling/type-fix changes bundled into the epic commit (out of plan scope).

### Stage 2 — Balanced Synthesis

**Keep:** The entire implementation is architecturally sound. The `analyst`-modeled no-column role, the visibility-default footgun defusal, the startup-command fallback, the find-or-spawn terminal resolution, and the direct `sendRobustText` call (bypassing `_attemptDirectTerminalPush`) are all correct. The Send buttons augment the Copy buttons as specified. The prompts are self-contained (file path, URL, marker in file) — the round-trip correctly survives session breaks, `/clear`, reboots, and multi-day gaps.

**Fix now:** Finding #1 + #1b — the missing `/clear`-avoidance comment was added, then reworded after user review identified that the original rationale ("would wipe Claude's conversation context mid-session") was based on a false premise. The corrected comment states the real rationale: the prompts are self-contained so `/clear` wouldn't break correctness, but the Claude Artifacts terminal is a general-purpose helper where clearing unrelated conversation is undesirable UX.

**Defer:** Finding #2 — the bundled unrelated changes are out of plan scope and harmless to this feature's correctness. Noted for commit hygiene but not fixed here.

### Files Changed (Implementation)
- `src/extension.ts` — `{ name: 'Claude Artifacts', role: 'claude_artifacts' }` in `allBuiltInAgents`
- `src/services/TaskViewerProvider.ts` — `sendPromptToAgentTerminal` method, `claude_artifacts: false` visibility default, `claude_artifacts` → `'claude'` startup fallback
- `src/services/PlanningPanelProvider.ts` — `case 'sendArtifactPromptToTerminal'` message handler
- `src/webview/kanban.html` — Agents tab roster row (checkbox + command input)
- `src/webview/planning.html` — 2 "⇨ Send to Claude" buttons beside the Copy buttons
- `src/webview/planning.js` — 2 Send button listeners, `artifactPromptSent` confirmation handler

### Files Changed (Review Fix)
- `src/services/TaskViewerProvider.ts:2731-2738` — Added `/clear`-avoidance code comment in `sendPromptToAgentTerminal`, then reworded after user review to correct the rationale (prompts are self-contained; `/clear` avoidance is UX preference, not correctness requirement)

### Validation Results
- **Compilation:** Skipped per session policy (project is pre-compiled).
- **Tests:** Skipped per session policy (run separately by user).
- **Code review:** Complete — 1 MAJOR finding fixed (missing `/clear`-avoidance comment). All other plan requirements verified present and correct.

### Remaining Risks
- **Fixed-timer readiness:** The spawn path uses fixed `setTimeout` delays (2s shell init + 3s startup command settle) rather than a true readiness protocol. On slow machines or slow shell startups, `claude` may not be ready to receive input when the prompt is sent. The plan acknowledged this ("do not invent a new readiness protocol") and deferred to `sendRobustText`'s pacing. This is a pragmatic trade-off, not a bug — but it means the first send after a cold spawn may occasionally arrive before `claude`'s input prompt is ready.
- **Terminal closed between resolve and send:** The terminal lookup happens outside the send lock. If the terminal is closed between the lookup and the `sendRobustText` call, the send would fail. This is an inherent race in the find-then-send pattern shared with existing code (`_executeLocal`, `_attemptDirectTerminalPush`) — not a regression.
- **No `BuiltInAgentRole` type entry:** `claude_artifacts` is absent from the `BuiltInAgentRole` union and `BUILT_IN_AGENT_LABELS`. This is consistent with `mcp_monitor`/`jules` (also absent from the type) and correct for a terminal-only role with no prompt customization. If a future feature needs `claude_artifacts` in the prompt-customization UI or kanban sorting, the type/labels entries would need to be added at that time.
