// Minimal Obsidian API stubs for Vitest environment.

import { deriveFileMetadata } from '../utils/pathMetadata';

export class App {
    vault = {
        getFolderByPath: () => null,
        getAbstractFileByPath: () => null,
        cachedRead: async () => '',
        adapter: {
            readBinary: async () => new ArrayBuffer(0)
        }
    };

    metadataCache = {
        getFileCache: () => null,
        getFirstLinkpathDest: () => null
    };

    fileManager = {
        processFrontMatter: async () => {}
    };
}

export class TFile {
    path = '';
    name = '';
    basename = '';
    extension = '';
    stat = { mtime: 0, ctime: 0 };

    constructor(path = '') {
        this.setPath(path);
    }

    setPath(path: string): void {
        this.path = path;
        const metadata = deriveFileMetadata(path);
        this.name = metadata.name;
        this.basename = metadata.basename;
        this.extension = metadata.extension;
    }
}

export class TFolder {
    path = '';

    constructor(path = '') {
        this.path = path;
    }
}

export class Notice {
    constructor(public message?: string) {}
    hide(): void {}
}

export class Menu {}
export class MenuItem {}
export class Setting {}
export class ButtonComponent {}
export class SliderComponent {}
export class WorkspaceLeaf {}

export const Platform = {
    isDesktopApp: true,
    isMobile: false
};

export const normalizePath = (value: string) => value;
export const setIcon = () => {};
export const getLanguage = () => 'en';
type RequestUrlResponse = {
    status: number;
    arrayBuffer?: ArrayBuffer;
    headers: Record<string, string>;
};

export const requestUrl = async (): Promise<RequestUrlResponse> => ({
    status: 404,
    headers: {}
});

export type CachedMetadata = {
    frontmatter?: Record<string, unknown>;
};

export type FrontMatterCache = Record<string, unknown>;
export type Hotkey = { modifiers: string[]; key: string };
export type Modifier = string;
