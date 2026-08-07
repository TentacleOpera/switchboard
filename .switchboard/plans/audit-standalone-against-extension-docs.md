# Standalone Doc-Parity Audit — Harness, Claim Register and Evidence Rules

## Metadata

**Complexity:** 4
**Tags:** audit, standalone, parity, infrastructure
**Project:** Browser Switchboard

## Goal

Stand up everything the section audits need: an audited build of current `src`, a scratch workspace with representative state, and the claim register with its evidence rules. This subtask produces no verdicts — it produces the instrument the other seven subtasks record into, and the rules that make their verdicts trustworthy.

### Problem analysis and root cause

The `switchboard-site` docs document the **extension's** feature set — the full product. Every user-facing feature they describe is a feature the standalone (browser) host is expected to have. The audit checks each one against what standalone actually delivers; every mismatch is a standalone defect.

Standalone parity has been declared complete several times and has not been. The failures share one method error, and this subtask exists to make repeating it impossible.

**Why previous parity checks kept passing.** `bootstrap.ts`'s `default:` arm (`src/standalone/bootstrap.ts:1062-1087`) delegates every unmatched verb to `kanbanProvider.handleServiceVerb` → `_handleMessage` (`src/services/KanbanProvider.ts:7261-7291`). In standalone **every verb is therefore reachable and every DB write lands**. Checking "is the verb wired?" or "does the write persist?" returns green for features that are entirely dead in the browser, because the failure is in the read-back path: `KanbanProvider.postMessage` has no sink there (neither `_broadcaster` nor `_panel` is set — `KanbanProvider.ts:2105-2120`), and both standalone state builders fabricate the board payload from hardcoded literals (`bootstrap.ts:341-346`, `:370-375`).

Code reading has also produced wrong results on this codebase repeatedly, including three incorrect hand-written greps during the session that produced this plan. Reading a code path is the weakest admissible evidence and is never sufficient on its own for a user-facing feature.

### Scope decision: the stale standalone doc contributes no requirements

`getting-started/headless-switchboard.md` was written when standalone was substantially less capable and describes limits that no longer hold — it claims standalone columns "reflect *your configured* set" (contradicted by `bootstrap.ts:341`) and scopes the remaining gap to "Automation and the Orchestrator," which is not accurate. It must not be cited to justify, excuse, or close any gap. It is an **output** of the audit, rewritten in the closeout subtask. No section audit may source a requirement from it.

## User Review Required

None.

## Complexity Audit

### Routine
- Creating the register file and its column schema.
- Provisioning a scratch workspace.

### Complex / Risky
- **Auditing a stale build.** The standalone host serves the packaged build, not the repo's `src/`. Auditing without first building and installing from current `src` measures whatever was last packaged. The register header must record the commit SHA and build artefact, or every downstream verdict is unattributable.
- **Representative workspace state.** A scratch workspace with an empty board cannot exercise most claims. It must carry: several plans across multiple columns, at least one feature with subtasks, a custom column, a hidden role, a configured project, a worktree, and integration keys present. A thin workspace silently converts real gaps into untestable rows.
- **Two browser hosts.** `npx switchboard` (standalone process) and "Open in Browser" (a second client of the running editor's server) have genuinely different capabilities — notably secret entry. The register must record which host each verdict was observed in, and both must be provisioned.
- **Capability gating.** PTY terminals are fail-closed on the optional `node-pty` module. "Absent because node-pty did not load" is a different finding from "never ported." The harness must run on a host where the capability is present, or every terminal claim is `GATED` and the audit learns nothing.

## Edge-Case & Dependency Audit

**Race Conditions** — none.

**Security** — the scratch workspace holds real integration credentials. Record key *presence* only; never paste values into the register.

**Side Effects**
- The section audits drive a live host and will create, move and complete plans. The workspace provisioned here must be a scratch workspace, never one with work in progress. This is the single most destructive aspect of the audit and it is this subtask's responsibility to prevent it.

**Dependencies & Conflicts**
- Findings will overlap the **Standalone Push-Path Parity** feature. The register schema includes a linked-plan column so overlaps are cross-referenced rather than re-planned.

## Dependencies

- None (hard). Sequencing: most efficient after the Standalone Push-Path Parity feature lands, so the section audits do not spend their budget re-finding that class one page at a time.

## Implementation

### 1. Build and provision

- Build and install from current `src`. Record the commit SHA and build artefact.
- Provision a **scratch** workspace with the representative state listed above.
- Launch both hosts: `npx switchboard`, and a running extension with "Switchboard: Open in Browser".
- Confirm the PTY layer loaded, so terminal claims are testable rather than `GATED`.

### 2. Create the register

**File:** `.switchboard/audits/standalone-extension-parity.md` (new)

Header records: commit SHA, build artefact, audit date, workspace state summary, and both host URLs.

One row per claim:

`ID | Section | File:line | Feature/claim | Host observed | Verdict | Evidence class | Note / linked plan`

Verdicts: `LIVE`, `GAP`, `PARTIAL`, `GATED` (capability-dependent), `N/A` (not a testable feature claim).

### 3. Write the evidence rules into the register header

Verbatim, so every section subtask is bound by them:

- **A — Runtime observed** in a running browser host. **Required** for any `LIVE` verdict on a user-facing feature.
- **B — Passing contract test** naming the behaviour.
- **C — Code path traced end-to-end** including the push path and the UI render. Never sufficient alone for a user-facing feature.
- **Not evidence:** verb reachability, a `{success:true}` response, a landed DB write, or the presence of a handler. All four are structurally false-green in standalone. Any verdict resting on them is invalid and must be re-done.
- Every file audited records a **line-coverage figure**; under 100% means the file is not finished.
- No requirement may be sourced from `getting-started/headless-switchboard.md`.

## Proposed Changes

### `.switchboard/audits/standalone-extension-parity.md` (new)
- **Context:** The shared instrument for all seven section subtasks.
- **Logic:** Header with build attribution and evidence rules; row schema for claims.
- **Edge Cases:** Build attribution missing → downstream verdicts unattributable.

## Verification Plan

1. The register exists with the row schema and the full evidence-rules block in its header.
2. The header names a commit SHA and build artefact, and that build is from current `src`.
3. Both hosts are reachable and their URLs recorded.
4. The PTY layer is confirmed loaded.
5. The scratch workspace demonstrably contains each item of representative state — check each off explicitly.
6. Confirm the workspace is scratch, not live work.

## Recommendation

Complexity 4 → **Send to Coder.** Mechanically simple, but it sets the conditions every other subtask depends on; a stale build or a thin workspace invalidates the whole feature.
