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

> **Superseded:** Gap #3's stated mechanism — "Role prompts are user-overridable (`defaultPromptOverrides`, `agentPromptBuilder.ts:184/302/1632-1633`). If an override drops the directive, completion detection breaks silently" — framed as a single, uniform exposure across all dispatched roles.
> **Reason:** Verified against source during this review (2026-07-10). The exposure is **not uniform** — it is per-role, and for the three roles the plan implicitly targets (coder/lead/intern) it does **not exist**:
> - **lead / coder / intern (main path, `buildKanbanBatchPrompt`):** `CODING_COMPLETION_REPORT_DIRECTIVE` is appended **after** `resolveBaseInstructions(...)` runs (lines 1142 / 1194 / 1238 / 1276). `resolveBaseInstructions` (`:297-318`) is the only place the override is applied for these roles, and it applies to `base` — the directive append that follows is separate and unconditional. A `replace`/`prepend`/`append` override on these roles **cannot drop the directive today.** The plan's "silently breaks" claim is false for exactly the roles most likely to be overridden.
> - **reviewer (`:981`):** completion is signalled by a plan-file-edit instruction **embedded in its base** (numbered step 6: "Update the original plan file…"), not by `CODING_COMPLETION_REPORT_DIRECTIVE`. That instruction lives inside `base`, so a `replace`-mode override on the reviewer role **does** drop it — a genuine silent-breakage exposure the plan missed.
> - **tester (`:1055`):** no plan-file-edit or completion instruction found in its branch at all; how a tester card clears is unverified (flagged for the user, below).
> - **custom agents (`buildCustomAgentPrompt`, `:1510-1640`):** the directive is **never** composed in, for any custom agent, override or not. Its `replace` mode (`:1636`) rebuilds the prompt from `planList` alone, discarding every composed block. This function takes **no `role` parameter** and `CustomAgentAddons` carries no code-touching flag, so the guard "for `CODE_TOUCHING_ROLES`" as written is not directly evaluable here.
> **Replaced with:** the corrected, per-role guard specification in Scope #3 below. The user's policy decision (hard guarantee, idempotent, code-touching roles) is preserved; only the *implementation map* is corrected.

## Metadata
- **Tags:** docs, refactor, api, reliability
- **Complexity:** 5

> **Superseded:** Complexity 4.
> **Reason:** Item #3 is subtler than a "few lines plus a comment" once the per-role divergence is accounted for (main path already-safe, reviewer base-embedded exposure, custom-agent no-role/no-flag problem), and item #2 requires a brace-matching object-literal parser with honest dynamic-classification, not a single regex extension. Two moderate, well-scoped risks on top of a routine doc/skill body → Mixed (5).
> **Replaced with:** Complexity 5 (still "Send to Coder", 4-6 band — recommendation unchanged).

## User Review Required
- **Doc location — resolved (user decision):** it ships as a **skill**, `.agents/skills/switchboard-contracts/SKILL.md`, because the `docs/` folder is not deployed with the extension while `.agents/skills/` is distributed with the plugin. (A new skill folder also sidesteps the overwrite:false propagation freeze that affects *updates* to existing skills — new files copy cleanly on install.)
- **Override guard behavior — resolved (user decision, 2026-07-10): hard guarantee.** Unconditionally re-append `CODING_COMPLETION_REPORT_DIRECTIVE` after any override is applied for code-touching roles (idempotent — never double-append). The directive is the completion-protocol handshake, not a stylistic choice, and is deliberately non-overridable.
- **Guard coverage — NEW open questions surfaced by this review (2026-07-10).** The per-role audit (see the Root-cause callout and Scope #3) changes what "code-touching roles" means in practice. Three decisions the coder needs:
  1. **reviewer** — its completion signal is a base-embedded "update the plan file" instruction (step 6), which a `replace`-mode override genuinely drops. Should the guard normalise reviewer onto `CODING_COMPLETION_REPORT_DIRECTIVE` too (so its completion signal is override-proof like coder/lead/intern), or leave reviewer's bespoke step-6 mechanism as-is? **Planner recommendation:** bring reviewer under the same idempotent guard — it is the one role with a real, current override-drop exposure.
  2. **tester** — no completion/plan-edit instruction found in its branch; how a tester card clears today is unverified. In scope to add the directive, or explicitly out of scope pending confirmation of tester's lifecycle? **Planner recommendation:** out of scope for this plan; open a separate investigation — adding a spurious directive could be wrong if testers intentionally never edit the plan file.
  3. **custom agents** — `buildCustomAgentPrompt` has no `role` and `CustomAgentAddons` has no code-touching flag. To guard here we must infer "touches code" from an available signal (git policy: commit/push strategy set and guardrail off). Accept the git-policy heuristic, add an explicit `codeTouching` addon flag, or leave custom agents out of scope? **Planner recommendation:** add the directive after the override block using the git-policy heuristic (writes ⇒ needs completion signalling), and note the heuristic in a comment; a dedicated flag is cleaner but expands the addon surface and the UI that populates it.
- Otherwise: None — no other open questions.

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

   > **Superseded:** "Composition guarantee: after `defaultPromptOverride` application (`:1632-1633`), unconditionally re-append `CODING_COMPLETION_REPORT_DIRECTIVE` for code-touching roles (`CODE_TOUCHING_ROLES`, `:721`) if the composed prompt no longer contains it." (single guard, at the custom-agent override site).
   > **Reason:** As established in the Root-cause callout, the exposure is per-role and `:1632-1633` is the custom-agent path, which (a) has no `role` to test against `CODE_TOUCHING_ROLES` and (b) never composed the directive in the first place. A single re-append there fixes neither the main path (already safe) nor reviewer (base-embedded, different mechanism). The guard must be role-aware and split across the two prompt-builder functions.
   > **Replaced with** the per-role specification below.

   **Current state (verified 2026-07-10):**

   | Role | Completion signal today | Override-droppable? | Guard action |
   | :--- | :--- | :--- | :--- |
   | lead / coder / intern | `CODING_COMPLETION_REPORT_DIRECTIVE` appended after override (`:1142/1194/1238/1276`) | **No** — append is post-override & unconditional | Route the four appends through a shared idempotent helper (below). Defensive: makes the invariant explicit so a future reorder can't regress it. |
   | reviewer (`:981`) | base-embedded step-6 "update the plan file" instruction | **Yes** — lives in `base`, dropped by a `replace` override | *(pending User Review decision)* bring under the idempotent guard on the reviewer branch. |
   | tester (`:1055`) | none found | n/a | *(pending User Review decision — likely out of scope)* |
   | custom agents (`buildCustomAgentPrompt`) | none — never composed | **Yes** — `replace` mode (`:1636`) discards the whole prompt | Append the directive **after** the override block (after `:1637`) when the agent is code-touching (git-policy heuristic — see User Review), idempotent. |

   **Concrete changes:**
   - Add a small idempotent helper `ensureCompletionDirective(text: string): string` — appends `CODING_COMPLETION_REPORT_DIRECTIVE` only if `text` does not already contain the sentinel `COMPLETION REPORT:` (the directive's leading token). Never double-appends.
   - **Main path (`buildKanbanBatchPrompt`):** replace the four raw `baseInstructions += '\n\n' + CODING_COMPLETION_REPORT_DIRECTIVE` lines (`:1142/1194/1238/1276`) with `baseInstructions = ensureCompletionDirective(baseInstructions)`. Behaviour-identical today (directive absent ⇒ appended once); the value is that the invariant is now named and centralised. Extend to the reviewer branch per the User Review decision.
   - **Custom path (`buildCustomAgentPrompt`):** after the override block (`:1632-1637`), `prompt = ensureCompletionDirective(prompt)` **guarded by the code-touching heuristic** (e.g. `gitCommitStrategy`/`gitPushStrategy` indicates writes and `gitProhibition`/`gitProhibitionEnabled` is not set). This is the only place a real "override wipes the directive" scenario exists, and it currently has no directive at all — closing a latent gap, not just hardening an existing guarantee.
   - **Load-bearing comment on the constant (`:572`):** name the three consumers (activity light, autoban, Manage oversight passes) and the helper, so no future refactor treats it as prose or removes the post-override placement.
   - **Cross-reference:** one line in the `switchboard-contracts` skill (Scope #1) documenting the guarantee. *(Corrects the original bullet's reference to `docs/agent_contracts.md`, which was superseded to the skill in Scope #1 — that file is not shipped.)*

### ⚙️ OUT OF SCOPE
- Full payload *type* documentation or JSON-schema per verb — key names only; types remain the arm's own validation concern.
- Any UI for viewing contracts or payload keys — file + catalog JSON is the surface.
- Changes to the Remote Manager feature's plans (frozen, mid-coding). This plan lands after and independently.
- Rewriting the user manual — it stays human/UI-facing.

## Implementation Steps
1. Write `.agents/skills/switchboard-contracts/SKILL.md` per Scope #1 (source every claim against current code at write time — do not copy this plan's line numbers blindly).
2. Add the skill pointers to the `switchboard-orchestration` skill and both `switchboard-manage` SKILL.md copies (body-only; preserve per-host frontmatter); add the `switchboard-contracts` row to the `AGENTS.md`/`CLAUDE.md` skills table.
3. Extend `scripts/generate-protocol-catalog.js` with payload-key extraction per Scope #2; regenerate `protocol-catalog.json`; confirm `catalog:check` treats the new field as part of the drift check.
4. `agentPromptBuilder.ts`: add `ensureCompletionDirective()` helper; route the four main-path appends (`:1142/1194/1238/1276`) through it; add the guarded post-override append in `buildCustomAgentPrompt` (after `:1637`); apply the User-Review decisions for reviewer/tester; add the load-bearing comment on the constant (`:572`). Do not re-derive line numbers blindly — confirm each site at edit time.
5. Gates: `npm run catalog:check`, `npm run parity:check` green. *(This session runs no compilation or tests per session directive; these gates are for the implementing coder.)*

## Complexity Audit
### Routine
- The contracts doc (prose, one page, facts already verified in source).
- Skill pointer additions; load-bearing comment.
### Complex / Risky
- **Payload-key static extraction**: webview call sites vary (object literals, shorthand, spreads, variables). Extracting keys means brace-matching the `{…}` after `postMessage({ type: '…'` and reading top-level keys — the existing `type`-only regex does not do this. The parser must classify honestly — a wrong `payloadKeys` list is worse than `"dynamic"`, because agents will trust it. Prefer under-claiming: any spread (`...x`), computed key (`[k]`), or non-object-literal argument ⇒ `"dynamic"`.
- **Per-role override guard correctness**: the guard is role-aware and split across two functions (see Scope #3 table). Must be idempotent (no double-append when `COMPLETION REPORT:` already present); must NOT fire for non-code-touching roles (planner/architect/chat legitimately lack it); the custom-agent branch has no `role` and must infer code-touching from git policy without a false positive on read-only agents.

## Edge-Case & Dependency Audit
- **Race Conditions:** None — docs, a generator, and prompt composition.
- **Security:** None new. Payload keys expose field *names* already visible in the shipped webview source.
- **Side Effects:** Regenerating `protocol-catalog.json` adds a field to a checked-in file consumed by `catalog:check`, the A2b allowlist generator, and the parity gate — verify all three tolerate (ignore or incorporate) `payloadKeys` before merging. The directive guard changes composed prompt text for overridden roles — users with existing overrides will see the directive reappear; that is the intent, but note it in the changelog.
- **Dependencies & Conflicts:** Item #2 touches the same generator the A2b passthrough plan extends (allowlist emission) and item #1's skill pointers touch the same SKILL.md files the UX overhaul rewrites — **land this plan after the Remote Manager feature merges** to avoid editing files mid-flight. No other conflicts.

## Dependencies
- Remote Manager feature (`a2b-generic-verb-passthrough-vscode-running.md`, `switchboard-manage-skill-ux-overhaul.md`) — sequence this plan **after** it merges (shared generator + SKILL.md surfaces).
- `protocol-catalog.json` `requestSites[]` (present) — the payload-extraction input.

## Adversarial Synthesis
Key risks: (1) payload extraction over-claiming on dynamic call sites — mitigated by brace-matching + classifying anything non-literal as `"dynamic"` and preferring under-claim; (2) the guard aiming at the wrong site — the original single re-append at `:1632` would have been a no-op for the roles it named (main path already safe) and unevaluable (custom path has no `role`), while the one real current exposure (reviewer's base-embedded step-6 under a `replace` override) went unaddressed — mitigated by the corrected per-role spec in Scope #3; (3) the contracts skill drifting from code — mitigated by citing the source file for every contract so staleness is checkable, and keeping it to contracts (slow-moving) not mechanics.

## Proposed Changes
### .agents/skills/switchboard-contracts/SKILL.md (new skill)
- One-page behavioral contracts list per Scope #1, each fact with its source file citation; invocation-scoping preamble in the description and body.
### .agents/skills/switchboard-orchestration/SKILL.md, .agents/skills/switchboard-manage/SKILL.md + .claude mirror, AGENTS.md/CLAUDE.md
- One-line pointer: consult the `switchboard-contracts` skill for behavior when unsure; never for invocation (catalog/orchestration skill are the invocation authority). Body-only edits; new row in the skills table.
### scripts/generate-protocol-catalog.js + protocol-catalog.json
- Payload-key extraction per request site; `payloadKeys` per verb; `"dynamic"` for non-literal payloads; regenerated catalog checked in.
### src/services/agentPromptBuilder.ts
- New `ensureCompletionDirective(text)` idempotent helper (append only if `COMPLETION REPORT:` absent).
- Main path (`buildKanbanBatchPrompt`): route the four existing appends (`:1142/1194/1238/1276`) through the helper; extend to reviewer per User Review decision.
- Custom path (`buildCustomAgentPrompt`): guarded post-override append (after `:1637`) using the git-policy code-touching heuristic — closes the latent gap that custom code-touching agents never receive the directive.
- Load-bearing comment on the constant (`:572`) naming its three consumers (activity light, autoban, Manage oversight passes) and the post-override placement invariant.
- See the Scope #3 per-role table for the current-state audit and exact actions.

## Verification Plan
> Gates below are for the implementing coder. This planning session runs no compilation or automated tests per session directive.

### Automated
- `npm run catalog:check` green with `payloadKeys` present; spot-assert a known literal-payload verb (e.g. `moveCard`-class) lists expected keys and a known dynamic site reports `"dynamic"`.
- `npm run parity:check` green (tolerates the new catalog field).
- Grep the composed prompt for each guarded path: `COMPLETION REPORT:` appears **exactly once** for (a) a coder with a `replace`-mode override, (b) reviewer with a `replace`-mode override (if brought under the guard), and (c) a code-touching custom agent with a `replace`-mode override. Confirm it appears **zero** times for a read-only custom agent (git prohibition on / no write strategy) and for planner/chat.
### Manual / behavioral
- In a fresh agent session, invoke the `switchboard-contracts` skill and ask "how do I know a dispatched plan is finished?" — correct answer (mtime advance, no board move) without reading source. Confirm the skill is present in an *installed* (non-dev) workspace after plugin install.
- `GET /catalog` shows `payloadKeys` for a sampled verb; calling that verb over HTTP with exactly those fields succeeds.
- Set a deliberately stripped `replace` prompt override for the coder role, dispatch a throwaway plan → the coder still receives the completion directive and the card's light clears on its final plan-file edit. Repeat for reviewer and a code-touching custom agent per the guard coverage decided in User Review.

## Effort note
One session: the doc is distillation of already-verified facts, the generator change is bounded static extraction (brace-matcher + honest `"dynamic"` fallback), and the guard is a small helper plus per-role wiring across two functions and one comment. Slightly more than "a few lines" once the per-role divergence and custom-agent heuristic are accounted for — hence Complexity 5, not 4.

---
**Recommendation:** Complexity 5 → **Send to Coder** (resolve the three User-Review guard-coverage decisions first — the planner's recommendations are inline).

## Completion Report

Implemented all three scopes. User-Review guard-coverage decisions resolved per the planner's inline recommendations: reviewer brought under the idempotent guard, tester left out of scope (its step-5 plan-edit instruction is a separate investigation), custom agents guarded via the git-policy code-touching heuristic.

**Scope #1 — switchboard-contracts skill:** created `.agents/skills/switchboard-contracts/SKILL.md` (8 behavioral contracts, each cited to source) + hand-matched `.claude/skills/switchboard-contracts/SKILL.md` mirror (`no-user` invocation); added the manifest entry in `src/services/ClaudeCodeMirrorService.ts`; added behavior-vs-invocation pointer blocks to both copies of the `switchboard-orchestration` and `switchboard-manage` skills (body-only, frontmatter preserved); registered the skill row in `AGENTS.md` + `CLAUDE.md` skills tables.

**Scope #2 — payload-key extraction:** extended `scripts/generate-protocol-catalog.js` with a brace-matching object-literal parser (`extractPayloadKeys`) that tracks string/template-literal/paren/bracket/brace depth and classifies any spread/computed-key/non-literal site as `"dynamic"` (never guesses); attached `payloadKeys` to every request/push site and added a top-level `verbPayloads` per-verb aggregation (conservative — sites that differ ⇒ `"dynamic"`). Regenerated `protocol-catalog.json` (458 literal verbs, 107 verb-level dynamic; 67 of 1200 sites genuinely dynamic). Two parser bugs found and fixed during verification: shorthand keys (`{ tabKey }`) re-armed `expectKey` on the trailing comma, and untracked parens let commas inside call-args (`slice(0, idx)`) re-arm at the object's top level — both caused false `dynamic` bails.

**Scope #3 — write-once directive guard:** added `ensureCompletionDirective(text)` idempotent helper (appends `CODING_COMPLETION_REPORT_DIRECTIVE` only if the `COMPLETION REPORT:` sentinel is absent) in `src/services/agentPromptBuilder.ts`; routed the four main-path appends (lead/coder×2/intern) through it; added the reviewer guard (normalising reviewer's base-embedded step-6 onto the override-proof directive); added the custom-agent post-override guard gated by the git-policy heuristic (`gitCommitStrategy==='whenDone'` || `gitPushStrategy==='pushWhenDone'`) && guardrail off; added a load-bearing comment on the constant naming its three consumers (activity light, autoban, Manage oversight) and the post-override invariant.

**Files changed:** `.agents/skills/switchboard-contracts/SKILL.md` (new), `.claude/skills/switchboard-contracts/SKILL.md` (new), `.agents/skills/switchboard-orchestration/SKILL.md`, `.claude/skills/switchboard-orchestration/SKILL.md`, `.agents/skills/switchboard-manage/SKILL.md`, `.claude/skills/switchboard-manage/SKILL.md`, `AGENTS.md`, `CLAUDE.md`, `src/services/ClaudeCodeMirrorService.ts`, `scripts/generate-protocol-catalog.js`, `protocol-catalog.json`, `src/services/agentPromptBuilder.ts`.

**Verification:** `npm run catalog:check` green (no drift; `payloadKeys` now part of the drift check); `npm run parity:check` green (allowlist ≡ catalog); helper idempotency confirmed (exactly-once in all cases); mirror bodies verified byte-identical to `.agents` source; AGENTS/CLAUDE skill-table rows identical. Compilation and automated tests skipped per session directive — `mirror:check` requires compilation and was not run (the hand-crafted mirror matches current `buildSkillMd` output). Known limitation: a custom agent with `gitCommitStrategy='dontCommit'` that edits code but doesn't commit is not flagged code-touching by the heuristic and won't receive the directive — this matches the plan's explicit verification spec ("no write strategy" ⇒ zero) but is a candidate for a future `codeTouching` addon flag.

## Review Findings

Reviewed 2026-07-10 with advanced regression analysis: no CRITICAL or MAJOR findings; no code fixes required. All five `ensureCompletionDirective` call sites verified post-override (`agentPromptBuilder.ts:1065/1175/1227/1271/1309` after `resolveBaseInstructions`; custom-path guard after the override block), the sentinel exists nowhere else in `src/` (no false idempotency suppression), non-code-touching roles receive no guard, and the custom-agent `gitProhibition ?? gitProhibitionEnabled` read matches the established UI-key convention of the git-policy block. Catalog spot-checks pass (1200/1200 sites carry `payloadKeys`; `moveCards` extracts correct keys; 98 verbs honestly `"dynamic"`), mirror bodies are byte-identical, and `catalog:check` + `parity:check` are green (compilation/tests skipped per session directive). NITs deferred: `verbPayloads` aggregated at catalog top level rather than under `providers.<Name>` as Scope #2 phrased it (functionally equivalent), `payloadKeys` includes the redundant `type` key, unnecessary `as any` casts on typed addon fields, and the auto-commit swept in ~180 lines of unrelated guided-setup removal (no orphaned references — grep clean, allowlist consistent). Remaining risk: the documented heuristic gap (`dontCommit` code-writing custom agents get no directive) stands until a `codeTouching` addon flag exists.
