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

import { TFile } from 'obsidian';
import { ContentType } from '../../interfaces/IContentProvider';
import { NotebookNavigatorSettings } from '../../settings';
import { FileData } from '../../storage/IndexedDBStorage';
import { getDBInstance } from '../../storage/fileOperations';
import { PreviewTextUtils } from '../../utils/previewTextUtils';
import { BaseContentProvider } from './BaseContentProvider';

/**
 * Content provider for generating file preview text
 */
export class PreviewContentProvider extends BaseContentProvider {
    getContentType(): ContentType {
        return 'preview';
    }

    getRelevantSettings(): (keyof NotebookNavigatorSettings)[] {
        return ['showFilePreview', 'skipHeadingsInPreview', 'skipCodeBlocksInPreview', 'stripHtmlInPreview', 'previewProperties'];
    }

    shouldRegenerate(oldSettings: NotebookNavigatorSettings, newSettings: NotebookNavigatorSettings): boolean {
        // Clear if preview is disabled
        if (!newSettings.showFilePreview && oldSettings.showFilePreview) {
            return true;
        }

        // Regenerate if preview is enabled and settings changed
        if (newSettings.showFilePreview) {
            return (
                oldSettings.showFilePreview !== newSettings.showFilePreview ||
                oldSettings.skipHeadingsInPreview !== newSettings.skipHeadingsInPreview ||
                oldSettings.skipCodeBlocksInPreview !== newSettings.skipCodeBlocksInPreview ||
                oldSettings.stripHtmlInPreview !== newSettings.stripHtmlInPreview ||
                JSON.stringify(oldSettings.previewProperties) !== JSON.stringify(newSettings.previewProperties)
            );
        }

        return false;
    }

    async clearContent(): Promise<void> {
        const db = getDBInstance();
        await db.batchClearAllFileContent('preview');
    }

    protected needsProcessing(fileData: FileData | null, file: TFile, settings: NotebookNavigatorSettings): boolean {
        if (!settings.showFilePreview || file.extension !== 'md') {
            return false;
        }

        const fileModified = fileData !== null && fileData.mtime !== file.stat.mtime;

        return !fileData || fileData.previewStatus === 'unprocessed' || fileModified;
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
        if (!settings.showFilePreview || job.file.extension !== 'md') {
            return null;
        }

        try {
            const metadata = this.app.metadataCache.getFileCache(job.file);

            // Skip Excalidraw files - return empty preview
            if (PreviewTextUtils.isExcalidrawFile(job.file.name, metadata?.frontmatter)) {
                if (fileData && fileData.previewStatus === 'none') {
                    if (fileData.mtime !== job.file.stat.mtime) {
                        return { path: job.file.path };
                    }
                    return null;
                }
                return {
                    path: job.file.path,
                    preview: ''
                };
            }

            const content = await this.readFileContent(job.file);
            const previewText = PreviewTextUtils.extractPreviewText(content, settings, metadata?.frontmatter);

            if (fileData) {
                const fileModified = fileData.mtime !== job.file.stat.mtime;

                if (previewText.length === 0 && fileData.previewStatus === 'none') {
                    if (fileModified) {
                        return { path: job.file.path };
                    }
                    return null;
                }

                if (fileData.previewStatus === 'has') {
                    const db = getDBInstance();
                    const cachedPreview = db.getCachedPreviewText(job.file.path);
                    if (cachedPreview.length > 0 && cachedPreview === previewText) {
                        if (fileModified) {
                            return { path: job.file.path };
                        }
                        return null;
                    }
                }
            }

            return {
                path: job.file.path,
                preview: previewText
            };
        } catch (error) {
            console.error(`Error generating preview for ${job.file.path}:`, error);
            // Error policy:
            // - If a preview already exists, keep it to avoid overwriting with partial/empty data.
            // - If preview was never generated (`unprocessed`), store an empty string to mark the file as processed.
            //   This avoids retry loops caused by repeated read/cache failures.
            if (fileData && fileData.previewStatus !== 'unprocessed') {
                return null;
            }
            return { path: job.file.path, preview: '' };
        }
    }
}
