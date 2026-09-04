# Every Lead-to-Coder Post Re-Orients the Whole Team, Because `created` Means "the Roster"

kanbanColumn: CREATED

## Goal

A startup orientation reaches a seat that was just started. Not a seat that has been running for hours, and not every other seat on its team.

### Problem analysis

**Observed 2026-09-04, inside a feature implementation.** Seats had been running for hours. The lead reviewed a coder's work and posted to it. The coder then received:

> *"Startup orientation — your standing orders follow. Acknowledge them in one line and wait; do not begin any work until you are given a task."*

A seat mid-feature was told to acknowledge and wait for a task it already had.

**The chain, from the seat's log and the source:**

1. The lead posts to the coder — the `sendToTerminal` verb.
2. `sendToTerminal` calls `instantiateAgentGroupCore` (`bootstrap.ts:3286-3306`), a create-or-attach for the team.
3. That function builds its return at `agentGroupInstantiation.ts:147`:

```js
const created: string[] = [headName, ...workers.map((w: any) => w.friendlyName)];
```

**The whole roster, unconditionally** — head plus every worker — with no test for whether anything was actually created. It is never filtered afterwards; it is returned as-is at `:166` and `:176`.

4. `bootstrap.ts:3306` then does:

```js
if (result.success && Array.isArray(result.created)) {
    relayStartupOrientation(result.created);
}
```

So **every lead-to-coder post arms a startup orientation for every seat on the team.**

**The field name is the defect.** `created` reads as "seats this call created" and is consumed on that assumption. It means "the roster". Every caller that treats it as a creation list is wrong, and this one relays a startup preamble to seats that started hours ago.

**Timing, measured:**

```
21:47:04.787   completion POST recorded, coder-1 cleared
21:47:04.859   coder-1 log session rolls           (+72ms)
21:47:05.003   startup orientation delivered       (+216ms)
```

The orientation landed while the CLI was still processing its clear — the log shows Devin's `/clear` picker open (`○ /clear  Clear conversation history`) with the paste arriving as literal `^[[200~`, because a menu cannot consume bracketed paste. Devin then completed the clear and restarted, discarding it.

**This is not the after-clear delivery.** That path exists and is correct: `TaskViewerProvider.ts:2505-2515` wraps the orders in an explicitly non-actionable envelope — *"This delivery restores your standing orders after a context clear. No action is required. Wait for your next dispatch."* The text in the log is `ORIENTATION_PREAMBLE`, which only `relayStartupOrientation` sends. The envelope built for exactly this situation is not what fired.

## Metadata

- **Complexity:** 3
- **Tags:** teams, prompts, both-hosts, bugfix

## User Review Required

None.

## Proposed Changes

### 1. `created` must list what was created

Return only the seats the call actually created. A caller asking "what did you just start" must not receive the roster.

This is the fix. Everything else follows from it.

### 2. Audit every consumer of `created`

The field is returned from a shared function used by both hosts. Any other caller treating it as a creation list has the same defect with a different symptom; find them before changing the semantics, so nothing depends on the roster behaviour.

If some caller genuinely wants the roster, give it a separate, correctly named field rather than overloading this one.

### 3. Orientation is for a started seat, and only that

Even with `created` corrected, state the rule at the relay: it fires for a seat that has just started and has no task. A seat mid-feature never receives it, whatever a caller passes.

`1e2afcd8` covers the other half — the relay firing into a seat that is already working. Same relay, and the two fixes should agree.

## Edge-Case & Dependency Audit

1. **A genuine create must still orient.** Narrowing `created` must not stop a newly spawned seat receiving its orientation — that is what the relay is for.
2. **A create-or-attach that creates some and attaches others** must return only the created ones. This is the case that produced the bug and the one to test.
3. **Both hosts.** `instantiateAgentGroupCore` is shared; `bootstrap.ts:3306` and the extension's `ptyCreateTerminal` / `ptyCreateBatch` sites all consume the result.
4. **Do not fix this at the relay by comparing timestamps.** Suppressing an orientation for an old seat papers over a return value that lies; the next consumer of `created` inherits it.
5. **The after-clear envelope is correct and should be left alone** — it already says no action is required. The problem is that it was not the delivery that fired.

## Verification Plan

1. A lead posting to a coder produces no orientation for any seat.
2. A newly created seat still receives its orientation.
3. A create-or-attach that creates one seat and attaches three returns one name in `created`.
4. No consumer of `created` treats it as the roster.
5. A seat running for hours never receives a startup orientation.
6. Both hosts behave identically.
