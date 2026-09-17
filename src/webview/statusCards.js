// ── Structured card renderer — ONE module, three surfaces ───────────────────
//
// Lead instructions and member reports reach the board through the CLI, so the
// board already holds them. This module is the single place that turns one of
// those payloads into DOM, consumed by:
//
//   * the dock Agent panel        (dock.js, dock.html)
//   * the mobile command surface  (command.js, command.html)
//   * the seat status pane        (terminals.js, terminals.html)
//
// A third copy of this renderer is the thing this module exists to prevent, so
// nothing else under src/webview/ may define a card renderer. The matching
// stylesheet is statusCards.css — also shared, also loaded by all three
// surfaces, and the only place the card's colours are written (as theme tokens;
// never a literal, so both the default Afterburner theme and body.theme-claudify
// resolve it).
//
// The schema is CLOSED and validated on arrival. A payload whose `type` is not
// one of CARD_TYPES — or a report whose `kind` is not one of REPORT_KINDS —
// renders as plain text rather than vanishing, because a card drawn from a
// guessed shape is a fabricated fact on a surface whose whole contract is that
// it shows what was DECLARED.
(function () {
    'use strict';

    /** The closed card-type set. `report` is a member/seat declaration; an
     *  `instruction` is a lead's directive to a seat. Anything else is not a
     *  card this renderer knows and degrades to plain text. */
    const CARD_TYPES = ['report', 'instruction'];

    /** The declared-report vocabulary. Mirrors the seat-report inbox
     *  (agentPromptBuilder.ts standing-order fragment) and the turn-end report
     *  `action` (ScheduledJobsService.recordTurnEndEvent). */
    const REPORT_KINDS = ['finished', 'blocked', 'question', 'status'];

    function isFiniteStamp(ms) {
        return typeof ms === 'number' && Number.isFinite(ms) && ms > 0;
    }

    /** "4m ago" / "just now"; '' for a missing or unreadable stamp so the caller
     *  omits the line rather than printing a made-up age. Same wording the seat
     *  status pane already uses for its host-derived signals. */
    function relativeStamp(ms) {
        if (!isFiniteStamp(ms)) { return ''; }
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

    function el(tag, className, text) {
        const node = document.createElement(tag);
        if (className) { node.className = className; }
        if (text !== undefined && text !== null && text !== '') { node.textContent = String(text); }
        return node;
    }

    /** Validate and shape one raw payload into a card record. NEVER returns null:
     *  anything unrecognised becomes `{ type: 'text', text }`, so a bad payload
     *  is shown as plain text instead of disappearing. */
    function normalise(raw) {
        if (raw === null || raw === undefined) { return { type: 'text', text: '' }; }
        if (typeof raw === 'string') { return { type: 'text', text: raw }; }
        if (typeof raw !== 'object') { return { type: 'text', text: String(raw) }; }

        const type = String(raw.type || '');
        const text = typeof raw.text === 'string' ? raw.text : '';
        const from = typeof raw.from === 'string' ? raw.from : '';
        const planTitle = typeof raw.planTitle === 'string' ? raw.planTitle : '';
        const created = isFiniteStamp(raw.created) ? raw.created : 0;

        if (type === 'report') {
            const kind = String(raw.kind || '').toLowerCase();
            // A report with an unrecognised kind is not a declaration this
            // renderer knows how to label — degrade to plain text rather than
            // showing it under a guessed chip.
            if (!REPORT_KINDS.includes(kind)) {
                return { type: 'text', text: text || kind };
            }
            return { type: 'report', kind, from, text, created, planTitle };
        }
        if (type === 'instruction') {
            return { type: 'instruction', from, text, created, planTitle };
        }
        return { type: 'text', text };
    }

    /** Build one card element. Emits class names ONLY — never a `style`
     *  attribute — because an inline style cannot be re-themed by a
     *  `body.theme-claudify` selector without `!important`, which is the
     *  hardcoding this module forbids. */
    function createCard(raw) {
        const card = normalise(raw);
        const root = el('div', 'sb-card sb-card--' + card.type);
        root.dataset.cardType = card.type;

        if (card.type === 'text') {
            root.appendChild(el('div', 'sb-card__body', card.text));
            return root;
        }

        const head = el('div', 'sb-card__head');
        const isReport = card.type === 'report';
        head.appendChild(el('span', 'sb-card__chip is-' + (isReport ? card.kind : 'instruction'), isReport ? card.kind : 'instruction'));

        const metaBits = [];
        if (card.from) { metaBits.push('from ' + card.from); }
        const when = relativeStamp(card.created);
        if (when) { metaBits.push(when); }
        if (metaBits.length) { head.appendChild(el('span', 'sb-card__meta', metaBits.join(' · '))); }
        root.appendChild(head);

        if (card.planTitle) { root.appendChild(el('div', 'sb-card__plan', card.planTitle)); }
        if (card.text) { root.appendChild(el('div', 'sb-card__body', card.text)); }
        return root;
    }

    /** Render a list of payloads into `container`, replacing its children. */
    function renderInto(container, cards) {
        if (!container) { return; }
        container.textContent = '';
        const list = Array.isArray(cards) ? cards : [];
        for (const raw of list) { container.appendChild(createCard(raw)); }
    }

    /** Adapt a turn-end report row (`GET /kanban/reports`) to a card payload.
     *  Shared so the three surfaces cannot disagree about how a `turn_end` event
     *  becomes a card. `action` is the closed `finished`/`blocked` vocabulary. */
    function fromTurnEnd(row) {
        const created = Date.parse((row && row.timestamp) || '');
        return {
            type: 'report',
            kind: String((row && row.action) || '').toLowerCase(),
            text: row && typeof row.message === 'string' ? row.message : '',
            created: Number.isFinite(created) ? created : 0,
            planTitle: row && typeof row.planTopic === 'string' ? row.planTopic : '',
        };
    }

    window.SwitchboardStatusCards = {
        CARD_TYPES,
        REPORT_KINDS,
        normalise,
        createCard,
        renderInto,
        relativeStamp,
        fromTurnEnd,
    };
})();
