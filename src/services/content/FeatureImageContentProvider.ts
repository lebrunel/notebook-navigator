/*
 * Notebook Navigator - Plugin for Obsidian
 * Copyright (c) 2025-2026 Johan Sanneblad
 * All rights reserved.
 * SPDX-License-Identifier: LicenseRef-NotebookNavigator-1.1
 *
 * Licensed under the Notebook Navigator License Agreement, Version 1.1.
 * See the LICENSE file in the repository root.
 */

import { CachedMetadata, FrontMatterCache, normalizePath, RequestUrlParam, RequestUrlResponse, requestUrl, TFile } from 'obsidian';
import { ContentType } from '../../interfaces/IContentProvider';
import { NotebookNavigatorSettings } from '../../settings';
import { FileData } from '../../storage/IndexedDBStorage';
import { getDBInstance } from '../../storage/fileOperations';
import { isExcalidrawFile } from '../../utils/fileNameUtils';
import { isImageExtension, isImageFile, isPdfFile } from '../../utils/fileTypeUtils';
import { BaseContentProvider } from './BaseContentProvider';
import { renderExcalidrawThumbnail } from './excalidraw/excalidrawThumbnail';
import { renderPdfCoverThumbnail } from './pdf/pdfCoverThumbnail';

const MAX_THUMBNAIL_WIDTH = 256;
const MAX_THUMBNAIL_HEIGHT = 144;
const THUMBNAIL_OUTPUT_MIME = 'image/webp';
const THUMBNAIL_OUTPUT_QUALITY = 0.75;
// Per-request timeout for external image fetches.
// YouTube thumbnails try multiple candidates, so total time can exceed this value.
const EXTERNAL_REQUEST_TIMEOUT_MS = 10000;

const SUPPORTED_IMAGE_MIME_TYPES = new Set([
    'image/jpeg',
    'image/png',
    'image/gif',
    'image/webp',
    'image/svg+xml',
    'image/avif',
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
    bmp: 'image/bmp'
};

const wikiImagePattern = `!\\[\\[(?<wikiImage>[^\\]]+)\\]\\]`;
const mdImagePattern = `!\\[[^\\]]*\\]\\((?<mdImage>(?:https?:\\/\\/(?:[^)\\r\\n(]|\\([^()\\r\\n]*\\))+|[^)\\r\\n]+))\\)`;

const markdownImageRegex = new RegExp(mdImagePattern, 'i');
const createCombinedImageRegex = () => new RegExp([wikiImagePattern, mdImagePattern].join('|'), 'ig');

type FeatureImageReference = { kind: 'local'; file: TFile } | { kind: 'external'; url: string } | { kind: 'youtube'; videoId: string };

type ImageBuffer = { buffer: ArrayBuffer; mimeType: string };

type FrontmatterImageTarget = { kind: 'wiki' | 'md' | 'plain'; target: string };

/**
 * Content provider for finding and storing feature images
 */
export class FeatureImageContentProvider extends BaseContentProvider {
    private readonly combinedImageRegex = createCombinedImageRegex();

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
            const reference = await this.findFeatureImageReference(job.file, metadata, settings);

            if (!reference) {
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

            const featureImageKey = this.getFeatureImageKey(reference);

            // The key represents the selected source and is the durable "processed" marker.
            // Key matches skip regeneration even when no blob is stored; only key changes re-enable processing.
            if (fileData && fileData.featureImageKey === featureImageKey) {
                return null;
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
            const thumbnail = await this.createThumbnailBlobFromBuffer(buffer, mimeType);
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
            return `e:${this.normalizeExternalUrl(reference.url)}`;
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
                    if (!settings.downloadExternalFeatureImages) {
                        continue;
                    }
                    const videoId = this.getVideoId(normalized);
                    if (videoId) {
                        return { kind: 'youtube', videoId };
                    }
                    return { kind: 'external', url: normalized };
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
        const decodedMdImage = this.safeDecodeLinkComponent(rawTarget);
        const sanitizedMdImage = this.stripMarkdownImageTitle(decodedMdImage);
        const trimmedMdImage = sanitizedMdImage.trim();
        if (!trimmedMdImage) {
            return null;
        }

        if (this.isHttpUrl(trimmedMdImage)) {
            return null;
        }

        if (this.isValidHttpsUrl(trimmedMdImage)) {
            if (!settings.downloadExternalFeatureImages) {
                return null;
            }
            const videoId = this.getVideoId(trimmedMdImage);
            if (videoId) {
                return { kind: 'youtube', videoId };
            }
            return { kind: 'external', url: trimmedMdImage };
        }

        const localTarget = this.stripLinkMetadata(trimmedMdImage);
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
                    mimeType: THUMBNAIL_OUTPUT_MIME,
                    quality: THUMBNAIL_OUTPUT_QUALITY
                });
            }

            const imageData = await this.readLocalImage(reference.file);
            if (!imageData) {
                return null;
            }

            return await this.createThumbnailBlobFromBuffer(imageData.buffer, imageData.mimeType);
        }

        if (reference.kind === 'external') {
            if (!settings.downloadExternalFeatureImages) {
                return null;
            }
            const imageData = await this.downloadExternalImage(reference.url);
            if (!imageData) {
                return null;
            }
            return await this.createThumbnailBlobFromBuffer(imageData.buffer, imageData.mimeType);
        }

        if (!settings.downloadExternalFeatureImages) {
            return null;
        }
        const imageData = await this.downloadYoutubeThumbnail(reference.videoId);
        if (!imageData) {
            return null;
        }
        return await this.createThumbnailBlobFromBuffer(imageData.buffer, imageData.mimeType);
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

    private async requestUrlWithTimeout(request: RequestUrlParam, timeoutMs: number): Promise<RequestUrlResponse | null> {
        let timeoutId: ReturnType<typeof globalThis.setTimeout> | null = null;
        const requestPromise = requestUrl(request);
        const timeoutPromise = new Promise<null>(resolve => {
            timeoutId = globalThis.setTimeout(() => resolve(null), timeoutMs);
        });

        try {
            // `requestUrl` does not accept an AbortSignal, so we use Promise.race with a timer and ignore late results.
            const responseOrNull = await Promise.race([requestPromise.then(response => response).catch(() => null), timeoutPromise]);
            return responseOrNull ?? null;
        } finally {
            if (timeoutId !== null) {
                globalThis.clearTimeout(timeoutId);
            }
        }
    }

    private async downloadExternalImage(imageUrl: string): Promise<ImageBuffer | null> {
        if (!this.isValidHttpsUrl(imageUrl)) {
            return null;
        }

        try {
            const response = await this.requestUrlWithTimeout(
                {
                    url: imageUrl,
                    method: 'GET',
                    throw: false
                },
                EXTERNAL_REQUEST_TIMEOUT_MS
            );

            if (!response || response.status !== 200) {
                return null;
            }

            const mimeType = this.getMimeTypeFromContentType(response.headers['content-type']);
            if (!mimeType || !response.arrayBuffer) {
                return null;
            }

            return { buffer: response.arrayBuffer, mimeType };
        } catch {
            return null;
        }
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
            } catch {
                // Continue to next candidate
            }
        }

        return null;
    }

    private async createThumbnailBlobFromBuffer(buffer: ArrayBuffer, mimeType: string): Promise<Blob | null> {
        if (mimeType === 'image/svg+xml') {
            // Keep SVG data as-is without raster encoding.
            return new Blob([buffer], { type: mimeType });
        }

        const bitmapResult = await this.tryCreateThumbnailFromBitmap(buffer, mimeType);
        if (bitmapResult) {
            return bitmapResult;
        }

        return await this.withImageFromBuffer(buffer, mimeType, async image => {
            const sourceWidth = image.naturalWidth || image.width || 0;
            const sourceHeight = image.naturalHeight || image.height || 0;

            if (sourceWidth <= 0 || sourceHeight <= 0) {
                return null;
            }

            const { width, height } = this.calculateThumbnailDimensions(sourceWidth, sourceHeight);
            if (width === sourceWidth && height === sourceHeight) {
                // Skip re-encoding when the image is already within thumbnail limits.
                return new Blob([buffer], { type: mimeType });
            }
            return await this.resizeImageToBlob(image, width, height);
        });
    }

    private async tryCreateThumbnailFromBitmap(buffer: ArrayBuffer, mimeType: string): Promise<Blob | null> {
        if (typeof createImageBitmap === 'undefined') {
            return null;
        }

        const blob = new Blob([buffer], { type: mimeType });

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
            if (bitmap) {
                try {
                    bitmap.close();
                } catch {
                    // ignore
                }
            }
        }
    }

    private async withImageFromBuffer<T>(
        buffer: ArrayBuffer,
        mimeType: string,
        handler: (image: HTMLImageElement) => Promise<T>
    ): Promise<T> {
        const blob = new Blob([buffer], { type: mimeType });
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

        const canvas = this.createCanvas(width, height);
        const ctx = canvas.getContext('2d');

        if (!ctx) {
            return null;
        }

        ctx.clearRect(0, 0, width, height);
        if ('imageSmoothingQuality' in ctx) {
            ctx.imageSmoothingQuality = 'high';
        }
        ctx.drawImage(source, 0, 0, width, height);

        // Encode to WebP first; fall back to PNG when WebP encoding fails.
        const primary = await this.canvasToBlob(canvas, THUMBNAIL_OUTPUT_MIME, THUMBNAIL_OUTPUT_QUALITY);
        if (primary) {
            return primary;
        }

        return this.canvasToBlob(canvas, 'image/png');
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

        markdownImageRegex.lastIndex = 0;
        const mdMatch = markdownImageRegex.exec(trimmedValue);
        if (mdMatch?.groups?.mdImage) {
            return { kind: 'md', target: mdMatch.groups.mdImage };
        }

        return { kind: 'plain', target: trimmedValue };
    }

    private normalizeFrontmatterImageTarget(extracted: FrontmatterImageTarget): string {
        let path = this.stripLinkMetadata(extracted.target);
        path = this.safeDecodeLinkComponent(path);

        if (extracted.kind === 'md') {
            path = this.stripMarkdownImageTitle(path).trim();
        }

        return path;
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

        const mimeType = contentType.split(';')[0].trim().toLowerCase();
        if (!SUPPORTED_IMAGE_MIME_TYPES.has(mimeType)) {
            return null;
        }

        return mimeType;
    }
}
