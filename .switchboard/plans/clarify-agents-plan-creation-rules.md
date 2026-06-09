# Clarify AGENTS.md Plan Creation Rules for Antigravity Session Mirroring

## Goal

Add a "Step 0" pre-check to the AGENTS.md plan-creation algorithm so that agents running inside an Antigravity sandbox session write plans only to the brain's `implementation_plan.md`, preventing duplicate entries caused by the Switchboard extension's automatic brain-to-mirror watcher.

## Metadata

- **Tags:** documentation, workflow
- **Complexity:** 2

## User Review Required

None.

## Complexity Audit

### Routine
- Single-file documentation change (AGENTS.md lines 37-53)
- Inserting a new step into an existing numbered algorithm
- No code changes, no runtime impact

### Complex / Risky
- None

## Edge-Case & Dependency Audit

### Race Conditions
- None — this is a documentation-only change with no runtime code.

### Security
- The rule references `~/.gemini/antigravity/brain/` (tilde notation), matching the codebase convention at `TaskViewerProvider.ts:1053-1054`. No absolute user-specific paths are embedded.

### Side Effects
- Agents that previously wrote plans to both `implementation_plan.md` and `.switchboard/plans/` will now write only to `implementation_plan.md`. The brain watcher (`_setupBrainWatcher`, `TaskViewerProvider.ts:8723`) handles mirroring automatically.

### Dependencies & Conflicts
- The brain watcher must be active for the mirror to occur. If the Switchboard extension is not running, plans written to the brain directory will not appear in the Switchboard UI until the extension starts and performs a rescan. This is existing behavior and not introduced by this change.
- The `antigravity-brain-detection.md` plan established multi-path probing (`~/.gemini/antigravity/brain/` and `~/.gemini/antigravity-cli/brain/`). This change uses the primary path `~/.gemini/antigravity/brain/` which is what `_getAntigravityRoot()` returns. The fallback path is a separate concern handled by the extension's runtime detection, not by agent documentation.

## Dependencies

- None

## Adversarial Synthesis

Key risks: (1) Agents may ignore the new Step 0 if they cache or skip AGENTS.md; (2) the brain watcher could be inactive, leaving plans invisible in the Switchboard UI until a rescan. Mitigations: Step 0 is placed as the very first step in the MANDATORY algorithm, making it impossible to miss if the agent reads the section; brain-watcher inactivity is an existing limitation, not a regression.

## Open Questions

None.

## Proposed Changes

---

### [MODIFY] AGENTS.md (lines 37-53)

**Context:** The `Workspace Detection for Plan Creation` section (lines 37-53) defines a 4-step algorithm for determining where to write plan files. It currently has no awareness of the Antigravity brain environment, causing agents in sandbox sessions to write plans to both `implementation_plan.md` (in the brain directory) and `.switchboard/plans/`, which produces duplicate entries because the brain watcher automatically mirrors the former into the latter.

**Logic:** Insert a new "Step 0" before the existing Step 1. This step checks whether the agent is operating inside an Antigravity brain session by probing for the brain directory. If present, the agent must write the plan only to the `implementation_plan.md` file inside the active conversation subdirectory and must not manually write a copy to `.switchboard/plans/`.

**Implementation:**

```diff
 ### 📂 Workspace Detection for Plan Creation
 
 **MANDATORY**: Before writing any plan file, you MUST verify where to write it using this algorithm:
 
+**Step 0 — Check for Antigravity Brain Environment**
+If the directory `~/.gemini/antigravity/brain/` exists on the filesystem, you are likely running inside an Antigravity sandbox session. In this case, you MUST write the implementation plan *only* to the `implementation_plan.md` file inside the active conversation subdirectory under that brain folder (the subdirectory you are currently operating within). Do NOT manually write a second copy of the plan to `.switchboard/plans/` — the Switchboard extension's brain watcher will automatically mirror the brain file into the plans directory for you. Proceed no further through this algorithm.
+
 **Step 1 — Discover the Switchboard workspace**
 Check each open workspace root for the existence of `.switchboard/plans/`. Not every repo in a multi-root setup has this — only Switchboard-managed workspaces do. Run: `ls {workspaceRoot}/.switchboard/plans/` for each root.
```

**Edge Cases:**
- If the brain directory exists but the agent is *not* operating within a conversation subdirectory (e.g., the agent was invoked outside the sandbox), Step 0's "likely running inside an Antigravity sandbox session" language is a heuristic. The agent should still write to the brain's `implementation_plan.md` only if it can identify its active conversation subdirectory; otherwise, fall through to Steps 1-4.
- If the Switchboard extension is not running, the brain watcher will not mirror the file. The plan will appear in the UI on the next extension startup / rescan. This is existing behavior.

---

## Verification Plan

### Automated Tests
* (SKIP: Automated tests are skipped per session instructions.)

### Manual Verification
1. Inspect the modified `AGENTS.md` file to ensure the new `Step 0` exception is clear, correctly formatted, and uses portable `~/.gemini/antigravity/brain/` path notation (not a user-specific absolute path).
2. Confirm that the new step is positioned before Step 1 and instructs the agent to stop ("Proceed no further") after writing to the brain directory.
3. Verify that subsequent agent instances read the updated rule and correctly write only to `implementation_plan.md` when the brain folder is present, producing no duplicate entries in `.switchboard/plans/`.

## Recommendation

**Send to Intern** — Complexity 2: single-file documentation change with no code impact.

---

## Review Pass (2026-06-01)

### Stage 1: Grumpy Principal Engineer Findings

| # | Finding | Severity | Description |
|---|---------|----------|-------------|
| 1 | Step 0 only probes `~/.gemini/antigravity/brain/`, missing `~/.gemini/antigravity-cli/brain/` | **MAJOR** | `LocalFolderService._ANTIGRAVITY_BRAIN_PATHS` lists `antigravity-cli/brain` as the FIRST probe target. The `antigravity-brain-detection.md` plan notes "the actual path on this system is `~/.gemini/antigravity-cli/brain/`". Agents in `antigravity-cli` sandboxes would miss Step 0 and fall through to Steps 1-4, writing to `.switchboard/plans/` instead of the brain's `implementation_plan.md`. The plan's rationale that "the fallback path is a separate concern handled by the extension's runtime detection" conflates extension read-time discovery with agent write-time decision. |
| 2 | Stale line references in plan | NIT | Plan references `TaskViewerProvider.ts:1053-1054` for `_getAntigravityRoot()` (actually line 1055) and `TaskViewerProvider.ts:8723` for `_setupBrainWatcher` (actually line 8838). |
| 3 | Duplicate protocol boundary markers in AGENTS.md | NIT | Lines 1-2 both had `<!-- switchboard:agents-protocol:start -->` and lines 57-58 both had `<!-- switchboard:agents-protocol:end -->`. Pre-existing, but causes extension's `indexOf`-based block extraction to include the duplicate start marker, triggering perpetual "content differs" updates and leaving a dangling end marker. |

### Stage 2: Balanced Synthesis

| # | Finding | Verdict | Rationale |
|---|---------|---------|-----------|
| 1 | Missing `antigravity-cli/brain` path | **Fix Now** | Real gap for agents in `antigravity-cli` sandboxes. Small targeted fix. |
| 2 | Stale line references | **Fix Now (trivial)** | Correcting while updating plan file anyway. |
| 3 | Duplicate protocol markers | **Fix Now (trivial)** | One-line deletion each; prevents extension block management issues. |

### Fixes Applied

1. **AGENTS.md line 41-42**: Expanded Step 0 path check from `~/.gemini/antigravity/brain/` alone to `~/.gemini/antigravity/brain/` or `~/.gemini/antigravity-cli/brain/`. Updated "under that brain folder" to "under whichever brain folder is present" for disambiguation.
2. **AGENTS.md line 1**: Removed duplicate `<!-- switchboard:agents-protocol:start -->` marker.
3. **AGENTS.md line 57 (now 56)**: Removed duplicate `<!-- switchboard:agents-protocol:end -->` marker.

### Files Changed

- `AGENTS.md` — Step 0 expanded to probe both brain paths; duplicate protocol markers removed.

### Validation Results

- Step 0 clarity and formatting: **PASS** — Both paths use portable tilde notation; "whichever brain folder is present" disambiguates.
- Step 0 positioned before Step 1 with "Proceed no further": **PASS** — Lines 40-42, before Step 1 at line 43.
- No duplicate entries instruction: **PASS** — "Do NOT manually write a second copy" and "Proceed no further" both present.
- Protocol markers: **PASS** — Exactly 1 start marker (line 1) and 1 end marker (line 56). Extension `indexOf` extraction will work correctly.
- Path consistency with codebase: **PASS** — Both `~/.gemini/antigravity/brain/` (matches `_getAntigravityRoot()` + `/brain/`) and `~/.gemini/antigravity-cli/brain/` (matches `LocalFolderService._ANTIGRAVITY_BRAIN_PATHS[0]`).

### Remaining Risks

- If both brain directories exist simultaneously, Step 0 says "whichever brain folder is present" but does not specify a tiebreaker. In practice, the agent knows its active conversation subdirectory and can determine which brain folder contains it. If neither contains the active subdirectory, the agent should fall through to Steps 1-4 (per the existing edge case in the plan).
- The brain watcher (`_setupBrainWatcher`) only watches `~/.gemini/antigravity/` (via `_getAntigravityRoot()`). Plans written to `~/.gemini/antigravity-cli/brain/` will NOT be mirrored by the brain watcher. This is an existing limitation of the extension, not introduced by this documentation change. The `antigravity-cli` path is probed by `LocalFolderService` for artifact discovery, but the watcher and mirroring pipeline only cover the primary path.
