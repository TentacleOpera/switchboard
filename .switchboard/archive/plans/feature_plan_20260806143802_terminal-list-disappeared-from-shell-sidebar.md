# Restore Disappeared Terminals List in Shell.html Sidebar

## Goal

The fleet terminals list in the shell.html left icon strip (`#strip-terminals` section) has disappeared. Terminal buttons that previously appeared between the bottom-placement icons and the theme toggle are no longer visible, even when PTY terminals exist and are active. The shell sidebar should show one button per fleet terminal with a status dot (active/done/exited), and clicking a button should pop out that terminal.

### Problem Analysis & Root Cause

**Symptom:** The `#strip-terminals` section in shell.html's left icon strip is empty or missing. The operator cannot see or click fleet terminal shortcuts in the shell rail, even though terminals exist and the Terminals panel itself shows them.

**Root Cause:** The fleet state push from terminals.js to shell.js is a one-directional `postMessage` flow with no fallback:

1. `terminals.js` calls `postFleetStateToShell()` after `fetchTerminalList()` succeeds (line 760).
2. `postFleetStateToShell()` posts `{type: 'terminalFleetState', terminals}` to `window.parent` (line 617-620).
3. `shell.js` receives the message and calls `renderTerminalSection(data.terminals)` (line 477).

The chain breaks if **any** step fails silently:

- **`fetchTerminalList` failure path does not call `postFleetStateToShell`.** When the `/terminals/verb/ptyListTerminals` fetch fails (network error, non-OK response, invalid payload), the function falls through to `checkSoloNotFound()` (line 779) without calling `postFleetStateToShell()`. The shell sidebar is never updated with the stale fleet list. The 5-second fleet poll retries, but if the failure is persistent (e.g., a transient server error during a heavy dispatch), the sidebar stays empty for the duration.

- **`renderTerminalSection` removes the container when `frames.has('terminals')` is false.** If the terminals panel is not in the manifest (e.g., `ptyReady` is false), the function removes the `#strip-terminals` container (line 284: `container.remove()`). This is correct behavior for a terminal-less host, but if `ptyReady` flips to false transiently (or the manifest is re-fetched with a stale `ptyReady` value), the container is removed and not recreated until the next `terminalFleetState` message — which never arrives because the terminals iframe doesn't exist.

- **No shell-side polling fallback.** The shell relies entirely on the terminals iframe to push fleet state. If the iframe is slow to load, crashes, or its `postFleetStateToShell` calls are lost, the shell sidebar stays in its initial empty state indefinitely. There is no mechanism for the shell to request fleet state from the terminals iframe.

**Most likely scenario:** The `fetchTerminalList` function failed on one or more poll cycles (transient server error, heavy dispatch, or a race with a server restart), and the failure path did not push the stale fleet state to the shell. The sidebar was cleared by a previous `renderTerminalSection([])` call (from `renderManifest` initialization) and never repopulated.

## Metadata

**Complexity:** 3
**Tags:** frontend, bugfix, reliability
**Project:** Browser Switchboard

## Complexity Audit (Routine vs Complex/Risky)

### Routine
- The `postFleetStateToShell` function (line 601) and `renderTerminalSection` function (shell.js line 274) are both small, self-contained functions with clear inputs and outputs.
- The fix is primarily about ensuring `postFleetStateToShell` is called on ALL `fetchTerminalList` exit paths, not just the success path.
- Adding a shell-side fallback (requesting fleet state from the terminals iframe) is a simple `postMessage` round-trip.

### Complex / Risky
- **Stale fleet list on failure:** Calling `postFleetStateToShell` on the failure path would push the stale `fleetList` (which might be empty if the first fetch failed). This is acceptable — showing stale terminals is better than showing none, and the next successful poll will correct it.
- **Container lifecycle:** The `renderTerminalSection` function removes the container when `frames.has('terminals')` is false. This is correct for a terminal-less host, but the function should be idempotent — calling it with terminals when the container was previously removed should recreate it. The current code already handles this (lines 296-308: creates the container if it doesn't exist).

## Edge-Case & Dependency Audit

**Race condition — `terminalFleetState` before `renderManifest`:** The shell's message listener (line 465) is set up before `loadManifest` runs. If a `terminalFleetState` message arrives before `renderManifest` creates the terminals frame, `frames.has('terminals')` would be false, and the container would be removed. This is unlikely (the terminals iframe hasn't loaded yet), but the fix should guard against it by deferring the message if frames aren't ready.

**Empty fleet list:** If `fleetList` is empty (no terminals), `postFleetStateToShell` sends an empty array. `renderTerminalSection` clears the container but doesn't remove it. The `:empty` CSS selector hides the border. This is correct — an empty fleet should show no buttons.

**Pop-out windows:** When a terminal is popped out into its own window, `postFleetStateToShell` in the pop-out returns early (`window.parent === window`). The shell sidebar is not updated from the pop-out. This is correct — the shell's terminals iframe (still mounted) handles fleet state updates.

## Proposed Changes

### File 1: `src/webview/terminals.js` — Push fleet state on ALL `fetchTerminalList` exit paths

**1a. Call `postFleetStateToShell()` in the failure/catch path of `fetchTerminalList`:**

Current (lines 765-779):
```js
        } catch (err) {
            console.warn('[Terminals] Failed to fetch terminal list:', err);
        }
        // Reached on a network error, a non-OK response, or an unusable payload. This
        // function deliberately swallows all three and leaves fleetList untouched, so
        // for solo mode the state is "not loaded yet" — NOT "terminal missing". Repaint
        // the transient state and let the next terminalsChanged refetch resolve it.
        checkSoloNotFound();
    }
```

New:
```js
        } catch (err) {
            console.warn('[Terminals] Failed to fetch terminal list:', err);
        }
        // Reached on a network error, a non-OK response, or an unusable payload. This
        // function deliberately swallows all three and leaves fleetList untouched, so
        // for solo mode the state is "not loaded yet" — NOT "terminal missing". Repaint
        // the transient state and let the next terminalsChanged refetch resolve it.
        // Push the stale fleet list to the shell so the sidebar doesn't go dark during
        // a transient fetch failure — the next successful poll will correct it.
        postFleetStateToShell();
        checkSoloNotFound();
    }
```

**1b. Also call `postFleetStateToShell()` when the response is OK but `data.terminals` is not an array (defensive):**

Current (lines 749-762):
```js
            if (res.ok) {
                const data = await res.json();
                if (data && Array.isArray(data.terminals)) {
                    hasFetchedList = true;
                    fleetList = data.terminals;
                    ...
                    postFleetStateToShell();
                    checkSoloNotFound();
                    return;
                }
            }
```

The `return` inside the `if (data && Array.isArray(data.terminals))` block means that a non-array `data.terminals` falls through to the failure path. With fix 1a above, `postFleetStateToShell()` will now be called in this case too. No additional change needed.

### File 2: `src/webview/shell.js` — Add a shell-side fleet state request fallback

**2a. Add a `requestFleetState` function that asks the terminals iframe to push its current fleet state:**

Add after the `renderTerminalSection` function (around line 402):

```js
    function requestFleetState() {
        const termFrame = frames.get('terminals');
        if (termFrame && termFrame.contentWindow) {
            try {
                termFrame.contentWindow.postMessage({ type: 'requestFleetState' }, location.origin);
            } catch { /* ignore */ }
        }
    }
```

**2b. Call `requestFleetState` after a short delay once the terminals frame loads:**

In `renderManifest`, after the `renderTerminalSection([])` call (line 441), add:

```js
        renderTerminalSection([]);

        // Ask the terminals iframe for its fleet state once it's loaded. The iframe's
        // own postFleetStateToShell runs on init and on a 5s poll, but a transient
        // fetch failure in the iframe can leave the rail dark. This request ensures
        // the shell gets fleet state even if the iframe's initial push was lost or
        // sent before the shell's message listener was ready.
        const termFrame = frames.get('terminals');
        if (termFrame) {
            termFrame.addEventListener('load', () => {
                setTimeout(requestFleetState, 500);
            });
        }
```

### File 3: `src/webview/terminals.js` — Handle `requestFleetState` messages

**3a. Add a handler for `requestFleetState` in the message listener (around line 534):**

Current:
```js
        window.addEventListener('message', (event) => {
            const message = event.data;
            if (!message) return;
            if (message.type === 'terminalsChanged') {
                fetchTerminalList();
            } else if (message.type === 'switchboardThemeChanged') {
```

New:
```js
        window.addEventListener('message', (event) => {
            const message = event.data;
            if (!message) return;
            if (message.type === 'terminalsChanged') {
                fetchTerminalList();
            } else if (message.type === 'requestFleetState') {
                // Shell-side fallback: the shell asked for our current fleet state.
                // Push it immediately (stale is better than dark) and trigger a fresh fetch.
                postFleetStateToShell();
                fetchTerminalList();
            } else if (message.type === 'switchboardThemeChanged') {
```

## Verification Plan

1. Open the browser cockpit (`/shell`).
2. **Verify:** The `#strip-terminals` section in the left icon strip shows one button per active fleet terminal, with a status dot (ring=active, green=done, grey=exited).
3. **Simulate a transient fetch failure:** In the browser DevTools, block the `/terminals/verb/ptyListTerminals` request once (Network tab → Block request URL → unblock after one failed cycle).
4. **Verify:** The shell sidebar retains the last known terminal buttons during the failed fetch cycle (does not go dark).
5. **Verify:** After unblocking, the next successful poll updates the sidebar with the current fleet state.
6. **Reload the shell page** and **verify:** The sidebar populates within ~1 second of the terminals iframe loading (the `requestFleetState` fallback triggers an immediate push).
7. **Close all terminals** and **verify:** The sidebar clears (empty `#strip-terminals`, no buttons) but the container remains in the DOM (border hidden by `:empty` selector).
8. **Open a new terminal** and **verify:** The sidebar shows the new terminal button within 5 seconds (next poll cycle).

## Review Findings

Reviewed `src/webview/terminals.js` and `src/webview/shell.js` against this plan. Two MAJOR findings fixed: the new `requestFleetState` arm accepted a `postMessage` from any origin while its two `postMessage`-driven neighbours (`focusTerminal`, `clearTerminalBadge`) guard `event.origin` — a guard was added, safe here because this arm never receives transport.js's synthetic origin-`''` dispatch; and the change shipped with zero automated coverage, so two contract assertions were added to `src/test/shell-terminal-strip.test.js` pinning the failure-path relay (both exit paths relay) and the shell↔iframe request round trip. Deferred NITs: the redundant `fetchTerminalList()` at load+500ms (`init()` already ran one on `DOMContentLoaded`), and the new relay sitting ahead of `checkSoloNotFound()` on the failure path (unreachable — the two are mutually exclusive). Plan accuracy note: Root Cause bullet 2 is not reachable in this code — `shell.js:525` is the only `frames.set` and there is no `frames.delete`, so `frames.has('terminals')` cannot flip transiently; bullets 1 and 3 are real and are what the fix addresses. Validation: `shell-terminal-strip` 34 passed / 0 failed, `terminal-solo-popout` 11/0, plus rename-rekey 8/0, sidebar-role-ordering 7/0, pane-grid-reconcile, input-path 19/0, flow-control 16/0, pty-route-surface all green; eslint clean, `tsc --noEmit` clean, and parity/push-routing/verb-returns/standalone-parity/mirror gates all pass. Both named automated checks are wired in CI (`.github/workflows/integration-tests.yml:382,422`).

## Completion Summary

Implemented the presence-recovery fix: `terminals.js` now calls `postFleetStateToShell()` on the `fetchTerminalList` failure/catch path (so a transient fetch error no longer leaves the rail dark) and handles a new `requestFleetState` message by pushing stale state immediately plus triggering a fresh fetch. `shell.js` adds a `requestFleetState()` function and wires it to fire 500ms after the terminals iframe's `load` event in `renderManifest`, giving the shell a side-channel to recover fleet state without waiting for the iframe's push. Files changed: `src/webview/terminals.js`, `src/webview/shell.js`. No issues encountered; `shell-terminal-strip.test.js` (25 passed) and `terminal-solo-popout-contract.test.js` (11 passed) stay green.

## Reviewer Pass

Direct in-place reviewer pass completed with advanced regression analysis (caller tracing, double-trigger, race, orphaned-reference and full-path audits). Valid MAJOR findings were fixed in `src/webview/shell.js`, `src/webview/terminals.js` and `src/test/shell-terminal-strip.test.js`; see `## Review Findings` above for the per-finding detail and deferred NITs. Verification was executed, not skipped: `shell-terminal-strip` 34 passed / 0 failed, `terminal-solo-popout` 11/0, six adjacent terminal contract suites green, eslint and `tsc --noEmit` clean, and all five project gates (parity, push-routing, verb-returns, standalone-parity, mirror) pass.
