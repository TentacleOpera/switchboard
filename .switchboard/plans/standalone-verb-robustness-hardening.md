# Standalone verb rail: payload guards, and two verbs that are not verbs

## Goal

Close three small correctness gaps found while probing the headless verb rail: `getSetting` throws a raw
TypeError on a malformed payload, `exportAgentAsSkillResult` is dispatched as a command when it is a
response, and `fetchFeatureDocuments` is sent by the UI and handled by nobody in either host.

### Root problem / background (verified 2026-08-04)

**1. `getSetting` has no key guard in the headless host.** Probing `POST /kanban/verb/getSetting` with
`{}` returns:

```json
{"success":false,"error":"Cannot read properties of undefined (reading 'startsWith')"}
```

`src/standalone/bootstrap.ts:713-719`:

```ts
case 'getSetting': {
    const key = payload.key;
    let value: any = uiSettings.get(key);
    if (value === undefined) {
        if (key === 'selectedRole') { value = undefined; }
        else if (key.startsWith('roleConfig_')) { value = undefined; }   // ← throws when key is undefined
    }
```

Both editor-host equivalents guard first — `KanbanProvider.ts:10108` (`if (typeof key !== 'string')
return { success: false, error: 'Key is not a string' }`) and `kanbanService.ts:195-197` (identical).
The headless arm is the odd one out. It is reachable over HTTP from any authenticated browser session, so
a malformed request produces an internal error message instead of a validation response. The same arm
also has the dead-store oddity that the two branches assign `value = undefined` when it is already
`undefined`, which suggests the block has drifted from whatever it originally did.

Related: the `saveSetting` arm (`:724-729`) performs no key validation at all. That is harmless while
the store is a throwaway `Map`, and stops being harmless the moment
`standalone-persist-ui-settings` makes it durable — an unvalidated key then writes a real config row.

**2. `exportAgentAsSkillResult` is a response type being posted as a command.** Of the 83 board verbs
measured dead in standalone, 82 are present in `KANBAN_VERBS` (152 entries) with handlers in
`KanbanProvider`. The single exception is `exportAgentAsSkillResult`, which `kanban.html` posts through
the same `postKanbanMessage` path as real commands. In the editor that is harmless — the webview→provider
channel ignores unknown types — but in the browser `transport.js:256-268` turns **every** `postMessage`
into `POST /<panel>/verb/<type>`, so a result message becomes an HTTP request for a verb that does not
exist, and `transport.js:283-290` renders the failure as a user-visible error toast. Its sibling
`promptOnDropResult` is handled correctly as an inbound message (`kanban.html:8217`), which shows the
intended pattern.

**3. `fetchFeatureDocuments` is sent and handled nowhere.** `src/webview/project.js:1071` posts
`{ type: 'fetchFeatureDocuments' }`. A repo-wide grep for the string finds **only** that line — no
provider case, no allowlist entry, no schema. Probing it returns `Unknown Planning verb:
'fetchFeatureDocuments'`. This one is **host-independent**: the allowlist gates
`handleServiceVerb` in both hosts, so any browser client fails, and in the editor the message is
silently dropped. Either the feature-documents fetch was never implemented or it was renamed and this
call site was left behind.

## Metadata
- **Tags:** bugfix, api, reliability, cli
- **Complexity:** 3
- **Repo:** `switchboard`

## User Review Required (decisions, with defaults)

1. **What should `fetchFeatureDocuments` do?**
   **Default (recommended): delete the call site.** Nothing consumes a response and nothing produces
   one, so it is dead code that costs a user-visible error toast in the browser. If feature documents
   *should* be fetched there, that is a feature to specify separately, not a gap to paper over — this
   plan removes the dead call and records the question.

2. **Where should `exportAgentAsSkillResult` be handled?**
   **Default: stop posting it.** Follow the `promptOnDropResult` precedent — a result belongs in the
   inbound `case` list, not in `postKanbanMessage`. If the webview genuinely needs to notify the host
   that an export finished, give it a properly named verb with a schema and an allowlist entry.

3. **Should `transport.js` refuse to POST message types that look like results?**
   **Default: no — fix the call sites, do not add a heuristic.** A `*Result` naming convention is not
   enforced anywhere, and a transport-layer guess would silently swallow a legitimately-named verb. The
   two known cases are cheap to fix directly. Worth revisiting only if a third appears.

## Complexity Audit

### Routine
- The `getSetting` guard is a two-line copy of the editor's own check.
- Removing one dead `postMessage` and one dead call site is subtraction.

### Complex / Risky
- **Nothing structurally risky**, with one caveat: `saveSetting` key validation interacts with the
  settings-persistence plan. If that plan lands first, this validation becomes load-bearing rather than
  cosmetic; if this lands first, it is a no-op that pre-empts a real hazard. Either order works, but the
  guard must exist before the store becomes durable.

## Edge-Case & Dependency Audit

- **Race Conditions.** None.
- **Security.** This is the security-relevant piece of the set: `getSetting`/`saveSetting` are
  HTTP-reachable, and once settings persist to `kanban.db`'s `config` table, an unvalidated key is an
  arbitrary-config-row write. Validate that the key is a string, non-empty, and within the
  `switchboard.`-derived namespace the arm constructs — reject rather than coerce. Also avoid echoing the
  raw key back in error text unescaped, since panel status messages render it.
- **Side Effects.** Removing `fetchFeatureDocuments` removes an error toast; no functional loss because
  nothing handled it.
- **Dependencies & Conflicts.** `standalone-persist-ui-settings` touches the same two arms — expect a
  small merge, and land the guards in whichever goes first. `standalone-board-verb-rail-fallthrough`
  will route `exportAgentAsSkillResult` to the `Unknown Kanban verb` branch and report it as
  not-implemented, which is correct behaviour but still a toast until the call site is removed.

## Dependencies

- None blocking. Pairs with `standalone-persist-ui-settings` (shared arms) and
  `standalone-board-verb-rail-fallthrough` (which changes how the stray verb fails, not whether).
- (No session IDs cited; IDs are assigned on import.)

## Adversarial Synthesis

**Risk summary.** Three genuinely small fixes; the only way to get them wrong is to over-reach. Adding a
transport-layer heuristic for "result-looking" message types, or inventing an implementation for
`fetchFeatureDocuments` to avoid deleting a line, would both add surface area to fix cosmetic problems.
The one item that deserves real care is the `saveSetting` key guard, because it stops being cosmetic the
moment settings become durable.

## Proposed Changes

### `src/standalone/bootstrap.ts` — `getSetting` / `saveSetting` guards

- **Context.** `getSetting:713-722`; `saveSetting:724-729`; the editor equivalents at
  `KanbanProvider.ts:10108` and `kanbanService.ts:195-197`.
- **Logic.** Validate the key before use in both arms, matching the editor's error text so clients see
  one consistent message across hosts.
- **Implementation.**
  ```ts
  case 'getSetting': {
      const key = payload?.key;
      if (typeof key !== 'string' || key.length === 0) {
          return { success: false, error: 'Key is not a string' };   // matches KanbanProvider.ts:10108
      }
      ...
  }
  ```
  Apply the same guard to `saveSetting`. While in `getSetting`, remove the two dead
  `value = undefined` assignments or replace them with whatever they were meant to express — leaving a
  no-op branch invites the next reader to preserve nothing.
- **Edge Cases.** Keep the `settingResult` WS broadcast for valid reads so panel behaviour is unchanged.
  A rejected key must not broadcast, or panels will act on a failed read.

### `src/webview/kanban.html` — stop posting a result as a verb

- **Context.** The `exportAgentAsSkillResult` post; the correct inbound precedent at `:8217`
  (`case 'promptOnDropResult'`).
- **Logic.** Remove the outbound post. If the webview needs the export outcome, it should arrive as an
  inbound message handled in the same `switch` as `promptOnDropResult`.
- **Implementation.** Delete the `postKanbanMessage({ type: 'exportAgentAsSkillResult', ... })` call and,
  if an outcome is displayed, add/confirm an inbound `case` instead.
- **Edge Cases.** Confirm the extension's `exportAgentAsSkill` arm actually sends a result message before
  wiring an inbound handler for one; if it does not, there is nothing to handle and the deletion alone is
  the whole fix.

### `src/webview/project.js` — remove the dead `fetchFeatureDocuments` call

- **Context.** `project.js:1071`; no handler, no allowlist entry, no schema anywhere in `src/`.
- **Logic.** Delete the call and any state it was priming (e.g. a loading flag that never clears).
- **Implementation.** Remove the post; if a UI element waits on a `featureDocuments`-shaped response,
  either remove that element or leave it in its empty state deliberately, with a comment.
- **Edge Cases.** Check for a `case 'featureDocuments...'` inbound handler that would now be
  unreachable, and remove it too rather than leaving orphaned code that implies a working feature.

## Verification Plan

### Automated Tests

- **Contract — malformed `getSetting` is a validation error, not an internal one.** `POST
  /kanban/verb/getSetting` with `{}` returns `{success:false, error:'Key is not a string'}` and no
  TypeError text. Assert the editor host returns the same message for the same input, locking the two
  hosts together.
- **Contract — `saveSetting` rejects a bad key.** Non-string and empty keys are rejected; assert no
  config row is written (meaningful once persistence lands, and a cheap assertion now).
- **Regression — no result-shaped verbs are posted.** Enumerate every `type: '...'` posted by
  `kanban.html` and assert each is present in `KANBAN_VERBS`. This currently fails on exactly one name
  and afterwards guards the whole surface — it is the same enumeration the board-coverage test uses, so
  share the helper.
- **Regression — no orphan verbs.** Assert every `type: '...'` posted by `project.js` resolves to an
  allowlisted planning verb, which catches `fetchFeatureDocuments` and anything like it.
- **Manual smoke.** Open the standalone board and Project panel and confirm no error toast appears on
  load or on selecting a feature.

## Uncertain Assumptions

- That `fetchFeatureDocuments` is dead rather than half-built. The grep is unambiguous about the current
  tree, but the feature may exist under another name that `project.js` was meant to call — worth one
  look at the feature-documents UI before deleting, in case the correct fix is to repoint the call.
- That no external API client depends on `getSetting` accepting a missing key and receiving the current
  TypeError shape. Extremely unlikely, and the editor already returns the stricter response.

## Out of Scope

- Implementing a feature-documents fetch.
- Changing `transport.js`'s postMessage-to-verb mapping.
