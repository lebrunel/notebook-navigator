import { describe, expect, it, vi } from 'vitest';
import { App, TFile } from 'obsidian';
import type { CachedMetadata } from 'obsidian';
import { FeatureImageContentProvider } from '../../src/services/content/FeatureImageContentProvider';
import { DEFAULT_SETTINGS } from '../../src/settings/defaultSettings';
import type { NotebookNavigatorSettings } from '../../src/settings/types';
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

        const content = `![](doc.pdf)\n![[hero]]`;
        const result = provider.getDocumentReference(content, noteFile, settings);

        expect(result?.kind).toBe('local');
        expect(getFirstLinkpathDest.mock.calls.some(call => call[0] === 'doc.pdf')).toBe(false);
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

    it('stores empty blob when external download fails', async () => {
        const { app } = createApp();
        const provider = new TestFeatureImageContentProvider(app);
        const settings = createSettings({ downloadExternalFeatureImages: true });
        const noteFile = createFile('notes/note.md');

        app.vault.cachedRead = async () => '![](https://example.com/cover.jpg)';

        const result = await provider.runProcessFile(noteFile, settings);

        expect(result).not.toBeNull();
        expect(result?.featureImageKey).toBe('e:https://example.com/cover.jpg');
        expect(result?.featureImage).toBeInstanceOf(Blob);
        expect(result?.featureImage?.size).toBe(0);
    });
});
