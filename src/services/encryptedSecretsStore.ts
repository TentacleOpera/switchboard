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
    /**
     * Set when the store file is present but could not be READ (permissions,
     * transient IO) — as opposed to read-but-undecryptable, which renames the
     * file away. An unreadable store must never be overwritten: `_save()` would
     * replace real ciphertext with a cache we know is empty for the wrong reason.
     */
    private _unreadable: boolean = false;

    constructor(storePath: string, keyPath: string) {
        this._storePath = storePath;
        this._keyPath = keyPath;
        this._load();
    }

    /**
     * Keys this store could plausibly be encrypted under, best guess first.
     *
     * The store is machine-global and shared by the editor host, the standalone
     * host and the CLI — processes that do not necessarily agree on whether
     * SWITCHBOARD_MASTER_KEY / _PASSPHRASE is set. Trying only one key would let
     * a host that lacks the env var declare a perfectly good store "corrupt" and
     * rename it away, destroying the other host's tokens.
     */
    private _candidateKeys(): Buffer[] {
        const candidates: Buffer[] = [];
        try {
            const envVal = process.env.SWITCHBOARD_MASTER_KEY || process.env.SWITCHBOARD_MASTER_PASSPHRASE;
            if (envVal) {
                candidates.push(crypto.scryptSync(envVal, 'switchboard-standalone', 32));
            }
        } catch { /* env-derived key unusable; fall through to the file key */ }

        try {
            if (fs.existsSync(this._keyPath)) {
                const fileKey = Buffer.from(fs.readFileSync(this._keyPath, 'utf8').trim(), 'hex');
                if (fileKey.length === 32) { candidates.push(fileKey); }
            }
        } catch { /* no readable file key */ }

        return candidates;
    }

    /** The key new ciphertext is written under. Env override wins, else the file key. */
    private _getOrCreateKey(): Buffer {
        try {
            const existing = process.env.SWITCHBOARD_MASTER_KEY || process.env.SWITCHBOARD_MASTER_PASSPHRASE;
            if (existing) {
                return crypto.scryptSync(existing, 'switchboard-standalone', 32);
            }
        } catch { /* fall through to file key */ }

        try {
            if (fs.existsSync(this._keyPath)) {
                const fileKey = Buffer.from(fs.readFileSync(this._keyPath, 'utf8').trim(), 'hex');
                if (fileKey.length === 32) { return fileKey; }
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
        let blob: Buffer;
        try {
            if (!fs.existsSync(this._storePath)) {
                this._cache.clear();
                this._lastMtime = 0;
                this._unreadable = false;
                return;
            }
            this._lastMtime = fs.statSync(this._storePath).mtimeMs;
            blob = fs.readFileSync(this._storePath);
        } catch (err) {
            // Present but unreadable. Leave the file alone and refuse later writes
            // rather than renaming or overwriting ciphertext we never saw.
            console.error('[StandaloneHostSecrets] Unable to read secret store:', err);
            this._cache.clear();
            this._lastMtime = 0;
            this._unreadable = true;
            return;
        }

        this._unreadable = false;

        if (blob.length < IV_LENGTH + TAG_LENGTH) {
            this._handleCorruptStore('Store file too small');
            return;
        }
        const iv = blob.subarray(0, IV_LENGTH);
        const tag = blob.subarray(blob.length - TAG_LENGTH);
        const ciphertext = blob.subarray(IV_LENGTH, blob.length - TAG_LENGTH);

        const candidates = this._candidateKeys();
        if (candidates.length === 0) {
            // No key to even attempt with — e.g. a store written by a host that had
            // SWITCHBOARD_MASTER_PASSPHRASE set (which never materialises a
            // .master-key file) being opened by a host that does not. That is not
            // corruption, and renaming a file we never tried to decrypt would
            // destroy the other host's tokens. Leave it alone and refuse writes.
            console.error(`[StandaloneHostSecrets] No master key available for ${this._storePath}; leaving it untouched. Set SWITCHBOARD_MASTER_KEY/_PASSPHRASE to the value used when it was written.`);
            this._cache.clear();
            this._lastMtime = 0;
            this._unreadable = true;
            return;
        }
        let lastError = 'decryption failed with every available master key';
        for (const key of candidates) {
            try {
                const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
                decipher.setAuthTag(tag);
                const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
                this._cache = new Map(Object.entries(JSON.parse(plaintext.toString('utf8'))));
                return;
            } catch (err) {
                lastError = err instanceof Error ? err.message : String(err);
            }
        }
        this._handleCorruptStore(lastError);
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
        this._unreadable = false;
    }

    private _checkMtimeAndReload(): void {
        if (!fs.existsSync(this._storePath)) {
            if (this._cache.size > 0 || this._unreadable) {
                this._cache.clear();
                this._lastMtime = 0;
                this._unreadable = false;
            }
            return;
        }
        try {
            const stat = fs.statSync(this._storePath);
            if (this._unreadable || stat.mtimeMs > this._lastMtime) {
                this._load();
            }
        } catch { /* ignore stat error */ }
    }

    private _save(): void {
        if (this._unreadable) {
            throw new Error(`[StandaloneHostSecrets] Refusing to overwrite unreadable secret store at ${this._storePath}`);
        }
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

    // ─── Synchronous core ───────────────────────────────────────────────────
    // Every operation is synchronous under the hood. The sync accessors are the
    // real API for callers that must complete before handing the store to
    // anyone else — notably the legacy-workspace migration, which renames files
    // the moment it is done and therefore cannot afford to await a microtask.

    keysSync(): string[] {
        this._checkMtimeAndReload();
        return Array.from(this._cache.keys());
    }

    getSync(key: string): string | undefined {
        this._checkMtimeAndReload();
        return this._cache.get(key);
    }

    storeSync(key: string, value: string): void {
        this._checkMtimeAndReload();
        this._cache.set(key, value);
        this._save();
    }

    deleteSync(key: string): void {
        this._checkMtimeAndReload();
        // No key, no write: a delete of an absent key must not create the store
        // (or its master key) as a side effect. The editor-host mirror calls
        // delete for keys the user may never have set.
        if (!this._cache.delete(key)) { return; }
        this._save();
    }

    // ─── SecretStorage-shaped async surface ─────────────────────────────────

    async keys(): Promise<string[]> {
        return this.keysSync();
    }

    async get(key: string): Promise<string | undefined> {
        return this.getSync(key);
    }

    async store(key: string, value: string): Promise<void> {
        this.storeSync(key, value);
    }

    async delete(key: string): Promise<void> {
        this.deleteSync(key);
    }
}
