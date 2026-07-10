---
description: "Three small supports for the NL-driven manager: a switchboard-contracts skill (behavior facts agents otherwise re-derive from source — shipped as a skill because docs/ is not deployed with the extension), generated per-verb payload field reference in the protocol catalog, and a guard ensuring the write-once completion directive survives prompt overrides."
---

# Switchboard-Contracts Skill, Verb Payload Reference & Write-Once Directive Guard

> **Status: PLAN.** Follow-up to the "Switchboard Remote Manager" feature (`a2b-generic-verb-passthrough-vscode-running.md` + `switchboard-manage-skill-ux-overhaul.md`). Those plans make the manager complete and usable; this plan makes it **self-sufficient** — agents stop re-deriving system behavior from source, stop guessing verb payloads, and the completion convention the oversight loop depends on cannot be silently edited away.

## Goal

Close the three operational gaps identified while reviewing the Remote Manager feature (2026-07-10):

1. **Agents re-derive system contracts from source.** Core behavioral facts — cards move on coding *start* and never on finish; completion = first plan-file mtime advance after dispatch; plan files are written once, at the end; persist a move before dispatching; epic subtasks carry their own `kanban_column` — are documented nowhere agent-readable. The user manual explains the *UI* to *humans*; an agent consulting it finds "click the button." During the feature review these facts had to be excavated from `GlobalPlanWatcherService.ts` and corrected twice in conversation. Every future managing agent hits the same wall.
2. **Verb payloads are undocumented.** After the A2b passthrough, ~600 verbs are callable, but an agent routing an uncommon NL request to a rarely-used verb must guess the payload fields by trial and error. The information already exists statically: `protocol-catalog.json`'s `requestSites[]` records the exact `file`/`line` of every webview `postMessage` call site — the generator just doesn't extract the object-literal keys.
3. **The write-once completion convention is one prompt edit from breaking.** The entire completion-detection chain (activity light, autoban, the Manage skill's Column Oversight pass) rests on `CODING_COMPLETION_REPORT_DIRECTIVE` (`agentPromptBuilder.ts:572`) instructing coders to append a summary to the plan file when finished. Role prompts are user-overridable (`defaultPromptOverrides`, `agentPromptBuilder.ts:184/302/1632-1633`). If an override drops the directive, completion detection breaks **silently** — dispatched plans finish but their cards never clear and oversight passes time out on work that succeeded.

### Root cause

All three are the same underlying gap: the system's *conventions* live in code and prompt strings, while its *documentation* targets human UI users. As soon as agents became first-class drivers (the Remote Manager feature), the conventions needed an agent-facing surface and tamper protection — neither existed because agents weren't the audience when the docs were written.

## Metadata
- **Tags:** docs, refactor, api, reliability
- **Complexity:** 4

## User Review Required
- **Doc location — resolved (user decision):** it ships as a **skill**, `.agents/skills/switchboard-contracts/SKILL.md`, because the `docs/` folder is not deployed with the extension while `.agents/skills/` is distributed with the plugin. (A new skill folder also sidesteps the overwrite:false propagation freeze that affects *updates* to existing skills — new files copy cleanly on install.)
- **Override guard behavior — resolved (user decision, 2026-07-10): hard guarantee.** Unconditionally re-append `CODING_COMPLETION_REPORT_DIRECTIVE` after any override is applied for code-touching roles (idempotent — never double-append). The directive is the completion-protocol handshake, not a stylistic choice, and is deliberately non-overridable.
- Otherwise: None — no open questions.

## Scope

### ✅ IN SCOPE

1. **`switchboard-contracts` skill — one page, contracts only, no UI.**

   > **Superseded:** deliver as `docs/agent_contracts.md`.
   > **Reason:** The `docs/` folder is not deployed with the extension — agents in installed workspaces would never see it. Skills (`.agents/skills/`) are distributed with the plugin.
   > **Replaced with:** a new skill `.agents/skills/switchboard-contracts/SKILL.md` (description: "System behavior contracts for agents driving Switchboard — consult when unsure how the system behaves; never for invocation"). Same one-page content. Model-invocable so any agent can pull it on demand.

   The behavioral facts an agent driving Switchboard must know, each with its source-of-truth reference:
   - Cards move on coding **start** (the move *is* the dispatch); they never move on finish.
   - Completion signal = **first plan-file mtime advance after dispatch** (`GlobalPlanWatcherService.ts` activity-light OFF-switch); dispatch never writes the plan file; no content is parsed ("no agent-authored text is trusted" as a control signal).
   - Plan files are **write-once-at-the-end** by dispatched agents (`CODING_COMPLETION_REPORT_DIRECTIVE`); mid-work plan edits break completion detection for everyone.
   - Staleness backstop: `switchboard.activityLight.timeoutMs` (default 10 min) sweep clears `dispatched_at`.
   - **Persist a card move before firing its dispatch** (move↔dispatch coupling).
   - **Epic subtasks carry their own `kanban_column`** — column sweeps must exclude them or they leak into batch operations.
   - Every API call carries `workspaceRoot`; reads prefer local `kanban-state-*.md` files; the extension is the sole `kanban.db` writer.
   - Project pins are resolve-only on import; the workspace name is never a project.
   - A scoping preamble: *"This doc answers how the system behaves. It never answers how to invoke something — for invocation, use the `switchboard-orchestration` skill and `GET /catalog`."*
   Add a pointer to this skill from the `switchboard-orchestration` skill and the `switchboard-manage` skill (both copies, body-only per their frontmatter split), phrased as: consult for behavior/concepts when unsure; never for invocation. Register the new skill in the `AGENTS.md`/`CLAUDE.md` skills table.
2. **Per-verb payload field extraction in the catalog generator.** Extend `scripts/generate-protocol-catalog.js`: for each `requestSites[]` entry (verb + file + line), statically parse the `postMessage({ type: '<verb>', ...fields })` object literal at that site and record the literal's key names. Emit as `payloadKeys: string[]` per verb (attach to the site entries and aggregate per verb under `providers.<Name>`). Sites with dynamic/spread payloads (`...obj`, computed keys, variable message objects) get `payloadKeys: "dynamic"` — never guess. The data rides the existing `GET /catalog` endpoint automatically; no new endpoint. Regenerate the checked-in `protocol-catalog.json`.
3. **Write-once directive guard.**
   - Composition guarantee in `agentPromptBuilder.ts`: after `defaultPromptOverride` application (`:1632-1633`), unconditionally re-append `CODING_COMPLETION_REPORT_DIRECTIVE` for code-touching roles (`CODE_TOUCHING_ROLES`, `:721`) if the composed prompt no longer contains it. The override customizes everything else; the completion contract survives.
   - Load-bearing comment on the constant (`:572`): name the three consumers (activity light, autoban, Manage oversight passes) so no future refactor treats it as prose.
   - One line in `docs/agent_contracts.md` (#1) cross-referencing the guarantee.

### ⚙️ OUT OF SCOPE
- Full payload *type* documentation or JSON-schema per verb — key names only; types remain the arm's own validation concern.
- Any UI for viewing contracts or payload keys — file + catalog JSON is the surface.
- Changes to the Remote Manager feature's plans (frozen, mid-coding). This plan lands after and independently.
- Rewriting the user manual — it stays human/UI-facing.

## Implementation Steps
1. Write `.agents/skills/switchboard-contracts/SKILL.md` per Scope #1 (source every claim against current code at write time — do not copy this plan's line numbers blindly).
2. Add the skill pointers to the `switchboard-orchestration` skill and both `switchboard-manage` SKILL.md copies (body-only; preserve per-host frontmatter); add the `switchboard-contracts` row to the `AGENTS.md`/`CLAUDE.md` skills table.
3. Extend `scripts/generate-protocol-catalog.js` with payload-key extraction per Scope #2; regenerate `protocol-catalog.json`; confirm `catalog:check` treats the new field as part of the drift check.
4. `agentPromptBuilder.ts`: add the composition guarantee after override application + the load-bearing comment on the constant.
5. Gates: `npm run catalog:check`, `npm run parity:check` green.

## Complexity Audit
### Routine
- The contracts doc (prose, one page, facts already verified in source).
- Skill pointer additions; load-bearing comment.
### Complex / Risky
- **Payload-key static extraction**: webview call sites vary (object literals, shorthand, spreads, variables). The parser must classify honestly — a wrong `payloadKeys` list is worse than `"dynamic"`, because agents will trust it. Prefer under-claiming.
- **Override composition guarantee**: must not double-append the directive when the override already contains it, and must not fire for non-code-touching roles (planner/architect prompts legitimately lack it).

## Edge-Case & Dependency Audit
- **Race Conditions:** None — docs, a generator, and prompt composition.
- **Security:** None new. Payload keys expose field *names* already visible in the shipped webview source.
- **Side Effects:** Regenerating `protocol-catalog.json` adds a field to a checked-in file consumed by `catalog:check`, the A2b allowlist generator, and the parity gate — verify all three tolerate (ignore or incorporate) `payloadKeys` before merging. The directive guard changes composed prompt text for overridden roles — users with existing overrides will see the directive reappear; that is the intent, but note it in the changelog.
- **Dependencies & Conflicts:** Item #2 touches the same generator the A2b passthrough plan extends (allowlist emission) and item #1's skill pointers touch the same SKILL.md files the UX overhaul rewrites — **land this plan after the Remote Manager feature merges** to avoid editing files mid-flight. No other conflicts.

## Dependencies
- Remote Manager feature (`a2b-generic-verb-passthrough-vscode-running.md`, `switchboard-manage-skill-ux-overhaul.md`) — sequence this plan **after** it merges (shared generator + SKILL.md surfaces).
- `protocol-catalog.json` `requestSites[]` (present) — the payload-extraction input.

## Adversarial Synthesis
Key risks: (1) payload extraction over-claiming on dynamic call sites — mitigated by classifying anything non-literal as `"dynamic"` and preferring under-claim; (2) the directive guard altering prompts users deliberately customized — mitigated by the User Review decision and a changelog note; (3) the contracts doc drifting from code over time — mitigated by citing the source file for every contract so staleness is checkable, and by keeping it to contracts (slow-moving) rather than mechanics (fast-moving).

## Proposed Changes
### .agents/skills/switchboard-contracts/SKILL.md (new skill)
- One-page behavioral contracts list per Scope #1, each fact with its source file citation; invocation-scoping preamble in the description and body.
### .agents/skills/switchboard-orchestration/SKILL.md, .agents/skills/switchboard-manage/SKILL.md + .claude mirror, AGENTS.md/CLAUDE.md
- One-line pointer: consult the `switchboard-contracts` skill for behavior when unsure; never for invocation (catalog/orchestration skill are the invocation authority). Body-only edits; new row in the skills table.
### scripts/generate-protocol-catalog.js + protocol-catalog.json
- Payload-key extraction per request site; `payloadKeys` per verb; `"dynamic"` for non-literal payloads; regenerated catalog checked in.
### src/services/agentPromptBuilder.ts
- Composition guarantee: re-append `CODING_COMPLETION_REPORT_DIRECTIVE` post-override for `CODE_TOUCHING_ROLES` when absent (idempotent — no double-append). Load-bearing comment on the constant naming its three consumers.

## Verification Plan
### Automated
- `npm run catalog:check` green with `payloadKeys` present; spot-assert a known literal-payload verb (e.g. `moveCard`-class) lists expected keys and a known dynamic site reports `"dynamic"`.
- `npm run parity:check` green (tolerates the new catalog field).
- Grep: composed coder prompt with a replace-mode override still contains `COMPLETION REPORT:` exactly once.
### Manual / behavioral
- In a fresh agent session, invoke the `switchboard-contracts` skill and ask "how do I know a dispatched plan is finished?" — correct answer (mtime advance, no board move) without reading source. Confirm the skill is present in an *installed* (non-dev) workspace after plugin install.
- `GET /catalog` shows `payloadKeys` for a sampled verb; calling that verb over HTTP with exactly those fields succeeds.
- Set a deliberately stripped prompt override for the coder role, dispatch a throwaway plan → the coder still receives the completion directive and the card's light clears on its final plan-file edit.

## Effort note
One short session: the doc is distillation of already-verified facts, the generator change is bounded static extraction with an honest fallback, and the guard is a few lines plus a comment.

---
**Recommendation:** Complexity 4 → **Send to Coder**.
