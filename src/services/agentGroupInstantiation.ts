import { MAX_DELEGATES_PER_PARENT, MAX_LIVE_DELEGATE_PTYS } from '../standalone/ptyFleetService';
import { wireSpawnedTeam, AGENT_GROUP_CALLBACK_INSTRUCTION } from './teamWiring';

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
    const wired = await wireSpawnedTeam({ db, headName, children: workers, members: Array.isArray(group?.members) ? group.members : undefined, prompt: group?.prompt, headPrompt: group?.headPrompt });
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
    };
}
