# Reverse Kanban Card Sort Order

## Problem Statement

Kanban cards currently display in **ascending** order (oldest activity first). This puts stale cards at the top and recently active cards at the bottom — counterintuitive for daily workflow.

## Current Behavior

Cards sort with oldest `lastActivity` at the top:

```javascript
// kanban.html:1932, 1950
items.sort((a, b) => (a.lastActivity || '').localeCompare(b.lastActivity || ''));
```

## Proposed Changes

### 1. Reverse Sort Order

Flip the comparison to show newest cards first:

```javascript
// In kanban.html - both locations (CODED_AUTO collapse and regular columns)
items.sort((a, b) => (b.lastActivity || '').localeCompare(a.lastActivity || ''));
```

This affects:
- Line ~1932: `coderItems.sort()` for collapsed CODED_AUTO view
- Line ~1950: `items.sort()` for all column rendering

## Verification Plan

- [ ] Open kanban view with multiple plans of varying ages
- [ ] Confirm most recently active cards appear at top of each column
- [ ] Drag cards between columns and verify they maintain sort position
- [ ] Test with CODED columns both expanded and collapsed

## Open Questions

- Should this be a user preference toggle, or universal behavior?

## Complexity Audit
**Manual Complexity Override:** 3

### Complex / Risky
- None.
