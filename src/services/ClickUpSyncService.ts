import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as https from 'https';
import type { AutoPullIntervalMinutes } from './IntegrationAutoPullService';
import {
  matchesClickUpAutomationRule,
  normalizeClickUpAutomationRules,
  type ClickUpAutomationRule
} from '../models/PipelineDefinition';

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
  realTimeSyncEnabled: boolean;
  autoPullEnabled: boolean;
  pullIntervalMinutes: AutoPullIntervalMinutes;
  automationRules: ClickUpAutomationRule[];
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
  clickupTaskId?: string;
}

export interface ClickUpListSummary {
  id: string;
  name: string;
}

export interface ClickUpColumnMappingState {
  columnId: string;
  listId: string;
  listName: string;
  status: 'mapped' | 'excluded' | 'unmapped';
}

export interface ClickUpMappingState {
  availableLists: ClickUpListSummary[];
  mappings: ClickUpColumnMappingState[];
  mappedCount: number;
  excludedCount: number;
  unmappedCount: number;
}

export interface ClickUpMappingSelection {
  columnId: string;
  strategy: 'create' | 'existing' | 'exclude';
  listId?: string;
}

export interface ClickUpApplyOptions {
  createFolder: boolean;
  createLists: boolean;
  createCustomFields: boolean;
  enableRealtimeSync: boolean;
  enableAutoPull: boolean;
  columns?: string[];
}

export type ClickUpWriteBackTarget = 'description' | 'comment';
export type ClickUpWriteBackFormat = 'append' | 'prepend' | 'replace';

export type ClickUpSyncSkipReason = 'unmapped-column' | 'excluded-column';

export interface ClickUpSyncResult {
  success: boolean;
  taskId?: string;
  error?: string;
  warning?: string;
  skippedReason?: ClickUpSyncSkipReason;
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

  private _normalizeStringRecord(raw: unknown): Record<string, string> {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      return {};
    }

    return Object.fromEntries(
      Object.entries(raw as Record<string, unknown>)
        .map(([key, value]) => [String(key || '').trim(), String(value || '').trim()])
        .filter(([key]) => key.length > 0)
    );
  }

  private _normalizeColumns(columns: string[] | undefined, config: ClickUpConfig | null): string[] {
    const normalized = (Array.isArray(columns) ? columns : [])
      .map((column) => String(column || '').trim())
      .filter(Boolean);
    if (normalized.length > 0) {
      return Array.from(new Set(normalized));
    }

    if (config) {
      const configColumns = Object.keys(config.columnMappings || {})
        .map((column) => String(column || '').trim())
        .filter(Boolean);
      if (configColumns.length > 0) {
        return Array.from(new Set(configColumns));
      }
    }

    return [...CANONICAL_COLUMNS];
  }

  private _hasExplicitColumnMapping(config: ClickUpConfig, column: string): boolean {
    return Object.prototype.hasOwnProperty.call(config.columnMappings, column);
  }

  private _getCustomFieldState(raw: Partial<ClickUpConfig> | null): ClickUpConfig['customFields'] {
    const customFields: Partial<ClickUpConfig['customFields']> = raw?.customFields && typeof raw.customFields === 'object'
      ? raw.customFields
      : {};

    return {
      sessionId: String(customFields.sessionId || '').trim(),
      planId: String(customFields.planId || '').trim(),
      syncTimestamp: String(customFields.syncTimestamp || '').trim()
    };
  }

  private _createEmptyConfig(): ClickUpConfig {
    return {
      workspaceId: '',
      folderId: '',
      spaceId: '',
      columnMappings: {},
      customFields: { sessionId: '', planId: '', syncTimestamp: '' },
      setupComplete: false,
      lastSync: null,
      realTimeSyncEnabled: false,
      autoPullEnabled: false,
      pullIntervalMinutes: 60,
      automationRules: []
    };
  }

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
      columnMappings: (() => {
        const normalizedMappings = this._normalizeStringRecord(raw.columnMappings);
        return Object.keys(normalizedMappings).length > 0
          ? normalizedMappings
          : {};
      })(),
      customFields: this._getCustomFieldState(raw),
      setupComplete: raw.setupComplete === true,
      lastSync: raw.lastSync || null,
      realTimeSyncEnabled: raw.realTimeSyncEnabled === undefined
        ? raw.setupComplete === true
        : raw.realTimeSyncEnabled === true,
      autoPullEnabled: raw.autoPullEnabled === true,
      pullIntervalMinutes: normalizedInterval,
      automationRules: normalizeClickUpAutomationRules(raw.automationRules)
    };
  }

  private _hasMappedLists(config: ClickUpConfig): boolean {
    return Object.values(config.columnMappings || {}).some(
      (listId) => typeof listId === 'string' && listId.trim().length > 0
    );
  }

  private async _loadWorkspaceId(): Promise<string> {
    const teamResult = await this.httpRequest('GET', '/team');
    if (teamResult.status !== 200) {
      throw new Error('Failed to fetch workspace. Check your API token.');
    }
    const teams = Array.isArray(teamResult.data?.teams) ? teamResult.data.teams : [];
    const workspaceId = String(teams[0]?.id || '').trim();
    if (!workspaceId) {
      throw new Error('No ClickUp workspaces found.');
    }
    return workspaceId;
  }

  private async _ensureWorkspaceAndSpace(config: ClickUpConfig): Promise<void> {
    if (!config.workspaceId) {
      config.workspaceId = await this._loadWorkspaceId();
    }
    if (config.spaceId) {
      return;
    }

    const spacesResult = await this.httpRequest('GET', `/team/${config.workspaceId}/space?archived=false`);
    if (spacesResult.status !== 200) {
      throw new Error('Failed to fetch ClickUp spaces.');
    }
    const spaces = Array.isArray(spacesResult.data?.spaces) ? spacesResult.data.spaces : [];
    if (spaces.length === 0) {
      throw new Error('No spaces found in workspace.');
    }

    const spaceItems: Array<{ label: string; id: string }> = spaces.map((space: any) => ({
      label: String(space?.name || '').trim(),
      id: String(space?.id || '').trim()
    })).filter((space: { label: string; id: string }) => space.label.length > 0 && space.id.length > 0);
    const selectedSpace = await vscode.window.showQuickPick(
      spaceItems.map((space) => space.label),
      { placeHolder: 'Select a ClickUp space for the AI Agents folder' }
    );
    if (!selectedSpace) {
      throw new Error('No ClickUp space selected.');
    }

    const resolvedSpaceId = spaceItems.find((space) => space.label === selectedSpace)?.id || '';
    if (!resolvedSpaceId) {
      throw new Error('No ClickUp space selected.');
    }
    config.spaceId = resolvedSpaceId;
  }

  private async _findAiAgentsFolder(spaceId: string): Promise<{ id: string; name: string } | null> {
    const foldersResult = await this.httpRequest('GET', `/space/${spaceId}/folder?archived=false`);
    if (foldersResult.status !== 200) {
      throw new Error('Failed to load ClickUp folders.');
    }

    const existingFolder = (foldersResult.data?.folders || []).find(
      (folder: any) => String(folder?.name || '').trim() === 'AI Agents'
    );
    const folderId = String(existingFolder?.id || '').trim();
    return folderId
      ? { id: folderId, name: 'AI Agents' }
      : null;
  }

  private async _ensureFolder(
    config: ClickUpConfig,
    allowCreate: boolean
  ): Promise<{ created: boolean }> {
    if (config.folderId) {
      return { created: false };
    }

    if (!config.spaceId) {
      await this._ensureWorkspaceAndSpace(config);
    }

    const existingFolder = await this._findAiAgentsFolder(config.spaceId);
    if (existingFolder?.id) {
      config.folderId = existingFolder.id;
      return { created: false };
    }

    if (!allowCreate) {
      throw new Error('ClickUp needs an existing "AI Agents" folder. Enable folder creation or reuse an existing folder first.');
    }

    const folderResult = await this.retry(() =>
      this.httpRequest('POST', `/space/${config.spaceId}/folder`, { name: 'AI Agents' })
    );
    if (folderResult.status !== 200) {
      throw new Error(`Failed to create folder: ${JSON.stringify(folderResult.data)}`);
    }
    const folderId = String(folderResult.data?.id || '').trim();
    if (!folderId) {
      throw new Error('ClickUp returned an invalid folder id.');
    }
    config.folderId = folderId;
    return { created: true };
  }

  private async _ensureColumnMappings(config: ClickUpConfig, columns: string[]): Promise<void> {
    if (!config.folderId) {
      throw new Error('ClickUp list setup requires an existing folder.');
    }

    const existingLists = await this.listFolderLists(config.folderId);
    for (const column of columns) {
      const hasExplicitMapping = this._hasExplicitColumnMapping(config, column);
      const currentListId = String(config.columnMappings[column] || '').trim();
      if (hasExplicitMapping && !currentListId) {
        config.columnMappings[column] = '';
        continue;
      }

      let targetList = currentListId
        ? existingLists.find((list) => list.id === currentListId)
        : undefined;
      if (!targetList) {
        targetList = existingLists.find((list) => list.name.toLowerCase() === column.toLowerCase());
      }

      if (!targetList) {
        const listResult = await this.retry(() =>
          this.httpRequest('POST', `/folder/${config.folderId}/list`, { name: column })
        );
        if (listResult.status !== 200) {
          throw new Error(`Failed to create list for column: ${column}`);
        }
        targetList = {
          id: String(listResult.data?.id || '').trim(),
          name: column
        };
        if (!targetList.id) {
          throw new Error(`ClickUp returned an invalid list for column: ${column}`);
        }
        existingLists.push(targetList);
      }

      config.columnMappings[column] = targetList.id;
      await this.delay(200);
    }
  }

  private async _ensureCustomFields(config: ClickUpConfig): Promise<void> {
    const firstListId = Object.values(config.columnMappings)
      .map((value) => String(value || '').trim())
      .find(Boolean);
    if (!firstListId) {
      throw new Error('ClickUp custom fields require at least one mapped list.');
    }

    const fieldDefs = [
      { name: 'switchboard_session_id', type: 'text', configKey: 'sessionId' as const },
      { name: 'switchboard_plan_id', type: 'text', configKey: 'planId' as const },
      { name: 'sync_timestamp', type: 'date', configKey: 'syncTimestamp' as const }
    ];
    for (const field of fieldDefs) {
      if (config.customFields[field.configKey]) {
        continue;
      }
      try {
        const fieldResult = await this.retry(() =>
          this.httpRequest('POST', `/list/${firstListId}/field`, {
            name: field.name,
            type: field.type
          })
        );
        if (fieldResult.status === 200) {
          config.customFields[field.configKey] = fieldResult.data.id;
        }
      } catch {
        console.warn(`[ClickUpSync] Custom field '${field.name}' creation failed — using description fallback.`);
      }
    }
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

  async listFolderLists(folderId?: string): Promise<ClickUpListSummary[]> {
    const config = await this.loadConfig();
    const resolvedFolderId = String(folderId || config?.folderId || '').trim();
    if (!resolvedFolderId) {
      return [];
    }

    const result = await this.httpRequest('GET', `/folder/${resolvedFolderId}/list?archived=false`);
    if (result.status !== 200) {
      throw new Error(`Failed to fetch ClickUp lists for folder ${resolvedFolderId}`);
    }

    return (result.data?.lists || [])
      .map((list: any) => ({
        id: String(list?.id || '').trim(),
        name: String(list?.name || '').trim()
      }))
      .filter((list: ClickUpListSummary) => list.id.length > 0);
  }

  async getColumnMappingState(columns: string[]): Promise<ClickUpMappingState> {
    const config = await this.loadConfig();
    const normalizedColumns = this._normalizeColumns(columns, config);
    const availableLists = config?.folderId ? await this.listFolderLists(config.folderId) : [];
    const listNameById = new Map(availableLists.map((list) => [list.id, list.name]));

    const mappings = normalizedColumns.map((columnId) => {
      if (!config || !this._hasExplicitColumnMapping(config, columnId)) {
        return {
          columnId,
          listId: '',
          listName: '',
          status: 'unmapped' as const
        };
      }

      const listId = String(config.columnMappings[columnId] || '').trim();
      if (!listId) {
        return {
          columnId,
          listId: '',
          listName: '',
          status: 'excluded' as const
        };
      }

      return {
        columnId,
        listId,
        listName: listNameById.get(listId) || '',
        status: 'mapped' as const
      };
    });

    return {
      availableLists,
      mappings,
      mappedCount: mappings.filter((mapping) => mapping.status === 'mapped').length,
      excludedCount: mappings.filter((mapping) => mapping.status === 'excluded').length,
      unmappedCount: mappings.filter((mapping) => mapping.status === 'unmapped').length
    };
  }

  async saveColumnMappings(
    selections: ClickUpMappingSelection[],
    columns?: string[]
  ): Promise<ClickUpMappingState> {
    const config = await this.loadConfig();
    if (!config?.setupComplete || !config.folderId) {
      throw new Error('ClickUp must be set up before updating column mappings.');
    }

    const normalizedColumns = this._normalizeColumns(columns, config);
    const selectionByColumn = new Map(
      selections
        .map((selection) => ({
          columnId: String(selection.columnId || '').trim(),
          strategy: selection.strategy,
          listId: String(selection.listId || '').trim()
        }))
        .filter((selection) => selection.columnId.length > 0)
        .map((selection) => [selection.columnId, selection])
    );
    const availableLists = await this.listFolderLists(config.folderId);
    const listById = new Map(availableLists.map((list) => [list.id, list]));
    const nextMappings = {
      ...config.columnMappings
    };

    for (const columnId of normalizedColumns) {
      const selection = selectionByColumn.get(columnId);
      if (!selection) {
        if (!this._hasExplicitColumnMapping(config, columnId)) {
          nextMappings[columnId] = '';
        }
        continue;
      }

      if (selection.strategy === 'exclude') {
        nextMappings[columnId] = '';
        continue;
      }

      if (selection.strategy === 'existing') {
        if (!selection.listId || !listById.has(selection.listId)) {
          throw new Error(`Select an existing ClickUp list for column '${columnId}'.`);
        }
        nextMappings[columnId] = selection.listId;
        continue;
      }

      const currentListId = String(config.columnMappings[columnId] || '').trim();
      let targetList = currentListId ? listById.get(currentListId) : undefined;
      if (!targetList) {
        targetList = availableLists.find((list) => list.name.toLowerCase() === columnId.toLowerCase());
      }

      if (!targetList) {
        const listResult = await this.retry(() =>
          this.httpRequest('POST', `/folder/${config.folderId}/list`, { name: columnId })
        );
        if (listResult.status !== 200) {
          throw new Error(`Failed to create ClickUp list for column '${columnId}'.`);
        }
        targetList = {
          id: String(listResult.data?.id || '').trim(),
          name: columnId
        };
        if (!targetList.id) {
          throw new Error(`ClickUp created an invalid list for column '${columnId}'.`);
        }
        availableLists.push(targetList);
        listById.set(targetList.id, targetList);
      }

      nextMappings[columnId] = targetList.id;
    }

    await this.saveConfig({
      ...config,
      columnMappings: nextMappings
    });
    return this.getColumnMappingState(normalizedColumns);
  }

  async saveAutomationSettings(
    automationRules: ClickUpAutomationRule[]
  ): Promise<void> {
    const config = await this.loadConfig();
    if (!config?.setupComplete) {
      throw new Error('ClickUp must be set up before saving automation settings.');
    }

    await this.saveConfig({
      ...config,
      automationRules: normalizeClickUpAutomationRules(automationRules)
    });
  }

  async listTasksFromClickUp(listId: string): Promise<any[]> {
    const tasks: any[] = [];
    let page = 0;

    while (true) {
      const result = await this.httpRequest('GET', `/list/${listId}/task?page=${page}&subtasks=true&include_closed=false`);
      if (result.status !== 200) {
        throw new Error(`Failed to fetch ClickUp tasks for list ${listId}: ${result.status}`);
      }

      const pageTasks: any[] = result.data?.tasks || [];
      tasks.push(...pageTasks);
      if (pageTasks.length < 100) {
        break;
      }
      page++;
      await this.delay(200);
    }

    return tasks;
  }

  private _mergeWriteBackContent(existing: string, content: string, format: ClickUpWriteBackFormat): string {
    const normalizedExisting = String(existing || '').trim();
    const normalizedContent = String(content || '').trim();
    if (!normalizedExisting) {
      return normalizedContent;
    }
    if (!normalizedContent) {
      return normalizedExisting;
    }

    switch (format) {
      case 'prepend':
        return `${normalizedContent}\n\n${normalizedExisting}`;
      case 'replace':
        return normalizedContent;
      case 'append':
      default:
        return `${normalizedExisting}\n\n${normalizedContent}`;
    }
  }

  async writeBackAutomationResult(
    taskId: string,
    content: string,
    target: ClickUpWriteBackTarget,
    format: ClickUpWriteBackFormat
  ): Promise<void> {
    const normalizedTaskId = String(taskId || '').trim();
    if (!normalizedTaskId) {
      throw new Error('ClickUp write-back requires a task ID.');
    }

    const normalizedContent = String(content || '').trim();
    if (!normalizedContent) {
      throw new Error('ClickUp write-back requires non-empty content.');
    }

    if (target === 'comment') {
      const commentResult = await this.retry(() =>
        this.httpRequest('POST', `/task/${normalizedTaskId}/comment`, {
          comment_text: normalizedContent,
          notify_all: false
        })
      );
      if (commentResult.status !== 200) {
        throw new Error(`Failed to comment on ClickUp task ${normalizedTaskId}.`);
      }
      return;
    }

    const taskResult = await this.retry(() =>
      this.httpRequest('GET', `/task/${normalizedTaskId}`)
    );
    if (taskResult.status !== 200) {
      throw new Error(`Failed to load ClickUp task ${normalizedTaskId} for write-back.`);
    }

    const existingDescription = String(
      taskResult.data?.description
      ?? taskResult.data?.markdown_description
      ?? ''
    );
    const updateResult = await this.retry(() =>
      this.httpRequest('PUT', `/task/${normalizedTaskId}`, {
        description: this._mergeWriteBackContent(existingDescription, normalizedContent, format)
      })
    );
    if (updateResult.status !== 200) {
      throw new Error(`Failed to update ClickUp task ${normalizedTaskId}.`);
    }
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

  async applyConfig(options: ClickUpApplyOptions): Promise<{ success: boolean; error?: string }> {
    if (this.setupInProgress) {
      return { success: false, error: 'Setup already in progress' };
    }
    this.setupInProgress = true;

    const previousConfig = await this.loadConfig();
    const config = previousConfig
      ? JSON.parse(JSON.stringify(previousConfig)) as ClickUpConfig
      : this._createEmptyConfig();
    let folderWasCreated = false;

    try {
      let token = await this.getApiToken();
      if (!token) {
        token = await this._promptForApiToken();
        if (!token) {
          return { success: false, error: 'Setup cancelled — ClickUp API token required.' };
        }
        await this._secretStorage.store('switchboard.clickup.apiToken', token);
      }

      const requestedColumns = this._normalizeColumns(options.columns, config);
      const wantsProvisioning = options.createFolder || options.createLists || options.createCustomFields || options.enableRealtimeSync;
      const hasExistingSetup = !!config.folderId || this._hasMappedLists(config) || Object.values(config.customFields).some(Boolean) || config.setupComplete;
      if (!hasExistingSetup && !wantsProvisioning && !options.enableAutoPull) {
        return { success: false, error: 'Select at least one ClickUp option to apply.' };
      }

      if (!config.workspaceId) {
        config.workspaceId = await this._loadWorkspaceId();
      }

      const needsFolder = options.createFolder || options.createLists || options.createCustomFields || options.enableRealtimeSync;
      if (needsFolder && !config.folderId && !config.spaceId) {
        await this._ensureWorkspaceAndSpace(config);
      }

      if (needsFolder) {
        const folderResult = await this._ensureFolder(config, options.createFolder);
        folderWasCreated = folderResult.created;
      }

      if (!options.createFolder && !config.folderId && (options.createLists || options.createCustomFields || options.enableRealtimeSync)) {
        return {
          success: false,
          error: 'ClickUp needs an existing "AI Agents" folder. Enable folder creation or reuse an existing folder first.'
        };
      }

      if (options.createLists) {
        await this._ensureColumnMappings(config, requestedColumns);
      }

      if (options.createCustomFields) {
        if (!this._hasMappedLists(config)) {
          throw new Error('Create custom fields requires at least one mapped ClickUp list.');
        }
        await this._ensureCustomFields(config);
      }

      if (options.enableRealtimeSync) {
        if (!config.folderId) {
          throw new Error('Realtime sync requires an existing ClickUp folder.');
        }
        if (!this._hasMappedLists(config)) {
          throw new Error('Realtime sync requires at least one mapped ClickUp list.');
        }
      }

      if (options.enableAutoPull && !this._hasMappedLists(config)) {
        throw new Error('Auto-pull requires at least one mapped ClickUp list.');
      }

      config.realTimeSyncEnabled = options.enableRealtimeSync === true;
      config.autoPullEnabled = options.enableAutoPull === true;
      config.setupComplete = true;
      await this.saveConfig(config);
      return { success: true };
    } catch (error) {
      if (folderWasCreated) {
        await this._cleanup(config, previousConfig);
      }
      const message = error instanceof Error ? error.message : String(error);
      return { success: false, error: message };
    } finally {
      this.setupInProgress = false;
    }
  }

  /**
   * Clean up ClickUp resources on setup failure.
   * Deleting the folder cascades to child lists.
   */
  private async _cleanup(config: ClickUpConfig, previousConfig?: ClickUpConfig | null): Promise<void> {
    if (config.folderId) {
      try {
        await this.httpRequest('DELETE', `/folder/${config.folderId}`);
      } catch { /* best-effort */ }
    }
    if (previousConfig) {
      await this.saveConfig(previousConfig);
      return;
    }
    try {
      await fs.promises.unlink(this.configPath);
      this._config = null;
    } catch { /* ignore */ }
  }

  // ── Sync Methods ────────────────────────────────────────────

  /**
   * Sync a single plan to ClickUp (Switchboard → ClickUp only).
   * Guarded by _isSyncInProgress to prevent circular loops.
   */
  async syncPlan(plan: KanbanPlanRecord): Promise<ClickUpSyncResult> {
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
        const skippedReason: ClickUpSyncSkipReason = this._hasExplicitColumnMapping(config, plan.kanbanColumn)
          ? 'excluded-column'
          : 'unmapped-column';
        const warning = skippedReason === 'excluded-column'
          ? `ClickUp sync is excluded for column '${plan.kanbanColumn}'.`
          : `ClickUp column '${plan.kanbanColumn}' is not mapped to any ClickUp list.`;
        console.warn(`[ClickUpSync] ${warning}`);
        return {
          success: true,
          warning,
          skippedReason
        };
      }

      const planContent = await this._readPlanContent(plan.planFile);
      const existingTaskId =
        String(plan.clickupTaskId || '').trim()
        || await this._findTaskByPlanId(plan.planId, config);

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
   * Sync plan markdown content to ClickUp task description.
   * Used by ContinuousSyncService for live updates.
   * Does NOT change task status, list, or custom fields.
   */
  async syncPlanContent(taskId: string, markdownContent: string): Promise<{ success: boolean; error?: string }> {
    try {
      const config = await this.loadConfig();
      if (!config?.setupComplete) {
        return { success: false, error: 'ClickUp not set up' };
      }

      // Convert markdown to ClickUp description format (if needed)
      // ClickUp API accepts markdown directly in description field
      const response = await this.httpRequest('PUT', `/task/${taskId}`, {
        description: markdownContent
      });

      if (response.status === 200) {
        return { success: true };
      } else {
        return { success: false, error: `ClickUp API error: ${response.status}` };
      }
    } catch (error) {
      return { success: false, error: `Sync failed: ${error}` };
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
      custom_fields: [
        ...(config.customFields.sessionId
          ? [{ id: config.customFields.sessionId, value: plan.sessionId }] : []),
        ...(config.customFields.planId
          ? [{ id: config.customFields.planId, value: plan.planId }] : []),
        ...(config.customFields.syncTimestamp
          ? [{ id: config.customFields.syncTimestamp, value: Date.now() }] : [])
      ]
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
  debouncedSync(
    sessionId: string,
    plan: KanbanPlanRecord,
    onComplete?: (result: ClickUpSyncResult) => void
  ): void {
    const existing = this.debounceTimers.get(sessionId);
    if (existing) { clearTimeout(existing); }

    const timer = setTimeout(async () => {
      const result = await this.syncPlan(plan);
      onComplete?.(result);
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
      const tasks = await this.listTasksFromClickUp(listId);

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

        const handledByAutomation = config.automationRules.some((rule) =>
          matchesClickUpAutomationRule(task, listId, rule)
        );
        if (handledByAutomation) { skipped++; continue; }

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
          `> **ClickUp Task ID:** ${task.id}`,
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
