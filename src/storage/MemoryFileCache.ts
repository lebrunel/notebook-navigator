/*
 * Notebook Navigator - Plugin for Obsidian
 * Copyright (c) 2025 Johan Sanneblad
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <https://www.gnu.org/licenses/>.
 */

import { FileData } from './IndexedDBStorage';
import { isMarkdownPath } from '../utils/fileTypeUtils';

// Creates a deep clone of FileData to prevent mutations from affecting the original
function cloneFileData(data: FileData): FileData {
    return {
        mtime: data.mtime,
        tags: data.tags ? [...data.tags] : null,
        previewStatus: data.previewStatus,
        // Feature image blobs are stored in IndexedDB, not in the memory cache.
        featureImage: null,
        featureImageStatus: data.featureImageStatus,
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
    private previewTextMap: Map<string, string> = new Map();
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
        this.previewTextMap.clear();
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
        return file?.previewStatus === 'has';
    }

    /**
     * Get preview text synchronously.
     * Returns empty string when preview text is not loaded.
     */
    getPreviewText(path: string): string {
        return this.previewTextMap.get(path) ?? '';
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
        if (data.previewStatus !== 'has') {
            this.previewTextMap.delete(path);
        }
    }

    // Sets a cloned copy of file data to prevent external modifications
    setClonedFile(path: string, data: FileData): void {
        this.memoryMap.set(path, cloneFileData(data));
        if (data.previewStatus !== 'has') {
            this.previewTextMap.delete(path);
        }
    }

    /**
     * Update specific file content fields.
     */
    updateFileContent(
        path: string,
        updates: {
            previewText?: string;
            previewStatus?: FileData['previewStatus'];
            featureImage?: Blob | null;
            featureImageKey?: string | null;
            featureImageStatus?: FileData['featureImageStatus'];
            metadata?: FileData['metadata'];
        }
    ): void {
        const existing = this.memoryMap.get(path);
        if (existing) {
            // Update specific fields
            if (updates.previewStatus !== undefined) {
                existing.previewStatus = updates.previewStatus;
            }
            if (updates.previewText !== undefined) {
                if (updates.previewText.length > 0) {
                    this.previewTextMap.set(path, updates.previewText);
                } else {
                    this.previewTextMap.delete(path);
                }
            }
            if (existing.previewStatus !== 'has') {
                this.previewTextMap.delete(path);
            }
            // Drop blob updates; the memory cache only tracks the key.
            if (updates.featureImage !== undefined) existing.featureImage = null;
            if (updates.featureImageKey !== undefined) existing.featureImageKey = updates.featureImageKey;
            if (updates.featureImageStatus !== undefined) existing.featureImageStatus = updates.featureImageStatus;
            if (updates.metadata !== undefined) existing.metadata = updates.metadata;
        }
    }

    /**
     * Delete a file from the cache.
     */
    deleteFile(path: string): void {
        this.memoryMap.delete(path);
        this.previewTextMap.delete(path);
    }

    /**
     * Batch delete multiple files from the cache.
     */
    batchDelete(paths: string[]): void {
        for (const path of paths) {
            this.memoryMap.delete(path);
            this.previewTextMap.delete(path);
        }
    }

    /**
     * Batch update multiple files.
     */
    batchUpdate(updates: { path: string; data: FileData }[]): void {
        for (const { path, data } of updates) {
            this.memoryMap.set(path, data);
            if (data.previewStatus !== 'has') {
                this.previewTextMap.delete(path);
            }
        }
    }

    /**
     * Batch update file content fields.
     */
    batchUpdateFileContent(
        updates: {
            path: string;
            previewText?: string;
            previewStatus?: FileData['previewStatus'];
            featureImage?: Blob | null;
            featureImageKey?: string | null;
            featureImageStatus?: FileData['featureImageStatus'];
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
        if (type === 'all' || type === 'preview') {
            this.previewTextMap.clear();
        }
        for (const [path, file] of this.memoryMap.entries()) {
            if (type === 'all' || type === 'preview') {
                file.previewStatus = isMarkdownPath(path) ? 'unprocessed' : 'none';
            }
            if (type === 'all' || type === 'featureImage') {
                file.featureImage = null;
                file.featureImageKey = null;
                file.featureImageStatus = 'unprocessed';
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
        this.previewTextMap.clear();
        this.isInitialized = false;
    }
}
