// ── Controller console — the Agent panel's controller surface ───────────────
//
// The dock Agent tab and the mobile command surface are the SAME console; this
// module is the one implementation both mount, so the two panes cannot drift
// (plan: the-agent-panel-becomes-a-standing-controller, change 2). The static
// markup lives in dock.html and command.html under these ids; this module wires
// it.
//
// Everything shown about the controller is SECOND-HAND: the board renders what
// the controller last told it (its lease, its state, its report, its
// escalations) and says when that was. The panel never infers controller state,
// and it holds no model endpoint call of its own — judgement belongs to the
// controller.
//
// No confirmation dialog gates anything here, including disarm (CLAUDE.md).
(function () {
    'use strict';

    const IDS = {
        state: 'agent-controller-state',
        when: 'agent-controller-when',
        where: 'agent-controller-where',
        arm: 'agent-controller-arm',
        disarm: 'agent-controller-disarm',
        run: 'agent-controller-run',
        status: 'agent-controller-status',
        rows: 'agent-controller-rows',
        configBody: 'agent-controller-config-body',
        report: 'agent-controller-report',
        escalations: 'agent-controller-escalations',
    };

    function el(id) { return document.getElementById(id); }

    async function jsonFetch(url, init) {
        try {
            const res = await fetch(url, Object.assign({ credentials: 'same-origin' }, init || {}));
            const data = await res.json().catch(() => null);
            return { ok: res.ok, status: res.status, data };
        } catch (err) {
            return { ok: false, status: 0, data: null, error: err && err.message ? err.message : String(err) };
        }
    }

    function relativeStamp(ms) {
        if (!Number.isFinite(ms) || ms <= 0) { return ''; }
        const delta = Date.now() - ms;
        if (delta < 0) { return 'just now'; }
        const secs = Math.round(delta / 1000);
        if (secs < 45) { return 'just now'; }
        const mins = Math.round(secs / 60);
        if (mins < 60) { return `${mins}m ago`; }
        const hours = Math.round(mins / 60);
        if (hours < 24) { return `${hours}h ago`; }
        return `${Math.round(hours / 24)}d ago`;
    }

    function setStatus(text, kind) {
        const node = el(IDS.status);
        if (!node) { return; }
        node.textContent = text || '';
        node.classList.remove('is-error', 'is-ok');
        if (kind === 'error') { node.classList.add('is-error'); }
        else if (kind === 'ok') { node.classList.add('is-ok'); }
    }

    /**
     * The four arming states, never collapsed (change 6). `unreadable` is an
     * alarm, distinct from `no controller configured`.
     */
    function armingState(lease) {
        if (!lease || lease.available === false) {
            return { key: 'unreadable', label: 'controller state unreadable', detail: (lease && lease.reason) || 'the lease store could not be read' };
        }
        if (!lease.holder) {
            return { key: 'none', label: 'no controller configured', detail: 'nothing has ever been armed on this board' };
        }
        if (lease.stale) {
            return { key: 'late', label: 'armed, controller late', detail: `lease expired ${relativeStamp(lease.expiresAt)} — the controller stopped reporting` };
        }
        return { key: 'healthy', label: 'armed, controller healthy', detail: `lease renewed ${relativeStamp(lease.renewedAt)}` };
    }

    function renderRows(rowsEl, stateView) {
        if (!rowsEl) { return; }
        rowsEl.textContent = '';
        const persisted = stateView && stateView.state ? stateView.state : null;
        const caps = persisted && persisted.capabilityAvailability && typeof persisted.capabilityAvailability === 'object'
            ? persisted.capabilityAvailability : null;
        if (!caps) {
            const line = document.createElement('div');
            line.className = 'agent-controller-row is-unavailable';
            line.textContent = 'row availability not reported yet — the controller has not completed a wake';
            rowsEl.appendChild(line);
            return;
        }
        const reasons = {
            model: 'no judgement backend configured — the mechanical rows still run',
            supervisor: 'no supervisor seat configured',
            twoProviders: 'fewer than two providers seated — reroute unavailable',
        };
        for (const key of Object.keys(caps)) {
            const row = document.createElement('div');
            row.className = 'agent-controller-row' + (caps[key] ? '' : ' is-unavailable');
            row.textContent = caps[key] ? `${key}: available` : `${key}: unavailable — ${reasons[key] || 'precondition unmet'}`;
            rowsEl.appendChild(row);
        }
    }

    function renderReport(reportEl, report) {
        if (!reportEl) { return; }
        if (!report || report.source === 'absent') {
            reportEl.textContent = 'The controller has not written a report yet.';
            return;
        }
        if (report.source === 'unreadable') {
            reportEl.textContent = `The report could not be read: ${report.reason || 'unknown error'}`;
            return;
        }
        reportEl.textContent = String(report.content || '');
    }

    function renderConfig(bodyEl, config, matrix, judgement) {
        if (!bodyEl) { return; }
        bodyEl.textContent = '';

        const intervalLabel = document.createElement('label');
        intervalLabel.className = 'agent-controller-field';
        intervalLabel.textContent = 'Wake interval (minutes) — applies on the next arm';
        const interval = document.createElement('input');
        interval.type = 'number';
        interval.min = '1';
        interval.id = 'agent-controller-interval';
        interval.value = config && config.value && config.value.intervalMinutes ? String(config.value.intervalMinutes) : '';
        intervalLabel.appendChild(interval);
        const intervalSave = document.createElement('button');
        intervalSave.type = 'button';
        intervalSave.id = 'agent-controller-interval-save';
        intervalSave.className = 'agent-controller-btn';
        intervalSave.textContent = 'Save interval';
        intervalSave.addEventListener('click', () => void saveConfig());
        bodyEl.appendChild(intervalLabel);
        bodyEl.appendChild(intervalSave);

        const matrixLabel = document.createElement('label');
        matrixLabel.className = 'agent-controller-field';
        matrixLabel.textContent = matrix && matrix.kind === 'configured'
            ? 'Solutions matrix (override) — JSON rows, saved to the board'
            : 'Solutions matrix — shipped default in force; save rows to override';
        const matrixArea = document.createElement('textarea');
        matrixArea.id = 'agent-controller-matrix';
        matrixArea.rows = 6;
        matrixArea.value = matrix && matrix.kind === 'configured' ? JSON.stringify(matrix.rows, null, 2) : '';
        matrixLabel.appendChild(matrixArea);
        bodyEl.appendChild(matrixLabel);
        const matrixSave = document.createElement('button');
        matrixSave.type = 'button';
        matrixSave.id = 'agent-controller-matrix-save';
        matrixSave.className = 'agent-controller-btn';
        matrixSave.textContent = 'Save matrix';
        matrixSave.addEventListener('click', () => void saveMatrix());
        bodyEl.appendChild(matrixSave);

        const judgementLabel = document.createElement('label');
        judgementLabel.className = 'agent-controller-field';
        judgementLabel.textContent = 'Judgement tiers, supervisor seat and ceiling';
        const judgementArea = document.createElement('textarea');
        judgementArea.id = 'agent-controller-judgement';
        judgementArea.rows = 5;
        judgementArea.value = judgement ? JSON.stringify(judgement, null, 2) : '{}';
        judgementLabel.appendChild(judgementArea);
        bodyEl.appendChild(judgementLabel);
        const judgementSave = document.createElement('button');
        judgementSave.type = 'button';
        judgementSave.id = 'agent-controller-judgement-save';
        judgementSave.className = 'agent-controller-btn';
        judgementSave.textContent = 'Save judgement config';
        judgementSave.addEventListener('click', () => void saveJudgement());
        bodyEl.appendChild(judgementSave);
    }

    function renderEscalations(escEl, escalations) {
        if (!escEl) { return; }
        escEl.textContent = '';
        const table = escalations && escalations.value ? escalations.value : null;
        const open = table && table.open ? Object.values(table.open) : [];
        const answered = table && table.answered ? Object.values(table.answered).slice(-5).reverse() : [];
        const heading = document.createElement('div');
        heading.className = 'agent-controller-row';
        heading.textContent = open.length
            ? `${open.length} open escalation(s) awaiting the supervisor`
            : 'no open escalations';
        escEl.appendChild(heading);
        for (const esc of open) {
            const card = document.createElement('div');
            card.className = 'agent-controller-escalation';
            const subject = document.createElement('div');
            subject.className = 'agent-controller-escalation-subject';
            subject.textContent = `${esc.subjectKey || 'subject'} — rule ${esc.ruleId || '?'}`;
            card.appendChild(subject);
            if (esc.reason) {
                const reason = document.createElement('div');
                reason.className = 'agent-controller-escalation-reason';
                reason.textContent = String(esc.reason);
                card.appendChild(reason);
            }
            escEl.appendChild(card);
        }
        for (const esc of answered) {
            const card = document.createElement('div');
            card.className = 'agent-controller-escalation is-answered';
            card.textContent = `${esc.subjectKey || 'subject'}: ${esc.verdict || esc.status || 'answered'}${esc.reason ? ' — ' + esc.reason : ''}`;
            escEl.appendChild(card);
        }
    }

    function create() {
        const stateEl = el(IDS.state);
        if (!stateEl) { return null; }
        let supervisorSeat = null;
        let lastConfig = null;
        let lastMatrix = null;

        async function saveConfig() {
            const input = el('agent-controller-interval');
            const value = input && input.value.trim() ? Number(input.value) : null;
            const res = await jsonFetch('/controller/config', {
                method: 'PUT', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ intervalMinutes: value }),
            });
            if (res.ok && res.data && res.data.success !== false) { setStatus('Wake interval saved — it applies on the next arm.', 'ok'); }
            else { setStatus('Interval not saved: ' + ((res.data && (res.data.reason || res.data.error)) || res.status), 'error'); }
            await refresh();
        }

        async function saveMatrix() {
            const area = el('agent-controller-matrix');
            if (!area) { return; }
            let rows;
            try { rows = JSON.parse(area.value); }
            catch (err) { setStatus('Matrix not saved — it is not valid JSON: ' + (err && err.message), 'error'); return; }
            const res = await jsonFetch('/controller/matrix', {
                method: 'PUT', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ rows }),
            });
            if (res.ok && res.data && res.data.success !== false) { setStatus('Matrix saved — the controller loads it on its next wake.', 'ok'); }
            else { setStatus('Matrix not saved: ' + ((res.data && (res.data.reason || res.data.error)) || res.status), 'error'); }
            await refresh();
        }

        async function saveJudgement() {
            const area = el('agent-controller-judgement');
            if (!area) { return; }
            let judgement;
            try { judgement = JSON.parse(area.value); }
            catch (err) { setStatus('Judgement config not saved — it is not valid JSON: ' + (err && err.message), 'error'); return; }
            const res = await jsonFetch('/controller/judgement', {
                method: 'PUT', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ judgement }),
            });
            if (res.ok && res.data && res.data.success !== false) { setStatus('Judgement config saved.', 'ok'); }
            else { setStatus('Judgement config not saved: ' + ((res.data && (res.data.reason || res.data.error)) || res.status), 'error'); }
            await refresh();
        }

        async function arm() {
            const res = await jsonFetch('/controller/arm', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
            if (res.ok && res.data && res.data.success !== false) { setStatus('Controller armed' + (res.data.pid ? ` (pid ${res.data.pid})` : '') + '.', 'ok'); }
            else { setStatus('Arm failed: ' + ((res.data && (res.data.reason || res.data.error)) || res.status), 'error'); }
            await refresh();
        }

        async function disarm() {
            const res = await jsonFetch('/controller/disarm', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
            if (res.data && res.data.success !== false) { setStatus(res.data.reason || 'Controller disarmed.', 'ok'); }
            else { setStatus('Disarm failed: ' + ((res.data && (res.data.reason || res.data.error)) || res.status), 'error'); }
            await refresh();
        }

        async function runNow() {
            const res = await jsonFetch('/controller/run', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
            if (res.ok && res.data && res.data.success !== false) { setStatus('One pass started.', 'ok'); }
            else { setStatus('Run failed: ' + ((res.data && (res.data.reason || res.data.error)) || res.status), 'error'); }
        }

        async function reply() {
            const input = el('agent-controller-reply');
            const text = input && input.value.trim();
            if (!text) { setStatus('Type a reply for the supervisor seat first.', 'error'); return; }
            if (!supervisorSeat) { setStatus('No supervisor seat is configured — set one in the judgement config.', 'error'); return; }
            const res = await jsonFetch('/terminals/verb/ptySendPrompt', {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name: supervisorSeat, data: text, clearBeforePrompt: false }),
            });
            if (res.ok && res.data && res.data.success !== false) {
                input.value = '';
                setStatus(`Reply delivered to the supervisor seat '${supervisorSeat}'.`, 'ok');
            } else {
                setStatus('Reply not delivered: ' + ((res.data && (res.data.error || res.data.reason)) || res.status), 'error');
            }
        }

        async function refresh() {
            const [leaseRes, stateRes, configRes, matrixRes, judgementRes, reportRes, escRes] = await Promise.all([
                jsonFetch('/controller/lease'),
                jsonFetch('/controller/state'),
                jsonFetch('/controller/config'),
                jsonFetch('/controller/matrix'),
                jsonFetch('/controller/judgement'),
                jsonFetch('/controller/report'),
                jsonFetch('/controller/escalations'),
            ]);
            const lease = leaseRes.data && leaseRes.data.lease ? leaseRes.data.lease : null;
            const stateView = stateRes.data && stateRes.data.state ? stateRes.data.state : null;
            const config = configRes.data && configRes.data.config ? configRes.data.config : null;
            const matrix = matrixRes.data && matrixRes.data.matrix ? matrixRes.data.matrix : null;
            const judgement = judgementRes.data && judgementRes.data.judgement ? judgementRes.data.judgement : null;
            const report = reportRes.data && reportRes.data.report ? reportRes.data.report : null;
            const escalations = escRes.data && escRes.data.escalations ? escRes.data.escalations : null;

            const arming = armingState(lease);
            stateEl.textContent = arming.label;
            stateEl.dataset.state = arming.key;
            // A fourth state the label alone would hide: armed and healthy but
            // with no usable model, so only the mechanical rows run.
            const caps = stateView && stateView.state && stateView.state.capabilityAvailability;
            if (arming.key === 'healthy' && caps && caps.model === false) {
                stateEl.textContent = 'armed, model unreachable';
                stateEl.dataset.state = 'model';
            }

            const whenEl = el(IDS.when);
            if (whenEl) {
                const wokeAt = stateView && stateView.updatedAt ? stateView.updatedAt : (lease && lease.renewedAt ? lease.renewedAt : 0);
                whenEl.textContent = wokeAt ? `last woke ${relativeStamp(wokeAt)}` : 'no wake recorded';
            }
            const whereEl = el(IDS.where);
            if (whereEl) {
                const holder = lease && lease.holder ? lease.holder : 'nothing';
                whereEl.textContent = `target: this board · holder: ${holder}${arming.detail ? ' · ' + arming.detail : ''}`;
            }

            supervisorSeat = judgement && typeof judgement.supervisorSeat === 'string' ? judgement.supervisorSeat : null;
            lastConfig = config;
            lastMatrix = matrix;
            renderRows(el(IDS.rows), stateView);
            renderConfig(el(IDS.configBody), config, matrix, judgement);
            renderReport(el(IDS.report), report);
            renderEscalations(el(IDS.escalations), escalations);
        }

        const armBtn = el(IDS.arm);
        const disarmBtn = el(IDS.disarm);
        const runBtn = el(IDS.run);
        if (armBtn) { armBtn.addEventListener('click', () => void arm()); }
        if (disarmBtn) { disarmBtn.addEventListener('click', () => void disarm()); }
        if (runBtn) { runBtn.addEventListener('click', () => void runNow()); }

        // Second-hand state that never goes stale is not second-hand state: a
        // controller that stops reporting must show as `late` with NO operator
        // action, so the console re-reads the board on its own clock.
        const pollTimer = setInterval(() => void refresh(), 15000);

        // Reply wiring is created here so both panes get the same control.
        const escEl = el(IDS.escalations);
        if (escEl) {
            const replyInput = document.createElement('textarea');
            replyInput.id = 'agent-controller-reply';
            replyInput.className = 'agent-controller-reply';
            replyInput.rows = 2;
            replyInput.placeholder = 'Reply to the supervisor seat';
            const replyBtn = document.createElement('button');
            replyBtn.type = 'button';
            replyBtn.id = 'agent-controller-reply-send';
            replyBtn.className = 'agent-controller-btn';
            replyBtn.textContent = 'Send reply';
            replyBtn.addEventListener('click', () => void reply());
            escEl.parentNode.insertBefore(replyInput, escEl.nextSibling);
            escEl.parentNode.insertBefore(replyBtn, replyInput.nextSibling);
        }

        return { refresh, arm, disarm, runNow, reply, pollTimer };
    }

    window.SwitchboardControllerConsole = { create, IDS };
})();
