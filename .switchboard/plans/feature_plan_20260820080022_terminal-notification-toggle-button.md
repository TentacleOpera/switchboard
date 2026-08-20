# Terminal Notification Toggle — Per-Terminal Completion-Reminder Standing Order

## Goal

Add a notification toggle button to each terminal card in the `terminals.html` sidebar. When pressed, it installs a pair-scoped standing order on that terminal that instructs the agent to POST a completion status to the extension when it has finished all instructions in a prompt. This lets the user flag reminders for longer-running processes — the extension shows a toast and badges the terminal when the agent reports back, without relying on the plan-file-watcher completion path.

### Problem & background

**Long-running agents go quiet and the user has no opt-in reminder.** The existing completion detection is derived from the PTY stream: `PlanIngestionEngine` sweeps for silent terminals and checks whether the plan file's mtime advanced (`feature_plan_20260814150000_agent-completion-endpoint.md`). This works for dispatched plan work, but it does not cover ad-hoc prompts, copy-prompt actions, or cases where the agent finishes without editing a plan file. The user has no way to say "tell me when this specific terminal is done with what I just sent it."

**The standing-orders system is the natural delivery vehicle.** `standingOrders.ts` already appends per-terminal instructions to every prompt sent through `ptySendPrompt` — the delivery layer for drag-drop/advance actions (`TaskViewerProvider.ts:767-778`). A pair-scoped order with `parent = <terminalName>` is selected by `selectOrders` and rendered into the `=== STANDING ORDERS ===` block. The infrastructure for per-terminal persistent instructions exists; what is missing is (a) a UI toggle to create/remove a specific order, (b) an HTTP endpoint the agent can POST to, and (c) a WebSocket broadcast that reaches the terminals panel.

**The copy-prompt path does not apply standing orders.** `promptSelected` (`KanbanProvider.ts:10758`) generates a prompt and copies it to the clipboard via `_generatePromptForColumn` → `clipboard.writeText`. The prompt never passes through `ptySendPrompt`, so `applyStandingOrders` is never called. For the notification order to reach copy-prompt prompts, the standing-orders block must be applied at the `promptSelected` endpoint before the clipboard write — using the live terminal set to resolve which orders apply. Since a copy-prompt is not addressed to a specific terminal, the notification order is injected as a **global-scope** order (applies to every terminal) when the toggle is ON for any terminal. This is the correct semantics: "when I copy a prompt and paste it into a terminal that has notifications enabled, the agent should report back."

**Agent-reported completion was removed once — this is different.** `POST /agent/event` was removed on 2026-08-08 because it was universal (every agent had to POST) and fell back to a blind timer for CLIs that did not support hooks. This feature is **opt-in per terminal** via a standing order — the agent only sees the instruction when the user has explicitly toggled it ON. If the agent ignores it, the existing file-watcher path is unaffected. No hooks, no `--settings` rewrite, no per-terminal token.

---

## Metadata

**Complexity:** 5
**Tags:** frontend, backend, feature, ui, ux
**Project:** Browser Switchboard

---

## User Review Required

Yes — confirm two things before coding: (a) the exact `NOTIFY ON COMPLETION` instruction text the agent will receive (the `curl` template in `makeNotifyCompletionOrder`), since it is what every enabled terminal's agent sees; and (b) the copy-prompt injection semantics — self-scoped orders are rendered as `If you are running in terminal "<name>": …` for EVERY notify-enabled terminal, because the copy-prompt path does not know which terminal the user will paste into. Both are product-visible behavior, not mechanical detail.

---

## Complexity Audit

**Score:** 5 / 10

### Routine

- Adding a toggle button to `renderTerminalRow` in `terminals.js` — the row already has an `.item-actions` div with `peek` and `clear` buttons; the new button follows the same pattern.
- Creating/removing a standing order via the existing `POST /terminals/standing-orders` endpoint (`LocalApiServer.ts:3107`) — the `add`/`delete` actions and `mutateStandingOrders` chain already handle this.
- Broadcasting a WebSocket message via `broadcastWs` (`LocalApiServer.ts:607`) — the `agentCompleted` broadcast is the template.
- Receiving the broadcast in `terminals.js` via `window.addEventListener('message')` (line 1097) and showing a toast via `showCompletionToast` (line 8829) — both already exist.

### Complex / Risky

- **The copy-prompt path gap.** `promptSelected` does not apply standing orders. Injecting them requires resolving orders + live names + groups at the `KanbanProvider` level, which currently only the `TaskViewerProvider` ptySendPrompt path does. The `KanbanProvider` has access to `_getKanbanDb` and can read the standing-orders config key, but the live-names set comes from the PTY fleet and must be fetched or passed in.
- **Scope semantics for the notification order.** A pair-scoped order requires `parent !== child` and a live `child` terminal. The notification order is about the terminal itself, not a pair relationship. Using `global` scope means it applies to ALL terminals, which is too broad — the user toggled it for ONE terminal. The correct approach is a new scope `self` (or reusing `pair` with `child = parent`, which the current validator rejects). The cleanest solution is a dedicated `notify-completion` scope type handled outside the normal `selectOrders` path — a separate config key or a deterministic-ID pair order with the validator relaxed for this specific case.
- **Idempotent toggle state.** The button must reflect whether the order is currently installed. The client already fetches standing orders via `GET /terminals/standing-orders` (line 9480). The toggle state is derived from whether an order with the deterministic ID prefix `notify-completion:<terminalName>` exists in the fetched list.
- **The standing-order instruction text must be self-contained.** It must tell the agent the exact `curl` command to POST to `POST /terminals/notify-completion` with the port from `.switchboard/api-server-port.txt`, including the terminal name and a brief status. The instruction is long but standing orders have no length cap.

---

## Edge-Case & Dependency Audit

- **Terminal rename.** `rewriteStandingOrdersForRename` (`standingOrders.ts:61`) rewrites `parent` and `child` fields. The notification order uses `parent = terminalName`, so a rename will correctly update it. The deterministic ID (`notify-completion:<oldName>`) will NOT be updated — the toggle state lookup by ID prefix will break. **Mitigation:** look up the order by `parent` match + instruction prefix rather than by ID, OR update the ID on rename. The simpler approach: the client checks `standingOrders.some(o => o.parent === terminalName && o.instruction.includes('notify-completion'))` rather than matching by ID.
- **Terminal exit/restart.** A pair-scoped order requires a live `child`. If the notification order is pair-scoped with `child = parent`, the `liveNames.has(o.child)` check will fail when the terminal exits, silently dropping the order. **Mitigation:** use a scope that does not require a live child. The `global` scope has no liveness gate but applies to all terminals. A dedicated `self` scope (no child, no liveness gate, matched by `parent === targetName`) is the correct design.
- **Multiple terminals with notification toggled ON.** Each terminal gets its own order. The `selectOrders` function must return the correct order for each terminal. With a `self` scope, the match is `o.parent === targetName` — one order per terminal, no cross-talk.
- **Copy-prompt with no terminal having notifications ON.** `promptSelected` applies standing orders only when there are orders to apply. If no terminal has the notification toggle ON, the copy-prompt path is unchanged — no performance impact.
- **Standalone vs extension host.** Both hosts construct `LocalApiServer` and both have `broadcastWs`. The `agentCompleted` broadcast works on both (`bootstrap.ts:660` and `TaskViewerProvider.ts:1577`). The new endpoint follows the same pattern — it calls `broadcastWs` with a new verb name.
- **Auth.** The new endpoint must use `_checkAuth(req, true)` like every other POST endpoint, so it is callable by the agent's `curl` (which carries the `sb_session` cookie or token).
- **Standing-orders block stripping.** `applyStandingOrders` strips any pre-existing block before appending. The `promptSelected` path must call `applyStandingOrders` (or a variant) on the generated prompt, which will strip and re-append correctly.

> **Superseded:** The original mitigation for terminal-rename ID drift proposed looking up the order by `parent` match + instruction prefix rather than by ID, "OR update the ID on rename."
> **Reason:** The proposed client code (`toggleNotifyCompletion`, `renderTerminalRow`) actually matches by full deterministic ID `notify-completion:<terminalName>`. After a rename, `rewriteStandingOrdersForRename` updates `parent`/`child` but NOT the ID, so `toggleNotifyCompletion` fails to find the existing order by its new-name ID, takes the ADD branch, and creates a DUPLICATE order while the old (parent-rewritten) order lingers — two delivery rows for one terminal. The "match by prefix" mitigation was never wired into the code the plan wrote.
> **Replaced with:** Extend `rewriteStandingOrdersForRename` (`standingOrders.ts:61`) to re-key the deterministic ID for notify-completion orders: when an order's `id` starts with `notify-completion:` and `o.parent === oldName`, rewrite both `parent` AND `id` to `notify-completion:<newName>`. This keeps the deterministic-ID contract consistent across every downstream lookup (toggle, render, find) without weakening them to prefix matching. See section 1 for the code.

---

## Dependencies

None — this plan is self-contained. It extends the existing standing-orders system (`standingOrders.ts`), the LocalApiServer route table, the terminals webview, and the KanbanProvider copy-prompt path, all of which are already in the codebase. No other plan must complete first.

---

## Adversarial Synthesis

Key risks: (1) the `notifyCompletion` server branch must run BEFORE `validateInstruction` or the empty client instruction triggers a 400 — fixed by reordering; (2) terminal rename leaves a stale deterministic ID, producing duplicate orders — fixed by re-keying the ID in `rewriteStandingOrdersForRename`; (3) the copy-prompt path injects self-scoped orders for EVERY notify-enabled terminal because it cannot resolve the paste target — accepted as correct semantics, documented in User Review Required. Mitigations: reordering + ID re-key are mechanical; the copy-prompt breadth is a product decision surfaced for confirmation. The verifiable contract is "toggle ON installs the order; the instruction is delivered; the endpoint broadcasts a toast on POST" — agent compliance with the instruction is a runtime expectation, not a build-time assertion.

---

## Proposed Changes

### 1. `src/services/standingOrders.ts` — Add `self` scope

Add `'self'` to `StandingOrderScope` and handle it in `selectOrders`, `scopeOf`, `renderOrder`, and the scope rank map.

```typescript
// Line 3: add 'self' to the union
export type StandingOrderScope = 'global' | 'team' | 'pair' | 'team-head' | 'self';

// scopeOf: no change needed (defaults to 'pair')

// selectOrders — add a branch before the pair fallback:
if (scope === 'self') {
    return o.parent === targetName;
}

// renderOrder — self renders like global/team (plain rule, no "regarding" framing):
// The existing else branch already handles this (non-pair scopes render as `- ${instruction}\n`)

// scopeRank — add self between global and team:
const scopeRank: Record<StandingOrderScope, number> = { global: 0, 'self': 1, 'team-head': 2, team: 2, pair: 3 };
```

Add a factory function for the notification order:

```typescript
const NOTIFY_COMPLETION_ID_PREFIX = 'notify-completion:';

export function makeNotifyCompletionOrder(terminalName: string, port: number): StandingOrder {
    const id = NOTIFY_COMPLETION_ID_PREFIX + terminalName;
    const instruction =
        `NOTIFY ON COMPLETION: When you have finished ALL instructions in this prompt, ` +
        `post a completion status to the Switchboard extension by running:\n` +
        `curl -s -X POST http://127.0.0.1:${port}/terminals/notify-completion ` +
        `-H "Content-Type: application/json" ` +
        `-d '{"terminalName":"${terminalName}","status":"completed","summary":"<brief summary of what you did>"}'\n` +
        `This is a required step — do not skip it. The extension will show a notification ` +
        `to the user so they know you are done.`;
    return {
        id,
        parent: terminalName,
        child: '',          // self scope: no child
        instruction,
        createdAt: Date.now(),
        scope: 'self',
    };
}

export function isNotifyCompletionOrder(o: StandingOrder): boolean {
    return o.id.startsWith(NOTIFY_COMPLETION_ID_PREFIX);
}

export function findNotifyCompletionOrder(orders: StandingOrder[], terminalName: string): StandingOrder | undefined {
    return orders.find(o => o.id === NOTIFY_COMPLETION_ID_PREFIX + terminalName);
}
```

**Re-key the deterministic ID on rename.** Extend `rewriteStandingOrdersForRename` (line 61) so a notify-completion order's ID follows its `parent` — otherwise the toggle lookup by full ID breaks after a rename and a duplicate order is created (see the Superseded callout in the Edge-Case audit):

```typescript
// Inside the existing orders.map(o => ...) callback, BEFORE the parent/child checks:
if (o.id.startsWith(NOTIFY_COMPLETION_ID_PREFIX) && o.parent === oldName) {
    changed = true;
    return { ...o, parent: newName, id: NOTIFY_COMPLETION_ID_PREFIX + newName };
}
```

(`NOTIFY_COMPLETION_ID_PREFIX` is module-local, so this stays inside `standingOrders.ts` — no export needed.)

### 2. `src/services/LocalApiServer.ts` — Relax validator for `self` scope + add `POST /terminals/notify-completion`

**Import:** add `makeNotifyCompletionOrder` to the existing import from `./standingOrders` (the file already imports `mutateStandingOrders`, `makeStandingOrder`, `validateInstruction`, `StandingOrder`, `StandingOrderScope`).

In `_handleStandingOrdersWrite` (line 3145), add `'self'` to the allowed scopes:

```typescript
if (!['global', 'team', 'pair', 'self'].includes(scope)) {
```

And add a `self`-scope validation branch (parent required, child not required, parent === child is OK for self):

```typescript
if (scope === 'self') {
    if (!parent) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: 'parent is required for self scope' }));
        return;
    }
}
```

Add the new endpoint in the route table (after `/phone-a-friend/done`, line 4765):

```typescript
} else if (pathname === '/terminals/notify-completion' && req.method === 'POST') {
    await this._handleNotifyCompletion(req, res);
```

Add the handler:

```typescript
/**
 * POST /terminals/notify-completion — agent-reported completion signal.
 * Body: { terminalName: string, status: string, summary?: string }.
 * Broadcasts a WebSocket message to the terminals panel so the user gets a
 * toast notification. Best-effort: always returns 200 to the agent so a
 * duplicate or stale POST does not cause the agent to retry.
 */
private async _handleNotifyCompletion(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    if (!await this._checkAuth(req, true)) {
        this._sendUnauthorized(res);
        return;
    }
    try {
        const body = await this._parseJsonBody(req);
        const terminalName = String(body?.terminalName || '').trim();
        const status = String(body?.status || 'completed').trim();
        const summary = typeof body?.summary === 'string' ? body.summary.trim() : '';
        if (!terminalName) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, error: 'Missing required field: terminalName' }));
            return;
        }
        // Broadcast to all connected webviews — transport.js relays WS broadcasts
        // to the terminals panel via postMessage.
        this.broadcastWs('terminalNotifyCompletion', {
            terminalName,
            status,
            summary,
        });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true }));
    } catch (err) {
        console.error('[LocalApiServer] notify-completion error:', err);
        // Still 200 — the agent must not retry on server error
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true }));
    }
}
```

### 3. `src/services/TaskViewerProvider.ts` — Relay the WebSocket broadcast to the webview

The `broadcastWs` call in `_handleNotifyCompletion` sends to WS clients. The standalone host's `bootstrap.ts` WS hub broadcasts to all connected WS clients, and `transport.js` relays WS messages to the webview via `postMessage`. The extension host's `LocalApiServer` also has `broadcastWs`. No additional relay code is needed — the WS broadcast reaches the webview the same way `agentCompleted` does.

**Confirmed (verified against source):** `transport.js` (lines 244-249) unwraps the wsHub envelope and calls `dispatchMessage(Object.assign({}, payload, { type: msg.type }))` for EVERY inbound WS frame. There is NO verb allowlist — unknown verb names are forwarded automatically. `terminalNotifyCompletion` is relayed with zero changes to `transport.js`. No allowlist entry is needed.

### 4. `src/webview/terminals.js` — Handle the WebSocket message + add the toggle button

**4a. Handle the `terminalNotifyCompletion` message** (near line 1115, the `agentCompleted` handler):

```javascript
} else if (message.type === 'terminalNotifyCompletion') {
    handleTerminalNotifyCompletion(message);
```

Add the handler function (near `handleAgentCompleted`, line 8790):

```javascript
function handleTerminalNotifyCompletion(msg) {
    const { terminalName, status, summary } = msg;
    // Badge the terminal with a notification indicator
    if (terminalName) {
        terminalBadges.set(terminalName, { label: 'NOTIFY', stamp: ++badgeStampSeq });
        renderSidebarList();
        renderPaneGrid();
        postFleetStateToShell();
    }
    // Show a toast — reuse the completion toast with a distinct title
    const title = summary || 'Agent reports completion';
    showCompletionToast(title, 'Notification', terminalName);
}
```

**4b. Add the notification toggle button to `renderTerminalRow`** (after the `clearBtn` in the actions div, around line 2468):

```javascript
const notifyBtn = document.createElement('button');
notifyBtn.type = 'button';
notifyBtn.className = 'item-notify-btn';
// State: check if a notify-completion standing order exists for this terminal
const hasNotifyOrder = standingOrders.some(
    o => o.parent === item.friendlyName && o.id.startsWith('notify-completion:')
);
notifyBtn.textContent = hasNotifyOrder ? 'notify on' : 'notify';
notifyBtn.title = hasNotifyOrder
    ? 'Completion notifications ON — agent will POST when done'
    : 'Toggle completion notifications for this terminal';
notifyBtn.classList.toggle('is-active', hasNotifyOrder);
notifyBtn.disabled = item.status === 'exited';
notifyBtn.addEventListener('click', async (e) => {
    e.stopPropagation();
    await toggleNotifyCompletion(item.friendlyName, notifyBtn);
});
actions.appendChild(notifyBtn);
```

**4c. Add the `toggleNotifyCompletion` function** (near `sendLinkMessage`, line 9656):

```javascript
async function toggleNotifyCompletion(terminalName, btn) {
    const existing = standingOrders.find(
        o => o.id === 'notify-completion:' + terminalName
    );
    try {
        if (existing) {
            // Remove
            const res = await fetch('/terminals/standing-orders', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ action: 'delete', id: existing.id })
            });
            const data = await res.json();
            if (!data.success) { showPaneToast('Failed to remove notification: ' + (data.error || 'unknown')); return; }
        } else {
            // Add — the server resolves the port and builds the instruction
            const res = await fetch('/terminals/standing-orders', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    action: 'add',
                    parent: terminalName,
                    child: '',
                    scope: 'self',
                    instruction: '',  // server fills this in for notify-completion orders
                    notifyCompletion: true
                })
            });
            const data = await res.json();
            if (!data.success) { showPaneToast('Failed to enable notification: ' + (data.error || 'unknown')); return; }
        }
        await fetchStandingOrders();
        renderSidebarList();
        showPaneToast(existing ? `Notifications off for ${terminalName}` : `Notifications on for ${terminalName}`);
    } catch (err) {
        showPaneToast('Notification toggle failed: ' + (err.message || String(err)));
    }
}
```

**4d. Server-side instruction generation for `notifyCompletion: true`** — in `_handleStandingOrdersWrite`, when `body.notifyCompletion` is true, build the instruction using `makeNotifyCompletionOrder`:

> **Superseded:** "In the 'add' branch, after validation: `if (body?.notifyCompletion === true)`…"
> **Reason:** The client sends `instruction: ''` (the server fills it in). `validateInstruction('')` (line 3171) returns `'Instruction is required'` and the endpoint responds 400 BEFORE the notifyCompletion branch is ever reached — the toggle ON request dies. Placing the branch "after validation" is a fatal ordering error.
> **Replaced with:** Place the `notifyCompletion` branch immediately AFTER the scope validation (the `['global','team','pair','self']` check and the `self`-scope parent-required check) and BEFORE `validateInstruction(instruction)`. The notifyCompletion path generates its own instruction server-side and must skip `validateInstruction` entirely (the client never supplies the instruction text):

```typescript
// In the 'add' branch, AFTER scope validation, BEFORE validateInstruction:
if (body?.notifyCompletion === true) {
    if (scope !== 'self') {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: 'notifyCompletion requires self scope' }));
        return;
    }
    if (!parent) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: 'parent is required for notifyCompletion' }));
        return;
    }
    const port = this._port;
    const order = makeNotifyCompletionOrder(parent, port);
    await mutateStandingOrders(db, async (orders) => {
        // Idempotent: replace any existing notify-completion order for this terminal
        const filtered = orders.filter(o => o.id !== order.id);
        return [...filtered, order];
    });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: true, order }));
    return;
}
// ...existing validateInstruction(instruction) call follows for the normal add path
```

### 5. `src/services/KanbanProvider.ts` — Apply standing orders to the copy-prompt path

**Imports (required — these are NOT currently imported into KanbanProvider):**
- From `./teamWiring`: add `loadEffectiveStandingOrders` (the file already imports `TERMINALS_GROUPS_KEY` and `TerminalGroupsSettingsAccessor` from teamWiring).
- From `./standingOrders`: add `applyStandingOrdersForCopyPrompt` (new, defined in section 1) and the `StandingOrder` type.

In the `promptSelected` case (line 10759 — the `case 'promptSelected':` label; the prompt is generated at line 10783 and the clipboard write is at line 10784), after generating the prompt and before `clipboard.writeText`:

```typescript
const prompt = await this._generatePromptForColumn(sourceCards, column, workspaceRoot, nextCol ?? undefined);

// Apply standing orders so copy-prompt prompts include per-terminal instructions
// (e.g. the notify-completion order). The copy-prompt path does not go through
// ptySendPrompt, so applyStandingOrders is never called by the delivery layer.
// We resolve orders + live names + groups from the DB and apply them here.
let promptWithOrders = prompt;
try {
    const db = await this._getKanbanDb(workspaceRoot);
    if (db) {
        const orders = await loadEffectiveStandingOrders(db);
        if (orders.length > 0) {
            const groups = await db.getConfigJson<TerminalGroup[]>(TERMINALS_GROUPS_KEY, []);
            // For copy-prompt, we don't know the target terminal. Apply orders
            // that would reach ANY live terminal — self-scoped orders (notify-
            // completion) apply to their parent terminal, so we apply all self-
            // scoped orders. Global orders also apply. Pair/team orders are
            // skipped (they require a specific target).
            const selfAndGlobalOrders = orders.filter(o =>
                (o.scope || 'pair') === 'self' || (o.scope || 'pair') === 'global'
            );
            if (selfAndGlobalOrders.length > 0) {
                // Apply as a synthetic block — use applyStandingOrders with a
                // dummy target that matches all self-scoped orders. Since self
                // orders match by parent, we need to apply per-terminal. The
                // simplest approach: render all self+global orders into one block.
                promptWithOrders = applyStandingOrdersForCopyPrompt(prompt, selfAndGlobalOrders);
            }
        }
    }
} catch (err) {
    console.warn('[KanbanProvider] Standing-orders application for copy-prompt failed:', err);
}

await this._seams().clipboard.writeText(promptWithOrders);
```

Add a helper in `standingOrders.ts`:

```typescript
/**
 * Render self + global standing orders into a block for copy-prompt prompts.
 * Unlike applyStandingOrders (which targets a specific terminal), this renders
 * ALL self-scoped orders (each prefixed with its terminal name) plus global
 * orders, since the copy-prompt does not know which terminal will receive it.
 */
export function applyStandingOrdersForCopyPrompt(prompt: string, orders: StandingOrder[]): string {
    if (!prompt || orders.length === 0) { return prompt; }
    const cleanPrompt = stripStandingOrdersBlock(prompt);
    const globalOrders = orders.filter(o => scopeOf(o) === 'global');
    const selfOrders = orders.filter(o => scopeOf(o) === 'self');
    if (globalOrders.length === 0 && selfOrders.length === 0) { return cleanPrompt; }

    let block = `\n\n${STANDING_ORDERS_MARKER}\n`;
    for (const o of globalOrders) {
        block += renderOrder(o);
    }
    for (const o of selfOrders) {
        block += `- If you are running in terminal "${o.parent}": ${o.instruction}\n`;
    }
    block += `These apply to everything you do in this terminal until told otherwise.\n`;
    return cleanPrompt + block;
}
```

### 6. `src/webview/terminals.html` — CSS for the notify button

Add after the `.item-peek-btn` rules (line 1195):

```css
/* Notification toggle — same bordered small-button language as peek/clear,
   with an active state that reads as "armed" (accent fill). */
.item-notify-btn {
    background: transparent;
    border: 1px solid var(--border-color);
    color: var(--text-secondary);
    font-size: 10px;
    font-family: inherit;
    letter-spacing: 0.5px;
    line-height: 1;
    padding: 3px 8px;
    border-radius: 3px;
    cursor: pointer;
    transition: all 0.2s;
}
.item-notify-btn:hover:not(:disabled) {
    color: var(--accent-teal);
    border-color: var(--accent-teal);
}
.item-notify-btn:disabled {
    opacity: 0.4;
    cursor: default;
}
.item-notify-btn.is-active {
    background: color-mix(in srgb, var(--accent-teal) 15%, transparent);
    border-color: var(--accent-teal);
    color: var(--accent-teal);
}
.item-notify-btn.is-active:hover:not(:disabled) {
    background: color-mix(in srgb, var(--accent-teal) 22%, transparent);
}
```

### 7. `src/standalone/bootstrap.ts` — WS broadcast relay (no change required)

The standalone host's WS hub (`bootstrap.ts:660`) broadcasts `agentCompleted` to all connected WS clients. The new `terminalNotifyCompletion` broadcast follows the same path via `broadcastWs`. As confirmed in section 3, `transport.js` forwards all WS verbs generically (no allowlist) — no change to `bootstrap.ts` or `transport.js` is needed. This section is retained as a verification note, not an edit site.

---

## Verification Plan

1. **Toggle ON creates a standing order.** Open the terminals panel, click `notify` on a terminal card. Verify:
   - The button text changes to `notify on` with the `.is-active` style.
   - `GET /terminals/standing-orders` returns an order with `id: "notify-completion:<terminalName>"`, `scope: "self"`, `parent: <terminalName>`.
   - The instruction text contains the `curl` command with the correct port.

2. **Toggle OFF removes the standing order.** Click `notify on` on the same terminal. Verify:
   - The button reverts to `notify` without the active style.
   - The order is removed from `GET /terminals/standing-orders`.

3. **Advance/drag-drop prompt includes the notification instruction.** With notifications ON for a terminal, drag a kanban card to that terminal. Verify the prompt delivered via `ptySendPrompt` includes the `=== STANDING ORDERS ===` block with the `NOTIFY ON COMPLETION` instruction.

4. **Copy-prompt includes the notification instruction.** With notifications ON for a terminal, use the kanban pane's "Copy Prompt" button. Verify the clipboard text includes the `=== STANDING ORDERS ===` block with the `If you are running in terminal "<name>"` line.

5. **Agent POST triggers a toast.** Simulate the agent's completion POST:
   ```bash
   curl -s -X POST http://127.0.0.1:<port>/terminals/notify-completion \
     -H "Content-Type: application/json" \
     -d '{"terminalName":"<name>","status":"completed","summary":"Done coding the auth module"}'
   ```
   Verify:
   - The terminals panel shows a completion toast with the summary text.
   - The terminal card shows a `NOTIFY` badge.

6. **Terminal rename preserves the order.** Rename a terminal that has notifications ON. Verify the standing order's `parent` field is updated and the toggle state is preserved on the renamed terminal.

7. **Terminal exit disables the toggle.** When a terminal exits, the notify button should be disabled (like the clear button).

8. **No notifications ON = no standing-orders block in copy-prompt.** With no terminals having notifications enabled, the copy-prompt path should produce identical output to before (no standing-orders block appended).

9. **Auth required.** A `curl` to `POST /terminals/notify-completion` without the session cookie/token should return 401.

10. **Rename re-keys the order ID (no duplicates).** Rename a terminal with notifications ON, then toggle OFF. Verify only ONE order is removed (not two), and `GET /terminals/standing-orders` shows zero `notify-completion:` orders afterward. This confirms the ID re-key in `rewriteStandingOrdersForRename` prevented the duplicate-order bug.

---

**Routing recommendation:** Complexity 5 → Send to Coder.
