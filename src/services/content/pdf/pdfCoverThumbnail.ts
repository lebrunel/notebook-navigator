/*
 * Notebook Navigator - Plugin for Obsidian
 * Copyright (c) 2025-2026 Johan Sanneblad
 * All rights reserved.
 * SPDX-License-Identifier: LicenseRef-NotebookNavigator-1.1
 *
 * Licensed under the Notebook Navigator License Agreement, Version 1.1.
 * See the LICENSE file in the repository root.
 */

import { App, loadPdfJs, TFile } from 'obsidian';
import { isRecord } from '../../../utils/typeGuards';
import { createOnceLogger, createRenderLimiter } from '../thumbnail/thumbnailRuntimeUtils';

// Options for rendering a PDF cover page thumbnail
export interface PdfCoverThumbnailOptions {
    maxWidth: number;
    maxHeight: number;
    mimeType: string;
    quality?: number;
}

// Minimal type for pdf.js worker instance
type PdfWorker = Record<string, unknown>;

// Viewport dimensions returned by pdf.js
type PdfViewport = { width: number; height: number };

// Render task returned by pdf.js page.render()
type PdfRenderTask = { promise: Promise<void> };

// Minimal interface for a pdf.js page object
type PdfPage = {
    getViewport: (params: { scale: number }) => PdfViewport;
    render: (params: { canvasContext: CanvasRenderingContext2D; canvas: HTMLCanvasElement; viewport: PdfViewport }) => PdfRenderTask;
    cleanup?: () => void;
};

// Time before the shared worker is destroyed after the last render completes
const DEFAULT_WORKER_IDLE_TIMEOUT_MS = 60000;
// Maximum concurrent PDF page renders to limit memory usage
const MAX_PARALLEL_PDF_RENDERS = 2;
// Skip thumbnails for very large PDFs to avoid memory spikes (especially when falling back to readBinary).
const MAX_PDF_THUMBNAIL_BYTES = 25 * 1024 * 1024;

// Shared pdf.js worker instance reused across renders
let sharedWorker: PdfWorker | null = null;
// Timer ID for destroying the worker after idle timeout
let workerIdleTimerId: number | null = null;

const renderLimiter = createRenderLimiter(MAX_PARALLEL_PDF_RENDERS);
const logOnce = createOnceLogger();

function clearWorkerIdleTimer(): void {
    if (workerIdleTimerId === null) {
        return;
    }
    window.clearTimeout(workerIdleTimerId);
    workerIdleTimerId = null;
}

// Type guard for checking if a value is a pdf.js page object
function isPdfPage(value: unknown): value is PdfPage {
    if (!isRecord(value)) {
        return false;
    }

    const getViewport = value['getViewport'];
    const render = value['render'];
    return typeof getViewport === 'function' && typeof render === 'function';
}

// Resets the idle timer that destroys the shared worker after inactivity
function touchWorkerIdleTimer(): void {
    clearWorkerIdleTimer();

    if (sharedWorker === null) {
        return;
    }

    if (renderLimiter.getActiveCount() > 0) {
        return;
    }

    workerIdleTimerId = window.setTimeout(() => {
        if (renderLimiter.getActiveCount() > 0) {
            touchWorkerIdleTimer();
            return;
        }
        destroySharedWorker();
    }, DEFAULT_WORKER_IDLE_TIMEOUT_MS);
}

// Cleans up and destroys the shared pdf.js worker instance
function destroySharedWorker(): void {
    clearWorkerIdleTimer();

    const worker = sharedWorker;
    sharedWorker = null;

    if (worker === null) {
        return;
    }

    const destroy = worker['destroy'];
    if (typeof destroy === 'function') {
        try {
            (destroy as () => void)();
        } catch {
            // ignore
        }
    }
}

// Attempts to create a pdf.js worker using the PDFWorker API
function tryCreateWorker(pdfjs: unknown): PdfWorker | null {
    if (!isRecord(pdfjs)) {
        return null;
    }

    const pdfWorker = pdfjs['PDFWorker'];

    if (isRecord(pdfWorker)) {
        const create = pdfWorker['create'];
        if (typeof create === 'function') {
            try {
                const worker = (create as (params: Record<string, unknown>) => unknown)({});
                return isRecord(worker) ? worker : null;
            } catch {
                return null;
            }
        }
    }

    if (typeof pdfWorker === 'function') {
        try {
            const worker = new (pdfWorker as new (params?: Record<string, unknown>) => unknown)({});
            return isRecord(worker) ? worker : null;
        } catch {
            return null;
        }
    }

    return null;
}

// Returns the shared worker instance, creating it if necessary
async function getSharedWorkerInstance(pdfjs: unknown): Promise<PdfWorker | null> {
    if (sharedWorker) {
        touchWorkerIdleTimer();
        return sharedWorker;
    }

    const worker = tryCreateWorker(pdfjs);
    if (!worker) {
        return null;
    }

    sharedWorker = worker;
    touchWorkerIdleTimer();
    return worker;
}

// Calculates the scale factor to fit dimensions within max bounds
function calculateScale(params: { baseWidth: number; baseHeight: number; maxWidth: number; maxHeight: number }): number {
    const { baseWidth, baseHeight, maxWidth, maxHeight } = params;
    if (baseWidth <= 0 || baseHeight <= 0 || maxWidth <= 0 || maxHeight <= 0) {
        return 1;
    }

    const widthScale = maxWidth / baseWidth;
    const heightScale = maxHeight / baseHeight;
    const scale = Math.min(widthScale, heightScale);
    return Math.min(1, scale);
}

// Converts a canvas to a Blob with the specified MIME type and quality
function canvasToBlob(canvas: HTMLCanvasElement, mimeType: string, quality?: number): Promise<Blob | null> {
    return new Promise(resolve => {
        canvas.toBlob(blob => resolve(blob ?? null), mimeType, typeof quality === 'number' ? quality : undefined);
    });
}

// Renders the first page of a PDF file as a thumbnail image blob
export async function renderPdfCoverThumbnail(app: App, pdfFile: TFile, options: PdfCoverThumbnailOptions): Promise<Blob | null> {
    if (pdfFile.extension.toLowerCase() !== 'pdf') {
        return null;
    }

    const fileSize = pdfFile.stat.size ?? 0;
    if (fileSize > MAX_PDF_THUMBNAIL_BYTES) {
        logOnce(`pdf-cover:skip-size:${pdfFile.path}`, `[PDF cover] Skipping thumbnail render due to file size: ${pdfFile.path}`, {
            size: fileSize,
            limit: MAX_PDF_THUMBNAIL_BYTES
        });
        return null;
    }

    clearWorkerIdleTimer();
    const release = await renderLimiter.acquire();

    let doc: { getPage: (pageNumber: number) => Promise<unknown>; destroy?: () => void } | null = null;
    let page: { cleanup?: () => void } | null = null;

    try {
        const pdfjs: unknown = await loadPdfJs();
        const worker = await getSharedWorkerInstance(pdfjs);

        const url = app.vault.getResourcePath(pdfFile);

        try {
            const task = (pdfjs as { getDocument: (params: Record<string, unknown>) => { promise: Promise<unknown> } }).getDocument({
                url,
                ...(worker ? { worker } : {})
            });
            doc = (await task.promise) as { getPage: (pageNumber: number) => Promise<unknown>; destroy?: () => void };
        } catch {
            const buffer = await app.vault.adapter.readBinary(pdfFile.path);
            const task = (pdfjs as { getDocument: (params: Record<string, unknown>) => { promise: Promise<unknown> } }).getDocument({
                data: buffer,
                ...(worker ? { worker } : {})
            });
            doc = (await task.promise) as { getPage: (pageNumber: number) => Promise<unknown>; destroy?: () => void };
        }

        const firstPage = await doc.getPage(1);
        if (!isPdfPage(firstPage)) {
            return null;
        }
        page = firstPage;

        const baseViewport = firstPage.getViewport({ scale: 1 });
        const scale = calculateScale({
            baseWidth: baseViewport.width,
            baseHeight: baseViewport.height,
            maxWidth: options.maxWidth,
            maxHeight: options.maxHeight
        });
        const viewport = firstPage.getViewport({ scale });

        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.ceil(viewport.width));
        canvas.height = Math.max(1, Math.ceil(viewport.height));

        const ctx = canvas.getContext('2d');
        if (!ctx) {
            return null;
        }

        const renderTask = firstPage.render({ canvasContext: ctx, canvas, viewport });

        await renderTask.promise;

        const blob = await canvasToBlob(canvas, options.mimeType, options.quality);
        if (blob) {
            return blob;
        }

        return await canvasToBlob(canvas, 'image/png');
    } catch (error: unknown) {
        logOnce(`pdf-cover:${pdfFile.path}`, `[PDF cover] Failed to render thumbnail: ${pdfFile.path}`, error);
        return null;
    } finally {
        try {
            page?.cleanup?.();
        } catch {
            // ignore
        }

        try {
            doc?.destroy?.();
        } catch {
            // ignore
        }

        release();
        touchWorkerIdleTimer();
    }
}
