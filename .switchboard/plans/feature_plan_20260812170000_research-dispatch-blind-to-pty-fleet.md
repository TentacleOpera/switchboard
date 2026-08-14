# Retire /research/dispatch And The Researcher Hand-Off Prompt Directive

*(Filename retained from this card's original framing — "research dispatch blind to pty fleet" — so the board card keeps its identity. The approach has changed from repair to retirement; see the Superseded callout below.)*

## Goal

Delete `/research/dispatch`, its host callback, its VS Code-terminal resolution, and the `RESEARCHER HAND-OFF` block injected into planner prompts — together with the entire prompt-time "is a researcher configured" branch that exists only to decide whether to inject it. The researcher hand-off becomes what every other agent relationship already is: a standing order plus a `/terminals/relay` call. One mechanism instead of two, and the one that survives is the one that works on the pty fleet.

### Problem analysis — how the endpoint was found to be broken

Observed 2026-08-12. A planner following the `RESEARCHER HAND-OFF` directive POSTed to the documented endpoint:

```
POST http://127.0.0.1:62500/research/dispatch
{"workspaceRoot":"/Users/patrickvuleta/Documents/GitHub/switchboard","prompt":"..."}
→ 200 {"dispatched":false,"reason":"researcher agent is not live"}
```

The fleet at that moment, from `POST /terminals/verb/ptyListTerminals`:

```json
{ "friendlyName": "researcher-1", "role": "researcher", "status": "active",
  "pid": 52005, "parentRoot": "/Users/patrickvuleta/Documents/GitHub/switchboard" }
```

8 active fleet terminals (6 planner, 1 researcher, 1 coder), 0 hidden. The researcher was live, in this workspace, correctly roled.

**Why it reported otherwise.** `_dispatchResearchToResearcher` (`src/services/TaskViewerProvider.ts:4790`) resolves the researcher against **two VS Code-only pools** and no others — `this._registeredTerminals` (a `Map<string, vscode.Terminal>`) and `vscode.window.terminals`. Neither contains node-pty fleet terminals; those live in a separate ptyHost process reachable only through `_ptyHostVerb('ptyListTerminals', …)`. A fleet-only researcher misses both lookups and lands on the `not live` branch — which means "not live" but fires for "not a `vscode.Terminal`".

**Operator-visible cost.** The planner silently downgrades to the chat-paste fallback and prints a 60-line research prompt into the conversation while the agent that exists to run it sits idle. Indistinguishable from "you have no researcher".

**The manual path worked first time.** In the same session, relaying the identical prompt to `researcher-1` over `POST /terminals/relay` (`from: planner-5`) returned `{"success":true,"delivered":"researcher-1"}` and the researcher answered. The fleet transport was never the problem; the endpoint's VS Code-shaped view of the fleet was.

### Why retire rather than repair

> **Superseded:** Add a node-pty fleet lookup as a third pool after the two VS Code lookups, keeping `/research/dispatch` as the researcher hand-off mechanism.
> **Reason:** It preserves a second, redundant mechanism for something the fleet already does natively, and preserves it in the wrong priority order (VS Code first, fleet as fallback) at a moment when the product is moving the other way. The teams work names *"the researcher hand-off as a conditional prompt directive"* as one of five overlapping mechanisms it exists to collapse, and its relationship vocabulary — now landed — makes a team install a `researcher` standing order on the head naming its researcher instance. A planner therefore already knows who its researcher is and reaches it the same way it reaches any other terminal. A repaired `/research/dispatch` would be a parallel path to the same outcome, carrying its own liveness model, its own reason strings, and its own response-shape hazard.
> **Replaced with:** Delete the endpoint, the callback, the resolution method, the prompt directive and the prompt-time researcher probe. The replacement is the `researcher` relationship plus `/terminals/relay` — the pty messaging system, which is the only messaging path that works when pty terminals exist.

### What the endpoint contributed that must not be lost

One thing, and it is load-bearing: `_dispatchResearchToResearcher` appends the save instruction host-side —

```ts
const fullPrompt = `${prompt}\n\nIMPORTANT: After completing the research, save the results to ${savePath} using the write_to_file tool so the plan author can review them later.`;
```

Without it a researcher's answer is unreachable: the pty verb surface exposes **no scrollback read**, so findings that are neither saved nor relayed back are lost. `feature_plan_20260813060000_researcher-relationship-has-no-return-path.md` moves that instruction — plus the return address the endpoint never had — into the `researcher` relationship's member-side template. **That plan must land before this one.**

## Metadata

- **Complexity:** 3
- **Tags:** backend, api, refactor, cli
- **Project:** Browser Switchboard

## Current State (verified at HEAD, 2026-08-14)

Every deletion target confirmed by direct read; the line numbers in the original plan had all drifted and are corrected here. **The scope is larger than originally written** — the directive is not one block in one string, it is one arm of a two-variant branch with a live probe behind it.

| Target | Location at HEAD |
| :--- | :--- |
| Route arm | `LocalApiServer.ts:3983` |
| Handler `_handleResearchDispatch` | `LocalApiServer.ts:2417` (docblock from `:2417`) |
| `onDispatchResearch` option | `LocalApiServer.ts:279` |
| Callback wiring | `TaskViewerProvider.ts:2756-2760` |
| `_dispatchResearchToResearcher` | `TaskViewerProvider.ts:4790` |
| `RESEARCHER HAND-OFF` text | `agentPromptBuilder.ts:859-861` (`ADVISE_RESEARCH_DIRECTIVE_HANDOFF`) |
| Directive variant selector | `agentPromptBuilder.ts:1352` |
| `researcherConfigured` option | `agentPromptBuilder.ts:227`, read at `:1177` |
| Prompt-time probe `isResearcherConfigured` | `TaskViewerProvider.ts:6105` |
| Probe call site | `KanbanProvider.ts:5009-5010` |

Three findings change the work:

1. **The directive is already split into two variants, and a naive block-deletion loses text.** `ADVISE_RESEARCH_DIRECTIVE_BASE` (`:858`) holds the shared instruction; `_HANDOFF` (`:859-861`) and `_NO_RESEARCHER_TAIL` (`:862`) are the two tails, and `ADVISE_RESEARCH_DIRECTIVE` / `..._NO_RESEARCHER` (`:863-864`) are BASE + each tail. The closing sentence *"If you are confident about everything, state that no research is needed and omit the section, the hand-off, and the prompt."* appears in **both tails and in neither BASE** — so deleting `_HANDOFF` alone silently drops it from the researcher-configured path. The correct end-state is that the two variants **collapse into one**.
2. **The whole `researcherConfigured` chain becomes dead.** It has exactly one consumer: the ternary at `:1352` selecting between the two variants. Collapse the variants and `isResearcherConfigured` (TaskViewerProvider), its `KanbanProvider` call, and the `researcherConfigured` option field all lose their only caller. Leaving them is not neutral — `isResearcherConfigured`'s docblock describes deciding "whether to include the Researcher Hand-Off directive", which would become a comment about nothing, and the probe would keep running a role lookup on every planner prompt build for no reason.
3. **The `_NO_RESEARCHER_TAIL` already contains a dangling reference — fix it on the way out.** It instructs the agent to *skip the "Researcher Hand-Off" section in the skill file entirely*. `.agents/skills/advise_research/SKILL.md` has **no such section** (grep: zero hits for `Researcher`, `Hand-Off`, `research/dispatch`, `dispatched`). This is pre-existing dead text; the surviving single directive must not carry it forward.

Two original concerns are **resolved and cost nothing**:

- **The catalog is runtime-generated, not checked in.** `/catalog` is served by `_handleGetCatalog` (`LocalApiServer.ts:4019`) and enumerates routes at request time. There is no committed catalog artefact and no `apiEndpointCount` constant anywhere in `src/`. The deletion is reflected automatically.
- **There is no documentation surface to edit.** Grep for `research/dispatch`, `onDispatchResearch`, `_dispatchResearchToResearcher` and `RESEARCHER HAND-OFF` across `.agents/`, `.claude/`, `AGENTS.md` and `CLAUDE.md` returns **zero hits** — every reference is in `src/`. Proposed Change 5 is therefore a confirmation step, not an editing task, and no mirror regeneration is required.

## User Review Required

- None. Retirement over repair was chosen deliberately on 2026-08-13 with the alternatives on the table.

## Complexity Audit

### Routine

- Deleting one route arm, one handler, one options field, one callback wiring, one private method.
- Deleting one probe method and its single call site.

### Complex / Risky

- **Sequencing is the whole risk.** Deleting the endpoint before the replacement exists leaves an interval in which no path closes the research loop. See `## Dependencies`.
- **The directive collapse is text surgery, not a block delete.** Getting it wrong silently drops the "if you are confident, omit it" instruction from every planner prompt that previously took the researcher-configured path. See Current State finding 1 and Proposed Change 1 — the acceptance check is reading a delivered prompt, not reading the diff.
- **In-flight agents on the old directive.** ~4,000 installs; an agent whose prompt was built before the deletion will still POST to the route. It gets a 404, and the directive's own rule — *"any non-200 OR `dispatched` not `true` → fall back"* — makes that a clean downgrade to chat-paste. The deletion is therefore safe without a compatibility shim, but only because the caller was written to branch on the status code. **Do not replace the route with a stub that returns 200.**
- **Half-deletion.** Pulling the route arm while leaving the handler, or the callback while leaving the method, turns documented invariants into comments describing code that no longer runs. The verification step greps for every identifier rather than trusting the edit.

## Edge-Case & Dependency Audit

1. **The standalone host has nothing to delete.** `grep -c onDispatchResearch src/standalone/bootstrap.ts` → **0** (re-confirmed at HEAD). The callback was only ever wired in the extension host, so under `npx switchboard` the route already returns HTTP 503. Retirement removes an asymmetry rather than creating one — and closes the PRD contract #7 Layer-2 gap by deleting the layer instead of building it.
2. **Planners with no team keep working.** With no `researcher` standing order installed, a planner has no researcher to relay to and falls back to pasting the prompt into its summary — exactly today's behaviour when no researcher is live. After the variant collapse this is the **only** behaviour, which is why the surviving directive must retain the chat-summary fallback wording verbatim.
3. **`.agents/skills/advise_research/SKILL.md` needs no edit.** It never mentions the endpoint (zero grep hits). It also never had the "Researcher Hand-Off" section the old no-researcher tail told agents to skip — see Current State finding 3. Leave the skill file alone; fix the directive that misdescribes it.
4. **`_getAgentNameForRole('researcher', …)` survives.** Confirmed three surviving callers at HEAD (`TaskViewerProvider.ts:4859`, `:5015`, plus source-level assertions in `browser-direct-terminal-helpers.test.js` and `browser-stray-dispatch-surface.test.js`). Delete only `_dispatchResearchToResearcher` and `isResearcherConfigured`; do not follow the call graph into shared helpers.
5. **Two existing tests assert on `_getAgentNameForRole` call shapes.** `browser-direct-terminal-helpers.test.js:187` and `browser-stray-dispatch-surface.test.js:117-120` match the source text of *other* methods (`_handleSendAnalystMessage`, `_handleAirlockSendToCoder`). Neither references the research path, so both stay green — but they are source-text assertions over `TaskViewerProvider.ts`, so confirm they still pass after a deletion in that file rather than assuming isolation.
6. **`withTerminalSendLock` / `sendRobustText` survive.** Both are general-purpose. This method is one of many callers.
7. **`switchboard.research.localFolderPaths` survives.** The setting still names where research is saved; the researcher relationship's member template names the same `.switchboard/docs/` default. Do not delete the setting.
8. **Response-shape hazard retires with the route.** The handler's long docblock documents at length that the body must stay `{dispatched, …}` with no `success` sibling — an observed P0 where agents announced phantom hand-offs. Deleting the route deletes the hazard; make sure the deletion takes the whole handler, not just the arm, so the comment does not survive as a description of nothing.
9. **The 404-vs-200 reason-string contract retires too.** `reason === 'no researcher agent configured'` → 404, everything else → 200. Nothing else keys on those literals.
10. **The phantom-hand-off comment in `KanbanProvider` goes with the probe.** `KanbanProvider.ts:5006-5008` explains the probe as avoiding "no wasted POST, no false-success path. Mirrors the runtime `_dispatchResearchToResearcher` check." Both referents are being deleted; the comment must not outlive them.
11. **`resolvedOptions` is a plain options bag.** Removing `researcherConfigured` from `KanbanProvider`'s assignment and from the `agentPromptBuilder` options interface is a compile-time-checked pair. Nothing persists this field, so there is no stored state to migrate.
12. **Race conditions / security.** None. Removing an endpoint removes surface.

## Dependencies

- `sess_none — no external session dependency.`
- **Hard prerequisite: `feature_plan_20260813060000_researcher-relationship-has-no-return-path.md`.** It relocates the save instruction and adds the return address that this endpoint's replacement needs. Land it first, or the loop is open in the interval.
- **The teams relationship vocabulary is already satisfied** at HEAD (`1bd39f4a`) — `linkPresets.ts`, `direction` and `wireSpawnedTeam`'s direction branch all exist, so the `researcher` relationship this retirement defers to is real, not pending.
- **No file conflict** with either sibling: this plan touches `LocalApiServer.ts`, `TaskViewerProvider.ts`, `KanbanProvider.ts` and `agentPromptBuilder.ts`. The return-path plan touches `linkPresets.ts`, `terminals.js`, `teamWiring.ts`, `standingOrders.ts` and the mirror test; the link-up plan touches `terminals.js` only. Disjoint.

## Adversarial Synthesis

Key risk is ordering, not code: the deletions are small and mechanical, but performed before the researcher relationship's return-path companion exists they remove the only working hand-off and leave nothing behind. The second risk is the one the original framing understated — treating the directive as a self-contained block to excise, when it is one arm of a two-variant branch whose shared closing sentence lives only in the tails. A block-delete compiles, passes every gate, and quietly ships planner prompts that no longer tell the agent it may omit the research section entirely; the only way to catch it is to read a delivered prompt. The third is a half-deletion — pulling the route arm while leaving the handler, or the directive while leaving the probe that fed it — which turns documented invariants into comments describing code that no longer runs. Mitigations: the strict prerequisite chain in `## Dependencies`, an explicit collapse-to-one-directive step rather than a delete, and a verification pass that greps for every identifier and reads one real prompt.

## Proposed Changes

### 1. `src/services/agentPromptBuilder.ts` — collapse the two directive variants into one

**Context.** `ADVISE_RESEARCH_DIRECTIVE_BASE` at `:858`; `ADVISE_RESEARCH_DIRECTIVE_HANDOFF` at `:859-861`; `ADVISE_RESEARCH_DIRECTIVE_NO_RESEARCHER_TAIL` at `:862`; the two exports at `:863-864`; the explanatory comment at `:852-857`; the selector at `:1352`; the option field at `:227` and its read at `:1177`.

**Logic.** With no endpoint there is nothing to branch on, so there should be exactly one exported directive. Build it as BASE plus the surviving fallback tail. Do **not** simply delete `_HANDOFF` and leave the ternary — that keeps a dead branch and drops the shared closing sentence from the researcher path (Current State finding 1).

**Implementation.**

- Delete `ADVISE_RESEARCH_DIRECTIVE_HANDOFF` entirely.
- Fold the surviving tail into a single export. The tail keeps the chat-summary fallback and the confident-omit sentence, and **drops** the two clauses that no longer describe anything: the *"No Researcher agent is configured for this workspace"* preamble (there is no longer a configured/not-configured distinction) and *"skip the 'Researcher Hand-Off' section in the skill file entirely"* (that section does not exist — Current State finding 3). Resulting shape:

```ts
// One directive, not two. The researcher hand-off was an HTTP POST to
// /research/dispatch, retired in favour of the `researcher` relationship
// (a standing order + /terminals/relay). With no endpoint there is nothing
// to branch on, so the prompt-time "is a researcher configured" probe went
// with it — see TaskViewerProvider.isResearcherConfigured (deleted).
export const ADVISE_RESEARCH_DIRECTIVE = ADVISE_RESEARCH_DIRECTIVE_BASE
    + ` Supply the ready-to-run research prompt at the very end of your chat summary so the user can`
    + ` trigger web research themselves. If you are confident about everything, state that no research`
    + ` is needed and omit the section, the hand-off, and the prompt.`;
```

- Delete `ADVISE_RESEARCH_DIRECTIVE_NO_RESEARCHER` and update `:1352` to append the single directive unconditionally.
- Delete `researcherConfigured` from the options interface (`:227`) and its read (`:1177`).
- Rewrite the `:852-857` comment: it currently explains the two-variant split and the P0 it was built to prevent. That P0 (a planner announcing a phantom hand-off) is now prevented by construction — there is no POST to misread — so the comment should record that outcome, not the mechanism that is being removed.

**Edge cases.** BASE ends with *"Then build the ready-to-run research prompt."* and the appended tail begins *" Supply the ready-to-run…"* — check the join renders as one paragraph with single spacing, no doubled space and no fused sentence. The old `_HANDOFF` tail opened with `\n\n`; the surviving tail must **not**, or the emitted prompt gains a stray blank line where a sentence continuation belongs.

### 2. `src/services/LocalApiServer.ts` — delete the route, the handler and the option

**Context.** Route arm at `:3983`; `_handleResearchDispatch` at `:2417`; `onDispatchResearch` in the options interface at `:279`.

**Logic.** Delete all three. Do not leave a stub arm — a 200-returning stub would defeat the in-flight agents' fallback branch (Complexity Audit).

**Edge cases.** The handler's long explanatory docblock — the `{dispatched}`-not-`{success}` response-shape contract and the 404-vs-200 reason-string rule — goes with the handler; it documents a contract that no longer exists. Take the whole method, not just its body.

### 3. `src/services/TaskViewerProvider.ts` — delete the callback wiring, the resolution method and the prompt-time probe

**Context.** `onDispatchResearch: async (workspaceRoot, prompt) => …` at `:2756-2760`; `_dispatchResearchToResearcher` at `:4790` through the end of the method; `isResearcherConfigured` at `:6105` with its docblock at `:6098-6104`.

**Logic.** Delete all three. `isResearcherConfigured` exists solely to feed the directive selector being collapsed in Change 1, and its docblock explicitly describes deciding "whether to include the Researcher Hand-Off directive" — a comment that would survive as a description of nothing.

**Edge cases.** Leave `_getAgentNameForRole`, `_suffixedName`, `_normalizeAgentKey`, `_stripIdeSuffix`, `_resolveWorkspaceRoot`, `withTerminalSendLock` and `sendRobustText` untouched — all have other callers (Edge-Case 4). The `_dispatchResearchToResearcher` Design Decision comment (never route through `sendPromptToAgentTerminal`, because it would spawn) is specific to this method and goes with it; confirm no other method's comment cites it as the rationale.

### 4. `src/services/KanbanProvider.ts` — delete the probe call site

**Context.** `:5006-5010` — the explanatory comment and the `resolvedOptions.researcherConfigured = …` assignment inside the `role === 'planner'` branch.

**Logic.** Delete the assignment and the comment together. Both referents named in the comment (`_dispatchResearchToResearcher`, the hand-off directive) are being deleted in this same change.

**Edge cases.** The `this._taskViewerProvider ? … : false` guard exists only for this call; nothing else in the branch depends on the provider being present. The surrounding planner-option assignments (`adviseResearchIfUnsure`, `plannerWorkflowPath`, …) are untouched — in particular `adviseResearchIfUnsure` **survives**: the research add-on itself is not being retired, only its hand-off arm.

### 5. Confirmation sweep (no edits expected)

**Logic.** Grep `research/dispatch`, `onDispatchResearch`, `_dispatchResearchToResearcher`, `isResearcherConfigured`, `researcherConfigured` and `RESEARCHER HAND-OFF` across `src/`, `.agents/`, `.claude/`, `AGENTS.md` and `CLAUDE.md`. At HEAD the non-`src/` surfaces are already clean (Current State), so this is a confirmation that the deletion is complete and that no control-plane doc acquired a reference in the meantime — **not** an editing task. If a hit does appear under `.agents/` or `AGENTS.md`, edit those at source and regenerate the `CLAUDE.md` / `.claude/skills` mirrors rather than hand-editing the mirrors.

## Verification Plan

Manual. Per session directive, no compilation step and no automated test run is part of this plan.

1. **The route is gone.** `POST /research/dispatch` returns **404**, not 200 and not 503.
2. **No stub survives.** Grep returns zero hits across `src/` for `research/dispatch`, `onDispatchResearch`, `_dispatchResearchToResearcher`, `isResearcherConfigured` and `researcherConfigured`.
3. **The directive collapsed correctly — read the prompt, not the diff.** Dispatch a planner with the research add-on enabled and read the delivered prompt. It must contain: no `RESEARCHER HAND-OFF` block; the chat-summary fallback sentence; **and** the closing *"If you are confident about everything, state that no research is needed…"* sentence. That last one is the specific casualty of a naive block-delete and is invisible in review.
4. **Both former paths now emit the same text.** Dispatch a planner in a workspace with a researcher-role agent configured and one without. The research section must be byte-identical in both — proving the branch is genuinely gone rather than defaulting.
5. **Joins are clean.** In the same delivered prompt, confirm the research paragraph reads as one paragraph: no doubled blank line, no fused sentence, no doubled space at the BASE/tail seam.
6. **The replacement works end to end.** With a team carrying a `researcher` member, hand the head a question that needs research. It relays to the researcher per its standing order; the researcher saves to `.switchboard/docs/` and relays a summary back. This is the acceptance test for the retirement — if it does not pass, the prerequisite plan has not landed and this one must not either.
7. **No team, honest degradation.** With no researcher standing order, confirm the planner pastes the ready-to-run prompt into its summary and says no hand-off occurred.
8. **In-flight agents downgrade cleanly.** From an agent still carrying the old directive, POST the route and confirm the 404 sends it down the chat-paste branch rather than stalling or announcing a phantom hand-off.
9. **Standalone unaffected.** Under `npx switchboard`, confirm the route is absent (previously 503) and nothing else regressed — the callback was never wired there.
10. **Catalog reflects the deletion automatically.** `GET /catalog` no longer lists `/research/dispatch`, with no regeneration step — it is built at request time.
11. **Gates.** Run `npm run parity:check` and `npm run push-routing:check` and confirm the endpoint deletion reds neither.
12. **Neighbouring source-text tests still pass.** `browser-direct-terminal-helpers.test.js` and `browser-stray-dispatch-surface.test.js` assert on `_getAgentNameForRole` call shapes inside `TaskViewerProvider.ts`; confirm a deletion in that file left both green (Edge-Case 5).
13. **Unrelated helpers intact.** Start a role-based terminal and confirm naming and role assignment are unchanged, and that the analyst and airlock send paths still resolve their agents.

### Automated Tests

None added, and none run in this pass (session directive). No existing contract test covers `/research/dispatch`; its invariants lived only in the comments being deleted with it. The two source-text tests named in Edge-Case 5 touch the same file but not this code path — they are a regression check, not coverage of the retirement.

## Recommendation

Complexity 3 → **Send to Intern**, with the caveat that Change 1 is text surgery on a shared string rather than a block deletion, and verification steps 3–5 are what catch getting it wrong. Land **last** in this feature: researcher return path → link-up preset delivery (independent) → this.
