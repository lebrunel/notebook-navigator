/*
 * Notebook Navigator - Plugin for Obsidian
 * Copyright (c) 2025-2026 Johan Sanneblad
 * All rights reserved.
 * SPDX-License-Identifier: LicenseRef-NotebookNavigator-1.1
 *
 * Licensed under the Notebook Navigator License Agreement, Version 1.1.
 * See the LICENSE file in the repository root.
 */

import { App, TFile } from 'obsidian';
import { ExtendedApp } from '../types/obsidian-extended';
import { EXCALIDRAW_BASENAME_SUFFIX, isExcalidrawFile } from './fileNameUtils';

/**
 * File visibility options for the navigator
 */
export const FILE_VISIBILITY = {
    DOCUMENTS: 'documents',
    SUPPORTED: 'supported',
    ALL: 'all'
} as const;

/**
 * Type derived from FILE_VISIBILITY values
 */
export type FileVisibility = (typeof FILE_VISIBILITY)[keyof typeof FILE_VISIBILITY];

/**
 * Core file types that Obsidian supports natively
 * This is a fallback list in case we can't access the view registry
 */
const CORE_OBSIDIAN_EXTENSIONS = new Set([
    'md', // Markdown
    'canvas', // Obsidian Canvas
    'base', // Obsidian database files
    'pdf' // PDF viewer
]);

/**
 * Common image extensions that can be displayed as feature images.
 * Limited to formats with reliable cross-platform support.
 */
const SUPPORTED_IMAGE_EXTENSIONS = ['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'avif', 'bmp'] as const;
const IMAGE_EXTENSIONS = new Set<string>(SUPPORTED_IMAGE_EXTENSIONS);

export function isImageExtension(extension: string): boolean {
    if (!extension) {
        return false;
    }
    return IMAGE_EXTENSIONS.has(extension.toLowerCase());
}

// Checks if a file extension is PDF (case-insensitive)
function isPdfExtension(extension: string): boolean {
    if (!extension) {
        return false;
    }
    return extension.toLowerCase() === 'pdf';
}

/**
 * Check if a file should be displayed based on the visibility setting
 */
export function shouldDisplayFile(file: TFile, visibility: FileVisibility, app: App): boolean {
    // Validate inputs
    if (!file?.extension) {
        return false;
    }

    switch (visibility) {
        case FILE_VISIBILITY.DOCUMENTS:
            // Primary document types in Obsidian
            return file.extension === 'md' || file.extension === 'canvas' || file.extension === 'base';

        case FILE_VISIBILITY.SUPPORTED: {
            // Get supported extensions inline
            const extensions = new Set<string>(CORE_OBSIDIAN_EXTENSIONS);

            try {
                // Try to get registered view types from Obsidian's view registry
                const extendedApp = app as ExtendedApp;

                if (extendedApp.viewRegistry?.typeByExtension) {
                    const typeByExtension = extendedApp.viewRegistry.typeByExtension;
                    if (typeByExtension && typeof typeByExtension === 'object') {
                        for (const ext of Object.keys(typeByExtension)) {
                            if (typeof ext === 'string') {
                                extensions.add(ext);
                            }
                        }
                    }
                }

                // Also check for registered extensions in the metadataTypeManager
                // This catches some additional file types that plugins might register
                if (extendedApp.metadataTypeManager?.registeredExtensions) {
                    const registeredExtensions = extendedApp.metadataTypeManager.registeredExtensions;
                    if (Array.isArray(registeredExtensions)) {
                        for (const ext of registeredExtensions) {
                            if (typeof ext === 'string') {
                                extensions.add(ext);
                            }
                        }
                    }
                }
            } catch {
                // If we can't access internal APIs, just use the core extensions
            }

            return extensions.has(file.extension);
        }

        case FILE_VISIBILITY.ALL:
            return true;

        default:
            // Default to documents for safety
            return file.extension === 'md' || file.extension === 'canvas' || file.extension === 'base';
    }
}

/**
 * Check if a file is an image that can be displayed as a feature image
 */
export function isImageFile(file: TFile): boolean {
    if (!file?.extension) {
        return false;
    }
    return isImageExtension(file.extension);
}

// Checks if a TFile is a PDF document
export function isPdfFile(file: TFile): boolean {
    if (!file?.extension) {
        return false;
    }
    return isPdfExtension(file.extension);
}

/**
 * Determines whether an inline extension suffix should be shown for a file name.
 * Excludes markdown, canvas, and base files.
 */
export function shouldShowExtensionSuffix(file: TFile): boolean {
    if (!file || !file.extension) return false;
    if (isExcalidrawFile(file)) {
        return true;
    }
    const ext = file.extension;
    return !(ext === 'md' || ext === 'canvas' || ext === 'base');
}

/**
 * Returns the extension suffix for inline display, including the leading dot.
 * Returns an empty string when suffix should not be shown.
 */
export function getExtensionSuffix(file: TFile): string {
    if (isExcalidrawFile(file)) {
        return EXCALIDRAW_BASENAME_SUFFIX;
    }
    return shouldShowExtensionSuffix(file) ? `.${file.extension}` : '';
}
