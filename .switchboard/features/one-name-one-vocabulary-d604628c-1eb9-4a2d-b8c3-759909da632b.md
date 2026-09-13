# One Name, One Vocabulary

**Complexity:** 7

## Goal

Consolidated 2026-09-10: the CLI becomes lc, the product becomes LABCOM end to end, one vocabulary across both audiences, and the agent-instruction protocol paths point somewhere real.

## How the Subtasks Achieve This

- **The Protocol Path in Our Own Agent Instructions Points Nowhere, and Nothing Stops the Fallout**: Fixes the one remaining dead `.switchboard/protocols/` reference in `.agents/plan-authoring-protocol.md` and adds a CI whitelist gate over `.agents/skills/` contents so a protocol written to the wrong directory fails CI instead of shipping silently. The CLAUDE.md corrections were already done (verified zero matches as of 2026-09-11).
- **Settle on one clear vocabulary and sweep both audiences**: Sweeps the lead-facing prompt in `KanbanProvider.ts` to teach `POST /terminals/clear` (the first-class endpoint with caller protection and mid-turn deferral) instead of the low-level `ptyClearTerminal` verb, which bypasses those invariants. Confirms agent-facing surfaces are already correct.
- **One Name End to End: Switchboard Becomes LABCOM, and the CLI Becomes `lc`**: Renames the user- and agent-facing surface from Switchboard/`switchboard` to LABCOM/`lc` — package name, bin, CLI usage, agent-facing instruction text, docs, site repo, config keys, and the on-disk `.switchboard/` state directory. No alias, no compatibility shim; the fleet is restarted to deliver fresh standing orders.

## Dependencies & sequencing

- **Shipping order:** Subtask B (clear endpoint vocabulary) is independent and can land in any order. Subtask A (protocol paths) should land before subtask C's change 9 (the `.switchboard/` rename) so the protocol path reference in `.agents/plan-authoring-protocol.md` is already corrected to `.agents/protocols/`. Within C, change 7 (site repo rename) should land first — "only gets dearer" — and change 9 (.switchboard/ rename) should land last, as its own commit, after A and after C's changes 1-8.
- **Prerequisites:** A's whitelist gate depends on Changes 5 and 6 (delete `improve-feature` alias, move `switchboard-orchestration` to protocols) landing before the gate — the 6-entry expected set assumes both are done. C's fleet restart (change 3) must be coordinated: stop fleet, land rename, start teams.

## Team Dispatch Instructions

### The Protocol Path in Our Own Agent Instructions Points Nowhere, and Nothing Stops the Fallout

- **Seat:** Intern (complexity 3)
- **Acceptance:**
  - `grep -rn "\.switchboard/protocols" CLAUDE.md .agents/plan-authoring-protocol.md` returns zero matches
  - `grep -rc "\.switchboard/protocols" src/services/agentPromptBuilder.ts` still returns 6 (migration keys unchanged)
  - `npm run skills-whitelist:check` exits 0 on the corrected tree
  - `npm run skills-whitelist:check` exits non-zero when a scratch directory is added under `.agents/skills/`
  - `.agents/skills/improve-feature/` does not exist (alias deleted)
  - `.agents/skills/switchboard-orchestration/` does not exist (moved to `.agents/protocols/`)
  - `manage-features/SKILL.md` references `improve-feature` by protocol path, not by skill name
  - The `switchboard` skill references `switchboard-orchestration` by protocol path, not by skill name
- **Must not touch:** The 12 `.switchboard/protocols/` occurrences in `src/` (migration keys in `agentPromptBuilder.ts`, `planner-workflow-path-migration.test.js`, `vsix-packaging-contract.test.js`)

### Settle on one clear vocabulary and sweep both audiences

- **Seat:** Intern (complexity 2)
- **Acceptance:**
  - `grep -n "ptyClearTerminal" src/services/KanbanProvider.ts` returns zero matches
  - `grep -n "POST /terminals/clear" src/services/KanbanProvider.ts` returns at least two matches
  - `grep -n "ptyClearTerminal" src/webview/terminals.js` returns the same three matches (webview unchanged)
  - Every `POST /terminals/clear` command example in `KanbanProvider.ts` includes a `from` field
- **Must not touch:** `src/webview/terminals.js` (the webview's internal `ptyClearTerminal` calls are the host's own UI, not agent-facing)

### One Name End to End: Switchboard Becomes LABCOM, and the CLI Becomes `lc`

- **Seat:** Lead Coder (complexity 7)
- **Acceptance:**
  - `grep -ri switchboard` over the repo returns nothing outside git history (contract test asserts this)
  - `--help` mentions `lc` and never `npx switchboard`
  - No string handed to an agent (standing orders, head prompts, bundled protocols) contains the old binary name
  - The config migration is idempotent: running it twice leaves the same keys, and a board written before the rename opens with settings intact
  - `switchboard --help` returns command not found (the intended result)
- **Must not touch:** None specified — every occurrence of the old name is in scope (the plan explicitly says "Explicitly out of scope: Nothing")

<!-- BEGIN SUBTASKS (auto-generated, do not edit) -->
## Subtasks
- [ ] [The Protocol Path in Our Own Agent Instructions Points Nowhere, and Nothing Stops the Fallout](../plans/protocol-paths-in-agent-instructions-point-nowhere.md) — **PLAN REVIEWED** — ID: e3ad7ee3-f987-4c1c-9162-22349572830c
- [ ] [Settle on one clear vocabulary and sweep both audiences](../plans/settle-on-one-clear-vocabulary-and-sweep-both-audiences.md) — **PLAN REVIEWED** — ID: 72bd124c-a155-468c-8af7-bd781f345ead
- [ ] [One Name End to End: Switchboard Becomes LABCOM, and the CLI Becomes `lc`](../plans/one-name-end-to-end-switchboard-becomes-labcom-and-the-cli-becomes-lc.md) — **PLAN REVIEWED** — ID: 9a9bea12-94ae-43e5-b676-0f88866191e9
<!-- END SUBTASKS -->

