# The Test Gates Tell the Truth

**Complexity:** 6

## Goal

Make CI mean something. Three control-plane tests are dark - invoked by nothing, and failing on a shared harness seam because the database no longer auto-creates a file that does not exist - so wire them into the package scripts and the CI workflow and fix the seam. Then sweep the source-regex suites and convert assertions that pin implementation spelling into assertions that pin behaviour, so a rename stops producing a red gate while a real behaviour change stays green.

## How the Subtasks Achieve This

- **Three dark control-plane tests fail on a database that no longer auto-creates** — fixes the shared harness seam and wires all three test files into the package scripts and the CI workflow, so they run at all.
- **Source-regex test assertions must pin behaviour, not spelling** — sweeps the CI-wired source-regex suites and converts assertions that pin implementation spelling into assertions that pin behaviour.

<!-- BEGIN SUBTASKS (auto-generated, do not edit) -->
## Subtasks
- [ ] [Source-Regex Test Assertions Must Pin Behaviour, Not Spelling](../plans/test-assertions-pin-behaviour-not-spelling.md) — **CREATED**
- [ ] [Three dark control-plane tests fail on a database that no longer auto-creates — fix the harness seam and wire them into CI](../plans/dark-control-plane-tests-fail-on-a-db-that-no-longer-auto-creates.md) — **CREATED**
<!-- END SUBTASKS -->
## Dependencies & sequencing

Wire the dark tests in first. The sweep should run against a suite where everything actually executes, or it will spend effort converting assertions that nothing invokes.

