# include optional challenge step in lead review coder prompt

## Notebook Plan

I want challenge behavior to be available as an **option** when sending work to lead coder, not forced into every single lead/coder prompt by default.

## Goal
- Add an explicit opt-in path to include a challenge step in the lead/coder implementation prompt.
- Keep the default lead/coder prompt unchanged (no automatic challenge step).

## Proposed Changes
1. Update prompt-building logic in `src/services/TaskViewerProvider.ts` so challenge instructions are injected only when an explicit flag is set.
2. Add a clear UI option in `src/webview/implementation.html` (and any related view) to choose:
   - Standard lead/coder prompt (default)
   - Lead/coder prompt with inline challenge step (opt-in)
3. Ensure existing dispatch paths keep current behavior unless the new option is selected.

## Verification Plan
1. Trigger standard lead/coder dispatch and verify payload has no inline challenge instructions.
2. Trigger the new "with challenge" option and verify payload includes the challenge step instructions.
3. Run both flows end-to-end and confirm they target the same plan file and complete successfully.

## Open Questions
- Naming preference for the UI action: `Lead Coder + Challenge` vs `Lead Coder (Challenge Enabled)`.
