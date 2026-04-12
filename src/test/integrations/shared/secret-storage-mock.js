'use strict';

class SecretStorageMock {
    constructor(seed = {}) {
        this._entries = new Map(Object.entries(seed));
    }

    async get(key) {
        return this._entries.has(key) ? this._entries.get(key) : undefined;
    }

    async store(key, value) {
        this._entries.set(key, value);
    }

    async delete(key) {
        this._entries.delete(key);
    }

    snapshot() {
        return Object.fromEntries(this._entries.entries());
    }
}

module.exports = { SecretStorageMock };
