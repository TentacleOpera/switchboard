# Agent visibility in the setup menu does not persist

## Goal
If I uncheck agetns in the setup menu, e.g. uncheck jules, then save and restart the ide, they're all back active again on restart ide. Why doesn't this persist?

## Proposed Changes
Modify `src/lifecycle/cleanWorkspace.ts`. The `readPersistedFields` function currently only preserves `startupCommands` when wiping the workspace on IDE restart. Update it to explicitly copy over all long-lived configuration and state tracking arrays from the old `state.json`.

Update `readPersistedFields` in `src/lifecycle/cleanWorkspace.ts` to exactly this implementation:
```typescript
/**
 * Reads persisted fields from existing state.json that must survive resets.
 */
async function readPersistedFields(statePath: string): Promise<Record<string, unknown>> {
    const persisted: Record<string, unknown> = {};
    try {
        const content = await fs.promises.readFile(statePath, 'utf8');
        const state = JSON.parse(content);
        
        // Preserve startup commands
        if (state.startupCommands && typeof state.startupCommands === 'object') {
            persisted.startupCommands = state.startupCommands;
        }
        
        // Preserve agent visibility preferences
        if (state.visibleAgents && typeof state.visibleAgents === 'object') {
            persisted.visibleAgents = state.visibleAgents;
        }

        // Preserve custom agent configurations
        if (Array.isArray(state.customAgents)) {
            persisted.customAgents = state.customAgents;
        }

        // Preserve autoban configuration
        if (state.autoban && typeof state.autoban === 'object') {
            persisted.autoban = state.autoban;
        }

        // Preserve plan ingestion target
        if (typeof state.planIngestionFolder === 'string') {
            persisted.planIngestionFolder = state.planIngestionFolder;
        }

        // Preserve jules tracking state
        if (Array.isArray(state.julesSessions)) {
            persisted.julesSessions = state.julesSessions;
        }
        if (typeof state.julesPollingDegraded === 'boolean') {
            persisted.julesPollingDegraded = state.julesPollingDegraded;
        }
        if (typeof state.julesPollingLastCheckedAt === 'string') {
            persisted.julesPollingLastCheckedAt = state.julesPollingLastCheckedAt;
        }
        if (typeof state.julesPollingDegradedAt === 'string') {
            persisted.julesPollingDegradedAt = state.julesPollingDegradedAt;
        }

        // NOTE: terminals are intentionally NOT preserved across resets.
        // Stale terminal entries cause orphan persistence and sidebar ghosts.
    } catch {
        // File missing or corrupt — nothing to preserve
    }
    return persisted;
}
```

## Verification Plan
- Uncheck an agent (e.g., Jules) in the setup menu and click "SAVE CONFIGURATION".
- Restart the extension/IDE (triggering `cleanWorkspace.ts`).
- Verify that the agent remains unchecked in the setup menu and is hidden from the sidebar grid.
- Verify that custom agents and plan ingestion folder configuration also survive the restart.
- Open `.switchboard/state.json` and ensure `julesSessions` does not get wiped out on restart.

## Complexity Audit

### Band A — Routine
- Update `readPersistedFields` in `src/lifecycle/cleanWorkspace.ts` to assign `visibleAgents`, `customAgents`, `planIngestionFolder`, and `julesSessions` (plus polling timestamps) to the `persisted` output object with proper type checking.

### Band B — Complex / Risky
- None

## Open Questions
- Should `julesSessions` and related status flags explicitly be preserved across restarts, or are they expected to clear? (Clarification: Persist them along with other non-ephemeral configuration to prevent UI tracking loss).
