# Fix NotebookLM Tab Text in planning.html

## Problem
The NotebookLM tab in `planning.html` has incorrect text:
1. Heading reads "NOTEBOOKLM AIRLOCK" - should be "NOTEBOOKLM INTEGRATION"
2. Intro text says "The Airlock" - should be "NotebookLM integration"

## Solution
Update text in `/Users/patrickvuleta/Documents/GitHub/switchboard/src/webview/planning.html`:

### Line 1220
**Before:**
```html
<div class="planning-card-header">NOTEBOOKLM AIRLOCK</div>
```

**After:**
```html
<div class="planning-card-header">NOTEBOOKLM INTEGRATION</div>
```

### Line 1221
**Before:**
```html
<div class="planning-card-description">The Airlock allows you to upload all your code into NotebookLM to access unlimited Gemini quota for planning features and diagnosing bugs.</div>
```

**After:**
```html
<div class="planning-card-description">NotebookLM integration allows you to upload all your code into NotebookLM to access unlimited Gemini quota for planning features and diagnosing bugs.</div>
```

### Line 1233 (consistency)
**Before:**
```html
<div class="planning-card-description">Create new Notebook and upload all files in the airlock folder as sources.</div>
```

**After:**
```html
<div class="planning-card-description">Create new Notebook and upload all files in the integration folder as sources.</div>
```

## Files Changed
- `src/webview/planning.html`

## Verification
Open the planning panel and verify the NotebookLM tab displays the corrected text.
