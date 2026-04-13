import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import {
    type ClickUpConfig,
    ClickUpSyncService,
    type ClickUpWriteBackFormat,
    type ClickUpWriteBackTarget
} from './ClickUpSyncService';
import { KanbanDatabase } from './KanbanDatabase';
import {
    type ClickUpAutomationRule,
    matchesClickUpAutomationRule
} from '../models/PipelineDefinition';

const DEFAULT_WRITEBACK_TARGET: ClickUpWriteBackTarget = 'description';
const DEFAULT_WRITEBACK_FORMAT: ClickUpWriteBackFormat = 'append';

type ClickUpAutomationTaskSummary = {
    id: string;
    name: string;
    description: string;
    url: string;
    listId: string;
    listName: string;
    tags: string[];
    status: string;
};

export interface ClickUpAutomationPollResult {
    created: number;
    skipped: number;
    writeBacks: number;
    errors: string[];
}

export class ClickUpAutomationService {
    constructor(
        private readonly _workspaceRoot: string,
        private readonly _clickUpService: ClickUpSyncService,
        private readonly _resolvePlansDir: () => Promise<string>
    ) { }

    private async _resolveWorkspaceId(db: KanbanDatabase): Promise<string> {
        let workspaceId = await db.getWorkspaceId() || await db.getDominantWorkspaceId();
        if (workspaceId) {
            return workspaceId;
        }

        workspaceId = crypto.createHash('sha256')
            .update(path.resolve(this._workspaceRoot))
            .digest('hex')
            .slice(0, 12);
        await db.setWorkspaceId(workspaceId);
        return workspaceId;
    }

    private _taskHasSwitchboardOwnership(task: any): boolean {
        return (task.tags || []).some((tag: any) =>
            String(tag?.name || '').trim().toLowerCase().startsWith('switchboard:')
        );
    }

    private _getRules(config: ClickUpConfig): ClickUpAutomationRule[] {
        return config.automationRules.filter((rule) => rule.enabled !== false);
    }

    private _getWatchedListIds(config: ClickUpConfig): string[] {
        const rules = this._getRules(config);
        const explicitListIds = rules
            .flatMap((rule) => rule.triggerLists)
            .map((listId) => String(listId || '').trim())
            .filter(Boolean);
        const mappedListIds = Object.values(config.columnMappings)
            .map((listId) => String(listId || '').trim())
            .filter(Boolean);
        const hasUnscopedRule = rules.some((rule) => rule.triggerLists.length === 0);

        if (hasUnscopedRule) {
            return Array.from(new Set([...explicitListIds, ...mappedListIds]));
        }

        if (explicitListIds.length > 0) {
            return Array.from(new Set(explicitListIds));
        }

        return Array.from(new Set(mappedListIds));
    }

    private _normalizePath(filePath: string): string {
        return filePath.replace(/\\/g, '/');
    }

    private _slugify(value: string, fallback: string): string {
        const normalized = String(value || '')
            .trim()
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, '-')
            .replace(/^-+|-+$/g, '');
        return normalized || fallback;
    }

    private _normalizeWhitespace(value: string): string {
        return String(value || '').replace(/\s+/g, ' ').trim();
    }

    private _truncate(value: string, maxLength: number): string {
        const normalized = this._normalizeWhitespace(value);
        if (normalized.length <= maxLength) {
            return normalized;
        }
        return `${normalized.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
    }

    private _buildStableAutomationId(clickupTaskId: string): string {
        const taskSlug = this._slugify(clickupTaskId, 'task');
        const stableHash = crypto.createHash('sha256')
            .update(`clickup-automation:${clickupTaskId}`)
            .digest('hex')
            .slice(0, 8);
        return `clickup_automation_${taskSlug}_${stableHash}`;
    }

    private _escapeRegExp(value: string): string {
        return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }

    private _extractPlanMetadata(planContent: string, label: string): string {
        const match = new RegExp(
            `^(?:>\\s*)?\\*\\*${this._escapeRegExp(label)}:\\*\\*\\s*(.+?)\\s*$`,
            'im'
        ).exec(String(planContent || ''));
        return match ? String(match[1] || '').trim() : '';
    }

    private async _fileExists(filePath: string): Promise<boolean> {
        try {
            await fs.promises.access(filePath);
            return true;
        } catch {
            return false;
        }
    }

    private async _readPlanContent(planFile: string): Promise<string> {
        const resolvedPlanFile = path.isAbsolute(planFile)
            ? planFile
            : path.join(this._workspaceRoot, planFile);
        return fs.promises.readFile(resolvedPlanFile, 'utf8');
    }

    private _buildGoal(task: ClickUpAutomationTaskSummary): string {
        return task.description
            ? task.description
            : `Complete the work requested in ClickUp task ${task.id}.`;
    }

    private _buildProposedChanges(task: ClickUpAutomationTaskSummary): string {
        const summary = task.description
            ? this._truncate(task.description, 180)
            : `Complete the work requested in ClickUp task ${task.id}.`;
        return [
            '- Review the ClickUp task context and confirm the requested outcome.',
            `- Implement the requested work: ${summary}`,
            '- Capture the resulting changes in this plan so the final result can be written back to ClickUp.'
        ].join('\n');
    }

    private _buildPlanContent(
        task: ClickUpAutomationTaskSummary,
        rule: ClickUpAutomationRule,
        planId: string,
        sessionId: string
    ): string {
        const metadataLines = [
            `> Imported from ClickUp task \`${task.id}\``,
            `> **ClickUp Task ID:** ${task.id}`,
            `> **Plan ID:** ${planId}`,
            `> **Session ID:** ${sessionId}`,
            `> **Automation Rule:** ${rule.name}`,
            task.url ? `> **URL:** ${task.url}` : '',
            task.listName ? `> **List:** ${task.listName}` : '',
            task.status ? `> **ClickUp Status:** ${task.status}` : '',
            task.tags.length > 0 ? `> **Tags:** ${task.tags.join(', ')}` : ''
        ].filter(Boolean);

        const notesLines = [
            '## ClickUp Task Notes',
            '',
            `**Start Column:** ${rule.targetColumn}`,
            `**Final Column:** ${rule.finalColumn}`,
            `**Write Back on Complete:** ${rule.writeBackOnComplete ? 'yes' : 'no'}`,
            task.url ? `**Task URL:** ${task.url}` : '',
            task.status ? `**Current ClickUp Status:** ${task.status}` : '',
            task.tags.length > 0 ? `**Tags:** ${task.tags.join(', ')}` : ''
        ].filter(Boolean);

        return [
            `# ${task.name || `ClickUp Task ${task.id}`}`,
            '',
            ...metadataLines,
            '',
            '## Metadata',
            '',
            `**Tags:** ${task.tags.join(', ') || 'clickup'}`,
            '**Complexity:** Unknown',
            '',
            '## Goal',
            '',
            this._buildGoal(task),
            '',
            '## Proposed Changes',
            '',
            this._buildProposedChanges(task),
            '',
            ...notesLines,
            '',
            '## Switchboard State',
            '',
            `**Kanban Column:** ${rule.targetColumn}`,
            '**Status:** active'
        ].join('\n');
    }

    private _resolveStoredRule(
        planContent: string,
        activeRules: ClickUpAutomationRule[]
    ): { rule: ClickUpAutomationRule | null; storedRuleName: string } {
        const storedRuleName = this._extractPlanMetadata(planContent, 'Automation Rule');
        if (!storedRuleName) {
            return { rule: null, storedRuleName: '' };
        }

        const normalizedStoredRuleName = storedRuleName.toLowerCase();
        const rule = activeRules.find(
            (entry) => entry.name.trim().toLowerCase() === normalizedStoredRuleName
        ) || null;
        return { rule, storedRuleName };
    }

    private _buildWriteBackSummary(planContent: string, planSessionId: string, ruleName: string): string {
        return [
            '## Switchboard Automation Result',
            '',
            `**Automation Rule:** ${ruleName}`,
            `**Session ID:** ${planSessionId}`,
            '',
            planContent.trim().slice(0, 20000)
        ].join('\n');
    }

    public async poll(): Promise<ClickUpAutomationPollResult> {
        const result: ClickUpAutomationPollResult = {
            created: 0,
            skipped: 0,
            writeBacks: 0,
            errors: []
        };

        const config = await this._clickUpService.loadConfig();
        if (!config?.setupComplete) {
            return result;
        }

        const activeRules = this._getRules(config);
        if (activeRules.length === 0) {
            return result;
        }

        const db = KanbanDatabase.forWorkspace(this._workspaceRoot);
        if (!(await db.ensureReady())) {
            result.errors.push('Kanban database unavailable for ClickUp automation polling.');
            return result;
        }

        const workspaceId = await this._resolveWorkspaceId(db);
        const plansDir = await this._resolvePlansDir();
        await fs.promises.mkdir(plansDir, { recursive: true });

        const availableLists = await this._clickUpService.listFolderLists(config.folderId).catch((error) => {
            result.errors.push(`Failed to fetch ClickUp lists: ${error instanceof Error ? error.message : String(error)}`);
            return [];
        });
        const listNameById = new Map(availableLists.map((list) => [list.id, list.name]));

        for (const listId of this._getWatchedListIds(config)) {
            let tasks: any[] = [];
            try {
                tasks = await this._clickUpService.listTasksFromClickUp(listId);
            } catch (error) {
                result.errors.push(`Failed to poll ClickUp list ${listId}: ${error instanceof Error ? error.message : String(error)}`);
                continue;
            }

            for (const task of tasks) {
                if (this._taskHasSwitchboardOwnership(task)) {
                    result.skipped++;
                    continue;
                }

                const normalizedTaskId = String(task.id || '').trim();
                if (!normalizedTaskId) {
                    result.skipped++;
                    continue;
                }

                const matchedRules = activeRules.filter((rule) => matchesClickUpAutomationRule(task, listId, rule));
                if (matchedRules.length === 0) {
                    result.skipped++;
                    continue;
                }

                if (matchedRules.length > 1) {
                    console.warn(
                        `[ClickUpAutomation] Multiple rules matched task ${normalizedTaskId}; using '${matchedRules[0].name}'.`
                    );
                }

                const matchedRule = matchedRules[0];
                const existingPlan = await db.findPlanByClickUpTaskId(workspaceId, normalizedTaskId);
                if (existingPlan) {
                    result.skipped++;
                    continue;
                }

                const stableAutomationId = this._buildStableAutomationId(normalizedTaskId);
                const planFile = this._normalizePath(path.join(plansDir, `${stableAutomationId}.md`));
                if (await this._fileExists(planFile)) {
                    result.skipped++;
                    continue;
                }

                const taskSummary: ClickUpAutomationTaskSummary = {
                    id: normalizedTaskId,
                    name: String(task.name || `ClickUp Task ${normalizedTaskId}`).trim(),
                    description: this._normalizeWhitespace(String(task.markdown_description || task.description || '')),
                    url: String(task.url || '').trim(),
                    listId,
                    listName: listNameById.get(listId) || String(task.list?.name || '').trim() || listId,
                    tags: Array.isArray(task.tags)
                        ? task.tags.map((tag: any) => String(tag?.name || '').trim()).filter(Boolean)
                        : [],
                    status: String(task.status?.status || '').trim()
                };

                try {
                    await fs.promises.writeFile(
                        planFile,
                        this._buildPlanContent(taskSummary, matchedRule, stableAutomationId, stableAutomationId),
                        { encoding: 'utf8', flag: 'wx' }
                    );
                    result.created++;
                } catch (error) {
                    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
                        result.skipped++;
                        continue;
                    }
                    result.errors.push(`Failed to create ClickUp automation plan for task ${normalizedTaskId}: ${error instanceof Error ? error.message : String(error)}`);
                }
            }
        }

        const pendingWriteBacks = (await db.getAllPlans(workspaceId)).filter((plan) =>
            plan.sourceType === 'clickup-automation'
            && !!plan.clickupTaskId
            && plan.status !== 'deleted'
            && plan.lastAction !== 'clickup_writeback_complete'
        );

        for (const plan of pendingWriteBacks) {
            if (!plan.clickupTaskId) {
                continue;
            }

            try {
                const planContent = await this._readPlanContent(plan.planFile);
                const { rule, storedRuleName } = this._resolveStoredRule(planContent, activeRules);
                if (!rule) {
                    result.errors.push(`Missing ClickUp automation rule '${storedRuleName || 'unknown'}' for task ${plan.clickupTaskId}.`);
                    continue;
                }

                if (rule.writeBackOnComplete !== true) {
                    continue;
                }

                if (String(plan.kanbanColumn || '').trim().toUpperCase() !== String(rule.finalColumn || '').trim().toUpperCase()) {
                    continue;
                }

                await this._clickUpService.writeBackAutomationResult(
                    plan.clickupTaskId,
                    this._buildWriteBackSummary(planContent, plan.sessionId, rule.name),
                    DEFAULT_WRITEBACK_TARGET,
                    DEFAULT_WRITEBACK_FORMAT
                );
                await db.updateLastAction(plan.sessionId, 'clickup_writeback_complete');
                result.writeBacks++;
            } catch (error) {
                result.errors.push(`Failed to write ClickUp automation result for ${plan.clickupTaskId}: ${error instanceof Error ? error.message : String(error)}`);
            }
        }

        return result;
    }
}
