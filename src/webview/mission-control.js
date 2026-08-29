(function () {
    'use strict';

    const vscode = acquireVsCodeApi();
    const WS_ROOT = decodeURIComponent(document.body.dataset.initialWorkspaceRoot || '');
    const HOST_CAPS = (() => {
        try { return JSON.parse(document.body.dataset.hostCapabilities || '{}'); }
        catch { return {}; }
    })();

    /* ═══════════════════════════════════════════════════════════════════
       Schedule action catalogue — classes carried as DATA, not as render
       branching. needsColumns / needsComplexity / needsArtifactsFolder /
       needsTerminal are the four field groups keyed on action class. A
       matrix test asserts the rendered fields equal the declared classes,
       not the markup. See the plan's "Complex / Risky" audit.
       ═══════════════════════════════════════════════════════════════════ */
    const SCHEDULE_ACTIONS = [
        { id: 'advance-plan',          label: 'Advance plan',                                                                   needsColumns: true,  needsComplexity: false, needsArtifactsFolder: false, needsTerminal: false, isBoard: true,  planner: false },
        { id: 'phone-a-friend',        label: 'Phone a friend on a coded plan (skips features)',                                needsColumns: true,  needsComplexity: false, needsArtifactsFolder: false, needsTerminal: false, isBoard: true,  planner: false },
        { id: 'advance-feature',       label: 'Advance feature (goes to a team if configured)',                                  needsColumns: true,  needsComplexity: false, needsArtifactsFolder: false, needsTerminal: false, isBoard: true,  planner: false },
        { id: 'batch-advance-planning',label: 'Batch advance to planning team',                                                 needsColumns: true,  needsComplexity: false, needsArtifactsFolder: false, needsTerminal: false, isBoard: true,  planner: true  },
        { id: 'review-code-vs-intent', label: 'Review code vs intent on CODE REVIEWED plans (last period), produce a doc',      needsColumns: false, needsComplexity: false, needsArtifactsFolder: true,  needsTerminal: true,  isBoard: false, planner: false },
        { id: 'process-memo',          label: 'Process memo',                                                                    needsColumns: false, needsComplexity: false, needsArtifactsFolder: false, needsTerminal: true,  isBoard: false, planner: true  },
        { id: 'improve-docs',          label: 'Improve docs',                                                                    needsColumns: false, needsComplexity: false, needsArtifactsFolder: false, needsTerminal: true,  isBoard: false, planner: true  },
        { id: 'update-readme',         label: 'Update readme',                                                                   needsColumns: false, needsComplexity: false, needsArtifactsFolder: false, needsTerminal: true,  isBoard: false, planner: false },
        { id: 'send-plans-to-jules',   label: 'Send plans to Jules',                                                             needsColumns: false, needsComplexity: true,  needsArtifactsFolder: false, needsTerminal: true,  isBoard: false, planner: false },
        { id: 'start-ready-mission',   label: 'Start a ready mission',                                                           needsColumns: false, needsComplexity: false, needsArtifactsFolder: false, needsTerminal: false, isBoard: true,  planner: false },
        { id: 'research',              label: 'Research (requires a research terminal)',                                         needsColumns: false, needsComplexity: false, needsArtifactsFolder: true,  needsTerminal: true,  isBoard: false, planner: true  },
        { id: 'git-pull-push',         label: 'Git pull/push',                                                                   needsColumns: false, needsComplexity: false, needsArtifactsFolder: false, needsTerminal: true,  isBoard: false, planner: false },
        { id: 'custom',                label: 'Custom',                                                                          needsColumns: false, needsComplexity: false, needsArtifactsFolder: false, needsTerminal: true,  isBoard: false, planner: false },
    ];

    /* The unattended standing order — three clauses every planner-class
       action carries when nobody is reading the reply. Appended to the
       prompt, not new machinery. See the plan's "unattended standing order". */
    const UNATTENDED_ORDER = [
        'This is an unattended task; user questions will not be answered.',
        'If user answers are required to proceed: move the plan back to CREATED with the open questions listed on it.',
        'If research is required but no researcher is available: move the plan back to CREATED with a note that the planning workflow is complete but needs uncertainty resolved.',
    ].join('\n');

    /* ── State ────────────────────────────────────────────────────────── */
    let missions = [];
    let schedules = [];
    let selectedMissionId = null;
    let selectedScheduleId = null;
    let statusFilter = 'all';
    let scheduleType = 'internal';   // 'internal' | 'external'
    let activeTab = 'missions';
    let controllerSeat = null;
    let controllerCollapsed = false;

    /* ── Tab switching ───────────────────────────────────────────────── */
    function switchTab(tabName) {
        activeTab = tabName;
        document.querySelectorAll('.shared-tab-btn').forEach(btn => {
            btn.classList.toggle('active', btn.dataset.tab === tabName);
        });
        document.querySelectorAll('.shared-tab-content').forEach(c => {
            c.classList.toggle('active', c.id === tabName + '-tab-content');
        });
    }
    document.querySelectorAll('.shared-tab-btn').forEach(btn => {
        btn.addEventListener('click', () => switchTab(btn.dataset.tab));
    });

    /* ── Sidebar collapse toggle ─────────────────────────────────────── */
    function wireCollapse(rowId) {
        const row = document.getElementById(rowId);
        if (!row) return;
        const btn = row.querySelector('.sidebar-toggle-btn');
        if (!btn) return;
        btn.addEventListener('click', () => row.classList.toggle('collapsed'));
    }
    wireCollapse('missions-content-row');
    wireCollapse('schedules-content-row');

    /* ── Status derivation (not stored) ─────────────────────────────────
       A mission's status is derived from the queue/board state, never
       stored on the mission itself — a stored copy drifts the first time a
       run dies unexpectedly ("in flight forever"). Until the backend
       derivation exists, the mission carries a `runState` hint from the
       host; absent that, it reads not-started. */
    function deriveMissionStatus(m) {
        if (!m) return 'not-started';
        if (m.runState === 'in-flight') return 'in-flight';
        if (m.runState === 'aborted') return 'aborted';
        if (m.runState === 'completed') return 'completed';
        return 'not-started';
    }

    function statusBadgeClass(status) {
        return ({ 'not-started': '', 'in-flight': 'is-active', 'aborted': 'is-aborted', 'completed': 'is-completed' })[status] || '';
    }

    /* ── Missions list rendering ─────────────────────────────────────── */
    function renderMissionsList() {
        const list = document.getElementById('missions-list');
        if (!list) return;
        const filtered = missions.filter(m => statusFilter === 'all' || deriveMissionStatus(m) === statusFilter);
        if (filtered.length === 0) {
            list.innerHTML = '<div class="mc-empty-state">No missions ' + (statusFilter === 'all' ? 'yet' : 'match this filter') + '. Use + NEW MISSION to create one.</div>';
            return;
        }
        list.innerHTML = '';
        for (const m of filtered) {
            const item = document.createElement('div');
            item.className = 'mc-list-item' + (m.id === selectedMissionId ? ' selected' : '');
            item.dataset.missionId = m.id;
            const status = deriveMissionStatus(m);
            const readyBadge = m.ready ? '<span class="mc-badge is-ready">READY</span>' : '';
            const statusBadge = '<span class="mc-badge ' + statusBadgeClass(status) + '">' + status.replace('-', ' ') + '</span>';
            item.innerHTML =
                '<div class="mc-list-item-title">' + _esc(m.goal || m.name || m.id) + '</div>' +
                '<div class="mc-list-item-sub">' +
                    '<span class="mc-badge">' + _esc(m.type || 'mission') + '</span>' +
                    statusBadge + readyBadge +
                '</div>';
            item.addEventListener('click', () => selectMission(m.id));
            list.appendChild(item);
        }
    }

    function selectMission(id) {
        selectedMissionId = id;
        renderMissionsList();
        renderMissionDetail();
        updateMissionControls();
    }

    /* ── Mission detail rendering ────────────────────────────────────── */
    function renderMissionDetail() {
        const detail = document.getElementById('missions-detail');
        if (!detail) return;
        const m = missions.find(x => x.id === selectedMissionId);
        if (!m) {
            detail.innerHTML = '<div class="mc-empty-state">Select a mission to view its detail.</div>';
            return;
        }
        const status = deriveMissionStatus(m);
        const features = (m.features || []).map(f => _chip(f, () => removeMissionMember('feature', f))).join('');
        const plans = (m.plans || []).map(p => _chip(p, () => removeMissionMember('plan', p))).join('');
        const sequencing = renderSequencing(m);
        const log = renderMissionLog(m);
        detail.innerHTML =
            '<div class="mc-detail-header">' +
                '<div><div class="mc-detail-title">' + _esc(m.goal || m.name || m.id) + '</div>' +
                '<div class="mc-detail-id">' + _esc(m.id) + '</div></div>' +
                '<span class="mc-badge ' + statusBadgeClass(status) + '">' + status.replace('-', ' ') + '</span>' +
            '</div>' +
            _field('Goal', '<textarea class="mc-textarea" id="mc-mission-goal">' + _esc(m.goal || '') + '</textarea>') +
            _fieldRow(
                _field('Type', '<select class="mc-select-field" id="mc-mission-type">' +
                    '<option value="mission"' + (m.type !== 'operation' ? ' selected' : '') + '>mission (unsupervised)</option>' +
                    '<option value="operation"' + (m.type === 'operation' ? ' selected' : '') + '>operation (supervised)</option></select>') +
                _field('Status (derived)', '<span class="mc-field-value">' + status + '</span>')
            ) +
            _field('Team', '<select class="mc-select-field" id="mc-mission-team"><option value="">—</option>' +
                (m.teams || []).map(t => '<option' + (m.team === t ? ' selected' : '') + '>' + _esc(t) + '</option>').join('') + '</select>') +
            _field('Max extra worktrees', '<input type="number" class="mc-input" id="mc-mission-worktrees" min="0" max="99" value="' + (m.maxExtraWorktrees ?? 0) + '" style="max-width:120px;">' +
                '<div style="font-size:10px;color:var(--text-secondary);margin-top:4px;">' + _worktreeHint(m.type) + '</div>') +
            _field('Features and plans', '<div class="mc-chip-list">' + features + plans +
                '<button class="mc-add-chip" id="mc-add-member">+ add</button></div>') +
            _field('Sequencing', sequencing) +
            _field('Log', log);

        // Wire goal editing
        const goalEl = document.getElementById('mc-mission-goal');
        if (goalEl) goalEl.addEventListener('change', () => updateMissionField('goal', goalEl.value));
        const typeEl = document.getElementById('mc-mission-type');
        if (typeEl) typeEl.addEventListener('change', () => updateMissionField('type', typeEl.value));
        const wtEl = document.getElementById('mc-mission-worktrees');
        if (wtEl) wtEl.addEventListener('change', () => updateMissionField('maxExtraWorktrees', parseInt(wtEl.value, 10) || 0));
        const addBtn = document.getElementById('mc-add-member');
        if (addBtn) addBtn.addEventListener('click', () => promptAddMember());
    }

    function _worktreeHint(type) {
        if (type === 'mission') return 'A mission may not exceed 1 extra worktree. 0 = stay in the starting tree.';
        return 'An operation may use more. 0 = stay in the starting tree.';
    }

    function renderSequencing(m) {
        const steps = m.sequencing;
        if (!steps || steps.length === 0) {
            return '<div class="mc-sequencing"><span class="mc-sequencing-default">Sequential (default — no stream map exists)</span></div>';
        }
        return '<div class="mc-sequencing">' + steps.map((s, i) =>
            '<div class="mc-sequencing-step"><span class="mc-sequencing-num">' + (i + 1) + '</span><span>' + _esc(s) + '</span></div>'
        ).join('') + '</div>';
    }

    function renderMissionLog(m) {
        const entries = m.log || [];
        if (entries.length === 0) return '<div class="mc-log"><span class="mc-sequencing-default">No events yet.</span></div>';
        return '<div class="mc-log">' + entries.map(e =>
            '<div class="mc-log-entry"><span class="mc-log-time">' + _esc(e.time || '') + '</span>' + _esc(e.text || '') + '</div>'
        ).join('') + '</div>';
    }

    function updateMissionControls() {
        const m = missions.find(x => x.id === selectedMissionId);
        const status = m ? deriveMissionStatus(m) : 'not-started';
        _setEnabled('mc-launch', !!m && m.ready && status === 'not-started');
        _setEnabled('mc-delete-mission', !!m && status !== 'in-flight');
        _setEnabled('mc-stop-mission', status === 'in-flight');
        _setEnabled('mc-ready-mission', !!m && !m.ready && status === 'not-started');
    }

    /* ── Schedules list rendering ────────────────────────────────────── */
    function renderSchedulesList() {
        const list = document.getElementById('schedules-list');
        if (!list) return;
        if (schedules.length === 0) {
            list.innerHTML = '<div class="mc-empty-state">No schedules yet. Use + NEW SCHEDULE to create one.</div>';
            return;
        }
        list.innerHTML = '';
        for (const s of schedules) {
            const item = document.createElement('div');
            item.className = 'mc-list-item' + (s.id === selectedScheduleId ? ' selected' : '');
            item.dataset.scheduleId = s.id;
            const typeBadge = '<span class="mc-badge">' + _esc(s.type || 'internal') + '</span>';
            const activeBadge = s.active ? '<span class="mc-badge is-active">ACTIVE</span>' : '<span class="mc-badge">OFF</span>';
            item.innerHTML =
                '<div class="mc-list-item-title">' + _esc(s.name || s.action || s.id) + '</div>' +
                '<div class="mc-list-item-sub">' + typeBadge + activeBadge +
                (s.schedule ? '<span class="mc-badge">' + _esc(s.schedule) + '</span>' : '') + '</div>';
            item.addEventListener('click', () => selectSchedule(s.id));
            list.appendChild(item);
        }
    }

    function selectSchedule(id) {
        selectedScheduleId = id;
        renderSchedulesList();
        renderScheduleDetail();
        updateScheduleControls();
    }

    /* ── Schedule detail rendering ───────────────────────────────────── */
    function renderScheduleDetail() {
        const detail = document.getElementById('schedules-detail');
        if (!detail) return;
        const s = schedules.find(x => x.id === selectedScheduleId);
        if (!s) {
            detail.innerHTML = '<div class="mc-empty-state">Select a schedule to view its detail.</div>';
            return;
        }
        const isExternal = (s.type || scheduleType) === 'external';
        const actionOptions = SCHEDULE_ACTIONS
            .filter(a => !isExternal || !a.isBoard)
            .map(a => '<option value="' + a.id + '"' + (s.action === a.id ? ' selected' : '') + '>' + _esc(a.label) + '</option>')
            .join('');
        const action = SCHEDULE_ACTIONS.find(a => a.id === (s.action || 'advance-plan')) || SCHEDULE_ACTIONS[0];

        detail.innerHTML =
            '<div class="mc-detail-header"><div><div class="mc-detail-title">' + _esc(s.name || s.action || s.id) + '</div>' +
            '<div class="mc-detail-id">' + _esc(s.id) + '</div></div></div>' +
            _field('Type', '<select class="mc-select-field" id="mc-sched-type">' +
                '<option value="internal"' + (!isExternal ? ' selected' : '') + '>internal</option>' +
                '<option value="external"' + (isExternal ? ' selected' : '') + '>external</option></select>') +
            (isExternal ? '' :
                _field('Time', '<select class="mc-select-field" id="mc-sched-time">' +
                    _timeOptions(s.schedule) + '</select>')) +
            _field('Action', '<select class="mc-select-field" id="mc-sched-action" ' +
                Object.entries({ needsColumns: action.needsColumns, needsComplexity: action.needsComplexity, needsArtifactsFolder: action.needsArtifactsFolder, needsTerminal: action.needsTerminal, isBoard: action.isBoard, planner: action.planner })
                    .map(([k, v]) => 'data-' + k + '="' + (v ? '1' : '0') + '"').join(' ') +
                '>' + actionOptions + '</select>') +
            // Conditional fields — shown/hidden by class data, not render branching
            _conditional('columns', action.needsColumns,
                _fieldRow(
                    _field('From column', '<select class="mc-select-field" id="mc-sched-from">' + _columnOptions(s.fromColumn) + '</select>') +
                    _field('To column', '<select class="mc-select-field" id="mc-sched-to">' + _columnOptions(s.toColumn) + '</select>'))) +
            _conditional('complexity', action.needsComplexity,
                _field('Complexity filters', '<input class="mc-input" id="mc-sched-complexity" placeholder="e.g. ≤6" value="' + _esc(s.complexityFilter || '') + '" style="max-width:160px;">')) +
            _conditional('artifacts', action.needsArtifactsFolder,
                _field('Artifacts folder', '<input class="mc-input" id="mc-sched-artifacts" value="' + _esc(s.artifactsFolder || '') + '" placeholder="/path/to/folder">')) +
            _conditional('terminal', action.needsTerminal && !isExternal,
                _field('Target terminal', '<select class="mc-select-field" id="mc-sched-terminal">' + _terminalOptions(s.targetTerminal) + '</select>')) +
            _conditional('prompt', action.needsTerminal,
                _field('Prompt', '<textarea class="mc-prompt-editor" id="mc-sched-prompt">' + _esc(s.prompt || _defaultPrompt(action)) + '</textarea>')) +
            (isExternal ?
                '<div class="mc-field"><button class="strip-btn is-teal" id="mc-copy-prompt" title="Copy the composed prompt to the clipboard — no local side effects">COPY PROMPT</button></div>' : '');

        // Wire type change
        const typeEl = document.getElementById('mc-sched-type');
        if (typeEl) typeEl.addEventListener('change', () => {
            scheduleType = typeEl.value;
            updateScheduleField('type', typeEl.value);
            renderScheduleDetail();
        });
        // Wire action change — re-render so conditional fields follow the class data
        const actionEl = document.getElementById('mc-sched-action');
        if (actionEl) actionEl.addEventListener('change', () => {
            const newAction = SCHEDULE_ACTIONS.find(a => a.id === actionEl.value) || SCHEDULE_ACTIONS[0];
            // Carry the new class data onto the element before re-render
            for (const [k, v] of Object.entries({ needsColumns: newAction.needsColumns, needsComplexity: newAction.needsComplexity, needsArtifactsFolder: newAction.needsArtifactsFolder, needsTerminal: newAction.needsTerminal, isBoard: newAction.isBoard, planner: newAction.planner })) {
                actionEl.setAttribute('data-' + k, v ? '1' : '0');
            }
            updateScheduleField('action', newAction.id);
            renderScheduleDetail();
        });
        const copyBtn = document.getElementById('mc-copy-prompt');
        if (copyBtn) copyBtn.addEventListener('click', () => copyExternalPrompt());

        const timeEl = document.getElementById('mc-sched-time');
        if (timeEl) timeEl.addEventListener('change', () => updateScheduleField('schedule', timeEl.value));
        const fromEl = document.getElementById('mc-sched-from');
        if (fromEl) fromEl.addEventListener('change', () => updateScheduleField('fromColumn', fromEl.value));
        const toEl = document.getElementById('mc-sched-to');
        if (toEl) toEl.addEventListener('change', () => updateScheduleField('toColumn', toEl.value));
        const compEl = document.getElementById('mc-sched-complexity');
        if (compEl) compEl.addEventListener('change', () => updateScheduleField('complexityFilter', compEl.value));
        const artEl = document.getElementById('mc-sched-artifacts');
        if (artEl) artEl.addEventListener('change', () => updateScheduleField('artifactsFolder', artEl.value));
        const termEl = document.getElementById('mc-sched-terminal');
        if (termEl) termEl.addEventListener('change', () => updateScheduleField('targetTerminal', termEl.value));
        const promptEl = document.getElementById('mc-sched-prompt');
        if (promptEl) promptEl.addEventListener('change', () => updateScheduleField('prompt', promptEl.value));
    }

    function _conditional(id, shown, inner) {
        return '<div class="mc-conditional' + (shown ? ' is-shown' : '') + '" data-cond="' + id + '">' + inner + '</div>';
    }

    function _timeOptions(selected) {
        const opts = ['every 5 min', 'every 10 min', 'every 15 min', 'every 30 min', 'hourly', 'every 2 hours', 'every 6 hours', 'daily', 'weekly', 'custom (cron)'];
        return opts.map(o => '<option' + (selected === o ? ' selected' : '') + '>' + o + '</option>').join('');
    }

    function _columnOptions(selected) {
        const cols = ['CREATED', 'CODING', 'CODE REVIEWED', 'REVIEWED', 'DONE', 'COMPLETED', 'STAGING'];
        return '<option value="">—</option>' + cols.map(c => '<option' + (selected === c ? ' selected' : '') + '>' + c + '</option>').join('');
    }

    function _terminalOptions(selected) {
        // Populated from the fleet when available; until then a free input fallback.
        const terms = (window.__sbFleet || []).map(t => t.name || t.friendlyName);
        const opts = terms.map(t => '<option' + (selected === t ? ' selected' : '') + '>' + _esc(t) + '</option>').join('');
        return '<option value="">—</option>' + opts + '<option value="__custom">custom…</option>';
    }

    function _defaultPrompt(action) {
        if (!action.needsTerminal) return '';
        // The wording is the deliverable for non-board actions. Planner-class
        // actions carry the unattended standing order.
        let base = '';
        switch (action.id) {
            case 'review-code-vs-intent': base = 'Review the code changes against the plan intent for plans in CODE REVIEWED in the last period. Produce a document summarising where intent was met and where it diverged.'; break;
            case 'process-memo':          base = 'Process the memo file: create one plan per entry.'; break;
            case 'improve-docs':          base = 'Improve the project documentation based on the current codebase state.'; break;
            case 'update-readme':         base = 'Update the project README to reflect the current state of the codebase.'; break;
            case 'send-plans-to-jules':   base = 'Send the selected plans to Jules for coding, respecting the complexity filters.'; break;
            case 'research':              base = 'Research the open questions on the selected plans and write findings to the artifacts folder.'; break;
            case 'git-pull-push':         base = 'Run git pull, then git push, resolving any conflicts.'; break;
            case 'custom':                base = ''; break;
            default:                      base = ''; break;
        }
        return action.planner ? base + '\n\n' + UNATTENDED_ORDER : base;
    }

    function copyExternalPrompt() {
        const promptEl = document.getElementById('mc-sched-prompt');
        const text = promptEl ? promptEl.value : '';
        // External type: Copy prompt only, no local side effects — no config
        // write, no scheduler change. The plan's "External" section.
        try {
            window.sbCopyToClipboard(text).then(() => {
                vscode.postMessage({ type: 'mcScheduleExternalCopy', scheduleId: selectedScheduleId, prompt: text });
            }).catch(() => {
                vscode.postMessage({ type: 'mcScheduleExternalCopy', scheduleId: selectedScheduleId, prompt: text });
            });
        } catch {
            vscode.postMessage({ type: 'mcScheduleExternalCopy', scheduleId: selectedScheduleId, prompt: text });
        }
    }

    function updateScheduleControls() {
        const s = schedules.find(x => x.id === selectedScheduleId);
        _setEnabled('mc-delete-schedule', !!s);
        _setEnabled('mc-start-schedule', !!s && !s.active && (s.type || scheduleType) === 'internal');
        _setEnabled('mc-stop-schedule', !!s && s.active && (s.type || scheduleType) === 'internal');
        _setEnabled('mc-schedule-logs', !!s);
    }

    /* ── Log view ────────────────────────────────────────────────────── */
    function showScheduleLogs() {
        const detail = document.getElementById('schedules-detail');
        if (!detail) return;
        const s = schedules.find(x => x.id === selectedScheduleId);
        if (!s) return;
        const asOf = new Date().toLocaleString();
        detail.innerHTML =
            '<div class="mc-detail-header"><div><div class="mc-detail-title">Logs — ' + _esc(s.name || s.id) + '</div></div>' +
            '<button class="strip-btn" id="mc-logs-back">← Back</button></div>' +
            '<div class="mc-log-asof">As of ' + _esc(asOf) + ' — this is a file render, not a live stream.</div>' +
            '<div class="mc-log-view">' + _esc(s.logContent || '(log file is empty or has not been written yet)') + '</div>';
        const back = document.getElementById('mc-logs-back');
        if (back) back.addEventListener('click', renderScheduleDetail);
        vscode.postMessage({ type: 'mcScheduleLoadLog', scheduleId: s.id });
    }

    /* ── Controller strip ────────────────────────────────────────────── */
    function setControllerSeat(seat) {
        controllerSeat = seat || null;
        const strip = document.getElementById('mc-controller-strip');
        const seatName = document.getElementById('mc-controller-seat-name');
        const frame = document.getElementById('mc-controller-frame');
        const empty = document.getElementById('mc-controller-empty');
        if (!strip) return;
        if (!controllerSeat) {
            strip.classList.add('is-hidden');
            if (frame) frame.src = '';
            if (seatName) seatName.textContent = '';
            return;
        }
        strip.classList.remove('is-hidden');
        if (seatName) seatName.textContent = controllerSeat;
        if (frame) {
            const url = '/terminals?solo=' + encodeURIComponent(controllerSeat);
            if (frame.getAttribute('src') !== url) { frame.src = url; }
            frame.style.display = '';
        }
        if (empty) empty.style.display = 'none';
        // Reveal scoped ops — the strip is a viewing context for the same
        // terminal, so btn-controller-* apply here too (one-controller plan).
        _setVisible('btn-controller-stop', true);
        _setVisible('btn-controller-restart', true);
        _setVisible('btn-controller-ack', true);
    }

    function collapseController(collapse) {
        controllerCollapsed = !!collapse;
        const strip = document.getElementById('mc-controller-strip');
        if (strip) strip.classList.toggle('is-collapsed', controllerCollapsed);
    }
    const collapseBtn = document.getElementById('mc-controller-collapse');
    if (collapseBtn) collapseBtn.addEventListener('click', () => collapseController(!controllerCollapsed));

    // Scoped ops — POST to the mission-control API endpoints.
    const stopBtn = document.getElementById('btn-controller-stop');
    if (stopBtn) stopBtn.addEventListener('click', () => {
        vscode.postMessage({ type: 'mcControllerStop' });
    });
    const restartBtn = document.getElementById('btn-controller-restart');
    if (restartBtn) restartBtn.addEventListener('click', () => {
        vscode.postMessage({ type: 'mcControllerRestart', seat: controllerSeat });
    });
    const ackBtn = document.getElementById('btn-controller-ack');
    if (ackBtn) ackBtn.addEventListener('click', () => {
        vscode.postMessage({ type: 'mcControllerAck' });
    });

    /* ── Global controls ─────────────────────────────────────────────── */
    const statusFilterEl = document.getElementById('mc-status-filter');
    if (statusFilterEl) statusFilterEl.addEventListener('change', () => {
        statusFilter = statusFilterEl.value;
        renderMissionsList();
    });

    function wireBtn(id, handler) {
        const el = document.getElementById(id);
        if (el) el.addEventListener('click', handler);
    }
    wireBtn('mc-new-mission', () => vscode.postMessage({ type: 'mcNewMission' }));
    wireBtn('mc-launch', () => { if (selectedMissionId) vscode.postMessage({ type: 'mcLaunchMission', missionId: selectedMissionId }); });
    wireBtn('mc-delete-mission', () => { if (selectedMissionId) vscode.postMessage({ type: 'mcDeleteMission', missionId: selectedMissionId }); });
    wireBtn('mc-stop-mission', () => { if (selectedMissionId) vscode.postMessage({ type: 'mcStopMission', missionId: selectedMissionId }); });
    wireBtn('mc-ready-mission', () => { if (selectedMissionId) vscode.postMessage({ type: 'mcReadyMission', missionId: selectedMissionId }); });
    wireBtn('mc-new-schedule', () => vscode.postMessage({ type: 'mcNewSchedule' }));
    wireBtn('mc-delete-schedule', () => { if (selectedScheduleId) vscode.postMessage({ type: 'mcDeleteSchedule', scheduleId: selectedScheduleId }); });
    wireBtn('mc-start-schedule', () => { if (selectedScheduleId) vscode.postMessage({ type: 'mcStartSchedule', scheduleId: selectedScheduleId }); });
    wireBtn('mc-stop-schedule', () => { if (selectedScheduleId) vscode.postMessage({ type: 'mcStopSchedule', scheduleId: selectedScheduleId }); });
    wireBtn('mc-schedule-logs', showScheduleLogs);

    function updateMissionField(field, value) {
        if (!selectedMissionId) return;
        // Enforce the worktree cap: a mission may not exceed 1 extra worktree.
        if (field === 'maxExtraWorktrees') {
            const m = missions.find(x => x.id === selectedMissionId);
            const type = (m && m.type) || 'mission';
            if (type === 'mission' && value > 1) { value = 1; }
        }
        vscode.postMessage({ type: 'mcUpdateMission', missionId: selectedMissionId, field, value });
    }
    function updateScheduleField(field, value) {
        if (!selectedScheduleId) return;
        vscode.postMessage({ type: 'mcUpdateSchedule', scheduleId: selectedScheduleId, field, value });
    }
    function removeMissionMember(kind, name) {
        if (!selectedMissionId) return;
        vscode.postMessage({ type: 'mcRemoveMissionMember', missionId: selectedMissionId, kind, name });
    }
    function promptAddMember() {
        // The host surfaces a picker; the panel does not implement its own modal.
        vscode.postMessage({ type: 'mcAddMissionMember', missionId: selectedMissionId });
    }

    /* ── Theme handling ──────────────────────────────────────────────── */
    function handleThemeChanged(theme) {
        document.body.classList.remove('theme-claudify', 'cyber-theme-enabled');
        if (theme === 'claudify') document.body.classList.add('theme-claudify');
        else if (theme === 'cyber' || theme === 'afterburner') document.body.classList.add('cyber-theme-enabled');
    }

    /* ── Inbound messages ────────────────────────────────────────────── */
    window.addEventListener('message', (e) => {
        const msg = e.data;
        if (!msg || typeof msg !== 'object') return;
        switch (msg.type) {
            case 'mcMissions':
                missions = Array.isArray(msg.missions) ? msg.missions : [];
                renderMissionsList();
                renderMissionDetail();
                updateMissionControls();
                break;
            case 'mcSchedules':
                schedules = Array.isArray(msg.schedules) ? msg.schedules : [];
                renderSchedulesList();
                renderScheduleDetail();
                updateScheduleControls();
                break;
            case 'mcScheduleLog':
                if (selectedScheduleId === msg.scheduleId) {
                    const view = document.querySelector('#schedules-detail .mc-log-view');
                    if (view) view.textContent = msg.content || '(empty)';
                    const asOf = document.querySelector('#schedules-detail .mc-log-asof');
                    if (asOf) asOf.textContent = 'As of ' + new Date().toLocaleString() + ' — this is a file render, not a live stream.';
                }
                break;
            case 'mcControllerSeat':
                setControllerSeat(msg.seat);
                break;
            case 'autobanStateSync':
            case 'updateAutobanConfig':
                // The autoban state rides the wsHub broadcast rail to every panel
                // (surface `common`), on connect AND on change. Reading it here is
                // what makes the controller strip work without a bespoke host
                // handler: `mcControllerSeat` has no sender, so without this the
                // strip could never appear.
                applyAutobanState(msg.state);
                break;
            case 'switchboardThemeChanged':
                handleThemeChanged(msg.theme);
                break;
            case 'panelVisibility':
                // The shell sends this on panel switch. The controller strip is
                // outside the tabbed area, so a tab switch never triggers this —
                // only a full panel switch does, which is the correct release
                // point for the pty size vote. No action needed here; the
                // terminals.js inside the iframe handles it.
                break;
            case 'fleetState':
                // Cache for the terminal dropdown options.
                window.__sbFleet = msg.fleet || [];
                break;
            case 'updateSchedulerConfig':
                applySchedulerConfig(msg.config);
                break;
            case 'terminalStatuses':
                // The live terminal roster, keyed by name. Used as the controller
                // fallback in applyAutobanState: the host can seat a `Mission Control`
                // terminal WITHOUT writing a seat record (a seat record is only
                // written by POST /mission-control/adopt), so a seat-only lookup
                // misses the ordinary Start path entirely.
                lastTerminalStatuses = (msg.terminals && typeof msg.terminals === 'object') ? msg.terminals : {};
                applyAutobanState(lastAutobanState);
                break;
        }
    });

    let lastAutobanState = null;
    let lastTerminalStatuses = {};

    /* ── Recurring jobs (survivors re-homed from the AUTOMATION tab + custom jobs) ──── */
    /** The two surviving preset recurring jobs. They ride the SCHEDULE clock — no interval
     *  of their own, because a second interval is a second clock — so with the
     *  schedule off neither runs. */
    const SURVIVOR_JOBS = [
        { source: 'fetch-plans', label: 'FETCH CLOUD PLANS', checkboxId: 'mc-job-fetch-plans' },
        { source: 'reconcile',   label: 'RECONCILE CLOUD WORK', checkboxId: 'mc-job-reconcile' },
    ];

    function applySchedulerConfig(config) {
        const cfg = (config && typeof config === 'object') ? config : { schemaVersion: 1, jobs: [] };
        window.__schedulerConfig = cfg;
        const jobs = Array.isArray(cfg.jobs) ? cfg.jobs : [];
        for (const sv of SURVIVOR_JOBS) {
            const el = document.getElementById(sv.checkboxId);
            if (!el) continue;
            const job = jobs.find(j => j && j.source === sv.source);
            el.checked = !!(job && job.enabled);
        }
        renderCustomJobs(jobs.filter(j => j && j.source === 'custom'));
    }

    function renderCustomJobs(customJobs) {
        const container = document.getElementById('mc-custom-jobs-list');
        if (!container) return;
        container.innerHTML = '';
        if (customJobs.length === 0) return;

        for (const job of customJobs) {
            const row = document.createElement('div');
            row.className = 'mc-custom-job-row';
            row.dataset.jobId = job.id;

            const enabledCheckbox = document.createElement('input');
            enabledCheckbox.type = 'checkbox';
            enabledCheckbox.checked = !!job.enabled;
            enabledCheckbox.title = 'Enable or disable this custom recurring prompt';
            enabledCheckbox.addEventListener('change', () => {
                updateCustomJob(job.id, { enabled: enabledCheckbox.checked });
            });

            const labelInput = document.createElement('input');
            labelInput.type = 'text';
            labelInput.className = 'mc-custom-job-label-input';
            labelInput.value = job.label || '';
            labelInput.placeholder = 'Job label';
            labelInput.addEventListener('change', () => {
                updateCustomJob(job.id, { label: labelInput.value.trim() || 'Custom Job' });
            });

            const promptTextarea = document.createElement('textarea');
            promptTextarea.className = 'mc-custom-job-prompt-input';
            promptTextarea.value = job.promptOverride || '';
            promptTextarea.placeholder = 'Prompt text (runs on schedule tick)...';
            promptTextarea.rows = 1;
            promptTextarea.addEventListener('change', () => {
                updateCustomJob(job.id, { promptOverride: promptTextarea.value });
            });

            const deleteBtn = document.createElement('button');
            deleteBtn.className = 'mc-custom-job-delete-btn';
            deleteBtn.textContent = 'DELETE';
            deleteBtn.title = 'Delete this custom job';
            deleteBtn.addEventListener('click', () => {
                deleteCustomJob(job.id);
            });

            row.appendChild(enabledCheckbox);
            row.appendChild(labelInput);
            row.appendChild(promptTextarea);
            row.appendChild(deleteBtn);
            container.appendChild(row);
        }
    }

    function updateCustomJob(jobId, changes) {
        const cfg = window.__schedulerConfig || { schemaVersion: 1, jobs: [] };
        const jobs = Array.isArray(cfg.jobs) ? cfg.jobs : [];
        const updated = jobs.map(j => {
            if (j && j.id === jobId) {
                return { ...j, ...changes };
            }
            return j;
        });
        window.__schedulerConfig = { schemaVersion: cfg.schemaVersion || 1, jobs: updated };
        vscode.postMessage({ type: 'setSchedulerConfig', config: window.__schedulerConfig });
    }

    function deleteCustomJob(jobId) {
        const cfg = window.__schedulerConfig || { schemaVersion: 1, jobs: [] };
        const jobs = Array.isArray(cfg.jobs) ? cfg.jobs : [];
        const updated = jobs.filter(j => j && j.id !== jobId);
        window.__schedulerConfig = { schemaVersion: cfg.schemaVersion || 1, jobs: updated };
        vscode.postMessage({ type: 'setSchedulerConfig', config: window.__schedulerConfig });
        renderCustomJobs(updated.filter(j => j && j.source === 'custom'));
    }

    function addCustomJob() {
        const cfg = window.__schedulerConfig || { schemaVersion: 1, jobs: [] };
        const jobs = Array.isArray(cfg.jobs) ? [...cfg.jobs] : [];
        const id = 'custom-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6);
        const newJob = {
            id,
            label: 'Custom Job',
            enabled: true,
            source: 'custom',
            target: 'local-terminal',
            intervalMinutes: 0,
            promptOverride: '',
            sourceConfig: {}
        };
        jobs.push(newJob);
        window.__schedulerConfig = { schemaVersion: cfg.schemaVersion || 1, jobs };
        vscode.postMessage({ type: 'setSchedulerConfig', config: window.__schedulerConfig });
        renderCustomJobs(jobs.filter(j => j && j.source === 'custom'));
    }

    function wireSurvivorJobs() {
        for (const sv of SURVIVOR_JOBS) {
            const el = document.getElementById(sv.checkboxId);
            if (!el) continue;
            el.addEventListener('change', () => {
                // UPSERT, not map. '+ ADD JOB' died with the scheduler surface, so this
                // checkbox is the only thing that can create the record — a map-only
                // toggle persists nothing on a config with no job of this source (every
                // fresh install) and the box snaps back on the next broadcast. The id is
                // derived from the source so it is stable and idempotent: it keys the
                // in-flight guard and the fetch-plans summary path.
                const cfg = window.__schedulerConfig || { schemaVersion: 1, jobs: [] };
                const jobs = Array.isArray(cfg.jobs) ? cfg.jobs : [];
                let found = false;
                const updated = jobs.map(j => {
                    if (j && j.source === sv.source) { found = true; return { ...j, enabled: el.checked }; }
                    return j;
                });
                if (!found) {
                    updated.push({
                        id: sv.source,
                        label: sv.label,
                        enabled: el.checked,
                        source: sv.source,
                        target: 'local-terminal',
                        intervalMinutes: 0,   // vestigial — the schedule is the clock
                        sourceConfig: {}
                    });
                }
                vscode.postMessage({ type: 'setSchedulerConfig', config: { schemaVersion: cfg.schemaVersion || 1, jobs: updated } });
            });
        }

        const addCustomBtn = document.getElementById('mc-add-custom-job');
        if (addCustomBtn) {
            addCustomBtn.addEventListener('click', () => {
                addCustomJob();
            });
        }
    }

    /* ── Autoban state → controller seat ─────────────────────────────── */
    /** Derives the controller strip from the broadcast autoban state. Tolerates a
     *  partial/absent state (the connect-time resync omits it entirely until the
     *  sidebar has relayed one).
     *
     *  This deliberately renders NO migration notice. `retiredAutomationModeNotice`,
     *  `recurringJobsResumedNotice` and `droppedCustomJobsNotice` stay as backend
     *  state, and no surface displays them. */
    function applyAutobanState(state) {
        if (!state || typeof state !== 'object') return;
        lastAutobanState = state;
        // The seat record names the terminal an agent adopted in place; when absent,
        // fall back to a live terminal carrying a controller role. These are the same
        // two sources the service-layer singleton guard consults, for the same reason:
        // an adopted controller carries neither the role nor the name, and an ordinary
        // Start writes the role but no seat record.
        let seat = state.missionControlSeat && state.missionControlSeat.terminalName;
        if (!seat) {
            for (const [name, t] of Object.entries(lastTerminalStatuses)) {
                if (!t || t.status !== 'active') continue;
                if (t.role === 'mission-control' || t.role === 'project_manager') {
                    seat = t.friendlyName || name;
                    break;
                }
            }
        }
        if (seat !== controllerSeat) { setControllerSeat(seat || null); }
    }

    /* ── Helpers ─────────────────────────────────────────────────────── */
    function _esc(s) {
        if (s == null) return '';
        return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }
    function _field(label, inner) {
        return '<div class="mc-field"><label class="mc-field-label">' + _esc(label) + '</label>' + inner + '</div>';
    }
    function _fieldRow(inner) { return '<div class="mc-field-row">' + inner + '</div>'; }
    function _chip(name, onRemove) {
        return '<span class="mc-chip">' + _esc(name) + '<span class="mc-chip-remove" data-name="' + _esc(name) + '">×</span></span>';
    }
    function _setEnabled(id, enabled) {
        const el = document.getElementById(id);
        if (el) el.disabled = !enabled;
    }
    function _setVisible(id, visible) {
        const el = document.getElementById(id);
        if (el) el.hidden = !visible;
    }

    /* ── Init ────────────────────────────────────────────────────────── */
    // Request initial state. The host (extension webview or browser transport)
    // replies with mcMissions / mcSchedules / mcControllerSeat.
    vscode.postMessage({ type: 'mcInit', workspaceRoot: WS_ROOT });
    // The two survivor recurring jobs. getSchedulerConfig is an existing, allowlisted
    // verb whose reply is `updateSchedulerConfig`; the host also pushes it on change.
    wireSurvivorJobs();
    vscode.postMessage({ type: 'getSchedulerConfig', workspaceRoot: WS_ROOT });
    // Gate the controller strip on the FLEET capability, which is what hosting a
    // terminal actually needs (`terminalFleet` tracks node-pty availability in both
    // hosts). It must NOT be gated on the `mission-control` capability: that flag
    // predates this panel, its only other consumer is a transport.js CSS rule
    // matching zero elements, and bootstrap.ts hardcodes it `false` — so gating on
    // it made the strip permanently invisible in the standalone/browser cockpit,
    // which is the narrow-viewport host the strip exists to serve.
    if (HOST_CAPS.terminalFleet === false) {
        const strip = document.getElementById('mc-controller-strip');
        if (strip) strip.classList.add('is-hidden');
    }
})();
