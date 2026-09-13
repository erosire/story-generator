// Vitest config scoped to this distribution template.
// Uses jsdom environment for React component testing with global APIs.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

// Same define as vite.config.ts: vitest.config.ts takes precedence over
// vite.config.ts, so without this the __APP_VERSION__ constant (sidebar
// version display) would be undefined inside tests. Same pattern as
// distribution/ScriptingSpaceFormatter.
//
// Path resolution: process.cwd() (NOT new URL(..., import.meta.url)) — vitest
// always sets cwd to the project root, so a cwd-relative read works for every
// invocation shape (see the matching note in vite.config.ts).
const pkg = JSON.parse(
    readFileSync(resolve(process.cwd(), 'package.json'), 'utf-8'),
) as { version: string };

export default defineConfig({
    define: {
        __APP_VERSION__: JSON.stringify(pkg.version),
    },
    test: {
        environment: 'jsdom',
        globals: true,
        include: ['src/**/*.{test,spec}.{ts,tsx}'],
        passWithNoTests: true,
    },
});
