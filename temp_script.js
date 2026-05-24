2476:    <script>
2477-        const vscode = acquireVsCodeApi();
2478-        const kanbanBoard = document.getElementById('kanban-board');
2479-
2480-        // ── PROMPTS TAB ─────────────────────────────────────────────────────────
2481-
2482-        const DEFAULT_CONFIG = { ...DEFAULT_ROLE_CONFIG };
2483-
2484-        let currentRole = 'planner';
2485-        let roleConfigs = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
2486-
2487-        const ROLE_DESCRIPTIONS = {
2488-            planner: 'Writes detailed step-by-step implementation plans and creates work checklists.',
2489-            lead: 'Implements high-complexity files, complex refactors, and core architecture changes.',
2490-            coder: 'Implements low-complexity boilerplate, routine functions, and minor enhancements.',
2491-            intern: 'Executes simple, repetitive code edits and heavily guided tasks at lowest cost.',
2492-            reviewer: 'Evaluates completed implementations against plans, checking for regressions and scope creep.',
2493-            tester: 'Validates implemented changes against the Design Doc/PRD, applies fixes for requirement gaps, and logs verification results.',
2494-            analyst: 'Researches general-purpose technical queries and outlines plan dependencies.',
2495-            ticket_updater: 'Synchronizes plan state and comments back to connected project management systems (e.g. ClickUp/Linear).',
2496-            researcher: 'Conducts semantic code searches and web research to discover necessary implementation context.',
2497-            research_planner: 'Scopes complex multi-part plans by gathering extensive context using deep research.',
2498-            splitter: 'Segregates planned files into distinct routine and complex task batches.',
2499-            gatherer: 'Aggregates codebase files, directory structure, and relevant symbols into the active prompt context.',
2500-            jules: 'Offloads tasks to Google Jules cloud-coding service for quota-free background execution.'
2501-        };
2502-
2503-        function updateRoleDescription() {
2504-            const descEl = document.getElementById('roleDescription');
2505-            if (descEl) {
2506-                descEl.textContent = ROLE_DESCRIPTIONS[currentRole] || '';
2507-            }
2508-        }
2509-
2510-        function loadRoleConfigs() {
2511-            const roles = ROLE_KEYS;
2512-            roles.forEach(role => {
2513-                postKanbanMessage({ type: 'getSetting', key: `roleConfig_${role}` });
2514-            });
2515-            postKanbanMessage({ type: 'getSetting', key: 'selectedRole' });
2516-        }
2517-
2518-        function updateCustomAgentsDropdown() {
2519-            const group = document.getElementById('customAgentsGroup');
2520-            if (!group) return;
2521-            group.innerHTML = '';
2522-            lastCustomAgents.forEach(agent => {
2523-                const opt = document.createElement('option');
2524-                opt.value = agent.id;
2525-                opt.textContent = agent.name;
2526-                group.appendChild(opt);
2527-            });
2528-        }
2529-
2530-        async function handleRoleChange() {
2531-            const plannerConfig = document.getElementById('plannerConfig');
2532-            const researchPlannerConfig = document.getElementById('research_plannerConfig');
2533-            const promptCustomization = document.getElementById('promptCustomization');
2534-            if (!plannerConfig || !researchPlannerConfig || !promptCustomization) return;
2535-
2536-            plannerConfig.style.display = currentRole === 'planner' ? 'block' : 'none';
2537-            researchPlannerConfig.style.display = currentRole === 'research_planner' ? 'block' : 'none';
2538-            promptCustomization.style.display = (currentRole === 'planner') ? 'none' : 'block';
2539-
2540-            if (currentRole === 'planner') {
2541-                const config = roleConfigs.planner;
2542-                document.getElementById('workflowFilePath').value = config.workflowFilePath || '.agent/workflows/improve-plan.md';
2543-                document.getElementById('plannerAddonSwitchboardSafeguards').checked = config.addons?.switchboardSafeguards !== false;
2544-                document.getElementById('plannerAddonDependencyCheck').checked = !!config.addons?.dependencyCheck;
2545-                document.getElementById('plannerAddonDesignDoc').checked = !!config.addons?.designDoc;
2546-                document.getElementById('plannerAddonAggressivePairProgramming').checked = !!config.addons?.aggressivePairProgramming;
2547-                document.getElementById('plannerAddonGitProhibition').checked = !!config.addons?.gitProhibition;
2548-                document.getElementById('plannerAddonSplitPlan').checked = !!config.addons?.splitPlan;
2549-                document.getElementById('plannerAddonClearAntigravityContext').checked = !!config.addons?.clearAntigravityContext;
2550-                document.getElementById('plannerAddonCavemanOutput').checked = !!config.addons?.cavemanOutput;
2551-                document.getElementById('plannerAddonSkipCompilation').checked = !!config.addons?.skipCompilation;
2552-                document.getElementById('plannerAddonSkipTests').checked = !!config.addons?.skipTests;
2553-                document.getElementById('plannerAddonUseSubagents').checked = config.addons?.useSubagents !== false;
2554-            } else if (currentRole === 'research_planner') {
2555-                const config = roleConfigs.research_planner;
2556-                document.getElementById('rp-enable-deep-planning').checked = !!config.enableDeepPlanning;
2557-                document.getElementById('rp-research-depth').value = config.researchDepth || 'deep';
2558-                renderRoleAddons(currentRole);
2559-            } else {
2560-                renderRoleAddons(currentRole);
2561-            }
2562-
2563-            const previewEl = document.getElementById('promptPreview');
2564-            if (previewEl) {
2565-                previewEl.readOnly = (currentRole === 'planner' || currentRole === 'research_planner');
2566-            }
2567-
2568-            refreshPreview();
2569-        }
2570-        function renderRoleAddons(role) {
2571-            const group = document.getElementById('roleAddonsGroup');
2572-            const desc = document.getElementById('roleAddonsDesc');
2573-            if (!group || !desc) return;
2574-            group.innerHTML = '';
2575-
2576-            const addons = ROLE_ADDONS[role] || [];
2577-            if (addons.length === 0) {
2578-                desc.textContent = 'No add-ons available for this role.';
2579-                return;
2580-            }
2581-
2582-            desc.textContent = `${role.charAt(0).toUpperCase() + role.slice(1)}-specific orchestration features:`;
2583-
2584-            addons.forEach(addon => {
2585-                const isChecked = roleConfigs[role]?.addons?.[addon.id] ?? addon.default;
2586-                const label = document.createElement('label');
2587-                label.className = 'checkbox-item';
2588-                label.title = addon.tooltip;
2589-                label.innerHTML = `
2590-                    <input type="checkbox" id="addon_${addon.id}" ${isChecked ? 'checked' : ''}>
2591-                    <span>${addon.label}</span>
2592-                    <span class="tooltip">${addon.tooltip}</span>
2593-                `;
2594-                label.querySelector('input').addEventListener('change', (e) => {
2595-                    if (!roleConfigs[role]) roleConfigs[role] = { prompt: '', addons: {} };
2596-                    if (!roleConfigs[role].addons) roleConfigs[role].addons = {};
2597-                    roleConfigs[role].addons[addon.id] = e.target.checked;
2598-                    saveRoleConfig(role);
2599-                    refreshPreview();
2600-                });
2601-                group.appendChild(label);
2602-            });
2603-        }
2604-
2605-        function saveRoleConfig(role) {
2606-            postKanbanMessage({
2607-                type: 'saveSetting',
2608-                key: `roleConfig_${role}`,
2609-                value: roleConfigs[role]
2610-            });
2611-        }
2612-
2613-        async function refreshPreview() {
2614-            const preview = document.getElementById('promptPreview');
2615-            if (!preview) return;
2616-            
2617-            const msg = { type: 'getPromptPreview', role: currentRole };
2618-            postKanbanMessage(msg);
2619-            preview.value = 'Loading preview...';
2620-        }
2621-
2622-        // ── AGENTS TAB ────────────────────────────────────────────────────────────
2623-
2624-        let agentsTabCustomAgents = [];
2625-        let agentsTabEditingAgentId = null;
2626-
2627-        function agentsTabSanitizeCustomAgentId(value) {
2628-          const normalized = String(value || '')
2629-            .toLowerCase()
2630-            .replace(/[^a-z0-9]+/g, '_')
2631-            .replace(/^_+|_+$/g, '')
2632-            .slice(0, 48);
2633-          return normalized || `agent_${Date.now().toString(36)}`;
2634-        }
2635-
2636-        function agentsTabToCustomAgentRole(id) {
2637-          return `custom_agent_${agentsTabSanitizeCustomAgentId(id)}`;
2638-        }
2639-
2640-        function agentsTabShowInlineForm(agent) {
2641-          agentsTabEditingAgentId = agent ? agent.id : null;
2642-          document.getElementById('agents-tab-inline-form-title').textContent = agent ? `Edit: ${agent.name}` : 'New Custom Agent';
2643-          document.getElementById('agents-tab-custom-agent-name').value = agent?.name || '';
2644-          document.getElementById('agents-tab-custom-agent-command').value = agent?.startupCommand || '';
2645-          document.getElementById('agents-tab-custom-agent-prompt').value = agent?.promptInstructions || '';
2646-          document.getElementById('agents-tab-custom-agent-dragdrop').value = agent?.dragDropMode || 'cli';
2647-          document.getElementById('agents-tab-custom-agent-kanban').checked = agent?.includeInKanban === true;
2648-
2649-          // Load addons
2650-          const addons = agent?.addons || {};
2651-          document.getElementById('ca-addon-switchboard-safeguards').checked = addons.switchboardSafeguards === true;
2652-          document.getElementById('ca-addon-git-prohibition').checked = addons.gitProhibitionEnabled === true;          document.getElementById('ca-addon-workspace-detection').checked = addons.workspaceTypeDetection === true;
2653-          document.getElementById('ca-addon-inline-challenge').checked = addons.includeInlineChallenge === true;
2654-          document.getElementById('ca-addon-accuracy').checked = addons.accurateCodingEnabled === true;
2655-          document.getElementById('ca-addon-suppress-walkthrough').checked = addons.suppressWalkthrough === true;
2656-          document.getElementById('ca-addon-pair-programming').checked = addons.pairProgrammingEnabled === true;
2657-          document.getElementById('ca-addon-aggressive-pair').checked = addons.aggressivePairProgramming === true;
2658-          document.getElementById('ca-addon-advanced-reviewer').checked = addons.advancedReviewerEnabled === true;
2659-          document.getElementById('ca-addon-caveman-output').checked = addons.cavemanOutput === true;
2660-          document.getElementById('ca-addon-dependency-check').checked = addons.dependencyCheckEnabled === true;
2661-          document.getElementById('ca-addon-split-plan').checked = addons.splitPlan === true;
2662-          document.getElementById('ca-addon-complexity-scoring').checked = addons.complexityScoringSkill === true;
2663-          document.getElementById('ca-addon-ticket-update').checked = addons.ticketUpdateEnabled === true;
2664-          document.getElementById('ca-addon-research').checked = addons.researchEnabled === true;
2665-          document.getElementById('ca-addon-design-doc-link').value = addons.designDocLink || '';
2666-          document.getElementById('ca-addon-workflow-path').value = addons.customWorkflowPath || '';
2667-
2668-          // Close details by default when opening form
2669-          document.getElementById('agents-tab-custom-agent-addons').removeAttribute('open');
2670-
2671-          document.getElementById('agents-tab-custom-agent-error').textContent = '';
2672-          document.getElementById('agents-tab-custom-agent-form').classList.remove('hidden');
2673-          setTimeout(() => document.getElementById('agents-tab-custom-agent-name').focus(), 0);
2674-        }
2675-
2676-        function agentsTabHideInlineForm() {
2677-          agentsTabEditingAgentId = null;
2678-          document.getElementById('agents-tab-custom-agent-form').classList.add('hidden');
2679-          document.getElementById('agents-tab-custom-agent-error').textContent = '';
2680-        }
2681-
2682-        function agentsTabSaveCustomAgent() {
2683-          const name = document.getElementById('agents-tab-custom-agent-name').value.trim();
2684-          const startupCommand = document.getElementById('agents-tab-custom-agent-command').value.trim();
2685-          if (!name || !startupCommand) {
2686-            document.getElementById('agents-tab-custom-agent-error').textContent = 'Name and startup command are required.';
2687-            return;
2688-          }
2689-
2690-          const newId = agentsTabSanitizeCustomAgentId(name);
2691-          const role = agentsTabToCustomAgentRole(newId);
2692-          const nextAgent = {
2693-            id: newId,
2694-            role,
2695-            name,
2696-            startupCommand,
2697-            promptInstructions: document.getElementById('agents-tab-custom-agent-prompt').value.trim(),
2698-            includeInKanban: !!document.getElementById('agents-tab-custom-agent-kanban').checked,
2699-            kanbanOrder: 0,
2700-            dragDropMode: document.getElementById('agents-tab-custom-agent-dragdrop').value,
2701-            addons: {
2702-                switchboardSafeguards: document.getElementById('ca-addon-switchboard-safeguards').checked,
2703-                gitProhibitionEnabled: document.getElementById('ca-addon-git-prohibition').checked,
2704-                workspaceTypeDetection: document.getElementById('ca-addon-workspace-detection').checked,
2705-                includeInlineChallenge: document.getElementById('ca-addon-inline-challenge').checked,
2706-                accurateCodingEnabled: document.getElementById('ca-addon-accuracy').checked,
2707-                suppressWalkthrough: document.getElementById('ca-addon-suppress-walkthrough').checked,
2708-                pairProgrammingEnabled: document.getElementById('ca-addon-pair-programming').checked,
2709-                aggressivePairProgramming: document.getElementById('ca-addon-aggressive-pair').checked,
2710-                advancedReviewerEnabled: document.getElementById('ca-addon-advanced-reviewer').checked,
2711-                cavemanOutput: document.getElementById('ca-addon-caveman-output').checked,
2712-                dependencyCheckEnabled: document.getElementById('ca-addon-dependency-check').checked,
2713-                splitPlan: document.getElementById('ca-addon-split-plan').checked,
2714-                complexityScoringSkill: document.getElementById('ca-addon-complexity-scoring').checked,
2715-                ticketUpdateEnabled: document.getElementById('ca-addon-ticket-update').checked,
2716-                researchEnabled: document.getElementById('ca-addon-research').checked,
2717-                designDocLink: document.getElementById('ca-addon-design-doc-link').value.trim() || undefined,
2718-                customWorkflowPath: document.getElementById('ca-addon-workflow-path').value.trim() || undefined,
2719-            }
2720-          };
2721-
2722-          const duplicate = agentsTabCustomAgents.find(agent =>
2723-            (agentsTabEditingAgentId ? agent.id !== agentsTabEditingAgentId : true) &&
2724-            (agent.name.toLowerCase() === nextAgent.name.toLowerCase() || agent.id === nextAgent.id)
2725-          );
2726-          if (duplicate) {
2727-            document.getElementById('agents-tab-custom-agent-error').textContent = 'Agent names must be unique.';
2728-            return;
2729-          }
2730-
2731-          const previousAgent = agentsTabCustomAgents.find(agent => agent.id === (agentsTabEditingAgentId || nextAgent.id));
2732-          if (previousAgent?.includeInKanban) {
2733-            nextAgent.kanbanOrder = previousAgent.kanbanOrder;
2734-          }
2735-
2736-          const workspaceRoot = getActiveWorkspaceRoot();
2737-
2738-          if (agentsTabEditingAgentId && agentsTabEditingAgentId !== nextAgent.id) {
2739-            // Identity changed -> delete old one to clean up state keys
2740-            vscode.postMessage({ type: 'deleteCustomAgent', agentId: agentsTabEditingAgentId, workspaceRoot });
2741-            agentsTabCustomAgents = agentsTabCustomAgents.filter(agent => agent.id !== agentsTabEditingAgentId);
2742-          } else {
2743-            agentsTabCustomAgents = agentsTabCustomAgents.filter(agent => agent.id !== nextAgent.id);
2744-          }
2745-
2746-          agentsTabCustomAgents.push(nextAgent);
2747-          agentsTabCustomAgents.sort((a, b) => (a.kanbanOrder - b.kanbanOrder) || a.name.localeCompare(b.name));
2748-
2749-          agentsTabRenderCustomAgentList();
2750-          agentsTabHideInlineForm();
2751-          vscode.postMessage({ type: 'saveCustomAgent', agent: nextAgent, workspaceRoot });
2752-        }
2753-
2754-        function agentsTabRenderCustomAgentList() {
2755-          const container = document.getElementById('agents-tab-custom-agent-list');
2756-          if (!container) return;
2757-          container.innerHTML = '';
2758-          document.getElementById('agents-tab-custom-agent-delete-error').textContent = '';
2759-
2760-          agentsTabCustomAgents.forEach(agent => {
2761-            const item = document.createElement('div');
2762-            item.className = 'agents-tab-custom-agent-item';
2763-            item.innerHTML = `
2764-              <span class="agents-tab-custom-agent-item-name">${agent.name}</span>
2765-              <span class="agents-tab-custom-agent-item-command">${agent.startupCommand}</span>
2766-              <div class="agents-tab-custom-agent-item-actions">
2767-                <button class="agents-tab-custom-agent-item-btn edit" data-id="${agent.id}">EDIT</button>
2768-                <button class="agents-tab-custom-agent-item-btn delete" data-id="${agent.id}">DELETE</button>
2769-              </div>
2770-            `;
2771-
2772-            item.querySelector('.edit').addEventListener('click', () => {
2773-              agentsTabShowInlineForm(agent);
2774-            });
2775-
2776-            item.querySelector('.delete').addEventListener('click', () => {
2777-                document.getElementById('agents-tab-custom-agent-delete-error').textContent = '';
2778-                if (agentsTabEditingAgentId === agent.id) {
2779-                  agentsTabHideInlineForm();
2780-                }
2781-                agentsTabCustomAgents = agentsTabCustomAgents.filter(a => a.id !== agent.id);
2782-                agentsTabRenderCustomAgentList();
2783-                vscode.postMessage({ type: 'deleteCustomAgent', agentId: agent.id, workspaceRoot: getActiveWorkspaceRoot() });
2784-            });
2785-
2786-            container.appendChild(item);
2787-          });
2788-        }
2789-
2790-        // Custom Agents event listeners
2791-        document.getElementById('agents-tab-btn-add-custom-agent')?.addEventListener('click', () => {
2792-          agentsTabShowInlineForm(null);
2793-        });
2794-
2795-        document.getElementById('agents-tab-btn-save-custom-agent')?.addEventListener('click', agentsTabSaveCustomAgent);
2796-
2797-        document.getElementById('agents-tab-btn-cancel-custom-agent')?.addEventListener('click', agentsTabHideInlineForm);
2798-
2799-        function agentsTabCollectConfig() {
2800-          const commands = {}, visibleAgents = {};
2801-          document.querySelectorAll('#agents-tab-content input[type="text"][data-role]').forEach(i => {
2802-            if (i.dataset.role) commands[i.dataset.role] = i.value.trim();
2803-          });
2804-          document.querySelectorAll('#agents-tab-content .agents-tab-visible-toggle').forEach(cb => {
2805-            if (cb.dataset.role) visibleAgents[cb.dataset.role] = cb.checked;
2806-          });
2807-          return {
2808-            commands, visibleAgents,
2809-            julesAutoSyncEnabled: document.getElementById('agents-tab-jules-auto-sync')?.checked ?? false,
2810-          };
2811-        }
2812-        function agentsTabSaveConfig() {
2813-          vscode.postMessage({ type: 'saveStartupCommands', ...agentsTabCollectConfig() });
2814-        }
2815-
2816-        // Autosave on checkbox change or text blur
2817-        document.querySelectorAll('#agents-tab-content input[type="checkbox"]').forEach(cb => {
2818-          cb.addEventListener('change', agentsTabSaveConfig);
2819-        });
2820-        document.querySelectorAll('#agents-tab-content input[type="text"][data-role]').forEach(i => {
2821-          i.addEventListener('blur', agentsTabSaveConfig);
2822-        });
2823-        // NOTE: Prompts tab autosave is handled by initPromptsTabListeners() and saveRoleConfig(),
2824-        // which correctly read from actual element IDs (plannerAddon*, roleAddonsGroup, etc.).
2825-        // The old promptsTabCollectConfig() was removed — it referenced non-existent element IDs
2826-        // and caused data loss by sending all-false values on every checkbox change.
2827-
2828-        /* ── Tooltip overlay system ─────────────────────────────────── */
2829-        const tooltipOverlay = document.getElementById('tooltip-overlay');
2830-        let tooltipTarget = null;
2831-
2832-        function showTooltip(el) {
2833-            if (!tooltipOverlay) return;
2834-            const text = el.getAttribute('data-tooltip');
2835-            if (!text) return;
2836-
2837-            tooltipTarget = el;
2838-            tooltipOverlay.textContent = text;
2839-
2840-            // Make visible off-screen first to measure dimensions
2841-            tooltipOverlay.style.left = '-9999px';
2842-            tooltipOverlay.style.top = '-9999px';
2843-            tooltipOverlay.classList.add('visible');
2844-
2845-            const rect = el.getBoundingClientRect();
2846-            const tipRect = tooltipOverlay.getBoundingClientRect();
2847-            const viewportW = document.documentElement.clientWidth;
2848-            const GAP = 4;
2849-
2850-            // Vertical: prefer above, flip below if clipped at top
2851-            let top = rect.top - tipRect.height - GAP;
2852-            if (top < 0) {
2853-                top = rect.bottom + GAP;
2854-            }
2855-
2856-            // Horizontal: center on element, clamp to viewport
2857-            let left = rect.left + rect.width / 2 - tipRect.width / 2;
2858-            if (left < 4) left = 4;
2859-            if (left + tipRect.width > viewportW - 4) {
2860-                left = viewportW - tipRect.width - 4;
2861-            }
2862-
2863-            tooltipOverlay.style.left = left + 'px';
2864-            tooltipOverlay.style.top = top + 'px';
2865-        }
2866-
2867-        function hideTooltip() {
2868-            if (!tooltipOverlay) return;
2869-            tooltipOverlay.classList.remove('visible');
2870-            tooltipOverlay.style.left = '-9999px';
2871-            tooltipOverlay.style.top = '-9999px';
2872-            tooltipTarget = null;
2873-        }
2874-
2875-        // Delegation via mouseover/mouseout (these bubble, unlike mouseenter/mouseleave)
2876-        document.addEventListener('mouseover', (e) => {
2877-            const el = e.target.closest('[data-tooltip]');
2878-            if (!el) return;
2879-            if (el === tooltipTarget) return;
2880-            hideTooltip();
2881-            showTooltip(el);
2882-        });
2883-
2884-        document.addEventListener('mouseout', (e) => {
2885-            const el = e.target.closest('[data-tooltip]');
2886-            if (!el) return;
2887-            const related = e.relatedTarget;
2888-            if (related && el.contains(related)) return;
2889-            hideTooltip();
2890-        });
2891-        let columnDefinitions = [
2892-            { id: 'CREATED', label: 'New', role: null, autobanEnabled: true },
2893-            { id: 'PLAN REVIEWED', label: 'Planned', role: 'planner', autobanEnabled: true },
2894-            {
2895-                id: 'CONTEXT GATHERER',
2896-                label: 'Gather',
2897-                role: 'gatherer',
2898-                kind: 'gather',
2899-                autobanEnabled: false,
2900-                hideWhenNoAgent: true
2901-            },
2902-            { id: 'LEAD CODED', label: 'Lead Coder', role: 'lead', autobanEnabled: true },
2903-            { id: 'CODER CODED', label: 'Coder', role: 'coder', autobanEnabled: true },
2904-            { id: 'CODE REVIEWED', label: 'Reviewed', role: 'reviewer', autobanEnabled: false },
2905-            { id: 'ACCEPTANCE TESTED', label: 'Acceptance Tested', role: 'tester', autobanEnabled: false },
2906-            { id: 'COMPLETED', label: 'Completed', kind: 'completed', autobanEnabled: false }
2907-        ];
2908-        let lastVisibleAgents = { ...DEFAULT_VISIBLE_AGENTS };
2909-        let columns = columnDefinitions
2910-            .filter(col => !col.role || lastVisibleAgents[col.role] !== false)
2911-            .map(col => col.id);
2912-        let currentCards = [];
2913-        let lastAgentNames = {};
2914-        let cliTriggersEnabled = true;
2915-        let dynamicComplexityRoutingEnabled = true;
2916-        let allowUnknownComplexityAutoMove = false;
2917-        let clearTerminalBeforePrompt = false;
2918-        let clearTerminalBeforePromptDelay = 1500;
2919-
2920-        let collapseCodersEnabled = true;
2921-        // Restore collapse toggle from webview state if available
2922-        try {
2923-            const savedState = vscode.getState();
2924-            if (savedState && typeof savedState.collapseCodersEnabled === 'boolean') {
2925-                collapseCodersEnabled = savedState.collapseCodersEnabled;
2926-            }
2927-        } catch (_) {}
2928-        let autobanConfig = null; // Received from backend: { enabled, batchSize, rules }
2929-        let autobanCountdownTimer = null;
2930-        let autobanColumns = columnDefinitions.filter(col => col.autobanEnabled).map(col => col.id);
2931-        let lastBoardSignature = '';
2932-        let currentWorkspaceRoot = '';
2933-        try {
2934-            const attr = document.body?.dataset?.initialWorkspaceRoot;
2935-            if (attr) currentWorkspaceRoot = decodeURIComponent(attr);
2936-        } catch (_) {}
2937-        let activeWorkspaceFilter = null;
2938-        let workspaceItems = [];
2939-        let currentControlPlaneMode = 'none';
2940-        let currentControlPlaneRoot = '';
2941-        let columnDragDropModes = {};
2942-        const integrationState = {
2943-            clickup: { setupComplete: false, realTimeSyncEnabled: false, autoPullEnabled: false, pullIntervalMinutes: 60, syncError: false, mappingWarning: '', unmappedColumnCount: 0 },
2944-            linear: { setupComplete: false, realTimeSyncEnabled: false, autoPullEnabled: false, pullIntervalMinutes: 60, syncError: false }
2945-        };
2946-        let activeIntegration = null;
2947-        const selectedCards = new Set();
2948-        let testingFailSessionIds = [];
2949-
2950-        // Project strip elements and helpers
2951-        const projectSelect = document.getElementById('project-select');
2952-        const btnAddProject = document.getElementById('btn-add-project');
2953-        const btnAssignProject = document.getElementById('btn-assign-project');
2954-        const btnDeleteProject = document.getElementById('btn-delete-project');
2955-
2956-        function updateProjectDropdown(projects, activeProjectFilter) {
2957-            if (!projectSelect) return;
2958-            const currentValue = activeProjectFilter || projectSelect.value;
2959-            projectSelect.innerHTML = '<option value="">All Projects</option>';
2960-            (projects || []).forEach(p => {
2961-                const opt = document.createElement('option');
2962-                opt.value = p;
2963-                opt.textContent = p;
2964-                projectSelect.appendChild(opt);
2965-            });
2966-            // Restore selection
2967-            if (currentValue && [...projectSelect.options].some(o => o.value === currentValue)) {
2968-                projectSelect.value = currentValue;
2969-            } else {
2970-                projectSelect.value = '';
2971-            }
2972-            // Show delete button only when a real project is selected
2973-            if (btnDeleteProject) {
2974-                btnDeleteProject.style.display = projectSelect.value ? '' : 'none';
2975-            }
2976-        }
2977-
2978-        projectSelect?.addEventListener('change', () => {
2979-            const selectedProject = projectSelect.value || null;
2980-            postKanbanMessage({ type: 'setProjectFilter', project: selectedProject });
2981-            if (btnDeleteProject) {
2982-                btnDeleteProject.style.display = selectedProject ? '' : 'none';
2983-            }
2984-        });
2985-
2986-        btnAddProject?.addEventListener('click', () => {
2987-            postKanbanMessage({ type: 'addProject' });
2988-        });
2989-
2990-        btnAssignProject?.addEventListener('click', () => {
2991-            const selectedProject = projectSelect?.value;
2992-            if (!selectedProject || selectedCards.size === 0) return;
2993-            postKanbanMessage({
2994-                type: 'assignSelectedToProject',
2995-                projectName: selectedProject,
2996-                planIds: Array.from(selectedCards)
2997-            });
2998-        });
2999-
3000-        btnDeleteProject?.addEventListener('click', () => {
3001-            const selectedProject = projectSelect?.value;
3002-            if (!selectedProject) return;
3003-            postKanbanMessage({ type: 'deleteProject', projectName: selectedProject });
3004-        });
3005-        let testingFailSourceColumn = '';
3006-        // Routing map state
3007-        let routingMapConfig = { lead: [7, 8, 9, 10], coder: [4, 5, 6], intern: [1, 2, 3] };
3008-        let routingMapDraggedCard = null;
3009-        // Column abbreviations for inline timers
3010-        const COLUMN_ABBREV = { 'CREATED': 'C', 'PLAN REVIEWED': 'P', 'INTERN CODED': 'I', 'LEAD CODED': 'L', 'CODER CODED': 'R', 'CODED_AUTO': 'A', 'COMPLETED': 'D' };
3011-
3012-        // Icon URIs injected by extension
3013-        const ICON_MOVE_SELECTED = '{{ICON_53}}';
3014-        const ICON_MOVE_ALL = '{{ICON_54}}';
3015-        const ICON_PROMPT_SELECTED = '{{ICON_22}}';
3016-        const ICON_PROMPT_ALL = '{{ICON_115}}';
3017-        const ICON_JULES = '{{ICON_28}}';
3018-        const ICON_ANALYST_MAP = '{{ICON_ANALYST_MAP}}';
3019-        const ICON_IMPORT_CLIPBOARD = '{{ICON_IMPORT_CLIPBOARD}}';
3020-        const ICON_CLI = '{{ICON_CLI}}';
3021-        const ICON_PROMPT = '{{ICON_PROMPT}}';
3022-        const ICON_DYNAMIC_ROUTING = '{{ICON_59}}';
3023-        const ICON_RECOVER_SELECTED = '{{ICON_55}}';
3024-        const ICON_TESTING_FAIL = '{{ICON_85}}';
3025-        const ICON_CHAT = '{{ICON_CHAT}}';
3026-        const ICON_CODE_MAP = '{{ICON_CODE_MAP}}';
3027-        const ICON_ARCHIVE_SELECTED = '{{ICON_41}}';
3028-
3029-        // Tab switching logic
3030-        const kanbanTabButtons = document.querySelectorAll('.kanban-tab-btn');
3031-        const kanbanTabContents = document.querySelectorAll('.kanban-tab-content');
3032-        let kanbanViewStateBeforeHide = null;
3033-
3034-        kanbanTabButtons.forEach(btn => {
3035-            btn.addEventListener('click', () => {
3036-                const tabName = btn.dataset.tab;
3037-                const currentTab = document.querySelector('.kanban-tab-content.active');
3038-                const currentTabId = currentTab ? currentTab.id.replace('-tab-content', '') : null;
3039-
3040-                // Capture state before leaving Kanban tab
3041-                if (currentTabId === 'kanban' && tabName !== 'kanban') {
3042-                    kanbanViewStateBeforeHide = captureBoardViewState();
3043-                }
3044-
3045-                // Switch tabs
3046-                kanbanTabButtons.forEach(b => b.classList.remove('active'));
3047-                kanbanTabContents.forEach(c => c.classList.remove('active'));
3048-
3049-                btn.classList.add('active');
3050-                const targetContent = document.getElementById(`${tabName}-tab-content`);
3051-                if (targetContent) {
3052-                    targetContent.classList.add('active');
3053-                }
3054-
3055-                // Restore state when entering Kanban tab
3056-                if (tabName === 'kanban' && kanbanViewStateBeforeHide) {
3057-                    restoreBoardViewState(kanbanViewStateBeforeHide);
3058-                }
3059-
3060-                // Hydrate AGENTS tab when activated
3061-                if (tabName === 'agents') {
3062-                  postKanbanMessage({ type: 'getStartupCommands' });
3063-                  postKanbanMessage({ type: 'getCustomAgents' });
3064-                }
3065-
3066-                // Hydrate DEPENDENCIES tab when activated
3067-                if (tabName === 'dependencies') {
3068-                  postKanbanMessage({ type: 'getDependencyMapData' });
3069-                }
3070-
3071-                // Hydrate UAT tab when activated
3072-                if (tabName === 'uat') {
3073-                    postKanbanMessage({ type: 'getUATData' });
3074-                }
3075-
3076-                // Hydrate PROMPTS tab when activated
3077-                if (tabName === 'prompts') {
3078-                  postKanbanMessage({ type: 'getCustomAgents' });
3079-                  loadRoleConfigs();
3080-                  updateRoleDescription();
3081-                }
3082-            });
3083-        });
3084-
3085-        function getActiveWorkspaceRoot() {
3086-            return currentWorkspaceRoot || (workspaceItems[0] && workspaceItems[0].workspaceRoot) || '';
3087-        }
3088-
3089-        function postKanbanMessage(message) {
3090-            vscode.postMessage({
3091-                ...message,
3092-                workspaceRoot: message.workspaceRoot || getActiveWorkspaceRoot()
3093-            });
3094-        }
3095-
3096-        // ── PROMPTS TAB EVENT LISTENERS ──────────────────────────────────────────
3097-        function initPromptsTabListeners() {
3098-            const roleSelect = document.getElementById('roleSelect');
3099-            if (roleSelect) {
3100-                roleSelect.addEventListener('change', (e) => {
3101-                    currentRole = e.target.value;
3102-                    handleRoleChange();
3103-                    updateRoleDescription();
3104-                    postKanbanMessage({ type: 'saveSetting', key: 'selectedRole', value: currentRole });
3105-                });
3106-            }
3107-
3108-            const workflowFilePath = document.getElementById('workflowFilePath');
3109-            if (workflowFilePath) {
3110-                workflowFilePath.addEventListener('change', (e) => {
3111-                    if (!roleConfigs.planner) roleConfigs.planner = { workflowFilePath: '', addons: {} };
3112-                    roleConfigs.planner.workflowFilePath = e.target.value;
3113-                    saveRoleConfig('planner');
3114-                    refreshPreview();
3115-                });
3116-            }
3117-
3118-            const validateWorkflowPath = document.getElementById('validateWorkflowPath');
3119-            if (validateWorkflowPath) {
3120-                validateWorkflowPath.addEventListener('click', () => {
3121-                    const pathEl = document.getElementById('workflowFilePath');
3122-                    if (pathEl) {
3123-                        postKanbanMessage({ type: 'fileExists', path: pathEl.value });
3124-                    }
3125-                });
3126-            }
3127-            const promptPreview = document.getElementById('promptPreview');
3128-            if (promptPreview) {
3129-                promptPreview.addEventListener('change', (e) => {
3130-                    if (currentRole === 'planner' || currentRole === 'research_planner') return; // read-only for planners
3131-                    if (!roleConfigs[currentRole]) roleConfigs[currentRole] = { prompt: '', addons: {} };
3132-                    roleConfigs[currentRole].prompt = e.target.value;
3133-                    saveRoleConfig(currentRole);
3134-                });
3135-            }
3136-            // Research Planner specific listeners
3137-            const rpEnableDeepPlanning = document.getElementById('rp-enable-deep-planning');
3138-            if (rpEnableDeepPlanning) {
3139-                rpEnableDeepPlanning.addEventListener('change', (e) => {
3140-                    if (!roleConfigs.research_planner) roleConfigs.research_planner = { enableDeepPlanning: false, researchDepth: 'deep', addons: {} };
3141-                    roleConfigs.research_planner.enableDeepPlanning = e.target.checked;
3142-                    saveRoleConfig('research_planner');
3143-                    refreshPreview();
3144-                });
3145-            }
3146-
3147-            const rpResearchDepth = document.getElementById('rp-research-depth');
3148-            if (rpResearchDepth) {
3149-                rpResearchDepth.addEventListener('change', (e) => {
3150-                    if (!roleConfigs.research_planner) roleConfigs.research_planner = { enableDeepPlanning: false, researchDepth: 'deep', addons: {} };
3151-                    roleConfigs.research_planner.researchDepth = e.target.value;
3152-                    saveRoleConfig('research_planner');
3153-                    refreshPreview();
3154-                });
3155-            }
3156-
3157-            // Planner specific add-on listeners
3158-            ['plannerAddonSwitchboardSafeguards', 'plannerAddonDependencyCheck', 'plannerAddonDesignDoc', 'plannerAddonAggressivePairProgramming', 'plannerAddonGitProhibition', 'plannerAddonSplitPlan', 'plannerAddonClearAntigravityContext', 'plannerAddonCavemanOutput', 'plannerAddonSkipCompilation', 'plannerAddonSkipTests', 'plannerAddonUseSubagents'].forEach(id => {
3159-                const el = document.getElementById(id);
3160-                if (el) {
3161-                    el.addEventListener('change', (e) => {
3162-                        const addonId = id.replace('plannerAddon', '');
3163-                        const finalAddonId = addonId.charAt(0).toLowerCase() + addonId.slice(1);
3164-                        if (!roleConfigs.planner) roleConfigs.planner = { workflowFilePath: '', addons: {} };
3165-                        if (!roleConfigs.planner.addons) roleConfigs.planner.addons = {};
3166-                        roleConfigs.planner.addons[finalAddonId] = e.target.checked;
3167-                        saveRoleConfig('planner');
3168-                        refreshPreview();
3169-                    });
3170-                }
3171-            });
3172-
3173-        }
3174-        initPromptsTabListeners();
3175-
3176-        function getWorkspaceItemRepoScope(item) {
3177-            const raw = String(item && item.workspaceRoot || '');
3178-            const parts = raw.split(/[\\/]/).filter(Boolean);
3179-            return parts.length > 0 ? parts[parts.length - 1] : '';
3180-        }
3181-
3182-        function buildWorkspaceOptionLabel(item) {
3183-            const baseLabel = String(item?.optionLabel || item?.label || item?.workspaceRoot || '');
3184-            const role = String(item?.role || item?.workspaceRole || '').toLowerCase();
3185-            const mode = String(item?.controlPlaneMode || item?.mode || '').toLowerCase();
3186-            if (role === 'control-plane' || item?.isControlPlane === true) {
3187-                return `${baseLabel} — Control Plane`;
3188-            }
3189-            if (mode === 'manual' || mode === 'explicit' || mode === 'auto') {
3190-                return `${baseLabel} — ${mode}`;
3191-            }
3192-            return baseLabel;
3193-        }
3194-
3195-        function updateWorkspaceSelector(explicitRoot = null) {
3196-            const select = document.getElementById('workspace-select');
3197-            if (!select) return;
3198-
3199-            // Save the current selection BEFORE rebuilding options
3200-            const savedSelection = select.value;
3201-
3202-            const options = workspaceItems.map(item => `
3203-                <option
3204-                    value="${escapeAttr(item.workspaceRoot)}"
3205-                    data-control-plane-action="${escapeAttr(item.controlPlaneAction || item.selectionMode || '')}"
3206-                >${escapeHtml(buildWorkspaceOptionLabel(item))}</option>
3207-            `).join('');
3208-            select.innerHTML = options;
3209-
3210-            // If the backend explicitly changed workspace, honor that over savedSelection
3211-            if (explicitRoot && workspaceItems.some(item => item.workspaceRoot === explicitRoot)) {
3212-                select.value = explicitRoot;
3213-                return;
3214-            }
3215-
3216-            // Restore the saved selection if it still exists in the new options
3217-            if (savedSelection && workspaceItems.some(item => item.workspaceRoot === savedSelection)) {
3218-                select.value = savedSelection;
3219-            } else {
3220-                // Only fall back to currentWorkspaceRoot or first option if saved selection is invalid
3221-                let selectedValue = activeWorkspaceFilter
3222-                    ? ((workspaceItems.find(item => getWorkspaceItemRepoScope(item) === activeWorkspaceFilter) || {}).workspaceRoot || currentWorkspaceRoot)
3223-                    : currentWorkspaceRoot;
3224-                if (selectedValue && !workspaceItems.some(item => item.workspaceRoot === selectedValue)) {
3225-                    selectedValue = workspaceItems[0]?.workspaceRoot || '';
3226-                }
3227-                if (selectedValue) {
3228-                    select.value = selectedValue;
3229-                }
3230-            }
3231-        }
3232-
3233-        function updateWorkspaceFilterBadge() {
3234-            const badge = document.getElementById('workspace-filter-badge');
3235-            const controlPlaneBadge = document.getElementById('workspace-control-plane-badge');
3236-            const resetButton = document.getElementById('workspace-reset-control-plane');
3237-            if (!badge) return;
3238-            if (activeWorkspaceFilter) {
3239-                badge.hidden = false;
3240-                badge.textContent = `FILTER: ${activeWorkspaceFilter}`;
3241-            } else {
3242-                badge.hidden = true;
3243-                badge.textContent = '';
3244-            }
3245-            if (controlPlaneBadge) {
3246-                if (currentControlPlaneMode && currentControlPlaneMode !== 'none') {
3247-                    controlPlaneBadge.hidden = false;
3248-                    controlPlaneBadge.textContent = `CONTROL PLANE: ${String(currentControlPlaneMode).toUpperCase()}`;
3249-                    controlPlaneBadge.title = currentControlPlaneRoot || '';
3250-                } else {
3251-                    controlPlaneBadge.hidden = true;
3252-                    controlPlaneBadge.textContent = '';
3253-                    controlPlaneBadge.title = '';
3254-                }
3255-            }
3256-            if (resetButton) {
3257-                resetButton.hidden = !(currentControlPlaneMode === 'explicit' || currentControlPlaneMode === 'manual');
3258-            }
3259-        }
3260-
3261-        function updateCliToggleUi() {
3262-            const toggle = document.getElementById('cli-triggers-toggle');
3263-            const toggleLabel = document.getElementById('cli-toggle');
3264-            if (toggle) {
3265-                toggle.checked = !!cliTriggersEnabled;
3266-            }
3267-            if (toggleLabel) {
3268-                toggleLabel.classList.toggle('is-off', !cliTriggersEnabled);
3269-            }
3270-        }
3271-
3272-        function updateComplexityRoutingToggleUi() {
3273-            const toggle = document.getElementById('complexity-routing-toggle');
3274-            if (toggle) {
3275-                toggle.classList.toggle('is-active', !!dynamicComplexityRoutingEnabled);
3276-            }
3277-        }
3278-
3279-        function updateUnknownComplexityToggleUi() {
3280-            const toggle = document.getElementById('unknown-complexity-toggle');
3281-            const toggleLabel = document.getElementById('unknown-complexity-label-setup');
3282-            if (toggle) {
3283-                toggle.checked = !!allowUnknownComplexityAutoMove;
3284-            }
3285-            if (toggleLabel) {
3286-                toggleLabel.classList.toggle('is-off', !allowUnknownComplexityAutoMove);
3287-            }
3288-        }
3289-
3290-        function updateClearTerminalBeforePromptUi() {
3291-            const toggle = document.getElementById('clear-terminal-before-prompt-toggle');
3292-            const toggleLabel = document.getElementById('clear-terminal-before-prompt-label');
3293-            const delayContainer = document.getElementById('clear-delay-container');
3294-            const delayInput = document.getElementById('clear-terminal-delay-input');
3295-            if (toggle) {
3296-                toggle.checked = !!clearTerminalBeforePrompt;
3297-            }
3298-            if (toggleLabel) {
3299-                toggleLabel.classList.toggle('is-off', !clearTerminalBeforePrompt);
3300-            }
3301-            if (delayContainer) {
3302-                delayContainer.style.display = clearTerminalBeforePrompt ? 'flex' : 'none';
3303-            }
3304-            if (delayInput) {
3305-                delayInput.value = String(clearTerminalBeforePromptDelay);
3306-            }
3307-        }
3308-
3309-
3310-        /** Get the next column in the pipeline (returns null for last column). */
3311-        function getNextColumn(col) {
3312-            const idx = columns.indexOf(col);
3313-            if (idx < 0 || idx >= columns.length - 1) return null;
3314-            return columns[idx + 1];
3315-        }
3316-
3317-        /** Flash an icon button for visual feedback. */
3318-        function flashIconBtn(btn) {
3319-            btn.classList.remove('flash');
3320-            void btn.offsetWidth;
3321-            btn.classList.add('flash');
3322-            btn.addEventListener('animationend', () => btn.classList.remove('flash'), { once: true });
3323-        }
3324-
3325-        /**
3326-         * Move cards optimistically in the DOM before backend processing.
3327-         * @param {string[]} sessionIds - Session IDs to move
3328-         * @param {string} sourceColumn - Logical source column (may be 'CODED_AUTO')
3329-         * @param {string} targetColumn - Logical target column
3330-         */
3331-        function moveCardsOptimistically(sessionIds, sourceColumn, targetColumn) {
3332-            const targetBody = document.getElementById('col-' + targetColumn);
3333-            if (!targetBody) return;
3334-
3335-            // Remove empty state from target if present
3336-            const emptyState = targetBody.querySelector('.empty-state');
3337-            if (emptyState) emptyState.remove();
3338-
3339-            // Track which source DOM columns need empty-state check and count decrements
3340-            // Key: DOM column ID, Value: set of sessionIds moved from that DOM col
3341-            const sourceDomColCounts = {};
3342-
3343-            sessionIds.forEach(id => {
3344-                const cardEl = document.querySelector(`.kanban-card[data-session="${id}"]`);
3345-                if (!cardEl) return;
3346-
3347-                // Resolve actual source column from currentCards (cards have no data-column attribute)
3348-                const cardData = currentCards.find(c => (c.sessionId || c.planId) === id);
3349-                const actualColumn = cardData ? cardData.column : sourceColumn;
3350-
3351-                // When coders are collapsed, actual coder columns display in CODED_AUTO DOM container
3352-                const CODED_IDS = ['LEAD CODED', 'CODER CODED', 'INTERN CODED'];
3353-                const sourceDomCol = (collapseCodersEnabled && CODED_IDS.includes(actualColumn))
3354-                    ? 'CODED_AUTO'
3355-                    : actualColumn;
3356-
3357-                // Capture source body BEFORE appendChild (closest() changes after move)
3358-                const sourceBody = document.getElementById('col-' + sourceDomCol);
3359-
3360-                // Move card to target
3361-                cardEl.classList.add('card-completing');
3362-                targetBody.appendChild(cardEl);
3363-
3364-                // Track for post-loop empty state + count updates
3365-                if (!sourceDomColCounts[sourceDomCol]) sourceDomColCounts[sourceDomCol] = 0;
3366-                sourceDomColCounts[sourceDomCol]++;
3367-            });
3368-
3369-            // Update source column empty states and counts
3370-            Object.entries(sourceDomColCounts).forEach(([domCol, movedCount]) => {
3371-                const sourceBody = document.getElementById('col-' + domCol);
3372-                if (sourceBody && sourceBody.querySelectorAll('.kanban-card').length === 0) {
3373-                    sourceBody.innerHTML = '<div class="empty-state">No plans</div>';
3374-                }
3375-                const srcCount = document.getElementById('count-' + domCol);
3376-                if (srcCount) {
3377-                    srcCount.textContent = String(Math.max(0, parseInt(srcCount.textContent || '0') - movedCount));
3378-                }
3379-            });
3380-
3381-            // Increment target count
3382-            const tgtCount = document.getElementById('count-' + targetColumn);
3383-            if (tgtCount) {
3384-                tgtCount.textContent = String((parseInt(tgtCount.textContent || '0') + sessionIds.length));
3385-            }
3386-        }
3387-
3388-        /** Get all selected session IDs within a specific column. */
3389-        function getSelectedInColumn(col) {
3390-            const container = document.getElementById('col-' + col);
3391-            if (!container) return [];
3392-            const ids = [];
3393-            container.querySelectorAll('.kanban-card.selected').forEach(el => {
3394-                ids.push(el.dataset.session || el.dataset.planId || '');
3395-            });
3396-            return ids.filter(Boolean);
3397-        }
3398-
3399-        /** Get selected session IDs from the dragged card's rendered column container. */
3400-        function getSelectedInRenderedContainer(cardEl) {
3401-            const container = cardEl ? cardEl.closest('.column-body') : null;
3402-            if (!container) return [];
3403-            return Array.from(container.querySelectorAll('.kanban-card.selected'))
3404-                .map(el => el.dataset.session || el.dataset.planId || '')
3405-                .filter(Boolean);
3406-        }
3407-
3408-        /** Get all session IDs within a specific column. */
3409-        function getAllInColumn(col) {
3410-            if (col === 'CODED_AUTO') {
3411-                const CODED_IDS = ['LEAD CODED', 'CODER CODED', 'INTERN CODED'];
3412-                return currentCards.filter(c => CODED_IDS.includes(c.column)).map(c => c.sessionId || c.planId || '').filter(Boolean);
3413-            }
3414-            return currentCards.filter(c => c.column === col).map(c => c.sessionId || c.planId || '').filter(Boolean);
3415-        }
3416-
3417-        function escapeAttr(value) {
3418-            return String(value || '')
3419-                .replace(/&/g, '&amp;')
3420-                .replace(/"/g, '&quot;')
3421-                .replace(/'/g, '&#39;')
3422-                .replace(/</g, '&lt;')
3423-                .replace(/>/g, '&gt;');
3424-        }
3425-
3426-        function updateIntegrationIntervalState() {
3427-            const toggle = document.getElementById('integration-autopull-toggle');
3428-            const select = document.getElementById('integration-interval-select');
3429-            if (!toggle || !select) return;
3430-            select.disabled = !toggle.checked;
3431-        }
3432-
3433-        function openIntegrationSettings(kind) {
3434-            const modal = document.getElementById('integration-settings-modal');
3435-            const title = document.getElementById('integration-settings-title');
3436-            const toggle = document.getElementById('integration-autopull-toggle');
3437-            const select = document.getElementById('integration-interval-select');
3438-            const state = integrationState[kind];
3439-            if (!modal || !title || !toggle || !select || !state) return;
3440-
3441-            activeIntegration = kind;
3442-            title.textContent = kind === 'clickup' ? 'ClickUp Auto-Pull & Automation Settings' : 'Linear Auto-Pull & Automation Settings';
3443-            toggle.checked = !!state.autoPullEnabled;
3444-            select.value = String(state.pullIntervalMinutes || 60);
3445-            updateIntegrationIntervalState();
3446-            modal.classList.remove('hidden');
3447-        }
3448-
3449-        function closeIntegrationSettings() {
3450-            const modal = document.getElementById('integration-settings-modal');
3451-            if (!modal) return;
3452-            modal.classList.add('hidden');
3453-            activeIntegration = null;
3454-        }
3455-
3456-        function saveIntegrationSettings() {
3457-            const toggle = document.getElementById('integration-autopull-toggle');
3458-            const select = document.getElementById('integration-interval-select');
3459-            if (!activeIntegration || !toggle || !select) return;
3460-
3461-            postKanbanMessage({
3462-                type: 'saveIntegrationAutoPullSettings',
3463-                integration: activeIntegration,
3464-                autoPullEnabled: !!toggle.checked,
3465-                pullIntervalMinutes: Number(select.value || 60)
3466-            });
3467-            closeIntegrationSettings();
3468-        }
3469-
3470-        function openTestingFailModal(sessionIds, column) {
3471-            testingFailSessionIds = sessionIds;
3472-            testingFailSourceColumn = column;
3473-            const modal = document.getElementById('testing-fail-modal');
3474-            const countEl = document.getElementById('testing-fail-plan-count');
3475-            const listEl = document.getElementById('testing-fail-plan-list');
3476-            const textarea = document.getElementById('testing-fail-feedback');
3477-            const def = columnDefinitions.find(d => d.id === column);
3478-            const label = def ? def.label : column;
3479-            countEl.textContent = sessionIds.length + ' plan(s) selected from "' + label + '" column';
3480-            listEl.innerHTML = sessionIds.map(id => {
3481-                const card = currentCards.find(c => c.sessionId === id);
3482-                const topic = card ? escapeHtml(card.topic || card.sessionId) : escapeHtml(id);
3483-                return '<li>' + topic + '</li>';
3484-            }).join('');
3485-            textarea.value = '';
3486-            textarea.style.borderColor = '';
3487-            modal.classList.remove('hidden');
3488-            textarea.focus();
3489-        }
3490-
3491-        function closeTestingFailModal() {
3492-            const modal = document.getElementById('testing-fail-modal');
3493-            modal.classList.add('hidden');
3494-            testingFailSessionIds = [];
3495-            testingFailSourceColumn = '';
3496-        }
3497-
3498-        function getColumnDefinition(col) {
3499-            return columnDefinitions.find(def => def.id === col) || null;
3500-        }
3501-
3502-        function buildBoardSignature(cards) {
3503-            if (!Array.isArray(cards) || cards.length === 0) return '';
3504-            return cards
3505-                .map(card => `${card.workspaceRoot || ''}|${card.planId || card.sessionId || ''}|${card.column}|${card.topic || ''}|${card.planFile || ''}|${card.complexity || 'Unknown'}|${card.lastActivity || ''}`)
3506-                .sort()
3507-                .join('||');
3508-        }
3509-
3510-        function captureBoardViewState() {
3511-            const columnScrollTop = {};
3512-            columns.forEach(col => {
3513-                const container = document.getElementById('col-' + col);
3514-                if (container) columnScrollTop[col] = container.scrollTop;
3515-            });
3516-            // Capture synthetic CODED_AUTO scroll when collapsed
3517-            if (collapseCodersEnabled) {
3518-                const autoContainer = document.getElementById('col-CODED_AUTO');
3519-                if (autoContainer) columnScrollTop['CODED_AUTO'] = autoContainer.scrollTop;
3520-            }
3521-            return {
3522-                boardScrollLeft: kanbanBoard.scrollLeft,
3523-                pageScrollY: window.scrollY,
3524-                columnScrollTop
3525-            };
3526-        }
3527-
3528-        function restoreBoardViewState(viewState) {
3529-            if (!viewState) return;
3530-            kanbanBoard.scrollLeft = viewState.boardScrollLeft || 0;
3531-            columns.forEach(col => {
3532-                const container = document.getElementById('col-' + col);
3533-                if (container) container.scrollTop = viewState.columnScrollTop[col] || 0;
3534-            });
3535-            // Restore synthetic CODED_AUTO scroll when collapsed
3536-            if (collapseCodersEnabled && viewState.columnScrollTop['CODED_AUTO'] != null) {
3537-                const autoContainer = document.getElementById('col-CODED_AUTO');
3538-                if (autoContainer) autoContainer.scrollTop = viewState.columnScrollTop['CODED_AUTO'];
3539-            }
3540-            window.scrollTo(0, viewState.pageScrollY || 0);
3541-        }
3542-
3543-        function renderColumns() {
3544-            // When collapsed, replace the three coder columns with a single synthetic entry
3545-            let renderDefs = columnDefinitions;
3546-            if (collapseCodersEnabled) {
3547-                const coderDefs = columnDefinitions.filter(d => d.kind === 'coded');
3548-                if (coderDefs.length > 0) {
3549-                    const syntheticCol = {
3550-                        id: 'CODED_AUTO',
3551-                        label: 'AUTOCODE',
3552-                        role: null,
3553-                        order: coderDefs[0].order || 180,
3554-                        kind: 'coded',
3555-                        autobanEnabled: true,
3556-                        dragDropMode: 'cli'
3557-                    };
3558-                    renderDefs = columnDefinitions
3559-                        .filter(d => d.kind !== 'coded')
3560-                        .concat([syntheticCol])
3561-                        .sort((a, b) => (a.order || 0) - (b.order || 0));
3562-                }
3563-            }
3564-
3565-            kanbanBoard.innerHTML = renderDefs.map(def => {
3566-                const isCreated = def.id === 'CREATED';
3567-                const isPlanReviewed = def.id === 'PLAN REVIEWED';
3568-                const isCompleted = def.kind === 'completed';
3569-                // Last working column = the column immediately before the completed column
3570-                const completedIndex = renderDefs.findIndex(d => d.kind === 'completed');
3571-                const defIndex = renderDefs.indexOf(def);
3572-                const isLastWorkingColumn = !isCompleted && completedIndex > 0 && defIndex === completedIndex - 1;
3573-                const hasAgent = !isCreated && !isCompleted;
3574-                
3575-                const mode = columnDragDropModes[def.id] || 'cli';
3576-                const modeIcon = mode === 'prompt' ? ICON_PROMPT : ICON_CLI;
3577-                const modeTitle = mode === 'prompt' ? 'Mode: Copy Prompt (drag cards to copy prompt to clipboard)' : 'Mode: CLI Dispatch (drag cards to trigger CLI agent)';
3578-                const modeToggle = (!isCreated && !isLastWorkingColumn && !isCompleted) 
3579-                    ? `<div class="mode-toggle mode-${mode}" data-column="${escapeAttr(def.id)}" data-tooltip="${escapeAttr(modeTitle)}">
3580-                           <img src="${modeIcon}" alt="${mode}">
3581-                       </div>` 
3582-                    : '';
3583-
3584-                const complexityRoutingToggle = isPlanReviewed
3585-                    ? `<div id="complexity-routing-toggle" class="complexity-routing-btn ${dynamicComplexityRoutingEnabled ? 'is-active' : ''}" data-tooltip="Toggle complexity routing (low→coder, high→lead)">
3586-                           <img src="${ICON_DYNAMIC_ROUTING}" alt="Dynamic Routing">
3587-                       </div>`
3588-                    : '';
3589-
3590-                const backlogToggleBtn = isCreated
3591-                    ? `<button class="backlog-toggle-btn${showingBacklog ? ' is-active' : ''}" id="btn-toggle-backlog" style="${draggedSessionId !== null ? 'pointer-events:none;opacity:0.5;' : ''}" data-tooltip="${showingBacklog ? 'Switch to New view' : 'Switch to Backlog view'}">${showingBacklog ? 'NEW' : 'BACKLOG'}</button>`
3592-                    : '';
3593-                const rightSide = isCreated
3594-                    ? `<div style="display: flex; align-items: center; gap: 8px; line-height: 1;">
3595-                            ${backlogToggleBtn}
3596-                            <button class="btn-add-plan" id="btn-add-plan" data-tooltip="Add Plan">+</button>
3597-                            <button class="btn-add-plan" id="btn-import-clipboard" data-tooltip="Import plan(s) from clipboard&#10;&#10;Multi-plan? Separate with markers:&#10;### PLAN 1 START&#10;[plan 1 content]&#10;### PLAN 2 START&#10;[plan 2 content]"><img src="${ICON_IMPORT_CLIPBOARD}" alt="Import" style="width: 16px; height: 16px;"></button>
3598-                            <span class="column-count" id="count-${escapeAttr(def.id)}">0</span>
3599-                       </div>`
3600-                    : `<div style="display: flex; align-items: center; gap: 4px;">
3601-                            ${complexityRoutingToggle}
3602-                            ${modeToggle}
3603-                            <span class="column-count" id="count-${escapeAttr(def.id)}">0</span>
3604-                       </div>`;
3605-                const subline = hasAgent
3606-                    ? `<div class="column-agent" id="agent-${escapeAttr(def.id)}"></div>`
3607-                    : `<div class="column-subline-spacer" aria-hidden="true"></div>`;
3608-
3609-                // Column button area (with buttons for all columns except last/completed, empty strip for last)
3610-                let buttonArea = '';
3611-                if (isCompleted) {
3612-                    buttonArea = `<div class="column-button-area">
3613-                        <button class="column-icon-btn recover-selected-btn" data-action="recover-selected" data-column="${escapeAttr(def.id)}" data-tooltip="Recover selected plans back to active board">
3614-                            <img src="${ICON_RECOVER_SELECTED}" alt="Recover Selected">
3615-                        </button>
3616-                        <button class="column-icon-btn archive-selected-btn" data-action="archive-selected" data-column="${escapeAttr(def.id)}" data-tooltip="Archive selected plans to DuckDB">
3617-                            <img src="${ICON_ARCHIVE_SELECTED}" alt="Archive Selected">
3618-                        </button>
3619-                    </div>`;
3620-                } else if (isLastWorkingColumn) {
3621-                    // Reviewed column: Complete Selected / Complete All buttons only (no prompt/CLI dispatch)
3622-                    buttonArea = `<div class="column-button-area">
3623-                        <button class="column-icon-btn" data-action="completeSelected" data-column="${escapeAttr(def.id)}" data-tooltip="Complete selected plans">
3624-                            <img src="${ICON_MOVE_SELECTED}" alt="Complete Selected">
3625-                        </button>
3626-                        <button class="column-icon-btn" data-action="completeAll" data-column="${escapeAttr(def.id)}" data-tooltip="Complete all plans in this column">
3627-                            <img src="${ICON_MOVE_ALL}" alt="Complete All">
3628-                        </button>
3629-                        <button class="column-icon-btn testing-fail-btn" data-action="testingFailed" data-column="${escapeAttr(def.id)}" data-tooltip="Report testing failure for selected plans">
3630-                            <img src="${ICON_TESTING_FAIL}" alt="Testing Failed" class="testing-fail-icon">
3631-                        </button>
3632-                    </div>`;
3633-                } else {
3634-                    const julesBtn = (isPlanReviewed && lastVisibleAgents.jules !== false)
3635-                        ? `<button class="column-icon-btn" data-action="julesSelected" data-column="${escapeAttr(def.id)}" data-tooltip="Send selected plans to Jules">
3636-                               <img src="${ICON_JULES}" alt="Jules">
3637-                           </button>`
3638-                        : '';
3639-                    const rePlanBtn = (isPlanReviewed && lastVisibleAgents.planner !== false)
3640-                        ? `<button class="column-icon-btn" data-action="rePlanSelected" data-column="${escapeAttr(def.id)}" data-tooltip="Re-plan selected plans (trigger high-reasoning refinement)">
3641-                               <img src="${ICON_ANALYST_MAP}" alt="Re-plan">
3642-                           </button>`
3643-                        : '';
3644-                    const codeMapBtn = (isCreated && lastVisibleAgents.analyst !== false)
3645-                        ? `<button class="column-icon-btn" data-action="codeMapSelected" data-column="${escapeAttr(def.id)}" data-tooltip="Run code map on selected plans (or all if none selected)">
3646-                               <img src="${ICON_CODE_MAP}" alt="Code Map">
3647-                           </button>`
3648-                        : '';
3649-                    const testingFailBtn = (def.kind === 'coded')
3650-                        ? `<button class="column-icon-btn testing-fail-btn" data-action="testingFailed" data-column="${escapeAttr(def.id)}" data-tooltip="Report testing failure for selected plans">
3651-                               <img src="${ICON_TESTING_FAIL}" alt="Testing Failed" class="testing-fail-icon">
3652-                           </button>`
3653-                        : '';
3654-                    const chatBtn = isCreated
3655-                        ? `<button class="column-icon-btn" data-action="chatCopyPrompt" data-column="${escapeAttr(def.id)}" data-tooltip="Copy chat prompt for selected plans to clipboard">
3656-                               <img src="${ICON_CHAT}" alt="Chat">
3657-                           </button>`
3658-                        : '';
3659-                    buttonArea = `<div class="column-button-area">
3660-                        <button class="column-icon-btn" data-action="moveSelected" data-column="${escapeAttr(def.id)}" data-tooltip="Move selected plans to next stage (triggers CLI if enabled)">
3661-                            <img src="${ICON_MOVE_SELECTED}" alt="Move Selected">
3662-                        </button>
3663-                        <button class="column-icon-btn" data-action="moveAll" data-column="${escapeAttr(def.id)}" data-tooltip="Move all plans in this column to next stage">
3664-                            <img src="${ICON_MOVE_ALL}" alt="Move All">
3665-                        </button>
3666-                        <button class="column-icon-btn" data-action="promptSelected" data-column="${escapeAttr(def.id)}" data-tooltip="Copy prompt for selected plans and advance to next stage">
3667-                            <img src="${ICON_PROMPT_SELECTED}" alt="Prompt Selected">
3668-                        </button>
3669-                        <button class="column-icon-btn" data-action="promptAll" data-column="${escapeAttr(def.id)}" data-tooltip="Copy prompt for all plans in this column and advance">
3670-                            <img src="${ICON_PROMPT_ALL}" alt="Prompt All">
3671-                        </button>
3672-                        ${julesBtn}
3673-                        ${rePlanBtn}
3674-                        ${codeMapBtn}
3675-                        ${testingFailBtn}
3676-                        ${chatBtn}
3677-                    </div>`;
3678-                }
3679-
3680-                const columnDisplayLabel = (isCreated && showingBacklog) ? 'BACKLOG' : def.label;
3681-                return `<div class="kanban-column" data-column="${escapeAttr(def.id)}">
3682-                    <div class="column-header">
3683-                        <div style="display:flex; flex-direction:column;">
3684-                            <span class="column-name">${escapeHtml(columnDisplayLabel)}</span>
3685-                            ${subline}
3686-                        </div>
3687-                        ${rightSide}
3688-                    </div>
3689-                    ${buttonArea}
3690-                    <div class="column-body" id="col-${escapeAttr(def.id)}"></div>
3691-                </div>`;
3692-            }).join('');
3693-
3694-            document.getElementById('btn-toggle-backlog')?.addEventListener('click', () => {
3695-                postKanbanMessage({ type: 'toggleBacklogView' });
3696-            });
3697-
3698-            document.getElementById('btn-add-plan')?.addEventListener('click', () => {
3699-                postKanbanMessage({ type: 'createPlan' });
3700-            });
3701-
3702-            document.getElementById('btn-import-clipboard')?.addEventListener('click', () => {
3703-                postKanbanMessage({ type: 'importFromClipboard' });
3704-            });
3705-
3706-            // Mode toggle handlers
3707-            document.querySelectorAll('.mode-toggle').forEach(toggle => {
3708-                toggle.addEventListener('click', () => {
3709-                    const columnId = toggle.dataset.column;
3710-                    const currentMode = columnDragDropModes[columnId] || 'cli';
3711-                    const nextMode = currentMode === 'cli' ? 'prompt' : 'cli';
3712-                    
3713-                    // Optimistic update
3714-                    columnDragDropModes[columnId] = nextMode;
3715-                    renderColumns();
3716-                    renderBoard(currentCards);
3717-                    updateAllColumnAgents();
3718-                    
3719-                    postKanbanMessage({ type: 'setColumnDragDropMode', columnId, mode: nextMode });
3720-                });
3721-            });
3722-
3723-
3724-            // Column icon button handlers
3725-            document.querySelectorAll('.column-icon-btn').forEach(btn => {
3726-                btn.addEventListener('click', () => {
3727-                    flashIconBtn(btn);
3728-                    const action = btn.dataset.action;
3729-                    const column = btn.dataset.column;
3730-                    // CODED_AUTO is synthetic — resolve to a real coder column for getNextColumn and backend messages.
3731-                    // All coded columns share the same next column (CODE REVIEWED), so using the first real one works.
3732-                    const backendColumn = (column === 'CODED_AUTO') ? (columnDefinitions.find(d => d.kind === 'coded')?.id || 'LEAD CODED') : column;
3733-                    const nextCol = getNextColumn(backendColumn);
3734-                    if (!nextCol && action !== 'julesSelected' && action !== 'rePlanSelected' && action !== 'completeSelected' && action !== 'completeAll' && action !== 'testingFailed') return;
3735-
3736-                    switch (action) {
3737-                        case 'moveSelected': {
3738-                            const ids = getSelectedInColumn(column);
3739-                            if (ids.length === 0) return;
3740-                            // Optimistic UI: highlight target column and move cards immediately
3741-                            if (nextCol) {
3742-                                const targetBody = document.getElementById('col-' + nextCol);
3743-                                if (targetBody) {
3744-                                    targetBody.classList.add('highlight');
3745-                                    targetBody.addEventListener('animationend', () => targetBody.classList.remove('highlight'), { once: true });
3746-                                }
3747-                                moveCardsOptimistically(ids, column, nextCol);
3748-                            }
3749-                            postKanbanMessage({ type: 'moveSelected', column: backendColumn, sessionIds: ids });
3750-                            ids.forEach(id => selectedCards.delete(id));
3751-                            break;
3752-                        }
3753-                        case 'moveAll': {
3754-                            const ids = getAllInColumn(column);
3755-                            if (ids.length === 0) return;
3756-                            // Optimistic UI: highlight target column and move cards immediately
3757-                            if (nextCol) {
3758-                                const targetBody = document.getElementById('col-' + nextCol);
3759-                                if (targetBody) {
3760-                                    targetBody.classList.add('highlight');
3761-                                    targetBody.addEventListener('animationend', () => targetBody.classList.remove('highlight'), { once: true });
3762-                                }
3763-                                moveCardsOptimistically(ids, column, nextCol);
3764-                            }
3765-                            // CODED_AUTO: backend moveAll filters by single column, so send explicit IDs instead
3766-                            if (column === 'CODED_AUTO') {
3767-                                postKanbanMessage({ type: 'moveSelected', column: backendColumn, sessionIds: ids });
3768-                            } else {
3769-                                postKanbanMessage({ type: 'moveAll', column: backendColumn });
3770-                            }
3771-                            ids.forEach(id => selectedCards.delete(id));
3772-                            break;
3773-                        }
3774-                        case 'promptSelected': {
3775-                            const ids = getSelectedInColumn(column);
3776-                            if (ids.length === 0) return;
3777-                            // Optimistic UI: highlight target column and move cards immediately
3778-                            if (nextCol) {
3779-                                const targetBody = document.getElementById('col-' + nextCol);
3780-                                if (targetBody) {
3781-                                    targetBody.classList.add('highlight');
3782-                                    targetBody.addEventListener('animationend', () => targetBody.classList.remove('highlight'), { once: true });
3783-                                }
3784-                                moveCardsOptimistically(ids, column, nextCol);
3785-                            }
3786-                            postKanbanMessage({ type: 'promptSelected', column: backendColumn, sessionIds: ids });
3787-                            ids.forEach(id => selectedCards.delete(id));
3788-                            break;
3789-                        }
3790-                        case 'promptAll': {
3791-                            const ids = getAllInColumn(column);
3792-                            if (ids.length === 0) return;
3793-                            // Optimistic UI: highlight target column and move cards immediately
3794-                            if (nextCol) {
3795-                                const targetBody = document.getElementById('col-' + nextCol);
3796-                                if (targetBody) {
3797-                                    targetBody.classList.add('highlight');
3798-                                    targetBody.addEventListener('animationend', () => targetBody.classList.remove('highlight'), { once: true });
3799-                                }
3800-                                moveCardsOptimistically(ids, column, nextCol);
3801-                            }
3802-                            // CODED_AUTO: backend promptAll filters by single column, so send explicit IDs instead
3803-                            if (column === 'CODED_AUTO') {
3804-                                postKanbanMessage({ type: 'promptSelected', column: backendColumn, sessionIds: ids });
3805-                            } else {
3806-                                postKanbanMessage({ type: 'promptAll', column: backendColumn });
3807-                            }
3808-                            ids.forEach(id => selectedCards.delete(id));
3809-                            break;
3810-                        }
3811-                        case 'julesSelected': {
3812-                            const ids = getSelectedInColumn(column);
3813-                            if (ids.length === 0) return;
3814-                            postKanbanMessage({ type: 'julesSelected', sessionIds: ids });
3815-                            ids.forEach(id => selectedCards.delete(id));
3816-                            break;
3817-                        }
3818-                        case 'rePlanSelected': {
3819-                            const ids = getSelectedInColumn(column);
3820-                            if (ids.length === 0) {
3821-                                postKanbanMessage({ type: 'showWarning', message: 'Please select at least one plan to re-plan.' });
3822-                                return;
3823-                            }
3824-                            postKanbanMessage({ type: 'rePlanSelected', sessionIds: ids, workspaceRoot: getActiveWorkspaceRoot() });
3825-                            break;
3826-                        }
3827-                        case 'codeMapSelected': {
3828-                            let ids = getSelectedInColumn(column);
3829-                            const usedAll = ids.length === 0;
3830-                            if (usedAll) {
3831-                                ids = getAllInColumn(column);
3832-                            }
3833-                            if (ids.length === 0) return;
3834-                            if (usedAll && ids.length > 5) {
3835-                                postKanbanMessage({ type: 'codeMapConfirm', sessionIds: ids, count: ids.length, workspaceRoot: getActiveWorkspaceRoot() });
3836-                            } else {
3837-                                postKanbanMessage({ type: 'codeMapSelected', sessionIds: ids, workspaceRoot: getActiveWorkspaceRoot() });
3838-                            }
3839-                            break;
3840-                        }
3841-                        case 'chatCopyPrompt': {
3842-                            const ids = getSelectedInColumn(column);
3843-                            postKanbanMessage({ type: 'chatCopyPrompt', sessionIds: ids, workspaceRoot: getActiveWorkspaceRoot() });
3844-                            break;
3845-                        }
3846-                        case 'testingFailed': {
3847-                            const ids = getSelectedInColumn(column);
3848-                            if (ids.length === 0) return;
3849-                            openTestingFailModal(ids, backendColumn);
3850-                            break;
3851-                        }
3852-                        case 'completeSelected': {
3853-                            const ids = getSelectedInColumn(column);
3854-                            if (ids.length === 0) return;
3855-                            postKanbanMessage({ type: 'completeSelected', sessionIds: ids, workspaceRoot: getActiveWorkspaceRoot() });
3856-                            ids.forEach(id => selectedCards.delete(id));
3857-                            break;
3858-                        }
3859-                        case 'completeAll': {
3860-                            const ids = getAllInColumn(column);
3861-                            if (ids.length === 0) return;
3862-                            postKanbanMessage({ type: 'completeAll', workspaceRoot: getActiveWorkspaceRoot() });
3863-                            ids.forEach(id => selectedCards.delete(id));
3864-                            break;
3865-                        }
3866-                    }
3867-                });
3868-            });
3869-
3870-            document.querySelectorAll('.column-body').forEach(container => {
3871-                const col = container.id.replace(/^col-/, '');
3872-                container.addEventListener('dragover', handleDragOver);
3873-                container.addEventListener('dragenter', handleDragEnter);
3874-                container.addEventListener('dragleave', handleDragLeave);
3875-                container.addEventListener('drop', (e) => handleDrop(e, col));
3876-            });
3877-        }
3878-
3879-        /** Map a kanban column to its assigned agent role. */
3880-        function columnToRole(col) {
3881-            const def = getColumnDefinition(col);
3882-            return def ? (def.role || null) : null;
3883-        }
3884-
3885-        /** Check if a column's agent is visible (enabled). */
3886-        function isColumnAgentVisible(col) {
3887-            const role = columnToRole(col);
3888-            if (!role) return true;
3889-            return lastVisibleAgents[role] !== false;
3890-        }
3891-
3892-        /** Check if a column currently has an assigned agent command behind it. */
3893-        function isColumnAgentAssigned(col) {
3894-            const role = columnToRole(col);
3895-            if (!role) return true;
3896-            const name = lastAgentNames[role];
3897-            return !!name && name !== 'No agent assigned';
3898-        }
3899-
3900-        function isColumnAgentAvailable(col) {
3901-            return isColumnAgentVisible(col) && isColumnAgentAssigned(col);
3902-        }
3903-
3904-        function updateAllColumnAgents() {
3905-            if (!lastAgentNames) return;
3906-
3907-            columns.forEach(col => {
3908-                const el = document.getElementById('agent-' + col);
3909-                if (el) {
3910-                    const role = columnToRole(col);
3911-                    const name = lastAgentNames[role];
3912-                    if (role && (lastVisibleAgents[role] === false || name === 'No agent assigned')) {
3913-                        el.textContent = 'No agent assigned';
3914-                        el.style.color = 'var(--vscode-editorWarning-foreground, #cca700)';
3915-                        el.style.fontStyle = 'italic';
3916-                    } else {
3917-                        el.textContent = name || '';
3918-                        el.style.color = '';
3919-                        el.style.fontStyle = '';
3920-                    }
3921-                }
3922-            });
3923-
3924-            // Update synthetic CODED_AUTO agent subline when collapsed
3925-            const autoRouteEl = document.getElementById('agent-CODED_AUTO');
3926-            if (autoRouteEl) {
3927-                autoRouteEl.textContent = 'Dynamic routing';
3928-                autoRouteEl.style.color = '';
3929-            }
3930-        }
3931-
3932-        function updateJulesButtonVisibility() {
3933-            const isVisible = lastVisibleAgents.jules !== false;
3934-            document.querySelectorAll('[data-action="julesSelected"]').forEach(btn => {
3935-                btn.style.display = isVisible ? '' : 'none';
3936-            });
3937-        }
3938-
3939-        function updateAutobanButtonState() {
3940-            const autobanBtn = document.getElementById('btn-autoban');
3941-            if (!autobanBtn) return;
3942-            const isEnabled = !!(autobanConfig && autobanConfig.enabled);
3943-            autobanBtn.classList.toggle('is-active', isEnabled);
3944-            autobanBtn.textContent = isEnabled ? '⏸ STOP AUTOMATION' : '▶ START AUTOMATION';
3945-            autobanBtn.title = isEnabled ? 'Stop automation engine' : 'Start automation engine';
3946-        }
3947-
3948-        function syncAutobanCountdownTimer() {
3949-            const shouldRun = !!(autobanConfig && autobanConfig.enabled);
3950-            if (shouldRun && !autobanCountdownTimer) {
3951-                autobanCountdownTimer = setInterval(updateAutobanIndicators, 1000);
3952-                return;
3953-            }
3954-            if (!shouldRun && autobanCountdownTimer) {
3955-                clearInterval(autobanCountdownTimer);
3956-                autobanCountdownTimer = null;
3957-            }
3958-        }
3959-
3960-        function renderBoard(cards) {
3961-            hideTooltip();
3962-            const viewState = captureBoardViewState();
3963-            currentCards = cards;
3964-            const buckets = {};
3965-            columns.forEach(c => buckets[c] = []);
3966-
3967-            // Filter/remap cards based on backlog view state
3968-            let displayCards = cards;
3969-            if (!showingBacklog) {
3970-                displayCards = cards.filter(card => card.column !== 'BACKLOG');
3971-            } else {
3972-                displayCards = cards
3973-                    .filter(card => card.column !== 'CREATED')
3974-                    .map(card => card.column === 'BACKLOG' ? { ...card, _effectiveColumn: 'CREATED' } : card);
3975-            }
3976-
3977-            displayCards.forEach(card => {
3978-                const effectiveCol = card._effectiveColumn || card.column;
3979-                const col = columns.includes(effectiveCol) ? effectiveCol : 'CREATED';
3980-                const t = new Date(card.lastActivity).getTime();
3981-                card._ts = isNaN(t) ? 0 : t;
3982-                buckets[col].push(card);
3983-            });
3984-
3985-            const CODED_COLUMN_IDS = ['LEAD CODED', 'CODER CODED', 'INTERN CODED'];
3986-
3987-            if (collapseCodersEnabled) {
3988-                // Render all coder-column cards into the synthetic CODED_AUTO container
3989-                const coderItems = [];
3990-                CODED_COLUMN_IDS.forEach(colId => {
3991-                    coderItems.push(...(buckets[colId] || []));
3992-                });
3993-                // Sort combined coder items by timestamp (newest first)
3994-                coderItems.sort((a, b) => b._ts - a._ts);
3995-                const sortedCoderItems = coderItems;
3996-                const autoContainer = document.getElementById('col-CODED_AUTO');
3997-                const autoCountEl = document.getElementById('count-CODED_AUTO');
3998-                if (autoContainer && autoCountEl) {
3999-                    autoCountEl.textContent = String(coderItems.length);
4000-                    autoContainer.innerHTML = coderItems.length === 0
4001-                        ? '<div class="empty-state">No plans</div>'
4002-                        : sortedCoderItems.map(card => createCardHtml(card)).join('');
4003-                }
4004-            }
4005-
4006-            columns.forEach(col => {
4007-                // In collapsed mode, skip the individual coder columns (rendered above as CODED_AUTO)
4008-                if (collapseCodersEnabled && CODED_COLUMN_IDS.includes(col)) return;
4009-                const container = document.getElementById('col-' + col);
4010-                const countEl = document.getElementById('count-' + col);
4011-                const items = buckets[col];
4012-                if (!container || !countEl) return;
4013-                // Only apply dependency sorting to planning columns
4014-                const PLANNING_COLUMNS = ['CREATED', 'PLAN REVIEWED'];
4015-                const isPlanningColumn = PLANNING_COLUMNS.includes(col);
4016-                const sortedItems = isPlanningColumn
4017-                    ? sortColumnByDependencies(items)
4018-                    : [...items].sort((a, b) => {
4019-                        const tsDiff = (b._ts || 0) - (a._ts || 0);
4020-                        if (tsDiff !== 0) return tsDiff;
4021-                        // Secondary tiebreaker: createdAt descending (for cards with no lastActivity/same lastActivity)
4022-                        let createdA = a.createdAt ? new Date(a.createdAt).getTime() : 0;
4023-                        let createdB = b.createdAt ? new Date(b.createdAt).getTime() : 0;
4024-                        if (isNaN(createdA)) createdA = 0;
4025-                        if (isNaN(createdB)) createdB = 0;
4026-                        return createdB - createdA;
4027-                    });
4028-                countEl.textContent = items.length;
4029-
4030-                if (items.length === 0) {
4031-                    container.innerHTML = '<div class="empty-state">No plans</div>';
4032-                } else {
4033-                    container.innerHTML = sortedItems.map(card => createCardHtml(card)).join('');
4034-                }
4035-            });
4036-
4037-            // Attach card-level event listeners
4038-            document.querySelectorAll('.kanban-card').forEach(el => {
4039-                el.addEventListener('dragstart', handleDragStart);
4040-                el.addEventListener('dragend', handleDragEnd);
4041-
4042-                // Card selection toggle (click on card body, not on buttons)
4043-                el.addEventListener('click', (e) => {
4044-                    if (e.target.closest('.card-btn') || e.target.closest('button')) return;
4045-                    const pid = el.dataset.session || el.dataset.planId || '';
4046-                    if (!pid) return; // Skip if no valid ID — also prevents empty selectPlan message
4047-                    if (selectedCards.has(pid)) {
4048-                        selectedCards.delete(pid);
4049-                        el.classList.remove('selected');
4050-                    } else {
4051-                        selectedCards.add(pid);
4052-                        el.classList.add('selected');
4053-                        // Sync sidebar dropdown on unmodified single clicks
4054-                        if (!e.shiftKey && !e.metaKey && !e.ctrlKey) {
4055-                            postKanbanMessage({ type: 'selectPlan', sessionId: el.dataset.session || '', planId: pid });
4056-                        }
4057-                    }
4058-                    updateReassignButtonVisibility();
4059-                });
4060-
4061-                // Re-apply selection state after re-render
4062-                const pid = el.dataset.session || el.dataset.planId || '';
4063-                if (pid && selectedCards.has(pid)) {
4064-                    el.classList.add('selected');
4065-                }
4066-            });
4067-
4068-            document.querySelectorAll('.card-btn.review').forEach(btn => {
4069-                btn.addEventListener('click', () => {
4070-                    postKanbanMessage({ type: 'reviewPlan', sessionId: btn.dataset.session || '', planId: btn.dataset.planId || '', workspaceRoot: btn.dataset.workspaceRoot });
4071-                });
4072-            });
4073-
4074-            document.querySelectorAll('.card-btn.complete').forEach(btn => {
4075-                btn.addEventListener('click', (e) => {
4076-                    const cardEl = e.target.closest('.kanban-card');
4077-                    if (cardEl) {
4078-                        // Optimistic UI: Animate out before sending to backend
4079-                        cardEl.classList.add('card-completing');
4080-                        setTimeout(() => {
4081-                            postKanbanMessage({ type: 'completePlan', sessionId: btn.dataset.session || '', planId: btn.dataset.planId || '', workspaceRoot: btn.dataset.workspaceRoot });
4082-                        }, 350); // Slightly less than 400ms to ensure smooth handoff to the backend redraw
4083-                    } else {
4084-                        // Fallback if DOM traversal fails
4085-                        postKanbanMessage({ type: 'completePlan', sessionId: btn.dataset.session || '', planId: btn.dataset.planId || '', workspaceRoot: btn.dataset.workspaceRoot });
4086-                    }
4087-                });
4088-            });
4089-
4090-            document.querySelectorAll('.card-btn.copy').forEach(btn => {
4091-                btn.addEventListener('click', () => {
4092-                    const column = btn.dataset.column || btn.closest('.kanban-column')?.dataset?.column;
4093-                    const sessionId = btn.dataset.session || '';
4094-                    postKanbanMessage({
4095-                        type: 'promptSelected',
4096-                        column,
4097-                        sessionIds: [sessionId],
4098-                        workspaceRoot: btn.dataset.workspaceRoot
4099-                    });
4100-                });
4101-            });
4102-
4103-            document.querySelectorAll('.card-btn.recover').forEach(btn => {
4104-                btn.addEventListener('click', () => {
4105-                    btn.disabled = true;
4106-                    btn.textContent = 'Recovering…';
4107-                    postKanbanMessage({ type: 'recoverSelected', sessionIds: [btn.dataset.session || ''], planIds: [btn.dataset.planId || ''] });
4108-                });
4109-            });
4110-
4111-            document.querySelectorAll('.pair-program-btn').forEach(btn => {
4112-                btn.addEventListener('click', () => {
4113-                    const sessionId = btn.dataset.session || '';
4114-                    const planId = btn.dataset.planId || '';
4115-                    postKanbanMessage({ type: 'pairProgramCard', sessionId, planId });
4116-                });
4117-            });
4118-
4119-            document.querySelectorAll('.send-to-backlog-btn').forEach(btn => {
4120-                btn.addEventListener('click', () => {
4121-                    postKanbanMessage({ type: 'sendToBacklog', sessionId: btn.dataset.session || '', planId: btn.dataset.planId || '', workspaceRoot: btn.dataset.workspaceRoot });
4122-                });
4123-            });
4124-
4125-            document.querySelectorAll('.send-to-new-btn').forEach(btn => {
4126-                btn.addEventListener('click', () => {
4127-                    postKanbanMessage({ type: 'sendToNew', sessionId: btn.dataset.session || '', planId: btn.dataset.planId || '', workspaceRoot: btn.dataset.workspaceRoot });
4128-                });
4129-            });
4130-
4131-
4132-
4133-            requestAnimationFrame(() => restoreBoardViewState(viewState));
4134-            updateReassignButtonVisibility();
4135-        }
4136-        function scoreToCategory(scoreStr) {
4137-            if (scoreStr === 'High') return 'High';
4138-            if (scoreStr === 'Low') return 'Low';
4139-            const score = parseInt(scoreStr, 10);
4140-            if (isNaN(score) || score <= 0) return 'Unknown';
4141-            if (score <= 2) return 'Very Low';
4142-            if (score <= 4) return 'Low';
4143-            if (score <= 6) return 'Medium';
4144-            if (score <= 8) return 'High';
4145-            if (score <= 10) return 'Very High';
4146-            return 'Unknown';
4147-        }
4148-
4149-        function categoryToCssClass(category) {
4150-            return category.toLowerCase().replace(' ', '-');
4151-        }
4152-
4153-        // Resolve a card's declared dependency strings (sessionIds or topics) against
4154-        // the currently-loaded board. Used to drive the red "blocked by" tooltip.
4155-        // Mirrors the resolver logic in sortColumnByDependencies, but scoped to
4156-        // all currentCards (not just one column) so cross-column deps still display
4157-        // meaningful tooltips.
4158-        function resolveCardDependencies(card) {
4159-            const raw = Array.isArray(card && card.dependencies) ? card.dependencies : [];
4160-            const resolved = [];
4161-            const pool = Array.isArray(currentCards) ? currentCards : [];
4162-            for (const rawDep of raw) {
4163-                const key = String(rawDep || '').trim();
4164-                if (!key) continue;
4165-                const isSessToken = /^sess_\d+$/.test(key);
4166-                let hit = null;
4167-                if (isSessToken) {
4168-                    hit = pool.find(c => c && c.sessionId === key) || null;
4169-                } else {
4170-                    const lower = key.toLowerCase();
4171-                    hit = pool.find(c => c && (c.sessionId === key || String(c.topic || '').trim().toLowerCase() === lower)) || null;
4172-                }
4173-                if (hit && hit.sessionId !== card.sessionId) {
4174-                    resolved.push({ raw: key, card: hit });
4175-                }
4176-                // Unresolved deps (no matching card) are silently dropped —
4177-                // cross-column blocking is surfaced via hasBlockingDependencies.
4178-            }
4179-            return { resolved };
4180-        }
4181-
4182-        function createCardHtml(card) {
4183-            const timeAgo = formatTimeAgo(card.lastActivity);
4184-            const shortTopic = card.topic.length > 50 ? card.topic.substring(0, 47) + '...' : card.topic;
4185-            const complexityValue = card.complexity || 'Unknown';
4186-            const category = scoreToCategory(complexityValue);
4187-            const complexityClass = categoryToCssClass(category);
4188-            const isCompleted = card.column === 'COMPLETED';
4189-            const completedClass = isCompleted ? ' completed' : '';
4190-
4191-            // Live sync state is retained in window.liveSyncStates for autoban/status-bar use,
4192-            // but card-level indicator and action buttons have been removed to reduce clutter.
4193-            // Pause/resume is still available via the card context menu.
4194-
4195-            // For completed cards, show a Recover button instead of Copy Prompt
4196-            let primaryActionBtn;
4197-            if (isCompleted) {
4198-                primaryActionBtn = `<button class="card-btn recover" data-plan-id="${escapeAttr(card.planId || card.sessionId || '')}" data-session="${escapeAttr(card.sessionId || '')}" data-tooltip="Recover this plan">Recover</button>`;
4199-            } else {
4200-                let copyLabel = 'Copy Prompt';
4201-                const CODED_IDS = ['LEAD CODED', 'CODER CODED', 'INTERN CODED'];
4202-                let sourceColumn = card.column;
4203-
4204-                // When a card is in the AUTOCODE bucket (visually collapsed or stored as CODED_AUTO),
4205-                // the next step is always the column after the coded lanes.
4206-                if (sourceColumn === 'CODED_AUTO' || (collapseCodersEnabled && CODED_IDS.includes(sourceColumn))) {
4207-                    const visibleCodedIds = CODED_IDS.filter(id => columns.includes(id));
4208-                    sourceColumn = visibleCodedIds[visibleCodedIds.length - 1] || 'CODER CODED';
4209-                }
4210-
4211-                const nextColId = getNextColumn(sourceColumn);
4212-                if (nextColId) {
4213-                    const nextDef = columnDefinitions.find(d => d.id === nextColId);
4214-                    if (nextDef) {
4215-                        const isCustom = nextDef.kind === 'custom-user' || nextDef.kind === 'custom-agent';
4216-                        if (isCustom) {
4217-                            copyLabel = 'Copy advance prompt';
4218-                        } else if (nextDef.role === 'planner' || nextDef.id === 'PLAN REVIEWED') {
4219-                            copyLabel = 'Copy planning prompt';
4220-                        } else if (['lead', 'coder', 'intern'].includes(nextDef.role)) {
4221-                            copyLabel = 'Copy coder prompt';
4222-                        } else if (nextDef.role === 'reviewer' || nextDef.id === 'CODE REVIEWED') {
4223-                            copyLabel = 'Copy review prompt';
4224-                        } else {
4225-                            copyLabel = 'Copy advance prompt';
4226-                        }
4227-                    }
4228-                }
4229-                primaryActionBtn = `<button class="card-btn copy" data-plan-id="${escapeAttr(card.planId || card.sessionId || '')}" data-session="${escapeAttr(card.sessionId || '')}" data-column="${escapeAttr(card.column)}" data-workspace-root="${escapeAttr(card.workspaceRoot)}" data-copy-label="${escapeAttr(copyLabel)}" data-tooltip="Copy prompt and advance">${copyLabel}</button>`;
4230-            }
4231-
4232-            const numericScore = parseInt(complexityValue, 10);
4233-            const isHighComplexity = complexityValue === 'High' || (!isNaN(numericScore) && numericScore >= 7);
4234-            const pairProgramBtn = (card.column === 'PLAN REVIEWED' && isHighComplexity)
4235-                ? `<button class="card-btn pair-program-btn" data-plan-id="${escapeAttr(card.planId || card.sessionId || '')}" data-session="${escapeAttr(card.sessionId || '')}" data-tooltip="Pair programming (Lead + Coder)">Pair</button>`
4236-                : '';
4237-            const backlogActionBtn = (!isCompleted && card.column === 'CREATED' && !showingBacklog)
4238-                ? `<button class="card-btn send-to-backlog-btn" data-plan-id="${escapeAttr(card.planId || card.sessionId || '')}" data-session="${escapeAttr(card.sessionId || '')}" data-workspace-root="${escapeAttr(card.workspaceRoot)}" data-tooltip="Move to Backlog">→ Backlog</button>`
4239-                : (!isCompleted && showingBacklog && card.column === 'BACKLOG')
4240-                    ? `<button class="card-btn send-to-new-btn" data-plan-id="${escapeAttr(card.planId || card.sessionId || '')}" data-session="${escapeAttr(card.sessionId || '')}" data-workspace-root="${escapeAttr(card.workspaceRoot)}" data-tooltip="Move back to New">→ New</button>`
4241-                    : '';
4242-
4243-            const completeOrDoneBtn = isCompleted
4244-                ? `<span class="card-done-badge">✓ Done</span>`
4245-                : `<button class="card-btn icon-btn complete" data-plan-id="${escapeAttr(card.planId || card.sessionId || '')}" data-session="${escapeAttr(card.sessionId || '')}" data-workspace-root="${escapeAttr(card.workspaceRoot)}" data-tooltip="Complete and archive">
4246-                       <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3.5 8.5l3 3 6-6"/></svg>
4247-                   </button>`;
4248-            const depInfo = resolveCardDependencies(card);
4249-            const blockingList = depInfo.resolved
4250-                .filter(r => r.card.column !== 'COMPLETED' && r.card.column !== 'CODE REVIEWED')
4251-                .map(r => `• ${r.card.topic || r.card.sessionId} (${r.card.column})`);
4252-            const redTitle = card.hasBlockingDependencies
4253-                ? (blockingList.length > 0
4254-                    ? `Blocked by:\n${blockingList.join('\n')}`
4255-                    : 'Has dependencies not yet ready')
4256-                : '';
4257-            const depWarningHtml = card.hasBlockingDependencies
4258-                ? `<span class="dependency-warning" title="${escapeAttr(redTitle)}">!</span>`
4259-                : '';
4260-            const cardId = escapeAttr(card.planId || card.sessionId || '');
4261-            return `
4262-                <div class="kanban-card${completedClass}" draggable="true" data-plan-id="${cardId}" data-session="${escapeAttr(card.sessionId || '')}" data-workspace-root="${escapeAttr(card.workspaceRoot)}">
4263-                    <div class="card-topic">${depWarningHtml}${escapeHtml(shortTopic)}</div>
4264-                    <div class="card-meta">Complexity: <span class="complexity-indicator ${complexityClass}">${category}</span> · ${timeAgo}</div>
4265-                    <div class="card-actions" style="display: flex; justify-content: space-between; align-items: center;">
4266-                        <div style="display: flex; gap: 4px;">
4267-                            ${pairProgramBtn}
4268-                            ${primaryActionBtn}
4269-                            ${backlogActionBtn}
4270-                        </div>
4271-                        <div style="display: flex; gap: 4px;">
4272-                            <button class="card-btn icon-btn review" data-plan-id="${cardId}" data-session="${escapeAttr(card.sessionId || '')}" data-workspace-root="${escapeAttr(card.workspaceRoot)}" data-tooltip="Review plan">
4273-                                <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M11.5 1.5l3 3L5 14H2v-3L11.5 1.5z"/></svg>
4274-                            </button>
4275-                            ${completeOrDoneBtn}
4276-                        </div>
4277-                    </div>
4278-                </div>
4279-            `;
4280-        }
4281-
4282-        function escapeHtml(str) {
4283-            const div = document.createElement('div');
4284-            div.textContent = str;
4285-            return div.innerHTML;
4286-        }
4287-
4288-        function formatTimeAgo(iso) {
4289-            if (!iso) return '';
4290-            const diff = Date.now() - new Date(iso).getTime();
4291-            const mins = Math.floor(diff / 60000);
4292-            if (mins < 1) return 'just now';
4293-            if (mins < 60) return mins + 'm ago';
4294-            const hrs = Math.floor(mins / 60);
4295-            if (hrs < 24) return hrs + 'h ago';
4296-            return Math.floor(hrs / 24) + 'd ago';
4297-        }
4298-
4299-        function sortColumnByDependencies(cards) {
4300-            if (cards.length <= 1) return cards;
4301-            // Build a dual-keyed lookup: planId (primary), sessionId (legacy), AND
4302-            // normalized topic all map to the same card. Lets us resolve legacy
4303-            // topic-form deps and new sessionId-form deps uniformly before DFS.
4304-            const keyToCard = new Map();
4305-            for (const c of cards) {
4306-                const cardKey = c.planId || c.sessionId || '';
4307-                if (cardKey) keyToCard.set(cardKey, c);
4308-                if (c.sessionId) keyToCard.set(c.sessionId, c); // legacy dep resolution
4309-                const topicKey = String(c.topic || '').trim().toLowerCase();
4310-                if (topicKey) keyToCard.set(topicKey, c);
4311-            }
4312-
4313-            // Resolve each card's raw dep strings to canonical planIds. Drop
4314-            // unresolved ones (cross-column or deleted targets — cross-column
4315-            // blocking is separately surfaced via hasBlockingDependencies).
4316-            const canonicalDepsFor = new Map();
4317-            for (const c of cards) {
4318-                const resolved = [];
4319-                const rawDeps = Array.isArray(c.dependencies) ? c.dependencies : [];
4320-                for (const raw of rawDeps) {
4321-                    const key = String(raw || '').trim();
4322-                    if (!key) continue;
4323-                    const sessTokenMatch = key.match(/^sess_\d+$/);
4324-                    const lookup = sessTokenMatch
4325-                        ? keyToCard.get(key)
4326-                        : (keyToCard.get(key) || keyToCard.get(key.toLowerCase()));
4327-                    const lookupKey = lookup ? (lookup.planId || lookup.sessionId || '') : '';
4328-                    const cardKey = c.planId || c.sessionId || '';
4329-                    if (lookupKey && lookupKey !== cardKey) {
4330-                        resolved.push(lookupKey);
4331-                    }
4332-                }
4333-                canonicalDepsFor.set(c.planId || c.sessionId || '', Array.from(new Set(resolved)));
4334-            }
4335-
4336-            const sorted = [];
4337-            const visited = new Set();
4338-            const visiting = new Set();
4339-
4340-            function visit(card) {
4341-                const cardKey = card ? (card.planId || card.sessionId || '') : '';
4342-                if (!cardKey) return;
4343-                if (visited.has(cardKey)) return;
4344-                if (visiting.has(cardKey)) {
4345-                    // Cycle detected — mark visited to break traversal but do NOT
4346-                    // push here. The outer visit() frame that's still on the stack
4347-                    // will push this card exactly once when it finishes.
4348-                    visited.add(cardKey);
4349-                    return;
4350-                }
4351-                visiting.add(cardKey);
4352-                const deps = canonicalDepsFor.get(cardKey) || [];
4353-                for (const depKey of deps) {
4354-                    const dep = keyToCard.get(depKey);
4355-                    if (dep) visit(dep);
4356-                }
4357-                visiting.delete(cardKey);
4358-                visited.add(cardKey);
4359-                sorted.push(card);
4360-            }
4361-
4362-            for (const card of cards) {
4363-                visit(card);
4364-            }
4365-            return sorted;
4366-        }
4367-
4368-        // Recover Selected handler
4369-        document.addEventListener('click', (e) => {
4370-            const btn = e.target.closest('.recover-selected-btn');
4371-            if (!btn) return;
4372-            const selected = getSelectedInColumn('COMPLETED');
4373-            if (selected.length === 0) {
4374-                vscode.postMessage({ type: 'showInfo', message: 'No cards selected. Use checkboxes to select cards to recover.' });
4375-                return;
4376-            }
4377-            postKanbanMessage({ type: 'recoverSelected', sessionIds: selected });
4378-        });
4379-
4380-        // Archive Selected handler
4381-        document.addEventListener('click', (e) => {
4382-            const btn = e.target.closest('.archive-selected-btn');
4383-            if (!btn) return;
4384-            const selected = getSelectedInColumn('COMPLETED');
4385-            if (selected.length === 0) {
4386-                vscode.postMessage({ type: 'showInfo', message: 'No cards selected. Use checkboxes to select cards to archive.' });
4387-                return;
4388-            }
4389-            postKanbanMessage({ type: 'archiveSelected', sessionIds: selected });
4390-        });
4391-
4392-        // Recover All handler
4393-        document.addEventListener('click', (e) => {
4394-            const btn = e.target.closest('.recover-all-btn');
4395-            if (!btn) return;
4396-            const allCompleted = getAllInColumn('COMPLETED');
4397-            if (allCompleted.length === 0) return;
4398-            postKanbanMessage({ type: 'recoverAll', sessionIds: allCompleted, count: allCompleted.length });
4399-        });
4400-
4401-        // Backlog toggle state
4402-        let showingBacklog = false;
4403-
4404-        // Drag & Drop handlers
4405-        let draggedSessionId = null;
4406-
4407-        function handleDragStart(e) {
4408-            const draggedCardEl =
4409-                (e.currentTarget && e.currentTarget.classList && e.currentTarget.classList.contains('kanban-card'))
4410-                    ? e.currentTarget
4411-                    : e.target.closest('.kanban-card');
4412-            const draggedId = draggedCardEl?.dataset.session || draggedCardEl?.dataset.planId;
4413-            if (!draggedCardEl || !draggedId) return;
4414-            draggedSessionId = draggedId;
4415-            draggedCardEl.classList.add('dragging');
4416-            e.dataTransfer.effectAllowed = 'move';
4417-
4418-            // Check if the dragged card is part of a multi-selection
4419-            let idsToTransfer = [draggedId];
4420-            if (selectedCards.has(draggedId) && selectedCards.size > 1) {
4421-                const selectedInRenderedContainer = getSelectedInRenderedContainer(draggedCardEl);
4422-                if (selectedInRenderedContainer.length > 1 && selectedInRenderedContainer.includes(draggedId)) {
4423-                    idsToTransfer = selectedInRenderedContainer;
4424-                }
4425-            }
4426-
4427-            // Add dragging class to all cards being transferred
4428-            idsToTransfer.forEach(id => {
4429-                const el = document.querySelector(`.kanban-card[data-session="${id}"]`);
4430-                if (el) el.classList.add('dragging');
4431-            });
4432-
4433-            e.dataTransfer.setData('application/json', JSON.stringify(idsToTransfer));
4434-            e.dataTransfer.setData('text/plain', draggedId);
4435-            e.dataTransfer.setData('application/switchboard-workspace-root', draggedCardEl.dataset.workspaceRoot || getActiveWorkspaceRoot());
4436-        }
4437-
4438-        function handleDragEnd(e) {
4439-            document.querySelectorAll('.kanban-card.dragging').forEach(el => el.classList.remove('dragging'));
4440-            document.querySelectorAll('.column-body').forEach(el => el.classList.remove('drag-over'));
4441-            draggedSessionId = null;
4442-        }
4443-
4444-        function handleDragOver(e) {
4445-            e.preventDefault();
4446-            e.dataTransfer.dropEffect = 'move';
4447-        }
4448-
4449-        function handleDragEnter(e) {
4450-            e.preventDefault();
4451-            const body = e.currentTarget;
4452-            body.classList.add('drag-over');
4453-        }
4454-
4455-        function handleDragLeave(e) {
4456-            const body = e.currentTarget;
4457-            // Only remove drag-over when actually leaving the column-body,
4458-            // not when entering a child element within it.
4459-            const related = e.relatedTarget;
4460-            if (!related || !body.contains(related)) {
4461-                body.classList.remove('drag-over');
4462-            }
4463-        }
4464-
4465-        /**
4466-         * Resolve which real coder column a card should route to when dropped onto CODED_AUTO.
4467-         * Uses complexity score vs. routingMapConfig. Falls back to CODER CODED if unknown.
4468-         */
4469-        function resolveCodedAutoTarget(card) {
4470-            if (!dynamicComplexityRoutingEnabled) return 'LEAD CODED';
4471-            const score = parseInt(card?.complexity, 10);
4472-            if (isNaN(score)) return 'CODER CODED';
4473-            const roleMap = { lead: 'LEAD CODED', coder: 'CODER CODED', intern: 'INTERN CODED' };
4474-            for (const [role, scores] of Object.entries(routingMapConfig)) {
4475-                if (Array.isArray(scores) && scores.includes(score)) {
4476-                    // Only route to INTERN CODED if the column is actually present
4477-                    const resolved = roleMap[role] || 'CODER CODED';
4478-                    if (resolved === 'INTERN CODED' && !columnDefinitions.some(d => d.id === 'INTERN CODED')) {
4479-                        return 'CODER CODED';
4480-                    }
4481-                    return resolved;
4482-                }
4483-            }
4484-            return 'CODER CODED';
4485-        }
4486-
4487-        function handleDrop(e, targetColumn) {
4488-            e.preventDefault();
4489-            e.currentTarget.classList.remove('drag-over');
4490-            const workspaceRoot = e.dataTransfer.getData('application/switchboard-workspace-root') || getActiveWorkspaceRoot();
4491-
4492-            let sessionIds = [];
4493-            try {
4494-                sessionIds = JSON.parse(e.dataTransfer.getData('application/json'));
4495-            } catch {
4496-                const plain = e.dataTransfer.getData('text/plain');
4497-                if (plain) sessionIds = [plain];
4498-            }
4499-
4500-            if (!sessionIds || sessionIds.length === 0) return;
4501-
4502-            // Handle drops onto the synthetic CODED_AUTO column — route each card to its real column
4503-            if (targetColumn === 'CODED_AUTO') {
4504-                const CODED_IDS = ['LEAD CODED', 'CODER CODED', 'INTERN CODED'];
4505-                document.querySelectorAll('.kanban-card.selected').forEach(el => el.classList.remove('selected'));
4506-                selectedCards.clear();
4507-                updateReassignButtonVisibility();
4508-                const targetBody = document.getElementById('col-CODED_AUTO');
4509-                const dispatchGroups = new Map();
4510-
4511-                sessionIds.forEach(id => {
4512-                    const card = currentCards.find(c => c.sessionId === id);
4513-                    if (!card) return;
4514-                    const resolvedTarget = resolveCodedAutoTarget(card);
4515-                    if (card.column === resolvedTarget) return;
4516-
4517-                    const prevCol = card.column;
4518-                    const srcIdx = prevCol === 'BACKLOG' ? 0 : columns.indexOf(prevCol);
4519-                    const tgtIdx = columns.indexOf(resolvedTarget);
4520-                    if (tgtIdx === srcIdx) return;
4521-
4522-                    const sourceColumnForPrompt = prevCol;
4523-                    const dropMode = columnDragDropModes['CODED_AUTO'] || 'cli';
4524-                    const dispatchType = tgtIdx < srcIdx
4525-                        ? 'backward'
4526-                        : (dropMode === 'prompt' ? 'prompt' : (!cliTriggersEnabled ? 'move' : 'cli'));
4527-                    const groupKey = dispatchType === 'prompt'
4528-                        ? `${dispatchType}::${resolvedTarget}::${sourceColumnForPrompt}`
4529-                        : `${dispatchType}::${resolvedTarget}`;
4530-                    const group = dispatchGroups.get(groupKey) || {
4531-                        dispatchType,
4532-                        targetColumn: resolvedTarget,
4533-                        sourceColumn: sourceColumnForPrompt,
4534-                        sessionIds: []
4535-                    };
4536-                    group.sessionIds.push(id);
4537-                    dispatchGroups.set(groupKey, group);
4538-
4539-                    // DOM optimistic update
4540-                    const cardEl = document.querySelector(`.kanban-card[data-session="${id}"]`);
4541-                    if (cardEl && targetBody) {
4542-                        // Source DOM column: cards in coder cols are already in CODED_AUTO dom container when collapsed
4543-                        const sourceDomCol = CODED_IDS.includes(card.column) ? 'CODED_AUTO' :
4544-                                             (card.column === 'BACKLOG' && showingBacklog ? 'CREATED' : card.column);
4545-                        const emptyState = targetBody.querySelector('.empty-state');
4546-                        if (emptyState) emptyState.remove();
4547-                        if (sourceDomCol !== 'CODED_AUTO') {
4548-                            targetBody.appendChild(cardEl);
4549-                            const sourceBody = document.getElementById('col-' + sourceDomCol);
4550-                            if (sourceBody && sourceBody.querySelectorAll('.kanban-card').length === 0) {
4551-                                sourceBody.innerHTML = '<div class="empty-state">No plans</div>';
4552-                            }
4553-                            const srcCount = document.getElementById('count-' + sourceDomCol);
4554-                            if (srcCount) srcCount.textContent = String(Math.max(0, parseInt(srcCount.textContent) - 1));
4555-                            const tgtCount = document.getElementById('count-CODED_AUTO');
4556-                            if (tgtCount) tgtCount.textContent = String(parseInt(tgtCount.textContent) + 1);
4557-                        }
4558-                        cardEl.classList.remove('card-dropped');
4559-                        void cardEl.offsetWidth;
4560-                        cardEl.classList.add('card-dropped');
4561-                        cardEl.addEventListener('animationend', () => cardEl.classList.remove('card-dropped'), { once: true });
4562-                    }
4563-
4564-                    card.column = resolvedTarget;
4565-                });
4566-
4567-                if (dispatchGroups.size === 0) return;
4568-
4569-                setTimeout(() => {
4570-                    dispatchGroups.forEach(group => {
4571-                        const groupedIds = group.sessionIds;
4572-                        if (groupedIds.length === 0) return;
4573-
4574-                        if (group.dispatchType === 'backward') {
4575-                            postKanbanMessage({ type: 'moveCardBackwards', sessionIds: groupedIds, targetColumn: group.targetColumn, workspaceRoot });
4576-                            return;
4577-                        }
4578-
4579-                        if (group.dispatchType === 'move') {
4580-                            postKanbanMessage({ type: 'moveCardForward', sessionIds: groupedIds, targetColumn: group.targetColumn, workspaceRoot });
4581-                            return;
4582-                        }
4583-
4584-                        if (group.dispatchType === 'prompt') {
4585-                            postKanbanMessage({
4586-                                type: 'promptOnDrop',
4587-                                sessionIds: groupedIds,
4588-                                sourceColumn: group.sourceColumn,
4589-                                targetColumn: group.targetColumn,
4590-                                workspaceRoot
4591-                            });
4592-                            return;
4593-                        }
4594-
4595-                        if (!isColumnAgentAvailable(group.targetColumn)) return;
4596-                        if (groupedIds.length === 1) {
4597-                            postKanbanMessage({ type: 'triggerAction', sessionId: groupedIds[0], targetColumn: group.targetColumn, workspaceRoot });
4598-                        } else {
4599-                            postKanbanMessage({ type: 'triggerBatchAction', sessionIds: groupedIds, targetColumn: group.targetColumn, workspaceRoot });
4600-                        }
4601-                    });
4602-                }, 350);
4603-                return;
4604-            }
4605-
4606-            const forwardIds = [];
4607-            const backwardIds = [];
4608-
4609-            // When backlog view is active, dropping to the CREATED slot means BACKLOG
4610-            const effectiveTargetColumn = (showingBacklog && targetColumn === 'CREATED') ? 'BACKLOG' : targetColumn;
4611-
4612-            sessionIds.forEach(id => {
4613-                const card = currentCards.find(c => c.sessionId === id);
4614-                if (!card || card.column === effectiveTargetColumn) return;
4615-
4616-                // BACKLOG cards are treated as index 0 (same as CREATED) for forward/backward calculation
4617-                const sourceIndex = card.column === 'BACKLOG' ? 0 : columns.indexOf(card.column);
4618-                const targetIndex = columns.indexOf(effectiveTargetColumn);
4619-
4620-                if (targetIndex < sourceIndex) {
4621-                    backwardIds.push(id);
4622-                } else {
4623-                    forwardIds.push(id);
4624-                }
4625-            });
4626-
4627-            // Special handling: forward drops INTO COMPLETED trigger archive, not dispatch
4628-            if (effectiveTargetColumn === 'COMPLETED' && forwardIds.length > 0) {
4629-                const completingIds = forwardIds.slice();
4630-                // Optimistic DOM move: relocate cards to COMPLETED column with animation
4631-                const targetBody = document.getElementById('col-' + targetColumn);
4632-                completingIds.forEach(id => {
4633-                    const card = currentCards.find(c => c.sessionId === id);
4634-                    const cardEl = document.querySelector(`.kanban-card[data-session="${id}"]`);
4635-                    if (cardEl && targetBody) {
4636-                        const emptyState = targetBody.querySelector('.empty-state');
4637-                        if (emptyState) emptyState.remove();
4638-                        cardEl.classList.add('card-completing');
4639-                        targetBody.appendChild(cardEl);
4640-                        // Update source column empty state
4641-                        if (card) {
4642-                            // Source DOM column: BACKLOG cards display in CREATED slot when showingBacklog
4643-                            const srcDomCol = (card.column === 'BACKLOG' && showingBacklog) ? 'CREATED' : card.column;
4644-                            const sourceBody = document.getElementById('col-' + srcDomCol);
4645-                            if (sourceBody && sourceBody.querySelectorAll('.kanban-card').length === 0) {
4646-                                sourceBody.innerHTML = '<div class="empty-state">No plans</div>';
4647-                            }
4648-                            const srcCount = document.getElementById('count-' + srcDomCol);
4649-                            if (srcCount) srcCount.textContent = String(Math.max(0, parseInt(srcCount.textContent) - 1));
4650-                            card.column = effectiveTargetColumn;
4651-                        }
4652-                        const tgtCount = document.getElementById('count-' + targetColumn);
4653-                        if (tgtCount) tgtCount.textContent = String(parseInt(tgtCount.textContent) + 1);
4654-                    }
4655-                    postKanbanMessage({ type: 'completePlan', sessionId: id, workspaceRoot: card?.workspaceRoot || workspaceRoot });
4656-                });
4657-                forwardIds.length = 0;
4658-            }
4659-
4660-            // Special handling: backward drags FROM COMPLETED trigger uncomplete/restore
4661-            const uncompleteIds = backwardIds.filter(id => {
4662-                const card = currentCards.find(c => c.sessionId === id);
4663-                return card && card.column === 'COMPLETED';
4664-            });
4665-            if (uncompleteIds.length > 0) {
4666-                postKanbanMessage({ type: 'uncompleteCard', sessionIds: uncompleteIds, targetColumn: effectiveTargetColumn, workspaceRoot });
4667-                uncompleteIds.forEach(id => {
4668-                    const idx = backwardIds.indexOf(id);
4669-                    if (idx >= 0) backwardIds.splice(idx, 1);
4670-                });
4671-            }
4672-
4673-            // Determine the effective drop mode for this column
4674-            const dropMode = columnDragDropModes[effectiveTargetColumn] || 'cli';
4675-
4676-            if (forwardIds.length > 0) {
4677-                // Agent availability check only applies in CLI mode — prompt mode doesn't need a CLI agent
4678-                if (dropMode === 'cli' && cliTriggersEnabled && !isColumnAgentAvailable(effectiveTargetColumn)) {
4679-                    // Strip forward moves if agent isn't ready/assigned, but allow backward moves to proceed
4680-                    forwardIds.length = 0;
4681-                    const agentEl = document.getElementById('agent-' + effectiveTargetColumn);
4682-                    if (agentEl) {
4683-                        agentEl.style.transition = 'color 0.15s';
4684-                        agentEl.style.color = 'var(--vscode-errorForeground, #f44747)';
4685-                        setTimeout(() => {
4686-                            agentEl.style.color = 'var(--vscode-editorWarning-foreground, #cca700)';
4687-                        }, 800);
4688-                    }
4689-                }
4690-            }
4691-
4692-            const validIds = [...forwardIds, ...backwardIds];
4693-            if (validIds.length === 0) return;
4694-
4695-            // Capture source columns BEFORE the optimistic update loop mutates card.column
4696-            const sourceColumnForPrompt = forwardIds.length > 0
4697-                ? (currentCards.find(c => c.sessionId === forwardIds[0])?.column || effectiveTargetColumn)
4698-                : effectiveTargetColumn;
4699-
4700-            // DOM target is the displayed column slot (targetColumn); logical target may differ (effectiveTargetColumn)
4701-            const targetBody = document.getElementById('col-' + targetColumn);
4702-
4703-            validIds.forEach(id => {
4704-                const card = currentCards.find(c => c.sessionId === id);
4705-                const cardEl = document.querySelector(`.kanban-card[data-session="${id}"]`);
4706-                // Source DOM column: BACKLOG cards display in CREATED slot when showingBacklog
4707-                const sourceDomColumn = (card && card.column === 'BACKLOG' && showingBacklog) ? 'CREATED' : (card?.column || targetColumn);
4708-                if (cardEl && targetBody) {
4709-                    // Remove empty-state placeholder if present
4710-                    const emptyState = targetBody.querySelector('.empty-state');
4711-                    if (emptyState) emptyState.remove();
4712-                    targetBody.appendChild(cardEl);
4713-
4714-                    // Update source column: show empty-state if now empty
4715-                    const sourceBody = document.getElementById('col-' + sourceDomColumn);
4716-                    if (sourceBody && sourceBody.querySelectorAll('.kanban-card').length === 0) {
4717-                        sourceBody.innerHTML = '<div class="empty-state">No plans</div>';
4718-                    }
4719-
4720-                    // Update counts
4721-                    const srcCount = document.getElementById('count-' + sourceDomColumn);
4722-                    const tgtCount = document.getElementById('count-' + targetColumn);
4723-                    if (srcCount) srcCount.textContent = String(Math.max(0, parseInt(srcCount.textContent) - 1));
4724-                    if (tgtCount) tgtCount.textContent = String(parseInt(tgtCount.textContent) + 1);
4725-
4726-                    // Update in-memory state (use effective column so backend is consistent)
4727-                    card.column = effectiveTargetColumn;
4728-
4729-                    // Trigger drop animation
4730-                    cardEl.classList.remove('card-dropped'); 
4731-                    void cardEl.offsetWidth; // Trigger reflow to restart animation
4732-                    cardEl.classList.add('card-dropped');
4733-                    cardEl.addEventListener('animationend', () => {
4734-                        cardEl.classList.remove('card-dropped');
4735-                    }, { once: true });
4736-                }
4737-            });
4738-
4739-
4740-
4741-            if (validIds.length > 0) {
4742-                document.querySelectorAll('.kanban-card.selected').forEach(el => el.classList.remove('selected'));
4743-                selectedCards.clear();
4744-                updateReassignButtonVisibility();
4745-                setTimeout(() => {
4746-                    if (forwardIds.length > 0) {
4747-                        if (dropMode === 'prompt') {
4748-                            // Prompt mode: copy prompt to clipboard + visual advance (no CLI dispatch needed)
4749-                            postKanbanMessage({ type: 'promptOnDrop', sessionIds: forwardIds, sourceColumn: sourceColumnForPrompt, targetColumn: effectiveTargetColumn, workspaceRoot });
4750-                        } else if (cliTriggersEnabled) {
4751-                            // CLI mode: dispatch to CLI agent (existing behaviour)
4752-                            if (forwardIds.length === 1) {
4753-                                postKanbanMessage({ type: 'triggerAction', sessionId: forwardIds[0], targetColumn: effectiveTargetColumn, workspaceRoot });
4754-                            } else {
4755-                                postKanbanMessage({ type: 'triggerBatchAction', sessionIds: forwardIds, targetColumn: effectiveTargetColumn, workspaceRoot });
4756-                            }
4757-                        } else {
4758-                            // No CLI triggers and not prompt mode — just move the card forward
4759-                            postKanbanMessage({ type: 'moveCardForward', sessionIds: forwardIds, targetColumn: effectiveTargetColumn, workspaceRoot });
4760-                        }
4761-                    }
4762-
4763-
4764-
4765-                    if (backwardIds.length > 0) {
4766-                        postKanbanMessage({ type: 'moveCardBackwards', sessionIds: backwardIds, targetColumn: effectiveTargetColumn, workspaceRoot });
4767-                    }
4768-                }, 350);
4769-            }
4770-        }
4771-
4772-        // Listen for messages from the extension
4773-        window.addEventListener('message', (event) => {
4774-            const msg = event.data;
4775-            switch (msg.type) {
4776-                case 'updateWorkspaceSelection': {
4777-                    const previousRoot = currentWorkspaceRoot;
4778-                    currentWorkspaceRoot = msg.workspaceRoot || '';
4779-                    activeWorkspaceFilter = msg.activeFilter || null;
4780-                    workspaceItems = Array.isArray(msg.workspaces) ? msg.workspaces : [];
4781-                    currentControlPlaneMode = msg.controlPlaneMode || msg.mode || 'none';
4782-                    currentControlPlaneRoot = msg.controlPlaneRoot || msg.effectiveControlPlaneRoot || '';
4783-                    
4784-                    // On cold start previousRoot is '', so explicitChange is false — safe because
4785-                    // there's no savedSelection to conflict with; the fallback path handles it.
4786-                    const explicitChange = previousRoot !== '' && previousRoot !== currentWorkspaceRoot;
4787-                    updateWorkspaceSelector(explicitChange ? currentWorkspaceRoot : null);
4788-                    updateWorkspaceFilterBadge();
4789-
4790-                    if (msg.projects !== undefined) {
4791-                        updateProjectDropdown(msg.projects, msg.projectFilter || null);
4792-                    }
4793-                    const projectFilterBadge = document.getElementById('project-filter-badge');
4794-                    if (projectFilterBadge) {
4795-                        if (msg.projectFilter) {
4796-                            projectFilterBadge.textContent = 'PROJECT: ' + msg.projectFilter;
4797-                            projectFilterBadge.hidden = false;
4798-                        } else {
4799-                            projectFilterBadge.hidden = true;
4800-                        }
4801-                    }
4802-                    break;
4803-                }
4804-                case 'moveCards': {
4805-                    const idsToMove = new Set(Array.isArray(msg.sessionIds) ? msg.sessionIds : []);
4806-                    const targetCol = msg.targetColumn;
4807-                    if (!idsToMove.size || !targetCol) break;
4808-                    let changed = false;
4809-                    currentCards = currentCards.map(card => {
4810-                        if (idsToMove.has(card.sessionId)) {
4811-                            changed = true;
4812-                            return { ...card, column: targetCol };
4813-                        }
4814-                        return card;
4815-                    });
4816-                    if (changed) {
4817-                        lastBoardSignature = buildBoardSignature(currentCards);
4818-                        renderBoard(currentCards);
4819-                    }
4820-                    break;
4821-                }
4822-                case 'updateBoard':
4823-                    const nextCards = Array.isArray(msg.cards) ? msg.cards : [];
4824-                    console.log('[Kanban WV] updateBoard received', nextCards.length, 'cards');
4825-                    const nextBoardSignature = buildBoardSignature(nextCards);
4826-                    const dbWarningBanner = document.getElementById('db-warning-banner');
4827-                    if (dbWarningBanner) {
4828-                        dbWarningBanner.style.display = msg.dbUnavailable ? '' : 'none';
4829-                    }
4830-                    if (typeof msg.showingBacklog !== 'undefined') {
4831-                        showingBacklog = msg.showingBacklog;
4832-                    }
4833-                    if (msg.routingConfig) {
4834-                        routingMapConfig = msg.routingConfig;
4835-                        updateRoutingMapButtonIndicator();
4836-                    }
4837-                    if (nextBoardSignature !== lastBoardSignature) {
4838-                        lastBoardSignature = nextBoardSignature;
4839-                        console.log('[Kanban WV] signature changed, calling renderBoard with', nextCards.length, 'cards');
4840-                        renderBoard(nextCards);
4841-                    } else {
4842-                        currentCards = nextCards;
4843-                    }
4844-                    break;
4845-                case 'settingResult': {
4846-                    const { key, value } = msg;
4847-                    if (key === 'selectedRole') {
4848-                        if (value) {
4849-                            currentRole = value;
4850-                            const roleSelect = document.getElementById('roleSelect');
4851-                            if (roleSelect) roleSelect.value = value;
4852-                        }
4853-                        handleRoleChange();
4854-                        updateRoleDescription();
4855-                    } else if (key.startsWith('roleConfig_')) {
4856-                        const role = key.replace('roleConfig_', '');
4857-                        roleConfigs[role] = value || JSON.parse(JSON.stringify(DEFAULT_CONFIG[role]));
4858-                        if (role === currentRole) {
4859-                            handleRoleChange();
4860-                        }
4861-                    break;
4862-                }
4863-                case 'antigravityPrompt': {
4864-                    const copyPromptBtn = document.getElementById('antigravity-copy-prompt-btn');
4865-                    if (copyPromptBtn && msg.prompt) {
4866-                        navigator.clipboard.writeText(msg.prompt).then(() => {
4867-                            copyPromptBtn.textContent = 'COPIED!';
4868-                            setTimeout(() => {
4869-                                copyPromptBtn.textContent = 'COPY PROMPT';
4870-                                copyPromptBtn.disabled = false;
4871-                            }, 2000);
4872-                        }).catch(err => {
4873-                            console.error('Failed to copy prompt:', err);
4874-                            copyPromptBtn.textContent = 'ERROR';
4875-                            setTimeout(() => {
4876-                                copyPromptBtn.textContent = 'COPY PROMPT';
4877-                                copyPromptBtn.disabled = false;
4878-                            }, 2000);
4879-                        });
4880-                    } else if (copyPromptBtn) {
4881-                        copyPromptBtn.textContent = msg.error ? 'NO PLANS' : 'ERROR';
4882-                        setTimeout(() => {
4883-                            copyPromptBtn.textContent = 'COPY PROMPT';
4884-                            copyPromptBtn.disabled = false;
4885-                        }, 2000);
4886-                    }
4887-                    break;
4888-                }
4889-                case 'promptPreviewResult': {
4890-                    const { role, preview, planCount } = msg;
4891-                    if (role !== currentRole) break;
4892-                    const previewEl = document.getElementById('promptPreview');
4893-                    if (previewEl) previewEl.value = preview || '(No prompt content)';
4894-                    
4895-                    const indicator = document.getElementById('previewPlanIndicator');
4896-                    if (indicator) {
4897-                        if (planCount > 0) {
4898-                            indicator.textContent = `(with ${planCount} plan${planCount !== 1 ? 's' : ''})`;
4899-                            indicator.style.color = 'var(--accent-teal)';
4900-                        } else {
4901-                            indicator.textContent = '(template only)';
4902-                            indicator.style.color = 'var(--text-secondary)';
4903-                        }
4904-                    }
4905-                    break;
4906-                }
4907-                case 'fileExistsResult': {
4908-                    const statusEl = document.getElementById('prompts-tab-workflow-path-status');
4909-                    if (statusEl) {
4910-                        statusEl.textContent = msg.exists ? '✓ File exists' : '✗ File not found';
4911-                        statusEl.style.color = msg.exists ? 'var(--accent-teal)' : 'var(--accent-red)';
4912-                    }
4913-                    break;
4914-                }
4915-                case 'backlogViewState':
4916-                    showingBacklog = event.data.showing;
4917-                    renderColumns();
4918-                    renderBoard(currentCards);
4919-                    break;
4920-                case 'updateColumns':
4921-                    if (Array.isArray(msg.columns) && msg.columns.length > 0) {
4922-                        columnDefinitions = msg.columns;
4923-                        columns = columnDefinitions.map(col => col.id);
4924-                        autobanColumns = columnDefinitions.filter(col => col.autobanEnabled).map(col => col.id);
4925-                        lastBoardSignature = '';
4926-                        renderColumns();
4927-                        renderBoard(currentCards);
4928-                        updateAllColumnAgents();
4929-                        updateAutobanIndicators();
4930-                        renderAutobanPanel();
4931-                    }
4932-                    break;
4933-                case 'dependencyMapData':
4934-                    renderDependencyTree(msg.plans);
4935-                    if (msg.prompt) {
4936-                        const btnCopyDepsPrompt = document.getElementById('btn-copy-deps-prompt');
4937-                        if (btnCopyDepsPrompt) {
4938-                            navigator.clipboard.writeText(msg.prompt).then(() => {
4939-                                btnCopyDepsPrompt.textContent = 'COPIED!';
4940-                                setTimeout(() => { btnCopyDepsPrompt.textContent = 'COPY PROMPT'; }, 2000);
4941-                            }).catch(err => {
4942-                                console.error('[kanban webview] failed to copy prompt:', err);
4943-                                btnCopyDepsPrompt.textContent = 'COPY FAILED';
4944-                                setTimeout(() => { btnCopyDepsPrompt.textContent = 'COPY PROMPT'; }, 2000);
4945-                            });
4946-                            btnCopyDepsPrompt.disabled = false;
4947-                        }
4948-                    }
4949-                    break;
4950-                case 'uatData':
4951-                    renderUATChecklist(msg.plans);
4952-                    break;
4953-                case 'actionTriggered':
4954-                    if (msg.role === 'analystMap') {
4955-                        const btnRebuild = document.getElementById('btn-rebuild-deps');
4956-                        if (btnRebuild) {
4957-                            btnRebuild.disabled = false;
4958-                            btnRebuild.textContent = 'REBUILD MAP';
4959-                            if (msg.success === false) {
4960-                                btnRebuild.textContent = 'REBUILD FAILED';
4961-                                setTimeout(() => { btnRebuild.textContent = 'REBUILD MAP'; }, 3000);
4962-                            }
4963-                        }
4964-                    }
4965-                    break;
4966-                case 'updateAgentNames':
4967-                    lastAgentNames = msg.agentNames || {};
4968-                    updateAllColumnAgents();
4969-                    break;
4970-                case 'cliTriggersState':
4971-                    cliTriggersEnabled = msg.enabled !== false;
4972-                    updateCliToggleUi();
4973-                    break;
4974-                case 'dynamicComplexityRoutingState':
4975-                    dynamicComplexityRoutingEnabled = msg.enabled !== false;
4976-                    updateComplexityRoutingToggleUi();
4977-                    break;
4978-                case 'allowUnknownComplexityAutoMoveState':
4979-                    allowUnknownComplexityAutoMove = msg.enabled !== false;
4980-                    updateUnknownComplexityToggleUi();
4981-                    break;
4982-                case 'clearTerminalBeforePromptState':
4983-                    clearTerminalBeforePrompt = msg.enabled !== false;
4984-                    if (msg.delay !== undefined) {
4985-                        clearTerminalBeforePromptDelay = msg.delay;
4986-                    }
4987-                    updateClearTerminalBeforePromptUi();
4988-                    break;
4989-
4990-                case 'clearTerminalBeforePromptDelayState':
4991-                    if (msg.delay !== undefined) {
4992-                        clearTerminalBeforePromptDelay = msg.delay;
4993-                        const delayInput = document.getElementById('clear-terminal-delay-input');
4994-                        if (delayInput) delayInput.value = String(msg.delay);
4995-                    }
4996-                    break;
4997-                case 'liveSyncUpdate': {
4998-                    window.liveSyncStates = window.liveSyncStates || {};
4999-                    const prev = window.liveSyncStates[msg.sessionId];
5000-                    // Sticky-error barrier: do not let a late-resolving orphaned
5001-                    // sync silently downgrade an 'error' status to 'active'. An
5002-                    // 'error' → 'syncing' transition is allowed (explicit retry).
5003-                    const isSilentErrorDowngrade =
5004-                        prev && prev.status === 'error' &&
5005-                        msg.status === 'active' &&
5006-                        !msg.clearError;
5007-                    if (isSilentErrorDowngrade) {
5008-                        break;
5009-                    }
5010-                    window.liveSyncStates[msg.sessionId] = {
5011-                        status: msg.status,
5012-                        lastSyncAt: msg.lastSyncAt,
5013-                        reason: msg.reason
5014-                    };
5015-
5016-                    // If status is 'synced', set a 3s timer to flip to 'watching' in the
5017-                    // data store (used by autoban/status-bar). No card-level re-render needed
5018-                    // since live sync indicators have been removed from cards.
5019-                    if (msg.status === 'synced') {
5020-                        setTimeout(() => {
5021-                            const state = window.liveSyncStates?.[msg.sessionId];
5022-                            if (state && state.status === 'synced') {
5023-                                window.liveSyncStates[msg.sessionId] = {
5024-                                    ...state,
5025-                                    status: 'watching'
5026-                                };
5027-                            }
5028-                        }, 3000);
5029-                    }
5030-
5031-                    // No card-level re-render needed — live sync indicators have been
5032-                    // removed from cards. The data store update above is sufficient for
5033-                    // autoban/status-bar consumers.
5034-                    break;
5035-                }
5036-                case 'liveSyncStates': {
5037-                    // Bulk update on board refresh
5038-                    window.liveSyncStates = {};
5039-                    for (const state of msg.states) {
5040-                        window.liveSyncStates[state.sessionId] = state;
5041-                    }
5042-                    renderBoard(currentCards);  // Full re-render to reflect board state
5043-                    break;
5044-                }
5045-                case 'clickupState': {
5046-                    integrationState.clickup = {
5047-                        setupComplete: msg.setupComplete === true,
5048-                        realTimeSyncEnabled: msg.realTimeSyncEnabled === true,
5049-                        autoPullEnabled: msg.autoPullEnabled === true,
5050-                        pullIntervalMinutes: Number(msg.pullIntervalMinutes || 60),
5051-                        syncError: msg.syncError === true,
5052-                        mappingWarning: String(msg.mappingWarning || ''),
5053-                        unmappedColumnCount: Number(msg.unmappedColumnCount || 0)
5054-                    };
5055-                    break;
5056-                }
5057-                case 'linearState': {
5058-                    integrationState.linear = {
5059-                        setupComplete: msg.setupComplete === true,
5060-                        realTimeSyncEnabled: msg.realTimeSyncEnabled === true,
5061-                        autoPullEnabled: msg.autoPullEnabled === true,
5062-                        pullIntervalMinutes: Number(msg.pullIntervalMinutes || 60),
5063-                        syncError: msg.syncError === true
5064-                    };
5065-                    break;
5066-                }
5067-                case 'visibleAgents':
5068-                    if (msg.agents) {
5069-                        lastVisibleAgents = { ...lastVisibleAgents, ...msg.agents };
5070-                        updateAllColumnAgents();
5071-                        updateJulesButtonVisibility();
5072-                    }
5073-                    break;
5074-                case 'copyPlanLinkResult': {
5075-                    let btn = null;
5076-                    if (msg.planId) {
5077-                        btn = document.querySelector(`.card-btn.copy[data-plan-id="${msg.planId}"]`);
5078-                    }
5079-                    if (!btn && msg.sessionId) {
5080-                        btn = document.querySelector(`.card-btn.copy[data-session="${msg.sessionId}"]`);
5081-                    }
5082-                    if (btn) {
5083-                        if (msg.success) {
5084-                            btn.textContent = 'Copied!';
5085-                            btn.classList.add('copied');
5086-                            btn.disabled = true;
5087-
5088-                            let fallbackTimer = null;
5089-                            const resetBtn = () => {
5090-                                btn.textContent = btn.dataset.copyLabel || 'Copy Prompt';
5091-                                btn.classList.remove('copied');
5092-                                btn.disabled = false;
5093-                                btn.removeEventListener('animationend', onAnimationEnd);
5094-                                if (fallbackTimer) { clearTimeout(fallbackTimer); fallbackTimer = null; }
5095-                            };
5096-                            const onAnimationEnd = () => {
5097-                                fallbackTimer = null;
5098-                                resetBtn();
5099-                            };
5100-                            btn.addEventListener('animationend', onAnimationEnd);
5101-                            // Fallback: if animationend never fires (prefers-reduced-motion,
5102-                            // or animation already completed before listener was attached),
5103-                            // reset the button after 2s to prevent it getting stuck disabled.
5104-                            fallbackTimer = setTimeout(resetBtn, 2000);
5105-                        } else {
5106-                            btn.textContent = btn.dataset.copyLabel || 'Copy Prompt';
5107-                            btn.classList.remove('copied');
5108-                            btn.disabled = false;
5109-                        }
5110-                    }
5111-                    break;
5112-                }
5113-                case 'updateAutobanConfig':
5114-                    autobanConfig = msg.state || null;
5115-                    updateAutobanIndicators(true);
5116-                    syncAutobanCountdownTimer();
5117-                    updateAutobanButtonState();
5118-                    renderAutobanPanel();
5119-                    break;
5120-                case 'updatePairProgrammingMode': {
5121-                    const ppSelect = document.getElementById('pairProgrammingModeSelect');
5122-                    if (ppSelect) {
5123-                        ppSelect.value = msg.mode || 'off';
5124-                        ppSelect.classList.toggle('is-off', ppSelect.value === 'off');
5125-                    }
5126-                    break;
5127-                }
5128-                case 'updateColumnDragDropModes':
5129-                    if (msg.modes && typeof msg.modes === 'object') {
5130-                        for (const [key, value] of Object.entries(msg.modes)) {
5131-                            columnDragDropModes[key] = value;
5132-                        }
5133-                        // Update toggle icons to reflect received modes
5134-                        document.querySelectorAll('.mode-toggle').forEach(toggle => {
5135-                            const colId = toggle.dataset.column;
5136-                            const mode = columnDragDropModes[colId] || 'cli';
5137-                            toggle.classList.toggle('mode-cli', mode === 'cli');
5138-                            toggle.classList.toggle('mode-prompt', mode === 'prompt');
5139-                            const img = toggle.querySelector('img');
5140-                            if (img) {
5141-                                img.src = mode === 'prompt' ? ICON_PROMPT : ICON_CLI;
5142-                                img.alt = mode;
5143-                            }
5144-                            toggle.title = mode === 'prompt'
5145-                                ? 'Mode: Copy Prompt (drag cards to copy prompt to clipboard)'
5146-                                : 'Mode: CLI Dispatch (drag cards to trigger CLI agent)';
5147-                        });
5148-                    }
5149-                    break;
5150-                case 'promptOnDropResult': {
5151-                    // Visual feedback when prompt-mode drop completes: flash the target column count badge green
5152-                    if (msg.success && Array.isArray(msg.sessionIds) && msg.sessionIds.length > 0) {
5153-                        const card = currentCards.find(c => msg.sessionIds.includes(c.sessionId));
5154-                        if (card) {
5155-                            const countEl = document.getElementById('count-' + card.column);
5156-                            if (countEl) {
5157-                                const origText = countEl.textContent;
5158-                                const origBg = countEl.style.background;
5159-                                const origColor = countEl.style.color;
5160-                                countEl.textContent = '✓';
5161-                                countEl.style.background = 'var(--vscode-testing-iconPassed, #73c991)';
5162-                                countEl.style.color = 'var(--vscode-editor-background, #1e1e1e)';
5163-                                setTimeout(() => {
5164-                                    countEl.textContent = origText;
5165-                                    countEl.style.background = origBg;
5166-                                    countEl.style.color = origColor;
5167-                                }, 1200);
5168-                            }
5169-                        }
5170-                    }
5171-                    break;
5172-                }
5173-                // Research modal handlers (notionFetchState, notionSearchResults,
5174-                // plannerPromptState, localFolderFetchState, linearFetchState, clickUpFetchState)
5175-                // were removed when the Research modal was deprecated in favour of the
5176-                // dedicated Planning Panel (`switchboard.openPlanningPanel` command).
5177-                // The backend still emits these messages for other flows, but no UI in
5178-                // this webview targets them anymore; the new PlanningPanelProvider owns
5179-                // those interactions.
5180-                case 'startupCommands': {
5181-                  const cmds = msg.commands || {}, vis = msg.visibleAgents || {};
5182-                  document.querySelectorAll('#agents-tab-content input[type="text"][data-role]').forEach(i => {
5183-                    if (i.dataset.role) i.value = cmds[i.dataset.role] || '';
5184-                  });
5185-                  document.querySelectorAll('#agents-tab-content .agents-tab-visible-toggle').forEach(cb => {
5186-                    if (cb.dataset.role) cb.checked = vis[cb.dataset.role] !== false;
5187-                  });
5188-                  const julesSyncCb = document.getElementById('agents-tab-jules-auto-sync');
5189-                  if (julesSyncCb) julesSyncCb.checked = !!msg.julesAutoSyncEnabled;
5190-                  // Sync lastVisibleAgents and column/Jules visibility.
5191-                  // Unlike the visibleAgents handler (which receives defaults-merged data
5192-                  // and uses a truthiness guard), startupCommands sends raw state.visibleAgents
5193-                  // which may be {}, so we guard on key count to avoid a no-op merge.
5194-                  if (Object.keys(vis).length > 0) {
5195-                    lastVisibleAgents = { ...lastVisibleAgents, ...vis };
5196-                    updateAllColumnAgents();
5197-                    updateJulesButtonVisibility();
5198-                  }
5199-                  break;
5200-                }
5201-                case 'customAgents': {
5202-                  agentsTabCustomAgents = msg.customAgents || [];
5203-                  lastCustomAgents = agentsTabCustomAgents;
5204-                  agentsTabRenderCustomAgentList();
5205-                  updateCustomAgentsDropdown();
5206-                  break;
5207-                }
5208-                case 'julesAutoSyncSetting': {
5209-                  const el = document.getElementById('agents-tab-jules-auto-sync');
5210-                  if (el) el.checked = msg.enabled === true;
5211-                  break;
5212-                }
5213-                case 'saveCustomAgentResult': {
5214-                  if (msg.success) {
5215-                    postKanbanMessage({ type: 'getCustomAgents' });
5216-                  } else {
5217-                    document.getElementById('agents-tab-custom-agent-error').textContent = msg.error || 'Failed to save custom agent';
5218-                  }
5219-                  break;
5220-                }
5221-                case 'deleteCustomAgentResult': {
5222-                  if (msg.success) {
5223-                    document.getElementById('agents-tab-custom-agent-delete-error').textContent = '';
5224-                    postKanbanMessage({ type: 'getCustomAgents' });
5225-                  } else {
5226-                    document.getElementById('agents-tab-custom-agent-delete-error').textContent = msg.error || 'Failed to delete custom agent';
5227-                  }
5228-                  break;
5229-                }
5230-                case 'kanbanStructure': {
5231-                    lastKanbanStructure = msg.structure || [];
5232-                    lastCustomKanbanColumns = msg.customColumns || [];
5233-                    renderKanbanStructureList();
5234-                    break;
5235-                }
5236-            }
5237-        });
5238-
5239-        /** Format seconds as MM:SS */
5240-        function formatCountdown(secs) {
5241-            const m = Math.floor(secs / 60);
5242-            const s = secs % 60;
5243-            return String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0');
5244-        }
5245-
5246-        /** Update autoban timer badges inline in the controls strip. */
5247-        /** Update autoban timer badges inline in the controls strip. */
5248-        function updateAutobanIndicators(forceRebuild) {
5249-            const container = document.getElementById('autoban-timers-inline');
5250-            if (!container) { updateAutobanButtonState(); return; }
5251-
5252-            if (!autobanConfig || !autobanConfig.enabled) {
5253-                if (container.innerHTML !== '') { container.innerHTML = ''; }
5254-                updateAutobanButtonState();
5255-                return;
5256-            }
5257-
5258-            // Compute desired state for each badge
5259-            const badgeData = autobanColumns.map(col => {
5260-                const abbrev = COLUMN_ABBREV[col] || col.charAt(0);
5261-                const rule = autobanConfig.rules && autobanConfig.rules[col];
5262-                if (rule && rule.enabled) {
5263-                    const lastTickAt = Number(autobanConfig.lastTickAt && autobanConfig.lastTickAt[col]) || Date.now();
5264-                    const intervalMs = Math.max(1, Number(rule.intervalMinutes) || 1) * 60 * 1000;
5265-                    const nextTickAt = lastTickAt + intervalMs;
5266-                    const remainingSec = Math.max(0, Math.ceil((nextTickAt - Date.now()) / 1000));
5267-                    const text = remainingSec > 0 ? `${abbrev}: ${formatCountdown(remainingSec)}` : `${abbrev}: GO`;
5268-                    return { text, active: true };
5269-                } else {
5270-                    return { text: `${abbrev}: off`, active: false };
5271-                }
5272-            });
5273-
5274-            const existingBadges = container.children;
5275-
5276-            // Full rebuild when structure changes or forced (config update)
5277-            if (forceRebuild || existingBadges.length !== badgeData.length) {
5278-                container.innerHTML = badgeData.map(b =>
5279-                    `<span class="autoban-timer-badge${b.active ? ' is-active' : ''}">${b.text}</span>`
5280-                ).join('');
5281-                updateAutobanButtonState();
5282-                return;
5283-            }
5284-
5285-            // Targeted update: only touch badges whose content or state changed
5286-            for (let i = 0; i < badgeData.length; i++) {
5287-                const el = existingBadges[i];
5288-                const data = badgeData[i];
5289-                if (el.textContent !== data.text) {
5290-                    el.textContent = data.text;
5291-                }
5292-                const hasActive = el.classList.contains('is-active');
5293-                if (data.active !== hasActive) {
5294-                    el.classList.toggle('is-active', data.active);
5295-                }
5296-            }
5297-            updateAutobanButtonState();
5298-        }
5299-
5300-        function updateReassignButtonVisibility() {
5301-            const btn = document.getElementById('btn-reassign-workspace');
5302-            if (btn) {
5303-                const count = selectedCards.size;
5304-                if (count > 0) {
5305-                    btn.disabled = false;
5306-                    btn.textContent = `ASSIGN TO WORKSPACE (${count})`;
5307-                } else {
5308-                    btn.disabled = true;
5309-                    btn.textContent = 'ASSIGN TO WORKSPACE';
5310-                }
5311-            }
5312-
5313-            const btnAssign = document.getElementById('btn-assign-project');
5314-            if (btnAssign) {
5315-                btnAssign.disabled = selectedCards.size === 0;
5316-            }
5317-        }
5318-
5319-        document.getElementById('btn-reassign-workspace')?.addEventListener('click', () => {
5320-            const sessionIds = Array.from(selectedCards);
5321-            
5322-            const select = document.getElementById('workspace-select');
5323-            const targetWorkspaceRoot = select ? select.value : '';
5324-
5325-            if (sessionIds.length === 0 || !targetWorkspaceRoot) {
5326-                return;
5327-            }
5328-
5329-            // Confirm before reassigning — plans will disappear from the current view
5330-            const targetLabel = select.selectedOptions?.[0]?.textContent || targetWorkspaceRoot;
5331-            if (!confirm(`Reassign ${sessionIds.length} plan${sessionIds.length === 1 ? '' : 's'} to workspace "${targetLabel}"?\n\nThese plans will disappear from the current board and appear under the target workspace.`)) {
5332-                return;
5333-            }
5334-
5335-            postKanbanMessage({
5336-                type: 'reassignPlansWorkspace',
5337-                sessionIds: sessionIds,
5338-                targetWorkspaceRoot: targetWorkspaceRoot
5339-            });
5340-
5341-            // Optimistically clear the selection
5342-            selectedCards.clear();
5343-            updateReassignButtonVisibility();
5344-            
5345-            // Un-select visually on screen
5346-            document.querySelectorAll('.kanban-card.selected').forEach(el => {
5347-                el.classList.remove('selected');
5348-            });
5349-        });
5350-
5351-        document.getElementById('workspace-select')?.addEventListener('change', (event) => {
5352-            const selectedWorkspaceRoot = event.target.value || '';
5353-            const selectedOption = event.target.selectedOptions?.[0];
5354-            lastBoardSignature = '';
5355-            postKanbanMessage({
5356-                type: 'selectWorkspace',
5357-                workspaceRoot: selectedWorkspaceRoot,
5358-                controlPlaneAction: selectedOption?.dataset?.controlPlaneAction || undefined
5359-            });
5360-        });
5361-        document.getElementById('workspace-reset-control-plane')?.addEventListener('click', () => {
5362-            lastBoardSignature = '';
5363-            postKanbanMessage({
5364-                type: 'selectWorkspace',
5365-                workspaceRoot: currentWorkspaceRoot || '',
5366-                controlPlaneAction: 'reset-auto-detect'
5367-            });
5368-        });
5369-        document.getElementById('btn-autoban')?.addEventListener('click', () => {
5370-            const currentlyEnabled = !!(autobanConfig && autobanConfig.enabled);
5371-            postKanbanMessage({ type: 'toggleAutoban', enabled: !currentlyEnabled });
5372-        });
5373-        document.getElementById('cli-triggers-toggle').addEventListener('change', (event) => {
5374-            const checked = !!event.target?.checked;
5375-            cliTriggersEnabled = checked;
5376-            updateCliToggleUi();
5377-            postKanbanMessage({ type: 'toggleCliTriggers', enabled: checked });
5378-        });
5379-        document.getElementById('unknown-complexity-toggle')?.addEventListener('change', (event) => {
5380-            const checked = !!event.target?.checked;
5381-            allowUnknownComplexityAutoMove = checked;
5382-            updateUnknownComplexityToggleUi();
5383-            postKanbanMessage({ type: 'toggleAllowUnknownComplexityAutoMove', enabled: checked });
5384-        });
5385-        document.getElementById('clear-terminal-before-prompt-toggle')?.addEventListener('change', (event) => {
5386-            const checked = !!event.target?.checked;
5387-            clearTerminalBeforePrompt = checked;
5388-            updateClearTerminalBeforePromptUi();
5389-            postKanbanMessage({ type: 'toggleClearTerminalBeforePrompt', enabled: checked });
5390-        });
5391-        document.getElementById('clear-terminal-delay-input')?.addEventListener('change', (event) => {
5392-            const value = parseInt(event.target?.value, 10);
5393-            if (!isNaN(value)) {
5394-                const clamped = Math.min(Math.max(value, 0), 10000);
5395-                clearTerminalBeforePromptDelay = clamped;
5396-                event.target.value = String(clamped);
5397-                postKanbanMessage({ type: 'updateClearTerminalBeforePromptDelay', delay: clamped });
5398-            }
5399-        });
5400-
5401-        document.getElementById('pairProgrammingModeSelect')?.addEventListener('change', (e) => {
5402-            const select = e.target;
5403-            select.classList.toggle('is-off', select.value === 'off');
5404-            postKanbanMessage({ type: 'setPairProgrammingMode', mode: select.value });
5405-        });
5406-
5407-        updateCliToggleUi();
5408-        renderColumns();
5409-        renderBoard([]);
5410-        updateAutobanButtonState();
5411-        syncAutobanCountdownTimer();
5412-
5413-        document.getElementById('integration-autopull-toggle')?.addEventListener('change', updateIntegrationIntervalState);
5414-        document.getElementById('integration-settings-close')?.addEventListener('click', closeIntegrationSettings);
5415-        document.getElementById('integration-settings-cancel')?.addEventListener('click', closeIntegrationSettings);
5416-        document.getElementById('integration-settings-save')?.addEventListener('click', saveIntegrationSettings);
5417-        document.getElementById('integration-settings-modal')?.addEventListener('click', function(e) {
5418-            if (e.target === e.currentTarget) closeIntegrationSettings();
5419-        });
5420-
5421-        // Linear and ClickUp request IDs for correlation
5422-        let linearContentRequestId = 0;
5423-        let clickUpContentRequestId = 0;
5424-
5425-        // Notion page content and Local Folder request IDs for correlation
5426-        let notionContentRequestId = 0;
5427-        let localFolderContentRequestId = 0;
5428-
5429-        // Testing Fail Modal event listeners
5430-        document.getElementById('testing-fail-close').addEventListener('click', closeTestingFailModal);
5431-        document.getElementById('testing-fail-modal').addEventListener('click', function(e) {
5432-            if (e.target === e.currentTarget) closeTestingFailModal();
5433-        });
5434-        document.getElementById('testing-fail-copy').addEventListener('click', function() {
5435-            const feedback = document.getElementById('testing-fail-feedback').value.trim();
5436-            if (!feedback) {
5437-                document.getElementById('testing-fail-feedback').style.borderColor = 'var(--accent-red)';
5438-                return;
5439-            }
5440-            postKanbanMessage({
5441-                type: 'testingFailed',
5442-                action: 'copyPrompt',
5443-                column: testingFailSourceColumn,
5444-                sessionIds: testingFailSessionIds,
5445-                feedback: feedback
5446-            });
5447-            closeTestingFailModal();
5448-        });
5449-        document.getElementById('testing-fail-send').addEventListener('click', function() {
5450-            const feedback = document.getElementById('testing-fail-feedback').value.trim();
5451-            if (!feedback) {
5452-                document.getElementById('testing-fail-feedback').style.borderColor = 'var(--accent-red)';
5453-                return;
5454-            }
5455-            postKanbanMessage({
5456-                type: 'testingFailed',
5457-                action: 'sendToLead',
5458-                column: testingFailSourceColumn,
5459-                sessionIds: testingFailSessionIds,
5460-                feedback: feedback
5461-            });
5462-            closeTestingFailModal();
5463-        });
5464-        document.getElementById('testing-fail-feedback').addEventListener('input', function() {
5465-            this.style.borderColor = '';
5466-        });
5467-
5468-        // Complexity routing toggle handler (event delegation to avoid memory leak)
5469-        document.addEventListener('click', (e) => {
5470-            const toggle = e.target.closest('#complexity-routing-toggle');
5471-            if (!toggle) return;
5472-            dynamicComplexityRoutingEnabled = !dynamicComplexityRoutingEnabled;
5473-            updateComplexityRoutingToggleUi();
5474-            postKanbanMessage({ type: 'toggleDynamicComplexityRouting', enabled: dynamicComplexityRoutingEnabled });
5475-        });
5476-
5477-        // ─── Routing Map ──────────────────────────────────────────────────────────
5478-
5479-        function updateRoutingMapButtonIndicator() {
5480-            const btn = document.getElementById('btn-routing-map');
5481-            if (!btn) return;
5482-            // Show orange dot when custom routing config differs from defaults
5483-            const isDefault = (
5484-                JSON.stringify(routingMapConfig.lead.slice().sort((a,b)=>a-b)) === JSON.stringify([7,8,9,10]) &&
5485-                JSON.stringify(routingMapConfig.coder.slice().sort((a,b)=>a-b)) === JSON.stringify([4,5,6]) &&
5486-                JSON.stringify(routingMapConfig.intern.slice().sort((a,b)=>a-b)) === JSON.stringify([1,2,3])
5487-            );
5488-            let dot = btn.querySelector('.routing-map-active-dot');
5489-            if (!isDefault) {
5490-                if (!dot) {
5491-                    dot = document.createElement('span');
5492-                    dot.className = 'routing-map-active-dot';
5493-                    btn.appendChild(dot);
5494-                }
5495-            } else if (dot) {
5496-                dot.remove();
5497-            }
5498-        }
5499-
5500-        function createComplexityCard(level) {
5501-            const card = document.createElement('div');
5502-            const cls = level >= 7 ? 'complexity-high' : level >= 4 ? 'complexity-medium' : 'complexity-low';
5503-            card.className = `complexity-card ${cls}`;
5504-            card.draggable = true;
5505-            card.dataset.complexity = level;
5506-            card.textContent = `Complexity ${level}`;
5507-
5508-            card.addEventListener('dragstart', (e) => {
5509-                routingMapDraggedCard = card;
5510-                card.classList.add('dragging');
5511-                e.dataTransfer.setData('text/plain', String(level));
5512-                e.dataTransfer.effectAllowed = 'move';
5513-                // Prevent kanban board drag handlers from seeing this event
5514-                e.stopPropagation();
5515-            });
5516-
5517-            card.addEventListener('dragend', () => {
5518-                card.classList.remove('dragging');
5519-                routingMapDraggedCard = null;
5520-            });
5521-
5522-            return card;
5523-        }
5524-
5525-        function renderRoutingCards() {
5526-            document.querySelectorAll('.routing-drop-zone').forEach(zone => { zone.innerHTML = ''; });
5527-            Object.entries(routingMapConfig).forEach(([role, complexities]) => {
5528-                const zone = document.querySelector(`.routing-drop-zone[data-role="${role}"]`);
5529-                if (!zone) return;
5530-                const sorted = [...complexities].sort((a, b) => b - a); // high→low within each column
5531-                sorted.forEach(level => zone.appendChild(createComplexityCard(level)));
5532-            });
5533-        }
5534-
5535-        // Bind drop zone listeners once (zones are static HTML, persist across renderRoutingCards calls)
5536-        document.querySelectorAll('.routing-drop-zone').forEach(zone => {
5537-            zone.addEventListener('dragover', (e) => {
5538-                e.preventDefault();
5539-                e.stopPropagation();
5540-                zone.classList.add('drag-over');
5541-            });
5542-            zone.addEventListener('dragleave', (e) => {
5543-                if (!zone.contains(e.relatedTarget)) {
5544-                    zone.classList.remove('drag-over');
5545-                }
5546-            });
5547-            zone.addEventListener('drop', (e) => {
5548-                e.preventDefault();
5549-                e.stopPropagation();
5550-                zone.classList.remove('drag-over');
5551-                if (routingMapDraggedCard) {
5552-                    zone.appendChild(routingMapDraggedCard);
5553-                    updateRoutingConfigFromDOM();
5554-                }
5555-            });
5556-        });
5557-
5558-        function updateRoutingConfigFromDOM() {
5559-            routingMapConfig = { lead: [], coder: [], intern: [] };
5560-            document.querySelectorAll('.routing-drop-zone').forEach(zone => {
5561-                const role = zone.dataset.role;
5562-                if (!role || !(role in routingMapConfig)) return;
5563-                zone.querySelectorAll('.complexity-card').forEach(card => {
5564-                    routingMapConfig[role].push(parseInt(card.dataset.complexity, 10));
5565-                });
5566-                routingMapConfig[role].sort((a, b) => a - b);
5567-            });
5568-        }
5569-
5570-        function openRoutingMap() {
5571-            const modal = document.getElementById('routing-map-modal');
5572-            if (!modal) return;
5573-            renderRoutingCards();
5574-            modal.classList.remove('hidden');
5575-        }
5576-
5577-        function closeRoutingMap() {
5578-            const modal = document.getElementById('routing-map-modal');
5579-            if (!modal) return;
5580-            modal.classList.add('hidden');
5581-        }
5582-
5583-        function saveRoutingMap() {
5584-            updateRoutingConfigFromDOM();
5585-            // Validate all 10 complexities assigned exactly once
5586-            const all = [...routingMapConfig.lead, ...routingMapConfig.coder, ...routingMapConfig.intern];
5587-            if (new Set(all).size !== 10 || all.length !== 10) {
5588-                // Should not happen with well-behaved drag-drop, but guard anyway
5589-                return;
5590-            }
5591-            postKanbanMessage({ type: 'updateRoutingConfig', config: routingMapConfig });
5592-            updateRoutingMapButtonIndicator();
5593-            closeRoutingMap();
5594-        }
5595-
5596-        // Routing map button
5597-        document.getElementById('btn-routing-map').addEventListener('click', openRoutingMap);
5598-
5599-        // Collapse coders toggle button
5600-        document.getElementById('btn-collapse-coders')?.addEventListener('click', () => {
5601-            collapseCodersEnabled = !collapseCodersEnabled;
5602-            const btn = document.getElementById('btn-collapse-coders');
5603-            if (btn) btn.classList.toggle('is-active', collapseCodersEnabled);
5604-            try {
5605-                const state = vscode.getState() || {};
5606-                state.collapseCodersEnabled = collapseCodersEnabled;
5607-                vscode.setState(state);
5608-            } catch (_) {}
5609-            renderColumns();
5610-            renderBoard(currentCards);
5611-            updateAllColumnAgents();
5612-        });
5613-        // Restore visual active state from saved toggle state
5614-        if (collapseCodersEnabled) {
5615-            document.getElementById('btn-collapse-coders')?.classList.add('is-active');
5616-        }
5617-
5618-        // Close buttons (both × header and Cancel footer)
5619-        document.querySelectorAll('[data-action="closeRoutingMap"]').forEach(btn => {
5620-            btn.addEventListener('click', closeRoutingMap);
5621-        });
5622-
5623-        // Save button
5624-        document.querySelector('[data-action="saveRoutingMap"]').addEventListener('click', saveRoutingMap);
5625-
5626-        // ─── End Routing Map ──────────────────────────────────────────────────────
5627-
5628-        // ─── Autoban Config Panel (ported from sidebar implementation.html) ────────
5629-
5630-        let lastTerminals = {};
5631-        let lastCustomAgents = [];
5632-        let isAutobanPanelInteracting = false;
5633-        let lastAntigravityAgent = '';
5634-        let lastAntigravityColumn = '';
5635-
5636-        function emitAutobanState() {
5637-            if (!autobanConfig) return;
5638-            postKanbanMessage({
5639-                type: 'updateAutobanState',
5640-                state: {
5641-                    enabled: autobanConfig.enabled,
5642-                    batchSize: autobanConfig.batchSize,
5643-                    complexityFilter: autobanConfig.complexityFilter,
5644-                    routingMode: autobanConfig.routingMode,
5645-                    rules: autobanConfig.rules
5646-                }
5647-            });
5648-        }
5649-
5650-        function createAutobanPanel() {
5651-            const container = document.createElement('div');
5652-            container.style.cssText = 'padding: 8px; display: flex; flex-direction: column; gap: 12px;';
5653-
5654-            if (!autobanConfig) {
5655-                const placeholder = document.createElement('div');
5656-                placeholder.style.cssText = 'padding: 20px; text-align: center; color: var(--text-secondary); font-family: var(--font-mono); font-size: 11px;';
5657-                placeholder.textContent = 'Loading automation state…';
5658-                container.appendChild(placeholder);
5659-                return container;
5660-            }
5661-
5662-            const state = autobanConfig;
5663-            const autobanSelectStyle = 'background:var(--panel-bg2); border:1px solid var(--border-color); color:var(--text-primary); font-family:var(--font-mono); font-size:10px; padding:2px 4px; border-radius:3px;';
5664-            const autobanNumberInputStyle = 'width:56px; background:var(--panel-bg2); border:1px solid var(--border-color); color:var(--text-primary); font-family:var(--font-mono); font-size:10px; padding:2px 4px; border-radius:3px; text-align:center;';
5665-            const chipStyle = 'display:inline-flex; align-items:center; gap:4px; border:1px solid var(--border-color); border-radius:999px; padding:1px 6px; font-size:9px; color:var(--text-secondary);';
5666-            const smallButtonStyle = 'background:var(--panel-bg2); border:1px solid var(--border-color); color:var(--text-primary); font-family:var(--font-mono); font-size:9px; padding:3px 6px; border-radius:4px; cursor:pointer;';
5667-            const guardInteraction = (el) => {
5668-                el.addEventListener('focus', () => { isAutobanPanelInteracting = true; });
5669-                el.addEventListener('blur', () => { isAutobanPanelInteracting = false; });
5670-            };
5671-            const autobanRoles = [
5672-                { role: 'planner', label: 'Planner' },
5673-                { role: 'intern', label: 'Intern' },
5674-                { role: 'coder', label: 'Coder' },
5675-                { role: 'lead', label: 'Lead Coder' },
5676-                { role: 'reviewer', label: 'Reviewer' },
5677-                ...lastCustomAgents
5678-                    .filter(agent => agent.includeInKanban === true)
5679-                    .map(agent => ({ role: agent.role, label: agent.name }))
5680-            ];
5681-
5682-            const getAutobanRuleIdSuffix = (column) => column.toLowerCase().replace(/[^a-z0-9]+/g, '-');
5683-            const columnTransitions = [
5684-                { column: 'CREATED', label: 'CREATED -> PLAN REVIEWED', defaultMin: 10, floorPerPlan: 3 },
5685-                { column: 'PLAN REVIEWED', label: 'PLAN REVIEWED -> INTERN/CODER/LEAD', defaultMin: 20, floorPerPlan: 5 },
5686-                { column: 'INTERN CODED', label: 'INTERN CODED -> CODE REVIEWED', defaultMin: 15, floorPerPlan: 4 },
5687-                { column: 'LEAD CODED', label: 'LEAD CODED -> CODE REVIEWED', defaultMin: 15, floorPerPlan: 4 },
5688-                { column: 'CODER CODED', label: 'CODER CODED -> CODE REVIEWED', defaultMin: 15, floorPerPlan: 4 }
5689-            ];
5690-
5691-            const resolveTerminalLiveness = (terminalName) => {
5692-                const terminal = lastTerminals[terminalName];
5693-                if (!terminal) {
5694-                    return { terminal: null, alive: false };
5695-                }
5696-                const heartbeatThresholdMs = 60_000;
5697-                const lastSeenMs = Date.parse(terminal.lastSeen || '');
5698-                const heartbeatAlive = !isNaN(lastSeenMs) && (Date.now() - lastSeenMs) < heartbeatThresholdMs;
5699-                const alive = terminal.alive !== undefined ? terminal.alive : (terminal._isLocal || heartbeatAlive);
5700-                return { terminal, alive: !!alive };
5701-            };
5702-
5703-            const getRolePoolEntries = (role) => {
5704-                const configuredPool = Array.isArray(state.terminalPools?.[role]) ? state.terminalPools[role].filter(Boolean) : [];
5705-                const managedPool = new Set(Array.isArray(state.managedTerminalPools?.[role]) ? state.managedTerminalPools[role] : []);
5706-                const aliveRoleTerminals = Object.keys(lastTerminals)
5707-                    .filter(name => lastTerminals[name] && lastTerminals[name].role === role)
5708-                    .filter(name => resolveTerminalLiveness(name).alive)
5709-                    .sort((a, b) => a.localeCompare(b));
5710-                const alivePrimaryRoleTerminals = aliveRoleTerminals
5711-                    .filter(name => String(lastTerminals[name]?.purpose || '').trim().toLowerCase() !== 'autoban-backup');
5712-                const effectivePool = (
5713-                    configuredPool.length > 0
5714-                        ? configuredPool.filter(name => aliveRoleTerminals.includes(name))
5715-                        : alivePrimaryRoleTerminals
5716-                ).slice(0, 5);
5717-                return effectivePool.map(name => {
5718-                    const status = resolveTerminalLiveness(name);
5719-                    const count = Number(state.sendCounts?.[name] || 0);
5720-                    return {
5721-                        name,
5722-                        count,
5723-                        max: Number(state.maxSendsPerTerminal || 10),
5724-                        managed: managedPool.has(name),
5725-                        alive: status.alive,
5726-                        terminal: status.terminal,
5727-                        exhausted: count >= Number(state.maxSendsPerTerminal || 10)
5728-                    };
5729-                });
5730-            };
5731-
5732-            const antigravitySection = document.createElement('div');
5733-            antigravitySection.className = 'db-subsection';
5734-            container.appendChild(antigravitySection);
5735-
5736-            const antigravityHeader = document.createElement('div');
5737-            antigravityHeader.className = 'subsection-header';
5738-            const antigravitySpan = document.createElement('span');
5739-            antigravitySpan.textContent = 'ANTIGRAVITY AUTOMATION';
5740-            antigravityHeader.appendChild(antigravitySpan);
5741-            antigravitySection.appendChild(antigravityHeader);
5742-
5743-            const antigravityDesc = document.createElement('div');
5744-            antigravityDesc.style.cssText = 'padding:0 8px; font-family:var(--font-mono); font-size:10px; color:var(--text-secondary); margin-bottom:8px;';
5745-            antigravityDesc.textContent = 'Select an agent and column, then copy a prompt (using prompts tab configuration) for the oldest plan in that column. Paste this prompt into the Antigravity automation timer (or similar IDE feature) to have Antigravity process all plans in a kanban column.';
5746-            antigravitySection.appendChild(antigravityDesc);
5747-
5748-            const antigravityActions = document.createElement('div');
5749-            antigravityActions.style.cssText = 'padding:0 8px; display:flex; gap:8px; align-items:center;';
5750-            antigravitySection.appendChild(antigravityActions);
5751-
5752-            const agentSelect = document.createElement('select');
5753-            agentSelect.style.cssText = 'background:var(--panel-bg2); border:1px solid var(--border-color); color:var(--text-primary); font-family:var(--font-mono); font-size:10px; padding:2px 4px; border-radius:3px; flex:1;';
5754-            guardInteraction(agentSelect);
5755-
5756-            // Populate with enabled agents from lastVisibleAgents
5757-            const enabledAgents = Object.keys(lastVisibleAgents || {}).filter(name => lastVisibleAgents[name] !== false);
5758-            enabledAgents.forEach(agentName => {
5759-                const opt = document.createElement('option');
5760-                opt.value = agentName;
5761-                opt.textContent = agentName;
5762-                agentSelect.appendChild(opt);
5763-            });
5764-            
5765-            // Restore last selected agent if it still exists
5766-            if (lastAntigravityAgent && enabledAgents.includes(lastAntigravityAgent)) {
5767-                agentSelect.value = lastAntigravityAgent;
5768-            } else if (enabledAgents.length > 0) {
5769-                lastAntigravityAgent = enabledAgents[0]; // initialize if empty
5770-            }
5771-            agentSelect.addEventListener('change', () => { lastAntigravityAgent = agentSelect.value; });
5772-
5773-            antigravityActions.appendChild(agentSelect);
5774-
5775-            const columnSelect = document.createElement('select');
5776-            columnSelect.style.cssText = 'background:var(--panel-bg2); border:1px solid var(--border-color); color:var(--text-primary); font-family:var(--font-mono); font-size:10px; padding:2px 4px; border-radius:3px; flex:1;';
5777-            guardInteraction(columnSelect);
5778-
5779-            columnDefinitions.forEach(col => {
5780-                const opt = document.createElement('option');
5781-                opt.value = col.id;
5782-                opt.textContent = col.label;
5783-                columnSelect.appendChild(opt);
5784-            });
5785-
5786-            // Default to 'CREATED'; fall back to first column if not present
5787-            const createdExists = columnDefinitions.some(col => col.id === 'CREATED');
5788-            const defaultCol = createdExists ? 'CREATED' : (columnDefinitions[0]?.id || '');
5789-            
5790-            if (lastAntigravityColumn && columnDefinitions.some(col => col.id === lastAntigravityColumn)) {
5791-                columnSelect.value = lastAntigravityColumn;
5792-            } else {
5793-                columnSelect.value = defaultCol;
5794-                lastAntigravityColumn = defaultCol; // initialize if empty
5795-            }
5796-            columnSelect.addEventListener('change', () => { lastAntigravityColumn = columnSelect.value; });
5797-
5798-            antigravityActions.appendChild(columnSelect);
5799-
5800-            const copyPromptBtn = document.createElement('button');
5801-            copyPromptBtn.className = 'strip-btn';
5802-            copyPromptBtn.id = 'antigravity-copy-prompt-btn';  // Unique ID for reliable selection
5803-            copyPromptBtn.textContent = 'COPY PROMPT';
5804-            copyPromptBtn.style.cssText = 'font-family:var(--font-mono); font-size:10px;';
5805-            copyPromptBtn.addEventListener('click', async () => {
5806-                try {
5807-                    const selectedAgent = agentSelect.value;
5808-                    if (!selectedAgent) {
5809-                        console.error('No agent selected');
5810-                        return;
5811-                    }
5812-
5813-                    copyPromptBtn.textContent = 'LOADING...';
5814-                    copyPromptBtn.disabled = true;
5815-
5816-                    // Request the prompt for the selected agent using prompts tab configuration
5817-                    postKanbanMessage({
5818-                        type: 'generateAntigravityPrompt',
5819-                        agent: selectedAgent,
5820-                        column: columnSelect.value,
5821-                        workspaceRoot: getActiveWorkspaceRoot()
5822-                    });
5823-
5824-                    // The response will be handled via a new message listener case
5825-                } catch (err) {
5826-                    console.error('Failed to generate prompt:', err);
5827-                    copyPromptBtn.textContent = 'COPY PROMPT';
5828-                    copyPromptBtn.disabled = false;
5829-                }
5830-            });
5831-            antigravityActions.appendChild(copyPromptBtn);
5832-
5833-            const automationRulesSection = document.createElement('div');
5834-            automationRulesSection.className = 'db-subsection';
5835-            container.appendChild(automationRulesSection);
5836-
5837-            const automationRulesHeader = document.createElement('div');
5838-            automationRulesHeader.className = 'subsection-header';
5839-            const automationRulesSpan = document.createElement('span');
5840-            automationRulesSpan.textContent = 'KANBAN AUTOMATION RULES';
5841-            automationRulesHeader.appendChild(automationRulesSpan);
5842-            automationRulesSection.appendChild(automationRulesHeader);
5843-
5844-            const batchRow = document.createElement('div');
5845-            batchRow.style.cssText = 'display:flex; align-items:center; gap:8px; padding:0 8px; font-family:var(--font-mono); font-size:10px; color:var(--text-secondary);';
5846-
5847-            const batchLabel = document.createElement('span');
5848-            batchLabel.textContent = 'MAX BATCH SIZE:';
5849-
5850-            const batchSelect = document.createElement('select');
5851-            batchSelect.style.cssText = autobanSelectStyle;
5852-            guardInteraction(batchSelect);
5853-            const AUTOBAN_BATCH_SIZE_OPTIONS = [1, 2, 3, 4, 5];
5854-            AUTOBAN_BATCH_SIZE_OPTIONS.forEach(val => {
5855-                const opt = document.createElement('option');
5856-                opt.value = String(val);
5857-                opt.textContent = String(val);
5858-                if (val === state.batchSize) opt.selected = true;
5859-                batchSelect.appendChild(opt);
5860-            });
5861-            batchSelect.addEventListener('change', () => {
5862-                state.batchSize = parseInt(batchSelect.value, 10) || 3;
5863-                emitAutobanState();
5864-            });
5865-
5866-            batchRow.appendChild(batchLabel);
5867-            batchRow.appendChild(batchSelect);
5868-            automationRulesSection.appendChild(batchRow);
5869-
5870-            const complexityRow = document.createElement('div');
5871-            complexityRow.style.cssText = 'display:flex; align-items:center; gap:8px; padding:0 8px; font-family:var(--font-mono); font-size:10px; color:var(--text-secondary);';
5872-
5873-            const complexityLabel = document.createElement('span');
5874-            complexityLabel.textContent = 'COMPLEXITY:';
5875-
5876-            const complexitySelect = document.createElement('select');
5877-            complexitySelect.style.cssText = autobanSelectStyle;
5878-            guardInteraction(complexitySelect);
5879-            [
5880-                { value: 'all', label: 'All' },
5881-                { value: 'low_and_below', label: 'Low and below (1-4)' },
5882-                { value: 'medium_and_below', label: 'Medium and below (1-6)' },
5883-                { value: 'medium_and_above', label: 'Medium and above (5-10)' },
5884-                { value: 'high_and_above', label: 'High and above (7-10)' }
5885-            ].forEach(({ value, label }) => {
5886-                const opt = document.createElement('option');
5887-                opt.value = value;
5888-                opt.textContent = label;
5889-                if (value === state.complexityFilter) opt.selected = true;
5890-                complexitySelect.appendChild(opt);
5891-            });
5892-            complexitySelect.title = 'Unknown complexity is treated as High (8). Low and below excludes Unknown.';
5893-            complexitySelect.addEventListener('change', () => {
5894-                state.complexityFilter = complexitySelect.value || 'all';
5895-                emitAutobanState();
5896-            });
5897-
5898-            complexityRow.appendChild(complexityLabel);
5899-            complexityRow.appendChild(complexitySelect);
5900-            automationRulesSection.appendChild(complexityRow);
5901-
5902-            const routingRow = document.createElement('div');
5903-            routingRow.style.cssText = 'display:flex; align-items:center; gap:8px; padding:0 8px; font-family:var(--font-mono); font-size:10px; color:var(--text-secondary);';
5904-
5905-            const routingLabel = document.createElement('span');
5906-            routingLabel.textContent = 'ROUTING:';
5907-
5908-            const routingSelect = document.createElement('select');
5909-            routingSelect.style.cssText = autobanSelectStyle;
5910-            guardInteraction(routingSelect);
5911-            [
5912-                { value: 'dynamic', label: 'Dynamic' },
5913-                { value: 'all_coder', label: 'All -> Coder' },
5914-                { value: 'all_lead', label: 'All -> Lead' }
5915-            ].forEach(({ value, label }) => {
5916-                const opt = document.createElement('option');
5917-                opt.value = value;
5918-                opt.textContent = label;
5919-                if (value === state.routingMode) opt.selected = true;
5920-                routingSelect.appendChild(opt);
5921-            });
5922-            routingSelect.addEventListener('change', () => {
5923-                state.routingMode = routingSelect.value || 'dynamic';
5924-                emitAutobanState();
5925-            });
5926-
5927-            routingRow.appendChild(routingLabel);
5928-            routingRow.appendChild(routingSelect);
5929-            automationRulesSection.appendChild(routingRow);
5930-
5931-            const maxSendsRow = document.createElement('div');
5932-            maxSendsRow.style.cssText = 'display:flex; align-items:center; gap:8px; padding:0 8px; font-family:var(--font-mono); font-size:10px; color:var(--text-secondary);';
5933-
5934-            const maxSendsLabel = document.createElement('span');
5935-            maxSendsLabel.textContent = 'MAX SENDS / TERMINAL:';
5936-
5937-            const maxSendsInput = document.createElement('input');
5938-            maxSendsInput.type = 'number';
5939-            maxSendsInput.min = '1';
5940-            maxSendsInput.max = '100';
5941-            maxSendsInput.value = String(Number(state.maxSendsPerTerminal || 10));
5942-            maxSendsInput.style.cssText = autobanNumberInputStyle;
5943-            guardInteraction(maxSendsInput);
5944-            maxSendsInput.addEventListener('change', () => {
5945-                const value = Math.max(1, Math.min(100, parseInt(maxSendsInput.value, 10) || 10));
5946-                state.maxSendsPerTerminal = value;
5947-                maxSendsInput.value = String(value);
5948-                postKanbanMessage({ type: 'updateAutobanMaxSends', maxSendsPerTerminal: value });
5949-                isAutobanPanelInteracting = false;
5950-                renderAutobanPanel();
5951-            });
5952-
5953-            const sessionCapBadge = document.createElement('span');
5954-            sessionCapBadge.style.cssText = chipStyle;
5955-            sessionCapBadge.textContent = 'SESSION ' + Number(state.sessionSendCount || 0) + '/' + Number(state.globalSessionCap || 200);
5956-
5957-            maxSendsRow.appendChild(maxSendsLabel);
5958-            maxSendsRow.appendChild(maxSendsInput);
5959-            maxSendsRow.appendChild(sessionCapBadge);
5960-            automationRulesSection.appendChild(maxSendsRow);
5961-
5962-            const columnRulesSection = document.createElement('div');
5963-            columnRulesSection.className = 'db-subsection';
5964-            container.appendChild(columnRulesSection);
5965-
5966-            const rulesHeader = document.createElement('div');
5967-            rulesHeader.className = 'subsection-header';
5968-            const rulesSpan = document.createElement('span');
5969-            rulesSpan.textContent = 'COLUMN RULES';
5970-            rulesHeader.appendChild(rulesSpan);
5971-            columnRulesSection.appendChild(rulesHeader);
5972-
5973-            const timingExplanation = document.createElement('div');
5974-            timingExplanation.style.cssText = 'padding:8px 12px; font-size:11px; color:var(--text-secondary); margin-bottom:8px; line-height:1.4;';
5975-            timingExplanation.textContent = 'Specify the time delay between advancing each plan to the next stage. Lower intervals require more backup terminals to avoid overwhelming each agent.';
5976-            columnRulesSection.appendChild(timingExplanation);
5977-
5978-            columnTransitions.forEach(({ column, label, defaultMin, floorPerPlan }) => {
5979-                const idSuffix = getAutobanRuleIdSuffix(column);
5980-                const rule = state.rules?.[column] || { enabled: true, intervalMinutes: defaultMin };
5981-                const ruleRow = document.createElement('div');
5982-                ruleRow.style.cssText = 'display:flex; align-items:center; gap:6px; padding:4px 8px; font-family:var(--font-mono); font-size:10px;';
5983-
5984-                const checkbox = document.createElement('input');
5985-                checkbox.type = 'checkbox';
5986-                checkbox.checked = rule.enabled;
5987-                checkbox.style.cssText = 'accent-color:var(--accent-teal); cursor:pointer;';
5988-                checkbox.addEventListener('change', () => {
5989-                    if (!state.rules) state.rules = {};
5990-                    if (!state.rules[column]) {
5991-                        state.rules[column] = { enabled: true, intervalMinutes: defaultMin };
5992-                    }
5993-                    state.rules[column].enabled = checkbox.checked;
5994-                    emitAutobanState();
5995-                });
5996-
5997-                const ruleLbl = document.createElement('span');
5998-                ruleLbl.style.cssText = 'color:var(--text-primary); flex:1; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;';
5999-                ruleLbl.textContent = label;
6000-
6001-                const everyLbl = document.createElement('span');
6002-                everyLbl.style.cssText = 'color:var(--text-secondary);';
6003-                everyLbl.textContent = 'every';
6004-
6005-                const minInput = document.createElement('input');
6006-                minInput.type = 'number';
6007-                minInput.min = '1';
6008-                minInput.max = '60';
6009-                minInput.id = 'interval-input-' + idSuffix;
6010-                minInput.value = String(rule.intervalMinutes);
6011-                minInput.style.cssText = 'width:40px; background:var(--panel-bg2); border:1px solid var(--border-color); color:var(--text-primary); font-family:var(--font-mono); font-size:10px; padding:2px 4px; border-radius:3px; text-align:center;';
6012-                guardInteraction(minInput);
6013-                minInput.addEventListener('change', () => {
6014-                    if (!state.rules) state.rules = {};
6015-                    if (!state.rules[column]) {
6016-                        state.rules[column] = { enabled: true, intervalMinutes: defaultMin };
6017-                    }
6018-                    const val = Math.max(1, parseInt(minInput.value, 10) || defaultMin);
6019-                    state.rules[column].intervalMinutes = val;
6020-                    minInput.value = String(val);
6021-                    emitAutobanState();
6022-                });
6023-
6024-                const minLbl = document.createElement('span');
6025-                minLbl.style.cssText = 'color:var(--text-secondary);';
6026-                minLbl.textContent = 'min';
6027-
6028-                ruleRow.appendChild(checkbox);
6029-                ruleRow.appendChild(ruleLbl);
6030-                ruleRow.appendChild(everyLbl);
6031-                ruleRow.appendChild(minInput);
6032-                ruleRow.appendChild(minLbl);
6033-                columnRulesSection.appendChild(ruleRow);
6034-            });
6035-
6036-            const terminalPoolsSection = document.createElement('div');
6037-            terminalPoolsSection.className = 'db-subsection';
6038-            container.appendChild(terminalPoolsSection);
6039-
6040-            const poolsHeader = document.createElement('div');
6041-            poolsHeader.className = 'subsection-header';
6042-            const poolsSpan = document.createElement('span');
6043-            poolsSpan.textContent = 'TERMINAL POOLS';
6044-            poolsHeader.appendChild(poolsSpan);
6045-            terminalPoolsSection.appendChild(poolsHeader);
6046-
6047-            const poolsHelp = document.createElement('div');
6048-            poolsHelp.style.cssText = 'padding:0 8px; font-family:var(--font-mono); font-size:9px; color:var(--text-secondary); line-height:1.4;';
6049-            poolsHelp.textContent = 'Autoban rotates across the stored pool for each role. Backup terminals created here are kept until you remove or reset them.';
6050-            terminalPoolsSection.appendChild(poolsHelp);
6051-
6052-            autobanRoles.forEach(({ role, label }) => {
6053-                const poolEntries = getRolePoolEntries(role);
6054-                const roleBlock = document.createElement('div');
6055-                roleBlock.style.cssText = 'display:flex; flex-direction:column; gap:6px; padding:6px 8px; border:1px solid var(--border-color); border-radius:6px; background:var(--panel-bg2);';
6056-
6057-                const roleHeader = document.createElement('div');
6058-                roleHeader.style.cssText = 'display:flex; align-items:center; justify-content:space-between; gap:8px;';
6059-
6060-                const roleTitleWrap = document.createElement('div');
6061-                roleTitleWrap.style.cssText = 'display:flex; align-items:center; gap:8px; min-width:0; flex:1 1 auto; overflow:hidden;';
6062-
6063-                const roleTitle = document.createElement('span');
6064-                roleTitle.style.cssText = 'font-family:var(--font-mono); font-size:10px; color:var(--text-primary); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; flex-shrink:1; min-width:0;';
6065-                roleTitle.textContent = label;
6066-
6067-                const roleCapacity = document.createElement('span');
6068-                roleCapacity.style.cssText = chipStyle + ' flex-shrink:0;';
6069-                roleCapacity.textContent = 'POOL ' + poolEntries.length + '/5';
6070-
6071-                roleTitleWrap.appendChild(roleTitle);
6072-                roleTitleWrap.appendChild(roleCapacity);
6073-
6074-                const addButton = document.createElement('button');
6075-                addButton.className = 'action-btn';
6076-                addButton.style.cssText = 'padding:3px 8px; font-size:9px; flex-shrink:0;';
6077-                addButton.textContent = 'ADD TERMINAL';
6078-                addButton.disabled = poolEntries.length >= 5;
6079-                addButton.addEventListener('click', () => {
6080-                    postKanbanMessage({ type: 'addAutobanTerminal', role });
6081-                });
6082-
6083-                roleHeader.appendChild(roleTitleWrap);
6084-                roleHeader.appendChild(addButton);
6085-                roleBlock.appendChild(roleHeader);
6086-
6087-                if (poolEntries.length === 0) {
6088-                    const emptyState = document.createElement('div');
6089-                    emptyState.style.cssText = 'font-family:var(--font-mono); font-size:9px; color:var(--text-secondary);';
6090-                    emptyState.textContent = 'No live terminals available for this role yet.';
6091-                    roleBlock.appendChild(emptyState);
6092-                } else {
6093-                    poolEntries.forEach(entry => {
6094-                        const terminalRow = document.createElement('div');
6095-                        terminalRow.style.cssText = 'display:flex; align-items:center; gap:6px; justify-content:space-between; flex-wrap:wrap;';
6096-
6097-                        const left = document.createElement('div');
6098-                        left.style.cssText = 'display:flex; align-items:center; gap:6px; min-width:0; flex-wrap:wrap;';
6099-
6100-                        const nameSpan = document.createElement('span');
6101-                        nameSpan.style.cssText = 'font-family:var(--font-mono); font-size:10px; color:var(--text-primary);';
6102-                        nameSpan.textContent = entry.name;
6103-
6104-                        const usageBadge = document.createElement('span');
6105-                        usageBadge.style.cssText = chipStyle + (entry.exhausted ? ' border-color:var(--accent-red, #e55); color:var(--accent-red, #e55);' : '');
6106-                        usageBadge.textContent = entry.count + '/' + entry.max;
6107-
6108-                        const statusBadge = document.createElement('span');
6109-                        statusBadge.style.cssText = chipStyle + (entry.alive ? '' : ' border-color:var(--accent-red, #e55); color:var(--accent-red, #e55);');
6110-                        statusBadge.textContent = entry.alive ? (entry.exhausted ? 'EXHAUSTED' : 'READY') : 'OFFLINE';
6111-
6112-                        const kindBadge = document.createElement('span');
6113-                        kindBadge.style.cssText = chipStyle;
6114-                        kindBadge.textContent = entry.managed ? 'BACKUP' : 'PRIMARY';
6115-
6116-                        left.appendChild(nameSpan);
6117-                        left.appendChild(usageBadge);
6118-                        left.appendChild(statusBadge);
6119-                        left.appendChild(kindBadge);
6120-
6121-                        const right = document.createElement('div');
6122-                        right.style.cssText = 'display:flex; align-items:center; gap:6px;';
6123-
6124-                        if (entry.terminal) {
6125-                            const focusButton = document.createElement('button');
6126-                            focusButton.style.cssText = smallButtonStyle;
6127-                            focusButton.textContent = 'FOCUS';
6128-                            focusButton.addEventListener('click', () => {
6129-                                postKanbanMessage({ type: 'focusTerminal', terminalName: entry.name });
6130-                            });
6131-                            right.appendChild(focusButton);
6132-                        }
6133-
6134-                        if (entry.managed) {
6135-                            const removeButton = document.createElement('button');
6136-                            removeButton.style.cssText = smallButtonStyle + ' color:var(--accent-red, #e55);';
6137-                            removeButton.textContent = 'REMOVE';
6138-                            removeButton.addEventListener('click', () => {
6139-                                postKanbanMessage({ type: 'removeAutobanTerminal', role, terminalName: entry.name });
6140-                            });
6141-                            right.appendChild(removeButton);
6142-                        }
6143-
6144-                        terminalRow.appendChild(left);
6145-                        terminalRow.appendChild(right);
6146-                        roleBlock.appendChild(terminalRow);
6147-                    });
6148-                }
6149-                terminalPoolsSection.appendChild(roleBlock);
6150-            });
6151-
6152-            const resetRow = document.createElement('div');
6153-            resetRow.style.cssText = 'display:flex; align-items:center; justify-content:space-between; gap:8px; padding:0 8px;';
6154-
6155-            const resetHint = document.createElement('span');
6156-            resetHint.style.cssText = 'font-family:var(--font-mono); font-size:9px; color:var(--text-secondary); line-height:1.4;';
6157-            resetHint.textContent = 'Clear sends, restart timers, and remove autoban-created backup terminals.';
6158-
6159-            const resetButton = document.createElement('button');
6160-            resetButton.className = 'action-btn';
6161-            resetButton.style.cssText = 'padding:4px 8px; font-size:9px; color:var(--accent-red, #e55);';
6162-            resetButton.textContent = 'CLEAR & RESET';
6163-            resetButton.addEventListener('click', () => {
6164-                if (!window.confirm('Clear autoban send counters and remove autoban backup terminals?')) return;
6165-                postKanbanMessage({ type: 'resetAutobanPools' });
6166-            });
6167-
6168-            resetRow.appendChild(resetHint);
6169-            resetRow.appendChild(resetButton);
6170-            container.appendChild(resetRow);
6171-
6172-            return container;
6173-        }
6174-
6175-        function renderAutobanPanel() {
6176-            const root = document.getElementById('automation-panel-root');
6177-            if (!root) return;
6178-            if (isAutobanPanelInteracting) return;
6179-            root.innerHTML = '';
6180-            root.appendChild(createAutobanPanel());
6181-        }
6182-
6183-        // Terminals and custom agents feed the terminal pool UI. Kanban webview
6184-        // does not own this state; it receives broadcasts from the host.
6185-        window.addEventListener('message', event => {
6186-            const msg = event.data;
6187-            if (!msg || typeof msg !== 'object') return;
6188-            if (msg.type === 'terminalStatuses') {
6189-                lastTerminals = msg.terminals || {};
6190-                renderAutobanPanel();
6191-            } else if (msg.type === 'customAgents') {
6192-                lastCustomAgents = Array.isArray(msg.customAgents) ? msg.customAgents : [];
6193-                updateCustomAgentsDropdown();
6194-                renderAutobanPanel();
6195-            }
6196-        });
6197-
6198-        // Render when Automation tab is opened.
6199-        kanbanTabButtons.forEach(btn => {
6200-            btn.addEventListener('click', () => {
6201-                if (btn.dataset.tab === 'automation') {
6202-                    // Request autoban config if not already loaded
6203-                    if (!autobanConfig) {
6204-                        postKanbanMessage({ type: 'getAutobanConfig' });
6205-                    }
6206-                    renderAutobanPanel();
6207-                }
6208-            });
6209-        });
6210-
6211-        // ─── End Autoban Config Panel ──────────────────────────────────────────────
6212-
6213-        // ─── Kanban Structure Configuration ────────────────────────────────────────
6214-        let lastKanbanStructure = [];
6215-        let lastCustomKanbanColumns = [];
6216-        let editingKanbanColumnId = null;
6217-        let draggedKanbanStructureId = null;
6218-
6219-        const kanbanColumnModal = document.getElementById('kanban-column-modal');
6220-        const kanbanColumnLabelInput = document.getElementById('kanban-column-label');
6221-        const kanbanColumnAssignedAgentInput = document.getElementById('kanban-column-assigned-agent');
6222-        const kanbanColumnTriggerPromptInput = document.getElementById('kanban-column-trigger-prompt');
6223-        const kanbanColumnDragDropModeInput = document.getElementById('kanban-column-dragdrop');
6224-        const kanbanColumnError = document.getElementById('kanban-column-error');
6225-        const kanbanStructureList = document.getElementById('kanban-structure-list');
6226-
6227-        function openKanbanColumnModal(column) {
6228-            editingKanbanColumnId = column ? column.id : null;
6229-            renderKanbanAssignedAgentOptions(column?.role || column?.assignedAgent || 'coder');
6230-            kanbanColumnLabelInput.value = column?.label || '';
6231-            kanbanColumnTriggerPromptInput.value = column?.triggerPrompt || '';
6232-            kanbanColumnDragDropModeInput.value = column?.dragDropMode || 'cli';
6233-            kanbanColumnError.textContent = '';
6234-            kanbanColumnModal.classList.remove('hidden');
6235-            setTimeout(() => kanbanColumnLabelInput.focus(), 0);
6236-        }
6237-
6238-        function closeKanbanColumnModal() {
6239-            editingKanbanColumnId = null;
6240-            kanbanColumnModal.classList.add('hidden');
6241-            kanbanColumnError.textContent = '';
6242-        }
6243-
6244-        function renderKanbanAssignedAgentOptions(selectedRole) {
6245-            const roles = BUILT_IN_AGENT_LABELS;
6246-            const options = roles.map(r => `<option value="${r.key}"${r.key === selectedRole ? ' selected' : ''}>${r.label}</option>`).join('');
6247-            kanbanColumnAssignedAgentInput.innerHTML = options;
6248-        }
6249-
6250-        function sanitizeKanbanColumnId(label) {
6251-            return 'custom-' + label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
6252-        }
6253-
6254-        function getRenderableKanbanStructure() {
6255-            if (!Array.isArray(lastKanbanStructure) || !lastKanbanStructure.length) {
6256-                return [];
6257-            }
6258-            return lastKanbanStructure.map(item => ({
6259-                ...item,
6260-                deletable: !item.fixed,
6261-                editable: item.source === 'custom-user'
6262-            }));
6263-        }
6264-
6265-        function renderKanbanStructureList() {
6266-            if (!kanbanStructureList) return;
6267-
6268-            const structure = getRenderableKanbanStructure();
6269-            kanbanStructureList.innerHTML = '';
6270-            if (!structure.length) return;
6271-
6272-            const rows = [...structure].sort((left, right) => {
6273-                const orderDelta = (Number(left.order) || 0) - (Number(right.order) || 0);
6274-                return orderDelta || String(left.label || '').localeCompare(String(right.label || ''));
6275-            });
6276-
6277-            rows.forEach(item => {
6278-                const row = document.createElement('div');
6279-                row.className = `kanban-structure-item${item.fixed ? ' is-fixed' : ''}`;
6280-                row.dataset.id = item.id;
6281-                if (item.visible === false) {
6282-                    row.style.opacity = '0.6';
6283-                }
6284-
6285-                const handle = document.createElement('div');
6286-                handle.className = item.fixed ? 'kanban-structure-lock' : 'kanban-structure-handle';
6287-                handle.textContent = item.fixed ? '🔒' : '⋮⋮';
6288-
6289-                const label = document.createElement('div');
6290-                label.className = 'kanban-structure-item-label';
6291-                label.textContent = item.label;
6292-
6293-                const kind = document.createElement('div');
6294-                kind.className = 'kanban-structure-item-kind';
6295-                if (item.fixed) {
6296-                    kind.textContent = 'Fixed';
6297-                } else if (item.source === 'built-in') {
6298-                    kind.textContent = item.visible === false ? 'Hidden' : 'Built-in';
6299-                } else {
6300-                    kind.textContent = item.dragDropMode === 'prompt' ? 'Custom • Prompt' : 'Custom • CLI';
6301-                }
6302-
6303-                if (!item.fixed && item.visible !== false) {
6304-                    row.draggable = true;
6305-                    row.addEventListener('dragstart', () => { draggedKanbanStructureId = item.id; });
6306-                    row.addEventListener('dragend', () => {
6307-                        draggedKanbanStructureId = null;
6308-                        document.querySelectorAll('.kanban-structure-item.drag-over').forEach(n => n.classList.remove('drag-over'));
6309-                    });
6310-                    row.addEventListener('dragover', (e) => {
6311-                        e.preventDefault();
6312-                        if (draggedKanbanStructureId && draggedKanbanStructureId !== item.id) {
6313-                            row.classList.add('drag-over');
6314-                        }
6315-                    });
6316-                    row.addEventListener('dragleave', () => row.classList.remove('drag-over'));
6317-                    row.addEventListener('drop', (e) => {
6318-                        e.preventDefault();
6319-                        row.classList.remove('drag-over');
6320-                        if (!draggedKanbanStructureId || draggedKanbanStructureId === item.id) return;
6321-                        reorderVisibleKanbanStructure(draggedKanbanStructureId, item.id);
6322-                    });
6323-                }
6324-
6325-                const actions = document.createElement('div');
6326-                actions.style.cssText = 'display:flex; align-items:center; gap:6px; margin-left:8px;';
6327-
6328-                if (!item.fixed) {
6329-                    if (item.source === 'built-in') {
6330-                        const toggleBtn = document.createElement('button');
6331-                        toggleBtn.className = 'strip-btn';
6332-                        toggleBtn.style.cssText = 'width:auto; min-width:64px;';
6333-                        toggleBtn.textContent = item.visible === false ? 'SHOW' : 'HIDE';
6334-                        toggleBtn.onclick = () => {
6335-                            postKanbanMessage({ type: 'toggleKanbanColumnVisibility', id: item.id, visible: item.visible === false });
6336-                        };
6337-                        actions.appendChild(toggleBtn);
6338-                    } else if (item.source === 'custom-user') {
6339-                        const editBtn = document.createElement('button');
6340-                        editBtn.className = 'strip-btn';
6341-                        editBtn.style.cssText = 'width:auto; min-width:64px;';
6342-                        editBtn.textContent = 'EDIT';
6343-                        editBtn.onclick = () => openKanbanColumnModal(item);
6344-
6345-                        const deleteBtn = document.createElement('button');
6346-                        deleteBtn.className = 'strip-btn';
6347-                        deleteBtn.style.cssText = 'width:auto; min-width:72px;';
6348-                        deleteBtn.textContent = 'DELETE';
6349-                        deleteBtn.onclick = () => {
6350-                            lastCustomKanbanColumns = lastCustomKanbanColumns.filter(c => c.id !== item.id);
6351-                            renderKanbanStructureList();
6352-                            postKanbanMessage({ type: 'deleteKanbanColumn', id: item.id });
6353-                        };
6354-
6355-                        actions.appendChild(editBtn);
6356-                        actions.appendChild(deleteBtn);
6357-                    }
6358-                }
6359-
6360-                row.appendChild(handle);
6361-                row.appendChild(label);
6362-                row.appendChild(kind);
6363-                row.appendChild(actions);
6364-                kanbanStructureList.appendChild(row);
6365-            });
6366-        }
6367-
6368-        function reorderVisibleKanbanStructure(draggedId, targetId) {
6369-            const renderable = getRenderableKanbanStructure();
6370-            const middleIds = renderable.filter(item => !item.fixed && item.visible !== false).map(item => item.id);
6371-            const fromIndex = middleIds.indexOf(draggedId);
6372-            const toIndex = middleIds.indexOf(targetId);
6373-            if (fromIndex < 0 || toIndex < 0 || fromIndex === toIndex) return;
6374-
6375-            const nextSequence = [...middleIds];
6376-            const [movedId] = nextSequence.splice(fromIndex, 1);
6377-            nextSequence.splice(toIndex, 0, movedId);
6378-
6379-            postKanbanMessage({ type: 'updateKanbanStructure', sequence: nextSequence });
6380-        }
6381-
6382-        function saveKanbanColumnDraft() {
6383-            const label = kanbanColumnLabelInput.value.trim();
6384-            const role = kanbanColumnAssignedAgentInput.value.trim();
6385-            if (!label || !role) {
6386-                kanbanColumnError.textContent = 'Column label and assigned agent are required.';
6387-                return;
6388-            }
6389-
6390-            const existingId = editingKanbanColumnId || sanitizeKanbanColumnId(label);
6391-            const duplicate = lastCustomKanbanColumns.find(column =>
6392-                column.id !== existingId && column.label.toLowerCase() === label.toLowerCase()
6393-            );
6394-            if (duplicate) {
6395-                kanbanColumnError.textContent = 'Column labels must be unique.';
6396-                return;
6397-            }
6398-
6399-            const column = {
6400-                id: existingId,
6401-                label,
6402-                role,
6403-                triggerPrompt: kanbanColumnTriggerPromptInput.value.trim(),
6404-                dragDropMode: kanbanColumnDragDropModeInput.value === 'prompt' ? 'prompt' : 'cli'
6405-            };
6406-
6407-            lastCustomKanbanColumns = lastCustomKanbanColumns.filter(c => c.id !== column.id);
6408-            lastCustomKanbanColumns.push(column);
6409-
6410-            postKanbanMessage({ type: 'saveKanbanColumn', column });
6411-            renderKanbanStructureList();
6412-            closeKanbanColumnModal();
6413-        }
6414-
6415-        // Event listeners for kanban structure
6416-        document.getElementById('btn-add-kanban-column')?.addEventListener('click', () => openKanbanColumnModal());
6417-        document.getElementById('btn-save-kanban-column')?.addEventListener('click', saveKanbanColumnDraft);
6418-        document.getElementById('btn-cancel-kanban-column')?.addEventListener('click', closeKanbanColumnModal);
6419-        document.getElementById('btn-restore-kanban-defaults')?.addEventListener('click', () => {
6420-            const confirmed = window.confirm('Restore the default Kanban structure? This removes custom columns.');
6421-            if (!confirmed) return;
6422-            lastCustomKanbanColumns = [];
6423-            postKanbanMessage({ type: 'restoreKanbanDefaults' });
6424-            renderKanbanStructureList();
6425-        });
6426-
6427-        // Load kanban structure when setup tab is opened
6428-        kanbanTabButtons.forEach(btn => {
6429-            btn.addEventListener('click', () => {
6430-                if (btn.dataset.tab === 'setup' && kanbanStructureList) {
6431-                    postKanbanMessage({ type: 'getKanbanStructure' });
6432-                }
6433-            });
6434-        });
6435-        // ─── End Kanban Structure Configuration ────────────────────────────────────
6436-
6437-        // Signal to extension that webview is ready to receive data
6438-        postKanbanMessage({ type: 'ready' });
6439-        // ─── Dependency Tree Visualization ──────────────────────────────────────────
6440-
6441-        function extractReadableTitle(depId) {
6442-            if (depId.includes('/') || depId.endsWith('.md')) {
6443-                const filename = depId.split('/').pop();
6444-                const nameWithoutExt = filename.replace(/\.md$/, '');
6445-                return nameWithoutExt
6446-                    .replace(/[_-]/g, ' ')
6447-                    .replace(/([a-z])([A-Z])/g, '$1 $2')
6448-                    .replace(/\b\w/g, l => l.toUpperCase());
6449-            }
6450-            if (/^sess_\d+$/.test(depId)) {
6451-                return `Plan (${depId.slice(0, 12)}…)`;
6452-            }
6453-            return depId;
6454-        }
6455-
6456-        function renderDependencyTree(plans) {
6457-            const container = document.getElementById('dep-tree-container');
6458-            if (!container) return;
6459-
6460-            if (!plans || plans.length === 0) {
6461-                container.innerHTML = '<div class="empty-state">No plans in New or Planned columns. Create a plan to see dependencies here.</div>';
6462-                return;
6463-            }
6464-
6465-            const DEP_NODE_LIMIT = 50;
6466-            const html = [];
6467-            const planMap = new Map();
6468-            const planFileMap = new Map();
6469-            plans.forEach(p => {
6470-                planMap.set(p.sessionId, p);
6471-                if (p.planFile) {
6472-                    planFileMap.set(p.planFile, p);
6473-                }
6474-            });
6475-
6476-            // Detect cycles to highlight them
6477-            const cycles = detectCyclesForDeps(plans);
6478-
6479-            const renderPlan = (plan) => {
6480-                const isCreated = plan.kanbanColumn === 'CREATED';
6481-                const statusClass = isCreated ? 'created' : 'planned';
6482-                
6483-                const deps = (plan.dependencies || '').split(',').map(d => d.trim()).filter(Boolean);
6484-                const blockingDeps = deps.filter(d => planMap.has(d) || planFileMap.has(d));
6485-                const isBlocking = blockingDeps.length > 0;
6486-                const isCycling = cycles.has(plan.sessionId);
6487-                const blockingClass = (isBlocking || isCycling) ? 'blocking' : '';
6488-
6489-                const safeSessionId = escapeAttr(plan.sessionId);
6490-                const safeTopic = escapeHtml(plan.topic);
6491-                const safeTopicAttr = escapeAttr(plan.topic);
6492-                const safeColumn = escapeHtml(plan.kanbanColumn);
6493-
6494-                let planHtml = `
6495-                    <div class="plan-node ${statusClass} ${blockingClass}" data-session-id="${safeSessionId}" onclick="postKanbanMessage({ type: 'selectPlan', sessionId: '${safeSessionId}' })">
6496-                        <div class="plan-title" title="${safeTopicAttr}">${safeTopic}</div>
6497-                        <div class="plan-status-tag">${safeColumn}${isBlocking ? ' ⚠️ BLOCKED' : ''}${isCycling ? ' 🔄 CYCLE' : ''}</div>
6498-                    </div>
6499-                `;
6500-
6501-                if (deps.length > 0) {
6502-                    deps.forEach(depId => {
6503-                        const depPlan = planMap.get(depId) || planFileMap.get(depId);
6504-                        let depTitle;
6505-                        let clickAttr;
6506-                        
6507-                        if (depPlan) {
6508-                            depTitle = escapeHtml(depPlan.topic);
6509-                            clickAttr = `data-dep-session="${escapeAttr(depPlan.sessionId)}"`;
6510-                        } else {
6511-                            depTitle = extractReadableTitle(depId);
6512-                            // Only make path-like deps clickable
6513-                            if (depId.includes('/') || depId.endsWith('.md')) {
6514-                                clickAttr = `data-dep-path="${escapeAttr(depId)}"`;
6515-                            } else {
6516-                                clickAttr = '';
6517-                            }
6518-                        }
6519-                        
6520-                        const clickClass = clickAttr ? 'dep-link' : '';
6521-                        planHtml += `
6522-                            <div class="dep-connector">
6523-                                <span class="${clickClass}" style="font-size: 10px; color: var(--text-secondary);" ${clickAttr}>Depends on: ${escapeHtml(depTitle)}</span>
6524-                            </div>
6525-                        `;
6526-                    });
6527-                }
6528-                return planHtml;
6529-            };
6530-
6531-            const displayPlans = plans.length > DEP_NODE_LIMIT ? plans.slice(0, DEP_NODE_LIMIT) : plans;
6532-
6533-            html.push('<div class="dep-tree">');
6534-            displayPlans.forEach(plan => {
6535-                html.push(renderPlan(plan));
6536-            });
6537-            if (plans.length > DEP_NODE_LIMIT) {
6538-                html.push(`<div class="empty-state" style="text-align:center; padding:10px;">Showing ${DEP_NODE_LIMIT} of ${plans.length} plans. <button class="strip-btn" onclick="_depShowAll()" style="font-size:10px; padding:2px 8px;">Show All</button></div>`);
6539-            }
6540-            html.push('</div>');
6541-
6542-            container.innerHTML = html.join('');
6543-
6544-            container.onclick = function(e) {
6545-                const target = e.target.closest('[data-dep-session], [data-dep-path]');
6546-                if (!target) return;
6547-                if (target.dataset.depSession) {
6548-                    postKanbanMessage({ type: 'selectPlan', sessionId: target.dataset.depSession });
6549-                } else if (target.dataset.depPath) {
6550-                    postKanbanMessage({ type: 'openPlanByPath', planPath: target.dataset.depPath });
6551-                }
6552-            };
6553-
6554-            // Expose full list for "Show All" button
6555-            window._depAllPlans = plans;
6556-            window._depShowAll = () => {
6557-                const c = document.getElementById('dep-tree-container');
6558-                if (!c) return;
6559-                const allHtml = ['<div class="dep-tree">'];
6560-                plans.forEach(plan => { allHtml.push(renderPlan(plan)); });
6561-                allHtml.push('</div>');
6562-                c.innerHTML = allHtml.join('');
6563-            };
6564-        }
6565-
6566-        function detectCyclesForDeps(plans) {
6567-            const adj = new Map();
6568-            plans.forEach(p => {
6569-                const deps = (p.dependencies || '').split(',').map(d => d.trim()).filter(Boolean);
6570-                // Only include edges to plans that exist in the current set
6571-                adj.set(p.sessionId, deps.filter(id => plans.some(q => q.sessionId === id)));
6572-            });
6573-
6574-            const visited = new Set();
6575-            const recStack = new Set();
6576-            const cycleNodes = new Set();
6577-
6578-            function dfs(u) {
6579-                visited.add(u);
6580-                recStack.add(u);
6581-
6582-                const deps = adj.get(u) || [];
6583-                for (const v of deps) {
6584-                    if (!visited.has(v)) {
6585-                        dfs(v);
6586-                    } else if (recStack.has(v)) {
6587-                        cycleNodes.add(u);
6588-                        cycleNodes.add(v);
6589-                    }
6590-                }
6591-
6592-                recStack.delete(u);
6593-            }
6594-
6595-            for (const planId of adj.keys()) {
6596-                if (!visited.has(planId)) {
6597-                    dfs(planId);
6598-                }
6599-            }
6600-            return cycleNodes;
6601-        }
6602-
6603-        function renderUATChecklist(plans) {
6604-            const container = document.getElementById('uat-checklist-container');
6605-            if (!container) return;
6606-
6607-            if (!plans || plans.length === 0) {
6608-                container.innerHTML = '<div class="empty-state">No plans in CODE REVIEWED or ACCEPTANCE TESTED columns with manual verification steps.</div>';
6609-                return;
6610-            }
6611-            let html = '';
6612-            for (const plan of plans) {
6613-                html += `<div class="uat-plan-section" data-session-id="${escapeAttr(plan.sessionId)}">`;
6614-                html += `<div class="uat-plan-title">${escapeHtml(plan.topic)} <span style="color:var(--text-secondary); font-size:9px;">(${escapeHtml(plan.kanbanColumn)})</span></div>`;
6615-                if (plan.steps && plan.steps.length > 0) {
6616-                    for (let i = 0; i < plan.steps.length; i++) {
6617-                        const step = plan.steps[i];
6618-                        const checked = step.checked ? 'checked' : '';
6619-                        const checkedClass = step.checked ? ' checked' : '';
6620-                        html += `<div class="uat-step${checkedClass}">
6621-                            <input type="checkbox" data-session-id="${escapeAttr(plan.sessionId)}" data-step-index="${i}" ${checked} />
6622-                            <span class="uat-step-text">${escapeHtml(step.text)}</span>
6623-                        </div>`;
6624-                    }
6625-                } else {
6626-                    html += '<div class="uat-no-steps">No manual verification steps defined</div>';
6627-                }
6628-                html += '</div>';
6629-            }
6630-            container.innerHTML = html;
6631-
6632-            // Attach checkbox listeners
6633-            container.querySelectorAll('input[type="checkbox"]').forEach(cb => {
6634-                cb.addEventListener('change', (e) => {
6635-                    const sessionId = e.target.dataset.sessionId;
6636-                    const stepIndex = parseInt(e.target.dataset.stepIndex, 10);
6637-                    const checked = e.target.checked;
6638-                    // Update visual state
6639-                    const stepDiv = e.target.closest('.uat-step');
6640-                    if (stepDiv) {
6641-                        stepDiv.classList.toggle('checked', checked);
6642-                    }
6643-                    // Persist to extension host
6644-                    postKanbanMessage({
6645-                        type: 'setUATCheckState',
6646-                        sessionId,
6647-                        stepIndex,
6648-                        checked
6649-                    });
6650-                });
6651-            });
6652-        }
6653-
6654-        // Add listeners for the dependencies tab buttons
6655-        window.addEventListener('DOMContentLoaded', () => {
6656-            const btnCopyDepsPrompt = document.getElementById('btn-copy-deps-prompt');
6657-            const btnRebuildDeps = document.getElementById('btn-rebuild-deps');
6658-            const btnRefreshDeps = document.getElementById('btn-refresh-deps');
6659-
6660-            if (btnCopyDepsPrompt) {
6661-                btnCopyDepsPrompt.addEventListener('click', () => {
6662-                    btnCopyDepsPrompt.disabled = true;
6663-                    const originalText = btnCopyDepsPrompt.textContent;
6664-                    btnCopyDepsPrompt.textContent = 'LOADING...';
6665-                    postKanbanMessage({ type: 'getDependencyMapData', copyPrompt: true });
6666-                });
6667-            }
6668-
6669-            if (btnRebuildDeps) {
6670-                btnRebuildDeps.addEventListener('click', () => {
6671-                    btnRebuildDeps.disabled = true;
6672-                    const originalText = btnRebuildDeps.textContent;
6673-                    btnRebuildDeps.textContent = 'SENDING...';
6674-                    postKanbanMessage({ type: 'rebuildDependencyMap' });
6675-                    
6676-                    // Reset button after 30s timeout or we can wait for a message back
6677-                    setTimeout(() => {
6678-                        btnRebuildDeps.disabled = false;
6679-                        btnRebuildDeps.textContent = originalText;
6680-                    }, 30000);
6681-                });
6682-            }
6683-
6684-            if (btnRefreshDeps) {
6685-                btnRefreshDeps.addEventListener('click', () => {
6686-                    postKanbanMessage({ type: 'getDependencyMapData' });
6687-                });
6688-            }
6689-
6690-            const btnRefreshUAT = document.getElementById('btn-refresh-uat');
6691-            if (btnRefreshUAT) {
6692-                btnRefreshUAT.addEventListener('click', () => {
6693-                    postKanbanMessage({ type: 'getUATData' });
6694-                });
6695-            }
6696-        });
6697-
6698-    </script>
