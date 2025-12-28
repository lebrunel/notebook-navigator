/*
 * Notebook Navigator - Plugin for Obsidian
 * Copyright (c) 2025-2026 Johan Sanneblad
 * SPDX-License-Identifier: LicenseRef-NotebookNavigator
 *
 * Licensed under the Notebook Navigator License Agreement (see LICENSE).
 */

import { App, TFile } from 'obsidian';

interface CachedReadEntry {
    mtime: number;
    expiresAt: number;
    promise: Promise<string>;
}

/**
 * Short-lived cache for shared cachedRead results across content providers.
 */
export class ContentReadCache {
    private readonly cache = new Map<string, CachedReadEntry>();

    constructor(
        private readonly app: App,
        private readonly ttlMs: number = 3000,
        private readonly maxEntries: number = 50
    ) {}

    readFile(file: TFile): Promise<string> {
        const key = file.path;
        const mtime = file.stat.mtime;
        const now = Date.now();
        const existing = this.cache.get(key);
        if (existing && existing.mtime === mtime && existing.expiresAt > now) {
            return existing.promise;
        }

        const promise = this.app.vault.cachedRead(file).catch(error => {
            this.cache.delete(key);
            throw error;
        });

        this.cache.set(key, {
            mtime,
            expiresAt: now + this.ttlMs,
            promise
        });

        this.prune(now);
        return promise;
    }

    private prune(now: number): void {
        for (const [key, entry] of this.cache) {
            if (entry.expiresAt <= now) {
                this.cache.delete(key);
            }
        }

        while (this.cache.size > this.maxEntries) {
            for (const key of this.cache.keys()) {
                this.cache.delete(key);
                break;
            }
        }
    }
}
