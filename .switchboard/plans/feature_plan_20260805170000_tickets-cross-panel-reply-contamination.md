# Tickets panel: stop cross-panel replies from overwriting the sidebar

## Goal

Make every scope-bearing Tickets reply carry the identity of the request that produced it, and make `tickets.js` ignore any reply that does not match the panel's own current selection. After this change, a newly created ticket stays on screen, and one panel's list load can never repaint (or blank) another panel's sidebar.

### Problem analysis & root cause

**Reported symptom.** Creating a ClickUp ticket succeeds remotely, but the new ticket does not appear in the sidebar — "the sidebar flashes with a lot of stuff and it disappears". Clicking **Refetch** makes it appear. It happens in the browser cockpit *and* in the editor panel, and is most obvious when creating the first ticket in an empty list.

**What is NOT wrong** (all four verified live against the running extension on port 59839, workspace `/Users/patrickvuleta/Documents/Gitlab`, list `901615209243`):

- The ClickUp task is created.
- `importTaskAsDocument` writes the local `.md` with correct `listId:` frontmatter.
- `registerImportedTicket` writes the `imported_docs` row with the right `workspace_id` and `content_type='ticket'`.
- `POST /tickets/verb/listLocalTicketFiles` returns the correct, correctly-scoped set.

Do not spend time on the import path, the delta cursor, the destructive-prune gates, or the `imported_docs` heal scan. They were each ruled out by direct measurement. (One specific trap: a list can legitimately show fewer sidebar rows than it has files, because subtasks carry `parentId:` in frontmatter and are deliberately excluded by `hiddenBySubtask`. That is correct behaviour, not the bug.)

**Actual root cause — replies are broadcast, and are not self-identifying.**

`TicketsPanelProvider.postMessageToWebview` routes through `_pushTo` → `BroadcastHub.push(message, 'tickets')`, which fans out to *both* the bound editor webview and `wsHub.broadcast(...)` — i.e. to **every** connected surface subscribed to the `tickets` surface. There is no addressing: a reply generated for panel B is delivered verbatim to panel A.

The receiving handler then consumes it unconditionally, because the payload contains nothing it could filter on:

```js
// src/webview/tickets.js:7080 — localTicketFilesListed
const tickets = message.tickets || [];
...
clickUpProjectIssues = tickets.map(t => ({ ... }));   // unconditional overwrite
renderTicketsTab();
```

```ts
// src/services/TicketsPanelProvider.ts:1748 — the reply it consumes
const res = { type: 'localTicketFilesListed', provider, tickets, ...(scopeCoverage ? { scopeCoverage } : {}) };
this.postMessageToWebview(res);        // no workspaceRoot, no listId/projectId
```

**Direct proof.** A probe WebSocket subscribed as a Tickets surface, representing a panel showing list `901615209243` (3 top-level tickets), was left idle. A second client then asked for a *different* list. The idle panel received:

```
PANEL A RECEIVED localTicketFilesListed: tickets=67 listId=<ABSENT> workspaceRoot=<ABSENT>
```

67 tickets belonging to a list it is not showing, with no field that would let it reject them.

**Why it presents as "flash, then disappear".** `clickUpProjectIssues` has two writers that race: `clickupProjectLoaded` (the remote list) and `localTicketFilesListed` (the file-backed list). Last writer wins. Any foreign reply becomes the sidebar. In the browser it is worse: `transport.js:317` dispatches the HTTP response body as a message *and* the WS broadcast arrives separately, so each panel processes its own answer plus N copies of everyone else's, in arbitrary order.

**Why it amplifies.** `clickupProjectLoaded`'s handler (`tickets.js:6626`) reacts by firing `refreshTicketsDelta` and `loadLocalTicketFiles()`. Those replies are broadcast too, and every panel reacts to them in turn. Measured: a single `clickupLoadProject` call produced **8** `localTicketFilesListed`, **8** `ticketSyncStatusesLoaded` and **3** `importAllTicketsComplete` pushes. The scope filter collapses this feedback loop as a side effect — a panel that rejects a foreign reply also stops firing follow-up verbs for it.

**Why it fits every reported specific.**

| Observation | Explanation |
|---|---|
| Empty list, first ticket is worst | Your panel's correct answer is a single card; any foreign reply overwrites it, and with an empty list there is no residual content to mask the loss. |
| Refetch fixes it | Refetch re-runs the chain from the panel you are looking at, so its reply usually lands last. |
| "Wasn't doing this previously" | Tickets only just became its own panel with a browser surface (the 2f split, 2026-08-04). Before that, tickets lived in a single Planning webview — one surface, so no cross-talk was possible. |
| Editor panel affected too | `BroadcastHub.push` writes to the bound webview on every push, including pushes generated while servicing a *browser* client's verb. |

**Chosen approach: stamp and filter, inside the Tickets panel.** Replies get a scope stamp; `tickets.js` drops non-matching ones. This is deliberately preferred over converting replies to addressed sends (`wsHub.send`, which already exists for exactly this purpose at `wsHub.ts:344`). Addressed replies would require threading a caller `originatorId` through `transport.js` → `LocalApiServer` → every provider, adding an originator→connection lookup to `wsHub`, and teaching `BroadcastHub` when to skip the editor webview — a change to the shared contract all six panels sit on, to fix a bug contained to one. Stamp-and-filter is correct on its own terms: two panels showing the *same* scope receive identical payloads, so cross-delivery between them is harmless and needs no suppression.

## Metadata

- **Complexity:** 5
- **Tags:** bugfix, frontend, backend, tickets, webview, browser-cockpit

## Complexity Audit

**Moderate — mechanically simple, but the completeness of the stamped set is what makes it correct.**

The change is two-sided and must land together:

1. **Backend** (`src/services/TicketsPanelProvider.ts`): add scope fields to the scope-bearing replies. Most already carry `workspaceRoot`; the gap is a consistent list/project id.
2. **Frontend** (`src/webview/tickets.js`): one shared predicate, applied at the top of each affected `case` arm.

The risk is not difficulty, it is **omission**. Missing one reply type leaves a live contamination path that reproduces exactly the same symptom and reads as "the fix didn't work". The audit below therefore enumerates the full set with current payload shape.

Not in scope: the ~40 other Tickets push types (attachments, comments, setup states, folder browsing). They do not write list-scoped sidebar state. Ticket-detail replies are addressed by ticket id and already tolerate cross-delivery through the existing detail-cache keying.

## Edge-Case & Dependency Audit

**Full set of scope-bearing replies, with what each carries today:**

| Reply | Emitted at | Has today | Must add |
|---|---|---|---|
| `localTicketFilesListed` | `TicketsPanelProvider.ts:1595`, `:1748` | `provider` | `workspaceRoot`, `scopeId` |
| `clickupProjectLoaded` | `:1233` (+ 3 error arms) | `workspaceRoot`, `loadSeq`, `status` | `listId` |
| `linearProjectLoaded` | `:979` (+ 2 error arms) | `workspaceRoot`, `projectName`, `status` | `projectId` |
| `ticketSyncStatusesLoaded` | `:1781` | `provider` | `workspaceRoot`, `scopeId` |
| `clickupListStatusesLoaded` | `:1288` | `workspaceRoot`, `listId` | — already complete |
| `importAllTicketsComplete` | `refreshTicketsDelta`, `:1521` | `workspaceRoot`, `provider`, `listId`, `projectId` | — already complete |
| `clickupError` / `linearError` with `scope: 'project'` | various | `workspaceRoot` | `listId` / `projectId` |

Two of these are already complete — that is the shape to copy, not a reason to skip them in the frontend filter.

**Error arms must be stamped too.** `clickupProjectLoaded` has three early-return arms (no workspace, setup incomplete, no list selected) that push `status: 'error' | 'setup-required'`. An unstamped error reply from another panel will be accepted and will set `clickUpProjectStatus = 'error'`, replacing a healthy sidebar with an error message. Stamp every arm, including the ones that return before a `listId` is resolved — where none exists, send `listId: undefined` explicitly and let the predicate treat "reply has no scope id" as **reject when the panel does have one selected**.

**The unscoped placeholder is locally synthesised, not pushed.** `loadLocalTicketFiles` (`tickets.js:1224`) dispatches its own `localTicketFilesListed` with `unscopedPlaceholder: true` via `window.dispatchEvent` when no list is selected. It never crosses the wire, so the filter must not reject it — gate on `message.unscopedPlaceholder === true` → always accept.

**Do not filter on `loadSeq`.** `clickupProjectLoaded` carries `loadSeq`, but `loadClickUpProject` (`tickets.js:3789`) never sends one, so it is always `undefined`. It is not a usable discriminator. Either wire it properly or ignore it; the scope stamp is what this plan relies on.

**Both providers, or the fix is half-wired.** `linearProjectLoaded` / `linearProjectIssues` take the identical path. A ClickUp-only fix leaves Linear users with the same bug.

**Same-scope duplicates are fine and must stay fine.** Two panels on the same list will still receive each other's identical replies. That is harmless; `_lastTicketsIssuesContainerHtml` already suppresses the duplicate DOM write. Do not add de-duplication — it would break the legitimate case where another panel's file-watcher-driven refresh should update your view.

**`ticketFileChanged` is an event, not a reply.** It is emitted by the file watcher (`:513`), not in response to a verb, and it *should* reach every panel. Do not stamp or filter it.

**The editor panel is fixed by the same frontend change.** `tickets.js` is shared between the editor webview and the browser cockpit; the predicate runs in both. No editor-specific work.

**Reply shape is a shared contract.** `POST /tickets/verb/<verb>` returns `{ success, ...res }` — the same object that is pushed. Adding fields is additive and safe for the HTTP consumers documented in the `switchboard-orchestration` skill. `protocol-catalog.json` is generated; regenerate rather than hand-edit.

## Proposed Changes

### 1. `src/services/TicketsPanelProvider.ts` — stamp the scope-bearing replies

Add a private helper next to `postMessageToWebview` (`:175`) and route the scoped replies through it:

```ts
/**
 * Stamp a reply with the identity of the request that produced it.
 *
 * Every push from this panel is BROADCAST (BroadcastHub → wsHub) to every
 * connected Tickets surface — editor webview and all browser tabs. A reply
 * that does not say which workspace + list/project it answers for is
 * indistinguishable from the receiving panel's own reply, and tickets.js
 * will render it over the top of the correct one. Verified 2026-08-05: a
 * panel showing a 3-ticket list received a foreign 67-ticket payload.
 */
private _scoped(res: any, workspaceRoot: string | null, scopeId?: string): any {
    return { ...res, workspaceRoot: workspaceRoot ?? undefined, scopeId: scopeId ?? undefined };
}
```

Apply it to `localTicketFilesListed` (both sites), `ticketSyncStatusesLoaded`, `clickupProjectLoaded` (all four arms, `scopeId` = the resolved `listId`), `linearProjectLoaded` (all three arms, `scopeId` = `projectId`), and the `scope: 'project'` arms of `clickupError` / `linearError`.

`clickupListStatusesLoaded` and `importAllTicketsComplete` already carry equivalent fields — leave their payloads alone, but confirm the frontend predicate reads `listId`/`projectId` for those two rather than `scopeId`.

### 2. `src/webview/tickets.js` — one predicate, applied at each affected arm

Add near the other Tickets state helpers:

```js
/**
 * Is this push an answer to a request THIS panel made?
 *
 * Host replies are broadcast to every Tickets surface, so a reply for another
 * panel's list arrives here looking exactly like our own. Accepting it
 * overwrites clickUpProjectIssues with a foreign list — the "sidebar flashes
 * with a lot of stuff and then disappears" bug. Reject anything that names a
 * scope other than the one we are showing.
 *
 * Accepts when: the message is our locally-synthesised placeholder; the
 * message names no scope AND we have none selected; or the scopes match.
 */
function _isForThisPanel(message) {
    if (message && message.unscopedPlaceholder) { return true; }
    const provider = message.provider || lastIntegrationProvider;
    if (provider && lastIntegrationProvider && provider !== lastIntegrationProvider) { return false; }
    const mine = lastIntegrationProvider === 'clickup'
        ? (clickUpSelectedListId || '')
        : (linearProjectPickerValue || '');
    const theirs = String(
        message.scopeId ?? message.listId ?? message.projectId ?? ''
    );
    if (!mine) { return true; }          // nothing selected — nothing to protect
    return theirs === mine;
}
```

Guard the arms: `localTicketFilesListed` (`:7080`), `clickupProjectLoaded` (`:6626`), `linearProjectLoaded` (`:6651`), `ticketSyncStatusesLoaded`, `clickupListStatusesLoaded`, `importAllTicketsComplete` (`:7345`), and the `scope === 'project'` branches of `clickupError` / `linearError`:

```js
case 'localTicketFilesListed': {
    if (!_isForThisPanel(message)) { break; }
    ...
}
```

Guarding `clickupProjectLoaded` and `importAllTicketsComplete` is what collapses the echo storm: a rejected reply no longer triggers this panel's `refreshTicketsDelta` / `loadLocalTicketFiles()` follow-ups.

### 3. `protocol-catalog.json` — regenerate

The catalog is produced by the scanner (`A1: protocol catalog scanner`). Regenerate it so the new reply fields are recorded; do not hand-edit.

## Verification Plan

**Automated**

1. Add a regression test alongside `src/test/verb-engine-tickets-headless.test.js` asserting that `listLocalTicketFiles`, `clickupLoadProject` and `getTicketSyncStatuses` replies each contain `workspaceRoot` and a scope id.
2. Add a `tickets.js` unit test for `_isForThisPanel` covering: matching scope → accept; foreign scope → reject; `unscopedPlaceholder` → accept; no scope selected → accept; provider mismatch → reject.
3. `npm test` — confirm no new failures. Five regression tests are already red at HEAD; stash-verify before attributing any failure to this change.

**Manual — the exact reproduction that proved the bug**

4. With the extension running, subscribe a probe socket as a Tickets surface:
   `ws://127.0.0.1:<port>/ws?originatorId=probe&surfaces=tickets,common` (port from `.switchboard/api-server-port.txt`).
5. `POST /tickets/verb/listLocalTicketFiles` with a list id *different* from the one the probe represents. **Before:** the probe receives that list's tickets with `listId: <ABSENT>`. **After:** the payload carries `workspaceRoot` + `scopeId`, so a real panel rejects it.
6. Open the Tickets panel in the editor and in a browser tab, select **different** lists in each. Refresh one. Confirm the other's sidebar does not change.
7. With both open on the same list, create a ticket in an empty list. Confirm it appears immediately and stays — no flash, no disappearance, no Refetch needed.
8. Count pushes for a single `clickupLoadProject` (was 8 × `localTicketFilesListed`, 8 × `ticketSyncStatusesLoaded`, 3 × `importAllTicketsComplete`). Expect a substantial drop once panels stop reacting to foreign replies.
9. Confirm Linear behaves identically with two panels on different Linear projects.

**User Review Required:** None.
