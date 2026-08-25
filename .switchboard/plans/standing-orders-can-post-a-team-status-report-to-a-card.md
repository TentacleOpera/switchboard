# A team can be told to report, and a result can be written to a Linear card, but nothing connects the two

## Goal

Let the operator set a standing order that keeps a Linear card updated with a team's status, so
progress is readable from a phone without asking anyone. Team-scoped standing orders exist, team
reports already accumulate in an inbox, and writing a summary to a Linear issue is already
implemented — the three have never been wired together.

### Problem Analysis

**Team-scoped standing orders exist.** `StandingOrder` (`src/services/standingOrders.ts:5-24`)
carries `scope: 'global' | 'team' | 'pair' | 'team-head' | 'role'` plus a `teamId` and a `role`,
stored under `terminals.standingOrders`, and injected into a terminal's context as a
`=== STANDING ORDERS ===` block (`STANDING_ORDERS_MARKER`, `:41`). There is a definitions library
(`StandingOrderDefinition`, `:33`) so a reusable instruction can be written once and assigned
many times, with `definitionId` linking an assignment to its definition and the `instruction`
field kept as a denormalized copy. `GET`/`POST /terminals/standing-orders`
(`LocalApiServer.ts:4482`, `:5073`) read and write them.

**Team reports already have an inbox and an HTTP surface.** Reports land in
`.switchboard/teams/<teamId>/reports/` (`LocalApiServer.ts:5827`), are listed by
`GET /teams/<teamId>/reports` (`:7012`) and claimed by `POST /teams/<teamId>/reports/claim`
(`:7016`), which moves the file to `claimed/` so the claim is atomic. `docs/REMOTE_ACCESS.md`
documents this as the loop an external team lead runs, with the filesystem operations and their
HTTP equivalents given side by side.

**Writing a summary to a Linear card is already implemented.**
`LinearAutomationService.writeBackAutomationResult(issueId, summary, target)` (`:209`) posts
either a `commentCreate` mutation or an update into the issue description
(`DEFAULT_WRITEBACK_TARGET = 'description'`, `:11`).

**Nothing joins them.** A standing order can tell a team to write reports. The reports pile up in
the inbox. The write-back function will post a summary to a card if something calls it with an
issue id. No code path takes a team's report and puts it on a Linear card, and no configuration
expresses "team X reports to card Y".

**Which means status is only readable by someone with filesystem or HTTP access to the host** —
i.e. at the desk, or through a tunnel. The tracker is the one surface already reachable from a
phone with real auth and a real app, and it is the one place the reports never reach.

**Reports are also currently consumed destructively.** The claim moves the file to `claimed/`,
which is correct for a lead processing a work queue and wrong for a status mirror: if the mirror
claims a report, the lead never sees it, and if it does not claim, it must track what it has
already posted by some other means. That tension is the design decision this plan turns on.

### Root Cause

The report inbox was built for one consumer — a team lead, human or agent, working through a
queue — so *claiming* (destructive read) was the right primitive and the only one. Outbound
tracker sync grew separately, keyed to plans and issues rather than to teams, so it has no notion
of a team at all. Status mirroring is a third consumer pattern (non-destructive, idempotent,
latest-wins) that neither subsystem anticipated.

### Non-goals

- **Not a new reporting format.** Whatever agents write today is what gets mirrored. This plan
  moves text; it does not standardise it.
- **Not real-time.** The tracker poll is 30-120s and that is fine — status on a phone does not
  need to be live, and pretending otherwise would mean a second transport.
- **Not two-way.** Editing the card does not change the team. Comments already have a routing
  path; this is the outbound direction only.
- **Not a replacement for the lead's claim loop.** The documented external-lead flow keeps
  working unchanged.
- **No new auth, no new exposure.** Runs in the existing sync on the operator's host.

## Metadata

**Complexity:** 5
**Tags:** backend, feature, devops, reliability, docs

## User Review Required

Yes — three decisions.

1. **Where does the card binding live?** Options: a new field on the standing order; a
   `team → issueId` map in the Linear config; or a convention (the team's name matches a card).
   Recommendation: **the Linear config**, because the binding is tracker-specific and a standing
   order should stay transport-agnostic — a team's instruction to "report your status" is
   equally valid with no tracker configured, and putting an issue id on it couples the two.
2. **Non-destructive read, or a separate stream?** The claim moves a report to `claimed/`.
   Recommendation: **non-destructive read plus a posted-watermark**, so the mirror never competes
   with the lead's queue. The alternative — teams writing status to a second directory — is
   cleaner in isolation but means agents must know which kind of report they are writing, which
   is a prompt-compliance problem rather than a code one.
3. **Comment per report, or one description kept current?** Recommendation: **description,
   with `writeBackAutomationResult`'s existing `'description'` default.** A comment per report
   turns a card into a wall of noise within a day, and the question a phone asks is "where is
   this now", not "what happened at 14:02". Consider a comment only for terminal events —
   finished, blocked.

## Complexity Audit

### Routine

- A `team → issueId` binding in the Linear config, with UI in the Remote tab.
- Reading the report inbox without claiming.
- Calling `writeBackAutomationResult` with the accumulated summary.

### Complex / Risky

- **Not competing with the claim loop.** This is the crux. The mirror must read without claiming
  and track its own high-water mark, or a lead's queue silently empties into a Linear card. The
  watermark has to survive restarts, or every restart re-posts the whole history.
- **Prompt compliance is the real dependency.** A standing order is text appended to an agent's
  context. Agents comply imperfectly: they will report inconsistently, forget, or write prose
  where the mirror expects a status. The plan must degrade to "last thing the team said" rather
  than assume a schema, and the card must make "no report since X" visible rather than showing
  stale status as current.
- **The definitions library is the right home for the instruction, not an ad-hoc order.** A
  reusable `StandingOrderDefinition` for status reporting, assigned per team, means the wording
  is edited once — and `syncDefinitionToAssignments`/`reSyncAssignmentsToDefinitions` already
  keep the denormalized copies current. Writing a bespoke instruction per team is the version
  that rots.
- **Description rewriting is lossy and racy.** A description is a single field. If the operator
  edits it, or Linear's own automations touch it, a mirror that overwrites destroys that. Needs a
  delimited managed region, and the write must be read-modify-write rather than replace.
- **Report content is agent-authored text going to a tracker.** It may contain paths, diffs,
  secrets an agent happened to print, or markup. Posting it to Linear publishes it to everyone
  with project access. That is a wider audience than the host, and worth an explicit decision
  rather than a default.
- **Unbounded growth in two places.** Reports accumulate on disk under `.switchboard/`, which
  users have in their repos, and a description grows every cycle. Both need bounds.

## Edge-Case & Dependency Audit

**Race conditions**
- Mirror reading while an agent writes a report: a partially-written file must never be posted.
  The inbox's existing `mv`-into-`claimed/` discipline exists for exactly this reason on the
  claim side; the write side needs the same guarantee.
- Mirror and lead reading concurrently: with a non-destructive read this is safe, which is most
  of why it is recommended.
- Two Switchboard instances mirroring one team to one card. `LinearAutomationService.poll()`
  already forces `db.refreshFromDisk()` before dedupe because "outbound syncs from another
  instance are visible immediately" (`:300-303`); the watermark needs equivalent care or both
  instances post.
- Operator editing the description between read and write — the read-modify-write must not clobber.

**Security**
- **This publishes agent output to everyone with Linear project access.** The blast radius of a
  team accidentally printing a token into a report changes from "on my disk" to "in a tracker,
  indexed, in notification emails". Name this in the docs and consider a size cap and a redaction
  pass, or at minimum make it an opt-in per team rather than global.
- No new exposure of the host, no new auth path.
- Team ids and workspace scoping must be honoured so one workspace's team cannot be bound to
  another's card.

**Side effects**
- The Linear config gains a per-team binding; existing configs must load unchanged without it.
- The Remote tab gains a surface, which is where the phone-facing behaviour becomes discoverable.
- `docs/REMOTE_ACCESS.md`'s external-lead table should note that reports may also be mirrored, so
  a lead is not surprised to find their queue reflected on a card.

**Migration**
- **Standing orders and their definitions ship today** under `terminals.standingOrders` and
  `terminals.standingOrderDefinitions`. Any change to those shapes must preserve unknown keys and
  load older stored orders unchanged — the codebase's rule is that state which shipped gets
  migrated, and a no-op migration costs nothing. Prefer adding the binding to the Linear config
  precisely so these keys need no change at all.

## Dependencies

- **Should agree with** `automation-rules-can-target-a-column-but-not-a-team.md` on one mechanism
  for a team result reaching a Linear card. That plan needs a write-back when a team-addressed
  card is done; this plan needs one for periodic status. They should be the same code path.
- **Reuses** `writeBackAutomationResult`, the report inbox and its HTTP routes, and the standing
  orders definitions library.
- **Independent of** the phone command-route feature, though it serves the same operator need
  from the other direction — and if this lands first, part of that feature's read-only status
  surface is already covered by the tracker.

## Adversarial Synthesis

Key risks: (1) the mirror claiming reports and silently draining the lead's queue; (2) a
watermark that does not survive restart, re-posting history every launch; (3) assuming agents
comply with a report schema, so the card shows nothing or shows stale status as current; (4)
overwriting a description the operator or Linear edited; (5) publishing agent output — possibly
including secrets — to everyone with project access; (6) this plan and the routing plan shipping
two different card-write-back mechanisms. Mitigations: non-destructive read with a durable
watermark; a reusable standing-order definition rather than per-team wording, with explicit
"no report since X" rendering; a delimited managed region written read-modify-write; opt-in per
team with a size cap and an explicit note in the docs about audience; and a jointly-agreed
write-back path settled before either plan is coded.

## Proposed Changes

1. **A `team → issueId` binding** in the Linear config, surfaced in the Remote tab, opt-in per
   team.
2. **A reusable status-reporting `StandingOrderDefinition`**, assigned per team at
   `scope: 'team'`, so the instruction is edited once and propagates through the existing
   definition-sync path.
3. **A non-destructive inbox read** with a durable posted-watermark that survives restarts and is
   safe against a second instance.
4. **Mirror into a delimited managed region of the card description**, read-modify-write, using
   `writeBackAutomationResult`'s existing `'description'` target. Render "no report since <time>"
   rather than presenting stale status as current.
5. **Bounds**: a size cap on what is posted and a retention rule for the artifacts on disk.
6. **Docs**: state in `docs/REMOTE_ACCESS.md` and the remote skill that mirroring publishes agent
   output to everyone with project access, and note it beside the external-lead table.

### Migration

Additive. The binding lives in the Linear config, so `terminals.standingOrders` and
`terminals.standingOrderDefinitions` need no shape change and every stored order loads unchanged.
Existing Linear configs load with no binding and mirror nothing.

## Verification Plan

1. **The phone test.** Set a binding, let a team run, and read current status from the Linear
   mobile app without touching the host. This is the acceptance test.
2. **The lead's queue is untouched.** With mirroring active, run the documented external-lead loop
   (`GET /teams/<id>/reports`, `POST /reports/claim`) and assert every report is still there to be
   claimed. This is the regression that matters most.
3. **Restart does not re-post.** Restart the host mid-stream and assert the watermark holds — no
   duplicate history on the card.
4. **Partial writes are never posted.** Post continuously while an agent writes a large report and
   assert no truncated content reaches Linear.
5. **Operator edits survive.** Edit the description outside the managed region and assert the next
   mirror preserves the edit.
6. **Non-compliant agent.** Run a team that ignores the standing order and assert the card says
   "no report since X" rather than showing old status as current.
7. **Two instances.** Mirror the same team from two hosts and assert one coherent card, not
   interleaved duplicates.
8. **Bounds hold.** Generate many large reports; assert the size cap and the retention rule both
   actually bite.
9. **Opt-in is real.** With no binding configured, assert nothing is posted and no report is read.
10. **Existing config loads.** Load a Linear config and a standing-orders blob saved before this
    change; assert identical behaviour and no dropped keys.
11. **Definition sync.** Edit the status-reporting definition and assert every team assignment
    picks up the new wording through the existing sync path.
