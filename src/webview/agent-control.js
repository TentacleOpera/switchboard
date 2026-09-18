// ── Agent Control panel (extracted from kanban.html) ──────────────────────
// Carries the Agents, Teams, Prompts and Standing Orders tabs as a first-class
// panel. See .switchboard/plans/extract-agent-control-into-its-own-panel-file.md.
//
// This file is the companion script for agent-control.html, loaded after
// sharedDefaults.js + clipboardFallback.js + transport.js (injected by the host
// via injectTransportShim) and sharedUtils.js (loaded by the HTML).

(function() {
    const vscode = acquireVsCodeApi();

    // Revived panels boot as a NEW webview (see utils/reviveWithRetention), so
    // getState() is undefined and every setState-persisted preference would silently
    // reset on each window reload. The host inlines the pre-reload payload into a
    // <meta name="sb-initial-state"> tag. Seed it once, before the first getState() read.
    try {
        if (vscode.getState() === undefined) {
            const _sbSeedEl = document.querySelector('meta[name="sb-initial-state"]');
            if (_sbSeedEl && _sbSeedEl.content) {
                vscode.setState(JSON.parse(_sbSeedEl.content));
            }
        }
    } catch (_) {}

    // CSS.escape polyfill for handling special characters in DOM lookups
    if (!window.CSS) { window.CSS = {}; }
    if (!window.CSS.escape) {
        window.CSS.escape = function(value) {
            return String(value).replace(/([^\w-])/g, '\\$1');
        };
    }

    // ── Forward-declare variables used by message handlers ────────────────
    let lastCustomAgents = [];

    // ── Helpers (board counterparts at kanban.html:7660, 7675, 8263) ───────
    // getActiveWorkspaceRoot: the board reads currentWorkspaceRoot/workspaceItems;
    // the agent-control panel has no workspace selector — the host stamps the
    // initial workspace root as a body data-attribute (URI-encoded), so that is
    // the only source.
    function getActiveWorkspaceRoot() {
        return decodeURIComponent(document.body.dataset.initialWorkspaceRoot || '');
    }

    // postKanbanMessage: the board stamps initiatorProject (boardProjectFilter);
    // the agent-control panel has no project filter, so that stamp is omitted.
    function postKanbanMessage(message) {
        vscode.postMessage({
            ...message,
            workspaceRoot: message.workspaceRoot || getActiveWorkspaceRoot(),
        });
    }

    function showStatusBarMessage(text, { isError = false } = {}) {
        const statusEl = document.getElementById('status-message');
        if (!statusEl) return;
        statusEl.textContent = text;
        statusEl.style.color = isError
            ? 'var(--vscode-errorForeground, #ff6b6b)'
            : 'var(--accent-teal)';
        statusEl.style.display = 'inline-block';
        statusEl.classList.remove('flashing');
        void statusEl.offsetWidth;
        statusEl.classList.add('flashing');
        if (statusEl._statusTimeoutId) clearTimeout(statusEl._statusTimeoutId);
        statusEl._statusTimeoutId = setTimeout(() => {
            statusEl.textContent = '';
            statusEl.classList.remove('flashing');
            statusEl._statusTimeoutId = null;
        }, 5000);
    }

    // ── Tooltip overlay system (board counterpart at kanban.html) ────────────
    // Tab markup carries `data-tooltip` attributes (e.g. the pair-programming
    // select), so the panel needs the same delegated hover tooltip.
    const tooltipOverlay = document.getElementById('tooltip-overlay');
    let tooltipTarget = null;

    function showTooltip(el) {
        if (!tooltipOverlay) return;
        const text = el.getAttribute('data-tooltip');
        if (!text) return;
        tooltipTarget = el;
        tooltipOverlay.textContent = text;
        tooltipOverlay.style.left = '-9999px';
        tooltipOverlay.style.top = '-9999px';
        tooltipOverlay.classList.add('visible');
        const rect = el.getBoundingClientRect();
        const tipRect = tooltipOverlay.getBoundingClientRect();
        const viewportW = document.documentElement.clientWidth;
        const GAP = 4;
        let top = rect.top - tipRect.height - GAP;
        if (top < 0) { top = rect.bottom + GAP; }
        let left = rect.left + rect.width / 2 - tipRect.width / 2;
        if (left < 4) left = 4;
        if (left + tipRect.width > viewportW - 4) { left = viewportW - tipRect.width - 4; }
        tooltipOverlay.style.left = left + 'px';
        tooltipOverlay.style.top = top + 'px';
    }

    function hideTooltip() {
        if (!tooltipOverlay) return;
        tooltipOverlay.classList.remove('visible');
        tooltipOverlay.style.left = '-9999px';
        tooltipOverlay.style.top = '-9999px';
        tooltipTarget = null;
    }

    // Delegation via mouseover/mouseout (these bubble, unlike mouseenter/mouseleave)
    document.addEventListener('mouseover', (e) => {
        const el = e.target.closest('[data-tooltip]');
        if (!el) return;
        if (el === tooltipTarget) return;
        hideTooltip();
        showTooltip(el);
    });
    document.addEventListener('mouseout', (e) => {
        const el = e.target.closest('[data-tooltip]');
        if (!el) return;
        const related = e.relatedTarget;
        if (related && el.contains(related)) return;
        hideTooltip();
    });

        // ── PROMPTS TAB ─────────────────────────────────────────────────────────
        const DEFAULT_CONFIG = { ...DEFAULT_ROLE_CONFIG };

        let currentRole = 'planner';
        let roleConfigs = JSON.parse(JSON.stringify(DEFAULT_CONFIG));

        const ROLE_DESCRIPTIONS = {
            planner: 'Writes detailed step-by-step implementation plans and creates work checklists.',
            lead: 'Implements high-complexity files, complex refactors, and core architecture changes.',
            coder: 'Implements low-complexity boilerplate, routine functions, and minor enhancements.',
            intern: 'Executes simple, repetitive code edits and heavily guided tasks at lowest cost.',
            reviewer: 'Evaluates completed implementations against plans, checking for regressions and scope creep.',
            tester: 'Validates implemented changes against the Design Doc/PRD, applies fixes for requirement gaps, and logs verification results.',
            analyst: 'Researches general-purpose technical queries and outlines plan dependencies.',
            ticket_updater: 'Reads a ticket and posts a short triage verdict (severity, area, recommended action, auto/needs-human) back to ClickUp/Linear.',
            researcher: 'Researches general topics and saves results as documents to local docs storage (.switchboard/docs/).',
            jules: 'Offloads tasks to Google Jules cloud-coding service for quota-free background execution.'
        };

        function updateRoleDescription() {
            const descEl = document.getElementById('roleDescription');
            if (descEl) {
                descEl.textContent = ROLE_DESCRIPTIONS[currentRole] || '';
            }
        }

        function loadRoleConfigs() {
            const roles = ROLE_KEYS;
            roles.forEach(role => {
                postKanbanMessage({ type: 'getSetting', key: `roleConfig_${role}` });
            });
            postKanbanMessage({ type: 'getSetting', key: 'selectedRole' });
        }

        function updateCustomAgentsDropdown() {
            const group = document.getElementById('customAgentsGroup');
            if (!group) return;
            group.innerHTML = '';
            lastCustomAgents.forEach(agent => {
                const opt = document.createElement('option');
                opt.value = agent.role || 'custom_agent_' + agent.id;
                opt.textContent = agent.name;
                group.appendChild(opt);
            });
        }

        async function handleRoleChange() {
            const plannerConfig = document.getElementById('plannerConfig');
            const researchComplexityConfig = document.getElementById('researchComplexityConfig');
            const promptCustomization = document.getElementById('promptCustomization');
            if (!plannerConfig || !researchComplexityConfig || !promptCustomization) return;

            plannerConfig.style.display = currentRole === 'planner' ? 'block' : 'none';
            researchComplexityConfig.style.display = currentRole === 'researcher' ? 'block' : 'none';
            promptCustomization.style.display = currentRole === 'planner' ? 'none' : 'block';
            
            const saveToLocalDocsRow = document.getElementById('saveToLocalDocsRow');
            if (saveToLocalDocsRow) {
                saveToLocalDocsRow.style.display = 'none';
            }

            if (currentRole === 'planner') {
                const config = roleConfigs.planner;
                document.getElementById('workflowFilePath').value = config.workflowFilePath || '.agents/protocols/improve-plan/SKILL.md';
                const plannerWorkflowEnabled = config.addons?.workflowFilePathEnabled !== false;
                document.getElementById('plannerWorkflowEnabled').checked = plannerWorkflowEnabled;
                document.getElementById('plannerWorkflowFilePathGroup').style.display = plannerWorkflowEnabled ? 'block' : 'none';
                document.getElementById('plannerAddonSwitchboardSafeguards').checked = config.addons?.switchboardSafeguards !== false;


                document.getElementById('plannerAddonConstitution').checked = !!config.addons?.constitution;
                document.getElementById('plannerAddonDesignSystemDoc').checked = !!config.addons?.designSystemDoc;
                // §Pair-programming team scope: the Aggressive Pair Programming
                // checkbox is retired (pair programming is now a team property).
                // The legacy key is preserved on read in KanbanProvider, so the
                // non-team path keeps its behaviour; the UI control is gone.
                document.getElementById('plannerAddonGitProhibition').checked = !!config.addons?.gitProhibition;
                document.getElementById('plannerAddonClearAntigravityContext').checked = !!config.addons?.clearAntigravityContext;
                document.getElementById('plannerAddonCavemanOutput').checked = !!config.addons?.cavemanOutput;
                document.getElementById('plannerAddonSkipCompilation').checked = !!config.addons?.skipCompilation;
                document.getElementById('plannerAddonSkipTests').checked = !!config.addons?.skipTests;
                document.getElementById('plannerAddonAdviseResearch').checked = config.addons?.adviseResearch !== false;
                document.getElementById('plannerAddonWriteFeatureDescriptionIfEmpty').checked = config.addons?.writeFeatureDescriptionIfEmpty !== false;
                // Load subagent policy radio for planner
                const plannerSubagentPolicy = config.addons?.subagentPolicy || 'default';
                const plannerSubagentRadios = document.getElementsByName('plannerSubagentPolicy');
                plannerSubagentRadios.forEach(radio => { radio.checked = radio.value === plannerSubagentPolicy; });
                const plannerCustomNameInput = document.getElementById('plannerAddonCustomSubagentName');
                if (plannerCustomNameInput) {
                    plannerCustomNameInput.style.display = plannerSubagentPolicy === 'customSubagent' ? 'inline-block' : 'none';
                    plannerCustomNameInput.value = config.addons?.customSubagentName || '';
                }

                // Load feature workflow path and feature subagent settings for planner
                document.getElementById('plannerFeatureWorkflowFilePath').value = config.addons?.featureWorkflowFilePath || '.agents/protocols/improve-feature/SKILL.md';
                const plannerFeatureWorkflowEnabled = config.addons?.featureWorkflowFilePathEnabled === true;
                document.getElementById('plannerFeatureWorkflowEnabled').checked = plannerFeatureWorkflowEnabled;
                document.getElementById('plannerFeatureWorkflowFilePathGroup').style.display = plannerFeatureWorkflowEnabled ? 'block' : 'none';

                const plannerFeatureSubagentPolicy = config.addons?.featureSubagentPolicy || 'default';
                const plannerFeatureSubagentRadios = document.getElementsByName('plannerFeatureSubagentPolicy');
                plannerFeatureSubagentRadios.forEach(radio => { radio.checked = radio.value === plannerFeatureSubagentPolicy; });
                const plannerFeatureCustomNameInput = document.getElementById('plannerFeatureCustomSubagentName');
                if (plannerFeatureCustomNameInput) {
                    plannerFeatureCustomNameInput.style.display = plannerFeatureSubagentPolicy === 'customSubagent' ? 'inline-block' : 'none';
                    plannerFeatureCustomNameInput.value = config.addons?.featureCustomSubagentName || '';
                }
            } else if (currentRole === 'researcher') {
                const config = roleConfigs[currentRole] || { prompt: '', addons: {} };
                const complexity = config.researchComplexity || 'deep';
                const radio = document.querySelector(`input[name="researchComplexity"][value="${complexity}"]`);
                if (radio) radio.checked = true;

                const saveToLocalDocsRow = document.getElementById('saveToLocalDocsRow');
                if (saveToLocalDocsRow) {
                    saveToLocalDocsRow.style.display = 'block';
                    document.getElementById('saveToLocalDocs').checked = !!config.saveToLocalDocs;
                }
                renderRoleAddons(currentRole);
            } else {
                renderRoleAddons(currentRole);
            }

            const previewEl = document.getElementById('promptPreview');
            if (previewEl) {
                previewEl.readOnly = (currentRole === 'planner');
            }

            refreshPreview();
        }
        function renderRoleAddons(role) {
            const group = document.getElementById('roleAddonsGroup');
            const desc = document.getElementById('roleAddonsDesc');
            if (!group || !desc) return;
            group.innerHTML = '';

            let addons = ROLE_ADDONS[role] || [];
            if (addons.length === 0 && role.startsWith('custom_agent_')) {
                // Custom agents receive the guardrail + the three granular git-policy
                // radios (Branch/Commit/Push) with work-on-main defaults, plus the
                // custom-agent-specific add-ons. Parity with built-in code roles.
                addons = [
                    { id: 'gitProhibition', label: 'Git Safety Guardrail', tooltip: 'Permit worktrees & commits; block destructive undo (reset/checkout/clean) and unclean deletions', default: true },
                    { id: 'gitBranchStrategy', label: 'Git Branch Strategy', tooltip: 'Prescriptive branch directive emitted in the GIT POLICY block', type: 'radio', default: 'notSpecified', group: 'git', options: [
                        { value: 'current', label: 'Current Branch', tooltip: 'Do all work on the current branch; do NOT create new branches or worktrees' },
                        { value: 'newBranch', label: 'New Branch', tooltip: 'Create ONE descriptively-named branch for this task and do all work on it' },
                        { value: 'notSpecified', label: 'Not Specified', tooltip: 'Emit no branch clause' }
                    ] },
                    { id: 'gitCommitStrategy', label: 'Git Commit Strategy', tooltip: 'Prescriptive commit directive emitted in the GIT POLICY block', type: 'radio', default: 'notSpecified', group: 'git', options: [
                        { value: 'whenDone', label: 'Commit When Done', tooltip: 'Stage all changes and create a single descriptive commit when the task is finished' },
                        { value: 'dontCommit', label: 'Do Not Commit', tooltip: 'Leave all changes in the working tree for the user to review' },
                        { value: 'notSpecified', label: 'Not Specified', tooltip: 'Emit no commit clause' }
                    ] },
                    { id: 'gitPushStrategy', label: 'Git Push Strategy', tooltip: 'Prescriptive push directive emitted in the GIT POLICY block', type: 'radio', default: 'notSpecified', group: 'git', options: [
                        { value: 'noPush', label: 'Do Not Push', tooltip: 'Do NOT push to any remote' },
                        { value: 'pushWhenDone', label: 'Push When Done', tooltip: 'After committing, push the working branch to its remote. Do not force-push.' },
                        { value: 'notSpecified', label: 'Not Specified', tooltip: 'Emit no push clause' }
                    ] },
                    { id: 'workflowFilePath', label: 'Workflow File', tooltip: 'Read a workflow file and follow it step-by-step', type: 'file', default: false },
                    { id: 'useWorktreesPerPlan', label: 'Agent-Managed Worktrees', group: 'features', tooltip: 'Give each subtask its own isolated git worktree to prevent file conflicts. Off = subtasks are implemented in the main working tree. Whether the agent uses subagents is controlled separately by Feature Subagent Policy.', default: false },
                    {
                        id: 'featureSubagentPolicy', label: 'Feature Subagent Policy', tooltip: 'Control how the agent handles subagent spawning for feature dispatches',
                        type: 'radio', group: 'features', default: 'default', options: [
                            { value: 'default', label: 'Not Specified', tooltip: 'Let the execution platform decide subagent behavior' },
                            { value: 'noSubagents', label: 'No Subagents', tooltip: 'Explicitly instruct the agent not to spawn or invoke any subagents' },
                            { value: 'useSubagents', label: 'Yes (Use Subagents)', tooltip: 'Instruct the agent to use parallel subagents when handling multiple plans' },
                            { value: 'customSubagent', label: 'Custom Subagent', tooltip: 'Instruct the agent to use a specific custom subagent', textInputOn: 'customSubagent' }
                        ]
                    },
                    { id: 'featureWorkflowFilePath', label: 'Feature Workflow File', tooltip: 'Read a workflow file and follow it step-by-step for feature dispatches', type: 'file', group: 'features', default: false },
                    { id: 'phoneAFriend', label: 'Phone-a-Friend', tooltip: 'Before expensive review, send the plan through a quick implementation sanity check (requires Phone-a-Friend agent configured)', default: false },
                    { id: 'applyFeatureDirectives', label: 'Apply Feature Ultracode/Goal Directives', group: 'features', tooltip: 'When dispatched on a feature, prepend the board\'s ultracode//goal directives (as for Lead/Coder/Intern)', default: false }
                ];
            }

            if (addons.length === 0) {
                desc.textContent = 'No add-ons available for this role.';
                return;
            }

            desc.textContent = `Build the ${role.charAt(0).toUpperCase() + role.slice(1)} prompt with add-on instructions:`;

            // Helper to render a single addon inside a container
            function renderAddon(addon, role, container) {
                if (addon.type === 'radio' && addon.options) {
                    // Render radio button group
                    const currentValue = roleConfigs[role]?.addons?.[addon.id] ?? addon.default;
                    const wrapper = document.createElement('div');
                    wrapper.className = 'addon-radio-group';
                    wrapper.innerHTML = `<span class="addon-label" style="font-weight:600;margin-bottom:4px;display:block;">${addon.label}</span>`;
                    const textInputsToToggle = [];
                    const targetTextField = addon.id === 'featureSubagentPolicy' ? 'featureCustomSubagentName' : 'customSubagentName';
                    addon.options.forEach(opt => {
                        const label = document.createElement('label');
                        label.className = 'checkbox-item';
                        label.style.display = 'block';
                        label.style.padding = '8px 12px';
                        label.style.marginBottom = '4px';
                        label.title = opt.tooltip || '';
                        label.innerHTML = `
                            <input type="radio" name="addon_${role}_${addon.id}" value="${opt.value}" ${currentValue === opt.value ? 'checked' : ''}>
                            <span class="addon-option-label">${opt.label}</span>
                            ${opt.tooltip ? `<span class="addon-option-desc">${opt.tooltip}</span>` : ''}
                        `;
                        const radioInput = label.querySelector('input');
                        wrapper.appendChild(label);

                        if (opt.textInputOn) {
                            const textInput = document.createElement('input');
                            textInput.type = 'text';
                            textInput.placeholder = 'Custom subagent name...';
                            textInput.style.marginLeft = '22px';
                            textInput.style.marginBottom = '6px';
                            textInput.style.padding = '2px 6px';
                            textInput.style.borderRadius = '4px';
                            textInput.style.border = '1px solid var(--vscode-input-border, #ccc)';
                            textInput.style.background = 'var(--vscode-input-background, #fff)';
                            textInput.style.color = 'var(--vscode-input-foreground, #000)';
                            textInput.style.display = currentValue === opt.textInputOn ? 'inline-block' : 'none';
                            textInput.value = roleConfigs[role]?.addons?.[targetTextField] || '';
                            textInput.className = 'addon-text-input';
                            
                            textInput.addEventListener('input', (e) => {
                                const sanitized = e.target.value.replace(/[^a-zA-Z0-9_]/g, '');
                                e.target.value = sanitized;
                                if (!roleConfigs[role]) roleConfigs[role] = { prompt: '', addons: {} };
                                if (!roleConfigs[role].addons) roleConfigs[role].addons = {};
                                roleConfigs[role].addons[targetTextField] = sanitized;
                                saveRoleConfig(role);
                                refreshPreview();
                            });
                            wrapper.appendChild(textInput);
                            textInputsToToggle.push({ input: textInput, triggerValue: opt.textInputOn });
                        }

                        radioInput.addEventListener('change', (e) => {
                            if (!roleConfigs[role]) roleConfigs[role] = { prompt: '', addons: {} };
                            if (!roleConfigs[role].addons) roleConfigs[role].addons = {};
                            roleConfigs[role].addons[addon.id] = e.target.value;

                            let isTextInputOptionSelected = false;
                            textInputsToToggle.forEach(ti => {
                                if (e.target.value === ti.triggerValue) {
                                    ti.input.style.display = 'inline-block';
                                    isTextInputOptionSelected = true;
                                } else {
                                    ti.input.style.display = 'none';
                                }
                            });

                            if (!isTextInputOptionSelected) {
                                roleConfigs[role].addons[targetTextField] = '';
                                textInputsToToggle.forEach(ti => {
                                    ti.input.value = '';
                                });
                            }

                            saveRoleConfig(role);
                            refreshPreview();
                        });
                    });
                    container.appendChild(wrapper);
                } else if (addon.type === 'file') {
                    // Checkbox toggles text input visibility
                    const isEnabled = roleConfigs[role]?.addons?.[addon.id + 'Enabled'] ?? addon.default;
                    const pathVal = roleConfigs[role]?.addons?.[addon.id] || '';

                    const wrapper = document.createElement('div');
                    wrapper.className = 'addon-file-group';
                    wrapper.style.marginBottom = '12px';

                    const label = document.createElement('label');
                    label.className = 'checkbox-item';
                    label.title = addon.tooltip;
                    label.innerHTML = `
                        <input type="checkbox" id="addon_${addon.id}_enabled" ${isEnabled ? 'checked' : ''}>
                        <span>${addon.label}</span>
                        <span class="tooltip">${addon.tooltip}</span>
                    `;

                    const textInput = document.createElement('input');
                    textInput.type = 'text';
                    textInput.id = `addon_${addon.id}_path`;
                    textInput.placeholder = 'e.g. .agents/protocols/improve-plan/SKILL.md or a protocol name like accuracy';
                    textInput.style.display = isEnabled ? 'block' : 'none';
                    textInput.style.marginTop = '4px';
                    textInput.style.width = '100%';
                    textInput.style.padding = '4px 8px';
                    textInput.style.borderRadius = '4px';
                    textInput.style.border = '1px solid var(--vscode-input-border, #ccc)';
                    textInput.style.background = 'var(--vscode-input-background, #fff)';
                    textInput.style.color = 'var(--vscode-input-foreground, #000)';
                    textInput.value = pathVal;

                    label.querySelector('input').addEventListener('change', (e) => {
                        const enabled = e.target.checked;
                        textInput.style.display = enabled ? 'block' : 'none';
                        if (!roleConfigs[role]) roleConfigs[role] = { prompt: '', addons: {} };
                        if (!roleConfigs[role].addons) roleConfigs[role].addons = {};
                        roleConfigs[role].addons[addon.id + 'Enabled'] = enabled;
                        saveRoleConfig(role);
                        refreshPreview();
                    });

                    textInput.addEventListener('input', (e) => {
                        if (!roleConfigs[role]) roleConfigs[role] = { prompt: '', addons: {} };
                        if (!roleConfigs[role].addons) roleConfigs[role].addons = {};
                        roleConfigs[role].addons[addon.id] = e.target.value;
                        saveRoleConfig(role);
                        refreshPreview();
                    });

                    wrapper.appendChild(label);
                    wrapper.appendChild(textInput);
                    container.appendChild(wrapper);
                } else {
                    // Existing checkbox rendering
                    let isChecked = roleConfigs[role]?.addons?.[addon.id] ?? addon.default;
                    // Seed checkbox initial state from the agent object for legacy agents.
                    // Guard on key EXISTENCE (undefined), not value-equality with default —
                    // otherwise an explicit `false` written by the user is indistinguishable
                    // from "key absent" and the seed would re-check the checkbox on re-render.
                    if (role.startsWith('custom_agent_') && roleConfigs[role]?.addons?.[addon.id] === undefined) {
                        const agentObj = (typeof lastCustomAgents !== 'undefined' ? lastCustomAgents : [])
                            .find(a => (a.role || ('custom_agent_' + a.id)) === role);
                        if (agentObj?.addons?.[addon.id] === true) isChecked = true;
                    }
                    const label = document.createElement('label');
                    label.className = 'checkbox-item';
                    label.title = addon.tooltip;
                    label.innerHTML = `
                        <input type="checkbox" id="addon_${addon.id}" ${isChecked ? 'checked' : ''}>
                        <span>${addon.label}</span>
                        <span class="tooltip">${addon.tooltip}</span>
                    `;
                    label.querySelector('input').addEventListener('change', (e) => {
                        if (!roleConfigs[role]) roleConfigs[role] = { prompt: '', addons: {} };
                        if (!roleConfigs[role].addons) roleConfigs[role].addons = {};
                        roleConfigs[role].addons[addon.id] = e.target.checked;
                        saveRoleConfig(role);
                        refreshPreview();
                    });
                    container.appendChild(label);
                }
            }

            // Partition: general (no group) first, then named subsections
            const general = addons.filter(a => !a.group);
            const subsections = [];
            const seen = new Set();
            addons.forEach(a => {
                if (a.group && !seen.has(a.group)) {
                    seen.add(a.group);
                    subsections.push(a.group);
                }
            });

            // 1) Render general addons as first set (flat, no header)
            if (general.length > 0) {
                const generalWrap = document.createElement('div');
                generalWrap.className = 'addon-general-group';
                generalWrap.style.display = 'flex';
                generalWrap.style.flexDirection = 'column';
                generalWrap.style.gap = '8px';
                general.forEach(addon => renderAddon(addon, role, generalWrap));
                group.appendChild(generalWrap);
            }

            // Helper to pretty-print group headers
            function prettyGroupLabel(g) {
                if (g === 'git') return 'Git Strategy';
                if (g === 'subagent') return 'Subagent Policy';
                if (g === 'features') return 'Features';
                return g.charAt(0).toUpperCase() + g.slice(1);
            }

            // 2) Render each named subsection as a collapsed accordion
            subsections.forEach(groupName => {
                const items = addons.filter(a => a.group === groupName);
                if (items.length === 0) return;

                const details = document.createElement('details');
                details.className = 'addon-subsection-accordion';
                
                const summary = document.createElement('summary');
                summary.className = 'addon-subsection-header';
                summary.textContent = prettyGroupLabel(groupName);
                
                const body = document.createElement('div');
                body.className = 'addon-subsection-body';
                body.style.display = 'flex';
                body.style.flexDirection = 'column';
                body.style.gap = '8px';
                if (groupName === 'features') {
                    const cap = document.createElement('div');
                    cap.className = 'addon-subsection-caption';
                    cap.style.opacity = '0.75';
                    cap.style.fontSize = '11px';
                    cap.textContent = 'These add-ons only take effect when the dispatched card is a feature (has subtasks). They are ignored for single-plan dispatch.';
                    body.appendChild(cap);
                }
                items.forEach(addon => renderAddon(addon, role, body));
                
                details.appendChild(summary);
                details.appendChild(body);
                group.appendChild(details);
            });
        }

        function saveRoleConfig(role) {
            postKanbanMessage({
                type: 'saveSetting',
                key: `roleConfig_${role}`,
                value: roleConfigs[role]
            });
        }

        async function refreshPreview() {
            const preview = document.getElementById('promptPreview');
            if (!preview) return;
            
            const msg = { type: 'getPromptPreview', role: currentRole };
            postKanbanMessage(msg);
            preview.value = 'Loading preview...';
        }


        // ── AGENTS TAB ────────────────────────────────────────────────────────────

        let agentsTabCustomAgents = [];
        let agentsTabEditingAgentId = null;

        // Agent Groups state
        let agentsTabAgentGroups = [];
        /**
         * Whether an `agentGroups` payload has EVER arrived from the host.
         *
         * `agentsTabAgentGroups` starts `[]`, and the request that fills it is
         * fire-and-forget: it is posted on TEAMS-tab activation and nothing
         * retries it. If the transport is down at that moment — the WS is
         * reconnecting, a verb 502s — the response never lands and the list stays
         * empty forever, while the tab says "No teams yet". That is a wrong answer
         * that reads exactly like a right one, on a MEMBERSHIP read, which is the
         * one thing this repo bans outright.
         *
         * This flag makes "the host has not answered" and "you genuinely have no
         * teams" two different, visibly different states. It previously went
         * unnoticed because the gallery ALSO drew five hard-coded shipped types
         * that needed no host at all; deleting that second catalogue removed the
         * accidental safety net and left the bare failure exposed.
         */
        let agentsTabAgentGroupsLoaded = false;
        let agentsTabEditingGroupId = null;
        // TEAMS tab card-row state: the picked card's key, and the id of an
        // optimistically-pushed adoption awaiting its saveAgentGroupResult —
        // the rollback key when the host fails to persist it.
        let teamsTabPickedKey = null;
        let teamsTabPendingAdoptId = null;
        /** Ids of the five shipped defaults — sent by the host, derived from
         *  DEFAULT_TEAM_DEFINITIONS. A default is undeletable and its delete
         *  affordance is ABSENT (not a confirm gate — `window.confirm` is a
         *  silent no-op in a webview, and confirm gates are banned outright). */
        let teamsTabDefaultIds = new Set();
        /** Roles the shipped ENABLED defaults need — the recommended agent set.
         *  Derived host-side; a hard-coded copy here would drift the moment a
         *  default's roster changed, and the failure would be silent. */
        let agentsTabRecommendedRoles = new Set();
        /** Per-team roles with no startup command: [{ teamId, teamName, roles }]. */
        let teamsTabCommandlessByTeam = [];

        function teamsTabIsDefault(group) {
            return !!(group && group.id && teamsTabDefaultIds.has(group.id));
        }

        /** The in-use switch, read the way the host reads it: an absent flag is
         *  enabled, and the SOURCE says whether anybody decided that. */
        function teamsTabIsEnabled(group) {
            return !group || group.enabled !== false;
        }

        function agentsTabSanitizeCustomAgentId(value) {
          const normalized = String(value || '')
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, '_')
            .replace(/^_+|_+$/g, '')
            .slice(0, 48);
          return normalized || `agent_${Date.now().toString(36)}`;
        }

        function agentsTabToCustomAgentRole(id) {
          return `custom_agent_${agentsTabSanitizeCustomAgentId(id)}`;
        }

        function agentsTabShowInlineForm(agent) {
          agentsTabEditingAgentId = agent ? agent.id : null;
          document.getElementById('agents-tab-inline-form-title').textContent = agent ? `Edit: ${agent.name}` : 'New Custom Agent';
          document.getElementById('agents-tab-custom-agent-name').value = agent?.name || '';
          document.getElementById('agents-tab-custom-agent-command').value = agent?.startupCommand || '';

          document.getElementById('agents-tab-custom-agent-error').textContent = '';
          document.getElementById('agents-tab-custom-agent-form').classList.remove('hidden');
          setTimeout(() => document.getElementById('agents-tab-custom-agent-name').focus(), 0);
        }

        function agentsTabHideInlineForm() {
          agentsTabEditingAgentId = null;
          document.getElementById('agents-tab-custom-agent-form').classList.add('hidden');
          document.getElementById('agents-tab-custom-agent-error').textContent = '';
        }

        function agentsTabSaveCustomAgent() {
          const name = document.getElementById('agents-tab-custom-agent-name').value.trim();
          const startupCommand = document.getElementById('agents-tab-custom-agent-command').value.trim();
          if (!name || !startupCommand) {
            document.getElementById('agents-tab-custom-agent-error').textContent = 'Name and startup command are required.';
            return;
          }

          const newId = agentsTabSanitizeCustomAgentId(name);
          const role = agentsTabToCustomAgentRole(newId);
          const nextAgent = {
            id: newId,
            role,
            name,
            startupCommand,
            includeInKanban: false,
            kanbanOrder: 0,
            dragDropMode: 'cli',
          };
          // Preserve existing agent's prompt config (backward compat)
          if (agentsTabEditingAgentId) {
            const existing = agentsTabCustomAgents.find(a => a.id === agentsTabEditingAgentId);
            if (existing) {
              if (existing.promptInstructions) nextAgent.promptInstructions = existing.promptInstructions;
              if (existing.addons) nextAgent.addons = existing.addons;
            }
          }

          const duplicate = agentsTabCustomAgents.find(agent =>
            (agentsTabEditingAgentId ? agent.id !== agentsTabEditingAgentId : true) &&
            (agent.name.toLowerCase() === nextAgent.name.toLowerCase() || agent.id === nextAgent.id)
          );
          if (duplicate) {
            document.getElementById('agents-tab-custom-agent-error').textContent = 'Agent names must be unique.';
            return;
          }

          const previousAgent = agentsTabCustomAgents.find(agent => agent.id === (agentsTabEditingAgentId || nextAgent.id));
          if (previousAgent) {
            nextAgent.kanbanOrder = previousAgent.kanbanOrder;
          }

          const workspaceRoot = getActiveWorkspaceRoot();

          if (agentsTabEditingAgentId && agentsTabEditingAgentId !== nextAgent.id) {
            // Identity changed -> delete old one to clean up state keys
            vscode.postMessage({ type: 'deleteCustomAgent', agentId: agentsTabEditingAgentId, workspaceRoot });
            agentsTabCustomAgents = agentsTabCustomAgents.filter(agent => agent.id !== agentsTabEditingAgentId);
          } else {
            agentsTabCustomAgents = agentsTabCustomAgents.filter(agent => agent.id !== nextAgent.id);
          }

          agentsTabCustomAgents.push(nextAgent);
          agentsTabCustomAgents.sort((a, b) => (a.kanbanOrder - b.kanbanOrder) || a.name.localeCompare(b.name));

          agentsTabRenderCustomAgentList();
          agentsTabHideInlineForm();
          vscode.postMessage({ type: 'saveCustomAgent', agent: nextAgent, workspaceRoot });
        }

        /**
         * Webview mirror of `deriveCliFamily` (src/services/cliIdentity.ts).
         * Presentation only — it labels a field, it never decides a timeout; the
         * host remains the single authority on the family a seat actually gets.
         * The roster is deliberately the SAME three names the host matches: this
         * indicator exists to show when a command falls OUTSIDE that roster, so
         * widening it here would hide exactly what it is meant to reveal.
         */
        function agentsTabDeriveCliFamily(startupCommand) {
          const cmd = String(startupCommand || '').trim();
          if (!cmd || cmd === 'No agent assigned') { return 'unknown'; }
          const binary = cmd.split(/\s+/)[0];
          if (!binary) { return 'unknown'; }
          const base = binary.split(/[\\/]/).pop().replace(/\.(exe|cmd|bat)$/i, '').toLowerCase();
          if (base === 'devin') { return 'devin'; }
          if (base === 'claude') { return 'claude'; }
          if (base === 'agy' || base === 'antigravity') { return 'antigravity'; }
          return 'unknown';
        }

        const AGENTS_TAB_UNKNOWN_CLI_TITLE =
          'Switchboard cannot identify the CLI in this command, so this seat gets the most patient '
          + 'readiness profile instead of one measured for its CLI. Only a bare devin, claude, agy or '
          + 'antigravity binary is recognised — a wrapper (npx, env, bash -lc), an alias or a path is not. '
          + 'Delivery still works; it is slower than it needs to be.';

        /**
         * Stamp an UNRECOGNISED CLI chip beside every role startup-command input
         * whose value does not parse to a known family. Runs on every value
         * change and on each `startupCommands` push, so a command corrected in
         * this tab clears its own chip. Empty inputs get no chip — an unset role
         * is not a misclassified one.
         */
        function agentsTabRefreshUnknownCliIndicators() {
          document.querySelectorAll('#agents-tab-content .startup-row input[type="text"][data-role]').forEach(input => {
            const row = input.parentElement;
            if (!row) { return; }
            let chip = row.querySelector('.agents-tab-unknown-cli');
            const value = (input.value || '').trim();
            const show = value.length > 0 && agentsTabDeriveCliFamily(value) === 'unknown';
            if (!show) {
              if (chip) { chip.remove(); }
              return;
            }
            if (!chip) {
              chip = document.createElement('span');
              chip.className = 'agents-tab-unknown-cli';
              chip.textContent = 'Unrecognised CLI';
              chip.title = AGENTS_TAB_UNKNOWN_CLI_TITLE;
              row.appendChild(chip);
            }
          });
        }

        document.addEventListener('input', (e) => {
          const t = e.target;
          if (t && t.matches && t.matches('#agents-tab-content .startup-row input[type="text"][data-role]')) {
            agentsTabRefreshUnknownCliIndicators();
          }
        });

        /**
         * Mark the roles the shipped ENABLED defaults need — the six a new user
         * configures and nothing else. The other roles stay available and
         * configurable; they are simply not the first-run path.
         *
         * The set is DERIVED host-side (union of headRole + member roles across
         * the enabled defaults) and arrives with the `agentGroups` message. It is
         * never typed here: a hard-coded list drifts the moment a default's roster
         * changes, and the failure is silent — a team whose new role nobody was
         * told to configure. `intern` entering the set is the proof.
         *
         * Runs on every `agentGroups` push, so a default's roster change reaches
         * the marks without a reload.
         */
        function agentsTabRefreshRecommendedRoleMarks() {
          document.querySelectorAll('#agents-tab-content .startup-row').forEach(row => {
            const input = row.querySelector('input[type="text"][data-role]')
              || row.querySelector('.agents-tab-visible-toggle');
            const role = input && input.dataset ? input.dataset.role : '';
            let chip = row.querySelector('.agents-tab-recommended-role');
            const show = !!role && agentsTabRecommendedRoles.has(role);
            if (!show) {
              if (chip) { chip.remove(); }
              return;
            }
            if (!chip) {
              chip = document.createElement('span');
              chip.className = 'agents-tab-recommended-role';
              chip.textContent = 'Needed by a shipped team';
              chip.title = 'One of the roles the teams that ship enabled use. '
                + 'Give it a startup command and those teams run; leave it blank and any team that '
                + 'needs it starts a bare shell.';
              const label = row.querySelector('label');
              if (label && label.nextSibling) { row.insertBefore(chip, label.nextSibling); }
              else { row.appendChild(chip); }
            }
          });
        }

        function agentsTabRenderCustomAgentList() {
          const container = document.getElementById('agents-tab-custom-agent-list');
          if (!container) return;
          container.innerHTML = '';
          document.getElementById('agents-tab-custom-agent-delete-error').textContent = '';

          agentsTabCustomAgents.forEach(agent => {
            const role = agent.role || agentsTabToCustomAgentRole(agent.id);
            // Check if agent role is used in any team (as head or member)
            const teamsUsingAgent = agentsTabAgentGroups.filter(g =>
              g.headRole === role || (g.members && g.members.some(m => m.role === role))
            );
            const isTeamAssigned = teamsUsingAgent.length > 0;
            // Team names are operator free text (#agent-groups-name), so escapeAttr is
            // load-bearing: a name carrying a double quote would otherwise terminate the
            // title early and spill the rest into attributes on this span.
            //
            // Both tooltips say "this workspace" deliberately. Custom agents are
            // machine-global (~/.switchboard/integration-config.json) but agentsTabAgentGroups
            // holds only the selected workspace's terminals.agentGroups, so an unqualified
            // "Standalone" would assert something this data cannot see — the agent may well
            // head a team in another root.
            const badgeHtml = isTeamAssigned
              ? `<span class="agents-tab-custom-agent-badge team-assigned" title="Used in this workspace by: ${escapeAttr(teamsUsingAgent.map(t => t.name).join(', '))}">Team (${teamsUsingAgent.length})</span>`
              : `<span class="agents-tab-custom-agent-badge standalone" title="Not used by any team in this workspace">Standalone</span>`;

            // Same indicator the role rows carry: a command Switchboard cannot
            // identify gets the most patient readiness profile, and the operator
            // should see that here rather than discover it through a prompt that
            // never submits.
            const unknownCliHtml = agentsTabDeriveCliFamily(agent.startupCommand) === 'unknown'
              ? `<span class="agents-tab-unknown-cli" title="${escapeAttr(AGENTS_TAB_UNKNOWN_CLI_TITLE)}">Unrecognised CLI</span>`
              : '';

            const item = document.createElement('div');
            item.className = 'agents-tab-custom-agent-item';
            item.innerHTML = `
              <span class="agents-tab-custom-agent-item-name">${agent.name}${badgeHtml}</span>
              <span class="agents-tab-custom-agent-item-command">${agent.startupCommand}${unknownCliHtml}</span>
              <div class="agents-tab-custom-agent-item-actions">
                <button class="agents-tab-custom-agent-item-btn edit" data-id="${agent.id}">EDIT</button>
                <button class="agents-tab-custom-agent-item-btn export-skill" data-id="${agent.id}">EXPORT SKILL</button>
                <button class="agents-tab-custom-agent-item-btn delete" data-id="${agent.id}">DELETE</button>
              </div>
            `;

            item.querySelector('.edit').addEventListener('click', () => {
              agentsTabShowInlineForm(agent);
            });

            item.querySelector('.export-skill').addEventListener('click', () => {
              vscode.postMessage({ type: 'exportAgentAsSkill', agentId: agent.id, workspaceRoot: getActiveWorkspaceRoot() });
              const btn = item.querySelector('.export-skill');
              const orig = btn.textContent;
              btn.textContent = 'EXPORTED!';
              setTimeout(() => { btn.textContent = orig; }, 2000);
            });

            item.querySelector('.delete').addEventListener('click', () => {
                document.getElementById('agents-tab-custom-agent-delete-error').textContent = '';
                if (agentsTabEditingAgentId === agent.id) {
                  agentsTabHideInlineForm();
                }
                agentsTabCustomAgents = agentsTabCustomAgents.filter(a => a.id !== agent.id);
                agentsTabRenderCustomAgentList();
                vscode.postMessage({ type: 'deleteCustomAgent', agentId: agent.id, workspaceRoot: getActiveWorkspaceRoot() });
            });

            container.appendChild(item);
          });
        }

        // Custom Agents event listeners
        document.getElementById('agents-tab-btn-add-custom-agent')?.addEventListener('click', () => {
          agentsTabShowInlineForm(null);
        });

        document.getElementById('agents-tab-btn-save-custom-agent')?.addEventListener('click', agentsTabSaveCustomAgent);

        document.getElementById('agents-tab-btn-cancel-custom-agent')?.addEventListener('click', agentsTabHideInlineForm);

        // Teams (Agent Groups) event listeners
        document.getElementById('agent-groups-btn-add')?.addEventListener('click', () => {
            teamsTabShowGroupForm(null);
        });
        document.getElementById('teams-build-link')?.addEventListener('click', () => {
            teamsTabShowGroupForm(null);
        });
        document.getElementById('agent-groups-btn-save')?.addEventListener('click', teamsTabSaveAgentGroup);
        document.getElementById('agent-groups-btn-cancel')?.addEventListener('click', teamsTabHideGroupForm);
        document.getElementById('agent-groups-add-member')?.addEventListener('click', () => {
            const membersDiv = document.getElementById('agent-groups-members');
            if (membersDiv) {
                membersDiv.appendChild(teamsTabAgentGroupMemberRow({ role: 'coder', count: 1, scope: 'per-team', relationship: 'reports-to-head' }));
            }
        });

        let currentDelegationRole = 'coder';

        function agentsTabPopulateRoleSelect() {
            const select = document.getElementById('delegation-role-select');
            if (!select) { return; }
            select.innerHTML = '';
            for (const role of ROLE_KEYS) {
                const option = document.createElement('option');
                option.value = role;
                option.textContent = role;
                if (role === currentDelegationRole) { option.selected = true; }
                select.appendChild(option);
            }
            select.onchange = (e) => { currentDelegationRole = e.target.value; agentsTabRenderDelegationPanel(currentDelegationRole); };
        }

        function agentsTabEnsureRoleConfig(role) {
            if (!roleConfigs[role]) { roleConfigs[role] = { prompt: '', addons: {} }; }
            if (!roleConfigs[role].addons) { roleConfigs[role].addons = {}; }
            return roleConfigs[role];
        }

        function agentsTabRenderDelegationPanel(role) {
            const container = document.getElementById('delegation-panels');
            if (!container) { return; }
            const cfg = agentsTabEnsureRoleConfig(role);
            container.innerHTML = '';

            const phoneSection = document.createElement('div');
            phoneSection.className = 'db-subsection';
            phoneSection.style.padding = '8px';

            // ── Toggle: enable Phone-a-Friend for this role ─────────────
            // The boolean controls whether the PHONE_A_FRIEND_DIRECTIVE is
            // emitted in the prompt. The dispatch itself always fires when
            // the directive is present — the flag governs emission, not
            // dispatch (see dispatchPhoneAFriend).
            const toggleRow = document.createElement('div');
            toggleRow.className = 'startup-row';
            toggleRow.style.gap = '6px';
            toggleRow.style.marginBottom = '8px';
            const toggleLabel = document.createElement('label');
            toggleLabel.style.fontSize = '11px';
            toggleLabel.style.display = 'flex';
            toggleLabel.style.alignItems = 'center';
            toggleLabel.style.gap = '4px';
            toggleLabel.style.cursor = 'pointer';
            const toggleCheckbox = document.createElement('input');
            toggleCheckbox.type = 'checkbox';
            toggleCheckbox.style.width = 'auto';
            toggleCheckbox.style.margin = '0';
            toggleCheckbox.checked = cfg.addons.phoneAFriend === true;
            toggleCheckbox.addEventListener('change', () => {
                cfg.addons.phoneAFriend = toggleCheckbox.checked;
                saveRoleConfig(role);
            });
            toggleLabel.appendChild(toggleCheckbox);
            toggleLabel.appendChild(document.createTextNode('Enable Phone-a-Friend for this role'));
            toggleRow.appendChild(toggleLabel);
            phoneSection.appendChild(toggleRow);

            // ── Default target select ────────────────────────────────────
            // The common case: "this coder calls a friend when it finishes a
            // batch." The target is usually the workspace singleton
            // ("Phone-a-Friend"), but the operator can name a specific terminal.
            // This writes a special '*' key into phoneAFriendTargets so the
            // dispatch resolver picks it up as the role default.
            const targetRow = document.createElement('div');
            targetRow.className = 'startup-row';
            targetRow.style.gap = '6px';
            targetRow.style.marginBottom = '8px';
            const targetLabel = document.createElement('label');
            targetLabel.style.fontSize = '11px';
            targetLabel.style.minWidth = '70px';
            targetLabel.textContent = 'Target';
            const targetInput = document.createElement('input');
            targetInput.type = 'text';
            targetInput.placeholder = 'Phone-a-Friend (default)';
            targetInput.style.flex = '1';
            targetInput.value = '';
            // Materialise the map on the config, not just locally — ADD TARGET
            // and the row editors both write through
            // `cfg.addons.phoneAFriendTargets`, and a local `|| {}` left it
            // undefined so the first click threw and the control did nothing
            // at all. This materialisation is the fix for the past bug the
            // original code comments called out.
            if (!cfg.addons.phoneAFriendTargets || typeof cfg.addons.phoneAFriendTargets !== 'object') {
                cfg.addons.phoneAFriendTargets = {};
            }
            // Read the default target from the '*' key if it exists.
            const defaultTarget = cfg.addons.phoneAFriendTargets['*'];
            if (typeof defaultTarget === 'string') { targetInput.value = defaultTarget; }
            targetInput.addEventListener('blur', () => {
                const t = agentsTabEnsureRoleConfig(role).addons;
                if (!t.phoneAFriendTargets || typeof t.phoneAFriendTargets !== 'object') { t.phoneAFriendTargets = {}; }
                const val = targetInput.value.trim();
                if (val) {
                    t.phoneAFriendTargets['*'] = val;
                } else {
                    delete t.phoneAFriendTargets['*'];
                }
                saveRoleConfig(role);
            });
            targetRow.appendChild(targetLabel);
            targetRow.appendChild(targetInput);
            phoneSection.appendChild(targetRow);

            // ── Advanced: per-terminal override map ──────────────────────
            // Shipped state — stays editable behind a disclosure. The map is
            // origin-terminal → target-terminal (or null for "off"). This is
            // the override mechanism for installs that need per-instance
            // routing; the common case is the toggle + default target above.
            const advToggle = document.createElement('button');
            advToggle.className = 'strip-btn';
            advToggle.style.width = '100%';
            advToggle.style.marginTop = '4px';
            advToggle.style.fontSize = '10px';
            advToggle.style.color = 'var(--text-secondary)';
            advToggle.textContent = '▶ Advanced: per-terminal overrides';
            const advContent = document.createElement('div');
            advContent.style.display = 'none';
            advContent.style.marginTop = '6px';
            let advOpen = false;
            advToggle.addEventListener('click', () => {
                advOpen = !advOpen;
                advContent.style.display = advOpen ? '' : 'none';
                advToggle.textContent = advOpen ? '▼ Advanced: per-terminal overrides' : '▶ Advanced: per-terminal overrides';
            });
            const targetList = document.createElement('div');
            targetList.style.display = 'flex'; targetList.style.flexDirection = 'column'; targetList.style.gap = '4px';
            const targets = cfg.addons.phoneAFriendTargets;
            for (const [origin, target] of Object.entries(targets)) {
                // Skip the '*' default key — it is edited by the target select above.
                if (origin === '*') { continue; }
                targetList.appendChild(agentsTabPhoneRow(role, origin, target));
            }
            const addBtn = document.createElement('button');
            addBtn.className = 'strip-btn'; addBtn.style.width = '100%'; addBtn.style.marginTop = '6px'; addBtn.textContent = 'ADD TARGET';
            addBtn.addEventListener('click', () => {
                const cur = agentsTabEnsureRoleConfig(role).addons;
                if (!cur.phoneAFriendTargets || typeof cur.phoneAFriendTargets !== 'object') { cur.phoneAFriendTargets = {}; }
                cur.phoneAFriendTargets[''] = '';
                saveRoleConfig(role);
                agentsTabRenderDelegationPanel(role);
            });
            advContent.appendChild(targetList);
            advContent.appendChild(addBtn);
            phoneSection.appendChild(advToggle);
            phoneSection.appendChild(advContent);
            container.appendChild(phoneSection);
        }

        function agentsTabPhoneRow(role, origin, target) {
            const row = document.createElement('div');
            row.className = 'startup-row';
            row.style.gap = '4px';
            row.innerHTML = '<input type="text" placeholder="origin terminal" style="flex:1;"><select style="width:80px;"><option value="target">target</option><option value="off">off</option></select><input type="text" placeholder="target terminal" style="flex:1;"><button class="strip-btn" style="padding:2px 8px;">×</button>';
            const [originInput, modeSelect, targetInput, delBtn] = row.querySelectorAll('input, select, button');
            originInput.value = origin;
            targetInput.value = target === null ? '' : (typeof target === 'string' ? target : '');
            modeSelect.value = target === null ? 'off' : 'target';
            targetInput.style.display = target === null ? 'none' : '';

            function save() {
                const cfg = agentsTabEnsureRoleConfig(role);
                if (!cfg.addons.phoneAFriendTargets || typeof cfg.addons.phoneAFriendTargets !== 'object') { cfg.addons.phoneAFriendTargets = {}; }
                const t = cfg.addons.phoneAFriendTargets;
                const newOrigin = originInput.value.trim();
                if (newOrigin !== origin) { delete t[origin]; }
                const newTarget = modeSelect.value === 'off' ? null : targetInput.value.trim();
                t[newOrigin] = newTarget;
                saveRoleConfig(role);
            }
            originInput.addEventListener('blur', save);
            modeSelect.addEventListener('change', () => { targetInput.style.display = modeSelect.value === 'off' ? 'none' : ''; save(); });
            targetInput.addEventListener('blur', save);
            delBtn.addEventListener('click', () => {
                const cfg = agentsTabEnsureRoleConfig(role);
                delete cfg.addons.phoneAFriendTargets[origin];
                saveRoleConfig(role);
                agentsTabRenderDelegationPanel(role);
            });
            return row;
        }


        // ── Teams (Agent Groups) ───────────────────────────────────────────────────
        // Moved from AGENTS to TEAMS. The agentsTab* prefix is retained for the
        // state variables (agentsTabAgentGroups, agentsTabEditingGroupId) because
        // the message handler at 'agentGroups' writes them — renaming the
        // variables would require changing every reference including the message
        // pump. The functions are renamed to teamsTab* to match their DOM home.

        /**
         * There is ONE catalogue, and it is not here.
         *
         * `SHIPPED_TEAM_TYPES` used to live at this spot: five hand-written team
         * types the gallery FORKED into the workspace on USE, minting a definition
         * with a generated id. It disagreed with the host's own
         * `DEFAULT_TEAM_DEFINITIONS` — the list you chose from and the list pushed
         * onto you were different lists, which is why a board grew a lead-headed
         * team the operator never created. "Batch planners" was the Planning team
         * under a worse name and "Planning with analyst" was a role-config concern
         * wearing a team costume.
         *
         * The five shipped defaults now arrive from the host like any other team,
         * in `agentsTabAgentGroups`, and are marked by `teamsTabDefaultIds` (sent
         * with the same message, DERIVED from DEFAULT_TEAM_DEFINITIONS — never
         * re-typed here). "ADD TEAM" creates an empty custom definition; it does
         * not fork a type.
         */

        /**
         * Relationship presets for the member editor dropdown.
         * Mirrors LINK_PRESETS in terminals.js / src/services/linkPresets.ts,
         * excluding `custom` (empty template, not a valid relationship for a member).
         * The contract test (link-presets-mirror-contract.test.js) guards the
         * full list; this is the subset the dropdown offers.
         */
        const MEMBER_RELATIONSHIP_PRESETS = [
            { id: 'reports-to-head', label: 'Reports to me' },
            { id: 'researcher', label: 'Researcher' },
            { id: 'reviewer', label: 'Reviewer' },
            { id: 'handoff', label: 'Hand off' },
            { id: 'second-opinion', label: 'Second opinion' }
        ];

        /**
         * Map a role string to a portrait symbol id. Single jet portrait
         * (Source: agent-fleet-air-combat-detailed.svg#afc-jet); this is the
         * seam where per-role art returns when agent-<role>.png files land.
         */
        function teamsTabPortraitId(role) {
            return 'portrait-agent';
        }

        /**
         * Low-level art resolver — the ONE place a stored `icon` value becomes
         * a URL. teamIconSrc(group) (added by the icon-picker plan) is a thin
         * wrapper over this: `const v = group?.icon; return v ? resolveArt(v) : null;`.
         *
         * Accepted forms, discriminated by prefix (no separate iconKind field):
         *   art:<name>  → /static/icons/<name>.png   (the long-term form; the
         *                 file is <name>.png under icons/. Regenerating art
         *                 overwrites the same filename, so saved refs survive.)
         *   pack:<file> → /static/icons/<url-encoded file>  (stand-in pack only;
         *                 those filenames contain spaces, so encode here, not
         *                 at storage time. Disappears with the stand-ins.)
         *   data:...    → passthrough (custom inline icon).
         *
         * `mtime` is OPTIONAL. The picker passes the file mtime returned by
         * GET /terminals/icon-palette to bust the 1-hour static cache
         * (LocalApiServer serves art as `public, max-age=3600`) after a
         * regenerate. Non-picker render paths (shell strip, cockpit header,
         * sidebar rows) omit it and accept stale cache within that window —
         * they do not call the listing endpoint, so they have no mtime to pass.
         *
         * Empty/absent/malformed → null. Never throws.
         */
        function resolveArt(value, mtime) {
            const v = String(value || '').trim();
            if (!v) { return null; }
            if (v.startsWith('data:')) { return v; }
            if (v.startsWith('art:')) {
                const name = v.slice('art:'.length).trim();
                if (!name) { return null; }
                const base = '/static/icons/' + encodeURIComponent(name) + '.png';
                return mtime ? base + '?v=' + mtime : base;
            }
            if (v.startsWith('pack:')) {
                const file = v.slice('pack:'.length).trim();
                if (!file) { return null; }
                const base = '/static/icons/' + encodeURIComponent(file);
                return mtime ? base + '?v=' + mtime : base;
            }
            return null;
        }

        /**
         * Team icon resolver — the ONLY place a stored team `icon` value
         * becomes a URL for the TEAMS tab surfaces (gallery card, flow head
         * node). Thin wrapper over `resolveArt` (the low-level prefix parser):
         * reads `group.icon`, hands it to `resolveArt`, returns the URL or
         * null. The shell strip and cockpit have their own consumers of
         * `resolveArt`; this helper is the TEAMS-tab seam so adding `art:`
         * handling later is one function's change across all surfaces.
         *
         * No mtime here: the TEAMS tab does not call the listing endpoint on
         * every render, so it accepts stale cache within the 1-hour static
         * window (the picker passes mtime only when constructing the
         * cache-busting URL for a freshly-picked icon).
         *
         * Absent/empty `icon` → null → caller falls back to the role portrait.
         */
        function teamIconSrc(group) {
            const v = group && group.icon ? group.icon : null;
            return v ? resolveArt(v) : null;
        }

        function agentArtSrc(role) {
            const slug = String(role || '').trim().toLowerCase()
                .replace(/[^a-z0-9]+/g, '-')
                .replace(/^-+|-+$/g, '');
            const name = slug ? `agent-${slug}.png` : '';
            const entry = name && Array.isArray(_iconPaletteCache)
                ? _iconPaletteCache.find(icon => icon && icon.name === name)
                : null;
            return entry ? `${entry.src}?v=${entry.mtime}` : null;
        }

        /**
         * Build a portrait element for a team/group: an `<img>` when the group
         * has a resolved icon, else the inline SVG `<use>` role portrait. Used
         * by the gallery card and the flow head node so both surfaces agree.
         *
         * `size` is the integer display size (TEAMS_TAB_CELL for the card, CELL
         * for the flow diagram). The `<img>` gets `flex:none` + explicit
         * width/height so a flex parent cannot stretch it to a fractional box
         * (which would silently reintroduce pixel-art blur), plus `.pixel-art`
         * for `image-rendering: pixelated`.
         *
         * `onerror` swaps the broken `<img>` for the role portrait SVG so a
         * missing/deleted asset degrades to the old behaviour rather than a
         * broken-image glyph. Note this fires after a network round-trip, so a
         * brief broken-image flash may appear on slow connections.
         */
        function teamsTabPortraitEl(group, size) {
            const src = teamIconSrc(group);
            if (src) {
                const img = document.createElement('img');
                img.src = src;
                img.alt = (group.name || group.id || 'team') + ' icon';
                img.width = size;
                img.height = size;
                img.className = 'teams-card-portrait pixel-art';
                img.style.flex = 'none';
                img.addEventListener('error', () => {
                    // Swap in the role portrait SVG so a 404 (deleted PNG,
                    // bad pack ref) degrades gracefully — no broken glyph.
                    const fallback = teamsTabRolePortraitEl(group.headRole, size);
                    img.replaceWith(fallback);
                });
                return img;
            }
            return teamsTabRolePortraitEl(group.headRole, size);
        }

        /**
         * The team JET for a head role — byte-for-byte the same derivation the
         * shell rail uses (`shell.js`: ROLE_JETS allowlist, `lead` for anything
         * unrecognised, `/static/icons/team-<role>.svg`).
         *
         * It is duplicated deliberately rather than imported: these are two
         * separate webview documents with no shared module, and the alternative
         * — the tab drawing DIFFERENT art from the rail for the same team — is
         * what this fixes. A team must look like itself on every surface.
         *
         * Presentation-only, so an unrecognised role falling back to the lead jet
         * is a placeholder, not a silent behaviour change (CLAUDE.md: fallbacks on
         * presentation paths are fine; the test is whether a wrong value changes
         * BEHAVIOUR, and a portrait does not).
         */
        const TEAMS_TAB_ROLE_JETS = ['lead', 'coder', 'planner', 'reviewer', 'intern'];
        function teamsTabJetSrc(role) {
            const r = String(role || '').toLowerCase();
            return '/static/icons/team-'
                + (TEAMS_TAB_ROLE_JETS.indexOf(r) >= 0 ? r : 'lead') + '.svg';
        }

        function teamsTabRolePortraitEl(role, size) {
            // The JET FIRST — the shipped defaults carry no `icon`, so this is the
            // arm that actually renders every default team, and it must match the
            // rail. Falls through to the agent portrait and then the inline SVG if
            // the jet ever 404s.
            const jet = document.createElement('img');
            jet.src = teamsTabJetSrc(role);
            jet.alt = `${role || 'agent'} portrait`;
            jet.width = size;
            jet.height = size;
            jet.className = 'teams-card-portrait pixel-art';
            jet.style.flex = 'none';
            jet.addEventListener('error', () => {
                jet.replaceWith(teamsTabRoleAgentPortraitEl(role, size));
            });
            return jet;
        }

        function teamsTabRoleAgentPortraitEl(role, size) {
            const src = agentArtSrc(role);
            if (!src) { return teamsTabPortraitSvgEl(role, size); }
            const img = document.createElement('img');
            img.src = src;
            img.alt = `${role || 'agent'} portrait`;
            img.width = size;
            img.height = size;
            img.className = 'teams-card-portrait pixel-art';
            img.style.flex = 'none';
            img.addEventListener('error', () => img.replaceWith(teamsTabPortraitSvgEl(role, size)));
            return img;
        }

        /** Inline-SVG role portrait — the fallback arm of teamsTabPortraitEl. */
        function teamsTabPortraitSvgEl(role, size) {
            const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
            svg.setAttribute('width', String(size));
            svg.setAttribute('height', String(size));
            svg.setAttribute('class', 'teams-card-portrait');
            const useEl = document.createElementNS('http://www.w3.org/2000/svg', 'use');
            useEl.setAttribute('href', '#' + teamsTabPortraitId(role));
            useEl.setAttribute('width', String(size));
            useEl.setAttribute('height', String(size));
            svg.appendChild(useEl);
            return svg;
        }

        /** Cell size for portrait <use> — fixed so better art cannot shift layout.
         *  32 (not 28): the art grid is 32x32, and a 24-unit viewBox at 28px is
         *  a 1.1667x fractional scale that blurs raster pixel art. 32 is 1x. */
        const TEAMS_TAB_CELL = 32;

        /**
         * Render the card row from ONE list: the workspace's teams — the five
         * shipped defaults plus whatever the operator built. There is no second
         * catalogue to merge in and no un-adopted type to render, so every card
         * is a real definition with a real id.
         *
         * `adopted` stays on the entry shape because the rest of this file reads
         * it; it is now always true.
         */
        function teamsTabRenderGallery() {
            if (_iconPaletteCache === null && !_iconPaletteRequested) {
                _iconPaletteRequested = true;
                postKanbanMessage({ type: 'getIconPalette' });
            }
            const container = document.getElementById('teams-gallery');
            if (!container) return;
            container.innerHTML = '';
            const cards = agentsTabAgentGroups.map(g => ({ group: g, adopted: true }));
            // The gallery used to draw five hard-coded shipped types when the
            // workspace list was empty, so a missed host response was invisible
            // here. That catalogue is gone, so this surface must say why it is
            // blank instead of simply being blank.
            if (cards.length === 0) { container.appendChild(teamsTabEmptyStateEl()); }
            for (const entry of cards) {
                container.appendChild(teamsTabGalleryCard(entry));
            }
            // Re-render the flow panel for the picked card, or clear it if
            // the picked team was deleted.
            const flowPanel = document.getElementById('teams-flow-panel');
            if (flowPanel) {
                if (teamsTabPickedKey) {
                    const picked = cards.find(c => teamsTabCardKey(c) === teamsTabPickedKey);
                    if (picked) {
                        teamsTabRenderFlow(picked);
                    } else {
                        flowPanel.innerHTML = '';
                        teamsTabPickedKey = null;
                    }
                } else {
                    flowPanel.innerHTML = '';
                }
            }
        }

        /** Stable key for a card entry — adopted teams have ids, types have names. */
        function teamsTabCardKey(entry) {
            return entry.adopted ? entry.group.id : ('type:' + entry.group.name);
        }

        /**
         * One card: portrait, name, purpose, roster strip. The whole card is
         * the click target. No USE button — adoption moves to the flow panel.
         */
        function teamsTabGalleryCard(entry) {
            const group = entry.group;
            const card = document.createElement('div');
            card.className = 'teams-card';
            const key = teamsTabCardKey(entry);
            if (key === teamsTabPickedKey) { card.classList.add('is-picked'); }

            // Portrait — chosen team icon (`<img>`) when set, else the inline
            // role portrait SVG. teamsTabPortraitEl handles both arms + the
            // 404 fallback so a deleted PNG degrades to the role portrait.
            card.appendChild(teamsTabPortraitEl(group, TEAMS_TAB_CELL));

            // Name
            const nameDiv = document.createElement('div');
            nameDiv.className = 'teams-card-name';
            nameDiv.textContent = group.name || group.id;
            card.appendChild(nameDiv);

            // Purpose — types carry one; adopted teams fall back to member summary
            const purposeDiv = document.createElement('div');
            purposeDiv.className = 'teams-card-purpose';
            purposeDiv.textContent = group.purpose || teamsTabRosterStrip(group);
            card.appendChild(purposeDiv);

            // Roster strip: LEAD · 3 CODER · 1 REVIEWER
            const rosterDiv = document.createElement('div');
            rosterDiv.className = 'teams-card-roster';
            rosterDiv.textContent = teamsTabRosterStrip(group);
            card.appendChild(rosterDiv);

            // ── The in-use switch ────────────────────────────────────────
            // A team that exists is not automatically a team that plays. A
            // disabled team is GREYED WITH ITS SWITCH — not hidden, not deleted —
            // or there is no way back on. stopPropagation so flipping the switch
            // does not also pick the card.
            if (!teamsTabIsEnabled(group)) { card.classList.add('is-disabled'); }
            const switchDiv = document.createElement('div');
            switchDiv.className = 'teams-card-switch';
            switchDiv.addEventListener('click', (e) => e.stopPropagation());
            const switchLabel = document.createElement('label');
            switchLabel.style.display = 'flex';
            switchLabel.style.alignItems = 'center';
            switchLabel.style.gap = '4px';
            const switchInput = document.createElement('input');
            switchInput.type = 'checkbox';
            switchInput.checked = teamsTabIsEnabled(group);
            switchInput.style.width = 'auto';
            switchInput.style.margin = '0';
            switchInput.addEventListener('change', () => {
                const g = agentsTabAgentGroups.find(x => x.id === group.id);
                if (!g) { return; }
                g.enabled = switchInput.checked;
                // The OPERATOR decided this, so the source says so — "off because
                // it ships off" and "off because the operator switched it off"
                // must never read the same on a membership read.
                g.enabledSource = 'config';
                teamsTabRenderAgentGroups();
                teamsTabRenderGallery();
                postKanbanMessage({ type: 'saveAgentGroup', group: { ...g } });
            });
            const switchText = document.createElement('span');
            switchText.textContent = 'IN USE';
            switchLabel.appendChild(switchInput);
            switchLabel.appendChild(switchText);
            switchDiv.appendChild(switchLabel);
            card.appendChild(switchDiv);
            if (!teamsTabIsEnabled(group)) {
                const offNote = document.createElement('div');
                offNote.className = 'teams-card-note';
                offNote.textContent = group.enabledSource === 'default'
                    ? 'Ships switched off. Switch it on to start it.'
                    : 'Switched off. It keeps its definition and its seats; it just does not play.';
                card.appendChild(offNote);
            }
            // Roles this team would start into BARE SHELLS. Reported BEFORE a
            // start, which is when a first-run user needs it — team start reports
            // the same thing, from the same host function, but by then the seats
            // are already open.
            const commandless = teamsTabCommandlessByTeam.find(e => e && e.teamId === group.id);
            if (commandless && Array.isArray(commandless.roles) && commandless.roles.length > 0) {
                const needDiv = document.createElement('div');
                needDiv.className = 'teams-card-note';
                needDiv.textContent = `${group.name} needs a startup command for: ${commandless.roles.join(', ')}`;
                card.appendChild(needDiv);
            }

            // Worktree field — adopted teams only. Previously gated behind a
            // START ON LOAD checkbox (auto-start is now removed); the field is
            // load-bearing for MANUAL starts: startAgentGroupById and
            // startTeamForWorkspace both read it as the spawn cwd / worktree
            // trigger, so it stays authorable independent of the removed toggle.
            // stopPropagation so editing does not also pick the card.
            if (entry.adopted) {
                const autoDiv = document.createElement('div');
                autoDiv.className = 'teams-card-autostart';
                autoDiv.addEventListener('click', (e) => e.stopPropagation());
                // The field kept the START ON LOAD row's container but lost that
                // checkbox's label with it, leaving an unexplained text box on
                // every adopted card. Name it — the existing label class is
                // already styled for exactly this position.
                const wtLabel = document.createElement('span');
                wtLabel.className = 'teams-card-autostart-label';
                wtLabel.textContent = 'WORKTREE';
                autoDiv.appendChild(wtLabel);
                const wtInput = document.createElement('input');
                wtInput.type = 'text';
                wtInput.className = 'teams-card-autostart-wt';
                wtInput.value = group.startWorktree || '';
                wtInput.placeholder = '';
                wtInput.addEventListener('change', () => {
                    const g = agentsTabAgentGroups.find(x => x.id === group.id);
                    if (!g) return;
                    const val = wtInput.value.trim();
                    if (val) { g.startWorktree = val; }
                    else { delete g.startWorktree; }
                    postKanbanMessage({ type: 'saveAgentGroup', group: { ...g } });
                });
                autoDiv.appendChild(wtInput);
                card.appendChild(autoDiv);
            }

            // WORKTREE badge
            if (group.worktreeMode === 'auto') {
                const wtBadge = document.createElement('div');
                wtBadge.className = 'teams-card-autostart';
                const wtLabel = document.createElement('span');
                wtLabel.className = 'teams-card-autostart-label';
                wtLabel.textContent = 'WORKTREE';
                wtBadge.appendChild(wtLabel);
                card.appendChild(wtBadge);
            }

            card.addEventListener('click', () => {
                teamsTabPickedKey = key;
                teamsTabRenderGallery();
            });
            return card;
        }

        /** Compact roster strip: "LEAD · 3 CODER · 1 REVIEWER" */
        function teamsTabRosterStrip(group) {
            const members = group.members || [];
            const parts = members.map(m => `${(m.count || 1)} ${String(m.role || 'member').toUpperCase()}${m.scope === 'shared' ? ' (SHARED)' : ''}`);
            return [String(group.headRole || 'head').toUpperCase(), ...parts].join(' · ') || 'head only';
        }

        /**
         * Derive nodes and edges from headRole + members[] and emit the SVG
         * diagram + the action button. One function, one input, no state of
         * its own. Nodes fade in staggered; edges stroke on after their nodes.
         */
        function teamsTabRenderFlow(entry) {
            const panel = document.getElementById('teams-flow-panel');
            if (!panel) return;
            panel.innerHTML = '';

            const group = entry.group;
            const members = group.members || [];
            const CELL = 20;   // node size in the diagram (smaller than card)
            const GAP = 12;    // horizontal gap between nodes
            const ROW_H = 70;  // vertical distance between rows

            // Collect all nodes: head first, then each member expanded by count.
            const headNode = { role: group.headRole, label: String(group.headRole || 'head').toUpperCase(), isHead: true };
            const memberNodes = [];
            const edges = []; // { from, to, label, rel }
            for (const m of members) {
                const count = m.count || 1;
                const rel = m.relationship || 'reports-to-head';
                const relPreset = MEMBER_RELATIONSHIP_PRESETS.find(p => p.id === rel);
                const label = relPreset ? relPreset.label : '';
                for (let i = 0; i < count; i++) {
                    const node = { role: m.role, label: String(m.role || 'member').toUpperCase(), isHead: false };
                    memberNodes.push(node);
                    edges.push({ from: node, to: headNode, label, rel });
                }
            }
            const allNodes = [headNode, ...memberNodes];

            // Layout: head centered on top row, members on the row below,
            // wrapping at a max of 5 per row.
            const MAX_PER_ROW = 5;
            const memberRows = [];
            for (let i = 0; i < memberNodes.length; i += MAX_PER_ROW) {
                memberRows.push(memberNodes.slice(i, i + MAX_PER_ROW));
            }
            const totalRows = 1 + memberRows.length;
            const svgHeight = totalRows * ROW_H + 20;
            const maxRowWidth = Math.max(1, ...memberRows.map(r => r.length)) * (CELL + GAP);
            const svgWidth = Math.max(200, maxRowWidth + 40);

            // Compute x positions per row
            function rowXs(row, totalWidth) {
                const rowWidth = row.length * (CELL + GAP) - GAP;
                const startX = (totalWidth - rowWidth) / 2;
                return row.map((_, i) => startX + i * (CELL + GAP));
            }

            const headXs = rowXs([headNode], svgWidth);
            headNode.x = headXs[0] + CELL / 2;
            headNode.y = 10 + CELL / 2;

            memberRows.forEach((row, rowIdx) => {
                const xs = rowXs(row, svgWidth);
                row.forEach((node, i) => {
                    node.x = xs[i] + CELL / 2;
                    node.y = 10 + (rowIdx + 1) * ROW_H + CELL / 2;
                });
            });

            // Build the SVG
            const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
            svg.setAttribute('class', 'teams-flow-svg');
            svg.setAttribute('width', String(svgWidth));
            svg.setAttribute('height', String(svgHeight));
            svg.setAttribute('viewBox', `0 0 ${svgWidth} ${svgHeight}`);

            // Edges first (so nodes render on top)
            edges.forEach((edge, i) => {
                const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
                line.setAttribute('x1', String(edge.from.x));
                line.setAttribute('y1', String(edge.from.y));
                line.setAttribute('x2', String(edge.to.x));
                line.setAttribute('y2', String(edge.to.y));
                line.setAttribute('stroke', 'var(--accent-teal)');
                line.setAttribute('stroke-width', '1.5');
                line.setAttribute('class', 'teams-flow-edge');
                line.style.animationDelay = `${0.3 + i * 0.04}s`;
                svg.appendChild(line);
                if (edge.label) {
                    const midX = (edge.from.x + edge.to.x) / 2;
                    const midY = (edge.from.y + edge.to.y) / 2;
                    const text = document.createElementNS('http://www.w3.org/2000/svg', 'text');
                    text.setAttribute('x', String(midX + 4));
                    text.setAttribute('y', String(midY));
                    text.setAttribute('font-size', '8');
                    text.setAttribute('fill', 'var(--text-secondary)');
                    text.textContent = edge.label;
                    svg.appendChild(text);
                }
            });

            // Nodes
            allNodes.forEach((node, i) => {
                const g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
                g.setAttribute('class', 'teams-flow-node');
                g.style.animationDelay = `${i * 0.06}s`;
                g.setAttribute('transform', `translate(${node.x - CELL / 2}, ${node.y - CELL / 2})`);
                const nodeSvg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
                nodeSvg.setAttribute('width', String(CELL));
                nodeSvg.setAttribute('height', String(CELL));
                // Head node: render the team icon (`<image>`) when set, else
                // the role portrait `<use>`. Members always use their role
                // portrait — the team icon is the team's identity, not the
                // members'. `<image>` is the SVG embed of `<img>`; `.pixel-art`
                // is not applicable inside SVG (image-rendering is set inline).
                const headIconSrc = node.isHead ? teamIconSrc(group) : null;
                const roleIconSrc = agentArtSrc(node.role);
                const nodeIconSrc = headIconSrc || roleIconSrc;
                if (nodeIconSrc) {
                    const imageEl = document.createElementNS('http://www.w3.org/2000/svg', 'image');
                    imageEl.setAttribute('href', nodeIconSrc);
                    imageEl.setAttribute('width', String(CELL));
                    imageEl.setAttribute('height', String(CELL));
                    imageEl.setAttribute('preserveAspectRatio', 'xMidYMid');
                    imageEl.style.imageRendering = 'pixelated';
                    let triedRoleIcon = !headIconSrc;
                    imageEl.addEventListener('error', () => {
                        if (!triedRoleIcon && roleIconSrc) {
                            triedRoleIcon = true;
                            imageEl.setAttribute('href', roleIconSrc);
                            return;
                        }
                        const useFallback = document.createElementNS('http://www.w3.org/2000/svg', 'use');
                        useFallback.setAttribute('href', '#' + teamsTabPortraitId(node.role));
                        useFallback.setAttribute('width', String(CELL));
                        useFallback.setAttribute('height', String(CELL));
                        imageEl.replaceWith(useFallback);
                    });
                    nodeSvg.appendChild(imageEl);
                } else {
                    const useEl = document.createElementNS('http://www.w3.org/2000/svg', 'use');
                    useEl.setAttribute('href', '#' + teamsTabPortraitId(node.role));
                    useEl.setAttribute('width', String(CELL));
                    useEl.setAttribute('height', String(CELL));
                    nodeSvg.appendChild(useEl);
                }
                g.appendChild(nodeSvg);
                // Label below the node
                const label = document.createElementNS('http://www.w3.org/2000/svg', 'text');
                label.setAttribute('x', String(CELL / 2));
                label.setAttribute('y', String(CELL + 10));
                label.setAttribute('text-anchor', 'middle');
                label.setAttribute('font-size', '8');
                label.setAttribute('fill', 'var(--text-secondary)');
                label.textContent = node.label;
                g.appendChild(label);
                svg.appendChild(g);
            });

            panel.appendChild(svg);

            // No ADOPT action. There is nothing to adopt — every card in this
            // gallery is already one of the workspace's own teams. Starting a
            // team is the terminals panel's job: this panel has no terminal grid
            // to seat one in, and the terminals panel's whole reaction to a
            // backend team registration is reloadTerminalGroups(), which merges
            // the group and seats nothing. A team started from here spawns
            // off-screen.
            const actionDiv = document.createElement('div');
            actionDiv.className = 'teams-flow-action';
            const hint = document.createElement('span');
            hint.className = 'teams-flow-hint';
            hint.textContent = 'Start it from the terminals panel.';
            actionDiv.appendChild(hint);
            const errorSpan = document.createElement('span');
            errorSpan.className = 'teams-flow-error';
            errorSpan.id = 'teams-flow-error';
            actionDiv.appendChild(errorSpan);
            panel.appendChild(actionDiv);
        }

        /**
         * "ADD TEAM" opens the editor with no group (`teamsTabShowGroupForm(null)`)
         * and the save below mints the definition. That is the whole creation path
         * now: it makes an empty CUSTOM team, it does not fork a shipped type,
         * because there are no shipped types to fork. The five defaults arrive
         * from the host with the rest of `agentsTabAgentGroups`.
         *
         * A team the operator builds is written `enabled: true` with
         * `enabledSource: 'config'` at creation, so the field is never absent and
         * there is no absent-means-what question to answer later.
         */

        /**
         * The empty-list notice, which says WHICH empty it is.
         *
         * Not loaded → the board has not answered; offer a retry, because the
         * request is posted once on tab activation and nothing else re-sends it.
         * Loaded and still empty → a genuine empty board, which is itself odd now
         * that the five defaults are undeletable, so it says so rather than
         * inviting the operator to build what should already be there.
         */
        function teamsTabEmptyStateEl() {
            const wrap = document.createElement('div');
            wrap.style.fontSize = '11px';
            wrap.style.color = 'var(--text-secondary)';
            wrap.style.padding = '4px 0';
            if (!agentsTabAgentGroupsLoaded) {
                const msg = document.createElement('span');
                msg.textContent = 'Teams have not loaded — the board did not answer. ';
                wrap.appendChild(msg);
                const retry = document.createElement('button');
                retry.className = 'agents-tab-custom-agent-item-btn';
                retry.textContent = 'RETRY';
                retry.addEventListener('click', () => {
                    postKanbanMessage({ type: 'getAgentGroups' });
                });
                wrap.appendChild(retry);
                return wrap;
            }
            wrap.textContent = 'No teams on this board. The five shipped defaults cannot be deleted, '
                + 'so an empty list means the board did not seed them — reload, and report it if it persists.';
            return wrap;
        }

        function teamsTabRenderAgentGroups() {
            const container = document.getElementById('agent-groups-list');
            if (!container) return;
            container.innerHTML = '';
            if (agentsTabAgentGroups.length === 0) {
                // "The board never answered" must not read as "you have no teams".
                // The five defaults are undeletable, so an EMPTY list from a
                // healthy host is itself a red flag worth saying out loud.
                container.appendChild(teamsTabEmptyStateEl());
                return;
            }
            for (const group of agentsTabAgentGroups) {
                container.appendChild(teamsTabAgentGroupRow(group));
            }
        }

        function teamsTabAgentGroupRow(group) {
            const row = document.createElement('div');
            row.className = 'agents-tab-custom-agent-item';
            row.style.flexWrap = 'wrap';
            const members = group.members || [];
            const memberSummary = members
                .map(m => `${m.count || 1}× ${m.role}${m.scope === 'shared' ? ' (shared)' : ''}`)
                .join(', ') || 'no members yet';
            const nameDiv = document.createElement('div');
            nameDiv.className = 'agents-tab-custom-agent-item-name';
            nameDiv.textContent = group.name;
            const detailDiv = document.createElement('div');
            detailDiv.className = 'agents-tab-custom-agent-item-command';
            detailDiv.style.flexBasis = '100%';
            // §Pair-programming team scope: show the team's intensity on the card.
            // 'on' is the default; 'aggressive' biases the planner's classification;
            // 'off' means the lead does everything (or a head-only team, resolved off).
            const ppVal = group.pairProgramming;
            const ppLabel = ppVal === 'aggressive' ? 'pair: aggressive'
                : ppVal === 'off' ? 'pair: off'
                : 'pair: on';
            detailDiv.textContent = `head: ${group.headRole} · ${memberSummary} · ${ppLabel}`;
            // Switched off: informational, not a fault — muted text, not red.
            // The definition and its seats are untouched; the team just does not
            // play. There is no `unassigned` flag any more: it meant "not the
            // auto-start default", auto-start is retired, and two flags that both
            // look like "off" is the two-copies-disagreeing trap.
            if (!teamsTabIsEnabled(group)) {
                row.style.opacity = '0.55';
                const offDiv = document.createElement('div');
                offDiv.style.flexBasis = '100%';
                offDiv.style.fontSize = '10px';
                offDiv.style.color = 'var(--text-secondary)';
                offDiv.textContent = group.enabledSource === 'default'
                    ? 'Switched off — this team ships off. Switch it on from its card above.'
                    : 'Switched off — switch it on from its card above.';
                row.appendChild(offDiv);
            }
            // Member-less starter: show the explanatory copy.
            if (members.length === 0) {
                const hintDiv = document.createElement('div');
                hintDiv.style.flexBasis = '100%';
                hintDiv.style.fontSize = '10px';
                hintDiv.style.color = 'var(--text-secondary)';
                hintDiv.textContent = 'This team does nothing until you add a member. Add one and every '
                    + group.headRole + ' you start will bring it along, already told what it is there for.';
                row.appendChild(hintDiv);
            }
            const actions = document.createElement('div');
            actions.className = 'agents-tab-custom-agent-item-actions';
            const editBtn = document.createElement('button');
            editBtn.className = 'agents-tab-custom-agent-item-btn';
            editBtn.textContent = 'EDIT';
            editBtn.addEventListener('click', () => teamsTabShowGroupForm(group));
            actions.appendChild(editBtn);
            // The five shipped defaults have NO delete affordance — absent, not
            // disabled and certainly not a confirm gate (confirm gates are banned
            // here, and `window.confirm` is a silent no-op in a webview anyway).
            // The off switch on the card above is the replacement for deleting one.
            if (!teamsTabIsDefault(group)) {
                const delBtn = document.createElement('button');
                delBtn.className = 'agents-tab-custom-agent-item-btn delete';
                delBtn.textContent = '×';
                delBtn.addEventListener('click', () => {
                    // Delete immediately — no confirmation dialog (hard project rule).
                    agentsTabAgentGroups = agentsTabAgentGroups.filter(g => g.id !== group.id);
                    // Clear the flow panel if the deleted team was the picked card —
                    // otherwise the panel keeps a START button for a deleted id.
                    if (teamsTabPickedKey === group.id) {
                        teamsTabPickedKey = null;
                    }
                    teamsTabRenderAgentGroups();
                    teamsTabRenderGallery();
                    postKanbanMessage({ type: 'deleteAgentGroup', groupId: group.id });
                });
                actions.appendChild(delBtn);
            }
            row.appendChild(nameDiv);
            row.appendChild(actions);
            row.appendChild(detailDiv);
            return row;
        }

        /**
         * Roster for both the Head role select and every member row's role select.
         * Built at call time, not cached: `lastCustomAgents` arrives asynchronously via
         * the `customAgents` message and can land after the form is first opened.
         *
         * `preserve` re-injects a stored role that is no longer in the roster (a typo
         * already saved, a deleted custom agent) as its own option. Without it a
         * <select> silently snaps to its first option and the next save REWRITES the
         * operator's team.
         *
         * Deliberately NOT filtered by lastVisibleAgents: visibility governs the
         * terminal picker and the open-all grid, not team composition.
         */
        function teamsTabRoleOptions(selectEl, selectedRole) {
            selectEl.innerHTML = '';
            const add = (value, text, parent) => {
                const o = document.createElement('option');
                o.value = value; o.textContent = text;
                (parent || selectEl).appendChild(o);
            };
            const known = new Set();
            // Filtered by ROLE_KEYS, NOT the bare BUILT_IN_AGENT_LABELS list. The labels
            // list carries `jules`, which is visibility-only (no startup-command input in
            // the AGENTS tab, absent from DEFAULT_ROLE_CONFIG, absent from KanbanProvider's
            // BUILTIN_ROLES). Offering it here authors a team seat that cannot boot a CLI.
            // ROLE_KEYS is Object.keys(DEFAULT_ROLE_CONFIG) — exactly the spawnable set —
            // so a role added there shows up here without a second edit.
            const spawnable = new Set(ROLE_KEYS);
            for (const r of BUILT_IN_AGENT_LABELS) {
                if (!spawnable.has(r.key)) { continue; }
                add(r.key, r.label); known.add(r.key);
            }
            const customAgents = (Array.isArray(lastCustomAgents) && lastCustomAgents.length)
                ? lastCustomAgents
                : (typeof agentsTabCustomAgents !== 'undefined' && Array.isArray(agentsTabCustomAgents) ? agentsTabCustomAgents : []);
            if (customAgents.length) {
                const grp = document.createElement('optgroup');
                grp.label = 'Custom Agents';
                for (const a of customAgents) {
                    const r = a.role || (typeof agentsTabToCustomAgentRole === 'function' ? agentsTabToCustomAgentRole(a.id) : a.id);
                    add(r, a.name || r, grp);
                    known.add(r);
                }
                selectEl.appendChild(grp);
            }
            const want = selectedRole || 'coder';
            if (!known.has(want)) { add(want, `${want} (not configured)`); }
            selectEl.value = want;
        }

        function teamsTabAgentGroupMemberRow(member) {
            // Member editor row: role, count, scope, relationship, label.
            // Per-member startupCommand is RETIRED (plan:
            // agents-are-saved-per-machine-and-a-team-picks-one) — a team
            // resolves every member from its one machine's command map. The
            // machine selector lives on the team form, not on the member row.
            // NEVER tag these inputs with data-role: agentsTabCollectConfig
            // scoops `#teams-tab-content input[type="text"][data-role]` into
            // the GLOBAL role-command map, so a data-role here would overwrite
            // the workspace's role command on the next Agents-config save.
            const row = document.createElement('div');
            row.className = 'startup-row';
            row.style.flexWrap = 'wrap';
            row.style.gap = '4px';

            const roleSel = document.createElement('select');
            roleSel.dataset.field = 'role';
            roleSel.style.flex = '1'; roleSel.style.minWidth = '110px';
            teamsTabRoleOptions(roleSel, member.role);

            const countIn = document.createElement('input');
            countIn.type = 'number'; countIn.min = '1'; countIn.max = '8';
            countIn.dataset.field = 'count';
            countIn.style.width = '50px';
            countIn.value = member.count ?? 1;

            const scopeSel = document.createElement('select');
            scopeSel.dataset.field = 'scope';
            scopeSel.style.width = '90px';
            scopeSel.innerHTML = '<option value="per-team">per-team</option><option value="shared">shared</option>';
            scopeSel.value = member.scope || 'per-team';

            const relSel = document.createElement('select');
            relSel.dataset.field = 'relationship';
            relSel.style.flex = '1'; relSel.style.minWidth = '100px';
            for (const p of MEMBER_RELATIONSHIP_PRESETS) {
                const opt = document.createElement('option');
                opt.value = p.id; opt.textContent = p.label;
                relSel.appendChild(opt);
            }
            relSel.value = member.relationship || 'reports-to-head';

            const labelIn = document.createElement('input');
            labelIn.type = 'text';
            labelIn.className = 'member-label';
            labelIn.placeholder = 'label';
            labelIn.style.width = '70px';
            labelIn.value = member.label || '';

            const delBtn = document.createElement('button');
            delBtn.className = 'strip-btn';
            delBtn.style.padding = '2px 8px';
            delBtn.textContent = '×';

            row.appendChild(roleSel);
            row.appendChild(countIn);
            row.appendChild(scopeSel);
            row.appendChild(relSel);
            row.appendChild(labelIn);
            row.appendChild(delBtn);

            function save() {
                member.role = roleSel.value.trim() || 'coder';
                member.count = parseInt(countIn.value, 10) || 1;
                member.scope = scopeSel.value;
                member.relationship = relSel.value;
                const label = labelIn.value.trim();
                if (label) { member.label = label; } else { delete member.label; }
                // Per-member startupCommand is retired — never persist it.
                delete member.startupCommand;
            }
            countIn.addEventListener('blur', save);
            labelIn.addEventListener('blur', save);
            [roleSel, scopeSel, relSel].forEach(el => el.addEventListener('change', save));
            delBtn.addEventListener('click', () => {
                const membersDiv = document.getElementById('agent-groups-members');
                if (membersDiv) { membersDiv.removeChild(row); }
            });
            return row;
        }

        function teamsTabShowGroupForm(group) {
            agentsTabEditingGroupId = group ? group.id : null;
            document.getElementById('agent-groups-form-title').textContent = group ? `Edit: ${group.name}` : 'New Team';
            document.getElementById('agent-groups-name').value = group?.name || '';
            // Mark head roles another team already uses — but do NOT disable them,
            // and do NOT treat it as a conflict. Two teams sharing a head role is
            // an ordinary configuration that nothing objects to: the shipped set
            // has two `planner`-headed teams (Planning and Multi-agent planning).
            // The " (in use)" suffix is information, not a warning. Nothing is
            // demoted, flagged, hidden or refused for declaring the same headRole
            // as another team.
            const headSel = document.getElementById('agent-groups-head-role');
            teamsTabRoleOptions(headSel, group?.headRole || 'lead');
            // Populate the machine selector (plan:
            // agents-are-saved-per-machine-and-a-team-picks-one). A team picks
            // ONE machine; default to `local` for a new team or a legacy team
            // without the field.
            const machineSel = document.getElementById('agent-groups-machine');
            if (machineSel) {
                machineSel.innerHTML = '';
                for (const m of agentsTabMachines) {
                    if (!m || !m.id) { continue; }
                    const opt = document.createElement('option');
                    opt.value = m.id;
                    opt.textContent = m.name || m.id;
                    machineSel.appendChild(opt);
                }
                machineSel.value = (group?.machine && agentsTabMachines.some(m => m.id === group.machine))
                    ? group.machine
                    : 'local';
            }
            const claimedRoles = new Set(agentsTabAgentGroups
                .filter(g => g.id !== group?.id)
                .map(g => g.headRole));
            // No `opt.disabled = false` reset: the static <option> markup is gone and
            // `teamsTabRoleOptions` builds every option fresh, so none is ever disabled.
            for (const opt of headSel.options) {
                // Append-only on top of the label `teamsTabRoleOptions` set above. This
                // is safe ONLY because `teamsTabRoleOptions` clears `selectEl.innerHTML`
                // first, so no `(in use)` suffix from a previous form-open survives.
                // If that helper ever caches, this becomes `Phone-a-Friend (in use) (in use)`.
                if (claimedRoles.has(opt.value)) { opt.textContent = `${opt.textContent} (in use)`; }
            }
            const membersDiv = document.getElementById('agent-groups-members');
            if (!membersDiv) return;
            membersDiv.innerHTML = '';
            const members = group ? (group.members || []).map(m => ({ ...m })) : [];
            if (members.length === 0 && !group) {
                members.push({ role: 'coder', count: 1, scope: 'per-team', relationship: 'reports-to-head' });
            }
            for (const m of members) {
                membersDiv.appendChild(teamsTabAgentGroupMemberRow(m));
            }
            const promptEl = document.getElementById('agent-groups-prompt');
            if (promptEl) { promptEl.value = group?.prompt || ''; }
            const headPromptEl = document.getElementById('agent-groups-head-prompt');
            if (headPromptEl) { headPromptEl.value = group?.headPrompt || ''; }
            const wtModeCb = document.getElementById('agent-groups-worktree-mode');
            if (wtModeCb) { wtModeCb.checked = group?.worktreeMode === 'auto'; }
            // §Pair-programming team scope: load the team's intensity. Default
            // 'on' for a new team and for a legacy team without the field.
            const ppSelect = document.getElementById('agent-groups-pair-programming');
            if (ppSelect) {
                // The Coding team is offered `on`/`aggressive` and NOT `off`: its
                // whole identity is the split, and two seats doing undifferentiated
                // work is not this team. The operator can still switch the whole
                // TEAM off — that is the control for "I do not want this".
                const offOpt = ppSelect.querySelector('option[value="off"]');
                if (offOpt) { offOpt.hidden = group?.id === 'coding-team'; }
                const ppVal = group?.pairProgramming;
                ppSelect.value = (ppVal === 'off' || ppVal === 'aggressive') ? ppVal : 'on';
                if (group?.id === 'coding-team' && ppSelect.value === 'off') { ppSelect.value = 'on'; }
            }
            // Load the existing icon value (or clear for a new team) and render
            // the preview. The hidden input is the source of truth for save.
            teamsTabSetIconValue(group?.icon || '');
            document.getElementById('agent-groups-error').textContent = '';
            document.getElementById('agent-groups-inline-form').classList.remove('hidden');
            setTimeout(() => document.getElementById('agent-groups-name').focus(), 0);
        }

        function teamsTabHideGroupForm() {
            agentsTabEditingGroupId = null;
            document.getElementById('agent-groups-inline-form').classList.add('hidden');
            document.getElementById('agent-groups-error').textContent = '';
            const wtModeCb = document.getElementById('agent-groups-worktree-mode');
            if (wtModeCb) { wtModeCb.checked = false; }
            // Reset the pair-programming select to the default ('on') for the next
            // team. teamsTabShowGroupForm re-loads the real value on edit.
            const ppReset = document.getElementById('agent-groups-pair-programming');
            if (ppReset) {
                const offOpt = ppReset.querySelector('option[value="off"]');
                if (offOpt) { offOpt.hidden = false; }
                ppReset.value = 'on';
            }
            // Collapse the icon grid so a re-open starts clean.
            const grid = document.getElementById('agent-groups-icon-grid');
            if (grid) { grid.style.display = 'none'; }
            const gridErr = document.getElementById('agent-groups-icon-error');
            if (gridErr) { gridErr.textContent = ''; }
        }

        // ── Icon picker ───────────────────────────────────────────────────
        // Three accepted icon forms (discriminated by prefix, no iconKind):
        //   art:<name>  → /static/icons/<name>.png  (long-term; regenerating
        //                 art overwrites the same filename, refs survive)
        //   pack:<file> → /static/icons/<url-encoded file>  (stand-in pack;
        //                 spaced filenames encoded at resolve time)
        //   data:...    → custom inline icon (64 KB cap after base64 encoding)
        // Absent/empty → role portrait fallback. The hidden input holds the
        // raw value; the preview button renders the resolved icon or the role
        // portrait. The grid populates from GET /terminals/icon-palette (via
        // the getIconPalette verb — the webview cannot fetch the HTTP endpoint
        // directly). No confirmation dialogs anywhere (CLAUDE.md): reset and
        // custom-clear act immediately.

        /** 64 KB cap on the encoded data URI (raw file ~48 KB → ~64 KB base64). */
        const ICON_DATA_URI_MAX_BYTES = 64 * 1024;
        /** Raw file size that encodes to ~64 KB base64 (4/3 ratio + overhead). */
        const ICON_FILE_MAX_RAW_BYTES = 48 * 1024;
        /** Cached palette so a second grid open doesn't re-fetch. */
        let _iconPaletteCache = null;
        let _iconPaletteRequested = false;

        /** Read the current icon value from the hidden input. */
        function teamsTabIconValue() {
            const el = document.getElementById('agent-groups-icon-value');
            return el ? (el.value || '').trim() : '';
        }

        /** Set the icon value, refresh the preview + label, clear grid errors. */
        function teamsTabSetIconValue(value) {
            const el = document.getElementById('agent-groups-icon-value');
            if (el) { el.value = value || ''; }
            teamsTabRenderIconPreview();
            const gridErr = document.getElementById('agent-groups-icon-error');
            if (gridErr) { gridErr.textContent = ''; }
        }

        /** Render the preview button: the resolved icon `<img>` or the role
         *  portrait SVG. Falls back to the role portrait on `<img>` error. */
        function teamsTabRenderIconPreview() {
            const btn = document.getElementById('agent-groups-icon-preview');
            const label = document.getElementById('agent-groups-icon-label');
            if (!btn || !label) { return; }
            btn.innerHTML = '';
            const headRole = document.getElementById('agent-groups-head-role')?.value || 'lead';
            const value = teamsTabIconValue();
            const src = value ? resolveArt(value) : null;
            if (src) {
                const img = document.createElement('img');
                img.src = src;
                img.alt = 'team icon';
                img.width = 32; img.height = 32;
                img.className = 'pixel-art';
                img.style.flex = 'none';
                img.addEventListener('error', () => {
                    btn.innerHTML = '';
                    btn.appendChild(teamsTabPortraitSvgEl(headRole, 32));
                });
                btn.appendChild(img);
                label.textContent = value.startsWith('data:') ? 'Custom icon'
                    : value.startsWith('art:') ? ('art: ' + value.slice(4))
                    : value.startsWith('pack:') ? ('pack: ' + value.slice(5))
                    : value;
            } else {
                btn.appendChild(teamsTabPortraitSvgEl(headRole, 32));
                label.textContent = 'Default icon';
            }
        }

        /** Open the grid: fetch the palette (cached), group by kind, render. */
        async function teamsTabOpenIconGrid() {
            const grid = document.getElementById('agent-groups-icon-grid');
            const items = document.getElementById('agent-groups-icon-grid-items');
            const gridErr = document.getElementById('agent-groups-icon-error');
            if (!grid || !items) { return; }
            grid.style.display = 'block';
            if (gridErr) { gridErr.textContent = ''; }
            items.innerHTML = '';
            // Loading placeholder while the verb round-trips.
            const loading = document.createElement('div');
            loading.style.cssText = 'grid-column:1/-1; font-size:10px; color:var(--text-secondary); padding:4px;';
            loading.textContent = 'Loading icons…';
            items.appendChild(loading);

            let icons = _iconPaletteCache;
            if (!icons) {
                try {
                    postKanbanMessage({ type: 'getIconPalette' });
                    // The iconPalette push arrives async via the message listener;
                    // wait for it with a short timeout so the grid isn't blank.
                    icons = await teamsTabWaitForIconPalette(3000);
                } catch {
                    icons = null;
                }
            }
            if (!icons || icons.length === 0) {
                loading.textContent = 'No icons found in icons/.';
                return;
            }
            _iconPaletteCache = icons;
            items.innerHTML = '';

            // Group by kind so the picker can show Agents / Teams / Stand-in
            // as separate sections — the stand-in pack drops as one group
            // once real art lands.
            const groups = { jet: [], brand: [] };
            for (const ic of icons) {
                if (groups[ic.kind]) { groups[ic.kind].push(ic); }
            }
            const groupLabels = { jet: 'Default', brand: 'CLI brand' };
            const currentValue = teamsTabIconValue();
            for (const kind of ['jet', 'brand']) {
                const arr = groups[kind];
                if (!arr || arr.length === 0) { continue; }
                const header = document.createElement('div');
                header.style.cssText = 'grid-column:1/-1; font-size:10px; font-weight:600; color:var(--text-secondary); margin-top:4px;';
                header.textContent = groupLabels[kind];
                items.appendChild(header);
                for (const ic of arr) {
                    const cell = document.createElement('button');
                    cell.type = 'button';
                    cell.title = ic.name + (ic.sizeWarning ? ' — ' + ic.sizeWarning : '');
                    cell.style.cssText = 'padding:2px; width:36px; height:36px; display:flex; align-items:center; justify-content:center; border:1px solid ' +
                        (resolveArt('pack:' + ic.name) === resolveArt(currentValue) ? 'var(--accent-teal)' : 'var(--border)') +
                        '; border-radius:3px; background:var(--panel-bg); cursor:pointer; position:relative;';
                    const img = document.createElement('img');
                    img.src = ic.src;
                    img.alt = ic.name;
                    img.width = 32; img.height = 32;
                    img.className = 'pixel-art';
                    img.style.flex = 'none';
                    cell.appendChild(img);
                    if (ic.sizeWarning) {
                        const badge = document.createElement('span');
                        badge.textContent = '!';
                        badge.style.cssText = 'position:absolute; top:0; right:1px; font-size:9px; color:var(--accent-red); font-weight:700;';
                        badge.title = ic.sizeWarning;
                        cell.appendChild(badge);
                    }
                    // One storage form for the whole palette: the exact filename
                    // under `pack:`, which both resolvers already expand verbatim
                    // (`/static/icons/<encoded file>`). The `art:` form is NOT usable
                    // here — it hardcodes a `.png` extension and every icon the
                    // palette now offers is an SVG.
                    const storeValue = 'pack:' + ic.name;
                    cell.addEventListener('click', () => {
                        teamsTabSetIconValue(storeValue);
                        teamsTabCloseIconGrid();
                    });
                    items.appendChild(cell);
                }
            }
        }

        function teamsTabCloseIconGrid() {
            const grid = document.getElementById('agent-groups-icon-grid');
            if (grid) { grid.style.display = 'none'; }
        }

        /** Wait for the `iconPalette` message push (set by the message listener). */
        function teamsTabWaitForIconPalette(timeoutMs) {
            return new Promise((resolve) => {
                let done = false;
                const finish = (val) => { if (!done) { done = true; cleanup(); resolve(val); } };
                const handler = (event) => {
                    const msg = event.data;
                    if (msg && msg.type === 'iconPalette') {
                        finish(Array.isArray(msg.icons) ? msg.icons : []);
                    }
                };
                window.addEventListener('message', handler);
                const timer = setTimeout(() => finish(_iconPaletteCache), timeoutMs);
                function cleanup() {
                    window.removeEventListener('message', handler);
                    clearTimeout(timer);
                }
            });
        }

        /** Handle the custom file input: check raw size BEFORE reading (a large
         *  file read into memory then rejected wastes RAM), then read as a data
         *  URI and enforce the 64 KB encoded cap. */
        function teamsTabHandleIconFile(file) {
            const gridErr = document.getElementById('agent-groups-icon-error');
            if (!file) { return; }
            if (file.size > ICON_FILE_MAX_RAW_BYTES) {
                if (gridErr) { gridErr.textContent = `File too large (${Math.round(file.size/1024)} KB). Max ~48 KB raw (encodes to 64 KB).`; }
                return;
            }
            const reader = new FileReader();
            reader.onload = () => {
                const dataUri = String(reader.result || '');
                if (dataUri.length > ICON_DATA_URI_MAX_BYTES) {
                    if (gridErr) { gridErr.textContent = `Encoded icon too large (${Math.round(dataUri.length/1024)} KB). Max 64 KB.`; }
                    return;
                }
                teamsTabSetIconValue(dataUri);
                teamsTabCloseIconGrid();
            };
            reader.onerror = () => {
                if (gridErr) { gridErr.textContent = 'Failed to read file.'; }
            };
            reader.readAsDataURL(file);
        }

        // ── Icon picker event wiring (bound once) ─────────────────────────
        (function teamsTabWireIconPicker() {
            const preview = document.getElementById('agent-groups-icon-preview');
            const reset = document.getElementById('agent-groups-icon-reset');
            const closeBtn = document.getElementById('agent-groups-icon-grid-close');
            const fileInput = document.getElementById('agent-groups-icon-file');
            if (preview) {
                preview.addEventListener('click', (e) => {
                    e.preventDefault();
                    const grid = document.getElementById('agent-groups-icon-grid');
                    if (grid && grid.style.display === 'block') {
                        teamsTabCloseIconGrid();
                    } else {
                        void teamsTabOpenIconGrid();
                    }
                });
            }
            if (reset) {
                reset.addEventListener('click', (e) => {
                    e.preventDefault();
                    teamsTabSetIconValue('');
                });
            }
            if (closeBtn) {
                closeBtn.addEventListener('click', (e) => {
                    e.preventDefault();
                    teamsTabCloseIconGrid();
                });
            }
            if (fileInput) {
                fileInput.addEventListener('change', () => {
                    const file = fileInput.files && fileInput.files[0];
                    teamsTabHandleIconFile(file);
                    // Reset the input so the same file can be re-picked.
                    fileInput.value = '';
                });
            }
            // Re-render the preview when the head role changes — the fallback
            // portrait depends on it.
            const headSel = document.getElementById('agent-groups-head-role');
            if (headSel) {
                headSel.addEventListener('change', teamsTabRenderIconPreview);
            }
        })();

        function teamsTabSaveAgentGroup() {
            const name = document.getElementById('agent-groups-name').value.trim();
            if (!name) {
                document.getElementById('agent-groups-error').textContent = 'Team name is required.';
                return;
            }
            const headRole = document.getElementById('agent-groups-head-role').value || 'lead';
            // Read members from the DOM rows. Role/count/scope/relationship are
            // read by data-field (unchanged); label and startupCommand are read BY
            // CLASS from the row that owns them. The old `existing.find(m => m.role
            // === role)` preservation shim is gone: it returned the FIRST member of
            // a role, so two same-role rows collapsed onto the first row's label and
            // command on every save. The row is now the sole source.
            const membersDiv = document.getElementById('agent-groups-members');
            const members = [];
            if (membersDiv) {
                const rows = membersDiv.querySelectorAll('.startup-row');
                for (const r of rows) {
                    // Addressed by data-field, NOT by index. The role control is a <select>
                    // now, so an index-based read shifts both collections and the old
                    // `inputs.length >= 2` guard rejected every row — saving a team with no
                    // members and no error.
                    const roleEl  = r.querySelector('[data-field="role"]');
                    const countEl = r.querySelector('[data-field="count"]');
                    const scopeEl = r.querySelector('[data-field="scope"]');
                    const relEl   = r.querySelector('[data-field="relationship"]');
                    if (roleEl && countEl && scopeEl && relEl) {
                        const role = (roleEl.value || '').trim() || 'coder';
                        const count = parseInt(countEl.value, 10) || 1;
                        const scope = scopeEl.value;
                        const relationship = relEl.value;
                        const label = (r.querySelector('.member-label')?.value || '').trim();
                        // Per-member startupCommand is RETIRED (plan:
                        // agents-are-saved-per-machine-and-a-team-picks-one).
                        // Members never carry their own command — the team's
                        // machine resolves every role.
                        members.push({
                            role, count, scope, relationship,
                            ...(label ? { label } : {}),
                        });
                    } else {
                        // Defensive: a row missing any of the four data-field controls is a
                        // row-builder regression, not a user error. Warn so a debug session
                        // can find it — the old `inputs.length >= 2` guard swallowed this
                        // silently and saved teams one member short with no signal.
                        console.warn('[teamsTab] skipped a member row missing data-field controls:', r);
                        continue;
                    }
                }
            }
            const id = agentsTabEditingGroupId || ('group-' + name.toLowerCase().replace(/[^a-z0-9]+/g, '-') + '-' + Date.now().toString(36));
            // `unassigned`/`unassignedReason` no longer exist — head-role
            // collisions are not a thing, so there is nothing to carry or clear.
            const promptText = (document.getElementById('agent-groups-prompt')?.value || '').trim();
            const headPromptText = (document.getElementById('agent-groups-head-prompt')?.value || '').trim();
            // The worktree field is NOT an editor field — it is set on the
            // card. This literal rebuilds the group from scratch and drops
            // every field it does not name (this literal rebuilds from scratch),
            // so an EDIT+SAVE would silently clear the operator's worktree
            // without this carry. Read from the existing in-memory definition.
            const prevGroup = agentsTabEditingGroupId
                ? agentsTabAgentGroups.find(g => g.id === agentsTabEditingGroupId) || null
                : null;
            // Icon carry-forward: the picker IS an editor field (read from the
            // hidden input), but a code path that saves without mounting the
            // form would leave the input empty and silently wipe the icon —
            // the same wipe trap that startWorktree/pacing need
            // explicit rescues for. Fall back to prevGroup?.icon so a save
            // cannot blank it. The hidden input is populated by
            // teamsTabShowGroupForm on every form open.
            const iconValue = teamsTabIconValue() || prevGroup?.icon || '';
            const worktreeModeEl = document.getElementById('agent-groups-worktree-mode');
            const worktreeMode = worktreeModeEl
                ? (worktreeModeEl.checked ? 'auto' : undefined)
                : (prevGroup?.worktreeMode ? prevGroup.worktreeMode : undefined);
            // §Pair-programming team scope: read the team's intensity from the
            // form. Default 'on' (the select's first option) — a team is a lead
            // plus cheaper seats, and the default should use them.
            const ppSelectEl = document.getElementById('agent-groups-pair-programming');
            let pairProgrammingVal = ppSelectEl
                ? (ppSelectEl.value === 'off' || ppSelectEl.value === 'aggressive' ? ppSelectEl.value : 'on')
                : (prevGroup?.pairProgramming || 'on');
            // The Coding team's split is NOT switchable off. A coder and an intern
            // with no split are two seats doing undifferentiated work, which is not
            // this team. The control for "I do not want this" is the team's own
            // in-use switch. Enforced here as well as in the dropdown, so a stale
            // form or a hand-edited select cannot write `off`.
            if (id === 'coding-team' && pairProgrammingVal === 'off') { pairProgrammingVal = 'on'; }
            // Read the team's machine (plan:
            // agents-are-saved-per-machine-and-a-team-picks-one). A team picks
            // ONE machine; default to `local` when unset or pointing at a
            // deleted machine (the migration repairs this on load too).
            const machineSelEl = document.getElementById('agent-groups-machine');
            let teamMachine = machineSelEl?.value || prevGroup?.machine || 'local';
            if (!agentsTabMachines.some(m => m.id === teamMachine)) {
                teamMachine = 'local';
            }
            const group = {
                id, name, headRole, members,
                machine: teamMachine,
                pairProgramming: pairProgrammingVal,
                ...(promptText ? { prompt: promptText } : {}),
                ...(headPromptText ? { headPrompt: headPromptText } : {}),
                ...(iconValue ? { icon: iconValue } : {}),
                ...(prevGroup?.startWorktree ? { startWorktree: prevGroup.startWorktree } : {}),
                ...(prevGroup?.pacing ? { pacing: prevGroup.pacing } : {}),
                ...(worktreeMode ? { worktreeMode } : {}),
                // The in-use switch is a CARD control, not an editor field — this
                // literal rebuilds the group from scratch and drops every field it
                // does not name, so an EDIT+SAVE would silently switch a disabled
                // team back on without this carry. A team with no stored value is
                // written `true` / `'config'`: the operator just saved it, so the
                // operator is the source. Never absent — there is then no
                // absent-means-what question to answer on a membership read.
                enabled: prevGroup && prevGroup.enabled === false ? false : true,
                enabledSource: prevGroup && typeof prevGroup.enabledSource === 'string'
                    ? prevGroup.enabledSource
                    : 'config',
                // Work kinds are not editable in this form yet (that is
                // `a-team-declares-what-work-it-accepts`), so carry them rather
                // than dropping a default's routing on an unrelated rename.
                ...(Array.isArray(prevGroup?.acceptedKinds) ? { acceptedKinds: [...prevGroup.acceptedKinds] } : {}),
                ...(prevGroup?.acceptedKindsSource ? { acceptedKindsSource: prevGroup.acceptedKindsSource } : {}),
                ...(prevGroup?.purpose ? { purpose: prevGroup.purpose } : {}),
            };
            // Replace or append. A NEW team is pushed optimistically so the card
            // redraws immediately; `teamsTabPendingAdoptId` is the rollback key,
            // read by saveAgentGroupResult when the host fails to persist it.
            // Without it a failed save leaves a card drawn for a team the host has
            // never seen.
            const idx = agentsTabAgentGroups.findIndex(g => g.id === id);
            if (idx >= 0) { agentsTabAgentGroups[idx] = group; }
            else { agentsTabAgentGroups.push(group); teamsTabPendingAdoptId = id; }
            teamsTabRenderAgentGroups();
            teamsTabRenderGallery();
            teamsTabHideGroupForm();
            postKanbanMessage({ type: 'saveAgentGroup', group });
        }


        // ── Machine selector (plan: agents-are-saved-per-machine-and-a-team-picks-one) ──
        // Agents are saved PER MACHINE. The selected machine's command map is
        // what the role inputs below show and save. A team picks one machine;
        // the machine's transport prefix is applied to every agent in that set.
        let agentsTabMachines = [];
        let agentsTabSelectedMachineId = 'local';
        let agentsTabMachineEditing = null; // null | 'add' | 'edit'

        function agentsTabMachineById(id) {
          return agentsTabMachines.find(m => m && m.id === id) || null;
        }

        function agentsTabRenderMachineSelect() {
          const sel = document.getElementById('agents-tab-machine-select');
          if (!sel) { return; }
          const prev = agentsTabSelectedMachineId;
          sel.innerHTML = '';
          for (const m of agentsTabMachines) {
            if (!m || !m.id) { continue; }
            const opt = document.createElement('option');
            opt.value = m.id;
            opt.textContent = m.name || m.id;
            sel.appendChild(opt);
          }
          // Preserve selection if still present; else fall back to local.
          if (agentsTabMachines.some(m => m.id === prev)) {
            sel.value = prev;
          } else {
            sel.value = 'local';
            agentsTabSelectedMachineId = 'local';
          }
          agentsTabUpdateMachineTransportLabel();
        }

        function agentsTabUpdateMachineTransportLabel() {
          const span = document.getElementById('agents-tab-machine-transport');
          if (!span) { return; }
          const m = agentsTabMachineById(agentsTabSelectedMachineId);
          if (!m || m.transport === 'local' || !m.transportPrefix) {
            span.textContent = m && m.id !== 'local' ? '(local)' : '';
          } else {
            span.textContent = `(${m.transport} ${m.transportPrefix})`;
          }
          const delBtn = document.getElementById('agents-tab-btn-delete-machine');
          if (delBtn) { delBtn.style.display = agentsTabSelectedMachineId === 'local' ? 'none' : ''; }
        }

        function agentsTabShowMachineForm(mode) {
          agentsTabMachineEditing = mode;
          const form = document.getElementById('agents-tab-machine-form');
          const title = document.getElementById('agents-tab-machine-form-title');
          if (!form || !title) { return; }
          title.textContent = mode === 'edit' ? 'Edit Machine' : 'New Machine';
          if (mode === 'edit') {
            const m = agentsTabMachineById(agentsTabSelectedMachineId);
            document.getElementById('agents-tab-machine-name').value = m?.name || '';
            document.getElementById('agents-tab-machine-id').value = m?.id || '';
            document.getElementById('agents-tab-machine-id').disabled = true;
            document.getElementById('agents-tab-machine-transport-select').value = m?.transport || 'local';
            document.getElementById('agents-tab-machine-prefix').value = m?.transportPrefix || '';
            document.getElementById('agents-tab-machine-clipath').value = m?.cliPath || '';
            document.getElementById('agents-tab-machine-remotecwd').value = m?.remoteCwd || '';
          } else {
            document.getElementById('agents-tab-machine-name').value = '';
            document.getElementById('agents-tab-machine-id').value = '';
            document.getElementById('agents-tab-machine-id').disabled = false;
            document.getElementById('agents-tab-machine-transport-select').value = 'local';
            document.getElementById('agents-tab-machine-prefix').value = '';
            document.getElementById('agents-tab-machine-clipath').value = '';
            document.getElementById('agents-tab-machine-remotecwd').value = '';
          }
          document.getElementById('agents-tab-machine-error').textContent = '';
          form.style.display = '';
        }

        function agentsTabHideMachineForm() {
          agentsTabMachineEditing = null;
          const form = document.getElementById('agents-tab-machine-form');
          if (form) { form.style.display = 'none'; }
          document.getElementById('agents-tab-machine-id').disabled = false;
        }

        function agentsTabSaveMachine() {
          const name = document.getElementById('agents-tab-machine-name').value.trim();
          const id = document.getElementById('agents-tab-machine-id').value.trim().replace(/\s+/g, '-');
          const transport = document.getElementById('agents-tab-machine-transport-select').value;
          const prefix = document.getElementById('agents-tab-machine-prefix').value.trim();
          const errEl = document.getElementById('agents-tab-machine-error');
          if (!name || !id) {
            errEl.textContent = 'Name and ID are required.';
            return;
          }
          if (!/^[A-Za-z0-9_.-]+$/.test(id)) {
            errEl.textContent = 'ID must be alphanumeric (letters, digits, _, ., -).';
            return;
          }
          if (transport !== 'local' && !prefix) {
            errEl.textContent = 'Transport prefix is required for ssh/mosh.';
            return;
          }
          if (transport === 'local' && prefix) {
            errEl.textContent = 'Local transport must have an empty prefix.';
            return;
          }
          if (agentsTabMachineEditing === 'add' && agentsTabMachineById(id)) {
            errEl.textContent = `Machine id '${id}' already exists.`;
            return;
          }
          // Optional per-machine fields (plan: a-remote-machines-cli-path-and-
          // working-directory): cliPath overrides the remote's CLI binary;
          // remoteCwd is the directory the seat cd's into. Both pass straight
          // through to the AgentMachine record — empty is a real value (bare
          // `switchboard` on the remote PATH / remote $HOME), stored absent.
          const cliPath = document.getElementById('agents-tab-machine-clipath').value.trim();
          const remoteCwd = document.getElementById('agents-tab-machine-remotecwd').value.trim();
          const machine = {
            id, name, transport,
            transportPrefix: transport === 'local' ? '' : prefix,
            ...(cliPath ? { cliPath } : {}),
            ...(remoteCwd ? { remoteCwd } : {}),
          };
          vscode.postMessage({ type: 'saveMachine', machine, mode: agentsTabMachineEditing });
          agentsTabHideMachineForm();
        }

        function agentsTabDeleteMachine() {
          if (agentsTabSelectedMachineId === 'local') { return; }
          vscode.postMessage({ type: 'deleteMachine', machineId: agentsTabSelectedMachineId });
        }

        function agentsTabProbeMachine() {
          const statusEl = document.getElementById('agents-tab-machine-probe-status');
          if (statusEl) { statusEl.textContent = 'probing...'; statusEl.style.color = 'var(--text-secondary)'; }
          vscode.postMessage({ type: 'probeMachine', machineId: agentsTabSelectedMachineId });
        }

        document.getElementById('agents-tab-machine-select')?.addEventListener('change', (e) => {
          agentsTabSelectedMachineId = e.target.value || 'local';
          agentsTabUpdateMachineTransportLabel();
          // Request the per-machine command map from the backend.
          vscode.postMessage({ type: 'getStartupCommandsForMachine', machineId: agentsTabSelectedMachineId });
        });
        document.getElementById('agents-tab-btn-add-machine')?.addEventListener('click', () => agentsTabShowMachineForm('add'));
        document.getElementById('agents-tab-btn-edit-machine')?.addEventListener('click', () => agentsTabShowMachineForm('edit'));
        document.getElementById('agents-tab-btn-delete-machine')?.addEventListener('click', agentsTabDeleteMachine);
        document.getElementById('agents-tab-btn-probe-machine')?.addEventListener('click', agentsTabProbeMachine);
        document.getElementById('agents-tab-btn-save-machine')?.addEventListener('click', agentsTabSaveMachine);
        document.getElementById('agents-tab-btn-cancel-machine')?.addEventListener('click', agentsTabHideMachineForm);

        function agentsTabCollectConfig() {
          const commands = {}, visibleAgents = {};
          // The Agent Visibility & CLI Commands section lives in #agents-tab-content;
          // the Delegation section moved to #teams-tab-content. Query both containers
          // so a moved control with data-role is still collected.
          document.querySelectorAll('#agents-tab-content input[type="text"][data-role], #teams-tab-content input[type="text"][data-role]').forEach(i => {
            if (i.dataset.role) commands[i.dataset.role] = i.value.trim();
          });
          document.querySelectorAll('#agents-tab-content .agents-tab-visible-toggle, #teams-tab-content .agents-tab-visible-toggle').forEach(cb => {
            if (cb.dataset.role) visibleAgents[cb.dataset.role] = cb.checked;
          });
          return {
            commands, visibleAgents,
            // Thread the selected machine so the backend writes to the
            // per-machine command map, not the legacy flat key. See the plan
            // `agents-are-saved-per-machine-and-a-team-picks-one`.
            machineId: agentsTabSelectedMachineId,
            julesAutoSyncEnabled: document.getElementById('agents-tab-jules-auto-sync')?.checked ?? false,
            plannerTerminalCount: parseInt(document.getElementById('agents-tab-planner-terminal-count')?.value || '1', 10),
            plannerLimitDispatchToTerminals: document.getElementById('agents-tab-planner-limit-dispatch')?.checked ?? false
          };
        }
        function agentsTabSaveConfig() {
          vscode.postMessage({ type: 'saveStartupCommands', ...agentsTabCollectConfig() });
        }

        // Autosave on checkbox change or text blur.
        // Bind over both #agents-tab-content and #teams-tab-content — the
        // Delegation section moved to TEAMS, and a moved control that renders
        // correctly can still be silently dropped from the collector if the
        // selector stays scoped to AGENTS alone.
        document.querySelectorAll('#agents-tab-content input[type="checkbox"], #teams-tab-content input[type="checkbox"]').forEach(cb => {
          cb.addEventListener('change', agentsTabSaveConfig);
        });
        document.querySelectorAll('#agents-tab-content input[type="text"][data-role], #teams-tab-content input[type="text"][data-role]').forEach(i => {
          i.addEventListener('blur', agentsTabSaveConfig);
        });
        document.getElementById('agents-tab-planner-terminal-count')?.addEventListener('change', agentsTabSaveConfig);
        document.getElementById('agents-tab-planner-limit-dispatch')?.addEventListener('change', agentsTabSaveConfig);




        // NOTE: Prompts tab autosave is handled by initPromptsTabListeners() and saveRoleConfig(),
        // which correctly read from actual element IDs (plannerAddon*, roleAddonsGroup, etc.).
        // The old promptsTabCollectConfig() was removed — it referenced non-existent element IDs
        // and caused data loss by sending all-false values on every checkbox change.

        /* ── Tooltip overlay system ─────────────────────────────────── */

        // ── Tab switching logic (simplified: 4 tabs, no kanban/worktrees/uat) ──
        const kanbanTabButtons = document.querySelectorAll('.shared-tab-btn');
        const kanbanTabContents = document.querySelectorAll('.shared-tab-content');

        kanbanTabButtons.forEach(btn => {
            btn.addEventListener('click', () => {
                const tabName = btn.dataset.tab;

                // Switch tabs
                kanbanTabButtons.forEach(b => b.classList.remove('active'));
                kanbanTabContents.forEach(c => c.classList.remove('active'));

                btn.classList.add('active');
                const targetContent = document.getElementById(`${tabName}-tab-content`);
                if (targetContent) {
                    targetContent.classList.add('active');
                }

                // Hydrate AGENTS tab when activated
                if (tabName === 'agents') {
                  postKanbanMessage({ type: 'getStartupCommands' });
                  postKanbanMessage({ type: 'getCustomAgents' });
                  postKanbanMessage({ type: 'getBuildTarget' });
                }

                // Hydrate TEAMS tab when activated — agent groups, gallery,
                // delegation panel and role configs all moved here from AGENTS.
                if (tabName === 'teams') {
                  postKanbanMessage({ type: 'getAgentGroups' });
                  loadRoleConfigs();
                  agentsTabPopulateRoleSelect();
                  agentsTabRenderDelegationPanel(currentDelegationRole);
                  teamsTabRenderGallery();
                }

                // Hydrate PROMPTS tab when activated
                if (tabName === 'prompts') {
                  postKanbanMessage({ type: 'getCustomAgents' });
                  loadRoleConfigs();
                  updateRoleDescription();
                  const promptsTab = document.querySelector('.prompts-tab');
                  if (promptsTab) promptsTab.scrollTop = 0;
                }

                // Hydrate STANDING ORDERS tab when activated — fetch the order
                // list and the team/role selector data. Reuses the agentGroups
                // and customAgents payloads already requested by other tabs.
                if (tabName === 'standing-orders') {
                  postKanbanMessage({ type: 'getStandingOrders' });
                  postKanbanMessage({ type: 'getAgentGroups' });
                  postKanbanMessage({ type: 'getCustomAgents' });
                  standingOrdersTabPopulateRoleSelect();
                  standingOrdersTabPopulateTeamSelect();
                  standingOrdersTabRender();
                }

                // Persist the active sub-tab (namespaced state).
                agentControlSet({ activeTab: tabName });
            });
        });

        // ── AGENT CONTROL STATE ─────────────────────────────────────────────────
        // The panel IS the agent-control view — no projection flag. Persisted state
        // is namespaced under `agentControl` so it never collides with the board's
        // getState() blob.
        const AGENT_CONTROL_TABS = ['agents', 'teams', 'prompts', 'standing-orders'];
        let _agentControlPendingRole = null;

        function agentControlGet() {
            try {
                const s = vscode.getState() || {};
                return s.agentControl || null;
            } catch (_) { return null; }
        }

        function agentControlSet(patch) {
            try {
                const s = vscode.getState() || {};
                s.agentControl = Object.assign({}, s.agentControl, patch);
                vscode.setState(s);
            } catch (_) {}
        }

        // Restore the persisted active tab on load. The HTML ships with AGENTS
        // active; if the persisted tab is one of the four, move the active markers
        // before the initial click() below so the hydration arm fires for the right tab.
        {
            const _ac = agentControlGet();
            const _acTab = (_ac && AGENT_CONTROL_TABS.indexOf(_ac.activeTab) !== -1) ? _ac.activeTab : 'agents';
            _agentControlPendingRole = (_ac && _ac.role) || null;
            const _acTargetBtn = document.querySelector('.shared-tab-btn[data-tab="' + _acTab + '"]');
            const _acTargetContent = document.getElementById(_acTab + '-tab-content');
            // Clear the default AGENTS active markers, then set the target tab active.
            document.querySelectorAll('.shared-tab-btn.active').forEach(b => b.classList.remove('active'));
            document.querySelectorAll('.shared-tab-content.active').forEach(c => c.classList.remove('active'));
            if (_acTargetBtn) { _acTargetBtn.classList.add('active'); }
            if (_acTargetContent) { _acTargetContent.classList.add('active'); }
        }

        // ── STANDING ORDERS TAB ──────────────────────────────────────────────
        // State + rendering for the Standing Orders tab (Agent Control view).
        // All data flows through kanban verbs — the webview CSP forbids direct
        // HTTP fetches. `pair` orders are list + delete only (add/edit stays in
        // the Link-up modal, which has the terminal-pairing selectors this view
        // lacks). No confirm gate on delete (per CLAUDE.md).
        // `available` is tri-state: `null` = no response yet (the tab was just
        // activated and nothing has answered), `true` = the store answered with
        // orders, `false` = the host refused (no root resolved, or the DB read
        // threw). The red gate renders ONLY on an explicit `false` — a `null`
        // would otherwise paint "no database" before any answer could arrive
        // (the original bug: the activation arm posts the verb and renders in the
        // same synchronous block). `reason` names the refusal when `available` is
        // false, so "no workspace root" and "the DB read threw" are not conflated.
        const standingOrdersTabState = { available: null, orders: [], definitions: [], coreOrders: [], reason: null };
        // Mirrors of the deterministic id prefixes the host installers mint —
        // constant STRINGS, not resolution logic (same precedent as the
        // STANDING_ORDERS_MARKER mirror in terminals.js). A row minted by an
        // installer can reappear after a delete; the SYSTEM-INSTALLED label
        // makes that legible instead of looking like a failed delete.
        const standingOrdersTabInstallerPrefixes = ['completion-directive:role:', 'review-callback:', 'global-queue-done:'];
        const standingOrdersTabBuiltInRoles = ['planner', 'lead', 'coder', 'intern', 'reviewer', 'tester', 'analyst', 'researcher', 'ticket_updater', 'jules'];

        function standingOrdersTabEscapeHtml(s) {
            return String(s == null ? '' : s)
                .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
                .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
        }

        function standingOrdersTabCurrentScope() {
            const sel = document.getElementById('standing-orders-scope-filter');
            return sel ? sel.value : 'all';
        }

        function standingOrdersTabTeamName(teamId) {
            const groups = (typeof agentsTabAgentGroups !== 'undefined' && Array.isArray(agentsTabAgentGroups)) ? agentsTabAgentGroups : [];
            const g = groups.find(x => x && x.id === teamId);
            return g ? g.name : null;
        }

        function standingOrdersTabCustomAgents() {
            try {
                return Array.isArray(lastCustomAgents) ? lastCustomAgents : [];
            } catch (_) {
                return [];
            }
        }

        function standingOrdersTabRoleExists(role) {
            if (standingOrdersTabBuiltInRoles.includes(role)) { return true; }
            return standingOrdersTabCustomAgents().some(agent => agent && (agent.id === role || agent.name === role));
        }

        function standingOrdersTabDefinition(id) {
            return (standingOrdersTabState.definitions || []).find(definition => definition && definition.id === id) || null;
        }

        function standingOrdersTabScopeBadge(o) {
            const scope = o.scope || 'pair';
            if (scope === 'global') { return 'GLOBAL'; }
            if (scope === 'role') {
                const role = o.role || '?';
                return 'ROLE: ' + standingOrdersTabEscapeHtml(role) + (standingOrdersTabRoleExists(role) ? '' : ' (role not found)');
            }
            if (scope === 'team' || scope === 'team-head') {
                const name = standingOrdersTabTeamName(o.teamId);
                const label = scope === 'team-head' ? 'TEAM-HEAD' : 'TEAM';
                if (name) { return label + ': ' + standingOrdersTabEscapeHtml(name); }
                return label + ': ' + standingOrdersTabEscapeHtml(o.teamId || '?') + ' (team not found)';
            }
            // pair
            return 'PAIR: ' + standingOrdersTabEscapeHtml(o.parent || '?') + ' → ' + standingOrdersTabEscapeHtml(o.child || '?');
        }

        function standingOrdersTabPopulateRoleSelect() {
            const sel = document.getElementById('standing-orders-add-role');
            if (!sel) { return; }
            // Reuse the Prompts tab's built-in role list + custom agents.
            const custom = standingOrdersTabCustomAgents();
            let html = '';
            for (const r of standingOrdersTabBuiltInRoles) {
                html += '<option value="' + standingOrdersTabEscapeHtml(r) + '">' + standingOrdersTabEscapeHtml(r) + '</option>';
            }
            if (custom.length) {
                html += '<optgroup label="Custom Agents">';
                for (const c of custom) {
                    const v = c.id || c.name || '';
                    html += '<option value="' + standingOrdersTabEscapeHtml(v) + '">' + standingOrdersTabEscapeHtml(c.name || v) + '</option>';
                }
                html += '</optgroup>';
            }
            sel.innerHTML = html;
        }

        function standingOrdersTabPopulateTeamSelect() {
            const sel = document.getElementById('standing-orders-add-team');
            if (!sel) { return; }
            const groups = (typeof agentsTabAgentGroups !== 'undefined' && Array.isArray(agentsTabAgentGroups)) ? agentsTabAgentGroups : [];
            if (!groups.length) {
                sel.innerHTML = '<option value="">No teams available</option>';
                sel.disabled = true;
            } else {
                sel.disabled = false;
                sel.innerHTML = groups.map(g => '<option value="' + standingOrdersTabEscapeHtml(g.id) + '">' + standingOrdersTabEscapeHtml(g.name || g.id) + '</option>').join('');
            }
        }

        function standingOrdersTabPopulateDefinitionSelect() {
            const row = document.getElementById('standing-orders-add-def-row');
            const select = document.getElementById('standing-orders-add-def');
            if (!row || !select) { return; }
            const definitions = standingOrdersTabState.available
                ? (standingOrdersTabState.definitions || []).filter(definition => definition && definition.id)
                : [];
            const selected = select.value;
            row.style.display = definitions.length ? 'block' : 'none';
            select.innerHTML = '<option value="">(none)</option>' + definitions.map(definition => {
                const label = definition.name || String(definition.instruction || '').slice(0, 60) || 'Untitled';
                return '<option value="' + standingOrdersTabEscapeHtml(definition.id) + '">' + standingOrdersTabEscapeHtml(label) + '</option>';
            }).join('');
            if (definitions.some(definition => definition.id === selected)) { select.value = selected; }
        }

        function standingOrdersTabFilteredOrders() {
            const scope = standingOrdersTabCurrentScope();
            const orders = standingOrdersTabState.orders || [];
            if (scope === 'all') { return orders; }
            return orders.filter(o => (o.scope || 'pair') === scope);
        }

        function standingOrdersTabRender() {
            const listEl = document.getElementById('standing-orders-list');
            const emptyEl = document.getElementById('standing-orders-empty');
            const unavailEl = document.getElementById('standing-orders-unavailable');
            const loadingEl = document.getElementById('standing-orders-loading');
            const addBtn = document.getElementById('standing-orders-add-btn');
            const defListEl = document.getElementById('standing-orders-def-list');
            const defEmptyEl = document.getElementById('standing-orders-def-empty');
            const defAddBtn = document.getElementById('standing-orders-def-add-btn');
            if (!listEl || !defListEl) { return; }

            // Tri-state availability gate:
            //   null  — no response yet: show a quiet loading line, hide the red
            //           gate, and keep the add buttons disabled (we do not know
            //           whether the store is reachable).
            //   false — the host refused: show the red gate, named by `reason`
            //           (falling back to the legacy sentence when no reason was
            //           carried), disable the add buttons.
            //   true  — store answered: hide both gate and loading, enable adds.
            const available = standingOrdersTabState.available;
            if (loadingEl) { loadingEl.style.display = (available === null) ? 'block' : 'none'; }
            if (unavailEl) {
                unavailEl.style.display = (available === false) ? 'block' : 'none';
                if (available === false) {
                    // Name the refusal when the host gave a reason; otherwise the
                    // legacy sentence stands. `reason` is HTML-escaped because it
                    // carries an error message that may reach the DOM.
                    unavailEl.textContent = standingOrdersTabState.reason
                        ? standingOrdersTabState.reason
                        : 'Standing orders require a Kanban database. Open Setup to configure one.';
                }
            }
            const addEnabled = available === true;
            if (addBtn) { addBtn.disabled = !addEnabled; }
            if (defAddBtn) { defAddBtn.disabled = !addEnabled; }

            const definitions = addEnabled
                ? (standingOrdersTabState.definitions || []).filter(definition => definition && definition.id)
                : [];
            defListEl.innerHTML = definitions.map(definition => standingOrdersTabRenderDefRow(definition)).join('');
            if (defEmptyEl) { defEmptyEl.style.display = addEnabled && !definitions.length ? 'block' : 'none'; }
            standingOrdersTabPopulateDefinitionSelect();

            const filtered = standingOrdersTabFilteredOrders();
            // The "No standing orders in this scope." line is a claim about an
            // ANSWERED store, not a not-yet-answered one — suppress it while
            // `available` is null so loading is not misread as empty.
            if (emptyEl) { emptyEl.style.display = (addEnabled && !filtered.length) ? 'block' : 'none'; }
            listEl.innerHTML = filtered.map(o => standingOrdersTabRenderRow(o)).join('');

            // Core orders — system-composed at delivery, never persisted.
            // Read-only rows: no edit, no delete, because there is no stored
            // row to mutate. Same scope filter applies.
            const coreListEl = document.getElementById('standing-orders-core-list');
            const coreEmptyEl = document.getElementById('standing-orders-core-empty');
            if (coreListEl) {
                const scope = standingOrdersTabCurrentScope();
                const coreOrders = addEnabled
                    ? (standingOrdersTabState.coreOrders || []).filter(o => scope === 'all' || (o.scope || 'pair') === scope)
                    : [];
                coreListEl.innerHTML = coreOrders.map(o => standingOrdersTabRenderCoreRow(o)).join('');
                if (coreEmptyEl) { coreEmptyEl.style.display = (addEnabled && !coreOrders.length) ? 'block' : 'none'; }
            }
        }

        function standingOrdersTabRenderCoreRow(o) {
            const badge = '<span style="font-size: 10px; font-weight: bold; letter-spacing: 0.5px; color: var(--text-secondary, #999);">' + standingOrdersTabScopeBadge(o) + '</span>'
                + '<span style="font-size: 10px; margin-left: 6px; border:1px solid currentColor; padding:0 4px; border-radius:3px; color: var(--text-secondary, #999);">CORE — composed at delivery</span>';
            const instruction = standingOrdersTabEscapeHtml(o.instruction || '');
            const idLine = '<div style="font-size: 10px; color: var(--text-secondary, #999); margin-top: 6px; font-family: monospace;">' + standingOrdersTabEscapeHtml(o.id || '') + '</div>';
            return '<div style="border:1px solid var(--panel-border, #444); padding:10px; margin-bottom:8px; border-radius:4px;">'
                + '<div style="display:flex; justify-content:space-between; align-items:flex-start; gap:8px; flex-wrap:wrap; margin-bottom:6px;">'
                + '<div>' + badge + '</div>'
                + '<div style="font-size: 10px; color: var(--text-secondary, #999);">read-only — no stored row</div>'
                + '</div>'
                + '<div style="font-size: 12px; white-space:pre-wrap; word-break:break-word;">' + instruction + '</div>'
                + idLine
                + '</div>';
        }

        function standingOrdersTabRenderRow(o) {
            const scope = o.scope || 'pair';
            const isPair = scope === 'pair';
            const instruction = standingOrdersTabEscapeHtml(o.instruction || '');
            const effective = o.effectiveInstruction && o.effectiveInstruction !== o.instruction
                ? standingOrdersTabEscapeHtml(o.effectiveInstruction) : null;
            const staleBadge = o.stale ? '<span style="color: var(--accent-red, #f48771); font-size: 10px; margin-left: 6px; border:1px solid currentColor; padding:0 4px; border-radius:3px;">stale</span>' : '';
            const droppedBadge = o.dropped ? '<span style="color: var(--accent-red, #f48771); font-size: 10px; margin-left: 6px; border:1px solid currentColor; padding:0 4px; border-radius:3px;">dropped</span>' : '';
            const installerBadge = standingOrdersTabInstallerPrefixes.some(p => (o.id || '').indexOf(p) === 0)
                ? '<span style="font-size: 10px; margin-left: 6px; border:1px solid currentColor; padding:0 4px; border-radius:3px; color: var(--text-secondary, #999);">SYSTEM-INSTALLED</span>' : '';
            const badge = '<span style="font-size: 10px; font-weight: bold; letter-spacing: 0.5px; color: var(--text-secondary, #999);">' + standingOrdersTabScopeBadge(o) + '</span>' + staleBadge + droppedBadge + installerBadge;
            // NO inline onclick= — the kanban webview's CSP is
            // `script-src 'nonce-...' <cspSource>` with no 'unsafe-inline', so an
            // inline handler attribute is blocked and the button does literally
            // nothing (the same silent-no-op class as window.confirm() here).
            // Actions ride data-so-action and are dispatched by the delegated
            // listener wired in standingOrdersTabWireEvents().
            const oid = standingOrdersTabEscapeHtml(o.id);
            const editBtn = isPair
                ? '<span style="font-size: 10px; color: var(--text-secondary, #999);">Edit in Link-up modal</span>'
                : '<button class="secondary-btn" style="height:22px; line-height:20px; padding:0 8px; margin:0;" data-so-action="toggle-edit" data-so-id="' + oid + '">EDIT</button>';
            const deleteBtn = '<button class="secondary-btn" style="height:22px; line-height:20px; padding:0 8px; margin:0; color: var(--accent-red, #f48771);" data-so-action="delete" data-so-id="' + oid + '">DELETE</button>';
            const effectiveLine = effective ? '<div style="font-size: 11px; color: var(--text-secondary, #999); margin-top: 4px;">Effective: ' + effective + '</div>' : '';
            const definition = o.definitionId ? standingOrdersTabDefinition(o.definitionId) : null;
            const definitionName = definition ? (definition.name || String(definition.instruction || '').slice(0, 60) || 'Untitled') : '';
            const linkedLine = definition
                ? '<div style="font-size:11px; color:var(--text-secondary, #999); margin-top:6px;">Follows library entry «' + standingOrdersTabEscapeHtml(definitionName) + '» — editing here detaches this order</div>'
                : '';
            const editForm = isPair ? '' : standingOrdersTabRenderEditForm(o);
            return '<div style="border:1px solid var(--panel-border, #444); padding:10px; margin-bottom:8px; border-radius:4px;">'
                + '<div style="display:flex; justify-content:space-between; align-items:flex-start; gap:8px; flex-wrap:wrap; margin-bottom:6px;">'
                + '<div>' + badge + '</div>'
                + '<div style="display:flex; gap:6px; align-items:center;">' + editBtn + deleteBtn + '</div>'
                + '</div>'
                + '<div style="font-size: 12px; white-space:pre-wrap; word-break:break-word;">' + instruction + '</div>'
                + effectiveLine
                + linkedLine
                + editForm
                // The deterministic id is the legibility anchor: an
                // installer-owned row that reappears after a delete is
                // recognisable as the same row, not a UI failure.
                + '<div style="font-size: 10px; color: var(--text-secondary, #999); margin-top: 6px; font-family: monospace;">' + oid + '</div>'
                + '</div>';
        }

        function standingOrdersTabRenderDefRow(definition) {
            const id = standingOrdersTabEscapeHtml(definition.id);
            const name = standingOrdersTabEscapeHtml(definition.name || String(definition.instruction || '').slice(0, 60) || 'Untitled');
            const instruction = standingOrdersTabEscapeHtml(definition.instruction || '');
            const usageCount = (standingOrdersTabState.orders || []).filter(order => order && order.definitionId === definition.id).length;
            const usageLine = usageCount === 0
                ? 'Used by no orders — safe to delete'
                : 'Used by ' + usageCount + ' ' + (usageCount === 1 ? 'order' : 'orders');
            const updateLine = usageCount > 0
                ? '<div style="font-size:11px; color:var(--text-secondary, #999); margin-bottom:6px;">Saving updates the instruction on ' + usageCount + ' ' + (usageCount === 1 ? 'order' : 'orders') + '.</div>'
                : '';
            return '<div style="border:1px solid var(--panel-border, #444); padding:10px; margin-bottom:8px; border-radius:4px;">'
                + '<div style="display:flex; justify-content:space-between; align-items:flex-start; gap:8px; flex-wrap:wrap; margin-bottom:6px;">'
                + '<strong style="font-size:12px;">' + name + '</strong>'
                + '<div style="display:flex; gap:6px; align-items:center;">'
                + '<button class="secondary-btn" style="height:22px; line-height:20px; padding:0 8px; margin:0;" data-so-def-action="toggle-edit" data-so-def-id="' + id + '">EDIT</button>'
                + '<button class="secondary-btn" style="height:22px; line-height:20px; padding:0 8px; margin:0; color:var(--accent-red, #f48771);" data-so-def-action="delete" data-so-def-id="' + id + '">DELETE</button>'
                + '</div></div>'
                + '<div style="font-size:12px; white-space:pre-wrap; word-break:break-word;">' + instruction + '</div>'
                + '<div style="font-size:11px; color:var(--text-secondary, #999); margin-top:6px;">' + usageLine + '</div>'
                + '<div id="standing-orders-def-edit-' + id + '" style="display:none; margin-top:8px; border-top:1px solid var(--panel-border, #444); padding-top:8px;">'
                + updateLine
                + '<label class="modal-label" for="standing-orders-def-edit-name-' + id + '">Name</label>'
                + '<input id="standing-orders-def-edit-name-' + id + '" class="modal-input" type="text" value="' + name + '">'
                + '<label class="modal-label" for="standing-orders-def-edit-instruction-' + id + '">Instruction</label>'
                + '<textarea id="standing-orders-def-edit-instruction-' + id + '" class="modal-textarea" rows="3">' + instruction + '</textarea>'
                + '<div id="standing-orders-def-edit-error-' + id + '" style="min-height:16px; color:var(--accent-red); font-size:11px; margin-top:4px;"></div>'
                + '<div class="flex gap-2" style="margin-top:6px;">'
                + '<button class="action-btn" style="height:24px; line-height:22px; padding:0 10px;" data-so-def-action="save-edit" data-so-def-id="' + id + '">SAVE</button>'
                + '<button class="secondary-btn" style="height:24px; line-height:22px; padding:0 10px;" data-so-def-action="toggle-edit" data-so-def-id="' + id + '">CANCEL</button>'
                + '</div></div></div>';
        }

        function standingOrdersTabToggleDefEdit(id) {
            const form = document.getElementById('standing-orders-def-edit-' + id);
            if (form) { form.style.display = form.style.display === 'none' ? 'block' : 'none'; }
        }

        function standingOrdersTabSaveDefEdit(id) {
            const nameInput = document.getElementById('standing-orders-def-edit-name-' + id);
            const instructionInput = document.getElementById('standing-orders-def-edit-instruction-' + id);
            const errorEl = document.getElementById('standing-orders-def-edit-error-' + id);
            const instruction = instructionInput ? instructionInput.value : '';
            if (!instruction.trim()) {
                if (errorEl) { errorEl.textContent = 'Instruction is required'; }
                return;
            }
            const enteredName = nameInput ? nameInput.value.trim() : '';
            if (errorEl) { errorEl.textContent = ''; }
            postKanbanMessage({
                type: 'updateStandingOrderDefinition',
                id: id,
                name: enteredName || instruction.slice(0, 60),
                instruction: instruction
            });
        }

        function standingOrdersTabDeleteDef(id) {
            postKanbanMessage({ type: 'deleteStandingOrderDefinition', id: id });
        }

        function standingOrdersTabShowDefAddForm() {
            if (!standingOrdersTabState.available) { return; }
            const form = document.getElementById('standing-orders-def-add-form');
            const errorEl = document.getElementById('standing-orders-def-add-error');
            if (errorEl) { errorEl.textContent = ''; }
            if (form) { form.style.display = 'block'; }
        }

        function standingOrdersTabHideDefAddForm() {
            const form = document.getElementById('standing-orders-def-add-form');
            const nameInput = document.getElementById('standing-orders-def-add-name');
            const instructionInput = document.getElementById('standing-orders-def-add-instruction');
            const errorEl = document.getElementById('standing-orders-def-add-error');
            if (form) { form.style.display = 'none'; }
            if (nameInput) { nameInput.value = ''; }
            if (instructionInput) { instructionInput.value = ''; }
            if (errorEl) { errorEl.textContent = ''; }
        }

        function standingOrdersTabSubmitDefAdd() {
            const nameInput = document.getElementById('standing-orders-def-add-name');
            const instructionInput = document.getElementById('standing-orders-def-add-instruction');
            const errorEl = document.getElementById('standing-orders-def-add-error');
            const instruction = instructionInput ? instructionInput.value : '';
            if (!instruction.trim()) {
                if (errorEl) { errorEl.textContent = 'Instruction is required'; }
                return;
            }
            const enteredName = nameInput ? nameInput.value.trim() : '';
            if (errorEl) { errorEl.textContent = ''; }
            postKanbanMessage({
                type: 'addStandingOrderDefinition',
                name: enteredName || instruction.slice(0, 60),
                instruction: instruction
            });
        }

        function standingOrdersTabUseDefinition() {
            const form = document.getElementById('standing-orders-add-form');
            const select = document.getElementById('standing-orders-add-def');
            const instructionInput = document.getElementById('standing-orders-add-instruction');
            if (!form || !select || !instructionInput) { return; }
            const definition = standingOrdersTabDefinition(select.value);
            form.dataset.definitionId = definition ? definition.id : '';
            if (definition) { instructionInput.value = definition.instruction || ''; }
        }

        function standingOrdersTabDetachDefinition() {
            const form = document.getElementById('standing-orders-add-form');
            const select = document.getElementById('standing-orders-add-def');
            if (form) { form.dataset.definitionId = ''; }
            if (select) { select.value = ''; }
        }

        function standingOrdersTabRenderEditForm(o) {
            const id = standingOrdersTabEscapeHtml(o.id);
            return '<div id="standing-orders-edit-' + id + '" style="display:none; margin-top:8px; border-top:1px solid var(--panel-border, #444); padding-top:8px;">'
                + '<textarea id="standing-orders-edit-instruction-' + id + '" class="modal-textarea" rows="3">' + standingOrdersTabEscapeHtml(o.instruction || '') + '</textarea>'
                + '<div id="standing-orders-edit-error-' + id + '" style="min-height:16px; color: var(--accent-red); font-size: 11px; margin-top: 4px;"></div>'
                + '<div class="flex gap-2" style="margin-top: 6px;">'
                + '<button class="action-btn" style="height:24px; line-height:22px; padding:0 10px;" data-so-action="save-edit" data-so-id="' + id + '">SAVE</button>'
                + '<button class="secondary-btn" style="height:24px; line-height:22px; padding:0 10px;" data-so-action="toggle-edit" data-so-id="' + id + '">CANCEL</button>'
                + '</div></div>';
        }

        function standingOrdersTabToggleEdit(id) {
            const form = document.getElementById('standing-orders-edit-' + id);
            if (form) { form.style.display = form.style.display === 'none' ? 'block' : 'none'; }
        }

        function standingOrdersTabSaveEdit(id) {
            const ta = document.getElementById('standing-orders-edit-instruction-' + id);
            const errEl = document.getElementById('standing-orders-edit-error-' + id);
            const instruction = ta ? ta.value : '';
            // Empty instruction = delete (matches the team cockpit editor convention).
            if (!instruction.trim()) {
                standingOrdersTabDelete(id);
                return;
            }
            if (errEl) { errEl.textContent = ''; }
            postKanbanMessage({ type: 'updateStandingOrder', id: id, instruction: instruction });
        }

        function standingOrdersTabDelete(id) {
            // No confirm gate — per CLAUDE.md, delete buttons delete immediately.
            postKanbanMessage({ type: 'deleteStandingOrder', id: id });
        }

        function standingOrdersTabShowAddForm() {
            if (!standingOrdersTabState.available) { return; }
            const scope = standingOrdersTabCurrentScope();
            const form = document.getElementById('standing-orders-add-form');
            const note = document.getElementById('standing-orders-add-scope-note');
            const roleRow = document.getElementById('standing-orders-add-role-row');
            const teamRow = document.getElementById('standing-orders-add-team-row');
            const definitionRow = document.getElementById('standing-orders-add-def-row');
            const err = document.getElementById('standing-orders-add-error');
            if (!form) { return; }

            // pair scope: add stays in the Link-up modal.
            if (scope === 'pair') {
                if (note) { note.textContent = 'Add pair orders via the Link-up modal.'; }
                if (roleRow) { roleRow.style.display = 'none'; }
                if (teamRow) { teamRow.style.display = 'none'; }
                if (definitionRow) { definitionRow.style.display = 'none'; }
                form.dataset.definitionId = '';
                form.style.display = 'block';
                const submit = document.getElementById('standing-orders-add-submit');
                if (submit) { submit.disabled = true; }
                return;
            }
            // "all" scope: default to global when adding from the All view.
            const addScope = scope === 'all' ? 'global' : scope;
            if (note) { note.textContent = 'Adding a ' + addScope.toUpperCase() + ' order.'; }
            if (roleRow) { roleRow.style.display = addScope === 'role' ? 'block' : 'none'; }
            if (teamRow) { teamRow.style.display = (addScope === 'team' || addScope === 'team-head') ? 'block' : 'none'; }
            if (err) { err.textContent = ''; }
            const submit = document.getElementById('standing-orders-add-submit');
            if (submit) { submit.disabled = false; }
            standingOrdersTabPopulateDefinitionSelect();
            form.style.display = 'block';
            form.dataset.scope = addScope;
        }

        function standingOrdersTabHideAddForm() {
            const form = document.getElementById('standing-orders-add-form');
            if (form) {
                form.style.display = 'none';
                form.dataset.definitionId = '';
            }
            const ta = document.getElementById('standing-orders-add-instruction');
            if (ta) { ta.value = ''; }
            const definitionSelect = document.getElementById('standing-orders-add-def');
            if (definitionSelect) { definitionSelect.value = ''; }
            const err = document.getElementById('standing-orders-add-error');
            if (err) { err.textContent = ''; }
        }

        function standingOrdersTabSubmitAdd() {
            const form = document.getElementById('standing-orders-add-form');
            if (!form) { return; }
            const scope = form.dataset.scope || 'global';
            const ta = document.getElementById('standing-orders-add-instruction');
            const instruction = ta ? ta.value : '';
            const err = document.getElementById('standing-orders-add-error');
            if (err) { err.textContent = ''; }
            if (!instruction.trim()) {
                if (err) { err.textContent = 'Instruction is required'; }
                return;
            }
            const payload = { type: 'addStandingOrder', scope: scope, instruction: instruction };
            if (form.dataset.definitionId) { payload.definitionId = form.dataset.definitionId; }
            if (scope === 'role') {
                const roleSel = document.getElementById('standing-orders-add-role');
                payload.role = roleSel ? roleSel.value : '';
                if (!payload.role) { if (err) { err.textContent = 'Role is required'; } return; }
            }
            if (scope === 'team' || scope === 'team-head') {
                const teamSel = document.getElementById('standing-orders-add-team');
                payload.teamId = teamSel ? teamSel.value : '';
                if (!payload.teamId) { if (err) { err.textContent = 'Team is required'; } return; }
            }
            postKanbanMessage(payload);
        }

        // Wire up the tab's DOM events once (idempotent — guarded by a flag).
        let _standingOrdersTabWired = false;
        function standingOrdersTabWireEvents() {
            if (_standingOrdersTabWired) { return; }
            _standingOrdersTabWired = true;
            const filter = document.getElementById('standing-orders-scope-filter');
            if (filter) { filter.addEventListener('change', standingOrdersTabRender); }
            const addBtn = document.getElementById('standing-orders-add-btn');
            if (addBtn) { addBtn.addEventListener('click', standingOrdersTabShowAddForm); }
            const cancelBtn = document.getElementById('standing-orders-add-cancel');
            if (cancelBtn) { cancelBtn.addEventListener('click', standingOrdersTabHideAddForm); }
            const submitBtn = document.getElementById('standing-orders-add-submit');
            if (submitBtn) { submitBtn.addEventListener('click', standingOrdersTabSubmitAdd); }
            const definitionSelect = document.getElementById('standing-orders-add-def');
            if (definitionSelect) { definitionSelect.addEventListener('change', standingOrdersTabUseDefinition); }
            const addInstruction = document.getElementById('standing-orders-add-instruction');
            if (addInstruction) { addInstruction.addEventListener('input', standingOrdersTabDetachDefinition); }
            const defAddBtn = document.getElementById('standing-orders-def-add-btn');
            if (defAddBtn) { defAddBtn.addEventListener('click', standingOrdersTabShowDefAddForm); }
            const defCancelBtn = document.getElementById('standing-orders-def-add-cancel');
            if (defCancelBtn) { defCancelBtn.addEventListener('click', standingOrdersTabHideDefAddForm); }
            const defSubmitBtn = document.getElementById('standing-orders-def-add-submit');
            if (defSubmitBtn) { defSubmitBtn.addEventListener('click', standingOrdersTabSubmitDefAdd); }
            // Row actions are delegated: the list is re-rendered wholesale on every
            // refresh, so per-button listeners would be re-attached (or lost) each
            // time, and inline onclick= is CSP-blocked in this webview.
            const listEl = document.getElementById('standing-orders-list');
            if (listEl) {
                listEl.addEventListener('click', function (ev) {
                    const btn = ev.target && ev.target.closest ? ev.target.closest('[data-so-action]') : null;
                    if (!btn || !listEl.contains(btn)) { return; }
                    const soId = btn.getAttribute('data-so-id') || '';
                    switch (btn.getAttribute('data-so-action')) {
                        case 'toggle-edit': standingOrdersTabToggleEdit(soId); break;
                        case 'save-edit': standingOrdersTabSaveEdit(soId); break;
                        case 'delete': standingOrdersTabDelete(soId); break;
                    }
                });
            }
            const definitionListEl = document.getElementById('standing-orders-def-list');
            if (definitionListEl) {
                definitionListEl.addEventListener('click', function (ev) {
                    const btn = ev.target && ev.target.closest ? ev.target.closest('[data-so-def-action]') : null;
                    if (!btn || !definitionListEl.contains(btn)) { return; }
                    const definitionId = btn.getAttribute('data-so-def-id') || '';
                    switch (btn.getAttribute('data-so-def-action')) {
                        case 'toggle-edit': standingOrdersTabToggleDefEdit(definitionId); break;
                        case 'save-edit': standingOrdersTabSaveDefEdit(definitionId); break;
                        case 'delete': standingOrdersTabDeleteDef(definitionId); break;
                    }
                });
            }
        }
        standingOrdersTabWireEvents();

        // Re-hydrate the Standing Orders tab after a transport reconnect. The tab's
        // only hydration is a `getStandingOrders` request posted once on activation;
        // its answer arrives as the `standingOrders` push over the WS hub (and now
        // also as the typed `standingOrdersResult` return body). If the socket was
        // down at request time the push had nowhere to land, and `__resync` carries
        // board state only — not standing orders — so the tab would stay in its
        // `available:null` loading state (or a stale `false`) until the operator
        // clicked away and back. Re-requesting on reconnect heals a host restart
        // without a manual tab switch. Only fires when this tab is the active one,
        // so an unseen tab does not generate round trips.
        window.addEventListener('sbTransportReconnected', () => {
            const activeTabBtn = document.querySelector('.shared-tab-btn.active');
            if (!activeTabBtn || activeTabBtn.dataset.tab !== 'standing-orders') { return; }
            postKanbanMessage({ type: 'getStandingOrders' });
        });

        // Initialize the initially active tab
        const initialTabBtn = document.querySelector('.shared-tab-btn.active');
        if (initialTabBtn) {
            initialTabBtn.click();
        }

        // Signal the host the panel is ready. Routed with source 'agent-control' so
        // the host takes the Agent Control ready arm (which posts the agent snapshot)
        // instead of the board's cold-start path (fullSync / pushFullState) — the
        // board render path is exactly what this panel exists to avoid.
        postKanbanMessage({ type: 'ready' });

        // ── PROMPTS TAB EVENT LISTENERS ──────────────────────────────────────────
        function initPromptsTabListeners() {
            const roleSelect = document.getElementById('roleSelect');
            if (roleSelect) {
                roleSelect.addEventListener('change', (e) => {
                    currentRole = e.target.value;
                    if (currentRole.startsWith('custom_agent_') && !roleConfigs[currentRole]) {
                        postKanbanMessage({ type: 'getSetting', key: `roleConfig_${currentRole}` });
                    }
                    handleRoleChange();
                    updateRoleDescription();
                    postKanbanMessage({ type: 'saveSetting', key: 'selectedRole', value: currentRole });
                    agentControlSet({ role: currentRole });
                });
            }

            const plannerWorkflowEnabled = document.getElementById('plannerWorkflowEnabled');
            if (plannerWorkflowEnabled) {
                plannerWorkflowEnabled.addEventListener('change', (e) => {
                    const enabled = e.target.checked;
                    document.getElementById('plannerWorkflowFilePathGroup').style.display = enabled ? 'block' : 'none';
                    if (!roleConfigs.planner) roleConfigs.planner = { workflowFilePath: '', addons: {} };
                    if (!roleConfigs.planner.addons) roleConfigs.planner.addons = {};
                    roleConfigs.planner.addons.workflowFilePathEnabled = enabled;
                    saveRoleConfig('planner');
                    refreshPreview();
                });
            }

            const workflowFilePath = document.getElementById('workflowFilePath');
            if (workflowFilePath) {
                workflowFilePath.addEventListener('change', (e) => {
                    if (!roleConfigs.planner) roleConfigs.planner = { workflowFilePath: '', addons: {} };
                    roleConfigs.planner.workflowFilePath = e.target.value;
                    saveRoleConfig('planner');
                    refreshPreview();
                });
            }

            const validateWorkflowPath = document.getElementById('validateWorkflowPath');
            if (validateWorkflowPath) {
                validateWorkflowPath.addEventListener('click', () => {
                    const pathEl = document.getElementById('workflowFilePath');
                    if (pathEl) {
                        postKanbanMessage({ type: 'fileExists', path: pathEl.value });
                    }
                });
            }
            const promptPreview = document.getElementById('promptPreview');
            if (promptPreview) {
                promptPreview.addEventListener('change', (e) => {
                    if (currentRole === 'planner') return; // read-only for planners
                    if (!roleConfigs[currentRole]) roleConfigs[currentRole] = { prompt: '', addons: {} };
                    roleConfigs[currentRole].prompt = e.target.value;
                    saveRoleConfig(currentRole);
                });
            }
            // Research complexity radio buttons (researcher only)
            document.querySelectorAll('input[name="researchComplexity"]').forEach(radio => {
                radio.addEventListener('change', (e) => {
                    if (!roleConfigs[currentRole]) roleConfigs[currentRole] = { prompt: '', addons: {} };
                    roleConfigs[currentRole].researchComplexity = e.target.value;
                    saveRoleConfig(currentRole);
                    refreshPreview();
                });
            });

            // Save to local docs listener (researcher only)
            const saveToLocalDocsCheckbox = document.getElementById('saveToLocalDocs');
            if (saveToLocalDocsCheckbox) {
                saveToLocalDocsCheckbox.addEventListener('change', (e) => {
                    if (!roleConfigs.researcher) roleConfigs.researcher = { prompt: '', addons: {} };
                    roleConfigs.researcher.saveToLocalDocs = e.target.checked;
                    saveRoleConfig('researcher');
                    refreshPreview();
                });
            }

            // Planner specific add-on listeners
            // §Pair-programming team scope: 'plannerAddonAggressivePairProgramming'
            // is retired from this list (the checkbox is gone). The remaining add-ons
            // keep their per-change save listener.
            ['plannerAddonSwitchboardSafeguards', 'plannerAddonConstitution', 'plannerAddonDesignSystemDoc', 'plannerAddonGitProhibition', 'plannerAddonClearAntigravityContext', 'plannerAddonCavemanOutput', 'plannerAddonSkipCompilation', 'plannerAddonSkipTests', 'plannerAddonAdviseResearch', 'plannerAddonWriteFeatureDescriptionIfEmpty'].forEach(id => {
                const el = document.getElementById(id);
                if (el) {
                    el.addEventListener('change', (e) => {
                        const addonIdMap = {
                            'plannerAddonDesignSystemDoc': 'designSystemDoc',
                            'plannerAddonConstitution': 'constitution'
                        };
                        const addonId = id.replace('plannerAddon', '');
                        const finalAddonId = addonIdMap[id] || (addonId.charAt(0).toLowerCase() + addonId.slice(1));
                        if (!roleConfigs.planner) roleConfigs.planner = { workflowFilePath: '', addons: {} };
                        if (!roleConfigs.planner.addons) roleConfigs.planner.addons = {};
                        roleConfigs.planner.addons[finalAddonId] = e.target.checked;
                        saveRoleConfig('planner');
                        refreshPreview();
                    });
                }
            });

            // Planner subagent policy radio listeners
            const plannerSubagentRadios = document.getElementsByName('plannerSubagentPolicy');
            const plannerCustomNameInput = document.getElementById('plannerAddonCustomSubagentName');
            plannerSubagentRadios.forEach(radio => {
                radio.addEventListener('change', (e) => {
                    if (!roleConfigs.planner) roleConfigs.planner = { workflowFilePath: '', addons: {} };
                    if (!roleConfigs.planner.addons) roleConfigs.planner.addons = {};
                    roleConfigs.planner.addons.subagentPolicy = e.target.value;
                    if (plannerCustomNameInput) {
                        plannerCustomNameInput.style.display = e.target.value === 'customSubagent' ? 'inline-block' : 'none';
                        if (e.target.value !== 'customSubagent') {
                            roleConfigs.planner.addons.customSubagentName = '';
                            plannerCustomNameInput.value = '';
                        }
                    }
                    saveRoleConfig('planner');
                    refreshPreview();
                });
            });
            if (plannerCustomNameInput) {
                plannerCustomNameInput.addEventListener('input', (e) => {
                    const sanitized = e.target.value.replace(/[^a-zA-Z0-9_]/g, '');
                    e.target.value = sanitized;
                    if (!roleConfigs.planner) roleConfigs.planner = { workflowFilePath: '', addons: {} };
                    if (!roleConfigs.planner.addons) roleConfigs.planner.addons = {};
                    roleConfigs.planner.addons.customSubagentName = sanitized;
                    saveRoleConfig('planner');
                    refreshPreview();
                });
            }

            // Planner feature workflow file enable checkbox listener
            const plannerFeatureWorkflowEnabled = document.getElementById('plannerFeatureWorkflowEnabled');
            if (plannerFeatureWorkflowEnabled) {
                plannerFeatureWorkflowEnabled.addEventListener('change', (e) => {
                    const enabled = e.target.checked;
                    document.getElementById('plannerFeatureWorkflowFilePathGroup').style.display = enabled ? 'block' : 'none';
                    if (!roleConfigs.planner) roleConfigs.planner = { workflowFilePath: '', addons: {} };
                    if (!roleConfigs.planner.addons) roleConfigs.planner.addons = {};
                    roleConfigs.planner.addons.featureWorkflowFilePathEnabled = enabled;
                    saveRoleConfig('planner');
                    refreshPreview();
                });
            }

            // Planner feature workflow file path text input listener
            const plannerFeatureWorkflowFilePath = document.getElementById('plannerFeatureWorkflowFilePath');
            if (plannerFeatureWorkflowFilePath) {
                plannerFeatureWorkflowFilePath.addEventListener('change', (e) => {
                    if (!roleConfigs.planner) roleConfigs.planner = { workflowFilePath: '', addons: {} };
                    if (!roleConfigs.planner.addons) roleConfigs.planner.addons = {};
                    roleConfigs.planner.addons.featureWorkflowFilePath = e.target.value;
                    saveRoleConfig('planner');
                    refreshPreview();
                });
            }

            // Planner feature workflow file validate button listener
            const validateFeatureWorkflowPath = document.getElementById('validateFeatureWorkflowPath');
            if (validateFeatureWorkflowPath) {
                validateFeatureWorkflowPath.addEventListener('click', () => {
                    const pathEl = document.getElementById('plannerFeatureWorkflowFilePath');
                    if (pathEl) {
                        postKanbanMessage({ type: 'fileExists', path: pathEl.value });
                    }
                });
            }

            // Planner feature subagent policy radio listeners
            const plannerFeatureSubagentRadios = document.getElementsByName('plannerFeatureSubagentPolicy');
            const plannerFeatureCustomNameInput = document.getElementById('plannerFeatureCustomSubagentName');
            plannerFeatureSubagentRadios.forEach(radio => {
                radio.addEventListener('change', (e) => {
                    if (!roleConfigs.planner) roleConfigs.planner = { workflowFilePath: '', addons: {} };
                    if (!roleConfigs.planner.addons) roleConfigs.planner.addons = {};
                    roleConfigs.planner.addons.featureSubagentPolicy = e.target.value;
                    if (plannerFeatureCustomNameInput) {
                        plannerFeatureCustomNameInput.style.display = e.target.value === 'customSubagent' ? 'inline-block' : 'none';
                        if (e.target.value !== 'customSubagent') {
                            roleConfigs.planner.addons.featureCustomSubagentName = '';
                            plannerFeatureCustomNameInput.value = '';
                        }
                    }
                    saveRoleConfig('planner');
                    refreshPreview();
                });
            });
            if (plannerFeatureCustomNameInput) {
                plannerFeatureCustomNameInput.addEventListener('input', (e) => {
                    const sanitized = e.target.value.replace(/[^a-zA-Z0-9_]/g, '');
                    e.target.value = sanitized;
                    if (!roleConfigs.planner) roleConfigs.planner = { workflowFilePath: '', addons: {} };
                    if (!roleConfigs.planner.addons) roleConfigs.planner.addons = {};
                    roleConfigs.planner.addons.featureCustomSubagentName = sanitized;
                    saveRoleConfig('planner');
                    refreshPreview();
                });
            }
            const promptsExportBtn = document.getElementById('prompts-tab-btn-export-skill');
            if (promptsExportBtn) {
                promptsExportBtn.addEventListener('click', () => {
                    const roleSelect = document.getElementById('roleSelect');
                    if (roleSelect) {
                        const selectedValue = roleSelect.value;
                        const selectedOpt = roleSelect.options[roleSelect.selectedIndex];
                        const customGroup = document.getElementById('customAgentsGroup');
                        const isCustomAgent = !!(customGroup && selectedOpt && customGroup.contains(selectedOpt));
                        if (isCustomAgent) {
                            // Custom agent: dropdown value is agent.role, not UUID — look up the actual id
                            const found = lastCustomAgents.find(a => (a.role || ('custom_agent_' + a.id)) === selectedValue);
                            const agentId = found ? found.id : undefined;
                            if (!agentId) {
                                showStatusBarMessage('Could not resolve custom agent ID', { isError: true });
                                return;
                            }
                            vscode.postMessage({ type: 'exportAgentAsSkill', agentId, workspaceRoot: getActiveWorkspaceRoot() });
                        } else {
                            // Built-in role: send as role, not agentId
                            vscode.postMessage({ type: 'exportAgentAsSkill', role: selectedValue, workspaceRoot: getActiveWorkspaceRoot() });
                        }
                        const orig = promptsExportBtn.textContent;
                        promptsExportBtn.textContent = 'EXPORTED!';
                        setTimeout(() => { promptsExportBtn.textContent = orig; }, 2000);
                    }
                });
            }

        }
        initPromptsTabListeners();

        // ── BUILD TARGET (plan: surface-a-build-target-in-agent-control) ─────────
        // Where builds run. The choice is per-workspace (persisted in the kanban.db
        // config table, read by BOTH hosts). Availability is probed by the host at
        // render; an unusable target is shown as unavailable and never silently
        // swapped for `this box`. Durations come from the last recorded result per
        // target so the choice is informed rather than a guess.
        let buildTargetState = { target: 'this-box', unrecognizedTarget: null, availability: null, lastResults: null, config: null };

        function buildTargetFmtDuration(result) {
            if (!result || typeof result.durationMs !== 'number') { return 'never built'; }
            const seconds = Math.round(result.durationMs / 100) / 10;
            return (result.success ? 'passed' : 'failed') + ' in ' + seconds + 's';
        }

        function renderBuildTarget() {
            const select = document.getElementById('build-target-select');
            const statusEl = document.getElementById('build-target-status');
            const durationsEl = document.getElementById('build-target-durations');
            const availability = buildTargetState.availability || {};
            if (select) {
                // Mark each option's availability in its label — the select is the
                // point of choice, so unavailability is reported HERE.
                Array.from(select.options).forEach(opt => {
                    const info = availability[opt.value];
                    const base = opt.value === 'this-box' ? 'this box'
                        : opt.value === 'ssh' ? 'desktop over SSH' : 'GitHub Actions';
                    opt.textContent = base + (info && info.available === false ? ' — unavailable' : '');
                });
                // An unrecognised persisted target matches no option, so the select
                // shows nothing selected (rather than falsely reading as `this box`);
                // the status line below explains why.
                select.value = buildTargetState.unrecognizedTarget || buildTargetState.target || 'this-box';
            }
            if (statusEl) {
                const info = availability[buildTargetState.target];
                if (buildTargetState.unrecognizedTarget) {
                    // The persisted target is not one of the three. Report it — do
                    // NOT show `this box` as if the operator had chosen it.
                    statusEl.textContent = 'Configured target "' + buildTargetState.unrecognizedTarget
                        + '" is not recognised. Choose one of: this box, desktop over SSH, GitHub Actions.';
                    statusEl.style.color = 'var(--accent-red, #f48771)';
                } else if (info) {
                    // Side-effect visibility for Actions (consumes minutes, fires
                    // webhooks) — shown BEFORE the operator commits to a build.
                    const sideEffect = buildTargetState.target === 'github-actions'
                        ? ' Triggering a workflow consumes Actions minutes and fires webhooks.'
                        : '';
                    statusEl.textContent = (info.detail || '') + sideEffect;
                    statusEl.style.color = info.available === false
                        ? 'var(--accent-red, #f48771)'
                        : 'var(--text-secondary)';
                } else {
                    statusEl.textContent = '';
                }
            }
            if (durationsEl) {
                const last = buildTargetState.lastResults || {};
                const order = ['this-box', 'ssh', 'github-actions'];
                const labels = { 'this-box': 'this box', 'ssh': 'desktop over SSH', 'github-actions': 'GitHub Actions' };
                durationsEl.innerHTML = order.map(id =>
                    '<div>' + labels[id] + ': ' + buildTargetFmtDuration(last[id]) + '</div>'
                ).join('');
            }
            // Per-target connection config, shown only for the selected remote target.
            const cfg = buildTargetState.config || {};
            const sshBlock = document.getElementById('build-target-config-ssh');
            const actionsBlock = document.getElementById('build-target-config-actions');
            if (sshBlock) { sshBlock.style.display = buildTargetState.target === 'ssh' ? 'block' : 'none'; }
            if (actionsBlock) { actionsBlock.style.display = buildTargetState.target === 'github-actions' ? 'block' : 'none'; }
            const sshHostInput = document.getElementById('build-target-ssh-host');
            if (sshHostInput && document.activeElement !== sshHostInput) { sshHostInput.value = cfg.sshHost || ''; }
            const actionsRepoInput = document.getElementById('build-target-actions-repo');
            if (actionsRepoInput && document.activeElement !== actionsRepoInput) { actionsRepoInput.value = cfg.actionsRepo || ''; }
            const actionsConfiguredInput = document.getElementById('build-target-actions-configured');
            if (actionsConfiguredInput) { actionsConfiguredInput.checked = cfg.actionsConfigured === true; }
        }

        function saveBuildTargetConfig(patch) {
            postKanbanMessage({ type: 'saveBuildTargetConfig', ...patch });
        }

        const buildTargetSelect = document.getElementById('build-target-select');
        if (buildTargetSelect) {
            buildTargetSelect.addEventListener('change', () => {
                const target = buildTargetSelect.value;
                // Never silently accept an unavailable target: warn, but still
                // persist the explicit choice so the operator's intent is recorded.
                const info = (buildTargetState.availability || {})[target];
                if (info && info.available === false) {
                    showStatusBarMessage('Build target "' + target + '" is unavailable: ' + info.detail, { isError: true });
                }
                postKanbanMessage({ type: 'saveBuildTarget', target });
            });
        }
        // Config inputs — save on change/blur, then the host re-probes and pushes
        // a fresh `buildTarget` (availability + durations).
        const buildTargetSshHost = document.getElementById('build-target-ssh-host');
        if (buildTargetSshHost) {
            buildTargetSshHost.addEventListener('change', () => saveBuildTargetConfig({ sshHost: buildTargetSshHost.value }));
        }
        const buildTargetActionsRepo = document.getElementById('build-target-actions-repo');
        if (buildTargetActionsRepo) {
            buildTargetActionsRepo.addEventListener('change', () => saveBuildTargetConfig({ actionsRepo: buildTargetActionsRepo.value }));
        }
        const buildTargetActionsConfigured = document.getElementById('build-target-actions-configured');
        if (buildTargetActionsConfigured) {
            buildTargetActionsConfigured.addEventListener('change', () => saveBuildTargetConfig({ actionsConfigured: buildTargetActionsConfigured.checked }));
        }
        // Paint the empty state immediately; the first `buildTarget` message fills
        // availability + durations. The panel does not wait for the host to render
        // the control.
        renderBuildTarget();

        // ── Message handler (tab-relevant cases extracted from the board's handler) ──
        window.addEventListener('message', (event) => {
            const msg = event.data;
            switch (msg.type) {
                case 'switchboardThemeNameSetting':
                case 'switchboardThemeChanged': {
                    if (msg.theme) {
                        // Compute the desired theme class set without touching unrelated classes
                        // (e.g. kanban-icons-colour, cyber-animation-disabled) that may have been
                        // injected server-side by applyThemeBodyClass().
                        const allThemeClasses = ['theme-claudify', 'cyber-theme-enabled'];
                        const desired = new Set();
                        if (msg.theme === 'claudify') {
                            desired.add('theme-claudify');
                        } else {
                            // Afterburner default (and fallback for any legacy theme value).
                            desired.add('cyber-theme-enabled');
                        }
                        // Remove only theme classes that should NOT be present — leave the
                        // correct ones in place so there is no flash if they were already
                        // injected by applyThemeBodyClass at HTML generation time.
                        for (const cls of allThemeClasses) {
                            if (!desired.has(cls)) {
                                document.body.classList.remove(cls);
                            }
                        }
                        // Add any desired classes that are not yet present.
                        for (const cls of desired) {
                            document.body.classList.add(cls);
                        }
                    }
                    break;
                }
                case 'colourKanbanIconsChanged': {
                    document.body.classList.toggle('kanban-icons-colour', !!msg.enabled);
                    break;
                }
                case 'cyberAnimationSetting': {
                    document.body.classList.toggle('cyber-animation-disabled', !!msg.disabled);
                    break;
                }
                case 'cyberScanlinesSetting': {
                    document.body.classList.toggle('cyber-scanlines-disabled', !!msg.disabled);
                    break;
                }
                case 'ultracodeAnimationSetting': {
                    document.body.classList.toggle('ultracode-animation-enabled', msg.enabled === true);
                    break;
                }
                case 'showStatusMessage': {
                    showStatusBarMessage(msg.message || '', { isError: !!msg.isError });
                    break;
                }
                case 'reloadRoleConfigs': {
                    loadRoleConfigs();
                    break;
                }
                case 'switchToTab': {
                    const tabName = msg.tab;
                    if (!tabName) break;
                    const targetBtn = document.querySelector(`.shared-tab-btn[data-tab="${tabName}"]`);
                    if (targetBtn) {
                        targetBtn.click();
                    }
                    break;
                }
                case 'buildTarget': {
                    // Render-time probe result: the chosen target, each target's
                    // availability, the last recorded result per target, and the
                    // per-target connection config the inputs show. `target` is
                    // absent when the persisted value was unrecognised —
                    // `unrecognizedTarget` carries it so the panel reports it.
                    buildTargetState.target = typeof msg.target === 'string' ? msg.target : null;
                    buildTargetState.unrecognizedTarget = typeof msg.unrecognizedTarget === 'string' ? msg.unrecognizedTarget : null;
                    buildTargetState.availability = msg.availability || null;
                    buildTargetState.lastResults = msg.lastResults || null;
                    buildTargetState.config = msg.config || null;
                    renderBuildTarget();
                    break;
                }
                case 'buildTargetSaved': {
                    // Defensive: the host now pushes the full `buildTarget` state after
                    // a save, but an older host may still echo the bare save. Clear any
                    // stale unrecognised value so the warning does not outlive the fix.
                    if (typeof msg.target === 'string') {
                        buildTargetState.target = msg.target;
                        buildTargetState.unrecognizedTarget = null;
                        renderBuildTarget();
                    }
                    break;
                }
                case 'settingResult': {
                    const { key, value } = msg;
                    if (key === 'selectedRole') {
                        // Agent Control view: the view's own persisted role (namespaced
                        // under `agentControl`) is authoritative for the Agent Control
                        // view. loadRoleConfigs() posts the getSetting that arrives
                        // here, so this is the "after loadRoleConfigs resolves" restore
                        // point. The TEAMS tab hydration arm calls loadRoleConfigs()
                        // WITHOUT getCustomAgents, so #roleSelect's customAgentsGroup
                        // optgroup may still be empty at this moment — a valid persisted
                        // custom_agent_* role would then fail the option check below. In
                        // that case keep _agentControlPendingRole alive for a later
                        // settingResult (e.g. when the PROMPTS tab hydrates with
                        // getCustomAgents); only drop it once the option list is
                        // populated and genuinely lacks it (a deleted custom agent), or
                        // once it has been consumed.
                        let _acRole = value;
                        let _acPendingConsumed = false;
                        if (_agentControlPendingRole) {
                            const _acSel = document.getElementById('roleSelect');
                            const _acOpts = _acSel ? Array.from(_acSel.options) : [];
                            // #roleSelect ships TEN hard-coded static <option> elements
                            // at first paint plus an EMPTY <optgroup id="customAgentsGroup">
                            // that updateCustomAgentsDropdown() fills only after
                            // getCustomAgents returns. The TEAMS tab hydration arm calls
                            // loadRoleConfigs() WITHOUT getCustomAgents, so a persisted
                            // custom_agent_* role would fail the option check below and be
                            // destroyed for the session. Defer ONLY custom_agent_* roles
                            // until the custom-agent source has loaded; a non-custom role
                            // is resolvable against the static options immediately.
                            const _acIsCustom = _agentControlPendingRole.indexOf('custom_agent_') === 0;
                            const _acCustomLoaded = lastCustomAgents.length > 0;
                            const _acCanResolveNow = !_acIsCustom || _acCustomLoaded;
                            if (_acCanResolveNow) {
                                if (_acOpts.some(o => o.value === _agentControlPendingRole)) {
                                    // The view's own persisted role wins over the host-global
                                    // selectedRole (mirrored from EITHER view on every role
                                    // change, so not a reliable per-view source of truth).
                                    _acRole = _agentControlPendingRole;
                                    _acPendingConsumed = true;
                                } else {
                                    // Static options present (non-custom) or custom list
                                    // loaded but the role no longer exists (deleted custom
                                    // agent) — drop it for good.
                                    _acPendingConsumed = true;
                                }
                            }
                            // else: custom_agent_* role + custom list still empty — keep
                            // _agentControlPendingRole alive for a later settingResult
                            // (e.g. PROMPTS tab hydration, which posts getCustomAgents).
                        }
                        if (_acRole) {
                            currentRole = _acRole;
                            const roleSelect = document.getElementById('roleSelect');
                            if (roleSelect) roleSelect.value = _acRole;
                            if (currentRole.startsWith('custom_agent_') && !roleConfigs[currentRole]) {
                                postKanbanMessage({ type: 'getSetting', key: `roleConfig_${currentRole}` });
                            }
                        }
                        handleRoleChange();
                        updateRoleDescription();
                        // Only persist a role when one actually resolved — never
                        // persist a default as a user choice.
                        if (_acRole) { agentControlSet({ role: currentRole }); }
                        if (_acPendingConsumed) { _agentControlPendingRole = null; }
                    } else if (key.startsWith('roleConfig_')) {
                        const role = key.replace('roleConfig_', '');
                        roleConfigs[role] = value || JSON.parse(JSON.stringify(DEFAULT_CONFIG[role] || { prompt: '', addons: {} }));
                        if (role === currentRole) {
                            handleRoleChange();
                        }
                    }
                    break;
                }
                case 'promptPreviewResult': {
                    const { role, preview, planCount } = msg;
                    if (role !== currentRole) break;
                    const previewEl = document.getElementById('promptPreview');
                    if (previewEl) previewEl.value = preview || '(No prompt content)';
                    
                    const indicator = document.getElementById('previewPlanIndicator');
                    if (indicator) {
                        if (planCount > 0) {
                            indicator.textContent = `(with ${planCount} plan${planCount !== 1 ? 's' : ''})`;
                            indicator.style.color = 'var(--accent-teal)';
                        } else {
                            indicator.textContent = '(template only)';
                            indicator.style.color = 'var(--text-secondary)';
                        }
                    }
                    break;
                }
                case 'fileExistsResult': {
                    const workflowPath = document.getElementById('workflowFilePath')?.value;
                    const featureWorkflowPath = document.getElementById('plannerFeatureWorkflowFilePath')?.value;
                    let targetId = 'prompts-tab-workflow-path-status';
                    if (msg.path === featureWorkflowPath && msg.path !== workflowPath) {
                        targetId = 'prompts-tab-feature-workflow-path-status';
                    }
                    const statusEl = document.getElementById(targetId);
                    if (statusEl) {
                        statusEl.textContent = msg.exists ? '✓ File exists' : '✗ File not found';
                        statusEl.style.color = msg.exists ? 'var(--accent-teal)' : 'var(--accent-red)';
                    }
                    break;
                }
                case 'startupCommands': {
                  const cmds = msg.commands || {}, vis = msg.visibleAgents || {};
                  // Populate the machine selector (plan: agents-are-saved-per-machine-and-a-team-picks-one).
                  if (Array.isArray(msg.machines)) {
                    agentsTabMachines = msg.machines.filter(m => m && m.id);
                    agentsTabRenderMachineSelect();
                  }
                  // The backend sends the SELECTED machine's command map; record it.
                  if (typeof msg.machineId === 'string') {
                    agentsTabSelectedMachineId = msg.machineId;
                    const sel = document.getElementById('agents-tab-machine-select');
                    if (sel) { sel.value = agentsTabSelectedMachineId; }
                    agentsTabUpdateMachineTransportLabel();
                  }
                  document.querySelectorAll('#agents-tab-content input[type="text"][data-role]').forEach(i => {
                    if (i.dataset.role) i.value = cmds[i.dataset.role] || '';
                  });
                  agentsTabRefreshUnknownCliIndicators();
                  document.querySelectorAll('#agents-tab-content .agents-tab-visible-toggle').forEach(cb => {
                    if (cb.dataset.role) cb.checked = vis[cb.dataset.role] !== false;
                  });
                  const julesSyncCb = document.getElementById('agents-tab-jules-auto-sync');
                  if (julesSyncCb) julesSyncCb.checked = !!msg.julesAutoSyncEnabled;
                  const plannerCountSelect = document.getElementById('agents-tab-planner-terminal-count');
                  if (plannerCountSelect) plannerCountSelect.value = String(msg.plannerTerminalCount ?? 1);
                  const plannerLimitCb = document.getElementById('agents-tab-planner-limit-dispatch');
                  if (plannerLimitCb) plannerLimitCb.checked = !!msg.plannerLimitDispatchToTerminals;
                  break;
                }
                case 'machinesList': {
                  agentsTabMachines = (msg.machines || []).filter(m => m && m.id);
                  agentsTabRenderMachineSelect();
                  break;
                }
                case 'startupCommandsForMachine': {
                  // Per-machine command map response (plan:
                  // agents-are-saved-per-machine-and-a-team-picks-one).
                  if (typeof msg.machineId === 'string') {
                    agentsTabSelectedMachineId = msg.machineId;
                    const sel = document.getElementById('agents-tab-machine-select');
                    if (sel) { sel.value = agentsTabSelectedMachineId; }
                    agentsTabUpdateMachineTransportLabel();
                  }
                  const cmds = msg.commands || {};
                  document.querySelectorAll('#agents-tab-content input[type="text"][data-role]').forEach(i => {
                    if (i.dataset.role) i.value = cmds[i.dataset.role] || '';
                  });
                  agentsTabRefreshUnknownCliIndicators();
                  break;
                }
                case 'saveMachineResult': {
                  if (msg.machines) {
                    agentsTabMachines = msg.machines.filter(m => m && m.id);
                    agentsTabRenderMachineSelect();
                  }
                  if (typeof msg.selectedMachineId === 'string') {
                    agentsTabSelectedMachineId = msg.selectedMachineId;
                    const sel = document.getElementById('agents-tab-machine-select');
                    if (sel) { sel.value = agentsTabSelectedMachineId; }
                    agentsTabUpdateMachineTransportLabel();
                  }
                  break;
                }
                case 'deleteMachineResult': {
                  if (msg.error) {
                    const statusEl = document.getElementById('agents-tab-machine-probe-status');
                    if (statusEl) { statusEl.textContent = msg.error; statusEl.style.color = 'var(--accent-red)'; }
                  } else if (msg.machines) {
                    agentsTabMachines = msg.machines.filter(m => m && m.id);
                    if (typeof msg.selectedMachineId === 'string') {
                      agentsTabSelectedMachineId = msg.selectedMachineId;
                    }
                    agentsTabRenderMachineSelect();
                  }
                  break;
                }
                case 'probeMachineResult': {
                  const statusEl = document.getElementById('agents-tab-machine-probe-status');
                  if (statusEl) {
                    if (!msg.reachable) {
                      statusEl.textContent = msg.error || 'unreachable';
                      statusEl.style.color = 'var(--accent-red)';
                    } else if (msg.cliWarning) {
                      statusEl.textContent = `reachable — ${msg.cliWarning}`;
                      statusEl.style.color = 'var(--accent-amber, orange)';
                    } else {
                      statusEl.textContent = 'reachable';
                      statusEl.style.color = 'var(--accent-green, green)';
                    }
                  }
                  break;
                }
                case 'customAgents': {
                  agentsTabCustomAgents = msg.customAgents || [];
                  lastCustomAgents = agentsTabCustomAgents;
                  // Same for the Standing Orders tab's role selector.
                  standingOrdersTabPopulateRoleSelect();
                  agentsTabRenderCustomAgentList();
                  updateCustomAgentsDropdown();
                  break;
                }
                case 'julesAutoSyncSetting': {
                  const el = document.getElementById('agents-tab-jules-auto-sync');
                  if (el) el.checked = msg.enabled === true;
                  break;
                }
                case 'saveCustomAgentResult': {
                  if (msg.success) {
                    postKanbanMessage({ type: 'getCustomAgents' });
                  } else {
                    document.getElementById('agents-tab-custom-agent-error').textContent = msg.error || 'Failed to save custom agent';
                  }
                  break;
                }
                case 'deleteCustomAgentResult': {
                  if (msg.success) {
                    document.getElementById('agents-tab-custom-agent-delete-error').textContent = '';
                    postKanbanMessage({ type: 'getCustomAgents' });
                  } else {
                    document.getElementById('agents-tab-custom-agent-delete-error').textContent = msg.error || 'Failed to delete custom agent';
                  }
                  break;
                }
                case 'agentGroups': {
                  agentsTabAgentGroups = msg.groups || [];
                  // The host answered. Until this lands, an empty list means
                  // "never loaded", not "no teams" — see the flag's declaration.
                  agentsTabAgentGroupsLoaded = true;
                  // Derived host-side from DEFAULT_TEAM_DEFINITIONS and sent with
                  // the groups — never re-typed here. A hard-coded copy drifts the
                  // moment a default's roster changes, and the failure is silent:
                  // a team whose new role nobody was told to configure.
                  if (Array.isArray(msg.defaultTeamIds)) {
                    teamsTabDefaultIds = new Set(msg.defaultTeamIds);
                  }
                  if (Array.isArray(msg.recommendedRoles)) {
                    agentsTabRecommendedRoles = new Set(msg.recommendedRoles);
                    agentsTabRefreshRecommendedRoleMarks();
                  }
                  if (Array.isArray(msg.commandlessByTeam)) {
                    teamsTabCommandlessByTeam = msg.commandlessByTeam;
                  }
                  // Standing Orders tab's team selector reads agentsTabAgentGroups;
                  // repopulate now that it is filled (the tab's hydration arm fires
                  // before this response arrives).
                  standingOrdersTabPopulateTeamSelect();
                  standingOrdersTabRender();
                  teamsTabRenderAgentGroups();
                  teamsTabRenderGallery();
                  agentsTabRenderCustomAgentList();
                  break;
                }
                case 'iconPalette': {
                  // Cache the palette so the picker grid doesn't re-fetch on
                  // every open. teamsTabWaitForIconPalette resolves its promise
                  // from this cache; a direct grid open also reads it.
                  _iconPaletteCache = Array.isArray(msg.icons) ? msg.icons : [];
                  _iconPaletteRequested = true;
                  teamsTabRenderGallery();
                  break;
                }
                case 'standingOrders':
                case 'standingOrdersResult': {
                  standingOrdersTabState.available = !!msg.available;
                  standingOrdersTabState.orders = Array.isArray(msg.orders) ? msg.orders : [];
                  standingOrdersTabState.definitions = Array.isArray(msg.definitions) ? msg.definitions : [];
                  standingOrdersTabState.coreOrders = Array.isArray(msg.coreOrders) ? msg.coreOrders : [];
                  // `reason` is carried on every `available:false` so the gate can
                  // name the refusal (no root vs. a DB read throw). Only meaningful
                  // when available is false; cleared on a true answer.
                  standingOrdersTabState.reason = (msg.available === false && typeof msg.reason === 'string') ? msg.reason : null;
                  standingOrdersTabRender();
                  break;
                }
                case 'standingOrderAdded': {
                  if (msg.success) {
                    standingOrdersTabHideAddForm();
                    postKanbanMessage({ type: 'getStandingOrders' });
                  } else {
                    const err = document.getElementById('standing-orders-add-error');
                    if (err) { err.textContent = msg.error || 'Failed to add standing order'; }
                  }
                  break;
                }
                case 'standingOrderUpdated': {
                  if (msg.success) {
                    postKanbanMessage({ type: 'getStandingOrders' });
                  } else {
                    const err = document.getElementById('standing-orders-edit-error-' + (msg.id || ''));
                    if (err) { err.textContent = msg.error || 'Failed to update standing order'; }
                  }
                  break;
                }
                case 'standingOrderDeleted': {
                  postKanbanMessage({ type: 'getStandingOrders' });
                  break;
                }
                case 'standingOrderDefinitionAdded': {
                  if (msg.success) {
                    standingOrdersTabHideDefAddForm();
                    postKanbanMessage({ type: 'getStandingOrders' });
                  } else {
                    const err = document.getElementById('standing-orders-def-add-error');
                    if (err) { err.textContent = msg.error || 'Failed to add library entry'; }
                  }
                  break;
                }
                case 'standingOrderDefinitionUpdated': {
                  if (msg.success) {
                    const form = document.getElementById('standing-orders-def-edit-' + (msg.id || ''));
                    if (form) { form.style.display = 'none'; }
                    postKanbanMessage({ type: 'getStandingOrders' });
                  } else {
                    const form = document.getElementById('standing-orders-def-edit-' + (msg.id || ''));
                    const err = document.getElementById('standing-orders-def-edit-error-' + (msg.id || ''));
                    if (form) { form.style.display = 'block'; }
                    if (err) { err.textContent = msg.error || 'Failed to update library entry'; }
                  }
                  break;
                }
                case 'standingOrderDefinitionDeleted': {
                  if (msg.success) {
                    postKanbanMessage({ type: 'getStandingOrders' });
                  } else {
                    const form = document.getElementById('standing-orders-def-edit-' + (msg.id || ''));
                    const err = document.getElementById('standing-orders-def-edit-error-' + (msg.id || ''));
                    if (form) { form.style.display = 'block'; }
                    if (err) { err.textContent = msg.error || 'Failed to delete library entry'; }
                  }
                  break;
                }
                case 'saveAgentGroupResult': {
                  if (msg.success) {
                    postKanbanMessage({ type: 'getAgentGroups' });
                  } else {
                    document.getElementById('agent-groups-error').textContent = msg.error || 'Failed to save agent group';
                  }
                  // Creation rollback. The optimistic push happens in
                  // teamsTabCreateCustomTeam so the card redraws immediately; if
                  // the host failed to persist it, leaving it drawn shows a card
                  // for a team the host has never seen.
                  if (teamsTabPendingAdoptId) {
                    const id = teamsTabPendingAdoptId;
                    teamsTabPendingAdoptId = null;
                    if (!msg.success) {
                      const idx = agentsTabAgentGroups.findIndex(g => g.id === id);
                      if (idx >= 0) {
                        agentsTabAgentGroups.splice(idx, 1);
                        teamsTabPickedKey = null;
                      }
                      teamsTabRenderAgentGroups();
                      teamsTabRenderGallery();
                      // After the re-render — teamsTabRenderFlow rebuilds the
                      // error span, so writing before it would be erased.
                      const errEl = document.getElementById('teams-flow-error');
                      if (errEl) { errEl.textContent = msg.error || 'Failed to create team.'; }
                    }
                  }
                  break;
                }
                case 'deleteAgentGroupResult': {
                  if (!msg.success) {
                    document.getElementById('agent-groups-error').textContent = msg.error || 'Failed to delete agent group';
                    postKanbanMessage({ type: 'getAgentGroups' });
                  }
                  break;
                }
            }
        });
    })();
