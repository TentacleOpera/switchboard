# Cleanup: Remove Central Setup Panel Header

## Goal
Remove the decorative "Central Setup Panel" header from the setup view as it serves no functional purpose.

## Metadata
**Tags:** frontend, ui, bugfix
**Complexity:** 1

## User Review Required
> No manual steps required. This is a cosmetic cleanup with no behavior change.
>
> **Recommendation:** Send to Coder

## Background
The setup view (`setup.html`) has a decorative header at the top with the title "Central Setup Panel" and a subtitle explaining the panel's purpose. This header is purely informational and provides no functional value. Removing it will clean up the UI and reduce visual clutter.

## Complexity Audit

### Routine
- Delete the `.setup-header` wrapper and its two text nodes from `src/webview/setup.html`.
- Delete the obsolete CSS rules for `.setup-header`, `.setup-title`, and `.setup-subtitle` from `src/webview/setup.html`.
- Confirm no JavaScript references those classes or relies on the removed markup.
- Verify the remaining `.setup-shell` / `.startup-section` layout still opens correctly at the top of the panel.

### Complex / Risky
- None.

## Edge-Case & Dependency Audit
- **Race Conditions:** None. This is a static HTML/CSS cleanup with no async state or IPC behavior.
- **Security:** None. No new data flow, commands, or permissions are introduced.
- **Side Effects:** The setup panel will reclaim a small amount of vertical space once the header is removed. If the visual spacing looks odd, any follow-up adjustment must stay within `src/webview/setup.html` and remain limited to existing layout spacing rules.
- **Dependencies & Conflicts:**
  - Potential same-file merge hotspot with `Move Configuration Components to Central Setup Panel` (`sess_1775836086369`, Reviewed) because it rewrites `src/webview/setup.html` end-to-end. If that plan lands separately, keep this cleanup applied to the migrated file rather than reintroducing the header.
  - Potential same-file merge hotspot with `Add Git Ignore Strategy UI to Setup Menu` (`sess_1775819673136`, Reviewed) because it also edits `src/webview/setup.html` in the SETUP area.
  - Potential same-file merge hotspot with `Fix: Team Lead Should Not Be Active by Default and Should Be Moved to Dedicated Accordion` (`sess_1775874881556`, Planned) because it also touches `src/webview/setup.html` and may shift nearby accordion structure.
  - No functional dependency on other active plans was found; this change is isolated to one view file.

## Root Cause Analysis

### Affected Element
**File:** `src/webview/setup.html`

**HTML (lines 395-398):**
```html
<div class="setup-header">
    <div class="setup-title">Central Setup Panel</div>
    <div class="setup-subtitle">Configuration-heavy controls live here so the sidebar can stay focused on live operations.</div>
</div>
```

**CSS (lines 66-70):**
```css
.setup-header {
    border: 1px solid var(--border-color);
    background: var(--panel-bg);
    padding: 14px 16px;
}
```

**CSS for title/subtitle (lines 72-84):**
```css
.setup-title {
    font-family: var(--font-mono);
    font-size: 12px;
    letter-spacing: 2px;
    color: var(--accent-green);
    text-transform: uppercase;
    margin-bottom: 6px;
}

.setup-subtitle {
    color: var(--text-secondary);
    line-height: 1.5;
}
```

### Why It Can Be Removed
- The header is purely decorative with no interactive elements
- The purpose of the panel is self-evident from the accordion section labels (Setup, Custom Agents, Default Prompt Overrides, Database Operations)
- Removing it will reduce vertical space and visual noise
- No JavaScript references these elements
- No backend functionality depends on this header

## Grumpy Critique
> Oh, splendid — a decorative header pretending to be architecture. The good news is the fix is tiny. The bad news is the draft still tries to act like a UI redesign by dangling an "optional" padding tweak, which is how harmless cleanup turns into accidental churn.
>
> Also, do not be lazy about same-file overlap. `setup.html` is already a merge magnet, and this header lives in the exact neighborhood other plans keep rewriting. If you patch the wrong copy or let a later merge resurrect the header, you will have accomplished the software equivalent of sweeping dust under the rug and then announcing the room is clean.

## Balanced Synthesis
The correct scope is narrow: remove only the obsolete header markup and its now-unused CSS, then verify the panel still renders cleanly. No JS, backend, or data changes are required. The only meaningful risk is concurrent edits to `src/webview/setup.html`, so the implementation should stay surgical and avoid any unnecessary spacing refactor.

## Proposed Changes

### Step 1: Remove HTML Header
**File:** `src/webview/setup.html`
**Lines:** 395-398
**Action:** Delete the entire `.setup-header` div

**Before:**
```html
<div class="setup-shell">
    <div class="setup-header">
        <div class="setup-title">Central Setup Panel</div>
        <div class="setup-subtitle">Configuration-heavy controls live here so the sidebar can stay focused on live operations.</div>
    </div>

    <div class="startup-section">
```

**After:**
```html
<div class="setup-shell">
    <div class="startup-section">
```

### Step 2: Remove CSS for Header
**File:** `src/webview/setup.html`
**Lines:** 66-84
**Action:** Delete the CSS rules for `.setup-header`, `.setup-title`, and `.setup-subtitle`

**Remove:**
```css
.setup-header {
    border: 1px solid var(--border-color);
    background: var(--panel-bg);
    padding: 14px 16px;
}

.setup-title {
    font-family: var(--font-mono);
    font-size: 12px;
    letter-spacing: 2px;
    color: var(--accent-green);
    text-transform: uppercase;
    margin-bottom: 6px;
}

.setup-subtitle {
    color: var(--text-secondary);
    line-height: 1.5;
}
```

### Step 3: Container Spacing Check (Clarification)
Do not add any new spacing rules as part of the primary change. After removing the header, do a quick visual check of the top of the panel; only if the spacing looks awkward should the existing `.setup-shell` spacing in `src/webview/setup.html` be adjusted, and only with the smallest possible edit.

**Current `.setup-shell` (lines 58-64):**
```css
.setup-shell {
    max-width: 980px;
    margin: 0 auto;
    display: flex;
    flex-direction: column;
    gap: 12px;
}
```

**Preferred default:** keep the current container spacing unless a visual check proves the removal created a noticeable gap issue. If a follow-up adjustment is necessary, make it only in `src/webview/setup.html` and only on `.setup-shell`.

## Verification Plan
1. Open the setup panel
2. Verify the "Central Setup Panel" header is no longer visible
3. Verify all accordion sections (Setup, Custom Agents, Default Prompt Overrides, Database Operations) are still visible and functional
4. Verify the layout looks balanced without the header
5. Test all buttons and controls in the setup panel to ensure functionality is unaffected

## Impact Assessment
- **No functional impact** - header is purely decorative
- **Reduced vertical space** - users will see more content without scrolling
- **Cleaner UI** - less visual clutter
- **No breaking changes** - no JavaScript or backend dependencies

## Related Files
- `src/webview/setup.html` - Only file affected

## Agent Recommendation
Send to Coder

## Reviewer Execution Update

### Stage 1 (Grumpy Principal Engineer)
> **NIT** The cleanup itself is correct, but it arrives with no dedicated regression harness. Static UI deletions have a nasty habit of being "cleaned up" right back in during nearby same-file merges, and `setup.html` is already a demolition derby. If someone resurrects `.setup-header` in a later migration, nothing automated will howl.

### Stage 2 (Balanced)
Keep the implementation as-is. No CRITICAL or MAJOR defect was found, and no production code fix was warranted. For this pass, the relevant evidence is that the header classes are gone from `src/webview/setup.html`, the setup surface still satisfies the existing setup-panel migration regression, and the repo compile still succeeds.

### Fixed Items
- No reviewer-applied production code fixes were needed.

### Files Changed
- Observed implementation file: `src/webview/setup.html`
- Reviewer update: `.switchboard/plans/remove_central_setup_panel_header.md`

### Validation Results
- `rg "setup-header|setup-title|setup-subtitle" src/webview/setup.html` → no matches
- `node src/test/setup-panel-migration.test.js` → passed
- `npm run compile` → passed
- `npx tsc --noEmit` → pre-existing TS2835 at `src/services/KanbanProvider.ts:2197` for `await import('./ArchiveManager')`

### Remaining Risks
- `src/webview/setup.html` remains a same-file merge hotspot with other setup-panel plans.
- There is still no header-specific regression test; the current confidence comes from source invariant checks plus broader setup-panel coverage.
