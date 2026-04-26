import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { KanbanDatabase } from './KanbanDatabase';
import { buildLinearIssueFilter, LinearSyncService, type LinearConfig } from './LinearSyncService';
import {
    type LinearAutomationRule,
    matchesLinearAutomationRule
} from '../models/PipelineDefinition';

const DEFAULT_WRITEBACK_TARGET: 'description' | 'comment' = 'description';

type LinearAutomationIssueSummary = {
    id: string;
    identifier: string;
    title: string;
    description: string;
    url: string;
    labels: string[];
    stateId: string;
    stateName: string;
    stateType: string;
};

type LinearAutomationWriteBackTarget = 'description' | 'comment';

export interface LinearAutomationPollResult {
    created: number;
    skipped: number;
    writeBacks: number;
    errors: string[];
}

export class LinearAutomationService {
    constructor(
        private readonly _workspaceRoot: string,
        private readonly _linearService: LinearSyncService,
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

    private _issueHasSwitchboardOwnership(issue: any): boolean {
        const labelNames = Array.isArray(issue?.labels?.nodes)
            ? issue.labels.nodes
                .map((label: any) => String(label?.name || '').trim().toLowerCase())
                .filter(Boolean)
            : [];
        return labelNames.some((labelName: string) => labelName === 'switchboard' || labelName.startsWith('switchboard:'));
    }

    private _applyProjectNameFilters(issues: any[], config: LinearConfig): any[] {
        const includeNames = (config.includeProjectNames || []).map(n => n.toLowerCase());
        const excludeNames = (config.excludeProjectNames || []).map(n => n.toLowerCase());
        if (includeNames.length === 0 && excludeNames.length === 0) {
            return issues;
        }
        return issues.filter((issue) => {
            const projectName = String(issue?.project?.name || '').trim().toLowerCase();
            if (!projectName) {
                return includeNames.length === 0;
            }
            if (excludeNames.length > 0 && excludeNames.includes(projectName)) {
                return false;
            }
            if (includeNames.length > 0 && !includeNames.includes(projectName)) {
                return false;
            }
            return true;
        });
    }

    private _getRules(config: LinearConfig): LinearAutomationRule[] {
        return config.automationRules.filter((rule) => rule.enabled !== false);
    }

    private _getWatchedStateIds(config: LinearConfig): string[] {
        return Array.from(new Set(
            this._getRules(config)
                .flatMap((rule) => rule.triggerStates)
                .map((stateId) => String(stateId || '').trim())
                .filter(Boolean)
        ));
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

    private _buildStableAutomationId(issueId: string, issueIdentifier?: string): string {
        const issueSlug = this._slugify(issueIdentifier || issueId, 'issue');
        const stableHash = crypto.createHash('sha256')
            .update(`linear-automation:${issueId}`)
            .digest('hex')
            .slice(0, 8);
        return `linear_automation_${issueSlug}_${stableHash}`;
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

    private _buildGoal(issue: LinearAutomationIssueSummary): string {
        return issue.description
            ? issue.description
            : `Complete the work requested in Linear issue ${issue.identifier || issue.id}.`;
    }

    private _buildProposedChanges(issue: LinearAutomationIssueSummary): string {
        const summary = issue.description
            ? this._truncate(issue.description, 180)
            : `Complete the work requested in Linear issue ${issue.identifier || issue.id}.`;
        return [
            '- Review the Linear issue context and confirm the requested outcome.',
            `- Implement the requested work: ${summary}`,
            '- Capture the resulting changes in this plan so the final result can be written back to Linear.'
        ].join('\n');
    }

    private _buildPlanContent(
        issue: LinearAutomationIssueSummary,
        rule: LinearAutomationRule,
        planId: string,
        sessionId: string
    ): string {
        const reference = issue.identifier || issue.id;
        const metadataLines = [
            `> Imported from Linear issue \`${reference}\``,
            `> **Linear Issue ID:** ${issue.id}`,
            `> **Plan ID:** ${planId}`,
            `> **Session ID:** ${sessionId}`,
            `> **Automation Rule:** ${rule.name}`,
            issue.url ? `> **URL:** ${issue.url}` : '',
            issue.stateName ? `> **State:** ${issue.stateName}` : '',
            issue.labels.length > 0 ? `> **Labels:** ${issue.labels.join(', ')}` : ''
        ].filter(Boolean);

        const notesLines = [
            '## Linear Issue Notes',
            '',
            `**Start Column:** ${rule.targetColumn}`,
            `**Final Column:** ${rule.finalColumn}`,
            `**Write Back on Complete:** ${rule.writeBackOnComplete ? 'yes' : 'no'}`,
            issue.identifier ? `**Linear Identifier:** ${issue.identifier}` : '',
            issue.url ? `**Issue URL:** ${issue.url}` : '',
            issue.stateName ? `**Current Linear State:** ${issue.stateName}${issue.stateType ? ` (${issue.stateType})` : ''}` : '',
            issue.labels.length > 0 ? `**Labels:** ${issue.labels.join(', ')}` : ''
        ].filter(Boolean);

        return [
            `# ${issue.title || `Linear Issue ${reference}`}`,
            '',
            ...metadataLines,
            '',
            '## Metadata',
            '',
            `**Tags:** ${issue.labels.join(', ') || 'linear'}`,
            '**Complexity:** Unknown',
            '',
            '## Goal',
            '',
            this._buildGoal(issue),
            '',
            '## Proposed Changes',
            '',
            this._buildProposedChanges(issue),
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
        activeRules: LinearAutomationRule[]
    ): { rule: LinearAutomationRule | null; storedRuleName: string } {
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

    public async writeBackAutomationResult(
        issueId: string,
        summary: string,
        target: LinearAutomationWriteBackTarget = DEFAULT_WRITEBACK_TARGET
    ): Promise<void> {
        const normalizedIssueId = String(issueId || '').trim();
        const normalizedSummary = String(summary || '').trim();
        if (!normalizedIssueId) {
            throw new Error('Linear write-back requires a non-empty issue ID.');
        }
        if (!normalizedSummary) {
            throw new Error('Linear write-back requires a non-empty summary.');
        }

        if (target === 'comment') {
            const result = await this._linearService.graphqlRequest(`
                mutation($issueId: String!, $body: String!) {
                    commentCreate(input: { issueId: $issueId, body: $body }) {
                        success
                    }
                }
            `, {
                issueId: normalizedIssueId,
                body: normalizedSummary
            });

            if (!result.data?.commentCreate?.success) {
                throw new Error(`Linear comment write-back failed for issue ${normalizedIssueId}.`);
            }
            return;
        }

        const issueResult = await this._linearService.graphqlRequest(`
            query($issueId: String!) {
                issue(id: $issueId) {
                    id
                    description
                }
            }
        `, { issueId: normalizedIssueId });
        const existingIssue = issueResult.data?.issue;
        if (!existingIssue?.id) {
            throw new Error(`Linear issue ${normalizedIssueId} was not found for write-back.`);
        }

        const currentDescription = String(existingIssue.description || '').trim();
        const nextDescription = currentDescription
            ? `${currentDescription}\n\n${normalizedSummary}`
            : normalizedSummary;
        const updateResult = await this._linearService.graphqlRequest(`
            mutation($issueId: String!, $description: String!) {
                issueUpdate(id: $issueId, input: { description: $description }) {
                    success
                }
            }
        `, {
            issueId: normalizedIssueId,
            description: nextDescription
        });

        if (!updateResult.data?.issueUpdate?.success) {
            throw new Error(`Linear description write-back failed for issue ${normalizedIssueId}.`);
        }
    }

    public async poll(): Promise<LinearAutomationPollResult> {
        const result: LinearAutomationPollResult = {
            created: 0,
            skipped: 0,
            writeBacks: 0,
            errors: []
        };

        const config = await this._linearService.loadConfig();
        if (!config?.setupComplete) {
            return result;
        }

        const activeRules = this._getRules(config);
        if (activeRules.length === 0) {
            return result;
        }

        const db = KanbanDatabase.forWorkspace(this._workspaceRoot);
        // Force a fresh on-disk view before dedupe so outbound syncs from another
        // instance are visible immediately during automation polling.
        if (!(await db.refreshFromDisk())) {
            result.errors.push('Kanban database unavailable for Linear automation polling.');
            return result;
        }

        const workspaceId = await this._resolveWorkspaceId(db);
        const plansDir = await this._resolvePlansDir();
        await fs.promises.mkdir(plansDir, { recursive: true });

        const watchedStateIds = new Set(this._getWatchedStateIds(config));
        const resolvedProjectId = await this._linearService.resolveSingleIncludeProjectId(config);
        const filter = buildLinearIssueFilter(config.teamId, resolvedProjectId || undefined);
        const query = `
            query($filter: IssueFilter!, $after: String) {
                issues(
                    filter: $filter
                    after: $after
                    first: 50
                ) {
                    nodes {
                        id
                        identifier
                        title
                        description
                        url
                        parent { id }
                        state { id name type }
                        labels { nodes { id name } }
                        project { name }
                    }
                    pageInfo { hasNextPage endCursor }
                }
            }
        `;

        let cursor: string | null = null;
        while (true) {
            let page: any;
            try {
                const pageResult = await this._linearService.graphqlRequest(query, {
                    filter,
                    after: cursor
                });
                page = pageResult.data?.issues;
            } catch (error) {
                result.errors.push(`Failed to poll Linear issues: ${error instanceof Error ? error.message : String(error)}`);
                break;
            }

            const issues = Array.isArray(page?.nodes) ? page.nodes : [];

            // Apply client-side project name filters if needed
            const filteredIssues = this._applyProjectNameFilters(issues, config);
            for (const issue of filteredIssues) {
                if (issue?.parent?.id) {
                    result.skipped++;
                    continue;
                }

                if (this._issueHasSwitchboardOwnership(issue)) {
                    console.log(`[LinearAutomation] Skipping issue ${issue.id} (${issue.identifier}) - has switchboard label`);
                    result.skipped++;
                    continue;
                }

                const normalizedIssueId = String(issue?.id || '').trim();
                if (!normalizedIssueId) {
                    result.skipped++;
                    continue;
                }

                const stateId = String(issue?.state?.id || '').trim();
                const stateType = String(issue?.state?.type || '').trim().toLowerCase();
                // Always filter out completed/cancelled/archived issues
                if (!stateId || stateType === 'completed' || stateType === 'cancelled' || stateType === 'canceled' || stateType === 'archived') {
                    result.skipped++;
                    continue;
                }

                // Filter out backlog if configured (default: true)
                if (config.excludeBacklog !== false && stateType === 'backlog') {
                    result.skipped++;
                    continue;
                }

                if (watchedStateIds.size > 0 && !watchedStateIds.has(stateId)) {
                    result.skipped++;
                    continue;
                }

                const matchedRules = activeRules.filter((rule) => matchesLinearAutomationRule(issue, rule));
                if (matchedRules.length === 0) {
                    result.skipped++;
                    continue;
                }

                if (matchedRules.length > 1) {
                    console.warn(
                        `[LinearAutomation] Multiple rules matched issue ${normalizedIssueId}; using '${matchedRules[0].name}'.`
                    );
                }

                const matchedRule = matchedRules[0];
                const existingPlan = await db.findPlanByLinearIssueId(workspaceId, normalizedIssueId);
                if (existingPlan) {
                    console.log(`[LinearAutomation] Skipping issue ${issue.id} (${issue.identifier}) - plan already exists: ${existingPlan.planFile}`);
                    result.skipped++;
                    continue;
                }

                const stableAutomationId = this._buildStableAutomationId(normalizedIssueId, String(issue?.identifier || ''));
                const planFile = this._normalizePath(path.join(plansDir, `${stableAutomationId}.md`));
                if (await this._fileExists(planFile)) {
                    console.log(`[LinearAutomation] Skipping issue ${issue.id} (${issue.identifier}) - plan file already exists: ${planFile}`);
                    result.skipped++;
                    continue;
                }

                const issueSummary: LinearAutomationIssueSummary = {
                    id: normalizedIssueId,
                    identifier: String(issue?.identifier || '').trim(),
                    title: String(issue?.title || `Linear Issue ${normalizedIssueId}`).trim(),
                    description: this._normalizeWhitespace(String(issue?.description || '')),
                    url: String(issue?.url || '').trim(),
                    labels: Array.isArray(issue?.labels?.nodes)
                        ? issue.labels.nodes.map((label: any) => String(label?.name || '').trim()).filter(Boolean)
                        : [],
                    stateId,
                    stateName: String(issue?.state?.name || '').trim(),
                    stateType
                };

                try {
                    await fs.promises.writeFile(
                        planFile,
                        this._buildPlanContent(issueSummary, matchedRule, stableAutomationId, stableAutomationId),
                        { encoding: 'utf8', flag: 'wx' }
                    );
                    console.log(`[LinearAutomation] Created plan ${planFile} for Linear issue ${issue.identifier} (${normalizedIssueId})`);
                    result.created++;
                } catch (error) {
                    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
                        console.log(`[LinearAutomation] Plan file already exists (race): ${planFile}`);
                        result.skipped++;
                        continue;
                    }
                    console.error(`[LinearAutomation] Failed to create plan for issue ${normalizedIssueId}:`, error);
                    result.errors.push(`Failed to create Linear automation plan for issue ${normalizedIssueId}: ${error instanceof Error ? error.message : String(error)}`);
                }
            }

            if (!page?.pageInfo?.hasNextPage) {
                break;
            }
            cursor = String(page.pageInfo.endCursor || '');
            await this._linearService.delay(200);
        }

        const pendingWriteBacks = (await db.getAllPlans(workspaceId)).filter((plan) =>
            plan.sourceType === 'linear-automation'
            && !!plan.linearIssueId
            && plan.status !== 'deleted'
            && plan.lastAction !== 'linear_writeback_complete'
        );

        for (const plan of pendingWriteBacks) {
            if (!plan.linearIssueId) {
                continue;
            }

            try {
                const planContent = await this._readPlanContent(plan.planFile);
                const { rule, storedRuleName } = this._resolveStoredRule(planContent, activeRules);
                if (!rule) {
                    result.errors.push(`Missing Linear automation rule '${storedRuleName || 'unknown'}' for issue ${plan.linearIssueId}.`);
                    continue;
                }

                if (rule.writeBackOnComplete !== true) {
                    continue;
                }

                if (String(plan.kanbanColumn || '').trim().toUpperCase() !== String(rule.finalColumn || '').trim().toUpperCase()) {
                    continue;
                }

                await this.writeBackAutomationResult(
                    plan.linearIssueId,
                    this._buildWriteBackSummary(planContent, plan.sessionId, rule.name),
                    DEFAULT_WRITEBACK_TARGET
                );
                await db.updateLastAction(plan.sessionId, 'linear_writeback_complete');
                result.writeBacks++;
            } catch (error) {
                result.errors.push(`Failed to write Linear automation result for ${plan.linearIssueId}: ${error instanceof Error ? error.message : String(error)}`);
            }
        }

        return result;
    }
}
