# Project Panel Posts Two Verbs the Planning Allowlist Rejects, So the Browser Shows an Error Banner on Every Open

## Goal

Stop the browser project panel throwing `Unknown Planning verb` for verbs it legitimately posts: route `improvePlan` to the provider that implements it, and let the `webviewReady` handshake through so cold-open messages are not stranded behind a 10-second fallback timer.

### Problem

The browser panels post their messages to a per-panel HTTP rail derived from `data-panel` (`src/webview/transport.js:26`). For `project.html` that is `/project/verb/<name>`, which `LocalApiServer` routes to `PlanningPanelProvider.handleServiceVerb` (`src/services/LocalApiServer.ts:3540-3542`). That entry point is allowlist-gated:

```ts
// src/services/PlanningPanelProvider.ts:121-123
if (!PLANNING_VERBS.has(verb)) {
    throw new Error(`Unknown Planning verb: '${verb}'`);
}
```

A throw becomes HTTP 500 with `{success:false, error}` (`LocalApiServer.ts:1829-1833`), and `transport.js` renders that as a red fixed banner for 8 seconds (`src/webview/transport.js:298-304` — the `project` panel is not in `STATUS_MESSAGE_PANELS`, so it takes the `showTransportError` branch, not the inline status line).

A route-accurate diff of every outbound `vscode.postMessage({type:…})` in each browser panel against the allowlist its route actually consults found exactly two live offenders, both in `project.js`:

| Verb | Posted at | Allowlist membership | Editor behaviour | Browser behaviour |
|---|---|---|---|---|
| `webviewReady` | `src/webview/project.js:1166` | **none** — absent from all six allowlists | Handled: `PlanningPanelProvider.ts:2499` (`if (msg.type === 'webviewReady' && isProject)`) completes the ready handshake and flushes queued messages | Rejected at `:121` before `_handleMessage` is ever reached → red error banner on **every** project-panel open, and the handshake never completes |
| `improvePlan` | `src/webview/project.js:2075` (the Kanban tab's *Improve* button) | `KANBAN_VERBS` only — the implementation is `KanbanProvider.ts:9797-9846` | Falls through `_handleMessage` with no matching case → the button silently does nothing | Rejected at `:121` → red error banner reading `Unknown Planning verb: 'improvePlan'` |

(All other panels are clean: `tickets.js`, `memo.js`, `connections.js` and `design.js` have zero live verbs outside their routes' allowlists. `sbInspectToggle` looks like an offender in a naive grep but is an **iframe** message — `frame.contentWindow.postMessage(...)` at `planning.js:7139` and `DesignPanelProvider.ts:562` — not a verb, so it is correctly absent.)

### Root cause

Two different mistakes with the same symptom.

**1. `webviewReady` is a handshake, not a verb, and was never catalogued.** `PlanningPanelProvider` handles it *inside* `_handleMessage`, downstream of the allowlist guard. That works for the editor, where the webview's `onDidReceiveMessage` calls `_handleMessage` directly (`:612-618`), and fails for the browser, where every message must first clear `handleServiceVerb`'s guard. Because the handshake never lands, the panel's queued cold-open messages (e.g. `activateKanbanTabAndSelectPlan` from a board Review click) are only released by the 10-second best-effort timeout at `:601-606` — which is why browser project-panel actions taken immediately after opening appear to do nothing.

**2. `improvePlan` lives in the wrong provider for the panel that posts it.** The implementation is `KanbanProvider`'s (it reads `.agents/skills/improve-plan/SKILL.md`, builds the prompt and writes the clipboard), and it is catalogued under `KANBAN_VERBS`. `project.js` posts it on `/project/verb`. There is no cross-provider delegation for it — unlike the memo verbs, which `PlanningPanelProvider` explicitly forwards to `TaskViewerProvider` (`:112-120`) precisely because they are catalogued elsewhere. `improvePlan` needed the same treatment and never got it.

Note this also makes the *editor* Improve button dead (silent fall-through), so the fix repairs both hosts.

## Metadata

- **Complexity:** 3
- **Tags:** backend, api, bugfix
- **Project:** Browser Switchboard

## Complexity Audit

**Routine, with one catalogue-generation step that is easy to forget.**

- `src/generated/verbAllowlist.ts` is auto-generated (`// AUTO-GENERATED — do not edit; run \`npm run catalog:generate\``) from `protocol-catalog.json`. The fix must edit `protocol-catalog.json` and regenerate — hand-editing the generated file will be silently reverted by the next generation run.
- The delegation pattern to copy already exists ten lines above the guard (`PlanningPanelProvider.ts:112-120`, the memo verbs), including the comment explaining why it must sit *before* the `PLANNING_VERBS` check. Mirror it.
- No DB work, no migration, no UI change, no dispatch/terminal involvement.

The one judgement call: `webviewReady` is a lifecycle ping with no payload and no security surface, so adding it to the Planning verb surface is safe. Do **not** solve it by loosening the allowlist guard (e.g. "allow unknown verbs through to `_handleMessage`") — the guard is the network trust boundary for untrusted HTTP input and the reason an unknown verb is never dynamically invoked.

## Edge-Case & Dependency Audit

- **Do not hand-edit the generated allowlist.** Change `protocol-catalog.json` → run `npm run catalog:generate` → commit both. Verify the regenerated file contains the new entries and nothing else changed.
- **Delegation must precede the guard.** `improvePlan` is not a Planning verb and must not be added to `PLANNING_VERBS`; it must be forwarded to `KanbanProvider.handleServiceVerb` ahead of the guard, exactly like the memo verbs. Adding it to `PLANNING_VERBS` instead would let it reach `_handleMessage`, which has no case for it — swapping a loud error for a silent no-op.
- **`KanbanProvider.handleServiceVerb` may not be attached.** The memo delegation throws a specific error when `_taskViewerProvider` is missing (`:118-119`). Mirror that for `_kanbanProvider` rather than optional-chaining into `undefined` and returning a bogus success.
- **`improvePlan` returns `{ success: true, prompt }`** (`KanbanProvider.ts:9838`). That is exactly the shape `transport.js:292-296` needs to put the prompt on the **browser** clipboard — so the browser Improve button will start working end-to-end for free once routing is fixed. Confirm the `prompt` field survives the delegation (return the provider's result verbatim; do not re-wrap it as `{success:true}`).
- **`improvePlan` also posts `showStatusMessage`** to the kanban webview (`:9834`). In the browser that push is surface-tagged for the board, not the project panel, so the project panel will not show it. The clipboard write plus the reply body are the project panel's signal; that is sufficient and no new push is needed.
- **The editor Improve button changes behaviour** from "does nothing" to "copies the improve-plan prompt". That is the intended repair, not a regression — but it means the editor path needs its own UAT line.
- **`webviewReady` has no schema.** `validateVerbPayload` passes through verbs with no schema (`verbSchemas.ts:54-56`), so adding the verb without a schema entry is consistent with the generic-dispatch contract. Optionally add an empty schema `{}` alongside the other lifecycle verbs.
- **Idempotency.** `project.js` posts `webviewReady` once at mount (`:1166`), but a browser reconnect re-runs panel init. `PlanningPanelProvider:2499`'s handler must tolerate being called more than once — check it only sets a ready flag and flushes, with no side effect that would double-fire.
- **Vestigial cluster, verify-then-delete (not deferred).** `planning.js` posts 14 tickets-family verbs (`refreshTicketsDelta` at `:7399`, `:7445`, `:7456`, `:7474`, `:7486`, `:8460`; `loadTicketMembers` at `:1417`; plus `loadTicketAssignees`, `listLocalTicketFiles`, `readLocalTicketFile`, `ticketAttachImage`, `ticketsDefaultRoot`, `ticketsRootChanged`, `getTicketSyncStatuses`, `clickupUpdateTaskAssignees`, `clickupUpdateTaskPriority`, `linearUpdateIssueAssignee`, `linearUpdateIssuePriority`). They are in `TICKETS_VERBS`, but `planning.js` posts on `/planning/verb`, so any live one would throw. Evidence says they are unreachable: `planning.html` contains **zero** occurrences of `data-tab="tickets"` / `tickets-tab`, and `tickets.html` only mentions `planning.js` in a comment — the tickets surface moved to its own panel. Step 5 of the verification plan proves reachability empirically; whatever is confirmed dead gets deleted in this plan, and anything found live gets a `TICKETS_VERBS` delegation arm alongside the memo one.

## Proposed Changes

### 1. `protocol-catalog.json`

Add `webviewReady` to the Planning provider's `verbs[]` (alphabetical position, beside the other lifecycle verbs such as `planShown` / `persistTabState`). Do **not** add `improvePlan` — that one is delegated, not adopted.

Then:

```
npm run catalog:generate
```

and confirm `src/generated/verbAllowlist.ts`'s `PLANNING_VERBS` gained exactly `'webviewReady'`.

### 2. `src/services/PlanningPanelProvider.ts:105-124`

Extend the pre-guard delegation block. Keep the memo arm as-is and add a kanban arm next to it:

```ts
         if (verb === 'memoLoad' || verb === 'memoSave' || verb === 'memoClear'
             || verb === 'memoGeneratePrompt' || verb === 'memoListWorkspaces') {
             if (this._taskViewerProvider) {
                 return this._taskViewerProvider.handleServiceVerb(verb, payload);
             }
             throw new Error(`Memo verb '${verb}' requires TaskViewerProvider, which is not attached.`);
         }
+        // improvePlan is implemented by KanbanProvider (KanbanProvider.ts:9797) and
+        // catalogued under KANBAN_VERBS, but the button that posts it lives in the
+        // PROJECT panel (project.js:2075), whose route prefix is /project/verb →
+        // handleServiceVerb here. Without this delegation the PLANNING_VERBS guard
+        // below rejects it and the browser shows "Unknown Planning verb: 'improvePlan'";
+        // in the editor it fell through _handleMessage with no case and did nothing.
+        // Same shape as the memo delegation above, and for the same reason: the verb is
+        // catalogued on another provider, so this MUST sit before the guard.
+        // Return the result verbatim — it carries `prompt`, which transport.js:292 uses
+        // to put the improve-plan prompt on the BROWSER clipboard.
+        if (verb === 'improvePlan') {
+            if (this._kanbanProvider) {
+                return this._kanbanProvider.handleServiceVerb(verb, payload);
+            }
+            throw new Error(`Verb '${verb}' requires KanbanProvider, which is not attached.`);
+        }
         if (!PLANNING_VERBS.has(verb)) {
             throw new Error(`Unknown Planning verb: '${verb}'`);
         }
```

`_handleMessage` already handles `webviewReady` at `:2499`, so once the catalogue change lands it needs no code edit — verify the `isProject` branch is reached on the browser path (the browser project panel sets `data-panel="project"`, and `handleServiceVerb` forwards `{...payload, type: verb}`; confirm `isProject` is derived from something that is true for an HTTP-originated project-panel call, not from a live `this._projectPanel` webview reference — if it is the latter, derive it from the payload's surface instead).

### 3. `src/webview/planning.js` — remove the vestigial tickets posts

After step 5 of the verification plan confirms them unreachable, delete the dead tickets-tab code paths in `planning.js` (the `refreshTicketsDelta` / ticket-member / local-ticket-file blocks listed in the dependency audit) along with any now-orphaned handlers. If any path proves live, instead add a `TICKETS_VERBS` delegation arm beside the memo/kanban arms:

```ts
        if (TICKETS_VERBS.has(verb) && !PLANNING_VERBS.has(verb)) {
            if (this._ticketsPanelProvider) { return this._ticketsPanelProvider.handleServiceVerb(verb, payload); }
            throw new Error(`Tickets verb '${verb}' requires TicketsPanelProvider, which is not attached.`);
        }
```

### 4. `src/test/browser-panel-verb-routing.test.js` (new)

A route-accurate guard so this class of defect cannot recur silently. For each browser panel, parse every outbound `vscode.postMessage({type:'…'})` from its `.js` and assert the verb is reachable on that panel's route:

| Panel file | Route prefix | Allowlists consulted |
|---|---|---|
| `project.js`, `planning.js`, `memo.js` | `/project`, `/planning`, `/memo` | `PLANNING_VERBS` + `TASKVIEWER_VERBS` + the explicit delegation arms |
| `tickets.js` | `/tickets` | `TICKETS_VERBS` |
| `design.js` | `/design` | `DESIGN_VERBS` |
| `connections.js` | `/connections` | `SETUP_VERBS` + `PLANNING_VERBS` |
| `kanban.html` inline script | `/kanban` | `KANBAN_VERBS` |

The test must exclude `contentWindow.postMessage` / `window.parent.postMessage` calls (iframe messages such as `sbInspectToggle`, which are not verbs) — match only the `vscode.postMessage` receiver, or the test will fail on correct code.

## Verification Plan

1. **Catalogue regenerated, not hand-edited:** `npm run catalog:generate` produces no diff beyond the intended `webviewReady` addition. `git diff src/generated/verbAllowlist.ts` shows exactly one added token.

2. **Compile + suite:** `npx tsc --noEmit -p .`, `npm test`. The new routing test must be green — and must be shown to *fail* on the pre-fix tree (stash the provider + catalogue changes, run it, confirm it reports `improvePlan` and `webviewReady`).

3. **Browser project panel opens clean.** Open the project panel in the browser cockpit with devtools open. Assert: **no** red transport banner, and no `[transport] verb failed` console warning naming `webviewReady`. Before the fix the banner appears on every open.

4. **Cold-open handshake actually completes.** From the browser board, click a card's Review action (which queues `activateKanbanTabAndSelectPlan` for a cold project panel). The panel must open on the Kanban tab with that plan selected **promptly** — not after the ~10s best-effort flush at `PlanningPanelProvider.ts:601-606`. Time it; sub-second vs ten seconds is the observable difference.

5. **Vestigial tickets verbs — prove reachability before deleting.** In the browser, open the planning panel, exercise every tab and control, and watch the network tab for any `POST /planning/verb/refreshTicketsDelta` (or the other 13). Repeat in the editor planning panel with the console open. Zero requests + zero handler hits ⇒ dead, delete. Any hit ⇒ wire the `TICKETS_VERBS` delegation instead.

6. **Improve button works in the browser.** Project panel → Kanban tab → select a plan → *Improve*. Assert: no error banner; the button flashes `Copied ✓`; the improve-plan prompt is on the **browser** clipboard (paste it and confirm it contains the plan's title, its absolute file path, and the `improve-plan` skill text).

7. **Improve button works in the editor** (repaired, previously silent). Same click in the VS Code project panel: the prompt must land on the host clipboard. Before the fix nothing happened at all.

8. **Guard still guards.** `curl -s -X POST localhost:$(cat .switchboard/api-server-port.txt)/planning/verb/definitelyNotAVerb -H 'Content-Type: application/json' -d '{}'` must still return `{"success":false,"error":"Unknown Planning verb: 'definitelyNotAVerb'"}`. The trust boundary must not have been loosened to fix the two legitimate verbs.

9. **`improvePlan` delegation is not a silent success when KanbanProvider is absent.** With `_kanbanProvider` unset (unit-level), the delegation must throw the named error rather than returning `{success:true}`.
