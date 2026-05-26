# Flash Lite Researcher Configuration

## Overview
Add configuration for Gemini 3.1 Flash-Lite API to enable direct web research from the Switchboard extension's planning view. This feature allows users to configure their Google API key in the setup tab and send research requests directly to the Gemini API from the research tab.

## Background
Currently, the RESEARCH tab in planning.html provides a prompt template but requires manual copy-paste to external AI services. This feature adds:
1. Secure API key storage in setup.html
2. Direct API integration for research requests
3. Button in research tab to send requests to Gemini 3.1 Flash-Lite

## Technical Context
- **planning.html location**: `/Users/patrickvuleta/Documents/GitHub/switchboard/src/webview/planning.html`
- **setup.html location**: `/Users/patrickvuleta/Documents/GitHub/switchboard/src/webview/setup.html`
- **Secret storage**: Extension already uses `context.secrets.get()` and `context.secrets.store()` for ClickUp, Linear, and Notion tokens
- **Pattern**: Follow existing secret storage pattern (e.g., `switchboard.clickup.apiToken`)

## Implementation Plan

### Phase 1: Setup Tab Configuration UI

**File**: `src/webview/setup.html`

1. Add new configuration section for Gemini API
   - Section header: "GEMINI FLASH-LITE RESEARCHER"
   - Input field for API key (password type for security)
   - Save button
   - Status indicator showing configured/unconfigured state
   - Link to Google AI Studio for API key generation
   - Security note explaining storage location and visibility:
     - "Your API key is stored in VS Code's secure storage (SecretStorage API)"
     - "The key is encrypted at rest and managed by VS Code's platform-specific secure storage"
     - "The extension never sees or logs your API key in plain text"
     - "The key is only sent directly to Google's Gemini API endpoints"

2. Follow existing setup.html styling patterns
   - Use existing card/border styles
   - Match dark theme colors
   - Use existing button styles

### Phase 2: Secret Storage Backend

**File**: `src/extension.ts`

1. Add command to save Gemini API key
   - Command ID: `switchboard.saveGeminiApiKey`
   - Secret key: `switchboard.gemini.apiToken`
   - Validation: Check key format (starts with `AIza` or similar pattern)
   - Success/error feedback via VS Code notifications

2. Add command to retrieve Gemini API key
   - Command ID: `switchboard.getGeminiApiKey`
   - Return empty string if not configured
   - Used by setup panel to show current state

3. Add command to clear Gemini API key
   - Command ID: `switchboard.clearGeminiApiKey`
   - Delete from secret storage
   - Update UI state

### Phase 3: Research Tab Integration

**File**: `src/webview/planning.html`

1. Add new button to RESEARCH tab
   - Button ID: `btn-send-gemini-research`
   - Label: "SEND TO GEMINI FLASH-LITE"
   - Position: Next to existing "SEND ANALYST REQUEST" button
   - Disabled state when API key not configured

2. Add configuration status indicator
   - Show "Gemini API: Configured" or "Gemini API: Not configured"
   - Link to setup tab when not configured
   - Position: Above research prompt input

3. Add loading state for API requests
   - Show spinner or progress indicator during request
   - Disable button during request
   - Display error messages on failure

### Phase 4: API Integration Service

**File**: `src/services/GeminiResearchService.ts` (new file)

1. Create service class for Gemini API calls
   - Constructor takes API key
   - Method: `performResearch(prompt: string, options: ResearchOptions)`
   - Options include:
     - Model: `gemini-3.1-flash-lite-preview`
     - Enable search grounding (optional)
     - Complexity level (from UI radio buttons)
     - Import local results (from UI toggle)

2. Implement API call logic
   - Use fetch to call Gemini API
   - Enable Search Grounding tool for web search
   - Handle rate limits and errors
   - Parse and return research results

3. Integration with research prompt template
   - Read prompt from textarea
   - Apply complexity level settings
   - Format for Gemini API requirements
   - Include instructions for structured output

### Phase 5: Planning Panel Provider Integration

**File**: `src/services/PlanningPanelProvider.ts`

1. Add message handler for Gemini research requests
   - Message type: `sendGeminiResearch`
   - Validate API key is configured
   - Call GeminiResearchService
   - Stream results back to webview
   - Handle errors gracefully

2. Add message handler for API key status
   - Message type: `getGeminiApiKeyStatus`
   - Return boolean indicating if key is configured
   - Called on webview initialization

3. Update webview message handling
   - Add new message types to switch statement
   - Maintain existing message handling

### Phase 6: Webview JavaScript Updates

**File**: `src/webview/planning.js`

1. Add API key status check on load
   - Call `getGeminiApiKeyStatus` message
   - Update UI state (enable/disable button)
   - Show configuration status

2. Add button click handler for Gemini research
   - Read research prompt from textarea
   - Read complexity level from radio buttons
   - Read import toggle state
   - Send `sendGeminiResearch` message
   - Handle streaming response
   - Display results in preview pane

3. Add link to setup tab
   - When API key not configured, show link
   - Click handler switches to setup tab
   - Focus Gemini configuration section

## File Changes Summary

### New Files
- `src/services/GeminiResearchService.ts` - Gemini API integration service

### Modified Files
- `src/webview/setup.html` - Add Gemini API configuration section
- `src/webview/planning.html` - Add Gemini research button and status indicator
- `src/webview/planning.js` - Add Gemini research handling logic
- `src/extension.ts` - Add secret storage commands for Gemini API key
- `src/services/PlanningPanelProvider.ts` - Add message handlers for Gemini research

## Testing Checklist

- [ ] API key saves correctly to secret storage
- [ ] API key retrieves correctly on extension reload
- [ ] API key clears correctly
- [ ] Research button disabled when API key not configured
- [ ] Research button enabled when API key configured
- [ ] Research request sends to Gemini API successfully
- [ ] Search grounding works for web research
- [ ] Complexity level settings applied to prompt
- [ ] Import toggle works for local result saving
- [ ] Error handling for invalid API keys
- [ ] Error handling for rate limits
- [ ] Error handling for network failures
- [ ] Loading state displays during API calls
- [ ] Results display correctly in preview pane
- [ ] Link to setup tab works when not configured

## Security Considerations

- API key stored in VS Code SecretStorage (encrypted at rest)
- API key never logged or displayed in plain text
- API key only sent to Google Gemini API endpoints
- Input field uses password type to prevent shoulder surfing
- Validation on key format before saving
- Clear option to remove key when no longer needed

## Future Enhancements

- Support for other Gemini models (3.1 Pro, 3.5 Flash)
- Custom prompt templates for different research types
- Research history and caching
- Batch research requests
- Cost tracking and quota monitoring
- Custom search grounding parameters
- Integration with local docs for context-aware research

## Dependencies

- VS Code SecretStorage API (already in use)
- Fetch API for HTTP requests (built-in)
- Existing planning panel infrastructure
- Existing secret storage patterns

## Success Criteria

- User can configure Gemini API key in setup tab
- User can send research requests directly from research tab
- API calls work with Gemini 3.1 Flash-Lite
- Search grounding enables web research
- Results display in preview pane
- Error handling is robust and user-friendly
- Implementation follows existing code patterns
