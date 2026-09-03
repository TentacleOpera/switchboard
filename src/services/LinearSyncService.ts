import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as http from 'http';
import * as https from 'https';
import * as crypto from 'crypto';
import { hostInlineImages } from './ImageHostingHelper';
import { CANONICAL_COLUMNS } from './ClickUpSyncService';
import { KanbanDatabase } from './KanbanDatabase';
import type { AutoPullIntervalMinutes } from './IntegrationAutoPullService';
import { DEFAULT_LIVE_SYNC_CONFIG } from '../models/LiveSyncTypes';
import {
  type LinearAutomationRule,
  normalizeLinearAutomationRules
} from '../models/PipelineDefinition';
import { GlobalIntegrationConfigService } from './GlobalIntegrationConfigService';
import { stampMarker, truncateForComment } from './commentMarker';
import { localizeHttpError } from './errorMessages';
import { isLoopbackHostHeader } from '../utils/loopbackHostname';

/** Escape untrusted text before it lands in the OAuth callback's HTML response. */
function _escapeHtml(value: string): string {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export interface LinearOAuthTokens {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  tokenType?: string;
  scope?: string[];
  actor?: 'app' | 'user';
  createdAt?: number;
}

export interface LinearOAuthRefreshLease {
  ownerId: string;
  expiresAt: number;
}

export type LinearCredentialKind = 'oauth' | 'apiKey' | 'none';

export interface LinearRateLimitState {
  requestsLimit?: number;
  requestsRemaining?: number;
  requestsReset?: number;
  complexity?: number;
  complexityLimit?: number;
  complexityRemaining?: number;
  complexityReset?: number;
  actorKind: 'app' | 'user';
}

export interface LinearPKCEFlowState {
  codeVerifier: string;
  codeChallenge: string;
  state: string;
  redirectUri: string;
  createdAt: number;
}

/**
 * Switchboard's published Linear OAuth client id. Public by design — PKCE means
 * no secret ships — but it is a value Linear ISSUES, not one we choose, so it is
 * empty until the app is registered and overridable per-install for operators
 * who register their own app (`switchboard.linear.oauthClientId`, or the
 * SWITCHBOARD_LINEAR_CLIENT_ID env var for headless hosts).
 *
 * `resolveLinearOAuthClientId()` is the only read path: an unset id must REFUSE
 * the flow with a message the operator can act on, never build an authorize URL
 * that Linear answers with an opaque `invalid_client`.
 */
export const LINEAR_OAUTH_CLIENT_ID = '';

export function resolveLinearOAuthClientId(): string {
  const fromEnv = String(process.env.SWITCHBOARD_LINEAR_CLIENT_ID || '').trim();
  if (fromEnv) { return fromEnv; }
  try {
    const fromSetting = String(
      vscode.workspace.getConfiguration('switchboard').get<string>('linear.oauthClientId') || ''
    ).trim();
    if (fromSetting) { return fromSetting; }
  } catch { /* no vscode config in some hosts */ }
  return LINEAR_OAUTH_CLIENT_ID;
}

const LINEAR_OAUTH_UNREGISTERED_MESSAGE =
  'Linear OAuth is not configured: no client id is available. Register a Linear OAuth '
  + 'application with actor=app and set `switchboard.linear.oauthClientId` (or the '
  + 'SWITCHBOARD_LINEAR_CLIENT_ID environment variable). The personal API key path is unaffected.';
export const LINEAR_AUTH_URL = 'https://linear.app/oauth/authorize';
export const LINEAR_TOKEN_HOST = 'api.linear.app';
export const LINEAR_TOKEN_PATH = '/oauth/token';
/** Set once this workspace has created at least one Linear `blocks` relation, so a
 *  workspace that never uses dependencies skips the reconciler's queries entirely. */
const LINEAR_RELATIONS_TOUCHED_KEY = 'switchboard.linear.relationsTouched';

export const LINEAR_OAUTH_SCOPES = ['read', 'write', 'issues:create', 'comments:create', 'app:assignable', 'app:mentionable'];


export interface LinearConfig {
  teamId: string;
  teamName: string;
  includeProjectNames?: string[];
  excludeProjectNames?: string[];
  columnToStateId: Record<string, string>;
  switchboardLabelId: string;
  setupComplete: boolean;
  lastSync: string | null;
  realTimeSyncEnabled: boolean;
  autoPullEnabled: boolean;
  pullIntervalMinutes: AutoPullIntervalMinutes;
  automationRules: LinearAutomationRule[];
  deleteSyncEnabled?: boolean;  // default: false — archive Linear issue when plan is deleted (opt-in)
  inboundDeleteEnabled?: boolean;  // default: false — tombstone local plan when Linear issue is deleted (provider-sync inbound-delete)
  completeSyncEnabled?: boolean;  // default: true — sync completed status to Linear
  excludeBacklog?: boolean;  // default: true — exclude backlog issues from sync
  selectedProjectName: string;  // Persisted project picker value for sidebar filter
  ticketSaveLocation?: string;  // base dir for local ticket .md files (set via Setup / migration)
}

export interface LinearApplyOptions {
  mapColumns: boolean;
  createLabel: boolean;
  includeProjectNames?: string[];
  excludeProjectNames?: string[];
  enableRealtimeSync: boolean;
  enableAutoPull: boolean;
  deleteSyncEnabled?: boolean;
  inboundDeleteEnabled?: boolean;
  enableCompleteSync?: boolean;
  excludeBacklog?: boolean;  // NEW: exclude backlog issues from sync
}

export interface LinearIssue {
  id: string;
  identifier: string;
  title: string;
  description: string;
  state: { id: string; name: string; type: string } | null;
  priority: number | null;
  assignee: { id: string; name: string; email: string } | null;
  project: { id: string; name: string } | null;
  labels: Array<{ id: string; name: string }>;
  createdAt: string;
  updatedAt: string;
  url: string;
  parentId: string | null;
}

export interface LinearComment {
  id: string;
  body: string;
  user: { id?: string; name: string; email?: string } | null;
  createdAt: string;
  parentId?: string | null;
  mentions?: Array<{ id: string; name: string }>;
}

export interface LinearAttachment {
  id: string;
  title: string;
  url: string;
  filename?: string;
  filesize?: number;
  mimeType?: string;
}

export type LinearIssueFilter = {
  team: { id: { eq: string } };
  project?: { id: { eq: string } };
  updatedAt?: { gt: string };
};

export function buildLinearIssueFilter(teamId: string, projectId?: string, updatedAfter?: string): LinearIssueFilter {
  const normalizedTeamId = String(teamId || '').trim();
  if (!normalizedTeamId) {
    throw new Error('Linear issue list queries require a team ID.');
  }

  const normalizedProjectId = String(projectId || '').trim();
  const filter: LinearIssueFilter = {
    team: { id: { eq: normalizedTeamId } }
  };

  if (normalizedProjectId) {
    filter.project = { id: { eq: normalizedProjectId } };
  }

  // Delta filter: Linear's GraphQL IssueFilter accepts updatedAt as a
  // DateComparator with gt operator. Value is ISO 8601 (DateTimeOrDuration).
  if (updatedAfter) {
    filter.updatedAt = { gt: updatedAfter };
  }

  return filter;
}

export { CANONICAL_COLUMNS };

const LINEAR_API_HOST = 'api.linear.app';
const LINEAR_API_PATH = '/graphql';

export class LinearSyncService {
  private _workspaceRoot: string;
  private _syncMapPath: string;
  private _config: LinearConfig | null = null;
  private _secretStorage: vscode.SecretStorage;
  private _setupInProgress = false;
  private _isSyncInProgress = false;
  private _consecutiveFailures = 0;
  private _debounceTimers: Map<string, NodeJS.Timeout> = new Map();
  private readonly _maxRetries = 3;
  private _lastRequestTime = 0;
  private readonly _minDelayMs = 50;

  // Cache service for issue caching
  private _cacheService: import('./PlanningPanelCacheService').PlanningPanelCacheService | null = null;
  private _tokenPresentCache: boolean | null = null;

  // OAuth and Rate Limiting state
  private _inFlightPKCE: LinearPKCEFlowState | null = null;
  private _hostId: string = 'host-' + process.pid + '-' + crypto.randomBytes(4).toString('hex');
  private _lastRateLimitState: LinearRateLimitState | null = null;
  private _oauthLoopbackServer: http.Server | null = null;

  // Reverse map: issueId -> projectId for efficient cache invalidation
  private _issueProjectIndex: Map<string, string> = new Map();
  private _cachedProjects: { id: string; name: string }[] | null = null;
  /**
   * Cached team members for the mention picker.
   * 5-minute TTL (matches _cachedProjects pattern).
   */
  private _cachedMembers: { data: Array<{ id: string; name: string; email: string }>; fetchedAt: number } | null = null;
  private static readonly MEMBERS_TTL_MS = 5 * 60 * 1000;

  private static readonly _transientMarkers = [
    'socket hang up',
    'ETIMEDOUT',
    'ECONNRESET',
    'ECONNREFUSED',
    'EPIPE',
    'EAI_AGAIN',
    'timeout',
    'network error',
    '429',
    'rate limit',
    'too many requests'
  ];

  private _isTransientError(error: unknown): boolean {
    const message = (error instanceof Error ? error.message : String(error)).toLowerCase();
    return LinearSyncService._transientMarkers.some(marker => message.includes(marker.toLowerCase()));
  }

  private async _throttle(): Promise<void> {
    const now = Date.now();
    const elapsed = now - this._lastRequestTime;
    if (elapsed < this._minDelayMs) {
      await this.delay(this._minDelayMs - elapsed);
    }
    this._lastRequestTime = Date.now();
  }

  // NOTE: no `configPath` getter — Linear config lives in the machine-global
  // store (see loadConfig/saveConfig, which go through
  // GlobalIntegrationConfigService). The old getter returned
  // <workspace>/.switchboard/linear-config.json, a path nothing has written since
  // that migration, so every reader got a stale/absent file while the real
  // config sat in the global store. It had no production callers.
  constructor(workspaceRoot: string, secretStorage: vscode.SecretStorage) {
    this._workspaceRoot = workspaceRoot;
    this._syncMapPath = path.join(workspaceRoot, '.switchboard', 'linear-sync.json');
    this._secretStorage = secretStorage;
  }

  /**
   * Inject the cache service for issue caching.
   */
  public setCacheService(cacheService: import('./PlanningPanelCacheService').PlanningPanelCacheService): void {
    this._cacheService = cacheService;
  }

  // ── Config I/O ───────────────────────────────────────────────

  private _createEmptyConfig(): LinearConfig {
    return {
      teamId: '',
      teamName: '',
      includeProjectNames: undefined,
      excludeProjectNames: undefined,
      columnToStateId: {},
      switchboardLabelId: '',
      setupComplete: false,
      lastSync: null,
      realTimeSyncEnabled: false,
      autoPullEnabled: false,
      pullIntervalMinutes: 60,
      automationRules: [],
      deleteSyncEnabled: false,  // default false — require explicit opt-in
      completeSyncEnabled: true,
      excludeBacklog: true,  // default to excluding backlog for lightweight sync
      selectedProjectName: ''  // default to no project selected
    };
  }

  private _normalizeConfig(raw: Partial<LinearConfig> | null): LinearConfig | null {
    if (!raw) {
      return null;
    }

    const interval = raw.pullIntervalMinutes;
    const normalizedInterval: AutoPullIntervalMinutes =
      interval === 5 || interval === 15 || interval === 30 || interval === 60 ? interval : 60;

    const normalizeNameArray = (arr: unknown): string[] | undefined => {
      if (!Array.isArray(arr)) return undefined;
      const normalized = arr
        .map((item: unknown) => String(item || '').trim())
        .filter((name: string) => name.length > 0);
      return normalized.length > 0 ? normalized : undefined;
    };

    return {
      teamId: raw.teamId || '',
      teamName: raw.teamName || '',
      includeProjectNames: normalizeNameArray(raw.includeProjectNames),
      excludeProjectNames: normalizeNameArray(raw.excludeProjectNames),
      columnToStateId: raw.columnToStateId || {},
      switchboardLabelId: raw.switchboardLabelId || '',
      setupComplete: raw.setupComplete === true,
      lastSync: raw.lastSync || null,
      realTimeSyncEnabled: raw.realTimeSyncEnabled === undefined
        ? raw.setupComplete === true
        : raw.realTimeSyncEnabled === true,
      autoPullEnabled: raw.autoPullEnabled === true,
      pullIntervalMinutes: normalizedInterval,
      automationRules: normalizeLinearAutomationRules(raw.automationRules),
      deleteSyncEnabled: raw.deleteSyncEnabled === undefined
        ? false  // Changed from (raw.setupComplete === true) — require explicit opt-in for ALL users
        : raw.deleteSyncEnabled === true,
      inboundDeleteEnabled: raw.inboundDeleteEnabled === undefined
        ? false  // Default false — require explicit opt-in (provider-sync inbound-delete)
        : raw.inboundDeleteEnabled === true,
      completeSyncEnabled: raw.completeSyncEnabled !== false,  // default true
      excludeBacklog: raw.excludeBacklog !== false,  // default true — exclude backlog issues
      selectedProjectName: raw.selectedProjectName || '',  // normalize missing/undefined to empty string
      ticketSaveLocation: raw.ticketSaveLocation || '',
    };
  }

  async loadConfig(): Promise<LinearConfig | null> {
    try {
      const raw = await GlobalIntegrationConfigService.loadConfig('linear') as (LinearConfig & { projectId?: string }) | null;
      if (!raw) return null;

      // Migration: legacy projectId → includeProjectNames
      if (raw.projectId && (!raw.includeProjectNames || raw.includeProjectNames.length === 0)) {
        try {
          const resolvedName = await this._resolveProjectIdToName(raw.projectId);
          if (resolvedName) {
            console.log(`[LinearSync] Migrating legacy projectId to includeProjectNames: ${resolvedName}`);
            raw.includeProjectNames = [resolvedName];
            delete raw.projectId;
            // Save migrated config
            await GlobalIntegrationConfigService.saveConfig('linear', raw, { replace: true });
          } else {
            console.warn(`[LinearSync] Failed to resolve legacy projectId to name, deferring migration. API may be unavailable.`);
          }
        } catch (error) {
          console.warn(`[LinearSync] Migration deferred due to error:`, error);
        }
      }

      const normalized = this._normalizeConfig(raw);
      this._config = normalized;
      return normalized;
    } catch { return null; }
  }

  public getTeamName(): string {
    return this._config?.teamName || '_unknown';
  }

  public getSelectedProjectName(): string {
    return this._config?.selectedProjectName || '';
  }

  async saveConfig(config: LinearConfig, options?: { replace?: boolean }): Promise<{ saved: boolean; reason?: string }> {
    const stored = await GlobalIntegrationConfigService.loadConfig('linear');
    const overlay = options?.replace ? config : { ...(stored || {}), ...config };
    const normalized = this._normalizeConfig(overlay);
    if (!normalized) {
      throw new Error('Linear config normalization failed');
    }
    const res = await GlobalIntegrationConfigService.saveConfig('linear', normalized, options);
    if (res.saved !== false) {
      this._config = normalized;
      this._cachedProjects = null;
      this._cachedMembers = null;
    }
    return res;
  }

  async saveAutomationSettings(
    automationRules: LinearAutomationRule[]
  ): Promise<void> {
    const config = await this.loadConfig();
    if (!config?.setupComplete) {
      throw new Error('Linear must be set up before saving automation settings.');
    }

    // The normalizer DROPS a rule it cannot resolve (both destinations set, an
    // unknown kind, a column rule with no final column). On the load path that
    // is the right conservative answer; on the SAVE path it is silent data loss
    // — the operator's rule disappears from the stored config with no error.
    // Refuse the whole save instead, which is what "refused at normalization
    // time" was supposed to mean.
    const incoming = Array.isArray(automationRules) ? automationRules : [];
    const normalized = normalizeLinearAutomationRules(incoming);
    if (normalized.length < incoming.length) {
      const kept = new Set(normalized.map((r) => r.name));
      const rejected = incoming
        .map((r) => String((r as any)?.name || '').trim())
        .filter((n) => n && !kept.has(n));
      throw new Error(
        rejected.length
          ? `Linear automation rules rejected: ${rejected.map((n) => `'${n}'`).join(', ')}. `
            + 'A rule needs a name, a trigger label, at least one trigger state, and exactly one '
            + 'destination (a target column with a final column, or a target team).'
          : 'One or more Linear automation rules were incomplete and could not be saved.'
      );
    }

    await this.saveConfig({
      ...config,
      automationRules: normalized
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

  private _normalizeLinearIssue(raw: any): LinearIssue {
    return {
      id: String(raw?.id || '').trim(),
      identifier: String(raw?.identifier || '').trim(),
      title: String(raw?.title || '').trim(),
      description: String(raw?.description || ''),
      state: raw?.state
        ? {
          id: String(raw.state.id || '').trim(),
          name: String(raw.state.name || '').trim(),
          type: String(raw.state.type || '').trim()
        }
        : null,
      priority: raw?.priority === undefined || raw?.priority === null || Number(raw.priority) === 0 ? null : Number(raw.priority),
      assignee: raw?.assignee
        ? {
          id: String(raw.assignee.id || '').trim(),
          name: String(raw.assignee.name || '').trim(),
          email: String(raw.assignee.email || '').trim()
        }
        : null,
      project: raw?.project
        ? {
          id: String(raw.project.id || '').trim(),
          name: String(raw.project.name || '').trim()
        }
        : null,
      labels: Array.isArray(raw?.labels?.nodes)
        ? raw.labels.nodes.map((label: any) => ({
          id: String(label?.id || '').trim(),
          name: String(label?.name || '').trim()
        })).filter((label: { id: string; name: string }) => label.id.length > 0 || label.name.length > 0)
        : [],
      createdAt: String(raw?.createdAt || '').trim(),
      updatedAt: String(raw?.updatedAt || '').trim(),
      url: String(raw?.url || '').trim(),
      parentId: String(raw?.parent?.id || '').trim() || null
    };
  }

  private _normalizeLinearComment(raw: any): LinearComment {
    // Parse Linear mention syntax from body: <@uuid> tokens
    const body = String(raw?.body || '');
    const mentions: Array<{ id: string; name: string }> = [];
    const mentionRegex = /<@([a-f0-9-]+)>/gi;
    let m: RegExpExecArray | null;
    while ((m = mentionRegex.exec(body)) !== null) {
      mentions.push({ id: m[1], name: '' });
    }

    return {
      id: String(raw?.id || '').trim(),
      body,
      user: raw?.user
        ? {
          id: String(raw.user.id || '').trim() || undefined,
          name: String(raw.user.name || '').trim(),
          email: String(raw.user.email || '').trim() || undefined
        }
        : null,
      createdAt: String(raw?.createdAt || '').trim(),
      parentId: raw?.parent?.id ? String(raw.parent.id).trim() : null,
      mentions
    };
  }

  private _normalizeLinearAttachment(raw: any): LinearAttachment {
    const title = String(raw?.title || '').trim();
    const url = String(raw?.url || '').trim();
    const metadata = raw?.metadata && typeof raw.metadata === 'object' ? raw.metadata : {};
    const subtitle = String(raw?.subtitle || '').trim();
    const derivedFilename = subtitle
      || title
      || (url ? url.split('/').filter(Boolean).pop() || '' : '');
    const filesizeValue = Number(metadata?.size);
    return {
      id: String(raw?.id || '').trim(),
      title,
      url,
      filename: derivedFilename || undefined,
      filesize: Number.isFinite(filesizeValue) && filesizeValue > 0 ? filesizeValue : undefined,
      mimeType: String(metadata?.contentType || metadata?.mimeType || '').trim() || undefined
    };
  }

  private _buildIssueListQuery(): string {
    return `
      query($filter: IssueFilter!, $after: String, $first: Int!) {
        issues(
          filter: $filter
          after: $after
          first: $first
        ) {
          nodes {
            id
            identifier
            title
            description
            state { id name type }
            priority
            assignee { id name email }
            project { id name }
            labels { nodes { id name } }
            parent { id }
            createdAt
            updatedAt
            url
          }
          pageInfo { hasNextPage endCursor }
        }
      }
    `;
  }

  private _isIssueIdentifier(value: string): boolean {
    return /^[A-Z][A-Z0-9_]*-\d+$/.test(value);
  }

  private _buildFallbackDescription(planFile: string): string {
    return `Managed by Switchboard.\n\nPlan file: \`${planFile}\`\n\nDo not edit the title — it is synced from Switchboard.`;
  }

  private _truncateInitialDescription(markdownContent: string): string {
    const maxBytes = DEFAULT_LIVE_SYNC_CONFIG.maxContentSizeBytes;
    const suffix = '\n\n... (truncated by Switchboard before Linear issue creation)';

    if (Buffer.byteLength(markdownContent, 'utf8') <= maxBytes) {
      return markdownContent;
    }

    let end = markdownContent.length;
    while (end > 0 && Buffer.byteLength(`${markdownContent.slice(0, end)}${suffix}`, 'utf8') > maxBytes) {
      end--;
    }

    return `${markdownContent.slice(0, end)}${suffix}`;
  }

  /**
   * Strip a leading ATX H1 header from markdown content.
   * Only strips if the first non-blank line starts with '# ' at column 0.
   * Also skips blank lines immediately after the H1 to avoid a leading blank line.
   * Does NOT handle Setext-style H1s (underlined with ===).
   */
  public _stripH1Header(markdownContent: string): string {
    const lines = markdownContent.split(/\r?\n/);

    // Find the first non-blank line
    let h1LineIndex = -1;
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].trim() === '') {
        continue;
      }
      // Check if this line is an ATX H1: starts with '# ' at column 0
      if (/^# /.test(lines[i])) {
        h1LineIndex = i;
      }
      // Whether or not it's an H1, stop scanning — we only strip if H1 is the very first non-blank line
      break;
    }

    if (h1LineIndex === -1) {
      // No leading H1 found — return content unchanged
      return markdownContent;
    }

    // Skip the H1 line and any blank lines immediately after it
    let startIndex = h1LineIndex + 1;
    while (startIndex < lines.length && lines[startIndex].trim() === '') {
      startIndex++;
    }

    return lines.slice(startIndex).join('\n');
  }

  private async _buildInitialIssueDescription(planFile: string): Promise<string> {
    const fallback = this._buildFallbackDescription(planFile);
    try {
      const planFilePath = path.isAbsolute(planFile)
        ? planFile
        : path.join(this._workspaceRoot, planFile);
      const markdownContent = await fs.promises.readFile(planFilePath, 'utf8');
      const contentWithoutH1 = this._stripH1Header(markdownContent);
      return this._truncateInitialDescription(contentWithoutH1);
    } catch (error) {
      console.warn(`[LinearSync] Failed to read plan file ${planFile}:`, error);
      return fallback;
    }
  }

  // ── Project Filter Helpers ───────────────────────────────────────

  public async getAvailableProjects(): Promise<{ id: string; name: string }[]> {
    if (this._cachedProjects) {
      return this._cachedProjects;
    }
    const config = await this.loadConfig();
    if (!config?.setupComplete || !config.teamId) {
      throw new Error('Linear not configured');
    }

    const result = await this.graphqlRequest(`
      query($teamId: String!) { team(id: $teamId) { projects { nodes { id name } } } }
    `, { teamId: config.teamId });

    const projects = Array.isArray(result.data?.team?.projects?.nodes)
      ? result.data.team.projects.nodes
      : [];
    const mapped = projects.map((project: any) => ({
      id: String(project?.id || '').trim(),
      name: String(project?.name || '').trim()
    })).filter((project: { id: string; name: string }) => project.id.length > 0 && project.name.length > 0);
    this._cachedProjects = mapped;
    return mapped;
  }

  public async resolveSingleIncludeProjectId(config?: LinearConfig): Promise<string | undefined> {
    const cfg = config || await this.loadConfig();
    if (!cfg) {
      return undefined;
    }
    const includeNames = cfg.includeProjectNames || [];
    const excludeNames = cfg.excludeProjectNames || [];
    if (includeNames.length !== 1 || excludeNames.length > 0) {
      return undefined;
    }
    const projectName = includeNames[0];
    const projects = await this.getAvailableProjects();
    const project = projects.find(p => p.name.toLowerCase() === projectName.toLowerCase());
    return project?.id;
  }

  private async _resolveProjectIdToName(projectId: string): Promise<string | null> {
    try {
      const projects = await this.getAvailableProjects();
      const match = projects.find((p) => p.id === projectId);
      return match?.name || null;
    } catch (error) {
      console.warn(`[LinearSync] Failed to resolve project ID to name:`, error);
      return null;
    }
  }

  private _applyProjectNameFilters(issues: LinearIssue[], config: LinearConfig): LinearIssue[] {
    const includeNames = config.includeProjectNames || [];
    const excludeNames = config.excludeProjectNames || [];

    if (includeNames.length === 0 && excludeNames.length === 0) {
      return issues;
    }

    const includeLower = includeNames.map((n) => n.toLowerCase());
    const excludeLower = excludeNames.map((n) => n.toLowerCase());

    return issues.filter((issue) => {
      const projectName = issue.project?.name || '';

      // Issues with no project: exclude if include filter is set, include otherwise
      if (!projectName) {
        return includeNames.length === 0;
      }

      const projectNameLower = projectName.toLowerCase();

      // Apply exclude filter
      if (excludeLower.includes(projectNameLower)) {
        return false;
      }

      // Apply include filter
      if (includeNames.length > 0) {
        return includeLower.includes(projectNameLower);
      }

      return true;
    });
  }

  private async _resolveSingleIncludeProjectId(config: LinearConfig): Promise<string | undefined> {
    const includeNames = config.includeProjectNames || [];
    const excludeNames = config.excludeProjectNames || [];

    // Only use server-side filter for single include with no excludes
    if (includeNames.length === 1 && excludeNames.length === 0) {
      try {
        const projects = await this.getAvailableProjects();
        const match = projects.find((p) => p.name.toLowerCase() === includeNames[0].toLowerCase());
        return match?.id;
      } catch (error) {
        console.warn(`[LinearSync] Failed to resolve single include project ID, falling back to client-side filtering:`, error);
        return undefined;
      }
    }

    return undefined;
  }

  /**
   * Generate a fingerprint for issue filter options to use in cache keys.
   */
  private _fingerprintIssueFilter(options: {
    search?: string;
    stateId?: string;
    assigneeId?: string;
    projectId?: string;
    limit?: number;
    updatedAfter?: string;
  }): string {
    const parts: string[] = [];
    if (options.search) {
      parts.push(`search:${options.search}`);
    }
    if (options.stateId) {
      parts.push(`state:${options.stateId}`);
    }
    if (options.assigneeId) {
      parts.push(`assignee:${options.assigneeId}`);
    }
    if (options.projectId) {
      parts.push(`project:${options.projectId}`);
    }
    if (options.limit !== undefined) {
      parts.push(`limit:${options.limit}`);
    }
    if (options.updatedAfter) {
      parts.push(`updatedAfter:${options.updatedAfter}`);
    }
    return parts.length > 0 ? parts.join('|') : 'default';
  }

  /**
   * Generate a fingerprint for the LinearConfig filter inputs (include/exclude
   * project names and team) so that cache keys do not collide across config
   * changes. Without this, two callers with the same options but different
   * include/exclude lists would share a cache entry and serve cross-config
   * data.
   */
  private _fingerprintLinearFilterConfig(config: LinearConfig): string {
    const inc = (config.includeProjectNames || []).slice().sort().join(',');
    const exc = (config.excludeProjectNames || []).slice().sort().join(',');
    const team = String(config.teamId || '').trim();
    return `inc=${inc}|exc=${exc}|team=${team}`;
  }

  /**
   * Clear the issueId → projectId reverse index. Used by manual cache
   * refresh to avoid stale invalidation hints after the cache is wiped.
   */
  public clearIssueProjectIndex(): void {
    this._issueProjectIndex.clear();
  }

  public async queryIssues(options: {
    search?: string;
    stateId?: string;
    stateName?: string;
    assigneeId?: string;
    projectId?: string;
    limit?: number;
    updatedAfter?: string;
    projectScoped?: boolean;
  }): Promise<LinearIssue[]> {
    const config = await this.loadConfig();
    if (!config?.setupComplete || !config.teamId) {
      throw new Error('Linear not configured');
    }

    const normalizedSearch = String(options.search || '').trim().toLowerCase();
    const normalizedStateId = String(options.stateId || '').trim();
    const normalizedStateName = String(options.stateName || '').trim().toLowerCase();
    const normalizedAssigneeId = String(options.assigneeId || '').trim();
    const normalizedProjectId = String(options.projectId || '').trim();
    const requestedLimit = Number(options.limit);
    const limit = Number.isFinite(requestedLimit) && requestedLimit > 0
      ? Math.min(Math.floor(requestedLimit), 100)
      : 50;
    const updatedAfter = options.updatedAfter ? String(options.updatedAfter).trim() : '';

    // Determine if this is a "simple" query that can use cache
    // Simple: no search, stateId, stateName, assigneeId, or updatedAfter filters
    // (project comes from config). Delta queries (updatedAfter set) bypass cache.
    const isSimpleQuery = !options.projectScoped && !normalizedSearch && !normalizedStateId && !normalizedStateName && !normalizedAssigneeId && !updatedAfter;
    // Cache key MUST include the filter-config fingerprint so that include/
    // exclude project name changes invalidate the cache via key divergence.
    const configFingerprint = this._fingerprintLinearFilterConfig(config);
    const cacheKey = isSimpleQuery && normalizedProjectId
      ? `project:${normalizedProjectId}:${this._fingerprintIssueFilter(options)}|cfg=${configFingerprint}`
      : `linear:${this._fingerprintIssueFilter(options)}|cfg=${configFingerprint}`;

    // Try cache first for simple queries
    if (isSimpleQuery && this._cacheService) {
      try {
        const cached = this._cacheService.getCachedTasks<LinearIssue>('linear', cacheKey);
        if (cached) {
          return cached;
        }
      } catch (e) {
        // Fail-open: continue to API fetch
        console.warn('[LinearSync] Cache read failed, falling back to API:', e);
      }
    }

    // Resolve project for scoped queries, else hybrid optimization
    let resolvedProjectId: string | undefined = undefined;
    let resolutionFailed = false;
    if (options.projectScoped) {
      if (normalizedProjectId) {
        const projects = await this.getAvailableProjects();
        const byId = projects.find(p => p.id === normalizedProjectId);
        if (byId) {
          resolvedProjectId = byId.id;
        } else {
          const byName = projects.find(p => p.name.toLowerCase() === normalizedProjectId.toLowerCase());
          if (byName) {
            resolvedProjectId = byName.id;
          } else {
            resolutionFailed = true;
          }
        }
      } else {
        resolutionFailed = true;
      }
      if (resolutionFailed) {
        const res = [] as LinearIssue[];
        (res as any).resolutionFailed = true;
        return res;
      }
    } else {
      resolvedProjectId = await this._resolveSingleIncludeProjectId(config) || undefined;
    }

    const filter = buildLinearIssueFilter(config.teamId, resolvedProjectId || undefined, updatedAfter || undefined);

    const issues: LinearIssue[] = [];
    let cursor: string | null = null;
    const query = this._buildIssueListQuery();
    let pageCount = 0;
    const maxPages = options.projectScoped ? 40 : 10; // Hard cap to prevent runaway pagination

    while ((options.projectScoped ? true : issues.length < limit) && pageCount < maxPages) {
      const result = await this.graphqlRequest(query, {
        filter,
        after: cursor,
        first: options.projectScoped ? 50 : Math.min(50, limit - issues.length)
      });

      const page = result.data?.issues;
      const nodes = Array.isArray(page?.nodes) ? page.nodes : [];
      for (const node of nodes) {
        const issue = this._normalizeLinearIssue(node);
        if (normalizedStateId && issue.state?.id !== normalizedStateId) {
          continue;
        }
        if (normalizedStateName && String(issue.state?.name || '').toLowerCase() !== normalizedStateName) {
          continue;
        }
        if (normalizedAssigneeId && issue.assignee?.id !== normalizedAssigneeId) {
          continue;
        }
        if (normalizedSearch) {
          const searchableText = [
            issue.identifier,
            issue.title,
            issue.description
          ].join('\n').toLowerCase();
          if (!searchableText.includes(normalizedSearch)) {
            continue;
          }
        }
        issues.push(issue);
        if (!options.projectScoped && issues.length >= limit) {
          break;
        }
      }

      if (!page?.pageInfo?.hasNextPage) {
        break;
      }
      cursor = String(page.pageInfo.endCursor || '').trim() || null;
      if (!cursor) {
        break;
      }
      pageCount++;
      if (pageCount >= maxPages) {
        console.warn(`[LinearSync] Reached maximum page cap (${maxPages}) for queryIssues. Some issues may be omitted.`);
        (issues as any).reachedPageCap = true;
      }
      await this.delay(200);
    }

    // Apply client-side project name filters
    const filteredIssues = options.projectScoped ? issues : this._applyProjectNameFilters(issues, config);
    if ((issues as any).reachedPageCap) {
      (filteredIssues as any).reachedPageCap = true;
    }

    // Update cache and reverse map for simple queries
    if (isSimpleQuery && this._cacheService) {
      try {
        this._cacheService.cacheTasks('linear', cacheKey, filteredIssues);
        // Update reverse map: issueId -> projectId
        for (const issue of filteredIssues) {
          if (issue.id && normalizedProjectId) {
            this._issueProjectIndex.set(issue.id, normalizedProjectId);
          }
        }
      } catch (e) {
        // Fail-open: cache errors are non-fatal
        console.warn('[LinearSync] Cache write failed:', e);
      }
    }

    return filteredIssues;
  }

  /**
   * Fetch ALL issue IDs for a project, paginating through the complete set
   * without the 100-issue limit cap that queryIssues enforces. Used by the
   * deletion sweep to get the full remote ID set — a naive queryIssues call
   * with limit:100 would return an incomplete set for projects with >100
   * issues, causing the sweep to delete local files for issues 101+ that
   * still exist remotely (a data-loss bug). Returns only IDs to minimize
   * payload size. Bypasses the cache (the sweep needs current live state,
   * not a potentially stale snapshot).
   */
  public async fetchAllIssueIds(projectId: string): Promise<{ ids: Set<string>; complete: boolean }> {
    const config = await this.loadConfig();
    if (!config?.setupComplete || !config.teamId) {
      throw new Error('Linear not configured');
    }
    const resolvedProjectId = await this._resolveSingleIncludeProjectId(config);
    const filter = buildLinearIssueFilter(config.teamId, resolvedProjectId || projectId);

    const ids = new Set<string>();
    let cursor: string | null = null;
    const query = this._buildIssueListQuery();
    let pageCount = 0;
    const maxPages = 50; // Safety cap: 50 pages × 50/page = 2500 issues max
    // `complete` is true ONLY when the loop observed the end of pagination
    // (no next page). A missing cursor or the page-cap exit leaves it false —
    // a truncated run must not authorise a destructive deletion sweep.
    let complete = false;

    while (pageCount < maxPages) {
      const result = await this.graphqlRequest(query, {
        filter,
        after: cursor,
        first: 50
      });
      const page = result.data?.issues;
      const nodes = Array.isArray(page?.nodes) ? page.nodes : [];
      for (const node of nodes) {
        if (node.id) ids.add(String(node.id));
      }
      if (!page?.pageInfo?.hasNextPage) { complete = true; break; }
      cursor = String(page.pageInfo.endCursor || '').trim() || null;
      if (!cursor) break;   // ambiguous truncation — complete stays false
      pageCount++;
      await this.delay(200);
    }
    if (!complete && pageCount >= maxPages) {
      console.warn(`[LinearSync] fetchAllIssueIds reached page cap (${maxPages}). Some issues may be omitted.`);
    }
    return { ids, complete };
  }

  /**
   * Does this issue still exist remotely? Answers for ONE issue, by id, so the
   * caller never has to infer deletion from absence in a paginated list.
   *
   * Two things count as 'deleted': a null `issue` node (or an Entity-not-found
   * GraphQL error), and `trashed: true`. The second matters — Linear's delete is
   * a 30-day trash, and a trashed issue is still fetchable by id, so without the
   * flag a deleted issue reads as alive for a month.
   *
   * Anything else — auth failure, timeout, rate limit, an unrecognised GraphQL
   * error — is 'unknown'. Callers must keep the local file on 'unknown': this
   * probe authorises deletion, so ambiguity has to mean no. Note `getIssue`
   * cannot serve this purpose: it also returns null when an issue exists but
   * falls outside the configured team/project filters.
   */
  public async probeIssueExistence(issueId: string): Promise<'deleted' | 'exists' | 'unknown'> {
    const normalizedId = String(issueId || '').trim();
    if (!normalizedId) { return 'unknown'; }
    try {
      const result = await this.graphqlRequest(
        'query($issueId: String!) { issue(id: $issueId) { id trashed } }',
        { issueId: normalizedId }
      );
      const node = result.data?.issue;
      if (!node) { return 'deleted'; }
      return node.trashed === true ? 'deleted' : 'exists';
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/entity not found|could not find|does not exist/i.test(message)) { return 'deleted'; }
      return 'unknown';
    }
  }

  public async getIssue(issueIdOrIdentifier: string): Promise<LinearIssue | null> {
    const config = await this.loadConfig();
    if (!config?.setupComplete || !config.teamId) {
      throw new Error('Linear not configured');
    }

    const normalizedLookup = String(issueIdOrIdentifier || '').trim();
    if (!normalizedLookup) {
      throw new Error('Linear issue lookup requires an issue ID or identifier.');
    }

    if (!this._isIssueIdentifier(normalizedLookup)) {
      const result = await this.graphqlRequest(`
        query($issueId: String!) {
          issue(id: $issueId) {
            id
            identifier
            title
            description
            state { id name type }
            priority
            assignee { id name email }
            project { id name }
            labels { nodes { id name } }
            parent { id }
            createdAt
            updatedAt
            url
          }
        }
      `, { issueId: normalizedLookup });

      return result.data?.issue ? this._normalizeLinearIssue(result.data.issue) : null;
    }

    const query = this._buildIssueListQuery();
    const resolvedProjectId = await this._resolveSingleIncludeProjectId(config);
    const filter = buildLinearIssueFilter(config.teamId, resolvedProjectId || undefined);
    let cursor: string | null = null;
    while (true) {
      const result = await this.graphqlRequest(query, {
        filter,
        after: cursor,
        first: 50
      });

      const page = result.data?.issues;
      const nodes = Array.isArray(page?.nodes) ? page.nodes : [];
      const match = nodes.find((node: any) =>
        String(node?.identifier || '').trim().toUpperCase() === normalizedLookup.toUpperCase()
      );
      if (match) {
        const issue = this._normalizeLinearIssue(match);
        // Apply client-side project name filters
        const filtered = this._applyProjectNameFilters([issue], config);
        return filtered.length > 0 ? filtered[0] : null;
      }

      if (!page?.pageInfo?.hasNextPage) {
        break;
      }
      cursor = String(page.pageInfo.endCursor || '').trim() || null;
      if (!cursor) {
        break;
      }
      await this.delay(200);
    }

    return null;
  }

  public async getSubtasks(issueId: string): Promise<LinearIssue[]> {
    const config = await this.loadConfig();
    if (!config?.setupComplete || !config.teamId) {
      throw new Error('Linear not configured');
    }

    const normalizedIssueId = String(issueId || '').trim();
    if (!normalizedIssueId) {
      throw new Error('Linear subtasks lookup requires an issue ID.');
    }

    const result = await this.graphqlRequest(`
      query($issueId: String!) {
        issue(id: $issueId) {
          children {
            nodes {
              id
              identifier
              title
              description
              state { id name type }
              priority
              assignee { id name email }
              project { id name }
              labels { nodes { id name } }
              createdAt
              updatedAt
              url
            }
          }
        }
      }
    `, { issueId: normalizedIssueId });

    const children = Array.isArray(result.data?.issue?.children?.nodes)
      ? result.data.issue.children.nodes
      : [];
    return children.map((child: any) => this._normalizeLinearIssue(child));
  }

  public async getComments(issueId: string): Promise<LinearComment[]> {
    const config = await this.loadConfig();
    if (!config?.setupComplete || !config.teamId) {
      throw new Error('Linear not configured');
    }

    const normalizedIssueId = String(issueId || '').trim();
    if (!normalizedIssueId) {
      throw new Error('Linear comment lookup requires an issue ID.');
    }

    const result = await this.graphqlRequest(`
      query($issueId: String!) {
        issue(id: $issueId) {
          comments {
            nodes {
              id
              body
              createdAt
              user { id name email }
              parent { id }
            }
          }
        }
      }
    `, { issueId: normalizedIssueId });

    const comments = Array.isArray(result.data?.issue?.comments?.nodes)
      ? result.data.issue.comments.nodes
      : [];
    return comments.map((comment: any) => this._normalizeLinearComment(comment));
  }

  public async getAttachments(issueId: string): Promise<LinearAttachment[]> {
    const config = await this.loadConfig();
    if (!config?.setupComplete || !config.teamId) {
      throw new Error('Linear not configured');
    }

    const normalizedIssueId = String(issueId || '').trim();
    if (!normalizedIssueId) {
      throw new Error('Linear attachment lookup requires an issue ID.');
    }

    const result = await this.graphqlRequest(`
      query($issueId: String!) {
        issue(id: $issueId) {
          attachments {
            nodes {
              id
              title
              url
            }
          }
        }
      }
    `, { issueId: normalizedIssueId });

    const attachments = Array.isArray(result.data?.issue?.attachments?.nodes)
      ? result.data.issue.attachments.nodes
      : [];
    return attachments.map((attachment: any) => this._normalizeLinearAttachment(attachment));
  }

  public async updateIssueState(issueId: string, stateId: string): Promise<void> {
    const config = await this.loadConfig();
    if (!config?.setupComplete) {
      throw new Error('Linear not configured');
    }

    const normalizedIssueId = String(issueId || '').trim();
    const normalizedStateId = String(stateId || '').trim();
    if (!normalizedIssueId || !normalizedStateId) {
      throw new Error('Linear state updates require both an issue ID and a state ID.');
    }

    const result = await this.graphqlRequest(`
      mutation($id: String!, $stateId: String!) {
        issueUpdate(id: $id, input: { stateId: $stateId }) { success }
      }
    `, { id: normalizedIssueId, stateId: normalizedStateId });

    if (!result.data?.issueUpdate?.success) {
      throw new Error(`Linear issue ${normalizedIssueId} rejected the requested state update.`);
    }

    // Invalidate cache for the project containing this issue
    if (this._cacheService) {
      const projectId = this._issueProjectIndex.get(normalizedIssueId);
      if (projectId) {
        this._cacheService.invalidateTaskCache('linear', `project:${projectId}`);
      } else {
        // Fallback: invalidate all Linear cache if project unknown
        this._cacheService.invalidateTaskCache('linear');
      }
    }
  }

  public async updateIssueAssignee(issueId: string, assigneeId: string | null): Promise<void> {
    const config = await this.loadConfig();
    if (!config?.setupComplete) {
      throw new Error('Linear not configured');
    }

    const normalizedIssueId = String(issueId || '').trim();
    if (!normalizedIssueId) {
      throw new Error('Linear assignee updates require an issue ID.');
    }

    const result = await this.graphqlRequest(`
      mutation($id: String!, $assigneeId: String) {
        issueUpdate(id: $id, input: { assigneeId: $assigneeId }) { success }
      }
    `, { id: normalizedIssueId, assigneeId: assigneeId ? String(assigneeId).trim() : null });

    if (!result.data?.issueUpdate?.success) {
      throw new Error(`Linear issue ${normalizedIssueId} rejected the requested assignee update.`);
    }

    // Invalidate cache for the project containing this issue
    if (this._cacheService) {
      const projectId = this._issueProjectIndex.get(normalizedIssueId);
      if (projectId) {
        this._cacheService.invalidateTaskCache('linear', `project:${projectId}`);
      } else {
        // Fallback: invalidate all Linear cache if project unknown
        this._cacheService.invalidateTaskCache('linear');
      }
    }
  }

  public async updateIssuePriority(issueId: string, priority: number): Promise<void> {
    const config = await this.loadConfig();
    if (!config?.setupComplete) {
      throw new Error('Linear not configured');
    }

    const normalizedIssueId = String(issueId || '').trim();
    if (!normalizedIssueId) {
      throw new Error('Linear priority updates require an issue ID.');
    }

    if (!Number.isInteger(priority) || priority < 0 || priority > 4) {
      throw new Error('Linear priority must be an integer between 0 and 4.');
    }

    const result = await this.graphqlRequest(`
      mutation($id: String!, $priority: Int!) {
        issueUpdate(id: $id, input: { priority: $priority }) { success }
      }
    `, { id: normalizedIssueId, priority });

    if (!result.data?.issueUpdate?.success) {
      throw new Error(`Linear issue ${normalizedIssueId} rejected the requested priority update.`);
    }

    // Invalidate cache for the project containing this issue
    if (this._cacheService) {
      const projectId = this._issueProjectIndex.get(normalizedIssueId);
      if (projectId) {
        this._cacheService.invalidateTaskCache('linear', `project:${projectId}`);
      } else {
        // Fallback: invalidate all Linear cache if project unknown
        this._cacheService.invalidateTaskCache('linear');
      }
    }
  }

  public async updateIssueLabels(issueId: string, labelIds: string[]): Promise<void> {
    const config = await this.loadConfig();
    if (!config?.setupComplete) {
      throw new Error('Linear not configured');
    }

    const normalizedIssueId = String(issueId || '').trim();
    if (!normalizedIssueId) {
      throw new Error('Linear label updates require an issue ID.');
    }

    const result = await this.graphqlRequest(`
      mutation($id: String!, $labelIds: [String!]!) {
        issueUpdate(id: $id, input: { labelIds: $labelIds }) { success }
      }
    `, { id: normalizedIssueId, labelIds });

    if (!result.data?.issueUpdate?.success) {
      throw new Error(`Linear issue ${normalizedIssueId} rejected the requested label update.`);
    }

    // Invalidate cache
    if (this._cacheService) {
      const projectId = this._issueProjectIndex.get(normalizedIssueId);
      if (projectId) {
        this._cacheService.invalidateTaskCache('linear', `project:${projectId}`);
      } else {
        this._cacheService.invalidateTaskCache('linear');
      }
    }
  }

  public async updateIssueParent(issueId: string, parentId: string | null): Promise<void> {
    const config = await this.loadConfig();
    if (!config?.setupComplete) {
      throw new Error('Linear not configured');
    }

    const normalizedIssueId = String(issueId || '').trim();
    if (!normalizedIssueId) {
      throw new Error('Linear parent updates require an issue ID.');
    }

    const result = await this.graphqlRequest(`
      mutation($id: String!, $parentId: String) {
        issueUpdate(id: $id, input: { parentId: $parentId }) { success }
      }
    `, { id: normalizedIssueId, parentId: parentId || null });

    if (!result.data?.issueUpdate?.success) {
      throw new Error(`Linear issue ${normalizedIssueId} rejected the requested parent update.`);
    }

    if (this._cacheService) {
      const projectId = this._issueProjectIndex.get(normalizedIssueId);
      if (projectId) {
        this._cacheService.invalidateTaskCache('linear', `project:${projectId}`);
      } else {
        this._cacheService.invalidateTaskCache('linear');
      }
    }
  }

  public async updateIssueProject(issueId: string, projectId: string | null): Promise<void> {
    const config = await this.loadConfig();
    if (!config?.setupComplete) {
      throw new Error('Linear not configured');
    }

    const normalizedIssueId = String(issueId || '').trim();
    if (!normalizedIssueId) {
      throw new Error('Linear project updates require an issue ID.');
    }

    const result = await this.graphqlRequest(`
      mutation($id: String!, $projectId: String) {
        issueUpdate(id: $id, input: { projectId: $projectId }) { success }
      }
    `, { id: normalizedIssueId, projectId: projectId || null });

    if (!result.data?.issueUpdate?.success) {
      throw new Error(`Linear issue ${normalizedIssueId} rejected the project update.`);
    }

    // Invalidate cache for BOTH the old project and the new project
    if (this._cacheService) {
      const oldProjectId = this._issueProjectIndex.get(normalizedIssueId);
      if (oldProjectId) {
        this._cacheService.invalidateTaskCache('linear', `project:${oldProjectId}`);
      }
      if (projectId) {
        this._cacheService.invalidateTaskCache('linear', `project:${projectId}`);
      } else {
        // If moving to no project, invalidate all Linear cache as fallback
        this._cacheService.invalidateTaskCache('linear');
      }
      // Update the reverse map
      if (projectId) {
        this._issueProjectIndex.set(normalizedIssueId, projectId);
      } else {
        this._issueProjectIndex.delete(normalizedIssueId);
      }
    }
  }

  public async addIssueComment(issueId: string, comment: string, options?: { parentId?: string; mentions?: Array<{ id: string; name: string }> }): Promise<{ success: boolean; error?: string }> {
    const config = await this.loadConfig();
    if (!config?.setupComplete) {
      throw new Error('Linear not configured');
    }

    const normalizedIssueId = String(issueId || '').trim();
    const normalizedComment = String(comment || '').trim();
    if (!normalizedIssueId || !normalizedComment) {
      throw new Error('Linear comments require both an issue ID and non-empty comment text.');
    }

    // Encode mentions into the body using Linear's <@uuid> syntax.
    // Verification gate: if Linear doesn't parse <@uuid>, the text is still
    // visible (safe fallback — no notification, but readable).
    let body = normalizedComment;
    const mentions = Array.isArray(options?.mentions) ? options!.mentions : [];
    if (mentions.length > 0) {
      for (const mention of mentions) {
        // UI inserts @{id} tokens; replace with <@uuid> for Linear
        body = body.replace(new RegExp(`@\\{${mention.id}\\}`, 'g'), `<@${mention.id}>`);
      }
    }

    const parentId = String(options?.parentId || '').trim() || undefined;
    const inputFields = parentId
      ? 'issueId: $issueId, body: $body, parentId: $parentId'
      : 'issueId: $issueId, body: $body';
    const vars: Record<string, string> = { issueId: normalizedIssueId, body };
    if (parentId) { vars.parentId = parentId; }

    try {
      const result = await this.graphqlRequest(`
        mutation($issueId: String!, $body: String!${parentId ? ', $parentId: String!' : ''}) {
          commentCreate(input: { ${inputFields} }) {
            success
          }
        }
      `, vars);

      if (!result.data?.commentCreate?.success) {
        // If parentId was rejected, retry without it (flat comment fallback)
        if (parentId) {
          console.warn('[LinearSync] Linear commentCreate with parentId failed, retrying as flat comment.');
          const fallbackResult = await this.graphqlRequest(`
            mutation($issueId: String!, $body: String!) {
              commentCreate(input: { issueId: $issueId, body: $body }) { success }
            }
          `, { issueId: normalizedIssueId, body });
          if (!fallbackResult.data?.commentCreate?.success) {
            return { success: false, error: `Linear issue ${normalizedIssueId} rejected the comment.` };
          }
          return { success: true };
        }
        return { success: false, error: `Linear issue ${normalizedIssueId} rejected the comment.` };
      }
      return { success: true };
    } catch (e) {
      // If parentId caused a GraphQL error, retry as flat comment
      if (parentId) {
        console.warn('[LinearSync] Linear commentCreate with parentId threw, retrying as flat comment:', e);
        const fallbackResult = await this.graphqlRequest(`
          mutation($issueId: String!, $body: String!) {
            commentCreate(input: { issueId: $issueId, body: $body }) { success }
          }
        `, { issueId: normalizedIssueId, body });
        if (!fallbackResult.data?.commentCreate?.success) {
          return { success: false, error: `Linear issue ${normalizedIssueId} rejected the comment.` };
        }
        return { success: true };
      }
      throw e;
    }
  }

  /**
   * §8 — host-side shared comment write-back primitive.
   *
   * Runs in the extension host (which holds the SecretStorage token), stamps the
   * self-marker, and truncates to Linear's comment size limit. Used by triage
   * write-back (§6), agent replies (§7/§9), and the sync-mode question directive
   * (§11). Agents reach it through the LocalApiServer `/comment` route — they never
   * call the provider API directly and never touch the marker, so they cannot break
   * the feedback-loop guard.
   */
  public async postManagedComment(issueId: string, body: string): Promise<{ success: boolean; error?: string }> {
    // Linear has no hard documented comment cap; 64k is a generous safety bound.
    const truncated = truncateForComment(body, 64000);
    const stamped = stampMarker(truncated);
    return this.addIssueComment(issueId, stamped);
  }

  /**
   * §7/§9 — Remote Control poll. Fetch current state + recent comments for a set of
   * synced issues in one batched query. Returns a map keyed by issue UUID. Comments
   * include their author flag so the caller can skip Switchboard's own comments via
   * the marker (the body is returned verbatim; marker filtering happens in the caller).
   */
  public async fetchIssueUpdates(issueIds: string[]): Promise<Record<string, {
    stateId: string;
    stateName: string;
    stateType: string;
    comments: Array<{ id: string; body: string; createdAt: string; author: string }>;
  }>> {
    const result: Record<string, { stateId: string; stateName: string; stateType: string; comments: Array<{ id: string; body: string; createdAt: string; author: string }> }> = {};
    const ids = (issueIds || []).map((s) => String(s || '').trim()).filter(Boolean);
    if (ids.length === 0) { return result; }

    const config = await this.loadConfig();
    if (!config?.setupComplete) { return result; }

    const QUERY = `
      query($ids: [ID!]) {
        issues(filter: { id: { in: $ids } }, first: 100) {
          nodes {
            id
            state { id name type }
            comments(first: 50) { nodes { id body createdAt user { name } } }
          }
        }
      }
    `;
    try {
      const resp = await this.graphqlRequest(QUERY, { ids });
      const nodes = resp?.data?.issues?.nodes || [];
      for (const node of nodes) {
        result[node.id] = {
          stateId: node.state?.id || '',
          stateName: node.state?.name || '',
          stateType: (node.state?.type || '').toLowerCase(),
          comments: (node.comments?.nodes || []).map((c: any) => ({
            id: String(c.id || ''),
            body: String(c.body || ''),
            createdAt: String(c.createdAt || ''),
            author: String(c.user?.name || '')
          }))
        };
      }
    } catch (e) {
      console.warn('[LinearSync] fetchIssueUpdates failed:', e);
    }
    return result;
  }

  // ── Comment Manager: threading + members ──────────────────────────

  /**
   * Fetch comments for an issue and rebuild threads client-side.
   * Linear returns comments flat with optional parent { id }.
   * Replies whose parent isn't in the batch go into an orphan bucket
   * (console.warn) — they are NOT dropped.
   */
  public async getCommentThreads(issueId: string): Promise<{
    threads: Array<{
      id: string;
      author: { id: string; name: string; email: string };
      body: string;
      date: string;
      mentions: Array<{ id: string; name: string }>;
      replies: Array<{
        id: string;
        author: { id: string; name: string; email: string };
        body: string;
        date: string;
        mentions: Array<{ id: string; name: string }>;
      }>;
    }>;
    threadingSupported: boolean;
  }> {
    const comments = await this.getComments(issueId);

    const topLevel = comments.filter(c => !c.parentId);
    const repliesByParent = new Map<string, typeof comments>();
    const orphans: typeof comments = [];

    for (const comment of comments) {
      if (comment.parentId) {
        const hasParent = comments.some(c => c.id === comment.parentId);
        if (hasParent) {
          const bucket = repliesByParent.get(comment.parentId) || [];
          bucket.push(comment);
          repliesByParent.set(comment.parentId, bucket);
        } else {
          console.warn(`[LinearSync] Orphan reply ${comment.id} — parent ${comment.parentId} not in batch.`);
          orphans.push(comment);
        }
      }
    }

    const toThread = (c: typeof comments[0]) => ({
      id: c.id,
      author: {
        id: String(c.user?.id || '').trim(),
        name: String(c.user?.name || '').trim(),
        email: String(c.user?.email || '').trim()
      },
      body: c.body,
      date: c.createdAt,
      mentions: c.mentions || [],
      replies: (repliesByParent.get(c.id) || []).map(r => ({
        id: r.id,
        author: {
          id: String(r.user?.id || '').trim(),
          name: String(r.user?.name || '').trim(),
          email: String(r.user?.email || '').trim()
        },
        body: r.body,
        date: r.createdAt,
        mentions: r.mentions || []
      }))
    });

    const threads = topLevel.map(toThread);
    // Orphans (replies whose parent isn't in this batch) are surfaced as
    // top-level threads so they're visible rather than dropped.
    for (const orphan of orphans) {
      threads.push(toThread(orphan));
    }

    return { threads, threadingSupported: true };
  }

  /**
   * Reply to an existing Linear comment.
   * Uses addIssueComment with parentId — Linear's commentCreate accepts parentId
   * for threaded replies (verification gate — falls back to flat on failure).
   */
  public async replyToComment(commentId: string, params: { commentText: string; mentions?: Array<{ id: string; name: string }> }): Promise<{ success: boolean; error?: string }> {
    const config = await this.loadConfig();
    if (!config?.setupComplete) {
      throw new Error('Linear not configured');
    }
    const normalizedCommentId = String(commentId || '').trim();
    if (!normalizedCommentId) { throw new Error('Linear reply requires a comment ID.'); }
    const normalizedComment = String(params?.commentText || '').trim();
    if (!normalizedComment) { throw new Error('Linear reply requires non-empty text.'); }

    // Linear replies are created via commentCreate with parentId.
    // We need the issueId — but replyToComment only has the commentId.
    // Linear's commentCreate requires issueId. We'll fetch the comment's issue
    // via a lightweight query, then call addIssueComment with parentId.
    let issueId: string | undefined;
    try {
      const result = await this.graphqlRequest(`
        query($commentId: String!) {
          comment(id: $commentId) { issue { id } }
        }
      `, { commentId: normalizedCommentId });
      issueId = String(result.data?.comment?.issue?.id || '').trim() || undefined;
    } catch (e) {
      console.warn('[LinearSync] Failed to resolve issueId for comment reply:', e);
    }

    if (!issueId) {
      // Can't determine issueId — post as a flat comment on the issue is not
      // possible without the issueId. Return error so UI can roll back.
      return { success: false, error: 'Could not resolve the issue for this comment reply.' };
    }

    return this.addIssueComment(issueId, normalizedComment, {
      parentId: normalizedCommentId,
      mentions: params.mentions
    });
  }

  /**
   * Fetch team members for the mention picker.
   * Uses the team's users query. Cached with 5-minute TTL.
   */
  public async getTeamMembers(): Promise<Array<{ id: string; name: string; email: string }>> {
    if (this._cachedMembers && (Date.now() - this._cachedMembers.fetchedAt) < LinearSyncService.MEMBERS_TTL_MS) {
      return this._cachedMembers.data;
    }

    const config = await this.loadConfig();
    if (!config?.setupComplete || !config.teamId) {
      throw new Error('Linear not configured');
    }

    try {
      const result = await this.graphqlRequest(`
        query($teamId: String!) {
          team(id: $teamId) {
            members {
              nodes {
                id
                name
                email
              }
            }
          }
        }
      `, { teamId: config.teamId });

      const members = Array.isArray(result.data?.team?.members?.nodes)
        ? result.data.team.members.nodes.map((m: any) => ({
            id: String(m?.id || '').trim(),
            name: String(m?.name || '').trim(),
            email: String(m?.email || '').trim()
          })).filter((m: { id: string }) => m.id.length > 0)
        : [];
      this._cachedMembers = { data: members, fetchedAt: Date.now() };
      return members;
    } catch (e) {
      console.warn('[LinearSync] Failed to fetch team members:', e);
      return [];
    }
  }

  public async uploadAttachment(issueId: string, buffer: Buffer, fileName: string): Promise<{ url: string }> {
    const config = await this.loadConfig();
    if (!config?.setupComplete) {
      throw new Error('Linear not configured');
    }

    // 1. Request upload URL
    const uploadRequestResult = await this.graphqlRequest(`
      mutation($filename: String!, $contentType: String!, $size: Int!) {
        fileUpload(filename: $filename, contentType: $contentType, size: $size) {
          uploadPageResponse {
            headers { key value }
            uploadUrl
          }
          assetUrl
        }
      }
    `, {
      filename: fileName,
      contentType: 'application/octet-stream',
      size: buffer.length
    });

    const uploadData = uploadRequestResult.data?.fileUpload;
    if (!uploadData?.uploadPageResponse) {
      throw new Error('Failed to request Linear upload URL');
    }

    const { uploadUrl, headers } = uploadData.uploadPageResponse;
    const assetUrl = uploadData.assetUrl;

    // 2. Upload file
    await new Promise((resolve, reject) => {
      const parsedUrl = new URL(uploadUrl);
      const options = {
        hostname: parsedUrl.hostname,
        path: parsedUrl.pathname + parsedUrl.search,
        method: 'PUT',
        headers: {
          'Content-Type': 'application/octet-stream',
          'Content-Length': buffer.length
        }
      };

      // Add custom headers from Linear
      if (Array.isArray(headers)) {
        for (const { key, value } of headers) {
          (options.headers as any)[key] = value;
        }
      }

      const req = https.request(options, (res) => {
        if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
          resolve(true);
        } else {
          let raw = '';
          res.on('data', chunk => raw += chunk);
          res.on('end', () => reject(new Error(`File upload failed with status ${res.statusCode}: ${raw}`)));
        }
      });

      req.on('error', reject);
      req.write(buffer);
      req.end();
    });

    // 3. Create attachment
    const attachmentCreateResult = await this.graphqlRequest(`
      mutation($issueId: String!, $url: String!, $title: String!) {
        attachmentCreate(input: { issueId: $issueId, url: $url, title: $title }) {
          success
          attachment { id url }
        }
      }
    `, {
      issueId,
      url: assetUrl,
      title: fileName
    });

    if (!attachmentCreateResult.data?.attachmentCreate?.success) {
      throw new Error('Failed to create Linear attachment link');
    }

    return { url: assetUrl };
  }

  public async updateIssueDescription(issueId: string, description: string, title?: string): Promise<void> {
    const config = await this.loadConfig();
    if (!config?.setupComplete) {
      throw new Error('Linear not configured');
    }

    const normalizedIssueId = String(issueId || '').trim();
    const normalizedDescription = String(description || '').trim();
    if (!normalizedIssueId || !normalizedDescription) {
      throw new Error('Linear description updates require both an issue ID and non-empty content.');
    }
    const normalizedTitle = title ? String(title).trim() : '';

    const result = await this.graphqlRequest(`
      mutation($id: String!, $description: String!${normalizedTitle ? ', $title: String!' : ''}) {
        issueUpdate(id: $id, input: { description: $description${normalizedTitle ? ', title: $title' : ''} }) { success }
      }
    `, { id: normalizedIssueId, description: normalizedDescription, ...(normalizedTitle ? { title: normalizedTitle } : {}) });

    if (!result.data?.issueUpdate?.success) {
      throw new Error(`Linear issue ${normalizedIssueId} rejected the requested description update.`);
    }

    // Invalidate cache for the project containing this issue
    if (this._cacheService) {
      const projectId = this._issueProjectIndex.get(normalizedIssueId);
      if (projectId) {
        this._cacheService.invalidateTaskCache('linear', `project:${projectId}`);
      } else {
        // Fallback: invalidate all Linear cache if project unknown
        this._cacheService.invalidateTaskCache('linear');
      }
    }
  }

  async archiveIssue(issueId: string): Promise<{ success: boolean; error?: string }> {
    const config = await this.loadConfig();
    if (!config?.setupComplete) {
      return { success: false, error: 'Linear not configured' };
    }

    const normalizedIssueId = String(issueId || '').trim();
    if (!normalizedIssueId) {
      return { success: false, error: 'Issue ID is required' };
    }

    try {
      // Use the dedicated issueArchive mutation (idempotent on already-archived
      // issues). The prior issueUpdate(input:{archivedAt}) form fails on
      // archived issues (they become read-only) and is the wrong API for this
      // operation.
      const result = await this.graphqlRequest(`
        mutation($id: String!) {
          issueArchive(id: $id) {
            success
          }
        }
      `, {
        id: normalizedIssueId
      });

      if (result.data?.issueArchive?.success) {
        console.log(`[LinearSync] Archived Linear issue ${normalizedIssueId}`);
        return { success: true };
      } else {
        return { success: false, error: `Linear issue ${normalizedIssueId} rejected the archive request.` };
      }
    } catch (error) {
      return { success: false, error: `Failed to archive Linear issue: ${error instanceof Error ? error.message : String(error)}` };
    }
  }

  /**
   * Unarchive a Linear issue. Archived issues are read-only — `issueUpdate`
   * fails on them. To push late content edits to an archived issue, unarchive
   * first, push, then re-archive. Uses the dedicated `issueUnarchive` mutation.
   */
  async unarchiveIssue(issueId: string): Promise<{ success: boolean; error?: string }> {
    const config = await this.loadConfig();
    if (!config?.setupComplete) {
      return { success: false, error: 'Linear not configured' };
    }

    const normalizedIssueId = String(issueId || '').trim();
    if (!normalizedIssueId) {
      return { success: false, error: 'Issue ID is required' };
    }

    try {
      const result = await this.graphqlRequest(`
        mutation($id: String!) {
          issueUnarchive(id: $id) {
            success
          }
        }
      `, {
        id: normalizedIssueId
      });

      if (result.data?.issueUnarchive?.success) {
        console.log(`[LinearSync] Unarchived Linear issue ${normalizedIssueId}`);
        return { success: true };
      } else {
        return { success: false, error: `Linear issue ${normalizedIssueId} rejected the unarchive request.` };
      }
    } catch (error) {
      return { success: false, error: `Failed to unarchive Linear issue: ${error instanceof Error ? error.message : String(error)}` };
    }
  }

  // ── Local Sync Map (planFile → Linear issueId) ──────────────

  async loadSyncMap(): Promise<Record<string, string>> {
    const db = KanbanDatabase.forWorkspace(this._workspaceRoot);
    return db.getAllLinearIssueLinks();
  }

  async saveSyncMap(map: Record<string, string>): Promise<void> {
    const db = KanbanDatabase.forWorkspace(this._workspaceRoot);
    // Full replace, not upsert: callers delete temp `creating_*` markers from
    // the map and those deletions must reach the table.
    await db.replaceAllLinearIssueLinks(map);
  }

  async getIssueIdForPlan(planFile: string): Promise<string | null> {
    const db = KanbanDatabase.forWorkspace(this._workspaceRoot);
    const link = await db.getLinearIssueLinkByPlan(planFile);
    return link ? link.issueId : null;
  }

  async setIssueIdForPlan(planFile: string, issueId: string): Promise<void> {
    const db = KanbanDatabase.forWorkspace(this._workspaceRoot);
    await db.setLinearIssueLink(issueId, planFile);
  }

  // ── Token & OAuth Management ─────────────────────────────────────────

  async getCredentialKind(): Promise<LinearCredentialKind> {
    try {
      const oauthTokens = await this.getOAuthTokens();
      if (oauthTokens && oauthTokens.accessToken) {
        return 'oauth';
      }
      const apiToken = await this._secretStorage.get('switchboard.linear.apiToken');
      if (apiToken && apiToken.trim().length > 0) {
        return 'apiKey';
      }
    } catch {}
    return 'none';
  }

  async isOAuthAppActor(): Promise<boolean> {
    return (await this.getCredentialKind()) === 'oauth';
  }

  async getOAuthTokens(): Promise<LinearOAuthTokens | null> {
    try {
      const raw = await this._secretStorage.get('switchboard.linear.oauthTokens');
      if (raw) {
        const parsed = JSON.parse(raw) as LinearOAuthTokens;
        // Crash-recovery half of the double buffer. A temp copy that survived a
        // crash is either the SAME pair (write completed, delete didn't) or a
        // NEWER pair (primary write didn't land) — never older, because temp is
        // written first. Prefer whichever pair is newer, then clear the temp so
        // a live refresh token is not left lying in a second secret.
        const tempRaw = await this._secretStorage.get('switchboard.linear.oauthTokens.temp');
        if (tempRaw && tempRaw !== raw) {
          try {
            const temp = JSON.parse(tempRaw) as LinearOAuthTokens;
            if (temp?.accessToken && (temp.createdAt || 0) > (parsed?.createdAt || 0)) {
              await this._secretStorage.store('switchboard.linear.oauthTokens', tempRaw);
              await this._secretStorage.delete('switchboard.linear.oauthTokens.temp');
              return temp;
            }
          } catch { /* unparseable temp — fall through and drop it */ }
        }
        if (tempRaw) {
          try { await this._secretStorage.delete('switchboard.linear.oauthTokens.temp'); } catch {}
        }
        return parsed;
      }
      // No primary at all: a crash between the temp write and the primary write.
      // The old refresh token is already dead Linear-side, so the temp pair is
      // the only usable credential.
      const tempOnly = await this._secretStorage.get('switchboard.linear.oauthTokens.temp');
      if (!tempOnly) return null;
      const recovered = JSON.parse(tempOnly) as LinearOAuthTokens;
      if (!recovered?.accessToken) return null;
      await this._secretStorage.store('switchboard.linear.oauthTokens', tempOnly);
      await this._secretStorage.delete('switchboard.linear.oauthTokens.temp');
      return recovered;
    } catch {
      return null;
    }
  }

  async saveOAuthTokens(tokens: LinearOAuthTokens): Promise<void> {
    const payload = JSON.stringify(tokens);
    // Atomic double-buffered persist: write to temp key first, then primary, then clear temp
    await this._secretStorage.store('switchboard.linear.oauthTokens.temp', payload);
    await this._secretStorage.store('switchboard.linear.oauthTokens', payload);
    await this._secretStorage.delete('switchboard.linear.oauthTokens.temp');
    this.clearApiTokenCache();
  }

  async clearOAuthTokens(): Promise<void> {
    await this._secretStorage.delete('switchboard.linear.oauthTokens');
    await this._secretStorage.delete('switchboard.linear.oauthTokens.temp');
    await this._secretStorage.delete('switchboard.linear.oauthLease');
    this.clearApiTokenCache();
  }

  async startOAuthFlow(redirectUri?: string): Promise<{ authorizeUrl: string; state: string; codeVerifier: string; redirectUri: string }> {
    const clientId = resolveLinearOAuthClientId();
    if (!clientId) { throw new Error(LINEAR_OAUTH_UNREGISTERED_MESSAGE); }
    if (this._inFlightPKCE && (Date.now() - this._inFlightPKCE.createdAt < 5 * 60 * 1000)) {
      const params = new URLSearchParams({
        response_type: 'code',
        client_id: clientId,
        redirect_uri: this._inFlightPKCE.redirectUri,
        scope: LINEAR_OAUTH_SCOPES.join(','),
        state: this._inFlightPKCE.state,
        code_challenge: this._inFlightPKCE.codeChallenge,
        code_challenge_method: 'S256',
        actor: 'app'
      });
      return {
        authorizeUrl: `${LINEAR_AUTH_URL}?${params.toString()}`,
        state: this._inFlightPKCE.state,
        codeVerifier: this._inFlightPKCE.codeVerifier,
        redirectUri: this._inFlightPKCE.redirectUri
      };
    }

    const codeVerifier = crypto.randomBytes(32).toString('base64url');
    const codeChallenge = crypto.createHash('sha256').update(codeVerifier).digest('base64url');
    const state = crypto.randomBytes(16).toString('hex');
    const effectiveRedirectUri = redirectUri || 'http://127.0.0.1:18942/oauth/callback';

    this._inFlightPKCE = {
      codeVerifier,
      codeChallenge,
      state,
      redirectUri: effectiveRedirectUri,
      createdAt: Date.now()
    };

    const params = new URLSearchParams({
      response_type: 'code',
      client_id: clientId,
      redirect_uri: effectiveRedirectUri,
      scope: LINEAR_OAUTH_SCOPES.join(','),
      state,
      code_challenge: codeChallenge,
      code_challenge_method: 'S256',
      actor: 'app'
    });

    return {
      authorizeUrl: `${LINEAR_AUTH_URL}?${params.toString()}`,
      state,
      codeVerifier,
      redirectUri: effectiveRedirectUri
    };
  }

  async exchangeOAuthCode(code: string, codeVerifier?: string, redirectUri?: string): Promise<LinearOAuthTokens> {
    const clientId = resolveLinearOAuthClientId();
    if (!clientId) { throw new Error(LINEAR_OAUTH_UNREGISTERED_MESSAGE); }
    const verifier = codeVerifier || this._inFlightPKCE?.codeVerifier;
    const uri = redirectUri || this._inFlightPKCE?.redirectUri || 'http://127.0.0.1:18942/oauth/callback';
    this._inFlightPKCE = null;

    if (!verifier) {
      throw new Error('Missing PKCE code_verifier for Linear OAuth code exchange');
    }

    const postData = new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: clientId,
      redirect_uri: uri,
      code: code.trim(),
      code_verifier: verifier
    }).toString();

    const response = await this._postOAuthToken(postData);
    if (response.error || !response.access_token) {
      throw new Error(`Linear OAuth exchange failed: ${response.error_description || response.error || 'unknown error'}`);
    }

    const tokens: LinearOAuthTokens = {
      accessToken: response.access_token,
      refreshToken: response.refresh_token,
      expiresAt: Date.now() + ((response.expires_in || 86400) * 1000),
      tokenType: response.token_type || 'Bearer',
      scope: Array.isArray(response.scope) ? response.scope : (typeof response.scope === 'string' ? response.scope.split(',') : LINEAR_OAUTH_SCOPES),
      actor: 'app',
      createdAt: Date.now()
    };

    await this.saveOAuthTokens(tokens);
    return tokens;
  }

  async refreshOAuthToken(): Promise<string> {
    const clientId = resolveLinearOAuthClientId();
    if (!clientId) { throw new Error(LINEAR_OAUTH_UNREGISTERED_MESSAGE); }
    const tokens = await this.getOAuthTokens();
    if (!tokens || !tokens.refreshToken) {
      throw new Error('No Linear OAuth refresh token available');
    }

    // Single-writer lease check
    let leaseRaw: string | undefined;
    try {
      leaseRaw = await this._secretStorage.get('switchboard.linear.oauthLease');
    } catch {}

    if (leaseRaw) {
      try {
        const lease = JSON.parse(leaseRaw) as LinearOAuthRefreshLease;
        if (lease && lease.expiresAt > Date.now() && lease.ownerId !== this._hostId) {
          // Another host holds the refresh lease — wait and read the refreshed token
          for (let i = 0; i < 7; i++) {
            await this.delay(500);
            const current = await this.getOAuthTokens();
            if (current && current.expiresAt > Date.now() + 60 * 1000) {
              return current.accessToken;
            }
            const freshLeaseRaw = await this._secretStorage.get('switchboard.linear.oauthLease');
            if (!freshLeaseRaw) break;
            const freshLease = JSON.parse(freshLeaseRaw);
            if (!freshLease || freshLease.expiresAt <= Date.now()) break;
          }
        }
      } catch {}
    }

    // Acquire lease. SecretStorage has no compare-and-swap, so the write is
    // followed by a read-back: two hosts that both saw an empty lease will both
    // store, but only one store lands last, and the loser must NOT exchange.
    // Without this, "single-writer" is a comment, not a mechanism.
    const lease: LinearOAuthRefreshLease = {
      ownerId: this._hostId,
      expiresAt: Date.now() + 30000
    };
    await this._secretStorage.store('switchboard.linear.oauthLease', JSON.stringify(lease));
    try {
      await this.delay(150);
      const confirmRaw = await this._secretStorage.get('switchboard.linear.oauthLease');
      const confirmed = confirmRaw ? JSON.parse(confirmRaw) as LinearOAuthRefreshLease : null;
      if (confirmed && confirmed.ownerId !== this._hostId && confirmed.expiresAt > Date.now()) {
        // Lost the race. Read the winner's token rather than burning ours — a
        // second exchange invalidates the winner's refresh token and Linear
        // revokes the whole authorization chain, which needs an admin to undo.
        for (let i = 0; i < 7; i++) {
          await this.delay(500);
          const current = await this.getOAuthTokens();
          if (current && current.expiresAt > Date.now() + 60 * 1000) {
            return current.accessToken;
          }
        }
        throw new Error('Linear OAuth refresh deferred: another host holds the refresh lease');
      }
    } catch (err: any) {
      if (String(err?.message || '').startsWith('Linear OAuth refresh deferred')) { throw err; }
      // A read-back failure is not proof we lost — fall through and exchange.
    }

    try {
      // Re-read the pair AFTER the lease is held. `tokens` was captured before
      // the wait loop above; if the other host refreshed in that window, its
      // refresh token is single-use and already spent, and replaying it revokes
      // the entire authorization. The lease makes this read the current truth.
      const held = await this.getOAuthTokens();
      const refreshTokenToUse = held?.refreshToken || tokens.refreshToken;
      if (held && held.expiresAt > Date.now() + 60 * 1000) {
        return held.accessToken;
      }
      const postData = new URLSearchParams({
        grant_type: 'refresh_token',
        client_id: clientId,
        refresh_token: refreshTokenToUse
      }).toString();

      const response = await this._postOAuthToken(postData);
      if (response.error || !response.access_token) {
        if (response.error === 'invalid_grant' || (response.error_description && response.error_description.includes('invalid_grant'))) {
          // Single-use token invalidated/revoked: clear stored tokens
          await this.clearOAuthTokens();
        }
        throw new Error(`Linear OAuth refresh failed: ${response.error_description || response.error || 'unknown error'}`);
      }

      const newTokens: LinearOAuthTokens = {
        accessToken: response.access_token,
        refreshToken: response.refresh_token,
        expiresAt: Date.now() + ((response.expires_in || 86400) * 1000),
        tokenType: response.token_type || 'Bearer',
        scope: Array.isArray(response.scope) ? response.scope : (held?.scope || tokens.scope),
        actor: 'app',
        createdAt: Date.now()
      };

      await this.saveOAuthTokens(newTokens);
      return newTokens.accessToken;
    } finally {
      try {
        await this._secretStorage.delete('switchboard.linear.oauthLease');
      } catch {}
    }
  }

  private async _postOAuthToken(postData: string): Promise<any> {
    return new Promise((resolve, reject) => {
      const req = https.request({
        hostname: LINEAR_TOKEN_HOST,
        path: LINEAR_TOKEN_PATH,
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Content-Length': Buffer.byteLength(postData)
        },
        timeout: 20000
      }, (res) => {
        let raw = '';
        res.on('data', (chunk) => { raw += chunk.toString(); });
        res.on('end', () => {
          try {
            const parsed = JSON.parse(raw);
            resolve(parsed);
          } catch {
            reject(new Error(`Failed to parse OAuth token response: ${raw.slice(0, 100)}`));
          }
        });
      });
      req.on('timeout', () => { req.destroy(); reject(new Error('Linear OAuth token request timed out')); });
      req.on('error', (err) => reject(err));
      req.write(postData);
      req.end();
    });
  }

  public async startOAuthLoopbackListener(port = 18942): Promise<{ port: number; close: () => void } | null> {
    if (this._oauthLoopbackServer) {
      try { this._oauthLoopbackServer.close(); } catch {}
      this._oauthLoopbackServer = null;
    }

    return new Promise((resolve) => {
      const server = http.createServer(async (req, res) => {
        try {
          // This listener is a SECOND http server, outside LocalApiServer, so it
          // does not inherit that server's guards — it has to carry them itself.
          // Bind is 127.0.0.1 (below); the Host check is the DNS-rebinding half:
          // without it a page on any origin resolving to loopback can drive the
          // exchange and log this install into the attacker's Linear workspace.
          if (!isLoopbackHostHeader(req.headers.host)) {
            res.writeHead(403, { 'Content-Type': 'text/plain' });
            res.end('Forbidden');
            return;
          }
          const reqUrl = new URL(req.url || '/', `http://127.0.0.1:${port}`);
          if (reqUrl.pathname === '/oauth/callback') {
            const code = reqUrl.searchParams.get('code');
            const state = reqUrl.searchParams.get('state');
            const error = reqUrl.searchParams.get('error');

            if (error) {
              res.writeHead(400, { 'Content-Type': 'text/html' });
              res.end(`<html><body style="background:#111;color:#f66;font-family:sans-serif;padding:40px;text-align:center;"><h2>Linear OAuth Failed</h2><p>${_escapeHtml(error)}</p></body></html>`);
              return;
            }

            if (code) {
              // A callback carrying no `state` is refused, not waved through:
              // the previous `state &&` short-circuit made the CSRF check
              // optional for exactly the caller that would omit it.
              if (this._inFlightPKCE && this._inFlightPKCE.state !== state) {
                res.writeHead(400, { 'Content-Type': 'text/html' });
                res.end(`<html><body style="background:#111;color:#f66;font-family:sans-serif;padding:40px;text-align:center;"><h2>Invalid State Parameter</h2></body></html>`);
                return;
              }

              await this.exchangeOAuthCode(code);
              res.writeHead(200, { 'Content-Type': 'text/html' });
              res.end(`<html><body style="background:#111;color:#00e5ff;font-family:sans-serif;padding:40px;text-align:center;"><h2>Linear Connected Successfully</h2><p>Switchboard is now connected to Linear as an App Actor. You can close this window.</p></body></html>`);
              setTimeout(() => {
                try { server.close(); } catch {}
              }, 1000);
              return;
            }
          }
          res.writeHead(404, { 'Content-Type': 'text/plain' });
          res.end('Not found');
        } catch (err: any) {
          res.writeHead(500, { 'Content-Type': 'text/html' });
          res.end(`<html><body style="background:#111;color:#f66;font-family:sans-serif;padding:40px;text-align:center;"><h2>Exchange Error</h2><p>${_escapeHtml(err?.message || 'unknown error')}</p></body></html>`);
        }
      });

      server.on('error', (err) => {
        console.warn('[LinearSyncService] Loopback listener failed to bind:', err);
        resolve(null);
      });

      server.listen(port, '127.0.0.1', () => {
        this._oauthLoopbackServer = server;
        setTimeout(() => {
          try { server.close(); } catch {}
          if (this._oauthLoopbackServer === server) this._oauthLoopbackServer = null;
        }, 5 * 60 * 1000);
        resolve({ port, close: () => { try { server.close(); } catch {} } });
      });
    });
  }

  public async checkViewerAdminStatus(): Promise<{ isAdmin: boolean | null; role?: string; message?: string }> {
    try {
      const token = await this.getApiToken();
      if (!token) {
        return {
          isAdmin: null,
          message: 'Connecting Linear as an App Actor requires Linear Workspace Admin permissions.'
        };
      }
      const res = await this.graphqlRequest('{ viewer { id admin role } }');
      const viewer = res?.data?.viewer;
      if (viewer) {
        const isAdmin = viewer.admin === true || viewer.role === 'admin';
        return {
          isAdmin,
          role: viewer.role,
          message: isAdmin
            ? 'Workspace Admin permissions confirmed.'
            : 'Notice: Non-admin users cannot authorize OAuth App Actors in Linear.'
        };
      }
    } catch (err: any) {
      return {
        isAdmin: null,
        message: `Could not verify admin status: ${err?.message || 'unknown error'}`
      };
    }
    return { isAdmin: null };
  }

  public getRateLimitState(): LinearRateLimitState | null {
    return this._lastRateLimitState;
  }

  async getApiToken(): Promise<string | null> {
    try {
      const oauthTokens = await this.getOAuthTokens();
      if (oauthTokens && oauthTokens.accessToken) {
        if (Date.now() > oauthTokens.expiresAt - 15 * 60 * 1000) {
          try {
            const refreshed = await this.refreshOAuthToken();
            return refreshed;
          } catch {
            if (Date.now() < oauthTokens.expiresAt) {
              return oauthTokens.accessToken;
            }
          }
        } else {
          return oauthTokens.accessToken;
        }
      }
      return await this._secretStorage.get('switchboard.linear.apiToken') || null;
    } catch { return null; }
  }

  async hasApiToken(): Promise<boolean> {
    if (this._tokenPresentCache !== null) { return this._tokenPresentCache; }
    const token = await this.getApiToken();
    this._tokenPresentCache = !!token;
    return this._tokenPresentCache;
  }

  clearApiTokenCache(): void {
    this._tokenPresentCache = null;
  }

  private _parseRateLimitHeaders(headers: http.IncomingHttpHeaders, isOAuth: boolean): void {
    const getNum = (name: string): number | undefined => {
      const val = headers[name];
      if (val === undefined || val === null) return undefined;
      const parsed = parseInt(Array.isArray(val) ? val[0] : val, 10);
      return Number.isNaN(parsed) ? undefined : parsed;
    };

    const requestsLimit = getNum('x-ratelimit-requests-limit');
    const requestsRemaining = getNum('x-ratelimit-requests-remaining');
    const requestsReset = getNum('x-ratelimit-requests-reset');
    const complexity = getNum('x-complexity');
    const complexityLimit = getNum('x-ratelimit-complexity-limit');
    const complexityRemaining = getNum('x-ratelimit-complexity-remaining');
    const complexityReset = getNum('x-ratelimit-complexity-reset');

    if (requestsLimit !== undefined || complexity !== undefined || requestsRemaining !== undefined) {
      this._lastRateLimitState = {
        requestsLimit,
        requestsRemaining,
        requestsReset,
        complexity,
        complexityLimit,
        complexityRemaining,
        complexityReset,
        actorKind: isOAuth ? 'app' : 'user'
      };
    }
  }

  // ── GraphQL Client ───────────────────────────────────────────

  /**
   * Generic GraphQL request wrapper for LocalApiServer proxy.
   */
  async makeGraphQLRequest(query: string, variables?: Record<string, unknown>): Promise<any> {
    const result = await this.graphqlRequest(query, variables);
    return result;
  }

  /**
   * Resolve an issue title or identifier to its ID.
   */
  async resolveNameToId(name: string): Promise<string | null> {
    const config = await this.loadConfig();
    if (!config?.setupComplete) {
      throw new Error('Linear not configured');
    }

    const normalizedName = name.trim().toLowerCase();

    // 1. Check if it's an identifier (e.g., LIN-123)
    if (this._isIssueIdentifier(name)) {
      const issue = await this.getIssue(name);
      return issue ? issue.id : null;
    }

    // 2. Search for issues by title
    const issues = await this.queryIssues({ search: name });
    if (issues.length > 0) {
      const exactMatch = issues.find(i => i.title.toLowerCase() === normalizedName);
      return exactMatch ? exactMatch.id : issues[0].id;
    }

    return null;
  }

  /**
   * Authenticated GraphQL request to Linear API.
   * Linear always returns HTTP 200; errors are in response.errors.
   * Throws if HTTP status != 200 OR if response.errors is non-empty.
   */
  async graphqlRequest(
    query: string,
    variables?: Record<string, unknown>,
    timeoutMs = 30000,
    signal?: AbortSignal
  ): Promise<{ data: any }> {
    try {
      return await this._graphqlRequestAttempt(query, variables, timeoutMs, signal);
    } catch (err: any) {
      if (err?.statusCode === 401 && (await this.isOAuthAppActor())) {
        try {
          await this.refreshOAuthToken();
          return await this._graphqlRequestAttempt(query, variables, timeoutMs, signal);
        } catch {
          throw err;
        }
      }
      throw err;
    }
  }

  private async _graphqlRequestAttempt(
    query: string,
    variables?: Record<string, unknown>,
    timeoutMs = 30000,
    signal?: AbortSignal
  ): Promise<{ data: any }> {
    await this._throttle();
    const token = await this.getApiToken();
    if (!token) { throw new Error('Linear API token not configured'); }
    const isOAuth = await this.isOAuthAppActor();
    const authHeader = token.startsWith('Bearer ') || token.startsWith('lin_api_')
      ? token
      : (isOAuth ? `Bearer ${token}` : token);

    return new Promise((resolve, reject) => {
      let settled = false;
      const safeResolve = (value: { data: any }) => {
        if (settled) return;
        settled = true;
        resolve(value);
      };
      const safeReject = (err: Error) => {
        if (settled) return;
        settled = true;
        reject(err);
      };

      const payload = JSON.stringify({ query, variables });
      const req = https.request({
        hostname: LINEAR_API_HOST,
        path: LINEAR_API_PATH,
        method: 'POST',
        headers: {
          'Authorization': authHeader,
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload)
        },
        timeout: timeoutMs
      }, (res) => {
        let raw = '';
        res.on('error', (err) => safeReject(new Error(`Linear response stream error: ${err.message}`)));
        res.on('aborted', () => safeReject(new Error('Linear response aborted by server')));
        res.on('data', (chunk: Buffer) => { raw += chunk.toString(); });
        res.on('end', () => {
          this._parseRateLimitHeaders(res.headers, isOAuth);

          if (res.statusCode !== 200) {
            const status = res.statusCode ?? 0;
            const err: any = new Error(localizeHttpError(status, 'linear', 'fetch from Linear'));
            err.statusCode = status;
            return safeReject(err);
          }
          try {
            const parsed = JSON.parse(raw);
            if (parsed.errors?.length) {
              const firstErr = parsed.errors[0];
              const code = firstErr?.extensions?.code;
              const isRateLimited = code === 'RATELIMITED' || String(firstErr?.message || '').toLowerCase().includes('ratelimit');
              const err: any = new Error(`Linear GraphQL error: ${firstErr.message}`);
              if (isRateLimited) {
                err.code = 'RATELIMITED';
                err.isRateLimited = true;
              }
              return safeReject(err);
            }
            safeResolve({ data: parsed.data });
          } catch {
            safeReject(new Error('Failed to parse Linear API response'));
          }
        });
      });
      req.on('timeout', () => { req.destroy(); safeReject(new Error('Linear request timed out')); });
      req.on('error', (err) => safeReject(err));

      // Wire up AbortController cancellation
      if (signal) {
        if (signal.aborted) {
          req.destroy(new Error('AbortError'));
          return safeReject(new Error('AbortError'));
        }
        const abortHandler = () => {
          req.destroy(new Error('AbortError'));
          safeReject(new Error('AbortError'));
        };
        signal.addEventListener('abort', abortHandler);
        req.on('close', () => signal.removeEventListener('abort', abortHandler));
      }

      req.write(payload);
      req.end();
    });
  }

  // ── Availability Check ───────────────────────────────────────

  async isAvailable(): Promise<boolean> {
    try {
      const token = await this.getApiToken();
      if (!token) { return false; }
      await this.graphqlRequest('{ viewer { id } }', undefined, 10000);
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
        this._tokenPresentCache = true;
      }

      if (!(await this.isAvailable())) {
        return { success: false, error: 'Linear token is invalid. Get a valid token at linear.app/settings/api' };
      }

      const needsTeamSelection = options.mapColumns || options.createLabel || (options.includeProjectNames && options.includeProjectNames.length > 0) || (options.excludeProjectNames && options.excludeProjectNames.length > 0) || options.enableRealtimeSync || options.enableAutoPull;
      const hasExistingSetup = !!config.teamId || !!config.switchboardLabelId || Object.keys(config.columnToStateId || {}).length > 0 || config.setupComplete;

      if (needsTeamSelection && !config.teamId) {
        await this._selectTeam(config);
      }

      config.includeProjectNames = options.includeProjectNames;
      config.excludeProjectNames = options.excludeProjectNames;

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
      config.deleteSyncEnabled = options.deleteSyncEnabled === true;
      config.inboundDeleteEnabled = options.inboundDeleteEnabled === true;
      config.completeSyncEnabled = options.enableCompleteSync !== false;
      config.excludeBacklog = options.excludeBacklog !== false;  // default true
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

  async syncPlan(plan: { planFile: string; topic: string; complexity: string }, newColumn: string): Promise<void> {
    const config = await this.loadConfig();
    if (!config?.setupComplete) { return; }
    if (!(await this.hasApiToken())) { return; }

    const stateId = config.columnToStateId[newColumn];
    if (!stateId) {
      console.warn(`[LinearSync] No Linear state mapped for column "${newColumn}" - skipping sync for plan ${plan.planFile}`);
      return;
    } // column not mapped

    // §4 — completeSyncEnabled gate. When the user disables "sync completed status",
    // automatic DONE/COMPLETED/ARCHIVED transitions are NOT pushed to Linear.
    // Manual dispatch (updateIssueState) is intentionally left untouched.
    const terminalColumn = ['DONE', 'COMPLETED', 'ARCHIVED'].includes((newColumn || '').toUpperCase());
    if (config.completeSyncEnabled === false && terminalColumn) {
      console.log(`[LinearSync] completeSyncEnabled is off — skipping ${newColumn} sync for plan ${plan.planFile}`);
      return;
    }

    const existingIssueId = await this.getIssueIdForPlan(plan.planFile);
    const priority = this._complexityToPriority(plan.complexity);

    try {
      if (existingIssueId) {
        console.log(`[LinearSync] Updating existing Linear issue ${existingIssueId} for plan ${plan.planFile} to state ${stateId}`);
        const result = await this.retry(() => this.graphqlRequest(`
          mutation($id: String!, $stateId: String!) {
            issueUpdate(id: $id, input: { stateId: $stateId }) { success }
          }
        `, { id: existingIssueId, stateId }));

        if (!result.data.issueUpdate.success) {
          console.warn(`[LinearSync] Issue update failed for ${existingIssueId}, attempting to recreate`);
          await this.createIssue(plan, stateId, priority, config);
        } else {
          console.log(`[LinearSync] Successfully updated Linear issue ${existingIssueId} for plan ${plan.planFile}`);
        }
      } else {
        await this.createIssue(plan, stateId, priority, config);
      }
    } catch (error) {
      console.warn(`[LinearSync] Failed to sync plan ${plan.planFile}:`, error);
      throw error;
    }
  }

  /**
   * Sync plan markdown content to Linear issue description.
   * Used by ContinuousSyncService for live updates.
   * Does NOT change issue state or other fields.
   */
  async syncPlanContent(issueId: string, markdownContent: string, signal?: AbortSignal): Promise<{ success: boolean; error?: string }> {
    try {
      const config = await this.loadConfig();
      if (!config?.setupComplete) {
        return { success: false, error: 'Linear not set up' };
      }
      if (!(await this.hasApiToken())) {
        return { success: false, error: 'Linear API token not configured' };
      }

      // Strip H1 header before syncing to description
      const contentWithoutH1 = this._stripH1Header(markdownContent);

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
        description: contentWithoutH1
      }, 30000, signal);

      if (result.data?.issueUpdate?.success) {
        return { success: true };
      } else {
        return { success: false, error: 'Linear issueUpdate returned success=false' };
      }
    } catch (error) {
      return { success: false, error: `Sync failed: ${error}` };
    }
  }

  /**
   * Internal implementation for creating a Linear issue.
   * Public to match ClickUpSyncService.createTask().
   */
  public async createIssue(
    plan: { planFile: string; topic: string },
    stateId: string,
    priority: number,
    config: LinearConfig
  ): Promise<void> {
    console.log(`[LinearSync] Creating Linear issue for plan ${plan.planFile} with title "${plan.topic}"`);
    const description = await this._buildInitialIssueDescription(plan.planFile);

    // Pre-mark in sync map BEFORE GraphQL call to prevent automation race condition.
    // Marker format: `creating_${planFile}_${timestamp}`. The timestamp is used by the
    // stale-marker sweep in importIssuesFromLinear to age out abandoned markers.
    const tempMarker = `creating_${plan.planFile}_${Date.now()}`;
    await this.setIssueIdForPlan(plan.planFile, tempMarker);

    const resolvedProjectId = await this._resolveSingleIncludeProjectId(config);
    let issueCreated = false;
    try {
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
          ...(resolvedProjectId ? { projectId: resolvedProjectId } : {})
        }
      }));

      if (result.data.issueCreate.success) {
        const issueId = result.data.issueCreate.issue.id;
        const identifier = result.data.issueCreate.issue.identifier;
        
        if (description) {
          try {
            const resolvedPlanPath = path.isAbsolute(plan.planFile)
              ? plan.planFile
              : path.join(this._workspaceRoot, plan.planFile);
            const { rewritten } = await hostInlineImages(
              (fileName, buffer) => this.uploadAttachment(issueId, buffer, fileName),
              description,
              resolvedPlanPath
            );
            if (rewritten !== description) {
              await this.updateIssueDescription(issueId, rewritten);
            }
          } catch (hostErr) {
            console.warn(`[LinearSync] Created Linear issue ${issueId}, but inline image hosting failed:`, hostErr);
          }
        }

        // Overwrite the temp marker with the real issue ID — this is the race-free handoff.
        await this.setIssueIdForPlan(plan.planFile, issueId);
        issueCreated = true;
        const db = KanbanDatabase.forWorkspace(this._workspaceRoot);
        const ready = await db.ensureReady();
        if (!ready) {
          throw new Error(`Kanban database unavailable while linking Linear issue ${issueId} to plan ${plan.planFile}.`);
        }
        const workspaceId = await db.getWorkspaceId() || await db.getDominantWorkspaceId() || '';
        const persisted = await db.updateLinearIssueIdByPlanFile(plan.planFile, workspaceId, issueId);
        if (!persisted) {
          throw new Error(`Failed to persist Linear issue ${issueId} for plan ${plan.planFile}.`);
        }
        console.log(`[LinearSync] Created Linear issue ${identifier} (ID: ${issueId}) for plan ${plan.planFile}`);
      } else {
        console.error(`[LinearSync] Failed to create Linear issue for plan ${plan.planFile}`);
        throw new Error(`Failed to create Linear issue for plan ${plan.planFile}.`);
      }
    } finally {
      // Guaranteed cleanup: if the temp marker is still present (we never replaced it
      // with the real issue ID), remove it. Covers success-that-failed-to-link,
      // GraphQL mutation returning success=false, and retry() exhaustion throws.
      if (!issueCreated) {
        try {
          const map = await this.loadSyncMap();
          if (map[plan.planFile] === tempMarker) {
            delete map[plan.planFile];
            await this.saveSyncMap(map);
          }
        } catch (cleanupErr) {
          console.warn(`[LinearSync] Failed to clean up temp marker for ${plan.planFile}:`, cleanupErr);
        }
      }
    }
  }

  public async createIssueSimple(params: {
    title: string;
    description?: string;
    projectId?: string;
    stateId?: string;
    parentId?: string;
    priority?: number;
    assigneeId?: string;
  }): Promise<{ id: string; identifier: string }> {
    const config = await this.loadConfig();
    if (!config || !config.setupComplete || !config.teamId) {
      throw new Error("Linear integration not configured. Complete setup in the Setup panel first.");
    }
    const result = await this.retry(() => this.graphqlRequest(`
      mutation($input: IssueCreateInput!) {
        issueCreate(input: $input) {
          success
          issue {
            id
            identifier
          }
        }
      }
    `, {
      input: {
        teamId: config.teamId,
        title: params.title,
        description: params.description || '',
        labelIds: config.switchboardLabelId ? [config.switchboardLabelId] : [],
        ...(params.projectId ? { projectId: params.projectId } : {}),
        ...(params.stateId ? { stateId: params.stateId } : {}),
        ...(params.parentId ? { parentId: params.parentId } : {}),
        ...(typeof params.priority === 'number' && Number.isInteger(params.priority) && params.priority >= 0 && params.priority <= 4 ? { priority: params.priority } : {}),
        ...(params.assigneeId ? { assigneeId: params.assigneeId } : {})
      }
    }));

    if (result.data?.issueCreate?.success) {
      const issueId = result.data.issueCreate.issue.id;
      const identifier = result.data.issueCreate.issue.identifier;
      if (params.description) {
        try {
          const { rewritten } = await hostInlineImages(
            (fileName, buffer) => this.uploadAttachment(issueId, buffer, fileName),
            params.description
          );
          if (rewritten !== params.description) {
            await this.updateIssueDescription(issueId, rewritten);
          }
        } catch (hostErr) {
          console.warn(`[LinearSync] Created issue ${issueId}, but inline image hosting failed:`, hostErr);
        }
      }
      return {
        id: issueId,
        identifier
      };
    } else {
      throw new Error("Failed to create Linear issue.");
    }
  }

  // ── Debounced Sync ───────────────────────────────────────────

  debouncedSync(planFile: string, plan: any, column: string): void {
    const existing = this._debounceTimers.get(planFile);
    if (existing) { clearTimeout(existing); }
    this._debounceTimers.set(planFile, setTimeout(async () => {
      this._debounceTimers.delete(planFile);
      try {
        await this.syncPlan(plan, column);
        this._consecutiveFailures = 0;
      } catch (error) {
        console.error(`[LinearSync] Failed to sync plan ${planFile} to column ${column}:`, error);
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
        // Fast-fail on permanent errors (auth, config, GraphQL validation)
        if (!this._isTransientError(error)) { throw error; }
        const jitterMs = Math.floor(Math.random() * 400);
        const backoffMs = Math.min(Math.pow(2, i) * 1000, 5000) + jitterMs;
        await this.delay(backoffMs);
      }
    }
    throw new Error('Max retries exceeded');
  }

  // ── Import Issues (legacy — used by extension.ts) ────────────

  /**
   * Two-pass import: parent issues with children ALWAYS become Switchboard features
   * (written to .switchboard/features/), children are linked via direct DB writes
   * (feature_id). Deeply nested hierarchies are flattened to one level. The GraphQL
   * query fetches the full hierarchy recursively (5 levels deep). Insert-before-
   * write ordering prevents the child-planId race (watcher would mint a random
   * planId if it fires between file write and DB insert).
   */
  async importIssuesFromLinear(plansDir: string): Promise<{ success: boolean; imported: number; skipped: number; error?: string }> {
    const config = await this.loadConfig();
    if (!config?.setupComplete) {
      return { success: false, imported: 0, skipped: 0, error: 'Linear not set up' };
    }

    try {
      // --- Stale marker sweep (TTL = 60s) ------------------------------------
      // A `creating_${planFile}_${timestamp}` marker older than 60s is assumed
      // to be abandoned (extension restart mid-create, network stall past retry
      // budget, etc.). Removing it unblocks auto-pull for that session.
      const STALE_MARKER_TTL_MS = 60_000;
      const nowTs = Date.now();
      {
        const map = await this.loadSyncMap();
        let dirty = false;
        for (const [sid, val] of Object.entries(map)) {
          if (typeof val === 'string' && val.startsWith('creating_')) {
            const m = val.match(/^creating_(.+)_(\d+)$/);
            const ts = m ? parseInt(m[2], 10) : NaN;
            if (!Number.isFinite(ts) || (nowTs - ts) > STALE_MARKER_TTL_MS) {
              delete map[sid];
              dirty = true;
            }
          }
        }
        if (dirty) { await this.saveSyncMap(map); }
      }

      const syncMap = await this.loadSyncMap();
      const syncMapIssueIds = new Set(Object.values(syncMap));

      // Plans with a live (non-stale) creating_* marker. An inbound issue
      // whose title matches one of these plans is our own outbound create
      // still in flight — skip it to avoid a duplicate.
      const planFilesBeingCreated = new Set<string>(
        Object.entries(syncMap)
          .filter(([, v]) => typeof v === 'string' && v.startsWith('creating_'))
          .map(([pf]) => pf)
      );

      // Resolve DB handle + workspaceId once for the scoped title fallback.
      const db = KanbanDatabase.forWorkspace(this._workspaceRoot);
      const ready = await db.ensureReady();
      const workspaceId = ready ? (await db.getWorkspaceId()) || '' : '';

      const allIssues: any[] = [];
      let cursor: string | null = null;

      const resolvedProjectId = await this._resolveSingleIncludeProjectId(config);
      const filter = buildLinearIssueFilter(config.teamId, resolvedProjectId || undefined);

      // Recursive GraphQL query: fetches the full hierarchy 5 levels deep.
      // Each level nests children { nodes { ... children { nodes { ... } } } }.
      // Comments/attachments/project/cycle are only on top-level issues to keep
      // the query size manageable. Children at all levels get core fields + parent.
      const QUERY = `
        query($filter: IssueFilter!, $after: String) {
          issues(
            filter: $filter
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
              children { nodes {
                id identifier title description url priority
                state { name type }
                assignee { name email }
                labels { nodes { name } }
                dueDate createdAt estimate
                parent { id }
                children { nodes {
                  id identifier title description url priority
                  state { name type }
                  assignee { name email }
                  labels { nodes { name } }
                  dueDate createdAt estimate
                  parent { id }
                  children { nodes {
                    id identifier title description url priority
                    state { name type }
                    assignee { name email }
                    labels { nodes { name } }
                    dueDate createdAt estimate
                    parent { id }
                    children { nodes {
                      id identifier title description url priority
                      state { name type }
                      assignee { name email }
                      labels { nodes { name } }
                      dueDate createdAt estimate
                      parent { id }
                    } }
                  } }
                } }
              } }
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
          filter,
          after: cursor
        });
        const page = result.data.issues;
        allIssues.push(...page.nodes);
        if (!page.pageInfo.hasNextPage) { break; }
        cursor = page.pageInfo.endCursor;
        await this.delay(200);
      }

      // Apply client-side project name filters
      const filteredIssues = this._applyProjectNameFilters(allIssues, config);

      // Recursively flatten: top-level issues + all their descendants (any depth).
      const allTasks: any[] = [];
      const seenIds = new Set<string>();
      const collectIssue = (issue: any) => {
        if (!issue || seenIds.has(issue.id)) { return; }
        seenIds.add(issue.id);
        allTasks.push(issue);
        if (issue.children?.nodes) {
          for (const child of issue.children.nodes) {
            collectIssue(child);
          }
        }
      };
      for (const issue of filteredIssues) {
        collectIssue(issue);
      }

      const issueNameById = new Map<string, string>(allTasks.map((t: any) => [t.id, `${t.title} (${t.identifier})`]));

      await fs.promises.mkdir(plansDir, { recursive: true });
      const featureDir = path.join(this._workspaceRoot, '.switchboard', 'features');
      await fs.promises.mkdir(featureDir, { recursive: true });
      let imported = 0;
      let skipped = 0;

      // ── Pass 0: Filter ──────────────────────────────────────────
      // Run all dedup/filter checks. Collect survivors into filteredTasks.
      const filteredTasks: any[] = [];

      for (const issue of allTasks) {
        if (syncMapIssueIds.has(issue.id)) { skipped++; continue; }

        // Scoped title fallback: only suppress if a local session is actively
        // being created AND its topic matches this issue's title. Global title
        // matching is explicitly avoided to prevent silent import loss.
        if (planFilesBeingCreated.size > 0 && ready && workspaceId) {
          const localPlan = await db.getPlanByTopic(issue.title || '', workspaceId);
          if (localPlan && planFilesBeingCreated.has(localPlan.planFile)) {
            skipped++;
            continue;
          }
        }

        const stateType = (issue.state?.type || '').toLowerCase();
        // Always filter out completed/cancelled/archived issues
        if (stateType === 'completed' || stateType === 'cancelled' || stateType === 'canceled' || stateType === 'archived') {
          skipped++;
          continue;
        }

        // Filter out backlog if configured (default: true)
        if (config.excludeBacklog !== false && stateType === 'backlog') {
          skipped++;
          continue;
        }

        const planFile = path.join(plansDir, `linear_import_${issue.id}.md`);
        try { await fs.promises.access(planFile); skipped++; continue; } catch { /* proceed */ }

        // Issue survived all filters — collect it.
        filteredTasks.push(issue);
      }

      // ── Group: Build parent/child maps from filtered tasks ──────
      const tasksById = new Map<string, any>(filteredTasks.map((t: any) => [t.id, t]));
      const childrenByParentId = new Map<string, any[]>();
      for (const task of filteredTasks) {
        const parentId = task.parent?.id;
        if (parentId && tasksById.has(parentId)) {
          if (!childrenByParentId.has(parentId)) {
            childrenByParentId.set(parentId, []);
          }
          childrenByParentId.get(parentId)!.push(task);
        }
      }

      // A top-level parent has children in the batch AND no in-batch parent.
      // An intermediate parent has children AND an in-batch parent — it's a subtask, not a feature.
      const isParent = (taskId: string) => childrenByParentId.has(taskId);
      const isChild = (task: any) => {
        const parentId = task.parent?.id;
        return !!parentId && tasksById.has(parentId);
      };
      const isTopLevelParent = (task: any) => isParent(task.id) && !isChild(task);

      // ── Pass 1: Insert DB records + write files (insert BEFORE write) ──
      // Insert-before-write ordering prevents the child-planId race: if the
      // watcher fires between file write and DB insert, ON CONFLICT preserves
      // the import's planId (not the watcher's random one).
      const uuidByIssueId = new Map<string, string>();

      for (const issue of filteredTasks) {
        const stateType = (issue.state?.type || '').toLowerCase();
        const kanbanColumn = stateType === 'backlog' ? 'BACKLOG' : 'CREATED';
        const priority = ['', 'urgent', 'high', 'normal', 'low'][issue.priority] || '';
        const dueDate = issue.dueDate || '';
        const assignee = issue.assignee ? (issue.assignee.name || issue.assignee.email) : '';
        const labels = (issue.labels?.nodes || []).map((l: any) => l.name).filter((n: string) => n !== 'switchboard').join(', ');
        const description = (issue.description || '').trim();
        const parentRef = issue.parent?.id ? (issueNameById.get(issue.parent.id) || issue.parent.id) : '';

        const metaLines = [
          `> Imported from Linear issue \`${issue.identifier}\``,
          `> **Linear Issue ID:** ${issue.id}`,
          issue.url         ? `> **URL:** ${issue.url}`              : '',
          parentRef         ? `> **Parent Issue:** ${parentRef}`     : '',
          priority          ? `> **Priority:** ${priority}`          : '',
          dueDate           ? `> **Due:** ${dueDate}`                : '',
          assignee          ? `> **Assignee:** ${assignee}`          : '',
          labels            ? `> **Tags:** ${labels}`                : '',
          issue.state?.name ? `> **State:** ${issue.state.name}`    : '',
        ].filter(Boolean).join('\n');

        // §2 — capture comments and attachments (top-level issues only).
        const COMMENT_CAP = 20;
        const COMMENT_CHAR_CAP = 2000;
        const commentNodes = (issue.comments?.nodes || []).slice(-COMMENT_CAP);
        const commentsSection = commentNodes.length
          ? '\n## Comments\n\n' + commentNodes.map((c: any) => {
              const author = c.user?.name || 'Unknown';
              const when = c.createdAt || '';
              let body = String(c.body || '').trim();
              if (body.length > COMMENT_CHAR_CAP) {
                body = body.slice(0, COMMENT_CHAR_CAP) + ' *[truncated]*';
              }
              return `**${author}**${when ? ` — ${when}` : ''}\n\n${body}`;
            }).join('\n\n---\n\n') + '\n'
          : '';

        const attachmentNodes = (issue.attachments?.nodes || []).filter((a: any) => a?.url);
        const attachmentsSection = attachmentNodes.length
          ? '\n## Attachments\n\n' + attachmentNodes.map((a: any) =>
              `- [${a.title || a.url}](${a.url})`
            ).join('\n') + '\n'
          : '';

        const stub = [
          `# ${issue.title || `Linear Issue ${issue.identifier}`}`,
          '',
          `kanbanColumn: ${kanbanColumn}`,
          '',
          metaLines,
          '',
          description || '',
          commentsSection,
          attachmentsSection,
        ].join('\n');

        if (isTopLevelParent(issue)) {
          // Top-level parent → feature: insert DB, mark feature, persist linear_issue_id,
          // THEN write to .switchboard/features/ (insert-before-write).
          const uuid = crypto.randomUUID();
          uuidByIssueId.set(issue.id, uuid);
          const featurePlanFile = path.join('.switchboard', 'features', `linear_import_${issue.id}_${uuid}.md`);

          if (ready && workspaceId) {
            try {
              await db.insertFileDerivedPlan({
                planId: uuid,
                sessionId: '',
                topic: issue.title || `Linear Issue ${issue.identifier}`,
                planFile: featurePlanFile,
                kanbanColumn,
                status: 'active' as any,
                complexity: 'Unknown',
                tags: '',
                repoScope: '',
                workspaceId,
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString(),
                lastAction: '',
                sourceType: 'linear-import',
                brainSourcePath: '',
                mirrorPath: '',
                routedTo: '',
                dispatchedAgent: '',
                dispatchedIde: '',
                isFeature: 1,
                featureId: ''
              } as any);
              await db.updateFeatureStatus(uuid, 1, '');
              await db.updateLinearIssueIdByPlanFile(featurePlanFile, workspaceId, issue.id);
            } catch (dbErr) {
              console.warn(`[LinearSync] import: DB insert failed for feature ${issue.id}, file will be written (watcher will ingest):`, dbErr);
            }
          }

          const featurePath = path.join(this._workspaceRoot, featurePlanFile);
          await fs.promises.writeFile(featurePath, stub, 'utf8');
          imported++;
        } else if (isChild(issue)) {
          // Child (including intermediate parents) → subtask: insert DB, persist
          // linear_issue_id, THEN write to .switchboard/plans/ (insert-before-write).
          const childUuid = crypto.randomUUID();
          uuidByIssueId.set(issue.id, childUuid);
          const childPlanFile = path.join(plansDir, `linear_import_${issue.id}.md`);
          const childRelPath = path.relative(this._workspaceRoot, childPlanFile);

          // Add Feature Plan ID metadata line for debugging (if parent UUID is known).
          const parentIssueId = issue.parent?.id;
          const parentUuid = parentIssueId ? uuidByIssueId.get(parentIssueId) || '' : '';
          const childStub = parentUuid
            ? stub.replace(metaLines, `${metaLines}\n> **Feature Plan ID:** ${parentUuid}`)
            : stub;

          if (ready && workspaceId) {
            try {
              await db.insertFileDerivedPlan({
                planId: childUuid,
                sessionId: '',
                topic: issue.title || `Linear Issue ${issue.identifier}`,
                planFile: childRelPath,
                kanbanColumn,
                status: 'active' as any,
                complexity: 'Unknown',
                tags: '',
                repoScope: '',
                workspaceId,
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString(),
                lastAction: '',
                sourceType: 'linear-import',
                brainSourcePath: '',
                mirrorPath: '',
                routedTo: '',
                dispatchedAgent: '',
                dispatchedIde: ''
              } as any);
              await db.updateLinearIssueIdByPlanFile(childRelPath, workspaceId, issue.id);
            } catch (dbErr) {
              console.warn(`[LinearSync] import: DB insert failed for child ${issue.id}, file will be written (watcher will ingest):`, dbErr);
            }
          }

          await fs.promises.writeFile(childPlanFile, childStub, 'utf8');
          imported++;
        } else {
          // Standalone: write file only (same as today — watcher ingests).
          const planFile = path.join(plansDir, `linear_import_${issue.id}.md`);
          await fs.promises.writeFile(planFile, stub, 'utf8');
          imported++;
        }
      }

      // ── Pass 2: Link children to top-level parents (flatten) ────
      // For each child, walk up the parentId chain to find the top-level
      // in-batch parent (a task that has no in-batch parent itself). Link
      // the child to that feature's planId via updateFeatureStatus.
      if (ready) {
        for (const issue of filteredTasks) {
          if (!isChild(issue)) { continue; }
          const childUuid = uuidByIssueId.get(issue.id);
          if (!childUuid) { continue; }

          // Walk up the parent chain to find the top-level parent.
          const visited = new Set<string>();
          let currentIssueId: string | null = issue.id;
          let topParentIssueId: string | null = null;

          while (currentIssueId) {
            if (visited.has(currentIssueId)) {
              console.warn(`[LinearSync] import: cycle detected in parentId chain at ${currentIssueId}, treating as standalone`);
              break;
            }
            visited.add(currentIssueId);

            const currentIssue = tasksById.get(currentIssueId);
            if (!currentIssue) { break; }

            const currentParentId = currentIssue.parent?.id;
            if (!currentParentId || !tasksById.has(currentParentId)) {
              // Current issue has no in-batch parent — it's the top-level parent.
              if (isParent(currentIssueId)) {
                topParentIssueId = currentIssueId;
              }
              break;
            }
            currentIssueId = currentParentId;
          }

          if (topParentIssueId) {
            const topParentUuid = uuidByIssueId.get(topParentIssueId);
            if (topParentUuid) {
              try {
                await db.updateFeatureStatus(childUuid, 0, topParentUuid);
              } catch (linkErr) {
                console.warn(`[LinearSync] import: failed to link child ${issue.id} to feature ${topParentIssueId}:`, linkErr);
              }
            }
          }
        }
      }

      return { success: true, imported, skipped };
    } catch (error) {
      return { success: false, imported: 0, skipped: 0, error: `Import failed: ${error}` };
    }
  }

  // ── Feature Outbound Sync ───────────────────────────────────────

  /**
   * Sync a Switchboard feature + its subtasks to Linear as a parent issue with
   * child issues linked via parentId. Creates/updates the feature issue first
   * (await, not debounce), then links each subtask's existing Linear issue
   * as a child. Subtasks without an existing Linear issue are skipped (added
   * to `failed`) — they will be linked on a future feature-sync trigger once
   * their individual sync creates an issue.
   */
  public async syncFeatureWithSubtasks(params: {
    featurePlanFile: string;
    featureTopic: string;
    featureColumn: string;
    subtasks: Array<{ planFile: string; topic: string; complexity: string }>;
  }): Promise<{ featureIssueId?: string; linked: string[]; failed: string[] }> {
    const config = await this.loadConfig();
    if (!config?.setupComplete || config.realTimeSyncEnabled !== true) {
      return { linked: [], failed: params.subtasks.map(s => s.planFile) };
    }
    if (!(await this.hasApiToken())) {
      return { linked: [], failed: params.subtasks.map(s => s.planFile) };
    }

    const linked: string[] = [];
    const failed: string[] = [];
    let featureIssueId: string | null = null;

    try {
      // 1. Create/update the feature issue first (await, bypass debounce).
      await this.syncPlan(
        { planFile: params.featurePlanFile, topic: params.featureTopic, complexity: 'Unknown' },
        params.featureColumn
      );

      // 2. Look up the feature's issue ID. If still a creating_* temp marker, retry once.
      featureIssueId = await this.getIssueIdForPlan(params.featurePlanFile);
      if (featureIssueId && featureIssueId.startsWith('creating_')) {
        await new Promise(resolve => setTimeout(resolve, 200));
        featureIssueId = await this.getIssueIdForPlan(params.featurePlanFile);
      }
      if (!featureIssueId || featureIssueId.startsWith('creating_')) {
        console.warn(`[LinearSync] syncFeatureWithSubtasks: feature issue ID not resolved for ${params.featurePlanFile} — all subtasks failed`);
        return { linked: [], failed: params.subtasks.map(s => s.planFile) };
      }

      // 3. Link each subtask's existing Linear issue as a child of the feature.
      for (const sub of params.subtasks) {
        try {
          const subIssueId = await this.getIssueIdForPlan(sub.planFile);
          if (subIssueId && !subIssueId.startsWith('creating_')) {
            await this.updateIssueParent(subIssueId, featureIssueId);
            linked.push(sub.planFile);
          } else {
            failed.push(sub.planFile);
          }
        } catch (linkErr) {
          console.warn(`[LinearSync] syncFeatureWithSubtasks: failed to link subtask ${sub.planFile}:`, linkErr);
          failed.push(sub.planFile);
        }
      }
    } catch (featureErr) {
      console.warn(`[LinearSync] syncFeatureWithSubtasks: feature sync failed:`, featureErr);
      return { linked: [], failed: params.subtasks.map(s => s.planFile) };
    }

    return { featureIssueId: featureIssueId ?? undefined, linked, failed };
  }

  /**
   * Unlink subtasks from their feature in Linear — set each subtask's parent to null.
   * Used when a subtask is removed from a feature or reassigned.
   */
  public async unlinkSubtasksFromFeature(subtaskPlanFiles: string[]): Promise<{ unlinked: string[]; failed: string[] }> {
    const config = await this.loadConfig();
    if (!config?.setupComplete || config.realTimeSyncEnabled !== true) {
      return { unlinked: [], failed: subtaskPlanFiles };
    }
    if (!(await this.hasApiToken())) {
      return { unlinked: [], failed: subtaskPlanFiles };
    }

    const unlinked: string[] = [];
    const failed: string[] = [];

    for (const planFile of subtaskPlanFiles) {
      try {
        const issueId = await this.getIssueIdForPlan(planFile);
        if (issueId && !issueId.startsWith('creating_')) {
          await this.updateIssueParent(issueId, null);
          unlinked.push(planFile);
        } else {
          // No external issue — nothing to unlink. Not a failure.
          unlinked.push(planFile);
        }
      } catch (err) {
        console.warn(`[LinearSync] unlinkSubtasksFromFeature: failed for ${planFile}:`, err);
        failed.push(planFile);
      }
    }

    return { unlinked, failed };
  }

  // ── Mission Milestones & Issue Relations ─────────────────────────

  public async createProjectMilestone(
    projectId: string,
    name: string,
    description?: string,
    targetDate?: string,
    sortOrder?: number
  ): Promise<{ id: string; name: string }> {
    const config = await this.loadConfig();
    if (!config?.setupComplete) {
      throw new Error('Linear not configured');
    }

    const normalizedProjectId = String(projectId || '').trim();
    const normalizedName = String(name || '').trim();
    if (!normalizedProjectId || !normalizedName) {
      throw new Error('Linear milestone creation requires a project ID and name.');
    }

    const input: Record<string, any> = {
      projectId: normalizedProjectId,
      name: normalizedName
    };
    if (description) input.description = description;
    if (targetDate) input.targetDate = targetDate;
    if (typeof sortOrder === 'number') input.sortOrder = sortOrder;

    const result = await this.graphqlRequest(`
      mutation($input: ProjectMilestoneCreateInput!) {
        projectMilestoneCreate(input: $input) {
          success
          projectMilestone { id name }
        }
      }
    `, { input });

    if (!result.data?.projectMilestoneCreate?.success || !result.data?.projectMilestoneCreate?.projectMilestone) {
      throw new Error(`Linear milestone creation rejected for project ${normalizedProjectId}.`);
    }

    return {
      id: result.data.projectMilestoneCreate.projectMilestone.id,
      name: result.data.projectMilestoneCreate.projectMilestone.name
    };
  }

  public async updateProjectMilestone(
    milestoneId: string,
    input: { name?: string; description?: string; targetDate?: string | null; sortOrder?: number }
  ): Promise<void> {
    const config = await this.loadConfig();
    if (!config?.setupComplete) {
      throw new Error('Linear not configured');
    }

    const normalizedMilestoneId = String(milestoneId || '').trim();
    if (!normalizedMilestoneId) {
      throw new Error('Linear milestone update requires a milestone ID.');
    }

    const result = await this.graphqlRequest(`
      mutation($id: String!, $input: ProjectMilestoneUpdateInput!) {
        projectMilestoneUpdate(id: $id, input: $input) { success }
      }
    `, { id: normalizedMilestoneId, input });

    if (!result.data?.projectMilestoneUpdate?.success) {
      throw new Error(`Linear milestone update rejected for ${normalizedMilestoneId}.`);
    }
  }

  public async updateIssueMilestone(issueId: string, milestoneId: string | null): Promise<void> {
    const config = await this.loadConfig();
    if (!config?.setupComplete) {
      throw new Error('Linear not configured');
    }

    const normalizedIssueId = String(issueId || '').trim();
    if (!normalizedIssueId) {
      throw new Error('Linear issue milestone update requires an issue ID.');
    }

    const result = await this.graphqlRequest(`
      mutation($id: String!, $milestoneId: String) {
        issueUpdate(id: $id, input: { projectMilestoneId: $milestoneId }) { success }
      }
    `, { id: normalizedIssueId, milestoneId: milestoneId || null });

    if (!result.data?.issueUpdate?.success) {
      throw new Error(`Linear issue ${normalizedIssueId} rejected the requested milestone update.`);
    }

    if (this._cacheService) {
      const projectId = this._issueProjectIndex.get(normalizedIssueId);
      if (projectId) {
        this._cacheService.invalidateTaskCache('linear', `project:${projectId}`);
      } else {
        this._cacheService.invalidateTaskCache('linear');
      }
    }
  }

  public async createIssueRelation(
    issueId: string,
    relatedIssueId: string,
    type: 'blocks' | 'duplicate' | 'related' = 'blocks'
  ): Promise<{ id: string } | null> {
    const config = await this.loadConfig();
    if (!config?.setupComplete) {
      throw new Error('Linear not configured');
    }

    const normalizedIssueId = String(issueId || '').trim();
    const normalizedRelatedIssueId = String(relatedIssueId || '').trim();
    if (!normalizedIssueId || !normalizedRelatedIssueId) {
      throw new Error('Linear relation creation requires both issue IDs.');
    }

    try {
      const result = await this.graphqlRequest(`
        mutation($input: IssueRelationCreateInput!) {
          issueRelationCreate(input: $input) {
            success
            issueRelation { id type }
          }
        }
      `, {
        input: {
          issueId: normalizedIssueId,
          relatedIssueId: normalizedRelatedIssueId,
          type
        }
      });

      if (result.data?.issueRelationCreate?.success && result.data.issueRelationCreate.issueRelation) {
        return { id: result.data.issueRelationCreate.issueRelation.id };
      }
      return null;
    } catch (err: any) {
      const msg = String(err?.message || '');
      if (msg.includes('already exists') || msg.includes('duplicate') || msg.includes('ConstraintViolation')) {
        return null;
      }
      throw err;
    }
  }

  public async deleteIssueRelation(relationId: string): Promise<void> {
    const config = await this.loadConfig();
    if (!config?.setupComplete) {
      throw new Error('Linear not configured');
    }

    const normalizedRelationId = String(relationId || '').trim();
    if (!normalizedRelationId) {
      throw new Error('Linear relation deletion requires a relation ID.');
    }

    const result = await this.graphqlRequest(`
      mutation($id: String!) {
        issueRelationDelete(id: $id) { success }
      }
    `, { id: normalizedRelationId });

    if (!result.data?.issueRelationDelete?.success) {
      throw new Error(`Linear rejected relation deletion for ${normalizedRelationId}.`);
    }
  }

  public async getIssueRelations(issueId: string): Promise<Array<{ id: string; type: string; relatedIssue: { id: string } }>> {
    const config = await this.loadConfig();
    if (!config?.setupComplete) {
      throw new Error('Linear not configured');
    }

    const normalizedIssueId = String(issueId || '').trim();
    if (!normalizedIssueId) {
      throw new Error('Linear relation lookup requires an issue ID.');
    }

    const result = await this.graphqlRequest(`
      query($id: String!) {
        issue(id: $id) {
          relations {
            nodes {
              id
              type
              relatedIssue { id }
            }
          }
        }
      }
    `, { id: normalizedIssueId });

    const nodes = result.data?.issue?.relations?.nodes || [];
    return nodes
      .map((n: any) => ({
        id: String(n?.id || ''),
        type: String(n?.type || ''),
        relatedIssue: { id: String(n?.relatedIssue?.id || '') }
      }))
      .filter((n: any) => n.id && n.relatedIssue.id);
  }

  public async syncMissionsAndDependencies(workspaceId?: string): Promise<{
    milestonesCreated: number;
    membersAssigned: number;
    membersUnassigned: number;
    relationsCreated: number;
    relationsDeleted: number;
  }> {
    const counts = { milestonesCreated: 0, membersAssigned: 0, membersUnassigned: 0, relationsCreated: 0, relationsDeleted: 0 };
    const config = await this.loadConfig();
    if (!config?.setupComplete || !(await this.hasApiToken())) {
      return counts;
    }

    const db = KanbanDatabase.forWorkspace(this._workspaceRoot);
    const wsId = workspaceId || (await db.getWorkspaceId()) || (await db.getDominantWorkspaceId()) || '';
    if (!wsId) {
      return counts;
    }

    let projectId = (await this.resolveSingleIncludeProjectId(config)) || (config as any).projectId;

    // 1. Reconcile Missions -> Project Milestones
    try {
      const missions = await db.getMissions(wsId);
      for (const mission of missions) {
        const members = await db.getMissionMembers(mission.id);
        const memberIssueIds: string[] = [];
        for (const m of members) {
          const plan = await db.getPlanByPlanId(m.memberId);
          if (plan?.linearIssueId) {
            memberIssueIds.push(plan.linearIssueId);
          }
        }

        // On demand: only mirror when a mission has at least one synced member in the tracker
        if (memberIssueIds.length === 0) {
          continue;
        }

        // If project ID is not resolved yet, try resolving from first member issue
        if (!projectId && memberIssueIds.length > 0) {
          try {
            const issue = await this.getIssue(memberIssueIds[0]);
            if (issue?.project?.id) {
              projectId = issue.project.id;
            }
          } catch { /* ignore */ }
        }

        if (!projectId) {
          continue;
        }

        let milestoneMapping = await db.getMissionMilestone(mission.id);
        let milestoneId = milestoneMapping?.milestoneId;

        if (!milestoneId) {
          try {
            const res = await this.createProjectMilestone(projectId, mission.name, mission.goal || undefined);
            if (res?.id) {
              milestoneId = res.id;
              await db.setMissionMilestone(mission.id, milestoneId, projectId, wsId);
              counts.milestonesCreated++;
            }
          } catch (err) {
            console.warn(`[LinearSyncService] Failed to create milestone for mission ${mission.id}:`, err);
          }
        }

        if (milestoneId) {
          let existingIssueIdsInMilestone: Set<string> = new Set();
          try {
            const msRes = await this.graphqlRequest(`
              query($id: String!) {
                projectMilestone(id: $id) {
                  id
                  issues {
                    nodes { id }
                  }
                }
              }
            `, { id: milestoneId });
            const nodes = msRes?.data?.projectMilestone?.issues?.nodes || [];
            for (const n of nodes) {
              if (n?.id) existingIssueIdsInMilestone.add(String(n.id));
            }
          } catch {
            // Fallback: empty set
          }

          const desiredMemberIssueIdSet = new Set(memberIssueIds);

          // Assign members not yet in milestone
          for (const issueId of memberIssueIds) {
            if (!existingIssueIdsInMilestone.has(issueId)) {
              try {
                await this.updateIssueMilestone(issueId, milestoneId);
                counts.membersAssigned++;
              } catch (err) {
                console.warn(`[LinearSyncService] Failed to assign issue ${issueId} to milestone ${milestoneId}:`, err);
              }
            }
          }

          // Unassign members that left the mission
          for (const existingId of existingIssueIdsInMilestone) {
            if (!desiredMemberIssueIdSet.has(existingId)) {
              try {
                await this.updateIssueMilestone(existingId, null);
                counts.membersUnassigned++;
              } catch (err) {
                console.warn(`[LinearSyncService] Failed to unassign issue ${existingId} from milestone ${milestoneId}:`, err);
              }
            }
          }
        }
      }
    } catch (err) {
      console.warn('[LinearSyncService] Failed to sync missions to milestones:', err);
    }

    // 2. Reconcile Plan Dependencies -> Linear 'blocks' Issue Relations
    try {
      const localDeps = await db.getAllPlanDependencies(wsId);
      const desiredEdges: Array<{ blockerIssueId: string; blockedIssueId: string }> = [];

      for (const dep of localDeps) {
        const blockedPlan = await db.getPlanByPlanId(dep.planId);
        const blockerPlan = await db.getPlanByPlanId(dep.dependsOnPlanId);
        if (blockedPlan?.linearIssueId && blockerPlan?.linearIssueId) {
          desiredEdges.push({
            blockerIssueId: blockerPlan.linearIssueId,
            blockedIssueId: blockedPlan.linearIssueId
          });
        }
      }

      // Whole-reconciler skip for the common case. Relations are only ever
      // created by this method, so a workspace that has neither a dependency row
      // nor a recorded creation has no relation state to reconcile — and should
      // spend zero requests discovering that on every 60s poll.
      const hasEverCreatedRelations = (await db.getConfig(LINEAR_RELATIONS_TOUCHED_KEY)) === '1';
      if (desiredEdges.length === 0 && !hasEverCreatedRelations) {
        return counts;
      }

      // Collect ALL Switchboard-managed Linear issue IDs in this workspace,
      // not just those in current deps — deleted deps leave stale relations
      // whose issues are no longer in the dep set but still managed.
      const allPlans = await db.getAllPlans(wsId);
      const managedIssueIds = new Set<string>();
      for (const p of allPlans) {
        if (p.linearIssueId) {
          managedIssueIds.add(p.linearIssueId);
        }
      }

      const existingLinearBlocks = new Map<string, Array<{ relationId: string; blockedIssueId: string }>>();

      // Batched, NOT one request per managed issue. This reconciler runs inside
      // every Remote Control poll (60s default), so a per-issue fetch is N
      // requests a minute: a 100-plan board spends 6,000 requests/hour against a
      // 5,000/hour budget and locks the whole Linear integration out. Chunks of
      // 50 keep a 200-plan board at 4 requests per cycle.
      const managedIdList = Array.from(managedIssueIds);
      const RELATION_BATCH = 50;
      for (let i = 0; i < managedIdList.length; i += RELATION_BATCH) {
        const chunk = managedIdList.slice(i, i + RELATION_BATCH);
        try {
          const batchRes = await this.graphqlRequest(`
            query($ids: [ID!]) {
              issues(filter: { id: { in: $ids } }, first: ${RELATION_BATCH}) {
                nodes {
                  id
                  relations { nodes { id type relatedIssue { id } } }
                }
              }
            }
          `, { ids: chunk });
          const issueNodes = batchRes?.data?.issues?.nodes || [];
          for (const node of issueNodes) {
            const issueId = String(node?.id || '');
            if (!issueId) { continue; }
            const rels = node?.relations?.nodes || [];
            for (const r of rels) {
              const relatedId = String(r?.relatedIssue?.id || '');
              if (String(r?.type || '') === 'blocks' && relatedId) {
                if (!existingLinearBlocks.has(issueId)) {
                  existingLinearBlocks.set(issueId, []);
                }
                existingLinearBlocks.get(issueId)!.push({
                  relationId: String(r.id),
                  blockedIssueId: relatedId
                });
              }
            }
          }
        } catch (err) {
          console.warn(`[LinearSyncService] Failed to fetch relations batch (${chunk.length} issues):`, err);
        }
      }

      // Create missing desired relations
      for (const edge of desiredEdges) {
        const existingList = existingLinearBlocks.get(edge.blockerIssueId) || [];
        const alreadyExists = existingList.some(e => e.blockedIssueId === edge.blockedIssueId);
        if (!alreadyExists) {
          try {
            const created = await this.createIssueRelation(edge.blockerIssueId, edge.blockedIssueId, 'blocks');
            if (created) {
              counts.relationsCreated++;
              await db.setConfig(LINEAR_RELATIONS_TOUCHED_KEY, '1');
            }
          } catch (err) {
            console.warn(`[LinearSyncService] Failed to create relation ${edge.blockerIssueId} blocks ${edge.blockedIssueId}:`, err);
          }
        }
      }

      // Remove stale relations between Switchboard-managed issues in this workspace.
      // A relation is managed if BOTH endpoints are Switchboard-managed issues.
      // This catches relations whose dep row was deleted — the issues are still
      // managed (have plans) but no longer have a desired edge.
      for (const [blockerIssueId, relList] of existingLinearBlocks.entries()) {
        for (const rel of relList) {
          const isManagedEdge = managedIssueIds.has(rel.blockedIssueId);
          if (isManagedEdge) {
            const isDesired = desiredEdges.some(
              d => d.blockerIssueId === blockerIssueId && d.blockedIssueId === rel.blockedIssueId
            );
            if (!isDesired) {
              try {
                await this.deleteIssueRelation(rel.relationId);
                counts.relationsDeleted++;
              } catch (err) {
                console.warn(`[LinearSyncService] Failed to delete relation ${rel.relationId}:`, err);
              }
            }
          }
        }
      }
    } catch (err) {
      console.warn('[LinearSyncService] Failed to sync plan dependencies:', err);
    }

    return counts;
  }

  // ── Native App User & Agent Session Surface ──────────────────────

  private _agentSessionsByIssue = new Map<string, { sessionId: string; createdAt: number }>();

  public async fetchAssignedIssues(): Promise<Array<{
    id: string;
    identifier: string;
    title: string;
    description: string;
    url: string;
    state?: { id: string; name: string; type: string };
    parent?: { id: string };
    project?: { id: string; name: string };
    updatedAt: string;
  }>> {
    const config = await this.loadConfig();
    // Gate on credential KIND, not presence. With a personal API key `viewer`
    // is the HUMAN operator, so this query returns every issue assigned to
    // them — importing all of it as plans is a board flood, not a dispatch.
    // The agent surface exists only for the OAuth app actor.
    if (!config?.setupComplete || !(await this.isOAuthAppActor())) {
      return [];
    }

    const query = `
      query {
        viewer {
          id
          assignedIssues(filter: { state: { type: { nin: ["completed", "canceled", "cancelled"] } } }, first: 100) {
            nodes {
              id
              identifier
              title
              description
              url
              state { id name type }
              parent { id }
              project { id name }
              updatedAt
            }
          }
        }
      }
    `;

    try {
      const resp = await this.graphqlRequest(query, {});
      const nodes = resp?.data?.viewer?.assignedIssues?.nodes || [];
      return nodes.map((n: any) => ({
        id: String(n.id || ''),
        identifier: String(n.identifier || ''),
        title: String(n.title || ''),
        description: String(n.description || ''),
        url: String(n.url || ''),
        state: n.state ? { id: String(n.state.id || ''), name: String(n.state.name || ''), type: String(n.state.type || '') } : undefined,
        parent: n.parent ? { id: String(n.parent.id || '') } : undefined,
        project: n.project ? { id: String(n.project.id || ''), name: String(n.project.name || '') } : undefined,
        updatedAt: String(n.updatedAt || '')
      })).filter((n: any) => n.id);
    } catch (err) {
      console.warn('[LinearSyncService] fetchAssignedIssues failed:', err);
      return [];
    }
  }

  public async fetchMentionNotifications(): Promise<Array<{
    id: string;
    type: string;
    createdAt: string;
    issue?: { id: string; identifier: string; title: string; url: string; description?: string };
    comment?: { id: string; body: string; createdAt: string; issue?: { id: string; identifier: string; title: string; url: string } };
  }>> {
    const config = await this.loadConfig();
    // Same gate as fetchAssignedIssues, and for a sharper reason: on a
    // personal key these are the operator's OWN unread notifications, and the
    // relay path archives every one it handles. Never touch a human's inbox.
    if (!config?.setupComplete || !(await this.isOAuthAppActor())) {
      return [];
    }

    const query = `
      query {
        viewer {
          id
          notifications(filter: { type: { in: ["issueMention", "commentMention"] }, read: { eq: false } }, first: 50) {
            nodes {
              id
              type
              createdAt
              issue { id identifier title url description }
              comment { id body createdAt issue { id identifier title url } }
            }
          }
        }
      }
    `;

    try {
      const resp = await this.graphqlRequest(query, {});
      const nodes = resp?.data?.viewer?.notifications?.nodes || [];
      return nodes.map((n: any) => ({
        id: String(n.id || ''),
        type: String(n.type || ''),
        createdAt: String(n.createdAt || ''),
        issue: n.issue ? {
          id: String(n.issue.id || ''),
          identifier: String(n.issue.identifier || ''),
          title: String(n.issue.title || ''),
          url: String(n.issue.url || ''),
          description: String(n.issue.description || '')
        } : undefined,
        comment: n.comment ? {
          id: String(n.comment.id || ''),
          body: String(n.comment.body || ''),
          createdAt: String(n.comment.createdAt || ''),
          issue: n.comment.issue ? {
            id: String(n.comment.issue.id || ''),
            identifier: String(n.comment.issue.identifier || ''),
            title: String(n.comment.issue.title || ''),
            url: String(n.comment.issue.url || '')
          } : undefined
        } : undefined
      })).filter((n: any) => n.id);
    } catch (err) {
      console.warn('[LinearSyncService] fetchMentionNotifications failed:', err);
      return [];
    }
  }

  public async archiveNotification(notificationId: string): Promise<boolean> {
    const normalizedId = String(notificationId || '').trim();
    if (!normalizedId) return false;

    try {
      const result = await this.graphqlRequest(`
        mutation($id: String!) {
          notificationArchive(id: $id) {
            success
          }
        }
      `, { id: normalizedId });
      return result.data?.notificationArchive?.success === true;
    } catch (err) {
      console.warn(`[LinearSyncService] archiveNotification failed for ${normalizedId}:`, err);
      return false;
    }
  }

  public async createAgentSessionOnIssue(issueId: string): Promise<string | null> {
    const normalizedIssueId = String(issueId || '').trim();
    if (!normalizedIssueId) return null;

    try {
      const result = await this.graphqlRequest(`
        mutation($issueId: String!) {
          agentSessionCreateOnIssue(issueId: $issueId) {
            success
            agentSession { id }
          }
        }
      `, { issueId: normalizedIssueId });

      const sessionId = result.data?.agentSessionCreateOnIssue?.agentSession?.id;
      if (sessionId) {
        this._agentSessionsByIssue.set(normalizedIssueId, { sessionId, createdAt: Date.now() });
        return sessionId;
      }
      return null;
    } catch (err) {
      console.warn(`[LinearSyncService] createAgentSessionOnIssue failed for ${normalizedIssueId}:`, err);
      return null;
    }
  }

  public async createAgentSessionOnComment(commentId: string): Promise<string | null> {
    const normalizedCommentId = String(commentId || '').trim();
    if (!normalizedCommentId) return null;

    try {
      const result = await this.graphqlRequest(`
        mutation($commentId: String!) {
          agentSessionCreateOnComment(commentId: $commentId) {
            success
            agentSession { id }
          }
        }
      `, { commentId: normalizedCommentId });

      return result.data?.agentSessionCreateOnComment?.agentSession?.id || null;
    } catch (err) {
      console.warn(`[LinearSyncService] createAgentSessionOnComment failed for ${normalizedCommentId}:`, err);
      return null;
    }
  }

  public async getOrCreateAgentSession(issueId: string): Promise<string | null> {
    const normalizedIssueId = String(issueId || '').trim();
    if (!normalizedIssueId) return null;

    const existing = this._agentSessionsByIssue.get(normalizedIssueId);
    // Keep session active for up to 2 hours
    if (existing && Date.now() - existing.createdAt < 2 * 60 * 60 * 1000) {
      return existing.sessionId;
    }
    return await this.createAgentSessionOnIssue(normalizedIssueId);
  }

  public async postAgentActivity(
    agentSessionId: string,
    content: string,
    ephemeral = false,
    signal?: string
  ): Promise<boolean> {
    const normalizedSessionId = String(agentSessionId || '').trim();
    const normalizedContent = String(content || '').trim();
    if (!normalizedSessionId || !normalizedContent) return false;

    const input: Record<string, any> = {
      agentSessionId: normalizedSessionId,
      content: normalizedContent,
      ephemeral: ephemeral === true
    };
    if (signal) input.signal = signal;

    try {
      const result = await this.graphqlRequest(`
        mutation($input: AgentActivityCreateInput!) {
          agentActivityCreate(input: $input) {
            success
            agentActivity { id }
          }
        }
      `, { input });

      return result.data?.agentActivityCreate?.success === true;
    } catch (err) {
      console.warn(`[LinearSyncService] postAgentActivity failed for session ${normalizedSessionId}:`, err);
      return false;
    }
  }
}
