# Improve Agents Tab UI

## Problem
1. The **Agents** tab of `kanban.html` can be confusing for new users because there are no descriptions explaining the purpose of each default agent role under its checkbox/command input row.
2. The "Add Custom Agent" inline form starts collapsed (hidden), which makes it look different from the user's expected visual design where it starts expanded so they immediately see the custom agent options.

## Goals
- Add a clear, concise description under each built-in agent checkbox to explain its role/purpose.
- Ensure the descriptions are styled beautifully to match the premium aesthetics of the app (small font size, indented, muted color).
- Make the "Add Custom Agent" form start expanded by default by removing the `hidden` class in the HTML.

## Files to Change
- `src/webview/kanban.html`

## Implementation Steps

### 1. CSS / Styles
Add a new class `.agent-description` in the `<style>` block of `src/webview/kanban.html` under the Agents tab custom list styles section:
```css
.agent-description {
  font-size: 10px;
  color: var(--text-secondary);
  margin-left: 22px;
  margin-bottom: 8px;
  opacity: 0.85;
  line-height: 1.3;
}
```

### 2. HTML Markup Updates for Built-In Agents
For each of the 13 built-in agent rows in `#agents-tab-content`, wrap them or add the description div directly underneath them. To make it compact, we will also override the `margin-bottom` on each agent's `.startup-row` to `2px` (from `6px` default) so it visualizes closer to its description.

The list of agents and their exact descriptions to add:
- **Planner**: `Writes detailed step-by-step implementation plans and creates work checklists.`
- **Lead Coder**: `Implements high-complexity files, complex refactors, and core architecture changes.`
- **Coder**: `Implements low-complexity boilerplate, routine functions, and minor enhancements.`
- **Reviewer**: `Evaluates completed implementations against plans, checking for regressions and scope creep.`
- **Acceptance Tester**: `Validates implemented changes against the Design Doc/PRD, applies fixes for requirement gaps, and logs verification results.`
- **Intern**: `Executes simple, repetitive code edits and heavily guided tasks at lowest cost.`
- **Analyst**: `Researches general-purpose technical queries and outlines plan dependencies.`
- **Ticket Updater**: `Synchronizes plan state and comments back to connected project management systems (e.g. ClickUp/Linear).`
- **Researcher**: `Conducts semantic code searches and web research to discover necessary implementation context.`
- **Research Planner**: `Scopes complex multi-part plans by gathering extensive context using deep research.`
- **Splitter**: `Segregates planned files into distinct routine and complex task batches.`
- **Context Gatherer**: `Aggregates codebase files, directory structure, and relevant symbols into the active prompt context.`
- **Jules**: `Offloads tasks to Google Jules cloud-coding service for quota-free background execution.`

### 3. Expand the Custom Agent Form by Default
In `src/webview/kanban.html` (around line ~2014):
- Remove the `hidden` class from the div `<div id="agents-tab-custom-agent-form" class="agents-tab-inline-form hidden">` so it becomes `<div id="agents-tab-custom-agent-form" class="agents-tab-inline-form">`.
- This ensures the form is fully visible upon first opening the Agents tab, showing fields for Agent Name, Startup Command, Prompt Instructions, and other toggle checkboxes, matching the expanded layout behavior.

## Verification
- Open/reload the Kanban board sidebar.
- Navigate to the **Agents** tab.
- Verify that under each built-in agent checkbox and text input field, a clean, styled description text is clearly visible.
- Verify that the "Add Custom Agent" form is expanded by default right below the built-in agents, with all form fields visible.
