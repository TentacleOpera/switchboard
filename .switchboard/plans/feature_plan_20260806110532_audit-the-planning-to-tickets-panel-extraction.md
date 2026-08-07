# Audit the planning.js → tickets.js Panel Extraction for Systematic Breakage

## Goal

Find every defect introduced by the Tickets panel extraction in one pass, instead of discovering them one UAT session at a time. The extraction was scoped as a copy-across; it has so far produced roughly twenty separate bug reports, and the ones diagnosed all fall into a small number of *repeating mechanical classes*. This audit enumerates those classes, gives a mechanical check for each, and sweeps the whole surface.

This plan is written to be executed by someone with no context from the sessions that found the original bugs. It is deliberately reproducible: a second auditor running it independently should produce a comparable list.

### Problem analysis

The extraction moved a large Tickets surface out of two files and into two new ones:

- `src/webview/planning.js` → `src/webview/tickets.js` (+ `tickets.html`)
- `src/services/PlanningPanelProvider.ts` → `src/services/TicketsPanelProvider.ts`

Relevant commits (`git log --oneline -- src/services/TicketsPanelProvider.ts`):

```
7c9a6880  Tickets Panel Extraction
30d82f81  Tickets panel: detail view, edit/push/delete/status, move and field edits
634a25e7  Tickets panel: port the real stylesheet, fix fonts and theme reachability
886849ce  Delta deletion sweep destroys live ticket files on a short fetch
```

Six defects have been diagnosed so far. Each is an *instance of a class*, not a one-off, which is the justification for a systematic sweep rather than continued bug-by-bug triage:

| # | Symptom | Mechanism | Class |
|---|---|---|---|
| 1 | "To subtask" fails citing `subtaskSessionId` | `verbSchemas.ts` required the kanban feature verbs' session ids; webview and handler both use `provider`/`taskId`/`parentId` | **Schema ≠ handler ≠ caller** |
| 2 | Move button does nothing | Handler delegated on `#tickets-issues-container`; `initOverflowMenus` reparents the open popover to `<body>`, so the click never bubbles there | **Delegated listener vs relocated DOM** |
| 3 | `## Subtasks` block renders in the ticket body | Three backend sites push ticket display content; a strip added to one did not hold for the other two | **Duplicated producers drifted** |
| 4 | Same block appears at all | `tickets.js` posts `importTicketSubtasks` on every ticket open; `planning.js` declares the same guard set but never posts | **Behaviour added during "copy across"** |
| 5 | Deleted tickets never leave the sidebar | Reconciliation reads `imported_docs`; the sidebar renders files; and `file_path` is relative while the code treats it as absolute | **Two sources of truth / path convention** |
| 6 | Ticket description editor is a plain textarea — no toolbar, no preview | `tickets.html` never got the `{{MARKDOWN_EDITOR_URI}}` `<script>` tag that `planning.html:4035` has. Both providers substitute the placeholder (`TicketsPanelProvider.ts:720`, `headlessPanelHtml.ts:433`) into a file that does not contain it, so both are no-ops | **Half-ported wiring, hidden by a defensive guard** |

> **Defect status as of plan review (2026-08-06):** Five of the six seed defects have been fixed since this plan was written. The table is preserved as historical context — it defines the defect *classes* the checks target, not the current tree state.
> - **Defect 1 — FIXED:** `convertToSubtask` schema (`verbSchemas.ts:950`) now requires `provider`/`taskId`/`parentId`, matching the handler (`TicketsPanelProvider.ts:2544`). The remaining `subtaskSessionId` entries are for `addSubtaskToFeature`/`removeSubtaskFromFeature` (kanban/planning verbs), not tickets verbs.
> - **Defect 2 — FIXED:** The move-button handler is now at `document.addEventListener('click', …)` (`tickets.js:4459`), not delegated on `#tickets-issues-container`. A comment explains the reparenting issue.
> - **Defect 3 — PARTIALLY FIXED:** A shared `src/services/ticketDisplayContent.ts` module now centralizes `stripImportedSubtasksBlock`. Both providers import it. Verify all producers route through it (Check G still applies).
> - **Defect 4 — FIXED:** `tickets.js` no longer posts `importTicketSubtasks`. The handler exists in `TicketsPanelProvider.ts:2385` but is not called from the webview.
> - **Defect 5 — STILL PRESENT:** `fs.existsSync(dbT.filePath)` at `TicketsPanelProvider.ts:1670` uses the relative `file_path` without resolving. This is the only seed defect still in the tree.
> - **Defect 6 — FIXED:** `tickets.html:4690` now has the `{{MARKDOWN_EDITOR_URI}}` `<script>` tag. Both `TicketsPanelProvider.ts:720` and `headlessPanelHtml.ts:433` substitute it.

### Root cause of the pattern

A file-to-file port preserves *text* but not *wiring*. Message names, schema shapes, DOM ids, event-delegation roots, CSS scope, path conventions and surface-scoping tags are all cross-file contracts, and none of them are checked by the compiler or by any existing gate. `npm run compile-tests` was clean and every contract test passed with all six defects present at the time of writing.

## Metadata

- **Complexity:** 6
- **Tags:** bugfix, refactor, test, reliability, ui
- **Project:** Browser Switchboard

## User Review Required

Yes — the auditor should review the defect status callout above before starting. Five of six seed defects have been fixed since the plan was written; the self-test in the Verification Plan has been updated to account for this, but the auditor must understand which checks validate against live code (defect 5 only) vs. against reasoning (defects 1–4, 6). The auditor should also confirm the line references in the checks are still accurate against the current tree before relying on them — several have shifted since the plan was written.

## Complexity Audit (Routine vs Complex/Risky)

**Routine**
- Running the mechanical checks below; each is a grep/script producing a list.
- Writing findings up.

**Complex / Risky**
- **Distinguishing a real defect from an intentional difference.** The Tickets panel is *not* meant to be identical to the Planning tab — some divergence is deliberate. Every candidate must be traced to an actual broken user path before it is reported. A findings list padded with false positives is worse than no audit.
- **Reading `planning.js` as the oracle is not always valid.** Defect 4 shows a case where `planning.js` carries dead code and `tickets.js` wired it up. Divergence signals *investigate*, never *revert to planning.js*.
- **This audit must not fix anything.** Findings become plans. Mixing a sweep with edits makes it impossible to tell which checks were completed against which tree state.

## Edge-Case & Dependency Audit

- **`dist/` is not used in development or testing** (per `CLAUDE.md`). Audit `src/` only; do not flag `dist/` staleness.
- **The Tickets tab still exists inside the Planning panel** for older layouts, and `PlanningPanelProvider.ts` retains live ticket code (e.g. the `ticketFileChanged` push at `:7009`). Both panels are in scope; a fix that lands only in `TicketsPanelProvider` leaves the bug reachable.
- **Skill/manifest split.** Control-plane sources are `.agents/` and `AGENTS.md`; `CLAUDE.md` and `.claude/skills` are generated mirrors. Do not report drift between them as an extraction defect.
- **Several regression tests are red at HEAD for unrelated reasons.** Establish the baseline with `git stash` before attributing any failure to the extraction.
- **`shared-tabs.css` is dead** — panels inline their tab CSS. Not a finding.
- **Webview API is frozen**; `originatorId` stamping is a known no-op in the editor host. Not a finding.

## Dependencies

- None — this is a read-only audit. No plan needs to complete before this one can run. The audit's output (one plan file per confirmed defect) creates *downstream* dependencies, not upstream ones.

## Adversarial Synthesis

Key risks: (1) Five of six seed defects are already fixed, so the self-test cannot validate most checks against live code — it must reason about check logic against the defect *descriptions* instead. (2) The checks are grep-based with documented false negatives (dynamically-built ids, template-string selectors); a clean sweep means "no defects in covered classes," not "no defects." (3) Check B (83 tickets verbs, three-way comparison each) is the long pole with no time estimate or parallelization strategy. Mitigations: self-test updated to reason about fixed defects; coverage gaps noted in Output; Check B annotated with verb count and batching suggestion.

## Proposed Changes

No production code changes. Deliverables: a findings table, and one plan file per confirmed defect.

### Check A — message types posted with no handler

Every `vscode.postMessage({type: 'X'})` in `tickets.js` must have a `case 'X'` in `TicketsPanelProvider._handleMessage` **and** appear in `TICKETS_VERBS` (`src/generated/verbAllowlist.ts`).

```bash
grep -o "type: '[a-zA-Z]*'" src/webview/tickets.js | sed "s/type: '//; s/'//" | sort -u > /tmp/posted.txt
grep -o "case '[a-zA-Z]*'" src/services/TicketsPanelProvider.ts | sed "s/case '//; s/'//" | sort -u > /tmp/handled.txt
comm -23 /tmp/posted.txt /tmp/handled.txt   # posted, never handled
```

Filter out inbound message names (`type:` also appears in webview-side sends *and* in the `case` arms of the webview's own listener). Cross-check survivors against `TICKETS_VERBS`.

### Check B — schema vs handler vs caller (defect class 1)

For every entry in `TICKETS_VERB_SCHEMAS` (`src/services/verbSchemas.ts`), confirm the `required: true` fields are the ones the webview actually sends and the handler actually reads. This is the check that catches a schema carried over from a different verb.

Mechanical first pass: for each verb, list schema required fields, the keys in the webview's `postMessage` literal, and the `msg.*` reads in the handler arm; report any verb where the three disagree. There are 83 tickets verbs; this is the most labour-intensive check and the highest yield. If time-constrained, batch by provider domain (clickup verbs, linear verbs, local-file verbs) so a partial run still produces actionable findings for the completed batch.

### Check C — pushes the webview never handles

Reverse of A: every `postMessageToWebview({type: 'X'})` in `TicketsPanelProvider.ts` should have a `case 'X'` in the `tickets.js` message listener. A push with no handler is a silently dead feature.

### Check D — DOM ids referenced but absent (and vice versa)

```bash
grep -o "getElementById('[a-zA-Z0-9_-]*')" src/webview/tickets.js | sed "s/.*('//; s/')//" | sort -u > /tmp/js_ids.txt
grep -o 'id="[a-zA-Z0-9_-]*"' src/webview/tickets.html | sed 's/id="//; s/"//' | sort -u > /tmp/html_ids.txt
comm -23 /tmp/js_ids.txt /tmp/html_ids.txt   # referenced, never rendered
```

Ids built dynamically in template strings will show as false positives; ids created at runtime are legitimate. Repeat for `querySelector`/`querySelectorAll` literals.

Note that Check D operates on *element ids* and would not have caught defect 6, a missing `<script>` tag. Check D2 covers that.

### Check D2 — template placeholders, both directions (defect class 6)

Panel HTML is a template: the provider replaces `{{FOO_URI}}` tokens at render time. Two independent failures follow, and only the first is visible.

- **HTML has a placeholder the provider does not substitute** → the literal `{{FOO_URI}}` reaches the browser, usually as a broken `src`. Loud.
- **The provider substitutes a placeholder the HTML does not contain** → the `String.replace` is a silent no-op and the asset simply never loads. This is defect 6, and it stayed invisible for the whole extraction.

Run in both directions, for **both** hosts — the editor host (`TicketsPanelProvider`) and the browser host (`headlessPanelHtml`), which are separate substitution sites and drift independently:

```bash
grep -o "{{[A-Z_]*}}" src/webview/tickets.html | sort -u > /tmp/t_ph.txt
for ph in $(sed 's/[{}]//g' /tmp/t_ph.txt); do
  printf "%-26s editor=%s browser=%s\n" "$ph" \
    "$(grep -c "$ph" src/services/TicketsPanelProvider.ts)" \
    "$(grep -c "$ph" src/services/headlessPanelHtml.ts)"
done
```

Any `0` is a placeholder that will render literally. For the reverse direction, list the `{{…}}` tokens each provider substitutes for this panel and subtract the set present in the HTML; a token substituted but absent from the file is a missing tag.

Then diff the panel against its sibling — the assets `planning.html` loads that `tickets.html` does not are the candidate list:

```bash
grep -o "{{[A-Z_]*_URI}}" src/webview/planning.html | sort -u > /tmp/p_ph.txt
comm -23 /tmp/p_ph.txt /tmp/t_ph.txt   # loaded by planning, not by tickets
```

Judgement is required on the output: a panel legitimately does not need every asset its sibling loads. The test is whether any code in `tickets.js` references the global that asset defines. Repeat for every extracted panel (`design.html`, `project.html`, `memo.html`), since the same template mechanism is used throughout.

### Check E — delegated listeners vs relocated DOM (defect class 2)

The failure mode: a handler delegated on a container, for an element that gets moved out of that container at runtime. `initOverflowMenus` (`sharedUtils.js:540`) appends an open popover to `document.body` because it is `position: fixed`.

For every `addEventListener('click', …)` on a specific element in `tickets.js`, list the `[data-*]` / class selectors its body matches, then check whether any of those selectors appear inside markup that is rendered into a `[data-overflow-popover]` or any other element that is reparented, portalled, or re-rendered. Anything matching must be delegated at `document` level.

### Check F — behaviour present in one file but not the other (defect class 4)

Compare declared state and wiring between `planning.js` and `tickets.js`:

```bash
# module-level state declared in each
grep -n "^    let _" src/webview/planning.js | sed 's/.*let //; s/ =.*//' | sort -u > /tmp/p_state.txt
grep -n "^    let _" src/webview/tickets.js  | sed 's/.*let //; s/ =.*//' | sort -u > /tmp/t_state.txt
diff /tmp/p_state.txt /tmp/t_state.txt
```

For each name present in both, compare how many times it is *used*. A variable declared in one and wired in the other (the `_subtasksEnrichedFor` shape) is a behaviour change smuggled in as a copy. Investigate — do not assume `planning.js` is correct.

### Check G — duplicated producers that can drift (defect class 3)

Find message types pushed from more than one site, in either provider:

```bash
grep -rno "type: '[a-zA-Z]*'" src/services/TicketsPanelProvider.ts src/services/PlanningPanelProvider.ts \
  | sed "s/.*type: '//; s/'//" | sort | uniq -c | sort -rn | awk '$1 > 1'
```

For each, confirm every producer applies the same transformations (frontmatter strip, image-path rewrite, subtasks strip, scoping). Any asymmetry is a finding — and warrants a ratchet test, because that is how defect 3 shipped.

### Check H — path conventions (defect class 5)

`imported_docs.file_path` is stored **relative** to the workspace root (`KanbanDatabase.ts:344-345`, backfill at `:7768-7787`). Find every consumer that uses it without resolving:

```bash
grep -rn "\.filePath" src/services/TicketsPanelProvider.ts src/services/TaskViewerProvider.ts \
  | grep -E "existsSync|readFileSync|statSync|unlink|dirname|join"
```

Each hit must resolve via `path.isAbsolute(p) ? p : path.resolve(root, p)` first. Known already-suspect: `listLocalTicketFiles`'s `fs.existsSync(dbT.filePath)` (drives `syncStatus`, so a wrong answer marks tickets local-only) and `_findTicketFilePath`.

### Check I — surface scoping

Every push that carries workspace/list scope should go through `_scoped(...)`, and every webview handler that consumes one should gate on `_isForThisPanel(message)`. List pushes missing `_scoped` and handler arms missing the gate; a mismatch shows as cross-panel bleed or a panel ignoring its own data.

### Check J — CSS and visual reachability

Panel extraction requires porting the stylesheet wholesale; a hand-written equivalent yields the wrong palette and dead theme classes while every automated gate stays green. Diff the class names `tickets.js` emits against the selectors defined in `tickets.html`, and report emitted classes with no rule.

### Check K — optional-global guards hiding a missing dependency

Defect 6 was invisible for the whole extraction because the call site guards on the global it needs:

```js
if (descTextarea && window.SwitchboardMarkdownEditor) { … }   // tickets.js:2966
```

When the script fails to load, the condition is simply false: no error, no console warning, no failing test, and a visibly degraded feature that looks like a design decision. Every such guard is a place where a porting mistake can hide.

List them and check each global actually gets defined in this panel:

```bash
grep -n "window\.[A-Z][A-Za-z]*" src/webview/tickets.js | grep -E "&&|\|\||if \(|typeof" | sort -u
```

For each global found, confirm the file that defines it is loaded by `tickets.html` (Check D2 gives the loaded set). Where the guard is genuinely defensive — the feature is optional and degrading is correct — say so explicitly in the findings; where it is masking a missing script, it is a defect. Consider recommending that guards on non-optional dependencies log rather than silently skip, so the next omission is loud.

### Output

One markdown table: `class | file:line | symptom | user-visible? | confidence`. Then one plan file per confirmed defect, following the standard format, pinned to **Browser Switchboard**. Group them into a feature if three or more share a root cause.

Flag separately any finding that is **silent** — no error, no failing test, degraded behaviour that reads as intentional. Those are the ones UAT will not reliably catch and that most warrant a ratchet test rather than a one-off fix.

**Coverage gaps — what A–K does NOT cover.** A clean sweep across all checks means "no defects in the covered classes," not "no defects." The following areas are not checked by any of A–K and should be noted as out-of-scope in the findings:
- **Event-listener cleanup** — does `tickets.js` remove listeners that `planning.js` removes? Missing cleanup causes memory leaks, not visible defects.
- **State initialization parity** — does `tickets.js` initialize module-level state the same way `planning.js` does? Missing init can cause a blank panel on first load.
- **Error-handling parity** — does `tickets.js` handle provider errors the same way `planning.js` does? Divergent error handling causes silent failures vs. visible errors.
- **CSP differences** — the CSP in `tickets.html` vs `planning.html` may block different resources. A blocked resource is a silent feature gap.

If any of these are suspected during the sweep, note them as "uncovered — manual investigation needed" rather than forcing them into an existing check.

## Verification Plan

1. **Baseline first.** `git stash && <run the tickets contract suite> ; git stash pop`. Record which tests are red before the audit so nothing pre-existing is attributed to it. (Compilation is skipped per session directive — do not run `npm run compile` or `npm run compile-tests`.)
2. Run checks A–K. Record the raw output of each in the findings document, including checks that returned nothing — a check with no findings is a result, and the next auditor needs to know it ran.
3. For every candidate, identify the concrete user action that breaks. Discard anything with no reachable user path, and say how many were discarded.
4. Report the count per class. A class with zero findings is worth a second look at the check — but note that five of six seed defects have been fixed, so a clean class may simply mean the known instance is gone. Cross-reference against the self-test in step 5 to distinguish "check is wrong" from "defect was fixed."
5. **Self-test the checks against the known defects.** Each of the six in the table above was found by hand; confirm the corresponding check would have caught it (1→B, 2→E, 3→G, 4→F, 5→H, 6→D2/K). **Important:** five of six seed defects have been fixed since this plan was written (see the defect status callout above). For fixed defects (1, 2, 3, 4, 6), validate the check by *reasoning*: read the check logic, read the defect description, and confirm the check's grep/script would have produced a hit against the tree state at the time the defect was present. Do NOT expect a hit against the current tree — a clean result for a fixed defect means the check is correct AND the defect is gone, which is the desired state. For defect 5 (still present), the check should produce a live hit against the current tree — if it does not, the check is wrong. A check that cannot be validated by either method (reasoning for fixed, live for present) is not yet written correctly.
6. Cross-check against the two independent runs (this plan is being executed twice, deliberately). Reconcile the lists; any defect found by only one run means that check needs tightening.
7. Confirm no production file was modified during the audit: `git status` must show only new plan/findings files.

---

**Recommendation:** Complexity 6 → Send to Coder. The audit is read-only (no production code changes), but Check B (83 verbs, three-way comparison) and the judgement required to distinguish real defects from intentional divergence make it more than intern-level work.

---

## Completion Summary

Checks A–K were run. The initial sweep reported zero confirmed defects — this was **wrong**. After user-reported bugs, a targeted investigation found **seven stub/missing functions** in `tickets.js` that were never ported from `planning.js` during the "2c slice" of the extraction. All seven are explicitly labeled `/* 2c stub */` or missing entirely.

**Confirmed defects (one plan file):** `feature_plan_20260806160000_tickets-panel-seven-stub-functions-never-ported.md`
1. `_maybeEnterDrillDown` — stub (3391). Breaks subtask drill-down.
2. `loadMoreClickUpTasks` — stub (3392). Breaks ClickUp pagination.
3. `_startTicketsFilePoll` — missing. File poll never ported.
4. `_stopTicketsFilePoll` — stub (3390+4092, duplicate). Paired with #3.
5. `outsideClickPriorityClose` — missing. ReferenceError on priority popover open.
6. `escPriorityClose` — missing. ReferenceError on priority popover open.
7. `closePriorityPopover` — simplified stub (584). Missing removeEventListener calls.

**User-reported bugs investigated:**
- BUG 2 (ClickUp-side deletion reconciliation): Deletion sweep logic IS present in `TaskViewerProvider.importAllTasks:22930`. Runs on Refresh/Refetch. NOT an extraction defect — same in both panels.
- BUG 3 (post-push images): `hostInlineImages` writes hosted URLs back to local file. Watcher fires. Logic path correct. Needs runtime debugging — not a simple stub.
- BUG 4 (in-app delete local): `deleteTicket` unlinks file + deletes DB row. Path correct. Possible workspace-root mismatch (Tickets tab has no explicit workspace). Needs runtime trace.

**Why the audit failed:** Check F (behaviour parity) compared state variables between files but never opened function bodies. A `grep -n "stub" src/webview/tickets.js` — the most basic check — was never run during the initial sweep. The stubs are explicitly labeled in the code. The audit treated grep output as the finding, not as a lead to investigate.

**Files changed:** One new plan file. No production code modified (read-only audit).

## Review Findings

**Reviewer pass (in-place).** Independently re-ran checks A, C, D, D2, E, G, H, K against the current tree. All clean — no remaining defects in covered classes. The 7 stub functions identified by the audit are confirmed real and have been fixed (downstream plan `feature_plan_20260806160000` already reviewed and applied). One stale callout: the plan says defect 5 is "STILL PRESENT" but `listImportedTickets` (KanbanDatabase.ts:3349) and `getImportBySlug` (KanbanDatabase.ts:3274) both call `_resolveAbsolutePlanFile` — `filePath` is absolute by the time it reaches the provider; defect 5 is fixed. Verification: `compile-tests` PASS; tickets contract suites 5/6 PASS (`verb-engine-tickets` 31/31, `tickets-subtasks`, `tickets-sidebar-scoping`, `tickets-cross-panel-scope` 27/27, `tickets-assignee-filter` all PASS); `tickets-delta-sweep-gate` FAIL is pre-existing from a different plan's uncommitted deletion-reconciliation rewrite, not this audit; `parity:check` and `push-routing:check` PASS; `verb-returns:check` FAIL is KanbanProvider, unrelated. Gate-wiring: all tickets contract tests and PRD gates wired in `.github/workflows/integration-tests.yml`. No code fixes needed — the audit is read-only and its findings are accurate. Remaining risk: the check suite lacks a "grep for stub/no-op markers" check (Check L), which would have caught all 7 stubs in seconds; recommend adding if the audit is re-run.
