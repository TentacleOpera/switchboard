import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as https from 'https';
import { CANONICAL_COLUMNS } from './ClickUpSyncService';
import type { AutoPullIntervalMinutes } from './IntegrationAutoPullService';
import {
  type LinearAutomationRule,
  normalizeLinearAutomationRules
} from '../models/PipelineDefinition';

export interface LinearConfig {
  teamId: string;
  teamName: string;
  projectId?: string;
  columnToStateId: Record<string, string>;
  switchboardLabelId: string;
  setupComplete: boolean;
  lastSync: string | null;
  realTimeSyncEnabled: boolean;
  autoPullEnabled: boolean;
  pullIntervalMinutes: AutoPullIntervalMinutes;
  automationRules: LinearAutomationRule[];
}

export interface LinearApplyOptions {
  mapColumns: boolean;
  createLabel: boolean;
  scopeProject: boolean;
  enableRealtimeSync: boolean;
  enableAutoPull: boolean;
}

export { CANONICAL_COLUMNS };

const LINEAR_API_HOST = 'api.linear.app';
const LINEAR_API_PATH = '/graphql';

export class LinearSyncService {
  private _workspaceRoot: string;
  private _configPath: string;
  private _syncMapPath: string;
  private _config: LinearConfig | null = null;
  private _secretStorage: vscode.SecretStorage;
  private _setupInProgress = false;
  private _isSyncInProgress = false;
  private _consecutiveFailures = 0;
  private _debounceTimers: Map<string, NodeJS.Timeout> = new Map();
  private readonly _maxRetries = 3;

  constructor(workspaceRoot: string, secretStorage: vscode.SecretStorage) {
    this._workspaceRoot = workspaceRoot;
    this._configPath = path.join(workspaceRoot, '.switchboard', 'linear-config.json');
    this._syncMapPath = path.join(workspaceRoot, '.switchboard', 'linear-sync.json');
    this._secretStorage = secretStorage;
  }

  // ── Config I/O ───────────────────────────────────────────────

  private _createEmptyConfig(): LinearConfig {
    return {
      teamId: '',
      teamName: '',
      projectId: undefined,
      columnToStateId: {},
      switchboardLabelId: '',
      setupComplete: false,
      lastSync: null,
      realTimeSyncEnabled: false,
      autoPullEnabled: false,
      pullIntervalMinutes: 60,
      automationRules: []
    };
  }

  private _normalizeConfig(raw: Partial<LinearConfig> | null): LinearConfig | null {
    if (!raw) {
      return null;
    }

    const interval = raw.pullIntervalMinutes;
    const normalizedInterval: AutoPullIntervalMinutes =
      interval === 5 || interval === 15 || interval === 30 || interval === 60 ? interval : 60;

    return {
      teamId: raw.teamId || '',
      teamName: raw.teamName || '',
      projectId: raw.projectId || undefined,
      columnToStateId: raw.columnToStateId || {},
      switchboardLabelId: raw.switchboardLabelId || '',
      setupComplete: raw.setupComplete === true,
      lastSync: raw.lastSync || null,
      realTimeSyncEnabled: raw.realTimeSyncEnabled === undefined
        ? raw.setupComplete === true
        : raw.realTimeSyncEnabled === true,
      autoPullEnabled: raw.autoPullEnabled === true,
      pullIntervalMinutes: normalizedInterval,
      automationRules: normalizeLinearAutomationRules(raw.automationRules)
    };
  }

  async loadConfig(): Promise<LinearConfig | null> {
    try {
      const content = await fs.promises.readFile(this._configPath, 'utf8');
      const normalized = this._normalizeConfig(JSON.parse(content));
      this._config = normalized;
      return normalized;
    } catch { return null; }
  }

  async saveConfig(config: LinearConfig): Promise<void> {
    const normalized = this._normalizeConfig(config);
    if (!normalized) {
      throw new Error('Linear config normalization failed');
    }
    await fs.promises.mkdir(path.dirname(this._configPath), { recursive: true });
    await fs.promises.writeFile(this._configPath, JSON.stringify(normalized, null, 2));
    this._config = normalized;
  }

  async saveAutomationSettings(
    automationRules: LinearAutomationRule[]
  ): Promise<void> {
    const config = await this.loadConfig();
    if (!config?.setupComplete) {
      throw new Error('Linear must be set up before saving automation settings.');
    }

    await this.saveConfig({
      ...config,
      automationRules: normalizeLinearAutomationRules(automationRules)
    });
  }

  async getAutomationCatalog(): Promise<{
    labels: Array<{ id: string; name: string }>;
    states: Array<{ id: string; name: string; type: string }>;
  }> {
    const config = await this.loadConfig();
    if (!config?.setupComplete || !config.teamId) {
      throw new Error('Linear must be set up before loading automation labels and states.');
    }

    const result = await this.graphqlRequest(`
      query($teamId: String!) {
        team(id: $teamId) {
          states { nodes { id name type } }
          labels { nodes { id name } }
        }
      }
    `, { teamId: config.teamId });

    const team = result.data?.team;
    if (!team) {
      throw new Error('Failed to load Linear automation catalog.');
    }

    return {
      labels: Array.isArray(team.labels?.nodes)
        ? team.labels.nodes
            .map((label: any) => ({
              id: String(label?.id || '').trim(),
              name: String(label?.name || '').trim()
            }))
            .filter((label: { id: string; name: string }) => label.id && label.name)
        : [],
      states: Array.isArray(team.states?.nodes)
        ? team.states.nodes
            .map((state: any) => ({
              id: String(state?.id || '').trim(),
              name: String(state?.name || '').trim(),
              type: String(state?.type || '').trim()
            }))
            .filter((state: { id: string; name: string; type: string }) => state.id && state.name)
        : []
    };
  }

  // ── Local Sync Map (sessionId → Linear issueId) ──────────────

  async loadSyncMap(): Promise<Record<string, string>> {
    try {
      const content = await fs.promises.readFile(this._syncMapPath, 'utf8');
      return JSON.parse(content);
    } catch { return {}; }
  }

  async saveSyncMap(map: Record<string, string>): Promise<void> {
    await fs.promises.mkdir(path.dirname(this._syncMapPath), { recursive: true });
    await fs.promises.writeFile(this._syncMapPath, JSON.stringify(map, null, 2));
  }

  async getIssueIdForPlan(sessionId: string): Promise<string | null> {
    const map = await this.loadSyncMap();
    return map[sessionId] || null;
  }

  async setIssueIdForPlan(sessionId: string, issueId: string): Promise<void> {
    const map = await this.loadSyncMap();
    map[sessionId] = issueId;
    await this.saveSyncMap(map);
  }

  // ── Token Management ─────────────────────────────────────────

  async getApiToken(): Promise<string | null> {
    try {
      return await this._secretStorage.get('switchboard.linear.apiToken') || null;
    } catch { return null; }
  }

  // ── GraphQL Client ───────────────────────────────────────────

  /**
   * Authenticated GraphQL request to Linear API.
   * Linear always returns HTTP 200; errors are in response.errors.
   * Throws if HTTP status != 200 OR if response.errors is non-empty.
   */
  async graphqlRequest(
    query: string,
    variables?: Record<string, unknown>,
    timeoutMs = 10000
  ): Promise<{ data: any }> {
    const token = await this.getApiToken();
    if (!token) { throw new Error('Linear API token not configured'); }

    return new Promise((resolve, reject) => {
      const payload = JSON.stringify({ query, variables });
      const req = https.request({
        hostname: LINEAR_API_HOST,
        path: LINEAR_API_PATH,
        method: 'POST',
        headers: {
          'Authorization': token,
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload)
        },
        timeout: timeoutMs
      }, (res) => {
        let raw = '';
        res.on('data', (chunk: Buffer) => { raw += chunk.toString(); });
        res.on('end', () => {
          if (res.statusCode !== 200) {
            return reject(new Error(`Linear API HTTP ${res.statusCode}`));
          }
          try {
            const parsed = JSON.parse(raw);
            if (parsed.errors?.length) {
              return reject(new Error(`Linear GraphQL error: ${parsed.errors[0].message}`));
            }
            resolve({ data: parsed.data });
          } catch {
            reject(new Error('Failed to parse Linear API response'));
          }
        });
      });
      req.on('timeout', () => { req.destroy(); reject(new Error('Linear request timed out')); });
      req.on('error', reject);
      req.write(payload);
      req.end();
    });
  }

  // ── Availability Check ───────────────────────────────────────

  async isAvailable(): Promise<boolean> {
    try {
      const token = await this.getApiToken();
      if (!token) { return false; }
      await this.graphqlRequest('{ viewer { id } }', undefined, 2000);
      return true;
    } catch { return false; }
  }

  // ── Setup Flow ───────────────────────────────────────────────

  private async _promptForApiToken(): Promise<string | null> {
    const input = await vscode.window.showInputBox({
      prompt: 'Enter your Linear API token — find it at linear.app/settings/api',
      password: true,
      placeHolder: 'lin_api_...',
      ignoreFocusOut: true,
      validateInput: (value) => (!value || value.trim().length < 10) ? 'Token appears too short' : null
    });
    return input ? input.trim() : null;
  }

  private async _selectTeam(config: LinearConfig): Promise<{ id: string; label: string }> {
    if (config.teamId && config.teamName) {
      return { id: config.teamId, label: config.teamName };
    }

    const teamsResult = await this.graphqlRequest(`{
      teams { nodes { id name } }
    }`);
    const teams = Array.isArray(teamsResult.data?.teams?.nodes) ? teamsResult.data.teams.nodes : [];
    const teamItems: Array<vscode.QuickPickItem & { id: string }> =
      teams.map((team: any) => ({ label: String(team?.name || ''), id: String(team?.id || '') }))
        .filter((team: vscode.QuickPickItem & { id: string }) => Boolean(team.label) && Boolean(team.id));
    const selectedTeam = await vscode.window.showQuickPick(teamItems, { placeHolder: 'Select your Linear team' });
    if (!selectedTeam) {
      throw new Error('No Linear team selected.');
    }
    config.teamId = selectedTeam.id;
    config.teamName = selectedTeam.label;
    return { id: config.teamId, label: config.teamName };
  }

  private async _selectProjectScope(teamId: string): Promise<string | undefined> {
    const projectsResult = await this.graphqlRequest(`
      query($teamId: String!) { team(id: $teamId) { projects { nodes { id name } } } }
    `, { teamId });
    const projects = Array.isArray(projectsResult.data?.team?.projects?.nodes)
      ? projectsResult.data.team.projects.nodes
      : [];
    const projectOptions = [
      { label: '(All issues in team)', id: '' },
      ...projects.map((project: any) => ({
        label: String(project?.name || '').trim(),
        id: String(project?.id || '').trim()
      })).filter((project: { label: string; id: string }) => project.label.length > 0)
    ];
    const selectedProject = await vscode.window.showQuickPick(projectOptions, {
      placeHolder: 'Scope to a project? (optional)'
    });
    if (selectedProject === undefined) {
      throw new Error('No Linear project scope selected.');
    }
    return selectedProject.id || undefined;
  }

  private async _mapColumnsToStates(teamId: string): Promise<Record<string, string>> {
    const statesResult = await this.graphqlRequest(`
      query($teamId: String!) { team(id: $teamId) { states { nodes { id name type } } } }
    `, { teamId });
    const states = Array.isArray(statesResult.data?.team?.states?.nodes)
      ? statesResult.data.team.states.nodes
      : [];
    const stateOptions = [
      { label: '(skip — do not sync)', id: '' },
      ...states.map((state: any) => ({
        label: `${state.name} (${state.type})`,
        id: String(state.id)
      }))
    ];

    const columnToStateId: Record<string, string> = {};
    for (const column of CANONICAL_COLUMNS) {
      const selected = await vscode.window.showQuickPick(stateOptions, {
        placeHolder: `Map Switchboard column "${column}" to a Linear state`
      });
      if (selected === undefined) {
        throw new Error(`No Linear state selected for column "${column}".`);
      }
      if (selected.id) {
        columnToStateId[column] = selected.id;
      }
    }
    return columnToStateId;
  }

  private async _ensureSwitchboardLabel(teamId: string): Promise<string> {
    const labelsResult = await this.graphqlRequest(`
      query($teamId: String!) { team(id: $teamId) { labels { nodes { id name } } } }
    `, { teamId });
    const existingLabel = labelsResult.data?.team?.labels?.nodes?.find((label: any) => label.name === 'switchboard');
    if (existingLabel?.id) {
      return String(existingLabel.id);
    }

    const createResult = await this.graphqlRequest(`
      mutation($teamId: String!, $name: String!, $color: String!) {
        issueLabelCreate(input: { teamId: $teamId, name: $name, color: $color }) {
          issueLabel { id }
        }
      }
    `, { teamId, name: 'switchboard', color: '#6366f1' });
    const labelId = String(createResult.data?.issueLabelCreate?.issueLabel?.id || '').trim();
    if (!labelId) {
      throw new Error('Failed to create the Switchboard label in Linear.');
    }
    return labelId;
  }

  async applyConfig(options: LinearApplyOptions): Promise<{ success: boolean; error?: string }> {
    if (this._setupInProgress) {
      return { success: false, error: 'Setup already in progress' };
    }
    this._setupInProgress = true;

    const existingConfig = await this.loadConfig();
    const config = existingConfig
      ? { ...existingConfig, columnToStateId: { ...(existingConfig.columnToStateId || {}) } }
      : this._createEmptyConfig();

    try {
      let token = await this.getApiToken();
      if (!token) {
        token = await this._promptForApiToken();
        if (!token) {
          return { success: false, error: 'Setup cancelled — Linear API token required.' };
        }
        await this._secretStorage.store('switchboard.linear.apiToken', token);
      }

      if (!(await this.isAvailable())) {
        return { success: false, error: 'Linear token is invalid. Get a valid token at linear.app/settings/api' };
      }

      const needsTeamSelection = options.mapColumns || options.createLabel || options.scopeProject || options.enableRealtimeSync || options.enableAutoPull;
      const hasExistingSetup = !!config.teamId || !!config.switchboardLabelId || Object.keys(config.columnToStateId || {}).length > 0 || config.setupComplete;
      if (!hasExistingSetup && !needsTeamSelection) {
        return { success: false, error: 'Select at least one Linear option to apply.' };
      }

      if (needsTeamSelection && !config.teamId) {
        await this._selectTeam(config);
      }

      if (options.scopeProject) {
        config.projectId = await this._selectProjectScope(config.teamId);
      } else {
        config.projectId = undefined;
      }

      if (options.mapColumns) {
        config.columnToStateId = await this._mapColumnsToStates(config.teamId);
      }

      if (options.createLabel) {
        config.switchboardLabelId = await this._ensureSwitchboardLabel(config.teamId);
      }

      const hasMappedStates = Object.values(config.columnToStateId || {}).some(
        (stateId) => typeof stateId === 'string' && stateId.trim().length > 0
      );
      if (options.enableRealtimeSync) {
        if (!config.teamId) {
          throw new Error('Realtime sync requires a configured Linear team.');
        }
        if (!hasMappedStates) {
          throw new Error('Realtime sync requires at least one mapped Linear state.');
        }
      }

      if (options.enableAutoPull && !config.teamId) {
        throw new Error('Auto-pull requires a configured Linear team.');
      }

      config.realTimeSyncEnabled = options.enableRealtimeSync === true;
      config.autoPullEnabled = options.enableAutoPull === true;
      config.setupComplete = true;
      await this.saveConfig(config);
      return { success: true };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error)
      };
    } finally {
      this._setupInProgress = false;
    }
  }

  // ── Sync Methods (Part 3) ────────────────────────────────────

  private _complexityToPriority(complexity: string): number {
    const n = parseInt(complexity, 10);
    if (isNaN(n)) { return 0; }
    if (n >= 9) { return 1; }
    if (n >= 7) { return 2; }
    if (n >= 5) { return 3; }
    return 4;
  }

  async syncPlan(plan: { sessionId: string; topic: string; planFile: string; complexity: string }, newColumn: string): Promise<void> {
    const config = await this.loadConfig();
    if (!config?.setupComplete) { return; }

    const stateId = config.columnToStateId[newColumn];
    if (!stateId) { return; } // column not mapped

    const existingIssueId = await this.getIssueIdForPlan(plan.sessionId);
    const priority = this._complexityToPriority(plan.complexity);

    try {
      if (existingIssueId) {
        const result = await this.retry(() => this.graphqlRequest(`
          mutation($id: String!, $stateId: String!) {
            issueUpdate(id: $id, input: { stateId: $stateId }) { success }
          }
        `, { id: existingIssueId, stateId }));

        if (!result.data.issueUpdate.success) {
          await this._createIssue(plan, stateId, priority, config);
        }
      } else {
        await this._createIssue(plan, stateId, priority, config);
      }
    } catch (error) {
      console.warn(`[LinearSync] Failed to sync plan ${plan.sessionId}:`, error);
      throw error;
    }
  }

  /**
   * Sync plan markdown content to Linear issue description.
   * Used by ContinuousSyncService for live updates.
   * Does NOT change issue state or other fields.
   */
  async syncPlanContent(issueId: string, markdownContent: string): Promise<{ success: boolean; error?: string }> {
    try {
      const config = await this.loadConfig();
      if (!config?.setupComplete) {
        return { success: false, error: 'Linear not set up' };
      }

      // Use existing graphqlRequest helper (line 192) — handles token, timeouts, error formatting
      const mutation = `
        mutation UpdateIssueDescription($id: String!, $description: String!) {
          issueUpdate(id: $id, input: { description: $description }) {
            success
            issue { id }
          }
        }
      `;

      const result = await this.graphqlRequest(mutation, {
        id: issueId,
        description: markdownContent
      });

      if (result.data?.issueUpdate?.success) {
        return { success: true };
      } else {
        return { success: false, error: 'Linear issueUpdate returned success=false' };
      }
    } catch (error) {
      return { success: false, error: `Sync failed: ${error}` };
    }
  }

  private async _createIssue(
    plan: { sessionId: string; topic: string; planFile: string },
    stateId: string,
    priority: number,
    config: LinearConfig
  ): Promise<void> {
    const description = `Managed by Switchboard.\n\nPlan file: \`${plan.planFile}\`\n\nDo not edit the title — it is synced from Switchboard.`;
    const result = await this.retry(() => this.graphqlRequest(`
      mutation($input: IssueCreateInput!) {
        issueCreate(input: $input) { success issue { id identifier } }
      }
    `, {
      input: {
        teamId: config.teamId,
        title: plan.topic,
        stateId,
        priority,
        labelIds: config.switchboardLabelId ? [config.switchboardLabelId] : [],
        description,
        ...(config.projectId ? { projectId: config.projectId } : {})
      }
    }));

    if (result.data.issueCreate.success) {
      await this.setIssueIdForPlan(plan.sessionId, result.data.issueCreate.issue.id);
    }
  }

  // ── Debounced Sync ───────────────────────────────────────────

  debouncedSync(sessionId: string, plan: any, column: string): void {
    const existing = this._debounceTimers.get(sessionId);
    if (existing) { clearTimeout(existing); }
    this._debounceTimers.set(sessionId, setTimeout(async () => {
      this._debounceTimers.delete(sessionId);
      try {
        await this.syncPlan(plan, column);
        this._consecutiveFailures = 0;
      } catch {
        this._consecutiveFailures++;
      }
    }, 500));
  }

  // ── Utilities ────────────────────────────────────────────────

  get setupInProgress() { return this._setupInProgress; }
  set setupInProgress(v) { this._setupInProgress = v; }
  get isSyncInProgress() { return this._isSyncInProgress; }
  set isSyncInProgress(v) { this._isSyncInProgress = v; }
  get consecutiveFailures(): number { return this._consecutiveFailures; }
  set consecutiveFailures(v: number) { this._consecutiveFailures = v; }
  get debounceTimers() { return this._debounceTimers; }
  get configPath() { return this._configPath; }
  get workspaceRoot() { return this._workspaceRoot; }

  delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  chunkArray<T>(array: T[], size: number): T[][] {
    const chunks: T[][] = [];
    for (let i = 0; i < array.length; i += size) { chunks.push(array.slice(i, i + size)); }
    return chunks;
  }

  async retry<T>(fn: () => Promise<T>, retries = this._maxRetries): Promise<T> {
    for (let i = 0; i < retries; i++) {
      try { return await fn(); }
      catch (error) {
        if (i === retries - 1) { throw error; }
        await this.delay(Math.pow(2, i) * 1000);
      }
    }
    throw new Error('Max retries exceeded');
  }

  // ── Import Issues (legacy — used by extension.ts) ────────────

  async importIssuesFromLinear(plansDir: string): Promise<{ success: boolean; imported: number; skipped: number; error?: string }> {
    const config = await this.loadConfig();
    if (!config?.setupComplete) {
      return { success: false, imported: 0, skipped: 0, error: 'Linear not set up' };
    }

    try {
      const syncMap = await this.loadSyncMap();
      const syncMapIssueIds = new Set(Object.values(syncMap));

      const allIssues: any[] = [];
      let cursor: string | null = null;

      const projectFilter = config.projectId ? '\n              project: { id: { eq: $projectId } }' : '';
      const QUERY = `
        query($teamId: String!${config.projectId ? ', $projectId: String!' : ''}, $after: String) {
          issues(
            filter: {
              team: { id: { eq: $teamId } }
              ${projectFilter}
            }
            after: $after
            first: 50
          ) {
            nodes {
              id identifier title description url priority
              state { name type }
              assignee { name email }
              labels { nodes { name } }
              dueDate createdAt estimate
              parent { id title identifier }
              children { nodes { id identifier title description url priority state { name type } assignee { name email } labels { nodes { name } } dueDate createdAt estimate parent { id } } }
              project { name }
              cycle { name number }
              comments { nodes { body user { name } createdAt } }
              attachments { nodes { title url } }
            }
            pageInfo { hasNextPage endCursor }
          }
        }
      `;

      while (true) {
        const result = await this.graphqlRequest(QUERY, {
          teamId: config.teamId,
          ...(config.projectId ? { projectId: config.projectId } : {}),
          after: cursor
        });
        const page = result.data.issues;
        allIssues.push(...page.nodes);
        if (!page.pageInfo.hasNextPage) { break; }
        cursor = page.pageInfo.endCursor;
        await this.delay(200);
      }

      const subIssues = allIssues.flatMap((issue: any) => issue.children?.nodes || []);
      const allTasks = [...new Map([...allIssues, ...subIssues].map((t: any) => [t.id, t])).values()];

      const issueNameById = new Map<string, string>(allTasks.map((t: any) => [t.id, `${t.title} (${t.identifier})`]));
      const subIssuesByParentId = new Map<string, any[]>();
      for (const task of allTasks) {
        if (task.parent?.id) {
          const siblings = subIssuesByParentId.get(task.parent.id) || [];
          siblings.push(task);
          subIssuesByParentId.set(task.parent.id, siblings);
        }
      }

      await fs.promises.mkdir(plansDir, { recursive: true });
      let imported = 0;
      let skipped = 0;

      for (const issue of allTasks) {
        if (syncMapIssueIds.has(issue.id)) { skipped++; continue; }

        const stateType = (issue.state?.type || '').toLowerCase();
        if (stateType === 'completed' || stateType === 'cancelled') { skipped++; continue; }

        const planFile = path.join(plansDir, `linear_import_${issue.id}.md`);
        try { await fs.promises.access(planFile); skipped++; continue; } catch { /* proceed */ }

        const kanbanColumn = stateType === 'backlog' ? 'BACKLOG' : 'CREATED';
        const priority = ['', 'urgent', 'high', 'normal', 'low'][issue.priority] || '';
        const dueDate = issue.dueDate || '';
        const assignee = issue.assignee ? (issue.assignee.name || issue.assignee.email) : '';
        const labels = (issue.labels?.nodes || []).map((l: any) => l.name).filter((n: string) => n !== 'switchboard').join(', ');
        const description = (issue.description || '').trim();
        const parentRef = issue.parent?.id ? (issueNameById.get(issue.parent.id) || issue.parent.id) : '';

        const metaLines = [
          `> Imported from Linear issue \`${issue.identifier}\``,
          issue.url         ? `> **URL:** ${issue.url}`              : '',
          parentRef         ? `> **Parent Issue:** ${parentRef}`     : '',
          priority          ? `> **Priority:** ${priority}`          : '',
          dueDate           ? `> **Due:** ${dueDate}`                : '',
          assignee          ? `> **Assignee:** ${assignee}`          : '',
          labels            ? `> **Labels:** ${labels}`              : '',
          issue.state?.name ? `> **State:** ${issue.state.name}`    : '',
        ].filter(Boolean).join('\n');

        const subIssuesList = subIssuesByParentId.get(issue.id) || [];
        const subIssueLines = subIssuesList.map((s: any) =>
          `- ${s.title} (\`${s.identifier}\`) — see \`linear_import_${s.id}.md\``
        );

        const commentLines = (issue.comments?.nodes || []).map((c: any) =>
          `- **${c.user?.name || 'Unknown'} (${c.createdAt?.slice(0, 10) || ''}):** ${c.body}`
        );

        const attachmentLines = (issue.attachments?.nodes || []).map((a: any) =>
          `- [${a.title}](${a.url})`
        );

        const notesLines = [
          '## Linear Issue Notes',
          '',
          `**State:** ${issue.state?.name || ''} (${stateType})`,
          issue.estimate !== null && issue.estimate !== undefined ? `**Estimate:** ${issue.estimate} points` : '',
          issue.project?.name ? `**Project:** ${issue.project.name}` : '',
          issue.cycle?.name   ? `**Cycle:** ${issue.cycle.name} (#${issue.cycle.number})` : '',
          `**Created:** ${issue.createdAt?.slice(0, 10) || ''}`,
          ...(subIssueLines.length > 0 ? ['', '**Sub-issues (each imported as a separate plan):**', ...subIssueLines] : []),
          ...(commentLines.length > 0 ? ['', '**Comments:**', ...commentLines] : []),
          ...(attachmentLines.length > 0 ? ['', '**Attachments:**', ...attachmentLines] : []),
        ].filter(s => s !== '').join('\n');

        const stub = [
          `# ${issue.title || `Linear Issue ${issue.identifier}`}`,
          '',
          metaLines,
          '',
          '## Goal',
          '',
          description || 'TODO',
          '',
          '## Proposed Changes',
          '',
          'TODO',
          '',
          notesLines,
          '',
          `## Switchboard State\n\n**Kanban Column:** ${kanbanColumn}\n**Status:** active\n`,
        ].join('\n');

        await fs.promises.writeFile(planFile, stub, 'utf8');
        imported++;
      }

      return { success: true, imported, skipped };
    } catch (error) {
      return { success: false, imported: 0, skipped: 0, error: `Import failed: ${error}` };
    }
  }
}
