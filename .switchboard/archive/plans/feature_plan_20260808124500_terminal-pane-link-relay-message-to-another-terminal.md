# "Link up" — a sidebar modal that instructs one agent terminal to message another

## Goal

Add a `LINK UP` button to the Terminals panel sidebar, directly beneath `SAVE AS GROUP`. It opens a modal with two terminal pickers — **parent** (the agent that will be instructed) and **child** (the terminal it will message) — plus a free-text instruction box. The parent picker defaults to the currently selected terminal, so the common case is one click, one target, and type.

On send, Switchboard composes the operator's instruction into a prompt and delivers it **into the parent terminal**, appending a concrete, copy-pasteable recipe for how that agent can push a message into the chosen child via the Switchboard HTTP API.

The operator is not messaging the child directly — they are *instructing the parent agent to message it*. That distinction is the whole feature: the parent holds the context worth handing over, and it is the only party that can decide what to send. Example instruction: *"hand over the context of this task to terminal 2"*.

This is a **sidebar-only** surface. No per-pane header button is added — see the Complexity Audit for why that alternative was rejected.

### Problem

Two agents sitting side by side in the Terminals panel have no way to talk to each other, and no way to be told to. Everything the panel can do to a terminal today is a fixed, parameterless command:

- `clear` → `POST /terminals/verb/ptyClearTerminal` (`src/webview/terminals.js:3973-3983`)
- `model` → `POST /terminals/verb/ptySendModel` (`src/webview/terminals.js:3986-3995`)
- kanban drag-drop → `POST /terminals/verb/ptySendPrompt` with a **board-generated** prompt (`src/webview/terminals.js:2229-2241`)

There is no path that carries **operator-authored** text into a terminal, and nothing anywhere tells an agent that a terminal-to-terminal channel exists at all. To hand context from `coder-1` to `reviewer-2` today the operator has to type the instruction into `coder-1` by hand, and then separately explain the HTTP call — which is undocumented in every agent-facing skill.

### Root cause (confirmed against the code)

Three separate gaps compose into "agents can't be told to talk to each other":

1. **No UI affordance, and no modal idiom in this panel.** The sidebar ops block (`terminals.html:1331-1338`) holds exactly three full-width `.secondary-btn`s — none takes an argument, so none has ever needed an input surface. `terminals.html` has **no modal of any kind**; the only overlay-ish surface is the inline `#role-picker` strip (`terminals.html:1322-1326`, CSS at `terminals.html:185-244`), and the only text-entry idiom is the in-place input swap used by `SAVE AS GROUP` (`terminals.js:547-571`) and inline rename (`terminals.js:3928-3949`). Neither can carry three fields.

2. **The transport already exists but is not addressable with operator text.** `ptySendPrompt` is served by both hosts (`src/standalone/bootstrap.ts:1257-1273`, `src/standalone/ptyHost.ts:188-210`) and routed on `/terminals/verb/` (`src/services/LocalApiServer.ts:3542-3544`). It takes `{ name, data }` and runs `sendPromptToPty` — bracketed-paste framing, 256-byte chunked writes, confirm `\r` for CLI agents (`src/standalone/ptyPromptDelivery.ts:21-54`). **No new verb is needed.** The webview simply never posts operator-authored `data` to it.

3. **Agents are never told the endpoint exists.** The only agent-facing HTTP hand-off documented anywhere in the codebase is the Researcher dispatch prose in `src/services/agentPromptBuilder.ts:749` (read `.switchboard/api-server-port.txt`, POST to `/research/dispatch`). Nothing in `.agents/skills/switchboard-orchestration/SKILL.md` or `switchboard-contracts/SKILL.md` mentions `ptySendPrompt`, `/terminals/verb/`, or terminal names as addresses. An agent asked to "hand over context to terminal 2" today has no idea how.

There is also a **live landmine** on the delivery path that this feature walks straight into: `sendPromptToPty` writes `/clear\r` and waits 2 s before the prompt when `clearBeforePrompt` is truthy (`ptyPromptDelivery.ts:26-31`), and both hosts arrange for that flag to be **`true` by default**:

- Extension host: `TaskViewerProvider._handleTerminalVerb`'s dispatch wrapper injects `switchboard.terminal.clearBeforePrompt` (default `true`) **only when the caller omitted the field** (`src/services/TaskViewerProvider.ts:2084-2095`). An explicit `false` from the caller survives, is forwarded to the pty-host child, and `ptyHost.ts:201` (`payload.clearBeforePrompt === true`) resolves it to `false`.
- Standalone host: `bootstrap.ts:1268` calls `sendPromptToPty(handle, payload.data || '', getPromptDeliveryOptions())` — it reads config (`bootstrap.ts:321-324`, default `true`) and **never looks at `payload.clearBeforePrompt` at all**.

A naive `{ name, data }` post therefore **wipes the parent agent's context immediately before instructing it to hand that context over** — the single most destructive possible bug for this feature. And on the standalone host it is not fixable from the webview: see the superseded callout in the Complexity Audit.

## Metadata

- **Complexity:** 6
- **Tags:** frontend, ui, ux, feature, api
- **Project:** Browser Switchboard

## User Review Required

None. Every open question in this plan is decided in it: sidebar-only surface (per-pane header alternative rejected below), no backdrop-click dismissal, no confirm gate, token delivered as an environment variable, and the standalone delivery-option override added as a first-class change rather than worked around in the webview.

## Complexity Audit

### Routine
- The delivery verb, its route, its auth check and its both-host implementations already exist and are covered by `src/test/pty-route-surface-contract.test.js`. This plan adds **no new verb**, so the catalog/allowlist isolation asserted at `pty-route-surface-contract.test.js:70-87` stays untouched and `npm run catalog:check` is unaffected.
- Both picker lists come from one in-memory array: `fleetList` (`terminals.js:104`, reassigned by `fetchTerminalList` at `terminals.js:816`) carries `friendlyName`, `role` and `status` for every terminal.
- The button is a fourth `.secondary-btn w-full` in an existing flex-column block — no layout work (`terminals.html:142-179`, `1331-1338`).
- The modal shape is a port, not an invention: `design.html`'s `.folder-modal` (CSS `design.html:2529-2620`, markup `design.html:4162-4170`) is the same-family browser panel and already has overlay + card + header + close-button + body. Port it wholesale, scoped as `.link-modal`, rather than hand-writing an "equivalent" — a hand-written stub lands on the wrong palette and dead theme classes while every gate stays green.
- Every CSS custom property the modal needs already exists in `terminals.html`: `--panel-bg` (25), `--panel-bg2` (26), `--border-color` (27), `--text-secondary` (30), `--state-readonly` (49). `color-mix(in srgb, …)` is already used in this file (`terminals.html:163`).
- The modal body needs **no** scrollbar CSS: the bare `::-webkit-scrollbar` block at `terminals.html:1231-1248` is unscoped and already applies to any scroller in the panel.

### Complex / Risky
- **`clearBeforePrompt` must be explicitly `false` — AND the standalone host must be taught to honour it.**

  > **Superseded:** "The post MUST send `clearBeforePrompt: false`; omitting it means the config default (`true`) applies in both hosts and the parent agent is `/clear`-ed before it is asked to hand over its context."
  > **Reason:** The first half is right and the second half is wrong in a way that inverts the feature on one of the two hosts. Sending `clearBeforePrompt: false` fixes the **extension host** only. `bootstrap.ts:1268` passes `getPromptDeliveryOptions()` to `sendPromptToPty` and never reads `payload.clearBeforePrompt` — the field is discarded before it reaches the delivery function, so under `npx switchboard` the parent is `/clear`-ed regardless of what the webview posts. The webview change alone therefore *appears* to fix the landmine (the field is visibly in the request body, the send returns `{"success":true}`) while the destructive behaviour is untouched on standalone. The same defect fires a second time when the parent agent runs the relay recipe: the child is `/clear`-ed too, so the handover arrives in an agent whose context was just wiped, and the recipe's own advice ("keep `clearBeforePrompt` false") is a lie on that host.
  > **Replaced with:** Two changes, both required. (1) The webview posts an explicit `clearBeforePrompt: false`. (2) `bootstrap.ts`'s `ptySendPrompt` arm honours an explicit boolean in the payload and falls back to `getPromptDeliveryOptions()` only when the field is `undefined` — matching the semantics `TaskViewerProvider.ts:2089` and `ptyHost.ts:201` already implement. See Proposed Change 6.

  The (2) change is strictly a superset of today's behaviour: every existing caller (the kanban drag-drop at `terminals.js:2229-2241`, and the `triggerAction` paths at `bootstrap.ts:1389/1423/1532`) omits the field and keeps the config default unchanged. No persisted state changes, so no migration is owed.

- **Standalone auth blocks the agent's follow-up call.** `_handleTerminalVerb` gates on `_checkAuth(req, true)` (`LocalApiServer.ts:1688-1691`). `_checkAuth` short-circuits to `true` when `getAuthToken()` returns empty (`LocalApiServer.ts:545-548`). Under the extension host that getter reads a VS Code secret with no setter UI — `this._context.secrets.get('switchboard.apiToken') || ''` (`TaskViewerProvider.ts:2122-2125`), confirmed "effectively always empty" by the note at `LocalApiServer.ts:578-580` → loopback trust → an unauthenticated `curl` from inside a PTY works. Under standalone, `getAuthToken` returns the always-set `sessionToken` (`bootstrap.ts:378`, wired at `bootstrap.ts:1634`) → the agent's `curl` gets **401**. The relay recipe is only truthful in one of the two hosts unless the token reaches the shell.
- **The secret must not enter the transcript.** Embedding the session token in the composed prompt writes it into the agent's scrollback *and* its conversation history, where it is retained and potentially uploaded. The token must reach the shell as an **environment variable**, never as prompt text. `PtyFleetService.create()` already has the injection point (`ptyFleetService.ts:147-158`), and its `{ ...process.env, ...switchboardEnv }` spread is load-bearing — a partial map replaces the whole environment.
- **The modal must out-stack the panel and not swallow its own error surface.** The highest existing `z-index` in `terminals.html` is `100` (`.toast-container`, `terminals.html:1160-1168`); `.pane-toast` is `40` (`terminals.html:792-808`). A `position: fixed` modal above both means `showPaneToast` failures render *behind* it. Failures must therefore surface **inline inside the modal**, and the modal closes only on success.
- **xterm eats keystrokes.** Every text input in this panel calls `e.stopPropagation()` on `keydown` (`terminals.js:3940-3944`) because the terminal viewport otherwise claims the event. The modal's textarea and any keyboard handling need the same treatment.
- **The composed shell recipe is a correctness surface, not prose.** It is the only part of this feature the operator cannot see fail — a broken heredoc or a word-split `curl` argument surfaces as "the agent tried and something went wrong". Both hazards are real in the first draft and are corrected in Proposed Change 5.

### Rejected alternative: a `link` button in each pane header
Considered and dropped in favour of the sidebar modal. It is worse on every axis that matters here:
- **It can only link terminals that are seated.** In a `1` layout with six live terminals, five of them are unreachable as a parent. The sidebar modal addresses the whole fleet regardless of layout.
- **The pane header is already full.** `createPaneElement` builds five buttons (`terminals.js:2355-2359`) into a header that, in the `2x3`/`3x3` layouts, is 10 px tall with an ellipsising title (`terminals.html:718-723`). A sixth control there is a genuine regression in dense layouts.
- **It drags in a whole class of known-dangerous churn.** `actionsEl.children[]` is index-addressed in two places — `updatePaneElement` reads `children[0..4]` (`terminals.js:2521-2530`) and `renderKanbanPane` reads `children[4]` (`terminals.js:2870-2873`). This file has already shipped one bug of exactly that class; see the comment at `terminals.js:2338-2343` describing the pin button being permanently corrupted by a `children[0]` overwrite. It would also land inside the source slice that `terminal-pane-pinning-contract.test.js:196-208` asserts on. None of that risk is incurred by a sidebar button.
- **Cost:** one extra selection (the parent), which the "default to the currently selected terminal" behaviour below removes in the common case.

## Edge-Case & Dependency Audit

- **No confirm gate, ever.** Per `CLAUDE.md`: Send fires immediately on click. `window.confirm()` is a silent no-op in VS Code webviews and this panel is browser-served anyway. Cancel / `×` / Escape are dismissals, not confirmation steps.
- **Do NOT close on backdrop click.** The modal holds typed text and there is no "discard changes?" gate available (and none is wanted). Close on `×`, Cancel, and Escape only — a stray backdrop click must not destroy a half-written instruction.
- **Parent defaults to the currently selected terminal, and can be wrong.** Resolve in order: `paneAssignments[focusedPaneIndex]` (the pane wearing `.focused`), then `activeTerminalName`, then the first `status === 'active'` entry in `fleetList`. `setFocusedPane` only writes `activeTerminalName` when the focused pane actually holds a terminal (`terminals.js:2037-2048`), so the focused pane can be empty while `activeTerminalName` still points at a live one — hence the two-step fallback. Every candidate must be re-checked against `fleetList` for `status === 'active'` before being used as the default; a stale default that silently targets a dead terminal is worse than no default.
- **Parent and child must differ.** Filter the child list to exclude the currently-chosen parent, and **re-filter it whenever the parent changes** — otherwise picking a parent that was already selected as the child leaves an agent instructed to message itself.
- **Fewer than two live terminals.** With no valid parent/child pair the modal has nothing to offer. Disable `LINK UP` (using the existing `.secondary-btn:disabled` rule at `terminals.html:167-170`) and give it a `title` explaining why, rather than opening an empty modal.
  - **Clarification — the disabled state needs a refresh hook.** The fleet is repopulated on every `fetchTerminalList` poll (`terminals.js:804-830`), so a `disabled` flag set once at boot goes stale the moment a second terminal spawns or the second-to-last one dies. Recompute it from `fleetList` inside `renderSidebarList()` (`terminals.js:1447`), which `fetchTerminalList` already calls on every successful poll. The `live.length < 2` guard inside `openLinkModal` stays as a belt-and-braces check.
- **Child dies between open and send.** `ptySendPrompt` validates the **parent** handle only — the child is just a name inside the prompt text. Re-validate the child (and the parent) against `fleetList` at send time and refuse with an inline error; a stale name sends the parent chasing a terminal that no longer exists.
- **Terminal names are not shell-safe.** Friendly names come from `role-N` generation but `rename()` accepts arbitrary text (`ptyFleetService.ts:262-274`). The composed `curl` recipe must build its JSON body with `python3` reading the name from `argv` and the message from a file — never by hand-quoting into a shell string. This is the same guidance `agentPromptBuilder.ts:749` already gives for the Researcher hand-off. Never interpolate a name straight into a shell double-quoted string.
- **Operator message is untrusted text going into a prompt.** It is typed by the local operator into their own agent, so this is not a privilege boundary — but it must not be able to break the prompt's structure. Deliver it inside a clearly delimited block and do not attempt to escape it; `sendPromptToPty`'s bracketed-paste framing already prevents line-by-line execution.
- **Empty message.** Disable Send while the textarea is blank rather than sending a bare recipe with no instruction.
- **Solo pop-outs cannot initiate a link.** `body.is-solo .terminals-sidebar { display: none !important; }` (`terminals.html:1287-1290`) hides the whole sidebar, so `LINK UP` is unreachable in a `?solo=<name>` window. Accepted trade-off: a solo pop-out is a deliberately stripped single-terminal view, and the cockpit window that spawned it still has the button. A solo window can still *receive* a relayed message — only initiation is unavailable.
- **Concurrent sends.** `withTerminalLock` (`ptyPromptDelivery.ts:9-14`) serialises per terminal name, so two rapid links to the same parent queue rather than interleave. No webview-side lock needed; a brief Send-button disable is cosmetic only.
- **Fleet refresh under an open modal.** `fetchTerminalList` reassigns `fleetList` on a poll (`terminals.js:816`). The modal reads it at open and at send; it does not need live re-rendering, but the send-time re-validation above is what makes a mid-modal fleet change safe.
- **Cookie credentials.** The panel's `fetch` calls use relative paths (`terminals.js:807, 2229, 3975, …`) and rely on `fetch`'s default `credentials: 'same-origin'` to carry the HttpOnly `sb_session` cookie that `_checkAuth` accepts (`LocalApiServer.ts:565-572`). The new call follows the same idiom — do **not** add `credentials: 'omit'` or an absolute URL, either of which would 401 the panel's own send under standalone.
- **Env var only reaches NEW terminals.** Adding `SWITCHBOARD_API_TOKEN` to `PtyFleetService.create()` affects terminals spawned after the change. Already-running standalone terminals keep 401-ing until respawned. Acceptable and worth a one-line note in the recipe. No migration is required: this is unreleased dev work on the PTY fleet, and no shipped on-disk state changes.
- **Persistence:** modal state is transient. Do **not** add it to `saveLayoutSettings()` (`terminals.js:790-802`) — that setting map is shared with ~4k installs' persisted layout and adding a key there would need a migration for nothing.
- **Scrollbar contract:** `browser-panel-scrollbar-contract.test.js` requires exactly one bare `::-webkit-scrollbar` rule per panel file. The existing bare block (`terminals.html:1231-1248`) already covers the modal body — do **not** add a second bare block.
- **Dependencies:** `src/webview/terminals.html`, `src/webview/terminals.js`, `src/standalone/ptyFleetService.ts`, `src/standalone/bootstrap.ts`. No DB change, no schema change, no new verb, no catalog regeneration, no `verbSchemas.ts` entry (pty verbs are not schema-validated — they are served by the dedicated `/terminals/verb/` route, not a provider switch), and **no change to `createPaneElement` / `updatePaneElement` / `renderKanbanPane`**.

## Dependencies

None. This plan depends on no other in-flight session.

## Adversarial Synthesis

**Risk Summary.** The dominant risk is a green-but-wrong outcome on the standalone host: `bootstrap.ts:1268` discards `payload.clearBeforePrompt`, so posting the field is visible in the request, returns `{"success":true}`, and still `/clear`s the parent — destroying the exact context the feature exists to hand over, and then doing it again to the child when the relay runs. Secondary risks are the composed shell recipe (an indented heredoc terminator never closes; a `${VAR:+…}` expansion carrying spaces word-splits into broken `curl` arguments), a `LINK UP` disabled flag that goes stale against the polled fleet, and an Escape handler scoped to an element that may not hold focus. Mitigations: teach `bootstrap.ts` to honour an explicit boolean (config default only when `undefined`); replace the heredoc/conditional-header recipe with an `argv` + message-file form and an unconditional `Authorization` header; recompute the disabled state inside `renderSidebarList()`; bind Escape at document level in the capture phase, guarded on modal visibility.

## Proposed Changes

### 1. `src/webview/terminals.html` — the button

Fourth entry in the existing `.sidebar-ops` block (`terminals.html:1331-1338`), same treatment as its siblings:

```html
<button type="button" id="btn-link-up" class="secondary-btn w-full"
        title="Instruct one agent terminal to send a message to another">LINK UP</button>
```

### 2. `src/webview/terminals.html` — modal markup + CSS

Markup goes at the end of `<body>`, as a sibling of `#terminals-main` (not inside a pane — the grid reflows on every layout change):

```html
<!-- Link-up modal. The panel's FIRST modal; shape ported from design.html's
     .folder-modal (CSS design.html:2529-2620, markup design.html:4162-4170)
     rather than hand-written, so it lands on the same palette and border
     treatment as the rest of the product.
     Hidden with the `hidden` attribute, matching #role-picker's idiom.
     NOT dismissed by a backdrop click — it holds typed text and there is no
     discard gate (and per CLAUDE.md there never will be one). -->
<div id="link-modal" class="link-modal" hidden>
    <div class="modal-content">
        <div class="modal-header">
            <h3>Link up</h3>
            <button type="button" class="modal-close-btn" id="link-modal-close" aria-label="Close">&times;</button>
        </div>
        <div class="modal-body">
            <label class="link-field-label" for="link-parent">Parent — the agent that will be instructed</label>
            <select id="link-parent" class="link-select"></select>

            <label class="link-field-label" for="link-child">Child — the terminal it will message</label>
            <select id="link-child" class="link-select"></select>

            <label class="link-field-label" for="link-message">Instruction</label>
            <textarea id="link-message" class="link-message"
                      placeholder="e.g. hand over the context of this task to terminal 2"></textarea>

            <div id="link-error" class="link-error" hidden></div>
        </div>
        <div class="modal-footer">
            <button type="button" id="link-cancel" class="secondary-btn">CANCEL</button>
            <button type="button" id="link-send" class="secondary-btn is-teal" disabled>SEND</button>
        </div>
    </div>
</div>
```

CSS, scoped as `.link-modal` so nothing leaks into the pane grid. `z-index: 200` clears the panel's current ceiling of `100` (`.toast-container`, `terminals.html:1160-1168`):

```css
.link-modal {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.6);
    display: flex;
    align-items: center;
    justify-content: center;
    /* Above .toast-container (100) and .pane-toast (40) — which is exactly why
       send failures render inline in .link-error rather than via showPaneToast:
       a toast raised from here would be painted behind this overlay. */
    z-index: 200;
}
/* MANDATORY. The UA `[hidden] { display: none }` rule is a plain author-level
   default and loses to the `display: flex` above; without this the modal is
   permanently visible. */
.link-modal[hidden] { display: none; }
.link-modal .modal-content {
    background: var(--panel-bg);
    border: 1px solid var(--border-color);
    border-radius: 8px;
    max-width: 480px; width: 90%; max-height: 80vh;
    display: flex; flex-direction: column;
    box-shadow: 0 8px 24px rgba(0, 0, 0, 0.4);
}
.link-modal .modal-header {
    display: flex; align-items: center; justify-content: space-between;
    padding: 14px 18px;
    border-bottom: 1px solid var(--border-color);
}
.link-modal .modal-header h3 {
    margin: 0; font-size: 13px; font-weight: 600;
    color: var(--text-primary);
    text-transform: uppercase; letter-spacing: 0.5px;
}
.link-modal .modal-close-btn {
    background: transparent; border: none; color: var(--text-secondary);
    font-size: 22px; cursor: pointer;
    width: 28px; height: 28px; border-radius: 4px;
    display: flex; align-items: center; justify-content: center;
}
.link-modal .modal-close-btn:hover { color: var(--text-primary); }
/* No ::-webkit-scrollbar rules here — the bare block at terminals.html:1231-1248
   is unscoped and already styles this scroller. A second bare rule would trip
   browser-panel-scrollbar-contract.test.js. */
.link-modal .modal-body { padding: 18px; overflow-y: auto; flex: 1; }
.link-modal .modal-footer {
    display: flex; gap: 8px; justify-content: flex-end;
    padding: 12px 18px;
    border-top: 1px solid var(--border-color);
}
.link-field-label {
    display: block;
    font-size: 10px; text-transform: uppercase; letter-spacing: 0.05em;
    color: var(--text-secondary);
    margin: 12px 0 4px;
}
.link-field-label:first-child { margin-top: 0; }
.link-select, .link-message {
    width: 100%;
    background: var(--panel-bg2);
    border: 1px solid var(--border-color);
    color: var(--text-primary);
    font-family: inherit; font-size: 11px;
    padding: 6px; border-radius: 3px;
}
.link-message { min-height: 72px; resize: vertical; }
.link-error {
    margin-top: 10px; padding: 6px 8px; border-radius: 3px;
    font-size: 11px;
    color: var(--state-readonly, #e06c75);
    background: color-mix(in srgb, var(--state-readonly, #e06c75) 12%, transparent);
}
.link-error[hidden] { display: none; }
```

### 3. `src/webview/terminals.js` — open, default, and wire

Alongside the other sidebar-ops handlers (`terminals.js:526-571`):

```js
const btnLinkUp = document.getElementById('btn-link-up');
if (btnLinkUp) { btnLinkUp.addEventListener('click', openLinkModal); }
```

```js
/**
 * Resolve the parent the modal should open on. The focused pane is the
 * operator's notion of "the selected terminal", but setFocusedPane only writes
 * activeTerminalName when the focused pane actually HOLDS a terminal
 * (terminals.js:2037-2048) — so a focused-but-empty pane has to fall through to
 * the last terminal that was selected, and only then to the fleet head.
 * Every candidate is re-checked against the live fleet: a default that quietly
 * targets a dead terminal is worse than no default at all.
 */
function defaultLinkParent() {
    const isLive = (n) => n && fleetList.some(t => t.friendlyName === n && t.status === 'active');
    const focused = paneAssignments[focusedPaneIndex];
    if (isLive(focused)) { return focused; }
    if (isLive(activeTerminalName)) { return activeTerminalName; }
    const first = fleetList.find(t => t.status === 'active');
    return first ? first.friendlyName : null;
}

function openLinkModal() {
    const live = fleetList.filter(t => t.status === 'active');
    if (live.length < 2) { showPaneToast('Need at least two live terminals to link'); return; }

    const modal = document.getElementById('link-modal');
    const parentSel = document.getElementById('link-parent');
    const messageEl = document.getElementById('link-message');

    fillTerminalSelect(parentSel, live, defaultLinkParent());
    syncChildOptions();          // excludes whatever parent resolved to
    messageEl.value = '';
    setLinkError(null);
    syncSendEnabled();

    modal.hidden = false;
    messageEl.focus();           // the instruction is the only thing left to supply
}

/**
 * The child list must never contain the parent — an agent instructed to message
 * itself is a no-op at best and a loop at worst. Re-run on every parent change,
 * preserving the current child selection when it is still valid.
 */
function syncChildOptions() { /* filter live fleet by !== parentSel.value */ }

/**
 * The fleet is repolled by fetchTerminalList (terminals.js:804), so the
 * two-live-terminals precondition is NOT a boot-time constant. Recompute here;
 * renderSidebarList() is already called on every successful poll.
 */
function syncLinkUpEnabled() {
    const btn = document.getElementById('btn-link-up');
    if (!btn) { return; }
    const liveCount = fleetList.filter(t => t.status === 'active').length;
    btn.disabled = liveCount < 2;
    btn.title = btn.disabled
        ? 'Needs at least two live terminals'
        : 'Instruct one agent terminal to send a message to another';
}
```

Call `syncLinkUpEnabled()` from the top of `renderSidebarList()` (`terminals.js:1447`).

Wire `change` on the parent select → `syncChildOptions()`; `input` on the textarea → `syncSendEnabled()`; `click` on `#link-cancel` and `#link-modal-close` → `modal.hidden = true`.

> **Superseded:** "Escape closes via a `keydown` listener on the modal that also calls `e.stopPropagation()`."
> **Reason:** A listener bound to `#link-modal` only fires when the event's path includes that element — i.e. only while focus is inside it. Clicking the backdrop (which deliberately does *not* close the modal) moves focus to `<body>`, after which Escape is dead. The listener also has to beat xterm, which is a sibling subtree; bubbling from the modal never reaches it either way, so element-scoped `stopPropagation()` is solving a problem it does not have while missing the one it does.
> **Replaced with:** Bind one `document`-level `keydown` listener in the **capture** phase, guarded on modal visibility. Capture runs before any handler inside xterm's own subtree, so `stopPropagation()` there reliably prevents the terminal from claiming the key:
> ```js
> document.addEventListener('keydown', (e) => {
>     const modal = document.getElementById('link-modal');
>     if (!modal || modal.hidden) { return; }
>     if (e.key === 'Escape') { e.stopPropagation(); modal.hidden = true; }
> }, true);
> ```
> The textarea keeps its own `keydown` → `e.stopPropagation()` handler (matching `terminals.js:3940-3944`) so ordinary typing never reaches the terminal.

### 4. `src/webview/terminals.js` — compose and deliver

```js
async function sendLinkMessage() {
    const parentName = document.getElementById('link-parent').value;
    const childName = document.getElementById('link-child').value;
    const message = document.getElementById('link-message').value.trim();
    if (!parentName || !childName || !message) { return; }

    // Re-validate BOTH ends: the modal may have sat open while the fleet changed.
    // ptySendPrompt checks the parent handle, but the child is only a name inside
    // the prompt text — nothing downstream would catch a dead one.
    const live = (n) => fleetList.some(t => t.friendlyName === n && t.status === 'active');
    if (!live(parentName)) { setLinkError(`${parentName} is no longer live`); return; }
    if (!live(childName)) { setLinkError(`${childName} is no longer live`); return; }

    try {
        // Relative URL + default credentials:'same-origin' — this is the idiom every
        // other verb call in this file uses (terminals.js:807, 2229, 3975). It is what
        // carries the HttpOnly sb_session cookie that _checkAuth accepts under
        // standalone (LocalApiServer.ts:565-572).
        const res = await fetch('/terminals/verb/ptySendPrompt', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                name: parentName,
                data: buildLinkPrompt(parentName, childName, message),
                // EXPLICIT false. Omitting this applies the config default (true)
                // in BOTH hosts — TaskViewerProvider.ts:2084-2095 and
                // bootstrap.ts:321-324/1268 — which writes /clear to the PARENT and
                // destroys the very context it is being asked to hand over.
                // NOTE: this field is only OBEYED on standalone once Proposed
                // Change 6 lands. Shipping this file without that one leaves the
                // landmine armed under `npx switchboard`.
                clearBeforePrompt: false
            })
        });
        const data = await res.json();
        if (!data.success) { setLinkError('Link failed: ' + (data.error || 'unknown')); return; }
        // Close first, THEN toast: the modal out-stacks .toast-container (z 200 vs
        // 100), so a toast raised while it is open would be painted behind it.
        document.getElementById('link-modal').hidden = true;
        showPaneToast(`Instructed ${parentName} to message ${childName}`);
    } catch (err) {
        setLinkError('Link failed: ' + (err.message || String(err)));
    }
}
```

### 5. `src/webview/terminals.js` — the relay prompt

> **Superseded:** the first draft of `buildLinkPrompt`, which emitted an indented `python3 - <<'PY' … PY` heredoc and a conditional auth header written as `\${SWITCHBOARD_API_TOKEN:+-H "Authorization: Bearer $SWITCHBOARD_API_TOKEN"}`.
> **Reason:** Two concrete shell bugs, both of which fail as "the agent tried and something went wrong" rather than as a visible error. (a) A heredoc terminator is only recognised at **column 0** unless the operator is `<<-` *and* the indentation is tabs; the draft indented `PY` by two spaces, so the heredoc never closes and the shell blocks reading input. (b) The result of a `${VAR:+word}` expansion is subject to field splitting but **not** to a second round of quote removal — the embedded double quotes stay literal and the value splits on its spaces, so `curl` receives `-H`, `"Authorization:`, `Bearer`, `<token>"` as four separate arguments and rejects them. The draft also asked the agent to hand-edit a Python string literal (`"data": "<the message…>"`), reintroducing exactly the quoting hazard the recipe was written to avoid.
> **Replaced with:** the version below. The message goes into a file via a quoted heredoc at column 0 (literal, no expansion, no escaping), the terminal name reaches Python through `argv`, and the `Authorization` header is sent **unconditionally** — safe on both hosts because `_checkAuth` returns `true` before inspecting any header when `getAuthToken()` is empty (`LocalApiServer.ts:545-548`), which is always the case under the extension host.

```js
/**
 * Build the relay prompt. Two parts, in this order:
 *   1. the operator's instruction verbatim, delimited;
 *   2. a concrete recipe for reaching `childName` over the Switchboard API.
 *
 * The API base is taken from location.origin — this page IS served by the
 * LocalApiServer that owns /terminals/verb/ (LocalApiServer.ts:3693), so it is
 * guaranteed correct without a port-file read. PTY_HOST_ORIGIN (terminals.js:80)
 * is a DIFFERENT server (the pty host child) and must not be used here.
 *
 * The auth token is NOT interpolated: it reaches the shell as
 * $SWITCHBOARD_API_TOKEN (see the ptyFleetService change below) so the secret
 * never enters the agent's scrollback or conversation history. The header is
 * emitted unconditionally — under the extension host getAuthToken() is empty and
 * _checkAuth short-circuits to loopback trust before reading it, so an empty
 * value is harmless there and correct under standalone.
 *
 * Every line of the shell block starts at column 0: an indented heredoc
 * terminator is not recognised and the shell hangs waiting for input.
 */
function buildLinkPrompt(parentName, childName, message) {
    const api = location.origin;
    return [
        `You have been asked to relay something to another Switchboard terminal.`,
        ``,
        `TARGET TERMINAL: ${childName}`,
        `YOUR TERMINAL:   ${parentName}`,
        ``,
        `OPERATOR INSTRUCTION:`,
        `---`,
        message,
        `---`,
        ``,
        `To deliver a message to ${childName}, POST it to the Switchboard API.`,
        `Write the message to a file and let python3 build the JSON — never`,
        `hand-escape quotes or newlines into a shell string:`,
        ``,
        `cat > /tmp/sb-relay-msg.txt <<'SBMSG'`,
        `<the message you want ${childName} to receive — say who you are and what`,
        `you are handing over, since the recipient has no idea this came from you>`,
        `SBMSG`,
        ``,
        `python3 -c 'import json,sys; print(json.dumps({"name": sys.argv[1], "data": open(sys.argv[2]).read(), "clearBeforePrompt": False}))' ${JSON.stringify(childName)} /tmp/sb-relay-msg.txt > /tmp/sb-relay.json`,
        ``,
        `curl -s -X POST "${api}/terminals/verb/ptySendPrompt" \\`,
        `  -H "Content-Type: application/json" \\`,
        `  -H "Authorization: Bearer $SWITCHBOARD_API_TOKEN" \\`,
        `  --data @/tmp/sb-relay.json`,
        ``,
        `A successful call returns {"success":true}. Keep "clearBeforePrompt" false`,
        `unless you deliberately want to reset ${childName}'s context first — true`,
        `sends /clear and destroys whatever that agent was holding.`,
        `If you get 401, this terminal predates the API-token injection; tell the`,
        `operator to restart it.`,
        ``,
        `Carry out the operator instruction now.`,
    ].join('\n');
}
```

Note that `${JSON.stringify(childName)}` produces a **double-quoted JSON string**, which is also a valid single shell word for any name that contains no `$`, backtick or backslash. Names are generated as `role-N` and renamed by the operator; if hardening beyond that is wanted later, wrap it in single quotes with `'` → `'\''` escaping. It is deliberately not over-engineered here — the token, not the name, is the security-relevant value, and it never enters the string.

### 6. `src/standalone/bootstrap.ts` — honour an explicit `clearBeforePrompt`

**This is the change that makes the feature actually work on the standalone host.** Today the arm discards the caller's flag:

```ts
// BEFORE (bootstrap.ts:1268) — payload.clearBeforePrompt is never read.
await sendPromptToPty(handle, payload.data || '', getPromptDeliveryOptions());
```

```ts
// AFTER — explicit caller intent wins; config default applies only when the
// field is absent. This is the same precedence TaskViewerProvider.ts:2089
// ("inject the default only when clearBeforePrompt === undefined") and
// ptyHost.ts:201 already implement, so the three delivery paths finally agree.
//
// Strictly a superset of the previous behaviour: every existing caller
// (terminals.js:2229 drag-drop, and the triggerAction paths at bootstrap.ts
// 1389/1423/1532) omits the field and is unaffected. No persisted state
// changes, so no migration is owed.
const deliveryDefaults = getPromptDeliveryOptions();
await sendPromptToPty(handle, payload.data || '', {
    clearBeforePrompt: typeof payload.clearBeforePrompt === 'boolean'
        ? payload.clearBeforePrompt
        : deliveryDefaults.clearBeforePrompt,
    clearBeforePromptDelayMs: typeof payload.clearBeforePromptDelayMs === 'number'
        ? payload.clearBeforePromptDelayMs
        : deliveryDefaults.clearBeforePromptDelayMs,
});
```

Update the arm's existing comment block (`bootstrap.ts:1258-1263`) accordingly — it currently asserts that `getPromptDeliveryOptions()` is used "for parity with triggerAction", which is what encoded the defect.

Leave `bootstrap.ts:1389`, `:1423` and `:1532` unchanged — those are internal `triggerAction` paths with no caller-supplied payload.

### 7. `src/standalone/ptyFleetService.ts` — API token in the PTY environment

Give the fleet an optional API token (constructor at `ptyFleetService.ts:84`) and inject it beside the existing `SWITCHBOARD_TERMINAL` stamp (`ptyFleetService.ts:147-158`):

```ts
constructor(workspaceRoot: string, db?: KanbanDatabase, apiToken?: string) {
    this.workspaceRoot = workspaceRoot;
    this.db = db;
    this.apiToken = apiToken;
    // …unchanged…
}
```

```ts
// Expose the seat's own identity AND the API credential to whatever runs in it.
// The token is an ENV VAR, never prompt text: a token pasted into a terminal
// lands in the agent's scrollback and its conversation history. Omitted when
// empty so the extension host (whose getAuthToken is effectively always empty —
// TaskViewerProvider.ts:2122, LocalApiServer.ts:578) leaves the variable unset;
// the recipe's unconditional Authorization header then carries an empty value,
// which _checkAuth never reads because it short-circuits on the empty expected
// token (LocalApiServer.ts:545-548).
// The spread is MANDATORY — ptyBackend.ts:89 does `options.env || process.env`.
const switchboardEnv: Record<string, string> = {
    SWITCHBOARD_TERMINAL: name,
    ...(this.apiToken ? { SWITCHBOARD_API_TOKEN: this.apiToken } : {}),
};
```

`ptyHost.ts:43` constructs `new PtyFleetService(workspaceRoot)` — the third parameter is optional, so that call site is unchanged and the extension host's child fleet stays token-free (it needs no token; loopback trust covers it).

### 8. `src/standalone/bootstrap.ts` — pass the session token to the fleet

`sessionToken` is minted at `bootstrap.ts:378`, well before the fleet is constructed at `bootstrap.ts:1585`:

```ts
// Third arg: the API session token. Terminal verbs are auth-gated
// (LocalApiServer.ts:1688), and standalone always has a token (wired as
// getAuthToken at bootstrap.ts:1634) — without this an agent's own curl to
// /terminals/verb/ptySendPrompt gets 401 and the link recipe is a lie on this
// host.
const ptyFleetService = new PtyFleetService(workspaceRoot, db, sessionToken);
```

No change to `src/standalone/ptyHost.ts`.

## Verification Plan

### Automated Tests

These are the implementer's gates (this planning pass ran no compilation and no tests, per session directive).

1. `npm run compile-tests` — the `ptyFleetService.ts` / `bootstrap.ts` edits must typecheck.
2. `node src/test/pty-route-surface-contract.test.js` — confirms no pty verb leaked into the catalog or `KANBAN_VERBS` (no new verb was added, so this must stay green unchanged).
3. `node src/test/terminal-pane-pinning-contract.test.js` and `node src/test/terminal-pane-grid-reconcile-contract.test.js` — must be green *and untouched*; this plan makes no edit to `createPaneElement` / `updatePaneElement` / `renderKanbanPane`, so any movement here means the change strayed out of scope.
4. `node src/test/browser-panel-scrollbar-contract.test.js` — confirms no second bare `::-webkit-scrollbar` rule was added to `terminals.html`.
5. **New regression guard (recommended):** assert that `bootstrap.ts`'s `ptySendPrompt` arm honours an explicit `clearBeforePrompt: false`. The cheapest honest form is a source assertion in the existing pty contract test — the arm must reference `payload.clearBeforePrompt`, not pass `getPromptDeliveryOptions()` straight through. Without it, a future "simplify to the shared options helper" refactor silently re-arms the landmine and nothing catches it.

### Manual UAT (browser panel, extension host)

Testing is done against the installed VSIX, so rebuild and reinstall before running these.

6. Open the Terminals panel with three live terminals. `LINK UP` sits directly beneath `SAVE AS GROUP`, same width and treatment.
7. Click a pane so it wears the focus ring, then click `LINK UP`. The **parent select is pre-set to that terminal**, the child select excludes it, and the caret lands in the instruction box.
8. Change the parent → the child list re-filters immediately and never offers the new parent.
9. Confirm dismissal: `×`, `CANCEL` and `Escape` all close. **Escape works after clicking the backdrop** (focus outside the modal) — the document-level capture listener is what makes this true. **Clicking the dark backdrop does NOT close** (typed text survives). **No confirmation dialog appears at any point.**
10. Type *"hand over the context of this task to terminal 2"*, Send. Confirm in the parent terminal that: (a) **no `/clear` was issued** — prior scrollback and context intact; (b) the prompt arrives as one block, not line-by-line; (c) it names the child and contains the `curl` recipe pointing at the panel's own origin.
11. Have the parent agent actually run the recipe verbatim. Confirm the `cat` heredoc terminates (no hung shell), the `python3` line produces valid JSON, the `curl` returns `{"success":true}`, the child receives the message, and the child's context was **not** cleared.
12. Kill the child with the modal open, then Send → **inline** error inside the modal reading `<name> is no longer live`; the modal stays open and nothing is delivered. Confirm the error is legible, i.e. not painted behind the overlay.
13. With `LINK UP` visible and enabled, kill terminals until one is left **without reloading the panel** → the button goes disabled on the next poll with an explanatory tooltip. Spawn a second terminal → it re-enables on the next poll.
14. Empty instruction → `SEND` stays disabled.
15. Confirm no pane header gained a button: headers still read `pin clear model hide` in a `2h` layout, and dense `3x3` headers are unchanged.

### Manual UAT (standalone)

16. `npx switchboard` in this workspace, open `/terminals`, spawn a fresh terminal, and run `echo $SWITCHBOARD_API_TOKEN` inside it — it must print the session token.
17. Repeat steps 10-11 under standalone. **This is the gate that proves Proposed Change 6 landed:** the parent must not be `/clear`-ed, and the child must not be `/clear`-ed when the relay arrives. The agent's `curl` must return `{"success":true}`, not `401`.
18. Confirm the token appears **only** in the environment — `grep` the delivered prompt text in the parent's scrollback for the token value and confirm zero hits.
19. Regression: drag a kanban card onto a terminal under standalone. It must still `/clear` first (the config default is unchanged for callers that omit the field).

---

**Recommendation: Send to Coder** (complexity 6).

---

## Completion Summary

Implemented all 8 proposed changes (see the Review Findings section below for the post-review state). Added a `LINK UP` button to the Terminals sidebar ops block and a first-of-its-kind modal (markup + scoped `.link-modal` CSS ported from `design.html`'s `.folder-modal`) to `src/webview/terminals.html`. Added the full modal lifecycle to `src/webview/terminals.js`: `openLinkModal`, `defaultLinkParent` (focused-pane → activeTerminalName → fleet-head fallback, all re-checked against the live fleet), `syncChildOptions` (parent-excluding, re-filters on parent change), `syncLinkUpEnabled` (recomputed inside `renderSidebarList` so the disabled state tracks the polled fleet), `sendLinkMessage` (send-time re-validation of both ends, explicit `clearBeforePrompt: false`, inline error surface, close-before-toast ordering), `buildLinkPrompt` (column-0 heredoc + `argv`/message-file `python3` JSON builder + unconditional `Authorization: Bearer $SWITCHBOARD_API_TOKEN` header), and a document-level capture-phase Escape listener that survives backdrop-click focus loss. Fixed the standalone `clearBeforePrompt` landmine in `src/standalone/bootstrap.ts` (`ptySendPrompt` arm now honours an explicit boolean, falling back to `getPromptDeliveryOptions()` only when the field is `undefined` — matching `TaskViewerProvider.ts` and `ptyHost.ts`). Added an optional `apiToken` constructor parameter to `src/standalone/ptyFleetService.ts` and injected `SWITCHBOARD_API_TOKEN` into the PTY environment (omitted when empty so the extension host path via `ptyHost.ts` is unaffected), then passed `sessionToken` to the fleet constructor in `bootstrap.ts`. No new verb, no catalog change, no `createPaneElement`/`updatePaneElement`/`renderKanbanPane` edit, no second bare `::-webkit-scrollbar` rule, no confirm gate. Per session directive, compilation and automated tests were skipped; verification was by read-back and red-team review against the plan's edge-case audit. No issues encountered.

## Review Findings

Reviewed all 8 proposed changes; the implementation matches the plan and the `clearBeforePrompt` precedence was traced end-to-end across all three delivery paths (bootstrap explicit-boolean-wins, `ptyHost.ts` `=== true`, `TaskViewerProvider` inject-only-when-`undefined`), with payload passthrough confirmed unfiltered (`verbSchemas.ts` carries zero pty entries) and `sessionToken` confirmed identical between `PtyFleetService` (bootstrap.ts:1602) and `getAuthToken` (bootstrap.ts:1651). One MAJOR gap: the plan's Automated item 5 — the regression guard pinning bootstrap's `ptySendPrompt` arm to `payload.clearBeforePrompt` — was never written (`grep clearBeforePrompt src/test/` returned zero hits), leaving the plan's most destructive failure mode unguarded; added it to `src/test/pty-route-surface-contract.test.js` (already CI-wired via `test:contract:pty-route-surface`) covering all three hosts plus the webview sender, and verified it fails against HEAD's defective arm. Two MINOR fixes in `src/webview/terminals.js`: `SEND` is now held disabled for the duration of the post (`withTerminalLock` serialises but does not dedupe, so a double-click delivered two relay prompts) and `#link-error` is cleared at the top of `sendLinkMessage`. Files changed by this review: `src/test/pty-route-surface-contract.test.js`, `src/webview/terminals.js`. Verification: `npm run compile-tests` clean; pty-route-surface (incl. new guard), panel-scrollbars, terminal-pane-pinning, terminal-pane-grid-reconcile, panel-runtime-surface, terminal-token-transport, terminal-input-path, terminal-flow-control, sidebar-groupings and solo-popout all green; four reds (`terminal-focus-affordance`, `terminal-pane-fit-verification`, `pty-dispatch-focus`, `terminal-operations-no-periodic-reopen`) were confirmed pre-existing at HEAD and unrelated. Remaining risks are deferred and plan-accepted: the recipe hardcodes `/tmp/sb-relay-*` paths (concurrent relays from different parents clobber) and assumes `python3`/POSIX shell, `SWITCHBOARD_TERMINAL` is injected but read nowhere in the repo, and every standalone UAT step (16-19) still needs a real `npx switchboard` run.
