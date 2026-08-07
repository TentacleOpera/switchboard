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
| `webviewReady` | `src/webview/project.js:1166` | **none** — absent from all six allowlists (verified: zero occurrences in `src/generated/verbAllowlist.ts`) | Handled: `PlanningPanelProvider.ts:2499` (`if (msg.type === 'webviewReady' && isProject)`) completes the ready handshake and flushes queued messages | Rejected at `:121` before `_handleMessage` is ever reached → red error banner on **every** project-panel open. (The handshake also cannot complete over HTTP even once catalogued — see root cause 1b.) |
| `improvePlan` | `src/webview/project.js:2075` (the Kanban tab's *Improve* button) | `KANBAN_VERBS` only — the implementation is `KanbanProvider.ts:9797-9846` | Falls through `_handleMessage` with no matching case → the button silently does nothing | Rejected at `:121` → red error banner reading `Unknown Planning verb: 'improvePlan'` |

(All other panels are clean: `tickets.js`, `memo.js`, `connections.js` and `design.js` have zero live verbs outside their routes' allowlists. `sbInspectToggle` looks like an offender in a naive grep but is an **iframe** message — `frame.contentWindow.postMessage(...)` at `planning.js:7139` and `DesignPanelProvider.ts:562` — not a verb, so it is correctly absent.)

### Root cause

Two different mistakes with the same symptom.

**1. `webviewReady` is a handshake, not a verb, and was never catalogued.** `PlanningPanelProvider` handles it *inside* `_handleMessage`, downstream of the allowlist guard. That works for the editor, where the webview's `onDidReceiveMessage` calls `_handleMessage` directly (`:612-618`), and fails for the browser, where every message must first clear `handleServiceVerb`'s guard.

There are **two** independent reasons the browser handshake cannot land, and the second was missed:

> **Superseded:** "Because the handshake never lands, the panel's queued cold-open messages (e.g. `activateKanbanTabAndSelectPlan` from a board Review click) are only released by the 10-second best-effort timeout at `:601-606` — which is why browser project-panel actions taken immediately after opening appear to do nothing."
> **Reason:** Verified 2026-08-06 and this is wrong — the readiness queue is **editor-only**. `postMessageToProjectWebview` (`:968-979`) mirrors to WS clients *unconditionally at `:973`, before* the `_projectPanelReady` check; only the editor's `_projectPanel.webview.postMessage` is gated by the queue (`:974-978`). There is also `pushProjectMessageToWsOnly` (`:989-997`), which exists specifically for browser-originated clicks and skips the queue and the editor panel entirely. A browser client therefore never waits on the 10-second flush, and no browser symptom is attributable to it. Chasing a sub-second-vs-ten-second timing difference in the browser would measure nothing.
> **Replaced with:** the **only** browser-visible symptom of the missing catalogue entry is the red transport banner on every project-panel open — the HTTP 500 produced by the allowlist throw. That is the defect to fix and the thing to verify. The 10-second queue starvation is a real mechanism but an editor-side one, and in the editor the handshake already works (see below), so nothing is starved there either.

**1b. Even catalogued, the handler still would not run on the browser path — `isProject` is a positional parameter HTTP never sets.** `_handleMessage(msg: any, isProject: boolean = false)` (`:2494`) gates the `webviewReady` branch on `isProject` (`:2499`). Only the editor's `onDidReceiveMessage` passes `true` (`:616`); `handleServiceVerb` calls `this._handleMessage({ ...payload, type: verb })` with **one argument**, so `isProject` is `false` for every HTTP-originated call. Adding `webviewReady` to `PLANNING_VERBS` makes the request return 200 (banner gone) but the branch at `:2499` still never executes for a browser client. The original plan listed this as a "confirm"; it is a confirmed fact and it changes the fix (see Proposed Changes §2).

**2. `improvePlan` lives in the wrong provider for the panel that posts it.** The implementation is `KanbanProvider`'s (it reads `.agents/skills/improve-plan/SKILL.md`, builds the prompt and writes the clipboard), and it is catalogued under `KANBAN_VERBS`. `project.js` posts it on `/project/verb`. There is no cross-provider delegation for it — unlike the memo verbs, which `PlanningPanelProvider` explicitly forwards to `TaskViewerProvider` (`:112-120`) precisely because they are catalogued elsewhere. `improvePlan` needed the same treatment and never got it.

Note this also makes the *editor* Improve button dead (silent fall-through), so the fix repairs both hosts.

## Metadata

- **Complexity:** 4
- **Tags:** backend, api, bugfix
- **Project:** Browser Switchboard

> **Superseded:** **Complexity:** 3
> **Reason:** Verification found a second, non-obvious mechanism (`isProject` is a positional parameter HTTP never sets) that changes the `webviewReady` fix from "add a catalogue entry" to "add a catalogue entry **and** decide what the HTTP path does, given that flushing the editor's queue from a browser handshake would be cross-surface contamination". That is a design decision plus a cross-provider delegation plus a catalogue regeneration — the top of Routine, not the middle.
> **Replaced with:** **Complexity:** 4

## User Review Required

None. The two judgement calls are decided in this plan: `improvePlan` is delegated pre-guard rather than adopted into `PLANNING_VERBS`, and the HTTP `webviewReady` path is an explicit no-op ack rather than a queue flush. Both are argued in the Complexity Audit and Proposed Changes.

## Complexity Audit

**Mostly routine, with one design decision and one catalogue-generation step that is easy to forget.**

### Routine

- `src/generated/verbAllowlist.ts` is auto-generated (`// AUTO-GENERATED — do not edit; run \`npm run catalog:generate\``) from `protocol-catalog.json`. The fix must edit `protocol-catalog.json` and regenerate — hand-editing the generated file will be silently reverted by the next generation run.
- The delegation pattern to copy already exists ten lines above the guard (`PlanningPanelProvider.ts:112-120`, the memo verbs), including the comment explaining why it must sit *before* the `PLANNING_VERBS` check. Mirror it. `_kanbanProvider` is confirmed present as a field (`:287`) with a setter (`:321`).
- No DB work, no migration, no UI change, no dispatch/terminal involvement, no ratchet impact (no `break` → `return` conversion).

### Complex / Risky

- **The `webviewReady` remedy is a design decision, not a catalogue edit.** See Proposed Changes §2: the naive fix (thread a browser-derived `isProject: true`) makes a browser handshake flush the **editor's** pending-message queue and set `_projectPanelReady = true` for a panel that never became ready.
- **Two viable placements for `improvePlan`, and one of them is a silent no-op.** The codebase contains both patterns: the memo verbs delegate to another provider *before* the guard (`:112-120`), while `promptSelected` delegates to `_kanbanProvider.handleServiceVerb` from *inside* `_handleMessage` (`:3599-3604`, `:3624-3629`) because it **is** in `PLANNING_VERBS`. Pre-guard delegation is the correct one here, and the reason is contract #5 in the project PRD: forwarding to `KanbanProvider.handleServiceVerb` means the payload is validated against *Kanban's* schema for `improvePlan`, the provider that actually dereferences its fields. Adding `improvePlan` to `PLANNING_VERBS` instead would validate it against a Planning schema that does not exist and then reach a `_handleMessage` with no case for it — swapping a loud error for a silent no-op, which is the bug that already makes the editor's Improve button dead.
- Do **not** solve either verb by loosening the allowlist guard (e.g. "allow unknown verbs through to `_handleMessage`") — the guard is the network trust boundary for untrusted HTTP input and the reason an unknown verb is never dynamically invoked.
- `webviewReady` itself is a lifecycle ping with no payload and no security surface, so adding it to the Planning verb surface is safe.

## Edge-Case & Dependency Audit

- **Do not hand-edit the generated allowlist.** Change `protocol-catalog.json` → run `npm run catalog:generate` → commit both. Verify the regenerated file contains the new entries and nothing else changed.
- **Delegation must precede the guard.** `improvePlan` is not a Planning verb and must not be added to `PLANNING_VERBS`; it must be forwarded to `KanbanProvider.handleServiceVerb` ahead of the guard, exactly like the memo verbs. Adding it to `PLANNING_VERBS` instead would let it reach `_handleMessage`, which has no case for it — swapping a loud error for a silent no-op.
- **`KanbanProvider.handleServiceVerb` may not be attached.** The memo delegation throws a specific error when `_taskViewerProvider` is missing (`:118-119`). Mirror that for `_kanbanProvider` rather than optional-chaining into `undefined` and returning a bogus success.
- **`improvePlan` returns `{ success: true, prompt }`** (`KanbanProvider.ts:9840`; the arm opens at `:9797`). That is exactly the shape `transport.js:292-296` needs to put the prompt on the **browser** clipboard — so the browser Improve button will start working end-to-end for free once routing is fixed. Confirm the `prompt` field survives the delegation (return the provider's result verbatim; do not re-wrap it as `{success:true}`).
- **`improvePlan` also posts `showStatusMessage`** to the kanban webview (`:9834`). In the browser that push is surface-tagged for the board, not the project panel, so the project panel will not show it. The clipboard write plus the reply body are the project panel's signal; that is sufficient and no new push is needed.
- **The editor Improve button changes behaviour** from "does nothing" to "copies the improve-plan prompt". That is the intended repair, not a regression — but it means the editor path needs its own UAT line.
- **`webviewReady` has no schema.** `validateVerbPayload` passes through verbs with no schema (`verbSchemas.ts:54-56`), so adding the verb without a schema entry is consistent with the generic-dispatch contract. Optionally add an empty schema `{}` alongside the other lifecycle verbs.
- **Idempotency.** `project.js` posts `webviewReady` once at mount (`:1166`), but a browser reconnect re-runs panel init. With the HTTP path returning a bare ack (§2), repeated posts are trivially idempotent. The editor branch is also safe: `_flushPendingProjectMessages` (`:999-1010`) only sets the ready flag, clears the timer and drains an array it then empties.
- **The Improve button's `Copied ✓` flash is optimistic and proves nothing.** `project.js:2069-2072` sets `textContent = 'Copied ✓'` and schedules the revert **before** posting the verb, so it flashes identically whether the call succeeds, 500s, or writes nothing to the clipboard. Any verification step that treats the flash as a success signal is measuring the wrong thing — assert on clipboard *content* and on the absence of the transport banner.
- **Vestigial cluster, verify-then-delete (not deferred).** `planning.js` posts 14 tickets-family verbs (`refreshTicketsDelta` at `:7399`, `:7445`, `:7456`, `:7474`, `:7486`, `:8460`; `loadTicketMembers` at `:1417`; plus `loadTicketAssignees`, `listLocalTicketFiles`, `readLocalTicketFile`, `ticketAttachImage`, `ticketsDefaultRoot`, `ticketsRootChanged`, `getTicketSyncStatuses`, `clickupUpdateTaskAssignees`, `clickupUpdateTaskPriority`, `linearUpdateIssueAssignee`, `linearUpdateIssuePriority`). They are in `TICKETS_VERBS`, but `planning.js` posts on `/planning/verb`, so any live one would throw. Evidence says they are unreachable: `planning.html` contains **zero** occurrences of `data-tab="tickets"` / `tickets-tab`, and `tickets.html` only mentions `planning.js` in a comment — the tickets surface moved to its own panel. Step 5 of the verification plan proves reachability empirically; whatever is confirmed dead gets deleted in this plan, and anything found live gets a `TICKETS_VERBS` delegation arm alongside the memo one.

## Dependencies

- None. No session dependency (`sess_*`) applies. This plan shares no method or file with the other three subtasks in the feature — they touch dispatch/terminal paths in `TaskViewerProvider` / `DesignPanelProvider` / `KanbanProvider`, this one touches `PlanningPanelProvider.handleServiceVerb`'s pre-guard block, `_handleMessage`'s handshake branch, `protocol-catalog.json` and `planning.js`. It can land first, last, or in parallel.
- Advisory only: `browser-direct-terminal-helpers-not-fleet-aware` also edits `PlanningPanelProvider.ts`, in a different region (`_sendPromptToTerminal` and the five builder arms). Per the project PRD's orchestration discipline — one agent stream per provider file — these two should not be coded **concurrently** by different agents even though they do not logically conflict.

## Adversarial Synthesis

**Risk summary.** The main risk is fixing the symptom and declaring victory: adding `webviewReady` to the catalogue removes the red banner while the handler at `:2499` still never runs over HTTP, and because the browser's real pushes arrive via unconditional WS mirroring, nothing observable distinguishes "handshake works" from "handshake acked and ignored" — so a reviewer can neither confirm nor refute the fix from the UI. That is why §2 makes the HTTP path an explicit, commented no-op ack rather than pretending to complete a handshake it cannot. Second risk: solving `improvePlan` by adding it to `PLANNING_VERBS`, which converts a loud error into a silent no-op and loses Kanban's schema validation at the boundary. Third: hand-editing the generated allowlist, which the next `catalog:generate` silently reverts. Mitigations: pre-guard delegation returning the provider's result verbatim (so `prompt` survives to the browser clipboard); a route-accurate contract test that must be shown red on the pre-fix tree; and a curl check proving the unknown-verb guard still rejects.

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

**The `webviewReady` handshake needs one more edit — and it is deliberately *not* "make the browser path flush the queue".**

> **Superseded:** "once the catalogue change lands it needs no code edit — verify the `isProject` branch is reached on the browser path … confirm `isProject` is derived from something that is true for an HTTP-originated project-panel call … if it is the latter, derive it from the payload's surface instead."
> **Reason:** `isProject` is neither derived nor inferred — it is the second positional parameter of `_handleMessage(msg, isProject = false)` (`:2494`), passed `true` only by the editor webview's `onDidReceiveMessage` (`:616`). `handleServiceVerb` calls `_handleMessage` with one argument, so it is `false` for every HTTP call. But the suggested remedy — derive it as `true` for HTTP project-panel calls — is actively wrong: `_flushPendingProjectMessages()` (`:999-1010`) sets `_projectPanelReady = true` and drains `_pendingProjectMessages` into `this._projectPanel.webview`. Firing that from a **browser** handshake would (a) mark the *editor's* Project panel ready when it is not, and (b) replay editor-queued messages (e.g. a tab jump + plan selection) early — exactly the cross-surface contamination `pushProjectMessageToWsOnly` (`:981-997`) was written to avoid. And it buys nothing: browser clients receive their pushes unconditionally via `mirrorToWs` at `:973`.
> **Replaced with:** catalogue the verb so the request returns 200, and make the HTTP path an explicit no-op ack. The queue is editor-only, by design.

```ts
     private async _handleMessage(msg: any, isProject: boolean = false): Promise<any> {
         if (msg.type === 'webviewReady' && isProject) {
             this._flushPendingProjectMessages();
             return;
         }
+        // HTTP-originated handshake (isProject is false — handleServiceVerb calls this
+        // with one argument). Ack it so the browser's POST /project/verb/webviewReady
+        // returns 200 instead of the allowlist throw's 500-and-red-banner, and stop.
+        // Deliberately does NOT flush _pendingProjectMessages: that queue gates ONLY the
+        // editor's _projectPanel.webview (:974-978) — WS clients are mirrored
+        // unconditionally at :973 — so flushing here would mark an editor panel ready
+        // that never booted and replay its queued messages early.
+        if (msg.type === 'webviewReady') {
+            return { success: true };
+        }
```

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

### Automated Tests

1. **Catalogue regenerated, not hand-edited:** `npm run catalog:generate` produces no diff beyond the intended `webviewReady` addition. `git diff src/generated/verbAllowlist.ts` shows exactly one added token.

2. **Compile + suite:** `npx tsc --noEmit -p .`, `npm test`. The new routing test must be green — and must be shown to *fail* on the pre-fix tree (stash the provider + catalogue changes, run it, confirm it reports `improvePlan` and `webviewReady`).

3. **Ratchet + parity:** `npm run parity:check` (this plan changes the allowlist, so parity is the load-bearing gate here — allowlists ≡ catalogs), plus `npm run verb-returns:check` and `npm run push-routing:check` with **no baseline edit**.

### Manual / UAT

4. **Browser project panel opens clean.** Open the project panel in the browser cockpit with devtools open. Assert: **no** red transport banner, and no `[transport] verb failed` console warning naming `webviewReady`. Confirm in the network tab that `POST /project/verb/webviewReady` returns **200**, not 500. Before the fix the banner appears on every open.

5. **Cold-open path still delivers (not a timing test).** From the browser board, click a card's Review action (which pushes `activateKanbanTabAndSelectPlan`). The browser project panel must open on the Kanban tab with that plan selected. Do **not** time this against the 10-second flush: WS clients are mirrored unconditionally (`PlanningPanelProvider.ts:973`), so the queue never gated the browser and there is no sub-second-vs-ten-second difference to observe. This step exists to prove the ack did not *break* an already-working path.

6. **Editor handshake unchanged.** Open the project panel in VS Code and confirm the editor's `webviewReady` still reaches `_flushPendingProjectMessages` (its branch is untouched) — a cold-open editor Review click must still land promptly. This is the path that would break if the new HTTP branch were placed *before* the `isProject` branch instead of after it.

7. **Vestigial tickets verbs — prove reachability before deleting.** In the browser, open the planning panel, exercise every tab and control, and watch the network tab for any `POST /planning/verb/refreshTicketsDelta` (or the other 13). Repeat in the editor planning panel with the console open. Zero requests + zero handler hits ⇒ dead, delete. Any hit ⇒ wire the `TICKETS_VERBS` delegation instead.

8. **Improve button works in the browser.** Project panel → Kanban tab → select a plan → *Improve*. Assert: no error banner, and the improve-plan prompt is on the **browser** clipboard — paste it and confirm it contains the plan's title, its absolute file path, and the `improve-plan` skill text. **Ignore the `Copied ✓` flash**: `project.js:2069-2072` sets it before posting the verb, so it appears identically on failure and is not evidence of anything.

9. **Improve button works in the editor** (repaired, previously silent). Same click in the VS Code project panel: the prompt must land on the host clipboard. Before the fix nothing happened at all.

10. **Guard still guards.** `curl -s -X POST localhost:$(cat .switchboard/api-server-port.txt)/planning/verb/definitelyNotAVerb -H 'Content-Type: application/json' -d '{}'` must still return `{"success":false,"error":"Unknown Planning verb: 'definitelyNotAVerb'"}`. The trust boundary must not have been loosened to fix the two legitimate verbs.

11. **`improvePlan` delegation is not a silent success when KanbanProvider is absent.** With `_kanbanProvider` unset (unit-level), the delegation must throw the named error rather than returning `{success:true}`.

12. **Delegated payload is validated by Kanban, not waved through.** Curl `POST /project/verb/improvePlan` with an empty body: it must return Kanban's own failure (`{"success":false,"error":"workspaceRoot and planFile are required"}` — `KanbanProvider.ts:9801`), proving the delegation reaches that provider's guard and schema rather than bypassing validation.

## Recommendation

Complexity 4 → **Send to Coder.**

## Review Findings

**Reviewer:** Direct reviewer pass (GLM-5.2 High)
**Date:** 2026-08-07
**Verdict:** PASS — all material requirements verified in source; one MAJOR finding (missing contract test) now fixed; one MINOR finding (vestigial tickets verbs in planning.js) documented as pending-deletion.

### Verified

| Requirement | Status | Evidence |
|---|---|---|
| `webviewReady` added to `PLANNING_VERBS` | ✅ | `src/generated/verbAllowlist.ts` confirmed; `protocol-catalog.json` regenerated |
| `improvePlan` delegated pre-guard to KanbanProvider | ✅ | `if (verb === 'improvePlan')` arm sits BEFORE the `PLANNING_VERBS` guard; returns `KanbanProvider.handleServiceVerb(verb, payload)` verbatim |
| `improvePlan` NOT adopted into `PLANNING_VERBS` | ✅ | Not in the set — adopting it would reach a `_handleMessage` with no case (silent no-op) |
| `improvePlan` delegation throws named error when KanbanProvider not attached | ✅ | `throw new Error(\`Verb '${verb}' requires KanbanProvider\`)` confirmed |
| `webviewReady` HTTP path is explicit no-op ack | ✅ | `case 'webviewReady'` returns `{ success: true }`; does NOT call `_flushPendingProjectMessages` |
| Editor `isProject` webviewReady branch still flushes | ✅ | `if (msg.type === 'webviewReady' && isProject)` branch still calls `_flushPendingProjectMessages`; sits before the HTTP case |
| PLANNING_VERBS unknown-verb guard still throws | ✅ | `if (!PLANNING_VERBS.has(verb)) { throw new Error(...) }` confirmed |
| Route-accurate sweep: project.js, planning.js, memo.js, tickets.js, design.js, connections.js, kanban.html | ✅ | All panels verified — every posted verb is reachable on its route (with documented vestigial exception, see MINOR below) |

### MAJOR Finding (Fixed)

**Missing contract test.** The plan's verification section specified a new contract test file (`browser-panel-verb-routing`), but it was never created. **Fixed:** Created `src/test/browser-panel-verb-routing.test.js` (11 assertions), wired into `package.json` as `test:contract:browser-panel-verb-routing` and CI workflow `integration-tests.yml`. All 11 assertions pass.

### MINOR Finding (Not fixed — pending browser UAT)

**13 vestigial tickets-family verbs in `planning.js`.** The planning panel webview still posts 13 tickets verbs (`refreshTicketsDelta`, `loadTicketMembers`, `loadTicketAssignees`, `listLocalTicketFiles`, `readLocalTicketFile`, `ticketAttachImage`, `ticketsDefaultRoot`, `ticketsRootChanged`, `getTicketSyncStatuses`, `clickupUpdateTaskAssignees`, `clickupUpdateTaskPriority`, `linearUpdateIssueAssignee`, `linearUpdateIssuePriority`) left over from before the tickets surface moved to its own panel. The plan's §3 says to verify reachability in-browser then DELETE them (or add a `TICKETS_VERBS` delegation arm if any prove live). That browser UAT was not run, so they are tracked in the contract test as a documented `PLANNING_VESTIGIAL_TICKETS` exception set. The routing guard still catches any NEW offender. These are pre-existing, not introduced by this feature.

### Gate Wiring Audit

| Gate | Status |
|---|---|
| `npx tsc --noEmit` | ✅ No new errors (5 pre-existing TS2835 in unrelated modules) |
| `npm run parity:check` | ✅ Pass |
| `npm run push-routing:check` | ✅ Pass |
| `npm run catalog:generate` | ✅ No unintended diff |
| `test:contract:browser-panel-verb-routing` | ✅ 11/11 pass (NEW) |
| `test:contract:verb-engine-planning` | ✅ 23/23 pass |
| `test:contract:panel-runtime-surface` | ✅ Pass |
