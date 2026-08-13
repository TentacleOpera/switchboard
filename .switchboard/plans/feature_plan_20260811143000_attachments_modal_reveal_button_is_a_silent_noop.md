# Delete the attachments-modal "Reveal" button and replace it with "Copy path"

## Goal

Remove the **Reveal** affordance from the Tickets attachments modal end-to-end — button, listener, verb arm, response arm, and the orphaned standalone stub — and put a **Copy path** button in its slot that writes the attachment's absolute local path to the clipboard directly from the webview.

### Problem

`Reveal` has never worked. It reports success and does nothing, on every host, in every configuration.

`git log -S` places its introduction in `cdfc407b` (2026-06-16, "Fix Attachment Download Path and UI Improvements") and shows it carried over verbatim in the Tickets panel extraction (`30d82f81`, 2026-08-04). It was born broken and has been shipped broken for roughly two months.

**Why it does nothing:**

```ts
// src/services/TicketsPanelProvider.ts:3524
await this._seams().commands.executeCommand('revealInExplorer', localPath);
```

`revealInExplorer` resolves its argument as a resource URI. Handed a raw `string`, it resolves nothing and returns **without throwing** — so the `catch` never fires, the success push goes out, and the webview prints `Attachment revealed ✓` (`src/webview/tickets.js:7994-8000`) for an action that did not happen. The two other reveal call sites in this repo both do it correctly, with `revealFileInOS` and a `Uri` (`src/services/PlanningPanelProvider.ts:3102`, `src/services/TaskViewerProvider.ts:11282`).

On the standalone/browser host it is structurally impossible for it to ever work — both reveal commands are registered as no-op stubs (`src/standalone/bootstrap.ts:830-831`).

The contrast with the sibling arm is the tell. `openAttachment` (`src/services/TicketsPanelProvider.ts:3492-3516`) goes through `this._seams().ui.openExternal(pathToFileURL(localPath).toString())` — a real seam call that works on both hosts. `revealAttachment` reaches for `commands.executeCommand` with a raw string, which is neither host-agnostic nor correct on the host it was written for.

### Why delete rather than fix

The affordance is redundant in this modal, and its one remaining justification is wrong on the surface this panel is pinned to:

1. **`Open` already covers viewing** — `openAttachment` hands the file to the OS default application (`src/services/TicketsPanelProvider.ts:3492-3516`).
2. **The path is already on screen.** Each downloaded row prints `Path: <localPath>` as text directly under the filename (`src/webview/tickets.js:2844-2849`), so "where is this file" is already answered.
3. **Images preview inline** in the modal via `att.webviewUri` (`src/webview/tickets.js:2850-2864`).
4. **On the browser cockpit, revealing is incoherent.** The file manager would open on the *host* machine, not on the machine the person is looking at. For a remote viewer that is useless; for a local one it duplicates `Open`.
5. **Two months shipped and broken with no report** until deliberate UAT. A button whose absence is undetectable for two months is not answering a real need.

Deleting it also settles a PRD contract violation rather than papering over it: contract #6 (*capability-gating honesty*) forbids "a stub that fakes success", which is exactly what `revealAttachment` is on both hosts.

What this workflow actually does with an attachment path is paste it into an agent prompt. That pattern already exists in six places in `src/webview/project.js` (e.g. line 1322) as `navigator.clipboard.writeText(toAgentRef(path))`, and `tickets.js` itself already uses `navigator.clipboard.writeText` at line 4669. `toAgentRef` is a passthrough returning the clean absolute path (`src/webview/sharedUtils.js:7`), and `sharedUtils.js` is loaded by `tickets.html` as its **first** script (line 4736), ahead of `tickets.js` (line 4744), on both hosts (`src/services/headlessPanelHtml.ts:433, 437`).

So the replacement needs **no verb, no host round-trip, and no standalone implementation** — which is what makes this a deletion rather than a rewrite.

## Metadata

- **Complexity:** 2
- **Tags:** bugfix, refactor, frontend, ui
- **Project:** Browser Switchboard

## User Review Required

None. The affordance is being deleted, not redesigned, and the replacement has direct in-file precedent.

## Complexity Audit

### Routine

- Deleting one button, one listener, one verb arm, one response arm and one orphaned stub registration.
- The replacement is a clipboard write with direct precedent in the same file (`src/webview/tickets.js:4669`).
- No schema work. `src/services/verbSchemas.ts` has **no** entry for `revealAttachment` — nor for `openAttachment`, `downloadAttachment` or `viewAttachments`. Verified: the only attachment-adjacent schema in that file is `persistTabState` (line 121). Nothing to remove there.

### Complex / Risky

Two items that need care, neither risky:

1. **`src/generated/verbAllowlist.ts` is generated — never hand-edit it.** Removing `revealAttachment` means running `npm run catalog:generate` (`package.json:874`) and letting `npm run catalog:check` (`package.json:875`) gate it in CI.
2. **`revealFileInOS`'s stub must survive the cleanup.** Only `revealInExplorer` becomes orphaned. `revealFileInOS` still has two live callers, so deleting both stub lines would break them.

**Ratchet impact: none.** The `revealAttachment` arm terminates with `return;` (`src/services/TicketsPanelProvider.ts:3540`), not `break;`. `npm run verb-returns:check` counts residual `break` statements per provider, so deleting this arm does **not** move the Tickets count. Do **not** lower the `"Tickets": 55` ceiling in `scripts/verb-return-contract-baseline.json` as part of this change — a ceiling only ratchets down when real `break`s were converted, and none were.

**Migration:** none required. `revealAttachment` is an internal webview↔host wire verb, not persisted state — no settings key, no DB column, no on-disk format, no user data keyed on it. The webview and host ship in the same VSIX (the browser cockpit is served from the VSIX's `dist`), so there is no version-skew window in which an old client could send `revealAttachment` to a new host.

## Edge-Case & Dependency Audit

### Race Conditions

| Case | Required behaviour |
| --- | --- |
| Transient user activation | The copy must run synchronously inside the click handler. Do not move it behind a `setTimeout` or after an `await` of a host round-trip, or the browser will reject the write. Calling `navigator.clipboard.writeText(...)` first and chaining `.then()` on the returned promise is fine — the activation is consumed at call time. |
| Modal re-rendered mid-click | `renderAttachmentsList` replaces `attachmentsList.innerHTML` wholesale and rebinds. The path is read from `btn.dataset.localPath` at click time, so a stale button that has already been detached simply never fires. No guard needed. |

### Security

| Case | Required behaviour |
| --- | --- |
| Path injection into the attribute | Keep `escapeAttr(localPath)` on the `data-local-path` write, exactly as `Open` does today. |
| Clipboard content | The absolute path only. `toAgentRef` is a passthrough (`src/webview/sharedUtils.js:7`) — no shell quoting, no `@` prefix. |

### Side Effects

| Case | Required behaviour |
| --- | --- |
| Clipboard write rejects (non-secure origin, permission denied) | Must show a **red** error status. Do not `.catch` into silence and do not show a ✓ — reintroducing a faked success is the exact defect being deleted. |
| Clipboard in the VS Code webview | `navigator.clipboard.writeText` works and is already relied on at `src/webview/tickets.js:4669` in this same file. |
| Clipboard in the browser cockpit | Served from `http://127.0.0.1:<port>`; a loopback origin is a secure context, so the async Clipboard API is available. |
| Paths with spaces or unicode | Copied verbatim, unquoted and unescaped — `toAgentRef` is a passthrough by design (users want clean absolute paths). |
| Attachment not yet downloaded | No `Copy path` button — it lives in the `isDownloaded` branch, exactly where `Reveal` did. There is no local path to copy otherwise. |
| Row layout | `Copy path` occupies the slot `Reveal` vacated, so the button row keeps its existing width and spacing. |

### Dependencies & Conflicts

| Case | Required behaviour |
| --- | --- |
| `revealFileInOS` stub in `bootstrap.ts:830` | **Keep.** Still called by `PlanningPanelProvider.ts:3102` and `TaskViewerProvider.ts:11282`. |
| Those two remaining `revealFileInOS` callers | **Explicitly out of scope.** They are still silent no-ops on the standalone host — the same faked-success shape, in two other features. This plan does not fix them and does not make them worse. Worth a separate plan; do not widen this one. |
| `revealInExplorer` stub in `bootstrap.ts:831` | **Delete** — zero callers remain after this change. Verify with grep, don't assume. |
| Any other `revealAttachment` sender | Only `src/webview/tickets.js:2886-2895`. A post-change grep across `src/` must return zero hits. Note `src/services/PlanningPanelProvider.ts:4882` and `src/webview/planning.js:4970` mention the name only inside "moved to TicketsPanelProvider" extraction comments — update those comment lines or accept the grep hits; do **not** leave them silently contradicting the code. |
| `src/services/verbSchemas.ts` | Has **no** entry for `revealAttachment` (nor for any attachment verb) — nothing to remove there. |
| Existing tests | No file under `src/test/` references `revealAttachment`, `reveal-attachment-btn` or `attachmentRevealed`. Nothing to update; add a guard instead. |
| **Feature sibling: chip-opens-viewer subtask** | This plan **must land first**. That subtask edits the same `renderAttachmentsList` function and its written text describes the row as carrying `Open` / `Reveal`. Landing it first would force a second rewrite of the same lines. |
| `toAgentRef` availability | `sharedUtils.js` is `tickets.html`'s first script (line 4736) and `toAgentRef` is a global (`sharedUtils.js:7`). `tickets.js` does not reference it today — this change is the first use in this panel. |

## Dependencies

- None. No prior session artifacts are required.

## Adversarial Synthesis

**Risk Summary.** The dominant risk is an *incomplete* deletion — leaving a sender, a response arm, or a stale allowlist entry behind so the verb half-exists and the `default` arm starts throwing at runtime. Mitigation is the grep-guard set, which is the primary verification here rather than an afterthought. The second risk is deleting the wrong `bootstrap.ts` stub (`revealFileInOS` has two live callers); mitigated by a counted grep. The replacement itself carries almost no risk: a synchronous clipboard write with an explicit red-error branch, using a pattern already shipped seven times in this codebase.

## Proposed Changes

### 1. `src/webview/tickets.js` — swap the button in `renderAttachmentsList` (line 2827-2831)

**Context.** The `isDownloaded` branch currently emits `Open` + `Reveal`.

**Implementation.**

```js
if (isDownloaded) {
    html += `
                <button class="strip-btn open-attachment-btn" data-local-path="${escapeAttr(localPath)}" style="font-size: 11px; padding: 2px 6px;">Open</button>
                <button class="strip-btn copy-attachment-path-btn" data-local-path="${escapeAttr(localPath)}" style="font-size: 11px; padding: 2px 6px;" title="Copy the absolute path to the clipboard">Copy path</button>
    `;
}
```

**Edge cases.** The `else` branch (`Open remote` + `Download`, lines 2832-2837) is untouched.

### 2. `src/webview/tickets.js` — replace the listener block (lines 2886-2895)

**Context.** The block sits between the `.open-attachment-btn` binding (2875-2884) and the `.download-attachment-modal-btn` binding (2897-2916).

**Implementation.** Delete the `.reveal-attachment-btn` block entirely and bind the replacement in its place:

```js
// Replaced the Reveal button (2026-08-11). Reveal posted `revealAttachment`,
// which called `revealInExplorer` with a raw string — VS Code resolves no
// resource and returns without throwing, so it reported success and did nothing
// on every host since it was added in cdfc407b. `Open` already covers viewing,
// the path is already printed under the filename, and on the browser cockpit a
// file manager would open on the HOST machine, not the viewer's. Copying the
// path is the operation this workflow actually performs — same pattern as
// project.js (six sites) and tickets.js:4669.
attachmentsList.querySelectorAll('.copy-attachment-path-btn').forEach(btn => {
    btn.addEventListener('click', () => {
        // Synchronous inside the click: the Clipboard API needs transient
        // user activation, so this must not sit behind a host round-trip.
        navigator.clipboard.writeText(toAgentRef(btn.dataset.localPath))
            .then(() => showTicketsStatus('Path copied ✓', false))
            // Never swallow this into a ✓ — a faked success is the bug we deleted.
            .catch(err => showTicketsStatus('Failed to copy path: ' + (err && err.message ? err.message : String(err)), true));
    });
});
```

**Edge cases.** `showTicketsStatus(text, isError)` is defined at `src/webview/tickets.js:333`; the second argument is the error flag.

### 3. `src/webview/tickets.js` — delete the `attachmentRevealed` arm (lines 7994-8000)

```js
case 'attachmentRevealed':
    ...
    break;
```

Remove entirely. Nothing else dispatches that message type. The neighbouring `attachmentOpened` arm (7986-7992) stays.

### 4. `src/services/TicketsPanelProvider.ts` — delete the verb arm (lines 3517-3541)

Remove the whole `case 'revealAttachment': { … }` block, including both `attachmentRevealed` pushes at 3526 and 3533. The `default` arm already throws loudly on an unhandled verb (`src/services/TicketsPanelProvider.ts:4242-4244`: `throw new Error(\`Unhandled Tickets verb: '${msg.type}'\`)`), which is the correct behaviour if any stale client ever sends it.

### 5. `src/generated/verbAllowlist.ts` — regenerate, do not hand-edit

```bash
npm run catalog:generate
```

`revealAttachment` should disappear from `TICKETS_VERBS` (currently present at `src/generated/verbAllowlist.ts:11`). `openAttachment`, `downloadAttachment` and `viewAttachments` must remain.

### 6. `src/standalone/bootstrap.ts` — drop the orphaned stub (line 831)

```ts
// Still stubbed: PlanningPanelProvider (zip reveal) and TaskViewerProvider
// (worktree folder reveal) both call this. Those two remain silent no-ops on
// this host — a separate defect, tracked separately, deliberately not widened
// into this change.
switchboardCommandRegistry.register('revealFileInOS', async () => undefined);
// `revealInExplorer` registration deleted — the Tickets attachments modal was
// its only caller, and that button is gone.
switchboardCommandRegistry.register('vscode.open', async () => undefined);
```

### 7. Extraction-comment hygiene

`src/services/PlanningPanelProvider.ts:4882` and `src/webview/planning.js:4970` name `revealAttachment` / `attachmentRevealed` in "moved to TicketsPanelProvider" comments. Update both lines to drop the now-deleted verb from the moved-list, so the comments stop describing code that no longer exists and the grep guards below stay meaningful.

## Verification Plan

> Session directive: this pass does **not** run compilation or automated tests. The gate commands below are listed for CI / the implementing session, not executed here.

### Automated Tests

1. New test `src/test/tickets-attachment-copy-path.test.js`:
   - render the attachments list with a downloaded attachment; assert a `.copy-attachment-path-btn` exists and **no** `.reveal-attachment-btn` does;
   - stub `navigator.clipboard.writeText`, click it, assert it received the exact `localPath` unmodified;
   - make the stub reject; assert the status is rendered as an **error** (`isError` true) and that no success string is shown;
   - render a not-downloaded attachment; assert neither button is present.
2. CI gates (run on merge, not in this session): `npm run catalog:check` must pass, confirming `verbAllowlist.ts` was regenerated rather than hand-edited or left stale; `npm run parity:check`; `npm run verb-returns:check` (the `"Tickets": 55` ceiling is expected to stay put — see Complexity Audit).

### Static guards — the primary check that this was a complete deletion, not a partial one

- `grep -rn "revealAttachment" src/` → **zero** hits (this includes the extraction comments cleaned up in change 7).
- `grep -rn "reveal-attachment-btn\|attachmentRevealed" src/` → **zero** hits.
- `grep -rn "revealInExplorer" src/` → **zero** hits.
- `grep -rn "revealFileInOS" src/ --include='*.ts'` → exactly **three** hits (the `bootstrap.ts:830` stub plus its two live callers), proving the wrong stub was not deleted.

> **Superseded:** `grep -rn "revealFileInOS" src/` → exactly **three** hits.
> **Reason:** The unfiltered grep returns **four** — `src/services/PlanningPanelProvider.ts.bak3:437` is a stale backup file still sitting in `src/services/`. A coder running the guard as written would see 4, assume a leftover caller, and go hunting for a bug that isn't there.
> **Replaced with:** `grep -rn "revealFileInOS" src/ --include='*.ts'` → exactly **three** hits (`.ts.bak3` does not match `*.ts`).

### Manual — VS Code editor panel

3. Open a ticket with an attachment → `View Attachments` → `Download`. The row shows `Open` and `Copy path`, and no `Reveal`.
4. Click `Copy path`, paste into a terminal. The path must be the exact absolute path shown in the `Path:` line — no `@` prefix, no quotes, no truncation.
5. Confirm `Open` still opens the file in the default application.
6. Copy a path containing a space or a unicode character and confirm it pastes intact.

### Manual — browser cockpit (the pinned surface)

7. Repeat steps 3-5 in the browser cockpit against the running standalone host. `Copy path` must work with no WS traffic at all — confirm in devtools that clicking it sends **no** message frame and issues **no** `POST /tickets/...`, since the copy is now purely client-side.
8. Confirm no console error mentioning an unknown or unhandled verb appears on panel load.

### Regression guard

9. Exercise the two surviving `revealFileInOS` callers (Planning zip export, worktree folder open) in the **editor** host and confirm they still reveal in Finder/Explorer — this change must not have touched them.

---

**Recommendation: Send to Intern** (complexity 2).
