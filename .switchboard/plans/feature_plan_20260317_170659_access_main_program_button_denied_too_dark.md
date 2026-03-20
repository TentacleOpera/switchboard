# Access main program button denied too dark

## Goal
The red 'DENIED' state triggered by the looping 'access main program' button in the sidebar is now too muted. it used to be a bright red, now i can barely read the text and it is not bright enough for DENIED.

## Source Analysis
- `src/webview/implementation.html:1323-1325`
  - The idle `Access main program` button is currently rendered as a normal neutral `secondary-btn` with no special red styling.
- `src/webview/implementation.html:1737-1763`
  - Clicking the button triggers the easter-egg denial flow:
    - text changes to `DENIED`,
    - `disabled = true`,
    - inline `background`, `color`, and `boxShadow` are set to the red denied state,
    - after 1 second the inline styles are cleared and the label rotates.
- `src/webview/implementation.html:737-764`
  - The shared `.secondary-btn:disabled` rule sets:
    - `opacity: 0.3`,
    - disabled foreground color,
    - neutral border styling.
  - That means the same click that sets the button red also immediately applies the global disabled visual dimming.
- `src/webview/implementation.html:798-800`
  - The existing red accent token for error-style secondary buttons still exists and is not itself the issue.
- **Clarification:** the likely regression is not that the red token changed globally; it is that the temporary `DENIED` state is being visually washed out by the shared disabled-button styling.

## Dependencies / Cross-Plan Conflict Scan
- `feature_plan_20260313_085532_make_access_main_program_button_consistent_styling.md`
  - Direct overlap. That earlier plan intentionally changed the button’s **idle** state from persistent red to neutral grey.
  - This fix must preserve that idle-state decision and only restore brightness for the temporary `DENIED` animation/state.
- `feature_plan_20260316_065159_add_main_controls_strip_at_top_of_kanban_board.md`
  - Shared sidebar/webview control styling surface.
  - This plan should avoid changing broad button styling patterns beyond the easter-egg denied state.
- `feature_plan_20260316_065436_change_kanban_headers.md` and `feature_plan_20260316_091239_change_kanban_header.md`
  - Shared visual polish area, but unrelated in scope.
  - No direct conflict expected unless this plan were to start changing general palette or typography rules, which it should not.

## Proposed Changes

### Band A — Routine / Low Complexity
1. Isolate the `DENIED` visual state from generic disabled dimming
   - **File:** `src/webview/implementation.html`
   - **Relevant areas:** button CSS near `737-764`, easter-egg handler near `1737-1763`
   - Keep the button temporarily non-interactive during the denial animation, but prevent the shared `.secondary-btn:disabled` styling from muting the red denied appearance.
   - **Clarification:** the correct fix is scoped to this button/state, not a blanket increase to disabled-button brightness across the sidebar.
2. Preserve the neutral idle styling introduced by the earlier button-styling plan
   - The button should remain standard grey before click and after the denied animation resets.
   - Only the transient `DENIED` state should regain the bright, readable red treatment the user expects.
3. Use the existing red accent system rather than inventing a new palette
   - Reuse the current red tokens already present in `implementation.html` (`--accent-red`, existing glow/error styling patterns).
   - Avoid introducing a new product-level theme or a new semantic state beyond the existing denied animation.
4. Keep the label rotation and one-second denied loop behavior unchanged
   - The text cycling (`Access main program`, `Access main security`, `Access main program grid`) and the deny timing already exist.
   - This fix should target readability/contrast only, not alter the easter-egg behavior.
5. Add a focused regression check for the denied-state styling path
   - Add a small source-level regression test asserting that the denied state is explicitly styled in a way that is not overridden by the generic disabled appearance.
   - Prefer the repo’s existing simple HTML/source-inspection regression style over introducing browser automation for this visual tweak.

### Band B — Complex / Risky
- None.

## Verification Plan
1. Open the sidebar and confirm the idle `Access main program` button still appears as the neutral grey secondary button.
2. Click the button and verify the temporary `DENIED` state is bright, readable red with strong enough contrast to be unmistakable.
3. During the `DENIED` window, confirm the button is still effectively non-interactive (the user cannot spam-trigger it).
4. After the one-second reset, confirm:
   - the button returns to the neutral idle style,
   - the label rotates as before,
   - no stray red styling remains.
5. Confirm other disabled `.secondary-btn` controls in the same webview remain unchanged.
6. Run targeted validation:
   - `npm run compile`
   - `npm run compile-tests`
   - the new focused regression test for the denied-state styling path.

## Open Questions
- None.

## Complexity Audit

### Band A — Routine
- Scope the fix to the easter-egg button’s temporary `DENIED` state.
- Preserve the neutral idle styling while restoring readable bright red during denial.
- Add focused regression coverage so generic disabled styling does not mute this state again.

### Band B — Complex / Risky
- None.
