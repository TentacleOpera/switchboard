import * as fs from 'fs';
import * as path from 'path';

export interface KanbanStateFields {
    kanbanColumn: string;
    status: string;
}

const VALID_COLUMNS = new Set([
    'CREATED', 'BACKLOG', 'PLANNED', 'TEAM LEAD CODED', 'INTERN CODED', 'CODER CODED',
    'LEAD CODED', 'CODE REVIEWED', 'ACCEPTANCE TESTED', 'CODED', 'PLAN REVIEWED', 'COMPLETED'
]);

/**
 * Parses the `## Switchboard State` section from plan file content.
 * Returns null if the section is absent or cannot be parsed.
 */
export function extractKanbanState(content: string): KanbanStateFields | null {
    const sectionMatch = content.match(
        /## Switchboard State\s*\n([\s\S]*?)(?=\n##\s|\n#\s|$)/
    );
    if (!sectionMatch) {
        return null;
    }
    const section = sectionMatch[1];

    const columnMatch = section.match(/\*\*Kanban Column:\*\*\s*(.+)/);
    const statusMatch = section.match(/\*\*Status:\*\*\s*(.+)/);

    const kanbanColumn = columnMatch?.[1]?.trim();
    const status = statusMatch?.[1]?.trim();

    if (!kanbanColumn || !VALID_COLUMNS.has(kanbanColumn)) {
        return null;
    }

    return {
        kanbanColumn,
        status: status === 'completed' ? 'completed' : 'active'
    };
}

/**
 * Upserts the `## Switchboard State` section at the end of plan file content.
 * Removes any existing state section before appending the new one.
 */
export function applyKanbanStateToPlanContent(
    content: string,
    state: KanbanStateFields & { lastUpdated: string; formatVersion: number }
): string {
    const withoutState = content.replace(/\n?## Switchboard State[\s\S]*$/, '');

    const stateSection = [
        '## Switchboard State',
        `**Kanban Column:** ${state.kanbanColumn}`,
        `**Status:** ${state.status}`,
        `**Last Updated:** ${state.lastUpdated}`,
        `**Format Version:** ${state.formatVersion}`
    ].join('\n');

    return withoutState.trimEnd() + '\n\n' + stateSection + '\n';
}

/**
 * Atomically writes updated kanban state into a plan file via a temp-file rename.
 * Validates the target path is within workspaceRoot before writing.
 * Errors are caught and logged — this function never throws.
 */
export async function writePlanStateToFile(
    planFilePath: string,
    workspaceRoot: string,
    column: string,
    status: string
): Promise<void> {
    const resolvedPlan = path.resolve(planFilePath);
    const resolvedRoot = path.resolve(workspaceRoot);
    if (!resolvedPlan.startsWith(resolvedRoot + path.sep)) {
        console.warn(`[Switchboard] Skipping state write: path outside workspace root: ${resolvedPlan}`);
        return;
    }

    if (!fs.existsSync(resolvedPlan)) {
        console.warn(`[Switchboard] Skipping state write: plan file not found: ${resolvedPlan}`);
        return;
    }

    const tmpPath = resolvedPlan + '.swb.tmp';
    try {
        const content = await fs.promises.readFile(resolvedPlan, 'utf-8');
        const updated = applyKanbanStateToPlanContent(content, {
            kanbanColumn: column,
            status,
            lastUpdated: new Date().toISOString(),
            formatVersion: 1
        });
        await fs.promises.writeFile(tmpPath, updated, 'utf-8');
        await fs.promises.rename(tmpPath, resolvedPlan);
    } catch (err) {
        try { await fs.promises.unlink(tmpPath); } catch { /* ignore */ }
        console.error(`[Switchboard] Failed to write kanban state to plan file ${resolvedPlan}: ${err}`);
    }
}
