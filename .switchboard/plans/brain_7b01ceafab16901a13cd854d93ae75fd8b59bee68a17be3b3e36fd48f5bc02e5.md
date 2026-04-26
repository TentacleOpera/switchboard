# Implementation Plan - Restoring Home Screen Functionality

The goal is to restore the missing UI content on the home screen that was inadvertently removed during the Goals screen redesign. This includes reinstating the observation history and status modules that define the "Administrative Concierge" experience.

## User Review Required

> [!IMPORTANT]
> We are moving the "Recent Observations" and "Status Summary" modules back to the Home screen, as they were likely the content the user noticed was missing. We will also ensure these modules adapt to the current app mode (Discovery vs. Therapy).

## Proposed Changes

### [Home Screen Restoration]

#### [MODIFY] [index.html](file:///Users/patrickvuleta/Documents/GitHub/patrickwork/designs/index.html)
- **Restore `refreshHomeScreen`**: Create a dedicated function to handle dynamic content for the Home screen, separate from `refreshGoalsScreen`.
- **Reinstate Modules**: Add `home-status-summary` and `home-observations-container` divs to the `screen-home` HTML.
- **Update `switchScreen`**: Ensure `refreshHomeScreen()` is called when navigating to the home screen.
- **Header Refinement**: Adjust the padding and layout of the home header to ensure the mode switch and settings icon don't overlap on smaller viewports.

## Verification Plan

### Automated Tests
- No automated tests available.

### Manual Verification
1.  Open the prototype and verify the Home screen shows the "Recent Observations" and "Status Summary" sections.
2.  Switch between **Discovery** and **Therapy** modes and verify the Home screen content updates accordingly (e.g., Discovery shows waitlist/pipeline status).
3.  Navigate from Goals to Home and verify the content refreshes correctly.
4.  Check the header on a narrow viewport to ensure the mode switch and settings icon are properly spaced.
