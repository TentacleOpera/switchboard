# Document the storage topology, deployment modes and remote loop — clause by clause, as each one ships

<!-- board-collapse-01 -->
> **RESCOPED 2026-09-04 (Board Collapse 01).** Two corrections. (1) Item 3 documents "the two axes and four combinations"; the mode matrix was settled at **three** on 2026-09-01 — board-local with agents-remote was refused. (2) Delete the mechanism that adds a documentation trigger line to six other storage plans. Documentation follows shipped behaviour; this plan shrinks to the two facts true today, the `agy` controller seat and the notification loop, plus the deployment vocabulary.


## Goal

Give the storage and remote work a documentation home, and a rule for when each part gets written: **when it ships, not when it is planned.** Extend `docs/REMOTE_ACCESS.md` rather than starting a new file, and record the two things that are true *today* and undocumented — the `agy`-as-controller pattern and the Linear notification loop — immediately, since neither waits on any code.

### Problem Analysis

**A large design surface has accumulated with no user-facing account of it.** The storage programme moves the database out of the repository into a home store, splits it by ownership and temperature, and makes the store a choosable target. The remote work adds deployment modes, a pairing story and remote authoring. Every one of those changes something a user or an agent can observe, and none of it is written down outside plan files.

**Two of those things need no code and are undocumented today:**

1. **`agy` as the controller seat.** `terminalUtils.ts:213` includes `agy` in the CLI-agent detection regex alongside `claude`, `gemini`, `cursor` and `windsurf`, and `terminals.js` maps it to the Antigravity brand icon. So the orchestrator seat can already run the Antigravity CLI. That matters because Antigravity shipped Remote Control (announced 21 Aug 2026): browser access to an Antigravity session on any of your machines. Run the controller on `agy` and the Switchboard cockpit becomes reachable from a browser through the host vendor's own feature — while the fleet it dispatches to can be any other CLI and any other subscription. Nothing to build; it is a configuration nobody would guess.
2. **Phone notifications already work through Linear.** Agents post completion comments via `postManagedComment` to the Linear or Notion card, and Linear's own app pushes those to a phone. So the notification loop is: agent completes → managed comment → Linear push. Switchboard does not need a notification system; it needs users to know this composition exists.

**The documentation directory cannot absorb more without a line drawn.** `docs/` holds 36 entries mixing published material (`REMOTE_ACCESS.md`, `TECHNICAL_DOC.md`, `headless-switchboard.md`) with working artifacts — four `imported_document_2026_*.md`, research dumps, investigation logs, an epic-clobber reading plan, screenshots. Adding six new files to that pile makes them unfindable rather than published.

**And the timing risk is the real one.** Sixteen plans of design exist and almost none has shipped. Documentation written from plans describes a product that does not exist, which is worse than absent documentation: it makes a user's failure to find a feature look like their mistake. `docs/REMOTE_ACCESS.md` is the counter-example to follow — it documents the loopback guards *that exist*, citing the files that enforce them.

### Root Cause

Documentation has been produced per-feature by whoever shipped it, with no owner for the cross-cutting story. Storage and remote access are exactly the topics that cannot be documented feature-by-feature, because a user's question ("where does my board live?", "how do I reach it from my laptop?") spans a dozen of them.

### Non-goals

- Documenting unshipped design. Each clause lands with its feature, not before.
- Reorganising `docs/`, deleting the imported/research artifacts, or renaming existing files. Out of scope and someone else's call.
- A new top-level documentation site or generated reference.
- Rewriting `README.md` or `ARCHITECTURE.md` beyond a pointer.

## Metadata

**Complexity:** 3
**Tags:** docs, ux, devops, infrastructure

## User Review Required

Yes — three decisions.

1. **One document or several?** Recommendation: **extend `docs/REMOTE_ACCESS.md` for the deployment modes and the remote loop, and add one new `docs/STORAGE.md` for the topology.** Two documents matching the two questions users actually ask, rather than six matching our plan boundaries.
2. **What lands now, before any storage work?** Recommendation: the two no-code items — the `agy` controller pattern and the Linear notification loop — plus the deployment-mode *vocabulary*, marked as which modes exist today (local/local does; the others do not yet). Everything else waits.
3. **Who owns the trigger?** A doc clause is easy to forget when the feature lands. Recommendation: each storage/remote plan gains a documentation line in its own Proposed Changes, naming the section it must update — so the doc obligation travels with the code rather than living in this plan.

## Complexity Audit

### Routine

- The `agy` controller section and the Linear notification section: both describe existing behaviour and can be written from the code.
- A deployment-mode vocabulary section naming the four combinations, and which are supported.
- A pointer from `README.md`.

### Complex / Risky

- **Saying what is true today without implying the rest is coming.** A document that lists four modes and marks three as future reads as a roadmap, and roadmaps in user docs become complaints. The framing should be "today Switchboard runs one machine, one board; the shape below is where the remote work is going" — stated once, not per-section.
- **Agent-facing paths are user-facing.** `query-kanban`'s documented `$SB_ROOT/.switchboard/kanban.db`, and `scripts/move-card.js`, are read by agents *and* by people. When consolidation moves the store these change, and the skill is the documentation. So the storage doc and the skill must move together or agents follow a stale path — which is the failure `board-read-endpoints-must-survive-the-storage-topology.md` already describes.
- **The mode-4 refusal needs its reasoning, not just its absence.** Board-local-with-remote-agents is coherent and will be asked for. If the doc simply omits it, someone builds it. One paragraph: it makes the agent host depend on the machine that sleeps, and the fix is an offline write queue the design deliberately refuses.
- **Do not restate the security posture in a second place.** `REMOTE_ACCESS.md` already carries the loopback argument and names the four guards. New sections should reference it, not paraphrase — two copies drift, and the drifting copy is the one someone reads.

## Edge-Case & Dependency Audit

**Security**
- The boundary model is worth one plain paragraph, because it is otherwise inferred wrongly: Switchboard constrains what *it* does and does not reconfigure the operator's machine or manage their credentials (`MultiRepoScaffoldingService.ts:149` refusing embedded credentials in repo URLs is the shipped example); attribution is not authorisation; branch protection is the operator's and outside the product. Stating it prevents both over-trust and the assumption that a control is missing by oversight.
- Do not document a control the product does not have. The `GIT POLICY` prompt lines are advisory and should be described that way if described at all.

**Side effects**
- `switchboard-remote.md`, the orchestration protocol and `query-kanban` are all documentation an *agent* reads. Anything said to users about where the board lives has an agent-facing twin, and the two must agree.
- `docs/headless-switchboard.md` overlaps the deployment-mode material; check before duplicating.

**Migration**
- Documentation only. The one hazard is a user on an older version reading current docs — so version-sensitive statements (where the database lives, especially) should say which version changed them.

## Dependencies

- **Extends** `docs/REMOTE_ACCESS.md`, itself the product of `standalone-remote-access-story.md`.
- **Each clause depends on its feature shipping.** The trigger lines belong in: `storage-topology-one-choice-three-stores.md`, `single-global-database-in-home-store.md`, `libsql-shared-store-turso-and-self-hosted-sqld.md`, `switchboard-as-a-local-app-and-a-self-hosted-remote.md`, `remote-authoring-over-the-shared-store-as-a-provider-kind.md`, `the-remote-command-vocabulary-is-closed.md`.
- **Independent, and shippable now:** the `agy` pattern, the Linear notification loop, the mode vocabulary, the boundary paragraph.

## Adversarial Synthesis

Key risks: documenting planned rather than shipped behaviour, which makes a user's inability to find a feature look like their own mistake; a four-mode table reading as a roadmap and generating complaints; restating the loopback security argument in a second place where the two copies drift; and agent-facing paths (`query-kanban`, `move-card.js`) going stale against a moved store, which is a documented failure mode already. Mitigations: a per-plan documentation trigger so each clause lands with its feature; one framing sentence rather than per-section futures; reference `REMOTE_ACCESS.md` instead of paraphrasing it; and treat the skill and the storage doc as a single change.

## Proposed Changes

**Now, no code required:**
1. **`docs/REMOTE_ACCESS.md` — controller-seat section.** `agy` is a supported CLI (`terminalUtils.ts:213`), so the orchestrator seat can run the Antigravity CLI and inherit that host's Remote Control for browser access, while dispatching to any other CLI. Configuration, not a feature.
2. **`docs/REMOTE_ACCESS.md` — notification section.** Completion comments via `postManagedComment` to Linear or Notion, plus Linear's own app, give phone notifications with no Switchboard notification system involved.
3. **`docs/REMOTE_ACCESS.md` — deployment vocabulary.** The two axes and four combinations, which are supported today, and one paragraph on why board-local-with-remote-agents is refused.
4. **A boundary paragraph** on what Switchboard constrains versus what remains the operator's.

**Per feature, as each ships:**
5. **`docs/STORAGE.md` (new)** — the three stores, the one operator choice, target-not-path, and where the database lives. Lands with the topology and consolidation work, and **together with** the `query-kanban` and `move-card.js` path updates.
6. **`REMOTE_ACCESS.md` mode sections** filled in as each mode becomes real.
7. **A documentation trigger line** added to the Proposed Changes of each storage/remote plan, naming the section it must update.
8. **A `README.md` pointer** to both documents.

### Migration

Documentation only. Version-sensitive claims about the database location name the version that changed them.

## Verification Plan

- **Nothing describes unshipped behaviour:** review-level check that every statement in the new sections is true of the current release, or explicitly marked as not yet available.
- **The no-code claims are actually true:** verify `agy` is in the CLI detection regex and brand-icon map; verify a completion comment reaches a Linear card and that Linear's app pushes it. Documenting either without checking is the failure this plan is most likely to commit.
- **No second copy of the security posture:** assert the new sections reference `REMOTE_ACCESS.md`'s guard list rather than restating it.
- **Agent and user docs agree:** diff what `query-kanban`, `switchboard-remote.md` and the orchestration protocol say about where the board lives against `STORAGE.md`. Assert no contradiction — the check that would have caught the stale-path problem earlier.
- **Mode-4 reasoning present:** assert the refusal is stated with its cause, not omitted.
- **Triggers exist:** assert each named storage/remote plan carries its documentation line.

## Outstanding Questions

- Does `docs/` need a published-versus-working-artifact split before more is added, or is that a separate cleanup someone else should scope?
- Should `docs/headless-switchboard.md` be folded into the deployment-mode material, or does it serve a distinct audience?
- Is there an existing docs site or is `docs/` in-repo the whole story? That decides whether "published" means anything today.
