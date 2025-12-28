/*
 * Notebook Navigator - Plugin for Obsidian
 * Copyright (c) 2025-2026 Johan Sanneblad
 * All rights reserved.
 * SPDX-License-Identifier: LicenseRef-NotebookNavigator-1.1
 *
 * Licensed under the Notebook Navigator License Agreement, Version 1.1.
 * See the LICENSE file in the repository root.
 */

import { STORAGE_KEYS } from '../types';
import { localStorage } from '../utils/localStorage';
import {
    DEFAULT_FEATURE_IMAGE_CACHE_MAX,
    FEATURE_IMAGE_STORE_NAME,
    FeatureImageBlobStore,
    computeFeatureImageMutation
} from './FeatureImageBlobStore';
import { MemoryFileCache } from './MemoryFileCache';

const STORE_NAME = 'keyvaluepairs';
const DB_SCHEMA_VERSION = 2; // IndexedDB structure version
const DB_CONTENT_VERSION = 1; // Data format version

export type FeatureImageStatus = 'unprocessed' | 'none' | 'has';

/**
 * Sentinel values for metadata date fields
 */
export const METADATA_SENTINEL = {
    /** Indicates that the frontmatter field name is empty/not configured */
    FIELD_NOT_CONFIGURED: 0,
    /** Indicates that parsing the date value failed */
    PARSE_FAILED: -1
} as const;

export interface FileData {
    mtime: number;
    tags: string[] | null; // null = not extracted yet (e.g. when tags disabled)
    preview: string | null; // null = not generated yet
    /**
     * Feature image placeholder for the main record.
     * Always null in the main store; blobs live in a dedicated blob store.
     * Empty blobs are not persisted; the featureImageKey is the durable marker for "processed but no thumbnail".
     */
    featureImage: Blob | null;
    /**
     * Feature image processing state.
     *
     * Semantics:
     * - `unprocessed`: content provider has not run yet for this file
     * - `none`: processed, but no thumbnail blob is stored (no reference or thumbnail generation failed)
     * - `has`: processed and a thumbnail blob is stored in the blob store
     */
    featureImageStatus: FeatureImageStatus;
    /**
     * Stable key describing the selected feature image source.
     *
     * Semantics:
     * - `null`: not generated yet (pending content generation)
     * - `''`: generated and resolved, but no image reference is selected
     * - `f:<path>@<mtime>`: local vault file reference (image embeds, PDF cover thumbnails)
     * - `e:<url>`: external https URL reference (normalized, without hash)
     * - `y:<videoId>`: YouTube thumbnail reference
     * - `x:<path>@<mtime>`: Excalidraw file preview reference
     */
    featureImageKey: string | null;
    metadata: {
        name?: string;
        created?: number; // Valid timestamp, 0 = field not configured, -1 = parse failed
        modified?: number; // Valid timestamp, 0 = field not configured, -1 = parse failed
        icon?: string;
        color?: string;
        hidden?: boolean; // Whether file matches frontmatter exclusion patterns
    } | null; // null = not generated yet
}

export interface FileContentChange {
    path: string;
    changes: {
        preview?: string | null;
        featureImage?: Blob | null;
        featureImageKey?: string | null;
        featureImageStatus?: FeatureImageStatus;
        metadata?: FileData['metadata'] | null;
        tags?: string[] | null;
    };
    changeType?: 'metadata' | 'content' | 'both';
}

interface IndexedDBStorageOptions {
    featureImageCacheMaxEntries?: number;
}

/**
 * IndexedDBStorage - Browser's IndexedDB wrapper for persistent file storage
 *
 * What it does:
 * - Stores file metadata and generated content (previews, images, frontmatter) in browser IndexedDB
 * - Provides efficient batch operations for large vaults
 * - Emits real-time change notifications for UI updates
 *
 * Relationships:
 * - Used by: StorageContext, ContentProviders, FileOperations, Statistics
 * - Core persistent storage layer that all other components depend on
 *
 * Key responsibilities:
 * - Manage IndexedDB connection lifecycle
 * - CRUD operations for file records (single and batch)
 * - Stream large datasets without loading into memory
 * - Track and notify about content changes
 * - Provide indexed queries (by tag, by content type)
 */
export class IndexedDBStorage {
    private cache: MemoryFileCache = new MemoryFileCache();
    private changeListeners = new Set<(changes: FileContentChange[]) => void>();
    private db: IDBDatabase | null = null;
    private dbName: string;
    // Dedicated feature image blob store with an in-memory LRU.
    private featureImageBlobs: FeatureImageBlobStore;
    private fileChangeListeners = new Map<string, Set<(changes: FileContentChange['changes']) => void>>();
    private initPromise: Promise<void> | null = null;
    private pendingRebuildNotice = false;

    constructor(appId: string, options?: IndexedDBStorageOptions) {
        this.dbName = `notebooknavigator/cache/${appId}`;
        // Initialize the LRU size from caller options or fallback default.
        const maxEntries = options?.featureImageCacheMaxEntries ?? DEFAULT_FEATURE_IMAGE_CACHE_MAX;
        this.featureImageBlobs = new FeatureImageBlobStore(maxEntries);
    }

    consumePendingRebuildNotice(): boolean {
        const pending = this.pendingRebuildNotice;
        this.pendingRebuildNotice = false;
        return pending;
    }

    private normalizeFileData(data: Partial<FileData>): FileData {
        const featureImageKey = typeof data.featureImageKey === 'string' ? data.featureImageKey : null;
        const rawStatus = data.featureImageStatus;
        const featureImageStatus: FeatureImageStatus =
            rawStatus === 'unprocessed' || rawStatus === 'none' || rawStatus === 'has'
                ? rawStatus
                : featureImageKey === null
                  ? 'unprocessed'
                  : 'none';

        return {
            mtime: typeof data.mtime === 'number' ? data.mtime : 0,
            tags: Array.isArray(data.tags) ? data.tags : null,
            preview: typeof data.preview === 'string' ? data.preview : null,
            // Feature image blobs are stored separately from the main record.
            // The MemoryFileCache is used for synchronous rendering and should not hold blob payloads.
            featureImage: null,
            featureImageStatus,
            featureImageKey,
            metadata: data.metadata && typeof data.metadata === 'object' ? (data.metadata as FileData['metadata']) : null
        };
    }

    /**
     * Subscribe to content change notifications.
     * Listeners are called whenever file content (preview, image, metadata) is updated.
     *
     * @param listener - Function to call with content changes
     * @returns Unsubscribe function
     */
    onContentChange(listener: (changes: FileContentChange[]) => void): () => void {
        this.changeListeners.add(listener);
        return () => this.changeListeners.delete(listener);
    }

    /**
     * Subscribe to content change notifications for a specific file.
     * More efficient than onContentChange as it only receives changes for the specified file.
     *
     * @param path - File path to listen for changes
     * @param listener - Function to call with content changes for this file
     * @returns Unsubscribe function
     */
    onFileContentChange(path: string, listener: (changes: FileContentChange['changes']) => void): () => void {
        let fileListeners = this.fileChangeListeners.get(path);
        if (!fileListeners) {
            fileListeners = new Set();
            this.fileChangeListeners.set(path, fileListeners);
        }
        fileListeners.add(listener);

        return () => {
            const listeners = this.fileChangeListeners.get(path);
            if (listeners) {
                listeners.delete(listener);
                if (listeners.size === 0) {
                    this.fileChangeListeners.delete(path);
                }
            }
        };
    }

    /**
     * Emit content changes to all registered listeners.
     * Catches and logs any errors in listeners to prevent cascading failures.
     *
     * @param changes - Array of content changes to emit
     */
    private emitChanges(changes: FileContentChange[]): void {
        if (changes.length === 0) return;
        // Only log batch operations or errors

        // Emit to global listeners
        this.changeListeners.forEach(listener => {
            try {
                listener(changes);
            } catch (error: unknown) {
                console.error('Error in change listener:', error);
            }
        });

        // Emit to file-specific listeners
        for (const change of changes) {
            const fileListeners = this.fileChangeListeners.get(change.path);
            if (fileListeners) {
                fileListeners.forEach(listener => {
                    try {
                        listener(change.changes);
                    } catch (error: unknown) {
                        console.error('Error in file change listener:', error);
                    }
                });
            }
        }
    }

    /**
     * Check if the database connection is initialized and ready.
     *
     * @returns True if database is connected and ready
     */
    isInitialized(): boolean {
        return this.db !== null;
    }

    /**
     * Initialize the database connection.
     * Creates the database and object stores if they don't exist.
     * Safe to call multiple times - returns existing connection if already initialized.
     */
    async init(): Promise<void> {
        if (this.db) {
            return;
        }
        if (this.initPromise) {
            // Don't log during normal operation to reduce noise
            return this.initPromise;
        }

        this.initPromise = this.checkSchemaAndInit().catch(error => {
            console.error('Failed to initialize database:', error);
            this.initPromise = null;
            throw error;
        });
        return this.initPromise;
    }

    private async checkSchemaAndInit(): Promise<void> {
        const storedSchemaVersion = localStorage.get<string>(STORAGE_KEYS.databaseSchemaVersionKey);
        const storedContentVersion = localStorage.get<string>(STORAGE_KEYS.databaseContentVersionKey);
        const currentSchemaVersion = DB_SCHEMA_VERSION.toString();
        const currentContentVersion = DB_CONTENT_VERSION.toString();

        // Check version changes
        const schemaChanged = storedSchemaVersion && storedSchemaVersion !== currentSchemaVersion;
        const contentChanged = storedContentVersion && storedContentVersion !== currentContentVersion;

        // Only schema changes require database recreation
        if (schemaChanged) {
            console.log(`Database schema version changed from ${storedSchemaVersion} to ${currentSchemaVersion}. Recreating database.`);
            await this.deleteDatabase();
        }

        localStorage.set(STORAGE_KEYS.databaseSchemaVersionKey, currentSchemaVersion);
        localStorage.set(STORAGE_KEYS.databaseContentVersionKey, currentContentVersion);

        const needsRebuild = !!(schemaChanged || contentChanged);
        this.pendingRebuildNotice = needsRebuild;
        await this.openDatabase(needsRebuild);

        // Clear and rebuild content if either version changed
        if (needsRebuild) {
            if (contentChanged && !schemaChanged) {
                console.log(`Content version changed from ${storedContentVersion} to ${currentContentVersion}. Rebuilding content.`);
            }
            // Clear all data to force rebuild
            await this.clear();
        }
    }

    private async deleteDatabase(): Promise<void> {
        if (this.db) {
            this.db.close();
            this.db = null;
        }

        return new Promise((resolve, reject) => {
            const deleteReq = indexedDB.deleteDatabase(this.dbName);

            deleteReq.onsuccess = () => {
                resolve();
            };

            deleteReq.onerror = () => {
                const deleteError = deleteReq.error;
                console.error('Failed to delete database:', deleteError);
                reject(this.normalizeIdbError(deleteError, 'Failed to delete database'));
            };

            deleteReq.onblocked = () => {
                console.error('Database deletion blocked');
                reject(new Error('Database deletion blocked'));
            };
        });
    }

    /**
     * Converts unknown error types to Error instances for consistent error handling.
     * IndexedDB errors can be DOMExceptions, null, or undefined - this normalizes them.
     */
    private normalizeIdbError(error: unknown, fallbackMessage: string): Error {
        return error instanceof Error ? error : new Error(fallbackMessage);
    }

    /**
     * Rejects a promise with a normalized error from either the transaction or the last request.
     * Prefers the transaction error if available, otherwise uses the last request error.
     */
    private rejectWithTransactionError(
        reject: (reason?: unknown) => void,
        transaction: IDBTransaction,
        lastRequestError: DOMException | Error | null,
        fallbackMessage: string
    ): void {
        const combinedError = transaction.error || lastRequestError;
        reject(this.normalizeIdbError(combinedError, fallbackMessage));
    }

    private async openDatabase(skipCacheLoad: boolean = false): Promise<void> {
        return new Promise((resolve, reject) => {
            const request = indexedDB.open(this.dbName, DB_SCHEMA_VERSION);

            request.onerror = () => {
                const requestError = request.error;
                console.error('Database open error:', requestError);
                reject(this.normalizeIdbError(requestError, 'Failed to open database'));
            };

            request.onblocked = () => {
                console.error('Database open blocked');
                reject(new Error('Database open blocked'));
            };

            request.onsuccess = async () => {
                this.db = request.result;
                // Reset blob caches whenever a new database connection is opened.
                this.featureImageBlobs.clearMemoryCaches();

                // Close this connection if a version change is requested elsewhere
                if (this.db) {
                    this.db.onversionchange = () => {
                        try {
                            this.db?.close();
                        } catch {
                            // noop
                        }
                        this.db = null;
                    };
                }

                // Initialize the cache with all data from IndexedDB
                if (skipCacheLoad) {
                    this.cache.resetToEmpty();
                } else {
                    try {
                        // Use cursor streaming to avoid materializing duplicate arrays in memory
                        const transaction = this.db.transaction([STORE_NAME], 'readonly');
                        const store = transaction.objectStore(STORE_NAME);

                        this.cache.clear();

                        await new Promise<void>((resolveCursor, rejectCursor) => {
                            const cursorRequest = store.openCursor();

                            cursorRequest.onsuccess = () => {
                                const cursor = cursorRequest.result;
                                if (!cursor) {
                                    resolveCursor();
                                    return;
                                }

                                // Stream each file directly into the cache without intermediate storage
                                const path = cursor.key as string;
                                this.cache.updateFile(path, this.normalizeFileData(cursor.value as Partial<FileData>));
                                cursor.continue();
                            };

                            cursorRequest.onerror = () => {
                                rejectCursor(this.normalizeIdbError(cursorRequest.error, 'Cursor iteration failed'));
                            };
                        });

                        // All data loaded, mark cache as ready.
                        this.cache.markInitialized();
                    } catch (error: unknown) {
                        console.error('[DB Cache] Failed to initialize cache:', error);
                        console.error(
                            '[DB Cache] IndexedDB cache hydration failed. Run Notebook Navigator: Rebuild cache to reset the database.'
                        );
                        this.cache.clear();
                    }
                }

                resolve();
            };

            request.onupgradeneeded = event => {
                const target = event.target;
                if (!(target instanceof IDBOpenDBRequest)) {
                    return;
                }
                const db = target.result;

                if (!db.objectStoreNames.contains(STORE_NAME)) {
                    // Use out-of-line keys since we removed path from FileData
                    const store = db.createObjectStore(STORE_NAME);

                    store.createIndex('mtime', 'mtime', { unique: false });
                    store.createIndex('tags', 'tags', { unique: false, multiEntry: true });
                }

                if (!db.objectStoreNames.contains(FEATURE_IMAGE_STORE_NAME)) {
                    db.createObjectStore(FEATURE_IMAGE_STORE_NAME);
                }

                if (event.oldVersion < 2) {
                    // Schema v2 introduces a dedicated feature image blob store.
                    // This plugin does not migrate old cache payloads between schemas; the cache is rebuilt.
                    //
                    // Clear any existing data in the versionchange transaction to avoid mixing v1 records
                    // with v2 read paths and to ensure content providers regenerate feature images.
                    const transaction = target.transaction;
                    if (!transaction) {
                        return;
                    }

                    try {
                        if (transaction.objectStoreNames.contains(STORE_NAME)) {
                            transaction.objectStore(STORE_NAME).clear();
                        }
                    } catch (error: unknown) {
                        console.error('[IndexedDB] clear failed during upgrade', { store: STORE_NAME, error });
                    }

                    try {
                        if (transaction.objectStoreNames.contains(FEATURE_IMAGE_STORE_NAME)) {
                            transaction.objectStore(FEATURE_IMAGE_STORE_NAME).clear();
                        }
                    } catch (error: unknown) {
                        console.error('[IndexedDB] clear failed during upgrade', { store: FEATURE_IMAGE_STORE_NAME, error });
                    }
                }
            };
        });
    }

    /**
     * Clear all data from the database.
     * Removes all file records but preserves the database structure.
     */
    async clear(): Promise<void> {
        await this.init();
        if (!this.db) throw new Error('Database not initialized');

        // Clear both the main store and the feature image blob store in one transaction.
        const transaction = this.db.transaction([STORE_NAME, FEATURE_IMAGE_STORE_NAME], 'readwrite');
        const store = transaction.objectStore(STORE_NAME);
        const blobStore = transaction.objectStore(FEATURE_IMAGE_STORE_NAME);

        return new Promise((resolve, reject) => {
            const op = 'clear';
            let lastRequestError: DOMException | Error | null = null;
            const request = store.clear();
            request.onerror = () => {
                lastRequestError = request.error || null;
                console.error('[IndexedDB] clear failed', {
                    store: STORE_NAME,
                    name: request.error?.name,
                    message: request.error?.message
                });
            };
            // Clear blob records alongside the main store.
            const blobRequest = blobStore.clear();
            blobRequest.onerror = () => {
                lastRequestError = blobRequest.error || null;
                console.error('[IndexedDB] clear failed', {
                    store: FEATURE_IMAGE_STORE_NAME,
                    name: blobRequest.error?.name,
                    message: blobRequest.error?.message
                });
            };
            transaction.oncomplete = () => {
                this.cache.resetToEmpty();
                // Drop any in-memory blobs after clearing the database.
                this.featureImageBlobs.clearMemoryCaches();
                resolve();
            };
            transaction.onabort = () => {
                console.error('[IndexedDB] transaction aborted', {
                    store: STORE_NAME,
                    op,
                    txError: transaction.error?.message,
                    reqError: lastRequestError?.message
                });
                this.rejectWithTransactionError(reject, transaction, lastRequestError, 'Transaction aborted');
            };
            transaction.onerror = () => {
                console.error('[IndexedDB] transaction error', {
                    store: STORE_NAME,
                    op,
                    txError: transaction.error?.message,
                    reqError: lastRequestError?.message
                });
                this.rejectWithTransactionError(reject, transaction, lastRequestError, 'Transaction error');
            };
        });
    }

    /**
     * Get a single file synchronously from the cache.
     *
     * @param path - File path to retrieve
     * @returns File data or null if not found
     */
    getFile(path: string): FileData | null {
        if (!this.cache.isReady()) {
            return null;
        }
        return this.cache.getFile(path);
    }

    /**
     * Seed the in-memory cache for a path without writing to IndexedDB.
     * Used to keep UI responsive when files are renamed and we already
     * have complete metadata under the old path.
     */
    seedMemoryFile(path: string, data: FileData): void {
        if (!this.cache.isReady()) {
            return;
        }
        this.cache.setClonedFile(path, data);
    }

    /**
     * Store or update a single file in the database.
     *
     * @param path - File path (key)
     * @param data - File data to store
     */
    async setFile(path: string, data: FileData): Promise<void> {
        await this.init();
        if (!this.db) throw new Error('Database not initialized');

        const transaction = this.db.transaction([STORE_NAME], 'readwrite');
        const store = transaction.objectStore(STORE_NAME);

        return new Promise((resolve, reject) => {
            const op = 'put';
            let lastRequestError: DOMException | Error | null = null;
            // Persist the main record without feature image blob data.
            const sanitized = this.normalizeFileData({ ...data, featureImage: null });
            const request = store.put(sanitized, path);
            request.onerror = () => {
                lastRequestError = request.error || null;
                console.error('[IndexedDB] put failed', {
                    store: STORE_NAME,
                    path,
                    name: request.error?.name,
                    message: request.error?.message
                });
            };
            transaction.oncomplete = () => {
                this.cache.updateFile(path, sanitized);
                resolve();
            };
            transaction.onabort = () => {
                console.error('[IndexedDB] transaction aborted', {
                    store: STORE_NAME,
                    op,
                    path,
                    txError: transaction.error?.message,
                    reqError: lastRequestError?.message
                });
                this.rejectWithTransactionError(reject, transaction, lastRequestError, 'Transaction aborted');
            };
            transaction.onerror = () => {
                console.error('[IndexedDB] transaction error', {
                    store: STORE_NAME,
                    op,
                    path,
                    txError: transaction.error?.message,
                    reqError: lastRequestError?.message
                });
                this.rejectWithTransactionError(reject, transaction, lastRequestError, 'Transaction error');
            };
        });
    }

    /**
     * Delete a single file from the database by path.
     *
     * @param path - File path to delete
     */
    async deleteFile(path: string): Promise<void> {
        await this.init();
        if (!this.db) throw new Error('Database not initialized');

        const transaction = this.db.transaction([STORE_NAME, FEATURE_IMAGE_STORE_NAME], 'readwrite');
        const store = transaction.objectStore(STORE_NAME);
        const blobStore = transaction.objectStore(FEATURE_IMAGE_STORE_NAME);

        return new Promise((resolve, reject) => {
            const op = 'delete';
            let lastRequestError: DOMException | Error | null = null;
            const request = store.delete(path);
            request.onerror = () => {
                lastRequestError = request.error || null;
                console.error('[IndexedDB] delete failed', {
                    store: STORE_NAME,
                    path,
                    name: request.error?.name,
                    message: request.error?.message
                });
            };
            // Remove any feature image blob for the file path.
            const blobRequest = blobStore.delete(path);
            blobRequest.onerror = () => {
                lastRequestError = blobRequest.error || null;
                console.error('[IndexedDB] delete failed', {
                    store: FEATURE_IMAGE_STORE_NAME,
                    path,
                    name: blobRequest.error?.name,
                    message: blobRequest.error?.message
                });
            };
            transaction.oncomplete = () => {
                this.cache.deleteFile(path);
                this.featureImageBlobs.deleteFromCache(path);
                resolve();
            };
            transaction.onabort = () => {
                console.error('[IndexedDB] transaction aborted', {
                    store: STORE_NAME,
                    op,
                    path,
                    txError: transaction.error?.message,
                    reqError: lastRequestError?.message
                });
                this.rejectWithTransactionError(reject, transaction, lastRequestError, 'Transaction aborted');
            };
            transaction.onerror = () => {
                console.error('[IndexedDB] transaction error', {
                    store: STORE_NAME,
                    op,
                    path,
                    txError: transaction.error?.message,
                    reqError: lastRequestError?.message
                });
                this.rejectWithTransactionError(reject, transaction, lastRequestError, 'Transaction error');
            };
        });
    }

    /**
     * Get multiple files synchronously from the cache.
     * More efficient than multiple getFile calls.
     *
     * @param paths - Array of file paths to retrieve
     * @returns Map of path to file data (only includes found files)
     */
    getFiles(paths: string[]): Map<string, FileData> {
        if (!this.cache.isReady()) {
            return new Map();
        }
        return this.cache.getFiles(paths);
    }

    /**
     * Store or update multiple files in the database.
     * More efficient than multiple setFile calls.
     *
     * @param files - Array of file data with paths to store
     */
    async setFiles(files: { path: string; data: FileData }[]): Promise<void> {
        await this.init();
        if (!this.db) throw new Error('Database not initialized');

        const transaction = this.db.transaction([STORE_NAME], 'readwrite');
        const store = transaction.objectStore(STORE_NAME);

        return new Promise((resolve, reject) => {
            const op = 'put:batch';
            let lastRequestError: DOMException | Error | null = null;
            if (files.length === 0) {
                resolve();
                return;
            }
            // Persist batch records without feature image blob data.
            const sanitizedFiles = files.map(({ path, data }) => ({
                path,
                data: this.normalizeFileData({ ...data, featureImage: null })
            }));

            sanitizedFiles.forEach(({ path, data }) => {
                const request = store.put(data, path);
                request.onerror = () => {
                    lastRequestError = request.error || null;
                    console.error('[IndexedDB] put failed', {
                        store: STORE_NAME,
                        path,
                        name: request.error?.name,
                        message: request.error?.message
                    });
                };
            });

            transaction.oncomplete = () => {
                this.cache.batchUpdate(sanitizedFiles);
                resolve();
            };
            transaction.onabort = () => {
                console.error('[IndexedDB] transaction aborted', {
                    store: STORE_NAME,
                    op,
                    txError: transaction.error?.message,
                    reqError: lastRequestError?.message
                });
                this.rejectWithTransactionError(reject, transaction, lastRequestError, 'Transaction aborted');
            };
            transaction.onerror = () => {
                console.error('[IndexedDB] transaction error', {
                    store: STORE_NAME,
                    op,
                    txError: transaction.error?.message,
                    reqError: lastRequestError?.message
                });
                this.rejectWithTransactionError(reject, transaction, lastRequestError, 'Transaction error');
            };
        });
    }

    /**
     * Delete multiple files from the database by paths.
     * More efficient than multiple deleteFile calls.
     *
     * @param paths - Array of file paths to delete
     */
    async deleteFiles(paths: string[]): Promise<void> {
        await this.init();
        if (!this.db) throw new Error('Database not initialized');

        const transaction = this.db.transaction([STORE_NAME, FEATURE_IMAGE_STORE_NAME], 'readwrite');
        const store = transaction.objectStore(STORE_NAME);
        const blobStore = transaction.objectStore(FEATURE_IMAGE_STORE_NAME);

        return new Promise((resolve, reject) => {
            const op = 'delete:batch';
            let lastRequestError: DOMException | Error | null = null;
            if (paths.length === 0) {
                resolve();
                return;
            }

            paths.forEach(path => {
                const request = store.delete(path);
                request.onerror = () => {
                    lastRequestError = request.error || null;
                    console.error('[IndexedDB] delete failed', {
                        store: STORE_NAME,
                        path,
                        name: request.error?.name,
                        message: request.error?.message
                    });
                };
                // Remove any feature image blob for the file path.
                const blobRequest = blobStore.delete(path);
                blobRequest.onerror = () => {
                    lastRequestError = blobRequest.error || null;
                    console.error('[IndexedDB] delete failed', {
                        store: FEATURE_IMAGE_STORE_NAME,
                        path,
                        name: blobRequest.error?.name,
                        message: blobRequest.error?.message
                    });
                };
            });

            transaction.oncomplete = () => {
                this.cache.batchDelete(paths);
                paths.forEach(path => this.featureImageBlobs.deleteFromCache(path));
                resolve();
            };
            transaction.onabort = () => {
                console.error('[IndexedDB] transaction aborted', {
                    store: STORE_NAME,
                    op,
                    txError: transaction.error?.message,
                    reqError: lastRequestError?.message
                });
                this.rejectWithTransactionError(reject, transaction, lastRequestError, 'Transaction aborted');
            };
            transaction.onerror = () => {
                console.error('[IndexedDB] transaction error', {
                    store: STORE_NAME,
                    op,
                    txError: transaction.error?.message,
                    reqError: lastRequestError?.message
                });
                this.rejectWithTransactionError(reject, transaction, lastRequestError, 'Transaction error');
            };
        });
    }

    /**
     * Get files with content synchronously.
     * Returns files that have the specified content type generated.
     *
     * @param type - Type of content to check for
     * @returns Array of files with content
     */
    getFilesWithContent(type: 'preview' | 'featureImage' | 'metadata'): FileData[] {
        if (!this.cache.isReady()) {
            return [];
        }
        return this.cache.getAllFiles().filter(file => {
            if (type === 'preview') return file.preview !== null;
            // Feature images are considered present when a stored thumbnail blob exists.
            if (type === 'featureImage') return file.featureImageStatus === 'has';
            if (type === 'metadata') return file.metadata !== null;
            return false;
        });
    }

    /**
     * Count files synchronously.
     * Returns the total number of files in the database.
     *
     * @returns Number of files
     */
    getFileCount(): number {
        if (!this.cache.isReady()) {
            return 0;
        }
        return this.cache.getFileCount();
    }

    /**
     * Get all files with their paths.
     * Returns array of objects containing path and file data.
     *
     * @returns Array of files with paths
     */
    getAllFiles(): { path: string; data: FileData }[] {
        if (!this.cache.isReady()) {
            return [];
        }
        return this.cache.getAllFilesWithPaths();
    }

    /**
     * Stream all files with their paths without allocating an array.
     *
     * @param callback - Function to call for each file
     */
    forEachFile(callback: (path: string, data: FileData) => void): void {
        if (!this.cache.isReady()) {
            return;
        }
        this.cache.forEachFile(callback);
    }

    /**
     * Get files that need content generation.
     * Returns paths of files where the specified content type is null.
     *
     * @param type - Type of content to check for
     * @returns Set of file paths needing content
     */
    getFilesNeedingContent(type: 'tags' | 'preview' | 'featureImage' | 'metadata'): Set<string> {
        if (!this.cache.isReady()) {
            return new Set();
        }
        const result = new Set<string>();
        this.cache.forEachFile((path, data) => {
            if (
                (type === 'tags' && data.tags === null) ||
                (type === 'preview' && data.preview === null) ||
                // Feature images need processing when they are unprocessed.
                (type === 'featureImage' && data.featureImageStatus === 'unprocessed') ||
                (type === 'metadata' && data.metadata === null)
            ) {
                result.add(path);
            }
        });
        return result;
    }

    /**
     * Get current database statistics.
     * Returns the number of items in the main store and an estimated total size in MB.
     *
     * Includes feature image blobs stored in the dedicated blob store.
     *
     * @returns Object with item count and size in MB
     */
    async getDatabaseStats(): Promise<{ itemCount: number; sizeMB: number }> {
        if (!this.cache.isReady()) {
            return { itemCount: 0, sizeMB: 0 };
        }
        let itemCount = 0;
        let totalSize = 0;
        this.cache.forEachFile((path, data) => {
            itemCount++;
            totalSize += path.length + JSON.stringify(data).length;
        });
        await this.forEachFeatureImageBlobRecord((_path, record) => {
            totalSize += record.blob.size;
        });
        const sizeMB = totalSize / 1024 / 1024;
        return { itemCount, sizeMB };
    }

    /**
     * Update file content (preview, image, and/or metadata) by path.
     * Only updates provided fields, preserves others.
     * Emits change notifications.
     *
     * @param path - File path to update
     * @param preview - New preview text (optional)
     * @param image - New feature image blob (optional)
     * @param metadata - New metadata (optional)
     */
    async updateFileContent(
        path: string,
        preview?: string,
        image?: Blob | null,
        metadata?: FileData['metadata'],
        featureImageKey?: string | null
    ): Promise<void> {
        await this.init();
        if (!this.db) throw new Error('Database not initialized');

        const transaction = this.db.transaction([STORE_NAME, FEATURE_IMAGE_STORE_NAME], 'readwrite');
        const store = transaction.objectStore(STORE_NAME);
        const blobStore = transaction.objectStore(FEATURE_IMAGE_STORE_NAME);
        const changes: FileContentChange['changes'] = {};
        let updated: FileData | null = null;
        let shouldClearFeatureImageCache = false;
        const opUpdate = 'updateFileContent';
        let lastRequestErrorUpdate: DOMException | Error | null = null;

        await new Promise<void>((resolve, reject) => {
            const getReq = store.get(path);
            getReq.onsuccess = () => {
                const existingRaw = (getReq.result as Partial<FileData> | undefined) || null;
                if (!existingRaw) {
                    resolve();
                    return;
                }
                const existing = this.normalizeFileData(existingRaw);
                const next: FileData = { ...existing };

                const featureImageMutation = computeFeatureImageMutation({
                    existingKey: existing.featureImageKey,
                    existingStatus: existing.featureImageStatus,
                    featureImageKey,
                    featureImage: image
                });
                if (featureImageMutation.changes.featureImageKey !== undefined) {
                    changes.featureImageKey = featureImageMutation.changes.featureImageKey;
                }
                if (featureImageMutation.changes.featureImageStatus !== undefined) {
                    changes.featureImageStatus = featureImageMutation.changes.featureImageStatus;
                }
                if (featureImageMutation.shouldClearCache) {
                    shouldClearFeatureImageCache = true;
                }

                if (preview !== undefined) {
                    next.preview = preview;
                    changes.preview = preview;
                }
                if (metadata !== undefined) {
                    next.metadata = metadata;
                    changes.metadata = metadata;
                }

                // Main store records never hold blob data.
                next.featureImageKey = featureImageMutation.nextKey;
                next.featureImage = null;
                next.featureImageStatus = featureImageMutation.nextStatus;
                updated = next;
                if (featureImageMutation.blobUpdate) {
                    // Write the blob record with the current key.
                    const imageReq = blobStore.put(featureImageMutation.blobUpdate, path);
                    imageReq.onerror = () => {
                        lastRequestErrorUpdate = imageReq.error || null;
                        console.error('[IndexedDB] put failed', {
                            store: FEATURE_IMAGE_STORE_NAME,
                            op: opUpdate,
                            path,
                            name: imageReq.error?.name,
                            message: imageReq.error?.message
                        });
                    };
                } else if (featureImageMutation.shouldDeleteBlob) {
                    const deleteReq = blobStore.delete(path);
                    deleteReq.onerror = () => {
                        lastRequestErrorUpdate = deleteReq.error || null;
                        console.error('[IndexedDB] delete failed', {
                            store: FEATURE_IMAGE_STORE_NAME,
                            op: opUpdate,
                            path,
                            name: deleteReq.error?.name,
                            message: deleteReq.error?.message
                        });
                    };
                }
                const putReq = store.put(next, path);
                putReq.onerror = () => {
                    lastRequestErrorUpdate = putReq.error || null;
                    console.error('[IndexedDB] put failed', {
                        store: STORE_NAME,
                        op: opUpdate,
                        path,
                        name: putReq.error?.name,
                        message: putReq.error?.message
                    });
                };
            };
            getReq.onerror = () => {
                lastRequestErrorUpdate = getReq.error || null;
                console.error('[IndexedDB] get failed', {
                    store: STORE_NAME,
                    op: opUpdate,
                    path,
                    name: getReq.error?.name,
                    message: getReq.error?.message
                });
                try {
                    transaction.abort();
                } catch (e) {
                    void e;
                }
            };
            transaction.oncomplete = () => resolve();
            transaction.onabort = () => {
                console.error('[IndexedDB] transaction aborted', {
                    store: STORE_NAME,
                    op: opUpdate,
                    path,
                    txError: transaction.error?.message,
                    reqError: lastRequestErrorUpdate?.message
                });
                this.rejectWithTransactionError(reject, transaction, lastRequestErrorUpdate, 'Transaction aborted');
            };
            transaction.onerror = () => {
                console.error('[IndexedDB] transaction error', {
                    store: STORE_NAME,
                    op: opUpdate,
                    path,
                    txError: transaction.error?.message,
                    reqError: lastRequestErrorUpdate?.message
                });
                this.rejectWithTransactionError(reject, transaction, lastRequestErrorUpdate, 'Transaction error');
            };
        });

        if (updated) {
            this.cache.updateFile(path, updated);
            if (shouldClearFeatureImageCache) {
                // Remove any cached blob for the updated path.
                this.featureImageBlobs.deleteFromCache(path);
            }
            if (Object.keys(changes).length > 0) {
                const hasContentChanges =
                    changes.preview !== undefined || changes.featureImageKey !== undefined || changes.featureImageStatus !== undefined;
                const hasMetadataChanges = changes.metadata !== undefined;
                const changeType = hasContentChanges && hasMetadataChanges ? 'both' : hasContentChanges ? 'content' : 'metadata';
                this.emitChanges([{ path, changes, changeType }]);
            }
        }
    }

    /**
     * Update file metadata by path.
     * Merges with existing metadata rather than replacing.
     * Emits change notifications.
     *
     * @param path - File path to update
     * @param metadata - Metadata fields to update
     */
    async updateFileMetadata(
        path: string,
        metadata: {
            name?: string;
            created?: number;
            modified?: number;
            icon?: string;
            color?: string;
        }
    ): Promise<void> {
        await this.init();
        if (!this.db) throw new Error('Database not initialized');

        const transaction = this.db.transaction([STORE_NAME], 'readwrite');
        const store = transaction.objectStore(STORE_NAME);
        let updated: FileData | null = null;
        const opMeta = 'updateFileMetadata';
        let lastRequestErrorMeta: DOMException | Error | null = null;

        await new Promise<void>((resolve, reject) => {
            const getReq = store.get(path);
            getReq.onsuccess = () => {
                const existingRaw = (getReq.result as Partial<FileData> | undefined) || null;
                if (!existingRaw) {
                    resolve();
                    return;
                }
                const existing = this.normalizeFileData(existingRaw);
                const newMeta = { ...(existing.metadata || {}), ...metadata };
                updated = { ...existing, metadata: newMeta };
                const putReq = store.put(updated, path);
                putReq.onerror = () => {
                    lastRequestErrorMeta = putReq.error || null;
                    console.error('[IndexedDB] put failed', {
                        store: STORE_NAME,
                        op: opMeta,
                        path,
                        name: putReq.error?.name,
                        message: putReq.error?.message
                    });
                };
            };
            getReq.onerror = () => {
                lastRequestErrorMeta = getReq.error || null;
                console.error('[IndexedDB] get failed', {
                    store: STORE_NAME,
                    op: opMeta,
                    path,
                    name: getReq.error?.name,
                    message: getReq.error?.message
                });
                try {
                    transaction.abort();
                } catch (e) {
                    void e;
                }
            };
            transaction.oncomplete = () => resolve();
            transaction.onabort = () => {
                console.error('[IndexedDB] transaction aborted', {
                    store: STORE_NAME,
                    op: opMeta,
                    path,
                    txError: transaction.error?.message,
                    reqError: lastRequestErrorMeta?.message
                });
                this.rejectWithTransactionError(reject, transaction, lastRequestErrorMeta, 'Transaction aborted');
            };
            transaction.onerror = () => {
                console.error('[IndexedDB] transaction error', {
                    store: STORE_NAME,
                    op: opMeta,
                    path,
                    txError: transaction.error?.message,
                    reqError: lastRequestErrorMeta?.message
                });
                this.rejectWithTransactionError(reject, transaction, lastRequestErrorMeta, 'Transaction error');
            };
        });

        if (updated) {
            const updatedRecord: FileData = updated;
            this.cache.updateFile(path, updatedRecord);
            this.emitChanges([{ path, changes: { metadata: updatedRecord.metadata }, changeType: 'metadata' }]);
        }
    }

    /**
     * Update modification times for multiple files in batch.
     * Used by content providers after successfully generating content.
     * Does NOT emit change notifications as this is an internal update.
     *
     * @param updates - Array of path and mtime pairs to update
     */
    async updateMtimes(updates: { path: string; mtime: number }[]): Promise<void> {
        await this.init();
        if (!this.db) throw new Error('Database not initialized');

        if (updates.length === 0) return;

        const transaction = this.db.transaction([STORE_NAME], 'readwrite');
        const store = transaction.objectStore(STORE_NAME);
        const cacheUpdates: { path: string; data: FileData }[] = [];

        await new Promise<void>((resolve, reject) => {
            const op = 'updateMtimes';
            let lastRequestError: DOMException | Error | null = null;
            updates.forEach(({ path, mtime }) => {
                const getReq = store.get(path);
                getReq.onsuccess = () => {
                    const existingRaw = (getReq.result as Partial<FileData> | undefined) || null;
                    if (!existingRaw) return;
                    const updated: FileData = { ...this.normalizeFileData(existingRaw), mtime };
                    cacheUpdates.push({ path, data: updated });
                    const putReq = store.put(updated, path);
                    putReq.onerror = () => {
                        lastRequestError = putReq.error || null;
                        console.error('[IndexedDB] put failed', {
                            store: STORE_NAME,
                            op,
                            path,
                            name: putReq.error?.name,
                            message: putReq.error?.message
                        });
                    };
                };
                getReq.onerror = () => {
                    lastRequestError = getReq.error || null;
                    console.error('[IndexedDB] get failed', {
                        store: STORE_NAME,
                        op,
                        path,
                        name: getReq.error?.name,
                        message: getReq.error?.message
                    });
                    try {
                        transaction.abort();
                    } catch (e) {
                        void e;
                    }
                };
            });
            transaction.oncomplete = () => {
                if (cacheUpdates.length > 0) {
                    this.cache.batchUpdate(cacheUpdates);
                }
                resolve();
            };
            transaction.onabort = () => {
                console.error('[IndexedDB] transaction aborted', {
                    store: STORE_NAME,
                    op,
                    txError: transaction.error?.message,
                    reqError: lastRequestError?.message
                });
                this.rejectWithTransactionError(reject, transaction, lastRequestError, 'Transaction aborted');
            };
            transaction.onerror = () => {
                console.error('[IndexedDB] transaction error', {
                    store: STORE_NAME,
                    op,
                    txError: transaction.error?.message,
                    reqError: lastRequestError?.message
                });
                this.rejectWithTransactionError(reject, transaction, lastRequestError, 'Transaction error');
            };
        });
    }

    /**
     * Clear content for a file by path (set to null).
     * Used when content needs to be regenerated.
     * Emits change notifications.
     *
     * @param path - File path to clear content for
     * @param type - Type of content to clear or 'all'
     */
    async clearFileContent(path: string, type: 'preview' | 'featureImage' | 'metadata' | 'all'): Promise<void> {
        await this.init();
        if (!this.db) throw new Error('Database not initialized');

        const transaction = this.db.transaction([STORE_NAME, FEATURE_IMAGE_STORE_NAME], 'readwrite');
        const store = transaction.objectStore(STORE_NAME);
        const blobStore = transaction.objectStore(FEATURE_IMAGE_STORE_NAME);
        const changes: FileContentChange['changes'] = {};
        let updated: FileData | null = null;
        let shouldClearFeatureImageCache = false;
        const op = 'clearFileContent';
        let lastRequestError: DOMException | Error | null = null;

        await new Promise<void>((resolve, reject) => {
            const getReq = store.get(path);
            getReq.onsuccess = () => {
                const existingRaw = (getReq.result as Partial<FileData> | undefined) || null;
                if (!existingRaw) {
                    resolve();
                    return;
                }
                const file = { ...this.normalizeFileData(existingRaw) };
                if (type === 'preview' || type === 'all') {
                    if (file.preview !== null) {
                        file.preview = null;
                        changes.preview = null;
                    }
                }
                if (type === 'featureImage' || type === 'all') {
                    // Clear feature image key in the main store and delete blob records.
                    if (file.featureImageKey !== null) {
                        file.featureImageKey = null;
                        changes.featureImageKey = null;
                    }
                    if (file.featureImageStatus !== 'unprocessed') {
                        file.featureImageStatus = 'unprocessed';
                        changes.featureImageStatus = 'unprocessed';
                    }
                    file.featureImage = null;
                    shouldClearFeatureImageCache = true;
                    const deleteReq = blobStore.delete(path);
                    deleteReq.onerror = () => {
                        lastRequestError = deleteReq.error || null;
                        console.error('[IndexedDB] delete failed', {
                            store: FEATURE_IMAGE_STORE_NAME,
                            op,
                            path,
                            name: deleteReq.error?.name,
                            message: deleteReq.error?.message
                        });
                    };
                }
                if (type === 'metadata' || type === 'all') {
                    if (file.metadata !== null) {
                        file.metadata = null;
                        changes.metadata = null;
                    }
                }
                updated = file;
                const putReq = store.put(file, path);
                putReq.onerror = () => {
                    lastRequestError = putReq.error || null;
                    console.error('[IndexedDB] put failed', {
                        store: STORE_NAME,
                        op,
                        path,
                        name: putReq.error?.name,
                        message: putReq.error?.message
                    });
                };
            };
            getReq.onerror = () => {
                lastRequestError = getReq.error || null;
                console.error('[IndexedDB] get failed', {
                    store: STORE_NAME,
                    op,
                    path,
                    name: getReq.error?.name,
                    message: getReq.error?.message
                });
                try {
                    transaction.abort();
                } catch (e) {
                    void e;
                }
            };
            transaction.oncomplete = () => resolve();
            transaction.onabort = () => {
                console.error('[IndexedDB] transaction aborted', {
                    store: STORE_NAME,
                    op,
                    path,
                    txError: transaction.error?.message,
                    reqError: lastRequestError?.message
                });
                this.rejectWithTransactionError(reject, transaction, lastRequestError, 'Transaction aborted');
            };
            transaction.onerror = () => {
                console.error('[IndexedDB] transaction error', {
                    store: STORE_NAME,
                    op,
                    path,
                    txError: transaction.error?.message,
                    reqError: lastRequestError?.message
                });
                this.rejectWithTransactionError(reject, transaction, lastRequestError, 'Transaction error');
            };
        });

        if (updated) {
            this.cache.updateFile(path, updated);
            if (shouldClearFeatureImageCache) {
                this.featureImageBlobs.deleteFromCache(path);
            }
            if (Object.keys(changes).length > 0) {
                const hasContentCleared =
                    changes.preview === null || changes.featureImageKey === null || changes.featureImageStatus !== undefined;
                const hasMetadataCleared = changes.metadata === null;
                const changeType = hasContentCleared && hasMetadataCleared ? 'both' : hasContentCleared ? 'content' : 'metadata';
                this.emitChanges([{ path, changes, changeType }]);
            }
        }
    }

    /**
     * Clear content for ALL files in batch using cursor.
     * Very efficient for clearing content when settings change.
     * Only clears content that is not already null.
     * Emits change notifications for all affected files.
     *
     * @param type - Type of content to clear or 'all'
     */
    async batchClearAllFileContent(type: 'preview' | 'featureImage' | 'metadata' | 'tags' | 'all'): Promise<void> {
        await this.init();
        if (!this.db) throw new Error('Database not initialized');

        const transaction = this.db.transaction([STORE_NAME, FEATURE_IMAGE_STORE_NAME], 'readwrite');
        const store = transaction.objectStore(STORE_NAME);
        const blobStore = transaction.objectStore(FEATURE_IMAGE_STORE_NAME);
        const changeNotifications: FileContentChange[] = [];
        const cacheUpdates: { path: string; data: FileData }[] = [];
        const op = 'batchClearAllFileContent';
        let lastRequestError: DOMException | Error | null = null;

        return new Promise((resolve, reject) => {
            if (type === 'featureImage' || type === 'all') {
                // Clear all feature image blobs in one operation.
                const clearReq = blobStore.clear();
                clearReq.onerror = () => {
                    lastRequestError = clearReq.error || null;
                    console.error('[IndexedDB] clear failed', {
                        store: FEATURE_IMAGE_STORE_NAME,
                        op,
                        name: clearReq.error?.name,
                        message: clearReq.error?.message
                    });
                };
            }
            const request = store.openCursor();

            request.onsuccess = () => {
                const cursor = request.result;
                if (cursor) {
                    const current = this.normalizeFileData(cursor.value as Partial<FileData>);
                    const updated: FileData = { ...current };
                    const changes: FileContentChange['changes'] = {};
                    let hasChanges = false;

                    if ((type === 'preview' || type === 'all') && updated.preview !== null) {
                        updated.preview = null;
                        changes.preview = null;
                        hasChanges = true;
                    }
                    if ((type === 'featureImage' || type === 'all') && updated.featureImageKey !== null) {
                        updated.featureImageKey = null;
                        changes.featureImageKey = null;
                        hasChanges = true;
                    }
                    if (type === 'featureImage' || type === 'all') {
                        updated.featureImage = null;
                        if (updated.featureImageStatus !== 'unprocessed') {
                            updated.featureImageStatus = 'unprocessed';
                            changes.featureImageStatus = 'unprocessed';
                            hasChanges = true;
                        }
                    }
                    if ((type === 'metadata' || type === 'all') && updated.metadata !== null) {
                        updated.metadata = null;
                        changes.metadata = null;
                        hasChanges = true;
                    }
                    if ((type === 'tags' || type === 'all') && updated.tags !== null) {
                        updated.tags = null;
                        changes.tags = null;
                        hasChanges = true;
                    }

                    if (hasChanges) {
                        const path = cursor.key as string;
                        const updateReq = cursor.update(updated);
                        updateReq.onerror = () => {
                            lastRequestError = updateReq.error || null;
                            console.error('[IndexedDB] cursor.update failed', {
                                store: STORE_NAME,
                                op,
                                path,
                                name: updateReq.error?.name,
                                message: updateReq.error?.message
                            });
                            try {
                                transaction.abort();
                            } catch (e) {
                                void e;
                            }
                        };
                        cacheUpdates.push({ path, data: updated });
                        const hasContentCleared =
                            changes.preview === null || changes.featureImageKey === null || changes.featureImageStatus !== undefined;
                        const hasMetadataCleared = changes.metadata === null || changes.tags !== undefined;
                        const clearType = hasContentCleared && hasMetadataCleared ? 'both' : hasContentCleared ? 'content' : 'metadata';
                        changeNotifications.push({ path, changes, changeType: clearType });
                    }

                    cursor.continue();
                }
            };

            request.onerror = () => {
                const requestError = request.error;
                lastRequestError = requestError || null;
                console.error('[IndexedDB] openCursor failed', {
                    store: STORE_NAME,
                    op,
                    name: requestError?.name,
                    message: requestError?.message
                });
                reject(this.normalizeIdbError(requestError, 'Cursor request failed'));
            };

            transaction.oncomplete = () => {
                if (cacheUpdates.length > 0) {
                    this.cache.batchUpdate(cacheUpdates);
                    this.emitChanges(changeNotifications);
                }
                if (type === 'featureImage' || type === 'all') {
                    // Reset the in-memory blob cache when all blobs are cleared.
                    this.featureImageBlobs.clearMemoryCaches();
                }
                resolve();
            };
            transaction.onabort = () => {
                console.error('[IndexedDB] transaction aborted', {
                    store: STORE_NAME,
                    op,
                    txError: transaction.error?.message,
                    reqError: lastRequestError?.message
                });
                this.rejectWithTransactionError(reject, transaction, lastRequestError, 'Transaction aborted');
            };
            transaction.onerror = () => {
                console.error('[IndexedDB] transaction error', {
                    store: STORE_NAME,
                    op,
                    txError: transaction.error?.message,
                    reqError: lastRequestError?.message
                });
                this.rejectWithTransactionError(reject, transaction, lastRequestError, 'Transaction error');
            };
        });
    }

    /**
     * Clear content for specific files in batch.
     * More efficient than multiple clearFileContent calls.
     * Only clears content that is not already null.
     * Emits change notifications for all affected files.
     *
     * @param paths - Array of file paths to clear content for
     * @param type - Type of content to clear or 'all'
     */
    async batchClearFileContent(paths: string[], type: 'preview' | 'featureImage' | 'metadata' | 'tags' | 'all'): Promise<void> {
        await this.init();
        if (!this.db) throw new Error('Database not initialized');

        const transaction = this.db.transaction([STORE_NAME, FEATURE_IMAGE_STORE_NAME], 'readwrite');
        const store = transaction.objectStore(STORE_NAME);
        const blobStore = transaction.objectStore(FEATURE_IMAGE_STORE_NAME);
        const updates: { path: string; data: FileData }[] = [];
        const changeNotifications: FileContentChange[] = [];
        const op = 'batchClearFileContent';
        let lastRequestError: DOMException | Error | null = null;

        await new Promise<void>((resolve, reject) => {
            if (paths.length === 0) {
                resolve();
                return;
            }

            paths.forEach(path => {
                const getReq = store.get(path);
                getReq.onsuccess = () => {
                    const existingRaw = (getReq.result as Partial<FileData> | undefined) || null;
                    if (!existingRaw) {
                        return;
                    }
                    const file = { ...this.normalizeFileData(existingRaw) };
                    const changes: FileContentChange['changes'] = {};
                    let hasChanges = false;
                    if ((type === 'preview' || type === 'all') && file.preview !== null) {
                        file.preview = null;
                        changes.preview = null;
                        hasChanges = true;
                    }
                    if ((type === 'featureImage' || type === 'all') && file.featureImageKey !== null) {
                        file.featureImageKey = null;
                        changes.featureImageKey = null;
                        hasChanges = true;
                    }
                    if (type === 'featureImage' || type === 'all') {
                        file.featureImage = null;
                        if (file.featureImageStatus !== 'unprocessed') {
                            file.featureImageStatus = 'unprocessed';
                            changes.featureImageStatus = 'unprocessed';
                            hasChanges = true;
                        }
                    }
                    if ((type === 'metadata' || type === 'all') && file.metadata !== null) {
                        file.metadata = null;
                        changes.metadata = null;
                        hasChanges = true;
                    }
                    if ((type === 'tags' || type === 'all') && file.tags !== null) {
                        file.tags = null;
                        changes.tags = null;
                        hasChanges = true;
                    }
                    if (hasChanges) {
                        const putReq = store.put(file, path);
                        putReq.onerror = () => {
                            lastRequestError = putReq.error || null;
                            console.error('[IndexedDB] put failed', {
                                store: STORE_NAME,
                                op,
                                path,
                                name: putReq.error?.name,
                                message: putReq.error?.message
                            });
                        };
                        if (type === 'featureImage' || type === 'all') {
                            // Remove feature image blobs for the cleared paths.
                            const deleteReq = blobStore.delete(path);
                            deleteReq.onerror = () => {
                                lastRequestError = deleteReq.error || null;
                                console.error('[IndexedDB] delete failed', {
                                    store: FEATURE_IMAGE_STORE_NAME,
                                    op,
                                    path,
                                    name: deleteReq.error?.name,
                                    message: deleteReq.error?.message
                                });
                            };
                        }
                        updates.push({ path, data: file });
                        const hasContentCleared =
                            changes.preview === null || changes.featureImageKey === null || changes.featureImageStatus !== undefined;
                        const hasMetadataCleared = changes.metadata === null || changes.tags !== undefined;
                        const clearType = hasContentCleared && hasMetadataCleared ? 'both' : hasContentCleared ? 'content' : 'metadata';
                        changeNotifications.push({ path, changes, changeType: clearType });
                    }
                    // noop
                };
                getReq.onerror = () => {
                    lastRequestError = getReq.error || null;
                    console.error('[IndexedDB] get failed', {
                        store: STORE_NAME,
                        op,
                        path,
                        name: getReq.error?.name,
                        message: getReq.error?.message
                    });
                    try {
                        transaction.abort();
                    } catch (e) {
                        void e;
                    }
                };
            });

            transaction.oncomplete = () => resolve();
            transaction.onabort = () => {
                console.error('[IndexedDB] transaction aborted', {
                    store: STORE_NAME,
                    op,
                    txError: transaction.error?.message,
                    reqError: lastRequestError?.message
                });
                this.rejectWithTransactionError(reject, transaction, lastRequestError, 'Transaction aborted');
            };
            transaction.onerror = () => {
                console.error('[IndexedDB] transaction error', {
                    store: STORE_NAME,
                    op,
                    txError: transaction.error?.message,
                    reqError: lastRequestError?.message
                });
                this.rejectWithTransactionError(reject, transaction, lastRequestError, 'Transaction error');
            };
        });

        if (updates.length > 0) {
            this.cache.batchUpdate(updates);
            this.emitChanges(changeNotifications);
        }
        if (type === 'featureImage' || type === 'all') {
            // Drop any cached blobs for the cleared paths.
            for (const path of paths) {
                this.featureImageBlobs.deleteFromCache(path);
            }
        }
    }

    /**
     * Update content for multiple files in batch.
     * More efficient than multiple updateFileContent calls.
     * Emits change notifications for all updates so UI components can react.
     * This is the primary method for notifying the UI about content changes.
     *
     * @param updates - Array of content updates to apply
     */
    async batchUpdateFileContent(
        updates: {
            path: string;
            tags?: string[] | null;
            preview?: string;
            featureImage?: Blob | null;
            featureImageKey?: string | null;
            metadata?: FileData['metadata'];
        }[]
    ): Promise<void> {
        await this.init();
        if (!this.db) throw new Error('Database not initialized');

        if (updates.length === 0) return;

        const transaction = this.db.transaction([STORE_NAME, FEATURE_IMAGE_STORE_NAME], 'readwrite');
        const store = transaction.objectStore(STORE_NAME);
        const blobStore = transaction.objectStore(FEATURE_IMAGE_STORE_NAME);
        const filesToUpdate: { path: string; data: FileData }[] = [];
        const changeNotifications: FileContentChange[] = [];
        const featureImageCacheUpdates = new Set<string>();

        await new Promise<void>((resolve, reject) => {
            const op = 'batchUpdateFileContent';
            let lastRequestError: DOMException | Error | null = null;
            updates.forEach(update => {
                const getReq = store.get(update.path);
                getReq.onsuccess = () => {
                    const existingRaw = (getReq.result as Partial<FileData> | undefined) || null;
                    if (!existingRaw) {
                        return;
                    }
                    const existing = this.normalizeFileData(existingRaw);
                    const newData: FileData = { ...existing };
                    const changes: FileContentChange['changes'] = {};
                    let hasChanges = false;
                    if (update.tags !== undefined) {
                        newData.tags = update.tags;
                        changes.tags = update.tags;
                        hasChanges = true;
                    }
                    if (update.preview !== undefined) {
                        newData.preview = update.preview;
                        changes.preview = update.preview;
                        hasChanges = true;
                    }
                    const featureImageMutation = computeFeatureImageMutation({
                        existingKey: existing.featureImageKey,
                        existingStatus: existing.featureImageStatus,
                        featureImageKey: update.featureImageKey,
                        featureImage: update.featureImage
                    });
                    if (featureImageMutation.changes.featureImageKey !== undefined) {
                        changes.featureImageKey = featureImageMutation.changes.featureImageKey;
                        hasChanges = true;
                    }
                    if (featureImageMutation.changes.featureImageStatus !== undefined) {
                        changes.featureImageStatus = featureImageMutation.changes.featureImageStatus;
                        hasChanges = true;
                    }
                    if (update.featureImageKey !== undefined || update.featureImage !== undefined) {
                        // Main store records never hold blob data.
                        newData.featureImageKey = featureImageMutation.nextKey;
                        newData.featureImage = null;
                        newData.featureImageStatus = featureImageMutation.nextStatus;
                    }
                    if (featureImageMutation.shouldClearCache) {
                        featureImageCacheUpdates.add(update.path);
                    }
                    if (update.metadata !== undefined) {
                        newData.metadata = update.metadata;
                        changes.metadata = update.metadata;
                        hasChanges = true;
                    }
                    if (hasChanges) {
                        const putReq = store.put(newData, update.path);
                        putReq.onerror = () => {
                            lastRequestError = putReq.error || null;
                            console.error('[IndexedDB] put failed', {
                                store: STORE_NAME,
                                op,
                                path: update.path,
                                name: putReq.error?.name,
                                message: putReq.error?.message
                            });
                        };
                        if (featureImageMutation.blobUpdate) {
                            // Write the blob record with the current key.
                            const imageReq = blobStore.put(featureImageMutation.blobUpdate, update.path);
                            imageReq.onerror = () => {
                                lastRequestError = imageReq.error || null;
                                console.error('[IndexedDB] put failed', {
                                    store: FEATURE_IMAGE_STORE_NAME,
                                    op,
                                    path: update.path,
                                    name: imageReq.error?.name,
                                    message: imageReq.error?.message
                                });
                            };
                        } else if (featureImageMutation.shouldDeleteBlob) {
                            // Remove any stored blob when the key changes or blob is empty.
                            const deleteReq = blobStore.delete(update.path);
                            deleteReq.onerror = () => {
                                lastRequestError = deleteReq.error || null;
                                console.error('[IndexedDB] delete failed', {
                                    store: FEATURE_IMAGE_STORE_NAME,
                                    op,
                                    path: update.path,
                                    name: deleteReq.error?.name,
                                    message: deleteReq.error?.message
                                });
                            };
                        }
                        filesToUpdate.push({ path: update.path, data: newData });
                        const hasContentUpdates =
                            changes.preview !== undefined ||
                            changes.featureImageKey !== undefined ||
                            changes.featureImageStatus !== undefined;
                        const hasMetadataUpdates = changes.metadata !== undefined || changes.tags !== undefined;
                        const updateType = hasContentUpdates && hasMetadataUpdates ? 'both' : hasContentUpdates ? 'content' : 'metadata';
                        changeNotifications.push({ path: update.path, changes, changeType: updateType });
                    }
                    // noop
                };
                getReq.onerror = () => {
                    lastRequestError = getReq.error || null;
                    console.error('[IndexedDB] get failed', {
                        store: STORE_NAME,
                        op,
                        path: update.path,
                        name: getReq.error?.name,
                        message: getReq.error?.message
                    });
                    try {
                        transaction.abort();
                    } catch (e) {
                        void e;
                    }
                };
            });
            transaction.oncomplete = () => resolve();
            transaction.onabort = () => {
                console.error('[IndexedDB] transaction aborted', {
                    store: STORE_NAME,
                    op,
                    txError: transaction.error?.message,
                    reqError: lastRequestError?.message
                });
                this.rejectWithTransactionError(reject, transaction, lastRequestError, 'Transaction aborted');
            };
            transaction.onerror = () => {
                console.error('[IndexedDB] transaction error', {
                    store: STORE_NAME,
                    op,
                    txError: transaction.error?.message,
                    reqError: lastRequestError?.message
                });
                this.rejectWithTransactionError(reject, transaction, lastRequestError, 'Transaction error');
            };
        });

        if (filesToUpdate.length > 0) {
            this.cache.batchUpdate(filesToUpdate);
            this.emitChanges(changeNotifications);
        }
        if (featureImageCacheUpdates.size > 0) {
            // Drop any cached blobs for updated paths.
            featureImageCacheUpdates.forEach(path => this.featureImageBlobs.deleteFromCache(path));
        }
    }

    /**
     * Batch update or add multiple files in the database.
     * More efficient than multiple setFile calls.
     * Updates cache after successful database writes.
     *
     * @param files - Array of file data with paths to store
     */
    async batchUpdate(files: { path: string; data: FileData }[]): Promise<void> {
        await this.setFiles(files);
    }

    /**
     * Clear database and reinitialize.
     * Used when vault structure changes significantly.
     */
    async clearDatabase(): Promise<void> {
        await this.clear();
    }

    /**
     * Check if a file has preview text synchronously.
     *
     * @param path - File path to check
     * @returns True if the file has preview text
     */
    hasPreview(path: string): boolean {
        if (!this.cache.isReady()) {
            return false;
        }
        return this.cache.hasPreview(path);
    }

    /**
     * Check if a file exists in the database.
     *
     * @param path - File path to check
     * @returns True if the file exists
     */
    hasFile(path: string): boolean {
        if (!this.cache.isReady()) {
            return false;
        }
        return this.cache.hasFile(path);
    }

    /**
     * Get preview text from memory cache, returning empty string if null.
     * Helper method for UI components that need non-null strings.
     *
     * @param path - File path to get preview for
     * @returns Preview text or empty string
     */
    getCachedPreviewText(path: string): string {
        const file = this.getFile(path);
        return file?.preview || '';
    }

    /**
     * Get tags from memory cache, returning empty array if none.
     * Helper method for UI components that need tag data.
     *
     * @param path - File path to get tags for
     * @returns Array of tag strings
     */
    getCachedTags(path: string): string[] {
        const file = this.getFile(path);
        // Return empty array if file doesn't exist or tags are null/not extracted yet
        if (!file || file.tags === null) return [];
        return file.tags;
    }

    /**
     * Fetch a feature image blob by path and expected key.
     * Reads from the in-memory LRU first, then IndexedDB.
     */
    async getFeatureImageBlob(path: string, expectedKey: string): Promise<Blob | null> {
        if (!expectedKey) {
            return null;
        }
        await this.init();
        if (!this.db) {
            return null;
        }
        return this.featureImageBlobs.getBlob(this.db, path, expectedKey);
    }

    /**
     * Stream all feature image blob records without allocating an array.
     * Only yields non-empty blobs with a string key.
     */
    async forEachFeatureImageBlobRecord(callback: (path: string, record: { featureImageKey: string; blob: Blob }) => void): Promise<void> {
        await this.init();
        if (!this.db) {
            return;
        }
        await this.featureImageBlobs.forEachBlobRecord(this.db, callback);
    }

    /**
     * Move a feature image blob between paths.
     */
    async moveFeatureImageBlob(oldPath: string, newPath: string): Promise<void> {
        await this.init();
        if (!this.db) throw new Error('Database not initialized');
        await this.featureImageBlobs.moveBlob(this.db, oldPath, newPath);
    }

    /**
     * Delete a feature image blob by path.
     */
    async deleteFeatureImageBlob(path: string): Promise<void> {
        await this.init();
        if (!this.db) throw new Error('Database not initialized');
        await this.featureImageBlobs.deleteBlob(this.db, path);
    }

    /**
     * Close the database connection.
     * Should be called when the plugin is unloaded.
     */
    close(): void {
        if (this.db) {
            this.db.close();
            this.db = null;
        }
        this.initPromise = null;
        this.cache.clear();
        this.featureImageBlobs.clearMemoryCaches();
    }
}
