# 55 hand-rolled source-span extractions treat a failed marker lookup as a valid span — one silently swallows the file, another silently collapses to nothing

## Goal

Replace the hand-rolled `.slice(indexOf(...))` span extractions across the contract test suite with one shared helper that **cannot** silently produce a degenerate span, and that hands over the fix when a marker moves. The immediate motivation is a measured defect (`memo-panel-workspace-binding-contract.test.js`, run-step 65 of CI, covered by `ci-contract-span-rot-memo-binding-and-pane-fit.md`), but the point of this plan is the other sites where the same primitive is used with no guard at all.

### Problem Analysis

The contract suite asserts over source text: **140 of 188 test files** `readFileSync` a source file and assert against its contents (measured at HEAD: `ls src/test/*.test.js | wc -l` → 188; `grep -l readFileSync src/test/*.test.js | wc -l` → 140). Most scope those assertions to a *span* — a function body, a switch arm, an object literal — extracted by searching for a start and end marker. Span extraction is therefore a load-bearing primitive of the whole suite. It is implemented ad hoc, in two populations, with very different safety.

**Population A — 20 files define their own `block()` helper.** Measured across all 20 definitions:

| Guard | Files with it |
| :--- | :--- |
| start marker found (`start !== -1`) | **20 / 20** |
| end marker found (`end !== -1`) | **20 / 20** |
| span not inverted (`end > start`) | 2 / 20 |
| span not degenerate (size / EOF check) | **0 / 20** |

Two signature variants exist (16× `block(code, start, end)`, 4× `block(start, end)` closing over a module-level source constant — `terminal-open-all-seating`, `terminal-pane-fit-verification`, `terminal-pane-grid-reconcile`, `terminal-renderer-lifecycle`), but every one of them makes a *missing* marker loud. That is why `terminal-pane-fit-verification-contract.test.js` failed with a usable message when its `const DEFAULT_ROLES` anchor was renamed — the helper threw `end marker not found AFTER "function batchFitVisiblePanes(": const DEFAULT_ROLES`. Population A is not the safety problem.

Two further facts about Population A were measured during this pass and matter for the helper's signature:

- **19 of the 20 use `substring`; only `terminal-sidebar-role-ordering-contract.test.js` uses `slice`.**
- **19 of the 20 search the end marker from `start` (not `start + startMarker.length`), and `terminal-sidebar-role-ordering` returns `code.slice(start, end + endMarker.length)` — an *inclusive* end.** No proposed signature that hard-codes exclusive-end can absorb Population A later without changing what that file's assertions see.

**Population B — raw inline span sites, with the *end* marker unguarded.** These inline the extraction:

```js
const body = kanbanSource.slice(idx, kanbanSource.indexOf('/** Get the next column ID', idx));
const armBody = kanbanProvider.slice(armIdx, kanbanProvider.indexOf("case 'importFromClipboard'", armIdx));
const gatingBlock = transportSrc.slice(transportSrc.indexOf('caps.featureManagement === false'));
```

All three exist at HEAD (`browser-planner-dispatch-surface.test.js:183` and `:202`, `dispatch-view-contract.test.js:142`, `headless-feature-management-contract.test.js:476`).

`String.prototype.slice` accepts negative indices as offsets from the end, so a failed `indexOf` — which returns `-1` — is not an error. It is a **valid argument that produces a plausible-looking span**. Four distinct degenerate modes follow, all silent:

1. **Two-arg form, missing end marker — the span swallows the rest of the file.** `src.slice(idx, -1)` is `src.slice(idx, len - 1)`. The span runs from the start marker to one character before EOF, so assertions meant to be scoped to one function now match *anything anywhere below it*. **This produces false negatives: the test passes while guarding nothing.**
2. **One-arg form, missing marker — the span is one character.** `src.slice(-1)` returns the final character of the file. Every `includes()` assertion against it fails, and every `!includes()` assertion **passes**.
3. **Fixed-window form, missing start marker — the span is empty.** `src.slice(-1, -1 + 500)` is `src.slice(len - 1, 499)`, which is `''` for any file longer than 500 characters. Every `!includes()` passes. This mode was missed by the original census and is attached to the **largest** shape in the suite (51 sites).
4. **End marker resolves earlier than intended — the span collapses.** No `-1` involved; the marker is simply not unique. This is the measured instance: `memo-panel-workspace-binding-contract.test.js:271-272` slices the `workspaceChanged` handler to the first `break;`, and an `if (_wsRootExplicit) { break; }` guard clause added at the top of the handler became that first `break;`. The window narrowed to three lines, both `indexOf` probes returned `-1`, and the assertion reported the debounce cancel and root reassignment as *missing* while both sat two lines past the truncation point — accusing correct code. Confirmed live at HEAD: `src/webview/memo.js` opens the arm with that guard, and the collapsed body measures exactly 3 lines.

**Live or latent?** Mode 4 is live and measured (the memo case). Modes 1–3 are **latent, not observed**: sampling of the two-arg, one-arg and fixed-window sites found every end marker resolving in its target source today (`/** Get the next column ID` and `case 'importFromClipboard'` in `KanbanProvider.ts`, `case 'settingResult':` in `kanban.html`, `caps.featureManagement === false` in `transport.js`). This plan is prevention on a surface where one instance has already fired, not a hunt for known breakage. A survey for currently-degenerate spans falls out of the migration itself — see Verification.

### The census, re-measured

> **Superseded:** "Population B — 55 raw span sites across 33 files, with no guards whatsoever." … "27 of the 55 sites use this form" (two-arg) … "9 of the 55 sites use this form" (one-arg) … "the 33 that inlined it added none".
> **Reason:** Re-measured at HEAD with a balanced-argument parser over every `.slice(` / `.substring(` call in `src/test/*.test.js` whose arguments contain `indexOf` or reference a variable assigned from `indexOf`. Every number is different, one whole shape (fixed-window, the largest) was missing, and the two populations are not disjoint. The original figures also mis-state the guard situation: a substantial minority of raw sites *do* assert the start index — the unguarded half is the **end** marker. The migration's file list, the "record pass/fail for all 33 files" invariant, and the scope estimate all depend on these numbers being right.
> **Replaced with:** the table below.

| Measure | Count |
| :--- | :--- |
| `.slice` / `.substring` calls in `src/test/*.test.js` with an `indexOf`-derived bound | **176** |
| — of those, inside one of the 20 `block()` definitions (Population A) | 20 |
| — **raw inline sites (Population B)** | **156**, across **55 files** |
| Files that define `block()` **and** carry raw sites (in both populations) | **9** |

Population B by shape:

| Shape | Sites | Degenerate mode on a missed marker | Expressible by a marker-pair API? |
| :--- | :--- | :--- | :--- |
| fixed window — `slice(idx, idx + N)` | **51** (24 files) | empty span (mode 3) | **No** — no end marker exists |
| two-arg, inline `indexOf` end | **39** (fewer files) | runs to EOF (mode 1) or collapses (mode 4) | Yes |
| two-arg, both bounds from `idx` vars | **38** | runs to EOF / inverted | Sometimes |
| one-arg to EOF | **23** | one character (mode 2) | Yes, via `toEnd` |
| prefix cut — `slice(0, idxVar)` | 4 | drops last character | Partly |
| other | 1 | — | — |

**Marker-bounded sites — the population the originally-proposed `span(src, start, end)` API can actually absorb: 62 sites across 26 files** (39 two-arg-inline + 23 one-arg). Of those 62:

- **25 already assert the start index is not `-1`** (e.g. `dispatch-view-contract.test.js:141` asserts `armIdx`, `headless-feature-management-contract.test.js:536` asserts `armIdx`). "No guards whatsoever" is overstated; the missing guard is almost always on the *end* marker, which is inlined into the second argument where there is nowhere to assert.
- **10 use `substring`**, whose negative-argument behaviour differs (clamps to 0 → span from *file start*).
- **9 sites across the wider population want an *exclusive* start** — `slice(templateIdx + 'template:'.length)`, `slice(content.indexOf(MARKER) + MARKER.length)`, `slice(start + SIG.length, end)`, `slice(open + 1, close)` and five more. A helper that always includes the start marker cannot migrate these faithfully.
- **Two sites nest lookups and then `new Function()` the result** — `tickets-subtask-embedding.test.js:451` and `:469` extract a private method body (`slice(indexOf('\n', indexOf('private _assetKey(')) + 1, indexOf('\n    }', indexOf('private _assetKey(')))`) and execute it. Exclusive start, end marker searched from the *start marker's* index rather than from the resolved start. Neither the original API nor a naive migration expresses this.

### Root Cause

A load-bearing primitive implemented 176 times (20 helper definitions + 156 inline sites) with no shared contract, on top of a language operation whose failure mode is a valid result rather than an exception. `indexOf` returning `-1` and `slice`/`substring` accepting `-1` compose into "silently wrong span" instead of "throw". The 20 files that wrote a helper each independently added the two guards that matter most; the inline sites guard the start index at best and never the end.

### Honest scope — what this guard catches, and what it does not

This matters because the plan was proposed off the back of six CI contract failures, and it does **not** address six.

| CI failure | Class | Addressed here? |
| :--- | :--- | :--- |
| run-step 65 `memo-workspace-binding` | span collapsed (mode 4) | **Partly — see the correction below** |
| run-step 76 `terminal-pane-fit` | marker renamed | Already loud via `block()`. Diagnosis improves only once Population A migrates — **a follow-up, not this plan** |
| run-step 64 `memo-browser-clear` | test lever bypassed by the seams migration | **No** — not a span problem |
| run-step 78 `terminal-focus-affordance` | assertion pins a deliberately-removed latch | **No** — needs judgment about intent |
| run-step 80 `shell-terminal-strip` | assertion pins a superseded conditional | **No** — needs judgment about intent |
| `ws-surface-scoping` | whole-file substring ban | **No** — no span involved |

> **Superseded:** "run-step 65 `memo-workspace-binding` — span collapsed (mode 3) — **Yes** — this exact class becomes impossible."
> **Reason:** Measured. The memo collapsed span is **3 lines**, so the proposed `minLines` default of 2 does **not** fire on it (`node -e` over `src/webview/memo.js` at HEAD: `body.split('\n').length === 3`, `3 < 2` is false). The plan's own prose conceded this in passing ("the memo span was three lines including the `case` line itself") while its headline table claimed the class becomes impossible. A size threshold is structurally incapable of catching mode 4: a collapsed window can be any size. The claim was the plan's flagship deliverable and it was false.
> **Replaced with:** mode 4 is caught by **rejecting generic end markers** (`opts.allowGenericEnd`, default `false`), not by a size threshold. A generic-token end marker is exactly what makes a span collapsible — any inserted guard clause, early return, or nested block moves it. 7 marker-bounded sites use a strictly-generic end marker today (`'break;'` ×1, `'};'` ×3, `'=>'` ×2, `' }'` ×1) and each is a latent mode-4. `minLines` stays as a cheap backstop for the cases the marker check cannot see, and is documented as a backstop rather than the mechanism.

**One of six.** The value is not retroactive coverage; it is that the raw sites stop being able to fail this way, including the 39 two-arg and 51 fixed-window sites that can currently pass while asserting nothing. No helper can catch 64/78/80 — those are "the design changed and the contract did not", which requires a human or agent to decide what the contract now means.

## Metadata

**Tags:** test, refactor, reliability, devops
**Complexity:** 7

Complexity 7 reflects the **recommended split** (see "Scope fence"): the helper set, its self-test and the ban gate as one shippable change, then the 62 marker-bounded sites across 26 files. Landing all 156 sites in one change is complexity 8 and is not recommended.

## User Review Required

None.

## Scope fence

**In scope (this plan, phased — Phase 1 and Phase 2):** the shared helper set (`at()` + `span()`), its self-test, the ratchet gate that keeps raw sites from coming back, and migrating the **62 marker-bounded sites across 26 files** onto `span()`.

**Recommended split — flag to the user, do not do silently.** With the corrected census this plan carries three independently-shippable phases and four distinct deliverables. Recommended decomposition:

- **P1 — helper set + self-test + ban gate.** New files only. No existing test touched. Independently shippable and independently verifiable (the self-test *is* the verification).
- **P2 — the 62 marker-bounded sites (26 files) onto `span()`.** The safety-critical population: every mode-1, mode-2 and mode-4 site lives here.
- **P3 — the remaining 94 index-derived sites (51 fixed-window + 38 both-vars + 4 prefix + 1 other) onto `at()`.** Strictly mechanical and semantics-identical: `at()` returns the same index `indexOf` returned or throws, so no span content changes. This is the phase that closes mode 3.

**Out of scope of every phase — flag, do not do:**
- **Consolidating the 20 `block()` definitions in Population A.** They already guard both markers, so migrating them is hygiene plus a diagnostic upgrade, not a safety fix. It is also 20 more files of churn, and 9 of those files are already touched by P2/P3 — merging both jobs into one diff makes neither reviewable. Separate plan.
- **Fixing the memo case.** `ci-contract-span-rot-memo-binding-and-pane-fit.md` owns run-step 65. This plan must land *after* it and migrate the corrected span onto the helper — see Dependencies. Fixing it here would erase that plan's fixture and double up the change.
- **Any change to what a contract asserts.** This is a mechanical substitution of the extraction mechanism. If migrating a site reveals that its span was degenerate and its assertions were vacuous, that is a **finding to report**, not a licence to rewrite the assertion here.

## Complexity Audit

### Routine

- Two new files (`src/test/helpers/sourceSpan.js`, `src/test/helpers/sourceSpan.selftest.js`) plus one new gate script, then a mechanical substitution at the call sites.
- The shared-helper pattern already exists and is established: `src/test/helpers/verbEngineTestSeams.js` (the only current occupant of `src/test/helpers/`), required as `require('./helpers/verbEngineTestSeams')` from contract tests. No new infrastructure, no build step — these are plain `node` scripts.
- The ratchet-gate pattern already exists and is established: `scripts/check-push-routing.js` and `scripts/check-verb-return-contract.js` with a JSON baseline that only ever ratchets down, wired as `npm run push-routing:check` / `verb-returns:check` and as CI steps. The new gate is a copy of that shape, and it is exactly what the project PRD means by "done is machine-checked, not asserted".
- Wiring is well-trodden: each contract test gets a `test:contract:<name>` script in `package.json` and a two-line CI step (`- name: … / run: npm run test:contract:<name>`). There are 86 such steps in `.github/workflows/integration-tests.yml` today.
- The semantics being consolidated are already agreed on the two guards that matter: 20 independent authors converged on them.
- No production code. No schema, no migration, no runtime path, no shipped state.

### Complex / Risky

- **26 files in P2 (55 if P3 is folded in), and the failure mode of a bad migration is a test that still passes.** Substituting a span mechanism can silently widen or narrow what an assertion sees. A file whose pass/fail counts are unchanged is *necessary but not sufficient* evidence the migration was faithful — a vacuous assertion passes before and after.
- **The guard will turn currently-green tests red, and those are real findings.** Any of the 39 two-arg sites whose span silently runs to EOF, and any of the 51 fixed-window sites whose start marker has drifted, has assertions that may only pass because they matched unrelated code (or matched nothing at all). Adding the guard exposes them. Expect reds, treat each as a discovery, and do **not** loosen the guard to make them go away.
- **The signature has to be right the first time, and the original one could not express three real shapes.** Exclusive start (9 sites), inclusive end (Population A's `terminal-sidebar-role-ordering`), and end-searched-from-the-start-marker's-own-index (the two `new Function()` sites in `tickets-subtask-embedding`). A signature settled without these forces a second sweep, which is the exact cost this plan exists to avoid.
- **Threshold choice is a real trade-off, and it is not the mode-4 mechanism.** `minLines` must be caller-overridable, its default must be justified, and the plan must not claim it catches collapsed windows — measured, it does not catch the one collapsed window we have.
- **A helper that throws inside a `test()` harness is caught as a test failure, not a crash.** These harnesses wrap each test in `try/catch` and increment a failure counter. That is the desired behaviour, but it means a helper throw must carry a message good enough to diagnose from one line of console output — the whole point of the exercise.
- **This plan's own guard could be weakened silently.** Same failure mode as everything else in this sweep: a helper whose degeneracy check is unreachable looks identical to one that works. It needs its own self-test, in-suite, plus the ratchet gate so removed call sites cannot quietly reappear as raw slices.

## Edge-Case & Dependency Audit

- **Race conditions.** None. All extraction is synchronous string manipulation.

- **Security.** None. No production file, runtime path, network surface, or user input. Two sites (`tickets-subtask-embedding.test.js:451`, `:469`) feed the extracted span to `new Function()`, but the input is repo source read from disk in a test — not a new trust boundary, and the migration does not widen it.

- **Side effects.** None outside the test suite. No gate script reads test files: `grep -l 'src/test' scripts/check-*.js` returns nothing. The one nuance is that `standalone-fork:check` *is* itself a test file (`node src/test/standalone-kanban-fork-detector.test.js`) — it contains zero `.slice(`/`.substring(` calls, so it is untouched by this migration either way. `parity:check`, `push-routing:check`, `verb-returns:check`, `mirror:check` are unaffected.

- **`slice` vs `substring` differ on negative arguments and both are in use.** `substring` clamps negatives to 0 (so a missing marker silently yields a span from the *file start*), while `slice` treats them as end-relative offsets. 10 of the 62 marker-bounded sites and 19 of the 20 `block()` definitions use `substring`. The helper must not preserve either behaviour — it must reject the failed lookup before any slicing happens. Do not assume the two idioms are interchangeable when reading existing sites.

- **Legitimately tiny spans exist in principle, and must remain expressible.** The default threshold must be low, and `opts.minLines` must let a caller assert an even smaller span deliberately.

  > **Superseded:** "`notifyInputDropped` in `terminals.js` is two lines. A hard minimum would break valid contracts."
  > **Reason:** No test extracts `notifyInputDropped` as a span. Both references (`terminal-chrome-not-in-buffer.test.js:140`, `terminal-focus-affordance-contract.test.js:129`) use `'function notifyInputDropped('` as an **end** marker bounding `syncInputStateChip`. The cited justification for `minLines: 2` was a hypothetical presented as a live site.
  > **Replaced with:** the risk is real but currently unexercised — no site in the suite extracts a span of fewer than 2 lines. `minLines: 2` is therefore chosen because it is the weakest threshold that still rejects a one-line window (mode 2's signature) while being provably false-alarm-free against the suite as it stands today. Note also that the two `new Function()` sites in `tickets-subtask-embedding.test.js` look like single-line spans under a naive reading of their `'\n'` end marker — they are not; the `'\n'` is the *inner* lookup that finds the end of the signature line, and the real end marker is `'\n    }'`. Read the nesting before assuming a span is one line.

- **A span that legitimately runs to EOF is the *normal* shape for one-arg sites, not an exception.**

  > **Superseded:** "`headless-feature-management-contract.test.js:476` uses the one-arg form intentionally — everything from a marker to end of file. The helper must support that as an *explicit* option (`toEnd: true`)."
  > **Reason:** Directionally right, materially undercounted. There are **23** one-arg sites, not one, and inspection shows most are deliberate "rest of the string" probes (`release.slice(release.indexOf('webgl.onContextLoss('))`, `fn.slice(fn.indexOf("group.source === 'role'"))`, and so on). `toEnd` is not a carve-out for a single site; it is the declared intent at roughly a third of the marker-bounded population, and 9 of those 23 also need an offset start.
  > **Replaced with:** `toEnd: true` is a first-class, commonly-used option. All 23 one-arg sites migrate to it. Its value is unchanged — it makes "runs to EOF" a *declared* intent rather than the accidental result of a missing marker — but it is a mainstream path, so its ergonomics and its interaction with `afterStart` must be designed, not bolted on.

- **Non-unique markers are the mode-4 hazard, and a size check cannot solve it.** A marker that matches earlier than intended may yield a plausibly-sized span — measured at 3 lines in the memo case. The helper rejects generic end markers by default (`allowGenericEnd: false`) and the migration must prefer a structural boundary (the next `case '`, the next declaration) at the 7 sites that currently use one. The size guard is the backstop, not the fix.

- **Indent-anchored closers are *not* generic and must not be rejected.** `'\n    }'`, `'\n }'`, `'\n },'`, `'\n private '` appear at ~13 sites and are genuinely structural — they pin a closing brace at a known indentation level, which an inserted guard clause inside the block cannot move. The generic-marker check must distinguish these from bare `'}'` / `'};'` / `' }'`, or it fires on a third of the suite and gets switched off.

- **`indexOf` with a `fromIndex` of the start marker's own position.** Several sites correctly pass `idx` as `fromIndex`; a naive migration that drops it would find an *earlier* occurrence of the end marker and invert the span. The helper must always search for the end marker from the end of the start marker by default, and its inversion guard must catch it if that is ever bypassed. Note that Population A does the opposite — 19 of 20 `block()` definitions search from `start`, not `start + startMarker.length` — so the default must be documented as a deliberate divergence, and `opts.endFrom: 'startMarkerStart'` must exist for the two `tickets-subtask-embedding` sites that depend on it.

- **Dependencies & conflicts.** Test files only, and they parallelise freely — no two of the 26 (or 55) share a file. Nine files sit in both populations (`shell-terminal-strip`, `terminal-flow-control`, `terminal-input-path`, `terminal-open-all-seating`, `terminal-pane-grid-reconcile`, `terminal-pane-pinning`, `terminal-renderer-lifecycle`, `terminal-sidebar-groupings`, `ws-surface-scoping`) and will temporarily carry both a local `block()` and a `require` of the shared helper. That is acceptable and expected; the follow-up plan removes the local definitions. It is **not** a reason to pull Population A into this plan. The one ordering constraint is the memo file (see Dependencies).

## Dependencies

- **`ci-contract-span-rot-memo-binding-and-pane-fit.md` — hard ordering.** That plan re-anchors `memo-panel-workspace-binding-contract.test.js` to bound the handler by the next `case '` instead of the first `break;`. This plan then migrates that corrected span onto the shared helper. Landing this first would mean fixing the same file twice and destroying the other plan's negative-control fixture.

  Two points of composition worth stating, both verified against that plan's text:
  - Its corrected shape is still a raw slice — `const nextArm = handler.indexOf("case '", 1); const body = handler.slice(0, nextArm);` — with an unguarded `-1` path it explicitly reasons about and accepts as "harmless here", plus a hand-written `assert.ok(/\bbreak;/.test(body))` sanity assertion as a bespoke guard. Migrating it to `span(memoJs, "case 'workspaceChanged'", "case '", { label: 'memo.js' })` subsumes both: the guard becomes structural, and the bespoke sanity assertion becomes redundant. **Leave the sanity assertion in place** — removing it is an assertion change, which the scope fence forbids.
  - That plan's footnote that the span "must use a non-zero `fromIndex`, because the slice *starts* with the literal `case 'workspaceChanged'`" is satisfied for free by this helper's default (`endFrom: 'startMarkerEnd'`). That default is not incidental — it is load-bearing for the memo site.
- No other dependency. This plan does not need CI to be green and does not unblock any CI step by itself — run-steps 11, 64, 65, 76, 78, 80 are owned by the three plans covering them.

## Adversarial Synthesis

**Risk Summary.** The dominant risk is that a mechanical substitution across 26–55 files silently changes what assertions see, and the evidence normally used to check a test change — unchanged pass/fail counts — is worthless here, because the defect being removed is precisely an assertion that passes while guarding nothing. The second risk is a signature settled on an undercounted census: the original API could not express exclusive-start (9 sites), inclusive-end (Population A), or end-searched-from-the-start-marker (2 sites), and a signature that has to change later forces the second sweep this plan exists to prevent. The third is mistaking the backstop for the mechanism — a `minLines` threshold cannot catch a collapsed window (measured: the memo span is 3 lines and passes `minLines: 2`), so mode 4 is closed by rejecting generic end markers, and the plan must not claim otherwise.

## Proposed Changes

### `src/test/helpers/sourceSpan.js` (new) — two primitives, layered

**Context.** New file, alongside the established `src/test/helpers/verbEngineTestSeams.js`.

> **Superseded:** a single `span(src, startMarker, endMarker, opts)` primitive as the whole deliverable, migrating 55 sites.
> **Reason:** measured, `span()` can only absorb 62 of the 156 raw sites. The other 94 — 51 fixed-window `slice(idx, idx + N)`, 38 two-arg-both-vars, 4 prefix cuts, 1 other — have no marker pair to express, so under a `span()`-only design they keep the raw `indexOf` and keep mode 3 (the *largest* shape stays unguarded). Worse, `span()` is a *semantic* substitution: it decides what the span contains, so every one of its 62 migrations can silently widen or narrow an assertion's view. The plan's own top risk.
> **Replaced with:** two layers. `at()` is a guarded `indexOf` — it returns exactly the index `indexOf` returned, or throws. Substituting it is **semantics-identical by construction**, it covers all 156 sites including every shape above, and it alone closes modes 1, 2 and 3 (all three are `-1` flowing into a slice). `span()` remains, built on `at()`, as sugar for the 62 marker-bounded sites — that is where the degeneracy check, the generic-marker rejection and the rich diagnostics earn their place. `at()` is the safety fix; `span()` is the diagnostic and mode-4 fix.

**Logic.** Resolve every index through a guard before it reaches a slice. `at()` is the floor: no `-1` can escape it. `span()` layers marker-pair semantics on top — inversion, degeneracy, generic-marker rejection — and when a marker is missing it does not just say so, it prints what is actually there, so the reader gets the replacement rather than a research task. That last part is what turns a `const DEFAULT_ROLES` → `const NO_ROLE` rename from git archaeology into a one-line answer.

**Implementation.**

```js
'use strict';

/**
 * Guarded source-text navigation for the contract suite.
 *
 * Why this exists: `indexOf` returns -1 on a miss, and `slice` accepts -1 as an
 * end-relative offset while `substring` clamps it to 0. A failed marker lookup is
 * therefore not an error — it is a valid argument that yields a plausible-looking
 * span. Four silent modes follow:
 *
 *   src.slice(idx, -1)        -> runs to EOF; assertions match unrelated code and the
 *                                test passes while guarding nothing.
 *   src.slice(-1)             -> one character; every `!includes()` passes.
 *   src.slice(-1, -1 + 500)   -> empty string; every `!includes()` passes.
 *   non-unique end marker     -> the window collapses (which is how a `workspaceChanged`
 *                                contract came to report correct code as missing).
 *
 * Resolve first, slice second, and never return a span nobody asked for.
 *
 * TWO LAYERS, on purpose:
 *   at()   — a guarded indexOf. Returns the same index indexOf would, or throws.
 *            Semantics-identical substitution, so it is safe at ANY site, including
 *            the fixed-window `slice(idx, idx + N)` shape that has no end marker.
 *   span() — marker-pair sugar built on at(). Adds inversion, degeneracy and
 *            generic-marker guards plus diagnostics. Decides span CONTENT, so a
 *            migration onto it must be checked, not assumed.
 */

/** Control-flow and punctuation tokens any inserted statement can move. */
const GENERIC_END_MARKERS = new Set([
    'break;', 'break', 'return;', 'return', 'continue;',
    '}', '};', '},', '{', ');', ')', ';', '=>', '\n',
]);

/**
 * Guarded index lookup — use this ANYWHERE an index feeds a slice.
 *
 * @param {string} src
 * @param {string} marker
 * @param {object} [opts]
 * @param {number} [opts.from=0]      search origin, as indexOf's fromIndex
 * @param {string} [opts.label]       source name for messages, e.g. 'terminals.js'
 * @returns {number} the index of `marker` (never -1 — it throws instead)
 */
function at(src, marker, opts = {}) {
    const label = opts.label || 'source';
    const from = opts.from || 0;
    const i = src.indexOf(marker, from);
    if (i === -1) {
        throw new Error(
            `[sourceSpan] marker not found in ${label}`
            + (from ? ` searching from line ${lineOf(src, from)}` : '')
            + `: ${JSON.stringify(marker)}`
            + describeNearest(src, marker)
            + (from ? describeFollowing(src, from) : '')
        );
    }
    return i;
}

/** Convenience: bind a source + label once, then navigate it. */
function bind(src, label) {
    return {
        text: src,
        at: (marker, from) => at(src, marker, { from, label }),
        span: (startMarker, endMarker, opts) => span(src, startMarker, endMarker, { label, ...opts }),
    };
}

/**
 * Extract a source span between two literal markers.
 *
 * @param {string} src
 * @param {string} startMarker              literal that opens the span
 * @param {string} [endMarker]              literal that closes it. Omit with opts.toEnd.
 * @param {object} [opts]
 * @param {boolean} [opts.toEnd]            span deliberately runs to end of source
 * @param {boolean} [opts.afterStart]       exclude the start marker from the span
 * @param {boolean} [opts.includeEnd]       include the end marker in the span
 * @param {'startMarkerEnd'|'startMarkerStart'} [opts.endFrom='startMarkerEnd']
 *        where to begin searching for the end marker. The default is deliberate and
 *        DIVERGES from the legacy per-file `block()` helpers, 19 of which search from
 *        the start marker's own index. Use 'startMarkerStart' only when a site
 *        genuinely depends on that (e.g. an end marker nested inside the start line).
 * @param {number}  [opts.minLines=2]       backstop: reject a span shorter than this.
 *        NOT the mechanism for a collapsed window — a collapsed window can be any
 *        size (the memo case measured 3 lines). allowGenericEnd is that mechanism.
 * @param {boolean} [opts.allowGenericEnd]  permit a generic-token end marker
 * @param {string}  [opts.label]            source name for messages
 */
function span(src, startMarker, endMarker, opts = {}) {
    const label = opts.label || 'source';
    const start = at(src, startMarker, { label });
    const spanStart = opts.afterStart ? start + startMarker.length : start;

    if (opts.toEnd) { return src.slice(spanStart); }
    if (!endMarker) {
        throw new Error(`[sourceSpan] ${label}: endMarker is required unless opts.toEnd is set`);
    }

    if (!opts.allowGenericEnd && isGenericMarker(endMarker)) {
        throw new Error(
            `[sourceSpan] ${label}: end marker ${JSON.stringify(endMarker)} is a generic token. `
            + `Any inserted guard clause, early return or nested block moves it, which silently `
            + `collapses the span — this is exactly how a workspaceChanged contract came to accuse `
            + `correct code of a missing statement. Prefer a structural boundary (the next \`case '\`, `
            + `the next declaration, an indent-anchored closer like "\\n    }"), or pass `
            + `opts.allowGenericEnd if this token really is the contract's boundary.`
        );
    }

    // Search AFTER the start marker by default. Several legacy call sites pass a
    // fromIndex for exactly this reason; dropping it finds an EARLIER occurrence
    // and inverts the span.
    const from = opts.endFrom === 'startMarkerStart' ? start : start + startMarker.length;
    const end = at(src, endMarker, { from, label });
    const spanEnd = opts.includeEnd ? end + endMarker.length : end;

    if (spanEnd <= spanStart) {
        throw new Error(
            `[sourceSpan] inverted or empty span in ${label}: `
            + `${JSON.stringify(startMarker)} at line ${lineOf(src, start)}, `
            + `${JSON.stringify(endMarker)} at line ${lineOf(src, end)}. Check declaration order.`
        );
    }

    const text = src.slice(spanStart, spanEnd);
    const lines = text.split('\n').length;
    const minLines = opts.minLines ?? 2;
    if (lines < minLines) {
        throw new Error(
            `[sourceSpan] degenerate span in ${label}: ${lines} line(s) between `
            + `${JSON.stringify(startMarker)} (line ${lineOf(src, start)}) and `
            + `${JSON.stringify(endMarker)} (line ${lineOf(src, end)}). The end marker `
            + `probably resolved earlier than intended — prefer a structural boundary, or pass `
            + `opts.minLines if this span really is this small.\n---\n${text}\n---`
        );
    }
    return text;
}

/**
 * Generic = movable. A marker is generic when it carries no identifier at all, or is a
 * bare control-flow token. Indent-anchored closers ("\n    }", "\n private ") are NOT
 * generic — the leading newline plus indentation pins them to a structural level that
 * a statement inserted inside the block cannot move. ~13 sites rely on that shape.
 */
function isGenericMarker(marker) {
    if (/^\n[ \t]{1,}/.test(marker)) { return false; }
    const t = marker.trim();
    if (GENERIC_END_MARKERS.has(t)) { return true; }
    return !/[A-Za-z_$]/.test(t);
}

function lineOf(src, index) {
    return src.slice(0, index).split('\n').length;
}

/** On a missing END marker, show what actually follows the start — usually the renamed marker. */
function describeFollowing(src, from, count = 4) {
    const decls = [];
    const lines = src.slice(from).split('\n');
    const startLine = lineOf(src, from);
    for (let i = 0; i < lines.length && decls.length < count; i++) {
        if (/^\s{0,8}(?:export\s+)?(?:const|let|var|function|class|async function)\s+\w/.test(lines[i])) {
            decls.push(`    ${startLine + i}: ${lines[i].trim()}`);
        }
    }
    return decls.length
        ? `\n  The next declarations after the search origin are:\n${decls.join('\n')}`
          + `\n  If one of these is your marker under a new name, retarget it.`
        : '';
}

/** On a missing marker, show the longest prefix that DOES resolve. */
function describeNearest(src, marker) {
    for (let len = marker.length - 1; len >= 4; len--) {
        const at_ = src.indexOf(marker.slice(0, len));
        if (at_ !== -1) {
            return `\n  Longest matching prefix ${JSON.stringify(marker.slice(0, len))}`
                + ` found at line ${lineOf(src, at_)}: ${JSON.stringify(src.slice(at_, at_ + marker.length + 24).split('\n')[0])}`;
        }
    }
    return '';
}

module.exports = { at, span, bind, lineOf, isGenericMarker };
```

**Call style.** `bind()` is the recommended shape at multi-site files, because it carries `label` once:

```js
const { bind } = require('./helpers/sourceSpan');
const kanban = bind(fs.readFileSync(kanbanHtmlPath, 'utf8'), 'kanban.html');

// marker-bounded — mode 1/2/4 site
const arm = kanban.span("case 'sendDispatchSetToCoders': {", "case 'importFromClipboard'");

// fixed-window — mode 3 site, no end marker exists; at() is the whole fix
const i = kanban.at('function updateFeatureActionButton()');
const body = kanban.text.slice(i, i + 1600);
```

**Threshold rationale.** `minLines` defaults to 2 because that is the weakest threshold that still rejects a one-line window — mode 2's signature — and it is provably false-alarm-free against the suite as it stands (no site extracts a span of fewer than 2 lines; verified during the census). It is explicitly a backstop: the measured mode-4 instance is 3 lines and passes it. `allowGenericEnd: false` is the mode-4 mechanism and the error message says so.

**Edge cases.** `describeFollowing`'s declaration regex is a heuristic for diagnostics only — it never affects pass/fail, so a miss degrades the message and nothing else. `toEnd` makes "runs to EOF" a declared intent, which is the only way the EOF hazard and the 23 legitimate one-arg EOF spans can coexist. `isGenericMarker`'s indent-anchor exemption is load-bearing — without it the check fires on ~13 healthy sites and gets disabled wholesale, which is worse than not having it.

### `src/test/helpers/sourceSpan.selftest.js` (new) — the guards must be provably able to fire

**Context.** New file. Needs a `package.json` script (`test:contract:source-span` → `node --require ./src/test/bootstrap/sandboxStateHome.js src/test/helpers/sourceSpan.selftest.js`, matching the 86 existing `test:contract:*` scripts) and a two-line CI step in `.github/workflows/integration-tests.yml` in the established `- name: … / run: npm run …` form. Nothing auto-discovers files in `src/test/`, so without both it never runs.

**Logic.** Every guard in this sweep has the same dominant failure mode: a check that can no longer fire looks exactly like a check that passes. The guards *are* the deliverable, so they are pinned against fixtures rather than trusted.

**Implementation.** Assert, at minimum:

- `at()` throws on a missing marker, and the message carries the longest-resolving prefix.
- `at()` with a `from` throws on a marker that exists only *before* `from`, and the message lists the following declarations.
- `at()` returns exactly `indexOf`'s value on a hit — the semantics-identity property the P3 migration depends on. Assert it over a handful of markers, not just one.
- A missing start marker in `span()` throws; a missing end marker throws.
- An inverted span (end marker occurring only *before* the start marker) throws rather than returning a backwards or empty string.
- A one-line span throws by default and is accepted with `minLines: 1`.
- `toEnd: true` returns to end of source and does not throw; `toEnd` composed with `afterStart: true` excludes the start marker.
- `includeEnd: true` includes the end marker; the default excludes it.
- `endFrom: 'startMarkerStart'` finds an end marker nested inside the start marker's own line, and the default does not.
- **A generic end marker throws by default and is accepted with `allowGenericEnd: true`** — cover `'break;'`, `'};'`, `'=>'`, `' }'`.
- **Indent-anchored closers are NOT rejected** — `'\n    }'`, `'\n },'`, `'\n private '` must pass with `allowGenericEnd` unset. This is the false-alarm guard; without it the generic check is one bad regex away from being switched off across the suite.
- **The memo fixture.** Reproduce the shape: a switch arm whose first `break;` belongs to a guard clause. Assert that `span(fixture, "case 'workspaceChanged'", 'break;')` **throws on the generic-marker check**, and — this is the negative control that keeps the plan honest — assert that with `allowGenericEnd: true` it returns a 3-line span and therefore **does not** trip `minLines: 2`. If someone later "simplifies" the mode-4 defence back to a size threshold, this assertion fails.

### `scripts/check-source-span.js` + `scripts/source-span-baseline.json` (new) — the win has to ratchet

**Context.** New gate, modelled directly on `scripts/check-push-routing.js` and `scripts/check-verb-return-contract.js`: count an anti-pattern, compare against a JSON baseline, fail if the count went **up**, and only ever ratchet the baseline down. Wired as `npm run source-span:check` and a CI step. The project PRD's enforcement section is explicit that "done" is machine-checked rather than asserted, and every other invariant in this repo that has stayed fixed has a ratchet behind it.

**Logic.** Without a ratchet, the 156 sites are removed once and reappear one PR at a time, because the raw idiom is shorter to type than the guarded one. ESLint cannot police this: `eslint.config.js` scopes its only rule block to `files: ['**/*.ts']`, so a `no-restricted-syntax` rule would not see a single `.test.js` file. A standalone script is the mechanism, and it is the pattern this repo already uses.

**Implementation.** Walk `src/test/**/*.js`. For each `.slice(` / `.substring(` call, parse its balanced argument list and flag the site when any argument contains `.indexOf(` or references a variable assigned from `.indexOf(` in the same file. Skip the interior of the 20 legacy `block()` definitions (they are Population A, owned by the follow-up plan) and skip `src/test/helpers/sourceSpan.js` itself. Emit per-file counts and a total. Compare against `source-span-baseline.json`; fail on any increase; support `--write` to ratchet down, exactly as `verb-returns:baseline` does. Seed the baseline from the count at the time P1 lands (176 total / 156 excluding `block()` interiors at the time of writing — regenerate rather than hard-coding these).

**Edge cases.** The parser must handle nested calls and template literals — the two `tickets-subtask-embedding` sites nest three `indexOf` calls inside one `slice`, and a line-oriented regex miscounts them. Count *sites*, not lines: `browser-planner-dispatch-surface.test.js` has the same expression on lines 183 and 202 and both must count.

### The 62 marker-bounded sites across 26 files — Phase 2, substitution onto `span()`

**Context.** 39 two-arg inline-`indexOf`-end sites and 23 one-arg to-EOF sites. 25 of the 62 already assert their start index; 10 use `substring`.

**Logic.** One file at a time. For each site: identify the intended span, express it as a `span()` call, and choose a **structural** end marker at the 7 sites whose end marker is a generic token — the helper will refuse to proceed otherwise, which is the point. Convert all 23 one-arg sites to `toEnd: true` rather than leaving EOF to be inferred. Use `afterStart: true` at the 9 sites whose current form offsets past the marker (`slice(templateIdx + 'template:'.length)` and friends); dropping the offset silently prepends the marker text to the span, which flips any `!includes()` assertion that happens to match inside it. Use `endFrom: 'startMarkerStart'` at the two `tickets-subtask-embedding` `new Function()` sites. Pass `label` (or use `bind()`) so every message names its source file.

**Implementation.** Per file: `const { bind } = require('./helpers/sourceSpan');`, bind each source once, then substitute each site. Do not touch any assertion. Where a site already asserts its start index (`assert.notStrictEqual(armIdx, -1, …)`), **leave the assertion in place** — it is now redundant but removing it is an assertion change. `substring`-based sites need care: `substring` clamps negatives to 0, so its degenerate span starts at the *file start*, not EOF; read what the site actually intended rather than assuming it matches the `slice` sites.

**Edge cases.** Where a site's span was genuinely degenerate, the migration surfaces it as a throw. Record it, leave the assertions alone, and raise it — a vacuous assertion is a separate finding with its own root cause, and folding a rewrite into a multi-file mechanical sweep is how it stops being reviewable.

### The remaining 94 index-derived sites — Phase 3, substitution onto `at()`

**Context.** 51 fixed-window `slice(idx, idx + N)` sites across 24 files (22 of which already assert the start index), 38 two-arg-both-vars sites, 4 prefix cuts, 1 other. Recommended as its own plan; specified here so the split is a decision about sequencing rather than about content.

**Logic.** Purely mechanical and semantics-identical: replace each `src.indexOf(marker)` (or `src.indexOf(marker, from)`) that feeds a slice with `at(src, marker, { from, label })`. The slice arithmetic, the window sizes and the span content are untouched. This is the phase that closes mode 3 — an empty fixed-window span caused by a drifted start marker becomes a throw naming the marker and its nearest resolving prefix.

**Implementation.** Prefer `bind()` at files with several sites. Where a site already has `assert.ok(idx > 0)` or `assert.notStrictEqual(idx, -1)`, leave it. Do not convert a fixed window into a marker pair — that is a semantic change and belongs in a separate, deliberate edit with its own review.

**Edge cases.** Watch for `at()` shadowing a local named `at` (the helper's own `describeNearest` renames its local for this reason). A fixed window whose `N` is now too small to contain the code it asserts on is a pre-existing, unrelated defect — record it, do not resize it in this sweep.

## Verification Plan

### Automated Tests

1. `npm run test:contract:source-span` — all guards pass, including the memo-shaped fixture, the indent-anchored-closer false-alarm guard, and the `at()`-returns-`indexOf`'s-value identity assertions.
2. `npm run source-span:check` — green against a baseline seeded at P1 and ratcheted down at the end of P2 and P3. Confirm the ratchet works by adding a raw `src.slice(src.indexOf('x'), src.indexOf('y'))` to a scratch test file, seeing the gate fail, and removing it.
3. **Per-file invariant, recorded for every migrated file.** Capture each file's pass/fail counts before and after migration; they must be identical. **State plainly in the completion report that this is necessary but not sufficient** — a vacuous assertion passes on both sides — which is why step 4 exists.
4. **Faithfulness spot-check on a sample.** For at least five migrated files spanning both idiom forms — and including at least one `substring` site, one `afterStart` site and one `toEnd` site — sabotage the source the span reads so the assertion inside the span *should* fail, and confirm it does. **Revert each.** This is the only evidence that the migrated span still points at the code it claims to.
5. **The degeneracy survey — the plan's second deliverable.** Report every site where a guard threw during migration, classified as: end marker missing (was running to EOF — its assertions may have been vacuous), start marker missing (fixed-window span was empty), span collapsed, generic end marker replaced with a structural one, or deliberate EOF span now marked `toEnd`. A run with zero throws in a given class is a legitimate outcome and must be stated as such rather than left implicit.
6. Run the CI steps for every migrated file and confirm no step that was green before is red for a reason unrelated to a genuine finding from step 5.
7. `npm run parity:check`, `npm run push-routing:check`, `npm run verb-returns:check`, `npm run mirror:check` — green. None reads a test file, so any change here is a signal that the sweep escaped its scope.
8. Confirm `git diff --name-only` contains only `src/test/**`, `scripts/check-source-span.js`, `scripts/source-span-baseline.json`, `package.json` and `.github/workflows/integration-tests.yml`. No production source file.
9. Confirm the new CI step actually appears in `.github/workflows/integration-tests.yml` and the new `package.json` scripts resolve — a helper self-test that no runner invokes is the same silent-green failure this plan is about.

### Manual

10. None. Nothing here touches a runtime path.

## Agent Recommendation

**Send to Lead Coder** (complexity 7) — a new shared primitive whose signature has to be right the first time (Population A migrates onto it later, and the original signature could not express three real shapes), a new ratchet gate, and a multi-file sweep whose mistakes produce passing tests rather than failing ones.

**Recommend the split first.** P1 (helper + self-test + gate) is a clean, independently-verifiable change. P2 (62 sites / 26 files) is the safety-critical migration. P3 (94 sites) is mechanical and semantics-identical. Landing all three as one change is complexity 8 and produces a diff no reviewer can hold.

The reviewer should check six things: that the self-test exists, is wired into `package.json` **and** CI, and that its generic-marker and indent-anchor guards are provably able to fire (steps 1 and 9); that the ratchet baseline was regenerated rather than hand-edited, and ratchets **down** at the end of each phase (step 2); that **no assertion was changed** anywhere — the diff should show extraction mechanism only, and pre-existing `!== -1` asserts should still be present even though the helper makes them redundant; that the faithfulness spot-checks in step 4 were actually run, since unchanged pass/fail counts prove nothing about a vacuous assertion; that deliberate EOF spans are marked `toEnd: true` and offset starts are marked `afterStart: true` rather than silently absorbing the marker text; and that any site where a guard threw appears in the step-5 survey instead of having been quietly made to pass — in particular that no site acquired `allowGenericEnd: true` or a raised `minLines` as a way of making a throw go away.

**Follow-up, deliberately excluded (see Scope fence):** migrating the 20 `block()` definitions in Population A onto this helper. They already guard both markers, so it buys diagnostics and the removal of 20 duplicate definitions rather than a safety fix — but until it lands, the improved "here are the next declarations" message does **not** reach the class of failure that hit `terminal-pane-fit`. Note that plan must handle two inherited behaviours: 19 of the 20 use `substring`, and `terminal-sidebar-role-ordering-contract.test.js` returns an **inclusive** end (`slice(start, end + endMarker.length)`) — hence `opts.includeEnd` exists in this signature now, so that sweep does not have to change it.
