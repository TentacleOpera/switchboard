/**
 * Stable Codename Generator
 *
 * Emits a stable two-word {adjective}-{noun} codename for a mission card
 * derived deterministically from its seed (planId / id).
 */

export const CODENAME_ADJECTIVES: readonly string[] = [
    'agile', 'amber', 'ancient', 'astral', 'atomic',
    'autumn', 'azure', 'bold', 'brave', 'bright',
    'bronze', 'calm', 'cedar', 'celestial', 'clever',
    'cobalt', 'copper', 'coral', 'cosmic', 'crimson',
    'crystal', 'daring', 'dawn', 'diamond', 'dusk',
    'eager', 'emerald', 'epic', 'fierce', 'fleet',
    'flint', 'frost', 'gallant', 'gentle', 'golden',
    'granite', 'harbor', 'hasty', 'iron', 'jade',
    'keen', 'kinetic', 'lunar', 'mystic', 'nimble',
    'noble', 'ocean', 'onyx', 'polar', 'radiant',
    'rapid', 'ruby', 'rustic', 'sapphire', 'shadow',
    'silver', 'solar', 'sonic', 'stellar', 'swift',
    'timber', 'topaz', 'valiant', 'velvet', 'vivid'
];

export const CODENAME_NOUNS: readonly string[] = [
    'anchor', 'arrow', 'aurora', 'beacon', 'breeze',
    'canyon', 'cascade', 'castle', 'cliff', 'comet',
    'compass', 'crane', 'crest', 'drift', 'eagle',
    'ember', 'falcon', 'feather', 'forest', 'forge',
    'fox', 'glacier', 'grove', 'harbor', 'haven',
    'hawk', 'horizon', 'island', 'lynx', 'meadow',
    'meteor', 'mountain', 'nebula', 'nexus', 'oasis',
    'orbit', 'peak', 'pioneer', 'prism', 'pulsar',
    'quarry', 'radar', 'raven', 'ridge', 'river',
    'rover', 'sentry', 'shadow', 'summit', 'temple',
    'tide', 'timber', 'trail', 'valley', 'vanguard',
    'vector', 'voyage', 'wave', 'whisper', 'zenith'
];

function hashSeed(seed: string, salt: number = 0): number {
    let hash = 2166136261 ^ salt;
    for (let i = 0; i < seed.length; i++) {
        hash ^= seed.charCodeAt(i);
        hash = Math.imul(hash, 16777619);
    }
    return Math.abs(hash >>> 0);
}

export function generateCodename(seed: string, salt: number = 0): string {
    const cleanSeed = (seed || 'mission').trim().toLowerCase();
    const h1 = hashSeed(cleanSeed, salt);
    const h2 = hashSeed(cleanSeed, salt + 1013);
    const adj = CODENAME_ADJECTIVES[h1 % CODENAME_ADJECTIVES.length];
    const noun = CODENAME_NOUNS[h2 % CODENAME_NOUNS.length];
    return `${adj}-${noun}`;
}
