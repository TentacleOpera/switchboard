# The catalogue extractor tracks brace depth but never consults it, so six role names are allowlisted as verbs

## Goal

Make `scripts/generate-protocol-catalog.js` record a `case` label as a handler arm **only when it sits directly in the message-handler switch**, not inside a nested switch within an arm. Regenerate `protocol-catalog.json` and `src/generated/verbAllowlist.ts`. Exactly six phantom verbs disappear; the already-red parity gate goes green.

### Problem Analysis

**Six allowlisted "verbs" have no handler, no schema, and no caller.** `planner`, `lead`, `coder`, `intern`, `reviewer`, `tester` are in `KANBAN_VERBS`. No webview posts them. `verbSchemas.ts` declares nothing for them. The only `case 'coder':` in `KanbanProvider.ts` is a branch of a nested `switch (role)` **inside** the `getPromptPreview` arm, where `role` is a request parameter used to filter cards for a preview (`~:13464-13468`). They surfaced during the agent-operation triage as "possibly the dispatch surface"; they are artefacts.

**The extractor bounds its scan correctly and then ignores the bound.** `extractHandlerArms` (`scripts/generate-protocol-catalog.js:58-99`) finds the handler switch via a per-provider `switchPattern` (`:34-39`), then walks lines tracking `{`/`}` depth and stops when depth returns to 0. That part is right. But within the span it applies the regex to every line unconditionally:

```js
const caseRe = /case\s+(['"])([^'"]+)\1\s*:/;          // :78
…
for (const ch of line) { if (ch === '{') depth++; else if (ch === '}') depth--; }
if (started && depth === 0) break;
…
const m = line.match(caseRe);
if (m) arms.push({ verb: m[2], line: i + 1, dynamic: false });   // no depth check
```

Depth is used to know *when to stop*, never to decide *whether this `case` is an arm*. A `case` at depth 3 — inside an arm's block, inside a nested switch — is recorded identically to one at depth 1.

**The false positives are exactly six, and only in Kanban.** A dry run replicating the extractor with a depth filter, across all six providers:

| provider | catalogue arms | depth-1 arms | removed by fix |
| :-- | --: | --: | :-- |
| Kanban | 178 | 174 | `coder` `intern` `lead` `planner` `reviewer` `tester` |
| Planning | 113 | 115 | — |
| Tickets | 89 | 89 | — |
| Design | 61 | 61 | — |
| TaskViewer | 104 | 104 | — |
| Setup | 105 | 105 | — |

No other provider has a nested string-literal switch inside an arm today. The fix is surgical.

**Why it matters beyond tidiness.** `KANBAN_VERBS` is the validation boundary for `POST /kanban/verb/<name>` and for `switchboard verb <name>`. Six names pass that boundary and dispatch to nothing. During the operation-set triage they cost real time — bare role names look exactly like a dispatch API — and any agent reading the allowlist will make the same mistake.

**The catalogue is also stale, and CI already knows.** `check-protocol-parity.js` fails at HEAD with four errors:

```
❌ Kanban:   verb 'setCardPriority' in allowlist but missing from catalog
❌ Kanban:   verb 'setOrderByMode'  in allowlist but missing from catalog
❌ Planning: verb 'setCardPriority' in allowlist but missing from catalog
❌ Planning: verb 'setOrderByMode'  in allowlist but missing from catalog
```

Both verbs landed in `4df54319` (2026-09-03, *priority as a native card field*). That commit touched `verbAllowlist.ts` and `protocol-catalog.json` but the catalogue does not contain the two new arms — the two generated files diverged within one commit. The dry run confirms both are genuine depth-1 arms in both providers. A regenerate is owed today independent of this plan; this plan rides on it.

### Root Cause

`extractHandlerArms` conflates two questions — *have I left the switch?* and *is this line an arm of the switch?* — and answers only the first with the depth counter. The second was left to a regex that cannot see structure. It worked until an arm contained its own string-literal switch.

## Metadata

**Complexity:** 2
**Tags:** tooling, catalogue, ci, bugfix
**Project:** Browser Switchboard

## Proposed Changes

1. **Consult depth when recording an arm.** In `extractHandlerArms`, capture `depthAtLineStart` **before** applying the line's braces, and push an arm only when `depthAtLineStart === 1`. Same rule for the `dynamic` branch.

   The ordering matters: `case 'foo': {` opens a brace on the same line, so a top-level arm reads depth 2 *after* the line is processed. Measuring before the line's braces is what makes depth 1 mean "directly in the switch body". An implementer who checks depth after the loop will drop every arm that opens a block — most of them.

2. **Regenerate both files** — `npm run catalog:generate` — in the same commit. This removes the six phantoms and adds the two verbs the catalogue is missing. `check-protocol-parity.js` regenerates byte-identical as its drift check (`:10`), so the fix and the regenerate cannot ship separately.

3. **Add a regression fixture.** A minimal provider-shaped file with one top-level arm containing a nested `switch (role) { case 'coder': … }`, asserting the extractor yields exactly one arm. This is the case that was missed; pin it.

4. **Leave `caseRe` alone.** The regex is fine. The defect is where it is applied, not what it matches.

### Not in scope

Deciding what the six names *should* mean. They mean nothing today. If a role-targeted dispatch verb is wanted, that is `agents-need-a-named-operation-set…`, and it would be a designed arm with a schema, not a recovered artefact.

## Verification Plan

1. After the fix, `node scripts/generate-protocol-catalog.js --write` changes `protocol-catalog.json` by **exactly** six removals (all Kanban, the six role names) and two additions (`setCardPriority`, `setOrderByMode` in Kanban and Planning). Nothing else moves.
2. `node scripts/check-protocol-parity.js` passes with 0 errors.
3. `KANBAN_VERBS` no longer contains `planner`, `lead`, `coder`, `intern`, `reviewer`, `tester`; `POST /kanban/verb/coder` is refused as unknown.
4. Arm counts for Planning, Tickets, Design, TaskViewer and Setup are unchanged.
5. The regression fixture yields one arm, not two. A version of the extractor without the depth check fails it.
6. An arm of the form `case 'x': {` at depth 1 is still recorded — guards the off-by-one in change #1.
7. `catalog:check`, `parity:check` and the `verb-returns` gate stay green.
