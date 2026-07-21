/**
 * Headless feature-column recompute + feature-file regeneration callbacks
 * (Headless Ingestion piece 2).
 *
 * The extension's `KanbanProvider.recomputeFeatureColumnFromSubtasks` and
 * `KanbanProvider._regenerateFeatureFile` are VS Code-coupled and unavailable
 * headless (standalone has no `KanbanProvider`). These factories reimplement the
 * two callbacks directly against `KanbanDatabase`, following the DB-direct
 * pattern the bootstrap already uses for column moves. They are the headless
 * counterparts injected into the shared `PlanIngestionEngine` so feature files
 * recompute their column and regenerate their `## Subtasks` block identically to
 * the extension.
 *
 * Behaviour mirrors `KanbanProvider.ts:6213` (recompute) and `:10971` (regen):
 *   - recompute only touches a 'CREATED' column (a feature's real column is
 *     authoritative and must not be yanked backward to its least-progressed
 *     subtask),
 *   - regen rewrites the auto-generated `## Subtasks` / `## Worktrees` blocks and
 *     the derived `**Complexity:**` marker, skipping the write when the generated
 *     content is byte-identical to disk (breaks the regen self-write loop).
 */

import * as fs from 'fs';
import * as path from 'path';
import { KanbanDatabase } from '../services/KanbanDatabase';
import { DEFAULT_KANBAN_COLUMNS } from '../services/agentConfig';
import { parseComplexityScore } from '../services/complexityScale';
import { PlanIngestionEngine } from '../services/PlanIngestionEngine';

function normalizeLegacyKanbanColumn(column: string | null | undefined): string {
    const normalized = String(column || '').trim();
    return normalized === 'CODED' ? 'LEAD CODED' : normalized;
}

function buildOrdinalMap(): Map<string, number> {
    const map = new Map<string, number>();
    DEFAULT_KANBAN_COLUMNS.forEach((def, idx) => map.set(def.id, idx));
    if (!map.has('BACKLOG')) { map.set('BACKLOG', -1); }
    return map;
}

const ORDINAL_MAP = buildOrdinalMap();

/**
 * Re-derive a feature's kanban_column from its subtasks. Mirrors
 * `KanbanProvider.recomputeFeatureColumnFromSubtasks` byte-for-byte, minus the
 * custom-columns lookup (headless uses the default column set — custom columns
 * are a VS Code config concern). Only touches a 'CREATED' column.
 */
export function createHeadlessFeatureColumnRecomputer(workspaceRoot: string): (featurePlanId: string, _ws: string) => Promise<void> {
    return async (featurePlanId: string, _ws: string): Promise<void> => {
        try {
            const db = KanbanDatabase.forWorkspace(workspaceRoot);
            if (!await db.ensureReady()) return;
            const feature = await db.getPlanByPlanId(featurePlanId);
            if (!feature || !feature.isFeature) return;
            const subtasks = await db.getSubtasksByFeatureId(featurePlanId);
            const columns = subtasks
                .map((st: any) => normalizeLegacyKanbanColumn(st.kanbanColumn))
                .filter((col: string | null): col is string => !!col);
            if (columns.length === 0) return;
            let resolved = columns.sort(
                (a: string, b: string) => (ORDINAL_MAP.get(a) ?? Infinity) - (ORDINAL_MAP.get(b) ?? Infinity)
            )[0];
            if (resolved === 'BACKLOG') resolved = 'CREATED';
            const current = normalizeLegacyKanbanColumn(feature.kanbanColumn) || 'CREATED';
            if (current !== 'CREATED') return;
            if (resolved === current) return;
            const workspaceId = await db.getWorkspaceId();
            if (!workspaceId) return;
            await db.updateColumnByPlanFile(feature.planFile, workspaceId, resolved);
        } catch (err) {
            console.warn(`[headless] recomputeFeatureColumnFromSubtasks failed for ${featurePlanId}:`, err);
        }
    };
}

/**
 * Regenerate a feature file's auto-generated `## Subtasks` / `## Worktrees`
 * blocks and derived `**Complexity:**` marker. Mirrors
 * `KanbanProvider._regenerateFeatureFile` byte-for-byte (same regexes, same
 * no-op-skip guard, same registerPendingCreation call before the write).
 */
export function createHeadlessFeatureFileRegenerator(workspaceRoot: string): (ws: string, featureId: string) => Promise<void> {
    return async (_ws: string, featureId: string): Promise<void> => {
        if (!featureId) return;
        try {
            const db = KanbanDatabase.forWorkspace(workspaceRoot);
            if (!await db.ensureReady()) return;
            const feature = await db.getPlanByPlanId(featureId);
            if (!feature || !feature.isFeature) return;
            const subtasks = await db.getSubtasksByFeatureId(featureId);
            const featureAbsPath = path.resolve(workspaceRoot, feature.planFile);
            let existingContent = '';
            try {
                existingContent = await fs.promises.readFile(featureAbsPath, 'utf8');
            } catch { /* file may not exist yet */ }

            const subtaskLines = subtasks.map(st => {
                const basename = path.basename(st.planFile);
                const topic = st.topic || basename;
                const column = normalizeLegacyKanbanColumn(st.kanbanColumn) || 'CREATED';
                return `- [ ] [${topic}](../plans/${basename}) — **${column}**`;
            });
            const subtaskSection = `<!-- BEGIN SUBTASKS (auto-generated, do not edit) -->\n## Subtasks\n${subtaskLines.join('\n') || '- [ ] (no subtasks)'}\n<!-- END SUBTASKS -->`;
            let newContent: string;
            const subtaskRegexes = [
                /<!-- BEGIN SUBTASKS[\s\S]*?<!-- END SUBTASKS -->/g,
                /^##\s*Subtasks\b[\s\S]*?<!-- END SUBTASKS -->/gm,
                /<!-- (?:BEGIN|END) SUBTASKS[^\n]*-->/g
            ];
            let firstSubtaskIndex = -1;
            for (const regex of subtaskRegexes) {
                regex.lastIndex = 0;
                const match = regex.exec(existingContent);
                if (match && (firstSubtaskIndex === -1 || match.index < firstSubtaskIndex)) {
                    firstSubtaskIndex = match.index;
                }
            }
            if (firstSubtaskIndex !== -1) {
                const contentBeforeFirst = existingContent.slice(0, firstSubtaskIndex);
                let contentAfterFirst = existingContent.slice(firstSubtaskIndex);
                for (const regex of subtaskRegexes) {
                    contentAfterFirst = contentAfterFirst.replace(regex, '');
                }
                newContent = (contentBeforeFirst + '\n\n' + subtaskSection + '\n\n' + contentAfterFirst).replace(/\n{3,}/g, '\n\n');
            } else {
                newContent = existingContent.replace(/\n*$/, '') + '\n\n' + subtaskSection + '\n';
            }

            const allWorktrees = await db.getWorktrees();
            const featureWorktrees = allWorktrees.filter(w => String(w.feature_id) === String(featureId));
            if (featureWorktrees.length > 0) {
                const integrationWt = featureWorktrees.find(w => !w.subtask_plan_id && !w.tier);
                const subtaskWtByPlanId = new Map(featureWorktrees.filter(w => w.subtask_plan_id).map(w => [String(w.subtask_plan_id), w]));
                const tierWts = featureWorktrees.filter(w => w.tier);
                const worktreeLines: string[] = [];
                if (integrationWt) {
                    worktreeLines.push(`- **Feature integration**: \`${integrationWt.branch}\` → \`${integrationWt.path}\``);
                }
                for (const wt of tierWts) {
                    worktreeLines.push(`- **${wt.tier === 'high' ? 'High' : 'Low'}-complexity tier**: \`${wt.branch}\` → \`${wt.path}\``);
                }
                for (const st of subtasks) {
                    const wt = subtaskWtByPlanId.get(String(st.planId));
                    if (!wt) continue;
                    const basename = path.basename(st.planFile);
                    worktreeLines.push(`- [${st.topic || basename}](../plans/${basename}): \`${wt.branch}\` → \`${wt.path}\``);
                }
                const worktreeSection = `<!-- BEGIN WORKTREES (auto-generated, do not edit) -->\n## Worktrees\n${worktreeLines.join('\n')}\n<!-- END WORKTREES -->`;
                const wtRegexes = [
                    /<!-- BEGIN WORKTREES[\s\S]*?<!-- END WORKTREES -->/g,
                    /^##\s*Worktrees\b[\s\S]*?<!-- END WORKTREES -->/gm,
                    /<!-- (?:BEGIN|END) WORKTREES[^\n]*-->/g
                ];
                let firstWtIndex = -1;
                for (const regex of wtRegexes) {
                    regex.lastIndex = 0;
                    const match = regex.exec(newContent);
                    if (match && (firstWtIndex === -1 || match.index < firstWtIndex)) {
                        firstWtIndex = match.index;
                    }
                }
                if (firstWtIndex !== -1) {
                    const wtBefore = newContent.slice(0, firstWtIndex);
                    let wtAfter = newContent.slice(firstWtIndex);
                    for (const regex of wtRegexes) {
                        wtAfter = wtAfter.replace(regex, '');
                    }
                    newContent = (wtBefore + '\n\n' + worktreeSection + '\n\n' + wtAfter).replace(/\n{3,}/g, '\n\n');
                } else {
                    newContent = newContent.replace(/\n*$/, '') + '\n\n' + worktreeSection + '\n';
                }
            }

            const featureMaxScore = subtasks.reduce((m, s) => Math.max(m, parseComplexityScore(s.complexity || '')), 0);
            if (featureMaxScore >= 1) {
                const complexityLine = `**Complexity:** ${featureMaxScore}`;
                const complexityRe = /^[ \t>*\-]*\*\*Complexity:\*\*[^\n]*$/im;
                newContent = complexityRe.test(newContent)
                    ? newContent.replace(complexityRe, complexityLine)
                    : newContent.replace(/(^# [^\n]*\n)/m, `$1\n${complexityLine}\n`);
            }

            // Bodyless-husk guard (mirrors KanbanProvider._regenerateFeatureFile): never
            // (re)create a feature file whose only content is the auto-generated blocks.
            // Regenerate is an UPDATE — a real feature is always authored with a `# Title`
            // before this runs. An empty meaningful body means the DB row outlived its file
            // (e.g. an agent rm'd the .md without deleting the row); writing now emits a
            // titleless "(no subtasks)" stub that shows on the board as a ghost feature.
            const meaningfulBody = newContent
                .replace(/<!-- BEGIN SUBTASKS[\s\S]*?<!-- END SUBTASKS -->/g, '')
                .replace(/<!-- BEGIN WORKTREES[\s\S]*?<!-- END WORKTREES -->/g, '')
                .replace(/^[ \t>*\-]*\*\*Complexity:\*\*[^\n]*$/im, '')
                .trim();
            if (!meaningfulBody) {
                console.warn(`[headless] regenerateFeatureFile: refusing to write bodyless feature file for ${featureId} (${feature.planFile}) — DB row has no authored file content (file likely deleted without removing the row). Skipping to avoid creating an empty husk.`);
                return;
            }

            if (newContent === existingContent) {
                return;
            }
            PlanIngestionEngine.registerPendingCreation(featureAbsPath);
            await fs.promises.writeFile(featureAbsPath, newContent, 'utf8');
        } catch (err) {
            console.warn(`[headless] regenerateFeatureFile failed for ${featureId}:`, err);
        }
    };
}
