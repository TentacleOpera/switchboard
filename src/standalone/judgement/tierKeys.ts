import { StandaloneHostSecrets } from '../../services/encryptedSecretsStore';
import { stateFile } from '../../utils/stateHome';

/**
 * Read a tier's API key from the board's encrypted secrets store
 * (plan: judgement-tiers-the-supervisor-seat-and-reroute, change 7).
 *
 * The controller is co-located with the board by design, so it reads the
 * credential from the same on-disk store the board writes, over no wire at all.
 * Key VALUES are never exposed on the board's config surface — the config
 * reports only `keySet`, and this is the one place a value is read.
 *
 * The key name is the shipped per-provider slot
 * (`switchboard.agentControl.apiKey.<providerId>`), so a key set from the
 * existing Agent Control panel is the key this reads. There is no second
 * credential store.
 */
export async function readTierApiKey(workspaceRoot: string, providerId: string): Promise<{ key: string | null; error?: string }> {
    if (!providerId) { return { key: null }; }
    try {
        const store = new StandaloneHostSecrets(stateFile('secrets.enc'), stateFile('.master-key'));
        const value = await store.get(`switchboard.agentControl.apiKey.${providerId}`);
        return { key: value ? String(value) : null };
    } catch (e) {
        // An unreadable store is NOT "no key configured" — that conflation makes
        // a locked keychain look like a missing credential.
        return { key: null, error: `secrets store read failed: ${e instanceof Error ? e.message : String(e)}` };
    }
}
