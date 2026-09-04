# Defects the Parity Audits Could Not See — Omitted Wiring, Orphan Writes and Discarded Values

<!-- board-collapse-membership -->
> **MEMBERSHIP CORRECTED 2026-09-04 (Board Collapse audit). The lead subtask no longer exists.**
> 
> *`POST /kanban/move` Is Dead in Standalone — and 13 More `LocalApiServer` Options* was **deleted**: commit `cf57044b` wired `moveCard`, `onPhoneAFriend`, `clearTerminalContext` and both team-pacing resolvers into the standalone root, and a live board now answers `POST /kanban/move` with 200.
> 
> Two consequences this file still gets wrong. **Shipping order step 1 names a card that does not exist**, and step 4 is sequenced "after (1)" — the sweep subtask is no longer blocked and can be scheduled on its own merits. And **Guard ownership assigns the option-supply parity assertion to "the move subtask"**, which is what this file calls the feature's lasting deliverable. That assertion is now owned by **`a-composition-root-parity-gate-that-actually-fails.md`** in the *Gates that mean something* feature. It has an owner; it is just not here.
> 
> Five subtasks remain, matching the database.


**Complexity:** 6

## Goal

Fix the four defects found by tracing call paths after the third standalone parity audit failed, and run the code-verification sweep that finds the rest of their class.

Three parity efforts have been declared complete and none answered the question, because each measured reachability — and in this codebase reachability is guaranteed independently of whether a feature works. The bootstrap kanbanVerb default arm delegates every unmatched verb to the provider, so every verb answers and every write lands whether or not the capability behind it exists. The first two audits passed on success:true; the third passed on catalog membership, with 178 of its 286 LIVE rows citing verb or endpoint presence.

Reading code found in hours what three audits of clicking and curling missed: an optional callback never passed, a write no reader consults, values computed and discarded, and a retired feature still documented. Three of the four are in shared code — the audits framed everything as standalone parity, so two of these have been broken in the extension the whole time and nobody was looking there.

**Planning each defect found it larger than first traced, and that is the feature's real finding.** The missing callback is one of **14** optional `LocalApiServer` options the extension supplies and standalone does not, out of 40. The ignored visibility write has **three** readers, not two, and is simultaneously mirrored into a machine-global file where the *terminal role picker* reads it — so a column id becomes a selectable agent role on every workspace on the machine. The discarded-value defect sits in a provider the return-contract ratchet scores at ceiling **0** — green, at floor, machine-"done" — while it hosts all eighteen violations. The doc drift covers **four** pages and a frontmatter description, not three. Every one of those enlargements came from the same instrument the sweep subtask formalises, applied to a defect that had already been "found".

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
  standalone bootstrap never passes, so the documented move endpoint stops failing
  closed. Bootstrap already wires six sibling `kanbanProvider` delegates in the
  same block, which both dates the omission as an oversight and hands the fix its
  template. The lasting deliverable is the option-supply parity assertion: `moveCard`
  is 1 of 14 options the extension supplies and standalone does not, and an omitted
  option is a valid construction that fails nothing at boot, at compile time or in
  any test — which is exactly how it went missing. The only genuinely
  standalone-specific subtask in the feature.
- **Hiding a Custom Kanban Column Does Nothing**: Makes the column readers honour
  the visibility key the toggle already writes, and stops the toggle writing a
  workspace-scoped column id into the machine-global *agent role* map. There are
  three readers — the board filter, the setup-structure builder, and the plan
  browser — and they encode two different definitions of "hidden", so they must be
  reconciled deliberately rather than made identical: the plan browser keeps showing
  a hidden column that still holds plans, on purpose. Carries the feature's only
  migration: shipped `visibleAgents` state on ~4,000 installs holds orphan keys in
  two stores, and honouring the key makes them live.
- **Read Verbs Return a Bare Ack**: Returns read-verb values in the HTTP body, as
  `local-api-server.md:171` and PRD contract #4 both require and 19 verbs currently
  don't. Harmless to the webview, which subscribes to the push; breaking for the
  agent and external tooling the documented contract is written for. Its durable
  half is a second dimension on the existing return-contract ratchet — the gate
  that today rates the worst-affected provider as perfectly migrated.
- **Four Published Doc Pages Still Document Plan Auto-Fetch**: Corrects the pages
  describing a service retired in `4d335c3c` and replaced by the `fetch-plans`
  Scheduler source. The point is not tidiness — `cloud-agents.md` is the page
  describing how off-machine plans reach the board, so documenting the retired
  implementation leaves the working replacement undocumented and unfindable. It
  also has to state what did *not* survive the swap: the retired settings included
  an author allow-list, and the replacement has no equivalent.
- **Five Shipped `planAutoFetch` Settings Were Removed Outright**: Re-declares the
  five retired settings as *deprecated* schema entries carrying a message that
  points at the Scheduler source. The retirement deleted them from
  `contributes.configuration` outright, and VS Code neither prunes an orphan key
  nor explains it — it shows "Unknown Configuration Setting" in the JSON editor and
  the Problems view, and nothing at all in the GUI editor. The repo already uses
  `deprecationMessage` three times for exactly this; `4d335c3c` bypassed its own
  pattern. The in-editor half of the same incomplete retirement the doc subtask
  fixes on the site.
- **Standalone Parity by Code Verification**: Sweeps for the remaining instances
  of the same defect shapes — now seven, after tracing the four confirmed defects
  to their ends added *cross-namespace write* and *vacuously-green gate*. Each shape
  is drawn from a confirmed instance, so the instrument is calibrated against
  known-real defects rather than hypothesised ones. Records only traced paths with
  named break points — a finding that rests on something existing, or on a CI check
  passing, is not recorded.

<!-- BEGIN SUBTASKS (auto-generated, do not edit) -->
## Subtasks
- [ ] [Hiding a Custom Kanban Column Does Nothing — Three Readers Ignore the Key, and the Write Leaks Into the Machine-Global Role Picker](../plans/custom-column-visibility-toggle-writes-state-no-reader-consults.md) — **PLAN REVIEWED** — ID: 585cfe79-d77a-43a3-a037-fdc3022fce08
- [ ] [Read Verbs Return a Bare Ack and Ship Their Value Only on the Webview Push — the Opposite of the Documented Contract](../plans/read-verbs-return-bare-ack-violating-documented-http-contract.md) — **PLAN REVIEWED** — ID: 27f87493-2cf8-4fae-992c-d1d521b4a776
- [ ] [Four Published Doc Pages Still Document Plan Auto-Fetch, Retired and Replaced by the `fetch-plans` Scheduler Source](../plans/docs-still-document-retired-plan-autofetch.md) — **PLAN REVIEWED** — ID: 375edd49-fcf9-40d4-a869-74b0696abc69
- [ ] [Standalone Parity by Code Verification — Sweep for Stubs, Omitted Wiring, Discarded Values and Gates That Pass Vacuously](../plans/standalone-code-verification-sweep-stubs-and-omissions.md) — **PLAN REVIEWED** — ID: fd9e39e7-366d-433a-9ea9-3365d569a4b4
- [ ] [Five Shipped `planAutoFetch` Settings Were Removed Outright, Leaving ~4,000 Installs With "Unknown Configuration Setting" Warnings and No Migration Path](../plans/planautofetch-settings-removed-without-deprecation-orphan-warnings.md) — **PLAN REVIEWED** — ID: 34c7a73f-d616-48e5-af0a-8ce944b4c098
<!-- END SUBTASKS -->

## Dependencies & sequencing

**The sweep runs last. This reverses the earlier guidance in this file**, which
suggested running it first to avoid duplicating the option enumeration. Planning
the fix subtasks made that obsolete: two of them now *build* the enumerations the
sweep would otherwise hand-derive, so running the sweep first means writing three
lists that are about to become machine-checked, then reconciling two versions of
the same surface.

**Shipping order**

1. **`POST /kanban/move`** and **Read Verbs Return a Bare Ack** — in either order,
   or in parallel. Each lands a fix plus the guard that makes its defect shape
   machine-checkable.
2. **Hiding a Custom Kanban Column** — independent of both, with one file caveat
   below.
3. **Four Published Doc Pages** and **Five Shipped `planAutoFetch` Settings** — the
   two halves of one incomplete retirement, independent of everything else and of
   each other. They land in different repositories, so they cannot share a commit;
   keep their copy consistent, since one is the site's account of where the
   capability went and the other is the in-editor account of the same thing.
4. **Standalone Parity by Code Verification** — after (1). It runs those two guards
   as three of its seven sweeps rather than repeating them by hand.

**Prerequisites and guards**

- **Guard ownership is assigned, and no subtask authors a new CI script.** The repo
  already has a nine-script check family with an established idiom (ratcheted,
  baselined, allowlisted, CI-wired). Three subtasks independently proposed "a new
  guard"; all three are routed into existing homes instead. Option-supply parity
  becomes a fourth assertion in `scripts/check-standalone-push-parity.js` — beside
  its existing broadcaster-installation assertion, which is the same "the
  composition root must supply X" shape — with exemptions in
  `scripts/standalone-parity-allowlist.json`, owned by the move subtask. Bare-ack
  detection becomes a second measured dimension in
  `scripts/check-verb-return-contract.js`, sharing
  `scripts/verb-return-contract-baseline.json`, owned by the read-verb subtask. A
  tenth script measuring an adjacent property of the same switch blocks is how two
  gates end up disagreeing about which arms exist.
- **Both new guards must be baselined from true current counts, not forced to zero.**
  That is the existing ratchet discipline: capture today's real number so CI is
  green from the first commit, then only ever lower it. Forcing either to zero on
  introduction reds CI on providers and options these subtasks are not converting.
- **The column-visibility and read-verb subtasks both edit `KanbanProvider.ts` and
  must serialise on it** — per the PRD's orchestration discipline (one agent stream
  per provider file). The regions are far apart (`cleanupKanbanColumnState` ~`:6339`
  versus `getFeatureWorktreeMode` ~`:11852`), so this is a merge-order constraint,
  not a design conflict. No other provider file is touched by more than one subtask.
- **The doc subtask lands in a different repository.** All four pages live in
  `switchboard-site`, a sibling repo. It cannot ride the same branch, commit or
  worktree as the other five, and its ship event is a site deploy, not an extension
  release. Plan it as its own change set. Its partner — the `planAutoFetch`
  deprecation subtask — is in *this* repo (`package.json`), so the two halves of that
  retirement ship on different cadences and neither blocks the other.

**Scope guard.** The sweep must not re-plan the four confirmed defects, and must
not open standalone parity plans for shared-code findings — mis-scoping is the
specific error this feature exists to correct. Residual findings of the
orphan-write, cross-namespace-write and discarded-value shapes go into the two fix
plans while they are open, not into new sibling cards; both are deliberately scoped
to sweep past their enumerated lists for exactly that reason.
`standalone-kanban-column-parity-audit.md` separately owns next-column resolution
and is linked, never absorbed.

**Held, not blocked.** The audit's two remaining doc claims (`installation.md:46`
and `headless-switchboard.md:62` misdescribing standalone capability) are not
subtasks here. Their supporting evidence was verb presence, so the doc rewrite they
feed cannot be written from them yet — the sweep re-derives them by code
verification, and the rewrite becomes a follow-up once it does.
