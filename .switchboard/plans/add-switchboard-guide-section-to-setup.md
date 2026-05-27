# Add Switchboard Guide Section to Setup Tab

## Overview
Add a "Switchboard guide" section to the top of the Setup tab in setup.html with a "Copy tutorial prompt" button that copies a setup guidance prompt to the clipboard. The prompt should reference the extension setup information in the project README.

## Requirements

### UI Changes
1. Add a new section at the top of the Setup tab content (before the existing "INIT PLUGIN" button)
2. Section should include:
   - Section label: "Switchboard guide"
   - Explanatory note: "Copy this prompt to ask an agent for guidance on Switchboard setup options"
   - "Copy tutorial prompt" button

### Button Behavior
- Button should use the same styling as the "plugin tutorial" button in implementation.html (action-btn class)
- On click, copy a prompt to clipboard that references the extension setup information from README.md
- The prompt should guide an agent to provide setup guidance based on the README content

### Prompt Content
The copied prompt should:
- Reference the README.md extension setup information
- Ask the agent to provide guidance on Switchboard setup options
- Be suitable for pasting into an AI agent chat

## Implementation Plan

### 1. Modify setup.html
- Add the new section HTML at the top of the setup tab content (id="startup-fields")
- Use existing CSS classes for consistency (section-label, hint-text, action-btn)
- Add a unique ID for the new button (e.g., "btn-copy-tutorial-prompt")

### 2. Add JavaScript handler
- Add an onclick handler for the new button
- Implement clipboard copy functionality using the VS Code API
- Construct the prompt text to include README setup information

### 3. Prompt construction
The prompt should include:
- A request for Switchboard setup guidance
- Reference to the README.md setup section
- Context about what setup options are available
- Clear instructions for the agent on what guidance to provide

## Files to Modify
- `/Users/patrickvuleta/Documents/GitHub/switchboard/src/webview/setup.html` - Add UI section and JavaScript handler
- `/Users/patrickvuleta/Documents/GitHub/switchboard/dist/webview/setup.html` - Update after build (if applicable)

## Testing Checklist
- [ ] Verify the new section appears at the top of the Setup tab
- [ ] Verify the section label and explanatory text are displayed correctly
- [ ] Verify the button styling matches the existing action-btn style
- [ ] Verify clicking the button copies the prompt to clipboard
- [ ] Verify the prompt content references README setup information appropriately
- [ ] Test the copied prompt by pasting it into an AI agent to confirm it provides useful guidance
