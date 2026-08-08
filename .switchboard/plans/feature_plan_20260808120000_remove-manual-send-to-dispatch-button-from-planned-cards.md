# Remove the Manual "Move to Dispatch" Button from Planned Column Cards

## Goal

Delete the per-card **Move to Dispatch** button that renders on every card in the Planned (`PLAN REVIEWED`) column, along with its click listener and its `sendToDispatch` provider verb. Entry into `DISPATCH` must be an agent-led decision only.

**Problem.** `DISPATCH` is supposed to mean "these plans are safe to run in parallel" — a *computed* answer: the `dispatch-analysis` skill reads plan bodies, builds a file-overlap graph, and moves the maximum independent set via `POST /kanban/move`. A one-click arrow computes nothing, so a clicked card and an analyzed card are indistinguishable once both sit in `DISPATCH`, and the column stops meaning parallel-safe.

**Root cause.** The button was cut by its own design — `.switchboard/plans/dispatcher-column-and-bounce-analysis.md` states the revision "deletes the send-to-Dispatch button, the per-card equivalent, the return-to-Planned button, and the bounce protocol." The implementation pass shipped it anyway, and review recorded the deviation as an accepted risk ("harmless — gives a manual escape hatch") instead of removing it.

**Scope.** Remove the `PLAN REVIEWED` entry button, its `.send-to-dispatch-btn` listener, and the `sendToDispatch` verb. Keep `→ Planned` on `DISPATCH` cards (exit direction — the operator's override of a wrong analysis) and keep the display-mode drop remap at `kanban.html:7428-7429` (shared with Backlog; also the only entry path that survives if `dispatchAnalyzeAvailable` ever gates Analyze off in a headless host).

> **Superseded:** "After this change, `DISPATCH` is reachable by exactly two paths."
> **Reason:** Verified false. `DISPATCH` is a real stored column (`KanbanDatabase.ts:898`), and two HTTP routes accept it as an arbitrary `targetColumn` and are untouched by this change: `POST /kanban/move` (`LocalApiServer.ts:1316` — the route `dispatch-analysis` itself uses, so it cannot be closed) and `POST /kanban/verb/moveCardForward|moveCardBackwards` (`KanbanProvider.ts:8441`, `8459`).
> **Replaced with:** Four paths — Analyze (intended), drag inside the Dispatch view, `POST /kanban/move`, and the two move verbs. The last three are generic primitives and deliberate overrides, out of scope. What this change delivers is narrower than the Goal sentence's wording: **unanalyzed entry stops being the default gesture**, not impossible.

## Metadata

- **Complexity:** 3
- **Tags:** ui, frontend, bugfix
- **Project:** Browser Switchboard

> **Superseded:** **Complexity:** 2
> **Reason:** Three hand-edited files plus two generated artifacts, a ternary re-flatten invisible to `tsc`, and a pre-existing red `catalog:check` to navigate. Routing unchanged (1-3 → Intern).

## User Review Required

None.

## Complexity Audit

### Routine
- One arm out of a chained ternary in `kanban.html`. No dedicated CSS — the button reuses `.card-btn.icon-btn`; `grep -n "send-to-dispatch-btn" src/webview/kanban.html` returns only the listener (6795) and the render site (6959).
- One listener block, one provider `case`, one generator run.
- No schema work. `KANBAN_VERB_SCHEMAS` has no `sendToDispatch` entry, and schemaless verbs validate as `ok`. (`sendToNew` at `verbSchemas.ts:380` is *Planning*'s verb — a grep trap.)

### Complex / Risky
- **Replace the whole ternary expression, don't delete lines.** `backlogActionBtn` is four nested arms (`kanban.html:6952-6964`); removing the third requires promoting and re-indenting the fourth. A line-level delete leaves an orphaned `:` — a syntax error that surfaces at webview *load*, not at `tsc` (`kanban.html` is not type-checked).
- **`catalog:check` is already red at HEAD.** Verified 2026-08-08: `node scripts/generate-protocol-catalog.js` exits **1** (`drift detected`); the checked-in catalog pins the arm at `"line": 10091` while it sits at 10103. `generate-verb-allowlist.js` and `check-protocol-parity.js` both exit **0**. Capture that baseline before editing so the post-regeneration diff is attributable, and expect churn beyond the `sendToDispatch` entries.
- **Never hand-edit the generated files.** Run `npm run catalog:generate` — catalog first, then allowlist, because `parity:check` asserts the allowlist regenerates byte-identical *from* the catalog.
- **Half-done removal is the real failure mode.** `src/test/browser-panel-verb-routing.test.js:181` asserts every verb posted from `kanban.html` is in `KANBAN_VERBS`, so dropping the allowlist entry while leaving the webview post fails by name.

## Edge-Case & Dependency Audit

- **Existing `DISPATCH` cards:** unaffected — this removes an entry path, not stored state. `DISPATCH` stays in `VALID_KANBAN_COLUMNS`. **Do not** write a migration or a relocation sweep.
- **Empty button slot:** a Planned card in the normal view now falls through to `''`. Already the shipped state for most columns, but confirm the footer visually.
- **Drag path cannot break.** `columns` (`kanban.html:4245`) has no `DISPATCH` member, so `indexOf` returns `-1`, the drop classifies as **backward**, and the webview posts `moveCardBackwards` — never `sendToDispatch`, never the forward CLI-dispatch path. It also bypasses the agent-availability gate at `:7507`, which strips forward ids only. Feature cascade still fires on this path (`KanbanProvider.ts:8447-8450`).
- **`showingDispatch` stays in use** at 11 other sites — no unused-binding cleanup implied.
- **Both hosts, one renderer.** `kanban.html` is the only board renderer and `KanbanProvider._handleMessage` the only verb router, so one edit covers extension and browser cockpit. The cockpit serves the installed VSIX's bundled copy, so browser UAT needs a rebuilt VSIX.
- **HTTP surface reduction.** `sendToDispatch` is currently callable as `POST /kanban/verb/sendToDispatch` (`LocalApiServer.ts:3545`) by anything reading `GET /catalog`. Removing it is intended — `POST /kanban/move` covers every API caller — but note it as an agent-facing change, not a pure UI one.
- **Untouched baselines:** `verb-return-contract-baseline.json` counts `break` (the arm has none) and `check-push-routing.js` counts `.webview.postMessage(` (likewise). Leave both alone.
- **Serialisation:** edits `KanbanProvider.ts` and `kanban.html` — do not run in parallel with another plan touching either file.

## Dependencies

- None.

## Adversarial Synthesis

Dominant risk is a half-done removal (allowlist entry gone, webview post left behind, or the inverse) — caught by `test:contract:browser-panel-verb-routing`, not by grep alone. Second is the ternary re-flatten, whose failure is a webview load-time syntax error invisible to `tsc`; mitigated by replacing the whole expression. Third is generated-artifact handling on top of an already-red `catalog:check`; mitigated by capturing that baseline first and running the generator rather than hand-editing.

## Proposed Changes

### 1. `src/webview/kanban.html:6952-6964` — remove the button render

Replace the **entire** `const backlogActionBtn = … : '';` expression with the three-arm version below (dispatch-entry arm deleted, `→ Planned` promoted one level). The removed condition (`card.column === 'PLAN REVIEWED' && !showingDispatch`) and the retained one (`showingDispatch && card.column === 'DISPATCH'`) are mutually exclusive, so evaluation order is unchanged.

```js
// Dispatch is an agent-led decision: cards enter DISPATCH via the Analyze button
// (planner + dispatch-analysis skill) or, as a deliberate operator override, a drag
// inside the Dispatch view. There is deliberately NO per-card "Move to Dispatch"
// button — a one-click move carries no parallel-safety analysis, which is the only
// thing membership in DISPATCH is supposed to mean. The `→ Planned` arm is the exit
// direction and stays.
const backlogActionBtn = (!isCompleted && card.column === 'CREATED' && !showingBacklog)
    ? `<button class="card-btn icon-btn send-to-backlog-btn" data-plan-id="${escapeAttr(card.planId || card.sessionId || '')}" data-session="${escapeAttr(card.sessionId || '')}" data-workspace-root="${escapeAttr(card.workspaceRoot)}" data-tooltip="Move to Backlog">
           <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M8 3v9M4.5 8.5L8 12l3.5-3.5"/></svg>
       </button>`
    : (!isCompleted && showingBacklog && card.column === 'BACKLOG')
        ? `<button class="card-btn send-to-new-btn" data-plan-id="${escapeAttr(card.planId || card.sessionId || '')}" data-session="${escapeAttr(card.sessionId || '')}" data-workspace-root="${escapeAttr(card.workspaceRoot)}" data-tooltip="Move back to New">→ New</button>`
        : (!isCompleted && showingDispatch && card.column === 'DISPATCH')
            ? `<button class="card-btn send-to-planned-btn" data-plan-id="${escapeAttr(card.planId || card.sessionId || '')}" data-session="${escapeAttr(card.sessionId || '')}" data-workspace-root="${escapeAttr(card.workspaceRoot)}" data-tooltip="Move back to Planned">→ Planned</button>`
            : '';
```

### 2. `src/webview/kanban.html:6795-6799` — delete the listener

```js
document.querySelectorAll('.send-to-dispatch-btn').forEach(btn => {
    btn.addEventListener('click', () => {
        postKanbanMessage({ type: 'sendToDispatch', sessionId: btn.dataset.session || '', planId: btn.dataset.planId || '', workspaceRoot: btn.dataset.workspaceRoot });
    });
});
```

Not optional — leaving this while removing the allowlist entry is exactly what `test:contract:browser-panel-verb-routing` fails on. Leave the adjacent `.send-to-backlog-btn` (6783), `.send-to-new-btn` (6789), and `.send-to-planned-btn` (6801) blocks alone.

### 3. `src/services/KanbanProvider.ts:10103-10111` — delete the `case 'sendToDispatch'` arm

Keep `sendToBacklog` (10085), `sendToNew` (10094), `sendToPlanned` (10112), `toggleDispatchView` (10121), `dispatchAnalyze` (10126). This is the provider's only `moveCardToColumn(..., 'DISPATCH')` call site but leaves no dead code: the drag path (`moveCardBackwards`/`moveCardForward`) and `POST /kanban/move` still pass `'DISPATCH'` through.

### 4. Regenerate the artifacts

```bash
# baseline BEFORE editing — expect 1, 0, 0
node scripts/generate-protocol-catalog.js; echo "catalog=$?"
node scripts/generate-verb-allowlist.js;  echo "allowlist=$?"
node scripts/check-protocol-parity.js;    echo "parity=$?"

# after steps 1-3
npm run catalog:generate
```

Drops `'sendToDispatch'` from `KANBAN_VERBS` and its entries at `providers.Kanban.arms[83]` / `verbs[405]` in `protocol-catalog.json`, plus the line-number churn.

### 5. Not changed

`verbSchemas.ts`, `agentConfig.ts` (`DISPATCH` stays a display-mode column), `KanbanDatabase.ts` (`DISPATCH` stays valid), `.agents/skills/dispatch-analysis/SKILL.md`, the drop remap at `kanban.html:7427-7429`, and both ratchet baselines.

## Verification Plan

Behavioural verification runs against an installed VSIX per `CLAUDE.md`; `dist/` is not exercised and must not be audited for staleness.

### Automated Tests

Static gates — run under this dispatch's SKIP directives (no compilation, no test suite):

1. `grep -rn "sendToDispatch\|send-to-dispatch" src/ --include="*.ts" --include="*.js" --include="*.html"` → **zero** hits (4 before).
2. `node scripts/generate-protocol-catalog.js` → exits **0** (ratchets from the known red 1).
3. `npm run parity:check` → **0**. The gate named after this change's actual risk: allowlist ≡ catalog.

Deferred by this dispatch — run on any dispatch without SKIP TESTS / SKIP COMPILATION; item 4 is the primary correctness tripwire:

4. `npm run test:contract:browser-panel-verb-routing` — catches the half-done removal.
5. `npm run test:contract:verb-engine-kanban` (19 sub-tests) — dispatcher gate intact.
6. `npx tsc --noEmit` — no new errors beyond the 5 pre-existing TS2835.

### Manual — installed VSIX

7. **Button gone** from Planned cards — check a plain plan card and a feature card.
8. **Other arms intact:** `CREATED` still shows its Backlog arrow, `BACKLOG` still shows `→ New`, `DISPATCH` still shows `→ Planned`. All three prove the re-flatten was correct.
9. **No load-time `SyntaxError`** in the webview console, and the Planned footer lays out with the slot empty.
10. **Both entry paths still work:** Analyze moves the safe set into `DISPATCH`; a drag onto the slot in Dispatch view persists as `DISPATCH` (wire check: `moveCardBackwards`, not `sendToDispatch`).
11. **Browser cockpit parity** after a rebuilt-and-installed VSIX — same absence, `→ Planned` still working.

---

**Recommendation: Send to Intern.** Two things not to improvise: replace the ternary expression wholesale, and run `npm run catalog:generate` after capturing the known-red `catalog:check` baseline.
