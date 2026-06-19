import * as fs from 'fs';
import * as path from 'path';

export interface InsightMetadata {
    filename: string;
    title: string;
    severity: string;
    status: string;
    sourcePlans: string[];
    governanceTarget: string;
    workspaceRoot: string;
}

export interface AdversarialSections {
    stage1: string | null;
    stage2: string | null;
}

export class InsightManager {
    public static getInsightsDirectory(workspaceRoot: string): string {
        const dir = path.join(workspaceRoot, '.switchboard', 'insights');
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
        return dir;
    }

    public static listInsights(workspaceRoot: string): InsightMetadata[] {
        const dir = this.getInsightsDirectory(workspaceRoot);
        const results: InsightMetadata[] = [];

        let files: string[];
        try {
            files = fs.readdirSync(dir).filter(f => f.endsWith('.md') && !f.startsWith('_'));
        } catch {
            return results;
        }

        for (const filename of files) {
            try {
                const filePath = path.join(dir, filename);
                const content = fs.readFileSync(filePath, 'utf8');
                const metadata = this._parseInsightMetadata(filename, content, workspaceRoot);
                if (metadata) {
                    results.push(metadata);
                }
            } catch (err) {
                console.warn(`[InsightManager] Failed to parse insight file ${filename}:`, err);
            }
        }

        return results;
    }

    public static readInsight(workspaceRoot: string, filename: string): string | null {
        const dir = this.getInsightsDirectory(workspaceRoot);
        const filePath = path.join(dir, filename);
        if (!fs.existsSync(filePath)) {
            return null;
        }
        return fs.readFileSync(filePath, 'utf8');
    }

    public static deleteInsight(workspaceRoot: string, filename: string): void {
        const dir = this.getInsightsDirectory(workspaceRoot);
        const filePath = path.join(dir, filename);
        if (fs.existsSync(filePath)) {
            fs.unlinkSync(filePath);
        }
    }

    public static updateInsightStatus(workspaceRoot: string, filename: string, newStatus: string): void {
        const dir = this.getInsightsDirectory(workspaceRoot);
        const filePath = path.join(dir, filename);
        if (!fs.existsSync(filePath)) {
            throw new Error(`Insight file not found: ${filename}`);
        }
        const content = fs.readFileSync(filePath, 'utf8');
        const updated = content.replace(
            /\*\*Status:\*\*\s*\w+/i,
            `**Status:** ${newStatus}`
        );
        fs.writeFileSync(filePath, updated, 'utf8');
    }

    public static extractAdversarialSections(planContent: string): AdversarialSections | null {
        const stage1Pattern = /^#{1,4}\s+(?:Stage 1|Grumpy.*?Findings|Adversarial.*?Findings)/im;
        const stage2Pattern = /^#{1,4}\s+(?:Stage 2|Balanced.*?Synthesis)/im;
        const fallbackPattern = /^#{1,4}\s+Adversarial Synthesis/im;

        let stage1: string | null = null;
        let stage2: string | null = null;

        const stage1Match = planContent.match(stage1Pattern);
        if (stage1Match && stage1Match.index !== undefined) {
            const start = stage1Match.index;
            const rest = planContent.slice(start + stage1Match[0].length);
            const nextHeading = rest.match(/^#{1,4}\s+/m);
            stage1 = nextHeading && nextHeading.index !== undefined
                ? rest.slice(0, nextHeading.index).trim()
                : rest.trim();
        }

        const stage2Match = planContent.match(stage2Pattern);
        if (stage2Match && stage2Match.index !== undefined) {
            const start = stage2Match.index;
            const rest = planContent.slice(start + stage2Match[0].length);
            const nextHeading = rest.match(/^#{1,4}\s+/m);
            stage2 = nextHeading && nextHeading.index !== undefined
                ? rest.slice(0, nextHeading.index).trim()
                : rest.trim();
        }

        if (!stage1 && !stage2) {
            const fallbackMatch = planContent.match(fallbackPattern);
            if (fallbackMatch && fallbackMatch.index !== undefined) {
                const start = fallbackMatch.index;
                const rest = planContent.slice(start + fallbackMatch[0].length);
                const nextHeading = rest.match(/^#{1,4}\s+/m);
                stage2 = nextHeading && nextHeading.index !== undefined
                    ? rest.slice(0, nextHeading.index).trim()
                    : rest.trim();
            }
        }

        if (!stage1 && !stage2) {
            return null;
        }

        return { stage1, stage2 };
    }

    private static _parseInsightMetadata(
        filename: string,
        content: string,
        workspaceRoot: string
    ): InsightMetadata | null {
        const titleMatch = content.match(/^#\s+(.+)$/m);
        const title = titleMatch ? titleMatch[1].trim() : filename.replace(/\.md$/, '');

        const severityMatch = content.match(/\*\*Severity:\*\*\s*(.+)/i);
        const statusMatch = content.match(/\*\*Status:\*\*\s*(\w+)/i);
        const sourcePlansMatch = content.match(/\*\*Source Plans:\*\*\s*(.+)/i);
        const governanceMatch = content.match(/\*\*Suggested Governance Target\*\*:?\s*(.+)/i);

        const sourcePlans = sourcePlansMatch
            ? sourcePlansMatch[1].split(',').map(s => s.trim()).filter(Boolean)
            : [];

        return {
            filename,
            title,
            severity: severityMatch ? severityMatch[1].trim() : 'unknown',
            status: statusMatch ? statusMatch[1].trim().toLowerCase() : 'open',
            sourcePlans,
            governanceTarget: governanceMatch ? governanceMatch[1].trim() : 'unknown',
            workspaceRoot
        };
    }
}
