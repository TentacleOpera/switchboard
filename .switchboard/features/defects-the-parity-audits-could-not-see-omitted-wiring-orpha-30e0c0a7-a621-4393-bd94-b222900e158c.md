# Defects the Parity Audits Could Not See — Omitted Wiring, Orphan Writes and Discarded Values

**Complexity:** 5

## Goal

Fix the four defects found by tracing call paths after the third standalone parity audit failed, and run the code-verification sweep that finds the rest of their class.

Three parity efforts have been declared complete and none answered the question, because each measured reachability — and in this codebase reachability is guaranteed independently of whether a feature works. The bootstrap kanbanVerb default arm delegates every unmatched verb to the provider, so every verb answers and every write lands whether or not the capability behind it exists. The first two audits passed on success:true; the third passed on catalog membership, with 178 of its 286 LIVE rows citing verb or endpoint presence.

Reading code found in hours what three audits of clicking and curling missed: an optional callback never passed, a write no reader consults, values computed and discarded, and a retired feature still documented. Three of the four are in shared code — the audits framed everything as standalone parity, so two of these have been broken in the extension the whole time and nobody was looking there.

## Provenance — where these came from

These are not new suspicions. Four are confirmed defects with traced call paths,
found during the review of `standalone-vs-extension-doc-parity-audit`
(`086b2dec`), whose register at `.switchboard/audits/standalone-extension-parity.md`
now records its own quality gate as **FAILED**. That register is not discarded:
its 387 enumerated doc claims and its corpus arithmetic (61 files / 3,555 lines,
independently confirmed against the tree) are the reusable half, and the sweep
subtask consumes them as its claim list while ignoring the verdict column.

Of the audit's eight reported gaps, one was withdrawn as a false positive of its
empty scratch workspace, one was already owned by
`standalone-kanban-column-parity-audit.md`, two were doc claims held back for
lack of admissible evidence, and the remaining four are the subtasks here — three
of them re-scoped, because the audit filed shared-code defects as standalone
parity gaps.

## How the Subtasks Achieve This

- **`POST /kanban/move` Is Dead in Standalone**: Wires the `moveCard` callback the
  standalone bootstrap never passes, so the documented move endpoint stops
  returning `{"error":"Kanban move not available"}`. The lasting deliverable is
  the endpoint-parity guard: `LocalApiServer` takes this callback as *optional*,
  so an omitted option is a valid construction that fails nothing at boot, at
  compile time or in any test — which is exactly how it went missing. The only
  genuinely standalone-specific subtask in the feature.
- **Hiding a Custom Kanban Column Does Nothing**: Makes both column readers honour
  the visibility key the toggle already writes. `_filterVisibleColumns` drops only
  built-ins and `_buildSetupKanbanStructure` hardcodes custom columns visible, so
  the write lands and both readers discard it. Both must change together — fixing
  one leaves the checkbox and the board disagreeing. Carries the feature's only
  migration concern: shipped `visibleAgents` state holds orphan keys from every
  user who ever tried this, and honouring the key makes them live.
- **Read Verbs Return a Bare Ack**: Returns read-verb values in the HTTP body, as
  `local-api-server.md:171` promises and ~19 verbs currently don't. Harmless to
  the webview, which subscribes to the push; breaking for the agent and external
  tooling the documented contract is written for. Adds the guard that stops the
  next copy-pasted getter from reintroducing it.
- **Three Published Doc Pages Still Document Plan Auto-Fetch**: Corrects the pages
  describing a service retired in `4d335c3c` and replaced by the `fetch-plans`
  Scheduler source. The point is not tidiness — `cloud-agents.md` is the page
  describing how off-machine plans reach the board, so documenting the retired
  implementation leaves the working replacement undocumented and unfindable.
- **Standalone Parity by Code Verification**: Sweeps for the remaining instances
  of the same five defect shapes, by reading code rather than driving a browser.
  Each shape is drawn from a confirmed instance above, so the instrument is
  calibrated against known-real defects rather than hypothesised ones. Records
  only traced paths with named break points — a finding that rests on something
  existing is not recorded.

<!-- BEGIN SUBTASKS (auto-generated, do not edit) -->
## Subtasks
- [ ] [`POST /kanban/move` Is Dead in Standalone — `moveCard` Is Never Passed to `LocalApiServer`](../plans/standalone-kanban-move-endpoint-not-wired.md) — **CREATED**
- [ ] [Hiding a Custom Kanban Column Does Nothing — the Toggle Writes State Both Readers Structurally Ignore](../plans/custom-column-visibility-toggle-writes-state-no-reader-consults.md) — **CREATED**
- [ ] [Read Verbs Return a Bare Ack and Ship Their Value Only on the Webview Push — the Opposite of the Documented Contract](../plans/read-verbs-return-bare-ack-violating-documented-http-contract.md) — **CREATED**
- [ ] [Three Published Doc Pages Still Document Plan Auto-Fetch, Retired and Replaced by the `fetch-plans` Scheduler Source](../plans/docs-still-document-retired-plan-autofetch.md) — **CREATED**
- [ ] [Standalone Parity by Code Verification — Sweep for Stubs, Omitted Wiring and Discarded Values](../plans/standalone-code-verification-sweep-stubs-and-omissions.md) — **CREATED**
<!-- END SUBTASKS -->

## Dependencies & sequencing

**No hard ordering constraints — the four fix subtasks touch disjoint code and
can run in parallel.** The doc subtask touches `switchboard-site` and shares no
files with the other four.

Two soft constraints worth honouring:

1. **The sweep overlaps the move subtask by design.** Both enumerate
   `LocalApiServer`'s optional options — the move plan does it to add its
   endpoint-parity guard, the sweep does it as its first defect shape. Running the
   sweep first, or concurrently with an explicit hand-off, avoids two people
   writing the same enumeration. If they run in either order without contact, the
   second one must extend the first's guard rather than add a parallel check.
2. **The sweep will likely find more instances of the orphan-write and
   discarded-value shapes.** Both fix subtasks are scoped to sweep past their
   enumerated lists for exactly this reason, so a late finding is an addition to
   an existing plan, not a new one. Prefer landing the sweep's findings into those
   two plans while they are open rather than opening siblings.

**Scope guard.** The sweep must not re-plan the four confirmed defects, and must
not open standalone parity plans for shared-code findings — mis-scoping is the
specific error this feature exists to correct. `standalone-kanban-column-parity-audit.md`
separately owns next-column resolution and is linked, never absorbed.

**Held, not blocked.** The audit's two remaining doc claims (`installation.md:46`
and `headless-switchboard.md:62` misdescribing standalone capability) are not
subtasks here. Their supporting evidence was verb presence, so the doc rewrite
they feed cannot be written from them yet — the sweep re-derives them by code
verification, and the rewrite becomes a follow-up once it does.
