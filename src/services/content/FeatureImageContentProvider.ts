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

import {
    CachedMetadata,
    FrontMatterCache,
    normalizePath,
    Platform,
    RequestUrlParam,
    RequestUrlResponse,
    requestUrl,
    TFile
} from 'obsidian';
import { ContentType } from '../../interfaces/IContentProvider';
import { NotebookNavigatorSettings } from '../../settings';
import { FileData } from '../../storage/IndexedDBStorage';
import { getDBInstance } from '../../storage/fileOperations';
import { isExcalidrawFile } from '../../utils/fileNameUtils';
import { isImageExtension, isImageFile, isPdfFile } from '../../utils/fileTypeUtils';
import { BaseContentProvider } from './BaseContentProvider';
import { renderExcalidrawThumbnail } from './excalidraw/excalidrawThumbnail';
import { renderPdfCoverThumbnail } from './pdf/pdfCoverThumbnail';
import { detectImageMimeTypeFromBuffer, getImageDimensionsFromBuffer, normalizeImageMimeType } from './thumbnail/imageDimensions';
import { createOnceLogger, createRenderBudgetLimiter, createRenderLimiter } from './thumbnail/thumbnailRuntimeUtils';

const MAX_THUMBNAIL_WIDTH = 256;
const MAX_THUMBNAIL_HEIGHT = 144;
const THUMBNAIL_OUTPUT_MIME = 'image/webp';
// iOS Safari has issues with WebP encoding in some contexts, so use PNG as fallback
const IOS_THUMBNAIL_OUTPUT_MIME = 'image/png';
const THUMBNAIL_OUTPUT_QUALITY = 0.75;
// Per-request timeout for external image fetches.
// YouTube thumbnails try multiple candidates, so total time can exceed this value.
const EXTERNAL_REQUEST_TIMEOUT_MS = 10000;
// Maximum lifetime for an external request before releasing the concurrency slot.
// `requestUrl()` does not accept an AbortSignal, so timed-out requests can continue running in the background.
const EXTERNAL_REQUEST_MAX_LIFETIME_MS = 60000;
// Maximum number of timed-out external requests that may continue running while new requests proceed.
// This bounds oversubscription when releasing limiter slots on timeout.
const EXTERNAL_REQUEST_TIMEOUT_DEBT_MAX = Platform.isMobile ? 0 : 2;
// Maximum total pixels that can be decoded concurrently on mobile devices
const MOBILE_IMAGE_DECODE_BUDGET_PIXELS = 120_000_000;

const SUPPORTED_IMAGE_MIME_TYPES = new Set([
    'image/jpeg',
    'image/png',
    'image/gif',
    'image/webp',
    'image/svg+xml',
    'image/avif',
    'image/heic',
    'image/heif',
    'image/bmp'
]);

const MIME_TYPE_BY_EXTENSION: Record<string, string> = {
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    png: 'image/png',
    gif: 'image/gif',
    webp: 'image/webp',
    svg: 'image/svg+xml',
    avif: 'image/avif',
    heic: 'image/heic',
    heif: 'image/heif',
    bmp: 'image/bmp'
};

const wikiImagePattern = `!\\[\\[(?<wikiImage>[^\\]]+)\\]\\]`;
const mdImagePattern = `!\\[[^\\]]*\\]\\((?<mdImage>(?:https?:\\/\\/(?:[^)\\r\\n(]|\\([^()\\r\\n]*\\))+|[^)\\r\\n]+))\\)`;

const markdownImageRegex = new RegExp(mdImagePattern, 'i');
const createCombinedImageRegex = () => new RegExp([wikiImagePattern, mdImagePattern].join('|'), 'ig');

type FeatureImageReference = { kind: 'local'; file: TFile } | { kind: 'external'; url: string } | { kind: 'youtube'; videoId: string };

type ImageBuffer = { buffer: ArrayBuffer; mimeType: string };

type FrontmatterImageTarget = { kind: 'wiki' | 'md' | 'plain'; target: string };

type ThumbnailSourceKind = 'local' | 'external';

/**
 * Content provider for finding and storing feature images
 */
export class FeatureImageContentProvider extends BaseContentProvider {
    private readonly combinedImageRegex = createCombinedImageRegex();

    protected readonly PARALLEL_LIMIT: number = 10;

    private readonly externalRequestLimiter = createRenderLimiter(6);
    private readonly imageDecodeLimiter = createRenderBudgetLimiter(
        Platform.isMobile ? MOBILE_IMAGE_DECODE_BUDGET_PIXELS : Number.MAX_SAFE_INTEGER
    );
    private readonly thumbnailCanvasLimiter = createRenderLimiter(6);
    private thumbnailCanvasPool: (HTMLCanvasElement | OffscreenCanvas)[] = [];
    private readonly logOnce = createOnceLogger();
    private readonly inFlightDownloads = new Map<string, Promise<ImageBuffer | null>>();
    private externalRequestTimeoutDebt = 0;

    /**
     * Returns a response header value using a case-insensitive lookup.
     *
     * HTTP header names are case-insensitive, but `requestUrl()` returns headers as a plain object
     * whose keys are not guaranteed to be normalized. Observed on iOS: the response includes `Content-Type`
     * (capitalized) rather than `content-type` (lowercase), so a direct `headers['content-type']` lookup
     * can return `undefined`.
     */
    private getHeaderValue(headers: Record<string, string>, headerName: string): string | undefined {
        const direct = headers[headerName];
        if (direct !== undefined) {
            return direct;
        }

        const needle = headerName.toLowerCase();
        for (const [key, value] of Object.entries(headers)) {
            if (key.toLowerCase() === needle) {
                return value;
            }
        }

        return undefined;
    }

    getContentType(): ContentType {
        return 'featureImage';
    }

    getRelevantSettings(): (keyof NotebookNavigatorSettings)[] {
        return ['showFeatureImage', 'featureImageProperties', 'downloadExternalFeatureImages'];
    }

    shouldRegenerate(oldSettings: NotebookNavigatorSettings, newSettings: NotebookNavigatorSettings): boolean {
        // Clear if feature image is disabled
        if (!newSettings.showFeatureImage && oldSettings.showFeatureImage) {
            return true;
        }

        // Regenerate if feature image is enabled and settings changed
        if (newSettings.showFeatureImage) {
            return (
                oldSettings.showFeatureImage !== newSettings.showFeatureImage ||
                JSON.stringify(oldSettings.featureImageProperties) !== JSON.stringify(newSettings.featureImageProperties) ||
                oldSettings.downloadExternalFeatureImages !== newSettings.downloadExternalFeatureImages
            );
        }

        return false;
    }

    async clearContent(): Promise<void> {
        const db = getDBInstance();
        await db.batchClearAllFileContent('featureImage');
    }

    protected needsProcessing(fileData: FileData | null, file: TFile, settings: NotebookNavigatorSettings): boolean {
        if (!settings.showFeatureImage) {
            return false;
        }

        if (file.extension !== 'md') {
            if (isPdfFile(file)) {
                // PDFs can have generated thumbnails; changes need reprocessing.
                const expectedKey = this.getFeatureImageKey({ kind: 'local', file });
                return !fileData || fileData.featureImageKey === null || fileData.featureImageKey !== expectedKey;
            }

            // The featureImageKey is the durable "processed" marker even when no blob is stored.
            return !fileData || fileData.featureImageKey === null;
        }

        const fileModified = fileData !== null && fileData.mtime !== file.stat.mtime;
        // `null` indicates content has not been generated yet.
        // Missing blobs do not force regeneration; the key tracks the last processed reference.
        return !fileData || fileData.featureImageKey === null || fileModified;
    }

    protected async processFile(
        job: { file: TFile; path: string[] },
        fileData: FileData | null,
        settings: NotebookNavigatorSettings
    ): Promise<{
        path: string;
        tags?: string[] | null;
        preview?: string;
        featureImage?: Blob | null;
        featureImageKey?: string | null;
        metadata?: FileData['metadata'];
    } | null> {
        if (!settings.showFeatureImage) {
            return null;
        }

        if (job.file.extension !== 'md') {
            // Generate cover thumbnail for PDF files using the first page
            if (isPdfFile(job.file)) {
                const reference: FeatureImageReference = { kind: 'local', file: job.file };
                const featureImageKey = this.getFeatureImageKey(reference);

                if (fileData && fileData.featureImageKey === featureImageKey) {
                    return null;
                }

                const thumbnail = await this.createThumbnailBlob(reference, settings);
                if (!thumbnail) {
                    const empty = this.createEmptyBlob();
                    return {
                        path: job.file.path,
                        featureImage: empty,
                        featureImageKey
                    };
                }

                return {
                    path: job.file.path,
                    featureImage: thumbnail,
                    featureImageKey
                };
            }

            const nextKey = '';
            const nextImage = this.createEmptyBlob();
            // Empty blobs are used as a processed marker; storage drops them and keeps the key.
            // A new key (reference change) is required before another attempt is recorded.
            if (fileData && fileData.featureImageKey === nextKey) {
                return null;
            }
            return {
                path: job.file.path,
                featureImage: nextImage,
                featureImageKey: nextKey
            };
        }

        try {
            // Handle Excalidraw files separately using ExcalidrawAutomate plugin
            if (isExcalidrawFile(job.file)) {
                const featureImageKey = this.getExcalidrawFeatureImageKey(job.file);

                if (fileData && fileData.featureImageKey === featureImageKey) {
                    return null;
                }

                const thumbnail = await this.createExcalidrawThumbnail(job.file);
                if (!thumbnail) {
                    const empty = this.createEmptyBlob();
                    return {
                        path: job.file.path,
                        featureImage: empty,
                        featureImageKey
                    };
                }

                return {
                    path: job.file.path,
                    featureImage: thumbnail,
                    featureImageKey
                };
            }

            const metadata = this.app.metadataCache.getFileCache(job.file);
            const fileModified = fileData !== null && fileData.mtime !== job.file.stat.mtime;
            const reference = await this.findFeatureImageReference(job.file, metadata, settings);

            if (!reference) {
                const nextKey = '';
                const nextImage = this.createEmptyBlob();
                // Empty blobs are used as a processed marker; storage drops them and keeps the key.
                // A new key (reference change) is required before another attempt is recorded.
                if (fileData && fileData.featureImageKey === nextKey) {
                    // If the file changed but the selected reference did not, return a no-op update
                    // so the base provider can update the stored mtime and clear the mismatch.
                    return fileModified ? { path: job.file.path, featureImageKey: nextKey } : null;
                }
                return {
                    path: job.file.path,
                    featureImage: nextImage,
                    featureImageKey: nextKey
                };
            }

            const featureImageKey = this.getFeatureImageKey(reference);

            // The key represents the selected source and is the durable "processed" marker.
            if (fileData && fileData.featureImageKey === featureImageKey) {
                if (!fileModified) {
                    return null;
                }
                // File contents changed but the extracted image reference did not.
                // When a thumbnail already exists, keep it and only acknowledge the mtime mismatch.
                // When no thumbnail exists, retry to handle transient download/decoding failures.
                if (fileData.featureImageStatus === 'has') {
                    return { path: job.file.path, featureImageKey };
                }
            }

            const thumbnail = await this.createThumbnailBlob(reference, settings);
            if (!thumbnail) {
                const empty = this.createEmptyBlob();
                // Store an empty blob with the current key to mark the reference as processed.
                // Storage drops empty blobs, so the key is the durable marker for this state.
                // A new key is required before another thumbnail attempt is recorded.
                return {
                    path: job.file.path,
                    featureImage: empty,
                    featureImageKey
                };
            }

            return {
                path: job.file.path,
                featureImage: thumbnail,
                featureImageKey
            };
        } catch (error) {
            console.error(`Error finding feature image for ${job.file.path}:`, error);
            return null;
        }
    }

    private createEmptyBlob(): Blob {
        return new Blob([]);
    }

    // Creates a cache key for Excalidraw files based on path and modification time
    private getExcalidrawFeatureImageKey(file: TFile): string {
        return `x:${file.path}@${file.stat.mtime}`;
    }

    // Renders an Excalidraw file to a resized thumbnail blob
    private async createExcalidrawThumbnail(file: TFile): Promise<Blob | null> {
        const pngBlob = await renderExcalidrawThumbnail(this.app, file, { scale: 1, padding: 0 });
        if (!pngBlob) {
            return null;
        }

        try {
            const mimeType = pngBlob.type || 'image/png';
            const buffer = await pngBlob.arrayBuffer();
            const thumbnail = await this.createThumbnailBlobFromBuffer(buffer, mimeType, file.path, 'local');
            return thumbnail ?? pngBlob;
        } catch {
            return pngBlob;
        }
    }

    protected getFeatureImageKey(reference: FeatureImageReference): string {
        if (reference.kind === 'local') {
            // Local references include the source mtime so edits to the image invalidate the key.
            return `f:${reference.file.path}@${reference.file.stat.mtime}`;
        }

        if (reference.kind === 'external') {
            // External references use a normalized https URL as the key.
            return `e:${reference.url}`;
        }

        // YouTube references use the video ID so all thumbnail URLs for a video map to one key.
        return `y:${reference.videoId}`;
    }

    private normalizeExternalUrl(url: string): string {
        try {
            const parsed = new URL(url);
            parsed.hash = '';
            return parsed.toString();
        } catch {
            return url;
        }
    }

    // Creates an external or YouTube image reference from a URL if external downloads are enabled
    private createExternalReference(url: string, settings: NotebookNavigatorSettings): FeatureImageReference | null {
        if (!settings.downloadExternalFeatureImages) {
            return null;
        }

        const normalized = this.normalizeExternalUrl(url.trim());
        const videoId = this.getVideoId(normalized);
        if (videoId) {
            return { kind: 'youtube', videoId };
        }
        return { kind: 'external', url: normalized };
    }

    private async findFeatureImageReference(
        file: TFile,
        metadata: CachedMetadata | null,
        settings: NotebookNavigatorSettings
    ): Promise<FeatureImageReference | null> {
        const fromFrontmatter = this.getFrontmatterImageReference(file, metadata, settings);
        if (fromFrontmatter) {
            return fromFrontmatter;
        }

        const content = await this.readFileContent(file);
        return this.getDocumentImageReference(content, file, settings);
    }

    protected getFrontmatterImageReference(
        file: TFile,
        metadata: CachedMetadata | null,
        settings: NotebookNavigatorSettings
    ): FeatureImageReference | null {
        const frontmatter = metadata?.frontmatter;
        if (!frontmatter) {
            return null;
        }

        for (const property of settings.featureImageProperties) {
            const candidates = this.extractFrontmatterStringValues(frontmatter[property]);

            for (const candidate of candidates) {
                const extracted = this.extractFrontmatterImageTarget(candidate);
                if (!extracted) {
                    continue;
                }

                const normalized = this.normalizeFrontmatterImageTarget(extracted);
                if (!normalized) {
                    continue;
                }

                if (this.isHttpUrl(normalized)) {
                    continue;
                }

                if (this.isValidHttpsUrl(normalized)) {
                    const external = this.createExternalReference(normalized, settings);
                    if (external) {
                        return external;
                    }
                    continue;
                }

                const resolved = this.resolveLocalFeatureFile(normalized, file);
                if (resolved) {
                    return { kind: 'local', file: resolved };
                }
            }
        }

        return null;
    }

    protected getDocumentImageReference(
        content: string,
        contextFile: TFile,
        settings: NotebookNavigatorSettings
    ): FeatureImageReference | null {
        const contentWithoutFrontmatter = this.stripLeadingFrontmatter(content);
        this.combinedImageRegex.lastIndex = 0;
        let match: RegExpExecArray | null = null;

        while ((match = this.combinedImageRegex.exec(contentWithoutFrontmatter)) !== null) {
            const reference = this.resolveDocumentImageMatch(match, contextFile, settings);
            if (reference) {
                return reference;
            }
        }

        return null;
    }

    private resolveDocumentImageMatch(
        match: RegExpExecArray,
        contextFile: TFile,
        settings: NotebookNavigatorSettings
    ): FeatureImageReference | null {
        const groups = match.groups;
        if (groups?.wikiImage) {
            const wikiTarget = this.safeDecodeLinkComponent(groups.wikiImage);
            const cleanedTarget = this.stripLinkMetadata(wikiTarget);
            if (!cleanedTarget) {
                return null;
            }
            if (this.hasUnsupportedEmbedExtension(cleanedTarget)) {
                return null;
            }
            const resolvedWikiImage = this.resolveLocalFeatureFile(cleanedTarget, contextFile);
            if (resolvedWikiImage) {
                return { kind: 'local', file: resolvedWikiImage };
            }
            return null;
        }

        if (groups?.mdImage) {
            return this.resolveMarkdownImageTarget(groups.mdImage, contextFile, settings);
        }

        return null;
    }

    private resolveMarkdownImageTarget(
        rawTarget: string,
        contextFile: TFile,
        settings: NotebookNavigatorSettings
    ): FeatureImageReference | null {
        const sanitizedMdImage = this.stripMarkdownImageTitle(rawTarget);
        const trimmedMdImage = sanitizedMdImage.trim();
        if (!trimmedMdImage) {
            return null;
        }

        if (this.isHttpUrl(trimmedMdImage)) {
            return null;
        }

        if (this.isValidHttpsUrl(trimmedMdImage)) {
            return this.createExternalReference(trimmedMdImage, settings);
        }

        const decodedLocalTarget = this.safeDecodeLinkComponent(trimmedMdImage);
        const localTarget = this.stripLinkMetadata(decodedLocalTarget);
        if (!localTarget) {
            return null;
        }
        if (this.hasUnsupportedEmbedExtension(localTarget)) {
            return null;
        }

        const resolvedMdImage = this.resolveLocalFeatureFile(localTarget, contextFile);
        if (resolvedMdImage) {
            return { kind: 'local', file: resolvedMdImage };
        }

        return null;
    }

    private stripLeadingFrontmatter(content: string): string {
        if (!content.startsWith('---')) {
            return content;
        }

        const firstNewline = content.indexOf('\n');
        if (firstNewline === -1) {
            return content;
        }

        const firstLine = content.slice(0, firstNewline).replace(/\r$/, '').trim();
        if (firstLine !== '---') {
            return content;
        }

        let cursor = firstNewline + 1;
        while (cursor < content.length) {
            const nextNewline = content.indexOf('\n', cursor);
            const lineEnd = nextNewline === -1 ? content.length : nextNewline;
            const line = content.slice(cursor, lineEnd).replace(/\r$/, '').trim();
            if (line === '---') {
                return nextNewline === -1 ? '' : content.slice(nextNewline + 1);
            }

            cursor = nextNewline === -1 ? content.length : nextNewline + 1;
        }

        return content;
    }

    // Checks if a link target has a file extension that cannot produce a feature image
    private hasUnsupportedEmbedExtension(target: string): boolean {
        const withoutSuffix = target.split(/[?#]/, 1)[0];
        const lastDot = withoutSuffix.lastIndexOf('.');
        if (lastDot === -1 || lastDot === withoutSuffix.length - 1) {
            return false;
        }

        const extension = withoutSuffix.slice(lastDot + 1);
        return extension.length > 0 && !isImageExtension(extension) && extension.toLowerCase() !== 'pdf';
    }

    private async createThumbnailBlob(reference: FeatureImageReference, settings: NotebookNavigatorSettings): Promise<Blob | null> {
        if (reference.kind === 'local') {
            if (isPdfFile(reference.file)) {
                return await renderPdfCoverThumbnail(this.app, reference.file, {
                    maxWidth: MAX_THUMBNAIL_WIDTH,
                    maxHeight: MAX_THUMBNAIL_HEIGHT,
                    mimeType: Platform.isIosApp ? IOS_THUMBNAIL_OUTPUT_MIME : THUMBNAIL_OUTPUT_MIME,
                    quality: THUMBNAIL_OUTPUT_QUALITY
                });
            }

            const imageData = await this.readLocalImage(reference.file);
            if (!imageData) {
                return null;
            }

            return await this.createThumbnailBlobFromBuffer(imageData.buffer, imageData.mimeType, reference.file.path, 'local');
        }

        if (reference.kind === 'external') {
            if (!settings.downloadExternalFeatureImages) {
                return null;
            }
            const imageData = await this.downloadExternalImage(reference.url);
            if (!imageData) {
                return null;
            }
            return await this.createThumbnailBlobFromBuffer(imageData.buffer, imageData.mimeType, reference.url, 'external');
        }

        if (!settings.downloadExternalFeatureImages) {
            return null;
        }
        const imageData = await this.downloadYoutubeThumbnail(reference.videoId);
        if (!imageData) {
            return null;
        }
        return await this.createThumbnailBlobFromBuffer(imageData.buffer, imageData.mimeType, `youtube:${reference.videoId}`, 'external');
    }

    private async readLocalImage(file: TFile): Promise<ImageBuffer | null> {
        const mimeType = this.getMimeTypeFromExtension(file.extension);
        if (!mimeType) {
            return null;
        }

        try {
            const buffer = await this.app.vault.adapter.readBinary(file.path);
            return { buffer, mimeType };
        } catch (error) {
            console.error(`Failed to read image ${file.path}:`, error);
            return null;
        }
    }

    /**
     * Fetches a URL with a timeout and concurrency limit to prevent overwhelming the network.
     */
    private async requestUrlWithTimeout(request: RequestUrlParam, timeoutMs: number): Promise<RequestUrlResponse | null> {
        // Acquire limiter slot to control concurrent external requests
        const releaseLimiter = await this.externalRequestLimiter.acquire();
        let limiterReleased = false;
        let hardReleaseId: ReturnType<typeof globalThis.setTimeout> | null = null;
        let timeoutDebtAdded = false;
        let timeoutDebtTimerId: ReturnType<typeof globalThis.setTimeout> | null = null;

        const safeReleaseLimiter = () => {
            if (limiterReleased) {
                return;
            }
            limiterReleased = true;
            if (hardReleaseId !== null) {
                globalThis.clearTimeout(hardReleaseId);
                hardReleaseId = null;
            }
            releaseLimiter();
        };

        const safeReleaseTimeoutDebt = () => {
            if (!timeoutDebtAdded) {
                return;
            }
            timeoutDebtAdded = false;
            if (timeoutDebtTimerId !== null) {
                globalThis.clearTimeout(timeoutDebtTimerId);
                timeoutDebtTimerId = null;
            }
            this.externalRequestTimeoutDebt = Math.max(0, this.externalRequestTimeoutDebt - 1);
        };

        const tryAddTimeoutDebt = (): boolean => {
            if (timeoutDebtAdded) {
                return true;
            }

            if (this.externalRequestTimeoutDebt >= EXTERNAL_REQUEST_TIMEOUT_DEBT_MAX) {
                return false;
            }

            this.externalRequestTimeoutDebt += 1;
            timeoutDebtAdded = true;
            timeoutDebtTimerId = globalThis.setTimeout(() => safeReleaseTimeoutDebt(), EXTERNAL_REQUEST_MAX_LIFETIME_MS);
            return true;
        };

        hardReleaseId = globalThis.setTimeout(() => safeReleaseLimiter(), EXTERNAL_REQUEST_MAX_LIFETIME_MS);

        let timeoutId: ReturnType<typeof globalThis.setTimeout> | null = null;
        const timeoutPromise = new Promise<null>(resolve => {
            timeoutId = globalThis.setTimeout(() => {
                // When a request times out, optionally free the limiter slot so other requests can proceed.
                // This can oversubscribe real in-flight requests since `requestUrl()` cannot be aborted, so it is bounded
                // by EXTERNAL_REQUEST_TIMEOUT_DEBT_MAX. When the debt budget is exhausted, we keep the limiter slot until
                // the request settles or the hard release timer fires.
                if (tryAddTimeoutDebt()) {
                    safeReleaseLimiter();
                }
                resolve(null);
            }, timeoutMs);
        });

        try {
            // `requestUrl` does not accept an AbortSignal, so we use Promise.race with a timer and ignore late results.
            const rawPromise = requestUrl(request);
            const requestPromise = rawPromise
                .then(response => response)
                .catch(() => null)
                .finally(() => {
                    safeReleaseLimiter();
                    safeReleaseTimeoutDebt();
                });

            const responseOrNull = await Promise.race([requestPromise, timeoutPromise]);
            return responseOrNull ?? null;
        } catch {
            safeReleaseLimiter();
            safeReleaseTimeoutDebt();
            return null;
        } finally {
            if (timeoutId !== null) {
                globalThis.clearTimeout(timeoutId);
            }
        }
    }

    private async downloadExternalImage(imageUrl: string): Promise<ImageBuffer | null> {
        const trimmedUrl = imageUrl.trim();
        if (!this.isValidHttpsUrl(trimmedUrl)) {
            return null;
        }

        return await this.getOrCreateDownload(`ext:${trimmedUrl}`, async () => {
            try {
                const response = await this.requestUrlWithTimeout(
                    {
                        url: trimmedUrl,
                        method: 'GET',
                        throw: false
                    },
                    EXTERNAL_REQUEST_TIMEOUT_MS
                );

                if (!response || response.status !== 200) {
                    return null;
                }

                // Determine the image type from the response headers.
                // iOS can return `Content-Type` instead of `content-type`, so use a case-insensitive lookup.
                const contentTypeHeader = this.getHeaderValue(response.headers, 'content-type');
                if (!contentTypeHeader) {
                    this.logOnce(
                        `featureImage-external-missing-content-type:${trimmedUrl}`,
                        `[${trimmedUrl}] Skipping external image - missing Content-Type header`
                    );
                    return null;
                }

                const mimeType = this.getMimeTypeFromContentType(contentTypeHeader);
                if (!mimeType) {
                    this.logOnce(
                        `featureImage-external-unsupported-content-type:${contentTypeHeader}:${trimmedUrl}`,
                        `[${trimmedUrl}] Skipping external image - unsupported Content-Type: ${contentTypeHeader}`
                    );
                    return null;
                }

                if (!response.arrayBuffer) {
                    this.logOnce(
                        `featureImage-external-missing-arrayBuffer:${mimeType}:${trimmedUrl}`,
                        `[${trimmedUrl}] Skipping external image - response missing arrayBuffer for ${mimeType}`
                    );
                    return null;
                }

                return { buffer: response.arrayBuffer, mimeType };
            } catch {
                return null;
            }
        });
    }

    private async downloadYoutubeThumbnail(videoId: string): Promise<ImageBuffer | null> {
        const candidates: { quality: string; mimeType: string }[] = [
            { quality: 'maxresdefault.jpg', mimeType: 'image/jpeg' },
            { quality: 'hqdefault.jpg', mimeType: 'image/jpeg' }
        ];

        for (const candidate of candidates) {
            const url = this.getYoutubeThumbnailUrl(videoId, candidate.quality);
            if (!this.isValidHttpsUrl(url)) {
                continue;
            }

            const result = await this.getOrCreateDownload(`yt:${url}|${candidate.mimeType}`, async () => {
                try {
                    const response = await this.requestUrlWithTimeout(
                        {
                            url,
                            method: 'GET',
                            headers: { Accept: candidate.mimeType },
                            throw: false
                        },
                        EXTERNAL_REQUEST_TIMEOUT_MS
                    );

                    if (response && response.status === 200 && response.arrayBuffer) {
                        return { buffer: response.arrayBuffer, mimeType: candidate.mimeType };
                    }
                    return null;
                } catch {
                    return null;
                }
            });

            if (result) {
                return result;
            }
        }

        return null;
    }

    // Deduplicates concurrent download requests by returning an existing promise for the same key
    private async getOrCreateDownload(key: string, request: () => Promise<ImageBuffer | null>): Promise<ImageBuffer | null> {
        const existing = this.inFlightDownloads.get(key);
        if (existing) {
            return existing;
        }

        const promise = request().finally(() => {
            this.inFlightDownloads.delete(key);
        });

        this.inFlightDownloads.set(key, promise);
        return promise;
    }

    // Resizes an image buffer to thumbnail dimensions with platform-aware pixel limits
    private async createThumbnailBlobFromBuffer(
        buffer: ArrayBuffer,
        mimeType: string,
        source: string,
        sourceKind: ThumbnailSourceKind
    ): Promise<Blob | null> {
        const normalizedMimeType = normalizeImageMimeType(mimeType);
        const detectedMimeType = detectImageMimeTypeFromBuffer(buffer);
        const effectiveMimeType =
            detectedMimeType && SUPPORTED_IMAGE_MIME_TYPES.has(detectedMimeType) ? detectedMimeType : normalizedMimeType;

        if (
            sourceKind === 'local' &&
            detectedMimeType &&
            detectedMimeType !== normalizedMimeType &&
            SUPPORTED_IMAGE_MIME_TYPES.has(detectedMimeType)
        ) {
            this.logOnce(
                `featureImage-mime-mismatch:${normalizedMimeType}:${detectedMimeType}:${source}`,
                `[${source}] Detected ${detectedMimeType} content for declared ${normalizedMimeType}`
            );
        }

        if (effectiveMimeType === 'image/svg+xml') {
            // Keep SVG data as-is without raster encoding.
            return new Blob([buffer], { type: effectiveMimeType });
        }

        // Extract dimensions from the image header to determine if resizing is needed.
        // Skip images with unknown dimensions to avoid memory issues during decoding.
        const dimensions = getImageDimensionsFromBuffer(buffer, effectiveMimeType);
        if (!dimensions) {
            this.logOnce(
                `featureImage-unknown-dimensions:${effectiveMimeType}:${source}`,
                `[${source}] Skipping ${effectiveMimeType} (${buffer.byteLength} bytes) - unable to determine image dimensions`
            );
            return null;
        }

        // Reject images exceeding platform-specific pixel limits to prevent out-of-memory crashes.
        const pixelCount = dimensions.width * dimensions.height;
        const maxPixels = Platform.isMobile ? 80_000_000 : 200_000_000;
        if (pixelCount > maxPixels) {
            this.logOnce(
                `featureImage-too-large:${effectiveMimeType}:${dimensions.width}x${dimensions.height}:${source}`,
                `[${source}] Skipping ${effectiveMimeType} (${dimensions.width}x${dimensions.height}) - image too large`
            );
            return null;
        }

        const { width: targetWidth, height: targetHeight } = this.calculateThumbnailDimensions(dimensions.width, dimensions.height);
        if (targetWidth === dimensions.width && targetHeight === dimensions.height) {
            // Skip decoding when the image is already within thumbnail limits.
            return new Blob([buffer], { type: effectiveMimeType });
        }

        const releaseDecodeBudget = await this.imageDecodeLimiter.acquire(pixelCount);

        try {
            const sourceBlob = new Blob([buffer], { type: effectiveMimeType });

            // Attempt direct bitmap resize which is more memory-efficient for large images.
            const resizedBitmapResult = await this.tryCreateThumbnailFromResizedBitmap(sourceBlob, targetWidth, targetHeight);
            if (resizedBitmapResult) {
                return resizedBitmapResult;
            }

            // Fallback decoding loads the full image into memory, so apply stricter limits.
            const maxFallbackPixels = Platform.isMobile ? 16_000_000 : 80_000_000;
            if (pixelCount > maxFallbackPixels) {
                this.logOnce(
                    `featureImage-fallback-skip:${effectiveMimeType}:${dimensions.width}x${dimensions.height}:${source}`,
                    `[${source}] Skipping ${effectiveMimeType} (${dimensions.width}x${dimensions.height}) - thumbnail decode fallback disabled for large images`
                );
                return null;
            }

            const bitmapResult = await this.tryCreateThumbnailFromBitmap(sourceBlob);
            if (bitmapResult) {
                return bitmapResult;
            }

            return await this.withImageFromBlob(sourceBlob, async image => {
                const sourceWidth = image.naturalWidth || image.width || 0;
                const sourceHeight = image.naturalHeight || image.height || 0;

                if (sourceWidth <= 0 || sourceHeight <= 0) {
                    return null;
                }

                const { width, height } = this.calculateThumbnailDimensions(sourceWidth, sourceHeight);
                if (width === sourceWidth && height === sourceHeight) {
                    // Skip re-encoding when the image is already within thumbnail limits.
                    return sourceBlob;
                }
                return await this.resizeImageToBlob(image, width, height);
            });
        } finally {
            releaseDecodeBudget();
        }
    }

    // Decodes and resizes an image in a single step using createImageBitmap resize options.
    // This approach avoids loading the full-resolution image into memory.
    private async tryCreateThumbnailFromResizedBitmap(blob: Blob, targetWidth: number, targetHeight: number): Promise<Blob | null> {
        if (typeof createImageBitmap === 'undefined') {
            return null;
        }

        if (targetWidth <= 0 || targetHeight <= 0) {
            return null;
        }

        let bitmap: ImageBitmap | null = null;
        try {
            bitmap = await createImageBitmap(blob, {
                resizeWidth: targetWidth,
                resizeHeight: targetHeight,
                resizeQuality: 'high'
            });
        } catch {
            return null;
        }

        try {
            return await this.resizeSourceToBlob(bitmap, targetWidth, targetHeight);
        } finally {
            this.closeBitmap(bitmap);
        }
    }

    // Decodes a blob to an ImageBitmap and resizes it to thumbnail dimensions
    private async tryCreateThumbnailFromBitmap(blob: Blob): Promise<Blob | null> {
        if (typeof createImageBitmap === 'undefined') {
            return null;
        }

        let bitmap: ImageBitmap | null = null;
        try {
            bitmap = await createImageBitmap(blob);
        } catch {
            return null;
        }

        try {
            const sourceWidth = bitmap.width || 0;
            const sourceHeight = bitmap.height || 0;

            if (sourceWidth <= 0 || sourceHeight <= 0) {
                return null;
            }

            const { width, height } = this.calculateThumbnailDimensions(sourceWidth, sourceHeight);
            if (width === sourceWidth && height === sourceHeight) {
                // Skip re-encoding when the image is already within thumbnail limits.
                return blob;
            }

            return await this.resizeSourceToBlob(bitmap, width, height);
        } finally {
            this.closeBitmap(bitmap);
        }
    }

    // Releases the resources held by an ImageBitmap
    private closeBitmap(bitmap: ImageBitmap | null): void {
        if (!bitmap) {
            return;
        }

        try {
            bitmap.close();
        } catch {
            // ignore
        }
    }

    // Loads a blob as an HTMLImageElement and passes it to the handler for processing
    private async withImageFromBlob<T>(blob: Blob, handler: (image: HTMLImageElement) => Promise<T>): Promise<T> {
        const imageUrl = URL.createObjectURL(blob);

        try {
            // Decode the image via an object URL and pass it to the handler.
            const image = await this.loadImage(imageUrl);
            return await handler(image);
        } finally {
            // Always revoke the object URL after decoding.
            URL.revokeObjectURL(imageUrl);
        }
    }

    private async resizeImageToBlob(image: HTMLImageElement, width: number, height: number): Promise<Blob | null> {
        return await this.resizeSourceToBlob(image, width, height);
    }

    private async resizeSourceToBlob(source: CanvasImageSource, width: number, height: number): Promise<Blob | null> {
        if (width <= 0 || height <= 0) {
            return null;
        }

        const canvasResult = await this.acquireThumbnailCanvas(width, height);
        if (!canvasResult) {
            return null;
        }

        const { canvas, ctx, release } = canvasResult;

        try {
            ctx.clearRect(0, 0, width, height);
            if ('imageSmoothingQuality' in ctx) {
                ctx.imageSmoothingQuality = 'high';
            }
            ctx.drawImage(source, 0, 0, width, height);

            const outputMimeType = Platform.isIosApp ? IOS_THUMBNAIL_OUTPUT_MIME : THUMBNAIL_OUTPUT_MIME;

            // Encode to the primary thumbnail mime type; fall back to PNG when encoding fails.
            const primary =
                outputMimeType === 'image/png'
                    ? await this.canvasToBlob(canvas, outputMimeType)
                    : await this.canvasToBlob(canvas, outputMimeType, THUMBNAIL_OUTPUT_QUALITY);
            if (primary) {
                return primary;
            }

            if (outputMimeType !== 'image/png') {
                return this.canvasToBlob(canvas, 'image/png');
            }

            return null;
        } finally {
            release();
        }
    }

    private createCanvas(width: number, height: number): HTMLCanvasElement | OffscreenCanvas {
        if (typeof OffscreenCanvas !== 'undefined') {
            const canvas = new OffscreenCanvas(width, height);
            if (typeof canvas.convertToBlob === 'function') {
                return canvas;
            }
        }
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        return canvas;
    }

    private calculateThumbnailDimensions(srcWidth: number, srcHeight: number): { width: number; height: number } {
        let width = srcWidth;
        let height = srcHeight;

        // Constrain the thumbnail to the max dimensions while preserving aspect ratio.
        if (srcWidth > MAX_THUMBNAIL_WIDTH || srcHeight > MAX_THUMBNAIL_HEIGHT) {
            const aspectRatio = srcWidth / srcHeight;

            if (MAX_THUMBNAIL_WIDTH / MAX_THUMBNAIL_HEIGHT > aspectRatio) {
                height = MAX_THUMBNAIL_HEIGHT;
                width = Math.round(height * aspectRatio);
            } else {
                width = MAX_THUMBNAIL_WIDTH;
                height = Math.round(width / aspectRatio);
            }
        }

        return { width: Math.max(1, width), height: Math.max(1, height) };
    }

    private loadImage(url: string): Promise<HTMLImageElement> {
        return new Promise((resolve, reject) => {
            const img = new Image();
            img.onload = () => resolve(img);
            img.onerror = () => reject(new Error('Failed to load image'));
            img.src = url;
        });
    }

    /**
     * Acquires a canvas from the pool for thumbnail rendering with concurrency limiting.
     * Returns a canvas, context, and release function that must be called when done.
     */
    private async acquireThumbnailCanvas(
        width: number,
        height: number
    ): Promise<{
        canvas: HTMLCanvasElement | OffscreenCanvas;
        ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
        release: () => void;
    } | null> {
        const releaseLimiter = await this.thumbnailCanvasLimiter.acquire();
        let released = false;

        // Reuse pooled canvas or create new one if pool is empty
        const canvas = this.thumbnailCanvasPool.pop() ?? this.createCanvas(Math.max(1, width), Math.max(1, height));
        canvas.width = width;
        canvas.height = height;

        const ctx = canvas.getContext('2d');
        if (!ctx) {
            // Return canvas to pool and release limiter on context failure
            this.thumbnailCanvasPool.push(canvas);
            releaseLimiter();
            return null;
        }

        // Release function returns canvas to pool and frees limiter slot
        const release = () => {
            if (released) {
                return;
            }
            released = true;
            this.thumbnailCanvasPool.push(canvas);
            releaseLimiter();
        };

        return { canvas, ctx, release };
    }

    private isOffscreenCanvas(canvas: HTMLCanvasElement | OffscreenCanvas): canvas is OffscreenCanvas {
        return typeof OffscreenCanvas !== 'undefined' && canvas instanceof OffscreenCanvas;
    }

    private async canvasToBlob(canvas: HTMLCanvasElement | OffscreenCanvas, mimeType: string, quality?: number): Promise<Blob | null> {
        // Wrap canvas.toBlob in a promise-based API.
        if (this.isOffscreenCanvas(canvas)) {
            try {
                return await canvas.convertToBlob({ type: mimeType, quality });
            } catch {
                return null;
            }
        }

        return await new Promise<Blob | null>(resolve => {
            canvas.toBlob(resolve, mimeType, quality);
        });
    }

    private extractFrontmatterStringValues(value: FrontMatterCache[keyof FrontMatterCache]): string[] {
        if (typeof value === 'string') {
            return [value];
        }

        if (Array.isArray(value)) {
            return value.filter((item): item is string => typeof item === 'string');
        }

        return [];
    }

    private extractFrontmatterImageTarget(rawValue: string): FrontmatterImageTarget | null {
        const trimmedValue = rawValue.trim();
        if (!trimmedValue) {
            return null;
        }

        const wikiTarget = this.extractWikiLinkTarget(trimmedValue);
        if (wikiTarget) {
            return { kind: 'wiki', target: wikiTarget };
        }

        const mdMatch = markdownImageRegex.exec(trimmedValue);
        if (mdMatch?.groups?.mdImage) {
            return { kind: 'md', target: mdMatch.groups.mdImage };
        }

        return { kind: 'plain', target: trimmedValue };
    }

    // Normalizes a frontmatter image target by removing display text, query params, and fragments.
    // External URLs preserve query params but strip fragments; local paths strip both.
    private normalizeFrontmatterImageTarget(extracted: FrontmatterImageTarget): string {
        let path = extracted.target.split('|')[0].trim();

        if (extracted.kind === 'md') {
            path = this.stripMarkdownImageTitle(path).trim();
        }

        if (this.isValidHttpsUrl(path)) {
            return this.normalizeExternalUrl(path);
        }

        path = this.safeDecodeLinkComponent(path);
        return path.split(/[?#]/, 1)[0].trim();
    }

    // Resolves a link path to a local image or PDF file using metadata cache or direct vault lookup
    private resolveLocalFeatureFile(imagePath: string, contextFile: TFile): TFile | null {
        const trimmedPath = imagePath.trim();
        const resolvedFromCache = this.app.metadataCache.getFirstLinkpathDest(trimmedPath, contextFile.path);
        if (resolvedFromCache instanceof TFile && (isImageFile(resolvedFromCache) || isPdfFile(resolvedFromCache))) {
            return resolvedFromCache;
        }

        const normalizedPath = normalizePath(trimmedPath);
        const abstractFile = this.app.vault.getAbstractFileByPath(normalizedPath);
        if (abstractFile instanceof TFile && (isImageFile(abstractFile) || isPdfFile(abstractFile))) {
            return abstractFile;
        }

        return null;
    }

    private extractWikiLinkTarget(value: string): string | undefined {
        const wikiMatch = value.match(/!?\[\[(.*?)\]\]/);
        return wikiMatch ? wikiMatch[1] : undefined;
    }

    private stripLinkMetadata(value: string): string {
        return value.split('|')[0].split(/[?#]/, 1)[0].trim();
    }

    private stripMarkdownImageTitle(value: string): string {
        const trimmedValue = value.trim();
        if (!trimmedValue) {
            return trimmedValue;
        }

        const titlePattern = /\s+(?:"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|\((?:[^)\\]|\\.)*\))\s*$/;
        const match = titlePattern.exec(trimmedValue);
        if (!match) {
            return trimmedValue;
        }

        const candidate = trimmedValue.slice(0, match.index).trimEnd();
        return candidate || trimmedValue;
    }

    private safeDecodeLinkComponent(value: string): string {
        try {
            return decodeURIComponent(value);
        } catch {
            return value;
        }
    }

    private isHttpUrl(url: string): boolean {
        return url.trim().toLowerCase().startsWith('http://');
    }

    private isValidHttpsUrl(url: string): boolean {
        try {
            const parsedUrl = new URL(url);
            return parsedUrl.protocol === 'https:';
        } catch {
            return false;
        }
    }

    private getVideoId(url: string): string | null {
        try {
            const parsedUrl = new URL(url);
            const hostname = parsedUrl.hostname.toLowerCase();
            const pathname = parsedUrl.pathname;
            const searchParams = parsedUrl.searchParams;

            const normalizedHostname = hostname.replace('m.youtube.com', 'youtube.com');

            if (hostname.includes('youtu.be')) {
                return pathname.slice(1);
            }

            if (normalizedHostname.includes('youtube.com')) {
                if (pathname === '/watch') {
                    return searchParams.get('v');
                }

                if (pathname.startsWith('/embed/') || pathname.startsWith('/v/') || pathname.startsWith('/shorts/')) {
                    return pathname.split('/')[2];
                }

                if (pathname === '/playlist') {
                    return searchParams.get('v');
                }
            }
            return null;
        } catch {
            return null;
        }
    }

    private getYoutubeThumbnailUrl(videoId: string, quality: string): string {
        const isWebp = quality.endsWith('.webp');
        const baseUrl = isWebp ? 'https://i.ytimg.com/vi_webp' : 'https://img.youtube.com/vi';
        return `${baseUrl}/${videoId}/${quality}`;
    }

    private getMimeTypeFromExtension(extension: string): string | null {
        if (!extension) {
            return null;
        }
        const key = extension.toLowerCase();
        return MIME_TYPE_BY_EXTENSION[key] ?? null;
    }

    private getMimeTypeFromContentType(contentType: string | undefined): string | null {
        if (!contentType) {
            return null;
        }

        const rawMimeType = contentType.split(';')[0].trim();
        const mimeType = normalizeImageMimeType(rawMimeType);
        if (!SUPPORTED_IMAGE_MIME_TYPES.has(mimeType)) {
            return null;
        }

        return mimeType;
    }
}
