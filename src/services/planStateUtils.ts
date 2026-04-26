import * as fs from 'fs';
import * as path from 'path';

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

interface SwitchboardStateSection {
    start: number;
    end: number;
    body: string;
    fields: {
        kanbanColumn: string | null;
        status: string | null;
    };
}

const DEFAULT_VALID_COLUMNS = new Set([
    'CREATED', 'BACKLOG', 'PLANNED', 'TEAM LEAD CODED', 'INTERN CODED', 'CODER CODED',
    'LEAD CODED', 'CODE REVIEWED', 'ACCEPTANCE TESTED', 'CODED', 'PLAN REVIEWED', 'COMPLETED'
]);

const FENCE_TOGGLE_RE = /^(```|~~~)/;
const TOP_LEVEL_HEADING_RE = /^(##\s+|#\s+)/;
const SWITCHBOARD_STATE_HEADING_RE = /^## Switchboard State\s*$/;

function normalizeLineEndings(content: string): string {
    return content.replace(/\r\n/g, '\n');
}

function restoreLineEndings(content: string, lineEnding: string): string {
    return lineEnding === '\n' ? content : content.replace(/\n/g, lineEnding);
}

function extractStateSectionFields(sectionBody: string): { kanbanColumn: string | null; status: string | null } {
    const columnMatch = sectionBody.match(/\*\*Kanban Column:\*\*\s*(.+)/);
    const statusMatch = sectionBody.match(/\*\*Status:\*\*\s*(.+)/);

    return {
        kanbanColumn: columnMatch?.[1]?.trim() || null,
        status: statusMatch?.[1]?.trim() || null
    };
}

function resolveValidColumns(options?: KanbanStateInspectionOptions): Set<string> {
    const resolved = new Set(DEFAULT_VALID_COLUMNS);
    if (!options?.validColumns) {
        return resolved;
    }
    for (const value of options.validColumns) {
        const normalized = String(value || '').trim();
        if (normalized) {
            resolved.add(normalized);
        }
    }
    return resolved;
}

function parseStateSectionBody(
    sectionBody: string,
    validColumns: Set<string>
): KanbanStateFields | null {
    const { kanbanColumn, status } = extractStateSectionFields(sectionBody);
    if (!kanbanColumn || !validColumns.has(kanbanColumn)) {
        return null;
    }
    return {
        kanbanColumn,
        status: status === 'completed' ? 'completed' : 'active'
    };
}

function collectTopLevelSwitchboardStateSections(content: string): SwitchboardStateSection[] {
    const normalized = normalizeLineEndings(content);
    const lines = normalized.split('\n');
    const lineStarts: number[] = [];
    let offset = 0;

    for (const line of lines) {
        lineStarts.push(offset);
        offset += line.length + 1;
    }

    const sections: SwitchboardStateSection[] = [];
    let inFence = false;

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const trimmed = line.trim();

        if (FENCE_TOGGLE_RE.test(trimmed)) {
            inFence = !inFence;
            continue;
        }

        if (inFence || !SWITCHBOARD_STATE_HEADING_RE.test(line)) {
            continue;
        }

        let endLine = lines.length;
        let sectionInFence = false;
        for (let j = i + 1; j < lines.length; j++) {
            const candidate = lines[j];
            const candidateTrimmed = candidate.trim();

            if (FENCE_TOGGLE_RE.test(candidateTrimmed)) {
                sectionInFence = !sectionInFence;
                continue;
            }

            if (!sectionInFence && TOP_LEVEL_HEADING_RE.test(candidate)) {
                endLine = j;
                break;
            }
        }

        const start = lineStarts[i];
        const end = endLine < lineStarts.length ? lineStarts[endLine] : normalized.length;
        const bodyStart = Math.min(normalized.length, start + line.length + 1);
        const body = normalized.slice(bodyStart, end);

        sections.push({
            start,
            end,
            body,
            fields: extractStateSectionFields(body)
        });
    }

    return sections;
}

function stripTrailingSwitchboardStateSections(content: string): string {
    const normalized = normalizeLineEndings(content);
    const sections = collectTopLevelSwitchboardStateSections(normalized);
    if (sections.length === 0) {
        return normalized.trimEnd();
    }

    let rebuilt = '';
    let cursor = 0;
    for (const section of sections) {
        rebuilt += normalized.slice(cursor, section.start);
        cursor = section.end;
    }
    rebuilt += normalized.slice(cursor);
    return rebuilt.trimEnd();
}

/**
 * Parses the `## Switchboard State` section from plan file content.
 * Returns null if the section is absent or cannot be parsed.
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

export function extractKanbanState(
    content: string,
    options?: KanbanStateInspectionOptions
): KanbanStateFields | null {
    return inspectKanbanState(content, options).state;
}

/**
 * Upserts the `## Switchboard State` section at the end of plan file content.
 * Removes any existing state section before appending the new one.
 */
export function applyKanbanStateToPlanContent(
    content: string,
    state: KanbanStateFields & { lastUpdated: string; formatVersion: number }
): string {
    const lineEnding = content.includes('\r\n') ? '\r\n' : '\n';
    const withoutState = stripTrailingSwitchboardStateSections(content);

    const stateSection = [
        '## Switchboard State',
        `**Kanban Column:** ${state.kanbanColumn}`,
        `**Status:** ${state.status}`,
        `**Last Updated:** ${state.lastUpdated}`,
        `**Format Version:** ${state.formatVersion}`
    ].join('\n');

    const rebuilt = withoutState.length > 0
        ? withoutState + '\n\n' + stateSection + '\n'
        : stateSection + '\n';
    return restoreLineEndings(rebuilt, lineEnding);
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
