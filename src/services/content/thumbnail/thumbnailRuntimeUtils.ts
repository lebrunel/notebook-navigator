/*
 * Notebook Navigator - Plugin for Obsidian
 * Copyright (c) 2025-2026 Johan Sanneblad
 * All rights reserved.
 * SPDX-License-Identifier: LicenseRef-NotebookNavigator-1.1
 *
 * Licensed under the Notebook Navigator License Agreement, Version 1.1.
 * See the LICENSE file in the repository root.
 */

// Creates a logger that only logs each unique key once to prevent log spam
export function createOnceLogger(): (key: string, message: string, error?: unknown) => void {
    const loggedFailures = new Set<string>();

    return (key: string, message: string, error?: unknown): void => {
        if (loggedFailures.has(key)) {
            return;
        }
        loggedFailures.add(key);

        if (error !== undefined) {
            console.log(message, error);
            return;
        }

        console.log(message);
    };
}

// Controls concurrent render operations with an acquire/release pattern
export interface RenderLimiter {
    acquire: () => Promise<() => void>;
    getActiveCount: () => number;
}

// Creates a limiter that restricts the number of concurrent render operations
export function createRenderLimiter(maxParallel: number): RenderLimiter {
    const maxParallelSafe = Number.isFinite(maxParallel) && maxParallel > 0 ? Math.floor(maxParallel) : 1;

    let active = 0;
    let waiterHead = 0;
    const waiters: (() => void)[] = [];

    // Decrements active count and notifies the next waiter if any
    function release(): void {
        active = Math.max(0, active - 1);

        const next = waiters[waiterHead];
        if (!next) {
            if (waiterHead > 0) {
                waiters.splice(0, waiterHead);
                waiterHead = 0;
            }
            return;
        }

        waiterHead += 1;
        active += 1;
        next();

        if (waiterHead > 50 && waiterHead > waiters.length / 2) {
            waiters.splice(0, waiterHead);
            waiterHead = 0;
        }
    }

    // Waits for an available slot and returns a release function
    async function acquire(): Promise<() => void> {
        if (active < maxParallelSafe) {
            active += 1;
            return () => release();
        }

        await new Promise<void>(resolve => {
            waiters.push(resolve);
        });

        return () => release();
    }

    return {
        acquire,
        getActiveCount: () => active
    };
}
