/*
 * Notebook Navigator - Plugin for Obsidian
 * Copyright (c) 2025-2026 Johan Sanneblad
 * SPDX-License-Identifier: LicenseRef-NotebookNavigator
 *
 * Licensed under the Notebook Navigator License Agreement (see LICENSE).
 */

import { CachedMetadata, FrontMatterCache, normalizePath, RequestUrlParam, RequestUrlResponse, requestUrl, TFile } from 'obsidian';
import { ContentType } from '../../interfaces/IContentProvider';
import { NotebookNavigatorSettings } from '../../settings';
import { FileData } from '../../storage/IndexedDBStorage';
import { getDBInstance } from '../../storage/fileOperations';
import { isImageExtension, isImageFile } from '../../utils/fileTypeUtils';
import { BaseContentProvider } from './BaseContentProvider';

const MAX_THUMBNAIL_WIDTH = 256;
const MAX_THUMBNAIL_HEIGHT = 144;
const THUMBNAIL_OUTPUT_MIME = 'image/webp';
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
            return !fileData || fileData.featureImage === null || fileData.featureImageKey === null;
        }

        const fileModified = fileData !== null && fileData.mtime !== file.stat.mtime;
        // `null` indicates content has not been generated yet.
        // Non-null blobs include the empty-blob sentinel (`size === 0`) which means "resolved but no thumbnail".
        return !fileData || fileData.featureImage === null || fileData.featureImageKey === null || fileModified;
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
            const nextKey = '';
            const nextImage = this.createEmptyBlob();
            if (fileData && fileData.featureImageKey === nextKey && fileData.featureImage !== null && fileData.featureImage.size === 0) {
                return null;
            }
            return {
                path: job.file.path,
                featureImage: nextImage,
                featureImageKey: nextKey
            };
        }

        try {
            const metadata = this.app.metadataCache.getFileCache(job.file);
            const reference = await this.findFeatureImageReference(job.file, metadata, settings);

            if (!reference) {
                const nextKey = '';
                const nextImage = this.createEmptyBlob();
                if (
                    fileData &&
                    fileData.featureImageKey === nextKey &&
                    fileData.featureImage !== null &&
                    fileData.featureImage.size === 0
                ) {
                    return null;
                }
                return {
                    path: job.file.path,
                    featureImage: nextImage,
                    featureImageKey: nextKey
                };
            }

            const featureImageKey = this.getFeatureImageKey(reference);

            // The key represents the selected source. If it hasn't changed and we already have a resolved value
            // (including the empty-blob sentinel), skip regeneration.
            if (fileData && fileData.featureImageKey === featureImageKey && fileData.featureImage !== null) {
                return null;
            }

            const thumbnail = await this.createThumbnailBlob(reference, settings);
            if (!thumbnail) {
                const empty = this.createEmptyBlob();
                // Mark as resolved with an empty blob. This records that the reference was evaluated but no thumbnail
                // could be produced (invalid/unreachable URL, unsupported image type, or decode/resize failure).
                //
                // This prevents repeated download/thumbnail attempts for the same key on every scan. To retry, the
                // reference must change (e.g., remove the image link so key becomes `''`, then add it back).
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

                const resolved = this.resolveLocalImageFile(normalized, file);
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
            if (this.hasNonImageExtension(cleanedTarget)) {
                return null;
            }
            const resolvedWikiImage = this.resolveLocalImageFile(cleanedTarget, contextFile);
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
        if (this.hasNonImageExtension(localTarget)) {
            return null;
        }

        const resolvedMdImage = this.resolveLocalImageFile(localTarget, contextFile);
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

    private hasNonImageExtension(target: string): boolean {
        const withoutQuery = target.split('?')[0];
        const lastDot = withoutQuery.lastIndexOf('.');
        if (lastDot === -1 || lastDot === withoutQuery.length - 1) {
            return false;
        }

        const extension = withoutQuery.slice(lastDot + 1);
        return extension.length > 0 && !isImageExtension(extension);
    }

    private async createThumbnailBlob(reference: FeatureImageReference, settings: NotebookNavigatorSettings): Promise<Blob | null> {
        let imageData: ImageBuffer | null = null;

        if (reference.kind === 'local') {
            imageData = await this.readLocalImage(reference.file);
        } else if (reference.kind === 'external') {
            if (!settings.downloadExternalFeatureImages) {
                return null;
            }
            imageData = await this.downloadExternalImage(reference.url);
        } else {
            if (!settings.downloadExternalFeatureImages) {
                return null;
            }
            imageData = await this.downloadYoutubeThumbnail(reference.videoId);
        }

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
            { quality: 'maxresdefault.webp', mimeType: 'image/webp' },
            { quality: 'maxresdefault.jpg', mimeType: 'image/jpeg' },
            { quality: 'sddefault.jpg', mimeType: 'image/jpeg' },
            { quality: 'hqdefault.jpg', mimeType: 'image/jpeg' },
            { quality: 'mqdefault.jpg', mimeType: 'image/jpeg' },
            { quality: 'default.jpg', mimeType: 'image/jpeg' }
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
            } catch (error) {
                void error;
            }
        }

        return null;
    }

    private async createThumbnailBlobFromBuffer(buffer: ArrayBuffer, mimeType: string): Promise<Blob | null> {
        if (mimeType === 'image/svg+xml') {
            return new Blob([buffer], { type: mimeType });
        }

        return await this.withImageFromBuffer(buffer, mimeType, async image => {
            const sourceWidth = image.naturalWidth || image.width || 0;
            const sourceHeight = image.naturalHeight || image.height || 0;

            if (sourceWidth <= 0 || sourceHeight <= 0) {
                return null;
            }

            const { width, height, shouldResize } = this.calculateThumbnailDimensions(sourceWidth, sourceHeight);

            if (!shouldResize) {
                return new Blob([buffer], { type: mimeType });
            }

            return await this.resizeImageToBlob(image, width, height);
        });
    }

    private async withImageFromBuffer<T>(
        buffer: ArrayBuffer,
        mimeType: string,
        handler: (image: HTMLImageElement) => Promise<T>
    ): Promise<T> {
        const blob = new Blob([buffer], { type: mimeType });
        const imageUrl = URL.createObjectURL(blob);

        try {
            const image = await this.loadImage(imageUrl);
            return await handler(image);
        } finally {
            URL.revokeObjectURL(imageUrl);
        }
    }

    private async resizeImageToBlob(image: HTMLImageElement, width: number, height: number): Promise<Blob | null> {
        const canvas = document.createElement('canvas');
        const ctx = canvas.getContext('2d');

        if (!ctx) {
            return null;
        }

        canvas.width = width;
        canvas.height = height;
        ctx.clearRect(0, 0, width, height);
        ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(image, 0, 0, width, height);

        const primary = await this.canvasToBlob(canvas, THUMBNAIL_OUTPUT_MIME);
        if (primary) {
            return primary;
        }

        return this.canvasToBlob(canvas, 'image/png');
    }

    private calculateThumbnailDimensions(srcWidth: number, srcHeight: number): { width: number; height: number; shouldResize: boolean } {
        let width = srcWidth;
        let height = srcHeight;
        let shouldResize = false;

        if (srcWidth > MAX_THUMBNAIL_WIDTH || srcHeight > MAX_THUMBNAIL_HEIGHT) {
            const aspectRatio = srcWidth / srcHeight;

            if (MAX_THUMBNAIL_WIDTH / MAX_THUMBNAIL_HEIGHT > aspectRatio) {
                height = MAX_THUMBNAIL_HEIGHT;
                width = Math.round(height * aspectRatio);
            } else {
                width = MAX_THUMBNAIL_WIDTH;
                height = Math.round(width / aspectRatio);
            }

            shouldResize = true;
        }

        return { width, height, shouldResize };
    }

    private loadImage(url: string): Promise<HTMLImageElement> {
        return new Promise((resolve, reject) => {
            const img = new Image();
            img.onload = () => resolve(img);
            img.onerror = () => reject(new Error('Failed to load image'));
            img.src = url;
        });
    }

    private async canvasToBlob(canvas: HTMLCanvasElement, mimeType: string): Promise<Blob | null> {
        return await new Promise<Blob | null>(resolve => {
            canvas.toBlob(resolve, mimeType);
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

    private resolveLocalImageFile(imagePath: string, contextFile: TFile): TFile | null {
        const trimmedPath = imagePath.trim();
        const resolvedFromCache = this.app.metadataCache.getFirstLinkpathDest(trimmedPath, contextFile.path);
        if (resolvedFromCache instanceof TFile && isImageFile(resolvedFromCache)) {
            return resolvedFromCache;
        }

        const normalizedPath = normalizePath(trimmedPath);
        const abstractFile = this.app.vault.getAbstractFileByPath(normalizedPath);
        if (abstractFile instanceof TFile && isImageFile(abstractFile)) {
            return abstractFile;
        }

        return null;
    }

    private extractWikiLinkTarget(value: string): string | undefined {
        const wikiMatch = value.match(/!?\[\[(.*?)\]\]/);
        return wikiMatch ? wikiMatch[1] : undefined;
    }

    private stripLinkMetadata(value: string): string {
        return value.split('|')[0].split('#')[0].trim();
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
