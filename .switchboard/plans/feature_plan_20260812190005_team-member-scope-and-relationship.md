# Team Members Gain A Scope And A Relationship

## Goal

Give a team member two properties it does not have today: whether it is **one set per team or shared across teams**, and **what relationship** it holds to its head. Both are what turn a list of spawned terminals into a team that means something.

### The problem

Two gaps, one in composition and one in wiring.

**Composition — every member is exclusive, so a shared service is inexpressible.** Reported from UAT: *"a researcher is not necessarily part of a similar team shape. You might want a grid of 8 planners all making plans, and just 1 research terminal serving all 8."*

Today a member is spawned per head, always. Eight planners would produce eight researchers, which is eight agent CLIs answering the same kind of question and seven of them idle. There is no way to say "one of these, shared".

**Wiring — every member gets the same hardcoded sentence.** `AGENT_GROUP_CALLBACK_INSTRUCTION` (`src/services/agentGroupInstantiation.ts:80-84`) is installed on every worker: *"it is your head agent. When you finish a task, report to it…"*. That is right for a coder. It is wrong for a researcher, which is not finishing tasks handed down but answering questions asked ad hoc, and wrong for a tester, and wrong for a second-opinion agent.

### Root cause

The vocabulary for "what one agent is to another" already exists and the team path does not use it. `LINK_PRESETS` (`src/webview/terminals.js:7922-7967`) ships five relationship templates, each a standing-order body phrased in the second person, plus a `custom` sentinel with an empty template:

| preset | template |
| :-- | :-- |
| `researcher` | *"{child} is your researcher… hand it questions… do not block on it"* |
| `reviewer` | *"{child} is your reviewer… hand it a summary when you finish a unit"* |
| `tester` | *"{child} is your tester… let it run the checks"* |
| `handoff` | *"hand over the full context… written to be picked up cold"* |
| `second-opinion` | *"put it to {child} before you commit"* |
| `custom` | *(empty — a sentinel that means "type your own", not a relationship)* |

Link-up installs one of these by hand for a chosen pair, in `standing` mode. A team installs a sixth body, hardcoded, for every member. Same mechanism, same store, two vocabularies — and the richer one is the one the operator has to drive manually every time.

## Metadata

**Complexity:** 7
**Tags:** backend, frontend, ux

## User Review Required

None.

## Complexity Audit

### Routine

- Adding two optional fields to a member definition is additive on a JSON blob; an install with neither must read as today's behaviour, which is a defaulting concern, not a migration.
- `resolvePreset` (`terminals.js:7983-7990`) already does template substitution for `{child}` / `{parent}`; the team path reuses it rather than inventing formatting.
- `mutateStandingOrders` already serialises the writes.

### Complex / Risky

- **`LINK_PRESETS` cannot simply be "moved to a shared module".** See the superseded callout in Design — `terminals.js` is a classic script with no module loading and no bundling step, so a direct cross-boundary import is not available today.
- **The `custom` preset has an empty template.** `resolvePreset` returns `''` for it. A member carrying `relationship: 'custom'` installs an empty standing order — a silent no-op that looks configured.
- **Direction is silent when wrong.** `reports-to-head` installs on the member about the head; every existing preset installs on the head about the member. A flipped order produces no error and no behaviour.
- **A shared member is unparented**, which puts it outside the delegate caps, outside `liveDelegateCount()`, outside head-owned teardown, and — critically — on the wrong side of the auto-start recursion guard.
- New fields land on `terminals.agentGroups`, which is shipped state on ~4,000 installs.

## Edge-Case & Dependency Audit

### Race Conditions

- **Two heads starting concurrently, both wanting the same shared member.** Both check "does a live instance exist", both see none, both spawn. The check-and-spawn must be serialised per (team definition, role) or the reported case produces two researchers under load — exactly the outcome the feature exists to prevent.
- Standing-order installs are serialised by `mutateStandingOrders`; concurrent heads cannot clobber each other's orders.

### Security

- No new wire surface. Relationship ids are resolved host-side against a fixed list; an unknown id must fall back to the default rather than being interpolated into a prompt.

### Side Effects

- A shared member is never auto-closed, so a long session accumulates orphan agent CLIs the operator must find and close by hand.
- `MAX_ORDERS = 20` and `MAX_BLOCK_CHARS = 4000` (shared across every order applying to one terminal, `standingOrders.ts:13-15`) both bite harder: a head with a researcher, a reviewer and three coders accumulates orders quickly, and block truncation is silent (`:70-72`).
- Richer relationship text lengthens the block; a long template crowds out a sibling order inside the same 4000-character budget.

### Dependencies & Conflicts

- **Depends on** *A Team Starts With Its Head Role*: `shared` scope changes what auto-start does on each head start (reuse a live instance rather than spawn), so it extends behaviour introduced there rather than existing alongside it.
- **Depends on** *The Spawn Primitive Must Wire The Team*: this plan changes *what* is installed; that plan establishes *where* installation happens. Both edit `spawnDelegates`' neighbourhood and the shared wiring function.
- **Blocks** *The Teams Tab And Four Shipped Team Types*: the tab renders `scope` and `relationship` per member and its editor writes them. Building the editor first means building it for fields that do not exist.
- **Blocks** *Seed A Starter Team, And Migrate*: the converter must write the final member shape including both fields.
- **Shares `terminals.js`** with two other subtasks (the standing-orders marker, the agent-CLI label cache). Different regions; they serialise under the one-stream-per-file rule.

## Dependencies

- `sess_20260812190003 — shared post-spawn team wiring` (must land first)
- `sess_20260812190004 — head-role auto-start` (must land first)
- `sess_20260812190005 — member scope and relationship`

## Adversarial Synthesis

Key risks: a "shared module" for `LINK_PRESETS` that the webview cannot actually load, leaving either a broken panel or a silent second copy nobody keeps in sync; a shared member spawned unparented that trips the auto-start recursion guard and starts a team of its own; and a check-then-spawn race producing the very duplicate researchers the feature exists to eliminate. Mitigations: follow the codebase's shipped cross-boundary pattern (TS source of truth + declared webview mirror + a contract test that fails when they diverge), give the shared-member spawn an explicit non-triggering signal rather than relying on parentage, and serialise the reuse check per (team, role). Direction and the empty `custom` template are the two silent failure modes and both need explicit handling rather than inference.

## Design

### Two new properties on a member definition

```
{ role, count, scope: 'per-team' | 'shared', relationship: '<preset id>' }
```

Defaults preserve today's behaviour exactly: `scope: 'per-team'`, `relationship: 'reports-to-head'` — the existing callback, promoted from a hardcoded string to a preset id. `label` and `startupCommand` remain on the shape and are preserved untouched (see the migration plan).

### `scope: 'shared'` — spawn once, wire to everyone

On each head start, for a shared member: if a live instance of that member already exists for this team definition, **reuse it**; otherwise spawn it. Either way install the standing order on the *head*, naming that instance.

Eight planners therefore produce one researcher and eight orders pointing at it. This is the case a per-team-only model cannot express, and it costs one field rather than a second concept.

**The reuse check must be serialised** per (team definition, role). Two heads starting together both read "no live instance" and both spawn otherwise — under exactly the load the feature was requested for.

**A shared member needs a stable, derivable name.** Per-team members are named `${head.friendlyName}-${role}${suffix}` (`ptyFleetService.ts:353`), which is meaningless for an instance owned by no head. Name a shared member from its **team definition** — e.g. `${teamName}-${role}` — so the reuse lookup has something to match on and two teams' researchers are distinguishable in the sidebar. Without a naming rule the reuse check has no key.

A shared member has **no parent**. It is not a delegate, so it counts against `MAX_LIVE_DELEGATE_PTYS` only if spawned as one — prefer spawning it unparented, which also keeps it clear of `MAX_DELEGATES_PER_PARENT` and out of any single head's ownership. Note the consequence: it is invisible to `liveDelegateCount()` (which counts terminals with a `parentInstanceId`, `ptyFleetService.ts:339`), so shared members are outside the fleet caps entirely. That is acceptable because their count is bounded by the number of team definitions, not by head starts — but it should be stated rather than discovered.

**An unparented spawn must not trigger its own team.** The auto-start recursion guard is *"a spawn triggers a team only when it has no `parentInstanceId`"*. A shared member is unparented by construction, so it passes that guard and would start a team of its own if its role heads one. The shared-member spawn must carry an explicit "this is a team member" signal that suppresses triggering, rather than relying on parentage. This is the single most likely way this plan breaks the plan before it.

**A shared member is never auto-closed.** Per-team members close with their head (already true — `kill()` recurses into `listChildren`, `ptyFleetService.ts:452-456`); a shared researcher belongs to nobody, and refcounting live agent CLIs to decide when to kill one is how you kill one mid-answer. It stays until closed by hand. State this in the UI rather than leaving it to be discovered.

### `relationship` — the preset vocabulary, shared by both paths

> **Superseded:** *"Move `LINK_PRESETS` out of `terminals.js` into a module both the webview and the team-spawn path import."*
> **Reason:** The webview cannot import a module. `terminals.js` is served as a classic script — `headlessPanelHtml.ts:400-408` injects `<script nonce="…" src="/static/webview/terminals.js"></script>`, and no webview HTML in the tree declares `type="module"`. Webview JS is not bundled either; only the extension is. So there is no import the webview side can perform, and the plan as written would either break the panel or quietly leave a second uncontrolled copy. The codebase already solved this exact problem once and its answer is visible three lines above `LINK_PRESETS` itself: `terminals.js:7973-7975` — *"Client mirror of the standing-orders resolver. Keep these in sync with `src/services/standingOrders.ts`."*
> **Replaced with:** Follow the shipped pattern. Put the canonical list in a TS module — `src/services/linkPresets.ts` — which the team-spawn path imports directly. Keep the webview's `LINK_PRESETS` literal where it is, re-declared as an explicit mirror with the same keep-in-sync comment convention, and add a contract test asserting the two lists have identical ids, labels, templates and directions. The comment is what the current mirror relies on; the test is what makes this one hold, and it costs one file.

Add the callback as a new entry:

```
{ id: 'reports-to-head', label: 'Reports to me — it works what I hand it',
  direction: 'member-receives', template: '<AGENT_GROUP_CALLBACK_INSTRUCTION verbatim>' }
```

The team spawn resolves a member's `relationship` to a template, substitutes the head and member names, and installs that as the standing order instead of the hardcoded constant. Link-up keeps writing one-off pairs by hand from the same list; a team writes them at every start. One vocabulary, two scopes.

**`custom` is not a relationship.** It is a UI sentinel with an empty template, and `resolvePreset` returns `''` for it (`terminals.js:7985-7986`). A member carrying `relationship: 'custom'` would install an empty standing order — configured-looking and inert. Exclude `custom` from the member relationship dropdown, and reject or default it host-side. An unknown relationship id must fall back to `reports-to-head`, never to an empty instruction.

### Templates are second-person and name the other terminal

Every existing preset is phrased as an instruction to the recipient about a named other terminal, because `applyStandingOrders` renders each order as `- Regarding terminal "<child>": <instruction>` (`standingOrders.ts:66-68`). A new template must read correctly after that prefix.

The relationship's *direction* also differs by preset: `reports-to-head` is installed **on the member** about the head, while `researcher`, `reviewer`, `tester`, `handoff` and `second-opinion` are all installed **on the head** about the member. Store the direction on the preset rather than inferring it — inferring it is how the orientation gets flipped, and a flipped order is silent.

## Implementation Notes

- `AGENT_GROUP_CALLBACK_INSTRUCTION` stays exported during the transition and becomes the body of the `reports-to-head` preset, so the shipped text is preserved byte-for-byte and existing installed orders continue to match.
- Orientation is the single most breakable thing here. `agentGroupInstantiation.ts:64-77` documents it: `parent` receives the block, `child` is what it is about. The Link-up modal is the working reference — it POSTs the order and then delivers the prompt to `parentName`.
- `MAX_ORDERS = 20` and `MAX_BLOCK_CHARS = 4000` both bite harder now. Keep templates short and fail with a specific error rather than truncating — the truncation at `standingOrders.ts:70-72` is silent and lands mid-sentence.
- Shared-member reuse must match on the *team definition plus role*, not on role alone, or two different teams both wanting a researcher would silently share one they never agreed to share.
- Member definitions live in `terminals.agentGroups`, which is shipped state. Read the two new fields defensively — an install with neither must behave exactly as today.
- `LINK_PRESETS[0]` is the default `linkPreset` for the Link-up modal (`terminals.js:1387-1388`, `:7970`). Do not reorder the array when adding the new entry, or every install's saved default silently changes meaning.

## Proposed Changes

### `src/services/linkPresets.ts` (new)

- **Context.** No canonical, backend-readable relationship vocabulary exists today.
- **Logic.** Export the preset list — `{ id, label, direction, template }` — plus a resolver mirroring `resolvePreset`'s substitution.
- **Implementation.** Include the five existing templates verbatim, the `custom` sentinel (marked as non-selectable for members), and `reports-to-head` carrying `AGENT_GROUP_CALLBACK_INSTRUCTION` byte-for-byte.
- **Edge Cases.** Unknown id → `reports-to-head`. Empty template → refuse to install rather than installing an empty order.

### `src/webview/terminals.js`

- **Context.** `LINK_PRESETS` at `:7922-7967`; `resolvePreset` at `:7983-7990`; default at `:1387-1388`.
- **Implementation.** Keep the literal in place; add the `direction` field and the `reports-to-head` entry so it matches the TS module exactly; add the keep-in-sync comment naming `src/services/linkPresets.ts`.
- **Edge Cases.** Append the new entry — do not reorder, or `LINK_PRESETS[0]` changes meaning for every saved default.

### `src/services/agentGroupInstantiation.ts` / the shared wiring function

- **Context.** `AGENT_GROUP_CALLBACK_INSTRUCTION` at `:80-84` is currently installed unconditionally per worker.
- **Implementation.** Resolve each member's `relationship` to a preset, apply the preset's `direction` to decide which terminal receives the order, substitute names, install.
- **Edge Cases.** Missing `relationship` → `reports-to-head` with byte-identical text. Direction must come from the preset, never from position in the call.

### `src/standalone/ptyFleetService.ts`

- **Context.** `spawnDelegates` at `:330-374`.
- **Logic.** A `shared` member resolves to an existing live instance or an unparented spawn.
- **Implementation.** Add the shared branch behind a serialised per-(team, role) check. Name shared instances from the team definition. Pass a non-triggering signal so auto-start does not fire for them.
- **Edge Cases.** Shared instances are outside both delegate caps and outside head teardown — both deliberate, both stated in the UI.

## Verification Plan

1. **The reported case.** A team headed on `planner` with `1 × researcher, shared`. Start eight planners: exactly one researcher exists, and all eight planners hold an order naming it.
2. **Per-team is unchanged.** A team headed on `lead` with `3 × coder, per-team`. Start two leads: six coders, three per lead, each parented to its own head.
3. **Reuse, not respawn.** With the researcher live, start a ninth planner — no second researcher, and the ninth planner gets an order naming the existing one.
4. **Concurrent reuse.** Start eight planners simultaneously (not sequentially). Still exactly one researcher — this is the race the sequential check passes and the real case fails.
5. **A shared member starts no team of its own.** Define a team headed on the shared member's role, then start a head that spawns it. The shared member must not trigger that team. Confirm by process count.
6. **Shared survives its users.** Close all eight planners; the researcher stays running.
7. **Per-team does not.** Close a lead; its three coders close.
8. **Relationship text is right.** Inspect the delivered prompt for a coder (`reports-to-head`) and for a planner with a researcher. Each reads correctly after the `Regarding terminal "<name>":` prefix and names the correct other terminal.
9. **Direction is right.** Confirm `reports-to-head` is installed on the member about the head, and `researcher` on the head about the member. Verify by reading `GET /terminals/standing-orders`, not by watching behaviour — a flipped order fails silently.
10. **`custom` cannot be selected, and cannot be honoured.** Confirm it is absent from the member relationship dropdown, and that a hand-edited `relationship: 'custom'` falls back to `reports-to-head` rather than installing an empty order.
11. **Defaults preserve today.** Load a group saved before this change: members behave as `per-team` + `reports-to-head`, with byte-identical order text.
12. **The mirror agrees.** Diff `LINK_PRESETS` in `terminals.js` against `src/services/linkPresets.ts` — ids, labels, templates and directions identical, order unchanged.
13. **Caps.** Drive a head to `MAX_ORDERS`; the error names the cap and no partial set is installed. Confirm a long template does not silently truncate a sibling order.
14. **Two teams do not accidentally share.** Two different definitions each wanting a shared researcher get their own, not one between them.
15. **Link-up still works.** Install a preset by hand from the modal; it appears and behaves as before, and coexists with team-installed orders on the same terminal.

### Automated Tests

Per the session directive, no compilation or automated-test run is part of this pass's verification; the checks above are manual. One test is nonetheless part of the deliverable rather than the verification: the `LINK_PRESETS` mirror contract test described in Design, which is the mechanism that keeps the two copies aligned after this change.

## Recommendation

Complexity 7 → **Send to Lead Coder**.

## Completion Summary

Created `src/services/linkPresets.ts` as the TS source of truth for the relationship-preset vocabulary — five existing templates plus `reports-to-head` (carrying `AGENT_GROUP_CALLBACK_INSTRUCTION` byte-for-byte) and the `custom` sentinel — each with a `direction` field (`member-receives` for `reports-to-head`, `head-receives` for all others), plus a `resolvePreset`/`resolvePresetMeta` pair that falls back to `reports-to-head` on unknown or `custom` ids. Updated the `LINK_PRESETS` mirror in `terminals.js` with matching `direction` fields, the `reports-to-head` entry appended (not reordered — `LINK_PRESETS[0]` is the saved default), and a keep-in-sync comment naming the TS module and contract test. Extended `DelegateDefinition` with optional `scope` and `relationship` fields, read defensively everywhere. Updated `wireSpawnedTeam` to accept `members` and resolve each child's `relationship` to a preset, applying the preset's `direction` to decide which terminal receives the order (`member-receives` → parent=member/child=head; `head-receives` → parent=head/child=member) — falling back to `reports-to-head` with byte-identical text when `members` is absent. Added the shared-scope reuse branch to `spawnDelegates`: a `scope: 'shared'` member is named `${teamName}-${role}`, reused if a live instance exists, or spawned unparented with `_isTeamMember: true`, with the check-and-spawn serialised per name through a `_sharedMemberChain` promise map; per-team members also carry `_isTeamMember: true`. The `_isTeamMember` flag is threaded through `create()` onto the `ExtendedTerminalHandle` and read by both hosts' auto-start triggers, so the recursion guard is `!payload.parentInstanceId && !payload._isTeamMember` — a shared member (unparented by construction) suppresses the trigger rather than relying on the fact that `spawnDelegates` calls `create()` directly without re-entering the verb path. Updated all callers (`bootstrap.ts`, `ptyHost.ts`, `TaskViewerProvider.ts`, `agentGroupInstantiation.ts`) to pass `teamName` and `members` through. Created `src/test/link-presets-mirror-contract.test.js` — 7 assertions verifying the TS and JS mirrors have identical ids, labels, templates and directions in the same order, and that the `reports-to-head` template matches `AGENT_GROUP_CALLBACK_INSTRUCTION` byte-for-byte. `npm run parity:check` passes green.

## Review Findings

MAJOR ×2, both fixed in `src/standalone/ptyFleetService.ts`: `_sharedMemberChain`'s `finally` deleted the map entry unconditionally, so a completing caller dropped a chain a later caller had already extended and the caller after that ran its check-and-spawn concurrently — precisely the duplicate-shared-member race verification step 4 exists to catch; and the shared branch had no `try/catch`, so a `create()` throw rejected `spawnDelegates` and failed `ptyCreateTerminal` after the head pty existed, the phantom-pane failure the caps comment forbids. The rest holds: `direction` is read from the preset and never inferred, `LINK_PRESETS[0]` is still `researcher` with `reports-to-head` appended, `custom` and unknown ids fall back to `reports-to-head` rather than installing an empty order, and shared members are correctly excluded from the per-head cap arithmetic. Confirmed orientation functionally end to end — `reports-to-head` installs parent=member/child=head, `reviewer` installs parent=head/child=member, and the no-`members` fallback is byte-identical to `AGENT_GROUP_CALLBACK_INSTRUCTION`. Also wired `link-presets-mirror-contract.test.js` into CI: it existed but had neither a `package.json` script nor a workflow step, so the mirror it was written to enforce was unguarded. Validation: typecheck clean, mirror contract 7/7, all nine static gates exit 0; files changed by this review are `src/standalone/ptyFleetService.ts`, `package.json` and `.github/workflows/integration-tests.yml`.
