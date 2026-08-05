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
// src/services/verbSchemas.ts:944 — describes a verb that no longer exists here
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
// src/webview/tickets.js:5455
vscode.postMessage({
    type: 'convertToSubtask',
    provider: lastIntegrationProvider,
    taskId: _convertCurrentTicketId,
    parentId: _convertSelectedParentId,
    workspaceRoot: ticketsWorkspaceRoot || undefined
});
```

```ts
// src/services/TicketsPanelProvider.ts:2507 — reads msg.provider / msg.taskId / msg.parentId
//   :2523  await clickUp.updateTask(msg.taskId, { parent: msg.parentId });
//   :2526  await linear.updateIssueParent(msg.taskId, msg.parentId);
```

The generated `protocol-catalog.json` — which is produced by scanning real call sites — independently records the correct shape, and disagrees with the hand-written schema:

```json
// protocol-catalog.json:7487
"convertToSubtask": { "payloadKeys": ["type", "provider", "taskId", "parentId", "workspaceRoot"], "siteCount": 1 }
```

**Why it is browser-only.** The editor webview path (`TicketsPanelProvider.ts:658`) calls `_handleMessage` directly with no validation. Only `handleServiceVerb` (`:113`) — the path the HTTP verb rail uses — calls `validateVerbPayload` (`:120`), so the request is rejected before it reaches the handler. The button therefore works in the editor and fails in the browser cockpit.

**Two-layer confirmation (per PRD contract #7).** The standalone bootstrap wires the Tickets verb router: `src/standalone/bootstrap.ts:1539` routes `ticketsVerb → ticketsProvider.handleServiceVerb` (the validated path). The handler arm (`:2507`) is host-agnostic — it uses `_adapterFactories`, `_resolveWorkspaceRoot`, and `postMessageToWebview` (broadcaster), with no `vscode.*` direct. Both Layer 2 (wiring) and the handler arm are present and correct; the schema is the sole broken link. Fixing it makes the verb reachable and functional headless.

**A test currently enforces the bug.** `src/test/verb-engine-tickets-headless.test.js:310` asserts *"schema validation rejects malformed payload (`convertToSubtask` missing `subtaskSessionId`)"*. It must be rewritten in the same change or the fix will not land green.

**No other consumer exists.** `convertToSubtask` appears only in `TICKETS_VERBS` (`src/generated/verbAllowlist.ts:11`) — not in the kanban or planning allowlists — and has exactly one call site. The feature-management verbs that legitimately use `subtaskSessionId` (`addSubtaskToFeature`, `removeSubtaskFromFeature`) are separate entries and are unaffected.

**Out-of-scope caveat (flagged, not fixed here).** The `convertToSubtask` arm `break`s out of the switch instead of `return`ing its result, so `handleServiceVerb` returns `undefined` and the HTTP body carries no data — a return-contract gap (PRD #4). The browser UI still receives the `subtaskConverted` push via the broadcaster, so the browser-cockpit goal is met; a pure HTTP orchestrator would see an empty body. This is a pre-existing gap, not caused by the schema bug, and is out of scope for this plan. Record as a follow-up.

## Metadata

- **Complexity:** 2
- **Tags:** bugfix, backend, api
- **Project:** browser-switchboard

## User Review Required

None.

## Complexity Audit

### Routine
- Replace one schema literal in `TICKETS_VERB_SCHEMAS` (`verbSchemas.ts:944`) with the correct field set.
- Retarget one assertion in `verb-engine-tickets-headless.test.js:310` and add one positive-case assertion.
- Regenerate `protocol-catalog.json` via `npm run catalog:generate` — expected empty diff (the catalog already holds the correct payload keys).
- No behaviour change in the handler, no state, no persistence, no migration. Single caller, single handler, both already correct.

### Complex / Risky
- None.

## Edge-Case & Dependency Audit

- **Race Conditions:** None. The verb is a synchronous validation gate followed by a single async API call; no shared mutable state, no concurrent field access.
- **Security:** The schema validates types, not enums — `provider` is accepted as any string and the handler throws `Unknown provider: ${msg.provider}` for anything that is not `clickup` or `linear`. Surfacing a missing `provider` at validation is strictly better than letting it reach the handler. Do not attempt to constrain the value set in the schema (the format does not support enums).
- **Side Effects:** None beyond the intended ClickUp/Linear re-parent API call. The schema change itself has no runtime side effect — it only permits payloads that were already correct to pass the gate.
- **Dependencies & Conflicts:**
  - **`taskId` / `parentId` types.** ClickUp task ids are strings; Linear issue ids are strings. Sibling schemas in the same file hedge with `type: ['string', 'number']` (e.g. `clickupUpdateTaskPriority.taskId`). Match that pattern rather than narrowing to `'string'` — a numeric-looking id posted from an external orchestrator would otherwise be rejected for no reason.
  - **`provider` must be required.** The handler throws for unknown providers, so a missing provider is already an error — surfacing it at validation is strictly better.
  - **`workspaceRoot` stays optional.** The Tickets tab has no workspace assignment of its own; the webview sends `ticketsWorkspaceRoot || undefined` and the backend resolves it via `_resolveWorkspaceRoot(undefined)`. Marking it required would break the normal case.
  - **Do not touch `PLANNING_VERB_SCHEMAS:572`.** It is a marker comment recording that the move happened. Removing it loses the breadcrumb that explains this bug.
  - **Do not rename the verb.** It is in the shipped `TICKETS_VERBS` allowlist and in `protocol-catalog.json`, both of which external agents read via `GET /catalog`. Renaming would break them for no benefit; the collision with the feature-management concept is a naming annoyance, not a defect.
  - **`src/generated/verbAllowlist.ts` needs no change.** The verb is already allowlisted; only its schema is wrong.
  - **Feature-management schemas are untouched.** `addSubtaskToFeature` / `removeSubtaskFromFeature` are separate `PLANNING_VERB_SCHEMAS` entries that legitimately use `subtaskSessionId`; this change does not touch them.

## Dependencies

None — this is a standalone bugfix with no prerequisite plans.

## Adversarial Synthesis

Key risks: (1) the retargeted test must include a *positive* case (`validateVerbPayload(...).ok === true`), not just a flipped rejection — a rejection-only retarget is half-done theater; (2) line numbers in the original plan drifted from source (939→944, 5386→5455, 2518→2507) and are corrected above so the implementer lands on the right lines; (3) the arm's return-contract gap (breaks instead of returns, empty HTTP body) is real but out of scope — the browser UI still gets the `subtaskConverted` push, so the stated goal is met. Mitigations: include the positive assertion; corrected line numbers; record the return-contract gap as a follow-up, do not expand this plan.

## Proposed Changes

### 1. `src/services/verbSchemas.ts` — replace the schema body at `:944`

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

### 2. `src/test/verb-engine-tickets-headless.test.js` — retarget the rejection test at `:310`

Replace the `missing subtaskSessionId` assertion with one that exercises the real contract: a payload missing `taskId` (or `parentId`) is rejected, and the full valid payload passes validation.

```js
await test("Tickets: schema validation rejects malformed payload (convertToSubtask missing taskId)", async () => {
    const { provider } = buildHeadlessTicketsProvider(tmpRoot);
    await assert.rejects(
        () => provider.handleServiceVerb('convertToSubtask', { provider: 'clickup', parentId: 'abc' }),
        /Invalid payload for Tickets verb 'convertToSubtask'.*taskId/
    );
});
```

Add a positive case asserting the valid payload passes the gate:

```js
await test('Tickets: schema validation accepts well-formed convertToSubtask payload', async () => {
    const { ok } = validateVerbPayload('tickets', 'convertToSubtask', {
        provider: 'clickup', taskId: 'a', parentId: 'b'
    });
    assert.strictEqual(ok, true);
});
```

> **Superseded:** Original test asserted `missing subtaskSessionId` is rejected — codifying the defect rather than the real contract.
> **Reason:** The `subtaskSessionId` field belongs to the feature-management verb, not this one. The test was a hostage note enforcing the bug.
> **Replaced with:** A rejection test for the real required field (`taskId`) plus a positive case asserting the valid payload passes. Both are required — a rejection-only retarget does not prove the fix works.

### 3. `protocol-catalog.json` — regenerate (confirm no drift)

Run `npm run catalog:generate`. The catalog already holds the correct payload keys (`provider`, `taskId`, `parentId`, `workspaceRoot`), so an empty diff is the expected and correct result — it confirms the hand-written schema now agrees with the scanner.

## Verification Plan

> **Note:** Per session directives, automated test runs and project compilation are SKIPPED in this verification plan. The test *file* is still edited as a proposed change (it locks the bug and must be retargeted), but "run the test suite" is not listed as a verification step here.

### Automated Tests
- Skipped per session directive. The implementer may run `node --test src/test/verb-engine-tickets-headless.test.js` locally if desired, but it is not a required gate for this plan.

### Manual verification
1. **Reproduce first.** `POST /tickets/verb/convertToSubtask` with `{"provider":"clickup","taskId":"x","parentId":"y","workspaceRoot":"<root>"}` and confirm the current `missing required field 'subtaskSessionId'` error.
2. Apply the schema change; re-issue the same request and confirm it reaches the handler (a real id pair re-parents the ticket; a bogus id pair returns a ClickUp/Linear API error, *not* a validation error — reaching an API error proves validation passed).
3. Confirm `validateVerbPayload('kanban', 'addSubtaskToFeature', { featureSessionId: 'f', subtaskSessionId: 's' }).ok === true` still holds — the feature-management schemas are untouched (`src/test/headless-feature-management-contract.test.js:189`).
4. Run `npm run catalog:generate` and confirm the `protocol-catalog.json` diff is empty (the scanner already recorded the correct shape).
5. **End-to-end in the browser cockpit:** open Tickets, select a ticket, click **Convert to subtask**, pick a parent, confirm. The ticket becomes a subtask and drops out of the top-level sidebar list (subtasks are excluded by `parentId` frontmatter).
6. **Editor panel regression check:** the same flow in the editor webview, which never validated and must keep working.

**Recommendation:** Complexity 2 → Send to Intern.
