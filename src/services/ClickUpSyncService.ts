import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as https from 'https';
import type { AutoPullIntervalMinutes } from './IntegrationAutoPullService';

export interface ClickUpConfig {
  workspaceId: string;
  folderId: string;
  spaceId: string;
  columnMappings: Record<string, string>;
  customFields: {
    sessionId: string;
    planId: string;
    syncTimestamp: string;
  };
  setupComplete: boolean;
  lastSync: string | null;
  autoPullEnabled: boolean;
  pullIntervalMinutes: AutoPullIntervalMinutes;
}

export interface KanbanPlanRecord {
  planId: string;
  sessionId: string;
  topic: string;
  planFile: string;
  kanbanColumn: string;
  status: string;
  complexity: string;
  tags: string;
  dependencies: string;
  createdAt: string;
  updatedAt: string;
  lastAction: string;
}

// Canonical Switchboard kanban columns (mirrors KanbanDatabase.ts VALID_KANBAN_COLUMNS)
export const CANONICAL_COLUMNS = [
  'CREATED', 'BACKLOG', 'PLAN REVIEWED', 'LEAD CODED',
  'CODER CODED', 'CODE REVIEWED', 'CODED', 'COMPLETED'
];

export class ClickUpSyncService {
  private _workspaceRoot: string;
  private _configPath: string;
  private _config: ClickUpConfig | null = null;
  private _debounceTimers: Map<string, NodeJS.Timeout> = new Map();
  private _rateLimitDelay: number = 1000;
  private _batchSize: number = 10;
  private _maxRetries: number = 3;
  private _secretStorage: vscode.SecretStorage;
  private _setupInProgress: boolean = false;
  private _isSyncInProgress: boolean = false;
  private _consecutiveFailures: number = 0;

  constructor(workspaceRoot: string, secretStorage: vscode.SecretStorage) {
    this._workspaceRoot = workspaceRoot;
    this._configPath = path.join(workspaceRoot, '.switchboard', 'clickup-config.json');
    this._secretStorage = secretStorage;
  }

  // ── Config I/O ──────────────────────────────────────────────

  private _normalizeConfig(raw: Partial<ClickUpConfig> | null): ClickUpConfig | null {
    if (!raw) {
      return null;
    }

    const interval = raw.pullIntervalMinutes;
    const normalizedInterval: AutoPullIntervalMinutes =
      interval === 5 || interval === 15 || interval === 30 || interval === 60 ? interval : 60;

    return {
      workspaceId: raw.workspaceId || '',
      folderId: raw.folderId || '',
      spaceId: raw.spaceId || '',
      columnMappings: raw.columnMappings || Object.fromEntries(CANONICAL_COLUMNS.map(c => [c, ''])),
      customFields: raw.customFields || { sessionId: '', planId: '', syncTimestamp: '' },
      setupComplete: raw.setupComplete === true,
      lastSync: raw.lastSync || null,
      autoPullEnabled: raw.autoPullEnabled === true,
      pullIntervalMinutes: normalizedInterval
    };
  }

  async loadConfig(): Promise<ClickUpConfig | null> {
    try {
      const content = await fs.promises.readFile(this._configPath, 'utf8');
      const normalized = this._normalizeConfig(JSON.parse(content));
      this._config = normalized;
      return normalized;
    } catch {
      return null;
    }
  }

  async saveConfig(config: ClickUpConfig): Promise<void> {
    const normalized = this._normalizeConfig(config);
    if (!normalized) {
      throw new Error('ClickUp config normalization failed');
    }
    const dir = path.dirname(this._configPath);
    await fs.promises.mkdir(dir, { recursive: true });
    await fs.promises.writeFile(this._configPath, JSON.stringify(normalized, null, 2));
    this._config = normalized;
  }

  // ── Token Management ────────────────────────────────────────

  /**
   * Read ClickUp API token from VS Code SecretStorage.
   * Returns null if not set — callers must handle this.
   */
  async getApiToken(): Promise<string | null> {
    try {
      return await this._secretStorage.get('switchboard.clickup.apiToken') || null;
    } catch {
      return null;
    }
  }

  private async _promptForApiToken(): Promise<string | null> {
    const inputToken = await vscode.window.showInputBox({
      prompt: 'Enter your ClickUp API token (starts with pk_)',
      password: true,
      placeHolder: 'pk_...',
      ignoreFocusOut: true,
      validateInput: (value) => {
        if (!value || value.trim().length < 10) {
          return 'Token appears too short. ClickUp tokens typically start with pk_';
        }
        return null;
      }
    });
    return inputToken ? inputToken.trim() : null;
  }

  // ── HTTP Client ─────────────────────────────────────────────

  /**
   * Authenticated HTTPS request to ClickUp REST API.
   * All extension-code ClickUp interactions go through this method.
   * Never logs the Authorization header.
   */
  async httpRequest(
    method: 'GET' | 'POST' | 'PUT' | 'DELETE',
    apiPath: string,
    body?: Record<string, unknown>,
    timeoutMs: number = 10000
  ): Promise<{ status: number; data: any }> {
    const token = await this.getApiToken();
    if (!token) { throw new Error('ClickUp API token not configured'); }

    return new Promise((resolve, reject) => {
      const payload = body ? JSON.stringify(body) : undefined;
      const req = https.request({
        hostname: 'api.clickup.com',
        path: `/api/v2${apiPath}`,
        method,
        headers: {
          'Authorization': token,
          'Content-Type': 'application/json',
          ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {})
        },
        timeout: timeoutMs
      }, (res) => {
        let raw = '';
        res.on('data', (chunk: Buffer) => { raw += chunk.toString(); });
        res.on('end', () => {
          try {
            resolve({ status: res.statusCode || 0, data: JSON.parse(raw) });
          } catch {
            resolve({ status: res.statusCode || 0, data: raw });
          }
        });
      });
      req.on('timeout', () => { req.destroy(); reject(new Error('Request timed out')); });
      req.on('error', reject);
      if (payload) { req.write(payload); }
      req.end();
    });
  }

  // ── Availability Check ──────────────────────────────────────

  /**
   * Check if ClickUp is configured and reachable.
   * Uses a 2-second timeout to avoid blocking UI.
   */
  async isAvailable(): Promise<boolean> {
    try {
      const token = await this.getApiToken();
      if (!token) { return false; }
      const result = await this.httpRequest('GET', '/team', undefined, 2000);
      return result.status === 200;
    } catch {
      return false;
    }
  }

  // ── Utilities ───────────────────────────────────────────────

  get setupInProgress(): boolean { return this._setupInProgress; }
  set setupInProgress(v: boolean) { this._setupInProgress = v; }

  get isSyncInProgress(): boolean { return this._isSyncInProgress; }
  set isSyncInProgress(v: boolean) { this._isSyncInProgress = v; }

  get consecutiveFailures(): number { return this._consecutiveFailures; }

  get debounceTimers(): Map<string, NodeJS.Timeout> { return this._debounceTimers; }
  get batchSize(): number { return this._batchSize; }
  get rateLimitDelay(): number { return this._rateLimitDelay; }
  get configPath(): string { return this._configPath; }
  get workspaceRoot(): string { return this._workspaceRoot; }

  delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  chunkArray<T>(array: T[], size: number): T[][] {
    const chunks: T[][] = [];
    for (let i = 0; i < array.length; i += size) {
      chunks.push(array.slice(i, i + size));
    }
    return chunks;
  }

  async retry<T>(fn: () => Promise<T>, retries: number = this._maxRetries): Promise<T> {
    for (let i = 0; i < retries; i++) {
      try {
        return await fn();
      } catch (error) {
        if (i === retries - 1) { throw error; }
        await this.delay(Math.pow(2, i) * 1000);
      }
    }
    throw new Error('Max retries exceeded');
  }

  // ── Setup Flow ──────────────────────────────────────────────

  /**
   * Setup ClickUp integration: create folder, lists, and custom fields.
   * Transactional — cleans up partial resources on failure.
   */
  async setup(): Promise<{ success: boolean; error?: string }> {
    if (this.setupInProgress) {
      return { success: false, error: 'Setup already in progress' };
    }
    this.setupInProgress = true;

    try {
      let token = await this.getApiToken();
      if (!token) {
        token = await this._promptForApiToken();
        if (!token) {
          return { success: false, error: 'Setup cancelled — ClickUp API token required.' };
        }
        await this._secretStorage.store('switchboard.clickup.apiToken', token);
      }

      let config = await this.loadConfig();
      if (!config) {
        config = {
          workspaceId: '',
          folderId: '',
          spaceId: '',
          columnMappings: Object.fromEntries(CANONICAL_COLUMNS.map(c => [c, ''])),
          customFields: { sessionId: '', planId: '', syncTimestamp: '' },
          setupComplete: false,
          lastSync: null,
          autoPullEnabled: false,
          pullIntervalMinutes: 60
        };
      }

      // Step 1: Get workspace
      const teamResult = await this.httpRequest('GET', '/team');
      if (teamResult.status !== 200) {
        return { success: false, error: 'Failed to fetch workspace. Check your API token.' };
      }
      const teams = teamResult.data?.teams || [];
      if (teams.length === 0) {
        return { success: false, error: 'No ClickUp workspaces found.' };
      }
      config.workspaceId = teams[0].id;

      // Step 2: Get spaces and prompt user to select one
      const spacesResult = await this.httpRequest('GET', `/team/${config.workspaceId}/space?archived=false`);
      const spaces = spacesResult.data?.spaces || [];
      if (spaces.length === 0) {
        return { success: false, error: 'No spaces found in workspace.' };
      }

      const spaceItems: { label: string; id: string }[] = spaces.map((s: any) => ({
        label: s.name, id: s.id
      }));
      const selectedSpace = await vscode.window.showQuickPick(
        spaceItems.map(s => s.label),
        { placeHolder: 'Select a ClickUp space for the AI Agents folder' }
      );
      if (!selectedSpace) {
        return { success: false, error: 'No space selected' };
      }
      config.spaceId = spaceItems.find(s => s.label === selectedSpace)?.id || '';

      // Step 3: Check for existing "AI Agents" folder
      const foldersResult = await this.httpRequest('GET', `/space/${config.spaceId}/folder?archived=false`);
      const existingFolder = (foldersResult.data?.folders || []).find((f: any) => f.name === 'AI Agents');
      let folderWasCreated = false;
      if (existingFolder) {
        const reuse = await vscode.window.showQuickPick(
          ['Reuse existing folder', 'Cancel setup'],
          { placeHolder: '"AI Agents" folder already exists in this space' }
        );
        if (reuse !== 'Reuse existing folder') {
          return { success: false, error: 'Setup cancelled — folder already exists' };
        }
        config.folderId = existingFolder.id;
      } else {
        const folderResult = await this.retry(() =>
          this.httpRequest('POST', `/space/${config.spaceId}/folder`, { name: 'AI Agents' })
        );
        if (folderResult.status !== 200) {
          return { success: false, error: `Failed to create folder: ${JSON.stringify(folderResult.data)}` };
        }
        config.folderId = folderResult.data.id;
        folderWasCreated = true;
      }

      // Step 4: Create lists for each canonical column
      for (const column of CANONICAL_COLUMNS) {
        const listResult = await this.retry(() =>
          this.httpRequest('POST', `/folder/${config.folderId}/list`, { name: column })
        );
        if (listResult.status !== 200) {
          if (folderWasCreated) { await this._cleanup(config); }
          return { success: false, error: `Failed to create list for column: ${column}` };
        }
        config.columnMappings[column] = listResult.data.id;
        await this.delay(200); // Light pacing to stay under rate limits
      }

      // Step 5: Create custom fields on the first list (CREATED)
      const firstListId = config.columnMappings['CREATED'];
      const fieldDefs = [
        { name: 'switchboard_session_id', type: 'text', configKey: 'sessionId' as const },
        { name: 'switchboard_plan_id', type: 'text', configKey: 'planId' as const },
        { name: 'sync_timestamp', type: 'date', configKey: 'syncTimestamp' as const }
      ];
      for (const field of fieldDefs) {
        try {
          const fieldResult = await this.retry(() =>
            this.httpRequest('POST', `/list/${firstListId}/field`, {
              name: field.name, type: field.type
            })
          );
          if (fieldResult.status === 200) {
            config.customFields[field.configKey] = fieldResult.data.id;
          }
        } catch {
          // Non-fatal: metadata will be embedded in task descriptions instead
          console.warn(`[ClickUpSync] Custom field '${field.name}' creation failed — using description fallback.`);
        }
      }

      config.setupComplete = true;
      await this.saveConfig(config);
      return { success: true };
    } catch (error) {
      return { success: false, error: `Setup failed: ${error}` };
    } finally {
      this.setupInProgress = false;
    }
  }

  /**
   * Clean up ClickUp resources on setup failure.
   * Deleting the folder cascades to child lists.
   */
  private async _cleanup(config: ClickUpConfig): Promise<void> {
    if (config.folderId) {
      try {
        await this.httpRequest('DELETE', `/folder/${config.folderId}`);
      } catch { /* best-effort */ }
    }
    try {
      await fs.promises.unlink(this.configPath);
    } catch { /* ignore */ }
  }

  // ── Sync Methods ────────────────────────────────────────────

  /**
   * Sync a single plan to ClickUp (Switchboard → ClickUp only).
   * Guarded by _isSyncInProgress to prevent circular loops.
   */
  async syncPlan(plan: KanbanPlanRecord): Promise<{ success: boolean; taskId?: string; error?: string }> {
    if (this.isSyncInProgress) {
      return { success: false, error: 'Sync already in progress (loop guard)' };
    }
    this.isSyncInProgress = true;

    try {
      const config = await this.loadConfig();
      if (!config || !config.setupComplete) {
        return { success: false, error: 'ClickUp not set up' };
      }

      const listId = config.columnMappings[plan.kanbanColumn];
      if (!listId) {
        // Column has no ClickUp list (e.g., custom agent column) — skip silently
        console.log(`[ClickUpSync] No list mapping for column '${plan.kanbanColumn}' — skipping sync.`);
        return { success: true }; // Not an error, just unmapped
      }

      const planContent = await this._readPlanContent(plan.planFile);
      const existingTaskId = await this._findTaskByPlanId(plan.planId, config);

      if (existingTaskId) {
        await this._updateTask(existingTaskId, plan, config, planContent);
        this._consecutiveFailures = 0;
        return { success: true, taskId: existingTaskId };
      } else {
        const taskId = await this._createTask(listId, plan, config, planContent);
        this._consecutiveFailures = 0;
        return { success: true, taskId: taskId || undefined };
      }
    } catch (error) {
      this._consecutiveFailures++;
      return { success: false, error: `Sync failed: ${error}` };
    } finally {
      this.isSyncInProgress = false;
    }
  }

  /**
   * Find an existing ClickUp task for a Switchboard plan.
   * Primary: custom field filter. Fallback: tag-based search.
   */
  private async _findTaskByPlanId(planId: string, config: ClickUpConfig): Promise<string | null> {
    if (config.customFields.planId) {
      try {
        const result = await this.httpRequest('GET',
          `/team/${config.workspaceId}/task` +
          `?custom_fields=[{"field_id":"${config.customFields.planId}","operator":"=","value":"${planId}"}]` +
          `&include_closed=true`
        );
        if (result.status === 200 && result.data?.tasks?.length > 0) {
          return result.data.tasks[0].id;
        }
      } catch { /* fall through to tag search */ }
    }

    try {
      const result = await this.httpRequest('GET',
        `/team/${config.workspaceId}/task?tags[]=switchboard:${encodeURIComponent(planId)}&include_closed=true`
      );
      if (result.status === 200 && result.data?.tasks?.length > 0) {
        return result.data.tasks[0].id;
      }
    } catch { /* not found */ }

    return null;
  }

  /**
   * Create a new ClickUp task from a Switchboard plan record.
   */
  private async _createTask(listId: string, plan: KanbanPlanRecord, config: ClickUpConfig, planContent: string): Promise<string | null> {
    // Map complexity to ClickUp priority: 1=urgent, 2=high, 3=normal, 4=low
    const complexityNum = parseInt(plan.complexity, 10) || 5;
    const priority = complexityNum >= 8 ? 2 : complexityNum >= 5 ? 3 : 4;

    // Sanitize description: use file content if available, else strip HTML from topic
    const description = planContent || (plan.topic || '').replace(/<[^>]*>/g, '');

    const tags = plan.tags
      ? plan.tags.split(',').map(t => t.trim()).filter(Boolean)
      : [];
    tags.push(`switchboard:${plan.planId}`);

    const body: Record<string, unknown> = {
      name: plan.topic || `Plan ${plan.planId}`,
      description: `${description}\n\n---\n[Switchboard] Session: ${plan.sessionId} | Plan: ${plan.planId}`,
      priority,
      tags,
      custom_fields: [
        ...(config.customFields.sessionId
          ? [{ id: config.customFields.sessionId, value: plan.sessionId }] : []),
        ...(config.customFields.planId
          ? [{ id: config.customFields.planId, value: plan.planId }] : []),
        ...(config.customFields.syncTimestamp
          ? [{ id: config.customFields.syncTimestamp, value: Date.now() }] : [])
      ]
    };

    const result = await this.retry(() =>
      this.httpRequest('POST', `/list/${listId}/task`, body)
    );
    return result.status === 200 ? result.data.id : null;
  }

  /**
   * Update an existing ClickUp task and move it to the correct list
   * if the kanban column has changed.
   */
  private async _updateTask(taskId: string, plan: KanbanPlanRecord, config: ClickUpConfig, planContent: string): Promise<void> {
    const body: Record<string, unknown> = {
      name: plan.topic || `Plan ${plan.planId}`,
      custom_fields: config.customFields.syncTimestamp
        ? [{ id: config.customFields.syncTimestamp, value: Date.now() }]
        : []
    };

    if (planContent) {
      body.description = `${planContent}\n\n---\n[Switchboard] Session: ${plan.sessionId} | Plan: ${plan.planId}`;
    }

    await this.retry(() =>
      this.httpRequest('PUT', `/task/${taskId}`, body)
    );

    // Move task to correct list if column changed
    const targetListId = config.columnMappings[plan.kanbanColumn];
    if (targetListId) {
      try {
        await this.retry(() =>
          this.httpRequest('POST', `/list/${targetListId}/task/${taskId}`)
        );
      } catch (err) {
        console.warn(`[ClickUpSync] Failed to move task ${taskId} to list ${targetListId}:`, err);
      }
    }
  }

  private async _readPlanContent(planFile: string): Promise<string> {
    if (!planFile) { return ''; }
    try {
      const filePath = path.isAbsolute(planFile)
        ? planFile
        : path.join(this._workspaceRoot, planFile);
      const content = await fs.promises.readFile(filePath, 'utf8');
      return content.slice(0, 50000);
    } catch {
      return '';
    }
  }

  /**
   * Batch sync all plans in a column with rate limiting.
   */
  async syncColumn(column: string, plans: KanbanPlanRecord[]): Promise<{ success: boolean; synced: number; errors: number }> {
    const config = await this.loadConfig();
    if (!config || !config.setupComplete) {
      return { success: false, synced: 0, errors: 0 };
    }

    let synced = 0;
    let errors = 0;
    const batches = this.chunkArray(plans, this.batchSize);

    for (const batch of batches) {
      for (const plan of batch) {
        const result = await this.syncPlan(plan);
        if (result.success) { synced++; } else { errors++; }
      }
      await this.delay(this.rateLimitDelay);
    }

    config.lastSync = new Date().toISOString();
    await this.saveConfig(config);
    return { success: true, synced, errors };
  }

  /**
   * Debounced sync for move events.
   * Rapid moves within 500ms are coalesced — only the final position syncs.
   */
  debouncedSync(sessionId: string, plan: KanbanPlanRecord): void {
    const existing = this.debounceTimers.get(sessionId);
    if (existing) { clearTimeout(existing); }

    const timer = setTimeout(async () => {
      await this.syncPlan(plan);
      this.debounceTimers.delete(sessionId);
    }, 500);

    this.debounceTimers.set(sessionId, timer);
  }

  /**
   * Fetch tasks from a ClickUp list and write a stub plan .md file for each.
   * The PlanFileImporter picks up new files automatically — no DB calls needed.
   * Skips tasks that already have a plan file or are owned by Switchboard (switchboard: tag).
   */
  async importTasksFromClickUp(
    listId: string,
    plansDir: string
  ): Promise<{ success: boolean; imported: number; skipped: number; error?: string }> {
    const config = await this.loadConfig();
    if (!config?.setupComplete) {
      return { success: false, imported: 0, skipped: 0, error: 'ClickUp not set up' };
    }

    try {
      const tasks: any[] = [];
      let page = 0;

      // subtasks=true returns subtasks inline in the same flat array, each with a `parent` field
      while (true) {
        const result = await this.httpRequest('GET', `/list/${listId}/task?page=${page}&subtasks=true&include_closed=false`);
        if (result.status !== 200) {
          return { success: false, imported: 0, skipped: 0, error: `Failed to fetch tasks: ${result.status}` };
        }
        const pageTasks: any[] = result.data?.tasks || [];
        tasks.push(...pageTasks);
        if (pageTasks.length < 100) { break; }
        page++;
        await this.delay(200);
      }

      await fs.promises.mkdir(plansDir, { recursive: true });

      // Build lookup maps from the flat task list
      const taskNameById = new Map<string, string>(tasks.map((t: any) => [t.id, t.name]));
      const subtasksByParentId = new Map<string, any[]>();
      for (const task of tasks) {
        if (task.parent) {
          const siblings = subtasksByParentId.get(task.parent) || [];
          siblings.push(task);
          subtasksByParentId.set(task.parent, siblings);
        }
      }

      let imported = 0;
      let skipped = 0;

      for (const task of tasks) {
        // Skip tasks already owned by Switchboard
        const hasSwitchboardTag = (task.tags || []).some((t: any) => t.name?.toLowerCase().startsWith('switchboard:'));
        if (hasSwitchboardTag) { skipped++; continue; }

        const planFile = path.join(plansDir, `clickup_import_${task.id}.md`);

        // Skip if already imported
        try { await fs.promises.access(planFile); skipped++; continue; } catch { /* file doesn't exist, proceed */ }

        // Determine initial kanban column: backlog status → BACKLOG, everything else → CREATED
        const statusName = (task.status?.status || '').toLowerCase();
        const kanbanColumn = statusName === 'backlog' ? 'BACKLOG' : 'CREATED';

        // Core fields
        const priority = task.priority?.priority || '';
        const dueDate = task.due_date ? new Date(Number(task.due_date)).toLocaleDateString() : '';
        const assignees = (task.assignees || []).map((a: any) => a.username || a.email || a.id).join(', ');
        const tags = (task.tags || [])
          .map((t: any) => t.name)
          .filter((n: string) => n && !n.toLowerCase().startsWith('switchboard:'))
          .join(', ');
        const description = (task.markdown_description || task.description || '').trim();
        const parentName = task.parent ? (taskNameById.get(task.parent) || task.parent) : '';

        // Metadata block (top of file)
        const metaLines = [
          `> Imported from ClickUp task \`${task.id}\``,
          task.url   ? `> **URL:** ${task.url}`                       : '',
          parentName ? `> **Parent Task:** ${parentName}`             : '',
          priority   ? `> **Priority:** ${priority}`                  : '',
          dueDate    ? `> **Due:** ${dueDate}`                        : '',
          assignees  ? `> **Assignees:** ${assignees}`                : '',
          tags       ? `> **Tags:** ${tags}`                          : '',
        ].filter(Boolean).join('\n');

        // ClickUp Ticket Notes — all remaining fields, no mapping, just raw info
        const startDate = task.start_date ? new Date(Number(task.start_date)).toLocaleDateString() : '';
        const timeEstimate = task.time_estimate ? `${Math.round(task.time_estimate / 60000)}m` : '';
        const creator = task.creator ? (task.creator.username || task.creator.email || task.creator.id) : '';
        const linkedTasks = (task.linked_tasks || []).map((l: any) => l.task_id || l.id).join(', ');
        const dependencies = (task.dependencies || []).map((d: any) => d.task_id || d.id).join(', ');

        const checklistLines = (task.checklists || []).flatMap((cl: any) =>
          (cl.items || []).map((item: any) => `- [${item.resolved ? 'x' : ' '}] ${item.name}`)
        );

        const customFieldLines = (task.custom_fields || [])
          .filter((f: any) => f.value !== null && f.value !== undefined && f.value !== '')
          .map((f: any) => `- **${f.name}:** ${JSON.stringify(f.value)}`);

        // List subtasks on parent tasks (each subtask gets its own plan file)
        const subtasks = subtasksByParentId.get(task.id) || [];
        const subtaskLines = subtasks.map((s: any) => `- ${s.name} (\`${s.id}\`) — see \`clickup_import_${s.id}.md\``);

        const notesLines = [
          '## ClickUp Ticket Notes',
          '',
          `**Status:** ${task.status?.status || ''}`,
          startDate      ? `**Start Date:** ${startDate}`        : '',
          timeEstimate   ? `**Time Estimate:** ${timeEstimate}`  : '',
          creator        ? `**Creator:** ${creator}`             : '',
          linkedTasks    ? `**Linked Tasks:** ${linkedTasks}`    : '',
          dependencies   ? `**Dependencies:** ${dependencies}`   : '',
          ...(subtaskLines.length > 0 ? ['', '**Subtasks (each imported as a separate plan):**', ...subtaskLines] : []),
          ...(checklistLines.length > 0 ? ['', '**Checklists:**', ...checklistLines] : []),
          ...(customFieldLines.length > 0 ? ['', '**Custom Fields:**', ...customFieldLines] : []),
        ].filter(s => s !== '').join('\n');

        // Embed kanban column for PlanFileImporter (must match extractKanbanState() bold-markdown format)
        const switchboardState = `## Switchboard State\n\n**Kanban Column:** ${kanbanColumn}\n**Status:** active\n`;

        const stub = [
          `# ${task.name || `ClickUp Task ${task.id}`}`,
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
          switchboardState,
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
