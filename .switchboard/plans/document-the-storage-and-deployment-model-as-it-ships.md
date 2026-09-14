# Document the storage topology, deployment modes and remote loop — clause by clause, as each one ships

<!-- board-collapse-01 -->
> **RESCOPED 2026-09-04 (Board Collapse 01).** Two corrections. (1) Item 3 documents "the two axes and four combinations"; the mode matrix was settled at **three** on 2026-09-01 — board-local with agents-remote was refused. (2) Delete the mechanism that adds a documentation trigger line to six other storage plans. Documentation follows shipped behaviour; this plan shrinks to the two facts true today, the `agy` controller seat and the notification loop, plus the deployment vocabulary.


## Goal

Give the storage and remote work a documentation home, and a rule for when each part gets written: **when it ships, not when it is planned.** Extend `docs/REMOTE_ACCESS.md` rather than starting a new file, and record the two things that are true *today* and undocumented — the `agy`-as-controller pattern and the Linear notification loop — immediately, since neither waits on any code.

### Problem Analysis

**A large design surface has accumulated with no user-facing account of it.** The storage programme moves the database out of the repository into a home store, splits it by ownership and temperature, and makes the store a choosable target. The remote work adds deployment modes, a pairing story and remote authoring. Every one of those changes something a user or an agent can observe, and none of it is written down outside plan files.

**Two of those things need no code and are undocumented today:**

1. **`agy` as the controller seat.** `terminalUtils.ts:244` includes `agy` in the CLI-agent detection regex (`/\b(copilot|gemini|agy|claude|windsurf|cursor|cortex)\b/i`) alongside `copilot`, `gemini`, `claude`, `windsurf`, `cursor` and `cortex`, and `terminals.js:3513` maps it to the Antigravity brand icon (`agy: 'antigravity'` in `CLI_BRAND_ICON_KEYS`). So the orchestrator seat can already run the Antigravity CLI. That matters because Antigravity shipped Remote Control (announced 21 Aug 2026): browser access to an Antigravity session on any of your machines. Run the controller on `agy` and the Switchboard cockpit becomes reachable from a browser through the host vendor's own feature — while the fleet it dispatches to can be any other CLI and any other subscription. Nothing to build; it is a configuration nobody would guess.

   > **Superseded:** `terminalUtils.ts:213` includes `agy` in the CLI-agent detection regex alongside `claude`, `gemini`, `cursor` and `windsurf`, and `terminals.js` maps it to the Antigravity brand icon.
   > **Reason:** The line citation drifted — the regex is at `terminalUtils.ts:244`, not `:213`. The regex also includes `copilot` and `cortex`, which the original description omitted. A documentation plan that cites the wrong line and omits two CLIs from the regex it documents will produce a doc that is wrong on both counts.
   > **Replaced with:** `terminalUtils.ts:244` includes `agy` in the CLI-agent detection regex (`/\b(copilot|gemini|agy|claude|windsurf|cursor|cortex)\b/i`) alongside `copilot`, `gemini`, `claude`, `windsurf`, `cursor` and `cortex`, and `terminals.js:3513` maps it to the Antigravity brand icon (`agy: 'antigravity'` in `CLI_BRAND_ICON_KEYS`).

2. **Phone notifications already work through Linear.** Agents post completion comments via `postManagedComment` (`LinearSyncService.ts:1559`, `NotionRemoteProvider.ts:246`) to the Linear or Notion card, and Linear's own app pushes those to a phone. So the notification loop is: agent completes → managed comment → Linear push. Switchboard does not need a notification system; it needs users to know this composition exists.

**The documentation directory cannot absorb more without a line drawn.** `docs/` holds ~38 entries (as of 2026-09-14) mixing published material (`REMOTE_ACCESS.md`, `TECHNICAL_DOC.md`, `headless-switchboard.md`) with working artifacts — four `imported_document_2026_*.md`, research dumps, investigation logs, an epic-clobber reading plan, screenshots. Adding six new files to that pile makes them unfindable rather than published.

   > **Superseded:** `docs/` holds 36 entries mixing published material (`REMOTE_ACCESS.md`, `TECHNICAL_DOC.md`, `headless-switchboard.md`) with working artifacts — four `imported_document_2026_*.md`, research dumps, investigation logs, an epic-clobber reading plan, screenshots.
   > **Reason:** The count has drifted to ~38 since the plan was written (e.g. `LOW_MEMORY_HOSTS.md` and `TOUCH_ACCESS.md` were added). A documentation plan that cites a count should be close enough that a reader checking it does not lose trust in the rest.
   > **Replaced with:** `docs/` holds ~38 entries (as of 2026-09-14) mixing published material (`REMOTE_ACCESS.md`, `TECHNICAL_DOC.md`, `headless-switchboard.md`) with working artifacts — four `imported_document_2026_*.md`, research dumps, investigation logs, an epic-clobber reading plan, screenshots.

**And the timing risk is the real one.** Sixteen plans of design exist and almost none has shipped. Documentation written from plans describes a product that does not exist, which is worse than absent documentation: it makes a user's failure to find a feature look like their mistake. `docs/REMOTE_ACCESS.md` is the counter-example to follow — it documents the loopback guards *that exist*, citing the files that enforce them.

### Root Cause

Documentation has been produced per-feature by whoever shipped it, with no owner for the cross-cutting story. Storage and remote access are exactly the topics that cannot be documented feature-by-feature, because a user's question ("where does my board live?", "how do I reach it from my laptop?") spans a dozen of them.

### Non-goals

- Documenting unshipped design. Each clause lands with its feature, not before.
- Reorganising `docs/`, deleting the imported/research artifacts, or renaming existing files. Out of scope and someone else's call.
- A new top-level documentation site or generated reference.
- Rewriting `README.md` or `ARCHITECTURE.md` beyond a pointer.

## Metadata

**Feature:** bddc9664-742d-4bd1-a801-082ed6ba3daa
**Complexity:** 3
**Tags:** docs, ux, devops, infrastructure

## User Review Required

Yes — three decisions.

1. **One document or several?** Recommendation: **extend `docs/REMOTE_ACCESS.md` for the deployment modes and the remote loop, and add one new `docs/STORAGE.md` for the topology.** Two documents matching the two questions users actually ask, rather than six matching our plan boundaries.
2. **What lands now, before any storage work?** Recommendation: the two no-code items — the `agy` controller pattern and the Linear notification loop — plus the deployment-mode *vocabulary*, marked as which modes exist today (local/local does; the others do not yet). Everything else waits.
3. **Who owns the trigger?** A doc clause is easy to forget when the feature lands. Recommendation: each storage/remote plan gains a documentation line in its own Proposed Changes, naming the section it must update — so the doc obligation travels with the code rather than living in this plan.

   > **Superseded:** Recommendation 3 as originally written — "each storage/remote plan gains a documentation line in its own Proposed Changes, naming the section it must update."
   > **Reason:** The Board Collapse 01 rescope (2026-09-04) deleted this mechanism — planting trigger lines in six other plans was rejected as a tripwire in someone else's Proposed Changes. The dependency is real (document a clause when it ships) but it is tracked here, not by editing sibling plans. Leaving the recommendation standing after the rescope contradicts the RESCOPED note at the top of this file.
   > **Replaced with:** The doc obligation is tracked in this plan's Dependencies section. When a storage/remote feature ships, the implementer checks this plan for the clause it owes and writes it. No trigger line is planted in sibling plan files.

## Complexity Audit

### Routine

- The `agy` controller section and the Linear notification section: both describe existing behaviour and can be written from the code.
- A deployment-mode vocabulary section naming the three allowed combinations, and which are supported.
- A pointer from `README.md`.

### Complex / Risky

- **Saying what is true today without implying the rest is coming.** A document that lists three modes and marks two as future reads as a roadmap, and roadmaps in user docs become complaints. The framing should be "today Switchboard runs one machine, one board; the shape below is where the remote work is going" — stated once, not per-section.
- **Agent-facing paths are user-facing.** `query-kanban`'s documented `$SB_ROOT/.switchboard/kanban.db`, and `scripts/move-card.js`, are read by agents *and* by people. When consolidation moves the store these change, and the skill is the documentation. So the storage doc and the skill must move together or agents follow a stale path — which is the failure `board-read-endpoints-must-survive-the-storage-topology.md` already describes.
- **The mode-4 refusal needs its reasoning, not just its absence.** Board-local-with-agents-remote is coherent and will be asked for. If the doc simply omits it, someone builds it. One paragraph: it makes the agent host depend on the machine that sleeps, and the fix is an offline write queue the design deliberately refuses.
- **Do not restate the security posture in a second place.** `REMOTE_ACCESS.md` already carries the loopback argument and names the four guards. New sections should reference it, not paraphrase — two copies drift, and the drifting copy is the one someone reads.
- **The mode terminology must disambiguate "local" and "remote" by perspective.** `REMOTE_ACCESS.md` already documents "Remote agent seats" (board on the always-on Pi, agents on other machines via ssh prefix). From the board host's perspective this is "board local, agents remote"; from the operator's perspective it is "remote board, remote agents." The refused mode (`switchboard-as-a-local-app-and-a-self-hosted-remote.md`, Settled, 2026-09-01) is "board on the operator's primary machine (which sleeps), agents on the stable machine" — a different configuration. The documentation vocabulary must use terms that do not conflate these two, or a reader will conclude the supported "Remote agent seats" pattern is the refused mode (or vice versa).

## Edge-Case & Dependency Audit

**Race Conditions**
- None. This is documentation only; no runtime state is touched.

**Security**
- The boundary model is worth one plain paragraph, because it is otherwise inferred wrongly: Switchboard constrains what *it* does and does not reconfigure the operator's machine or manage their credentials (`MultiRepoScaffoldingService.ts:149` refusing embedded credentials in repo URLs is the shipped example); attribution is not authorisation; branch protection is the operator's and outside the product. Stating it prevents both over-trust and the assumption that a control is missing by oversight.
- Do not document a control the product does not have. The `GIT POLICY` prompt lines are advisory and should be described that way if described at all.

**Side effects**
- `switchboard-remote.md`, the orchestration protocol and `query-kanban` are all documentation an *agent* reads. Anything said to users about where the board lives has an agent-facing twin, and the two must agree.
- `docs/headless-switchboard.md` overlaps the deployment-mode material; check before duplicating.

**Dependencies & Conflicts**
- The new "Remote agent seats" content in `REMOTE_ACCESS.md` must not contradict the existing "Remote agent seats" section (lines 233–302) that already documents board-on-Pi with agents-on-other-machines. The vocabulary section integrates with or references that existing section rather than restating it.
- The mode-4 refusal paragraph must be consistent with `switchboard-as-a-local-app-and-a-self-hosted-remote.md`'s Settled section, which defines "board local" as "board on the operator's primary machine" — not "board on the board host."

**Migration**
- Documentation only. The one hazard is a user on an older version reading current docs — so version-sensitive statements (where the database lives, especially) should say which version changed them.

## Dependencies

- **Extends** `docs/REMOTE_ACCESS.md`, itself the product of `standalone-remote-access-story.md`.
- ~~**Each clause depends on its feature shipping.** The trigger lines belong in:~~ **REMOVED 2026-09-04 (Board Collapse audit): this plan does not edit six other plan files.** The dependency is real — document a clause when it ships — but track it here, not by planting a tripwire in someone else's Proposed Changes. Original list, for reference: `storage-topology-one-choice-three-stores.md`, `single-global-database-in-home-store.md`, `libsql-shared-store-turso-and-self-hosted-sqld.md`, `switchboard-as-a-local-app-and-a-self-hosted-remote.md`, `remote-authoring-over-the-shared-store-as-a-provider-kind.md`, `the-remote-command-vocabulary-is-closed.md`.
- **Independent, and shippable now:** the `agy` pattern, the Linear notification loop, the mode vocabulary, the boundary paragraph.

## Adversarial Synthesis

Key risks: documenting planned rather than shipped behaviour, which makes a user's inability to find a feature look like their own mistake; a three-mode table reading as a roadmap and generating complaints; restating the loopback security argument in a second place where the two copies drift; agent-facing paths (`query-kanban`, `move-card.js`) going stale against a moved store; and the mode terminology conflating the supported "Remote agent seats" pattern (board on always-on Pi, agents on other machines) with the refused "board local, agents remote" mode (board on a sleeping laptop, agents on the stable machine). Mitigations: one framing sentence rather than per-section futures; reference `REMOTE_ACCESS.md` instead of paraphrasing it; treat the skill and the storage doc as a single change; and use perspective-qualified terms ("board on the operator's machine" vs "board on the always-on host") in the vocabulary section so the refused and supported modes are not confused.

## Proposed Changes

**Now, no code required:**
1. **`docs/REMOTE_ACCESS.md` — controller-seat section.** `agy` is a supported CLI (`terminalUtils.ts:244`), so the orchestrator seat can run the Antigravity CLI and inherit that host's Remote Control for browser access, while dispatching to any other CLI. Configuration, not a feature.
2. **`docs/REMOTE_ACCESS.md` — notification section.** Completion comments via `postManagedComment` (`LinearSyncService.ts:1559`, `NotionRemoteProvider.ts:246`) to Linear or Notion, plus Linear's own app, give phone notifications with no Switchboard notification system involved.
3. **`docs/REMOTE_ACCESS.md` — deployment vocabulary.** ~~The two axes and four combinations~~ **— THREE combinations (corrected 2026-09-04): board-local with agents-remote was REFUSED on 2026-09-01 and must not be documented as available.** The two axes and three combinations, which are supported today, and one paragraph on why board-local-with-remote-agents is refused. **The vocabulary must integrate with the existing "Remote agent seats" section (lines 233–302) of `REMOTE_ACCESS.md`, which already documents board-on-always-on-Pi with agents-on-other-machines via ssh prefix — that is "remote board, remote agents" from the operator's perspective, NOT the refused mode.** The refusal paragraph must use perspective-qualified language: the refused mode is "board on the operator's primary machine (which sleeps), agents on the stable machine" — not "board on the board host, agents on other machines," which is the supported "Remote agent seats" pattern.
4. **A boundary paragraph** on what Switchboard constrains versus what remains the operator's.

**Per feature, as each ships:**
5. **`docs/STORAGE.md` (new)** — the three stores, the one operator choice, target-not-path, and where the database lives. Lands with the topology and consolidation work, and **together with** the `query-kanban` and `move-card.js` path updates.
6. **`REMOTE_ACCESS.md` mode sections** filled in as each mode becomes real.
7. ~~**A documentation trigger line** added to the Proposed Changes of each storage/remote plan, naming the section it must update.~~ **REMOVED 2026-09-04 (Board Collapse audit): this plan does not edit six other plan files.** The doc obligation is tracked in this plan's Dependencies section instead.
8. **A `README.md` pointer** to both documents.

### Migration

Documentation only. Version-sensitive claims about the database location name the version that changed them.

## Verification Plan

- **Nothing describes unshipped behaviour:** review-level check that every statement in the new sections is true of the current release, or explicitly marked as not yet available.
- **The no-code claims are actually true:** verify `agy` is in the CLI detection regex (`terminalUtils.ts:244`) and brand-icon map (`terminals.js:3513`); verify a completion comment reaches a Linear card and that Linear's app pushes it. Documenting either without checking is the failure this plan is most likely to commit.
- **No second copy of the security posture:** assert the new sections reference `REMOTE_ACCESS.md`'s guard list rather than restating it.
- **Agent and user docs agree:** diff what `query-kanban`, `switchboard-remote.md` and the orchestration protocol say about where the board lives against `STORAGE.md`. Assert no contradiction — the check that would have caught the stale-path problem earlier.
- **Mode-4 reasoning present:** assert the refusal is stated with its cause, not omitted.
- **Mode terminology is unambiguous:** assert the vocabulary section uses perspective-qualified terms and does not conflate the supported "Remote agent seats" pattern (board on always-on host) with the refused mode (board on a sleeping machine). A reader should be able to tell from the doc alone which is which.
- ~~**Triggers exist:** assert each named storage/remote plan carries its documentation line.~~ **REMOVED 2026-09-04 (Board Collapse audit): the trigger-line mechanism was deleted.** The doc obligation is tracked in this plan's Dependencies section, not in sibling plan files.

## Outstanding Questions

- Does `docs/` need a published-versus-working-artifact split before more is added, or is that a separate cleanup someone else should scope?
- Should `docs/headless-switchboard.md` be folded into the deployment-mode material, or does it serve a distinct audience?
- Is there an existing docs site or is `docs/` in-repo the whole story? That decides whether "published" means anything today.
