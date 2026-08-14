# Browser panel action feedback: toasts and clipboard delivery

**Complexity:** 7

## Goal

Verb buttons in the browser/standalone cockpit give no feedback: host notifications are thrown at the VS Code window or console-logged, and the standalone clipboard seam is a no-op so copy buttons copy nothing while the UI reports success. Two subtasks: bridge host notifications into browser panel toasts via request-scoped capture, and finish the prompt-copy return-body retrofit so transport.js can write the browser clipboard.

Both are the same defect class — an action's *result* has no route back to the browser tab that asked for
it — and they converge on one file, `src/webview/transport.js`, which is why they ship as one unit rather
than two tickets. Together they close PRD contract #6 ("capability-gating honesty — no dead buttons") for
the whole verb engine at once: after this feature, a browser verb either does the thing and says so, or
says why not.

## How the Subtasks Achieve This

- **Finish the prompt-copy return-body retrofit so standalone copy buttons actually copy**: Retrofits
  ~42 verb arms across Planning, Design, TaskViewer and `sharedUtilityVerbs` to return their copy payload
  in the HTTP body (`prompt` for prompts, a new `__clipboard` key for non-prompt copies such as the
  Tickets "Link all" file-path list), so `transport.js` can write the *browser's* clipboard — the only
  clipboard that exists in the standalone host. Adds `check-clipboard-return-parity.js`, a ratcheted CI
  gate that walks verb arms and fails any clipboard-writing arm that returns no copy payload, so the
  retrofit cannot silently drift again (it already did once: `DesignPanelProvider.ts:2866` returns
  `promptText`, a key `transport.js` never reads). The same gate generates the `COPY_VERBS` list the
  client needs. On the browser side it claims the clipboard **synchronously in the click frame** via
  `ClipboardItem` with a promise payload — the only pattern WebKit accepts — and falls back to an
  accessible manual-copy surface where no programmatic path exists. This is the half that makes the
  *action* real.

- **Bridge host notifications to the browser panels so verb buttons stop looking dead**: Adds
  request-scoped notice capture (`AsyncLocalStorage`) so any `showTemporaryNotification` /
  `show{Information,Warning,Error}Message` raised while serving a browser verb rides home in the response
  body under a reserved `__notices` key, and renders as a toast in the panel that was clicked. One guard
  in `showTemporaryNotification.ts` plus three in `VscodeHostUI` covers ~390 call sites without editing
  any of them; the VS Code webview path never establishes a context, so editor notifications are
  unchanged. Item-bearing calls (choice dialogs) are deliberately not intercepted. This is the half that
  makes the *feedback* real.

## Dependencies & sequencing

- **Ship the clipboard retrofit first, then the notification bridge.** This ordering is load-bearing, not
  a preference. The notification bridge alone gives the standalone host a green *"Diagram prompt copied
  to clipboard"* toast over an **empty** clipboard — a louder and more convincing version of the
  `Copied!` lie the other subtask exists to remove. The clipboard subtask makes the message true before
  the other subtask starts saying it out loud. Landing both in one change is equally acceptable; landing
  the notification bridge first is not.

- **They collide on one function and the collision is invisible to a merge tool.** Both rewrite the
  `.then(function (result) {...})` response handler in `src/webview/transport.js` — the clipboard subtask
  owns the block at the top (`:372-376`), the notification subtask appends the notice loop below it.
  Because both sides produce valid JavaScript, a three-way merge will happily accept a version that
  reverts the clipboard fix. **The second subtask must re-read `transport.js` and edit the post-first-
  subtask file rather than applying its own snippet verbatim.** Each plan carries a Cross-Subtask
  Reconciliation table stating the reconciled end-state line by line.

- **Shared reserved-key convention.** The two subtasks introduce `__clipboard` and `__notices`
  respectively; both are transport-private, both are deleted from the body before it is re-dispatched as
  a `MessageEvent`. They were reconciled to one `__`-prefixed naming rule so the cockpit ends with a
  single convention rather than two invented independently.

- **A DOM-contract prerequisite runs backwards.** The notification subtask retires the
  `#sb-transport-error` element id in favour of a `#sb-transport-notices` stack. The clipboard subtask
  ships *first* and adds a JSDOM test for a failed copy — that test must assert on behaviour
  (`showTransportError` reached / a visible node carrying the message), **never** on the element id, or
  it turns red the moment the second subtask lands. The existing assertion at
  `src/test/headless-feature-management-contract.test.js:405` pins that id today and must be updated by
  the notification subtask in the same commit.

- **Two fixed overlays now compete for the same anchor.** The clipboard subtask adds an interactive
  manual-copy surface (focused `<textarea>`, `aria-live` status); the notification subtask adds a
  click-through notice stack at `bottom:16px; left:50%`. They must not overlap — a toast covering the
  textarea the user is being told to press `Cmd+C` in defeats the fallback — and must not share a
  container, since one needs `pointer-events:none` and the other needs focus. The notification subtask
  lands second and owns making them coexist.

- **Guards that must already hold before either lands.** The `EXPECTED_QUIET` suppression and the
  typed-failure fall-through in `transport.js:377-405` are shipped behaviour that both subtasks must
  preserve byte-for-byte (an earlier draft of the notification plan dropped both). Each plan now names
  them explicitly and the notification subtask carries a JSDOM regression test for the quiet-list.

- **Explicitly out of scope for both** (recorded so a coder recognises them as known, not as damage):
  the standalone memo verb fork at `bootstrap.ts:1638-1700`, which reimplements four memo verbs outside
  the providers and therefore bypasses both fixes; and `createHeadlessHostSeams` in `hostServices.ts`,
  which has zero callers. The feature-level decision on the latter is **keep it and add a
  "NOT INJECTED ANYWHERE" header comment** — four comments and a test reference it by name to say exactly
  that, so deleting it would leave dangling references.

<!-- BEGIN SUBTASKS (auto-generated, do not edit) -->
## Subtasks
- [ ] [Bridge host notifications to the browser panels so verb buttons stop looking dead](../plans/feature_plan_20260811143000_bridge-host-notifications-to-browser-toasts.md) — **PLAN REVIEWED**
- [ ] [Finish the prompt-copy return-body retrofit so standalone copy buttons actually copy](../plans/feature_plan_20260811143001_standalone-copy-prompt-verbs-never-reach-a-clipboard.md) — **PLAN REVIEWED**
<!-- END SUBTASKS -->

