# Add Git Ignore Strategy UI to Setup Menu

## Goal

Expose the existing `WorkspaceExcludeService` configuration (ignore strategy and ignore rules) in the sidebar SETUP panel so users can configure git exclusion behavior without manually editing VS Code settings.

## Metadata

**Tags:** frontend, UI
**Complexity:** 5

## User Review Required
> [!NOTE]
> - The "APPLY" button writes to `.git/info/exclude` or `.gitignore` depending on selected strategy. Users should understand that the `gitignore` strategy modifies a committed file.
> - No breaking changes. Existing `switchboard.workspace.ignoreStrategy` and `switchboard.workspace.ignoreRules` VS Code settings continue to work as before; this UI simply provides a visual editor for them.
> - **Clarification:** The current codebase renders the editable SETUP surface in `src/webview/setup.html`, opened from the sidebar via `src/webview/implementation.html` → `openSetupPanel`. The plan must target the central setup panel, not duplicate controls in the sidebar.

---

## Complexity Audit

### Routine
- **Clarification:** Add the HTML section (dropdown, textarea, status indicator, warning copy, button) to the actual SETUP panel in `src/webview/setup.html` inside `#startup-fields`; `src/webview/implementation.html` only contains the `OPEN SETUP` launcher and should remain unchanged for this feature.
- Add JavaScript helpers in `src/webview/setup.html` for dropdown change, apply click, result feedback, and config hydration — follows the existing `btn-save-startup` + `window.addEventListener('message', ...)` patterns already used there.
- Add setup-panel message routing in `src/services/SetupPanelProvider.ts` for `getGitIgnoreConfig` and `updateGitIgnoreConfig`, mirroring how that file already forwards `saveStartupCommands`, `getVisibleAgents`, and other setup-panel messages.
- Add shared get/save helpers plus setup-panel state broadcast in `src/services/TaskViewerProvider.ts` so the setup panel can load the saved `switchboard.workspace.ignoreStrategy` / `switchboard.workspace.ignoreRules` values on open and after save.
- Keep `src/services/WorkspaceExcludeService.ts` as the single writer for ignore files; the UI layer should only edit VS Code settings and surface the service's current append-only behavior clearly.

### Complex / Risky
- **Config round-trip correctness:** The UI must correctly serialize the textarea content (newline-delimited glob patterns) into a JSON string array for the VS Code setting `switchboard.workspace.ignoreRules`, and deserialize it back on load. Malformed input (empty lines, trailing whitespace, non-string values) must be sanitized.
- **Two-setting apply hazard:** `src/extension.ts` currently invokes `excludeService.apply()` on every `switchboard.workspace` configuration change. A single APPLY action that writes `ignoreStrategy` and `ignoreRules` sequentially can otherwise trigger two writes against partially updated config. **Clarification:** Coalesce or debounce those config-change reactions so one UI action produces one exclude-file update.
- **Append-only side effect:** Changing strategy from `localExclude` to `gitignore` (or vice versa) does NOT clean up rules from the previous target file, and changing rules does NOT remove previously appended entries. The `WorkspaceExcludeService.apply()` method only appends missing rules. **Clarification:** This is existing behavior, not new product scope; the UI copy/status text must say so explicitly to avoid implying full bidirectional sync.

## Edge-Case & Dependency Audit
- **Race Conditions:** The current `src/extension.ts` listener reacts immediately to every `switchboard.workspace` change. Without a debounce/coalescing step, one APPLY click can write half-updated config twice (for example, new strategy with old rules, then new strategy with new rules). The plan must explicitly harden this by coalescing `ignoreStrategy` + `ignoreRules` updates into a single `WorkspaceExcludeService.apply()` run. Rapid repeated clicks should be handled by disabling the APPLY button while the save is in flight and by letting the debounced listener collapse the resulting config events.
- **Security:** The textarea accepts arbitrary glob patterns written to `.git/info/exclude` or `.gitignore`. These are local git exclusion patterns with no code execution path, but the save helper should still validate that `strategy` is one of `localExclude`, `gitignore`, or `none` and that `rules` is an array of trimmed strings before persisting.
- **Side Effects:** Clicking APPLY can create `.gitignore` if it does not exist yet and can append another managed block when the user changes rules over time. The `none` strategy skips file modification entirely. The UI must show both the current target path and an append-only warning so users understand that APPLY does not remove older entries.
- **Dependencies & Conflicts:**
  - **Depends on (already implemented):** "Switchboard Repository Exclusion System" (Reviewed column) — source inspection confirmed `src/services/WorkspaceExcludeService.ts`, `src/extension.ts`, and `package.json` already define the underlying settings and apply behavior.
  - **Low-risk same-file overlap** with "Fix Team Lead UI Visibility" (`sess_1775819612843`, Planned) — both plans touch `src/webview/setup.html`, but in different blocks (`PROMPT_ROLES` vs. the git-ignore subsection). Merge carefully if they land together.
  - **Potential merge hotspot** with "Feature Plan: Add Acceptance Tester Role" (`sess_1775837845472`, New) — both plans touch `src/services/TaskViewerProvider.ts`. There is no product dependency, but concurrent edits in that file must be coordinated or rebased.
  - After scanning active Kanban plans (New + Planned) and the plans folder, no other conflicts or dependencies were found.

---

## Proposed Changes

> [!IMPORTANT]
> **MAXIMUM DETAIL REQUIRED:** Provide complete, fully functioning code blocks. Break down the logic step-by-step before showing code.

### Clarification — Authoritative implementation surface in the current codebase

- **Clarification:** The editable SETUP controls now live in `src/webview/setup.html`, not `src/webview/implementation.html`. Source inspection confirmed `setup.html` owns `#startup-fields`, the prompt-control toggles, and `#btn-save-startup`, while `implementation.html` only exposes `#btn-open-central-setup` and posts `openSetupPanel`.
- **Clarification:** Setup-panel webview messages are received by `src/services/SetupPanelProvider.ts`, which already forwards `ready`, `saveStartupCommands`, and `get*` requests to `TaskViewerProvider`. The new git-ignore messages must follow that same routing path.
- **Clarification:** `src/services/WorkspaceExcludeService.ts` already owns ignore-file writes and intentionally behaves as append-only. This plan should expose that existing behavior clearly rather than introduce a new file-rewrite system.

### Current-codebase corrections (authoritative; use these changes first)

#### [NO CHANGE] `src/webview/implementation.html`

- **Context:** Inspected current sidebar source. It renders Terminal Operations plus the `OPEN SETUP` launcher and does not contain the prompt-control toggles or `SAVE CONFIGURATION` button anymore.
- **Logic:** Keep the sidebar lean and avoid duplicating git-ignore controls in two webviews. The existing `openSetupPanel` flow remains the correct entry point.
- **Implementation:** No code change required in this file for the current codebase.
- **Edge Cases Handled:** Prevents a split-brain UI where sidebar state and central setup-panel state could diverge.

#### [MODIFY] `src/webview/setup.html`

- **Context:** This is the real SETUP editor surface (`#startup-fields`) that already renders `design-doc-toggle`, `accurate-coding-toggle`, `lead-challenge-toggle`, `advanced-reviewer-toggle`, `aggressive-pair-toggle`, and `btn-save-startup`. The git-ignore editor belongs here.
- **Logic:**
  1. Insert a `GIT IGNORE STRATEGY` subsection directly after the aggressive-pair toggle and before `SAVE CONFIGURATION`.
  2. Add a `<select>` for `localExclude | gitignore | none`, a newline-delimited `<textarea>` for rules, a target-path status line, an append-only warning, and an `APPLY GIT IGNORE` button.
  3. Store the currently loaded config in local JS state (`lastGitIgnoreConfig`) so the UI can hydrate on `ready`, on accordion re-open, and after a successful save.
  4. Post `getGitIgnoreConfig` when the Setup accordion opens, post `updateGitIgnoreConfig` when APPLY is clicked, and handle both `gitIgnoreConfig` and `saveGitIgnoreConfigResult` in the existing message switch.
- **Implementation:**

```diff
@@
                 <label class="startup-row" style="display:flex; align-items:center; gap:8px; margin-top:6px;">
                     <input id="aggressive-pair-toggle" type="checkbox" style="width:auto; margin:0;">
                     <span>Aggressive pair programming (shift more tasks to Coder)</span>
                 </label>
+                <div style="font-size: 10px; color: var(--text-secondary); margin: 12px 0 4px; font-family: var(--font-mono); letter-spacing: 1px;">
+                    GIT IGNORE STRATEGY
+                </div>
+                <div class="startup-row" style="display:flex; flex-direction:column; gap:6px; align-items:stretch; margin-top:6px;">
+                    <label for="git-ignore-strategy" style="font-size:11px; color:var(--text-secondary);">Strategy</label>
+                    <select id="git-ignore-strategy" style="width:100%; box-sizing:border-box; font-family:var(--font-mono); font-size:11px; background:var(--panel-bg2); border:1px solid var(--border-color); color:var(--text-primary); padding:6px 8px; border-radius:4px;">
+                        <option value="localExclude">localExclude — .git/info/exclude (local only)</option>
+                        <option value="gitignore">gitignore — .gitignore (committed)</option>
+                        <option value="none">none — do not manage ignore files</option>
+                    </select>
+                </div>
+                <div class="startup-row" style="display:flex; flex-direction:column; gap:6px; align-items:stretch;">
+                    <label for="git-ignore-rules" style="font-size:11px; color:var(--text-secondary);">Ignore rules (one glob per line)</label>
+                    <textarea id="git-ignore-rules" class="modal-textarea" style="min-height:96px; font-size:11px;" placeholder=".switchboard/*&#10;.agent/*"></textarea>
+                </div>
+                <div id="git-ignore-target-status" style="font-size:10px; color:var(--text-secondary); margin-top:2px; font-family:var(--font-mono);">
+                    Target: .git/info/exclude
+                </div>
+                <div id="git-ignore-warning" style="font-size:10px; color:var(--text-secondary); line-height:1.4; font-family:var(--font-mono);">
+                    Clarification: APPLY appends missing entries only. It does not remove older rules from existing ignore files.
+                </div>
+                <button id="btn-apply-git-ignore" class="secondary-btn w-full" style="margin-top:4px;">APPLY GIT IGNORE</button>
                 <button id="btn-save-startup" class="secondary-btn w-full" style="margin-top:4px; color: var(--accent-green); border-color: color-mix(in srgb, var(--accent-green) 250%, transparent);">
                     SAVE CONFIGURATION
                 </button>
@@
         let lastPromptOverrides = {};
         let lastPromptPreviews = {};
         let editingPromptRole = 'planner';
         let lastDesignDocLink = '';
         let currentDbPath = '';
         let workspaceRoot = '';
         let lastPlanIngestionFolder = '';
+        let lastGitIgnoreConfig = {
+            strategy: 'localExclude',
+            rules: ['.switchboard/*', '.agent/*']
+        };
@@
         function getCustomVisibleAgentsPatch() {
             return Object.fromEntries(
                 lastCustomAgents.map(agent => [agent.role, lastVisibleAgents[agent.role] !== false])
             );
         }
+
+        function sanitizeGitIgnoreRules(raw) {
+            return Array.from(new Set(
+                String(raw || '')
+                    .split('\n')
+                    .map(rule => rule.trim())
+                    .filter(Boolean)
+            ));
+        }
+
+        function updateGitIgnoreTargetStatus() {
+            const strategy = document.getElementById('git-ignore-strategy')?.value || 'localExclude';
+            const targetMap = {
+                localExclude: '.git/info/exclude',
+                gitignore: '.gitignore',
+                none: 'No file (manual management)'
+            };
+            const status = document.getElementById('git-ignore-target-status');
+            if (status) {
+                status.textContent = `Target: ${targetMap[strategy] || strategy}`;
+            }
+        }
+
+        function renderGitIgnoreConfig() {
+            const strategySelect = document.getElementById('git-ignore-strategy');
+            const rulesTextarea = document.getElementById('git-ignore-rules');
+            if (strategySelect) strategySelect.value = lastGitIgnoreConfig.strategy;
+            if (rulesTextarea) rulesTextarea.value = lastGitIgnoreConfig.rules.join('\n');
+            updateGitIgnoreTargetStatus();
+        }
@@
         document.getElementById('btn-save-startup')?.addEventListener('click', () => {
             const accurateCodingEnabled = !!document.getElementById('accurate-coding-toggle')?.checked;
             const advancedReviewerEnabled = !!document.getElementById('advanced-reviewer-toggle')?.checked;
@@
                 visibleAgents: getCustomVisibleAgentsPatch()
             });
         });
+        document.getElementById('git-ignore-strategy')?.addEventListener('change', () => {
+            const strategy = document.getElementById('git-ignore-strategy')?.value || 'localExclude';
+            lastGitIgnoreConfig = { ...lastGitIgnoreConfig, strategy };
+            updateGitIgnoreTargetStatus();
+        });
+        document.getElementById('btn-apply-git-ignore')?.addEventListener('click', () => {
+            const strategy = document.getElementById('git-ignore-strategy')?.value || 'localExclude';
+            const rules = sanitizeGitIgnoreRules(document.getElementById('git-ignore-rules')?.value || '');
+            lastGitIgnoreConfig = { strategy, rules };
+            const applyButton = document.getElementById('btn-apply-git-ignore');
+            if (applyButton) applyButton.textContent = 'APPLYING...';
+            vscode.postMessage({ type: 'updateGitIgnoreConfig', strategy, rules });
+        });
@@
         bindAccordion('setup-toggle', 'startup-fields', 'setup-chevron', () => {
             vscode.postMessage({ type: 'getAccurateCodingSetting' });
             vscode.postMessage({ type: 'getAdvancedReviewerSetting' });
             vscode.postMessage({ type: 'getLeadChallengeSetting' });
             vscode.postMessage({ type: 'getAggressivePairSetting' });
             vscode.postMessage({ type: 'getDesignDocSetting' });
+            vscode.postMessage({ type: 'getGitIgnoreConfig' });
         });
@@
                 case 'designDocSetting': {
                     const toggle = document.getElementById('design-doc-toggle');
                     if (toggle) toggle.checked = !!message.enabled;
                     lastDesignDocLink = message.link || '';
@@
                     }
                     break;
                 }
+                case 'gitIgnoreConfig': {
+                    const strategy = ['localExclude', 'gitignore', 'none'].includes(message.strategy) ? message.strategy : 'localExclude';
+                    const rules = Array.isArray(message.rules)
+                        ? message.rules.map(rule => String(rule).trim()).filter(Boolean)
+                        : ['.switchboard/*', '.agent/*'];
+                    lastGitIgnoreConfig = { strategy, rules };
+                    renderGitIgnoreConfig();
+                    break;
+                }
+                case 'saveGitIgnoreConfigResult': {
+                    const applyButton = document.getElementById('btn-apply-git-ignore');
+                    if (!applyButton) break;
+                    applyButton.textContent = message.success === false ? 'FAILED' : 'APPLIED';
+                    setTimeout(() => {
+                        applyButton.textContent = 'APPLY GIT IGNORE';
+                    }, 1500);
+                    break;
+                }
 ```

- **Edge Cases Handled:** Uses the same setup-panel message loop as existing settings, sanitizes newline-delimited rules, preserves defaults from `package.json`, and keeps the append-only warning visible next to the APPLY action.

#### [MODIFY] `src/services/SetupPanelProvider.ts`

- **Context:** The central setup panel does not talk to `TaskViewerProvider` directly; its messages flow through `SetupPanelProvider._handleMessage()`. Adding the new UI without wiring this router would make the APPLY button inert.
- **Logic:** Add one read path (`getGitIgnoreConfig`) and one write path (`updateGitIgnoreConfig`) in the existing switch, following the same forwarding pattern already used for `saveStartupCommands`, `getCustomAgents`, and `getDefaultPromptOverrides`.
- **Implementation:**

```diff
@@
                 case 'getDesignDocSetting': {
                     const designDocSetting = this._taskViewerProvider.handleGetDesignDocSetting();
                     this._panel.webview.postMessage({
                         type: 'designDocSetting',
                         enabled: designDocSetting.enabled,
                         link: designDocSetting.link
                     });
                     break;
                 }
+                case 'getGitIgnoreConfig': {
+                    const config = this._taskViewerProvider.handleGetGitIgnoreConfig();
+                    this._panel.webview.postMessage({ type: 'gitIgnoreConfig', ...config });
+                    break;
+                }
                 case 'getDefaultPromptOverrides': {
                     const overrides = await this._taskViewerProvider.handleGetDefaultPromptOverrides();
                     this._panel.webview.postMessage({ type: 'defaultPromptOverrides', overrides });
                     break;
                 }
+                case 'updateGitIgnoreConfig':
+                    await this._taskViewerProvider.handleSaveGitIgnoreConfig(message);
+                    await vscode.commands.executeCommand('switchboard.refreshUI');
+                    break;
                 case 'saveDefaultPromptOverrides':
                     await this._taskViewerProvider.handleSaveDefaultPromptOverrides(message);
                     await vscode.commands.executeCommand('switchboard.refreshUI');
                     break;
```

- **Edge Cases Handled:** Keeps all setup-panel saves on the same provider path, avoids adding dead sidebar-only message handlers, and refreshes both setup-panel + sidebar state after save using the existing `switchboard.refreshUI` command.

#### [MODIFY] `src/services/TaskViewerProvider.ts`

- **Context:** `TaskViewerProvider` already owns shared configuration persistence (`handleSaveStartupCommands`) and setup-panel state broadcasting (`postSetupPanelState`). Git-ignore settings should follow that same pattern instead of being bolted into the sidebar webview switch.
- **Logic:**
  1. Add `handleGetGitIgnoreConfig()` to read and sanitize the current `switchboard.workspace` settings with `package.json` defaults.
  2. Add `handleSaveGitIgnoreConfig()` to validate `strategy`, sanitize `rules`, persist both settings, and post success/failure feedback back to any open webviews.
  3. Extend `postSetupPanelState()` so the setup panel receives `gitIgnoreConfig` during `ready` / refresh cycles.
  4. **Clarification:** Do not add `updateGitIgnoreConfig` to the sidebar `onDidReceiveMessage` switch unless `src/webview/implementation.html` begins posting that message in the future.
- **Implementation:**

```diff
@@
     public async handleGetDbPath(workspaceRoot?: string): Promise<{ path: string; workspaceRoot: string }> {
         const resolvedWorkspaceRoot = this._resolveWorkspaceRoot(workspaceRoot) || '';
         const config = vscode.workspace.getConfiguration('switchboard');
         const configuredPath = config.get<string>('kanban.dbPath', '');
         return {
             path: configuredPath || '.switchboard/kanban.db',
             workspaceRoot: resolvedWorkspaceRoot
         };
     }
+
+    public handleGetGitIgnoreConfig(): { strategy: 'localExclude' | 'gitignore' | 'none'; rules: string[] } {
+        const config = vscode.workspace.getConfiguration('switchboard.workspace');
+        const rawStrategy = config.get<string>('ignoreStrategy', 'localExclude');
+        const strategy = rawStrategy === 'gitignore' || rawStrategy === 'none' ? rawStrategy : 'localExclude';
+        const rawRules = config.get<string[]>('ignoreRules', ['.switchboard/*', '.agent/*']);
+        const rules = Array.isArray(rawRules)
+            ? rawRules.map(rule => String(rule).trim()).filter(Boolean)
+            : ['.switchboard/*', '.agent/*'];
+        return { strategy, rules };
+    }
+
+    public async handleSaveGitIgnoreConfig(data: any): Promise<void> {
+        const allowedStrategies = new Set(['localExclude', 'gitignore', 'none']);
+        const strategy = allowedStrategies.has(data?.strategy) ? data.strategy : 'localExclude';
+        const rules = Array.isArray(data?.rules)
+            ? Array.from(new Set(data.rules.map((rule: unknown) => String(rule).trim()).filter(Boolean)))
+            : [];
+
+        try {
+            const config = vscode.workspace.getConfiguration('switchboard.workspace');
+            await config.update('ignoreStrategy', strategy, vscode.ConfigurationTarget.Workspace);
+            await config.update('ignoreRules', rules, vscode.ConfigurationTarget.Workspace);
+            this._postSharedWebviewMessage({ type: 'gitIgnoreConfig', strategy, rules });
+            this._postSharedWebviewMessage({ type: 'saveGitIgnoreConfigResult', success: true });
+        } catch (error) {
+            console.error('[Switchboard] Failed to save git ignore config:', error);
+            this._postSharedWebviewMessage({ type: 'saveGitIgnoreConfigResult', success: false });
+            throw error;
+        }
+    }
@@
         const designDocSetting = this.handleGetDesignDocSetting();
         this._setupPanelProvider.postMessage({
             type: 'designDocSetting',
             enabled: designDocSetting.enabled,
             link: designDocSetting.link
         });
+
+        const gitIgnoreConfig = this.handleGetGitIgnoreConfig();
+        this._setupPanelProvider.postMessage({ type: 'gitIgnoreConfig', ...gitIgnoreConfig });
 
         const overrides = await this.handleGetDefaultPromptOverrides(workspaceRoot);
         this._setupPanelProvider.postMessage({ type: 'defaultPromptOverrides', overrides });
```

- **Edge Cases Handled:** Uses the canonical defaults from `package.json` / `WorkspaceExcludeService`, rejects invalid strategies, deduplicates rules, and centralizes success/failure feedback so the setup panel can recover cleanly after validation or write errors.

#### [MODIFY] `src/extension.ts`

- **Context:** The current `onDidChangeConfiguration` listener runs `excludeService.apply()` immediately for every `switchboard.workspace` change. That is too eager for a single UI action that must update two related settings.
- **Logic:** Debounce the ignore-setting listener so sequential `ignoreStrategy` + `ignoreRules` updates collapse into one `WorkspaceExcludeService.apply()` run. Keep the startup-time `excludeService.apply()` call unchanged.
- **Implementation:**

```diff
@@
     if (workspaceRoot) {
         const excludeService = new WorkspaceExcludeService(workspaceRoot);
+        let pendingWorkspaceExcludeApply: ReturnType<typeof setTimeout> | undefined;
+        const scheduleWorkspaceExcludeApply = () => {
+            if (pendingWorkspaceExcludeApply) {
+                clearTimeout(pendingWorkspaceExcludeApply);
+            }
+            pendingWorkspaceExcludeApply = setTimeout(() => {
+                pendingWorkspaceExcludeApply = undefined;
+                excludeService.apply().catch(err => {
+                    console.warn('[Switchboard] Workspace exclusion re-evaluation error:', err);
+                });
+            }, 75);
+        };
+
         excludeService.apply().catch(err => {
             console.warn('[Switchboard] Workspace exclusion setup error:', err);
         });
 
         context.subscriptions.push(
             vscode.workspace.onDidChangeConfiguration(e => {
-                if (e.affectsConfiguration('switchboard.workspace')) {
-                    excludeService.apply().catch(err => {
-                        console.warn('[Switchboard] Workspace exclusion re-evaluation error:', err);
-                    });
+                if (
+                    e.affectsConfiguration('switchboard.workspace.ignoreStrategy')
+                    || e.affectsConfiguration('switchboard.workspace.ignoreRules')
+                ) {
+                    scheduleWorkspaceExcludeApply();
                 }
             })
         );
+        context.subscriptions.push(new vscode.Disposable(() => {
+            if (pendingWorkspaceExcludeApply) {
+                clearTimeout(pendingWorkspaceExcludeApply);
+            }
+        }));
     }
```

- **Edge Cases Handled:** Prevents double-apply writes from one save action, keeps startup initialization intact, and narrows the listener to the two settings that actually drive `WorkspaceExcludeService`.

#### [NO CHANGE] `src/services/WorkspaceExcludeService.ts`

- **Context:** Inspected current service behavior. It already reads `switchboard.workspace.ignoreStrategy` / `ignoreRules`, creates `.git/info/exclude` or `.gitignore` as needed, and appends only missing lines.
- **Logic:** No service rewrite is required for this plan. The UI must faithfully represent the current append-only semantics instead of changing them.
- **Implementation:** No code change required in this file for this plan.
- **Edge Cases Handled:** Avoids unplanned product-scope expansion into block-rewrite/synchronization semantics.

> [!NOTE]
> The preserved draft below references `src/webview/implementation.html` from an older pre-migration assumption. Keep it for history, but treat the current-codebase corrections above as authoritative for implementation.

### Webview UI & Logic

#### [MODIFY] `src/webview/implementation.html`

**Change 1 — Add HTML section to SETUP panel (after line 1727, before SAVE CONFIGURATION button at line 1728)**

- **Context:** The SETUP panel in the sidebar (`id="startup-fields"`) contains various configuration toggles (accurate coding, advanced reviewer, lead challenge, aggressive pair, design doc). The git ignore strategy section should appear after all existing toggles and before the SAVE CONFIGURATION button, as a separate subsection with its own APPLY action (it writes to disk, unlike the other toggles which only update settings on SAVE).
- **Logic:** Insert a new subsection with:
  1. A `GIT IGNORE STRATEGY` section label (matches the existing `PROMPT CONTROLS` label style)
  2. A `<select>` dropdown for strategy (`localExclude`, `gitignore`, `none`)
  3. A `<textarea>` for editing ignore rules (one glob pattern per line)
  4. A status line showing the target file path (updates dynamically when strategy changes)
  5. An APPLY button that sends the config to the extension
- **Implementation:**

Find (lines 1726–1728):
```html
                    <span>Aggressive pair programming (shift more tasks to Coder)</span>
                </label>
                <button id="btn-save-startup" class="secondary-btn w-full"
```

Replace with:
```html
                    <span>Aggressive pair programming (shift more tasks to Coder)</span>
                </label>
                <div
                    style="font-size: 10px; color: var(--text-secondary); margin: 14px 0 4px; font-family: var(--font-mono); letter-spacing: 1px;">
                    GIT IGNORE STRATEGY</div>
                <div class="startup-row" style="display:flex; align-items:center; gap:8px;">
                    <label style="min-width:70px; font-size:11px;">Strategy</label>
                    <select id="git-ignore-strategy" style="flex:1; background:var(--input-bg); color:var(--text-primary); border:1px solid var(--border); border-radius:4px; padding:4px 6px; font-size:11px; font-family:var(--font-mono);">
                        <option value="localExclude">localExclude — .git/info/exclude (local only)</option>
                        <option value="gitignore">gitignore — .gitignore (committed to repo)</option>
                        <option value="none">none — manual management only</option>
                    </select>
                </div>
                <div class="startup-row" style="display:flex; flex-direction:column; gap:4px;">
                    <label style="font-size:11px;">Ignore Rules (one pattern per line)</label>
                    <textarea id="git-ignore-rules"
                        style="width:100%; min-height:60px; background:var(--input-bg); color:var(--text-primary); border:1px solid var(--border); border-radius:4px; padding:6px; font-size:11px; font-family:var(--font-mono); resize:vertical; box-sizing:border-box;"
                        placeholder=".switchboard/*&#10;.agent/*"></textarea>
                </div>
                <div id="git-ignore-target-status"
                    style="font-size:10px; color:var(--text-secondary); margin-top:2px; font-family:var(--font-mono);">
                    Target: .git/info/exclude
                </div>
                <button id="btn-apply-git-ignore" class="secondary-btn w-full" style="margin-top:4px;">APPLY GIT IGNORE</button>
                <button id="btn-save-startup" class="secondary-btn w-full"
```

- **Edge Cases Handled:** The `<textarea>` uses `placeholder` with `&#10;` for a multi-line hint. The `<select>` option labels include the target file for clarity. The status indicator is a separate `<div>` that updates dynamically (see Change 2).

---

**Change 2 — Add JavaScript event handlers (after existing event handler block, near the State section around line 2567)**

- **Context:** The webview needs handlers to: (a) update the status indicator when the strategy dropdown changes, (b) send the config to the extension when APPLY is clicked, (c) populate the UI when the extension sends the current config on init.
- **Logic:**
  1. On strategy `<select>` change: update the target status text to show which file will be modified.
  2. On APPLY button click: read the strategy and rules from the UI, split textarea by newlines, filter empty lines, and send a `updateGitIgnoreConfig` message to the extension.
  3. On receiving a `gitIgnoreConfig` message from the extension: populate the dropdown and textarea with the current saved values.
- **Implementation:**

Find (line 2567):
```javascript
        // State
```

Replace with:
```javascript
        // Git Ignore Strategy handlers
        const gitIgnoreStrategySelect = document.getElementById('git-ignore-strategy');
        const gitIgnoreRulesTextarea = document.getElementById('git-ignore-rules');
        const gitIgnoreTargetStatus = document.getElementById('git-ignore-target-status');
        const btnApplyGitIgnore = document.getElementById('btn-apply-git-ignore');

        function updateGitIgnoreTargetStatus() {
            if (!gitIgnoreStrategySelect || !gitIgnoreTargetStatus) return;
            const strategy = gitIgnoreStrategySelect.value;
            const targets = {
                localExclude: '.git/info/exclude',
                gitignore: '.gitignore',
                none: 'No file (manual management)'
            };
            gitIgnoreTargetStatus.textContent = 'Target: ' + (targets[strategy] || strategy);
        }

        if (gitIgnoreStrategySelect) {
            gitIgnoreStrategySelect.addEventListener('change', updateGitIgnoreTargetStatus);
        }

        if (btnApplyGitIgnore) {
            btnApplyGitIgnore.addEventListener('click', () => {
                const strategy = gitIgnoreStrategySelect ? gitIgnoreStrategySelect.value : 'localExclude';
                const rulesText = gitIgnoreRulesTextarea ? gitIgnoreRulesTextarea.value : '';
                const rules = rulesText.split('\n').map(r => r.trim()).filter(r => r.length > 0);
                vscode.postMessage({ type: 'updateGitIgnoreConfig', strategy, rules });
                btnApplyGitIgnore.textContent = 'APPLIED';
                setTimeout(() => { btnApplyGitIgnore.textContent = 'APPLY GIT IGNORE'; }, 1500);
            });
        }

        // State
```

- **Edge Cases Handled:** Empty lines and whitespace-only lines are filtered out when splitting the textarea. If the textarea is empty, an empty array is sent (which is valid — `WorkspaceExcludeService` will have no rules to append). The APPLY button shows brief "APPLIED" feedback following the same pattern as the SAVE CONFIGURATION button (line 2529).

---

**Change 3 — Add message handler for `gitIgnoreConfig` in the webview message switch (inside the `window.addEventListener('message', ...)` handler)**

- **Context:** When the extension sends the current git ignore config (on init or after save), the webview must populate the dropdown and textarea.
- **Logic:** Add a new case `'gitIgnoreConfig'` that sets the dropdown value and textarea content.
- **Implementation:**

This change should be added inside the existing `window.addEventListener('message', function (event) { ... })` handler's switch statement. The exact insertion point is after an existing case block (e.g., after the `'visibleAgents'` case around line 2928).

Find (lines 2928–2930):
```javascript
                    break;
                case 'customAgents':
```

Replace with:
```javascript
                    break;
                case 'gitIgnoreConfig':
                    if (message.strategy && gitIgnoreStrategySelect) {
                        gitIgnoreStrategySelect.value = message.strategy;
                    }
                    if (message.rules && gitIgnoreRulesTextarea) {
                        gitIgnoreRulesTextarea.value = Array.isArray(message.rules) ? message.rules.join('\n') : '';
                    }
                    updateGitIgnoreTargetStatus();
                    break;
                case 'customAgents':
```

- **Edge Cases Handled:** Null-checks on both DOM elements. Falls back to empty string if `rules` is not an array. Calls `updateGitIgnoreTargetStatus()` to sync the status indicator with the received strategy value.

---

### Extension Backend

#### [MODIFY] `src/services/TaskViewerProvider.ts`

**Change 4 — Add `updateGitIgnoreConfig` message handler (inside the `onDidReceiveMessage` switch, after the `saveStartupCommands` case block)**

- **Context:** The webview sends `updateGitIgnoreConfig` with `{ strategy, rules }` when the user clicks APPLY. The handler must update the VS Code workspace settings `switchboard.workspace.ignoreStrategy` and `switchboard.workspace.ignoreRules`. No direct call to `WorkspaceExcludeService` is needed — the existing `onDidChangeConfiguration` listener in `src/extension.ts` (lines 939–946) already watches for `switchboard.workspace` config changes and triggers `excludeService.apply()` automatically.
- **Logic:**
  1. Read `data.strategy` (string) and `data.rules` (string array) from the message.
  2. Update both VS Code workspace settings using `ConfigurationTarget.Workspace`.
  3. Send a confirmation message back to the webview (optional — the APPLY button already shows feedback).
- **Implementation:**

Find (line 3438):
```typescript
                        break;
                    case 'fetchNotionContent': {
```

Replace with:
```typescript
                        break;
                    case 'updateGitIgnoreConfig': {
                        try {
                            const wsConfig = vscode.workspace.getConfiguration('switchboard.workspace');
                            if (typeof data.strategy === 'string') {
                                await wsConfig.update('ignoreStrategy', data.strategy, vscode.ConfigurationTarget.Workspace);
                            }
                            if (Array.isArray(data.rules)) {
                                await wsConfig.update('ignoreRules', data.rules, vscode.ConfigurationTarget.Workspace);
                            }
                            this._view?.webview.postMessage({ type: 'gitIgnoreConfigResult', success: true });
                        } catch (err) {
                            console.error('[Switchboard] Failed to update git ignore config:', err);
                            this._view?.webview.postMessage({ type: 'gitIgnoreConfigResult', success: false });
                        }
                        break;
                    }
                    case 'fetchNotionContent': {
```

- **Edge Cases Handled:** Type-checks `data.strategy` (string) and `data.rules` (array) before updating. Wraps in try/catch to prevent unhandled rejections. The VS Code config update triggers the existing `onDidChangeConfiguration` listener in `extension.ts`, which calls `WorkspaceExcludeService.apply()` — no duplicate instantiation needed.

---

**Change 5 — Send git ignore config to webview on init (inside the `ready` handler, after the existing settings push block)**

- **Context:** The `ready` handler in the `onDidReceiveMessage` switch (lines 3103–3136) sends initial state and toggle settings to the webview. The git ignore config should be sent here so the UI is populated on load.
- **Logic:** Read `switchboard.workspace.ignoreStrategy` and `switchboard.workspace.ignoreRules` from VS Code config and send a `gitIgnoreConfig` message.
- **Implementation:**

Find (lines 3133–3135):
```typescript
                        // Push default prompt overrides
                        this._cachedDefaultPromptOverrides = await this._getDefaultPromptOverrides();
                        this._view?.webview.postMessage({ type: 'defaultPromptOverrides', overrides: this._cachedDefaultPromptOverrides });
```

Replace with:
```typescript
                        // Push git ignore config
                        {
                            const wsConfig = vscode.workspace.getConfiguration('switchboard.workspace');
                            this._view?.webview.postMessage({
                                type: 'gitIgnoreConfig',
                                strategy: wsConfig.get<string>('ignoreStrategy', 'localExclude'),
                                rules: wsConfig.get<string[]>('ignoreRules', ['.switchboard/*', '.agent/*'])
                            });
                        }
                        // Push default prompt overrides
                        this._cachedDefaultPromptOverrides = await this._getDefaultPromptOverrides();
                        this._view?.webview.postMessage({ type: 'defaultPromptOverrides', overrides: this._cachedDefaultPromptOverrides });
```

- **Edge Cases Handled:** Uses defaults (`'localExclude'` and `['.switchboard/*', '.agent/*']`) matching the `WorkspaceExcludeService` constructor defaults (line 12–13 of `WorkspaceExcludeService.ts`). The block scope `{ }` prevents variable name collisions with other config reads in the same handler.

---

## UI Design

```
GIT IGNORE STRATEGY
┌─────────────────────────────────────┐
│ Strategy: [localExclude ▼]          │
│                                     │
│ Ignore Rules (one pattern per line):│
│ ┌─────────────────────────────────┐ │
│ │ .switchboard/*                  │ │
│ │ .agent/*                        │ │
│ │                                 │ │
│ └─────────────────────────────────┘ │
│                                     │
│ Target: .git/info/exclude           │
│                                     │
│ [APPLY GIT IGNORE]                  │
└─────────────────────────────────────┘
```

---

## Files to Modify

**Clarification — authoritative current-codebase file set:** `src/webview/setup.html`, `src/services/SetupPanelProvider.ts`, `src/services/TaskViewerProvider.ts`, and `src/extension.ts`. `src/webview/implementation.html` and `src/services/WorkspaceExcludeService.ts` were inspected and intentionally remain unchanged.
**Clarification:** The preserved draft blocks above are historical context only; use the authoritative file set below for implementation and review.

| File | Changes |
|------|---------|
| `src/webview/setup.html` | Add the git-ignore subsection, local UI state, APPLY flow, accordion refresh request, and message handlers — **1 coordinated change cluster** |
| `src/services/SetupPanelProvider.ts` | Route `getGitIgnoreConfig` and `updateGitIgnoreConfig` through the central setup-panel message switch — **1 change cluster** |
| `src/services/TaskViewerProvider.ts` | Add shared get/save helpers and broadcast `gitIgnoreConfig` during setup-panel state refresh — **1 change cluster** |
| `src/extension.ts` | Debounce/coalesce ignore-setting change reactions so one APPLY click produces one `WorkspaceExcludeService.apply()` pass — **1 change cluster** |

**Total: 4 files with one coordinated setup-panel feature path.**

---

## Verification Plan

### Automated Tests
- Run `npx tsc --noEmit`
- Run `npm run compile`
- Preserve the draft's original verification intent by confirming the saved config is broadcast back to the setup panel during `ready` / refresh initialization; no existing dedicated automated test currently covers this setup-panel flow

### Manual Verification
- [ ] Open the central SETUP panel via the sidebar `OPEN SETUP` button; confirm the new GIT IGNORE STRATEGY subsection appears in `src/webview/setup.html` after "Aggressive pair programming" and before `SAVE CONFIGURATION`.
- [ ] Strategy dropdown defaults to `localExclude` and shows `localExclude`, `gitignore`, and `none`.
- [ ] Textarea hydrates from the saved `switchboard.workspace.ignoreRules` array using one rule per line.
- [ ] Target status line updates immediately when the strategy changes, and the append-only warning remains visible next to the APPLY action.
- [ ] Clicking APPLY updates both VS Code workspace settings (`switchboard.workspace.ignoreStrategy`, `switchboard.workspace.ignoreRules`) and returns `APPLIED` / `FAILED` feedback without freezing the setup panel.
- [ ] Changing both strategy and rules in one APPLY action results in one coalesced `WorkspaceExcludeService.apply()` pass (no stale default-rule write before the final config lands).
- [ ] Switching strategy from `localExclude` to `gitignore` and clicking APPLY writes to `.gitignore`; selecting `none` does not modify any ignore file.
- [ ] Empty textarea yields an empty rules array without throwing, and blank lines / trailing whitespace are stripped.
- [ ] Existing prompt-control toggles and `SAVE CONFIGURATION` still behave exactly as before.

---

## Adversarial Synthesis

### Grumpy Critique

> Oh good, another draft that thinks the SETUP UI still lives in `src/webview/implementation.html`. It does not. That file has an `OPEN SETUP` launcher and zero prompt-control toggles. If you implement the stale draft literally, you will create a second config editor in the sidebar and guarantee drift from the real setup surface in `src/webview/setup.html`.
>
> And no, you do **not** wire this through the sidebar `TaskViewerProvider` message switch just because it's nearby. The central setup editor talks through `src/services/SetupPanelProvider.ts`. Wrong receiver, wrong code path, dead button.
>
> The truly nasty bug is the config-write sequencing. `src/extension.ts` currently calls `excludeService.apply()` on **every** `switchboard.workspace` change. One APPLY click that saves `ignoreStrategy` and `ignoreRules` in sequence can fire the service twice: once with half-updated state and once with the final state. That is how you append stale defaults to the wrong file and then spend an afternoon insisting the service is "idempotent."
>
> Also, `WorkspaceExcludeService` is append-only. Changing rules does not delete old lines. Switching strategy does not clean up the previous target. If the UI copy doesn't say that explicitly, users will assume APPLY is a full sync and file a bug the first time they see old junk still sitting in `.gitignore`.
>
> And please stop claiming "no conflicts" after a lazy glance. The active `Feature Plan: Add Acceptance Tester Role` also edits `src/services/TaskViewerProvider.ts`. That is a real New/Planned merge hotspot, even if the product behavior is unrelated.

### Balanced Response

The critique is valid, and the hardened plan now treats the current codebase as the authority instead of following the stale draft blindly:

1. The implementation surface is corrected to `src/webview/setup.html`, with `src/webview/implementation.html` explicitly inspected and intentionally left unchanged except for its existing `OPEN SETUP` launcher behavior.
2. Setup-panel message routing is corrected to `src/services/SetupPanelProvider.ts`, while `src/services/TaskViewerProvider.ts` provides the shared get/save helpers and state broadcast for the new config payload.
3. The plan now explicitly hardens `src/extension.ts` with a debounce/coalescing step so one APPLY action does not trigger two exclusion writes from partially updated config.
4. The UI copy is required to surface the existing append-only behavior as a **Clarification**, preventing the plan from accidentally promising cleanup or full synchronization.
5. The dependency audit now calls out the only active merge hotspot (`Feature Plan: Add Acceptance Tester Role` in `src/services/TaskViewerProvider.ts`), flags the low-risk shared-file overlap with `Fix Team Lead UI Visibility` in `src/webview/setup.html`, and states explicitly that no other New/Planned conflicts were found.

---

## Recommended Agent

**Send to Coder** (Complexity 5 — multi-file setup-panel wiring plus one debounced config-listener hardening step, but all changes follow established webview ↔ provider patterns)

---

## Reviewer Execution Pass

### Stage 1 - Grumpy Principal Engineer

> The code at least landed in the correct surface this time: `src/webview/setup.html` and `src/services/SetupPanelProvider.ts`, not the stale sidebar launcher path. The APPLY button is disabled while the save is in flight, the setup-panel message routing exists, and `TaskViewerProvider` sanitizes both strategy and rules before persisting.
>
> I went looking for the material ways this could still be wrong against the plan: stale `implementation.html` wiring, missing setup-panel hydration, missing append-only warning copy, or the two-write config race that would append defaults into the wrong file. I did not find a plan-breaking miss. `src/extension.ts` now scopes the listener to `switchboard.workspace.ignoreStrategy` / `ignoreRules` and debounces re-apply, which is the exact hardening this plan called for.
>
> The remaining complaint is about verification depth, not a blocker in the reviewed code. There is still no automated test that exercises the actual setup-panel APPLY path or proves one UI save yields one `WorkspaceExcludeService.apply()` execution under real VS Code config events. Repo-wide validation also is not green: `npx tsc --noEmit` currently fails in `src/services/KanbanProvider.ts`, and `npm run lint` fails because the repo does not have the ESLint flat-config file ESLint v9 expects. Those failures appear outside this plan, but they are still real risks.

### Stage 2 - Balanced Synthesis

The implementation matches the authoritative feature path from this plan. The UI lives in `src/webview/setup.html`, routes through `src/services/SetupPanelProvider.ts`, uses shared get/save helpers in `src/services/TaskViewerProvider.ts`, and leaves `WorkspaceExcludeService` as the only ignore-file writer. The planned behavior is present: config sanitization, append-only warning copy, `.gitignore` committed-file hint, setup-panel hydration, disabled APPLY feedback, and debounced ignore-setting change handling in `src/extension.ts`.

No material defect was found that justified changing product code during this review pass. I therefore left the implementation intact and limited edits to this plan file so the review record reflects the actual inspection and validation evidence. Remaining risk is concentrated in verification depth rather than obvious implementation mismatch: there is still no dedicated automated test for the setup-panel APPLY path or the coalesced single-apply behavior, and unrelated repo-wide validation failures remain outstanding.

### Fixed Items

- None. No material implementation defects were identified in the reviewed feature path, so no product code changes were made during this reviewer-executor pass.

### Files Changed During Review Pass

- `.switchboard/plans/add_git_ignore_ui_to_setup_menu.md` — appended reviewer execution findings, validation results, and remaining risks.

### Validation Results

- `npx tsc --noEmit` ❌
  - Failed with: `src/services/KanbanProvider.ts:2197:57 - error TS2835: Relative import paths need explicit file extensions ... Did you mean './ArchiveManager.js'?`
  - This failure is outside the reviewed git-ignore setup-panel files.
- `npm run compile` ✅
  - Webpack completed successfully for both the extension bundle and MCP server bundle.
- `npm run lint` ❌
  - Failed with: `ESLint couldn't find an eslint.config.(js|mjs|cjs) file.`
  - This is a repo-level lint configuration issue, not a defect in the reviewed feature path.

### Remaining Risks

- No dedicated automated test currently covers the central setup-panel `APPLY GIT IGNORE` flow or proves a single UI save collapses to one `WorkspaceExcludeService.apply()` execution.
- Repo-wide validation is not fully green because `npx tsc --noEmit` and `npm run lint` currently fail for reasons outside this plan's implementation surface.
- `src/services/TaskViewerProvider.ts` remains a known merge hotspot called out by the plan, so concurrent work there still carries integration risk.
