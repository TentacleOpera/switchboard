# A composition-root parity gate that actually fails

## Goal

Add a CI gate that compares the **options objects** the two hosts hand to shared services, and fails on any key present in one root and absent from the other unless it is on an explicit, justified allowlist. Today no gate looks at composition roots, which is why the same class of defect has now shipped twice.

### Problem Analysis

`CLAUDE.md` states the rule — *"Standalone and the extension MUST NOT diverge. NO EXCEPTIONS"* — and then documents why the rule is not enough:

> **The trap is not verbs.** `bootstrap.ts`'s `default:` arm delegates every unmatched verb to the provider, so verb-reachability audits always come back green. The trap is **composition-root wiring**: service seams (`engine.setX(...)`), options objects handed to shared services, and `Promise<void>` callbacks where "never wired" and "working" are the same value.

That was written after the 2026-08 incident in which all four `PlanIngestionEngine` queue seams were wired in `extension.ts` only, for a month, with **every gate green**. The stated remedy was *"diff the two roots by hand."*

**Hand-diffing did not hold.** A fresh mechanical diff of the two `LocalApiServer` option objects — `TaskViewerProvider.ts:3707` (57 keys) against `bootstrap.ts:2756` (45 keys) — finds **sixteen** options wired in the extension only, including `moveCard`, which makes `POST /kanban/move` return `503` on every standalone host. That is a documented HTTP route, in the docs, dead in one of two shipped hosts.

The lesson is not that someone forgot to hand-diff. It is that **a manual audit is not a gate.** An instruction to check something by hand fails silently the first time anyone is busy, and produces no artefact when it passes.

### Root Cause

Every existing gate checks a layer where divergence does not hide:

| Gate | What it checks | Why it misses this |
| :--- | :--- | :--- |
| `standalone-parity:check` | Browser read-back path | Scoped to reads, not construction |
| `parity:check` | Protocol parity | Verbs, and the `default:` arm makes verbs always reachable |
| `host-seam-parity:check` | Host seam interfaces | The seam *interface*, not which seams each root wires |
| `verb-returns:check` | Verb return contracts | Return shapes, not presence |

None of them enumerate what each composition root actually passes. The gap is structural, not an oversight in any one gate.

Two properties of the code make the defect invisible to the compiler as well:

- Every field on `LocalApiServerOptions` is **optional**, deliberately, so test harnesses can construct a partial server. Optionality is correct and should stay — but it means omission is never a type error.
- `bootstrap.ts` declares its object as **`const options: any`**, discarding even the weak signal a typed literal would give.

## Metadata

**Complexity:** 5
**Tags:** ci, tooling, standalone, parity, reliability

## Approach

**A source-level key-set diff, not a runtime one.** The gate must not need to boot either host — booting the extension requires VS Code, and a gate that cannot run in plain CI will be skipped. Parse the two option literals from source and compare key sets.

1. **`scripts/check-composition-root-parity.js`**, in the shape of the existing `scripts/check-*.js` gates, wired as `npm run composition-parity:check` and added to the same CI job that runs the other parity checks.

2. **Locate the roots by marker, not by line number.** Line numbers drift; the plan that fixes the current gap will itself move them. Put a stable comment marker at each site — `// @composition-root LocalApiServer` — and have the script find those. A missing marker fails the gate: that is how a third construction site added later gets caught instead of silently escaping.

3. **Parse the object literal properly.** Use the TypeScript compiler API, already a dependency, rather than a regex. A regex over property syntax gets shorthand properties (`kanbanVerb,`) wrong — that exact mistake understated the gap as 21 keys before a corrected parse put it at 16, and an over-reporting gate gets muted rather than fixed.

4. **An explicit allowlist with reasons**, checked in beside the script:

   ```js
   // Keys legitimately wired in one host only. Every entry needs a reason.
   const HOST_SPECIFIC = {
     standalone: {
       port: 'The extension has no listening port of its own.',
       terminalWsGateway: 'PTY fleet transport; the extension uses VS Code terminals.',
       allowSecretWritesOverHttp: 'Standalone-only secrets path.',
       mintEnrolmentToken: 'Standalone-only device enrolment.',
     },
     extension: { /* populated by the seam-wiring plan, with a reason each */ },
   };
   ```

   The allowlist is the deliverable, not a workaround. It turns *"we forgot"* into *"we decided, and here is why"* — and a reviewer reading a new entry is being asked to agree with a claim rather than notice an absence.

5. **Fail loudly and specifically.** The output must name the key, both roots, and which side is missing, so the failure is actionable without reading the script.

6. **Generalise past `LocalApiServer`.** The same marker mechanism should cover any shared service constructed in both roots. Start with `LocalApiServer`; make adding a second service a matter of adding a marker pair.

## Complexity Audit

### Routine

- The script skeleton, the npm script, the CI wiring — all have close precedents in `scripts/check-*.js`.

### Complex / Risky

- **A gate that over-reports gets disabled.** The first run will report the current sixteen. If the seam-wiring plan has not landed, the gate is red on day one — which is correct but useless as a merge gate. Land the wiring first, or land the gate with the current sixteen pre-populated in the allowlist as `TODO:` entries and burn them down. Prefer the former.
- **Marker comments can be deleted.** Someone refactoring `bootstrap.ts` can remove the marker and silently disable the gate. Mitigate by failing when a marker is *absent*, and by asserting the expected marker count — zero markers must be a failure, not a pass over an empty set.
- **Key-set equality is necessary, not sufficient.** A key can be present in both roots and wired to a stub that returns `undefined`. This gate catches omission, not wrong implementation. Say so in the script header so nobody reads a green gate as a stronger guarantee than it is.
- **Don't make the options type non-optional.** It is tempting to force parity through the type system by making `LocalApiServerOptions` fields required. That breaks every test harness that constructs a partial server, and would be a much larger, worse change. The optionality is correct; the gate is the right layer.

## Edge-Case & Dependency Audit

**Migration.** None — a build-time gate touching no runtime code and no persisted state.

**Security.** Neutral. The gate reads source and exits non-zero; it ships nothing and reaches no network.

**Side effects.** CI gains one job step. If it runs in the existing parity job it costs no new runner.

**Ordering.** Land **after** the seam-wiring plan, so the gate goes green on arrival. Landing it first means either a red gate or an allowlist full of `TODO:` entries that nobody burns down — which reproduces the original failure with extra steps.

## Verification Plan

1. **Prove it catches the real bug.** Run the gate against the commit *before* the seam-wiring fix and confirm it fails, naming `moveCard` among the missing keys. A gate that has never failed on a known-bad input is not known to work.
2. **Prove it passes after.** Run against the fixed tree; expect exit 0.
3. **Synthetic regression.** Delete one key from the standalone options object in a scratch commit and confirm the gate fails naming that key. Restore.
4. **Marker removal.** Delete one `@composition-root` marker and confirm the gate fails rather than silently passing over one root.
5. **Shorthand properties.** Assert the parser sees `kanbanVerb,` (shorthand) and `moveCard: async (...) => {}` alike — a fixture covering both forms, since this is the specific way a naive implementation gets it wrong.
6. **Allowlist discipline.** An allowlist entry with an empty or missing reason string fails the gate.
7. Runs clean in CI with no VS Code and no running host.

## Dependencies

- **Depends on** the seam-wiring plan for a green baseline. Ship that first.
- **Follows the precedent of** `scripts/check-verb-return-contract.js` (the return-contract ratchet) for shape and CI placement.
- `CLAUDE.md`'s "Standalone and the extension MUST NOT diverge" section should be updated once this lands: the guidance currently ends at *"diff the two roots by hand"*, and should instead point at the gate, keeping the hand-diff advice only for the layers the gate cannot reach (stub implementations, and seams wired via `engine.setX(...)` rather than an options object).
