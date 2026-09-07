# What Reaches a Seat, and When

**Complexity:** 3

## Goal

Three plans on one defect class: instructions delivered once at spawn and needed hours later. The subagent policy, the completion-report directive and startup orientation all assume a seat remembers its first message.

<!-- BEGIN SUBTASKS (auto-generated, do not edit) -->
## Subtasks
- [ ] [The Subagent Policy Is Delivered Once and Is Not a Standing Order](../plans/the-subagent-policy-is-a-sentence-nothing-enforces-it.md) — **CODE REVIEWED** — ID: 95cab2e1-f649-40c6-afdd-193ab6478711
- [ ] [A Coder Is Told How to Report Once, at the Start, and Needs It Hours Later](../plans/a-coder-is-told-how-to-report-once-at-the-start-and-needs-it-hours-later.md) — **CODE REVIEWED** — ID: 3bd9b739-4757-4ca4-a830-c3213edead38
- [ ] [Startup Orientation Is for Hand-Driven Seats — Standalone Sends It to Automated Ones](../plans/the-after-clear-orders-delivery-bypasses-clear-readiness.md) — **CODE REVIEWED** — ID: 948968f2-a1ce-4250-9b7a-c128b26c3907
<!-- END SUBTASKS -->


## Review Findings

Two of the three subtasks are delivered; one has no implementation at all. Startup orientation
(`948968f2`) is complete and symmetric across both composition roots, with one stale CI-wired
assertion fixed. The subagent standing order (`95cab2e1`) was correct in composition but inert on
shipped state — the fragment id reached only rows created for the first time, because both writers skip
an existing row keyed on a deterministic id and the migration that would have upgraded them has no
callers; fixed by a new additive `reconcileSystemFragmentRows` in `teamWiring.ts` plus five tests in a
CI-wired gate. The reporting-recipe subtask (`3bd9b739`) has zero code and its card should not have
reached CODE REVIEWED. Verification: `tsc -p tsconfig.test.json --noEmit` clean, `npm run compile`
clean, `npm test` aggregate green, `test:contract:startup-orientation` 32/32,
`test:contract:standing-orders-definitions` 16/17 with the one failure reproduced at `a5f1832f^`.

## Deferred Findings

- CRITICAL — subtask `3bd9b739` ("A Coder Is Told How to Report Once…") is entirely unimplemented; see that plan file's own Deferred Findings for the four parts. `.switchboard/plans/a-coder-is-told-how-to-report-once-at-the-start-and-needs-it-hours-later.md:1`
- MAJOR — a family of CI-wired contract gates is red at `a5f1832f^` for reasons unrelated to this feature: `queue-pipeline`, `external-headed-team`, `team-release-control`, `team-scoped-routing`, `atomic-team-lifecycle`, `queue-stall-watch`, `queue-done-relay` and `standing-orders-fleet-root` all crash with `Cannot find module 'vscode'` because the 2026-09-04 storage overhaul pulled `RetentionService` → `ArchiveManager` into `LocalApiServer`'s import graph and those scripts do not preload `src/test/bootstrap/vscodeStub.js`. `package.json:1055`
- MAJOR — `test:contract:standing-orders-marker` carries three stale assertions and a crash left by the Go pty-host migration: the retired `sendPromptToPty` call marker, the retired `/api/pty/` request builders, a `.switchboard/plans/` vs `plans/intake/` drift between `kanban.html` and `teamWiring.ts`, and `__filename` undefined inside its own eval'd `requireFrom`. `src/test/standing-orders-marker-contract.test.js:685`
- MAJOR — `test:contract:seat-safeguards` has three pre-existing failures: `ACCURATE_CODING_DIRECTIVE` is now `buildAccuracyDirective()` rather than a template literal (two assertions), and the `ptyListTerminals`-count window bound (`const http = require`) sits ~21,000 lines past its start marker so the gate counts the whole file — 22 at `a5f1832f^`, 23 now. `src/test/seat-safeguards-fleet-prompt-path.test.js:511`
- MAJOR — `test:contract:prompt-payload-kind` fails its log-session-boundary parity assertion at `a5f1832f^` too: `onSessionBoundary` is not within 200 characters of `onTerminalContextCleared:` in `bootstrap.ts`. `src/test/prompt-payload-kind-contract.test.js:310`
