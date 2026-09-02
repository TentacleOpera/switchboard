# A Verb Miss Reports Which Rail It Missed, Not That The Host Cannot Do It

## Goal

Stop the standalone host converting "this verb is not on this rail" into "this verb is not implemented in standalone mode". The first is true and actionable; the second is a claim about host capability the code cannot support, and it is frequently false.

### Problem Analysis & Root Cause

**The rewrite.** `src/standalone/bootstrap.ts:1704`:

```ts
} catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.startsWith('Unknown Kanban verb')) {
        return { success: false, error: `Verb '${verb}' not implemented in standalone mode` };
    }
    return { success: false, error: msg };
}
```

The provider throws `Unknown Kanban verb: '${verb}'` (`KanbanProvider.ts:9473`) — accurate, and scoped to what the provider actually knows: the verb is not in *its* switch. The bootstrap catches that and substitutes a statement about the whole host.

> **Superseded:** "The same pattern is at `bootstrap.ts:2645` for PTY verbs."
> **Reason:** The PTY path is NOT the same pattern and NOT at line 2645. It is at line **2655**, and it is a `switch default:` arm inside `handlePtyVerb`, not a catch-block rewrite of a thrown `Unknown Kanban verb`. The kanban path catches a throw and rewrites it; the PTY path directly returns the misleading message from a switch default. These are structurally different code paths requiring different fix approaches: the kanban fix modifies a catch-block branch; the PTY fix modifies a switch-default return.
> **Replaced with:** The PTY path is a `switch default:` at `bootstrap.ts:2654-2655` inside `handlePtyVerb` (defined at `:1723`), reached via `terminalVerb` (`:3293-3297`). It directly returns `{ success: false, error: \`PTY verb '${verb}' not implemented in standalone mode\` }` — no catch block, no thrown error being rewritten. The fix changes the return string in the default arm, not a catch-block branch.

**It is demonstrably false.** Observed 2026-09-01 against the live standalone server:

```
POST /kanban/verb/fetchKanbanPlans   → {"success":false,"error":"Verb 'fetchKanbanPlans' not implemented in standalone mode"}
POST /project/verb/fetchKanbanPlans  → 200, 2,555 plans
```

The verb is implemented, in standalone, and served by the same process — just on the project rail (`PlanningPanelProvider.ts:3785`). The routing is per-panel by design: `transport.js:26` builds `const routePrefix = panel === 'kanban' ? '/kanban/verb' : '/' + panel + '/verb'`. A verb addressed to the wrong prefix is a caller mistake, not a missing feature.

**Why this costs more than a vague message.** A generic error makes you look. A confidently wrong one makes you stop looking in the right place and start looking in the wrong one. In this instance it sent a debugging session hunting a standalone parity gap that does not exist — and standalone parity gaps are a real, recurring class in this codebase, which is exactly what makes the wrong message persuasive.

**Who sees it.** Standalone only — the rewrite lives in `bootstrap.ts`. In the extension the accurate `Unknown Kanban verb` surfaces. So the host with no editor to fall back on, driven over ssh and from the tailnet, gets the worse diagnostic.

**Related but not this.** `c71b9857` (*Surface Verb Failures in the Browser Transport*, CODE REVIEWED) makes failed verbs **visible** in the browser cockpit, where `transport.js` currently re-dispatches `{success:false, error}` as a typeless event no handler consumes. That fixes silence. This fixes accuracy. A verb failure that is now visible and still misattributed is not much better than one that was hidden, so the two compose.

**Out of scope: `ptyHost.ts:352`.** There is a separate PTY host file (`src/standalone/ptyHost.ts`) whose own `switch default:` at `:352` returns `Unknown terminal verb '${verb}'`. This message is **already accurate** — it names the terminal handler, not the whole host — and already matches the `VERB_NOT_HERE` regex via `unknown (terminal |pty )?verb`. It does not need changing. The contract test at `cli-board-commands-contract.test.js:131-135` asserts its text, and it should remain as-is.

## Metadata
**Topic:** Verb-miss errors name the rail, not a host capability
**Tags:** cli, bugfix
**Complexity:** 3

## User Review Required

None.

## Complexity Audit

### Routine
- Replacing a string literal in a catch-block branch (`bootstrap.ts:1706-1708`)
- Replacing a string literal in a switch-default return (`bootstrap.ts:2655`)
- Updating one contract test assertion to match new PTY message text (`cli-board-commands-contract.test.js:126-130`)

### Complex / Risky
- The `VERB_NOT_HERE` regex in `cli.ts:1441` gates the terminal→kanban retry. The new PTY message MUST still match it, or `switchboard verb moveCard` silently stops falling through to the kanban rail. This is the one way a message-text change causes a functional regression rather than a cosmetic one.

## Edge-Case & Dependency Audit

- **Race Conditions:** None. Both sites are synchronous returns in single-threaded Node.js request handlers.
- **Security:** None. The verb name is already user-supplied and already appears in error messages; the change does not introduce new information exposure.
- **Side Effects:** None. The change alters only the string content of failure responses. No control flow, no retry logic, no state mutation.
- **Dependencies & Conflicts:**
  - `cli.ts:1441` `VERB_NOT_HERE` regex — the new PTY message must match `/not implemented|unknown (terminal |pty )?verb|missing verb/i`. The proposed PTY message contains "Unknown terminal verb", which matches via `unknown (terminal |pty )?verb`. No regex change needed.
  - `cli-board-commands-contract.test.js:126-130` — asserts the exact PTY default-arm text. MUST be updated in lockstep with the message change.
  - `c71b9857` (Surface Verb Failures in the Browser Transport) — composes with this change but is not a hard dependency. This plan works independently; with `c71b9857` in, the new message is what the user sees in the toast.

## Dependencies

- None.

## Adversarial Synthesis

Key risks: (1) the `VERB_NOT_HERE` regex in `cli.ts:1441` gates the terminal→kanban retry — if the new PTY message drops the matching phrase, `switchboard verb moveCard` silently stops falling through; (2) the contract test at `cli-board-commands-contract.test.js:126-130` asserts the exact PTY message text and WILL fail if not updated in lockstep; (3) the plan originally conflated two structurally different code paths (catch-block rewrite vs switch-default), which could send an implementer hunting for a non-existent catch block in the PTY handler. Mitigations: the proposed PTY message retains "Unknown terminal verb" which matches the existing regex unchanged; the contract test is listed as an explicit step in the Proposed Changes; the structural difference is now documented with a Superseded callout.

## Proposed Changes

### `src/standalone/bootstrap.ts` — kanban catch-block (:1704-1710)

- **Context.** The `kanbanVerb` function's `default:` arm (line 1663) calls `kanbanProvider.handleServiceVerb(verb, ...)`. If the verb is not in `KANBAN_VERBS`, the provider throws `Unknown Kanban verb: '${verb}'` (`KanbanProvider.ts:9473`). The catch block at `:1704` matches that throw with `msg.startsWith('Unknown Kanban verb')` and rewrites it to the misleading host-capability claim.
- **Logic.** Replace the rewrite target. Instead of asserting the verb is "not implemented in standalone mode", state what is actually known: the verb was not found on the kanban rail, and point at the discovery surface. Keep the `if` branch so non-unknown-verb errors still pass through unchanged via the `return { success: false, error: msg }` fallback.
- **Implementation.** Change `:1706-1708` from:
  ```ts
  if (msg.startsWith('Unknown Kanban verb')) {
      return { success: false, error: `Verb '${verb}' not implemented in standalone mode` };
  }
  ```
  to:
  ```ts
  if (msg.startsWith('Unknown Kanban verb')) {
      return { success: false, error: `Unknown kanban verb '${verb}' — not found on the kanban rail. Check GET /catalog for the verb's home rail.` };
  }
  ```
- **Edge Cases.** A genuinely unknown verb (one on no rail at all) also hits this branch and gets the same message. The wording is true for both cases: the verb was not found on the kanban rail, regardless of whether it exists elsewhere. The server cannot distinguish "wrong rail" from "does not exist" and must not imply it can. The message says "not found on the kanban rail" — accurate in both cases — and points at `GET /catalog` so the caller can check for themselves.

### `src/standalone/bootstrap.ts` — PTY switch-default (:2654-2655)

- **Context.** `handlePtyVerb` (defined at `:1723`) is a `switch(verb)` with explicit cases for each PTY verb. The `default:` arm at `:2654` returns the misleading host-capability claim for any verb not in the switch. This is reached via `terminalVerb` (`:3293-3297`) which is the handler for `POST /terminals/verb/<verb>`.
- **Logic.** Replace the message text. Name the terminals rail explicitly and point at the catalog. The new message MUST contain a phrase that matches the `VERB_NOT_HERE` regex (`/not implemented|unknown (terminal |pty )?verb|missing verb/i`) so the CLI's terminal→kanban retry (`cli.ts:1442-1444`) continues to fire.
- **Implementation.** Change `:2655` from:
  ```ts
  return { success: false, error: `PTY verb '${verb}' not implemented in standalone mode` };
  ```
  to:
  ```ts
  return { success: false, error: `Unknown terminal verb '${verb}' — not found on the terminals rail. Check GET /catalog for the verb's home rail.` };
  ```
  The phrase "Unknown terminal verb" matches VERB_NOT_HERE via `unknown (terminal |pty )?verb`, so no regex change in `cli.ts` is needed.
- **Edge Cases.** Same as the kanban path: a verb that genuinely does not exist on any rail gets the same message, which is accurate — it was not found on the terminals rail. The caller can check `GET /catalog` to confirm.

### `src/test/cli-board-commands-contract.test.js` — PTY message assertion (:126-130)

- **Context.** This contract test statically asserts that `bootstrap.ts`'s terminal-verb default arm contains the exact text `PTY verb '${verb}' not implemented in standalone mode`. It exists to ensure the terminal rail answers with a recognizable refusal (not a 404) so the CLI's retry logic fires. Changing the PTY message text WILL break this assertion.
- **Logic.** Update the regex to match the new message text. The test's intent — "the terminal-verb default arm must still refuse with a clear message" — is preserved; only the matched text changes.
- **Implementation.** Change `:128` from:
  ```js
  /PTY verb '\$\{verb\}' not implemented in standalone mode/,
  ```
  to:
  ```js
  /Unknown terminal verb '\$\{verb\}' — not found on the terminals rail/,
  ```
  and update the assertion description at `:129` from `'standalone\'s terminal-verb default arm must still refuse with "not implemented".'` to `'standalone\'s terminal-verb default arm must still refuse with a rail-scoped message.'`.
- **Edge Cases.** The VERB_NOT_HERE regex assertion at `:136-141` does NOT need updating — the regex itself is unchanged, and the new PTY message still matches it via "unknown terminal verb".

### What NOT to change

- **`cli.ts:1441` `VERB_NOT_HERE` regex** — unchanged. The new PTY message matches the existing regex. No lockstep update needed.
- **`ptyHost.ts:352`** — already returns `Unknown terminal verb '${verb}'`, which is accurate and rail-scoped. Out of scope.
- **`bootstrap.ts:1709` fallback return** — `return { success: false, error: msg }` for non-unknown-verb errors. Already passes the real error through. Unchanged.
- **No cross-rail verb resolver.** Suggesting "did you mean /project/verb?" would need a registry of every verb on every rail, kept in sync with both providers — new machinery, and a new thing to drift. Naming the rail that was tried and pointing at the catalog is enough to un-stick someone; guessing on their behalf is the overreach.
- **No silent retry on the other rail.** `cmdVerb` already retries `/terminals/verb` → `/kanban/verb`, and its comment (`cli.ts:1430-1440`) explains carefully why the retry is narrowed to two non-executing refusals: a blind retry could run a side-effecting terminal verb twice. That reasoning holds here. This plan changes a message, not a control flow.

## Verification Plan

### Automated Tests

1. **Contract test update.** `cli-board-commands-contract.test.js` — the PTY message assertion at `:126-130` is updated to match the new text. Run `node src/test/cli-board-commands-contract.test.js` and confirm it passes. The VERB_NOT_HERE regex assertion at `:136-141` remains unchanged and still passes.
2. **Existing verb-engine tests.** `src/test/verb-engine-kanban-headless.test.js:189-193` and `src/test/headless-feature-management-contract.test.js:237-239` assert that `handleServiceVerb` throws `/Unknown Kanban verb/` for unknown verbs. These test the provider directly, not the bootstrap catch block, so they are unaffected by the message change. Confirm they still pass.

### Goal Invariants

- Assert the string `not implemented in standalone mode` is absent from `src/standalone/bootstrap.ts` (both the kanban catch-block at `:1707` and the PTY default arm at `:2655` have been replaced).
- Assert the kanban catch-block branch at `bootstrap.ts:1706-1708` returns an error string containing `kanban rail` when the caught message starts with `Unknown Kanban verb`.
- Assert the PTY default arm at `bootstrap.ts:2654-2655` returns an error string containing `terminals rail` and the phrase `Unknown terminal verb` (which matches the VERB_NOT_HERE regex).
- Assert the contract test at `cli-board-commands-contract.test.js:128` regex matches the new PTY default-arm text in `bootstrap.ts:2655`.

### Manual Checks

3. **The reported case.** `POST /kanban/verb/fetchKanbanPlans` returns an error naming the kanban rail and does **not** say "not implemented in standalone mode". `POST /project/verb/fetchKanbanPlans` still returns 200 with plans.
4. **A genuinely unknown verb** — one on no rail at all — also gets the rail-scoped message. The wording must be true for both cases, since the server cannot distinguish them and must not imply it can.
5. **The PTY path.** Same check against `bootstrap.ts:2655` via `POST /terminals/verb/<nonexistent>` — the response names the terminals rail and points at `GET /catalog`.
6. **Real errors are unchanged.** A verb that exists and throws returns its own message, not the unknown-verb wording — confirm the `msg.startsWith('Unknown Kanban verb')` branch has not widened.
7. **`cmdVerb`'s retry still fires.** The new PTY message contains "Unknown terminal verb" which matches VERB_NOT_HERE via `unknown (terminal |pty )?verb`. Verify `switchboard verb moveCard` still falls through from the terminal rail to the kanban rail.
8. **Extension unaffected** — the rewrite is standalone-only; confirm the editor host's error text did not move.
9. **Browser cockpit.** With `c71b9857` in, the new text is what a user actually sees in the toast. Read it as a user would and confirm it names a next action.
