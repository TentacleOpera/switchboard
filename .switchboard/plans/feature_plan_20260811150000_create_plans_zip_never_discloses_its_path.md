# Create Plans: disclose the docs-zip path instead of relying on a reveal that can silently fail

## Goal

Make the Create Plans "Download zip" flow tell the user **where the zip is**, in the panel, on every host — instead of depending entirely on an OS reveal whose failure is swallowed by two nested catches.

## Goal — problem analysis and root cause

### What this feature is

The Planning panel's **Create Plans** pane (wired in `src/webview/connections.js:370-412`) exists to get a workspace's documentation into an external AI surface and get plans back:

1. The user picks a source folder (`createPlansPickFolder`, `src/services/PlanningPanelProvider.ts:3060-3074`).
2. `createPlansDownloadZip` (`src/services/PlanningPanelProvider.ts:3075-3107`) recursively collects every `.md`/`.txt` in that folder, optionally adds the constitution, PRDs and README, prepends a `HOW-TO-PLAN.md` built from `CREATE_PLANS_CORE_PROMPT`, and writes a zip with a `MANIFEST.md`.
3. `bundleDocsContext` writes it to `<workspaceRoot>/.switchboard/create-plans/`, deleting any pre-existing `.zip` in that directory first (`src/services/ContextBundler.ts:34-41`).
4. The user uploads that zip to ChatGPT / Claude web, which reads the docs and returns plans.
5. The user pastes those plans back via `createPlansPasteBack` (`src/services/PlanningPanelProvider.ts:3108+`).

Step 4 is the whole point of the feature, and it requires the user to **find the file on disk** to drag into a browser upload dialog.

### The defect

The only thing that ever tells the user where the zip is, is a best-effort OS reveal:

```ts
// src/services/PlanningPanelProvider.ts:3101-3102
this._seams().ui.showTemporaryNotification(`Docs zip created (${fileCount} doc${fileCount === 1 ? '' : 's'})`);
try { await this._seams().commands.executeCommand('revealFileInOS', vscode.Uri.file(zipPath)); } catch { /* reveal is best-effort */ }
```

The notification discloses a **count, not a path**. So if the reveal does not happen, the user is told a file was created and given no way to find it.

And the reveal's failure is unobservable, because it is swallowed **twice**:

1. The local `catch { /* reveal is best-effort */ }` on line 3102.
2. `VscodeHostCommands.executeCommand` wraps every dispatch in a blanket `catch { return undefined; }` (`src/services/hostSeams.ts:327-336`), so the command cannot even throw out to that local catch.

On the standalone host it is worse than unobservable — it is guaranteed. `src/standalone/bootstrap.ts:848` registers `revealFileInOS` as `async () => undefined`, and the seam is registry-first (`src/services/hostSeams.ts:329-331`), so the registered stub is executed and returns cleanly. Note the second-order cost: without that registration the call would fall through to `vscodeShim.executeCommand`, which logs `[headless] command '<name>' is not bridged — the calling arm's side effect did not happen` (`src/standalone/vscodeShim.ts:244-250`). **The stub suppresses the one diagnostic that would have surfaced this.**

The fix is not to make the reveal work. The fix is to stop making path disclosure depend on a side effect that has no return channel: put the path in the panel, where it is visible, selectable and copyable regardless of host.

> **Superseded:** the original citation of the `revealFileInOS` stub registration as `src/standalone/bootstrap.ts:783`.
> **Reason:** line drift — the registration is at `src/standalone/bootstrap.ts:848` at HEAD. The claim itself is correct and verified; only the line number was stale.
> **Replaced with:** `src/standalone/bootstrap.ts:848`.

## Metadata

- **Complexity:** 3
- **Tags:** bugfix, frontend, backend, ux
- **Project:** Browser Switchboard

## User Review Required

None. The one judgement call — whether to keep the reveal at all — is decided below: keep it, demoted to a convenience.

## Complexity Audit

### Routine

- One response body carrying a string, one webview element rendering it, one clipboard copy with direct precedent (`src/webview/connections.js:535` already calls `navigator.clipboard.writeText`).
- No new verb, no allow-list regeneration, no schema, no persisted state, no migration — `createPlansDownloadZip` already exists and already runs; this adds a return payload and a push where today there is none.

### Complex / Risky

- **The delivery channel is the only real decision.** The arm currently `break`s, so an HTTP caller receives a bare `{success:true}` with no data — the exact "reachable but not usable" shape the PRD's return-in-body contract (#4) exists to prevent. The fix must **return** the path in the body *and* push it, not one or the other. See Proposed Changes §1 for why both.
- **`escapeHtml` is not available in this panel.** `src/webview/connections.html:554` loads only `connections.js`; `sharedUtils.js` is injected on neither the editor nor the headless serving path (`src/services/headlessPanelHtml.ts:459-461`). An `innerHTML` render with `escapeHtml(...)` would be a `ReferenceError` at the moment of success — a crash exactly where the user is being told things worked.

**One judgement call:** whether to keep the reveal at all. **Keep it**, as a genuine best-effort convenience *on top of* disclosure — in the editor host it lands the user directly in Finder, which is faster than copy-then-paste. It stops being load-bearing, which is the actual problem. This is the opposite call from the Tickets attachments Reveal button, and for a concrete reason: there, `Open` and a printed path already existed, so reveal was redundant; here, nothing else discloses the path at all.

## Edge-Case & Dependency Audit

### Side Effects

| Case | Required behaviour |
| --- | --- |
| Reveal succeeds (editor host) | Finder opens **and** the path is shown in the pane. Both, not either. |
| Reveal is a stub (standalone host) | Path is shown in the pane. The user copies it. Feature remains usable. |
| Reveal throws | Already swallowed by the seam's blanket catch; disclosure is unaffected because it no longer depends on the reveal's outcome. |
| Zip build fails | Existing `catch` shows `Docs zip failed: …` via `showErrorMessage`, and the arm now also returns `{success:false, error}`. Do **not** show a path. |
| Folder has no docs | Existing early-out notification. No path shown. |
| Folder fails validation | Sibling plan's `_validateDocsFolder` rejects before any read. No path shown. |
| A previous zip existed | `bundleDocsContext` deletes prior `.zip` files in the out dir first (`ContextBundler.ts:38-41`), so the displayed path is always the only zip present. No stale-path risk. |
| Path shown after a later failed run | The pane must clear the previous path when a new zip run starts, so a stale success path is never displayed next to a fresh error. |
| Very long path | Must wrap or scroll inside its container, never force the pane to scroll horizontally. |
| Clipboard rejects | Show a red error. Never a ✓ — a faked success is the exact bug class this plan exists to remove. |
| Browser cockpit | Delivered by the returned body, which `transport.js:405-412` re-dispatches as a message — the same handler serves both hosts. |
| `showTemporaryNotification` on standalone | Also inert (`src/standalone/hostServices.ts:428` logs to console; the live path's `vscode.window` equivalent is likewise not a UI). This is *why* the panel-side disclosure is the fix rather than putting the path in the toast. |

### Race Conditions

- The clearing message and the ready message are emitted from the same arm in order, so they cannot interleave for one run. Two concurrent zip runs are not reachable — the button is a single control in a single pane and `bundleDocsContext` writes to one deterministic destination.

### Security

- The disclosed path is one the server itself just wrote inside `<workspaceRoot>/.switchboard/create-plans/`. No user input is echoed. Rendering via `textContent` (not `innerHTML`) keeps it inert regardless.

## Dependencies

- `sess_none — no new package or service dependencies.`
- **Ordering:** land **after** the sibling plan *"Create Plans is unreachable on the standalone host — the folder picker is a stubbed native dialog"*. Until the picker is replaced, the Create Plans pane cannot be driven to the zip step on the browser cockpit, so verification step 8 below has no route through the real UI.

**Explicitly out of scope**, flagged rather than silently fixed or ignored:
- `VscodeHostCommands.executeCommand`'s blanket `catch { return undefined; }` (`src/services/hostSeams.ts:333-335`) converts *every* failed command into a silent success for *every* caller in the codebase. That is the structural enabler of this bug class. Changing it has a very large blast radius and deserves its own plan.
- The `revealFileInOS` stub registration at `src/standalone/bootstrap.ts:848`, which suppresses the not-bridged diagnostic.

## Adversarial Synthesis

**Key risks:** (1) disclosing only through a webview push, which leaves an HTTP caller with the same contentless `{success:true}` the PRD contract forbids; (2) rendering with `escapeHtml`, which is undefined in this panel and would throw on the success path; (3) leaving a stale path visible beside a later failure. **Mitigations:** return the path in the body *and* push it, so the browser gets it via `transport.js`'s re-dispatch and the editor via the webview; render with `textContent`; emit an explicit clearing message at the top of the arm.

## Proposed Changes

### 1. `src/services/PlanningPanelProvider.ts` — return the path and push it (replace lines 3099-3106)

```ts
const howToPlan = `# How to plan from these docs\n\n${CREATE_PLANS_CORE_PROMPT}\n\nThe docs are the other markdown files in this zip — see MANIFEST.md for the list.`;
const { zipPath, fileCount } = await bundleDocsContext(cpRoot, { sources, howToPlanMarkdown: howToPlan });
this._seams().ui.showTemporaryNotification(`Docs zip created (${fileCount} doc${fileCount === 1 ? '' : 's'})`);
// Disclose the path through the PANEL, not through the reveal. The reveal is a
// side effect with no return channel: its failure is swallowed by the seam's
// blanket catch (hostSeams.ts:333) and it is a no-op stub on the standalone host
// (bootstrap.ts:848), so a user whose reveal does not happen was previously told
// a file existed and never told where.
this.postMessageToWebview({ type: 'createPlansZipReady', zipPath, fileCount });
// Best-effort convenience ON TOP of disclosure — no longer load-bearing.
try { await this._seams().commands.executeCommand('revealFileInOS', vscode.Uri.file(zipPath)); } catch { /* reveal is best-effort */ }
// Return-in-body (PRD contract #4): an HTTP caller must receive the path, not a
// contentless ack. transport.js re-dispatches this body as a message, so the
// browser cockpit is served by the same handler as the editor's push.
return { success: true, type: 'createPlansZipReady', zipPath, fileCount };
```

Clear at the start of the arm, so a stale path never sits beside a new error:

```ts
case 'createPlansDownloadZip': {
    this.postMessageToWebview({ type: 'createPlansZipReady', zipPath: '', fileCount: 0 });
    // …existing body…
```

And give the failure branches real bodies rather than falling through to `break`:

```ts
} catch (err) {
    const message = `Docs zip failed: ${err instanceof Error ? err.message : String(err)}`;
    this._seams().ui.showErrorMessage(message);
    return { success: false, error: message };
}
```

The two early-outs (`No workspace open`, `Choose a folder to bundle first`, `That folder has no docs …`) likewise return `{ success: false, error: <same string> }` instead of `break`.

> **Superseded:** the original §1, which pushed `createPlansZipReady` and left the arm's terminal `break` in place.
> **Reason:** a `break` leaves the route layer to synthesise `{success:true}` with no data (`src/services/LocalApiServer.ts:2064-2067`). For the editor that is invisible, but the browser cockpit is the host this plan exists to fix, and an HTTP caller — including any external orchestration client — would get a success ack containing nothing. That is the "reachable but not usable" shape PRD contract #4 names explicitly.
> **Replaced with:** return the payload **and** keep the push. Both channels, one handler.

**Ratchet note for the implementer:** converting these `break`s to `return`s lowers this provider's residual `break` count. `npm run verb-returns:check` enforces a per-provider ceiling from `scripts/verb-return-contract-baseline.json`, and the PRD requires the ceiling be lowered to the true residual **in the same change**. Run `npm run verb-returns:baseline` after the edit and commit the updated baseline. Do not force the ceiling to 0 — `break` inside nested switches/loops is legitimate control flow.

### 2. `src/webview/connections.js` — render the path with a copy affordance

The pane already has a `cp-zip-hint` element (`src/webview/connections.js:383`). Render into it with DOM nodes, not `innerHTML`:

```js
case 'createPlansZipReady': {
    if (!zipHint) break;
    zipHint.textContent = '';
    if (!msg.zipPath) { break; }                 // cleared at run start
    const pathEl = document.createElement('div');
    pathEl.className = 'cp-zip-path';
    pathEl.style.cssText = 'font-size:11px; word-break:break-all;';
    pathEl.textContent = msg.zipPath;            // textContent, not innerHTML — see below
    const copyBtn = document.createElement('button');
    copyBtn.type = 'button';
    copyBtn.className = 'strip-btn';
    copyBtn.style.cssText = 'font-size:11px; padding:2px 6px;';
    copyBtn.textContent = 'Copy path';
    copyBtn.addEventListener('click', () => {
        // Synchronous inside the click — the Clipboard API needs transient user activation.
        navigator.clipboard.writeText(msg.zipPath)
            .then(() => { if (statusEl) statusEl.textContent = 'Path copied ✓'; })
            .catch(err => { if (statusEl) statusEl.textContent = 'Failed to copy path: ' + (err && err.message ? err.message : String(err)); });
    });
    zipHint.appendChild(pathEl);
    zipHint.appendChild(copyBtn);
    break;
}
```

> **Superseded:** `zipHint.innerHTML = '…' + escapeHtml(msg.zipPath) + '…'` followed by `document.getElementById('cp-copy-zip-path')?.addEventListener(…)`, copying `toAgentRef(msg.zipPath)`.
> **Reason:** three concrete problems. (a) `escapeHtml` is **not in scope** in this panel — `connections.html:554` loads only `connections.js`, and neither `PlanningPanelProvider`'s editor HTML build nor `getConnectionsHtml` (`src/services/headlessPanelHtml.ts:445-468`) injects `sharedUtils.js`. The original plan flagged this as "confirm"; it is now confirmed absent, so the `innerHTML` route would throw on the success path. (b) `toAgentRef` is an identity function (`src/webview/sharedUtils.js:7-10`, `return absPath`) and is likewise not in scope — wrapping the path in it adds a dependency and changes nothing. (c) `getElementById` immediately after an `innerHTML` assignment works, but building nodes directly removes the re-query and the escaping question together.
> **Replaced with:** DOM construction with `textContent`, and copying the raw `msg.zipPath`.

### 3. No change to `src/services/ContextBundler.ts`

The destination (`<workspaceRoot>/.switchboard/create-plans/`) is already deterministic and already single-zip. This plan discloses it; it does not move it.

## Verification Plan

*(Compilation and automated test execution are out of scope for this planning pass per session directive; the steps below are what the implementer runs.)*

**Automated**
1. `npm run verb-returns:check` — passes against the baseline updated in the same change.
2. New test `src/test/create-plans-zip-path-disclosure.test.js`:
   - stub `bundleDocsContext` to return a known `zipPath`; invoke the `createPlansDownloadZip` arm with a folder containing one `.md`; assert the **returned body** carries exactly that `zipPath` (not just `{success:true}`) **and** that a `createPlansZipReady` push is emitted with the same value;
   - assert both happen **even when** the `revealFileInOS` seam call rejects — the disclosure must not be conditional on the reveal;
   - assert a clearing push (`zipPath: ''`) is emitted at the start of the arm;
   - assert that when the zip build throws, the arm returns `{success:false, error}` and **no** non-empty `createPlansZipReady` is emitted.
3. Assert the three early-outs return `{success:false, error}` rather than a bare ack.

**Manual — VS Code editor panel**
4. Create Plans → pick a folder with a few `.md` files → Download zip. Finder opens at the zip **and** the pane shows the full path with a `Copy path` button.
5. Click `Copy path`, paste into a terminal, confirm the file exists at exactly that path and is the only `.zip` in `.switchboard/create-plans/`.
6. Run it again against a folder with **no** docs: the "no docs to bundle" notification appears and the previously-shown path is **cleared** — no stale path beside the new outcome.
7. Paste a very long path case: confirm the pane wraps and does not scroll horizontally.

**Manual — browser cockpit**
8. With the standalone host running, reach the Create Plans pane (the sibling folder-picker plan must have landed) and produce a zip. Confirm the path renders even though `revealFileInOS` is a stub there and no Finder window opens. This is the case that is completely unusable today.
9. Confirm `Copy path` works in the browser (localhost is a secure context, so the Clipboard API is available).
10. In devtools, confirm the POST response body for `createPlansDownloadZip` carries `zipPath` — the return-contract half, independent of the WS push.

**Regression guard**
11. Confirm `createPlansPasteBack` still creates plans from pasted markdown — the paste-back half of this feature must be untouched.

## Recommendation

Complexity 3 → **Send to Intern.**
