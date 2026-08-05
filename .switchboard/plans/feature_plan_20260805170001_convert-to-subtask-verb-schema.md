# Fix `convertToSubtask` verb schema — it validates against the wrong verb's fields

## Goal

Correct the `convertToSubtask` entry in `TICKETS_VERB_SCHEMAS` so it describes the payload the Tickets panel actually sends (`provider`, `taskId`, `parentId`, `workspaceRoot`) instead of the feature-management payload it was copied from (`subtaskSessionId`, `featureSessionId`). Update the test that currently locks the wrong schema in place.

### Problem analysis & root cause

**Reported symptom.** The "convert to subtask" button does nothing and reports an invalid `subtaskSessionId` error.

**Reproduced live** against the running extension:

```
$ curl -X POST http://127.0.0.1:59839/tickets/verb/convertToSubtask \
    -d '{"provider":"clickup","taskId":"…","parentId":"…","workspaceRoot":"…"}'
{"success":false,"error":"Invalid payload for Tickets verb 'convertToSubtask': missing required field 'subtaskSessionId'"}
```

**Root cause.** `convertToSubtask` was moved out of `PLANNING_VERB_SCHEMAS` during the Tickets extraction — `verbSchemas.ts:572` still carries the marker comment `// ── 2d: convertToSubtask schema moved to TICKETS_VERB_SCHEMAS. ──`. The schema that landed in `TICKETS_VERB_SCHEMAS` is the **feature-management** one (the `addSubtaskToFeature` family, which genuinely uses session ids), not the ticket one:

```ts
// src/services/verbSchemas.ts:939 — describes a verb that no longer exists here
convertToSubtask: {
    fields: {
        subtaskSessionId: { type: 'string', required: true },
        featureSessionId: { type: 'string', required: true },
        workspaceRoot: { type: 'string' },
    },
},
```

Both the only caller and the only handler use a completely different set of fields:

```js
// src/webview/tickets.js:5386
vscode.postMessage({
    type: 'convertToSubtask',
    provider: lastIntegrationProvider,
    taskId: _convertCurrentTicketId,
    parentId: _convertSelectedParentId,
    workspaceRoot: ticketsWorkspaceRoot || undefined
});
```

```ts
// src/services/TicketsPanelProvider.ts:2518 — reads msg.provider / msg.taskId / msg.parentId
await clickUp.updateTask(msg.taskId, { parent: msg.parentId });
```

The generated `protocol-catalog.json` — which is produced by scanning real call sites — independently records the correct shape, and disagrees with the hand-written schema:

```json
"convertToSubtask": { "payloadKeys": ["type", "provider", "taskId", "parentId", "workspaceRoot"], "siteCount": 1 }
```

**Why it is browser-only.** The editor webview path (`TicketsPanelProvider.ts:661`) calls `_handleMessage` directly with no validation. Only `handleServiceVerb` (`:114`) — the path the HTTP verb rail uses — calls `validateVerbPayload`, so the request is rejected before it reaches the handler. The button therefore works in the editor and fails in the browser cockpit.

**A test currently enforces the bug.** `src/test/verb-engine-tickets-headless.test.js:310` asserts *"schema validation rejects malformed payload (`convertToSubtask` missing `subtaskSessionId`)"*. It must be rewritten in the same change or the fix will not land green.

**No other consumer exists.** `convertToSubtask` appears only in `TICKETS_VERBS` (`src/generated/verbAllowlist.ts:11`) — not in the kanban or planning allowlists — and has exactly one call site. The feature-management verbs that legitimately use `subtaskSessionId` (`addSubtaskToFeature`, `removeSubtaskFromFeature`) are separate entries and are unaffected.

## Metadata

- **Complexity:** 1
- **Tags:** bugfix, backend, tickets, browser-cockpit

## Complexity Audit

**Trivial.** One schema literal, one test, one generated-file regeneration. No behaviour change in the handler, no state, no persistence, no migration. The verb has a single caller and a single handler, both already correct — only the validator between them is wrong.

## Edge-Case & Dependency Audit

- **`taskId` / `parentId` types.** ClickUp task ids are strings; Linear issue ids are strings. Sibling schemas in the same file hedge with `type: ['string', 'number']` (e.g. `clickupUpdateTaskPriority.taskId`). Match that pattern rather than narrowing to `'string'` — a numeric-looking id posted from an external orchestrator would otherwise be rejected for no reason.
- **`provider` must be required.** The handler throws `Unknown provider: ${msg.provider}` for anything that is not `clickup` or `linear`, so a missing provider is already an error — surfacing it at validation is strictly better. The schema format in this file validates types, not enums, so do not attempt to constrain the value set here.
- **`workspaceRoot` stays optional.** The Tickets tab has no workspace assignment of its own; the webview sends `ticketsWorkspaceRoot || undefined` and the backend resolves it via `_resolveWorkspaceRoot(undefined)`. Marking it required would break the normal case.
- **Do not touch `PLANNING_VERB_SCHEMAS:572`.** It is a marker comment recording that the move happened. Removing it loses the breadcrumb that explains this bug.
- **Do not rename the verb.** It is in the shipped `TICKETS_VERBS` allowlist and in `protocol-catalog.json`, both of which external agents read via `GET /catalog`. Renaming would break them for no benefit; the collision with the feature-management concept is a naming annoyance, not a defect.
- **Regenerate, don't hand-edit, `protocol-catalog.json`.** It already holds the correct payload keys, so the diff may be empty — that is the expected outcome and confirms the fix agrees with the scanner.
- **`src/generated/verbAllowlist.ts` needs no change.** The verb is already allowlisted; only its schema is wrong.

## Proposed Changes

### 1. `src/services/verbSchemas.ts` — replace the schema body

```ts
// ── 2d: moved from PLANNING_VERB_SCHEMAS. This is the TICKET convert-to-subtask
//    (re-parent a ClickUp task / Linear issue under another ticket), NOT the
//    feature-management verb of the same name — the session-id fields that used
//    to be here belonged to addSubtaskToFeature and rejected every real call.
//    Shape mirrors protocol-catalog.json's scanned payloadKeys for this verb.
convertToSubtask: {
    fields: {
        provider: { type: 'string', required: true },
        taskId: { type: ['string', 'number'], required: true },
        parentId: { type: ['string', 'number'], required: true },
        workspaceRoot: { type: 'string' },
    },
},
```

### 2. `src/test/verb-engine-tickets-headless.test.js` — retarget the rejection test

Replace the `missing subtaskSessionId` assertion at `:310` with one that exercises the real contract: a payload missing `taskId` (or `parentId`) is rejected, and the full valid payload passes validation.

```js
await test("Tickets: schema validation rejects malformed payload (convertToSubtask missing taskId)", async () => {
    await assert.rejects(
        () => provider.handleServiceVerb('convertToSubtask', { provider: 'clickup', parentId: 'abc' }),
        /Invalid payload for Tickets verb 'convertToSubtask'.*taskId/
    );
});
```

Add a positive case asserting `validateVerbPayload('tickets', 'convertToSubtask', { provider: 'clickup', taskId: 'a', parentId: 'b' }).ok === true`.

### 3. `protocol-catalog.json` — regenerate

Run the catalog scanner. An empty diff is the expected and correct result.

## Verification Plan

1. **Reproduce first.** `POST /tickets/verb/convertToSubtask` with `{"provider":"clickup","taskId":"x","parentId":"y","workspaceRoot":"<root>"}` and confirm the current `missing required field 'subtaskSessionId'` error.
2. Apply the schema change; re-issue the same request and confirm it reaches the handler (a real id pair re-parents the ticket; a bogus id pair returns a ClickUp API error, *not* a validation error — reaching an API error proves validation passed).
3. `node --test src/test/verb-engine-tickets-headless.test.js` — the retargeted test passes.
4. Confirm `validateVerbPayload('kanban', 'addSubtaskToFeature', { featureSessionId: 'f', subtaskSessionId: 's' }).ok === true` still holds — the feature-management schemas are untouched (`src/test/headless-feature-management-contract.test.js:189`).
5. `npm test` — no new failures. Five regression tests are already red at HEAD; stash-verify before attributing a failure to this change.
6. **End-to-end in the browser cockpit:** open Tickets, select a ticket, click **Convert to subtask**, pick a parent, confirm. The ticket becomes a subtask and drops out of the top-level sidebar list (subtasks are excluded by `parentId` frontmatter).
7. **Editor panel regression check:** the same flow in the editor webview, which never validated and must keep working.

**User Review Required:** None.
