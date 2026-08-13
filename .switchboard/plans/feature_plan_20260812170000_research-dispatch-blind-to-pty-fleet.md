# Retire /research/dispatch And The Researcher Hand-Off Prompt Directive

*(Filename retained from this card's original framing — "research dispatch blind to pty fleet" — so the board card keeps its identity. The approach has changed from repair to retirement; see the Superseded callout below.)*

## Goal

Delete `/research/dispatch`, its host callback, its VS Code-terminal resolution, and the `RESEARCHER HAND-OFF` block injected into planner prompts. The researcher hand-off becomes what every other agent relationship already is: a standing order plus a `/terminals/relay` call. One mechanism instead of two, and the one that survives is the one that works on the pty fleet.

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

**Why it reported otherwise.** `_dispatchResearchToResearcher` (`src/services/TaskViewerProvider.ts:4685-4695`) resolves the researcher against **two VS Code-only pools** and no others — `this._registeredTerminals` (a `Map<string, vscode.Terminal>`) and `vscode.window.terminals`. Neither contains node-pty fleet terminals; those live in a separate ptyHost process reachable only through `_ptyHostVerb('ptyListTerminals', …)`. A fleet-only researcher misses both lookups and lands on the `not live` branch — which means "not live" but fires for "not a `vscode.Terminal`".

**Operator-visible cost.** The planner silently downgrades to the chat-paste fallback and prints a 60-line research prompt into the conversation while the agent that exists to run it sits idle. Indistinguishable from "you have no researcher".

**The manual path worked first time.** In the same session, relaying the identical prompt to `researcher-1` over `POST /terminals/relay` (`from: planner-5`) returned `{"success":true,"delivered":"researcher-1"}` and the researcher answered. The fleet transport was never the problem; the endpoint's VS Code-shaped view of the fleet was.

### Why retire rather than repair

> **Superseded:** Add a node-pty fleet lookup as a third pool after the two VS Code lookups, keeping `/research/dispatch` as the researcher hand-off mechanism.
> **Reason:** It preserves a second, redundant mechanism for something the fleet already does natively, and preserves it in the wrong priority order (VS Code first, fleet as fallback) at a moment when the product is moving the other way. `teams-as-the-main-model` names *"the researcher hand-off as a conditional prompt directive"* as one of five overlapping mechanisms it exists to collapse, and its subtask 4 makes `relationship` the wiring vocabulary — a team installs a `researcher` standing order on the head naming its researcher instance. Once that lands, a planner already knows who its researcher is and reaches it the same way it reaches any other terminal. A repaired `/research/dispatch` would be a parallel path to the same outcome, carrying its own liveness model, its own reason strings, and its own response-shape hazard.
> **Replaced with:** Delete the endpoint, the callback, the resolution method and the prompt directive. The replacement is the teams `researcher` relationship plus `/terminals/relay` — the pty messaging system, which is the only messaging path that works when pty terminals exist.

### What the endpoint contributed that must not be lost

One thing, and it is load-bearing: `_dispatchResearchToResearcher` appends the save instruction host-side —

```ts
const fullPrompt = `${prompt}\n\nIMPORTANT: After completing the research, save the results to ${savePath} using the write_to_file tool so the plan author can review them later.`;
```

(`TaskViewerProvider.ts:4704`). Without it a researcher's answer is unreachable: the pty verb surface exposes **no scrollback read**, so findings that are neither saved nor relayed back are lost. `feature_plan_20260813060000_researcher-relationship-has-no-return-path.md` moves that instruction — plus the return address the endpoint never had — into the `researcher` relationship's member-side template. **That plan must land before this one.**

## Metadata

- **Complexity:** 3
- **Tags:** backend, api, refactor, cli
- **Project:** Browser Switchboard

## User Review Required

- None. Retirement over repair was chosen deliberately on 2026-08-13 with the alternatives on the table.

## Complexity Audit

### Routine

- Deleting one route arm, one handler, one options field, one callback wiring, one private method.
- Deleting one block from the prompt builder.

### Complex / Risky

- **Sequencing is the whole risk.** Deleting the endpoint before the replacement exists leaves an interval in which no path closes the research loop. See `## Dependencies`.
- **In-flight agents on the old directive.** ~4,000 installs; an agent whose prompt was built before the deletion will still POST to the route. It gets a 404, and the directive's own rule — *"any non-200 OR `dispatched` not `true` → fall back"* — makes that a clean downgrade to chat-paste. The deletion is therefore safe without a compatibility shim, but only because the caller was written to branch on the status code. Do not replace the route with a stub that returns 200.
- **The generated catalog.** `/research/dispatch` appears in the `/catalog` endpoint list (`apiEndpointCount: 80`). Confirm whether the catalog is regenerated from source or checked in, and whether `npm run parity:check` reads it, before assuming the deletion is invisible to the gates.

## Edge-Case & Dependency Audit

1. **The standalone host has nothing to delete.** `grep -c onDispatchResearch src/standalone/bootstrap.ts` → **0**. The callback was only ever wired in the extension host, so under `npx switchboard` the route already returns HTTP 503 (`LocalApiServer.ts:2483-2488`). Retirement removes an asymmetry rather than creating one — and closes the PRD contract #7 Layer-2 gap by deleting the layer instead of building it.
2. **Planners with no team keep working.** With no `researcher` standing order installed, a planner has no researcher to relay to and falls back to pasting the prompt into its summary — exactly today's behaviour when no researcher is live. `.agents/skills/advise_research/SKILL.md` already documents that fallback and needs **no edit**: it never mentions the endpoint. Only the injected directive does.
3. **The directive is injected, not authored per-session.** `src/services/agentPromptBuilder.ts:898` holds the whole `RESEARCHER HAND-OFF` block as a template literal. Deleting it removes the hand-off instruction from every prompt that carries the research add-on; nothing else references the route from the agent side.
4. **`_getAgentNameForRole('researcher', …)` survives.** It is used beyond this method (role resolution generally). Delete only `_dispatchResearchToResearcher`; do not follow the call graph into shared helpers.
5. **`withTerminalSendLock` / `sendRobustText` survive.** Both are general-purpose. This method is one of many callers.
6. **`switchboard.research.localFolderPaths` survives.** The setting still names where research is saved; the researcher relationship's member template names the same `.switchboard/docs/` default. Do not delete the setting.
7. **Response-shape hazard retires with the route.** `LocalApiServer.ts:2505-2521` documents at length that the body must stay `{dispatched, …}` with no `success` sibling — an observed P0 where agents announced phantom hand-offs. Deleting the route deletes the hazard; make sure the deletion takes the whole handler, not just the arm, so the comment does not survive as a description of nothing.
8. **The 404-vs-200 reason-string contract retires too.** `reason === 'no researcher agent configured'` → 404, everything else → 200 (`:2521`). Nothing else keys on those literals.
9. **Documentation surfaces.** Grep for `research/dispatch` across `.agents/`, `.claude/`, `AGENTS.md` and `CLAUDE.md` before finishing — the control-plane source of truth is `.agents/` + `AGENTS.md`, and the generated `CLAUDE.md` / `.claude/skills` mirrors must be regenerated rather than hand-edited.
10. **Race conditions / security.** None. Removing an endpoint removes surface.

## Dependencies

- `sess_none — no external session dependency.`
- **Hard prerequisite: `feature_plan_20260813060000_researcher-relationship-has-no-return-path.md`.** It relocates the save instruction and adds the return address that this endpoint's replacement needs. Land it first, or the loop is open in the interval.
- **Hard prerequisite (transitively): teams subtask 4** — `feature_plan_20260812190005_team-member-scope-and-relationship.md`, which creates the `researcher` relationship wiring the return-path plan extends.
- **No file conflict** with either: this plan touches `LocalApiServer.ts`, `TaskViewerProvider.ts` and `agentPromptBuilder.ts`; those touch `linkPresets.ts`, `terminals.js` and the spawn wiring.

## Adversarial Synthesis

Key risk is ordering, not code: the deletions are small and mechanical, but performed before the teams researcher relationship and its return-path companion exist they remove the only working hand-off and leave nothing behind. The second risk is a half-deletion — pulling the route arm while leaving the handler, or the callback while leaving the method — which turns documented invariants into comments describing code that no longer runs. Mitigations: the strict prerequisite chain in `## Dependencies`, and a verification step that greps for every identifier rather than trusting the edit.

## Proposed Changes

### 1. `src/services/agentPromptBuilder.ts` — delete the hand-off directive

**Context.** Line 898, the `RESEARCHER HAND-OFF (try this before showing the prompt to the user): …` template-literal block.

**Logic.** Remove the block entirely. The surrounding research add-on keeps its "flag uncertain assumptions and supply a ready-to-run research prompt" instruction — only the HTTP hand-off goes.

**Edge cases.** Check the joins on either side of the deleted block so two paragraphs do not fuse or leave a doubled blank line in the emitted prompt.

### 2. `src/services/LocalApiServer.ts` — delete the route, the handler and the option

**Context.** Route arm at `:4055`; `_handleResearchDispatch` at `:2482-2530`; `onDispatchResearch` in the options interface at `:282`.

**Logic.** Delete all three. Do not leave a stub arm — a 200-returning stub would defeat the in-flight agents' fallback branch (Complexity Audit).

**Edge cases.** The long explanatory comment at `:2505-2521` goes with the handler; it documents a contract that no longer exists.

### 3. `src/services/TaskViewerProvider.ts` — delete the callback wiring and the resolution method

**Context.** `onDispatchResearch: async (workspaceRoot, prompt) => …` at `:2634-2639`; `_dispatchResearchToResearcher` at `:4669` through the end of the method.

**Logic.** Delete both. Leave `_getAgentNameForRole`, `_suffixedName`, `_normalizeAgentKey`, `_stripIdeSuffix`, `withTerminalSendLock` and `sendRobustText` untouched — all have other callers.

**Edge cases.** The method's Design Decision #3 comment (never route through `sendPromptToAgentTerminal`, because it would spawn) is specific to this method and goes with it. Confirm no other caller relies on it having been documented here.

### 4. Documentation sweep

**Logic.** Grep `research/dispatch`, `onDispatchResearch`, `_dispatchResearchToResearcher` and `RESEARCHER HAND-OFF` across `src/`, `.agents/`, `AGENTS.md` and `CLAUDE.md`. Edit `.agents/` and `AGENTS.md` at source; regenerate the `CLAUDE.md` / `.claude/skills` mirrors rather than hand-editing them.

## Verification Plan

Manual. Per session directive, no compilation step and no automated test run is part of this plan.

1. **The route is gone.** `POST /research/dispatch` returns **404**, not 200 and not 503.
2. **No stub survives.** Grep returns zero hits for `research/dispatch`, `onDispatchResearch` and `_dispatchResearchToResearcher` across `src/`.
3. **The directive is gone.** Dispatch a planner with the research add-on enabled and read the delivered prompt: no `RESEARCHER HAND-OFF` block, and the surrounding research instruction still reads cleanly with no fused paragraphs or doubled blank lines.
4. **The replacement works end to end.** With a team carrying a `researcher` member, hand the head a question that needs research. It relays to the researcher per its standing order; the researcher saves to `.switchboard/docs/` and relays a summary back. This is the acceptance test for the retirement — if it does not pass, the prerequisite plan has not landed and this one must not either.
5. **No team, honest degradation.** With no researcher standing order, confirm the planner pastes the ready-to-run prompt into its summary and says no hand-off occurred.
6. **In-flight agents downgrade cleanly.** From an agent still carrying the old directive, POST the route and confirm the 404 sends it down the chat-paste branch rather than stalling or announcing a phantom hand-off.
7. **Standalone unaffected.** Under `npx switchboard`, confirm the route is absent (previously 503) and nothing else regressed — the callback was never wired there.
8. **Gates.** Run `npm run parity:check` and `npm run push-routing:check` and confirm the endpoint deletion does not red either; regenerate the catalog if it is checked in.
9. **Unrelated helpers intact.** Confirm role resolution still works elsewhere — start a role-based terminal and confirm naming and role assignment are unchanged.

### Automated Tests

None added, and none run in this pass (session directive). No existing contract test covers `/research/dispatch`; its invariants lived only in the comments being deleted with it.

## Recommendation

Complexity 3 → **Send to Intern.** Land last in the chain: teams subtask 4 → researcher return path → this.
