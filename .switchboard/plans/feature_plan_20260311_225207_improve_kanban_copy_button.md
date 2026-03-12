# Context-Aware Cross-IDE Copy Prompts for Kanban Cards

## Goal
Improve the Kanban card copy buttons so that instead of just copying a raw markdown link to the plan, they copy tailored instruction prompts based on the card's current column (stage). Additionally, update the text on the button itself to clearly indicate what is being copied (e.g., "Copy execution prompt"). This enables a seamless cross-IDE copy-paste workflow (e.g., to Windsurf) with zero manual prompt typing required, while keeping the UI clear.

## User Review Required

> [!NOTE]
> This changes the clipboard output from a raw Markdown link (e.g., `[Plan](file://...)`) to a conversational prompt (e.g., `Please execute the following plan:\n\n[Plan](file://...)`) when copied from the Kanban board. 

> [!WARNING]
> If users rely on the Kanban copy button specifically to paste raw links into documentation, they will now have to delete the prompt text (except in the "CODE REVIEWED" column which stays a raw link). (Note: The "Copy" button in the standard Sidebar view will continue to output just the raw link, preserving that functionality).

## Complexity Audit

### Band A — Routine
- Extracting the `data-column` attribute from the DOM in `kanban.html`.
- Passing the `column` state through the IPC messaging layer (`kanban.html` -> `KanbanProvider` -> `extension`).
- Adding prompt string templates to `TaskViewerProvider.ts`.
- Updating the card generation logic in `kanban.html` to render contextual button labels.

### Band B — Complex / Risky
- None. This is a linear data-flow extension of an existing feature.

## Edge-Case Audit

- **Race Conditions:** None. The column state is read synchronously from the DOM at the exact moment of the click.
- **Security:** No new attack vectors. We are strictly appending string literals to the already-validated `file://` URI output. The existing `_isPathWithinRoot` validation is preserved untouched.
- **Side Effects:** The sidebar's independent "COPY" button must not be affected. We handle this by making the `column` argument optional; if absent, it gracefully falls back to the legacy raw-link output.

## Adversarial Synthesis

### Grumpy Critique
You're hijacking the user's clipboard with conversational slop! What if the user just wants the link? Now you're forcing them to backspace "Please review this..." every time they paste into Notion or Slack! Furthermore, parsing the DOM for `.closest('.kanban-column')` inside a button click is brittle. If someone restructures the HTML, the copy button breaks silently. And what about the UX?! Changing clipboard behavior without offering an opt-out toggle or explicit UI indication is terrible! Users who are used to the raw link are going to get annoyed when they paste into a PR or doc.

### Balanced Response
Grumpy is right that taking away the raw link is annoying for documentation purposes. However, the explicit user request is to optimize for *cross-IDE execution*. To mitigate the documentation issue, the standard Sidebar "COPY" button will remain a raw link generator. The Kanban board is specifically designed for agent state-routing, so making its copy button context-aware makes semantic sense. Regarding the DOM traversal, `.closest('.kanban-column')` is the standard, robust way to handle delegated/nested events in vanilla JS without tightly coupling state to the button dataset. To address the UX shock, we will explicitly change the label of the button itself (e.g., "Copy planning prompt") so users know exactly what they are getting before they click.

## Proposed Changes

> [!IMPORTANT]
> **MAXIMUM DETAIL REQUIRED:** Provide complete, fully functioning code blocks. Break down the logic step-by-step before showing the code.

### 1. Kanban Webview

#### [MODIFY] `src/webview/kanban.html`
- **Context:** The frontend needs to capture which column the card currently resides in when the "Copy" button is pressed, and the button's actual text label should reflect what it copies.
- **Logic:** 
  1. In the `createCardHtml` function (or wherever the card HTML is built), determine the appropriate button text based on the column name:
     - `CREATED`: "Copy planning prompt"
     - `PLAN REVIEWED`: "Copy execution prompt"
     - `CODED`: "Copy review prompt"
     - `CODE REVIEWED` (and any other): "Copy plan link"
  2. Update the event listener for `.card-btn.copy`. Traverse the DOM up from the clicked button to find the nearest `.kanban-column` container, read its `data-column` value, and append it to the `vscode.postMessage` payload.
- **Implementation:**
```javascript
    // Inside the HTML string generation for the card:
    let copyLabel = 'Copy plan link';
    if (colName === 'CREATED') copyLabel = 'Copy planning prompt';
    else if (colName === 'PLAN REVIEWED') copyLabel = 'Copy execution prompt';
    else if (colName === 'CODED') copyLabel = 'Copy review prompt';

    // ... replace the <button class="card-btn copy"...>Copy</button> with:
    `<button class="card-btn copy" data-session="${card.sessionId}">${copyLabel}</button>`

    // In the event listeners setup:
    document.querySelectorAll('.card-btn.copy').forEach(btn => {
        btn.addEventListener('click', (e) => {
            btn.disabled = true;
            const cardEl = e.target.closest('.kanban-card');
            const colEl = e.target.closest('.kanban-column');
            const column = colEl ? colEl.dataset.column : undefined;
            
            vscode.postMessage({ 
                type: 'copyPlanLink', 
                sessionId: btn.dataset.session,
                column: column 
            });
        });
    });
```

### 2. Kanban Backend Provider

#### [MODIFY] `src/services/KanbanProvider.ts`
- **Context:** The `KanbanProvider` receives the IPC message and forwards it to the main extension command registry. It needs to pass the new column argument along.
- **Logic:** Add `msg.column` to the `vscode.commands.executeCommand` arguments.
- **Implementation:**
```typescript
            case 'copyPlanLink':
                if (msg.sessionId) {
                    const success = await vscode.commands.executeCommand<boolean>('switchboard.copyPlanFromKanban', msg.sessionId, msg.column);
                    this._panel?.webview.postMessage({ type: 'copyPlanLinkResult', sessionId: msg.sessionId, success });
                }
                break;
```

### 3. Extension Command Registry

#### [MODIFY] `src/extension.ts`
- **Context:** The command bridging the Kanban board to the TaskViewerProvider must accept the new argument.
- **Logic:** Add an optional `column?: string` parameter to the callback and pass it down.
- **Implementation:**
```typescript
    const copyPlanFromKanbanDisposable = vscode.commands.registerCommand('switchboard.copyPlanFromKanban', async (sessionId: string, column?: string) => {
        return await taskViewerProvider.handleKanbanCopyPlan(sessionId, column);
    });
```

### 4. Task Viewer Provider (Core Logic)

#### [MODIFY] `src/services/TaskViewerProvider.ts`
- **Context:** This is where the clipboard text is actually generated and written to the OS.
- **Logic:** Update signatures to accept `column?: string`. If `column` is provided, wrap the markdown link in a predefined string template based on the column's semantic next step (e.g., `CREATED` -> requires Planner enhancement). If `column` is undefined or unrecognized, output just the markdown link.
- **Implementation:**
```typescript
    /** Called by the Kanban board to copy a plan link to clipboard. Returns true on success. */
    public async handleKanbanCopyPlan(sessionId: string, column?: string): Promise<boolean> {
        return await this._handleCopyPlanLink(sessionId, column);
    }

    private async _handleCopyPlanLink(sessionId: string, column?: string): Promise<boolean> {
        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (!workspaceFolders) return false;

        const workspaceRoot = workspaceFolders.uri.fsPath;
        const runSheetPath = path.join(workspaceRoot, '.switchboard', 'sessions', `${sessionId}.json`);

        try {
            const content = await fs.promises.readFile(runSheetPath, 'utf8');
            const sheet = JSON.parse(content);
            const topic = (sheet.topic || 'Plan').toString().trim() || 'Plan';

            let planPathAbsolute: string | undefined;
            if (typeof sheet.planFile === 'string' && sheet.planFile.trim()) {
                planPathAbsolute = path.resolve(workspaceRoot, sheet.planFile.trim());
            } else if (typeof sheet.brainSourcePath === 'string' && sheet.brainSourcePath.trim()) {
                planPathAbsolute = path.resolve(workspaceRoot, sheet.brainSourcePath.trim());
            }

            if (!planPathAbsolute) {
                throw new Error('No plan file path is available for this session.');
            }

            // F-06 SECURITY: Enforce workspace containment for plan paths
            if (!this._isPathWithinRoot(planPathAbsolute, workspaceRoot)) {
                throw new Error('Plan file path is outside the workspace boundary.');
            }

            const planUri = vscode.Uri.file(planPathAbsolute).toString();
            const markdownLink = `[${topic}](${planUri})`;

            let promptToCopy = markdownLink;

            if (column === 'CREATED') {
                promptToCopy = `Please review and enhance the following plan:\n\n${markdownLink}`;
            } else if (column === 'PLAN REVIEWED') {
                promptToCopy = `Please execute the following plan. Use the linked file as the single source of truth:\n\n${markdownLink}`;
            } else if (column === 'CODED') {
                promptToCopy = `The implementation for the following plan is complete. Please review the code against the plan requirements and identify any defects:\n\n${markdownLink}`;
            }

            await vscode.env.clipboard.writeText(promptToCopy);

            this._view?.webview.postMessage({ type: 'copyPlanLinkResult', success: true });
            return true;
        } catch (e: any) {
            const errorMessage = e?.message || String(e);
            this._view?.webview.postMessage({ type: 'copyPlanLinkResult', success: false, error: errorMessage });
            vscode.window.showErrorMessage(`Failed to copy plan link: ${errorMessage}`);
            return false;
        }
    }
```

## Verification Plan

### Manual Testing
1. Ensure you have active plans in the Kanban board.
2. Verify the card in the **CREATED** column has a button labeled "Copy planning prompt". Click it, paste into an empty text file and verify it includes "Please review and enhance the following plan".
3. Move a card to **PLAN REVIEWED**. Verify the button label changes to "Copy execution prompt". Click it and paste. Verify it includes "Please execute the following plan".
4. Move a card to **CODED**. Verify the button label changes to "Copy review prompt". Click it and paste. Verify it includes "The implementation for the following plan is complete. Please review the code...".
5. Move a card to **CODE REVIEWED**. Verify the button label changes to "Copy plan link". Click it and paste. Verify it outputs *only* the `[Plan Title](file://...)` markdown link without any conversational wrapper.
6. Open the standard Switchboard Sidebar (not the Kanban view). Select a plan from the dropdown and click the primary **COPY** button. Verify it outputs *only* the `[Plan Title](file://...)` markdown link without any conversational wrapper.
