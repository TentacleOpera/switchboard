# Expose `.switchboard/epics/` in Managed Gitignore Rules

## Goal

Add `!.switchboard/epics/` as an exception to Switchboard's managed gitignore block so that epic files are committed to the repository. Without this, remote coding sessions (Claude Code on the web, Jules, etc.) cannot see the epics folder — it's created at runtime but falls under the blanket `.switchboard/*` exclusion with no carve-out.

**Root cause:** When epics were added, the `TARGETED_RULES` array in `WorkspaceExcludeService.ts` was not updated to mirror the treatment of `plans/`. Any user who runs setup (or whose gitignore is managed by Switchboard) has the folder silently excluded.

## Metadata

**Complexity:** 2
**Tags:** backend, infrastructure, devops, reliability

## Proposed Changes

### [MODIFY] `src/services/WorkspaceExcludeService.ts` — Add epics exception

In `TARGETED_RULES` (lines 9–28), add `!.switchboard/epics/` immediately after `!.switchboard/plans/`:

```typescript
// BEFORE:
'!.switchboard/reviews/',
'!.switchboard/plans/',
'!.switchboard/sessions/',

// AFTER:
'!.switchboard/reviews/',
'!.switchboard/plans/',
'!.switchboard/epics/',
'!.switchboard/sessions/',
```

### [MODIFY] `src/test/git-ignore-custom-default-regression.test.js` — Update snapshot

The regression test validates the exact content of `TARGETED_RULES`. It will fail without a matching update. Add `!.switchboard/epics/` in the same position to the expected rules array.

Locate the assertion that checks for `!.switchboard/plans/` and insert the epics line directly after it.

### [CHECK] `src/webview/setup.html` — Warning text

The setup tab contains a warning (around line 632–634) that references `plans/` specifically. Review whether this text should be updated to also mention `epics/` for clarity. This is documentation-only; not a functional change.

## Migration Consideration

This is an **additive change** to the managed block. Existing users who already have a managed block in their `.gitignore` will get the new line added on the next time `WorkspaceExcludeService.apply()` runs (extension activation or settings change). The epics folder, if it exists, will immediately become tracked — which is the desired outcome.

Users on the `custom` or `none` strategy are unaffected (they manage their own rules).

## Verification Plan

1. Run the existing gitignore regression test: `node src/test/git-ignore-custom-default-regression.test.js` — must pass.
2. In a test workspace, create an epic via the kanban UI and confirm `git status` shows `.switchboard/epics/*.md` as untracked (i.e., no longer ignored).
3. Run Switchboard setup → confirm the managed block in `.gitignore` includes `!.switchboard/epics/`.

## Success Criteria

1. `TARGETED_RULES` contains `!.switchboard/epics/` in the correct position.
2. Regression test passes.
3. A freshly created epic file appears in `git status` as an untracked file (not silently ignored).
