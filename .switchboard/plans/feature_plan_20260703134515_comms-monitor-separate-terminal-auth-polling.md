# Comms Monitor: Separate Terminal Creation, Auth Check, and Polling Start

## Goal

The Comms Monitor currently conflates three distinct steps into a single "Launch" action: (1) creating the terminal, (2) sending the `claude` startup command, and (3) starting the polling loop. This creates an authentication problem: if the user is not authenticated with Claude (or hasn't configured their MCP servers), the polling loop starts immediately and every tick sends a prompt whose tool calls fail with auth errors — burning tokens on failures the user can't see or recover from.

This plan separates the flow into three distinct, user-controlled buttons:
1. **Start Terminal** — creates the terminal and sends the `claude` startup command. Does NOT start polling.
2. **Check Authentication** — sends a real MCP test prompt to the terminal (e.g. "List your connected MCP servers and their available tools") so the user can see in the terminal whether Claude is authenticated and MCP servers are reachable. This is a **diagnostic only** — no confirmation gate, no blocking. The user looks at the terminal output and decides whether things are working.
3. **Start Polling** — starts the periodic polling loop. Available whenever a terminal is running — no auth gate. If auth is broken, the user sees errors in the terminal and clicks "Stop Polling" themselves.

### Problem Analysis & Root Cause

**Symptom:** The user clicks "Launch Monitor Terminal". A terminal opens, `claude` starts, and the polling loop immediately begins sending prompts. If the user hasn't authenticated Claude (no API key, expired session) or hasn't configured MCP servers (no Slack/Gmail/Calendar connectors), every prompt's tool calls fail silently in the terminal. The user sees the monitor "running" but getting errors, with no way to diagnose or control the flow.

**Root cause (confirmed by code reading against current `src/`):** `launchMcpMonitorTerminal` (`TaskViewerProvider.ts:20604`) creates and reveals the terminal, then sends the startup command:
1. Creates the terminal via `vscode.window.createTerminal` (line 20631)
2. Waits for shell readiness and sends the startup command via `terminal.sendText(cmd.trim(), true)` (line 20671)
3. Pushes status to the kanban via `_postMcpMonitorConfig()` (line 20675)

> **Accuracy correction (2026-07-03 improve-plan pass):** In the *current* checked-in code, `launchMcpMonitorTerminal` does **NOT** call `_startMcpMonitorLoop()` and does **NOT** schedule any first prompt — no `_scheduleMcpMonitorFirstPrompt` symbol exists in `TaskViewerProvider.ts` yet. Those are additions expected from companion plans ("first-prompt-after-startup", "apply-source-changes-immediately"). Today the loop is started in two places: (a) on activation at `TaskViewerProvider.ts:487` (`void this._startMcpMonitorLoop();`) and (b) in `setMcpMonitorConfigFromKanban` at `TaskViewerProvider.ts:20575` (called when the config panel saves). Both currently gate on `cfg.enabled`. So the "polling auto-starts on launch" symptom is only literally true once the companion plans land; without them, polling starts when the user toggles the on/off dropdown to "on" (which sets `enabled: true`). This plan still holds — it decouples the loop gate from `enabled` — but the "removes loop-start from launch" step is only meaningful in combination with the companion plans that add it.

There is no separation between "terminal exists" and "polling is active." The `enabled` config flag (`McpMonitorConfig.enabled`, `GlobalIntegrationConfigService.ts:40`) is the only control, and it's a single boolean that gates both the config panel visibility (`kanban.html:7615`/`7623`) and the loop (`_startMcpMonitorLoop` at `TaskViewerProvider.ts:20482`, guard at line 20484). Setting `enabled: true` starts the loop regardless of whether the terminal is live or authenticated.

**The auth gap:** `_mcpMonitorTick` (`TaskViewerProvider.ts:20512`, `enabled` guard at line 20514) reads config, finds the terminal, builds the prompt (`_buildMcpMonitorPrompt` at line 20552), and calls `sendRobustText`. It never checks whether Claude is actually authenticated or whether MCP servers are configured. If Claude returns an auth error, the terminal shows it, but the extension has no visibility — it just keeps sending prompts every interval. The user has to manually look at the terminal, realize the errors, and figure out what's wrong. And because polling auto-started, the errors are already happening before the user has a chance to verify their setup.

## Metadata

- **Tags:** authentication, ux, feature, frontend, backend, reliability
  <!-- Tags constrained to the allowed improve-plan set. Domain descriptors that
       are NOT valid tags but describe this work: comms-monitor, mcp-monitor,
       terminal, polling, lifecycle. -->
- **Complexity:** 5
- **Project:** switchboard
- **Repo:** (root — no bare sub-repo)
- **Files touched:** `src/services/TaskViewerProvider.ts`, `src/services/GlobalIntegrationConfigService.ts`, `src/services/KanbanProvider.ts`, `src/webview/kanban.html`, `src/extension.ts`

## User Review Required

- **Tag semantics — `enabled` becomes "panel visibility only".** This plan repurposes the shipped `enabled` flag from "controls the loop" to "controls config-panel visibility", and introduces `pollingEnabled` as the new loop gate. Confirm this split is acceptable rather than, e.g., renaming `enabled` outright (renaming would break every reader that persists it — see companion "rename-display-labels" scope). The additive approach preserves all existing keys.
- **Backward-compat default for existing `enabled: true` installs (~4,000 installs).** The read shim maps `pollingEnabled ?? enabled ?? false`, so existing users who had the monitor "on" will have polling auto-resume after upgrade. Confirm this is the desired behavior vs. defaulting everyone to "polling stopped" on upgrade (which would be a visible behavior change but arguably safer given the whole point of the feature is to stop unattended polling). **This default choice is the single most user-visible decision in the plan and must be signed off.**
- **`lastCheckAt` field is out of scope.** The Proposed Changes below thread a `lastCheckAt?: string` field through the config get/set paths, but no such field exists in the current `McpMonitorConfig` (`GlobalIntegrationConfigService.ts:39-45`) and this feature does not require it. Treat it as **Clarification only** — either drop it from the diff or split it into a separate plan. It is retained in the code snippets below for continuity but flagged here as not-required.
- **No confirmation dialogs** — per repo rule, all three buttons act immediately. Confirmed in design (auth check is a non-blocking diagnostic).

## Complexity Audit

### Routine
- Additive config field `pollingEnabled` with a backward-compat read fallback — reuses the existing `getMcpMonitorConfig` / `setMcpMonitorConfig` `?? current.X` pattern verbatim.
- New `checkMcpMonitorAuth` / `startMcpMonitorPolling` / `stopMcpMonitorPolling` methods mirror the existing `launchMcpMonitorTerminal` / `setMcpMonitorConfigFromKanban` shape (terminal lookup via `_normalizeAgentKey` + `_stripIdeSuffix`, `sendRobustText`, `_postMcpMonitorConfig`).
- Command registration in `extension.ts` and message routing in `KanbanProvider.ts` follow the established `launchMcpMonitorTerminal` pattern one-for-one.
- Three-button webview panel reuses the existing button/`guardInteraction` idioms already in `kanban.html`.

### Complex / Risky
- **Shared-symbol contention.** `_startMcpMonitorLoop` (20482) and `_mcpMonitorTick` (20512) are rewritten by BOTH this plan (gate flip `enabled`→`pollingEnabled`) and the sibling "per-source-intervals" plan (GCD multi-timer rewrite). Whoever lands second must reconcile, not clobber. HIGH conflict.
- **Semantic repurposing of a shipped flag.** `enabled` changes meaning (loop gate → panel visibility). Any sibling that still reads `enabled` as "is the monitor running" ("first-prompt", "apply-source-changes-immediately") will misbehave until updated.
- **One-shot first-prompt ownership.** This plan asserts the 30s one-shot must fire from `startMcpMonitorPolling`, but the "first-prompt-after-startup" sibling schedules it inside `launchMcpMonitorTerminal`. Direct contradiction — see Dependencies.
- **Backward-compat behavior change** for the install base (auto-resume polling on upgrade).

**Moderate overall.** The change separates one combined action into three independent buttons and adds a new `pollingEnabled` config field. No `authConfirmed` field or confirmation gate — the auth check is a pure diagnostic that sends a test prompt, and the user decides when to start polling. This is simpler than a gated wizard flow.

The individual changes:
- Config schema: add `pollingEnabled` (additive, backward-compatible read mapping from legacy `enabled`).
- Backend: split `launchMcpMonitorTerminal` (remove polling start — only meaningful once companion plans add it), add `checkMcpMonitorAuth` (send test prompt), add `startMcpMonitorPolling` / `stopMcpMonitorPolling`.
- UI: replace the single Launch button with three buttons (Start Terminal, Check Auth, Start/Stop Polling), shown conditionally based on terminal state and polling state.

**Risk:** Low-to-moderate. The `pollingEnabled` field is additive with a backward-compat read fallback (`pollingEnabled ?? enabled ?? false`), so existing installs with `enabled: true` continue polling automatically. The auth check is non-blocking — it just sends text to the terminal, same as a normal tick. The residual risk is entirely in the shared-symbol overlap with sibling plans (see Dependencies).

## Edge-Case & Dependency Audit

### Race Conditions
- **Activation-time loop vs. terminal existence.** After the gate flips to `pollingEnabled`, the activation-time `_startMcpMonitorLoop()` (`TaskViewerProvider.ts:487`) will start the interval on startup for any backward-compat `enabled: true` install (mapped to `pollingEnabled: true`). `_mcpMonitorTick` (20512) already guards on "no live terminal → return", plus an in-flight guard (`_mcpMonitorInFlight`) and a `_mcpMonitorLastSendAt` debounce, so a tick with no terminal is a safe no-op. No new race introduced, but document that polling can be "active" before a terminal exists.
- **`setMcpMonitorConfigFromKanban` still calls `_startMcpMonitorLoop()`** (line 20575). After the gate flip, toggling the on/off dropdown ("on" → `enabled: true`, panel visibility) re-invokes the loop, which now re-checks `pollingEnabled` and correctly does nothing unless polling was separately started. Verify the dropdown no longer implicitly starts polling.
- **Double start.** Rapid clicks of "Start Polling" call `startMcpMonitorPolling` twice; `_startMcpMonitorLoop` clears any existing `_mcpMonitorTimer` before setting a new one (20488-20490), so no timer leak. The webview does not currently disable the Start Polling button on click (unlike Start Terminal) — consider disabling to avoid a duplicate first-prompt schedule.

### Security
- The auth-check prompt is built from user-controlled `sources` and `customInstruction` and injected into the terminal via `sendRobustText`, identical to the existing tick prompt path (`_buildMcpMonitorPrompt`). No new injection surface beyond what already ships. The diagnostic is explicitly read-only in intent but, unlike `_buildMcpMonitorPrompt`, the new `_buildMcpMonitorAuthPrompt` does NOT include the "do NOT take any actions" preamble — consider adding it so the auth check stays strictly diagnostic.

### Side Effects
- **Backward compatibility — existing `enabled: true` installs:** Existing users have `enabled: true` in their config. After this plan, `pollingEnabled` controls the loop. The `getMcpMonitorConfig` read path maps `enabled: true` → `pollingEnabled: true` for configs that don't have the new field. This is a read-time compat shim, not a file migration.
- **Terminal killed between steps:** If the user creates the terminal (step 1) but kills it before starting polling (step 3), the polling button disappears (the terminal-close handler from the companion plan pushes updated status). If polling was active, the loop stops (companion plan's `handleTerminalClosed` calls `_stopMcpMonitorLoop`).
- **Auth check when no terminal exists:** The "Check Authentication" button is only visible when a terminal is running. If the user somehow triggers it without a terminal, the backend method returns early (no terminal found).
- **Auth check while polling is active:** The user can click "Check Authentication" while polling is running — it just sends an additional test prompt to the terminal. The polling loop continues unaffected. This is fine — it's a diagnostic.
- **Auth expires mid-polling:** The user authenticates, starts polling, but the Claude session expires hours later. Tool calls start failing. The polling loop continues (it doesn't know auth failed). The user sees errors in the terminal, clicks "Stop Polling," re-authenticates in the terminal, and clicks "Start Polling" again. This is the expected recovery flow.
- **MCP server not configured (vs. Claude auth failure):** The auth check prompt asks Claude to check authentication status for each MCP server and explain how to authenticate if needed. If MCP servers aren't configured, Claude will report no servers connected. If servers are configured but not authenticated (e.g. Slack OAuth not completed), Claude will explain how to authenticate. Both cases are visible to the user in the terminal output, with actionable guidance from Claude.
- **Re-start polling after stop:** After stopping polling (but keeping the terminal), the user can restart polling without re-creating the terminal or re-checking auth. The "Start Polling" button is available whenever a live terminal exists.
- **No `confirm()` dialogs.** All buttons act immediately.

### Dependencies & Conflicts
This plan is the **central, highest-conflict** member of its 10-plan epic. It touches the same symbols as several siblings. Conflicts are documented here and in `## Dependencies` for the epic orchestrator to sequence — **do not resolve them unilaterally in this plan.**

- **`enabled` → `pollingEnabled` gate flip (HIGH conflict).** Siblings "first-prompt-after-startup" and "apply-source-changes-immediately" gate behavior on `cfg.enabled`. Once this plan makes `enabled` mean "panel visibility only", those siblings must be updated to read `pollingEnabled` for "is the loop running", or they will fire against the wrong flag. This plan does NOT edit those siblings.
- **`_startMcpMonitorLoop` (20482) + `_mcpMonitorTick` (20512) shared rewrite (HIGH conflict).** Sibling "per-source-intervals" also rewrites both methods to a GCD-based multi-timer keyed per source and builds on `pollingEnabled`. This plan only flips the single-`intervalMinutes` gate from `enabled` to `pollingEnabled`. Heavy overlap — the two rewrites must be merged into one reconciled implementation (gate = `pollingEnabled`, timer = per-source GCD), landed once, not applied twice.
- **One-shot first-prompt ownership (DIRECT contradiction).** "first-prompt-after-startup" schedules a 30s one-shot inside `launchMcpMonitorTerminal`. THIS plan asserts the one-shot must move to `startMcpMonitorPolling` (so polling-start, not terminal-creation, triggers the first prompt). These cannot both hold — the epic must pick where the one-shot lives. This plan's position: it belongs in `startMcpMonitorPolling`.
- **Status-line UI shared surface.** The monitor status line in `kanban.html` (current terminal-status/launch block around lines 7709-7730) is also modified by "stuck-running-status-and-stop-control" (adds a Stop button / running-status indicator) and relocated wholesale by "dedicated-tab" (moves the UI into a new COMMS tab). This plan replaces the single Launch button with a three-button panel. All three plans edit the same DOM region — merge, don't overwrite. This plan's UI should target whatever container the monitor ends up in after "dedicated-tab".
- **`remove-dontask-permission-mode`** — no known symbol overlap; independent.
- **Companion plan interactions (behavioral):**
  - The "Stop Monitor" button plan adds a stop control that kills the terminal. This plan adds "Stop Polling" (stops the loop, keeps the terminal). They're different actions and both should coexist.
  - The 30s one-shot first prompt plan starts polling after launch. After this plan, the one-shot should only fire after the user clicks "Start Polling," not after terminal creation.
  - The dedicated COMMS tab plan moves the UI. This plan's UI changes target whatever tab the monitor lives in.

## Dependencies

- `sess_epic_comms_monitor — parent epic (10 subtasks)` — this plan must be sequenced against its siblings; it is the shared-state hub.
- `sess_first_prompt_after_startup — one-shot ownership` — contradiction on where the 30s one-shot lives (launch vs. start-polling). Must be reconciled.
- `sess_apply_source_changes_immediately — enabled gate` — reads `enabled` as loop control; must migrate to `pollingEnabled`.
- `sess_per_source_intervals — loop rewrite` — GCD multi-timer rewrite of `_startMcpMonitorLoop`/`_mcpMonitorTick`; heaviest overlap, build on `pollingEnabled`.
- `sess_stuck_running_status_and_stop_control — status-line UI` — shares the status-line DOM region (adds Stop button).
- `sess_dedicated_tab — UI relocation` — moves the monitor UI into a COMMS tab; this plan's buttons must follow.
- `sess_rename_display_labels — label copy` — may rename the monitor's user-facing labels; keep button text in sync.

> Session IDs above are placeholders for the sibling plan identities; the epic orchestrator should substitute the real `sess_` IDs when sequencing. Recorded here per the required `sess_XXX — <topic>` format.

## Adversarial Synthesis

**Risk Summary:** Key risks — (1) two siblings ("per-source-intervals" and this plan) independently rewrite `_startMcpMonitorLoop`/`_mcpMonitorTick`, and a naive second-lands-wins merge silently drops one gate or timer; (2) repurposing the shipped `enabled` flag will break any sibling still reading it as "loop running" until they migrate to `pollingEnabled`; (3) the backward-compat default auto-resumes polling for ~4,000 existing `enabled: true` installs, a user-visible behavior change. Mitigations — land the loop rewrite once as a reconciled implementation (gate `pollingEnabled` + per-source GCD timer), migrate all `enabled`-readers in the same epic pass, and get explicit sign-off on the auto-resume default. The auth check itself is low-risk (non-blocking terminal send).

## Proposed Changes

### 1. `src/services/GlobalIntegrationConfigService.ts` — add `pollingEnabled` field

**Verified anchors (current code):** the `mcpMonitor?` block is at lines **15-21**, `McpMonitorConfig` at **39-45**, `DEFAULT_MCP_MONITOR_CONFIG` at **47-53**, `getMcpMonitorConfigSync` at **221** (return **224-231**), `getMcpMonitorConfig` at **233** (return **236-242**), `setMcpMonitorConfig` at **245** (write **248-254**).

> **Note (lastCheckAt is out of scope):** the current `mcpMonitor?` block and `McpMonitorConfig` have NO `lastCheckAt` field. The snippets below add one, but it is **not required** for this feature (see User Review Required). Drop it or split it out unless a sibling needs it.

Extend the `mcpMonitor?` block (line 15) and `McpMonitorConfig` (line 39):

```ts
    mcpMonitor?: {
        enabled?: boolean;          // controls config panel visibility (on/off dropdown)
        pollingEnabled?: boolean;   // NEW: whether the periodic polling loop is active
        intervalMinutes?: number;
        targetRole?: string;
        sources?: string[];
        customInstruction?: string;
        lastCheckAt?: string;       // OUT OF SCOPE — see note above
    };
```

```ts
export interface McpMonitorConfig {
    enabled: boolean;              // config panel visibility
    pollingEnabled: boolean;       // NEW: loop active
    intervalMinutes: number;
    targetRole: string;
    sources: string[];
    customInstruction: string;
    lastCheckAt?: string;          // OUT OF SCOPE — see note above
}
```

Also add `pollingEnabled: false` to `DEFAULT_MCP_MONITOR_CONFIG` (lines 47-53) so the default object satisfies the non-optional interface field.

In `getMcpMonitorConfig` (line 233) and `getMcpMonitorConfigSync` (line 221), add backward-compat mapping:

```ts
        return {
            enabled: cfg.enabled ?? (cfg.pollingEnabled ?? false),
            pollingEnabled: cfg.pollingEnabled ?? cfg.enabled ?? false,  // fall back to legacy enabled
            intervalMinutes: Math.max(cfg.intervalMinutes ?? DEFAULT_MCP_MONITOR_CONFIG.intervalMinutes, 1),
            targetRole: cfg.targetRole ?? DEFAULT_MCP_MONITOR_CONFIG.targetRole,
            sources: cfg.sources ?? DEFAULT_MCP_MONITOR_CONFIG.sources,
            customInstruction: cfg.customInstruction ?? DEFAULT_MCP_MONITOR_CONFIG.customInstruction,
            lastCheckAt: cfg.lastCheckAt,
        };
```

In `setMcpMonitorConfig` (line 245), write the new field through:

```ts
        globalConfig.mcpMonitor = {
            enabled: config.enabled ?? current.enabled ?? DEFAULT_MCP_MONITOR_CONFIG.enabled,
            pollingEnabled: config.pollingEnabled ?? current.pollingEnabled ?? current.enabled ?? false,
            intervalMinutes: Math.max(config.intervalMinutes ?? current.intervalMinutes ?? DEFAULT_MCP_MONITOR_CONFIG.intervalMinutes, 1),
            targetRole: config.targetRole ?? current.targetRole ?? DEFAULT_MCP_MONITOR_CONFIG.targetRole,
            sources: config.sources ?? current.sources ?? DEFAULT_MCP_MONITOR_CONFIG.sources,
            customInstruction: config.customInstruction ?? current.customInstruction ?? DEFAULT_MCP_MONITOR_CONFIG.customInstruction,
            lastCheckAt: config.lastCheckAt ?? current.lastCheckAt,
        };
```

### 2. `src/services/TaskViewerProvider.ts` — gate the loop on `pollingEnabled` instead of `enabled`

**Verified anchor:** `_startMcpMonitorLoop` is at **line 20482** (the current guard `if (!cfg.enabled)` is at line 20484; single `intervalMinutes` computed at line 20491). `_mcpMonitorTick`'s guard `if (!cfg.enabled) return;` is at **line 20514** and must ALSO be flipped to `pollingEnabled` (the plan below only shows `_startMcpMonitorLoop`; the tick guard is the second half of the gate flip). **Conflict:** the sibling "per-source-intervals" rewrites this same method — merge, do not clobber.

In `_startMcpMonitorLoop` (line 20482), check `pollingEnabled`:

```ts
    private async _startMcpMonitorLoop() {
        const cfg = await GlobalIntegrationConfigService.getMcpMonitorConfig();
        if (!cfg.pollingEnabled) {
            this._stopMcpMonitorLoop();
            return;
        }
        if (this._mcpMonitorTimer) {
            clearInterval(this._mcpMonitorTimer);
        }
        const intervalMs = Math.max(cfg.intervalMinutes, 1) * 60 * 1000;
        this._mcpMonitorTimer = setInterval(() => this._enqueueMcpMonitorTick(), intervalMs);
    }
```

### 3. `src/services/TaskViewerProvider.ts` — remove polling start from `launchMcpMonitorTerminal`

**Verified anchor:** `launchMcpMonitorTerminal` is at **line 20604** (spans ~20604-20676). It creates the terminal (`createTerminal` at 20631), sends the startup command (`terminal.sendText(cmd.trim(), true)` at 20671), and already ends by calling `await this._postMcpMonitorConfig();` at 20675.

> **Accuracy note:** In the *current* code this method does **NOT** call `_startMcpMonitorLoop()` and there is **no** `_scheduleMcpMonitorFirstPrompt` symbol anywhere in the file. So this step is a **guard against companion plans re-introducing loop-start here** rather than a removal of existing code. If "first-prompt-after-startup" or "apply-source-changes-immediately" land first and add those calls, remove them from this method. If this plan lands first, the step is a no-op plus a comment marking the boundary.

Ensure `launchMcpMonitorTerminal` does NOT start polling:

```ts
    public async launchMcpMonitorTerminal(): Promise<void> {
        // ... existing terminal creation + startup command code (lines 20605-20672) ...
        // DO NOT call _startMcpMonitorLoop() here.
        // DO NOT call _scheduleMcpMonitorFirstPrompt() here (companion-plan symbol).

        // Push updated status to kanban (already present at line 20675)
        await this._postMcpMonitorConfig();
    }
```

### 4. `src/services/TaskViewerProvider.ts` — add `checkMcpMonitorAuth` method

Sends a real MCP diagnostic prompt to the terminal so the user can see whether Claude is authenticated and MCP servers are connected:

```ts
    /**
     * Send a diagnostic prompt to the monitor terminal that tests whether Claude
     * is authenticated and MCP servers are connected. The user reads the terminal
     * output to determine if things are working. This is non-blocking — it just
     * sends text to the terminal, same as a normal tick.
     */
    public async checkMcpMonitorAuth(): Promise<boolean> {
        const targetName = 'MCP Monitor';
        const strippedTarget = this._normalizeAgentKey(this._stripIdeSuffix(targetName));
        const terminal = vscode.window.terminals.find(t => {
            const tName = this._normalizeAgentKey(this._stripIdeSuffix(t.name));
            return tName === strippedTarget && t.exitStatus === undefined;
        });
        if (!terminal) {
            return false;
        }
        const cfg = await GlobalIntegrationConfigService.getMcpMonitorConfig();
        const testPrompt = this._buildMcpMonitorAuthPrompt(cfg);
        await sendRobustText(terminal, testPrompt, true);
        return true;
    }

    /**
     * Build the auth-check prompt from the user's selected sources. Lists the
     * specific MCP servers Claude should check so the response covers exactly
     * the services the monitor is configured to use.
     */
    private _buildMcpMonitorAuthPrompt(cfg: McpMonitorConfig): string {
        const sources = cfg.sources || [];
        const sourceNames: string[] = [];
        for (const src of sources) {
            if (src === 'custom') {
                if (cfg.customInstruction && cfg.customInstruction.trim()) {
                    sourceNames.push(cfg.customInstruction.trim());
                }
            } else if (src === 'slack') {
                sourceNames.push('Slack');
            } else if (src === 'gmail') {
                sourceNames.push('Gmail');
            } else if (src === 'gcal') {
                sourceNames.push('Google Calendar');
            }
        }
        if (sourceNames.length === 0) {
            return 'Am I authenticated to use MCP servers? Check each connected MCP server and report its authentication status. If any are not authenticated, explain how I can authenticate.';
        }
        const list = sourceNames.map(n => `- ${n}`).join('\n');
        return `Am I authenticated to use these MCP servers?\n${list}\n\nCheck each one and report its authentication status. If any are not authenticated, explain how I can authenticate.`;
    }
```

### 5. `src/services/TaskViewerProvider.ts` — add `startMcpMonitorPolling` and `stopMcpMonitorPolling` methods

```ts
    /**
     * Start the periodic polling loop. Available whenever a terminal is running.
     * No auth gate — the user is responsible for verifying auth before starting.
     */
    public async startMcpMonitorPolling(): Promise<void> {
        await GlobalIntegrationConfigService.setMcpMonitorConfig({ pollingEnabled: true });
        await this._startMcpMonitorLoop();
        // Schedule the first prompt (30s one-shot from companion plan)
        this._scheduleMcpMonitorFirstPrompt();
        await this._postMcpMonitorConfig();
    }

    /**
     * Stop the polling loop but keep the terminal alive.
     */
    public async stopMcpMonitorPolling(): Promise<void> {
        await GlobalIntegrationConfigService.setMcpMonitorConfig({ pollingEnabled: false });
        this._stopMcpMonitorLoop();
        await this._postMcpMonitorConfig();
    }
```

### 6. `src/extension.ts` — register the new commands

Near line 1335 (where `launchMcpMonitorTerminal` is registered):

```ts
    const checkMcpMonitorAuthDisposable = vscode.commands.registerCommand('switchboard.checkMcpMonitorAuth', async () => {
        return taskViewerProvider.checkMcpMonitorAuth();
    });
    context.subscriptions.push(checkMcpMonitorAuthDisposable);

    const startMcpMonitorPollingDisposable = vscode.commands.registerCommand('switchboard.startMcpMonitorPolling', async () => {
        await taskViewerProvider.startMcpMonitorPolling();
    });
    context.subscriptions.push(startMcpMonitorPollingDisposable);

    const stopMcpMonitorPollingDisposable = vscode.commands.registerCommand('switchboard.stopMcpMonitorPolling', async () => {
        await taskViewerProvider.stopMcpMonitorPolling();
    });
    context.subscriptions.push(stopMcpMonitorPollingDisposable);
```

### 7. `src/services/KanbanProvider.ts` — add message handlers

Near line 5752 (where `launchMcpMonitorTerminal` is handled):

```ts
            case 'checkMcpMonitorAuth': {
                await vscode.commands.executeCommand('switchboard.checkMcpMonitorAuth');
                break;
            }
            case 'startMcpMonitorPolling': {
                await vscode.commands.executeCommand('switchboard.startMcpMonitorPolling');
                break;
            }
            case 'stopMcpMonitorPolling': {
                await vscode.commands.executeCommand('switchboard.stopMcpMonitorPolling');
                break;
            }
```

### 8. `src/webview/kanban.html` — add `pollingEnabled` to webview state

Near line 6139:

```js
        let mcpMonitorConfig = { enabled: false, pollingEnabled: false, intervalMinutes: 5, targetRole: 'mcp_monitor', sources: ['slack'], customInstruction: '' };
```

The `updateMcpMonitorConfig` handler (line 6803) already replaces config wholesale (`mcpMonitorConfig = msg.config`), so the new field flows through automatically.

### 9. `src/webview/kanban.html` — replace the status line with three-button control panel

Replace the status line (lines 7880-7898) with a three-button flow. No wizard gating — the buttons are shown conditionally based on terminal and polling state, but there's no auth-confirmation gate:

```js
            // Status & Controls — three independent buttons
            const controlsContainer = document.createElement('div');
            controlsContainer.style.cssText = 'margin-top:8px; padding-top:6px; border-top:1px dashed var(--border-color); font-size:9px; line-height:1.3;';

            // Terminal status + Start Terminal button
            const termStatus = document.createElement('div');
            termStatus.style.cssText = 'margin-bottom:6px;';
            if (isMcpMonitorTerminalRunning) {
                termStatus.innerHTML = '🟢 <strong>Terminal:</strong> running';
            } else {
                termStatus.innerHTML = '🔴 <strong>Terminal:</strong> not started';
                const startTermBtn = document.createElement('button');
                startTermBtn.textContent = 'Start Terminal';
                startTermBtn.style.cssText = 'display:block; margin-top:4px; padding:4px 10px; font-family:var(--font-mono); font-size:10px; cursor:pointer; background:var(--accent-teal); color:var(--bg-primary); border:none; border-radius:3px;';
                guardInteraction(startTermBtn);
                startTermBtn.addEventListener('click', () => {
                    startTermBtn.disabled = true;
                    startTermBtn.textContent = 'Starting…';
                    postKanbanMessage({ type: 'launchMcpMonitorTerminal' });
                });
                termStatus.appendChild(startTermBtn);
            }
            controlsContainer.appendChild(termStatus);

            // Check Authentication button (only if terminal is running)
            if (isMcpMonitorTerminalRunning) {
                const authRow = document.createElement('div');
                authRow.style.cssText = 'margin-bottom:6px;';
                const authLabel = document.createElement('div');
                authLabel.innerHTML = '🔐 <strong>Authentication Check</strong>';
                authRow.appendChild(authLabel);

                const checkAuthBtn = document.createElement('button');
                checkAuthBtn.textContent = 'Check Authentication';
                checkAuthBtn.style.cssText = 'display:block; margin-top:4px; padding:4px 10px; font-family:var(--font-mono); font-size:10px; cursor:pointer; background:var(--panel-bg2); border:1px solid var(--border-color); color:var(--text-primary); border-radius:3px;';
                guardInteraction(checkAuthBtn);
                checkAuthBtn.addEventListener('click', () => {
                    checkAuthBtn.disabled = true;
                    checkAuthBtn.textContent = 'Check sent — see terminal…';
                    postKanbanMessage({ type: 'checkMcpMonitorAuth' });
                    // Re-enable after 3s so the user can retry
                    setTimeout(() => {
                        checkAuthBtn.disabled = false;
                        checkAuthBtn.textContent = 'Check Authentication';
                    }, 3000);
                });
                authRow.appendChild(checkAuthBtn);

                const authHelp = document.createElement('div');
                authHelp.style.cssText = 'margin-top:4px; font-size:8px; color:var(--text-secondary); line-height:1.3;';
                authHelp.textContent = 'Sends a prompt asking Claude to check authentication status for each MCP server and explain how to authenticate if needed. Check the terminal output — if servers are authenticated, you\'re good to start polling. If not, follow the instructions Claude provides to authenticate, then retry.';
                authRow.appendChild(authHelp);

                controlsContainer.appendChild(authRow);

                // Polling controls (only if terminal is running)
                const pollingRow = document.createElement('div');
                if (mcpMonitorConfig.pollingEnabled) {
                    pollingRow.innerHTML = '✅ <strong>Polling:</strong> active';
                    const stopPollingBtn = document.createElement('button');
                    stopPollingBtn.textContent = '⏸ Stop Polling';
                    stopPollingBtn.style.cssText = 'display:block; margin-top:4px; padding:4px 10px; font-family:var(--font-mono); font-size:10px; cursor:pointer; background:var(--panel-bg2); border:1px solid var(--border-color); color:var(--text-primary); border-radius:3px;';
                    guardInteraction(stopPollingBtn);
                    stopPollingBtn.addEventListener('click', () => {
                        postKanbanMessage({ type: 'stopMcpMonitorPolling' });
                    });
                    pollingRow.appendChild(stopPollingBtn);
                } else {
                    pollingRow.innerHTML = '⬜ <strong>Polling:</strong> stopped';
                    const startPollingBtn = document.createElement('button');
                    startPollingBtn.textContent = '▶ Start Polling';
                    startPollingBtn.style.cssText = 'display:block; margin-top:4px; padding:4px 10px; font-family:var(--font-mono); font-size:10px; cursor:pointer; background:var(--accent-teal); color:var(--bg-primary); border:none; border-radius:3px;';
                    guardInteraction(startPollingBtn);
                    startPollingBtn.addEventListener('click', () => {
                        postKanbanMessage({ type: 'startMcpMonitorPolling' });
                    });
                    pollingRow.appendChild(startPollingBtn);
                }
                controlsContainer.appendChild(pollingRow);
            }

            mcpConfigPanel.appendChild(controlsContainer);
```

### 10. `src/webview/kanban.html` — update the on/off dropdown semantics

The existing on/off dropdown (line 7778) sets `enabled`, which now controls only panel visibility (not the loop). The `saveMonitorConfig` function (line 7906) should not change `pollingEnabled` — that's controlled by the Start/Stop Polling buttons:

```js
            const saveMonitorConfig = () => {
                const enabled = mcpSelect.value === 'on';  // panel visibility only
                const intervalMinutes = parseInt(intervalSelect.value, 10);
                const customInstruction = customInstructionTextarea.value;
                const sources = Array.from(activeSources);
                mcpMonitorConfig = { ...mcpMonitorConfig, enabled, intervalMinutes, sources, customInstruction };
                postKanbanMessage({
                    type: 'setMcpMonitorConfig',
                    config: {
                        enabled,           // panel visibility
                        intervalMinutes,   // polling interval (used when polling starts)
                        sources,
                        customInstruction
                        // pollingEnabled is preserved on the backend (setMcpMonitorConfig uses ?? current.X)
                    }
                });
            };
```

## Verification Plan

1. **Build:** `npm run compile` succeeds with no type errors.
2. **Manual — three-button flow:**
   - Enable the monitor (on/off dropdown → "on"). Config panel appears.
   - Confirm the status shows "🔴 Terminal: not started" + "Start Terminal" button. No auth or polling buttons visible.
   - Click "Start Terminal". Terminal opens, `claude` starts. Status updates to "🟢 Terminal: running". Auth check and polling buttons appear.
   - Confirm NO polling has started (no prompt sent, no interval timer running).
3. **Manual — auth check (diagnostic):**
   - Click "Check Authentication". Confirm the terminal receives a prompt listing the specific selected sources, e.g.: "Am I authenticated to use these MCP servers?\n- Slack\n- Gmail\n\nCheck each one and report its authentication status. If any are not authenticated, explain how I can authenticate."
   - Look at the terminal output. If Claude is authenticated and MCP servers are configured, Claude reports auth status as OK. If not, Claude explains how to authenticate — follow those steps, then retry.
   - Confirm the button re-enables after 3 seconds (can retry).
4. **Manual — start polling:**
   - Click "▶ Start Polling". Confirm the polling loop starts (30s one-shot fires, then interval begins). Status updates to "✅ Polling: active" + "⏸ Stop Polling" button.
5. **Manual — stop polling (keeps terminal):**
   - Click "⏸ Stop Polling". Confirm the interval stops (no more prompts). Status updates to "⬜ Polling: stopped" + "▶ Start Polling" button. The terminal is still alive.
   - Click "▶ Start Polling" again. Confirm polling resumes without re-creating the terminal.
6. **Manual — auth check while polling:**
   - Start polling. Click "Check Authentication". Confirm the test prompt is sent alongside the polling prompts — no conflict, no crash. Polling continues.
7. **Manual — terminal killed resets the flow:**
   - Start the terminal, start polling. Kill the terminal manually.
   - Confirm the status resets: "🔴 Terminal: not started" + "Start Terminal" button. Auth and polling buttons disappear. Polling stops (companion plan's `handleTerminalClosed` calls `_stopMcpMonitorLoop`).
8. **Manual — backward compat (existing `enabled: true`):**
   - On an install with existing `mcpMonitor.enabled: true` (no `pollingEnabled` field), open the COMMS tab.
   - Confirm the config panel is visible (enabled maps to panel visibility).
   - Confirm `pollingEnabled` is read as `true` (falls back to `enabled`), so polling shows as active if a terminal is running. Existing users aren't disrupted.
9. **Regression:** The on/off dropdown still controls config panel visibility. Source checkboxes, interval, and custom instruction still save correctly. The `setMcpMonitorConfig` backend handler preserves `pollingEnabled` when it's not specified in the partial config.
