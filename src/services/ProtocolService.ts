import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";
import { KanbanDatabase, ControlPlaneEntry } from "./KanbanDatabase";
import { BUNDLED_PROTOCOLS, BundledProtocol } from "./bundledProtocols";
import { stateFile } from "../utils/stateHome";

export interface ResolvedProtocol {
    name: string;
    body: string;
    path?: string;
    delivery: "inline" | "materialize";
}

export class ProtocolService {
    /**
     * Seeds all bundled protocols into the control_plane table of the database.
     */
    public static async seedProtocols(db: KanbanDatabase): Promise<{ seeded: number; updated: number }> {
        const entries: ControlPlaneEntry[] = Object.values(BUNDLED_PROTOCOLS).map(p => ({
            name: p.name,
            kind: "protocol",
            version: p.version,
            contentHash: p.contentHash,
            body: p.body,
            delivery: p.delivery,
            updatedAt: new Date().toISOString()
        }));
        return await db.seedControlPlane(entries);
    }

    /**
     * Resolves a protocol by name or path.
     * Returns the body (for inline) or materialized absolute path (for materialize).
     */
    public static async resolveProtocol(
        rawName: string,
        workspaceRoot?: string,
        kanbanDb?: KanbanDatabase
    ): Promise<ResolvedProtocol | null> {
        if (!rawName || typeof rawName !== "string") {
            return null;
        }

        const name = this.normalizeProtocolName(rawName);
        if (!name) {
            return null;
        }

        // improve-remote-plan was deleted outright per architectural decision
        if (name === "improve-remote-plan") {
            return null;
        }

        let entry: ControlPlaneEntry | null = null;
        if (kanbanDb) {
            try {
                entry = await kanbanDb.getControlPlaneEntry(name, "protocol");
            } catch {}
        }
        if (!entry && workspaceRoot) {
            try {
                const db = KanbanDatabase.forWorkspace(workspaceRoot);
                if (await db.ensureReady()) {
                    entry = await db.getControlPlaneEntry(name, "protocol");
                }
            } catch {}
        }

        const bundled = BUNDLED_PROTOCOLS[name];
        if (!entry && !bundled) {
            return null;
        }

        // `bundled` may be undefined here: line 71 returns early only when BOTH entry
        // and bundled are missing, so a control_plane row with an empty body and no
        // bundled counterpart (a retired protocol still in the table, or an
        // override-only row) reached `bundled.body` and threw a TypeError instead of
        // returning null.
        const body = (entry?.overrideBody ?? entry?.workspaceOverride) || entry?.body || bundled?.body;
        if (!body) {
            return null;
        }
        const delivery: "inline" | "materialize" = entry?.delivery || bundled?.delivery || "materialize";
        const contentHash = entry?.contentHash || bundled?.contentHash || crypto.createHash("sha256").update(body, "utf8").digest("hex");

        // Check if committed survivor files exist for improve-plan and improve-feature
        if (workspaceRoot && (name === "improve-plan" || name === "improve-feature")) {
            const committedPath = path.join(workspaceRoot, ".agents", "protocols", name, "SKILL.md");
            if (fs.existsSync(committedPath)) {
                return {
                    name,
                    body,
                    path: committedPath,
                    delivery
                };
            }
        }

        if (delivery === "inline") {
            return {
                name,
                body,
                delivery: "inline"
            };
        }

        // Materialize to cache: ~/.switchboard/cache/protocols/<contentHash>/SKILL.md
        let materializedPath: string | undefined;
        try {
            const cacheDir = stateFile("cache", "protocols", contentHash);
            materializedPath = path.join(cacheDir, "SKILL.md");
            if (!fs.existsSync(materializedPath)) {
                fs.mkdirSync(cacheDir, { recursive: true });
                const tmpFile = path.join(cacheDir, `SKILL.md.tmp.${process.pid}.${Date.now()}`);
                fs.writeFileSync(tmpFile, body, "utf8");
                fs.renameSync(tmpFile, materializedPath);
            }
        } catch {
            // Fallback for sandboxed test environments
            if (workspaceRoot) {
                const fallbackDir = path.join(workspaceRoot, ".switchboard", "cache", "protocols", contentHash);
                materializedPath = path.join(fallbackDir, "SKILL.md");
                if (!fs.existsSync(materializedPath)) {
                    fs.mkdirSync(fallbackDir, { recursive: true });
                    fs.writeFileSync(materializedPath, body, "utf8");
                }
            }
        }

        return {
            name,
            body,
            path: materializedPath,
            delivery: "materialize"
        };
    }

    /**
     * Normalizes a protocol path or identifier to its base name.
     * Rejects path traversal attempts.
     */
    public static normalizeProtocolName(p: string): string | null {
        if (!p || typeof p !== "string") return null;
        const trimmed = p.trim();

        // Traversal guard
        if (trimmed.includes("..") || trimmed.includes("\\")) {
            return null;
        }

        let m = trimmed.match(/(?:\.agents|\.switchboard)\/protocols\/([^/]+)(?:\/SKILL\.md|\.md)?$/);
        if (m) return m[1];

        m = trimmed.match(/^protocols\/([^/]+)(?:\/SKILL\.md|\.md)?$/);
        if (m) return m[1];

        if (!trimmed.includes("/")) {
            return trimmed.replace(/\.md$/, "");
        }

        return null;
    }
}
