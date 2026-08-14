# Researcher Relationship: Standing Orders, Return Path and Endpoint Retirement

**Complexity:** 4

## Goal

Make the researcher relationship work as a durable standing order with a closed loop, and delete the parallel HTTP mechanism that duplicates it. Today the Link-up modal's default preset-plus-mode pairing relays a parent-addressed instruction to the child, inverting every pronoun; a researcher that does receive a question has no instruction to save its findings or reply; and the /research/dispatch endpoint resolves researchers against VS Code-only terminal pools, reporting not-live for a live pty-fleet researcher. These three plans converge on one mechanism: a preset carrying a real instruction body IS a standing order, a round-trip relationship needs a member-side companion order, and once both exist the endpoint is redundant surface that can be deleted rather than repaired.

## How the Subtasks Achieve This

- **The Researcher Relationship Has No Return Path**: adds an optional `memberTemplate` to the preset shape and installs it on the researcher once at spawn, carrying the concrete `/terminals/relay` reply call and the `.switchboard/docs/` save instruction — the two halves nothing else in the system supplies. Installed under a self-key (`parent === child === the researcher`) so the shipped idempotency check delivers install-once for a shared researcher with no new plumbing. This is what makes "fold its answer in when it comes back" mean something.
- **Link-Up Role Presets Fire Through The Relay Path**: derives the Link-up modal's Mode from whether the selected preset carries a real instruction body, so role presets install as standing orders instead of being relayed verbatim to an audience they were not written for. Derived rather than stored as a second field, so the two encodings cannot drift.
- **Retire /research/dispatch And The Researcher Hand-Off Prompt Directive**: deletes the route, its handler, the callback, the VS Code-only resolution method and the injected `RESEARCHER HAND-OFF` prompt block, once the standing-order replacement carries the save instruction the endpoint used to append host-side.

<!-- BEGIN SUBTASKS (auto-generated, do not edit) -->
## Subtasks
- [ ] [Retire /research/dispatch And The Researcher Hand-Off Prompt Directive](../plans/feature_plan_20260812170000_research-dispatch-blind-to-pty-fleet.md) — **PLAN REVIEWED**
- [ ] [Link-Up Role Presets Fire Through The Relay Path, Inverting Who The Instruction Is Addressed To](../plans/feature_plan_20260812171500_link-up-presets-fire-through-relay-not-standing-orders.md) — **PLAN REVIEWED**
- [ ] [The Researcher Relationship Has No Return Path](../plans/feature_plan_20260813060000_researcher-relationship-has-no-return-path.md) — **PLAN REVIEWED**
<!-- END SUBTASKS -->

## Dependencies & sequencing

**✅ The external blocker has cleared.** All three subtasks were written against a pending teams prerequisite (`feature_plan_20260812190005_team-member-scope-and-relationship.md`). That work **landed in commit `1bd39f4a`** and was re-verified at HEAD on 2026-08-14: `src/services/linkPresets.ts` exists as the canonical preset list with `resolvePreset` / `resolvePresetMeta` / `DEFAULT_MEMBER_RELATIONSHIP`, every preset carries `direction`, `wireSpawnedTeam` (`teamWiring.ts:397-416`) branches on it, and `src/test/link-presets-mirror-contract.test.js` guards the `terminals.js` mirror. **This feature is unblocked and ready to execute.**

Hard chain within the feature: **return path → preset delivery → retirement.**

1. **The Researcher Relationship Has No Return Path** lands first. It relocates the save instruction and adds the return address that the retirement's replacement needs. It also owns the `LINK_PRESETS` literal in `terminals.js`, so it takes that file first.
2. **Link-Up Role Presets Fire Through The Relay Path** is independent of the retirement and can land any time after subtask 1 releases `terminals.js`. Its ordering constraint is file contention, not logic.
3. **Retire /research/dispatch** lands **last**. It names the return-path plan as a hard prerequisite — deleting the endpoint first leaves an interval in which nothing closes the research loop, because that endpoint is currently the only thing appending the save instruction.

**Reconciled design decisions** (verification changed two subtasks' mechanisms — implement to these, not to the pre-audit text):

- **"Is this a real relationship?" is answered by a non-empty `template`, never by the presence of `direction`.** `direction` is non-optional and `custom` carries a filler `'head-receives'` (`linkPresets.ts:116`, `terminals.js:8085`), so a direction-keyed test captures the one preset that must be exempt. `resolvePreset` / `resolvePresetMeta` already use the template test; both subtasks defer to it so there is one definition, not two.
- **The companion return-path order is self-keyed** (`parent === child === the researcher`), which reuses `wireSpawnedTeam`'s shipped `(parent, child)` idempotency check for install-once. The originally-planned "only if this spawn CREATED the member" guard is not implementable — none of the three `wireSpawnedTeam` call sites pass a created-vs-reused signal — and is unnecessary. It carries one consequence, owned by subtask 1: `rewriteStandingOrdersForRename` rewrites `parent` **or** `child`, never both, so the first self-keyed order in the system exposes a latent rename bug that would silently kill the return path.
- **The mirror contract test is a regex scraper, not a module import.** Adding `memberTemplate` is a **parser** change. Left unextended it does not go red — it fuses the new field into `template` and goes green while covering nothing. Subtask 1 owns that fix.
- **The retirement is wider than the endpoint.** The `RESEARCHER HAND-OFF` text is one arm of a two-variant directive whose shared closing sentence lives only in the tails, and the prompt-time `isResearcherConfigured` probe exists solely to choose between them. The variants collapse to one and the probe chain dies with them; a naive block-delete compiles and silently drops an instruction from every planner prompt.

**File contention:** the two webview-side subtasks share `src/webview/terminals.js` in **different regions** — subtask 1 edits only the `LINK_PRESETS` literal (`:8027-8086`); subtask 2 edits `loadLayoutSettings` (`:1416-1422`), the preset `change` handler (`:8520-8525`) and `buildLinkPrompt` (`:8370-8394`). They serialise under the project's one-stream-per-file rule but do not contend for the same lines. The retirement is disjoint from both: `LocalApiServer.ts`, `TaskViewerProvider.ts`, `KanbanProvider.ts`, `agentPromptBuilder.ts`.
