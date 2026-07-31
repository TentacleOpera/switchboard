import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 16;
const TAG_LENGTH = 16;

export interface HostSecrets {
    get(key: string): Promise<string | undefined>;
    store(key: string, value: string): Promise<void>;
    delete(key: string): Promise<void>;
    keys(): Promise<string[]>;
}

export class StandaloneHostSecrets implements HostSecrets {
    private _keyPath: string;
    private _storePath: string;
    private _cache: Map<string, string> = new Map();
    private _lastMtime: number = 0;

    constructor(storePath: string, keyPath: string) {
        this._storePath = storePath;
        this._keyPath = keyPath;
        this._load();
    }

    private _getOrCreateKey(): Buffer {
        try {
            const existing = process.env.SWITCHBOARD_MASTER_KEY || process.env.SWITCHBOARD_MASTER_PASSPHRASE;
            if (existing) {
                return crypto.scryptSync(existing, 'switchboard-standalone', 32);
            }
        } catch { /* fall through to file key */ }

        try {
            if (fs.existsSync(this._keyPath)) {
                return Buffer.from(fs.readFileSync(this._keyPath, 'utf8').trim(), 'hex');
            }
        } catch { /* fall through to create */ }

        const key = crypto.randomBytes(32);
        const dir = path.dirname(this._keyPath);
        if (!fs.existsSync(dir)) { fs.mkdirSync(dir, { recursive: true }); }
        fs.writeFileSync(this._keyPath, key.toString('hex'), { mode: 0o600 });
        try { fs.chmodSync(this._keyPath, 0o600); } catch { /* ignore on Windows */ }
        return key;
    }

    private _load(): void {
        if (!fs.existsSync(this._storePath)) {
            this._cache.clear();
            this._lastMtime = 0;
            return;
        }
        try {
            const stat = fs.statSync(this._storePath);
            this._lastMtime = stat.mtimeMs;
        } catch { /* ignore stat error */ }

        const key = this._getOrCreateKey();
        const blob = fs.readFileSync(this._storePath);
        if (blob.length < IV_LENGTH + TAG_LENGTH) {
            this._handleCorruptStore('Store file too small');
            return;
        }
        const iv = blob.subarray(0, IV_LENGTH);
        const tag = blob.subarray(blob.length - TAG_LENGTH);
        const ciphertext = blob.subarray(IV_LENGTH, blob.length - TAG_LENGTH);
        try {
            const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
            decipher.setAuthTag(tag);
            const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
            this._cache = new Map(Object.entries(JSON.parse(plaintext.toString('utf8'))));
        } catch (err) {
            this._handleCorruptStore(err instanceof Error ? err.message : String(err));
        }
    }

    private _handleCorruptStore(reason: string): void {
        console.error(`[StandaloneHostSecrets] Corrupt store detected (${reason}). Backing up corrupt file.`);
        try {
            let backupPath = `${this._storePath}.corrupt-${Date.now()}.bak`;
            let counter = 1;
            while (fs.existsSync(backupPath)) {
                backupPath = `${this._storePath}.corrupt-${Date.now()}_${counter++}.bak`;
            }
            fs.renameSync(this._storePath, backupPath);
        } catch (e) {
            console.error('[StandaloneHostSecrets] Failed to rename corrupt store:', e);
        }
        this._cache.clear();
        this._lastMtime = 0;
    }

    private _checkMtimeAndReload(): void {
        if (!fs.existsSync(this._storePath)) {
            if (this._cache.size > 0) {
                this._cache.clear();
                this._lastMtime = 0;
            }
            return;
        }
        try {
            const stat = fs.statSync(this._storePath);
            if (stat.mtimeMs > this._lastMtime) {
                this._load();
            }
        } catch { /* ignore stat error */ }
    }

    private _save(): void {
        const key = this._getOrCreateKey();
        const iv = crypto.randomBytes(IV_LENGTH);
        const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
        const plaintext = Buffer.from(JSON.stringify(Object.fromEntries(this._cache)), 'utf8');
        const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
        const tag = cipher.getAuthTag();
        const dir = path.dirname(this._storePath);
        if (!fs.existsSync(dir)) { fs.mkdirSync(dir, { recursive: true }); }

        const tmpPath = `${this._storePath}.${process.pid}.tmp`;
        fs.writeFileSync(tmpPath, Buffer.concat([iv, ciphertext, tag]), { mode: 0o600 });
        try { fs.chmodSync(tmpPath, 0o600); } catch { /* ignore on Windows */ }
        fs.renameSync(tmpPath, this._storePath);

        try {
            const stat = fs.statSync(this._storePath);
            this._lastMtime = stat.mtimeMs;
        } catch { /* ignore stat error */ }
    }

    async keys(): Promise<string[]> {
        this._checkMtimeAndReload();
        return Array.from(this._cache.keys());
    }

    async get(key: string): Promise<string | undefined> {
        this._checkMtimeAndReload();
        return this._cache.get(key);
    }

    async store(key: string, value: string): Promise<void> {
        this._checkMtimeAndReload();
        this._cache.set(key, value);
        this._save();
    }

    async delete(key: string): Promise<void> {
        this._checkMtimeAndReload();
        this._cache.delete(key);
        this._save();
    }
}
