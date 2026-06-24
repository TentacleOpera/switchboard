# MCP Monitor: Periodic Terminal Poller for claude.ai MCP Servers

## Goal

Let Switchboard poll the user's claude.ai MCP servers (Slack, ClickUp, etc.) on a sub-hourly interval *without* the user opening those external apps. Because claude.ai MCP tools only exist **inside a Claude session**, the extension cannot call them directly — instead it periodically dispatches a check prompt into a **dedicated, user-configured agent terminal** running a cheap or local model. The agent reads the MCP servers and reports anything noteworthy in that terminal pane. This runs **independently** of the board-automation engine and is coordinated as a **machine-global singleton**.

### Problem Analysis

The existing cloud `schedule` tool has a 1-hour minimum interval, and external-app checking is manual. Switchboard already owns all the machinery this needs — it just isn't wired for this purpose:

- **Timer + serialization + lifecycle**: the autoban engine in `TaskViewerProvider` (`_autobanTimers`, the serial `_autobanTickQueue`, the standalone safety-net `_autobanEmptyColumnSweepTimer` at `:320`).
- **Terminal dispatch**: `resolveTerminalByName()` (`extension.ts:354`) + `sendRobustText()` (`terminalUtils.ts:63`) — exactly how startup commands push text into a terminal.
- **Dedicated terminal with a chosen model**: agent **roles** with per-role **startup commands** (`GlobalIntegrationConfigService.getAgentStartupCommands`, `TaskViewerProvider.getAgentStartupCommand` at `:3444`). The `jules_monitor` role (`:3449`) is a direct precedent for a monitor-only role.
- **Machine-global config**: `GlobalIntegrationConfigService` (`~/.switchboard/integration-config.json`).

**Root cause of "where does it go":** the autoban tick handler `_autobanTickColumn` (`:7931`) is hardwired to kanban-column processing (collect cards, filter eligibility, complexity-route) — none of which applies to "ping a terminal." What's reusable is the *scaffolding around* it, not that handler. So the feature is a **new, independent background loop** (modeled on the empty-column sweep timer) that uses its **own dedicated serial queue** (`_mcpMonitorTickQueue`) — NOT the shared `_autobanTickQueue`, which `_stopAutobanEngine()` resets to `Promise.resolve()` at `:7927` and which would orphan an in-flight monitor tick on every autoban stop/restart. The monitor and autoban also dispatch to *different* terminals, so cross-serializing them buys nothing. The loop dispatches to a **dedicated `mcp_monitor` role terminal**.

## Metadata

**Tags:** feature, automation, mcp, terminal, ui
**Complexity:** 6

## User Review Required

None. The user-facing knobs (interval, watched sources, custom instruction) are all editable in the new AUTOMATION-tab config panel; the only code-locked choices are the curated `SOURCE_PRESETS` wording and the fixed read-only preamble, both trivially extendable. Decisions made (not hedged): the user selects *which sources to watch* (Slack/Gmail/Calendar/Custom) and the prompt is composed from those — not free-text authored; runs independently of the autoban enable/pause/reset controls; coordinated as a global singleton via terminal-presence; results surface in the monitor terminal pane only (notifications/kanban-cards are explicitly out of scope for this iteration).

## Complexity Audit

### Routine
- Add an optional `mcpMonitor` block to `GlobalConfig` + async/sync accessors on `GlobalIntegrationConfigService` (mirrors the existing `clickup`/`linear`/`ticketsAutoSync` accessor pattern).
- Register `mcp_monitor` as a known agent role so it gets a startup-command slot (mirror `jules_monitor` at `TaskViewerProvider.ts:3449`).
- Add a second dropdown (on/off) directly under the MODE selector in the AUTOMATION tab, plus a collapsible config block shown when "on".
- Add `KanbanProvider` message handlers + an `extension.ts` command, paralleling the existing autoban handlers.

### Complex / Risky
- **Independence from the autoban engine.** The loop must NOT be started/stopped by `_startAutobanEngine`/`_stopAutobanEngine`, and the existing pause/reset buttons must NOT touch it. It has its own timer field and its own on/off control. It uses its **own dedicated serial queue** (`_mcpMonitorTickQueue`) rather than borrowing `_autobanTickQueue` — because `_stopAutobanEngine()` resets `_autobanTickQueue = Promise.resolve()` at `:7927`, which would orphan an in-flight monitor tick on every autoban stop/restart. Since the monitor and autoban dispatch to *different* terminals, cross-serializing them is unnecessary anyway.
- **Global-singleton coordination without a lockfile.** claude.ai MCP servers are account-global; N open windows must not produce N duplicate Slack polls. Mechanism: **terminal presence is the election.** `mcp_monitor` is a singular dedicated role (like `jules_monitor`) — there is one such terminal, in one window. The loop fires only in the window where a *live* `mcp_monitor` terminal is resolvable; every other window's tick is a no-op. No lockfile, no pool, sidestepping the multi-process concerns in `state-json-protocol-is-fiction`.
- **Busy-terminal / overrun.** A check could still be running when the next tick fires. Mitigation: an **in-flight boolean guard** (`_mcpMonitorInFlight`) set true before `sendRobustText` and cleared in a `finally` — the tick skips if a prior check is still running. This is stronger than a pure timestamp debounce (a slow multi-tool MCP turn easily exceeds `intervalMs * 0.5`). A secondary timestamp debounce (`_mcpMonitorLastSendAt`) remains as a defense against rapid double-fire from config-change restarts. `sendRobustText` already flattens newlines so the multi-line prompt submits as one CLI turn.
- **Context accumulation is a feature, not a bug.** Because the same long-lived terminal receives every ping, the agent naturally remembers prior checks and can report only *what changed since last time*. The default prompt leans on this.

## Edge-Case & Dependency Audit

- **Race Conditions:** Monitor sends run on a **dedicated `_mcpMonitorTickQueue`** (NOT the shared `_autobanTickQueue`, which `_stopAutobanEngine()` resets at `:7927` — reusing it would orphan an in-flight monitor tick on every autoban stop/restart). The monitor and autoban target different terminals, so cross-serialization is unnecessary. Across windows, the terminal-presence guard ensures only one window dispatches.
- **Clipboard disruption (known, inherited):** `sendRobustText` routes payloads >100 chars through `pasteTextViaClipboard`, which saves/restores the user's clipboard around a ~1s paste window. The composed monitor prompt is multi-line and exceeds this threshold, so every tick briefly occupies the clipboard. This is the same mechanism autoban uses, but the monitor runs silently in the background while the user may be mid-paste elsewhere. Documented as a known edge case for this iteration; a custom sub-100-char or chunked-only send path is a possible future optimization, not a gate.
- **Dead / missing terminal:** If no live `mcp_monitor` terminal is resolvable, the tick no-ops silently (no spam). The AUTOMATION config panel surfaces a one-line status ("No monitor terminal running") so the user knows why nothing is happening — shown in the panel, not as a popup.
- **Token cost:** Each tick is a full agent turn with MCP tool calls — potentially expensive. This is the entire reason the target is a **dedicated terminal the user points at a cheap/local model** via its startup command. The panel notes this.
- **Security:** No new attack surface in the extension — it only sends a text prompt to a local terminal. The MCP access lives entirely in the user's own authenticated claude.ai session. The default prompt instructs the agent to **report only, take no actions**.
- **Migration:** New feature — no prior shipped state, so no migration of *its* data. BUT `~/.switchboard/integration-config.json` is a shipped, shared file: adding the optional `mcpMonitor` key must be **additive**. `loadGlobal`/`saveGlobal` already round-trip the whole object, preserving unknown/legacy keys, so a new optional field is safe. Last-write-wins across windows is acceptable for a rarely-written config; noted.

## Dependencies

None — self-contained. No other plan or session must complete first. The `mcp_monitor` role reuses the existing startup-command editor; no new Setup UI is strictly required (the role appears wherever roles are listed), though confirming the role surfaces there is part of verification.

## Adversarial Synthesis

Top risks: (1) **queue coupling to autoban** — reusing `_autobanTickQueue` would orphan in-flight monitor ticks when `_stopAutobanEngine()` resets it at `:7927`; mitigated by a dedicated `_mcpMonitorTickQueue` (the monitor and autoban target different terminals, so cross-serialization is unnecessary anyway). (2) **duplicate account polling across windows** — mitigated by the terminal-presence election; verified by opening two windows and confirming only the one with the monitor terminal dispatches. (3) **prompt sent to a busy terminal** — mitigated by an in-flight boolean guard (`_mcpMonitorInFlight`) plus a secondary timestamp debounce, and `sendRobustText`'s existing shell-ready pacing. (4) **monitor role accidentally receiving plan-execution dispatches** — mitigated by adding `mcp_monitor` to the monitor-only safety guard at `TaskViewerProvider.ts:15371` (mirroring `jules_monitor`). The feature adds an independent loop and a UI block; it does not modify the autoban tick path, so board automation behavior is unchanged.

## Proposed Changes

### `src/services/GlobalIntegrationConfigService.ts` — global config for the monitor
- **Context:** `GlobalConfig` (line 5) already holds `clickup`/`linear`/`ticketsAutoSync` and `agents.startupCommands`. Accessors follow a clear async + sync pattern (`getTicketsAutoSync`/`setTicketsAutoSync` at `:133`).
- **Logic:** Add an optional, additive block:
  ```ts
  mcpMonitor?: {
      enabled?: boolean;            // default false
      intervalMinutes?: number;     // default 5; clamped to >= 1
      targetRole?: string;          // default 'mcp_monitor'
      sources?: string[];           // selected source preset keys, e.g. ['slack','gmail']; default ['slack']
      customInstruction?: string;   // free text, composed in when 'custom' is among the selected sources
  };
  ```
  The user picks *which sources to watch* (Slack, Gmail, ClickUp, Linear, Calendar, Custom…), not a free-text prompt — the prompt is composed from these selections at dispatch (see "Prompt construction" below).
- **Implementation:**
  - Add the field to the `GlobalConfig` interface with a doc comment explaining it is machine-global because MCP servers are account-scoped, not repo-scoped.
  - Add `getMcpMonitorConfig(): Promise<Required<...>>` (async) and `getMcpMonitorConfigSync()` (sync, for activation-time start) that merge stored values over defaults so callers always get a complete object.
  - Add `setMcpMonitorConfig(cfg)` that loads, merges into `globalConfig.mcpMonitor`, and `saveGlobal()`s — preserving all other keys (matches `setTicketsAutoSync` at `:138`).
- **Edge Cases:** Missing file → defaults (`sources: ['slack']`). `intervalMinutes < 1` → clamp to 1. `sources` empty/unknown keys → builder skips unknowns; if nothing resolves, the panel shows a "no sources selected" hint and the tick no-ops. Unknown extra config keys preserved by the existing round-trip.

### Prompt construction — composed from selected sources, NOT via `agentPromptBuilder`
- **Context:** `agentPromptBuilder.ts` (`buildKanbanBatchPrompt`) is the canonical builder for **plan-dispatch** prompts. Every branch is organized around a `BatchPromptPlan[]` and terminates in `PLANS TO PROCESS: <planList>`, wrapped in role machinery (execution-authorization, `GIT_PROHIBITION_DIRECTIVE`, `FOCUS_DIRECTIVE`, subagent rules, working-dir resolution). Its header comment says all *kanban batch* paths must route through it.
- **Decision:** The monitor prompt does **NOT** route through `buildKanbanBatchPrompt` — no plan files, no working dir, no coder/lead/reviewer role; that machinery is irrelevant and injecting it would be actively wrong. The "must route through" rule applies to role/plan dispatch, not to this standalone read-only ping. Instead the monitor gets its **own small composer** that assembles the prompt from the user's selected source presets.
- **The composer — `buildMcpMonitorPrompt(cfg)`** (new, co-located with the loop in `TaskViewerProvider`, or a tiny sibling module):
  1. **Fixed preamble** (constant): "Check the following for anything new that needs my attention since your previous check. Report only what is new and noteworthy as a short bullet list. If nothing needs attention, reply 'All clear'. This is read-only — do NOT take any actions, send any messages, or modify anything."
  2. **Per-source lines** from a `SOURCE_PRESETS` map keyed by the `sources[]` values, each a short description of what "needs attention" means for that source. Set:
     - `slack` → "Slack: unread direct messages and @-mentions across my channels."
     - `gmail` → "Gmail: unread or important emails in my inbox."
     - `gcal` → "Google Calendar: events starting in the next 24 hours."
     - `custom` → emits `cfg.customInstruction` verbatim (skipped if blank).
  3. Join preamble + the selected source lines (as a bulleted list) + custom instruction, then `normalizeNewlines(...)`. Unknown keys in `sources[]` are skipped. If no source resolves to any text, return empty and the tick no-ops (panel shows "no sources selected").
- **Why a map, not free text:** the user selects *intent* ("watch Slack and Gmail"); the wording of each check stays curated and consistent, and new presets are added in one place. `SOURCE_PRESETS` is the single source of truth shared by the composer and consumed by the UI to render the checklist labels.
- **Presets are user intent, not live discovery.** The extension cannot enumerate which claude.ai MCP servers the terminal's session actually has. If a user selects a source whose server isn't connected, the agent simply reports it can't access it — acceptable, no pre-flight check needed.
- **Deliberate non-features:**
  - **No "since last check" / timestamp templating.** The dedicated terminal is long-lived, so the agent's own conversation history is the continuity — each ping means "what changed since I last looked." First ping of a fresh terminal just reports current state.
  - **No `resolveBaseInstructions` override layer.** Customization is the source checklist + the `custom` free-text entry; a second hidden-default override layer would be redundant.
- **Implementation note:** import `normalizeNewlines` from `agentPromptBuilder.ts` (the one reuse from that module) rather than reimplementing it.

### `src/services/TaskViewerProvider.ts` — the independent monitor loop
- **Context:** Engine state fields are declared around `:306–320`; `_autobanEmptyColumnSweepTimer` (`:320`) is a standalone `setInterval` independent of the per-column rule timers — the exact shape to copy. `_enqueueAutobanTick` (`:7862`) appends to the serial `_autobanTickQueue`. Role startup commands resolve via `getAgentStartupCommand` (`:3444`) / `jules_monitor` (`:3449`).
- **Logic:** A self-contained loop that, on each tick, resolves the target terminal in *this* window and (if present and not in-flight) enqueues a `sendRobustText` of the prompt onto the monitor's **own** serial queue.
- **Implementation:**
  - New fields near `:320`: `private _mcpMonitorTimer?: NodeJS.Timeout;`, `private _mcpMonitorTickQueue: Promise<void> = Promise.resolve();` (dedicated — NOT `_autobanTickQueue`, which `_stopAutobanEngine()` resets at `:7927`), `private _mcpMonitorLastSendAt = 0;`, and `private _mcpMonitorInFlight = false;`.
  - `private async _startMcpMonitorLoop()`:
    - Read `GlobalIntegrationConfigService.getMcpMonitorConfigSync()`. If `!enabled`, ensure stopped and return.
    - Clear any existing `_mcpMonitorTimer`.
    - Compute `intervalMs = Math.max(intervalMinutes, 1) * 60_000`.
    - Set `_mcpMonitorTimer = setInterval(() => this._enqueueMcpMonitorTick(), intervalMs)`. Do **not** fire an immediate tick on start (avoids a burst when the user toggles it on); first tick is one interval later.
  - `private _stopMcpMonitorLoop()`: clear and undefine `_mcpMonitorTimer`. Do NOT reset `_mcpMonitorTickQueue` here unless the provider is disposing (a running check should be allowed to finish; on `dispose()`, resetting is acceptable).
  - `private _enqueueMcpMonitorTick()`: append onto `_mcpMonitorTickQueue` (the monitor's own serial chain) a call to `_mcpMonitorTick()`. This serializes monitor ticks against each other without coupling to the autoban queue.
  - `private async _mcpMonitorTick()`:
    1. Re-read config (live interval/role/sources/customInstruction/enabled); if disabled, return.
    2. **Singleton guard / terminal election:** resolve the target terminal for `targetRole` in this window via `resolveTerminalByName(targetRole)` (or the role→terminal resolution used by autoban). If none is resolvable or it is not alive, **return silently** — another window (or none) owns the monitor.
    3. **In-flight guard:** if `this._mcpMonitorInFlight`, skip (a prior check is still running — a slow multi-tool MCP turn can exceed the interval). Set `this._mcpMonitorInFlight = true` before sending, clear it in a `finally`.
    4. **Secondary debounce:** if `Date.now() - _mcpMonitorLastSendAt < intervalMs * 0.5`, skip (guards against rapid double-fire from config-change restarts).
    5. `const prompt = buildMcpMonitorPrompt(cfg)`; if empty (no sources selected), return. Else `await sendRobustText(terminal, prompt)`; set `_mcpMonitorLastSendAt = Date.now()`.
  - **Lifecycle wiring:** call `_startMcpMonitorLoop()` once during TaskViewerProvider init (after config services are ready), and again from the config-change handler below. It is **never** called from `_startAutobanEngine`/`_stopAutobanEngine`, and `_stopMcpMonitorLoop`/reset is **never** called from `resetAutobanTimersFromKanban` or `setAutobanPausedFromKanban`.
  - `public async setMcpMonitorConfigFromKanban(cfg)`: validate/clamp, `GlobalIntegrationConfigService.setMcpMonitorConfig(cfg)`, then `_startMcpMonitorLoop()` (which restarts or stops based on the new `enabled`), then broadcast current config to the webview.
  - Add `_stopMcpMonitorLoop()` to the provider's `dispose()` so the timer is cleared on deactivation.
- **Default prompt (`DEFAULT_MCP_MONITOR_PROMPT`):**
  > "Check my claude.ai MCP servers (e.g. Slack, ClickUp) for anything new that needs my attention since your previous check — unread mentions or DMs, newly assigned tasks, replies awaiting me. Report only what is new and noteworthy as a short bullet list. If nothing needs attention, reply 'All clear'. Do not take any actions or send any messages — this is a read-only check."

### `src/webview/kanban.html` — on/off dropdown under the MODE selector
- **Context:** The MODE selector row is built at `:7273–7295` (`modeRow`), followed by `modeHelpText` (`:7302`) and `safetyNote` (`:7307`). The mode `<select>` styling is `autobanSelectStyle`. State is emitted via `postKanbanMessage`.
- **Logic:** Insert a **second dropdown row immediately after the mode row** (before `modeHelpText`), an on/off `<select>` labeled e.g. `MCP MONITOR:`. When set to "On", render a collapsible config block beneath it; when "Off", hide the block. This block is **not** gated by `currentAutomationMode` (it shows for all modes, since the monitor is independent).
- **Implementation:**
  - After `container.appendChild(modeRow)` (`:7295`), build `mcpMonitorRow` reusing `modeRow`'s flex styling and `autobanSelectStyle`; options `{value:'off',label:'Off'}` / `{value:'on',label:'On'}`, selected from the loaded monitor config's `enabled`.
  - Build `mcpMonitorConfig` (a `div`, `display:` toggled by the dropdown) containing:
    - **Interval** select (1 / 2 / 5 / 10 / 15 / 30 minutes), default from config.
    - **Sources** — a checklist (one checkbox per `SOURCE_PRESETS` entry: Slack, Gmail, Calendar, Custom), checked from `config.sources`. The checklist labels come from `SOURCE_PRESETS` so UI and composer never drift. Checking **Custom** reveals a small free-text input bound to `customInstruction`.
    - **Status line** — no terminal picker. The target is always the `mcp_monitor` role terminal (a singular dedicated role, like `jules_monitor`). Show: "Monitor terminal: running" when a live `mcp_monitor` terminal is resolvable, else "No monitor terminal running — launch one as the `mcp_monitor` role with a cheap/local model and permission-bypass flags (e.g. `--permission-mode dontAsk --allowedTools \"mcp__*\"`)."
    - A short help line: "On this interval, Switchboard asks your monitor terminal to check the selected sources via your claude.ai MCP servers and report anything new. Point the terminal at a cheap/local model and launch it with permission-bypass flags (e.g. `--permission-mode dontAsk --allowedTools \"mcp__*\"`) so checks run unattended — every check is a full agent turn, but interactive sessions stay on your flat subscription (no per-token headless billing)."
  - **No raw prompt textarea** — the prompt is composed from the source selections (matching the composer above). `SOURCE_PRESETS` keys/labels are exposed to the webview (e.g. injected as a JSON constant when the HTML is rendered, alongside the existing template substitutions) so the checklist stays in sync with the backend.
  - Wire `change`/`input` listeners that debounce (reuse the panel's existing interaction-guard pattern, `guardInteraction`) and `postKanbanMessage({ type: 'setMcpMonitorConfig', config: { enabled, intervalMinutes, sources, customInstruction } })`.
  - On panel render and on receiving `updateMcpMonitorConfig`, hydrate the controls from the broadcast config. Keep this independent of `currentAutomationMode` branching.
- **Edge Cases:** Switching board MODE must not reset or hide the monitor block. Antigravity-batch mode (which hides several autoban controls) must still show the monitor block.

### `src/services/KanbanProvider.ts` — message handlers
- **Context:** Autoban handlers are at `:4840–4868` (`setAutomationMode`, `updateAutobanConfig`, `resetAutobanTimers`, `setAutobanPaused`), each forwarding to a `TaskViewerProvider` method or executing a `switchboard.*` command.
- **Logic:** Add a `setMcpMonitorConfig` case that forwards to the new provider method, and ensure the current monitor config is pushed to the webview when the AUTOMATION panel renders.
- **Implementation:**
  - Add `case 'setMcpMonitorConfig':` → `await this._taskViewerProvider.setMcpMonitorConfigFromKanban(msg.config)` (or execute a `switchboard.setMcpMonitorConfigFromKanban` command, matching how the existing autoban cases dispatch).
  - Where the autoban state is broadcast to the webview (alongside `_postAutobanState`), also post `{ type: 'updateMcpMonitorConfig', config: <getMcpMonitorConfig()> }` so the dropdown hydrates on open.

### `src/extension.ts` — command registration + role
- **Context:** Autoban commands are registered at `:1207–1243`. Terminal resolution is `resolveTerminalByName` (`:354`). Role→startup-command fallback for monitor-style roles is at `TaskViewerProvider.ts:3449` (`jules_monitor`).
- **Logic:** Register the monitor config command and make `mcp_monitor` a recognized role.
- **Implementation:**
  - Register `switchboard.setMcpMonitorConfigFromKanban` → `taskViewerProvider.setMcpMonitorConfigFromKanban(...)` (only if the KanbanProvider dispatches via command rather than a direct call; otherwise skip).
  - Add `mcp_monitor` to the agent-role registry / known-roles list so it appears in the startup-command editor and can be launched as an agent terminal (mirror `jules_monitor`). Its startup command is where the user sets the cheap/local model AND the permission-bypass flags. **Required permission flags** (confirmed via research — see Uncertain Assumptions): an interactive Claude CLI session prompts for per-call tool approval unless launched with bypass flags, which would stall every background check at a "[Y/n]" gate. The recommended/example startup command is:
    ```
    claude --model claude-haiku-4-5 --permission-mode dontAsk --allowedTools "mcp__*"
    ```
    (`--dangerously-skip-permissions` is a broader alternative but bypasses ALL tool approval, not just MCP.) The role's help text / placeholder in the startup-command editor must note that the permission flags are required for unattended monitoring to work. A local-model or own-Slack-bot launcher is also valid as long as it lands in an interactive session with MCP access and auto-approved tools.
  - **Monitor-only safety guard:** add `mcp_monitor` to the execute-dispatch block at `TaskViewerProvider.ts:15371` (alongside `jules_monitor`) so a column-config mishap can never dispatch a plan-execution prompt into the read-only monitor terminal. Mirror the existing `jules_monitor` branch: `clearDispatchLock()`, show a warning, post `actionTriggered` failure, `return false`.

## Uncertain Assumptions

Research was run to confirm the feature's external premises. Findings below — the core premise **holds for interactive terminal mode** (which is what this plan uses), but introduced one new implementation requirement (tool-approval flags).

- **Claude CLI terminal sessions can access the user's claude.ai MCP servers — CONFIRMED for interactive mode.** Research confirms claude.ai connectors (Slack, Gmail, Calendar, ClickUp, Linear) are account-scoped and sync to interactive Claude CLI sessions after `/login`. No local `.mcp.json` configuration is needed for these cloud connectors. **Critical caveat:** this ONLY works in **interactive** terminal sessions — headless `claude -p` / `--print` invocations fail to load `mcp__claude_ai_*` cloud tools (confirmed bug, GitHub issues #36833 / #37805). The plan's mechanism (`sendRobustText` pasting into a live interactive terminal) is consistent with the interactive requirement — do NOT switch to a headless/SDK dispatch path or the connectors vanish.
- **MCP connections persist across CLI session restarts — CONFIRMED.** OAuth tokens are cloud-managed by Anthropic and persist across launches/restarts until the user explicitly `/logout`s or the provider revokes the token. The long-lived-terminal continuity model is sound.
- **Billing — interactive sessions stay on flat subscription (CONFIRMED, favorable).** Anthropic's June 15, 2026 billing split isolates only headless/SDK/programmatic usage into a separate monthly credit pool. Interactive terminal sessions (what this plan uses) remain covered under the user's flat Pro/Max subscription. The sub-hourly polling cost concern that would have killed a headless approach does NOT apply here. Document this in the panel help text so users know the interactive-terminal choice is what keeps it affordable.
- **Tool-approval prompts — NEW REQUIREMENT (was unverified, now confirmed).** In an interactive Claude CLI session, each MCP tool call triggers a per-call permission approval prompt ("Allow Slack tool? [Y/n]") unless the session was launched with permission-bypass flags. Without these flags, every pasted check prompt stalls at an approval gate — breaking the silent-background model. The startup command for the `mcp_monitor` role MUST include permission flags. Recommended default example: `claude --model claude-haiku-4-5 --permission-mode dontAsk --allowedTools "mcp__*"` (or `--dangerously-skip-permissions` as a broader alternative). The plan's panel help text and the role's default/example startup command must surface this requirement so the user knows to include the flags. See the updated `extension.ts` section below.

All code-level claims (line numbers, function signatures, queue-reset behavior, role-guard precedent, `sendRobustText` clipboard threshold, `resolveTerminalByName` window-scoping) were verified against the current source.

## Verification Plan

### Automated Tests
If the repo has unit coverage for `GlobalIntegrationConfigService`, add tests for: defaults when `mcpMonitor` absent; merge-over-defaults; `intervalMinutes` clamp to ≥1; round-trip preserves unrelated keys (`clickup`, `agents.startupCommands`). Otherwise, manual verification governs (the loop logic depends on VS Code terminal APIs not easily unit-tested).

### Manual Verification
- [ ] AUTOMATION tab shows an on/off "MCP MONITOR" dropdown directly under the MODE selector, in **all three** modes (single-column, multi-column, antigravity-batch).
- [ ] Setting it to "On" reveals the interval select, the source checklist (Slack/Gmail/Calendar/Custom), and the terminal status line; "Off" hides them. State persists across panel re-renders and VS Code reloads (config is global).
- [ ] Checking "Custom" reveals a free-text field; its text appears in the composed prompt. Unchecking hides it and drops it from the prompt.
- [ ] Selecting Slack + Gmail produces a prompt that asks the agent to check exactly those two sources (verify by inspecting what lands in the monitor terminal).
- [ ] Launch a terminal as the `mcp_monitor` role with a startup command that includes permission-bypass flags (e.g. `claude --model claude-haiku-4-5 --permission-mode dontAsk --allowedTools "mcp__*"`). With the monitor "On" at a 1-minute interval, confirm the check prompt is dispatched into *that* terminal ~1 minute later, and again each interval — and that MCP tool calls execute WITHOUT a per-call "[Y/n]" approval prompt (confirming the permission flags took effect).
- [ ] The dispatched agent reports MCP findings (or "All clear") in the terminal pane and takes no actions.
- [ ] **Independence:** turn board automation (autoban) OFF — the monitor keeps ticking. Press the autoban Pause and Reset buttons — the monitor is unaffected.
- [ ] **Singleton:** open the same machine in two VS Code windows; with one `mcp_monitor` terminal in window A only, confirm only window A dispatches (window B no-ops).
- [ ] No monitor terminal running → no dispatch, no popup; the panel shows the "No monitor terminal running" hint.
- [ ] Changing the interval in the panel takes effect on the next cycle without requiring a reload.
- [ ] Changing the selected sources persists and changes the composed prompt on the next cycle.
- [ ] `~/.switchboard/integration-config.json` gains an `mcpMonitor` block and retains existing `clickup`/`linear`/`agents` keys after toggling.
- [ ] `npm run compile` succeeds (only when producing a VSIX; not required for src-based testing).

## Recommendation

**Complexity: 6 → Send to Coder.** The work is majority-routine (config accessor, UI dropdown, message handler, role registration) with two well-scoped moderate risks (the dedicated-queue independence invariant and the in-flight overrun guard). The adversarial review added four surgical refinements — dedicated `_mcpMonitorTickQueue`, in-flight boolean guard, `mcp_monitor` monitor-only dispatch guard, and a corrected line reference — none of which expand the product scope. A coder can execute this plan directly; no lead-level architectural decisions remain open.

## Post-Implementation Review (Reviewer Pass)

### Files Changed by Reviewer
- `src/webview/kanban.html` — Added missing `break;` statement at line 6514 before `case 'updateMcpMonitorConfig':` (was falling through from `case 'startupCommands':`, clobbering `isMcpMonitorTerminalRunning` to `false` on every agent-config message).

### Findings

| Severity | Finding | File:Line | Status |
|----------|---------|-----------|--------|
| CRITICAL | Missing `break` in `startupCommands` switch case → fall-through into `updateMcpMonitorConfig` resets `isMcpMonitorTerminalRunning` to `false` and triggers spurious `renderAutobanPanel()` on every agent-config message | `src/webview/kanban.html:6513` | **FIXED** — added `break;` |
| NIT | `_isMcpMonitorTerminalRunning(targetRole)` and `_mcpMonitorTick()` accept `targetRole`/`cfg.targetRole` but hardcode `'MCP Monitor'` for terminal resolution. Works via normalization equivalence (`_normalizeAgentKey('MCP Monitor')` === `_normalizeAgentKey('mcp_monitor')`) but parameter is misleading dead weight | `src/services/TaskViewerProvider.ts:19084,19158` | Deferred — UI doesn't expose `targetRole`; safe |
| NIT | Source checklist checkbox labels render full `SOURCE_PRESETS` descriptions (e.g. "Slack: unread direct messages and @-mentions across my channels.") instead of short names ("Slack") | `src/webview/kanban.html:7410` | Deferred — cosmetic; consistent with plan's "labels come from SOURCE_PRESETS" requirement |

### Verification Results
- **Independence invariant verified:** `_stopAutobanEngine()` (line 8001-8015) resets `_autobanTickQueue` but NOT `_mcpMonitorTickQueue`. `_startMcpMonitorLoop`/`_stopMcpMonitorLoop` are never called from autoban start/stop/pause/reset handlers. `dispose()` correctly calls `_stopMcpMonitorLoop()`.
- **Monitor-only safety guard verified:** `mcp_monitor` added to the dispatch block at `TaskViewerProvider.ts:15469` alongside `jules_monitor` — prevents plan-execution dispatches into the read-only monitor terminal.
- **Config accessor verified:** `GlobalIntegrationConfigService` correctly clamps `intervalMinutes` to ≥1, merges over defaults, preserves unknown keys via round-trip. Both sync and async accessors present.
- **Prompt composer verified:** `_buildMcpMonitorPrompt` correctly composes from `SOURCE_PRESETS`, skips unknown keys, returns empty string when no sources resolve, uses `normalizeNewlines` from `agentPromptBuilder.ts`.
- **UI placement verified:** MCP Monitor row is inserted after `modeRow` and before `modeHelpText`, not gated by `currentAutomationMode` — shows in all three modes.
- **Role registration verified:** `mcp_monitor` added to agent grid with display name "MCP Monitor", visibility toggle in `sharedDefaults.js`, startup-command fallback with permission-bypass flags at `TaskViewerProvider.ts:3520`.
- **Compilation/tests:** Skipped per session instructions.

### Remaining Risks
1. **`targetRole` hardcoded** — if a user manually edits `~/.switchboard/integration-config.json` to set a custom `targetRole`, the terminal resolution won't follow (hardcoded `'MCP Monitor'`). Low risk since the field is not UI-exposed.
2. **Clipboard disruption** — inherited from `sendRobustText` for prompts >100 chars; documented as known edge case in plan. No fix in this iteration.
3. **Full-preset checkbox labels** — cosmetic UX issue; checkboxes show long descriptions rather than short names. Defer to a future polish pass.
