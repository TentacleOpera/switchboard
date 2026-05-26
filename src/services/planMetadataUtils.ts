
import * as path from 'path';
import * as fs from 'fs';
import { legacyToScore } from './complexityScale';

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

export interface PlanMetadata {
    sessionId?: string;
    topic: string;
    kanbanColumn?: string;
    complexity: string;
    tags: string;
    dependencies: string;
    project?: string;
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

    // Extract complexity
    let complexity: string = 'Unknown';
    const overrideMatch = content.match(/^[\s\-\*\>]*(?:\d+\.\s*)?\*\*Manual Complexity Override:\*\*\s*(\d{1,2}|Low|High|Unknown)/im);
    if (overrideMatch) {
        const val = overrideMatch[1];
        if (val.toLowerCase() !== 'unknown') {
            const num = parseInt(val, 10);
            if (!isNaN(num) && num >= 1 && num <= 10) complexity = String(num);
            else {
                const legacy = legacyToScore(val);
                if (legacy > 0) complexity = String(legacy);
            }
        }
    }
    if (complexity === 'Unknown') {
        const metadataMatch = content.match(/^[\s\-\*\>]*(?:\d+\.\s*)?\*\*Complexity:\*\*\s*(\d{1,2}|Low|High)/im);
        if (metadataMatch) {
            const val = metadataMatch[1];
            const num = parseInt(val, 10);
            if (!isNaN(num) && num >= 1 && num <= 10) complexity = String(num);
            else {
                const legacy = legacyToScore(val);
                if (legacy > 0) complexity = String(legacy);
            }
        }
    }

    // Extract tags
    let tags: string = '';
    const tagsMatch = content.match(/^[\s\-\*\>]*(?:\d+\.\s*)?\*\*Tags:\*\*\s*(.+)/im);
    if (tagsMatch) {
        tags = sanitizeTags(tagsMatch[1]);
    }

    // Extract dependencies
    let dependencies: string = '';
    const sectionMatch = content.match(/^#{1,4}\s+Dependencies\b[^\n]*$/im);
    if (sectionMatch && sectionMatch.index !== undefined) {
        const afterHeading = content.slice(sectionMatch.index + sectionMatch[0].length);
        const nextHeadingMatch = afterHeading.match(/^\s*#{1,4}\s+/m);
        const sectionBody = nextHeadingMatch
            ? afterHeading.slice(0, nextHeadingMatch.index)
            : afterHeading;
        const deps = sectionBody
            .split(/\r?\n/)
            .map(line => line.trim())
            .map(line => line.replace(/^[-*+]\s+/, '').replace(/^\d+\.\s+/, '').trim())
            .filter(line => line.length > 0)
            .filter(line => !/^(none|n\/a|na|unknown)$/i.test(line));
        dependencies = [...new Set(deps)].join(', ');
    }

    let project: string | undefined;
    const projectMatch = content.match(/^\*\*Project:\*\*\s*(.+)$/im);
    if (projectMatch) {
        project = projectMatch[1].trim() || undefined;
    }

    return {
        topic,
        kanbanColumn: columnMatch?.[1],
        complexity,
        tags,
        dependencies,
        project
    };
}
