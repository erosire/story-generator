// Vite config for the distribution template.
// `base` is set to "./" so all asset paths are relative — works on any GitHub Pages subpath
// e.g. https://username.github.io/repo-name/ without needing to hardcode the repo name.
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// Read the package version at config time (raw fs read instead of a JSON
// import so tsconfig does not need resolveJsonModule for the config file).
// It is injected into the app bundle via `define` below so the sidebar's
// "Stories" header can display it without bundling the whole package.json
// into the client. Same pattern as distribution/ScriptingSpaceFormatter.
//
// Path resolution: process.cwd() (NOT new URL(..., import.meta.url)) — vitest
// loads this config as a module through its own transform, where
// import.meta.url is a virtual module id (not a file URL) and `new URL`
// throws "The URL must be of scheme file". Vitest always sets cwd to the
// project root (the directory containing vitest.config.ts), so a cwd-relative
// read works identically for `vite build`, `vite dev`, and `vitest run`.
const pkg = JSON.parse(
    readFileSync(resolve(process.cwd(), 'package.json'), 'utf-8'),
) as { version: string };

export default defineConfig({
    plugins: [react()],
    // Relative base path so the build works on GitHub Pages subpaths
    base: './',
    define: {
        // Compile-time constant — replaced with the literal version string
        // (e.g. "1.0.2") in both dev and build output. Mirrored in
        // vitest.config.ts (which takes precedence under tests) and declared
        // ambient in src/vite-env.d.ts for `tsc --noEmit`.
        __APP_VERSION__: JSON.stringify(pkg.version),
    },
    // Keep local development on the agreed localhost port instead of Vite's
    // default 5173 so frontend and API development use a predictable URL.
    server: {
        port: 8000,
        // Never watch the service's shared writable data root: chokidar
        // holding files under temporary/database while the underload service
        // writes them surfaces as sporadic EPERM failures on Windows.
        watch: {
            ignored: ['**/temporary/**']
        }
    },
    build: {
        outDir: 'dist',
    },
});
