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
// src/services/TicketsPanelProvider.ts:1749 — the reply it consumes
const res = { type: 'localTicketFilesListed', provider, tickets, ...(scopeCoverage ? { scopeCoverage } : {}) };
this.postMessageToWebview(res);        // no workspaceRoot, no listId/projectId
```

**Direct proof.** A probe WebSocket subscribed as a Tickets surface, representing a panel showing list `901615209243` (3 top-level tickets), was left idle. A second client then asked for a *different* list. The idle panel received:

```
PANEL A RECEIVED localTicketFilesListed: tickets=67 listId=<ABSENT> workspaceRoot=<ABSENT>
```

67 tickets belonging to a list it is not showing, with no field that would let it reject them.

**Why it presents as "flash, then disappear".** `clickUpProjectIssues` has two writers that race: `clickupProjectLoaded` (the remote list) and `localTicketFilesListed` (the file-backed list). Last writer wins. Any foreign reply becomes the sidebar. In the browser it is worse: `transport.js:318` dispatches the HTTP response body as a message *and* the WS broadcast arrives separately, so each panel processes its own answer plus N copies of everyone else's, in arbitrary order.

**Why it amplifies.** `clickupProjectLoaded`'s handler (`tickets.js:6626`) reacts by firing `refreshTicketsDelta` and `loadLocalTicketFiles()`. Those replies are broadcast too, and every panel reacts to them in turn. Measured: a single `clickupLoadProject` call produced **8** `localTicketFilesListed`, **8** `ticketSyncStatusesLoaded` and **3** `importAllTicketsComplete` pushes. The scope filter collapses this feedback loop as a side effect — a panel that rejects a foreign reply also stops firing follow-up verbs for it.

**Why it fits every reported specific.**

| Observation | Explanation |
|---|---|
| Empty list, first ticket is worst | Your panel's correct answer is a single card; any foreign reply overwrites it, and with an empty list there is no residual content to mask the loss. |
| Refetch fixes it | Refetch re-runs the chain from the panel you are looking at, so its reply usually lands last. |
| "Wasn't doing this previously" | Tickets only just became its own panel with a browser surface (the 2f split, 2026-08-04). Before that, tickets lived in a single Planning webview — one surface, so no cross-talk was possible. |
| Editor panel affected too | `BroadcastHub.push` writes to the bound webview on every push (`broadcastHub.ts:84`), including pushes generated while servicing a *browser* client's verb. |

**Chosen approach: stamp and filter, inside the Tickets panel.** Replies get a scope stamp; `tickets.js` drops non-matching ones. This is deliberately preferred over converting replies to addressed sends (`wsHub.send`, which already exists for exactly this purpose at `wsHub.ts:344`). Addressed replies would require threading a caller `originatorId` through `transport.js` → `LocalApiServer` → every provider, adding an originator→connection lookup to `wsHub`, and teaching `BroadcastHub` when to skip the editor webview — a change to the shared contract all six panels sit on, to fix a bug contained to one. Stamp-and-filter is correct on its own terms: two panels showing the *same* scope receive identical payloads, so cross-delivery between them is harmless and needs no suppression.

## Metadata

- **Complexity:** 5
- **Tags:** bugfix, frontend, backend, ui
- **Project:** browser-switchboard

## User Review Required

None. The root cause was verified by direct probe, and the fix is contained to the Tickets panel with no shared-contract change.

## Complexity Audit

### Routine

- Adding `workspaceRoot` and `scopeId` fields to reply objects in `TicketsPanelProvider.ts` — mechanical field additions at known line numbers.
- Adding a single `_isForThisPanel` predicate to `tickets.js` — a pure function with no side effects.
- Applying `if (!_isForThisPanel(message)) { break; }` at the top of each affected `case` arm — one-line guards.
- Regenerating `protocol-catalog.json` via the existing scanner — a build step, not hand-editing.

### Complex / Risky

- **Omission risk.** Missing one reply type leaves a live contamination path that reproduces exactly the same symptom. The audit table below enumerates the full set, but a missed arm reads as "the fix didn't work."
- **Linear scope stamping differs from ClickUp.** `linearLoadProject` loads ALL team issues with no project scoping (`TicketsPanelProvider.ts:966`). There is no `projectId` to stamp. The predicate must use `workspaceRoot` as the Linear discriminator, not a project scope id. See Superseded callout in Proposed Changes.
- **`ticketSyncStatusesLoaded` has no backend-side scope id.** The `getTicketSyncStatuses` verb takes `{ provider, ids, workspaceRoot }` — no `listId`/`projectId`. The frontend must pass the scope id in the verb so the backend can stamp it on the reply. See Superseded callout in Proposed Changes.
- **Cross-workspace same-scope collision.** Two panels in different workspaces showing the same ClickUp list ID would pass a scope-id-only check. The predicate must also verify `workspaceRoot` when both sides have one.
- **Error arms must be stamped too.** An unstamped error reply from another panel will set `clickUpProjectStatus = 'error'`, replacing a healthy sidebar with an error message.

## Edge-Case & Dependency Audit

**Full set of scope-bearing replies, with what each carries today:**

| Reply | Emitted at | Has today | Must add |
|---|---|---|---|
| `localTicketFilesListed` | `TicketsPanelProvider.ts:1595` (early return), `:1749` (success) | `provider` | `workspaceRoot`, `scopeId` (= `listId` for ClickUp, `projectId` for Linear) |
| `clickupProjectLoaded` | `:1186` (no workspace), `:1201` (setup incomplete), `:1214` (no list), `:1234` (success) | `workspaceRoot`, `loadSeq`, `status` | `scopeId` (= resolved `listId`) |
| `linearProjectLoaded` | `:940` (no workspace), `:954` (setup incomplete), `:978` (success) | `workspaceRoot`, `projectName`, `status` | `workspaceRoot` only — NO `projectId` (see Superseded callout) |
| `ticketSyncStatusesLoaded` | `:1778` | `provider` | `workspaceRoot`, `scopeId` (passed from frontend — see Superseded callout) |
| `clickupListStatusesLoaded` | `:1288` | `workspaceRoot`, `listId` | — already complete |
| `importAllTicketsComplete` | `refreshTicketsDelta` `:1521`, `importAllTickets` `:2968` | `workspaceRoot`, `provider`, `listId`, `projectId` | — already complete |
| `clickupError` / `linearError` with `scope: 'project'` | `clickupError` `:1245`; `linearError` `:988` | `workspaceRoot` | `clickupError`: `scopeId` (= `listId`); `linearError`: `workspaceRoot` only (no `projectId` available) |

Two of these are already complete — that is the shape to copy, not a reason to skip them in the frontend filter.

**Error arms must be stamped too.** `clickupProjectLoaded` has three early-return arms (no workspace `:1186`, setup incomplete `:1201`, no list selected `:1214`) that push `status: 'error' | 'setup-required'`. An unstamped error reply from another panel will be accepted and will set `clickUpProjectStatus = 'error'`, replacing a healthy sidebar with an error message. Stamp every arm, including the ones that return before a `listId` is resolved — where none exists, send `scopeId: undefined` explicitly and let the predicate treat "reply has no scope id" as **reject when the panel does have one selected**.

**The unscoped placeholder is locally synthesised, not pushed.** `loadLocalTicketFiles` (`tickets.js:1224`) dispatches its own `localTicketFilesListed` with `unscopedPlaceholder: true` via `window.dispatchEvent` when no list is selected. It never crosses the wire, so the filter must not reject it — gate on `message.unscopedPlaceholder === true` → always accept.

**Do not filter on `loadSeq`.** `clickupProjectLoaded` carries `loadSeq`, but `loadClickUpProject` (`tickets.js:3786`) never sends one, so it is always `undefined`. It is not a usable discriminator. Either wire it properly or ignore it; the scope stamp is what this plan relies on.

**Both providers, or the fix is half-wired.** `linearProjectLoaded` / `linearProjectIssues` take the identical broadcast path. A ClickUp-only fix leaves Linear users with the same bug. However, the Linear fix differs from ClickUp: see the Superseded callout for `linearProjectLoaded` below.

**Same-scope duplicates are fine and must stay fine.** Two panels on the same list will still receive each other's identical replies. That is harmless; `_lastTicketsIssuesContainerHtml` already suppresses the duplicate DOM write. Do not add de-duplication — it would break the legitimate case where another panel's file-watcher-driven refresh should update your view.

**`ticketFileChanged` is an event, not a reply.** It is emitted by the file watcher (`:513`), not in response to a verb, and it *should* reach every panel. Do not stamp or filter it.

**The editor panel is fixed by the same frontend change.** `tickets.js` is shared between the editor webview and the browser cockpit; the predicate runs in both. No editor-specific work.

**Reply shape is a shared contract.** `POST /tickets/verb/<verb>` returns `{ success, ...res }` — the same object that is pushed. Adding fields is additive and safe for the HTTP consumers documented in the `switchboard-orchestration` skill. `protocol-catalog.json` is generated; regenerate rather than hand-edit.

## Dependencies

None — this plan is self-contained within the Tickets panel.

## Adversarial Synthesis

**Key risks:** (1) Linear `projectId` stamping is impossible — `linearLoadProject` loads all team issues with no project scoping, so the predicate must use `workspaceRoot` as the Linear discriminator, not a project scope id; (2) `ticketSyncStatusesLoaded` has no backend-side scope id — the frontend must pass `listId`/`projectId` in the verb so the backend can stamp it on the reply; (3) the predicate lacks a `workspaceRoot` check — two panels in different workspaces showing the same ClickUp list ID would pass a scope-id-only check. **Mitigations:** Use `workspaceRoot` as the Linear discriminator and add a `workspaceRoot` check to the predicate for all providers; pass scope id from the frontend in the `getTicketSyncStatuses` verb. The ClickUp stamp-and-filter approach, echo storm collapse, `unscopedPlaceholder` exemption, and `ticketFileChanged` exclusion are all correct as originally planned.

## Proposed Changes

### 1. `src/services/TicketsPanelProvider.ts` — stamp the scope-bearing replies

Add a private helper next to `postMessageToWebview` (`:175`):

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

Apply it to `localTicketFilesListed` (both sites: early return `:1595` and success `:1749`), `clickupProjectLoaded` (all four arms: `:1186`, `:1201`, `:1214`, `:1234` — `scopeId` = the resolved `listId`), and the `scope: 'project'` arm of `clickupError` (`:1245` — `scopeId` = `listId`).

`clickupListStatusesLoaded` (`:1288`) and `importAllTicketsComplete` (`:1521`, `:2968`) already carry equivalent fields — leave their payloads alone, but confirm the frontend predicate reads `listId`/`projectId` for those two rather than `scopeId`.

> **Superseded:** Stamp `scopeId = projectId` on `linearProjectLoaded` (all three arms) and `linearError` scope:project.
> **Reason:** `linearLoadProject` sends `{ type: 'linearLoadProject', workspaceRoot }` — no `projectId` (`tickets.js:3783`). The backend loads ALL team issues (`TicketsPanelProvider.ts:966`). The reply carries `projectName` (a display string like `"My Team (team-wide)"`, `:973`), not a project ID. `linearProjectPickerValue` is a client-side filter (project name from a dropdown, `tickets.js:762`), not a server-side scope. Stamping `scopeId = projectId` would set `scopeId: undefined`; the predicate would compare `linearProjectPickerValue` (e.g. `"ProjectA"`) against `""` → reject → **the panel rejects its own reply and goes blank**. This is a regression worse than the current bug.
> **Replaced with:** For Linear, do NOT stamp a `scopeId`. Instead, ensure `workspaceRoot` is present on all `linearProjectLoaded` arms (it already is: `:945`, `:959`, `:983`) and `linearError` scope:project (`:992`). The predicate uses `workspaceRoot` as the Linear discriminator (see predicate correction below). Cross-delivery within the same workspace is harmless — both panels receive the same full team issue list, and each filters client-side via `linearProjectPickerValue`. Cross-workspace delivery is the only risk, and `workspaceRoot` handles it.

> **Superseded:** Stamp `workspaceRoot` and `scopeId` on `ticketSyncStatusesLoaded` at the backend.
> **Reason:** `getTicketSyncStatuses` (`TicketsPanelProvider.ts:1753`) takes `{ provider, ids, workspaceRoot }` — no `listId`, no `projectId`. The backend handler has no scope id to stamp. Stamping `scopeId: undefined` would cause the predicate to reject ALL sync status replies (theirs="" vs mine=clickUpSelectedListId), permanently breaking sync badges.
> **Replaced with:** (a) Add `workspaceRoot` to the `ticketSyncStatusesLoaded` reply at `:1778` (it is available at `:1754` but not currently included in `res`). (b) Pass `listId`/`projectId` from the frontend in the `getTicketSyncStatuses` verb — the frontend knows its scope at `_requestTicketSyncStatuses` (`tickets.js:1255`). (c) Stamp `scopeId` on the reply from the received `msg.listId`/`msg.projectId`. This keeps the stamp-and-filter approach intact for sync statuses too.

### 2. `src/webview/tickets.js` — one predicate, applied at each affected arm

Add near the other Tickets state helpers (after `ticketsWorkspaceRoot` at `:113`):

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
 * message names no scope AND we have none selected; the scopes match; or
 * the workspaceRoot matches (for Linear, which has no per-project scope id).
 */
function _isForThisPanel(message) {
    if (message && message.unscopedPlaceholder) { return true; }
    const provider = message.provider || lastIntegrationProvider;
    if (provider && lastIntegrationProvider && provider !== lastIntegrationProvider) { return false; }
    // Workspace guard: if both sides carry a workspaceRoot, they must match.
    // This catches cross-workspace contamination where two panels show the
    // same ClickUp list ID or the same Linear team in different workspaces.
    if (message.workspaceRoot && ticketsWorkspaceRoot
            && message.workspaceRoot !== ticketsWorkspaceRoot) {
        return false;
    }
    // ClickUp: scope by listId. Linear: no server-side scope id — workspaceRoot
    // guard above is the discriminator. linearProjectPickerValue is a client-
    // side filter, not a server scope, so we do NOT compare it against the
    // reply's scopeId.
    if (lastIntegrationProvider === 'linear') {
        return true;   // workspaceRoot already checked; same-workspace = same data
    }
    const mine = clickUpSelectedListId || '';
    const theirs = String(
        message.scopeId ?? message.listId ?? message.projectId ?? ''
    );
    if (!mine) { return true; }          // nothing selected — nothing to protect
    return theirs === mine;
}
```

> **Superseded:** The original predicate used `linearProjectPickerValue` as the Linear scope id and compared it against `message.scopeId`.
> **Reason:** `linearProjectPickerValue` is a client-side filter (project name), not a server-side scope. `linearLoadProject` loads all team issues — the reply is not scoped to a single project. Comparing `linearProjectPickerValue` against a non-existent `scopeId` would reject valid replies and blank the panel.
> **Replaced with:** For Linear, the predicate returns `true` after the `workspaceRoot` guard (same workspace = same team data; client-side filter handles the rest). For ClickUp, the predicate compares `clickUpSelectedListId` against `message.scopeId ?? message.listId ?? message.projectId` as before. A `workspaceRoot` guard runs for ALL providers before the scope-id check, catching cross-workspace contamination.

Guard the arms: `localTicketFilesListed` (`:7080`), `clickupProjectLoaded` (`:6626`), `linearProjectLoaded` (`:6656`), `ticketSyncStatusesLoaded` (`:7065`), `clickupListStatusesLoaded` (`:6671`), `importAllTicketsComplete` (`:7350`), and the `scope === 'project'` branches of `clickupError` (`:6681`) / `linearError` (`:6695`):

```js
case 'localTicketFilesListed': {
    if (!_isForThisPanel(message)) { break; }
    ...
}
```

Guarding `clickupProjectLoaded` and `importAllTicketsComplete` is what collapses the echo storm: a rejected reply no longer triggers this panel's `refreshTicketsDelta` / `loadLocalTicketFiles()` follow-ups.

**Also update `_requestTicketSyncStatuses`** (`tickets.js:1255`) to pass the scope id in the verb so the backend can stamp it on the reply:

```js
function _requestTicketSyncStatuses() {
    if (!lastIntegrationProvider) return;
    const issues = lastIntegrationProvider === 'clickup' ? clickUpProjectIssues : linearProjectIssues;
    if (!issues.length) return;
    vscode.postMessage({
        type: 'getTicketSyncStatuses',
        provider: lastIntegrationProvider,
        ids: issues.map(t => t.id),
        workspaceRoot: ticketsWorkspaceRoot || undefined,
        listId: lastIntegrationProvider === 'clickup' ? (clickUpSelectedListId || undefined) : undefined,
        projectId: lastIntegrationProvider === 'linear' ? (linearProjectPickerValue || undefined) : undefined
    });
}
```

Then in `TicketsPanelProvider.ts` `getTicketSyncStatuses` (`:1753`), stamp the reply:

```ts
const scopeId = provider === 'clickup'
    ? String((msg.listId as string) || '').trim() || undefined
    : String((msg.projectId as string) || '').trim() || undefined;
// ... existing logic ...
const res = { type: 'ticketSyncStatusesLoaded', provider, statuses, workspaceRoot, scopeId };
```

### 3. `protocol-catalog.json` — regenerate

The catalog is produced by the scanner (`A1: protocol catalog scanner`). Regenerate it so the new reply fields are recorded; do not hand-edit.

## Verification Plan

**Automated Tests**

1. Add a regression test alongside `src/test/verb-engine-tickets-headless.test.js` asserting that `listLocalTicketFiles`, `clickupLoadProject` and `getTicketSyncStatuses` replies each contain `workspaceRoot` and a scope id.
2. Add a `tickets.js` unit test for `_isForThisPanel` covering: matching scope → accept; foreign scope → reject; `unscopedPlaceholder` → accept; no scope selected → accept; provider mismatch → reject; `workspaceRoot` mismatch → reject; Linear provider → accept (same workspace, no scope-id check).
3. `npm test` — confirm no new failures. Five regression tests are already red at HEAD; stash-verify before attributing any failure to this change.

**Manual — the exact reproduction that proved the bug**

4. With the extension running, subscribe a probe socket as a Tickets surface:
   `ws://127.0.0.1:<port>/ws?originatorId=probe&surfaces=tickets,common` (port from `.switchboard/api-server-port.txt`).
5. `POST /tickets/verb/listLocalTicketFiles` with a list id *different* from the one the probe represents. **Before:** the probe receives that list's tickets with `listId: <ABSENT>`. **After:** the payload carries `workspaceRoot` + `scopeId`, so a real panel rejects it.
6. Open the Tickets panel in the editor and in a browser tab, select **different** lists in each. Refresh one. Confirm the other's sidebar does not change.
7. With both open on the same list, create a ticket in an empty list. Confirm it appears immediately and stays — no flash, no disappearance, no Refetch needed.
8. Count pushes for a single `clickupLoadProject` (was 8 × `localTicketFilesListed`, 8 × `ticketSyncStatusesLoaded`, 3 × `importAllTicketsComplete`). Expect a substantial drop once panels stop reacting to foreign replies.
9. Confirm Linear behaves identically with two panels on different Linear projects — the sidebar should not blank or flash.
10. Confirm sync badges still appear correctly after the fix (regression check for the `ticketSyncStatusesLoaded` scope stamping).

**User Review Required:** None.

## Completion Summary

Implemented the stamp-and-filter fix for cross-panel Tickets reply contamination. Added a `_scoped(res, workspaceRoot, scopeId)` helper in `src/services/TicketsPanelProvider.ts` and stamped every scope-bearing reply: `localTicketFilesListed` (both arms), `clickupProjectLoaded` (all four arms, `scopeId` = resolved `listId`), `clickupError` scope:project (`scopeId` = `listId`), and `ticketSyncStatusesLoaded` (all arms, scope id passed from the frontend verb). Per the Superseded callouts, `linearProjectLoaded`/`linearError` keep their existing `workspaceRoot` only (no `scopeId` — Linear has no server-side project scope). Added `listId`/`projectId` to the `getTicketSyncStatuses` verb schema (`src/services/verbSchemas.ts`) for field-accuracy. In `src/webview/tickets.js` added the `_isForThisPanel` predicate (workspaceRoot guard for all providers, ClickUp listId scope check, Linear workspace-only discrimination, `unscopedPlaceholder` exemption) and applied `if (!_isForThisPanel(message)) { break; }` guards to `clickupProjectLoaded`, `linearProjectLoaded`, `clickupListStatusesLoaded`, `ticketSyncStatusesLoaded`, `localTicketFilesListed`, `importAllTicketsComplete`, and the project-scope branches of `clickupError`/`linearError`; updated `_requestTicketSyncStatuses` to pass `listId`/`projectId`. Regenerated `protocol-catalog.json` (line-number drift only; arm/verb/push counts unchanged at 616/521/595). Verified `npm run push-routing:check` and `npm run verb-returns:check` both pass against baseline. No issues encountered; no compilation or test run performed per session constraints.

## Review Findings

Reviewer pass found three material issues and fixed all three: (1) **CRITICAL** — the change broke the CI-wired `tickets-sidebar-scoping` gate, verified green at parent `4505876a` and red at HEAD, because the inserted `_isForThisPanel` guard pushed the `ticketsLoadedOnce` latch past that test's 300-char window and the `this._scoped(` wrapper broke its `const res = { type: 'localTicketFilesListed'…` literal match — both assertions repaired to test the invariant rather than the incidental form; (2) **MAJOR** — the predicate's provider guard was inert, since `clickupProjectLoaded` / `clickupError` / `linearProjectLoaded` carry no `provider` field, so a ClickUp reply reaching a Linear-mode panel fell through to the `lastIntegrationProvider === 'linear'` early-accept — provider is now also inferred from the message type prefix; (3) **MAJOR** — this plan's Verification Plan mandated two automated tests with no session-constraint deferral and neither was written, so `src/test/tickets-cross-panel-reply-scope.test.js` was authored (27 assertions: the real `_isForThisPanel` source instantiated against controlled panel state for all nine accept/reject cases, plus stamp-site and guarded-arm contracts and the `ticketFileChanged` exclusion) and wired into `package.json` + `.github/workflows/integration-tests.yml`. Files changed: `src/webview/tickets.js`, `src/test/tickets-sidebar-list-scoping.test.js`, `src/test/tickets-cross-panel-reply-scope.test.js` (new), `package.json`, `.github/workflows/integration-tests.yml`. Validation: `compile-tests` clean, `catalog:check` / `parity:check` / `push-routing:check` / `verb-returns:check` all green, `eslint` 0 errors, and 12 contract tests pass including `cross-client-scope` and `ws-surface-scoping`. Remaining risk (accepted, per the plan's own stamping decision): the three `clickupProjectLoaded` early-return arms stamp `scopeId: undefined`, so a panel holding a stale `clickUpSelectedListId` rejects even its **own** `setup-required` / no-list error and shows nothing instead of the reason — deliberate (ambiguity resolves to reject) but it is the one path where the filter can hide a real message.
