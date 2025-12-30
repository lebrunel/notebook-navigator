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

import { STORAGE_KEYS } from '../types';
import { localStorage } from '../utils/localStorage';
import {
    DEFAULT_FEATURE_IMAGE_CACHE_MAX,
    FEATURE_IMAGE_STORE_NAME,
    FeatureImageBlobStore,
    computeFeatureImageMutation
} from './FeatureImageBlobStore';
import { MemoryFileCache } from './MemoryFileCache';
import { isPlainObjectRecordValue } from '../utils/recordUtils';
import { isMarkdownPath } from '../utils/fileTypeUtils';

const STORE_NAME = 'keyvaluepairs';
const PREVIEW_STORE_NAME = 'filePreviews';
const DB_SCHEMA_VERSION = 3; // IndexedDB structure version
const DB_CONTENT_VERSION = 1; // Data format version

export type FeatureImageStatus = 'unprocessed' | 'none' | 'has';
export type PreviewStatus = 'unprocessed' | 'none' | 'has';

function getDefaultPreviewStatusForPath(path: string): PreviewStatus {
    return isMarkdownPath(path) ? 'unprocessed' : 'none';
}

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
    /**
     * Preview text processing state.
     *
     * Semantics:
     * - `unprocessed`: content provider has not run yet for this file
     * - `none`: processed, but no preview text was produced
     * - `has`: processed and a non-empty preview string exists in the preview store
     */
    previewStatus: PreviewStatus;
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
    private previewLoadPromises = new Map<string, Promise<void>>();
    private previewLoadDeferred = new Map<string, { resolve: () => void }>();
    private previewLoadQueue = new Set<string>();
    private previewLoadFlushTimer: ReturnType<typeof setTimeout> | null = null;
    private isPreviewLoadFlushRunning = false;
    private previewLoadSessionId = 0;
    private isClosing = false;
    private initPromise: Promise<void> | null = null;
    private pendingRebuildNotice = false;
    private static readonly PREVIEW_LOAD_MAX_BATCH = 250;

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

    private normalizeFileDataInPlace(data: Partial<FileData> & { preview?: string | null }, pathForDefaults?: string): FileData {
        const featureImageKey = typeof data.featureImageKey === 'string' ? data.featureImageKey : null;
        const rawStatus = data.featureImageStatus;
        const featureImageStatus: FeatureImageStatus =
            rawStatus === 'unprocessed' || rawStatus === 'none' || rawStatus === 'has'
                ? rawStatus
                : featureImageKey === null
                  ? 'unprocessed'
                  : 'none';

        const rawPreviewStatus = data.previewStatus;
        const previewStatus: PreviewStatus =
            rawPreviewStatus === 'unprocessed' || rawPreviewStatus === 'none' || rawPreviewStatus === 'has'
                ? rawPreviewStatus
                : typeof data.preview === 'string'
                  ? data.preview.length > 0
                      ? 'has'
                      : 'none'
                  : typeof pathForDefaults === 'string'
                    ? getDefaultPreviewStatusForPath(pathForDefaults)
                    : 'unprocessed';

        data.mtime = typeof data.mtime === 'number' ? data.mtime : 0;
        data.tags = Array.isArray(data.tags) ? data.tags : null;
        data.previewStatus = previewStatus;
        // Feature image blobs are stored separately from the main record.
        // The MemoryFileCache is used for synchronous rendering and should not hold blob payloads.
        data.featureImage = null;
        data.featureImageStatus = featureImageStatus;
        data.featureImageKey = featureImageKey;
        data.metadata = data.metadata && typeof data.metadata === 'object' ? (data.metadata as FileData['metadata']) : null;

        if ('preview' in data) {
            delete (data as Partial<FileData> & { preview?: string | null }).preview;
        }

        return data as FileData;
    }

    private normalizeFileData(data: Partial<FileData> & { preview?: string | null }): FileData {
        const copy: Partial<FileData> & { preview?: string | null } = { ...data };
        return this.normalizeFileDataInPlace(copy);
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
        if (this.isClosing) {
            return;
        }
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

    private parseStoredVersion(value: unknown): number | null {
        if (typeof value === 'number' && Number.isFinite(value)) {
            return Math.trunc(value);
        }

        if (typeof value === 'string') {
            const parsed = Number.parseInt(value, 10);
            return Number.isFinite(parsed) ? parsed : null;
        }

        return null;
    }

    private getStoredVersion(key: string): number | null {
        const raw = localStorage.get<unknown>(key);
        return this.parseStoredVersion(raw);
    }

    private isVersionError(error: unknown): boolean {
        return error instanceof DOMException && error.name === 'VersionError';
    }

    private async checkSchemaAndInit(): Promise<void> {
        const storedSchemaVersion = this.getStoredVersion(STORAGE_KEYS.databaseSchemaVersionKey);
        const storedContentVersion = this.getStoredVersion(STORAGE_KEYS.databaseContentVersionKey);
        const currentSchemaVersion = DB_SCHEMA_VERSION;
        const currentContentVersion = DB_CONTENT_VERSION;

        // Check version changes
        const schemaVersionUnknown = storedSchemaVersion === null;
        const contentVersionUnknown = storedContentVersion === null;
        const schemaChanged = storedSchemaVersion !== null && storedSchemaVersion !== currentSchemaVersion;
        const contentChanged = storedContentVersion !== null && storedContentVersion !== currentContentVersion;
        const schemaDowngrade = schemaChanged && storedSchemaVersion !== null && storedSchemaVersion > currentSchemaVersion;

        // Only downgrade schema changes require database recreation; upgrades are handled via onupgradeneeded.
        if (schemaChanged) {
            if (schemaDowngrade) {
                console.log(
                    `Database schema version downgraded from ${storedSchemaVersion} to ${currentSchemaVersion}. Recreating database.`
                );
                await this.deleteDatabase();
            } else {
                console.log(`Database schema version upgraded from ${storedSchemaVersion} to ${currentSchemaVersion}.`);
            }
        } else if (schemaVersionUnknown) {
            console.log(`Database schema version is missing. Rebuilding database.`);
        }

        if (contentChanged) {
            console.log(`Content version changed from ${storedContentVersion} to ${currentContentVersion}. Rebuilding content.`);
        } else if (contentVersionUnknown) {
            console.log('Content version is missing. Rebuilding content.');
        }

        const needsRebuild = schemaDowngrade || contentChanged || schemaVersionUnknown || contentVersionUnknown;
        // Only show the rebuild notice when a version mismatch is detected (not when the keys are missing).
        this.pendingRebuildNotice = schemaDowngrade || contentChanged;

        try {
            await this.openDatabase(needsRebuild);
        } catch (error: unknown) {
            if (this.isVersionError(error)) {
                console.log('Database version mismatch detected. Recreating database.');
            } else {
                console.error('Database open failed. Recreating database.', error);
            }
            this.pendingRebuildNotice = true;
            await this.deleteDatabase();
            await this.openDatabase(true);
        }

        // Clear and rebuild content if either version changed
        if (needsRebuild) {
            // Clear all data to force rebuild
            await this.clear();
        }

        localStorage.set(STORAGE_KEYS.databaseSchemaVersionKey, currentSchemaVersion.toString());
        localStorage.set(STORAGE_KEYS.databaseContentVersionKey, currentContentVersion.toString());
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
                        this.cache.clear();

                        // Wrap an IndexedDB request in a promise so it can be awaited.
                        const requestToPromise = <T>(request: IDBRequest<T>, fallbackMessage: string): Promise<T> =>
                            new Promise((resolveRequest, rejectRequest) => {
                                request.onsuccess = () => resolveRequest(request.result);
                                request.onerror = () => rejectRequest(this.normalizeIdbError(request.error, fallbackMessage));
                            });

                        // Bulk-load the store to avoid per-row cursor callbacks.
                        // Use batching to limit peak memory usage on large vaults.
                        const batchSize = 5000;
                        // Tracks the last key in the previous batch so the next query can resume after it.
                        let lastKey: IDBValidKey | null = null;

                        while (true) {
                            const transaction = this.db.transaction([STORE_NAME], 'readonly');
                            const store = transaction.objectStore(STORE_NAME);
                            // When resuming, start strictly after the last key we processed.
                            const range = lastKey === null ? undefined : IDBKeyRange.lowerBound(lastKey, true);

                            // Fetch keys and values for the same range/count so indexes line up.
                            const keysRequest: IDBRequest<IDBValidKey[]> = store.getAllKeys(range, batchSize);
                            const valuesRequest = store.getAll(range, batchSize) as IDBRequest<Partial<FileData>[]>;
                            const [keys, values] = await Promise.all([
                                requestToPromise(keysRequest, 'getAllKeys failed'),
                                requestToPromise(valuesRequest, 'getAll failed')
                            ]);

                            if (keys.length === 0) {
                                break;
                            }

                            // Apply each row directly into the in-memory cache.
                            // Records are persisted by this class and are expected to already be normalized.
                            // Avoid allocating new objects during hydration by inserting the stored record directly.
                            const rowCount = Math.min(keys.length, values.length);
                            for (let index = 0; index < rowCount; index += 1) {
                                const key = keys[index];
                                if (typeof key !== 'string') {
                                    continue;
                                }
                                this.cache.updateFile(
                                    key,
                                    this.normalizeFileDataInPlace(values[index] as Partial<FileData> & { preview?: string | null }, key)
                                );
                            }

                            // Continue from the last key returned in this batch.
                            lastKey = keys[keys.length - 1];
                            // If IndexedDB returned fewer than the requested count, there are no more rows.
                            if (keys.length < batchSize) {
                                break;
                            }
                        }

                        // All data loaded, mark cache as ready.
                        this.cache.markInitialized();
                    } catch (error: unknown) {
                        console.error('[DB Cache] Failed to initialize cache:', error);
                        console.error(
                            '[DB Cache] IndexedDB cache hydration failed. Run Notebook Navigator: Rebuild cache to reset the database.'
                        );
                        this.cache.resetToEmpty();
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

                if (!db.objectStoreNames.contains(PREVIEW_STORE_NAME)) {
                    db.createObjectStore(PREVIEW_STORE_NAME);
                }

                const transaction = target.transaction;
                if (!transaction) {
                    return;
                }

                if (event.oldVersion < 2) {
                    // Schema v2 introduces a dedicated feature image blob store.
                    // Schema v3 introduces a dedicated preview text store.
                    //
                    // v1 cache payloads are not migrated; clear stores so the cache is rebuilt.

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

                    try {
                        if (transaction.objectStoreNames.contains(PREVIEW_STORE_NAME)) {
                            transaction.objectStore(PREVIEW_STORE_NAME).clear();
                        }
                    } catch (error: unknown) {
                        console.error('[IndexedDB] clear failed during upgrade', { store: PREVIEW_STORE_NAME, error });
                    }
                }

                if (event.oldVersion < 3) {
                    const mainStore = transaction.objectStore(STORE_NAME);
                    const previewStore = transaction.objectStore(PREVIEW_STORE_NAME);

                    const cursorRequest = mainStore.openCursor();
                    cursorRequest.onsuccess = () => {
                        const cursor = cursorRequest.result;
                        if (!cursor) {
                            return;
                        }

                        const path = cursor.key;
                        if (typeof path !== 'string') {
                            cursor.continue();
                            return;
                        }

                        const recordValue: unknown = cursor.value;
                        if (!isPlainObjectRecordValue(recordValue)) {
                            cursor.continue();
                            return;
                        }

                        const record = recordValue as { preview?: unknown; previewStatus?: unknown; featureImage?: unknown };
                        const legacyPreview = record.preview;
                        const previewText = typeof legacyPreview === 'string' ? legacyPreview : null;

                        const persistAndContinue = (nextPreviewStatus: PreviewStatus) => {
                            delete record.preview;
                            record.previewStatus = nextPreviewStatus;
                            record.featureImage = null;

                            const updateReq = cursor.update(record);
                            updateReq.onsuccess = () => cursor.continue();
                            updateReq.onerror = event2 => {
                                event2.preventDefault();
                                console.error('[IndexedDB] cursor.update failed during preview migration', {
                                    store: STORE_NAME,
                                    path,
                                    name: updateReq.error?.name,
                                    message: updateReq.error?.message
                                });
                                cursor.continue();
                            };
                        };

                        if (previewText === null) {
                            persistAndContinue('unprocessed');
                            return;
                        }

                        if (previewText.length === 0) {
                            persistAndContinue('none');
                            return;
                        }

                        const putReq = previewStore.put(previewText, path);
                        putReq.onsuccess = () => persistAndContinue('has');
                        putReq.onerror = event2 => {
                            event2.preventDefault();
                            console.error('[IndexedDB] put failed during preview migration', {
                                store: PREVIEW_STORE_NAME,
                                path,
                                name: putReq.error?.name,
                                message: putReq.error?.message
                            });
                            // Mark as unprocessed so the preview provider can regenerate content.
                            persistAndContinue('unprocessed');
                        };
                    };
                    cursorRequest.onerror = () => {
                        console.error('[IndexedDB] preview migration cursor failed', {
                            store: STORE_NAME,
                            name: cursorRequest.error?.name,
                            message: cursorRequest.error?.message
                        });
                    };
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

        // Clear stores in one transaction to keep the cache consistent.
        const transaction = this.db.transaction([STORE_NAME, FEATURE_IMAGE_STORE_NAME, PREVIEW_STORE_NAME], 'readwrite');
        const store = transaction.objectStore(STORE_NAME);
        const blobStore = transaction.objectStore(FEATURE_IMAGE_STORE_NAME);
        const previewStore = transaction.objectStore(PREVIEW_STORE_NAME);

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
            const previewRequest = previewStore.clear();
            previewRequest.onerror = () => {
                lastRequestError = previewRequest.error || null;
                console.error('[IndexedDB] clear failed', {
                    store: PREVIEW_STORE_NAME,
                    name: previewRequest.error?.name,
                    message: previewRequest.error?.message
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

        const transaction = this.db.transaction([STORE_NAME, FEATURE_IMAGE_STORE_NAME, PREVIEW_STORE_NAME], 'readwrite');
        const store = transaction.objectStore(STORE_NAME);
        const blobStore = transaction.objectStore(FEATURE_IMAGE_STORE_NAME);
        const previewStore = transaction.objectStore(PREVIEW_STORE_NAME);

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
            const previewRequest = previewStore.delete(path);
            previewRequest.onerror = () => {
                lastRequestError = previewRequest.error || null;
                console.error('[IndexedDB] delete failed', {
                    store: PREVIEW_STORE_NAME,
                    path,
                    name: previewRequest.error?.name,
                    message: previewRequest.error?.message
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

        const transaction = this.db.transaction([STORE_NAME, FEATURE_IMAGE_STORE_NAME, PREVIEW_STORE_NAME], 'readwrite');
        const store = transaction.objectStore(STORE_NAME);
        const blobStore = transaction.objectStore(FEATURE_IMAGE_STORE_NAME);
        const previewStore = transaction.objectStore(PREVIEW_STORE_NAME);

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
                const previewRequest = previewStore.delete(path);
                previewRequest.onerror = () => {
                    lastRequestError = previewRequest.error || null;
                    console.error('[IndexedDB] delete failed', {
                        store: PREVIEW_STORE_NAME,
                        path,
                        name: previewRequest.error?.name,
                        message: previewRequest.error?.message
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
            if (type === 'preview') return file.previewStatus !== 'unprocessed';
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
                (type === 'preview' && isMarkdownPath(path) && data.previewStatus === 'unprocessed') ||
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
        await this.forEachPreviewTextRecord((path, previewText) => {
            totalSize += path.length + previewText.length;
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

        const transaction = this.db.transaction([STORE_NAME, FEATURE_IMAGE_STORE_NAME, PREVIEW_STORE_NAME], 'readwrite');
        const store = transaction.objectStore(STORE_NAME);
        const blobStore = transaction.objectStore(FEATURE_IMAGE_STORE_NAME);
        const previewStore = transaction.objectStore(PREVIEW_STORE_NAME);
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
                    const previewStatus: PreviewStatus = preview.length > 0 ? 'has' : 'none';
                    next.previewStatus = previewStatus;
                    changes.preview = preview;
                    if (previewStatus === 'has') {
                        const previewReq = previewStore.put(preview, path);
                        previewReq.onerror = () => {
                            lastRequestErrorUpdate = previewReq.error || null;
                            console.error('[IndexedDB] put failed', {
                                store: PREVIEW_STORE_NAME,
                                op: opUpdate,
                                path,
                                name: previewReq.error?.name,
                                message: previewReq.error?.message
                            });
                        };
                    } else {
                        const deleteReq = previewStore.delete(path);
                        deleteReq.onerror = () => {
                            lastRequestErrorUpdate = deleteReq.error || null;
                            console.error('[IndexedDB] delete failed', {
                                store: PREVIEW_STORE_NAME,
                                op: opUpdate,
                                path,
                                name: deleteReq.error?.name,
                                message: deleteReq.error?.message
                            });
                        };
                    }
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
            const updatedRecord: FileData = updated;
            this.cache.updateFile(path, updatedRecord);
            if (preview !== undefined) {
                this.cache.updateFileContent(path, { previewText: preview, previewStatus: updatedRecord.previewStatus });
            }
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

        const transaction = this.db.transaction([STORE_NAME, FEATURE_IMAGE_STORE_NAME, PREVIEW_STORE_NAME], 'readwrite');
        const store = transaction.objectStore(STORE_NAME);
        const blobStore = transaction.objectStore(FEATURE_IMAGE_STORE_NAME);
        const previewStore = transaction.objectStore(PREVIEW_STORE_NAME);
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
                    const nextPreviewStatus = getDefaultPreviewStatusForPath(path);
                    if (file.previewStatus !== nextPreviewStatus) {
                        file.previewStatus = nextPreviewStatus;
                        changes.preview = null;
                    }
                    const deleteReq = previewStore.delete(path);
                    deleteReq.onerror = () => {
                        lastRequestError = deleteReq.error || null;
                        console.error('[IndexedDB] delete failed', {
                            store: PREVIEW_STORE_NAME,
                            op,
                            path,
                            name: deleteReq.error?.name,
                            message: deleteReq.error?.message
                        });
                    };
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

        const transaction = this.db.transaction([STORE_NAME, FEATURE_IMAGE_STORE_NAME, PREVIEW_STORE_NAME], 'readwrite');
        const store = transaction.objectStore(STORE_NAME);
        const blobStore = transaction.objectStore(FEATURE_IMAGE_STORE_NAME);
        const previewStore = transaction.objectStore(PREVIEW_STORE_NAME);
        const changeNotifications: FileContentChange[] = [];
        const cacheUpdates: { path: string; data: FileData }[] = [];
        const op = 'batchClearAllFileContent';
        let lastRequestError: DOMException | Error | null = null;

        return new Promise((resolve, reject) => {
            if (type === 'preview' || type === 'all') {
                const clearReq = previewStore.clear();
                clearReq.onerror = () => {
                    lastRequestError = clearReq.error || null;
                    console.error('[IndexedDB] clear failed', {
                        store: PREVIEW_STORE_NAME,
                        op,
                        name: clearReq.error?.name,
                        message: clearReq.error?.message
                    });
                };
            }
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

                    const path = cursor.key;
                    if (typeof path !== 'string') {
                        cursor.continue();
                        return;
                    }

                    if (type === 'preview' || type === 'all') {
                        const nextPreviewStatus = getDefaultPreviewStatusForPath(path);
                        if (updated.previewStatus !== nextPreviewStatus) {
                            updated.previewStatus = nextPreviewStatus;
                            changes.preview = null;
                            hasChanges = true;
                        }
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

        const transaction = this.db.transaction([STORE_NAME, FEATURE_IMAGE_STORE_NAME, PREVIEW_STORE_NAME], 'readwrite');
        const store = transaction.objectStore(STORE_NAME);
        const blobStore = transaction.objectStore(FEATURE_IMAGE_STORE_NAME);
        const previewStore = transaction.objectStore(PREVIEW_STORE_NAME);
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
                    if (type === 'preview' || type === 'all') {
                        const nextPreviewStatus = getDefaultPreviewStatusForPath(path);
                        if (file.previewStatus !== nextPreviewStatus) {
                            file.previewStatus = nextPreviewStatus;
                            changes.preview = null;
                            hasChanges = true;
                        }
                        const deleteReq = previewStore.delete(path);
                        deleteReq.onerror = () => {
                            lastRequestError = deleteReq.error || null;
                            console.error('[IndexedDB] delete failed', {
                                store: PREVIEW_STORE_NAME,
                                op,
                                path,
                                name: deleteReq.error?.name,
                                message: deleteReq.error?.message
                            });
                        };
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

        const needsPreviewStore = updates.some(update => update.preview !== undefined);
        const needsFeatureImageStore = updates.some(update => update.featureImageKey !== undefined || update.featureImage !== undefined);
        const storeNames: string[] = [STORE_NAME];
        if (needsFeatureImageStore) {
            storeNames.push(FEATURE_IMAGE_STORE_NAME);
        }
        if (needsPreviewStore) {
            storeNames.push(PREVIEW_STORE_NAME);
        }

        const transaction = this.db.transaction(storeNames, 'readwrite');
        const store = transaction.objectStore(STORE_NAME);
        const blobStore = needsFeatureImageStore ? transaction.objectStore(FEATURE_IMAGE_STORE_NAME) : null;
        const previewStore = needsPreviewStore ? transaction.objectStore(PREVIEW_STORE_NAME) : null;
        const filesToUpdate: { path: string; data: FileData }[] = [];
        const changeNotifications: FileContentChange[] = [];
        const featureImageCacheUpdates = new Set<string>();
        const previewTextUpdates: { path: string; previewText: string; previewStatus: PreviewStatus }[] = [];

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
                        const previewStatus: PreviewStatus = update.preview.length > 0 ? 'has' : 'none';
                        newData.previewStatus = previewStatus;
                        changes.preview = update.preview;
                        hasChanges = true;
                        if (previewStore && previewStatus === 'has') {
                            const previewReq = previewStore.put(update.preview, update.path);
                            previewReq.onerror = () => {
                                lastRequestError = previewReq.error || null;
                                console.error('[IndexedDB] put failed', {
                                    store: PREVIEW_STORE_NAME,
                                    op,
                                    path: update.path,
                                    name: previewReq.error?.name,
                                    message: previewReq.error?.message
                                });
                            };
                            previewTextUpdates.push({ path: update.path, previewText: update.preview, previewStatus });
                        } else if (previewStore) {
                            const deleteReq = previewStore.delete(update.path);
                            deleteReq.onerror = () => {
                                lastRequestError = deleteReq.error || null;
                                console.error('[IndexedDB] delete failed', {
                                    store: PREVIEW_STORE_NAME,
                                    op,
                                    path: update.path,
                                    name: deleteReq.error?.name,
                                    message: deleteReq.error?.message
                                });
                            };
                        }
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
                        if (blobStore && featureImageMutation.blobUpdate) {
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
                        } else if (blobStore && featureImageMutation.shouldDeleteBlob) {
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
            if (previewTextUpdates.length > 0) {
                previewTextUpdates.forEach(update => {
                    this.cache.updateFileContent(update.path, { previewText: update.previewText, previewStatus: update.previewStatus });
                });
            }
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
        if (!this.cache.isReady()) {
            return '';
        }
        return this.cache.getPreviewText(path);
    }

    /**
     * Loads preview text for a single file path into the in-memory cache.
     * Used by UI components that need preview text without hydrating the full preview store on startup.
     */
    async ensurePreviewTextLoaded(path: string): Promise<void> {
        if (this.isClosing) {
            return;
        }
        if (!this.cache.isReady()) {
            return;
        }

        const file = this.cache.getFile(path);
        if (!file || file.previewStatus !== 'has') {
            return;
        }

        if (this.cache.getPreviewText(path).length > 0) {
            return;
        }

        const existingPromise = this.previewLoadPromises.get(path);
        if (existingPromise) {
            return existingPromise;
        }

        const deferred: { resolve: () => void } = {
            resolve: () => void 0
        };

        const loadPromise = new Promise<void>(resolve => {
            deferred.resolve = resolve;
        }).finally(() => {
            this.previewLoadPromises.delete(path);
            this.previewLoadDeferred.delete(path);
        });

        this.previewLoadDeferred.set(path, deferred);
        this.previewLoadPromises.set(path, loadPromise);
        this.previewLoadQueue.add(path);
        this.schedulePreviewTextLoadFlush();
        return loadPromise;
    }

    private schedulePreviewTextLoadFlush(): void {
        if (this.isClosing) {
            return;
        }
        if (this.previewLoadFlushTimer !== null) {
            return;
        }

        this.previewLoadFlushTimer = globalThis.setTimeout(() => {
            this.previewLoadFlushTimer = null;
            void this.flushPreviewTextLoadQueue();
        }, 0);
    }

    private async repairPreviewStatusRecords(updates: { path: string; previewStatus: PreviewStatus }[]): Promise<void> {
        if (this.isClosing) {
            return;
        }
        if (updates.length === 0) {
            return;
        }
        await this.init();
        if (!this.db) {
            return;
        }

        const sessionId = this.previewLoadSessionId;
        if (this.isClosing || sessionId !== this.previewLoadSessionId) {
            return;
        }

        const db = this.db;
        const transaction = db.transaction([STORE_NAME], 'readwrite');
        const store = transaction.objectStore(STORE_NAME);

        await new Promise<void>((resolve, reject) => {
            const op = 'repairPreviewStatusRecords';
            let lastRequestError: DOMException | Error | null = null;

            updates.forEach(update => {
                const getReq = store.get(update.path);
                getReq.onsuccess = () => {
                    const recordValue: unknown = getReq.result;
                    if (!isPlainObjectRecordValue(recordValue)) {
                        return;
                    }

                    const record = recordValue;
                    if (record.previewStatus === update.previewStatus) {
                        return;
                    }

                    record.previewStatus = update.previewStatus;
                    const putReq = store.put(record, update.path);
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
                if (this.isClosing) {
                    resolve();
                    return;
                }
                console.error('[IndexedDB] transaction aborted', {
                    store: STORE_NAME,
                    op,
                    txError: transaction.error?.message,
                    reqError: lastRequestError?.message
                });
                this.rejectWithTransactionError(reject, transaction, lastRequestError, 'Transaction aborted');
            };
            transaction.onerror = () => {
                if (this.isClosing) {
                    resolve();
                    return;
                }
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

    private async flushPreviewTextLoadQueue(): Promise<void> {
        if (this.isPreviewLoadFlushRunning) {
            return;
        }

        this.isPreviewLoadFlushRunning = true;
        const sessionId = this.previewLoadSessionId;
        try {
            const queuedPaths = Array.from(this.previewLoadQueue);
            this.previewLoadQueue.clear();
            if (queuedPaths.length === 0) {
                return;
            }

            const pathsToProcess = queuedPaths.slice(0, IndexedDBStorage.PREVIEW_LOAD_MAX_BATCH);
            if (queuedPaths.length > IndexedDBStorage.PREVIEW_LOAD_MAX_BATCH) {
                for (const path of queuedPaths.slice(IndexedDBStorage.PREVIEW_LOAD_MAX_BATCH)) {
                    this.previewLoadQueue.add(path);
                }
            }

            if (this.isClosing || sessionId !== this.previewLoadSessionId) {
                for (const path of pathsToProcess) {
                    this.previewLoadDeferred.get(path)?.resolve();
                }
                return;
            }

            try {
                await this.init();
            } catch (error: unknown) {
                if (this.isClosing || sessionId !== this.previewLoadSessionId) {
                    for (const path of queuedPaths) {
                        this.previewLoadDeferred.get(path)?.resolve();
                    }
                    return;
                }
                const initError = error instanceof Error ? error : new Error('Failed to initialize database');
                console.error('[PreviewText] Failed to initialize database for preview load', initError);
                for (const path of queuedPaths) {
                    this.previewLoadDeferred.get(path)?.resolve();
                }
                return;
            }

            if (!this.db) {
                if (this.isClosing || sessionId !== this.previewLoadSessionId) {
                    for (const path of pathsToProcess) {
                        this.previewLoadDeferred.get(path)?.resolve();
                    }
                    return;
                }
                console.error('[PreviewText] Database not initialized for preview load');
                for (const path of pathsToProcess) {
                    this.previewLoadDeferred.get(path)?.resolve();
                }
                return;
            }

            const pathsToLoad: string[] = [];
            for (const path of pathsToProcess) {
                const deferred = this.previewLoadDeferred.get(path);
                if (!deferred) {
                    continue;
                }

                const file = this.cache.getFile(path);
                if (!file || file.previewStatus !== 'has') {
                    deferred.resolve();
                    continue;
                }

                if (this.cache.getPreviewText(path).length > 0) {
                    deferred.resolve();
                    continue;
                }

                pathsToLoad.push(path);
            }

            if (pathsToLoad.length === 0) {
                return;
            }

            const previewTexts = new Map<string, string | null>();
            const changes: FileContentChange[] = [];
            const previewStatusRepairs: { path: string; previewStatus: PreviewStatus }[] = [];

            const db = this.db;
            if (this.isClosing || sessionId !== this.previewLoadSessionId) {
                for (const path of pathsToLoad) {
                    this.previewLoadDeferred.get(path)?.resolve();
                }
                return;
            }

            const transaction = db.transaction([PREVIEW_STORE_NAME], 'readonly');
            const store = transaction.objectStore(PREVIEW_STORE_NAME);

            try {
                await new Promise<void>((resolve, reject) => {
                    const op = 'loadPreviewText:batch';
                    let lastRequestError: DOMException | Error | null = null;

                    for (const path of pathsToLoad) {
                        const getReq = store.get(path);
                        getReq.onsuccess = () => {
                            const previewText: unknown = getReq.result;
                            if (typeof previewText === 'string' && previewText.length > 0) {
                                previewTexts.set(path, previewText);
                            } else {
                                previewTexts.set(path, null);
                            }
                        };
                        getReq.onerror = () => {
                            lastRequestError = getReq.error || null;
                            if (!this.isClosing && sessionId === this.previewLoadSessionId) {
                                console.error('[IndexedDB] get failed', {
                                    store: PREVIEW_STORE_NAME,
                                    op,
                                    path,
                                    name: getReq.error?.name,
                                    message: getReq.error?.message
                                });
                            }
                            try {
                                transaction.abort();
                            } catch (e) {
                                void e;
                            }
                        };
                    }

                    transaction.oncomplete = () => resolve();
                    transaction.onabort = () => {
                        if (this.isClosing || sessionId !== this.previewLoadSessionId) {
                            resolve();
                            return;
                        }
                        console.error('[IndexedDB] transaction aborted', {
                            store: PREVIEW_STORE_NAME,
                            op,
                            txError: transaction.error?.message,
                            reqError: lastRequestError?.message
                        });
                        this.rejectWithTransactionError(reject, transaction, lastRequestError, 'Transaction aborted');
                    };
                    transaction.onerror = () => {
                        if (this.isClosing || sessionId !== this.previewLoadSessionId) {
                            resolve();
                            return;
                        }
                        console.error('[IndexedDB] transaction error', {
                            store: PREVIEW_STORE_NAME,
                            op,
                            txError: transaction.error?.message,
                            reqError: lastRequestError?.message
                        });
                        this.rejectWithTransactionError(reject, transaction, lastRequestError, 'Transaction error');
                    };
                });
            } catch (error: unknown) {
                const loadError = error instanceof Error ? error : new Error('Preview load failed');
                if (!this.isClosing && sessionId === this.previewLoadSessionId) {
                    console.error('[PreviewText] Failed to load previews', loadError);
                }
                for (const path of pathsToLoad) {
                    this.previewLoadDeferred.get(path)?.resolve();
                }
                return;
            }

            for (const path of pathsToLoad) {
                const previewText = previewTexts.get(path);
                if (typeof previewText === 'string' && previewText.length > 0) {
                    this.cache.updateFileContent(path, { previewText, previewStatus: 'has' });
                    changes.push({ path, changes: { preview: previewText }, changeType: 'content' });
                } else {
                    const file = this.cache.getFile(path);
                    if (file && file.previewStatus === 'has') {
                        const nextPreviewStatus = getDefaultPreviewStatusForPath(path);
                        this.cache.updateFileContent(path, { previewText: '', previewStatus: nextPreviewStatus });
                        previewStatusRepairs.push({ path, previewStatus: nextPreviewStatus });
                        changes.push({ path, changes: { preview: null }, changeType: 'content' });
                    }
                }
                this.previewLoadDeferred.get(path)?.resolve();
            }

            if (previewStatusRepairs.length > 0 && !this.isClosing && sessionId === this.previewLoadSessionId) {
                try {
                    await this.repairPreviewStatusRecords(previewStatusRepairs);
                } catch (error: unknown) {
                    if (!this.isClosing && sessionId === this.previewLoadSessionId) {
                        console.error('[PreviewText] Failed to persist preview status repairs', error);
                    }
                }
            }

            if (changes.length > 0) {
                this.emitChanges(changes);
            }
        } finally {
            this.isPreviewLoadFlushRunning = false;
            if (sessionId === this.previewLoadSessionId && !this.isClosing && this.previewLoadQueue.size > 0) {
                this.schedulePreviewTextLoadFlush();
            }
        }
    }

    async deletePreviewText(path: string): Promise<void> {
        await this.init();
        if (!this.db) throw new Error('Database not initialized');

        if (this.cache.isReady()) {
            this.cache.updateFileContent(path, { previewText: '' });
        }

        const transaction = this.db.transaction([PREVIEW_STORE_NAME], 'readwrite');
        const store = transaction.objectStore(PREVIEW_STORE_NAME);

        await new Promise<void>((resolve, reject) => {
            const op = 'deletePreviewText';
            let lastRequestError: DOMException | Error | null = null;

            const deleteReq = store.delete(path);
            deleteReq.onerror = () => {
                lastRequestError = deleteReq.error || null;
                console.error('[IndexedDB] delete failed', {
                    store: PREVIEW_STORE_NAME,
                    op,
                    path,
                    name: deleteReq.error?.name,
                    message: deleteReq.error?.message
                });
            };

            transaction.oncomplete = () => resolve();
            transaction.onabort = () => {
                console.error('[IndexedDB] transaction aborted', {
                    store: PREVIEW_STORE_NAME,
                    op,
                    txError: transaction.error?.message,
                    reqError: lastRequestError?.message
                });
                this.rejectWithTransactionError(reject, transaction, lastRequestError, 'Transaction aborted');
            };
            transaction.onerror = () => {
                console.error('[IndexedDB] transaction error', {
                    store: PREVIEW_STORE_NAME,
                    op,
                    txError: transaction.error?.message,
                    reqError: lastRequestError?.message
                });
                this.rejectWithTransactionError(reject, transaction, lastRequestError, 'Transaction error');
            };
        });
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
     * Stream all preview text records without hydrating them into the main in-memory cache.
     * Only yields non-empty strings with a string key.
     */
    async forEachPreviewTextRecord(callback: (path: string, previewText: string) => void): Promise<void> {
        await this.init();
        if (!this.db) {
            return;
        }

        const transaction = this.db.transaction([PREVIEW_STORE_NAME], 'readonly');
        const store = transaction.objectStore(PREVIEW_STORE_NAME);

        await new Promise<void>((resolve, reject) => {
            const op = 'forEachPreviewTextRecord';
            let lastRequestError: DOMException | Error | null = null;

            const request = store.openCursor();
            request.onsuccess = () => {
                const cursor = request.result;
                if (!cursor) {
                    return;
                }

                const path = cursor.key;
                const value: unknown = cursor.value;
                if (typeof path === 'string' && typeof value === 'string' && value.length > 0) {
                    callback(path, value);
                }

                cursor.continue();
            };
            request.onerror = () => {
                const requestError = request.error;
                lastRequestError = requestError || null;
                console.error('[IndexedDB] openCursor failed', {
                    store: PREVIEW_STORE_NAME,
                    op,
                    name: requestError?.name,
                    message: requestError?.message
                });
                reject(this.normalizeIdbError(requestError, 'Cursor request failed'));
            };

            transaction.oncomplete = () => resolve();
            transaction.onabort = () => {
                console.error('[IndexedDB] transaction aborted', {
                    store: PREVIEW_STORE_NAME,
                    op,
                    txError: transaction.error?.message,
                    reqError: lastRequestError?.message
                });
                this.rejectWithTransactionError(reject, transaction, lastRequestError, 'Transaction aborted');
            };
            transaction.onerror = () => {
                console.error('[IndexedDB] transaction error', {
                    store: PREVIEW_STORE_NAME,
                    op,
                    txError: transaction.error?.message,
                    reqError: lastRequestError?.message
                });
                this.rejectWithTransactionError(reject, transaction, lastRequestError, 'Transaction error');
            };
        });
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
     * Move preview text between paths.
     */
    async movePreviewText(oldPath: string, newPath: string): Promise<void> {
        if (oldPath === newPath) {
            return;
        }
        await this.init();
        if (!this.db) throw new Error('Database not initialized');

        const cachedPreviewText = this.cache.isReady() ? this.cache.getPreviewText(oldPath) : '';
        if (this.cache.isReady()) {
            this.cache.updateFileContent(oldPath, { previewText: '' });
            if (cachedPreviewText.length > 0) {
                this.cache.updateFileContent(newPath, { previewText: cachedPreviewText, previewStatus: 'has' });
            }
        }

        const transaction = this.db.transaction([PREVIEW_STORE_NAME], 'readwrite');
        const store = transaction.objectStore(PREVIEW_STORE_NAME);

        await new Promise<void>((resolve, reject) => {
            const op = 'movePreviewText';
            let lastRequestError: DOMException | Error | null = null;

            const getReq = store.get(oldPath);
            getReq.onsuccess = () => {
                const previewText: unknown = getReq.result;
                if (typeof previewText === 'string' && previewText.length > 0) {
                    const putReq = store.put(previewText, newPath);
                    putReq.onerror = () => {
                        lastRequestError = putReq.error || null;
                        console.error('[IndexedDB] put failed', {
                            store: PREVIEW_STORE_NAME,
                            op,
                            path: newPath,
                            name: putReq.error?.name,
                            message: putReq.error?.message
                        });
                    };
                }

                const deleteReq = store.delete(oldPath);
                deleteReq.onerror = () => {
                    lastRequestError = deleteReq.error || null;
                    console.error('[IndexedDB] delete failed', {
                        store: PREVIEW_STORE_NAME,
                        op,
                        path: oldPath,
                        name: deleteReq.error?.name,
                        message: deleteReq.error?.message
                    });
                };
            };
            getReq.onerror = () => {
                lastRequestError = getReq.error || null;
                console.error('[IndexedDB] get failed', {
                    store: PREVIEW_STORE_NAME,
                    op,
                    path: oldPath,
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
                    store: PREVIEW_STORE_NAME,
                    op,
                    txError: transaction.error?.message,
                    reqError: lastRequestError?.message
                });
                this.rejectWithTransactionError(reject, transaction, lastRequestError, 'Transaction aborted');
            };
            transaction.onerror = () => {
                console.error('[IndexedDB] transaction error', {
                    store: PREVIEW_STORE_NAME,
                    op,
                    txError: transaction.error?.message,
                    reqError: lastRequestError?.message
                });
                this.rejectWithTransactionError(reject, transaction, lastRequestError, 'Transaction error');
            };
        });
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
        this.isClosing = true;
        this.previewLoadSessionId += 1;
        if (this.db) {
            this.db.close();
            this.db = null;
        }
        this.initPromise = null;
        this.cache.clear();
        if (this.previewLoadFlushTimer !== null) {
            globalThis.clearTimeout(this.previewLoadFlushTimer);
            this.previewLoadFlushTimer = null;
        }
        this.previewLoadQueue.clear();
        this.previewLoadDeferred.forEach(deferred => deferred.resolve());
        this.previewLoadDeferred.clear();
        this.previewLoadPromises.clear();
        this.featureImageBlobs.clearMemoryCaches();
    }
}
