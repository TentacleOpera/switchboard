# Create Plans: disclose the docs-zip path instead of relying on a reveal that can silently fail

## Goal

Make the Create Plans "Download zip" flow tell the user **where the zip is**, in the panel, on every host — instead of depending entirely on an OS reveal whose failure is swallowed by two nested catches.

## Goal — problem analysis and root cause

### What this feature is

The Planning panel's **Create Plans** pane (wired in `src/webview/connections.js:380-412`) exists to get a workspace's documentation into an external AI surface and get plans back:

1. The user picks a source folder (`createPlansPickFolder`, `src/services/PlanningPanelProvider.ts:3060-3074`).
2. `createPlansDownloadZip` (`src/services/PlanningPanelProvider.ts:3075-3106`) recursively collects every `.md`/`.txt` in that folder, optionally adds the constitution, PRDs and README, prepends a `HOW-TO-PLAN.md` built from `CREATE_PLANS_CORE_PROMPT`, and writes a zip with a `MANIFEST.md`.
3. `bundleDocsContext` writes it to `<workspaceRoot>/.switchboard/create-plans/`, deleting any pre-existing `.zip` in that directory first (`src/services/ContextBundler.ts:34-41`).
4. The user uploads that zip to ChatGPT / Claude web, which reads the docs and returns plans.
5. The user pastes those plans back via `createPlansPasteBack` (`src/services/PlanningPanelProvider.ts:3107+`).

Step 4 is the whole point of the feature, and it requires the user to **find the file on disk** to drag into a browser upload dialog.

### The defect

The only thing that ever tells the user where the zip is, is a best-effort OS reveal:

```ts
// src/services/PlanningPanelProvider.ts:3099-3102
this._seams().ui.showTemporaryNotification(`Docs zip created (${fileCount} doc${fileCount === 1 ? '' : 's'})`);
try { await this._seams().commands.executeCommand('revealFileInOS', vscode.Uri.file(zipPath)); } catch { /* reveal is best-effort */ }
```

The notification discloses a **count, not a path**. So if the reveal does not happen, the user is told a file was created and given no way to find it.

And the reveal's failure is unobservable, because it is swallowed **twice**:

1. The local `catch { /* reveal is best-effort */ }` on line 3102.
2. `VscodeHostCommands.executeCommand` wraps every dispatch in a blanket `catch { return undefined; }` (`src/services/hostSeams.ts:327-336`), so the command cannot even throw out to that local catch.

On the standalone host it is worse than unobservable — it is guaranteed. `src/standalone/bootstrap.ts:783` registers `revealFileInOS` as `async () => undefined`, and the seam is registry-first (`src/services/hostSeams.ts:329-331`), so the registered stub is executed and returns cleanly. Note the second-order cost: without that registration the call would fall through to `vscodeShim.executeCommand`, which logs `[headless] command '<name>' is not bridged — the calling arm's side effect did not happen` (`src/standalone/vscodeShim.ts:244-250`). **The stub suppresses the one diagnostic that would have surfaced this.**

The fix is not to make the reveal work. The fix is to stop making path disclosure depend on a side effect that has no return channel: put the path in the panel, where it is visible, selectable and copyable regardless of host.

## Metadata

- **Complexity:** 2
- **Tags:** bugfix, frontend, backend, ux
- **Project:** Browser Switchboard

## Complexity Audit (Routine vs Complex/Risky)

**Routine.** One push message carrying a string, one webview element rendering it, one clipboard copy with direct precedent (`src/webview/project.js` does `navigator.clipboard.writeText(toAgentRef(path))` in six places; `connections.js` already uses `navigator.clipboard.writeText` at line 535).

**Nothing risky.** No new verb, no allow-list regeneration, no schema, no persisted state, no migration — `createPlansDownloadZip` already exists and already runs; this adds a response push where today there is none.

**One judgement call:** whether to keep the reveal at all. **Keep it**, as a genuine best-effort convenience *on top of* disclosure — in the editor host it lands the user directly in Finder, which is faster than copy-then-paste. It stops being load-bearing, which is the actual problem. This is the opposite call from the Tickets attachments Reveal button, and for a concrete reason: there, `Open` and a printed path already existed, so reveal was redundant; here, nothing else discloses the path at all.

## Edge-Case & Dependency Audit

| Case | Required behaviour |
| --- | --- |
| Reveal succeeds (editor host) | Finder opens **and** the path is shown in the pane. Both, not either. |
| Reveal is a stub (standalone host) | Path is shown in the pane. The user copies it. Feature remains usable. |
| Reveal throws | Already swallowed by the seam's blanket catch; disclosure is unaffected because it no longer depends on the reveal's outcome. |
| Zip build fails | Existing `catch` shows `Docs zip failed: …` via `showErrorMessage`. Do **not** show a path. Unchanged. |
| Folder has no docs | Existing early-out notification. No path shown. Unchanged. |
| A previous zip existed | `bundleDocsContext` deletes prior `.zip` files in the out dir first (`ContextBundler.ts:38-41`), so the displayed path is always the only zip present. No stale-path risk. |
| Path shown after a later failed run | The pane must clear the previous path when a new zip run starts, so a stale success path is never displayed next to a fresh error. |
| Very long path | Must wrap or scroll inside its container, never force the pane to scroll horizontally. |
| Clipboard rejects | Show a red error. Never a ✓ — a faked success is the exact bug class this plan exists to remove. |
| Browser cockpit | The push must go through the panel's normal broadcast path so it reaches the browser, not only the editor webview. |
| `showTemporaryNotification` on standalone | Also stubbed. This is *why* the panel-side disclosure is the fix rather than putting the path in the toast. |

**Dependencies:** none new.

**Explicitly out of scope**, flagged rather than silently fixed or ignored:
- `VscodeHostCommands.executeCommand`'s blanket `catch { return undefined; }` (`src/services/hostSeams.ts:333-335`) converts *every* failed command into a silent success for *every* caller in the codebase. That is the structural enabler of this bug class. Changing it has a very large blast radius and deserves its own plan.
- The Create Plans folder picker is stubbed on the standalone host, which blocks this flow there before the zip is ever built. Tracked separately — this plan makes the disclosure correct on both hosts so it is right once that is unblocked.

## Proposed Changes

### 1. `src/services/PlanningPanelProvider.ts` — push the path (replace lines 3099-3102)

```ts
const { zipPath, fileCount } = await bundleDocsContext(cpRoot, { sources, howToPlanMarkdown: howToPlan });
this._seams().ui.showTemporaryNotification(`Docs zip created (${fileCount} doc${fileCount === 1 ? '' : 's'})`);
// Disclose the path through the PANEL, not through the reveal. The reveal is a
// side effect with no return channel: its failure is swallowed by the seam's
// blanket catch (hostSeams.ts:333) and it is a no-op stub on the standalone host
// (bootstrap.ts:783), so a user whose reveal does not happen was previously told
// a file existed and never told where.
this.postMessageToWebview({ type: 'createPlansZipReady', zipPath, fileCount });
// Best-effort convenience ON TOP of disclosure — no longer load-bearing.
try { await this._seams().commands.executeCommand('revealFileInOS', vscode.Uri.file(zipPath)); } catch { /* reveal is best-effort */ }
```

Also push a clearing message at the start of the arm, so a stale path never sits beside a new error:

```ts
case 'createPlansDownloadZip': {
    this.postMessageToWebview({ type: 'createPlansZipReady', zipPath: '', fileCount: 0 });
    // …existing body…
```

### 2. `src/webview/connections.js` — render the path with a copy affordance

The pane already has a `cp-zip-hint` element (`src/webview/connections.js:383`). Render into it:

```js
case 'createPlansZipReady': {
    if (!zipHint) break;
    if (!msg.zipPath) { zipHint.innerHTML = ''; break; }   // cleared at run start
    zipHint.innerHTML =
        '<div class="cp-zip-path" style="font-size:11px; word-break:break-all;">'
        + escapeHtml(msg.zipPath) +
        '</div><button type="button" id="cp-copy-zip-path" class="strip-btn" style="font-size:11px; padding:2px 6px;">Copy path</button>';
    document.getElementById('cp-copy-zip-path')?.addEventListener('click', () => {
        // Synchronous inside the click — the Clipboard API needs transient user activation.
        navigator.clipboard.writeText(toAgentRef(msg.zipPath))
            .then(() => { if (statusEl) statusEl.textContent = 'Path copied ✓'; })
            .catch(err => { if (statusEl) statusEl.textContent = 'Failed to copy path: ' + (err && err.message ? err.message : String(err)); });
    });
    break;
}
```

Confirm `escapeHtml` / `toAgentRef` are in scope in this webview (both are `sharedUtils.js` globals); import or inline if the Connections panel does not load it.

### 3. No change to `src/services/ContextBundler.ts`

The destination (`<workspaceRoot>/.switchboard/create-plans/`) is already deterministic and already single-zip. This plan discloses it; it does not move it.

## Verification Plan

**Automated**
1. `npx tsc --noEmit -p tsconfig.json` — clean.
2. `npm test` — no regressions. Five tests are already red at HEAD; stash-verify before attributing a failure here.
3. New test `src/test/create-plans-zip-path-disclosure.test.js`:
   - stub `bundleDocsContext` to return a known `zipPath`; invoke the `createPlansDownloadZip` arm with a folder containing one `.md`; assert a `createPlansZipReady` push is emitted carrying **exactly** that `zipPath`;
   - assert the push happens **even when** the `revealFileInOS` seam call rejects — the disclosure must not be conditional on the reveal;
   - assert a clearing push (`zipPath: ''`) is emitted at the start of the arm;
   - assert that when the zip build throws, an error is surfaced and **no** non-empty `createPlansZipReady` is emitted.

**Manual — VS Code editor panel**
4. Create Plans → pick a folder with a few `.md` files → Download zip. Finder opens at the zip **and** the pane shows the full path with a `Copy path` button.
5. Click `Copy path`, paste into a terminal, confirm the file exists at exactly that path and is the only `.zip` in `.switchboard/create-plans/`.
6. Run it again against a folder with **no** docs: the "no docs to bundle" notification appears and the previously-shown path is **cleared** — no stale path beside the new outcome.

**Manual — browser cockpit**
7. With the standalone host running, reach the Create Plans pane. Confirm the `createPlansZipReady` push arrives over WS (devtools → WS frames) and the path renders, even though `revealFileInOS` is a stub there and no Finder window opens. This is the case that is completely unusable today.
   *(If the pane cannot be reached because the folder picker is stubbed on this host, that is the separately-tracked blocker — verify this step by invoking the `createPlansDownloadZip` verb directly against the API with a known folder.)*
8. Confirm `Copy path` works in the browser (localhost is a secure context, so the Clipboard API is available).

**Regression guard**
9. Confirm `createPlansPasteBack` still creates plans from pasted markdown — the paste-back half of this feature must be untouched.
