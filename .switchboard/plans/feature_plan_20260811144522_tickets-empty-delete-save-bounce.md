# Deleted ticket description bounces back after Save in tickets.html

## Goal

Make the Tickets detail pane in `tickets.html` honour an explicitly empty local description, so that selecting all body text, deleting it, and clicking **Save** removes the body from the preview and **Push** later sends the new (empty) body instead of the original remote description.

### Problem

In `src/webview/tickets.html` / `src/webview/tickets.js`, when a user enters Edit on a ticket, selects all the description text in the markdown editor, presses Delete, and clicks **Save**:

- The deleted body reappears in the preview immediately after Save.
- If they then click **Push**, the original (undeleted) content is sent to the provider, so the edit is lost remotely.

### Root cause

1. **An empty local description falls through to the remote one.** `renderTicketsLinearTaskDetail` (`:3374`) and `renderTicketsClickUpTaskDetail` (`:3484`) build the body from a `||` chain that starts with the local markdown:

   ```js
   const descSrc = (selectedClickUpIssue.descriptionMarkdown || task.markdownDescription || task.description || '').trim();
   ```

   When the user deletes the entire body, `descriptionMarkdown` is `''` — falsy — so the chain continues to the stale provider-side `task.markdownDescription` / `issue.description`. `renderedDescriptionHtml` is `''` too (`renderMarkdown('')` returns `''`), so the preferred branch above it does not fire either. That is the visible "bounce back". The chain cannot distinguish "the user deliberately cleared the body" from "nothing local was loaded", because `''` means both.

2. **Save and refresh are not sequenced.** `btn-save-ticket-edit` (`:5173`) posts `saveLocalTicketFile` and immediately calls `exitTicketsEditMode()` (`:5202`), which itself ends with `_refreshSelectedTicketFromFile()` (`:3154`) — a `readLocalTicketFile` request issued before the host has confirmed the write. If the read wins the race, the just-edited in-memory state is overwritten by a still-on-disk version. `pushTicketEdits` reads the local file directly, so a write that has not landed causes the old content to be pushed.

3. **`saveLocalTicketFile` is silent.** The host arm (`TicketsPanelProvider.ts:2142`) writes the file and then `break`s on every path — success and all four failure paths. It never tells the webview when it is safe to leave edit mode or refresh, and it returns nothing in the HTTP body, so a headless caller cannot see the outcome either.

## Metadata

- **Complexity:** 5
- **Tags:** bugfix, frontend, backend, ui, ux
- **Project:** Browser Switchboard

> **Superseded:** Complexity 4.
> **Reason:** the change grew two obligations that were not in the original scope and are both load-bearing: the renderer edit is pinned character-for-character by an existing contract test (`tickets-description-markdown-fallback.test.js`) that must be updated in lockstep, and converting the host arm's `break`s to `return`s moves the `Tickets` return-contract ratchet ceiling, which CI enforces. Still majority-routine, but with two well-scoped cross-cutting risks — the definition of a 5.
> **Replaced with:** Complexity 5.

## User Review Required

None. Empty-means-empty is the decided semantic; the title-clearing fallback is explicitly out of scope and unchanged.

## Complexity Audit

### Routine
- The display fix is a three-branch renderer change at two sites (`:3374`, `:3484`).
- The save-acknowledgement is one new host push and one new webview message arm.
- The Push guard is a two-line early return in an existing listener (`:5210`).

### Complex / Risky
- **The renderer line is pinned by a contract test.** `src/test/tickets-description-markdown-fallback.test.js` asserts the exact `descSrc` expression in both renderers with a literal regex (`const descSrc = \(selectedLinearIssue\.descriptionMarkdown \|\| issue\.description \|\| ''\)\.trim\(\);` and the ClickUp twin). Changing that line without updating the test turns the suite red; changing the test carelessly deletes the guard that keeps escaped-plaintext rendering from returning. Both must move together, deliberately.
- **`break` → `return` moves the ratchet.** `scripts/check-verb-return-contract.js` enforces `scripts/verb-return-contract-baseline.json`, where `"Tickets": 55`. Converting the five `break`s in `saveLocalTicketFile` lowers the provider's true residual count; the PRD requires the ceiling to be lowered **in the same change**, to whatever `analyze-verb-migration2.js` reports post-conversion. Leaving it at 55 banks the win without locking it.
- **Both renderers early-return while `ticketsEditMode` is true** (`:3304`, `:3414`). Deferring `exitTicketsEditMode()` until the ack means the pane stays in the editor for the duration of the round-trip — acceptable, but it makes a lost/failed ack a visible stuck state, which is why the failure branch must clear the pending flag and surface an error rather than silently doing nothing.
- **`exitTicketsEditMode()` already refreshes.** It ends with `_refreshSelectedTicketFromFile()` (`:3154`), so the new ack arm must not call both — see Proposed Change 3.

**Main judgement calls:**
- Distinguishing "intentionally empty local markdown" from "not yet loaded" in the renderer. `typeof descriptionMarkdown === 'string'` is the discriminator: every path that owns the local body (`btn-save-ticket-edit` `:5191`/`:5196`, `localTicketFileRead` `:7866`/`:7881`, `_applyTicketFilePayloadToSelected` `:6907`/`:6916`) sets it to a string, and the pre-fetch card-click stub (`{ task, detailsFetched: false }`, `:3186`) leaves it `undefined`. `localDescription === true` is the semantic twin but adds nothing here: the API ingestion arms set `descriptionMarkdown` from the remote payload anyway, so on that path both discriminators pick the same string.
- Whether to add a new host-to-webview message or reuse `localTicketFileRead`. A dedicated `localTicketFileSaved` signal is the cleanest way to order the post-save read.

## Edge-Case & Dependency Audit

| Case | Required behaviour |
| --- | --- |
| Empty body after a local save | Preview must show the `No description provided.` placeholder, not the provider's original `markdownDescription` / `description`. |
| Non-empty body after a local save | Preview must continue to show the edited rendered HTML via the `renderedDescriptionHtml` branch. |
| Remote ticket never edited | `clickupTaskDetailsLoaded` (`:7650`) / `linearTaskDetailsLoaded` (`:7616`) set `descriptionMarkdown` from `message.task.markdownDescription` / `message.issue.description`; the renderer must still display that correctly. Since those arms also normalise `renderedDescriptionHtml` to `renderMarkdown(source)`, this case takes the first branch and never reaches the new logic. |
| Pre-fetch card-click stub | `_selectTicketFromCard` builds `{ task, detailsFetched: false }` from a sidebar row, with **no** `descriptionMarkdown`. `typeof … === 'string'` is false, so the raw-payload branch still fires — this is the branch `tickets-description-markdown-fallback.test.js` exists to protect. |
| Whitespace-only body | `renderMarkdown('\n')` returns a truthy `'<p><br></p>'`. Every branch must `.trim()` before its emptiness test, exactly as the current code does, or a whitespace-only description paints an empty paragraph instead of the placeholder. |
| File saved while a `readLocalTicketFile` is in flight | `localTicketFileSaved` must be the only trigger for `exitTicketsEditMode`; no read is issued until that signal arrives. |
| Ack arrives for a different ticket | The user navigated away mid-save. Clear the pending flag and the loading state, but do **not** exit edit mode or refresh — the pane now belongs to another ticket. |
| Push clicked while save is pending | `btn-push-ticket` must be ignored (with a status message) until `localTicketFileSaved` completes. |
| Ack never arrives (host crash, dropped WS frame) | The pane stays in edit mode with the loading state on. Accepted: the user can still press Cancel, which calls `exitTicketsEditMode()` directly (`:5205`). Do **not** add a timeout that force-exits — it would race the real ack and re-open the write-vs-read hole this plan closes. |
| Title cleared by user | The save handler already falls back to the original title with `|| fallbackTitle` (`:5185`). Acceptable — a ticket must have a title; this plan does not change title semantics. |

**Race conditions.** The one this plan closes is save-vs-read. The one it must not open is ack-vs-navigation, handled by the id check in the new arm.

**Security.** None. The new branch renders through `renderMarkdown`, which escapes on the way in and routes URLs through `sanitizeUrl` — the same function the two live branches already use. No new injection surface.

**Side effects.** `localTicketFileSaved` is a host→webview push, not a verb, so it needs no `verbSchemas.ts` entry and does not appear in `TICKETS_VERBS`. It is broadcast by `postMessageToWebview` → `_pushTo` → `BroadcastHub` to **every** connected tickets surface, so it must carry `provider` + `id` (it does) and the receiving arm must match on the selected ticket before acting — which is what the id check is for.

**Dependencies & conflicts:** no new runtime dependencies. `saveLocalTicketFile`, `readLocalTicketFile`, `pushTicket`, and the `localTicketFileRead` / `ticketFileChanged` arms already exist.

## Dependencies

- `feature_plan_20260811161841_ticket-detail-h1-from-sidebar-row-not-detail-cache.md` — **land that plan first.** It rewrites the `<h1>` line immediately above the description branch this plan replaces, in both renderers. Apply this plan's change on top of the already-rewritten block so the final text contains both `resolveTicketTitle(...)` and the `hasLocalDesc` branch. Split across parallel streams, one edit silently reverts the other.
- No session dependencies (`sess_…`) — none recorded for this work.

## Adversarial Synthesis

**Risk summary.** The dominant risk is not the logic but the two guards that sit on top of it: a contract test pins the exact renderer expression, and CI's return-contract ratchet pins the host arm's `break` count — either one, left unattended, turns a correct fix into a red build. The second risk is a stuck editor: deferring `exitTicketsEditMode` until the host acknowledges means a lost ack leaves the user in edit mode, mitigated by clearing the pending flag on every branch and leaving Cancel as the manual escape rather than adding a timeout that would re-open the write-vs-read race. The third is silent regression of the escaped-plaintext fix, mitigated by keeping `renderMarkdown` in every branch and updating the contract test's regex rather than deleting the assertion.

## Proposed Changes

### 1. `src/webview/tickets.js` — make an explicit empty local description authoritative

> **Superseded:** the plan's original before/after pair, which quoted `if (selectedLinearIssue.renderedDescriptionHtml) { … } else { contentHtml += `<p>${escapeHtml((issue.description || '').trim() || 'No description provided.').replace(/\n/g, '<br>')}</p>`; }` and replaced it with a branch built on `escapeHtml(rawDescription).replace(/\n/g, '<br>')`.
> **Reason:** that "current" code no longer exists. HEAD already carries a three-branch renderer that renders source markdown with `renderMarkdown(descSrc)` — the fix for "ticket description degrades to escaped plaintext", pinned by `src/test/tickets-description-markdown-fallback.test.js` (which asserts `contentHtml += renderMarkdown(descSrc);` is present and that the `escapeHtml(...).replace(/\n/g,'<br>')` limb is absent). Applying the original replacement would have reintroduced the exact bug that test was written to prevent, and turned it red.
> **Replaced with:** the branch structure below, which keeps `renderMarkdown` everywhere and only changes *which source* branch 2 is allowed to read.

**Current (Linear, `:3376`–`:3385`):**

```js
if (selectedLinearIssue.renderedDescriptionHtml) {
    contentHtml += externalizeAnchors(selectedLinearIssue.renderedDescriptionHtml);
} else {
    const descSrc = (selectedLinearIssue.descriptionMarkdown || issue.description || '').trim();
    if (descSrc) {
        contentHtml += renderMarkdown(descSrc);
    } else {
        contentHtml += '<p>No description provided.</p>';
    }
}
```

**Replace with:**

```js
if (selectedLinearIssue.renderedDescriptionHtml) {
    contentHtml += externalizeAnchors(selectedLinearIssue.renderedDescriptionHtml);
} else {
    // An explicit descriptionMarkdown string is AUTHORITATIVE, including ''. The old
    // `descriptionMarkdown || issue.description` chain could not tell "the user cleared
    // the body" from "nothing local loaded" — both are falsy — so a deliberate delete
    // fell through to the stale remote description and bounced back after Save.
    // `undefined` (the pre-fetch card-click stub, { issue, detailsFetched: false })
    // still falls through to the raw payload: that branch is what keeps a not-yet-
    // fetched ticket from rendering as blank.
    const hasLocalDesc = typeof selectedLinearIssue.descriptionMarkdown === 'string';
    const descSrc = (hasLocalDesc
        ? selectedLinearIssue.descriptionMarkdown
        : (issue.description || '')).trim();
    if (descSrc) {
        contentHtml += renderMarkdown(descSrc);
    } else {
        contentHtml += '<p>No description provided.</p>';
    }
}
```

**ClickUp (`:3486`–`:3495`) — identical shape:**

```js
const hasLocalDesc = typeof selectedClickUpIssue.descriptionMarkdown === 'string';
const descSrc = (hasLocalDesc
    ? selectedClickUpIssue.descriptionMarkdown
    : (task.markdownDescription || task.description || '')).trim();
```

Three properties are preserved on purpose and must not be lost: `externalizeAnchors` stays on the host-HTML branch, `renderMarkdown` stays on the source branch (never `escapeHtml`), and `.trim()` still gates the emptiness test.

### 2. `src/test/tickets-description-markdown-fallback.test.js` — update the pinned expression in lockstep

`testRendererBranches` matches the old chain literally:

```js
sourceChain: /const descSrc = \(selectedLinearIssue\.descriptionMarkdown \|\| issue\.description \|\| ''\)\.trim\(\);/,
```

Update both `sourceChain` regexes to the new two-source form and **add** an assertion for the discriminator, so the guard gets stronger rather than weaker:

```js
sourceChain: /const hasLocalDesc = typeof selectedLinearIssue\.descriptionMarkdown === 'string';/,
// …and, in the same block:
assert.ok(
    block.includes("? selectedLinearIssue.descriptionMarkdown") && block.includes("(issue.description || '')"),
    'Linear: branch 2 must prefer an explicit local descriptionMarkdown (including "") over the remote payload'
);
```

Every other assertion in that file — `externalizeAnchors` on branch 1, `renderMarkdown(descSrc)` on branch 2, `No description provided.` on branch 3, the absent `escapeHtml(...).replace(/\n/g,'<br>')` limb, and the whole `testIngestionNormalisation` block — stays exactly as it is. This change narrows *which* source branch 2 reads; it does not touch how it renders.

### 3. `src/webview/tickets.js` — defer `exitTicketsEditMode` until the host confirms the save

Add a save-pending flag near the other ticket state variables:

```js
let _ticketsSavePending = false;
```

In the `btn-save-ticket-edit` listener (`:5173`), the only change is the tail — the whole title/body/cache block above it is already correct and must be left alone:

```js
    _ticketsSavePending = true;
    setTicketsLoadingState(true);
    vscode.postMessage({ type: 'saveLocalTicketFile', provider, id, content: fullMarkdown, workspaceRoot: ticketsWorkspaceRoot });
    // Do NOT exit edit mode here — wait for 'localTicketFileSaved'. exitTicketsEditMode
    // ends in _refreshSelectedTicketFromFile(), so exiting now issues a read that can
    // beat the host's write and clobber the just-edited in-memory state.
});
```

Add a new arm in the main `window.addEventListener('message', …)` switch:

```js
case 'localTicketFileSaved': {
    const selectedId = lastIntegrationProvider === 'linear'
        ? selectedLinearIssue?.issue?.id
        : selectedClickUpIssue?.task?.id;
    _ticketsSavePending = false;
    setTicketsLoadingState(false);
    // The user navigated away mid-save. The write still landed; this pane just no
    // longer owns that ticket, so exiting edit mode / refreshing here would act on
    // the wrong selection. Pushes are broadcast to every tickets surface, so this
    // guard is also what stops another tab's save from closing this tab's editor.
    if (message.id !== selectedId) { break; }
    if (message.success) {
        // exitTicketsEditMode() already calls _refreshSelectedTicketFromFile() as its
        // last statement (:3154) — do not call it again here, or the read is issued twice.
        exitTicketsEditMode();
    } else {
        showTicketsStatus(message.error || 'Save failed', true);
    }
    break;
}
```

> **Superseded:** the original arm called `exitTicketsEditMode(); _refreshSelectedTicketFromFile();` in sequence.
> **Reason:** `exitTicketsEditMode` (`:3138`) ends with `_refreshSelectedTicketFromFile()` at `:3154`. Calling both fires two `readLocalTicketFile` requests for the same ticket, and the second races the first's response through the same `_applyTicketFilePayloadToSelected` path.
> **Replaced with:** `exitTicketsEditMode()` alone, with a comment naming the built-in refresh.

### 4. `src/services/TicketsPanelProvider.ts` — acknowledge `saveLocalTicketFile` and return in-body

The arm at `:2142` currently `break`s on all five paths (guard miss `:2145`, import failure `:2156`, import throw `:2162`, no file path `:2167`, write throw `:2178`) and on success `:2179`. Convert each to a push + a `return`, so the webview gets a deterministic signal *and* an HTTP caller gets a real body (PRD contract #4 — failure branches must return `{success:false, error}`, never a silent success):

**Success:**

```ts
this.postMessageToWebview({ type: 'localTicketFileSaved', provider, id, success: true, workspaceRoot });
return { success: true, provider, id, filePath, workspaceRoot };
```

**Each failure path** — keep the existing `showErrorMessage` call, then:

```ts
this.postMessageToWebview({ type: 'localTicketFileSaved', provider, id, success: false, error: errMsg, workspaceRoot });
return { success: false, error: errMsg };
```

The early guard at `:2145` (`!workspaceRoot || !id || typeof content !== 'string'`) has no `id` to address a push to in the worst case; return `{ success: false, error: 'saveLocalTicketFile requires workspaceRoot, id and content' }` and push only when `id` is present.

### 5. `scripts/verb-return-contract-baseline.json` — ratchet `Tickets` down in the same change

Change 4 removes five `break`s from `TicketsPanelProvider`. Run `node scripts/analyze-verb-migration2.js` after the conversion and set `"Tickets"` to the reported residual (from the current `55`). The PRD is explicit that a completion lowers the ceiling in the same change; leaving it at 55 lets the win silently erode. Do **not** force it to 0 — legitimate nested-control-flow `break`s inside inner switches and loops must stay.

### 6. `src/webview/tickets.js` — guard Push while a save is in flight

In the `btn-push-ticket` listener (`:5210`), add the early return; the rest is unchanged:

```js
document.getElementById('btn-push-ticket')?.addEventListener('click', () => {
    if (_ticketsSavePending) {
        showTicketsStatus('Save in progress; wait before pushing.', true);
        return;
    }
    // …existing body unchanged…
});
```

`btn-push-ticket-subtasks` (`:5223`) reads the same local file and takes the same guard.

### 7. No change to `src/webview/tickets.html`

The editor markup and meta-bar buttons are already wired; this fix is entirely in `tickets.js`, the host provider, and the two guard files above.

## Verification Plan

### Automated Tests

1. `src/test/tickets-description-markdown-fallback.test.js` — updated per change 2, must pass. Its ingestion-normalisation and `renderMarkdown` behaviour blocks must pass **unmodified**.
2. New `src/test/tickets-empty-description-save.test.js`:
   - Build a `selectedClickUpIssue` with `descriptionMarkdown: ''`, `renderedDescriptionHtml: ''` and a non-empty `task.markdownDescription`; assert the rendered preview contains `No description provided.` and does **not** contain the `task.markdownDescription` text.
   - Repeat for `selectedLinearIssue` against `issue.description`.
   - Build the pre-fetch stub (`{ task, detailsFetched: false }`, no `descriptionMarkdown`) with a non-empty `task.markdownDescription`; assert the remote text **does** render — the fall-through branch must survive.
   - Static assertion that `btn-save-ticket-edit` no longer calls `exitTicketsEditMode()` and that a `localTicketFileSaved` arm exists which does.
3. `npm run verb-returns:check` — green against the lowered `Tickets` ceiling.
4. `npm run push-routing:check` — unchanged; the new push routes through `postMessageToWebview`, not a raw `webview.postMessage`.
5. `npm test` — confirm no new failures against the known-red baseline (record the pre-existing failures before attributing any red to this change).

### Manual — VS Code editor panel

6. Open the Tickets panel and select a ticket with a non-empty description.
7. Click **Edit**, select all in the markdown editor, press Delete, click **Save**.
8. The editor must close only after the host acknowledges, and the preview must show `No description provided.`, not the original description.
9. Inspect the local `.md` file: frontmatter plus `# <title>` and no body.
10. Click **Push**; the remote description must be updated to empty.
11. Regression: edit a ticket, change (but do not clear) the description, Save. The preview must show the edited text.
12. Regression: select a ticket that has not been locally edited and verify its original description still renders — including one whose panel was opened straight from a sidebar card before details finished loading.
13. Click **Push** during a save and confirm the "Save in progress" status appears instead of a push.

### Manual — browser / standalone

14. Repeat 7–10 in `npx switchboard`. The `localTicketFileSaved` push arrives over the WebSocket rather than `webview.postMessage`; confirm the editor still closes and the preview clears. With two browser tabs open on the same panel, confirm a save in tab A does not close tab B's editor (the id guard in change 3).

---

**Recommendation:** Complexity 5 → **Send to Coder**. Land **after** `feature_plan_20260811161841` (H1 resolver) and on the same stream — both rewrite adjacent lines of the same two render blocks.
