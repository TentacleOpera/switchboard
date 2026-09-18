# The board refuses a workspaceRoot it does not serve

## Goal

A request naming a `workspaceRoot` the board has never heard of is refused with
a 400 naming the root given and the roots served — instead of being answered,
byte-identically, from the host's own root. This closes the server-side hole
both halves of this feature route around: the CLI can be made to never *send* an
unowned root, but only the server can *refuse* one from any client.

## Why it does not work today

The CLI derives `workspaceRoot` from its own cwd and sends it on every request —
query param for reads, body field for writes (`cli.ts:508-511`). The board does
not verify that the root it was handed is one it actually serves. Measured
against the running board:

```
GET /kanban/columns?workspaceRoot=/home/patrick/switchboard  -> 200, 2062 bytes
GET /kanban/columns?workspaceRoot=/nonexistent/elsewhere     -> 200, 2062 bytes
                                                       byte-identical
```

A root the board has never heard of is answered from the host's own root, with
no warning and no way to tell after the fact which board answered — the fallback
rule in CLAUDE.md, on a routing read.

Remote seats are exactly where this stops being theoretical. It works in the
current setup only because the remote checkout happens to sit at the same
absolute path as the board's workspace. A worktree, an `/opt` install, or a
different user on the far side all produce a root the board silently discards
while every command keeps returning 200.

The verifier already exists and is half-wired: `_resolveKnownRoot`
(`LocalApiServer.ts:11002`) produces exactly the refusal this plan wants —
`workspaceRoot '<given>' is not a known workspace root. Known roots: [...]` —
but it is invoked only by the plan-create and import-plans write handlers
(`:11842`, `:12173`). The read funnel `_resolveDbFromQuery` (`:10825`) passes
the query param straight through, and the seat-facing write routes
(`/kanban/queue/next` `:4332`, `/kanban/queue/done` `:4392`,
`/kanban/task/complete`, `/kanban/dispatch`, the verb arms) accept
`body.workspaceRoot` unverified.

**Absent stays unchanged.** A request with NO `workspaceRoot` keeps today's
primary-root default — `queue/done` and friends document the field as optional.
The refusal applies only to a root that is present and unknown.

## Scope

`src/services/LocalApiServer.ts` only. This is shared server code: the check
lands once at `_resolveDbFromQuery` and the seat-facing write routes, and serves
both hosts while the extension lives. That is not divergence — it is shared
code, and no `extension.ts` composition-root seam is touched.

No client changes. The Node CLI's resolution belongs to *A tagged `ApiTarget`*
and its call sites to *Every Node command dials the resolved target*; the env
injection that makes this refusal safe belongs to *The host inlines seat identity
and the board URL into a remote spawn*.

## Metadata

**Complexity:** 4
**Tags:** api, infrastructure, feature
**Feature:** 30f625e0-feb9-4e96-aadb-af04610e3643

## User Review Required

- **This subtask converts silent wrong answers into loud 400s.** That is the
  point, and it is also the risk: any caller sending a legitimate but
  unregistered root starts failing where it previously succeeded. The known case
  is a worktree-cwd seat. It must not land before the env injection that fixes
  that case.

## Complexity Audit

### Routine

- `_resolveKnownRoot` already exists with the required refusal shape — wiring,
  not invention.
- The shared read-path catch (`:10338-10352`) already honors `err.statusCode`,
  so a typed thrown error propagates as its own status with no new plumbing.

### Complex / Risky

- **Root validation regression surface.** Any caller sending a legitimate but
  unregistered root — a worktree-cwd seat is the known case — starts getting
  400s where it got silent-correct 200s. Mitigated by the sibling subtask
  injecting `SWITCHBOARD_WORKSPACE_ROOT` into every seat's env; the seat-facing
  routes are the audit surface, not all ~80 body-readers.
- **Call-site audit, not just the funnel.** The typed error must reach the wire
  as a 400 from every `_resolveDbFromQuery` call site. A site that catches
  broadly and rewraps turns the refusal into a 500, which is a worse answer than
  the one being fixed — it tells the operator the board is broken rather than
  that their root is wrong.

## Edge-Case & Dependency Audit

- **POSIX dev+ino match** means a symlinked or differently-spelled root still
  resolves; a nonexistent given path falls to canonical path comparison and
  refuses.
- **The known-roots set** is `_options.workspaceRoot ∪ _allRoots ∪ mapping
  folders` — on standalone that is the launch root, so a seat carrying
  `SWITCHBOARD_WORKSPACE_ROOT` always matches.
- **Absent param is not a miss.** Absence keeps the documented optional-field
  contract and today's primary-root default. Only present-but-unknown refuses.
- **Ordering.** This must land after *The host inlines seat identity and the
  board URL into a remote spawn*. Landing it first gives worktree-cwd seats 400s
  with no env to fix them.

## Dependencies

- *The host inlines seat identity and the board URL into a remote spawn* —
  **must land first.** It injects `SWITCHBOARD_WORKSPACE_ROOT` into every seat's
  env, which is what makes this refusal safe rather than a regression.
- *A tagged `ApiTarget`* and *Every Node command dials the resolved target* —
  complementary, not blocking. They make the client never send an unowned root;
  this makes the server refuse one from any client. The two compose and neither
  blocks the other.

## Adversarial Synthesis

Key risk: this subtask's whole value is turning a quiet 200 into a loud 400, and
that same property is its failure mode if the env injection is not already
there. A seat whose cwd is a worktree sends its worktree path today and is
silently answered; under validation that same request 400s. Env-beats-cwd
uniformly is what makes the refusal safe, which is why the ordering constraint is
a hard dependency and not a preference.

Secondary risk: a broadly-catching call site rewrapping the typed 400 as a 500.
Mitigated by auditing every `_resolveDbFromQuery` call site explicitly and by a
test asserting the status code on the wire, not the thrown shape.

## Proposed Changes

### `src/services/LocalApiServer.ts`

- **Context.** `_resolveDbFromQuery` (`:10825`) passes `workspaceRoot` to
  `getKanbanDatabase` unverified (standalone's callback ignores it:
  `bootstrap.ts:4937`). `_resolveKnownRoot` (`:11002`) exists with the correct
  refusal. The shared read-path catch (`:10338-10352`) already honors
  `err.statusCode`, so a typed thrown error propagates as its own status.
- **Logic.** When a `workspaceRoot` param is PRESENT on a read, run
  `_resolveKnownRoot`; on a miss throw `{ statusCode: 400, code:
  'UNKNOWN_WORKSPACE_ROOT', message: <given + known roots> }`. On a hit, pass
  the resolved canonical root to `getKanbanDatabase`. Absent param: unchanged
  (primary root — the documented optional-field contract).
- **Implementation.** Add a shared `_requireKnownRoot(root|undefined)` helper
  returning the canonical root or throwing the typed error; call it in
  `_resolveDbFromQuery` and at the seat-facing write routes that read
  `body.workspaceRoot`: `/kanban/queue/next` (`:4332`), `/kanban/queue/done`
  (`:4392`), `/kanban/task/complete`, `/kanban/dispatch`, and the
  `/terminals/verb/*` + `/kanban/verb/*` arms. Audit the other
  `_resolveDbFromQuery` call sites (`:8619`, `:10430`, `:10612`, `:10752`,
  `:11743`) so the typed error reaches the wire as 400, not a caught-and-
  rewrapped 500.
- **Edge cases.** POSIX dev+ino match means a symlinked/spelled-differently
  root still resolves; a nonexistent given path falls to canonical path
  comparison and refuses. The known-roots set is `_options.workspaceRoot ∪
  _allRoots ∪ mapping folders` — on standalone that is the launch root; a seat
  carrying `SWITCHBOARD_WORKSPACE_ROOT` always matches.

## Verification Plan

### Automated Tests

Extend `src/test/workspace-root-write-path-contract.test.js` (or sibling):

- `GET /kanban/columns?workspaceRoot=<unknown>` → 400 naming given + known
  roots; `?workspaceRoot=<known>` → 200; absent → primary-root behaviour
  unchanged. The currently byte-identical pair must diverge.
- `POST /kanban/queue/done` with unknown `body.workspaceRoot` → 400; same for
  `queue/next` and `task/complete`.
- The typed error carries `statusCode: 400` through every
  `_resolveDbFromQuery` call site — no 500 rewraps.
- A symlinked spelling of a known root resolves 200 (dev+ino match), not 400.

`npm run compile-tests` before running any of these, per the build rule.

### Goal Invariants

- A request naming a `workspaceRoot` outside the known-roots set is refused
  non-2xx — negative; paired positive: the board's own root resolves 200 and
  the absent-param default still resolves the primary root.
- The refusal message names both the root given and the roots served — asserted
  on the message, not just the status.

### Manual Verification

- A request naming a `workspaceRoot` the board does not serve is refused,
  naming the root given and the roots served. Verified by the pair that is
  currently byte-identical: `/home/patrick/switchboard` succeeds,
  `/nonexistent/elsewhere` fails.
- A remote seat whose checkout is at a DIFFERENT absolute path from the board's
  workspace still works — `SWITCHBOARD_WORKSPACE_ROOT` is injected from the
  board's own root, so the path match in the current setup is no longer
  load-bearing, and the suite must not depend on it.
- With the board on machine A and the agent on machine B, `switchboard next`
  and `switchboard done` succeed from B with **no tunnel and no shared
  filesystem**, and the card clears on A.

## Recommendation

**Send to Coder.** Complexity 4: the verifier exists and the error plumbing
exists — this is wiring plus a call-site audit. The risk is entirely in ordering
and in a rewrapped status code, both of which a test pins.

## Implementation Summary

- Added `_requireKnownRoot(rawRoot?: string | null): string | undefined` to `src/services/LocalApiServer.ts` validating against `_resolveKnownRoot` and throwing `{ statusCode: 400, code: 'UNKNOWN_WORKSPACE_ROOT', message }` on miss while passing canonical root on hit and `undefined` when absent/empty.
- Updated `_resolveDbFromQuery` to validate `workspaceRoot` via `_requireKnownRoot` and pass canonical root to `getKanbanDatabase`.
- Audited and updated read / query callers including `_handleReadEndpoint` (which already honors `err.statusCode`), `_handleGetProtocol`, and `_handlePostDispatchWriteSets` to return 400 with `UNKNOWN_WORKSPACE_ROOT` when unknown root is supplied.
- Audited and updated seat-facing write handlers in `src/services/LocalApiServer.ts`:
  - `_handleKanbanQueueNext`
  - `_handleKanbanQueueDone`
  - `_handleKanbanTaskComplete`
  - `_handleKanbanDispatch`
  - `_handleTerminalVerb`
  - `_handleKanbanVerb`
  Each validates `body.workspaceRoot` via `_requireKnownRoot` and respects `err.statusCode` / `err.code` in its error catch block.
- Updated `src/test/workspace-root-write-path-contract.test.js` adding tests verifying `_requireKnownRoot` and `_resolveDbFromQuery` throw 400 `UNKNOWN_WORKSPACE_ROOT` on unknown roots and accept known roots / absent parameter.


## Review Findings

Reviewed `_requireKnownRoot` and every `_resolveDbFromQuery` call site in `src/services/LocalApiServer.ts`; the typed `{statusCode:400, code:'UNKNOWN_WORKSPACE_ROOT'}` error reaches the wire as a 400 from all of them — `_handleReadEndpoint` and `_requireReadableStore` already honour `err.statusCode`, and `_handleGetProtocol` and `_handlePostDispatchWriteSets` gained explicit status-preserving catches — with no 500 rewraps, and only `>=500` reaching `console.error` so an expected refusal does not spam the log. All six seat-facing write routes (`queue/next`, `queue/done`, `task/complete`, `dispatch`, `terminals/verb/*`, `kanban/verb/*`) validate `body.workspaceRoot`, absent stays the documented primary-root default, and an empty known-root set fails CLOSED with 503. The ordering dependency is satisfied in fact, not just on paper: `bootstrap.ts` hands `GoPtyFleetProjection` and `LocalApiServer` the same `workspaceRoot` binding, so the `SWITCHBOARD_WORKSPACE_ROOT` a remote seat carries is always a member of `_getKnownRoots()`. No code changes were needed. Verification: `test:contract:workspace-root-write-path` passed (and it is already invoked by CI at `.github/workflows/integration-tests.yml:132`), typecheck clean.

## Deferred Findings

- NIT `src/services/LocalApiServer.ts:8692` — the worktree-create handler's branch-name lookup calls `_resolveDbFromQuery` inside a bare `catch {}`, so an `UNKNOWN_WORKSPACE_ROOT` there is swallowed and the handler proceeds with the feature id as the branch name. Outside the surface this plan named, and the swallow is deliberate for that lookup, but it is the one call site where the refusal does not reach the caller.
- NIT `src/services/LocalApiServer.ts:11115` — `_requireKnownRoot` runs `_getKnownRoots()` plus two `statSync` calls per known root on every board read, including the common case where the supplied root is the host's own. A new per-request syscall cost on the hottest path on a Pi.
- NIT `src/services/LocalApiServer.ts:4868` — `_handleKanbanTaskComplete`'s `workspaceRoot` changed from `''` to `undefined` when both the body field and `_options.workspaceRoot` are empty; the very next line 400s on falsiness either way, so the behaviour is unchanged, but the type widened silently.
