# Comms Monitor: Highlight Claude Dependency and Haiku Model in UI

## Goal

The Comms Monitor (formerly MCP Monitor) depends on the `claude` CLI being installed and configured with MCP servers (Slack, Gmail, Google Calendar connectors). The current AUTOMATION tab UI does not communicate this dependency — a user without Claude installed or without MCP servers configured will launch the monitor terminal, see it fail silently, and not understand why. Additionally, the monitor uses the Haiku model to minimize token costs (the fallback startup command at `TaskViewerProvider.ts:3901` already specifies `--model claude-haiku-4-5`), but the UI never tells the user this, so they may override the startup command with a more expensive model without realizing the cost implications.

This plan adds:
1. A **dependency notice** in the AUTOMATION tab that explicitly states the Claude + MCP server requirement, with a quick checklist of what's needed.
2. A **model indicator** that shows which model the monitor will use (Haiku by default), with a note about cost savings.
3. A **warning** if the user has overridden the startup command with a non-Haiku model, so they understand the cost tradeoff.

### Problem Analysis & Root Cause

**Symptom 1 (hidden dependency):** The user enables the Comms Monitor, clicks "Launch", and the terminal opens. If `claude` is not installed, the terminal shows a shell error (`command not found: claude`) but the AUTOMATION tab still says "🟢 running". If Claude is installed but no MCP servers are configured, Claude starts but the prompt fails when it tries to call `mcp__slack__*` tools. In both cases the user has no idea what went wrong or what prerequisites they're missing.

**Root cause 1:** The UI (`kanban.html:7622-7780`, panel created at 7622, appended to container at ~7780) renders the monitor config panel with source checkboxes, interval, and a launch button — but zero prerequisite information. The help text at line 7729 (`mcpHelp`) mentions "via your claude.ai MCP servers" in passing, but doesn't frame it as a hard dependency or tell the user how to set it up. There's no check for whether `claude` is on the PATH or whether MCP servers are configured.

**Symptom 2 (hidden model / cost):** The fallback startup command (`TaskViewerProvider.ts:3901`) is `claude --model claude-haiku-4-5 --permission-mode dontAsk --allowedTools "mcp__*"`. This already uses Haiku — good. But the user can override this via the agent startup command config (`getAgentStartupCommand`, line 3889), and if they set a custom command without `--model claude-haiku-4-5`, they silently switch to the default (more expensive) model. The UI gives no indication of which model is in use or why Haiku was chosen.

**Root cause 2:** The startup command is resolved in the backend (`getAgentStartupCommand`, line 3889) and sent to the terminal, but the resolved command is never surfaced to the UI. The webview has no visibility into which model flag is present.

> **Line-anchor note (verified 2026-07-03 against current `src/`):** All references in this plan were re-verified against live code. Anchors that drifted since authoring: `_postMcpMonitorConfig` is at **20579** (was 20487); the `mcp_monitor` fallback command is at **3901** (was 3892); `getAgentStartupCommand` is at **3889** (was 3880); the `updateMcpMonitorConfig` webview handler is at **6732** (was 6803); `mcpConfigPanel` is created at **7622** (was 7797); webview state vars (`mcpMonitorConfig`, `mcpMonitorPresets`) are declared at **6078–6080** (was ~6139); `mcpHelp` help text is at **7729** (was 7903). Symbols are stable; treat line numbers as approximate and search by symbol.

## Metadata

- **Tags:** ux, ui, frontend, feature, cli
- **Complexity:** 4
- **Project:** switchboard
- **Repo:** switchboard (main extension repo — no bare sub-repo)
- **Files touched:** `src/services/TaskViewerProvider.ts`, `src/webview/kanban.html`
  - _Note: `src/services/KanbanProvider.ts` was listed originally but requires **no change** — `_postMcpMonitorConfig` already fans the message out to both `this._view` and `this._kanbanProvider` via `postMessage`, so the new `resolvedStartupCommand` field reaches the kanban webview automatically. Retained here for traceability; do not edit KanbanProvider._
  - _Domain tags dropped from the tag line (comms-monitor, mcp-monitor, claude, haiku, cost, dependency) are not in the allowed tag vocabulary; the subject matter is preserved in the Goal. Tags normalized to the allowed set only._

## User Review Required

- **Copy review:** The dependency-notice text and the model-indicator cost note are user-facing. Confirm the wording (especially the `npm i -g @anthropic-ai/claude-code` install hint and "via Claude's MCP config") matches how the product documents Claude setup elsewhere.
- **Design placement:** Three new blocks (prerequisites notice, model indicator, collapsible resolved command) are prepended to a compact panel. Confirm the panel does not become too tall / dominate the AUTOMATION tab; the notice is intentionally small (font-size 9px). Adjust if it crowds the interval and sources controls.
- **Model-detection heuristic:** Detection is a case-insensitive substring match (`haiku`/`sonnet`/`opus`/`claude`) on the resolved command string. Confirm this is acceptable vs. parsing the `--model` flag value precisely (see adversarial critique — a source path or custom instruction containing "opus" could theoretically false-positive, but the string checked is the *resolved startup command*, not user prose).

## Complexity Audit

**Routine-to-moderate.** The change involves: (a) a backend method to resolve and return the startup command string to the webview (so the UI can display the model), (b) a static dependency-notice block in the HTML, and (c) a client-side model-detection check on the command string. No data migrations, no schema changes. The model detection is a simple string check (`--model claude-haiku` or `--model haiku` in the command). The Claude-installed check is best done client-side by attempting to detect the binary — but since the webview is sandboxed, the backend should expose a "prerequisites check" result.

**Design decision — don't over-engineer the prerequisite check:** A full "is claude installed + are MCP servers configured" check would require shelling out to `claude --version` and inspecting `~/.claude/mcp.json` or similar. This is fragile and varies by Claude version. Instead, this plan adds a **static notice** (always visible) that tells the user what's needed, plus a **model indicator** derived from the resolved startup command. A future plan can add a live prerequisite check if the static notice proves insufficient.

### Routine

- Adding one field (`resolvedStartupCommand`) to an existing `_postMcpMonitorConfig` message payload — reuses the established config-push pattern.
- Storing the field in webview state alongside existing `mcpMonitorConfig` / `mcpMonitorPresets` variables.
- Three additive, static/derived DOM blocks in `kanban.html` following the existing `document.createElement` + inline-style + `appendChild` pattern already used throughout the panel.
- Pure string-substring model detection — no async, no new dependencies, no schema/state migration.

### Complex / Risky

- **Shared message surface:** `_postMcpMonitorConfig` is consumed by two webviews (`this._view` and `this._kanbanProvider`). The added field must be backward-compatible (it is — handlers ignore unknown fields), but the message shape is a coordination point across the epic.
- **Shared fallback-command string:** this plan *reads and displays* the `mcp_monitor` fallback command at `TaskViewerProvider.ts:3901`, which sibling plan **remove-dontask-permission-mode** *edits*. The exact-string assertion in Verification step 3 is coupled to that string (see Adversarial Synthesis and Dependencies).

## Edge-Case & Dependency Audit

### Race Conditions
- **Config push during panel interaction:** The `updateMcpMonitorConfig` handler (line 6732) guards re-render with `if (!isAutobanPanelInteracting)`. A `resolvedStartupCommand` that arrives while the user is interacting will be stored in state but not rendered until the next non-interacting render — acceptable, since the model indicator is derived at render time from the stored value. Store the field *unconditionally* (like `mcpMonitorConfig`), not inside the interaction guard.
- **First render before backend push:** The kanban webview may render the panel before the initial `_postMcpMonitorConfig` arrives (the `postMcpMonitorConfig` wrapper exists precisely because the initial push is a no-op when the panel isn't ready). `mcpMonitorResolvedCmd` must default to `''`, and `detectModel('')` must return a safe "Unknown" state — it does.

### Security
- No new attack surface. `resolvedStartupCommand` is inserted via `pre.textContent` / template innerHTML built from a backend-controlled config string, not arbitrary user HTML. **Caution:** the model-indicator block uses `innerHTML` with `${modelInfo.name}` and `${modelNote}` — these are derived from a fixed set of literals in `detectModel`, NOT from the raw command, so no injection. Do **not** interpolate `mcpMonitorResolvedCmd` into `innerHTML`; the collapsible `cmdPre` correctly uses `textContent`. Keep it that way.

### Side Effects
- The `_postMcpMonitorConfig` message now carries an extra field on every push. Both consumers (main view + kanban) receive it; neither breaks on the extra field.
- No terminal/behavior change — the resolved command is only *displayed*, never re-executed differently. The command the monitor actually launches with is still resolved independently in `launchMcpMonitorTerminal` (line ~20659), which calls the same `getAgentStartupCommand('mcp_monitor')`, so display and launch stay consistent.

### Dependencies & Conflicts
- **Sibling `remove-dontask-permission-mode`** edits the same fallback string at `TaskViewerProvider.ts:3901` (removing `--permission-mode dontAsk`). This plan reads/displays that string. Functional detection is unaffected (it only greps for `haiku`/`sonnet`/`opus`), but Verification step 3's exact-string assertion must be updated to whatever the reconciled fallback string is. **Coordinate at epic level.**
- Per-plan edge cases (original, preserved):

- **Startup command not yet resolved:** `getAgentStartupCommand` is async (reads config). The webview needs the resolved command to display the model. The backend should push it as part of the `_postMcpMonitorConfig` message (which already sends config to the webview). Add a `resolvedStartupCommand` field to that message.
- **Custom startup command with no model flag:** If the user's custom command is `claude` (no `--model`), the model indicator should say "Default model (not Haiku — higher cost)" rather than assuming Haiku. The fallback command has Haiku; a custom override may not.
- **Custom startup command with a different Haiku variant:** `--model claude-haiku-4-5`, `--model haiku`, `--model claude-3-5-haiku` should all be detected as "Haiku". Use a substring match for `haiku` (case-insensitive) in the command string.
- **Custom startup command with Sonnet/Opus:** Detect `sonnet` or `opus` in the command and show a cost warning.
- **Command is not `claude` at all:** If the user configures a completely different binary (e.g. `my-custom-agent`), the model detection should say "Custom command (model unknown)".
- **Dependency notice always visible:** The notice is static text, not conditional on any check. This is intentional — it's always relevant when the monitor is enabled. It should be compact so it doesn't dominate the panel.
- **No `confirm()` dialogs.** The cost warning is informational text, not a blocking dialog.

## Dependencies

- No hard blocking `sess_` dependency. This plan is self-contained and additive.
- **Soft coordination (same epic):** `sess_remove_dontask_perm — remove-dontask-permission-mode` edits the `mcp_monitor` fallback command string this plan displays. Land order does not matter for correctness, but Verification step 3's exact-string expectation depends on the final fallback string. If both land, reconcile the asserted string once.

## Adversarial Synthesis

**Risk Summary:** Key risks: (1) the Verification step-3 exact-string assertion is brittle and collides with sibling `remove-dontask-permission-mode`, which rewrites the same fallback command; (2) the model heuristic is a substring match that could mislabel exotic custom commands; (3) three stacked notices could crowd the compact panel. Mitigations: assert on model *detection* (presence of `haiku`) rather than the full literal command; keep detection substring-based but scoped to the resolved command only; keep blocks compact (9px) and coordinate the fallback string at epic level.

## Proposed Changes

### 1. `src/services/TaskViewerProvider.ts` — include resolved startup command in the config push

In `_postMcpMonitorConfig` (line 20579), add the resolved startup command to the message. Note the live method does NOT currently declare `resolvedStartupCommand` — add both the `await this.getAgentStartupCommand('mcp_monitor')` line and the message field:

```ts
    private async _postMcpMonitorConfig() {
        const config = await GlobalIntegrationConfigService.getMcpMonitorConfig();
        const isMonitorRunning = this._isMcpMonitorTerminalRunning(config.targetRole);
        const resolvedStartupCommand = await this.getAgentStartupCommand('mcp_monitor');
        const message = {
            type: 'updateMcpMonitorConfig',
            config,
            isMonitorRunning,
            presets: TaskViewerProvider.SOURCE_PRESETS,
            resolvedStartupCommand   // NEW
        };
        this._view?.webview.postMessage(message);
        this._kanbanProvider?.postMessage(message);
    }
```

### 2. `src/webview/kanban.html` — store the resolved command in webview state

In the `updateMcpMonitorConfig` message handler (line 6732), store the resolved command. The live handler also sets `isMcpMonitorTerminalRunning` — insert the new line without removing that:

```js
                  mcpMonitorConfig = msg.config || mcpMonitorConfig;
                  isMcpMonitorTerminalRunning = !!msg.isMonitorRunning;
                  mcpMonitorPresets = msg.presets || mcpMonitorPresets;
                  mcpMonitorResolvedCmd = msg.resolvedStartupCommand || '';   // NEW — store unconditionally, outside the interaction guard
```

Add the variable declaration near line 6078–6080, alongside `mcpMonitorConfig` and `mcpMonitorPresets`:

```js
        let mcpMonitorResolvedCmd = '';
```

### 3. `src/webview/kanban.html` — add the dependency notice block

Insert the notice at the top of the config panel (after `mcpConfigPanel` is created at line 7622, before the interval row is appended at line 7643). This is always visible when the panel is shown:

```js
            // Dependency Notice
            const depNotice = document.createElement('div');
            depNotice.style.cssText = 'padding:6px 8px; margin-bottom:8px; border:1px solid var(--accent-teal-dim); border-radius:4px; background:color-mix(in srgb, var(--accent-teal) 6%, transparent); font-size:9px; line-height:1.4; color:var(--text-primary);';
            depNotice.innerHTML = `
                <strong>📋 Prerequisites:</strong><br>
                This monitor requires the <code style="color:var(--accent-teal);">claude</code> CLI with MCP servers configured for the sources you want to watch.<br>
                <span style="color:var(--text-secondary);">• Install Claude: <code>npm i -g @anthropic-ai/claude-code</code></span><br>
                <span style="color:var(--text-secondary);">• Add MCP servers (Slack, Gmail, Calendar) via Claude's MCP config</span><br>
                <span style="color:var(--text-secondary);">• The monitor runs in a dedicated terminal using these servers</span>
            `;
            mcpConfigPanel.appendChild(depNotice);
```

### 4. `src/webview/kanban.html` — add the model indicator with cost warning

Insert the model indicator after the dependency notice, before the interval row:

```js
            // Model Indicator
            const modelRow = document.createElement('div');
            modelRow.style.cssText = 'padding:6px 8px; margin-bottom:8px; border:1px solid var(--border-color); border-radius:4px; background:var(--panel-bg2); font-size:9px; line-height:1.4;';

            const detectModel = (cmd) => {
                if (!cmd || !cmd.trim()) return { name: 'Unknown', isHaiku: false, isCustom: false };
                const lower = cmd.toLowerCase();
                if (!lower.includes('claude')) return { name: 'Custom command', isHaiku: false, isCustom: true };
                if (lower.includes('haiku')) return { name: 'Haiku', isHaiku: true, isCustom: false };
                if (lower.includes('sonnet')) return { name: 'Sonnet', isHaiku: false, isCustom: false };
                if (lower.includes('opus')) return { name: 'Opus', isHaiku: false, isCustom: false };
                return { name: 'Default (not Haiku)', isHaiku: false, isCustom: false };
            };

            const modelInfo = detectModel(mcpMonitorResolvedCmd);
            const modelIcon = modelInfo.isHaiku ? '💰' : '⚠️';
            const modelColor = modelInfo.isHaiku ? 'var(--accent-teal)' : 'var(--text-secondary)';
            const modelNote = modelInfo.isHaiku
                ? 'Using Haiku to minimize token costs. Each check is a short read-only query — Haiku is ideal.'
                : modelInfo.isCustom
                    ? 'Custom command detected. Model unknown — verify it uses Haiku for cost efficiency.'
                    : 'Not using Haiku. This monitor runs frequently — consider --model claude-haiku-4-5 to reduce costs.';

            modelRow.innerHTML = `
                <span style="color:${modelColor};">${modelIcon}</span>
                <strong style="color:var(--text-primary);">Model: ${modelInfo.name}</strong><br>
                <span style="color:var(--text-secondary);">${modelNote}</span>
            `;
            mcpConfigPanel.appendChild(modelRow);
```

### 5. `src/webview/kanban.html` — show the resolved command in a collapsible details element

For transparency, show the actual command that will be sent (collapsible to avoid clutter):

```js
            // Resolved command (collapsible)
            const cmdDetails = document.createElement('details');
            cmdDetails.style.cssText = 'margin-bottom:8px; font-size:9px; color:var(--text-secondary);';
            const cmdSummary = document.createElement('summary');
            cmdSummary.textContent = 'Startup command (resolved)';
            cmdSummary.style.cssText = 'cursor:pointer; color:var(--text-secondary);';
            const cmdPre = document.createElement('pre');
            cmdPre.style.cssText = 'margin-top:4px; padding:4px; background:var(--panel-bg); border:1px solid var(--border-color); border-radius:3px; font-size:9px; color:var(--text-primary); white-space:pre-wrap; word-break:break-all;';
            cmdPre.textContent = mcpMonitorResolvedCmd || '(not resolved)';
            cmdDetails.appendChild(cmdSummary);
            cmdDetails.appendChild(cmdPre);
            mcpConfigPanel.appendChild(cmdDetails);
```

## Verification Plan

### Automated Tests
- No dedicated unit-test harness exists for the kanban webview DOM in this repo, so the primary verification is manual (below). If a lightweight test is added, target the pure `detectModel(cmd)` helper (extract it or duplicate its logic in a test): assert `detectModel('claude --model claude-haiku-4-5 …')` → `{name:'Haiku', isHaiku:true}`; `detectModel('claude --model claude-sonnet-4')` → `{name:'Sonnet'}`; `detectModel('my-agent')` → `{name:'Custom command', isCustom:true}`; `detectModel('')` → `{name:'Unknown'}`. This isolates the one piece of real logic from the DOM.
- **Type/build:** `npm run compile` succeeds with no type errors (only needed if producing a VSIX; per CLAUDE.md `dist/` is not used in dev/test).

### Manual Verification
1. **Build:** `npm run compile` succeeds with no type errors.
2. **Manual — dependency notice visible:**
   - Open AUTOMATION tab, enable the monitor. Confirm the "📋 Prerequisites" notice is visible at the top of the config panel, listing the `claude` CLI requirement, MCP server setup, and the dedicated terminal note.
3. **Manual — model indicator shows Haiku (default):**
   - With no custom startup command configured (using the fallback), confirm the model indicator shows "💰 Model: Haiku" with the cost-savings note.
   - Expand "Startup command (resolved)" — confirm it shows the current `mcp_monitor` fallback command. **Do not hard-assert the full literal string** — sibling plan `remove-dontask-permission-mode` may remove `--permission-mode dontAsk` from `TaskViewerProvider.ts:3901`. Assert instead that the resolved command (a) starts with `claude`, and (b) contains `--model claude-haiku-4-5`. At time of writing the fallback is `claude --model claude-haiku-4-5 --permission-mode dontAsk --allowedTools "mcp__*"`; verify against whatever that line currently is.
4. **Manual — model indicator shows non-Haiku warning:**
   - Configure a custom startup command for `mcp_monitor` that uses `--model claude-sonnet-4` (via the Setup tab or config file).
   - Reopen the AUTOMATION tab. Confirm the model indicator shows "⚠️ Model: Sonnet" with the cost warning recommending Haiku.
5. **Manual — custom command detection:**
   - Configure a custom startup command that is not `claude` (e.g. `my-agent`). Confirm the indicator shows "⚠️ Model: Custom command" with the "model unknown" note.
6. **Manual — resolved command updates on config change:**
   - Change the startup command in Setup, return to AUTOMATION tab. Confirm the resolved command and model indicator reflect the new command (the `_postMcpMonitorConfig` push includes `resolvedStartupCommand`).
7. **Regression:** The `_postMcpMonitorConfig` message now includes `resolvedStartupCommand` — existing message handlers that destructure the message (line 6732) ignore unknown fields, so no breakage. The `updateMcpMonitorConfig` handler in the webview only reads `config`, `presets`, `isMonitorRunning`, and (now) `resolvedStartupCommand` — extra fields are harmless.

---

## Recommendation

**Complexity 4 → Send to Coder.** Additive, low-risk change reusing established config-push and DOM-build patterns, but it touches a shared cross-webview message surface (`_postMcpMonitorConfig`) and displays a fallback string that a sibling plan edits, so it needs a coder who will coordinate the epic-level shared surfaces rather than an unattended intern pass.

## Review Findings

**Files changed:** none (implementation verified correct as-is). **Validation:** `resolvedStartupCommand` is included in `_postMcpMonitorConfig` message and stored in `mcpMonitorResolvedCmd` outside the interaction guard; `detectModel` correctly handles empty/claude/haiku/sonnet/opus/custom commands; `cmdPre` uses `textContent` (not `innerHTML`) for command display — no injection risk; displayed fallback command correctly reflects the `dontAsk` removal from the sibling plan. **No fixes needed.** **Remaining risks:** `detectModel` substring check could mislabel exotic custom commands containing "claude" (e.g. `my-claude-wrapper`) as "Default (not Haiku)" rather than "Custom command" — acceptable per plan's design decision.
