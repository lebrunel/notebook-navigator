/*
 * Notebook Navigator - Plugin for Obsidian
 * Copyright (c) 2025-2026 Johan Sanneblad
 * SPDX-License-Identifier: LicenseRef-NotebookNavigator
 *
 * Licensed under the Notebook Navigator License Agreement (see LICENSE).
 */

import { TFile } from 'obsidian';
import { IContentProvider, ContentType } from '../../interfaces/IContentProvider';
import { NotebookNavigatorSettings } from '../../settings';

/**
 * Registry for managing content providers
 * Centralizes the registration and coordination of different content generation services
 */
export class ContentProviderRegistry {
    private providers: Map<ContentType, IContentProvider> = new Map();

    /**
     * Registers a content provider
     * @param provider - The provider to register
     */
    registerProvider(provider: IContentProvider): void {
        this.providers.set(provider.getContentType(), provider);
    }

    /**
     * Gets all registered providers
     */
    getAllProviders(): IContentProvider[] {
        return Array.from(this.providers.values());
    }

    /**
     * Gets a specific provider by content type
     */
    getProvider(type: ContentType): IContentProvider | undefined {
        return this.providers.get(type);
    }

    /**
     * Gets all settings that affect any content generation
     */
    getAllRelevantSettings(): (keyof NotebookNavigatorSettings)[] {
        const allSettings = new Set<keyof NotebookNavigatorSettings>();

        for (const provider of this.providers.values()) {
            const settings = provider.getRelevantSettings();
            settings.forEach(setting => allSettings.add(setting));
        }

        return Array.from(allSettings);
    }

    /**
     * Handles settings changes by notifying affected providers
     * @param oldSettings - Previous settings
     * @param newSettings - New settings
     * @returns Content types that were cleared and need regeneration
     */
    async handleSettingsChange(oldSettings: NotebookNavigatorSettings, newSettings: NotebookNavigatorSettings): Promise<ContentType[]> {
        const clearPromises: Promise<void>[] = [];
        const affectedTypes: ContentType[] = [];

        // Check each provider to see if it's affected
        for (const provider of this.providers.values()) {
            if (provider.shouldRegenerate(oldSettings, newSettings)) {
                // Clear content for this provider
                clearPromises.push(provider.clearContent());
                affectedTypes.push(provider.getContentType());
            }

            // Always notify providers of settings changes
            provider.onSettingsChanged(newSettings);
        }

        // Wait for all clear operations to complete
        if (clearPromises.length > 0) {
            await Promise.all(clearPromises);
        }

        return affectedTypes;
    }

    /**
     * Queues files for content generation across all providers
     * @param files - Files to queue
     * @param settings - Current settings
     * @param options - Optional filtering to include or exclude specific content types
     */
    queueFilesForAllProviders(
        files: TFile[],
        settings: NotebookNavigatorSettings,
        options?: { include?: ContentType[]; exclude?: ContentType[] }
    ): void {
        const include = options?.include;
        const exclude = options?.exclude;

        for (const provider of this.providers.values()) {
            const type = provider.getContentType();

            // Skip providers not in the include list (if specified)
            if (include && !include.includes(type)) {
                continue;
            }

            // Skip providers in the exclude list (if specified)
            if (exclude && exclude.includes(type)) {
                continue;
            }

            // Resume provider before queuing so it accepts new work after a stop
            provider.startProcessing(settings);
            provider.queueFiles(files);
        }
    }

    /**
     * Stops all providers' processing
     */
    stopAllProcessing(): void {
        for (const provider of this.providers.values()) {
            provider.stopProcessing();
        }
    }
}
