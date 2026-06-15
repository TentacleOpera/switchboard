# Constitution and Tuning Webview

## Goal

Create a new dedicated webview (tuning.html) with two tabs to support project constitution management and plan-based tuning workflows:
- **Constitution tab**: Surface and edit project constitution.md files with an interview-based builder skill
- **Tuning tab**: Provide agent prompts for reviewing completed plans and extracting adversarial insights

## Metadata

**Complexity:** 6

**Tags:** ui, feature, docs

## Current State

Switchboard has several webviews:
- planning.html (Local/Online/Kanban/Tickets tabs)
- implementation.html (prompts configuration)
- setup.html (initial setup and control plane configuration)

The planning.html Local tab serves as the reference pattern for file discovery:
- Tree pane on the left showing files by workspace
- Preview pane on the right showing markdown content
- File selection and navigation
- Workspace filtering for multi-workspace setups

The implementation.html webview provides the pattern for webview registration in extension.ts.

## Problem Analysis

Switchboard lacks first-class support for project constitutions - project-specific invariants that should be automatically surfaced during planning. Additionally, the adversarial review workflow generates valuable insights about recurring issues, but there's no mechanism to extract and apply these insights to improve project governance documents.

The proposed solution addresses both gaps by:
1. Creating a dedicated webview for constitution management and tuning
2. Providing a tuning workflow that leverages existing review data to improve governance

## Implementation Plan

### Phase 1: Create tuning.html Webview

#### 1.1 Create tuning.html File

**File**: `src/webview/tuning.html` (new file)

**Structure**:
- Follow existing webview pattern (CSP headers, font loading, CSS variables)
- Two-tab layout: Constitution and Tuning
- Controls strip with tab buttons
- Content areas for each tab (hidden/shown via `.active` class)
- Tree pane and preview pane for Constitution tab
- Prompt cards area for Tuning tab

**CSS**:
- Reuse existing CSS from planning.html (tree pane, preview pane, controls strip)
- Add tab-specific styling if needed
- Follow existing dark theme and accent color patterns

#### 1.2 Register tuning.html Webview

**File**: `src/extension.ts`

**Changes**:
- Add webview registration for tuning.html similar to other webviews
- Add command to open tuning webview (e.g., `switchboard.openTuning`)
- Add webview provider class or integrate with existing provider pattern
- Register message handlers for tuning-specific operations

**Reference**: Follow pattern used for implementation.html registration

### Phase 2: Constitution Tab

#### 2.1 Constitution Tab UI

**File**: `src/webview/tuning.html`

**Changes**:
- Add "Constitution" tab button in controls strip
- Add `#constitution-content` div with flex layout
- Add tree pane `#tree-pane-constitution` and preview pane `#preview-pane-constitution`
- Add "Build Constitution" button in constitution tab controls
- Follow existing tab activation pattern (`.active` class toggle)

#### 2.2 Constitution File Discovery

**File**: `src/webview/tuning.html` (JavaScript section)

**Changes**:
- Add `loadConstitutionFiles()` function that:
  - Scans workspace roots and control plane for `CONSTITUTION.md` files
  - For multi-workspace setups, groups files by workspace
  - Builds tree structure matching Local tab pattern
  - Populates `#tree-pane-constitution`

**Detection logic**:
- Check workspace root for `CONSTITUTION.md`
- If control plane is enabled, check control plane root for `CONSTITUTION.md`
- One constitution per workspace maximum (no creation if exists)

#### 2.3 Constitution Preview

**File**: `src/webview/tuning.html` (JavaScript section)

**Changes**:
- Add `previewConstitutionFile(absolutePath)` function
- On file selection in tree pane:
  - Read file content via VSCode message passing
  - Render markdown in `#preview-pane-constitution`
  - Update active doc banner with constitution name

#### 2.4 Constitution Builder Skill

**File**: `.agent/skills/constitution_builder.md` (new skill)

**Content**:
- Skill that interviews the user to build or improve a constitution
- Questions should cover:
  - Project domain and constraints
  - Coding standards and patterns
  - Architecture invariants
  - Security requirements
  - Performance requirements
  - Testing requirements
- Generates markdown constitution file
- Handles both new creation and improvement of existing constitutions

**File**: `src/webview/tuning.html` (JavaScript section)

**Changes**:
- On "Build Constitution" button click:
  - Send message to extension to invoke `constitution_builder` skill
  - Pass current constitution content (if exists) as context
  - Display skill output in preview pane or modal

#### 2.5 Constitution Editing

**File**: `src/webview/tuning.html` (JavaScript section)

**Changes**:
- Enable markdown editing in preview pane (reuse existing edit infrastructure)
- Add "Save" button to persist changes
- On save, write file via VSCode message passing

### Phase 3: Tuning Tab

#### 3.1 Tuning Tab UI

**File**: `src/webview/tuning.html`

**Changes**:
- Add "Tuning" tab button in controls strip
- Add `#tuning-content` div with flex layout (hidden by default)
- Follow existing tab activation pattern (`.active` class toggle)

#### 3.2 Tuning Prompts UI

**File**: `src/webview/tuning.html`

**Changes**:
- In `#tuning-content`, add prompt cards:
  - "Review Done Plans" - Analyze all plans in Done column
  - "Review Recent Plans" - Analyze plans from last N days
  - "Extract Adversarial Patterns" - Focus on Grumpy critique sections
- Each card has:
  - Description
  - "Start Conversation" button
  - Optional parameters (date range, plan count)

#### 3.3 Tuning Skill

**File**: `.agent/skills/tuning.md` (new skill)

**Content**:
- Skill that reviews completed plans and extracts insights
- Capabilities:
  - Read plans from `.switchboard/plans/`
  - Filter by status (Done) or date range
  - Extract adversarial review notes (Grumpy sections)
  - Identify recurring patterns
  - Generate recommendations for AGENTS.md or CONSTITUTION.md
- Output format:
  - Summary of findings
  - Specific recommendations with plan references
  - Proposed edits (diff-style or direct suggestions)

#### 3.4 Tuning Conversation Integration

**File**: `src/webview/tuning.html` (JavaScript section)

**Changes**:
- On "Start Conversation" click:
  - Send message to extension with selected tuning prompt
  - Extension invokes `tuning` skill with appropriate parameters
  - Skill output displayed in preview pane or initiates chat session
- For now, keep it simple - skill output in preview pane

### Phase 4: Constitution Prompt Injection

#### 4.1 Add Constitution to Planner Prompts

**File**: `src/services/agentPromptBuilder.ts`

**Changes**:
- Add `constitutionContent` to `PromptBuilderOptions` interface
- Add `constitutionLink` to `PromptBuilderOptions` interface
- In `buildKanbanBatchPrompt()`, for planner role:
  - If `constitutionContent` is provided, inject it similar to design docs:
    ```typescript
    const constitutionContent = options?.constitutionContent?.trim();
    if (constitutionContent) {
        plannerPrompt += `\n\nPROJECT CONSTITUTION:\nThe following is the project's constitution - inviolate rules and invariants that must be followed:\n\n${constitutionContent}`;
    }
    ```
  - If `constitutionLink` is provided (no pre-fetched content), inject link:
    ```typescript
    const constitutionLink = options?.constitutionLink?.trim();
    if (constitutionLink) {
        plannerPrompt += `\n\nPROJECT CONSTITUTION:\nThe following document contains the project's inviolate rules and invariants. Read it before planning:\n${constitutionLink}`;
    }
    ```

#### 4.2 Constitution Content Fetching

**File**: `src/extension.ts` or appropriate service

**Changes**:
- Add function to read constitution.md from workspace or control plane
- Call this function when dispatching planner prompts
- Pass content to `buildKanbanBatchPrompt()` via `constitutionContent` option

### Phase 5: Extension Integration

#### 5.1 Message Handlers

**File**: `src/extension.ts`

**Changes**:
- Add message handler for constitution file operations:
  - `loadConstitutionFiles` - returns list of constitution files by workspace
  - `readConstitutionFile` - returns file content
  - `saveConstitutionFile` - writes file content
- Add message handler for tuning operations:
  - `invokeTuningSkill` - invokes tuning skill with parameters
  - `invokeConstitutionBuilder` - invokes constitution builder skill

#### 5.2 Command Registration

**File**: `package.json`

**Changes**:
- Add command `switchboard.openTuning` to open tuning webview
- Add command to command palette if desired

## Edge Cases

1. **No constitution exists**: Constitution tab shows empty state with "Build Constitution" button
2. **Multiple workspaces**: Tree pane groups constitutions by workspace, similar to Local tab
3. **Control plane vs workspace**: Constitution in control plane takes precedence if both exist
4. **Constitution builder on existing file**: Skill should read existing content and suggest improvements
5. **Tuning with no Done plans**: Tuning skill should handle empty result set gracefully
6. **Constitution content too large**: Consider truncation or link-only mode for very large constitutions

## Dependencies

- Existing planning.html tab infrastructure
- Existing markdown preview/rendering
- Existing skill invocation pattern
- Existing workspace detection logic

## Testing Checklist

- [ ] tuning.html webview opens correctly via command
- [ ] Constitution tab appears in controls strip
- [ ] Tuning tab appears in controls strip
- [ ] Constitution files are discovered correctly in single-workspace setup
- [ ] Constitution files are discovered correctly in multi-workspace setup
- [ ] Constitution preview renders markdown correctly
- [ ] Constitution can be edited and saved
- [ ] Constitution builder skill can be invoked
- [ ] Constitution builder generates valid markdown
- [ ] Tuning prompts are displayed correctly
- [ ] Tuning skill can be invoked
- [ ] Tuning skill reads plans from correct location
- [ ] Constitution content is injected into planner prompts
- [ ] Constitution link is injected into planner prompts (when content not pre-fetched)

## Remaining Risks

1. **Constitution location ambiguity**: If both workspace and control plane have constitutions, need clear precedence rules
2. **Tuning skill complexity**: Extracting meaningful patterns from adversarial reviews may require iterative refinement
3. **Prompt token budget**: Constitution content adds to prompt size; may need truncation for large constitutions
4. **Constitution builder interview quality**: The skill needs good question design to extract useful invariants
