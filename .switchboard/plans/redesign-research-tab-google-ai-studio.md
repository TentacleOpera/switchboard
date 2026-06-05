# Redesign Research Tab to Support AI Studio Flow

## Goal
The goal is to streamline the Research tab in `planning.html` to support a clean 3-step workflow optimized for Google AI Studio with search grounding. 
Currently, the Research tab is designed for an in-IDE agent to perform the research directly in a terminal. However, the desired flow is to use the in-IDE agent only to *draft* a high-quality prompt, which the user then runs in Google AI Studio (with search grounding enabled) and imports back.

**Core Problem:** The current Research tab mixes two distinct workflows (direct agent research vs. external AI Studio research) into a single unfocused UI. The complexity radio buttons, import toggle, and "HOW TO RUN RESEARCH" collapsible create cognitive overhead. The import function always writes to the first configured folder with no user choice, and the analyst dispatch path bypasses the prompt builder entirely, sending raw text that doesn't leverage the `draft_research_prompt` skill.

**Root Cause:** The Research tab was originally built for the `researcher` role (deep research via agent terminal). The AI Studio flow was bolted on as "Option A" in a collapsible section. The analyst dispatch (`handleSendToAnalystFromPlanningPanel`) sends a raw prompt string without going through `buildKanbanBatchPrompt`, so it can't reference skills or produce structured dispatch prompts.

This updated design addresses user feedback by:
1. Generating the analyst prompt via the existing prompt builder function (`buildKanbanBatchPrompt`) with a new `instruction` mode.
2. Creating a general-use skill (`draft_research_prompt`) that instructs the analyst agent to print the drafted prompt to stdout and write it to `research_prompt_draft.md` in its current working directory (safe for multi-repo sandboxes).
3. Allowing the user to select the destination folder for their imported research document from their configured local docs directories in the webview.

## Metadata
**Complexity:** 6
**Tags:** frontend, backend, ui, ux, feature, api, docs

## User Review Required

> [!IMPORTANT]
> The prompt builder function will generate a dedicated drafting request for the analyst. The analyst agent will output the drafted prompt directly to the terminal stdout and to `research_prompt_draft.md` in its current directory. You can copy it directly from the terminal or the generated file.

> [!WARNING]
> We will update `AGENTS.md` to register the new `draft_research_prompt` skill. Because `AGENTS.md` is a system protocol file, we require explicit permission before updating it.

## Complexity Audit

### Routine
- Replace `#research-content` HTML with 3-step layout (pure markup swap)
- Update `generateResearchPrompt()` to read from `<select id="research-depth">` instead of radio buttons
- Wire "COPY PROMPT TEMPLATE" button to existing `generateResearchPrompt()` function
- Wire "DRAFT WITH ANALYST AGENT" button to post topic/context/depth to extension
- Populate destination folder dropdown from `state.localFolderPaths` on `localFoldersListed` message
- Update import button handler to read selected folder and pass in `importResearchDoc` postMessage
- Update button label reset logic for new button IDs
- Register `draft_research_prompt` skill in AGENTS.md Available Skills table

### Complex / Risky
- Add `draft-research-prompt` instruction handling to `buildKanbanBatchPrompt` analyst role branch — must produce a well-structured dispatch prompt that references the skill and passes topic/context/depth parameters
- Add new `draftResearchPrompt` message handler in PlanningPanelProvider.ts that calls `buildKanbanBatchPrompt` and dispatches to analyst terminal (current `sendToAnalyst` handler sends raw prompt, bypassing the builder)
- Add `targetFolder` parameter to `writeContentToDocsDir` / `_writeDocToDocsDir` with validation against `localFolderService.getFolderPaths()` to prevent arbitrary file writes

## Edge-Case & Dependency Audit

**Race Conditions:**
- `_writeDocToDocsDir` uses a `_writeQueue` serialized per workspace root. Two rapid imports targeting different folders could queue, but this is safe — the queue ensures sequential writes. No change needed.

**Security:**
- The `targetFolder` parameter from the webview must be validated against `localFolderService.getFolderPaths()` before writing. Without validation, a crafted webview message could write to arbitrary paths. The handler must reject any `folderPath` not in the configured set.

**Side Effects:**
- Replacing the complexity radio buttons with a `<select>` dropdown changes the DOM structure. Any code that queries `input[name="complexity"]` (currently `generateResearchPrompt()` at line 2568) must be updated simultaneously.
- The import toggle (`#import-toggle`) is being removed. The `generateResearchPrompt()` function currently reads this toggle (line 2569). The function must be updated to remove the import-toggle logic.
- Removing the "HOW TO RUN RESEARCH" collapsible and "IMPORT OPTIONS" card simplifies the UI but removes the NotebookLM instructions. Clarification: The NotebookLM flow remains accessible via the NOTEBOOKLM INTEGRATION tab — it is not removed from the product, only from the Research tab.

**Dependencies & Conflicts:**
- The `handleSendToAnalystFromPlanningPanel` method (TaskViewerProvider.ts, line 6237) currently accepts only a `prompt: string`. The new `draftResearchPrompt` handler needs to call `buildKanbanBatchPrompt` and then dispatch the resulting prompt. This can reuse the existing `_dispatchExecuteMessage` pipeline but requires a new entry point.
- The `sendToAnalyst` message type (PlanningPanelProvider.ts, line 1323) passes `msg.prompt`. The new `draftResearchPrompt` message type will pass `msg.topic`, `msg.context`, `msg.depth` instead — a different contract. Keep both message types to preserve backward compatibility.

## Dependencies
None

## Adversarial Synthesis
Key risks: (1) `buildKanbanBatchPrompt` analyst change is dead code without a new dispatch handler that actually calls it — the current `sendToAnalyst` path sends raw text; (2) replacing radio buttons with `<select>` breaks `generateResearchPrompt()` if not updated in lockstep; (3) adding `targetFolder` without validation against configured paths creates an arbitrary-write security gap. Mitigations: add a dedicated `draftResearchPrompt` message handler that calls the prompt builder before dispatching; update `generateResearchPrompt()` to read from the new `<select>` element; validate `targetFolder` against `localFolderService.getFolderPaths()` before any file write.

## Proposed Changes

### Skills & Prompts

#### [NEW] [.agent/skills/draft_research_prompt.md](file:///Users/patrickvuleta/Documents/GitHub/switchboard/.agent/skills/draft_research_prompt.md)
- Define a new general-use skill that instructs an agent how to draft a prompt for Google AI Studio with search grounding based on a topic, context, and depth.
- Instruct the agent to print the final prompt directly to standard output and save it to `research_prompt_draft.md` in its current working directory.
- **Skill content skeleton:**
  ```markdown
  ---
  name: Draft Research Prompt
  description: Draft a high-quality research prompt for Google AI Studio with search grounding.
  ---
  
  # Draft Research Prompt Skill
  
  You are drafting a research prompt for Google AI Studio with search grounding enabled.
  
  ## Parameters
  - **Topic**: The central research question or topic (provided by the caller)
  - **Context**: Additional context, domain, or specifics (provided by the caller, may be empty)
  - **Depth**: Research depth — one of: quick, standard, deep, academic
  
  ## Instructions
  1. Based on the Topic, Context, and Depth, craft a comprehensive research prompt optimized for Google AI Studio with search grounding.
  2. The prompt should follow this structure:
     - ROLE: Research analyst with source credibility standards
     - CONTEXT: The provided context and domain
     - CENTRAL QUESTION: The provided topic
     - SUB-QUESTIONS: 4-6 targeted sub-questions covering core framing, best practices, trade-offs, state of the art, and domain-specific concerns
     - SOURCE GUIDANCE: Prefer official docs, standards bodies, peer-reviewed sources; distrust marketing; date-check sources
     - SCOPE: Focused on the central question with clearly-labelled benchmarks for related domains
     - OUTPUT: Structured format with executive summary, tiered findings, trade-off evaluation, glossary, and source list
     - DEPTH: The provided depth level with source count target
  3. After drafting, print the complete prompt to stdout.
  4. Save the prompt to `research_prompt_draft.md` in your current working directory.
  5. Do NOT perform the research yourself — you are only drafting the prompt for the user to run externally.
  ```

#### [MODIFY] [agentPromptBuilder.ts](file:///Users/patrickvuleta/Documents/GitHub/switchboard/src/services/agentPromptBuilder.ts)
- **Lines 744-766** (the `role === 'analyst'` branch): Add handling for `options.instruction === 'draft-research-prompt'`.
- When `instruction === 'draft-research-prompt'`:
  - Build a dedicated dispatch prompt that references the `draft_research_prompt` skill.
  - Include the topic, context, and depth as parameters in the prompt.
  - Instruct the analyst to invoke `skill: "draft_research_prompt"` with the provided parameters.
  - Example prompt structure:
    ```
    Read .agent/skills/draft_research_prompt.md and follow it step-by-step.
    
    PARAMETERS:
    - Topic: [topic from options]
    - Context: [context from options]
    - Depth: [depth from options]
    ```
- Add new optional fields to `PromptBuilderOptions` interface (lines 75-140):
  - `researchTopic?: string` — the research topic for draft-research-prompt mode
  - `researchContext?: string` — the research context for draft-research-prompt mode
  - (Note: `researchDepth` already exists at line 107)

#### [MODIFY] [AGENTS.md](file:///Users/patrickvuleta/Documents/GitHub/switchboard/AGENTS.md)
- Register the new `draft_research_prompt` skill in the "Available Skills" table.
- Add row: `| draft_research_prompt | User asks to "draft a research prompt", "create AI Studio prompt", or needs a research prompt for external AI tools |`

---

### Webview Interface

#### [MODIFY] [planning.html](file:///Users/patrickvuleta/Documents/GitHub/switchboard/src/webview/planning.html)
- **Lines 2185-2294** (the `#research-content` div): Replace all contents with a clean, 3-step layout:
  - **Step 1: Draft Research Prompt** card:
    - Topic textarea (`id="research-prompt-input"` — preserve existing ID for `generateResearchPrompt()` compatibility)
    - Context textarea (`id="research-context-input"` — preserve existing ID)
    - Depth select dropdown (`id="research-depth"` — NEW, replaces radio buttons; options: quick, standard, deep, academic)
    - Action buttons: "COPY PROMPT TEMPLATE" (`id="btn-copy-research-prompt"` — reuse existing ID) and "DRAFT WITH ANALYST AGENT" (`id="btn-draft-with-analyst"` — NEW)
  - **Step 2: Run Research in Google AI Studio** card:
    - Numbered instructions: paste the prompt, toggle search grounding, run
    - Link to open AI Studio (reuse existing `id="btn-open-ai-studio"` span)
    - Note about free tier and search grounding limits
  - **Step 3: Import Research Document** card:
    - Document title input (`id="research-doc-title"` — preserve existing ID)
    - Destination folder dropdown select (`id="research-destination-folder"` — NEW)
    - "IMPORT FROM CLIPBOARD" button (`id="btn-import-research-doc-clipboard"` — reuse existing ID)
    - Status message element (`id="research-import-status"` — preserve existing ID)
- **Remove** the following elements that are no longer needed:
  - Complexity radio buttons (`.radio-group` with `input[name="complexity"]`)
  - Import toggle (`#import-toggle` and its container)
  - "HOW TO RUN RESEARCH" collapsible (`<details>` section)
  - "IMPORT OPTIONS" card
  - Old "IMPORT RESEARCH DOC" card (replaced by Step 3)
  - "SEND ANALYST REQUEST" button (`id="btn-send-to-analyst"` — replaced by "DRAFT WITH ANALYST AGENT")

#### [MODIFY] [planning.js](file:///Users/patrickvuleta/Documents/GitHub/switchboard/src/webview/planning.js)
- **Lines 2567-2626** (`generateResearchPrompt` function): Update to read depth from `<select id="research-depth">` instead of `input[name="complexity"]:checked`. Remove the `importToggle` / `importEnabled` logic (lines 2569, 2574) since the import toggle is removed.
- **Lines 234-248** (send to analyst button handler): Replace with "DRAFT WITH ANALYST AGENT" handler that posts a new message type:
  ```javascript
  vscode.postMessage({
      type: 'draftResearchPrompt',
      topic: document.getElementById('research-prompt-input').value.trim(),
      context: document.getElementById('research-context-input').value.trim(),
      depth: document.getElementById('research-depth').value
  });
  ```
- **Lines 2212-2216** (`localFoldersListed` handler): Add population of the destination folder dropdown:
  ```javascript
  const folderSelect = document.getElementById('research-destination-folder');
  if (folderSelect) {
      folderSelect.innerHTML = '';
      (msg.paths || []).forEach(p => {
          const opt = document.createElement('option');
          opt.value = p;
          opt.textContent = p.split('/').pop() || p;
          folderSelect.appendChild(opt);
      });
  }
  ```
- **Lines 173-208** (import button handlers): Update `handleResearchImportClick` to read the selected destination folder and pass it in the `importResearchDoc` postMessage:
  ```javascript
  const folderSelect = document.getElementById('research-destination-folder');
  const folderPath = folderSelect ? folderSelect.value : undefined;
  vscode.postMessage({
      type: 'importResearchDoc',
      docTitle: docTitle || undefined,
      folderPath: folderPath || undefined
  });
  ```
- Update button label reset logic for the new "DRAFT WITH ANALYST AGENT" button ID (`btn-draft-with-analyst`).

---

### VS Code Extension Services

#### [MODIFY] [PlanningPanelProvider.ts](file:///Users/patrickvuleta/Documents/GitHub/switchboard/src/services/PlanningPanelProvider.ts)
- **After line 1351** (the `sendToAnalyst` case): Add a new message handler case for `draftResearchPrompt`:
  ```typescript
  case 'draftResearchPrompt': {
      const { topic, context, depth } = msg;
      if (!topic) {
          this._panel?.webview.postMessage({
              type: 'draftResearchPromptResult',
              success: false,
              error: 'No topic provided'
          });
          break;
      }
      try {
          // Build the analyst prompt via the prompt builder
          const { buildKanbanBatchPrompt } = require('./agentPromptBuilder');
          const analystPrompt = buildKanbanBatchPrompt('analyst', [], {
              instruction: 'draft-research-prompt',
              researchTopic: topic,
              researchContext: context || '',
              researchDepth: depth || 'standard',
              switchboardSafeguardsEnabled: false
          });
          const result = await vscode.commands.executeCommand<{ success: boolean; error?: string }>(
              'switchboard.sendToAnalystFromPlanningPanel',
              analystPrompt
          );
          this._panel?.webview.postMessage({
              type: 'draftResearchPromptResult',
              success: result?.success ?? false,
              error: result?.error
          });
      } catch (err) {
          this._panel?.webview.postMessage({
              type: 'draftResearchPromptResult',
              success: false,
              error: String(err)
          });
      }
      break;
  }
  ```
  Note: `plans` is an empty array since this is a single-purpose dispatch, not a batch. The prompt builder's `draft-research-prompt` instruction branch will produce a standalone prompt that doesn't require plan files.

- **Line 1174** (`importResearchDoc` case): Update to accept `msg.folderPath`:
  ```typescript
  case 'importResearchDoc': {
      await this._handleImportResearchDoc(workspaceRoot, msg.docTitle, msg.folderPath);
      break;
  }
  ```

- **Lines 2915-2994** (`_handleImportResearchDoc` method): Update signature to accept optional `folderPath`:
  ```typescript
  private async _handleImportResearchDoc(workspaceRoot: string, docTitle?: string, folderPath?: string): Promise<void> {
  ```
  Pass `folderPath` to `writeContentToDocsDir`:
  ```typescript
  const writeResult = await this._plannerPromptWriter.writeContentToDocsDir(
      workspaceRoot,
      content,
      finalDocTitle,
      'research-clipboard',
      { skipDesignDocLink: true, targetFolder: folderPath }
  );
  ```

#### [MODIFY] [PlannerPromptWriter.ts](file:///Users/patrickvuleta/Documents/GitHub/switchboard/src/services/PlannerPromptWriter.ts)
- **Lines 53-58** (`_writeDocToDocsDir` method signature): Add `targetFolder` to options:
  ```typescript
  options: { skipDesignDocLink?: boolean; pageOrder?: number; parentDocName?: string; targetFolder?: string } = {}
  ```
- **Lines 60-65** (docsDir resolution): When `options.targetFolder` is provided, validate and use it:
  ```typescript
  const localFolderService = this._options.getLocalFolderService(workspaceRoot);
  const folderPaths = localFolderService.getFolderPaths();
  if (folderPaths.length === 0) {
      throw new Error("No local docs folder configured. Add a folder in the LOCAL DOCS tab before importing.");
  }
  // Validate targetFolder against configured paths
  let docsDir: string;
  if (options.targetFolder) {
      if (!folderPaths.includes(options.targetFolder)) {
          throw new Error(`Target folder "${options.targetFolder}" is not a configured local docs folder.`);
      }
      docsDir = options.targetFolder;
  } else {
      docsDir = folderPaths[0];
  }
  ```
- **Lines 145-151** (`writeContentToDocsDir` method signature): Add `targetFolder` to options type:
  ```typescript
  options: { skipDesignDocLink?: boolean; pageOrder?: number; parentDocName?: string; targetFolder?: string } = {}
  ```
  Pass `targetFolder` through to `_writeDocToDocsDir` (already done via options spread at line 163).

## Verification Plan

### Automated Tests
- SKIP COMPILATION: The project is assumed to be in a pre-compiled state for this session.
- SKIP TESTS: The test suite will be run separately by the user.

### Manual Verification
1. Open the Switchboard panel and switch to the **RESEARCH** tab.
2. Verify that the new 3-step layout is present, clean, and visually aligned.
3. Enter a topic and context, select a depth from the dropdown, and click **COPY PROMPT TEMPLATE** — verify it copies a structured research prompt to clipboard.
4. Click **DRAFT WITH ANALYST AGENT** — verify it dispatches a prompt to the Analyst terminal that references the `draft_research_prompt` skill.
5. Verify the analyst agent outputs the drafted prompt to stdout and creates `research_prompt_draft.md`.
6. Check the folder destination dropdown in Step 3 is populated with configured local docs folders.
7. Copy research output from AI Studio, select a target folder from the dropdown, and click **IMPORT FROM CLIPBOARD** — verify the file is created in the selected folder.
8. Test import without selecting a folder — verify it defaults to the first configured folder (backward compatible).
9. Test import with an invalid `folderPath` (e.g., send a crafted message) — verify the write is rejected with an error.

**Recommendation:** Send to Coder (Complexity 6 — multi-file changes with moderate logic and one security-sensitive validation)
