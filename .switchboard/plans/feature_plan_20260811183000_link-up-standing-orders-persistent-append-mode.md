# Link-Up Standing Orders — A Persistent Mode That Appends The Relationship To Every Prompt Sent To A Terminal

## Goal

Give the Link-up modal a **delivery mode** choice:

- **Instant** — today's behaviour, unchanged. Compose the instruction, deliver it into the parent terminal once, done.
- **Standing orders** — persist the relationship instead of firing it. Nothing is delivered at save time. From then on, *every* prompt Switchboard delivers into that parent terminal carries the relationship as an appended block.

The motivating arrangement is "terminal A is the researcher for terminal B". That is not a message — it is a **standing fact about how B should work**, and it has to survive every subsequent dispatch, paste and drop, or it is worthless.

Ship with it: a small management surface (list the active standing orders, delete one immediately) — otherwise the arrangement can be created but never revoked.

### Problem

Link-up is fire-and-forget. It delivers one prompt and forgets the relationship existed.

`sendLinkMessage` (`src/webview/terminals.js:7518`) POSTs `buildLinkPrompt(...)` to `/terminals/verb/ptySendPrompt` and closes the modal. Nothing is written anywhere. `openLinkModal` (`:7425`) blanks the instruction box (`messageEl.value = ''`) on every open, so even the *text* of the last arrangement is gone.

The consequence at delivery time: every path that pushes a prompt into a terminal composes it with zero knowledge that a relationship exists.

- Terminals-pane normal drop → `POST /terminals/verb/ptySendPrompt` with `{ name, data: promptText }` (`terminals.js:3581`) — `promptText` is whatever `/kanban/verb/promptSelected` returned, verbatim.
- Terminals-pane Shift-drop → a bracketed-paste frame written straight to the terminal's WebSocket (`terminals.js:3574`), which never touches the server at all.
- Extension-host fleet dispatch → `_tryFleetDeliveryForRole` → `_dispatchExecuteMessage` → `_attemptDirectTerminalPush` → `_ptyHostVerb('ptySendPrompt')` (`src/services/TaskViewerProvider.ts:19351`), which bypasses `LocalApiServer` entirely.
- Standalone-host board dispatch → `kanbanVerb` forwards `triggerAction` / `sendToTerminal` into `handlePtyVerb` (`src/standalone/bootstrap.ts:1016`), whose arms call `sendPromptToPty` directly (`:1345`, `:1379`) on the `/kanban/verb/` rail — never touching `/terminals/verb/` at all.

So the *first* prompt after a link-up carries none of the arrangement, and on the kanban dispatch path it is very likely preceded by a `/clear` (`TaskViewerProvider.ts:2095` injects `clearBeforePrompt` default `true` when the caller omits it) — which erases the one-shot instruction from the agent's context outright. The operator's "you are the researcher for terminal 2" survives, at best, until the next card is dropped.

### Root cause

Three compounding gaps, none of which is a bug in isolation:

1. **No persistence layer for terminal-to-terminal relationships.** The link modal has three controls and no store. `terminals.js` persists plenty of panel state (`saveLayoutSettings`, `:1388` — layout, pane assignments, groups, group prefs) but nothing about relationships, because none was ever modelled.
2. **No append hook on the delivery path.** `data` is passed through to `sendPromptToPty` untouched by both hosts (`src/standalone/bootstrap.ts:1182`, `src/standalone/ptyHost.ts:223`). Prompt text is treated as opaque from composition to PTY write, so there is no seam where per-target context can be added.
3. **The delivery surface is fragmented.** Multiple code paths deliver a prompt to a named terminal — over HTTP, over a raw WebSocket, internal to the extension host, and internal to the standalone host on a *different* rail. Any fix that lands in only one of them is silently partial, which is exactly the trap a naive "append it in the drop handler" implementation falls into.

### Where the append must land (decided)

> **Superseded:** One shared resolver applied at **three** call sites — (1) `LocalApiServer._handleTerminalVerb` (`src/services/LocalApiServer.ts:1825`) for `verb === 'ptySendPrompt'`, (2) the Shift-drop paste in `src/webview/terminals.js:3574`, (3) `TaskViewerProvider._dispatchExecuteMessage` / `_tryFleetDeliveryForRole` (`:19195`).
>
> **Reason:** Two of the three sites are wrong, and the set is incomplete — which is precisely the failure mode this section exists to prevent.
> 1. **The standalone host's board dispatch is not covered at all.** `bootstrap.ts:1003-1017` documents it explicitly: the `pty*` verbs live only on `/terminals/verb/`, but the *dispatch* verbs `triggerAction` and `sendToTerminal` are served on `/kanban/verb/` and forwarded into `handlePtyVerb` (`:1016`). Their arms call `sendPromptToPty` directly (`:1345`, `:1379`), so `LocalApiServer._handleTerminalVerb` — which only sees `/terminals/verb/` — never observes a standalone board dispatch. A fourth standalone site, `memoGeneratePrompt`'s send-to-planner (`:1503`, inside `planningVerb`), is likewise invisible to it. Verification step 13 ("standalone parity") would have failed against the original design.
> 2. **`_dispatchExecuteMessage` does not call `_ptyHostVerb('ptySendPrompt')`.** It calls `_attemptDirectTerminalPush` (`:19315`), which is what issues the verb (`:19351`). `:19195` is `_tryFleetDeliveryForRole`, not `_dispatchExecuteMessage` (`:19242`).
> 3. **Appending at `_dispatchExecuteMessage` keys off the wrong name.** It receives `targetAgent`, a *pre-resolution* name; `_attemptDirectTerminalPush` resolves it to `target.friendlyName` via `_stripIdeSuffix` + `_normalizeAgentKey` matching. Standing orders are keyed by `friendlyName`, so a suffixed or case-variant `targetAgent` silently matches nothing and the block is dropped — a green "it works" on the operator's usual name and a silent miss on every alias.
>
> **Replaced with:** One shared resolver applied at **three genuine chokepoints**, one per delivery domain. Each is the *sole* funnel for its domain, so coverage is provable by enumeration rather than by discipline.

| Site | File / line | Why this is the chokepoint |
| :--- | :--- | :--- |
| Extension-host pty rail | `TaskViewerProvider._ptyHostVerb` (`src/services/TaskViewerProvider.ts:366`) | The **only** caller of the pty host's `/api/pty/` HTTP surface — both request builders (`:395`, `:417`) live inside it, and `ptyHost.ts:322` documents it as "the only caller of /api/pty". Covers the pane normal-drop, the browser cockpit, any agent curling `/terminals/verb/ptySendPrompt` (via `handlePtyVerb`, `:2095`), **and** every internal fleet dispatch (via `_attemptDirectTerminalPush`, `:19351`) — in one hook. `payload.name` is already the resolved `friendlyName` at this depth. |
| Standalone-host delivery | new local `deliverPrompt(...)` wrapper in `src/standalone/bootstrap.ts`, replacing all four `sendPromptToPty` call sites (`:1182` the `ptySendPrompt` arm, `:1345` `triggerAction`, `:1379` `sendToTerminal`, `:1503` `memoGeneratePrompt`) | Standalone spreads delivery across two verb rails; there is no single function to wrap. The four call sites are the complete set (`grep -n "await sendPromptToPty(" src/standalone/bootstrap.ts`), and `db` (`:197`) plus `ptyFleetService` are in lexical scope at every one — so the live-name lookup is in-process and free. |
| Shift-drop paste | `src/webview/terminals.js:3574` | Writes the bracketed-paste frame directly to the terminal WebSocket — no server involvement in either host. |

**`LocalApiServer` needs no verb-level append.** Under the extension host the terminals rail funnels into `_ptyHostVerb`; under standalone it funnels into `handlePtyVerb`'s `ptySendPrompt` arm, which the `deliverPrompt` wrapper covers. Hooking `_handleTerminalVerb` as well would add a second append on the same delivery (defused only by the idempotence marker) while still missing the standalone board. `LocalApiServer` still gains the two **management routes** — that part of the original design stands.

The pty-host handlers (`ptyHost.ts:223`, `bootstrap.ts:1182`) are deliberately **not** the append point, and neither is `sendPromptToPty` itself (`src/standalone/ptyPromptDelivery.ts:21`). `ptyHost.ts:43` constructs `new PtyFleetService(workspaceRoot)` with **no database**, so the pty-host child cannot read the store; putting the resolver there would work standalone (where `sendPromptToPty` runs in-process beside the DB) and silently no-op under the extension host. That is the same asymmetry trap, one layer lower.

**Deliberately excluded:** `src/standalone/delegation.ts:225` (`sendPromptToPty(child, c.prompt, …)`). Delegate children are host-spawned with generated names the operator cannot select in the modal, so no standing order can name one; and a delegate prompt is a scoped one-shot task, not the parent's ongoing work. Stated here so a later reader does not "complete" the set by wiring it.

## Metadata

**Complexity:** 7
**Tags:** frontend, backend, api, ui, ux, feature, security
**Project:** Browser Switchboard

## User Review Required

None. Every open decision in the original draft is now decided in-plan: append sites, rename handling, dead-terminal policy, caps, multi-order ordering, the copy-to-clipboard non-goal, and the delegate-child exclusion.

## Complexity Audit

### Routine
- The modal already exists, with its own scoped CSS block (`src/webview/terminals.html:1445-1519`) and wiring (`wireLinkModal`, `terminals.js:7579`). A mode control is a fourth field in a body that already has three (`terminals.html:1697-1719`).
- The delete-a-standing-order control is a plain immediate delete. Per `CLAUDE.md`, no confirm gate — and `window.confirm()` is a silent no-op in a VS Code webview anyway.
- `KanbanDatabase.getConfigJson` / `setConfigJson` (`src/services/KanbanDatabase.ts:5296`, `:5302`) already provide a typed JSON config store, and `LocalApiServer` already holds `getKanbanDatabase` in its options (`:292`, with `_resolveDbForRoot` at `:2688`) — no new persistence machinery. Both hosts supply it (`TaskViewerProvider.ts:866`, `bootstrap.ts:1616`).
- Both selects are populated from `fleetList` via the existing `fillTerminalSelect` (`terminals.js:7382`); the management list reads the same array to grey out dead ends.
- This is unreleased dev work (the link-up feature itself landed 2026-08-08) and the config key is net-new, so it needs **no migration** — nothing shipped reads or writes it.
- The rename hook has a working precedent three lines away: `handlePtyVerb` already runs a post-dispatch DB write for exactly this verb set (`TaskViewerProvider.ts:2103`).

### Complex / Risky
- **Fragmented delivery surface, and the fragments are invisible from each other.** The Shift-drop path bypasses HTTP; the extension-host dispatch bypasses `LocalApiServer`; the standalone board dispatch bypasses the terminals rail entirely. A one-site implementation passes casual testing (drag a card onto a pane — works) and fails the operator's actual workflow (dispatch from the board — silently bare), differently in each host. The three chokepoints above are chosen so coverage is enumerable; the verification plan exercises each in both hosts.
- **Recursion / self-reference.** A link-up *instruction* delivered to a parent must not itself carry that parent's standing orders — the agent would receive its own standing block quoted back inside a message about standing blocks. `sendLinkMessage` must opt out explicitly.
- **Marker forgery is a self-DoS.** The idempotence guard is `prompt.includes(MARKER)`. An instruction whose text contains the marker string makes every future prompt look pre-blocked, permanently suppressing the whole feature for that operator. The marker must be rejected/stripped from instruction text at save time.
- **Prompt inflation.** Appending on *every* delivery means the block rides along with every card dispatch forever. Uncapped, a few verbose standing orders measurably shrink the agent's usable context. Capped and truncated below, **server-side** — the modal's counter is advisory.
- **Name-keyed state vs. renames.** Standing orders are keyed by `friendlyName`, and `ptyRenameTerminal` mutates exactly that (`src/standalone/ptyFleetService.ts:391`, `handle.friendlyName = newAlias` at `:396`). A rename silently orphans both ends of the relationship unless the rename path rewrites the store — and under the extension host the rename executes inside the pty-host child, which has no DB, so the rewrite must happen in the parent.
- **Two hosts, no shared delivery function.** Anything added to the delivery path must behave identically under the extension host and standalone, which reach the PTY through structurally different code. `src/test/pty-route-surface-contract.test.js` already pins the shape of these paths and must keep passing.
- **A persistent cross-agent injection channel.** Every pty child is handed `$SWITCHBOARD_API_TOKEN`, so any agent can POST a standing order onto any *other* terminal. See Security below.

## Edge-Case & Dependency Audit

### Race Conditions

- **Concurrent add/delete clobber.** `getConfigJson` → mutate → `setConfigJson` is a read-modify-write. Two cockpit windows (or a window plus an agent curl) saving at once lose one entry. Serialize every mutation of `terminals.standingOrders` through a single module-level promise chain in the route handler — the same posture `ptyFleetService`'s `_registryWrite` takes for `runtime.terminals`. Reads need no lock.
- **Rename racing a delivery.** A dispatch that reads the store microseconds before the rename rewrite lands emits the old child name. Benign and self-correcting on the next dispatch; do not add UI for it.
- **Modal open across a fleet change.** The management list is a snapshot. A child that dies while the modal is open renders live until the next `fetchTerminalList` poll re-renders. Acceptable — the append-time live check is the authority, not the list.
- **Nested verb call.** The extension-host hook calls `_ptyHostVerb('ptyListTerminals')` from inside `_ptyHostVerb`. Guard on `verb === 'ptySendPrompt'` so the inner call cannot re-enter the hook. One level, no recursion.

### Security

- **The write route is reachable by every agent.** `_checkAuth` accepts the token every pty child carries (see `buildLinkPrompt`'s `$SWITCHBOARD_API_TOKEN` recipe), so any agent can create a standing order targeting any terminal. This is **not a new trust boundary** — `ptySendPrompt` already lets any child push arbitrary text into any terminal — but it is a *durability* escalation: one-shot injection becomes text appended to every future prompt that terminal receives. Accepted, with hard limits rather than a new auth tier:
  - Reject non-string `parent` / `child` / `instruction`, and any `instruction` over **2000 characters**, at the route — the modal's counter is a courtesy, not a control.
  - Cap the store at **20 orders total**; reject beyond that with a readable error.
  - Reject (or strip) the marker string from `instruction` — see the self-DoS note above.
  - Total appended block capped at **4000 characters** with visible truncation.
- **No secret exposure.** The block carries operator-authored text and terminal names only. No token, no path, no DB content.
- **`delete` needs no ownership check.** Anything that can delete can also add; there is nothing to protect that the write route does not already expose.

### Side Effects

- Every prompt delivered to a parent with live standing orders grows by the block, including prompts preceded by `/clear`. Intended — see the `clearBeforePrompt` interaction below.
- Under the extension host, `_attemptDirectTerminalPush`'s **VS Code-terminal fallback leg** (reached only when no matching PTY is active) gets no block. Correct by construction: a standing order's parent must be a live PTY, so the append would be skipped anyway. Non-goal, not a gap.
- The store is a single key in the **primary workspace's** `kanban.db` and is keyed by terminal name only — not by workspace root. A standing order created while workspace A is selected applies to a same-named terminal regardless of which worktree it runs in. Accepted: terminal names are already globally unique within a fleet.
- **Solo mode.** `saveSetting` early-returns under `soloTerminalName` (`terminals.js:1309`). The standing-orders store is DB-backed via its own routes and does **not** go through `saveSetting`, so it must not inherit that suppression — a solo popout window still delivers prompts and must still append. The one casualty is the *last-used mode* preference, which does use `saveSetting` and so will not persist from a popout. Acceptable; do not special-case it.
- One extra `ptyListTerminals` round-trip per extension-host dispatch **only when at least one order exists**. Standalone pays nothing — `ptyFleetService.listActive()` is in-process.

### Dependencies & Conflicts

- **The relay-endpoint plan.** `feature_plan_20260811170004_link-up-relay-endpoint-and-safe-clear-default.md` rewrites `buildLinkPrompt` and adds `POST /terminals/relay`. This plan touches `sendLinkMessage`'s *branching* (which mode to run) and adds an opt-out flag, not the prompt body — the two are compatible in either order. If the relay plan lands first, the instant branch calls whatever it left behind; if this lands first, the relay plan rewrites the instant branch's prompt builder and nothing here moves. **If `POST /terminals/relay` exists when this lands, it is a fourth delivery entry point and must carry the same opt-out** (a relay is a link-up instruction, so `standingOrders: false`).
- **`protocol-catalog.json` is generated, not hand-edited.** `scripts/generate-protocol-catalog.js` derives `apiEndpoints` via `extractApiEndpoints()`, and `npm run catalog:check` fails on drift. See Proposed Changes §2.
- **`src/test/pty-route-surface-contract.test.js`** asserts the `pty*` verbs stay out of the generated verb surface. The new routes are plain REST paths, not verbs, so they land in `apiEndpoints` and leave `verbs` / `KANBAN_VERBS` untouched — the contract holds. Do not add a `standingOrders` *verb*.
- **PRD contracts.** `#4` return-in-body: both routes return their data in the body (the GET returns the order list, not a bare ack). `#5` boundary validation: the routes hand-validate as listed under Security (they are not `handleServiceVerb` verbs, so `verbSchemas.ts` does not reach them). `#6` capability-gating honesty: when `getKanbanDatabase` yields nothing, the GET route reports unavailability and the modal **disables** the Standing option rather than offering a control that saves into the void. `#7` two-layer completion: satisfied only because both hosts are hooked — the original single-server design would have shipped a standalone dead end.
- **Multiple standing orders on one parent.** Allowed. Append all of them, creation order, under one header — an operator wanting a researcher *and* a reviewer is the obvious second use case. Do not silently replace on a second save.
- **Dead terminals.** A standing order naming a terminal that is no longer live is **skipped at append time and rendered greyed in the list — never auto-deleted.** Terminal names are recreated (`role-1` comes back), and silently dropping the arrangement because a seat was restarted is the worse failure.
- **Idempotence.** The block is fenced with a fixed marker. The resolver returns the text unchanged if the marker is already present, so a payload that somehow passes through two append sites gets one block, not two. With the three-chokepoint design no delivery traverses two sites, so this is belt-and-braces rather than load-bearing — keep it anyway.
- **Interaction with `clearBeforePrompt`.** The block is appended to the prompt text, which is written *after* the `/clear` and its delay (`src/standalone/ptyPromptDelivery.ts`). A clearing dispatch therefore re-establishes the standing orders in the freshly cleared context — which is exactly the behaviour that makes this feature worth having.
- **Control-string deliveries.** Anything delivering a bare control string rather than a task prompt must opt out. The append must key off `standingOrders !== false` in the payload, so callers can suppress it without a schema change to every site.
- **Non-goal, stated:** the kanban board's *copy-prompt-to-clipboard* buttons are out of scope. The clipboard has no target terminal, so there is no relationship to resolve; guessing the focused pane would attach the wrong agent's standing orders to a prompt the operator may paste anywhere.

## Dependencies

- `sess_20260811170004 — link-up relay endpoint and safe /clear default` (compatible in either order; if it lands first, its relay entry point must carry `standingOrders: false`)

## Adversarial Synthesis

**Risk Summary.** The dominant risk is partial coverage: prompt delivery is fragmented across four surfaces in two structurally different hosts, and the original three-site design missed standalone board dispatch entirely while hooking a function that does not issue the verb. Mitigation is to hook the three genuine chokepoints (`_ptyHostVerb`, a `deliverPrompt` wrapper over bootstrap's four `sendPromptToPty` sites, and the client-side Shift-drop) so coverage is provable by `grep`, not by discipline. Secondary risks — read-modify-write clobber on the config key, marker forgery permanently suppressing the feature, unbounded prompt inflation, and rename orphaning — are handled by a serialized write chain, marker rejection at save time, server-enforced caps, and a rename rewrite in the parent process of each host.

## Proposed Changes

### 1. `src/services/standingOrders.ts` (new)

The single resolver, shared by every append site. No `vscode` import, no host imports — PRD contract #3.

```ts
export interface StandingOrder {
    id: string;
    parent: string;      // the terminal that RECEIVES the appended block
    child: string;       // the terminal it has been told to work with
    instruction: string;
    createdAt: number;
}

export const STANDING_ORDERS_CONFIG_KEY = 'terminals.standingOrders';
export const STANDING_ORDERS_MARKER = '=== SWITCHBOARD STANDING ORDERS ===';
export const MAX_BLOCK_CHARS = 4000;
export const MAX_INSTRUCTION_CHARS = 2000;
export const MAX_ORDERS = 20;

/** Idempotent. Returns `prompt` unchanged when there is nothing to add. */
export function applyStandingOrders(
    prompt: string,
    targetName: string,
    orders: StandingOrder[],
    liveNames: Set<string>
): string {
    if (!prompt || prompt.includes(STANDING_ORDERS_MARKER)) { return prompt; }
    const mine = orders.filter(o =>
        o.parent === targetName && liveNames.has(o.child)
    );
    if (mine.length === 0) { return prompt; }

    let block = `\n\n${STANDING_ORDERS_MARKER}\n`;
    for (const o of mine) {
        block += `- Regarding terminal "${o.child}": ${o.instruction}\n`;
    }
    block += `These apply to everything you do in this terminal until told otherwise.\n`;
    if (block.length > MAX_BLOCK_CHARS) {
        block = block.slice(0, MAX_BLOCK_CHARS) + '\n…[standing orders truncated]\n';
    }
    return prompt + block;
}

/** Save-time validation. Returns an error string, or null when acceptable. */
export function validateInstruction(text: unknown): string | null {
    if (typeof text !== 'string' || !text.trim()) { return 'Instruction is required'; }
    if (text.length > MAX_INSTRUCTION_CHARS) { return `Instruction exceeds ${MAX_INSTRUCTION_CHARS} characters`; }
    if (text.includes(STANDING_ORDERS_MARKER)) { return 'Instruction may not contain the standing-orders marker'; }
    return null;
}
```

`liveNames` is passed in rather than looked up, because the two hosts resolve the fleet differently and this module must stay free of host imports.

**Edge cases:** empty `prompt` returns unchanged (never fabricate a prompt out of a block alone); `orders` containing an entry whose `parent === child` is filtered out by the live check only if the child is dead — reject the self-pair at the route instead, mirroring `syncChildOptions`' exclusion (`terminals.js:7401`); truncation may cut mid-line, which is acceptable because the trailing marker announces it.

### 2. `src/services/LocalApiServer.ts` — management routes only

> **Superseded:** A verb-level append inside `_handleTerminalVerb` (`:1825`) for `verb === 'ptySendPrompt'`, resolving orders and calling `terminalVerb('ptyListTerminals', {})` to build the live set.
> **Reason:** It is neither sufficient nor necessary. Insufficient: the standalone host serves board dispatch as `triggerAction` / `sendToTerminal` on `/kanban/verb/` (`bootstrap.ts:1007-1017`), which never reaches `_handleTerminalVerb`. Unnecessary: under both hosts the terminals rail funnels into a lower chokepoint that must be hooked anyway (`_ptyHostVerb` / `handlePtyVerb`'s arm), so a hook here is a second append on the same delivery, defused only by the marker guard.
> **Replaced with:** `LocalApiServer` gains the two management routes and nothing else. The append moves to the per-host chokepoints in §3 and §4.

Two routes, beside the `/terminals/verb/` branch (`:3699`):

```ts
} else if (pathname === '/terminals/standing-orders' && req.method === 'GET') {
    await this._handleStandingOrdersList(req, res);
} else if (pathname === '/terminals/standing-orders' && req.method === 'POST') {
    await this._handleStandingOrdersWrite(req, res);   // {action:'add'|'delete', ...}
```

**Logic.**
- Resolve the DB with the existing `_resolveDbForRoot` (`:2688`).
- **GET** returns `{ success: true, available: true, orders: StandingOrder[] }`. When no DB is reachable it returns `{ success: true, available: false, orders: [] }` — an honest capability report, not a 500, so the modal can disable the mode rather than dead-click it (PRD #6).
- **POST** validates before mutating: `action` is `'add'` or `'delete'`; for `add`, `parent`/`child` are non-empty strings and unequal, `validateInstruction` passes, and the store is under `MAX_ORDERS`; for `delete`, `id` is a non-empty string. Every failure returns `{ success: false, error }` with a 400 (PRD #4 — the failure branch returns, it does not fall through to a bare ack).
- All mutations run inside a module-level serialized chain so concurrent add/delete cannot clobber (see Race Conditions).
- `id` is generated server-side; a client-supplied `id` on `add` is ignored.

**Edge cases:** deleting an unknown `id` is a success no-op (the operator's intent — "it is gone" — is satisfied, and two windows racing a delete must not surface an error); a `parent` naming a terminal that is not currently live is **accepted** (dead-terminal policy is skip-at-append, not reject-at-save).

**Catalog.**

> **Superseded:** "Register both routes in `protocol-catalog.json` so `GET /catalog` advertises them."
> **Reason:** `protocol-catalog.json` is generated, not authored — `scripts/generate-protocol-catalog.js` derives its `apiEndpoints` array via `extractApiEndpoints()`, and running the script without `--write` is a CI drift check that exits non-zero when the checked-in file disagrees (`npm run catalog:check`). A hand-added entry fails the gate; a hand-omitted one fails it too.
> **Replaced with:** Add the routes to `LocalApiServer.ts`, then run `npm run catalog:generate` and commit the regenerated `protocol-catalog.json`. Confirm the two paths appear under `apiEndpoints` and that `verbs` / the allowlist are unchanged (the `pty*`-stay-off-the-generated-surface contract in `src/test/pty-route-surface-contract.test.js`).

### 3. `src/services/TaskViewerProvider.ts` — the extension-host chokepoint

> **Superseded:** "In `_dispatchExecuteMessage` (or immediately before the `_ptyHostVerb('ptySendPrompt')` call it wraps, `:19195` onward), resolve from the kanban DB the provider already holds and call the same helper."
> **Reason:** `_dispatchExecuteMessage` (`:19242`) does not wrap that call — `_attemptDirectTerminalPush` (`:19315`) issues it at `:19351`; `:19195` is `_tryFleetDeliveryForRole`. Worse, `_dispatchExecuteMessage` holds `targetAgent`, the *unresolved* name, while the store is keyed by `friendlyName` — so suffixed or case-variant targets would silently get no block. And a hook there covers only the internal dispatch, leaving the HTTP rail to a second, separate hook.
> **Replaced with:** One hook in `_ptyHostVerb` (`:366`), the sole caller of the pty host's `/api/pty/` surface — it covers the HTTP rail (`handlePtyVerb`, `:2095`), the browser cockpit, agent curls, and every internal dispatch (`_attemptDirectTerminalPush`, `:19351`) at a depth where `payload.name` is already the resolved `friendlyName`.

At the top of `_ptyHostVerb`, before the request is built:

```ts
if (verb === 'ptySendPrompt' && payload?.standingOrders !== false && typeof payload?.data === 'string') {
    const db = await this._getKanbanDb(this._resolvePrimaryRoot());
    const orders = db ? await db.getConfigJson<StandingOrder[]>(STANDING_ORDERS_CONFIG_KEY, []) : [];
    if (orders.length > 0) {
        // Nested call is safe: the guard above is verb-scoped, so ptyListTerminals
        // cannot re-enter this branch. Gated on orders.length so an operator who
        // never uses the feature pays nothing per dispatch.
        const listed = await this._ptyHostVerb('ptyListTerminals', {});
        const live = new Set<string>(
            (listed?.terminals || [])
                .filter((t: any) => t.status === 'active')
                .map((t: any) => t.friendlyName)
        );
        payload = { ...payload, data: applyStandingOrders(payload.data, payload.name, orders, live) };
    }
}
```

**Logic.** The hook sits above the transport, so both the JSON and raw-binary branches are unaffected (`ptyPasteImage` cannot match the verb guard). `payload` is copied, never mutated in place — callers such as `_attemptDirectTerminalPush` reuse their object for logging.

**Edge cases:** `_ptyHostVerb`'s early return when the pty host is down happens *before* any of this matters (place the hook after that guard so a dead host still short-circuits without a DB read); a DB that throws must not fail the dispatch — wrap the resolve in a `try`/`catch` that falls through with the prompt unchanged, because a missing standing block is a degraded prompt while a thrown error is a lost dispatch.

**Rename hook.**

> **Superseded:** "In the `ptyRenameTerminal` handling that `LocalApiServer` already routes, after a successful rename, rewrite `parent`/`child` matches in the store."
> **Reason:** `LocalApiServer` has no per-verb rename handling — `_handleTerminalVerb` forwards every verb generically. Under the extension host the rename executes inside the pty-host child's own `PtyFleetService` (`ptyFleetService.ts:391`), which has no database, so nothing at that depth can rewrite the store.
> **Replaced with:** Extend the post-dispatch hook that already exists for exactly this verb set — `handlePtyVerb`'s `if (['ptyCreateTerminal', 'ptyCloseTerminal', 'ptyRenameTerminal'].includes(verb))` block at `:2103`, which already resolves the DB and updates the `runtime.terminals` mirror. Add the standing-orders rewrite there, gated on `verb === 'ptyRenameTerminal' && result?.success !== false`, through the same serialized write chain as add/delete. The standalone counterpart is in §4.

### 4. `src/standalone/bootstrap.ts` — the standalone chokepoint

A local wrapper, declared beside `handlePtyVerb` (`:1056`) where `db` (`:197`) and `ptyFleetService` are both in scope:

```ts
const deliverPrompt = async (
    handle: any,
    text: string,
    opts: any,
    applyOrders = true
): Promise<void> => {
    let out = text;
    if (applyOrders) {
        try {
            const orders = await db.getConfigJson<StandingOrder[]>(STANDING_ORDERS_CONFIG_KEY, []);
            if (orders.length > 0) {
                const live = new Set(ptyFleetService.listActive().map(t => t.friendlyName));
                out = applyStandingOrders(text, handle.friendlyName, orders, live);
            }
        } catch { /* a degraded prompt beats a lost dispatch */ }
    }
    await sendPromptToPty(handle, out, opts);
};
```

Replace all four call sites:

| Line | Arm | `applyOrders` |
| :--- | :--- | :--- |
| `:1182` | `ptySendPrompt` verb | `payload.standingOrders !== false` |
| `:1345` | `triggerAction` (board dispatch) | `true` |
| `:1379` | `sendToTerminal` | `true` |
| `:1503` | `memoGeneratePrompt` send-to-planner (in `planningVerb`) | `true` |

`ptyFleetService.listActive()` is in-process, so standalone pays no round-trip even when orders exist.

**Rename hook (standalone).** In the `ptyRenameTerminal` arm (`:1146`), after `ptyFleetService.rename(...)` returns `true`, rewrite `parent`/`child` matches through the same serialized chain.

**Edge cases:** `:1503` lives in `planningVerb`, outside `handlePtyVerb` — declare `deliverPrompt` at a scope both can see, or the memo path silently keeps the bare `sendPromptToPty`. `:1345` and `:1379` may have just *created* the terminal, in which case `listActive()` includes it and `handle.friendlyName` is authoritative.

### 5. `src/webview/terminals.html`

Mode control and management list inside the existing modal body (`:1697-1719`, above the instruction label at `:1710`):

```html
<label class="link-field-label" for="link-mode">Mode</label>
<select id="link-mode" class="link-select">
    <option value="instant">Instant — deliver this message once, now</option>
    <option value="standing">Standing orders — append to every prompt sent to the parent</option>
</select>
```

and below `#link-error` (`:1714`):

```html
<div id="link-standing-list" class="link-standing-list" hidden></div>
```

CSS goes in the existing `.link-modal` block (`:1445-1519`), reusing `--panel-bg2` / `--border-color` / `--text-secondary`. The delete control is a bare `×` button that deletes on click.

**Edge cases:** the `standing` option carries `disabled` when the GET route reports `available: false`, with the reason in `#link-error` on selection attempt — no dead control (PRD #6).

### 6. `src/webview/terminals.js`

- `openLinkModal` (`:7425`): restore the last-used mode, fetch `GET /terminals/standing-orders`, render the list, and disable the standing option when `available` is false.
- `syncSendEnabled` (`:7418`): unchanged predicate (non-empty instruction), but the button label follows the mode — `SEND` vs `SAVE`. Add a live character counter against `MAX_INSTRUCTION_CHARS`.
- `sendLinkMessage` (`:7518`): branch on mode. The standing branch POSTs `{action:'add', parent, child, instruction}` and re-renders the list **without closing the modal** — the operator has just created a persistent thing and should see it land. The instant branch keeps its existing POST and gains `standingOrders: false` alongside the existing `clearBeforePrompt: false`, with a comment saying why (a link-up instruction must not carry the parent's own standing block back into itself).
- `wireLinkModal` (`:7579`): bind the mode `change` (label swap) and delegate the list's `×` clicks. Both new inputs need the `keydown` → `stopPropagation()` treatment the instruction textarea already has, or xterm eats the keystrokes.
- Shift-drop (`:3574`): apply the same block client-side before framing.

```js
// The Shift-drop paste writes straight to the terminal WebSocket and never
// reaches either host's delivery path, so the server-side append cannot see
// it. Same marker, so a prompt is never double-blocked.
const withOrders = applyStandingOrdersClient(promptText, targetName, standingOrders, liveNameSet());
entry.ws.send(encodeInputFrame('\x1b[200~' + withOrders + '\x1b[201~'));
```

`applyStandingOrdersClient` is a small mirror of the shared helper (this file is a plain browser script and cannot import the `.ts` module); the marker string and caps are duplicated as named constants with a comment pointing at `src/services/standingOrders.ts` as the source of truth. A contract test pins the two in lockstep.

**Edge cases:** the client mirror needs the order list in memory — refresh it on the same `fetchTerminalList` poll that maintains `fleetList`, so a Shift-drop immediately after a save is not stale; on fetch failure fall back to an empty list (deliver the bare prompt) rather than blocking the drop.

## Verification Plan

> **Session directive:** this planning session was run with SKIP COMPILATION and SKIP TESTS, so no build or suite was executed here. The contract tests below remain required deliverables of the implementing change — run them in a session without that directive.

### Manual / UAT

1. **Instant mode is untouched.** With no standing orders saved, open Link-up, leave the mode on Instant, send. The parent receives exactly the prompt it receives today.
2. **Standing order creation delivers nothing.** Switch to Standing orders, save. Confirm nothing is written into either terminal, and the new entry appears in the modal's list immediately.
3. **Pane normal-drop carries it.** Drag a plan card onto the parent's pane. The delivered prompt ends with the standing-orders block naming the child.
4. **Shift-drop carries it.** Same drag with Shift held. The pasted (unsubmitted) text ends with the same block — this path never touches either host's delivery code and is the one most likely to be missed.
5. **Extension-host board dispatch carries it.** Dispatch a card to the same terminal from the kanban board (the `_tryFleetDeliveryForRole` → `_attemptDirectTerminalPush` path, not the panel). Confirm the block is present — and confirm it survives a dispatch that `/clear`s first.
6. **Standalone board dispatch carries it.** Repeat 5 under `npx switchboard`. This is the `/kanban/verb/triggerAction` → `handlePtyVerb` → `deliverPrompt` path, which the original design did not cover — it is the single most important step in this list.
7. **Alias resolution.** Dispatch to the parent using a suffixed / different-case name so `_attemptDirectTerminalPush`'s normalizer resolves it. The block must still appear (it is keyed on the resolved `friendlyName`).
8. **No double-append.** Confirm exactly one marker block in every case above.
9. **Link-up opt-out.** With a standing order active on terminal A, send an *instant* link-up from A. Confirm the delivered instruction carries no standing-orders block.
10. **Delete is immediate.** Click × on an entry. It disappears with no confirm dialog, and the next dispatch to that terminal carries no block.
11. **Dead child.** Kill the child terminal. The entry renders greyed, is skipped on the next dispatch, and is still present after a panel reload.
12. **Rename.** Rename the parent, then dispatch to it under the new name. The block still applies. Repeat for the child and confirm the block names the new child name. Repeat both under standalone.
13. **Caps.** Save several long instructions totalling over 4000 characters; confirm the block truncates with the marker and the prompt still delivers. Attempt a 2001-character instruction via `curl` (bypassing the modal's counter) and confirm the route rejects it. Attempt a 21st order and confirm rejection.
14. **Marker forgery.** Attempt to save an instruction containing the marker string. The route rejects it; the feature keeps working.
15. **Multiple orders.** Two standing orders on one parent — both appear, in creation order, under one header.
16. **Concurrent write.** Add from two cockpit windows (or two `curl`s) simultaneously. Both entries survive.
17. **Cold path cost.** With zero standing orders saved, confirm no extra `ptyListTerminals` call is issued per extension-host dispatch.
18. **Capability gating.** With no reachable kanban DB, confirm the Standing option renders disabled rather than saving into the void.
19. **Catalog.** `GET /catalog` lists `/terminals/standing-orders` for both methods, and `npm run catalog:check` is clean against the committed file.

### Automated Tests

- **New — marker/cap lockstep contract test.** Assert that `applyStandingOrdersClient`'s marker string, `MAX_BLOCK_CHARS` and `MAX_INSTRUCTION_CHARS` in `src/webview/terminals.js` match the exported constants in `src/services/standingOrders.ts` by reading both sources. A drift here means the client mirror stops recognising the server's fence and starts double-blocking.
- **New — delivery-site coverage test.** Assert by source scan that `src/standalone/bootstrap.ts` contains no bare `await sendPromptToPty(` outside the `deliverPrompt` wrapper, and that `TaskViewerProvider.ts` routes every `/api/pty/` request through `_ptyHostVerb`. This is the enumerable guarantee that replaces "remember to hook all the sites".
- **New — resolver unit tests.** `applyStandingOrders`: empty prompt, marker already present, no matching parent, dead child filtered, multiple orders in creation order, over-cap truncation. `validateInstruction`: empty, over-length, marker-bearing.
- **Existing — must stay green.** `src/test/pty-route-surface-contract.test.js` (the `pty*`-verbs-off-the-generated-surface contract) and the terminal contract tests. `npm run catalog:check`, `npm run parity:check`.

---

**Recommendation: Send to Lead Coder** (complexity 7 — three coordinated append sites across two structurally different hosts, a new persistence store with a security surface, and a rename hook that must land in both hosts' parent processes).

## Implementation Summary

Implemented the standing-orders persistent append mode across both the extension and standalone hosts. Added `src/services/standingOrders.ts` as the shared resolver, `src/services/LocalApiServer.ts` management routes, `_ptyHostVerb` and rename hooks in `src/services/TaskViewerProvider.ts`, the `deliverPrompt` wrapper and call-site replacements in `src/standalone/bootstrap.ts`, and the mode/management UI in `src/webview/terminals.html` and `src/webview/terminals.js`. Also wired client-side Shift-drop append and regenerated `protocol-catalog.json` and `src/generated/verbAllowlist.ts`; `npm run catalog:check` and `npm run parity:check` both pass. No issues encountered.
