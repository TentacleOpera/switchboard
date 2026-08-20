import * as fs from 'fs';
import * as path from 'path';
import { MAX_DELEGATES_PER_PARENT, MAX_LIVE_DELEGATE_PTYS } from '../standalone/ptyFleetService';
import { wireSpawnedTeam, AGENT_GROUP_CALLBACK_INSTRUCTION, SEEDED_AGENT_GROUP, type TerminalGroupsSettingsAccessor } from './teamWiring';
import { bootstrapTeamReportsDirectory } from './ScheduledJobsService';

// Re-exported for downstream consumers (e.g. the team-member-scope preset).
// The instruction text now lives in teamWiring.ts, where the shared wiring
// function that installs it resides.
export { AGENT_GROUP_CALLBACK_INSTRUCTION };

/**
 * Host-agnostic core of "instantiate an agent group".
 *
 * The two hosts differ in exactly one respect — how a head terminal plus its
 * delegate children get created:
 *
 * - Extension host: the fleet lives in the pty-host child process, reached with
 *   `_ptyHostVerb('ptyCreateTerminal', …)` — deliberately BELOW `handlePtyVerb`,
 *   which overwrites `delegates` from role config.
 * - Standalone: the fleet is in-process, so `ptyFleetService.create()` +
 *   `spawnDelegates()` are called directly — again below the `handlePtyVerb`
 *   wrapper, which applies the same overwrite.
 *
 * Everything else — the three-cap pre-flight, the standing-order orientation,
 * idempotency, partial-failure handling — is identical, and duplicating it was
 * how the orientation bug survived: one host is where a defect hides.
 *
 * The wire-supplied `startupCommand`/`delegates` guards on both hosts' HTTP rails
 * are untouched. This is trusted host-side code resolving a definition the user
 * authored in the Agents tab; the guards exist to stop the *wire* supplying one.
 */

export interface AgentGroupCreateResult {
    success: boolean;
    terminal?: { friendlyName?: string;[k: string]: any };
    delegates?: Array<{ friendlyName: string;[k: string]: any }>;
    delegateError?: string;
    error?: string;
}

export interface InstantiateAgentGroupOptions {
    db: any;
    settings?: TerminalGroupsSettingsAccessor;
    group: any;
    cwd: string;
    /** Count of live delegate (parented) ptys across the whole fleet. */
    liveDelegateCount: () => Promise<number>;
    /** Create the head with its delegate members, BELOW the handlePtyVerb wrapper. */
    createHeadWithDelegates: (spec: {
        role: string;
        name: string;
        cwd: string;
        delegates: any[];
        teamName?: string;
    }) => Promise<AgentGroupCreateResult>;
    /** Host hook fired once terminals exist (e.g. the runtime.terminals mirror). */
    onCreated?: () => void;
}

export interface InstantiateAgentGroupResult {
    success: boolean;
    created?: string[];
    workers?: any[];
    delegateError?: string;
    error?: string;
    /**
     * The terminals-group id `wireSpawnedTeam` registered for this team.
     * The webview switches to this group to seat the whole team; the id
     * formula is NOT to be re-derived client-side (see wireSpawnedTeam's
     * WireSpawnedTeamResult comment). Absent when no group was registered
     * (member-less team) or when wiring failed.
     */
    teamGroupId?: string;
}

export async function instantiateAgentGroupCore(
    opts: InstantiateAgentGroupOptions
): Promise<InstantiateAgentGroupResult> {
    const { db, group, cwd, liveDelegateCount, createHeadWithDelegates, onCreated } = opts;

    if (!db) { return { success: false, error: 'Kanban DB not ready' }; }

    const members = Array.isArray(group?.members) ? group.members : [];

    // Mirror spawnDelegates' own arithmetic exactly (per-definition clamp, then
    // sum) so the pre-flight refusal and the engine's refusal agree. Diverging
    // here produces the worst outcome: we let it through, the head spawns, and
    // spawnDelegates refuses — leaving an orphan agent CLI running.
    const workerCount = members.reduce(
        (n: number, m: any) => n + Math.max(1, Math.min(m?.count || 1, MAX_DELEGATES_PER_PARENT)), 0);

    // Pre-flight the two delegate caps before creating anything. spawnDelegates
    // checks its own, but only after the head terminal already exists — so an
    // over-cap group would leave a running head behind and report a
    // delegateError. This is the difference between "nothing happened" and "you
    // now have an orphan agent CLI to close by hand". The standing-orders cap
    // (MAX_ORDERS) was removed — it bounded how many teams you could have, not
    // what reaches any prompt, and nothing ever pruned orders.
    if (workerCount > MAX_DELEGATES_PER_PARENT) {
        return { success: false, error: `Delegate cap: ${workerCount} requested, ${MAX_DELEGATES_PER_PARENT} allowed per head agent` };
    }
    const liveDelegates = await liveDelegateCount();
    if (liveDelegates + workerCount > MAX_LIVE_DELEGATE_PTYS) {
        return { success: false, error: `Delegate cap: ${liveDelegates} live, ${workerCount} requested, ${MAX_LIVE_DELEGATE_PTYS} allowed in total` };
    }

    const result = await createHeadWithDelegates({
        role: group?.headRole || 'lead',
        name: group?.name,
        cwd,
        delegates: members,
        teamName: group?.name,
    });
    if (!result?.success) {
        return { success: false, error: result?.error || 'Failed to create head terminal' };
    }

    const headName = result.terminal?.friendlyName || group?.name;
    const workers: any[] = Array.isArray(result.delegates) ? result.delegates : [];
    const created: string[] = [headName, ...workers.map((w: any) => w.friendlyName)];

    onCreated?.();

    // Wire the team through the shared host-agnostic function — standing orders
    // + group registration. This replaces the inline standing-order block that
    // lived here: running both would double every order. The function is
    // idempotent (skip existing pairs / group ids).
    //
    // This wrapper runs BELOW handlePtyVerb (its header comment explains why:
    // the wrapper overwrites `delegates` from role config), so it will not
    // inherit the post-create hook — it needs its own call. The order is
    // installed exactly once on this path, not twice.
    //
    // Terminals are already created — do not roll back. Surface the error.
    const wired = await wireSpawnedTeam({ db, settings: opts.settings, headName, children: workers, members: Array.isArray(group?.members) ? group.members : undefined, prompt: group?.prompt, headPrompt: group?.headPrompt, headRole: group?.headRole, pacing: group?.pacing === 'seat' ? 'seat' : 'head', templateId: group?.id });
    if (!wired.ok) {
        return {
            success: true,
            created,
            workers,
            delegateError: result.delegateError || undefined,
            error: `Terminals created but team wiring failed: ${wired.error}`,
        };
    }

    return {
        success: true,
        created,
        workers,
        delegateError: result.delegateError || undefined,
        ...(wired.groupId ? { teamGroupId: wired.groupId } : {}),
    };
}

/**
 * Resolve a team template by name or id for the external-headed team path.
 *
 * ONE resolver, called by both hosts (LocalApiServer's built-in fallback and the
 * standalone bootstrap's `createExternalTeam`). Two copies of this table drift the
 * moment either host gains a template, and the drift is silent — the same
 * `template` string produces two different rosters depending on which host served
 * the request.
 *
 * The operator's own teams (`terminals.agentGroups` — what the TEAMS tab gallery
 * shows) win. `SEEDED_AGENT_GROUP` is the only shipped starter, so it is the only
 * hard-coded fallback: nothing here invents a roster the operator never authored.
 */
export async function resolveExternalTeamTemplate(db: any, template: string): Promise<any | null> {
    const wanted = String(template || '').trim().toLowerCase();
    if (!wanted) { return null; }
    try {
        const customGroups = await db?.getConfigJson?.('terminals.agentGroups', []) as any[];
        if (Array.isArray(customGroups)) {
            const hit = customGroups.find((g: any) =>
                g && (String(g.name ?? '').toLowerCase() === wanted || String(g.id ?? '').toLowerCase() === wanted));
            if (hit) { return hit; }
        }
    } catch { /* fall through to the shipped starter */ }
    const seed = SEEDED_AGENT_GROUP;
    if (String(seed.name).toLowerCase() === wanted || String(seed.id).toLowerCase() === wanted) {
        return seed;
    }
    return null;
}

export interface WriteHeadPromptFileOptions {
    headName: string;
    featureId?: string;
    workers: Array<{ friendlyName: string; role?: string; [k: string]: any }>;
    group?: any;
    apiPort?: number;
}

/**
 * Writes `.switchboard/teams/<teamId>/head-prompt.md` containing all instructions,
 * endpoints, and context an external agent lead needs to operate a team.
 */
export async function writeHeadPromptFile(
    workspaceRoot: string,
    teamId: string,
    opts: WriteHeadPromptFileOptions
): Promise<string | null> {
    const sbDir = path.join(workspaceRoot, '.switchboard');
    // Lazy creation, same guard as bootstrapTeamReportsDirectory: `.switchboard`
    // is created by the extension's own scaffolder, never by a writer that
    // happens to want a subdirectory. `mkdir -p` here would litter a
    // non-Switchboard workspace with a half-built control directory.
    if (!fs.existsSync(sbDir)) { return null; }
    const teamDir = path.join(sbDir, 'teams', teamId);
    await fs.promises.mkdir(teamDir, { recursive: true });

    const filePath = path.join(teamDir, 'head-prompt.md');
    const { headName, featureId, workers, apiPort } = opts;

    const workerLines = workers.map(w => `- **${w.friendlyName}** (${w.role || 'worker'})`).join('\n');

    const content = `# Team Lead Instructions — ${headName}

You lead this external team via HTTP and filesystem interfaces.

## 1. Identity & Routing
- **Head Name / Origin:** \`${headName}\`
- **Team ID:** \`${teamId}\`
- **Team Reports Directory:** \`.switchboard/teams/${teamId}/reports/\`
- **Claimed Reports Directory:** \`.switchboard/teams/${teamId}/reports/claimed/\`
${featureId ? `- **Active Feature ID:** \`${featureId}\`\n` : ''}
## 2. Team Roster
${workerLines || '- (no worker terminals)'}

## 3. Port Discovery & Endpoint Access
Read the LocalApiServer port from \`.switchboard/api-server-port.txt\` (or \`.switchboard/api-port\`).
Base URL: \`http://127.0.0.1:<port>\`${apiPort ? ` (default / current port: ${apiPort})` : ''}

## 4. Work Dispatch & Communication
- **Dispatch subtask to worker:** \`POST /kanban/dispatch\`
  \`\`\`json
  {
    "plan": "<subtaskPlanId>",
    "targetColumn": "<CODING_COLUMN>",
    "from": "${headName}"
  }
  \`\`\`
- **Send prompt to worker terminal:** \`POST /terminals/verb/ptySendPrompt\`
  \`\`\`json
  {
    "name": "<workerFriendlyName>",
    "data": "<prompt content>",
    "clearBeforePrompt": false
  }
  \`\`\`

## 5. Board Reads & Status Check
- **Read full board:** \`GET /kanban/board\`
- **List features (yours is \`${featureId || '<featureId>'}\`):** \`GET /kanban/features\`
- **Read one plan:** \`GET /kanban/plan?planId=<planId>\`
- **Read plans:** \`GET /kanban/plans\`

There is no \`GET /kanban/feature\` — \`/kanban/feature\` is POST-only (feature creation).
Read features with \`GET /kanban/features\` and pick yours out of the list.

## 6. Verification Pattern
Verify worker progress directly via git in the workspace / worktree:
\`\`\`bash
git -C <worktree> rev-list --count <base>..HEAD
git -C <worktree> diff <base>..HEAD
\`\`\`
Do not rely on worker self-reports alone; inspect the actual git commits.

## 7. Advancing & Review
When all subtasks of the feature are complete and verified:
\`\`\`json
POST /kanban/dispatch
{
  "plan": "<featurePlanId>",
  "targetColumn": "CODE REVIEWED",
  "from": "${headName}"
}
\`\`\`
*(Do not use /kanban/move for review handoff; /kanban/dispatch triggers the reviewer).*

## 8. Pull Next Feature (Lead-Paced Pipeline)
When the reviewer reports the feature has passed review, pull the next staged feature:
\`\`\`json
POST /kanban/queue/next
{
  "from": "${headName}"
}
\`\`\`
- If a card is returned in \`dispatched\`, begin working on its subtasks.
- If \`dispatched: null\` (\`reason: "queue empty"\`), report that the queue is empty and stop.
- If status \`409\`, your team still has work in flight in a coding column.

## 9. Tick Loop (Schedule / Periodic Wake)
On each wake (or when notified by a background watcher):
1. Read this file (\`.switchboard/teams/${teamId}/head-prompt.md\`) to re-orient.
2. Read incoming reports in \`.switchboard/teams/${teamId}/reports/\`.
3. Process each report, verify with git, and move processed reports to \`.switchboard/teams/${teamId}/reports/claimed/\`.
4. Dispatch new subtasks to available workers or advance cards.
5. If the feature is complete and reviewed, pull the next feature via \`POST /kanban/queue/next\`.
`;

    await fs.promises.writeFile(filePath, content, 'utf8');
    return filePath;
}

export interface InstantiateExternalHeadedTeamOptions {
    db: any;
    settings?: TerminalGroupsSettingsAccessor;
    group: any;
    headName: string;
    featureId?: string;
    cwd: string;
    workspaceRoot?: string;
    apiPort?: number;
    liveDelegateCount?: () => Promise<number>;
    createDelegatesOnly: (spec: {
        cwd: string;
        delegates: any[];
        teamName?: string;
    }) => Promise<{
        success: boolean;
        delegates?: Array<{ friendlyName: string; role?: string; [k: string]: any }>;
        delegateError?: string;
        error?: string;
    }>;
    onCreated?: () => void;
}

export interface InstantiateExternalHeadedTeamResult {
    success: boolean;
    teamId?: string;
    workers?: any[];
    headPromptFile?: string;
    reportsDir?: string;
    delegateError?: string;
    error?: string;
}

/**
 * Instantiates an external-headed team (no head terminal is spawned).
 * Spawns only delegate terminals, registers the team in terminals.groups,
 * bootstraps the team reports directory, and writes head-prompt.md.
 */
export async function instantiateExternalHeadedTeam(
    opts: InstantiateExternalHeadedTeamOptions
): Promise<InstantiateExternalHeadedTeamResult> {
    const { db, group, headName, featureId, cwd, workspaceRoot, apiPort, liveDelegateCount, createDelegatesOnly, onCreated } = opts;

    if (!db) { return { success: false, error: 'Kanban DB not ready' }; }
    if (!headName) { return { success: false, error: 'headName is required' }; }

    const members = Array.isArray(group?.members) ? group.members : [];

    const workerCount = members.reduce(
        (n: number, m: any) => n + Math.max(1, Math.min(m?.count || 1, MAX_DELEGATES_PER_PARENT)), 0);

    if (workerCount > MAX_DELEGATES_PER_PARENT) {
        return { success: false, error: `Delegate cap: ${workerCount} requested, ${MAX_DELEGATES_PER_PARENT} allowed per head agent` };
    }
    if (liveDelegateCount) {
        const liveDelegates = await liveDelegateCount();
        if (liveDelegates + workerCount > MAX_LIVE_DELEGATE_PTYS) {
            return { success: false, error: `Delegate cap: ${liveDelegates} live, ${workerCount} requested, ${MAX_LIVE_DELEGATE_PTYS} allowed in total` };
        }
    }

    const result = await createDelegatesOnly({
        cwd,
        delegates: members,
        teamName: headName,
    });
    if (!result?.success) {
        return { success: false, error: result?.error || 'Failed to spawn delegate terminals' };
    }

    const workers: any[] = Array.isArray(result.delegates) ? result.delegates : [];
    onCreated?.();

    const root = workspaceRoot || cwd;
    const teamId = 'team_' + encodeURIComponent(headName).replace(/[^a-zA-Z0-9_]/g, '_');

    // Bootstrap the reports inbox before wiring — the callback instruction the
    // wiring installs names this directory, so it must exist by the time a
    // worker reads its standing order.
    const reportsDir = await bootstrapTeamReportsDirectory(root, teamId);

    // Wire the team with externalHead: true. The head-prompt file is written
    // through `regenerateHeadPrompt`, which wireSpawnedTeam fires after the
    // group registration lands — so the roster in the file is the roster that
    // was actually persisted, and any later caller that re-wires the team with
    // a changed roster regenerates the file by the same seam. The file is the
    // external agent's ONLY interface; a stale roster is a silent failure.
    let headPromptFile: string | undefined;
    const wired = await wireSpawnedTeam({
        db,
        settings: opts.settings,
        headName,
        children: workers,
        members: Array.isArray(group?.members) ? group.members : undefined,
        prompt: group?.prompt,
        headRole: group?.headRole,
        teamId,
        externalHead: true,
        pacing: group?.pacing === 'seat' ? 'seat' : 'head',
        templateId: group?.id,
        regenerateHeadPrompt: async ({ groupId, memberNames }) => {
            try {
                const written = await writeHeadPromptFile(root, groupId, {
                    headName,
                    featureId,
                    workers: memberNames.map((name) => {
                        const spawned = workers.find((w: any) => w && w.friendlyName === name);
                        return spawned || { friendlyName: name };
                    }),
                    group,
                    apiPort,
                });
                headPromptFile = written || undefined;
            } catch (err) {
                console.warn(`[agentGroupInstantiation] writeHeadPromptFile failed:`, err);
            }
        },
    });

    if (!wired.ok) {
        return {
            success: true,
            teamId,
            workers,
            delegateError: result.delegateError || undefined,
            error: `Terminals created but team wiring failed: ${wired.error}`,
        };
    }

    return {
        success: true,
        teamId,
        workers,
        headPromptFile,
        reportsDir: reportsDir || undefined,
        delegateError: result.delegateError || undefined,
    };
}
