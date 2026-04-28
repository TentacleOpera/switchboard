# Improve ClickUp Status Label Design

## Goal
Redesign the ClickUp task card status labels in the sidebar to look less like buttons and more like distinct, color-coded status indicators.

## Current State
- Location: `/Users/patrickvuleta/Documents/GitHub/switchboard/src/webview/implementation.html`
- Current CSS class: `.project-card-status` (lines 532-540)
- Current color mapping: `getStatusColor()` function (lines 4108-4117)
- Status labels appear as gray boxes that look clickable, with limited color differentiation

## Issues
1. **Button-like appearance**: padding, border-radius, and bold styling make labels look interactive
2. **Limited color palette**: only 5 hardcoded status colors (To Do, In Progress, Review, Done, Closed)
3. **Poor contrast**: some colors may not meet accessibility standards
4. **No status grouping**: visual hierarchy doesn't communicate status categories (open/in-progress/closed)

## Implementation Plan

### Phase 1: Redesign CSS Styling
**File**: `src/webview/implementation.html`

Use **minimal badges** design with left border accent:

Modify `.project-card-status` class:
```css
.project-card-status {
    font-size: 10px;
    font-weight: 500;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    padding: 0 4px;
    border-left: 2px solid;
    white-space: nowrap;
    flex-shrink: 0;
}
```

**Key changes from current:**
- Remove background-color fill
- Add left border with dynamic color via `border-left-color` style attribute
- Lighter font weight (600 → 500)
- Add text-transform uppercase and letter-spacing for readability
- No border-radius (flat/minimal look)

**HTML change required** (line ~3989):
```html
<span class="project-card-status" style="border-left-color: ${statusColor};">${escapeHtml(task.status)}</span>
```
Replace `background-color: ${statusColor}` with `border-left-color: ${statusColor}`

### Phase 2: Expand Color Mapping
**File**: `src/webview/implementation.html`

Extend `getStatusColor()` to support more ClickUp statuses:

| Status | Color | Category |
|--------|-------|----------|
| To Do / Backlog / Open | `#8e8e93` | Open |
| In Progress / Active | `#ff9f0a` | In Progress |
| Review / In Review | `#bf5af2` | In Progress |
| Blocked / On Hold | `#ff375f` | Blocked |
| Done / Complete | `#30d158` | Closed |
| Closed / Cancelled | `#8e8e93` | Closed |
| Custom statuses | mapped dynamically | Varies |

Consider using ClickUp's native status colors if available in the API response.

### Phase 3: Status Category Visual Grouping
Add CSS classes for status categories:
- `.status-open` - gray/neutral tones
- `.status-progress` - warm tones (yellow, orange, purple)
- `.status-blocked` - red tones
- `.status-closed` - green tones

Apply category class dynamically based on status name matching.

## Files to Modify
1. `src/webview/implementation.html` - CSS and getStatusColor() function

## Verification Steps
1. Open ClickUp sidebar with tasks in various statuses
2. Verify status labels no longer look like buttons
3. Verify distinct colors for different status categories
4. Check contrast meets WCAG 4.5:1 for text
5. Verify custom ClickUp statuses have fallback color

## Estimation
Complexity: 3/10 (CSS and minor JS changes only)
Estimated time: 30-45 minutes
