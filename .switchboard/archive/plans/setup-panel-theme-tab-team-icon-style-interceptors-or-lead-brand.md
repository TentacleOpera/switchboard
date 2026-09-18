# Setup Panel Theme Tab: Select Team Icon Style (Interceptors vs. Team Lead CLI Brand Icons)

## Goal

In the **Theme** tab of the Setup Panel, add a configuration option allowing users to choose the icon style rendered for teams in the Shell navigation rail and terminal strips:
1. **Interceptors (Default / Current):** Stylized interceptor / spaceship pixel-art icons.
2. **Team Lead CLI Brand Icons:** The authentic brand icon of the team lead's registered AI CLI agent (e.g., Claude, Antigravity, Devin, Jules, Gemini, OpenAI, Cursor, Copilot, Windsurf, Qwen, Amp, Cline, Kiro, Kilo, Trae, Opencode, Zed).

### Problem Analysis

**Teams currently display interceptor glyphs regardless of their composition.** While the interceptor aesthetic fits the space/cockpit theme, operators running multi-agent setups (e.g., a Claude lead with Gemini coders, or an Antigravity lead with subagents) often want immediate visual recognition of which AI engine is driving each team.

Switchboard already bundles high-quality SVG brand icons for all major CLI agents in `icons/` (`brand-claude.svg`, `brand-antigravity.svg`, `brand-devin.svg`, `brand-jules.svg`, `brand-gemini.svg`, `brand-openai.svg`, `brand-cursor.svg`, `brand-copilot.svg`, `brand-windsurf.svg`, `brand-qwen.svg`, `brand-amp.svg`, `brand-cline.svg`, `brand-kiro.svg`, `brand-kilo.svg`, `brand-trae.svg`, `brand-opencode.svg`, `brand-zed.svg`, `brand-cli-default.svg`).

By adding a clean toggle in the Setup **Theme** tab:
- Operators can switch between the unified **Interceptors** fleet look and the engine-specific **Team Lead Brand Icons**.
- When **Team Lead Brand Icons** is active, each team's button in the shell rail and terminal strip automatically inspects the team lead's configured agent profile and renders that provider's brand icon styled with the active theme accent.
- Changes apply instantly via live WebSocket/postMessage broadcast without requiring a browser reload.

## Proposed Changes

### 1. Setup Panel UI & Persistence (`src/webview/setup.html`, `src/webview/setup.js`, `SetupProvider.ts`)

#### [MODIFY] [setup.html](file:///home/patrick/switchboard/src/webview/setup.html)
- Add a new section in the **Theme** tab: **"Team Icon Style"**:
  - Radio option 1: `Interceptors (Default)` — Stylized fleet interceptor icons.
  - Radio option 2: `Team Lead CLI Brand Icons` — Uses the brand icon of the team lead agent (Claude, Antigravity, Devin, Gemini, etc.).

#### [MODIFY] [setup.js](file:///home/patrick/switchboard/src/webview/setup.js)
- Wire change event on the team icon style radios to call `setTeamIconStyle` verb via `postMessage` / `transport.js`.
- Hydrate initial radio selection from loaded config.

#### [MODIFY] [SetupProvider.ts](file:///home/patrick/switchboard/src/services/SetupProvider.ts)
- Add verb handler `setTeamIconStyle` that persists `theme.teamIconStyle` in the database / config table (`'interceptors' | 'lead-brand'`).
- Broadcast `teamIconStyleChanged` event through `BroadcastHub`.

### 2. Shell Rail & Terminal Strip Icon Resolution (`src/webview/shell.js`, `src/webview/terminals.js`, `src/services/headlessPanelHtml.ts`)

#### [MODIFY] [headlessPanelHtml.ts](file:///home/patrick/switchboard/src/services/headlessPanelHtml.ts)
- Inject `data-team-icon-style` attribute into panel body initialization attributes (`data-team-icon-style="${teamIconStyle}"`).

#### [MODIFY] [shell.js](file:///home/patrick/switchboard/src/webview/shell.js) & [terminals.js](file:///home/patrick/switchboard/src/webview/terminals.js)
- When resolving the icon for a team slot:
  - If `teamIconStyle === 'lead-brand'`:
    - Look up the team's `lead` terminal definition from the team configuration.
    - Extract the lead's provider / agent engine (`claude`, `antigravity`, `devin`, `gemini`, `openai`, etc.).
    - Render the corresponding brand SVG mask (`data-brand-icon-<provider>` or fallback `data-brand-icon-default`).
  - If `teamIconStyle === 'interceptors'` (or unset):
    - Render the standard team interceptor icon SVG mask.
- Listen for `teamIconStyleChanged` broadcast and re-render the team icons dynamically in place.

### 3. Dual Host Parity (`src/extension.ts` & `src/standalone/bootstrap.ts`)
- Ensure `setTeamIconStyle` verb and `teamIconStyleChanged` broadcast are wired in both the VS Code extension composition root and standalone bootstrap composition root.

## Verification Plan

### Automated Tests
1. **Config persistence:** Assert `setTeamIconStyle` persists `'lead-brand'` and `'interceptors'` into the database and returns success.
2. **Push-parity check:** Assert `teamIconStyleChanged` message type is handled across both standalone and extension providers (`npm run standalone-parity:check`).
3. **Brand icon resolution:** Contract test asserting that when `teamIconStyle === 'lead-brand'`, a team with a `claude` lead resolves `brand-claude.svg` and a team with an `antigravity` lead resolves `brand-antigravity.svg`.

### Manual Verification
1. Open the Setup panel in the browser board (`http://localhost:7777`).
2. Navigate to the **Theme** tab.
3. Switch from **Interceptors** to **Team Lead CLI Brand Icons**.
4. Observe the Shell navigation rail and terminal strips instantly update to show the Claude / Antigravity brand icon for the Coding team.
5. Switch back to **Interceptors** and observe the fleet ship icons restore immediately.

## Goal Invariants

- `theme.teamIconStyle` defaults to `'interceptors'`.
- When set to `'lead-brand'`, team buttons in `shell.js` and `terminals.js` render the brand icon of the team's lead terminal.
- Switching icon style in Setup broadcasts live updates to all connected webviews without requiring a page reload.
- Both VS Code extension and standalone hosts support the configuration and broadcast seamlessly.

## Metadata
**Topic:** Setup Panel Theme Tab: Select Team Icon Style (Interceptors vs. Team Lead CLI Brand Icons)
