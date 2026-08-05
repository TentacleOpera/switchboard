# Standalone verb rail: two verbs that are not verbs

## Goal

Remove two dead outbound message types that the browser transport turns into failing HTTP
requests: `exportAgentAsSkillResult` is posted as a command when it is a response, and
`fetchFeatureDocuments` is sent by the UI and handled by nobody in either host.

### Root problem / background (verified 2026-08-04 against current `src/`)

**1. `exportAgentAsSkillResult` is a response type being posted as a command.** The kanban
webview posts `{ type: 'exportAgentAsSkillResult', success: false, error: 'Could not resolve
custom agent ID' }` at `src/webview/kanban.html:4790` when the prompts-export flow fails to
resolve a custom agent ID client-side. `exportAgentAsSkillResult` is **not** in `KANBAN_VERBS`
(`src/generated/verbAllowlist.ts:7` — only `exportAgentAsSkill` is), and no provider case
consumes it. In the editor that is harmless — the webview→provider channel ignores unknown
types — but in the browser `transport.js`'s `postMessage` shim (`:263-325`) turns **every**
`postMessage` into `POST /<panel>/verb/<type>`, so a result message becomes an HTTP request
for a verb that does not exist, and the `Verb '...' not implemented in standalone mode`
failure surfaces to the user. Its sibling `promptOnDropResult` is handled correctly as an
inbound message (`kanban.html:8217`), which shows the intended pattern.

Note the direction asymmetry: `KanbanProvider`'s `exportAgentAsSkill` arm posts
`exportAgentAsSkillResult` **provider→webview** from six sites (`KanbanProvider.ts:10382-
10407`). Those are additive webview pushes — legal under the return-in-body contract — and
are **out of scope** here. No webview inbound case handles them today (the UI gives optimistic
"EXPORTED!" button feedback at `kanban.html:4045-4048` and `:4798-4800` instead); that is a
pre-existing display choice, not part of this fix.

**2. `fetchFeatureDocuments` is sent and handled nowhere.** `src/webview/project.js:1071` posts
`{ type: 'fetchFeatureDocuments' }` from the feature-save success path. A repo-wide grep for
the string finds **only** that line — no provider case, no allowlist entry
(`PLANNING_VERBS`, `verbAllowlist.ts:9`), no schema. Probing it returns `Unknown Planning verb:
'fetchFeatureDocuments'`. This one is **host-independent**: the allowlist gates
`handleServiceVerb` in both hosts, so any browser client fails, and in the editor the message
is silently dropped. Either the feature-documents fetch was never implemented or it was
renamed and this call site was left behind.

> **Superseded:** Close three correctness gaps, including "`getSetting` throws a raw TypeError
> on a malformed payload" via unguarded `uiSettings` arms in `src/standalone/bootstrap.ts`,
> plus matching `saveSetting` key validation.
> **Reason:** Already fixed in current `src/`. The unguarded standalone arms were deleted in
> commit `30d82f8` (2026-08-04); the standalone `kanbanVerb` switch now falls through its
> `default:` to `kanbanProvider.handleServiceVerb`, which is schema-gated at the boundary
> (`verbSchemas.ts:399-408` requires `key: string` for both verbs) and guarded in every arm
> (`kanbanService.ts:195-197` / `:221-223`, `KanbanProvider.ts:10091` / `:10110` — all return
> `{ success: false, error: 'Key is not a string' }`). The original probe hit a stale build.
> A headless round-trip test already exists (`src/test/verb-engine-kanban-headless.test.js:304-310`).
> **Replaced with:** This plan covers only the two live items above. No `getSetting`/
> `saveSetting` work remains; do not re-add arms or guards.

## Metadata
- **Tags:** bugfix, api, reliability, cli
- **Complexity:** 2
- **Project:** browser-switchboard

## User Review Required (decisions, with defaults)

1. **What should `fetchFeatureDocuments` do?**
   **Default (recommended): delete the call site.** Nothing consumes a response and nothing
   produces one, so it is dead code that costs a failing HTTP request in the browser. If
   feature documents *should* be fetched there, that is a feature to specify separately, not
   a gap to paper over — this plan removes the dead call and records the question.

2. **How should the export-error at `kanban.html:4790` be surfaced?**
   **Default: replace the outbound post with local feedback.** The failure is detected
   entirely client-side (the agent ID lookup happens in the webview), so the host was never
   going to do anything with it — the post only existed to bounce the error back. Use the
   UI's existing toast/inline error mechanism to show "Could not resolve custom agent ID"
   and return early, exactly as the code does now. Do NOT invent a new verb, schema, and arm
   to report a client-side lookup failure to the host.

3. **Should `transport.js` refuse to POST message types that look like results?**
   **Default: no — fix the call sites, do not add a heuristic.** A `*Result` naming
   convention is not enforced anywhere, and a transport-layer guess would silently swallow a
   legitimately-named verb. The boundary already validates per-verb schemas (contract #5).
   The two known cases are cheap to fix directly. Worth revisiting only if a third appears.

## Complexity Audit

### Routine
- Removing one dead `postMessage` and one dead call site is subtraction.
- The replacement feedback at `kanban.html:4790` reuses the UI's existing error display.

### Complex / Risky
- **The only real hazard is silent failure.** Deleting the outbound post at `:4790` without
  replacing the feedback leaves the export button doing nothing on that error path. The
  deletion and the local error display must land together.

## Edge-Case & Dependency Audit

- **Race Conditions.** None.
- **Security.** None — pure subtraction of client-side message traffic; no new input surface.
- **Side Effects.** Removing `fetchFeatureDocuments` removes a failing POST on every feature
  save; no functional loss because nothing handled it. Removing the
  `exportAgentAsSkillResult` post removes a failing POST on an error path, replaced by
  equivalent local feedback.
- **Dependencies & Conflicts.** `standalone-board-verb-rail-fallthrough` changes how stray
  verbs fail in standalone (the `default:` arm now returns `Verb '...' not implemented in
  standalone mode`), which is correct behaviour but still a failed request until these call
  sites are removed. No file conflicts with the other plans in this feature.

## Dependencies

- None blocking. (No session IDs cited; IDs are assigned on import.)

## Adversarial Synthesis

**Risk summary.** Two genuinely small subtractions; the only way to get them wrong is to
over-reach (implement `fetchFeatureDocuments`, add a transport heuristic) or to under-deliver
(delete the `:4790` post without replacing its user feedback, leaving a silent error path).
Keep the scope at exactly two call sites.

## Proposed Changes

### `src/webview/kanban.html` — stop posting a result as a verb, keep the feedback local

- **Context.** The outbound post at `:4790` in the prompts-export flow; the correct inbound
  precedent at `:8217` (`case 'promptOnDropResult'`); optimistic "EXPORTED!" feedback at
  `:4798-4800`.
- **Logic.** The agent-ID resolution failure is detected client-side, so display it
  client-side. The post bounces a result through a verb that does not exist; delete it and
  show the same error text through the UI's existing error display instead.
- **Implementation.** Replace:
  ```js
  vscode.postMessage({ type: 'exportAgentAsSkillResult', success: false, error: 'Could not resolve custom agent ID' });
  return;
  ```
  with the panel's local error display (e.g. its toast mechanism) showing
  `'Could not resolve custom agent ID'`, keeping the early `return`. Do not add an inbound
  `case`, a new verb, or a schema entry.
- **Edge Cases.** The provider→webview `exportAgentAsSkillResult` pushes
  (`KanbanProvider.ts:10382-10407`) stay untouched — additive pushes are contract-legal.
  Confirm no other outbound post of this type exists (grep the webview tree).

### `src/webview/project.js` — remove the dead `fetchFeatureDocuments` call

- **Context.** `project.js:1071`, in the feature-save success path beside
  `fetchKanbanPlans`; no handler, no allowlist entry, no schema anywhere in `src/`.
- **Logic.** Delete the call and any state it was priming (e.g. a loading flag that never
  clears).
- **Implementation.** Remove the post; if a UI element waits on a `featureDocuments`-shaped
  response, either remove that element or leave it in its empty state deliberately, with a
  comment.
- **Edge Cases.** Check for a `case 'featureDocuments...'` inbound handler that would now be
  unreachable, and remove it too rather than leaving orphaned code that implies a working
  feature. (Current grep finds none; re-check at implementation time.)

## Verification Plan

> Per dispatch directive, no automated tests and no compilation steps are part of this
> verification plan — manual verification only.

- **Manual — export error path.** In the standalone browser board, open the prompts-export
  flow and force the unresolvable-agent path (or simulate by temporarily selecting a stale
  custom-agent entry). Confirm the "Could not resolve custom agent ID" error displays locally
  and the browser's network tab shows **no** `POST /kanban/verb/exportAgentAsSkillResult`.
- **Manual — feature save.** In the standalone Project panel, save a feature and confirm the
  network tab shows **no** `POST /planning/verb/fetchFeatureDocuments` and no error toast.
- **Manual — grep gate.** After the change, `exportAgentAsSkillResult` appears only as
  provider→webview pushes in `KanbanProvider.ts`, and `fetchFeatureDocuments` appears nowhere
  in `src/`.
- **Manual — editor regression.** Repeat the two flows in the VS Code extension host and
  confirm identical user-visible behaviour (the editor previously swallowed both messages
  silently, so the only visible change should be the new local error display).

## Uncertain Assumptions

- That `fetchFeatureDocuments` is dead rather than half-built. The grep is unambiguous about
  the current tree, but the feature may exist under another name that `project.js` was meant
  to call — worth one look at the feature-documents UI before deleting, in case the correct
  fix is to repoint the call.

## Out of Scope

- Implementing a feature-documents fetch.
- Changing `transport.js`'s postMessage-to-verb mapping.
- The provider→webview `exportAgentAsSkillResult` pushes and their (absent) inbound display.
- Any `getSetting`/`saveSetting` work — already guarded at the schema boundary and in every
  arm (see the Superseded callout above).

## Completion Report

Implemented both call-site fixes. `src/webview/kanban.html` now shows the unresolved custom-agent error in the status bar instead of posting a non-verb result. `src/webview/project.js` no longer sends the dead `fetchFeatureDocuments` message on feature saves. Grep confirms `fetchFeatureDocuments` is gone from `src/` and `exportAgentAsSkillResult` only remains as provider-to-webview pushes. No compilation or tests were run per the dispatch directive.
