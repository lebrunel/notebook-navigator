/*
 * Notebook Navigator - Plugin for Obsidian
 * Copyright (c) 2025-2026 Johan Sanneblad
 * SPDX-License-Identifier: LicenseRef-NotebookNavigator
 *
 * Licensed under the Notebook Navigator License Agreement (see LICENSE).
 */

import { FileData } from './IndexedDBStorage';

// Creates a deep clone of FileData to prevent mutations from affecting the original
function cloneFileData(data: FileData): FileData {
    return {
        mtime: data.mtime,
        tags: data.tags ? [...data.tags] : null,
        preview: data.preview,
        featureImage: data.featureImage,
        featureImageKey: data.featureImageKey,
        metadata: data.metadata ? { ...data.metadata } : null
    };
}

/**
 * In-memory file cache that mirrors the IndexedDB storage for synchronous access.
 * This cache stores all file data in RAM to enable synchronous reads during rendering,
 * eliminating async operations in React components and fixing virtualizer height calculations.
 *
 * Memory usage is minimal - even 100k files at ~300 bytes each = 30MB RAM.
 */
export class MemoryFileCache {
    private memoryMap: Map<string, FileData> = new Map();
    private isInitialized = false;

    /**
     * Mark the cache as initialized after loading data.
     */
    markInitialized(): void {
        this.isInitialized = true;
    }

    /**
     * Clears any cached data but leaves the cache marked as ready.
     * Used when IndexedDB operations succeed but contain no rows.
     */
    resetToEmpty(): void {
        this.memoryMap.clear();
        this.isInitialized = true;
    }

    /**
     * Get file data synchronously.
     */
    getFile(path: string): FileData | null {
        return this.memoryMap.get(path) || null;
    }

    /**
     * Get multiple files synchronously.
     */
    getFiles(paths: string[]): Map<string, FileData> {
        const result = new Map<string, FileData>();
        for (const path of paths) {
            const file = this.memoryMap.get(path);
            if (file) {
                result.set(path, file);
            }
        }
        return result;
    }

    /**
     * Check if a file has preview text.
     */
    hasPreview(path: string): boolean {
        const file = this.memoryMap.get(path);
        return !!file?.preview;
    }

    /**
     * Check if a file exists in the cache.
     */
    hasFile(path: string): boolean {
        return this.memoryMap.has(path);
    }

    /**
     * Get all files as an array (use sparingly).
     */
    getAllFiles(): FileData[] {
        return Array.from(this.memoryMap.values());
    }

    /**
     * Get all files with their paths.
     */
    getAllFilesWithPaths(): { path: string; data: FileData }[] {
        const result: { path: string; data: FileData }[] = [];
        for (const [path, data] of this.memoryMap.entries()) {
            result.push({ path, data });
        }
        return result;
    }

    /**
     * Get file count without allocating intermediate arrays.
     */
    getFileCount(): number {
        return this.memoryMap.size;
    }

    /**
     * Stream all files without creating copies.
     */
    forEachFile(callback: (path: string, data: FileData) => void): void {
        this.memoryMap.forEach((data, path) => {
            callback(path, data);
        });
    }

    /**
     * Update or add a file in the cache.
     */
    updateFile(path: string, data: FileData): void {
        this.memoryMap.set(path, data);
    }

    // Sets a cloned copy of file data to prevent external modifications
    setClonedFile(path: string, data: FileData): void {
        this.memoryMap.set(path, cloneFileData(data));
    }

    /**
     * Update specific file content fields.
     */
    updateFileContent(
        path: string,
        updates: {
            preview?: string;
            featureImage?: Blob | null;
            featureImageKey?: string | null;
            metadata?: FileData['metadata'];
        }
    ): void {
        const existing = this.memoryMap.get(path);
        if (existing) {
            // Update specific fields
            if (updates.preview !== undefined) existing.preview = updates.preview;
            if (updates.featureImage !== undefined) existing.featureImage = updates.featureImage;
            if (updates.featureImageKey !== undefined) existing.featureImageKey = updates.featureImageKey;
            if (updates.metadata !== undefined) existing.metadata = updates.metadata;
        }
    }

    /**
     * Delete a file from the cache.
     */
    deleteFile(path: string): void {
        this.memoryMap.delete(path);
    }

    /**
     * Batch delete multiple files from the cache.
     */
    batchDelete(paths: string[]): void {
        for (const path of paths) {
            this.memoryMap.delete(path);
        }
    }

    /**
     * Batch update multiple files.
     */
    batchUpdate(updates: { path: string; data: FileData }[]): void {
        for (const { path, data } of updates) {
            this.memoryMap.set(path, data);
        }
    }

    /**
     * Batch update file content fields.
     */
    batchUpdateFileContent(
        updates: {
            path: string;
            preview?: string;
            featureImage?: Blob | null;
            featureImageKey?: string | null;
            metadata?: FileData['metadata'];
        }[]
    ): void {
        for (const update of updates) {
            this.updateFileContent(update.path, update);
        }
    }

    /**
     * Clear specific content type from all files.
     */
    clearAllFileContent(type: 'preview' | 'featureImage' | 'metadata' | 'all'): void {
        for (const file of this.memoryMap.values()) {
            if (type === 'all' || type === 'preview') file.preview = null;
            if (type === 'all' || type === 'featureImage') {
                file.featureImage = null;
                file.featureImageKey = null;
            }
            if (type === 'all' || type === 'metadata') file.metadata = null;
        }
    }

    /**
     * Get cache statistics.
     */
    getStats(): { fileCount: number; memoryUsageEstimate: number } {
        const fileCount = this.memoryMap.size;

        // Rough estimate: 300 bytes per file
        const memoryUsageEstimate = fileCount * 300;

        return { fileCount, memoryUsageEstimate };
    }

    /**
     * Check if cache is initialized.
     */
    isReady(): boolean {
        return this.isInitialized;
    }

    /**
     * Clear the entire cache (used during cleanup).
     */
    clear(): void {
        this.memoryMap.clear();
        this.isInitialized = false;
    }
}
