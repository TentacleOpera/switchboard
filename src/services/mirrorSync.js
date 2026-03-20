'use strict';

const fs = require('fs');
const path = require('path');

function setRecentWrite(recentWrites, stablePath, ttlMs) {
    const existing = recentWrites.get(stablePath);
    if (existing) clearTimeout(existing);
    recentWrites.set(stablePath, setTimeout(() => recentWrites.delete(stablePath), ttlMs));
}

/**
 * Synchronize mirror plan content into the underlying brain plan + existing sidecars.
 * Returns write details for caller logging and assertions.
 */
async function syncMirrorToBrain(options) {
    const {
        mirrorPath,
        resolvedBrainPath,
        getStablePath,
        getResolvedSidecarPaths,
        recentBrainWrites,
        writeTtlMs = 2000
    } = options;

    const mirrorContent = await fs.promises.readFile(mirrorPath, 'utf8');
    const brainContent = fs.existsSync(resolvedBrainPath)
        ? await fs.promises.readFile(resolvedBrainPath, 'utf8')
        : null;

    const resolvedSidecars = getResolvedSidecarPaths(resolvedBrainPath);
    let sidecarNeedsUpdate = false;
    for (const sidecarPath of resolvedSidecars) {
        try {
            const sidecarContent = await fs.promises.readFile(sidecarPath, 'utf8');
            if (sidecarContent !== mirrorContent) {
                sidecarNeedsUpdate = true;
                break;
            }
        } catch {
            sidecarNeedsUpdate = true;
            break;
        }
    }

    const baseNeedsUpdate = mirrorContent !== brainContent;
    if (!baseNeedsUpdate && !sidecarNeedsUpdate) {
        return { updatedBase: false, sidecarWrites: 0, changed: false };
    }

    await fs.promises.mkdir(path.dirname(resolvedBrainPath), { recursive: true });

    if (baseNeedsUpdate) {
        const stableBrainPath = getStablePath(resolvedBrainPath);
        setRecentWrite(recentBrainWrites, stableBrainPath, writeTtlMs);
        await fs.promises.writeFile(resolvedBrainPath, mirrorContent);
    }

    let sidecarWrites = 0;
    for (const sidecarPath of resolvedSidecars) {
        let sidecarContent;
        try {
            sidecarContent = await fs.promises.readFile(sidecarPath, 'utf8');
        } catch {
            sidecarContent = undefined;
        }
        if (sidecarContent === mirrorContent) continue;

        const stableSidecarPath = getStablePath(sidecarPath);
        setRecentWrite(recentBrainWrites, stableSidecarPath, writeTtlMs);
        await fs.promises.writeFile(sidecarPath, mirrorContent);
        sidecarWrites++;
    }

    return { updatedBase: baseNeedsUpdate, sidecarWrites, changed: baseNeedsUpdate || sidecarWrites > 0 };
}

module.exports = {
    syncMirrorToBrain
};
