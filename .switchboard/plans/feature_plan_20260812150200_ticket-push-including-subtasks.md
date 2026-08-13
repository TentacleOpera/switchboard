# Add a "Push + subtasks" Action and Make the Plain Push Button Say What It Actually Pushes

## Goal

Answer the question the current UI leaves open — *does pushing a parent push its subtasks?* — by making the answer visible in the UI: keep `Push` as parent-only, and add a second, explicitly-labelled action that pushes the parent plus every locally-present subtask.

### The problem

The Tickets detail action bar has one `Push` button (`src/webview/tickets.html:4050`). Nothing about it says whether "push" means this ticket, or this ticket and its children. A user looking at a parent with eight subtasks cannot tell whether pressing it will publish their subtask edits, and the only way to find out is to press it and diff the remote.

### Root cause — push is single-ticket by construction, and it silently withholds the subtask block

`TaskViewerProvider.pushTicketEdits` (`src/services/TaskViewerProvider.ts:22910`) takes exactly one `{ provider, id }` and pushes exactly one remote record:

```ts
const filePath = await this._findTicketDocument(resolvedRoot, provider, id);
...
const { pushBody, withheld } = stripAppendedBlocksForPush(bodyLines.join('\n'));
const description = pushBody.trim();
...
await linear.updateIssueDescription(id, descriptionToPush, titleFromHeading);
// (ClickUp arm: clickUp.updateTask / markdown_content on the same single id)
```

Two facts follow:

1. **No subtask is ever pushed.** There is no loop over children and no second id.
2. **The `## Subtasks` block is deliberately stripped.** `stripAppendedBlocksForPush` removes the import-generated block, and the code notes it: `notes.push('An import-generated block (subtasks/comments) was withheld from the remote description.')`. That is correct — the block is a local index, not remote content — but it means even the *titles* of subtasks never travel.

The webview mirrors this. `src/webview/tickets.js:5173-5181`:

```js
document.getElementById('btn-push-ticket')?.addEventListener('click', () => {
    const provider = lastIntegrationProvider;
    const id = provider === 'linear' ? selectedLinearIssue?.issue.id : selectedClickUpIssue?.task.id;
    if (!id) return;
    setTicketsLoadingState(true);
    vscode.postMessage({ type: 'pushTicket', provider, id, workspaceRoot: ticketsWorkspaceRoot });
});
```

One id, one verb, no scope concept. (`tickets.js:5173`, `tickets.html:4050` — both verified at HEAD.)

So the answer to the user's question is **no** — and the fix is a second action that says so by contrast, plus a tooltip on the existing button that states its scope.

### Second finding — `Push` is already a dead button in the standalone browser cockpit

This was not in the original plan and it changes what "add a second button" has to do.

`switchboard.pushTicketEdits` is registered **only** in `src/extension.ts:2065`, and via `vscode.commands.registerCommand` — *not* via `registerSwitchboardCommand`, the helper (`extension.ts:57`) that also populates the host-agnostic `SwitchboardCommandRegistry`. 48 other commands in `extension.ts` do use it; this one does not.

Follow the call through the seam:

1. The `pushTicket` arm calls `this._seams().commands.executeCommand('switchboard.pushTicketEdits', ...)` (`TicketsPanelProvider.ts:2977`).
2. `VscodeHostCommands.executeCommand` (`hostSeams.ts:327-336`) is registry-first: `if (this._registry.has(command))` → **miss**, because nothing registered it there.
3. It falls through to `vscode.commands.executeCommand`. Under the extension host that is real. Under standalone that is `src/standalone/vscodeShim.ts:244-250`, which logs `[headless] command 'switchboard.pushTicketEdits' is not bridged — the calling arm's side effect did not happen` and returns `undefined`.
4. `bootstrap.ts` registers a handful of commands into `switchboardCommandRegistry` (794-843: `switchboard.refreshUI`, `focusTerminalByName`, `triggerAgentFromKanban`, `triggerBatchAgentFromKanban`, `getAttachmentList`, `downloadAttachment`, and three no-op stubs). `switchboard.pushTicketEdits` is **not** among them.
5. Back in the arm, `result?.success` on `undefined` is falsy → `showErrorMessage('Push to clickup failed: unknown error')`.

So in `npx switchboard`, pressing `Push` today does nothing and reports an unknown error. That is a live violation of PRD contract #6 (capability-gating honesty — "never a control that dead-clicks") and #7 (two-layer completion: Layer 1 exists, Layer 2 was never wired).

**Consequence for this plan:** the original instruction — register the new command in `bootstrap.ts` "beside the existing `switchboard.pushTicketEdits` registration" — points at something that does not exist. A coder will search `bootstrap.ts`, find nothing to sit beside, and either skip the step or guess. And shipping `Push + subtasks` without fixing this adds a *second* dead button to the browser cockpit, which is the exact failure mode contract #6 names.

Both registrations are therefore in scope. This is two small edits, not a refactor, and doing only the new one would knowingly ship the defect this plan exists to eliminate — a button whose behaviour the UI misrepresents.

## Metadata

- **Complexity:** 6
- **Tags:** frontend, backend, api, feature, ui
- **Project:** Browser Switchboard

> Raised from 5 → 6 on review: the work now also covers repairing the unregistered `switchboard.pushTicketEdits` command in the standalone host, and touches three generated/validated protocol artifacts (`protocol-catalog.json`, the regenerated `verbAllowlist.ts`, `verbSchemas.ts`) with a CI drift check on the regeneration. Still Coder tier, but not a single-surface change.

## Complexity Audit (Routine vs Complex/Risky)

**Routine**
- Adding a button to the action bar and a click handler.
- Adding a `pushTicketWithSubtasks` verb arm that iterates ids.
- Tightening the existing `Push` tooltip.

**Complex / Risky**
- **The staleness guard is per-ticket and must stay per-ticket.** `pushTicketEdits` refuses to push when the remote moved after our last pull (the guard block is 22973-23021), because push is a **full replacement** of the description. A batch push must run that guard independently for each id and skip the stale ones — never bypass it, and never abort the whole batch because one child is stale. The comment there records the exact incident it prevents ("a 3-day-old 6315-byte local file against a 7353-byte description edited 2 hours earlier"). Note the guard uses a **60s** grace (not 1s) and returns `{ success: false, stale: true, error }` at 23005-23013.
- **`pushTicketEdits` already declares `stale?: boolean` in its return type** (22913). The composition below reads `r.stale` — do not add the field, and do not conflate it with the two hard-failure returns at 22997 and 23003 (unverifiable remote / no timestamp), which are `success: false` **without** `stale` and must count as failures, not skips. That distinction is the whole of edge case 4.
- **The command seam swallows exceptions.** `VscodeHostCommands.executeCommand` wraps its dispatch in `try { ... } catch { return undefined; }` (`hostSeams.ts:327-336`). If `pushTicketEditsWithSubtasks` throws, the arm receives `undefined`, not an error — and `undefined` is indistinguishable from "command not registered". The arm must therefore default every count (`result?.pushed ?? 0`) *and* treat a wholly-absent result as a failure with a distinct message, or a mis-registration will read to the user as "0 pushed, 0 failed, success".
- **Return-in-body (PRD contract #4).** The existing `pushTicket` arm (`TicketsPanelProvider.ts:2972`) ends in `break`, so an HTTP caller gets no body — it posts to the webview only. The new arm MUST `return` its result object as well as posting. Do **not** convert the existing `pushTicket` arm's `break` to a `return` as a drive-by: it is a separate, defensible change with its own ratchet implications (`scripts/verb-return-contract-baseline.json`), and bundling it makes this diff harder to review. Adding a new returning arm does not raise any provider's `break` count, so the ratchet stays green.
- **Partial success is the normal outcome.** With N children, some will push, some will be stale, some will have no local file. The result must report all three counts. A boolean `success` would make a 1-of-9 push look identical to a 9-of-9 push.
- **Attachment/inline-image hosting runs per push** (`hostInlineImages`, plus the `alreadyHosted` dedupe via `_hostedImageLookup`). Pushing N tickets means N upload passes; the dedupe sidecar is per-`provider_id` key, so it is already correctly scoped — but the batch must not share one `attachmentsDir` computation across ids. Each id derives its own from its own `filePath`.
- **Which children count as "subtasks"?** Locally-present files only. Do NOT fetch the remote child list and push files that do not exist locally — there would be nothing to push. Source of truth: local files carrying `parentId: <this id>` frontmatter, written unconditionally by `_buildLinearImportPlanContent` (`TaskViewerProvider.ts:7596`) and `_buildClickUpImportPlanContent` (`:7870`).
- **`_localSubtaskIdsFor` needs its own scan — the existing one is in the wrong class.** `TicketsPanelProvider._scanLocalTicketFiles` (410) already parses `parentId:` out of frontmatter with `/^parentId:\s*(.+)$/m` (436), but it is a private method on the *panel* provider, and the new push method lives on `TaskViewerProvider`. Reuse the **regex and the frontmatter convention**, not the method; do not reach across providers or promote a private to public just for this.
- **Hard prerequisite: this feature's subtask-fetch plan must land first.** Today no subtask `.md` files exist anywhere — the import path filters subtasks out before writing (`TaskViewerProvider.ts:23887`). So `_localSubtaskIdsFor` returns `[]` for every parent, and by edge case 1 the new button is **disabled on every ticket in the product**. Shipping this plan alone yields a permanently-greyed control and a feature that cannot be manually verified at all. See the feature file's sequencing section.
- **Rate limiting.** Sequential, not parallel. Each child push is up to three remote calls (date-updated probe, attachment uploads, update). Parallelising N of those against ClickUp/Linear invites 429s. Sequential is the safe choice regardless of the exact published limits, so no research gate on this — if a 429 is ever observed in practice, count it as a failure with its message surfaced and add pacing then, rather than pre-building a throttle for a limit no one has hit.

## Edge-Case & Dependency Audit

1. **Parent with zero local subtask files.** The new button must be **disabled**, not present-and-silent, so the user learns there is nothing extra to push. Reuse the existing disabled-button idiom on this bar.
2. **A subtask selected (not a parent).** The subtask has no children; the new button is disabled. Do not hide it — a hidden control on some selections and not others is harder to reason about than a disabled one.
3. **Stale child.** Skip it, count it, and name it in the summary. Never overwrite.
4. **Child deleted remotely.** The per-id guard already returns a hard failure on a 404 rather than recreating it from a stale body (`Could not verify remote ticket ${id} before pushing`). Preserve that; count it as a failure.
5. **Locally-modified parent + clean children.** Push all of them; each id is judged on its own.
6. **The `## Subtasks` block is still withheld** from every pushed description, parent included. This action pushes each subtask's own *description*, not the parent's checklist. Say that in the tooltip so it is not mistaken for "sync the checklist upstream".
7. **`last_synced_at` restamp.** Each successful child push must restamp via `registerImportedTicket`, or the child immediately reads as `modified` and the next refresh skips it. This is the same trap documented in the stamp-FIRST comment at `TaskViewerProvider.ts:23483-23486` ("that is how 86d3y200v flagged itself 13.2s after its own import"). `pushTicketEdits` already restamps on its own success path — verify that before adding a second restamp in the batch wrapper, or the file gets stamped twice per push.
8. **Ordering.** Push the parent first, then children. If the parent push is refused as stale, still attempt the children — they are independent records.
9. **No confirm dialog** before pushing, no "are you sure you want to push N tickets?" (repo rule). The button label carries the scope; that is the whole safeguard.
10. **`_findTicketDocument` vs `_findTicketFilePath`.** `pushTicketEdits` uses `_findTicketDocument` (`TaskViewerProvider.ts:22919`); the tickets panel uses `_findTicketFilePath` (`TicketsPanelProvider.ts:2428`). Use the same resolver `pushTicketEdits` already uses for each child so a path-shape mismatch cannot make a present file look absent (`imported_docs` stores absolute paths, a known past source of exactly this).
11. **Verb allowlist is GENERATED — do not hand-edit it.** `src/generated/verbAllowlist.ts` lists `pushTicket` in `TICKETS_VERBS`, and the new verb must join it or the browser transport rejects the call. The open question in the earlier draft is now settled: **a generator exists.** `scripts/generate-verb-allowlist.js` reads `protocol-catalog.json` and emits `verbAllowlist.ts` (`--write` to overwrite), and `scripts/check-protocol-parity.js` runs a **drift check that regenerates and compares byte-for-byte**. A hand-edit to `verbAllowlist.ts` therefore fails `npm run parity:check` in CI. Add the verb to `protocol-catalog.json`, then regenerate.
12. **Per-verb schema (PRD contract #5) — missing from the earlier draft.** Every verb is payload-validated at the HTTP boundary. `pushTicket`'s schema lives at `src/services/verbSchemas.ts:1081` in `TICKETS_VERB_SCHEMAS`. Without a matching entry the new verb is either rejected or unvalidated at dispatch, depending on the dispatcher's default — neither is acceptable. The payload is identical to `pushTicket`'s, so the schema is a copy:

```ts
pushTicketWithSubtasks: {
    fields: {
        workspaceRoot: { type: 'string' },
        provider: { type: 'string', required: true },
        id: { type: 'string', required: true },
    },
},
```

Keep it permissive and field-accurate per contract #5 — require only `provider` and `id`, exactly as `pushTicket` does; `workspaceRoot` is optional because the arm resolves it via `_resolveWorkspaceRoot`.

## Proposed Changes

### `src/webview/tickets.html`

Add the second button immediately after the existing one, and give the existing one an explicit scope tooltip:

```html
<button id="btn-push-ticket" class="strip-btn"
        title="Push this ticket's title and description to the remote. Subtasks are NOT included.">Push</button>
<button id="btn-push-ticket-subtasks" class="strip-btn"
        title="Push this ticket AND every locally-imported subtask — each one's own title and description. The generated Subtasks checklist is never pushed.">Push + subtasks</button>
```

### `src/webview/tickets.js`

**a)** Wire the new button beside the existing handler (~line 5173):

```js
document.getElementById('btn-push-ticket-subtasks')?.addEventListener('click', () => {
    const provider = lastIntegrationProvider;
    const id = provider === 'linear'
        ? selectedLinearIssue?.issue.id
        : selectedClickUpIssue?.task.id;
    if (!id) return;
    setTicketsLoadingState(true);
    vscode.postMessage({ type: 'pushTicketWithSubtasks', provider, id, workspaceRoot: ticketsWorkspaceRoot });
});
```

**b)** Mirror the existing show/hide of `btn-push-ticket` (lines 3021 and 3106) for the new id, and disable it when the selected ticket has no locally-present children. The subtask count already reaches the webview for the sidebar's subtask-count chip; reuse that signal rather than adding a new round trip.

**c)** Extend the `pushTicketResult` handler (~line 7375) to render the batch summary when the reply carries counts.

### `src/services/TicketsPanelProvider.ts`

New verb arm next to `pushTicket` (2972-3003), delegating to a single new provider method — not re-implementing the push. Unlike `pushTicket`, which ends in `break`, this arm **returns** its result body (PRD contract #4):

```ts
case 'pushTicketWithSubtasks': {
    const workspaceRoot = this._resolveWorkspaceRoot(msg.workspaceRoot);
    const { provider, id } = msg;
    try {
        const result: any = await this._seams().commands.executeCommand(
            'switchboard.pushTicketEditsWithSubtasks',
            { workspaceRoot, provider, id }
        );
        if (!result?.success) {
            this._seams().ui.showErrorMessage(
                `Push to ${provider} incomplete: ${result?.error || 'unknown error'}`
            );
        }
        const res = {
            type: 'pushTicketResult', id, workspaceRoot,
            success: !!result?.success,
            pushed: result?.pushed ?? 0,
            skippedStale: result?.skippedStale ?? 0,
            failed: result?.failed ?? 0,
            message: result?.message,
            error: result?.error
        };
        this.postMessageToWebview(res);
        return { ...res, success: !!result?.success };
    } catch (error) { /* typed failure reply, same shape */ }
}
```

### `src/services/TaskViewerProvider.ts`

New public method that composes the existing single-ticket push. It must not duplicate any of the push body/staleness/image logic:

```ts
/**
 * Push a parent AND every locally-imported subtask, one remote record each.
 *
 * Sequential and per-id on purpose:
 *  - each id re-runs pushTicketEdits' own staleness guard, so a stale child is
 *    SKIPPED rather than overwritten (push is a full description replacement);
 *  - each id derives its own attachments sidecar from its own file path;
 *  - N parallel pushes would be up to 3N remote calls at once — a 429 magnet.
 *
 * The generated `## Subtasks` checklist is still withheld from every description
 * (stripAppendedBlocksForPush). This pushes each subtask's OWN body, not the index.
 */
public async pushTicketEditsWithSubtasks(
    workspaceRoot: string,
    data: { provider: 'linear' | 'clickup'; id: string }
): Promise<{ success: boolean; pushed: number; skippedStale: number; failed: number; message: string; error?: string }> {
    const resolvedRoot = this._resolveWorkspaceRoot(workspaceRoot);
    if (!resolvedRoot) { return { success: false, pushed: 0, skippedStale: 0, failed: 0, message: '', error: 'No workspace open.' }; }
    const { provider, id } = data;

    const ids = [id, ...await this._localSubtaskIdsFor(resolvedRoot, provider, id)];
    let pushed = 0, skippedStale = 0, failed = 0;
    const failures: string[] = [];

    for (const target of ids) {
        const r = await this.pushTicketEdits(resolvedRoot, { provider, id: target });
        if (r.success) { pushed++; }
        else if (r.stale) { skippedStale++; }
        else { failed++; failures.push(`${target}: ${r.error || 'unknown'}`); }
    }

    const parts = [`${pushed} pushed`];
    if (skippedStale > 0) { parts.push(`${skippedStale} skipped (remote changed — Refetch, then push again)`); }
    if (failed > 0) { parts.push(`${failed} failed`); }
    return {
        success: failed === 0,
        pushed, skippedStale, failed,
        message: `Push + subtasks: ${parts.join(', ')}.`,
        error: failed > 0 ? failures.slice(0, 3).join('; ') : undefined
    };
}

/** Local subtask ids for a parent: files carrying `parentId: <id>` frontmatter. */
private async _localSubtaskIdsFor(
    resolvedRoot: string, provider: 'linear' | 'clickup', parentId: string
): Promise<string[]> { /* scan the parent's directory; match frontmatter, not the checklist */ }
```

### `src/extension.ts` — register through the host-agnostic registry, and repair the existing one

`extension.ts:2065` currently registers the existing command with the raw vscode API:

```ts
const pushTicketEditsDisposable = vscode.commands.registerCommand('switchboard.pushTicketEdits', async (data: {...}) => {
    return taskViewerProvider.pushTicketEdits(data.workspaceRoot, data);
});
```

Switch it to `registerSwitchboardCommand` (the helper at `extension.ts:57`, used by 48 other commands), which registers the handler in `SwitchboardCommandRegistry` **and** keeps the vscode registration for palette/keybinding callers. Register the new command the same way, immediately after:

```ts
const pushTicketEditsDisposable = registerSwitchboardCommand('switchboard.pushTicketEdits', async (data: { workspaceRoot: string; provider: 'linear' | 'clickup'; id: string }) => {
    return taskViewerProvider.pushTicketEdits(data.workspaceRoot, data);
});
const pushTicketEditsWithSubtasksDisposable = registerSwitchboardCommand('switchboard.pushTicketEditsWithSubtasks', async (data: { workspaceRoot: string; provider: 'linear' | 'clickup'; id: string }) => {
    return taskViewerProvider.pushTicketEditsWithSubtasks(data.workspaceRoot, data);
});
context.subscriptions.push(pushTicketEditsDisposable, pushTicketEditsWithSubtasksDisposable);
```

This is behaviour-preserving on the shipped extension (contract #2): the registry is consulted first, executes the identical closure in-process, and the vscode registration still exists for any external caller.

### `src/standalone/bootstrap.ts` — wire both into the registry (Layer 2)

There is **no existing `pushTicketEdits` registration here to sit beside** — see "Second finding" above. Add both to the registry block that begins at line 794 ("Register standalone command handlers into switchboardCommandRegistry"), alongside `switchboard.getAttachmentList` (839) and `switchboard.downloadAttachment` (843), which follow the same delegate-to-the-provider shape:

```ts
switchboardCommandRegistry.register('switchboard.pushTicketEdits', async (data: any) =>
    taskViewerProvider.pushTicketEdits(data.workspaceRoot, data));
switchboardCommandRegistry.register('switchboard.pushTicketEditsWithSubtasks', async (data: any) =>
    taskViewerProvider.pushTicketEditsWithSubtasks(data.workspaceRoot, data));
```

Use whatever local identifier bootstrap already holds for the `TaskViewerProvider` instance backing `getAttachmentList`/`downloadAttachment` — do not construct a second one.

**Registering only the new command is not acceptable.** It would leave the browser cockpit with a working `Push + subtasks` next to a `Push` that silently fails — a worse and more confusing state than today, and squarely against contract #6.

### `protocol-catalog.json` → `src/generated/verbAllowlist.ts` (regenerate, never hand-edit)

Add `pushTicketWithSubtasks` to the tickets verb list in `protocol-catalog.json` (`pushTicket`'s entries are at 1735 / 1982 / 5771 / 9467 / 25617 — mirror each shape), then regenerate:

```
node scripts/generate-verb-allowlist.js --write
npm run parity:check
```

`check-protocol-parity.js` regenerates and byte-compares, so a hand-edited `verbAllowlist.ts` fails CI even when the verb string is correct.

### `src/services/verbSchemas.ts`

Add the `pushTicketWithSubtasks` schema to `TICKETS_VERB_SCHEMAS`, immediately after `pushTicket` (1081-1087), using the copy given in edge case 12.

## Verification Plan

1. **Unit — scope of the plain Push.** Assert `pushTicketEdits` still issues exactly one remote update for one id, and that `stripAppendedBlocksForPush` still removes the `## Subtasks` block. This is the regression guard on the existing behaviour.
2. **Unit — batch composition.** With a parent and three local subtask files, `pushTicketEditsWithSubtasks` calls the single-ticket push exactly four times, parent first, sequentially (assert call order and that no two overlap).
3. **Unit — stale child is skipped, not overwritten.** Stub the second child's remote `date_updated` past its baseline; assert `skippedStale === 1`, that no update call was made for that id, and that the other three still pushed.
4. **Unit — partial-failure reporting.** One child returns a hard error: `success === false`, `pushed === 3`, `failed === 1`, and `message` names all three counts.
5. **Unit — child discovery source.** A subtask listed in the parent's `## Subtasks` checklist but with **no local file** is NOT included. A local file with `parentId:` matching IS included.
6. **Unit — restamp.** After a successful child push, `registerImportedTicket` was called for that child; assert its sync status is not `modified` immediately afterward.
7. **Unit — allowlist and schema.** `TICKETS_VERBS` contains `pushTicketWithSubtasks`, and `TICKETS_VERB_SCHEMAS` has a matching entry. Then run `npm run parity:check` and confirm the regenerated `verbAllowlist.ts` is byte-identical to the checked-in file — a hand-edit passes the unit assertion and fails here.
7a. **Unit — both commands are registered in both hosts.** Assert `switchboardCommandRegistry.has('switchboard.pushTicketEdits')` and `has('switchboard.pushTicketEditsWithSubtasks')` after `extension.ts` activation **and** after `bootstrap.ts` composition. This is the regression guard on the dead-button defect; without it nothing catches a standalone-only omission, because the seam swallows the miss and returns `undefined`.
7b. **Unit — return-in-body.** The `pushTicketWithSubtasks` arm returns a body carrying `pushed`/`skippedStale`/`failed`, not a bare `{success:true}` — per PRD contract #4, and asserted on the returned value, not the posted message.
8. **Regression.** Run the tickets suites (`tickets-subtask-embedding`, `tickets-sidebar-list-scoping`, `verb-engine-tickets-headless`, `browser-panel-verb-routing`). Five regression tests are red at HEAD independently — stash-verify before attributing red to this change.
9. **Manual.** With the extension running, on a ClickUp parent that has locally-imported subtasks:
   - Confirm `Push` still pushes only the parent (diff the remote children before/after — unchanged).
   - Edit one subtask's description locally, press `Push + subtasks`, and confirm that subtask's remote description changed and the parent's did too.
   - Select a parent with no local subtasks and confirm `Push + subtasks` is disabled.
   - Hover both buttons and confirm the tooltips state their scope.
   - Remember the browser panel is served from the installed VSIX's `dist/`, not `src/` — rebuild/reinstall before concluding a fix did not land.
10. **Manual — standalone host (`npx switchboard`), the check that catches the dead-button defect.** In the browser cockpit, press `Push` on a ticket with a local edit and confirm the remote actually changes. Before this plan it does not: the console logs `[headless] command 'switchboard.pushTicketEdits' is not bridged` and the UI reports "Push to clickup failed: unknown error". Then press `Push + subtasks` and confirm the same. Watch the standalone console for any `not bridged` line — one appearing for either command means the `bootstrap.ts` registration was missed, and the extension host will not reveal it.

## Completion Summary

Implemented the "Push + subtasks" action and the plain-Push scope tooltip across all eight surfaces named in the plan. The webview (`tickets.html`/`tickets.js`) gained the second button with explicit scope tooltips, a click handler posting `pushTicketWithSubtasks`, edit-mode show/hide mirroring, a disabled-state gate in `_toggleSubtaskMetaButtons` (subtask selected or no subtasks → disabled, reusing the detail-cache subtask-count signal), and a `pushTicketResult` handler extension that renders the batch summary when counts are present. `TicketsPanelProvider.ts` got the new `pushTicketWithSubtasks` arm, which returns its result body (PRD contract #4) and defaults every count so a swallowed-seam `undefined` reads as a failure rather than "0 pushed, 0 failed". `TaskViewerProvider.ts` got `pushTicketEditsWithSubtasks` (sequential, parent-first, per-id staleness guard preserved, no second restamp since `pushTicketEdits` already restamps) and `_localSubtaskIdsFor` (scans the parent's directory for files carrying `parentId:` frontmatter, matching the convention emitted at `:7596`/`:7870`, never the checklist). The dead-button defect was repaired: `extension.ts` now registers `switchboard.pushTicketEdits` through `registerSwitchboardCommand` (was raw `vscode.commands`, missing from the host-agnostic registry) and adds `switchboard.pushTicketEditsWithSubtasks` the same way; `bootstrap.ts` bridges both into the standalone registry beside the attachment pair. `verbSchemas.ts` got the permissive `pushTicketWithSubtasks` schema, and `protocol-catalog.json` + `src/generated/verbAllowlist.ts` were regenerated via `npm run catalog:generate` (the verb now appears in `TICKETS_VERBS` and all five catalog sections). No compilation or automated tests were run per instructions; the subtask-fetch prerequisite is landed but unbuilt, so on-disk verification of child discovery must wait for build/install.

### Head-agent review addendum

The disabled-state gate described above as "reusing the detail-cache subtask-count signal" was corrected during review: the detail cache holds the REMOTE subtask list, while `_localSubtaskIdsFor` discovers children from LOCAL files carrying `parentId:` frontmatter. Gating on the cache enabled the button for a parent whose subtasks exist remotely but were never imported, where it would push only the parent and report "1 pushed" — silently degrading into the plain Push beside it, and failing the plan's own manual step 9. The gate now reads the file-derived `subtaskCount` that `listLocalTicketFiles` puts on each sidebar card. Separately, `_localSubtaskIdsFor`'s filename regex accepted both providers regardless of the `provider` argument and is now anchored to it.
