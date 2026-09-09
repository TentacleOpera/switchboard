# A Plan Whose File Is Gone Answers 200 With an Empty Body

## Goal

`GET /kanban/plan?planId=<id>` must not report success for a plan it cannot read. Today a row whose
plan file is missing returns **HTTP 200** with a fully-populated record and `content: ""` — a
response an agent cannot tell apart from a plan whose file is genuinely empty, or from one it simply
has not been given.

### Problem analysis

**Reproduced on the Pi board, 2026-09-09.** Two rows, one healthy and one not:

```
GET /kanban/plan?planId=b9abce15-…   200   content: ""          <- file does not exist
GET /kanban/plan?planId=ed7aebbe-…   200   content: 4544 chars  <- file exists
```

Both answers are `200`. Both carry a complete record — `topic`, `status`, `kanban_column`,
`plan_file`. The only difference is an empty string in a field that is *also* legitimately empty for
an empty file. An agent asked to work `b9abce15` receives a success, reads nothing, and has no
signal that the plan it was told to implement is not there. The documented contract even states the
behaviour — *"returns one plan plus its file content at `.data.content`, or `''` when the plan file
is missing"* — which makes it deliberate, and wrong for the same reason the project's standing rule
says so:

> **A fallback must never be indistinguishable from a real value.** …a default that behaves exactly
> like a configured value turns a loud failure into a quiet wrong answer.

This is that rule applied to a read of plan content, which is the input an execution agent acts on.
`''` is the quiet value: it passes every type check, serialises fine, and reads as "nothing to do".

**The row is legitimate; the response is not.** `b9abce15` is not corruption. It is the pre-rename
path of a plan that became *Delete Auto-Start*
(`.switchboard/plans/teams-start-when-a-card-needs-them-not-at-boot.md`, `ed7aebbe`) — both rows
carry the same `created_at` to the millisecond, `2026-09-09T12:57:02.670Z`. The importer marked the
old path `status = 'missing'` via `markPlanMissingByPlanFile`
(`KanbanDatabase.ts:3575`), which is correct behaviour.

**Nothing else here is broken, and two things that look broken are not:**

- **The purge sweep works.** `runPurgeSweep` (`PlanIngestionEngine.ts:956`) is scheduled — called at
  `:522` on start and `:768` on the periodic pass — and deletes missing rows older than 24 hours.
  `b9abce15` went missing at `13:23Z` and is 8.3 hours old, so it is not eligible yet. There is no
  purge defect; the row ages out on its own.
- **`status` is already on the response.** The record says `"missing"`. A caller *could* discriminate
  — but only by knowing to check a field whose value it has no reason to distrust, on a request that
  returned 200. The server knows the file was unreadable and should say so itself.

#### Related, and deliberately not merged into this card

*Establish when the brain watcher and plan scanner arm in each host* (`1e5da4ea`, PLAN REVIEWED)
covers the standalone deferred-init gap — `_setupBrainWatcher` is reachable only from
`_runDeferredConstructorInit`, which is called from `resolveWebviewView` (a VS Code webview
lifecycle method standalone does not have) or from `reinitializePlanWatcher` on a workspace switch.
That is a separate defect on a separate path. This card is only about what the plan endpoint
returns.

## Metadata

**Complexity:** 3
**Tags:** api, plans, standalone, contracts

## User Review Required

None.

## Proposed Changes

### 1. Distinguish "no file" from "empty file" on the plan endpoint

- **Logic:** When the plan file cannot be read, the response must say so in a way a caller cannot
  miss. Either fail the request (a 404 or 409 naming the path), or keep the 200 and return
  `content: null` alongside an explicit `contentError` carrying the reason and the resolved path.
  Prefer failing: this is a read of the exact artefact the caller asked for, and the caller's next
  step is to act on content it does not have.
- **Implementation:** One place, the plan-read arm. Do not add the discrimination at each call site —
  that is the shape the fallback rule warns about, and it leaves the next caller uncovered.
- **Edge cases:** A genuinely empty plan file must still return `content: ""` with no error. The two
  cases are different and the response must be able to say which.

### 2. Never substitute a plausible value on this path

- **Logic:** No `catch { return '' }` and no default around the file read. Where the file cannot be
  read, surface the failure with its cause — permissions and not-found are different answers and the
  caller can act on the difference.
- **Rationale:** `catch { return {} }` on a config load is one of the shipped examples the standing
  rule cites. This is the same shape one directory over.

### 3. Both hosts

- **Logic:** The endpoint is served by the shared `LocalApiServer`, so one change covers both
  composition roots — but confirm by hand rather than by verb reachability, per the standing rule
  that `bootstrap.ts`'s `default:` arm makes every verb audit come back green.

## Verification Plan

### Automated Tests
- A row whose `plan_file` does not exist: the endpoint reports the failure and never returns
  `content: ""`.
- A row whose plan file exists but is zero bytes: `content: ""`, no error. The two cases are
  distinguishable from the response alone.
- A healthy plan is unchanged — same status, same body shape, content intact.
- An agent-shaped consumer given the missing-file response does not proceed as though it had a plan.

### Goal Invariants
- No response describes a plan the server could not read as a success.
- Empty-because-missing and empty-because-empty are never the same bytes on the wire.
- The plan-read path substitutes nothing on failure.

### Manual
- Rename a plan file out from under an active row, hit the endpoint, and confirm the response names
  the missing path rather than answering 200 with nothing in it.

## Outstanding Questions

- None.
