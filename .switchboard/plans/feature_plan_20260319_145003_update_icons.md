# Update icons

## Goal
in the kanban board, replace the following icons.

Import plan from notebook: C:\Users\patvu\Documents\GitHub\switchboard\icons\25-101-150 Sci-Fi Flat icons-121.png

generate context map: C:\Users\patvu\Documents\GitHub\switchboard\icons\25-1-100 Sci-Fi Flat icons-42.png

## Proposed Changes
- Map `{{ICON_IMPORT_CLIPBOARD}}` placeholder to `25-101-150 Sci-Fi Flat icons-121.png` in `KanbanProvider.ts` icon injection
- Map `{{ICON_ANALYST_MAP}}` placeholder to `25-1-100 Sci-Fi Flat icons-42.png` in `KanbanProvider.ts` icon injection
- Use placeholders in `kanban.html` for the "Import plan from clipboard" button and "Generate context map" button

## Verification Plan
- Confirm both icon files exist in `icons/` directory
- Confirm `KanbanProvider.ts:1451-1452` maps placeholders to correct icon filenames
- Confirm `kanban.html:724-725` declares the placeholder constants
- Confirm `kanban.html:848,866` renders icons in the correct buttons

## Open Questions
- None remaining — implementation is complete.

## Complexity Audit

### Band A (Routine)
- Two icon file references in `KanbanProvider.ts`
- Two placeholder constants in `kanban.html`
- Two `<img>` tags in `kanban.html`

### Band B (Complex/Risky)
- None

**Classification:** Low complexity (Band A only)

---

## Reviewer Pass — 2026-03-19

### Stage 1: Grumpy Principal Engineer (Adversarial)

| # | Severity | Finding |
|---|----------|---------|
| 1 | MAJOR | Plan body was incomplete — Proposed Changes, Verification Plan, and Open Questions all said "TODO". The actual implementation was already done in code but the plan was never backfilled. Fixed in this review pass. |
| 2 | NIT | Icon filenames follow a non-descriptive naming convention (`25-101-150 Sci-Fi Flat icons-121.png`). Not actionable — these are third-party asset names. |

**No CRITICAL findings. One MAJOR (documentation gap, now fixed).**

### Stage 2: Balanced Synthesis

- **Keep**: All icon mappings are correct and functional.
- **Fix now**: Backfill plan documentation (done in this review pass).
- **Defer**: Nothing.

### Files Changed (Implementation)
- `src/services/KanbanProvider.ts` (lines 1451-1452): Icon placeholder → file mappings for `{{ICON_ANALYST_MAP}}` and `{{ICON_IMPORT_CLIPBOARD}}`
- `src/webview/kanban.html` (lines 724-725): Placeholder constant declarations
- `src/webview/kanban.html` (lines 848, 866): Icon rendering in button elements
- `icons/25-101-150 Sci-Fi Flat icons-121.png`: Import clipboard icon (exists)
- `icons/25-1-100 Sci-Fi Flat icons-42.png`: Analyst map icon (exists)

### Validation Results
- **Icon files exist**: ✅ Both files confirmed in `icons/` directory
- **TypeScript compilation**: ✅ Clean (`npx tsc --noEmit` exit 0)
- **Code review**: ✅ All icon mappings correctly wired

### Remaining Risks
- None. Static asset references with no runtime logic.
