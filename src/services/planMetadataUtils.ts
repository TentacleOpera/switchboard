
import * as path from 'path';
import * as fs from 'fs';
import { deriveComplexityFromContent } from './complexityScale';
import { STAGE_COMPLETE_LABEL } from './agentPromptBuilder';

export const ALLOWED_TAGS = new Set([
    'frontend', 'backend', 'auth', 'authentication', 'database', 'api', 'ui', 'ux',
    'bugfix', 'feature', 'refactor', 'test', 'docs', 'security', 'performance',
    'reliability', 'mobile', 'devops', 'infrastructure', 'cli', 'library'
]);

export function sanitizeTags(raw: string): string {
    if (!raw || raw.toLowerCase().trim() === 'none') return '';
    const tags = raw
        .toLowerCase()
        .split(',')
        .map(t => t.trim())
        .filter(t => t.length > 0 && ALLOWED_TAGS.has(t));
    if (tags.length === 0) return '';
    return `,${tags.join(',')},`;
}

/**
 * Extract a `> **Label:** value` (or `**Label:** value`) embedded metadata line.
 * Moved here from PlanFileImporter so the watcher and batch importer share one parser.
 */
export function extractEmbeddedMetadata(content: string, label: string): string {
    const pattern = new RegExp(`^(?:>\\s+)?\\*\\*${label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}:\\*\\*\\s*(.+)$`, 'im');
    const match = content.match(pattern);
    return match ? match[1].trim() : '';
}

export function extractClickUpTaskId(content: string): string {
    const explicitId = extractEmbeddedMetadata(content, 'ClickUp Task ID');
    if (explicitId) {
        return explicitId;
    }

    const importedMatch = content.match(/^>\s+Imported from ClickUp task\s+`([^`]+)`$/im);
    return importedMatch ? importedMatch[1].trim() : '';
}

export function extractLinearIssueId(content: string): string {
    return extractEmbeddedMetadata(content, 'Linear Issue ID');
}

export interface PlanMetadata {
    sessionId?: string;
    topic: string;
    kanbanColumn?: string;
    complexity: string;
    tags: string;
    project?: string;
    /** Durable fact: the feature plan-id (filename UUID) this subtask belongs to. */
    feature?: string;
    /**
     * Activity-light OFF-switch. Present (possibly empty) when the agent appended a
     * `**Stage Complete: <COLUMN>**` marker. The watcher clears the card's `working`
     * state (nulls dispatched_at) when this is set. Empty string = marker present but
     * no column echoed (clear without the stale-marker column guard).
     */
    stageComplete?: string;
}

/**
 * Infer a readable topic/title from a plan file path.
 * Strips common prefixes (brain_, feature_plan_, plan_), leading hex hashes,
 * and converts underscores/hyphens to spaces with title casing.
 */
export function inferTopicFromPath(filePath: string | undefined): string {
    if (!filePath) return '(untitled)';
    let name = path.basename(filePath, path.extname(filePath));
    name = name.replace(/^(brain_|feature_plan_|plan_)/, '');
    // Strip leading hex hash (32+ hex chars)
    name = name.replace(/^[0-9a-f]{32,}$/i, '').replace(/^[0-9a-f]{32,}_/i, '');
    if (!name) return '(untitled)';
    return name
        .replace(/[_-]+/g, ' ')
        .replace(/\b\w/g, c => c.toUpperCase())
        .trim() || '(untitled)';
}

export async function parsePlanMetadata(content: string, planFile: string): Promise<PlanMetadata> {
    // Extract topic
    const topicMatch = content.match(/^#\s+(.+)$/m) || 
                      content.match(/topic:\s*(.+)$/im);
    const topic = topicMatch?.[1] || inferTopicFromPath(planFile);

    // Extract kanbanColumn
    const columnMatch = content.match(/kanbanColumn[:\s]+(\w+)/i);

    // Extract complexity — full-fidelity chain (override → **Complexity:** →
    // agent recommendation → Complexity Audit / Band B). Shared helper keeps the
    // watcher's DB-column write in sync with the rich parser used for display.
    const complexity: string = deriveComplexityFromContent(content);

    // Extract tags
    let tags: string = '';
    const tagsMatch = content.match(/^[\s\-\*\>]*(?:\d+\.\s*)?\*\*Tags(?:\*\*:\s*|:\*\*)\s*(.+)/im);
    if (tagsMatch) {
        tags = sanitizeTags(tagsMatch[1]);
    }

    let project: string | undefined;
    // Tolerate the same list-item prefixes as the Tags regex above (line 90):
    // agents write `- **Project:** X` / `> **Project:** X` / `2. **Project:** X`
    // under ## Metadata. The old line-anchored regex silently dropped those pins.
    const projectMatch = content.match(/^[\s\-\*\>]*(?:\d+\.\s*)?\*\*Project(?:\*\*:\s*|:\*\*)\s*(.+)$/im);
    if (projectMatch) {
        project = projectMatch[1].trim() || undefined;
    }

    // Durable fact: **Feature:** <feature-plan-id> (the feature's filename UUID).
    // Apply-if-empty semantics on import — absence never clears a DB link.
    let feature: string | undefined;
    const featureMatch = content.match(/^[\s\-\*\>]*(?:\d+\.\s*)?\*\*Feature(?:\*\*:\s*|:\*\*)\s*(.+)$/im);
    if (featureMatch) {
        const raw = featureMatch[1].trim();
        if (raw) {
            feature = raw;
        }
    }

    // Activity-light OFF-switch: `**Stage Complete: <COLUMN>**` (or `> **…**`).
    // Tolerant of a bare `**Stage Complete:**` (no column) — yields '' so the watcher
    // clears without the stale-marker column guard. undefined when the marker is absent.
    let stageComplete: string | undefined;
    const stageRegex = new RegExp(
        `^(?:>\\s+)?\\*\\*${STAGE_COMPLETE_LABEL.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}:\\*\\*\\s*(.*)$`,
        'im'
    );
    const stageMatch = content.match(stageRegex);
    if (stageMatch) {
        stageComplete = stageMatch[1].trim();
    }

    return {
        topic,
        kanbanColumn: columnMatch?.[1],
        complexity,
        tags,
        project,
        feature,
        stageComplete
    };
}

/**
 * Insert or update a `**Manual Complexity Override:** <value>` marker in a plan
 * file's content.
 *
 * This marker is the HIGHEST-priority complexity source for both parsePlanMetadata()
 * (used by the plan watcher) and KanbanProvider.getComplexityFromPlan(). Writing it
 * is what makes a user's dropdown choice survive plan-file re-imports — without it,
 * the watcher re-derives complexity from the plan's `**Complexity:**` line on the
 * next file event and clobbers the DB value the dropdown just set.
 *
 * Always emits the `**Manual Complexity Override:** N` form (colon INSIDE the
 * asterisks) — that is the single format both parsers accept.
 */
export function applyManualComplexityOverride(content: string, complexity: string): string {
    const normalized = content.replace(/\r\n/g, '\n');
    const overrideLine = `**Manual Complexity Override:** ${complexity}`;

    // Replace an existing override line in place.
    const existingRegex = /^[ \t>*\-]*\*\*Manual Complexity Override:\*\*[^\n]*$/im;
    if (existingRegex.test(normalized)) {
        return normalized.replace(existingRegex, overrideLine);
    }

    // Otherwise insert it right after the **Complexity:** metadata line if present,
    // so the override sits alongside the value it overrides.
    const complexityLine = normalized.match(/^[ \t>*\-]*\*\*Complexity:\*\*[^\n]*$/im);
    if (complexityLine && complexityLine.index !== undefined) {
        const insertPos = complexityLine.index + complexityLine[0].length;
        return `${normalized.slice(0, insertPos)}\n${overrideLine}${normalized.slice(insertPos)}`;
    }

    // Failing that, after the ## Metadata heading...
    const metadataHeading = normalized.match(/^#{1,4}\s+Metadata\b[^\n]*$/im);
    if (metadataHeading && metadataHeading.index !== undefined) {
        const insertPos = metadataHeading.index + metadataHeading[0].length;
        return `${normalized.slice(0, insertPos)}\n\n${overrideLine}${normalized.slice(insertPos)}`;
    }

    // ...then after the first H1 title...
    const title = normalized.match(/^#\s+[^\n]+$/m);
    if (title && title.index !== undefined) {
        const insertPos = title.index + title[0].length;
        return `${normalized.slice(0, insertPos)}\n\n${overrideLine}\n${normalized.slice(insertPos)}`;
    }

    // ...else prepend.
    return `${overrideLine}\n\n${normalized}`;
}
