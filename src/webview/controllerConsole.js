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
// No confirmation dialog gates anything here (CLAUDE.md).
(function () {
    'use strict';

    const IDS = {
        state: 'agent-controller-state',
        when: 'agent-controller-when',
        where: 'agent-controller-where',
        arm: 'agent-controller-arm',
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

    /**
     * Capability rows, greyed with THEIR REASON — and the reason is the one the
     * controller reported, never a sentence composed here. A plausible
     * client-side reason is indistinguishable from a reported one, which is the
     * fallback rule applied to the surface itself; where the controller did not
     * report one, the row says the reason was not reported rather than
     * inventing the likeliest cause.
     */
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
        const detail = persisted && persisted.capabilityDetail && typeof persisted.capabilityDetail === 'object'
            ? persisted.capabilityDetail : {};
        for (const key of Object.keys(caps)) {
            const row = document.createElement('div');
            row.className = 'agent-controller-row' + (caps[key] ? '' : ' is-unavailable');
            const d = detail[key];
            const reason = d && typeof d.reason === 'string' && d.reason ? d.reason : '';
            const source = d && typeof d.source === 'string' && d.source ? ` (source: ${d.source})` : '';
            if (caps[key]) {
                row.textContent = `${key}: available${reason ? ' — ' + reason : ''}${source}`;
            } else {
                row.textContent = `${key}: unavailable — ${reason || 'reason not reported by the controller'}${source}`;
            }
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

    /**
     * True while the operator is typing into the config editor, or has typed
     * something they have not saved. The console re-reads the board every 15s so
     * `late` shows up with no operator action; rebuilding the editor on that
     * poll wiped whatever was half-typed into the matrix or judgement box, which
     * on a phone is the difference between "configurable from the panel" and
     * "not configurable at all".
     */




    function create() {
        const stateEl = el(IDS.state);
        if (!stateEl) { return null; }
        let supervisorSeat = null;




        async function arm() {
            const res = await jsonFetch('/controller/arm', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
            if (res.ok && res.data && res.data.success !== false) { setStatus('Controller armed' + (res.data.pid ? ` (pid ${res.data.pid})` : '') + '.', 'ok'); }
            else { setStatus('Arm failed: ' + ((res.data && (res.data.reason || res.data.error)) || res.status), 'error'); }
            await refresh();
        }


        async function runNow() {
            const res = await jsonFetch('/controller/run', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
            if (res.ok && res.data && res.data.success !== false) { setStatus('One pass started.', 'ok'); }
            else { setStatus('Run failed: ' + ((res.data && (res.data.reason || res.data.error)) || res.status), 'error'); }
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
            renderRows(el(IDS.rows), stateView);
            renderReport(el(IDS.report), report);
        }

        const armBtn = el(IDS.arm);
        const runBtn = el(IDS.run);
        if (armBtn) { armBtn.addEventListener('click', () => void arm()); }
        if (runBtn) { runBtn.addEventListener('click', () => void runNow()); }

        // Second-hand state that never goes stale is not second-hand state: a
        // controller that stops reporting must show as `late` with NO operator
        // action, so the console re-reads the board on its own clock.
        const pollTimer = setInterval(() => void refresh(), 15000);

        return { refresh, arm, runNow, pollTimer };
    }

    window.SwitchboardControllerConsole = { create, IDS };
})();
