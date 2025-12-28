/*
 * Notebook Navigator - Plugin for Obsidian
 * Copyright (c) 2025-2026 Johan Sanneblad
 * All rights reserved.
 * SPDX-License-Identifier: LicenseRef-NotebookNavigator-1.1
 *
 * Licensed under the Notebook Navigator License Agreement, Version 1.1.
 * See the LICENSE file in the repository root.
 */
import { describe, expect, it, vi } from 'vitest';
import { App, TFile } from 'obsidian';
import type { CachedMetadata } from 'obsidian';
import { FeatureImageContentProvider } from '../../src/services/content/FeatureImageContentProvider';
import { DEFAULT_SETTINGS } from '../../src/settings/defaultSettings';
import type { NotebookNavigatorSettings } from '../../src/settings/types';
import type { FileData } from '../../src/storage/IndexedDBStorage';
import { deriveFileMetadata } from '../utils/pathMetadata';

class TestFeatureImageContentProvider extends FeatureImageContentProvider {
    getFrontmatterReference(file: TFile, metadata: CachedMetadata | null, settings: NotebookNavigatorSettings) {
        return this.getFrontmatterImageReference(file, metadata, settings);
    }

    getDocumentReference(content: string, file: TFile, settings: NotebookNavigatorSettings) {
        return this.getDocumentImageReference(content, file, settings);
    }

    async runProcessFile(file: TFile, settings: NotebookNavigatorSettings) {
        return this.processFile({ file, path: file.path.split('/') }, null, settings);
    }

    async runProcessFileWithData(file: TFile, fileData: FileData | null, settings: NotebookNavigatorSettings) {
        return this.processFile({ file, path: file.path.split('/') }, fileData, settings);
    }

    buildKey(reference: FeatureImageReference): string {
        return this.getFeatureImageKey(reference);
    }
}

type FeatureImageReference = { kind: 'local'; file: TFile } | { kind: 'external'; url: string } | { kind: 'youtube'; videoId: string };

function createSettings(overrides?: Partial<NotebookNavigatorSettings>): NotebookNavigatorSettings {
    return {
        ...DEFAULT_SETTINGS,
        featureImageProperties: ['thumbnail'],
        downloadExternalFeatureImages: true,
        ...overrides
    };
}

function createApp() {
    const app = new App();
    const resolvedFiles = new Map<string, TFile>();

    app.metadataCache.getFileCache = () => null;
    const getFirstLinkpathDest = vi.fn<(path: string, sourcePath: string) => TFile | null>(
        (path: string) => resolvedFiles.get(path) ?? null
    );
    app.metadataCache.getFirstLinkpathDest = getFirstLinkpathDest;
    app.vault.getFolderByPath = () => null;
    app.vault.getAbstractFileByPath = (path: string) => resolvedFiles.get(path) ?? null;
    app.vault.cachedRead = async () => '';
    app.vault.adapter.readBinary = async () => new ArrayBuffer(0);

    return { app, resolvedFiles, getFirstLinkpathDest };
}

function createFile(path: string): TFile {
    const file = new TFile();
    const metadata = deriveFileMetadata(path);
    file.path = path;
    file.name = metadata.name;
    file.basename = metadata.basename;
    file.extension = metadata.extension;
    return file;
}

describe('FeatureImageContentProvider scanning', () => {
    it('uses the first embedded YouTube link in the document', () => {
        const { app, resolvedFiles } = createApp();
        const provider = new TestFeatureImageContentProvider(app);
        const settings = createSettings({ downloadExternalFeatureImages: true });
        const noteFile = createFile('notes/note.md');

        const imageFile = createFile('images/cover.png');
        resolvedFiles.set('image', imageFile);
        resolvedFiles.set(imageFile.path, imageFile);

        const content = `![](https://youtu.be/abc123)\n![[image]]`;
        const result = provider.getDocumentReference(content, noteFile, settings);

        expect(result?.kind).toBe('youtube');
        if (result?.kind === 'youtube') {
            expect(result.videoId).toBe('abc123');
        }
    });

    it('resolves extensionless wiki embeds to local images', () => {
        const { app, resolvedFiles } = createApp();
        const provider = new TestFeatureImageContentProvider(app);
        const settings = createSettings();
        const noteFile = createFile('notes/note.md');

        const imageFile = createFile('images/hero.png');
        resolvedFiles.set('hero', imageFile);
        resolvedFiles.set(imageFile.path, imageFile);

        const result = provider.getDocumentReference('![[hero]]', noteFile, settings);

        expect(result?.kind).toBe('local');
        if (result?.kind === 'local') {
            expect(result.file.path).toBe(imageFile.path);
        }
    });

    it('resolves extensionless markdown embeds to local images', () => {
        const { app, resolvedFiles } = createApp();
        const provider = new TestFeatureImageContentProvider(app);
        const settings = createSettings();
        const noteFile = createFile('notes/note.md');

        const imageFile = createFile('images/hero.png');
        resolvedFiles.set('hero', imageFile);
        resolvedFiles.set(imageFile.path, imageFile);

        const result = provider.getDocumentReference('![](hero)', noteFile, settings);

        expect(result?.kind).toBe('local');
        if (result?.kind === 'local') {
            expect(result.file.path).toBe(imageFile.path);
        }
    });

    it('skips external images when downloads are disabled and continues scanning', () => {
        const { app, resolvedFiles } = createApp();
        const provider = new TestFeatureImageContentProvider(app);
        const settings = createSettings({ downloadExternalFeatureImages: false });
        const noteFile = createFile('notes/note.md');

        const imageFile = createFile('images/hero.png');
        resolvedFiles.set('hero', imageFile);
        resolvedFiles.set(imageFile.path, imageFile);

        const content = `![](https://example.com/cover.jpg)\n![[hero]]`;
        const result = provider.getDocumentReference(content, noteFile, settings);

        expect(result?.kind).toBe('local');
        if (result?.kind === 'local') {
            expect(result.file.path).toBe(imageFile.path);
        }
    });

    it('ignores frontmatter content when scanning the document body', () => {
        const { app, resolvedFiles } = createApp();
        const provider = new TestFeatureImageContentProvider(app);
        const settings = createSettings();
        const noteFile = createFile('notes/note.md');

        const imageFile = createFile('images/hero.png');
        resolvedFiles.set('hero', imageFile);
        resolvedFiles.set(imageFile.path, imageFile);

        const content = `---\ncover: ![](https://youtu.be/frontmatter)\n---\n![[hero]]`;
        const result = provider.getDocumentReference(content, noteFile, settings);

        expect(result?.kind).toBe('local');
        if (result?.kind === 'local') {
            expect(result.file.path).toBe(imageFile.path);
        }
    });

    it('ignores CRLF frontmatter content when scanning the document body', () => {
        const { app, resolvedFiles } = createApp();
        const provider = new TestFeatureImageContentProvider(app);
        const settings = createSettings();
        const noteFile = createFile('notes/note.md');

        const imageFile = createFile('images/hero.png');
        resolvedFiles.set('hero', imageFile);
        resolvedFiles.set(imageFile.path, imageFile);

        const content = `---\r\ncover: ![](https://youtu.be/frontmatter)\r\n---\r\n![[hero]]`;
        const result = provider.getDocumentReference(content, noteFile, settings);

        expect(result?.kind).toBe('local');
        if (result?.kind === 'local') {
            expect(result.file.path).toBe(imageFile.path);
        }
    });

    it('skips non-image wiki embeds with extensions before resolving and continues scanning', () => {
        const { app, resolvedFiles, getFirstLinkpathDest } = createApp();
        const provider = new TestFeatureImageContentProvider(app);
        const settings = createSettings();
        const noteFile = createFile('notes/note.md');

        const imageFile = createFile('images/hero.png');
        resolvedFiles.set('hero', imageFile);
        resolvedFiles.set(imageFile.path, imageFile);

        const content = `![[note.md]]\n![[hero]]`;
        const result = provider.getDocumentReference(content, noteFile, settings);

        expect(result?.kind).toBe('local');
        expect(getFirstLinkpathDest.mock.calls.some(call => call[0] === 'note.md')).toBe(false);
    });

    it('skips non-image markdown embeds with extensions before resolving and continues scanning', () => {
        const { app, resolvedFiles, getFirstLinkpathDest } = createApp();
        const provider = new TestFeatureImageContentProvider(app);
        const settings = createSettings();
        const noteFile = createFile('notes/note.md');

        const imageFile = createFile('images/hero.png');
        resolvedFiles.set('hero', imageFile);
        resolvedFiles.set(imageFile.path, imageFile);

        const content = `![](doc.docx)\n![[hero]]`;
        const result = provider.getDocumentReference(content, noteFile, settings);

        expect(result?.kind).toBe('local');
        expect(getFirstLinkpathDest.mock.calls.some(call => call[0] === 'doc.docx')).toBe(false);
    });

    it('resolves PDF markdown embeds to local files', () => {
        const { app, resolvedFiles } = createApp();
        const provider = new TestFeatureImageContentProvider(app);
        const settings = createSettings();
        const noteFile = createFile('notes/note.md');

        const pdfFile = createFile('resources/doc.pdf');
        resolvedFiles.set('doc.pdf', pdfFile);
        resolvedFiles.set(pdfFile.path, pdfFile);

        const result = provider.getDocumentReference('![](doc.pdf)', noteFile, settings);

        expect(result?.kind).toBe('local');
        if (result?.kind === 'local') {
            expect(result.file.path).toBe(pdfFile.path);
        }
    });

    it('resolves PDF markdown embeds with fragments to local files', () => {
        const { app, resolvedFiles } = createApp();
        const provider = new TestFeatureImageContentProvider(app);
        const settings = createSettings();
        const noteFile = createFile('notes/note.md');

        const pdfFile = createFile('resources/doc.pdf');
        resolvedFiles.set('doc.pdf', pdfFile);
        resolvedFiles.set(pdfFile.path, pdfFile);

        const result = provider.getDocumentReference('![](doc.pdf#page=2)', noteFile, settings);

        expect(result?.kind).toBe('local');
        if (result?.kind === 'local') {
            expect(result.file.path).toBe(pdfFile.path);
        }
    });

    it('resolves PDF markdown embeds with query strings to local files', () => {
        const { app, resolvedFiles } = createApp();
        const provider = new TestFeatureImageContentProvider(app);
        const settings = createSettings();
        const noteFile = createFile('notes/note.md');

        const pdfFile = createFile('resources/doc.pdf');
        resolvedFiles.set('doc.pdf', pdfFile);
        resolvedFiles.set(pdfFile.path, pdfFile);

        const result = provider.getDocumentReference('![](doc.pdf?page=2)', noteFile, settings);

        expect(result?.kind).toBe('local');
        if (result?.kind === 'local') {
            expect(result.file.path).toBe(pdfFile.path);
        }
    });

    it('resolves PDF wiki embeds to local files', () => {
        const { app, resolvedFiles } = createApp();
        const provider = new TestFeatureImageContentProvider(app);
        const settings = createSettings();
        const noteFile = createFile('notes/note.md');

        const pdfFile = createFile('resources/hero.pdf');
        resolvedFiles.set('hero.pdf', pdfFile);
        resolvedFiles.set(pdfFile.path, pdfFile);

        const result = provider.getDocumentReference('![[hero.pdf]]', noteFile, settings);

        expect(result?.kind).toBe('local');
        if (result?.kind === 'local') {
            expect(result.file.path).toBe(pdfFile.path);
        }
    });

    it('resolves PDF wiki embeds with fragments to local files', () => {
        const { app, resolvedFiles } = createApp();
        const provider = new TestFeatureImageContentProvider(app);
        const settings = createSettings();
        const noteFile = createFile('notes/note.md');

        const pdfFile = createFile('resources/hero.pdf');
        resolvedFiles.set('hero.pdf', pdfFile);
        resolvedFiles.set(pdfFile.path, pdfFile);

        const result = provider.getDocumentReference('![[hero.pdf#page=2]]', noteFile, settings);

        expect(result?.kind).toBe('local');
        if (result?.kind === 'local') {
            expect(result.file.path).toBe(pdfFile.path);
        }
    });

    it('resolves PDF wiki embeds with query strings to local files', () => {
        const { app, resolvedFiles } = createApp();
        const provider = new TestFeatureImageContentProvider(app);
        const settings = createSettings();
        const noteFile = createFile('notes/note.md');

        const pdfFile = createFile('resources/hero.pdf');
        resolvedFiles.set('hero.pdf', pdfFile);
        resolvedFiles.set(pdfFile.path, pdfFile);

        const result = provider.getDocumentReference('![[hero.pdf?page=2]]', noteFile, settings);

        expect(result?.kind).toBe('local');
        if (result?.kind === 'local') {
            expect(result.file.path).toBe(pdfFile.path);
        }
    });

    it('continues scanning when PDF embed cannot be resolved', () => {
        const { app, resolvedFiles, getFirstLinkpathDest } = createApp();
        const provider = new TestFeatureImageContentProvider(app);
        const settings = createSettings();
        const noteFile = createFile('notes/note.md');

        const imageFile = createFile('images/hero.png');
        resolvedFiles.set('hero', imageFile);
        resolvedFiles.set(imageFile.path, imageFile);

        const content = `![](doc.pdf)\n![[hero]]`;
        const result = provider.getDocumentReference(content, noteFile, settings);

        expect(result?.kind).toBe('local');
        if (result?.kind === 'local') {
            expect(result.file.path).toBe(imageFile.path);
        }
        expect(getFirstLinkpathDest.mock.calls.some(call => call[0] === 'doc.pdf')).toBe(true);
    });

    it('resolves frontmatter properties to local images', () => {
        const { app, resolvedFiles } = createApp();
        const provider = new TestFeatureImageContentProvider(app);
        const settings = createSettings();
        const noteFile = createFile('notes/note.md');

        const imageFile = createFile('images/hero.png');
        resolvedFiles.set('hero', imageFile);
        resolvedFiles.set(imageFile.path, imageFile);

        const metadata: CachedMetadata = {
            frontmatter: {
                thumbnail: '![[hero]]'
            }
        };

        const result = provider.getFrontmatterReference(noteFile, metadata, settings);

        expect(result?.kind).toBe('local');
        if (result?.kind === 'local') {
            expect(result.file.path).toBe(imageFile.path);
        }
    });

    it('includes source mtime in local image cache keys', () => {
        const { app } = createApp();
        const provider = new TestFeatureImageContentProvider(app);
        const imageFile = createFile('images/hero.png');
        imageFile.stat.mtime = 12345;

        const key = provider.buildKey({ kind: 'local', file: imageFile });

        expect(key).toBe(`f:${imageFile.path}@${imageFile.stat.mtime}`);
    });

    it('skips regeneration when featureImageKey matches even without a blob', async () => {
        const { app } = createApp();
        const provider = new TestFeatureImageContentProvider(app);
        const settings = createSettings();
        const noteFile = createFile('notes/note.md');

        const metadata: CachedMetadata = {
            frontmatter: {
                thumbnail: 'https://example.com/cover.jpg'
            }
        };
        app.metadataCache.getFileCache = () => metadata;

        // Existing data already recorded the same feature image key.
        const fileData: FileData = {
            mtime: noteFile.stat.mtime,
            tags: null,
            preview: null,
            featureImage: null,
            featureImageStatus: 'none',
            featureImageKey: 'e:https://example.com/cover.jpg',
            metadata: null
        };

        // No update is emitted when the key matches.
        const result = await provider.runProcessFileWithData(noteFile, fileData, settings);
        expect(result).toBeNull();
    });

    it('stores empty blob when external download fails', async () => {
        const { app } = createApp();
        const provider = new TestFeatureImageContentProvider(app);
        const settings = createSettings({ downloadExternalFeatureImages: true });
        const noteFile = createFile('notes/note.md');

        // Provide a document with an external image reference.
        app.vault.cachedRead = async () => '![](https://example.com/cover.jpg)';

        const result = await provider.runProcessFile(noteFile, settings);

        // An empty blob is written alongside the key when no thumbnail is produced.
        expect(result).not.toBeNull();
        expect(result?.featureImageKey).toBe('e:https://example.com/cover.jpg');
        expect(result?.featureImage).toBeInstanceOf(Blob);
        expect(result?.featureImage?.size).toBe(0);
    });

    it('generates Excalidraw feature images via ExcalidrawAutomate', async () => {
        const { app } = createApp();
        const provider = new TestFeatureImageContentProvider(app);
        const settings = createSettings();
        const excalidrawFile = createFile('drawings/sketch.excalidraw.md');
        excalidrawFile.stat.mtime = 123;

        const destroy = vi.fn<() => void>();
        const createPng = vi.fn<
            (
                view: undefined,
                scale: number,
                exportSettings: object,
                embeddedFilesLoader: object,
                theme: undefined,
                padding: number
            ) => Promise<Blob | null>
        >(async () => new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' }));

        Reflect.set(globalThis, 'ExcalidrawAutomate', {
            getAPI: () => ({
                getSceneFromFile: async () => ({ elements: [{ x: 0, y: 0, width: 100, height: 80 }] }),
                copyViewElementsToEAforEditing: async () => {},
                getEmbeddedFilesLoader: () => ({}),
                getExportSettings: () => ({}),
                createPNG: createPng,
                destroy
            })
        });

        try {
            const result = await provider.runProcessFile(excalidrawFile, settings);

            expect(result?.featureImageKey).toBe(`x:${excalidrawFile.path}@${excalidrawFile.stat.mtime}`);
            expect(result?.featureImage).toBeInstanceOf(Blob);
            expect(result?.featureImage?.size).toBeGreaterThan(0);
            expect(result?.featureImage?.type).toBe('image/png');
            expect(createPng).toHaveBeenCalledWith(undefined, expect.any(Number), expect.any(Object), expect.any(Object), undefined, 0);
            expect(createPng.mock.calls[0]?.[1]).toBeLessThanOrEqual(1);
            expect(createPng.mock.calls[0]?.[1]).toBeGreaterThan(0);
            expect(destroy).toHaveBeenCalledTimes(1);
        } finally {
            Reflect.deleteProperty(globalThis, 'ExcalidrawAutomate');
        }
    });

    it('skips Excalidraw regeneration when featureImageKey matches', async () => {
        const { app } = createApp();
        const provider = new TestFeatureImageContentProvider(app);
        const settings = createSettings();
        const excalidrawFile = createFile('drawings/sketch.excalidraw.md');
        excalidrawFile.stat.mtime = 456;

        const createPng = vi.fn(async () => new Blob([new Uint8Array([1])], { type: 'image/png' }));

        Reflect.set(globalThis, 'ExcalidrawAutomate', {
            getAPI: () => ({
                getSceneFromFile: async () => ({ elements: [{ x: 0, y: 0, width: 100, height: 80 }] }),
                copyViewElementsToEAforEditing: async () => {},
                getEmbeddedFilesLoader: () => ({}),
                getExportSettings: () => ({}),
                createPNG: createPng,
                destroy: () => {}
            })
        });

        try {
            const fileData: FileData = {
                mtime: excalidrawFile.stat.mtime,
                tags: null,
                preview: null,
                featureImage: null,
                featureImageStatus: 'has',
                featureImageKey: `x:${excalidrawFile.path}@${excalidrawFile.stat.mtime}`,
                metadata: null
            };

            const result = await provider.runProcessFileWithData(excalidrawFile, fileData, settings);
            expect(result).toBeNull();
            expect(createPng).not.toHaveBeenCalled();
        } finally {
            Reflect.deleteProperty(globalThis, 'ExcalidrawAutomate');
        }
    });

    it('destroys ExcalidrawAutomate API when getSceneFromFile throws', async () => {
        const { app } = createApp();
        const provider = new TestFeatureImageContentProvider(app);
        const settings = createSettings();
        const excalidrawFile = createFile('drawings/broken.excalidraw.md');
        excalidrawFile.stat.mtime = 777;

        const destroy = vi.fn<() => void>();

        Reflect.set(globalThis, 'ExcalidrawAutomate', {
            getAPI: () => ({
                getSceneFromFile: async () => {
                    throw new Error('boom');
                },
                copyViewElementsToEAforEditing: async () => {},
                getEmbeddedFilesLoader: () => ({}),
                getExportSettings: () => ({}),
                createPNG: async () => null,
                destroy
            })
        });

        try {
            const result = await provider.runProcessFile(excalidrawFile, settings);

            expect(result?.featureImageKey).toBe(`x:${excalidrawFile.path}@${excalidrawFile.stat.mtime}`);
            expect(result?.featureImage).toBeInstanceOf(Blob);
            expect(result?.featureImage?.size).toBe(0);
            expect(destroy).toHaveBeenCalledTimes(1);
        } finally {
            Reflect.deleteProperty(globalThis, 'ExcalidrawAutomate');
        }
    });

    it('falls back to copyViewElementsToEAforEditing without embedded files', async () => {
        const { app } = createApp();
        const excalidrawFile = createFile('drawings/embedded.excalidraw.md');
        excalidrawFile.stat.mtime = 888;

        Reflect.set(app as object, 'workspace', {
            iterateAllLeaves: (cb: (leaf: object) => void) => {
                cb({ view: { file: { path: excalidrawFile.path } } });
            }
        });

        const provider = new TestFeatureImageContentProvider(app);
        const settings = createSettings();

        const destroy = vi.fn<() => void>();
        const copyViewElementsToEAforEditing = vi.fn<(_elements: object[], includeFiles: boolean) => Promise<void>>(
            async (_elements, includeFiles) => {
                if (includeFiles) {
                    throw new Error('includeFiles unsupported');
                }
            }
        );
        const setView = vi.fn<(_view: object) => void>();

        Reflect.set(globalThis, 'ExcalidrawAutomate', {
            getAPI: () => ({
                setView,
                getSceneFromFile: async () => ({ elements: [{ x: 0, y: 0, width: 100, height: 80 }] }),
                copyViewElementsToEAforEditing,
                getEmbeddedFilesLoader: () => ({}),
                getExportSettings: () => ({}),
                createPNG: async () => new Blob([new Uint8Array([9])], { type: 'image/png' }),
                destroy
            })
        });

        try {
            const result = await provider.runProcessFile(excalidrawFile, settings);

            expect(result?.featureImageKey).toBe(`x:${excalidrawFile.path}@${excalidrawFile.stat.mtime}`);
            expect(result?.featureImage?.size).toBeGreaterThan(0);
            expect(copyViewElementsToEAforEditing).toHaveBeenCalledTimes(2);
            expect(copyViewElementsToEAforEditing).toHaveBeenNthCalledWith(1, expect.any(Array), true);
            expect(copyViewElementsToEAforEditing).toHaveBeenNthCalledWith(2, expect.any(Array), false);
            expect(setView).toHaveBeenCalledTimes(1);
            expect(destroy).toHaveBeenCalledTimes(1);
        } finally {
            Reflect.deleteProperty(globalThis, 'ExcalidrawAutomate');
        }
    });

    it('destroys ExcalidrawAutomate API when createPNG throws', async () => {
        const { app } = createApp();
        const provider = new TestFeatureImageContentProvider(app);
        const settings = createSettings();
        const excalidrawFile = createFile('drawings/throw.excalidraw.md');
        excalidrawFile.stat.mtime = 999;

        const destroy = vi.fn<() => void>();

        Reflect.set(globalThis, 'ExcalidrawAutomate', {
            getAPI: () => ({
                getSceneFromFile: async () => ({ elements: [{ x: 0, y: 0, width: 100, height: 80 }] }),
                copyViewElementsToEAforEditing: async () => {},
                getEmbeddedFilesLoader: () => ({}),
                getExportSettings: () => ({}),
                createPNG: async () => {
                    throw new Error('png failed');
                },
                destroy
            })
        });

        try {
            const result = await provider.runProcessFile(excalidrawFile, settings);

            expect(result?.featureImageKey).toBe(`x:${excalidrawFile.path}@${excalidrawFile.stat.mtime}`);
            expect(result?.featureImage).toBeInstanceOf(Blob);
            expect(result?.featureImage?.size).toBe(0);
            expect(destroy).toHaveBeenCalledTimes(1);
        } finally {
            Reflect.deleteProperty(globalThis, 'ExcalidrawAutomate');
        }
    });
});
