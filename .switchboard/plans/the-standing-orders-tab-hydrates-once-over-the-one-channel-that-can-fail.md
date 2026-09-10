# The Standing Orders Tab Hydrates Once, Over the One Channel That Can Fail

## Goal

Stop the Standing Orders tab claiming there is no Kanban database when there is one. Make its
hydration survive a dropped WebSocket, and make the red line say something true.

### Problem analysis

**Reproduced from the operator's report:** open the board's STANDING ORDERS tab → a red line reads
*"Standing orders require a Kanban database. Open Setup to configure one."* The database exists, is
open, and holds four orders.

**The message is not a server verdict. It is the client's initial state.**

- `kanban.html:6974` — `const standingOrdersTabState = { available: false, ... }`.
- `kanban.html:7095` — the red line is shown whenever that flag is falsy, and `:7096`/`:7097`
  disable both ADD buttons with it.

So the line does not mean "no database". It means *"nothing has answered me yet"* — and it is
painted **before** anything could have: the tab-activation arm posts the verb and then calls
`standingOrdersTabRender()` synchronously in the same block (`:6899-6902`).

**Verified against the live host — the server side is healthy.**

```
POST /kanban/verb/getStandingOrders  ->  {"success":true,"available":true,"orders":[ ...4... ]}
GET  /terminals/standing-orders      ->  {"success":true,"available":true, ... }
```

A WS client opened against the running host also receives the push: `standingOrders` arrives with
`payload.available = true`.

**Clearing the line depends on the WebSocket, and on nothing else.**

- `KanbanProvider.ts:14106` sends the typed payload through `postMessage` → `_broadcaster.push` →
  `wsHub.broadcast`. That is the only typed delivery.
- The HTTP response body is returned **untyped** on purpose. The comment at `KanbanProvider.ts:14077`
  explains why: in the browser `transport.js` dispatches the return body *and* the broadcaster
  mirrors the push, so a typed body makes the panel handle every response twice — and because each
  write verb's success handler re-requests, that doubles the round trips on every write.
- `transport.js:522` does `dispatchMessage(result)` on that untyped body. The panel's
  `switch (msg.type)` matches nothing (`type` is `undefined`) and it is dropped silently.

The tab therefore has exactly one hydration channel, requests on it exactly once per activation, and
cannot recover from a miss. Two misses are reachable, both sticky:

1. **WS down at request time.** A host restart with the board page left open: `transport.js`
   reconnects with backoff, the verb still returns 200 with `available:true`, and the push has
   nowhere to land. On reconnect the client gets `__resync`, which carries board state — standing
   orders are not part of it — so the tab stays red until the operator clicks away and back.
2. **Request lands inside the boot window.** Before a workspace root resolves,
   `_resolveStandingOrdersRoot` (`KanbanProvider.ts:1205`) returns null and the host pushes a
   genuine `available:false` (`:14086`). One bad answer, no retry, red for the life of the page.

**The message also conflates three unrelated causes.** "Not answered yet", "no workspace root
resolved" and "the DB read threw" (`:14109`) all render as the same sentence, and only the second is
even close to true.

**Relationship to the sibling defect.** This is the same read-back family as
`the-project-panel-waits-for-a-push-the-standalone-host-never-sends.md`, but not the same bug: there
the standalone host never pushes at all. Here the push exists and works — the fragility is that it
is the *only* channel, and the response body is deliberately inert. Fix them together if the
transport-level conversion in that plan is chosen, since it would cover both.

## Metadata

**Complexity:** 2
**Tags:** bugfix, standalone, kanban, standing-orders, parity
**Dependencies:** shares a seam with `The Project Panel Waits for a Push the Standalone Host Never
Sends`. Fix that one first if the transport conversion is taken.

## User Review Required

None.

## Proposed Changes

### 1. Let the read verb's response hydrate the tab

- **Logic:** give `getStandingOrders`'s HTTP body a distinct type — `standingOrdersResult` — handled
  by the same code path as the `standingOrders` push. Double handling is safe for a **read**: it
  costs one extra idempotent render, not an extra round trip. The double-dispatch hazard the
  `:14077` comment names applies to the **write** verbs, whose success handlers re-request; leave
  those three bodies untyped.
- The push stays as it is, so a write made in one client still updates every other one.

### 2. Tell the truth in the gate

- Initialise `available` as `null` ("not answered yet") and show the red line only once a response
  has actually said `false`. Until then, render nothing, or a quiet loading state.
- When the host does refuse, say which refusal it was. `_resolveStandingOrdersRoot` returning null
  and a DB read throwing are different operator problems and only one of them is fixed in Setup;
  carry a `reason` on the `available:false` payload and render it.

### 3. Re-request after a reconnect

- `transport.js` already fires `sbTransportReconnected` (`:223`). The Standing Orders tab should
  re-request on it when it is the active tab, so a host restart heals without a click.
- Check the other tabs that hydrate once on activation for the same gap — this is a shape, not one
  tab. Any tab whose only hydration is a push, requested once, has it.

## Verification Plan

- With the host healthy, opening STANDING ORDERS shows the four orders and no red line — including
  on the first activation after a page load, with the WS artificially blocked.
- Killing and restarting the host with the board page open: the tab recovers without a manual tab
  switch.
- A genuinely unresolved workspace root shows a message naming that cause, not the database.
- No extra `getStandingOrders` round trips on add / update / delete (count them).

## Outstanding Questions

- How many other tabs hydrate once-on-activation with a push as the only channel? Worth a ratchet
  alongside `scripts/check-standalone-push-parity.js`, which measures pushed payloads and would not
  register a *dropped* reply as a gap at all.
