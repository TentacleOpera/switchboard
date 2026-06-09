import * as fs from 'fs';
import * as path from 'path';

/**
 * @deprecated Plan files should not contain Switchboard State sections.
 * The KanbanDatabase is the sole source of truth for plan state.
 * These functions are kept for backward compatibility only.
 */

export interface KanbanStateFields {
    kanbanColumn: string;
    status: string;
}

export interface KanbanStateInspection {
    state: KanbanStateFields | null;
    topLevelSectionCount: number;
    lastSeenColumn: string | null;
}

export interface KanbanStateInspectionOptions {
    validColumns?: Iterable<string>;
}

/**
 * @deprecated Plan files should not contain Switchboard State sections.
 * The KanbanDatabase is the sole source of truth for plan state.
 * Always returns null state.
 */
export function inspectKanbanState(
    content: string,
    options?: KanbanStateInspectionOptions
): KanbanStateInspection {
    // DISABLED: We no longer trust or read file-based state.
    return {
        state: null,
        topLevelSectionCount: 0,
        lastSeenColumn: null
    };
}

/**
 * @deprecated Plan files should not contain Switchboard State sections.
 * The KanbanDatabase is the sole source of truth for plan state.
 * Always returns null.
 */
export function extractKanbanState(
    content: string,
    options?: KanbanStateInspectionOptions
): KanbanStateFields | null {
    return inspectKanbanState(content, options).state;
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
    // DISABLED: Switchboard State writes are disabled to prevent file-state override bugs.
    // The KanbanDatabase is the sole source of truth.
    return Promise.resolve();
}
