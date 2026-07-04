# Comms Monitor: Editable Prompt Preview with Timestamps, Channels, and DM/Channel Differentiation

## Goal

The MCP Monitor (Comms Monitor) in the kanban.html **AUTOMATION** tab currently builds its check prompt entirely in the backend (`_buildMcpMonitorPrompt`, `TaskViewerProvider.ts:20552` — line anchors verified 2026-07-03; the plan's original `:20460` had drifted) and sends it invisibly to the terminal. The user has no way to see what prompt is being sent, let alone edit it. Additionally, the prompt content is too vague — it says "unread direct messages and @-mentions across my channels" without specifying timestamps, channel names, inboxes, or differentiating between DMs and channels.

This plan adds a **live, editable prompt preview** to the AUTOMATION tab that:
1. Renders the exact prompt text the backend will send, updating in real time as the user toggles sources / interval / custom instruction.
2. Is fully editable — the user can override the generated prompt with their own text.
3. Enriches the generated prompt with **explicit timestamps** (the diff boundary), **channel names / inbox identifiers**, and **clear DM-vs-channel differentiation** for Slack.

### Problem Analysis & Root Cause

**Symptom 1 (no preview):** The user enables the monitor, picks sources, but has no idea what text gets sent to the terminal. The prompt is assembled in `_buildMcpMonitorPrompt` (line 20552) from a fixed preamble + `SOURCE_PRESETS` strings (`SOURCE_PRESETS` is at line 20475). The webview never sees the rendered prompt — it only sends config (sources, interval, custom instruction) via the `setMcpMonitorConfig` message (`saveMonitorConfig` posts it at kanban.html:7738; the backend `case 'setMcpMonitorConfig'` is in `KanbanProvider.ts:6263`) and trusts the backend to build the text.

**Symptom 2 (vague prompt):** The current source presets are generic:
- `slack: "Slack: unread direct messages and @-mentions across my channels."` — no timestamp boundary, no channel names, no DM/channel split.
- `gmail: "Gmail: unread or important emails in my inbox."` — no inbox name, no sender filter, no timestamp.
- `gcal: "Google Calendar: events starting in the next 24 hours."` — no calendar name.

The preamble (inside `_buildMcpMonitorPrompt`, line 20553) says "since your previous check" but doesn't inject the actual timestamp (this is being addressed by the persistent `lastCheckAt` plan — the sibling **mcp-monitor-first-prompt-after-startup**, which adds `lastCheckAt?: string` to `McpMonitorConfig` in its Phase 2 — but the prompt text still needs to *render* that timestamp and the source-specific details).

**Root cause:** The prompt is built server-side from static preset strings with no parameterization, and the webview has no rendering/preview capability — it only sends config fragments. There is no "prompt template" concept; the presets are flat strings, not parameterized templates.

## Metadata

- **Tags:** comms-monitor, mcp-monitor, automation, kanban, prompt, ux, slack, gmail
- **Complexity:** 5
- **Project:** switchboard
- **Files touched:** `src/services/TaskViewerProvider.ts`, `src/services/GlobalIntegrationConfigService.ts`, `src/services/KanbanProvider.ts`, `src/webview/kanban.html`

## User Review Required

This plan modifies **shared surfaces also touched by sibling subtasks in the "MCP Monitor improvements" epic** — coordinate these at the epic level before implementation:

- **`_buildMcpMonitorPrompt` (`TaskViewerProvider.ts:20552`)** — this plan rewrites it (parameterized source lines, `promptOverride` short-circuit). Also rewritten by **first-prompt-after-startup** (adds `lastCheckAt` timestamp injection) and **per-source-intervals** (adds due-source filtering). The reconciled builder must support all three: override short-circuit → timestamp boundary → per-source lines filtered by "due" status.
- **`McpMonitorConfig` schema (`GlobalIntegrationConfigService.ts:39`)** — this plan adds `promptOverride`, `slackChannels`, `slackDmOnly`, `slackChannelOnly`, `gmailLabel`. **first-prompt-after-startup** adds `lastCheckAt`; **per-source-intervals** *replaces* `intervalMinutes`/`lastCheckAt` with `sourceIntervals`/`sourceLastCheckAt` maps. See Adversarial Synthesis for the timestamp conflict.
- **kanban.html monitor UI block (`saveMonitorConfig` at 7732, source checklist / `activeSources` at 7654, checkbox `change` block at 7679–7699)** — extended by this plan and by rename-display-labels, dedicated-tab, stuck-running-status-and-stop-control, and apply-source-changes-immediately.
- **`setMcpMonitorConfigFromKanban` / `saveMonitorConfig`** — apply-source-changes-immediately adds a coalesced immediate-tick to the same functions this plan extends.

**Decision needed:** does the epic ship the persistent `lastCheckAt` (first-prompt-after-startup) or the per-source `sourceLastCheckAt` (per-source-intervals) as the timestamp source of truth? This plan's timestamp rendering must bind to whichever wins.

## Complexity Audit

**Moderate.** This is a UI + backend change across three files. The backend changes (parameterized prompt builder, config schema for channel/inbox overrides, prompt-override field) follow existing patterns in the file. The frontend changes (live preview textarea, real-time rendering) are the most involved part — the webview needs to either replicate the prompt-building logic client-side (for live preview) or request a rendered preview from the backend on each config change.

**Design decision — client-side rendering:** The preview must update instantly as the user toggles checkboxes. Round-tripping to the backend on every change would be laggy and flood the message channel. The prompt-building logic should be **mirrored in the webview** (a JS function that produces the same text as `_buildMcpMonitorPrompt`), using the config state already in the webview (`mcpMonitorConfig`). The backend retains the authoritative builder for actual sends; the webview builder is for preview only. When the user edits the preview textarea, the edited text is sent as a `promptOverride` field in the config and the backend uses it verbatim instead of calling `_buildMcpMonitorPrompt`.

**Risk:** Prompt-builder drift between the webview mirror and the backend. Mitigated by: (a) keeping the webview builder simple and well-commented, (b) the backend always has the final say — if `promptOverride` is empty/unchanged, the backend rebuilds from its own logic, so a drifted webview preview only affects what the user *sees*, not what is *sent* (unless they edit it, in which case their edit is sent verbatim).

### Routine
- Additive optional fields on `McpMonitorConfig` and `GlobalConfig.mcpMonitor` following the existing `?? current.X` read/write pattern.
- New per-source prompt-line helpers (`_buildSlackPromptLine`, `_buildGmailPromptLine`) extending the existing preset-string approach.
- New webview inputs (channel field, DM/channel checkboxes, Gmail label) mirroring the existing `customInstructionTextarea` styling and `guardInteraction` wiring.
- New `renderMcpMonitorPreview` message handler mirroring the existing `setMcpMonitorConfig` handler in `KanbanProvider.ts`.

### Complex / Risky
- Client-side prompt-builder mirror must stay in sync with the backend `_buildMcpMonitorPrompt` (drift risk — mitigated as above; backend is authoritative for actual sends).
- `_buildMcpMonitorPrompt` is a **shared surface** rewritten by three sibling subtasks; the reconciled signature/behavior must be agreed at the epic level (see User Review Required).
- `promptOverride`-vs-generated state machine in the webview (`previewIsOverride` flag): must correctly preserve manual edits on text input but regenerate on source/interval toggle, and clear cleanly via Reset.
- Timestamp binding depends on an unresolved epic decision (`lastCheckAt` vs `sourceLastCheckAt`).

## Edge-Case & Dependency Audit

- **Prompt override persistence:** `promptOverride` must be persisted in `~/.switchboard/integration-config.json` so it survives reloads. It's a new optional field on `mcpMonitor` — additive, no migration.
- **Override vs. generated:** If the user edits the preview, then later toggles a source, the preview should regenerate from the template (discarding the manual edit) OR preserve the edit. Decision: **regenerate on source/interval toggle, preserve on pure text edits.** A "Reset to template" button is provided to explicitly discard the override. This avoids the user being stuck with a stale override after changing sources.
- **Timestamp in preview:** The preview shows the *current* `lastCheckAt` boundary (or "past 24 hours" if none). At actual send time, the backend uses the live `lastCheckAt`. The preview is approximate — it shows what the prompt *would* look like now. This is acceptable; the timestamp is informational.
- **Channel/inbox fields empty:** If the user doesn't fill in channel names, the prompt falls back to the generic "across my channels" phrasing. Channel-name fields are optional enhancements, not required.
- **Custom instruction source:** The custom instruction textarea already exists (`customInstructionTextarea`, kanban.html:7666). It should be incorporated into the preview as an additional bullet, same as today.
- **Long prompts:** The preview textarea should be scrollable and resizable (matching the existing `customInstructionTextarea` style with `resize:vertical`).
- **Webview `confirm()` ban:** No confirm dialogs. The "Reset to template" button resets immediately.
- **Dependency on persistent `lastCheckAt` plan:** This plan assumes `lastCheckAt` exists in the config (from the companion plan **first-prompt-after-startup**, Phase 2). If that plan hasn't shipped yet, the timestamp rendering falls back to "past 24 hours" — the preview still works, just without a timestamp boundary. No hard dependency.

### Race Conditions
- **Preview render vs. config push:** The backend `_postMcpMonitorConfig` (line 20579) pushes `updateMcpMonitorConfig` to the webview; the webview's `renderPreview` reads `mcpMonitorConfig`. If a push lands mid-edit while `previewIsOverride` is true, `renderPreview` must not clobber the user's in-progress text — the `if (!previewIsOverride)` guard already covers this.
- **Coalesced-tick interaction (apply-source-changes-immediately):** if that sibling ships, `saveMonitorConfig` triggers an immediate backend tick. The `promptOverride` must be persisted *before* the tick fires, or the tick sends the pre-edit generated prompt. Since `saveMonitorConfig` posts the full config (including `promptOverride`) synchronously before the tick schedule, the persisted value wins — verify ordering during integration.

### Security
- `promptOverride` is user-authored text sent verbatim to a terminal via `sendRobustText`. It is read-only-scoped by the preamble instruction, but a user override could remove that guard. This is user-initiated and local (the user is instructing their own agent) — acceptable, same trust boundary as the existing `customInstruction` field. No new escalation surface.
- Channel/label strings are interpolated into prompt text, not into shell commands or SQL — no injection sink beyond the LLM prompt itself.

### Side Effects
- Adds up to five new keys to `~/.switchboard/integration-config.json`. Additive; older extension versions ignore unknown keys on read (per the `?? current.X` pattern) so downgrade is safe.
- `_postMcpMonitorConfig` will now surface the new fields to any webview that renders config — confirm no other consumer breaks on the extra keys (they spread the whole `config` object).

### Dependencies & Conflicts
- **Soft dep:** `lastCheckAt` from first-prompt-after-startup (graceful fallback to "past 24 hours" if absent).
- **Schema conflict:** per-source-intervals replaces `intervalMinutes`/`lastCheckAt` with `sourceIntervals`/`sourceLastCheckAt` maps — this plan's single-`lastCheckAt` timestamp logic would need rework if that ships. See Adversarial Synthesis.
- **Function-overlap:** apply-source-changes-immediately and the display-label / dedicated-tab / stop-control siblings all edit the same `_buildMcpMonitorPrompt` and kanban.html monitor block.

## Dependencies

- `sess_first_prompt_startup — mcp-monitor-first-prompt-after-startup` (adds persistent `lastCheckAt` to `McpMonitorConfig`; soft dependency — this plan degrades gracefully without it)
- `sess_per_source_intervals — comms-monitor-per-source-intervals` (potential schema supersession of the timestamp/interval fields this plan reads)
- `sess_apply_source_changes — comms-monitor-apply-source-changes-immediately` (co-edits `setMcpMonitorConfigFromKanban` / `saveMonitorConfig`)

## Adversarial Synthesis

Key risks: (1) three sibling subtasks rewrite the shared `_buildMcpMonitorPrompt` and the same kanban.html monitor block, so uncoordinated implementation will produce merge conflicts or a builder that only satisfies one plan; (2) the timestamp boundary this plan renders (`new Date(cfg.lastCheckAt)`) breaks if per-source-intervals ships its `sourceLastCheckAt` map instead of a global `lastCheckAt`; (3) the webview prompt-builder mirror can drift from the backend. Mitigations: treat the prompt builder and config schema as epic-coordinated surfaces (do not merge unilaterally), bind the timestamp render to whichever `lastCheckAt` shape the epic settles on with a defensive fallback to "past 24 hours", and rely on the backend as the authoritative builder so a drifted preview never changes what is actually sent unless the user explicitly overrides.

## Proposed Changes

### 1. `src/services/GlobalIntegrationConfigService.ts` — add prompt-override and source-detail fields to config schema

Extend `GlobalConfig.mcpMonitor` (line 15) and `McpMonitorConfig` (line 39):

```ts
    mcpMonitor?: {
        enabled?: boolean;
        intervalMinutes?: number;
        targetRole?: string;
        sources?: string[];
        customInstruction?: string;
        lastCheckAt?: string;
        promptOverride?: string;          // NEW: user-edited prompt text; empty = use generated
        slackChannels?: string;           // NEW: comma-separated channel/DM names to focus on
        slackDmOnly?: boolean;            // NEW: if true, prompt asks for DMs only (no channels)
        slackChannelOnly?: boolean;       // NEW: if true, prompt asks for channels only (no DMs)
        gmailLabel?: string;              // NEW: Gmail label/inbox to focus on (e.g. "INBOX", "Important")
    };
```

```ts
export interface McpMonitorConfig {
    enabled: boolean;
    intervalMinutes: number;
    targetRole: string;
    sources: string[];
    customInstruction: string;
    lastCheckAt?: string;
    promptOverride?: string;
    slackChannels?: string;
    slackDmOnly?: boolean;
    slackChannelOnly?: boolean;
    gmailLabel?: string;
}
```

Read/write these through `getMcpMonitorConfig` (line 233) and `setMcpMonitorConfig` (line 245) following the existing `?? current.X` pattern. **Also update `getMcpMonitorConfigSync` (line 221)** — it is a separate read path that materializes the typed `McpMonitorConfig`; if the new fields are not propagated there, any sync consumer silently drops them. `DEFAULT_MCP_MONITOR_CONFIG` (line 47) needs no new entries since all new fields are optional (leave them `undefined` by default). All new fields are optional with no defaults — additive, no migration.

### 2. `src/services/TaskViewerProvider.ts` — parameterize the prompt builder

**Shared surface — coordinate at epic level.** `_buildMcpMonitorPrompt` is also rewritten by first-prompt-after-startup (timestamp injection) and per-source-intervals (due-source filtering). Do not merge this rewrite unilaterally; the final builder must compose all three behaviors. Keep this plan's design (override short-circuit + per-source lines) but layer it onto the reconciled builder.

Replace `_buildMcpMonitorPrompt` (line 20552; the current body emits a FIXED preamble with no timestamp, no `promptOverride`, and flat `SOURCE_PRESETS` strings at line 20475) with a parameterized version that injects timestamps, channel names, and DM/channel differentiation:

```ts
    private _buildMcpMonitorPrompt(cfg: McpMonitorConfig): string {
        // If the user has an override, use it verbatim.
        if (cfg.promptOverride && cfg.promptOverride.trim()) {
            return normalizeNewlines(cfg.promptOverride.trim());
        }

        const boundary = cfg.lastCheckAt
            ? `since ${new Date(cfg.lastCheckAt).toUTCString()}`
            : 'in the past 24 hours';
        const preamble = `Check the following for anything new that needs my attention ${boundary}. Report only what is new and noteworthy as a short bullet list. If nothing needs attention, reply 'All clear'. This is read-only — do NOT take any actions, send any messages, or modify anything.`;

        const lines: string[] = [];
        const sources = cfg.sources || [];
        for (const src of sources) {
            if (src === 'custom') {
                if (cfg.customInstruction && cfg.customInstruction.trim()) {
                    lines.push(cfg.customInstruction.trim());
                }
            } else if (src === 'slack') {
                lines.push(this._buildSlackPromptLine(cfg));
            } else if (src === 'gmail') {
                lines.push(this._buildGmailPromptLine(cfg));
            } else if (src === 'gcal') {
                lines.push('Google Calendar: events starting in the next 24 hours.');
            }
        }
        if (lines.length === 0) return '';
        const body = preamble + "\n\n" + lines.map(line => `- ${line}`).join('\n');
        return normalizeNewlines(body);
    }

    private _buildSlackPromptLine(cfg: McpMonitorConfig): string {
        const channels = (cfg.slackChannels || '').split(',').map(s => s.trim()).filter(Boolean);
        const scopeParts: string[] = [];
        if (!cfg.slackDmOnly) {
            if (channels.length > 0) {
                scopeParts.push(`messages in channels: ${channels.join(', ')}`);
            } else {
                scopeParts.push('messages in channels (all)');
            }
        }
        if (!cfg.slackChannelOnly) {
            scopeParts.push('direct messages (DMs)');
        }
        const scope = scopeParts.join(' and ');
        return `Slack: unread ${scope} and @-mentions ${cfg.lastCheckAt ? 'since ' + new Date(cfg.lastCheckAt).toUTCString() : 'in the past 24 hours'}. Clearly label each item as [DM] or [channel: #name].`;
    }

    private _buildGmailPromptLine(cfg: McpMonitorConfig): string {
        const label = cfg.gmailLabel && cfg.gmailLabel.trim() ? cfg.gmailLabel.trim() : 'INBOX';
        return `Gmail: unread or important emails in label "${label}" ${cfg.lastCheckAt ? 'since ' + new Date(cfg.lastCheckAt).toUTCString() : 'in the past 24 hours'}. Include sender and subject for each.`;
    }
```

### 3. `src/services/TaskViewerProvider.ts` — expose a "render preview" message handler

Add a new message type so the webview can request a rendered preview from the backend (used as a one-time sync on panel load, and optionally on save). In `KanbanProvider.ts`, alongside the existing `case 'setMcpMonitorConfig':` handler (line 6263), add:

```ts
            case 'renderMcpMonitorPreview': {
                if (this._taskViewerProvider && msg.config) {
                    const preview = this._taskViewerProvider.buildMcpMonitorPreview(msg.config);
                    this._panel?.webview.postMessage({ type: 'mcpMonitorPreview', preview });
                }
                break;
            }
```

In `TaskViewerProvider.ts`, add a public method:

```ts
    public buildMcpMonitorPreview(cfg: Partial<McpMonitorConfig>): string {
        const full: McpMonitorConfig = {
            enabled: cfg.enabled ?? false,
            intervalMinutes: cfg.intervalMinutes ?? 5,
            targetRole: cfg.targetRole ?? 'mcp_monitor',
            sources: cfg.sources ?? [],
            customInstruction: cfg.customInstruction ?? '',
            lastCheckAt: cfg.lastCheckAt,
            promptOverride: '',  // preview always shows the generated template, not the override
            slackChannels: cfg.slackChannels,
            slackDmOnly: cfg.slackDmOnly,
            slackChannelOnly: cfg.slackChannelOnly,
            gmailLabel: cfg.gmailLabel,
        };
        return this._buildMcpMonitorPrompt(full);
    }
```

Note: the preview deliberately passes `promptOverride: ''` so the rendered preview always shows the *generated* template. The user's edited override is stored separately and shown in the textarea; the "Reset to template" button clears the override and re-renders the template.

### 4. `src/webview/kanban.html` — add source-detail fields (Slack channels, DM/channel toggles, Gmail label)

After the sources checklist (`activeSources` is built at line 7654; the per-source checkboxes and their `change` handler are at lines 7679–7699) and before the status line, add a "Source Details" section that appears when the corresponding source is checked:

```js
            // Source Details (conditional on checked sources)
            const detailsSection = document.createElement('div');
            detailsSection.style.cssText = 'margin-top:4px; margin-bottom:8px; padding-left:4px;';

            // Slack details
            const slackDetails = document.createElement('div');
            slackDetails.style.cssText = 'display:' + (activeSources.has('slack') ? 'block' : 'none') + '; margin-bottom:6px;';
            const slackChanLabel = document.createElement('div');
            slackChanLabel.textContent = 'Slack channels (comma-separated, blank = all):';
            slackChanLabel.style.cssText = 'font-size:9px; color:var(--text-secondary); margin-bottom:2px;';
            const slackChanInput = document.createElement('input');
            slackChanInput.type = 'text';
            slackChanInput.value = mcpMonitorConfig.slackChannels || '';
            slackChanInput.placeholder = 'e.g. general, engineering, #proj-x';
            slackChanInput.style.cssText = 'width:100%; background:var(--panel-bg); border:1px solid var(--border-color); color:var(--text-primary); font-family:var(--font-mono); font-size:9px; padding:3px; border-radius:3px; box-sizing:border-box;';
            guardInteraction(slackChanInput);

            const slackScopeRow = document.createElement('div');
            slackScopeRow.style.cssText = 'display:flex; gap:8px; margin-top:4px; font-size:9px; color:var(--text-secondary);';
            const dmOnlyCb = document.createElement('input'); dmOnlyCb.type = 'checkbox'; dmOnlyCb.id = 'mcp-slack-dm-only';
            dmOnlyCb.checked = !!mcpMonitorConfig.slackDmOnly; guardInteraction(dmOnlyCb);
            const dmOnlyLabel = document.createElement('label'); dmOnlyLabel.textContent = 'DMs only';
            dmOnlyLabel.htmlFor = 'mcp-slack-dm-only'; dmOnlyLabel.style.cssText = 'cursor:pointer;';
            const chanOnlyCb = document.createElement('input'); chanOnlyCb.type = 'checkbox'; chanOnlyCb.id = 'mcp-slack-chan-only';
            chanOnlyCb.checked = !!mcpMonitorConfig.slackChannelOnly; guardInteraction(chanOnlyCb);
            const chanOnlyLabel = document.createElement('label'); chanOnlyLabel.textContent = 'Channels only';
            chanOnlyLabel.htmlFor = 'mcp-slack-chan-only'; chanOnlyLabel.style.cssText = 'cursor:pointer;';
            slackScopeRow.appendChild(dmOnlyCb); slackScopeRow.appendChild(dmOnlyLabel);
            slackScopeRow.appendChild(chanOnlyCb); slackScopeRow.appendChild(chanOnlyLabel);

            slackDetails.appendChild(slackChanLabel);
            slackDetails.appendChild(slackChanInput);
            slackDetails.appendChild(slackScopeRow);
            detailsSection.appendChild(slackDetails);

            // Gmail details
            const gmailDetails = document.createElement('div');
            gmailDetails.style.cssText = 'display:' + (activeSources.has('gmail') ? 'block' : 'none') + '; margin-bottom:6px;';
            const gmailLabelLabel = document.createElement('div');
            gmailLabelLabel.textContent = 'Gmail label/inbox (blank = INBOX):';
            gmailLabelLabel.style.cssText = 'font-size:9px; color:var(--text-secondary); margin-bottom:2px;';
            const gmailLabelInput = document.createElement('input');
            gmailLabelInput.type = 'text';
            gmailLabelInput.value = mcpMonitorConfig.gmailLabel || '';
            gmailLabelInput.placeholder = 'e.g. INBOX, Important, Work';
            gmailLabelInput.style.cssText = 'width:100%; background:var(--panel-bg); border:1px solid var(--border-color); color:var(--text-primary); font-family:var(--font-mono); font-size:9px; padding:3px; border-radius:3px; box-sizing:border-box;';
            guardInteraction(gmailLabelInput);
            gmailDetails.appendChild(gmailLabelLabel);
            gmailDetails.appendChild(gmailLabelInput);
            detailsSection.appendChild(gmailDetails);

            mcpConfigPanel.appendChild(detailsSection);
```

Wire the Slack checkbox to show/hide `slackDetails` and the Gmail checkbox to show/hide `gmailDetails` (in the existing `checkbox.addEventListener('change', ...)` block at lines 7679–7699, which already calls `saveMonitorConfig()` at line 7699).

### 5. `src/webview/kanban.html` — add the editable prompt preview textarea

After the details section, add the preview:

```js
            // Editable Prompt Preview
            const previewHeader = document.createElement('div');
            previewHeader.style.cssText = 'font-weight:bold; color:var(--text-secondary); margin-top:8px; margin-bottom:4px; display:flex; justify-content:space-between; align-items:center;';
            const previewHeaderText = document.createElement('span');
            previewHeaderText.textContent = 'Prompt Preview (editable):';
            previewHeader.appendChild(previewHeaderText);

            const resetBtn = document.createElement('button');
            resetBtn.textContent = 'Reset to template';
            resetBtn.style.cssText = 'font-size:9px; padding:2px 6px; background:var(--panel-bg); border:1px solid var(--border-color); color:var(--text-secondary); border-radius:3px; cursor:pointer;';
            guardInteraction(resetBtn);
            previewHeader.appendChild(resetBtn);

            const previewTextarea = document.createElement('textarea');
            previewTextarea.style.cssText = 'width:100%; height:120px; background:var(--panel-bg); border:1px solid var(--border-color); color:var(--text-primary); font-family:var(--font-mono); font-size:9px; padding:6px; border-radius:3px; resize:vertical; box-sizing:border-box; line-height:1.4;';
            guardInteraction(previewTextarea);

            // Track whether the user has manually edited the preview
            let previewIsOverride = !!(mcpMonitorConfig.promptOverride && mcpMonitorConfig.promptOverride.trim());

            // Client-side prompt builder mirror (must match _buildMcpMonitorPrompt in backend)
            const buildPreviewPrompt = (cfg) => {
                const boundary = cfg.lastCheckAt
                    ? `since ${new Date(cfg.lastCheckAt).toUTCString()}`
                    : 'in the past 24 hours';
                const preamble = `Check the following for anything new that needs my attention ${boundary}. Report only what is new and noteworthy as a short bullet list. If nothing needs attention, reply 'All clear'. This is read-only — do NOT take any actions, send any messages, or modify anything.`;
                const lines = [];
                const sources = cfg.sources || [];
                for (const src of sources) {
                    if (src === 'custom') {
                        if (cfg.customInstruction && cfg.customInstruction.trim()) lines.push(cfg.customInstruction.trim());
                    } else if (src === 'slack') {
                        const channels = (cfg.slackChannels || '').split(',').map(s => s.trim()).filter(Boolean);
                        const scopeParts = [];
                        if (!cfg.slackDmOnly) scopeParts.push(channels.length > 0 ? `messages in channels: ${channels.join(', ')}` : 'messages in channels (all)');
                        if (!cfg.slackChannelOnly) scopeParts.push('direct messages (DMs)');
                        lines.push(`Slack: unread ${scopeParts.join(' and ')} and @-mentions ${boundary}. Clearly label each item as [DM] or [channel: #name].`);
                    } else if (src === 'gmail') {
                        const label = cfg.gmailLabel && cfg.gmailLabel.trim() ? cfg.gmailLabel.trim() : 'INBOX';
                        lines.push(`Gmail: unread or important emails in label "${label}" ${boundary}. Include sender and subject for each.`);
                    } else if (src === 'gcal') {
                        lines.push('Google Calendar: events starting in the next 24 hours.');
                    }
                }
                if (lines.length === 0) return '';
                return preamble + "\n\n" + lines.map(l => `- ${l}`).join('\n');
            };

            const renderPreview = () => {
                if (!previewIsOverride) {
                    previewTextarea.value = buildPreviewPrompt(mcpMonitorConfig);
                }
            };
            renderPreview();  // initial render

            // On any config-affecting change, regenerate the template (unless user has override)
            const regeneratePreview = () => {
                if (!previewIsOverride) renderPreview();
            };

            // User edits the textarea → mark as override
            previewTextarea.addEventListener('input', () => {
                previewIsOverride = true;
            });

            // Reset button → discard override, regenerate template
            resetBtn.addEventListener('click', () => {
                previewIsOverride = false;
                mcpMonitorConfig.promptOverride = '';
                renderPreview();
                saveMonitorConfig();
            });

            mcpConfigPanel.appendChild(previewHeader);
            mcpConfigPanel.appendChild(previewTextarea);
```

### 6. `src/webview/kanban.html` — update `saveMonitorConfig` to include new fields and prompt override

Update the `saveMonitorConfig` function (line 7732; **shared surface** — apply-source-changes-immediately also extends this function and `setMcpMonitorConfigFromKanban`) to send the new fields:

```js
            const saveMonitorConfig = () => {
                const enabled = mcpSelect.value === 'on';
                const intervalMinutes = parseInt(intervalSelect.value, 10);
                const customInstruction = customInstructionTextarea.value;
                const sources = Array.from(activeSources);
                const slackChannels = slackChanInput.value;
                const slackDmOnly = dmOnlyCb.checked;
                const slackChannelOnly = chanOnlyCb.checked;
                const gmailLabel = gmailLabelInput.value;
                const promptOverride = previewIsOverride ? previewTextarea.value : '';
                mcpMonitorConfig = { ...mcpMonitorConfig, enabled, intervalMinutes, sources, customInstruction, slackChannels, slackDmOnly, slackChannelOnly, gmailLabel, promptOverride };
                postKanbanMessage({
                    type: 'setMcpMonitorConfig',
                    config: { enabled, intervalMinutes, sources, customInstruction, slackChannels, slackDmOnly, slackChannelOnly, gmailLabel, promptOverride }
                });
                regeneratePreview();
            };
```

Wire all new inputs (`slackChanInput`, `dmOnlyCb`, `chanOnlyCb`, `gmailLabelInput`) to call `saveMonitorConfig` on `change`/`input`, same as the existing `intervalSelect` and `customInstructionTextarea` listeners (lines 7753–7754).

## Verification Plan

### Automated Tests

- **Typecheck / build:** `npm run compile` (webpack) succeeds with no TypeScript errors — the primary automated gate for this change, since the MCP-monitor path has no dedicated unit-test harness today.
- **Prompt-builder parity (recommended, if a unit test is added):** a small pure-function test asserting `_buildMcpMonitorPrompt` and the webview `buildPreviewPrompt` mirror produce identical text for representative configs (Slack-only, Slack DMs-only, Gmail with label, custom, empty sources, with/without `lastCheckAt`). This is the highest-value automated guard against builder drift.

### Manual Verification

1. **Build:** `npm run compile` succeeds with no type errors.
2. **Manual — preview appears and updates live:**
   - Open AUTOMATION tab, enable the monitor.
   - Toggle Slack on → preview textarea populates with the Slack prompt line including "past 24 hours" (no `lastCheckAt` yet).
   - Toggle Gmail on → preview updates to include the Gmail line.
   - Change interval → preview unaffected (interval doesn't change prompt text — correct).
3. **Manual — timestamp in preview:**
   - After at least one successful monitor tick (so `lastCheckAt` is persisted), reopen the AUTOMATION tab.
   - Confirm the preview shows "since <UTC timestamp>" instead of "past 24 hours".
4. **Manual — Slack channel differentiation:**
   - Enable Slack, enter "general, engineering" in the channels field.
   - Confirm preview contains "messages in channels: general, engineering and direct messages (DMs)" and "Clearly label each item as [DM] or [channel: #name]".
   - Check "DMs only" → preview updates to remove the channels scope, keeping only DMs.
   - Check "Channels only" (uncheck DMs only) → preview updates to remove DMs.
5. **Manual — Gmail label:**
   - Enable Gmail, enter "Important" in the label field.
   - Confirm preview contains `in label "Important"`.
6. **Manual — editable override:**
   - Type a custom message into the preview textarea.
   - Confirm `previewIsOverride` becomes true and subsequent source toggles do NOT overwrite the edit.
   - Click "Reset to template" → preview regenerates from the template, override cleared.
7. **Manual — override is sent verbatim:**
   - Edit the preview, save config.
   - Trigger a monitor tick (or wait for interval).
   - Confirm the terminal receives the edited text verbatim (not the generated template).
8. **Manual — override persists across reload:**
   - Edit the preview, reload the VS Code window.
   - Reopen AUTOMATION tab → the edited text is still in the preview textarea (loaded from `promptOverride` in config).
9. **Regression:** Existing monitor behavior (interval polling, terminal launch, source presets) unaffected when no new fields are set. The `setMcpMonitorConfig` signature is additive — existing partial configs from older installs still work.
10. **Regression — sync read path:** After updating `getMcpMonitorConfigSync` (line 221), confirm any sync consumer still compiles and returns the new fields (guards against silently dropping `promptOverride` on a sync read).

## Recommendation

**Complexity: 5 → Send to Coder.** This is a well-scoped multi-file change (config schema + backend builder + webview UI + one new message handler) that extends existing patterns. The elevated risk is not local complexity but epic-level coordination: `_buildMcpMonitorPrompt`, the `McpMonitorConfig` schema, and the kanban.html monitor block are shared with several sibling subtasks. The coder MUST reconcile the prompt-builder rewrite and the timestamp source-of-truth (`lastCheckAt` vs `sourceLastCheckAt`) with those siblings rather than merging in isolation.

## Review Findings

**Files changed:** `src/services/TaskViewerProvider.ts` (replaced `_slackGmailBoundary` with per-source `_sourceBoundary`), `src/webview/kanban.html` (updated `buildPreviewPrompt` mirror to use per-source boundaries for Slack/Gmail lines). **Validation:** grep confirmed zero remaining `_slackGmailBoundary` references; per-source boundary logic now matches between backend and webview mirror. **Fixes applied:** MAJOR — `_slackGmailBoundary` used `min(slack, gmail)` baselines for both Slack and Gmail prompt lines, causing incorrect timestamps when only one source was due and drift between the backend builder and the webview preview; replaced with `_sourceBoundary(cfg, source)` that uses only the relevant source's `sourceLastCheckAt` entry, and updated the webview mirror to match. **Remaining risks:** The `buildPreviewPrompt` mirror has a dead `promptOverride` short-circuit branch (NIT — `renderPreview` already passes `promptOverride: ''`); preview/backend drift risk is inherent to the mirror design but mitigated by the backend being authoritative for actual sends.
