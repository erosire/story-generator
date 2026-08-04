// Vite config for the distribution template.
// `base` is set to "./" so all asset paths are relative — works on any GitHub Pages subpath
// e.g. https://username.github.io/repo-name/ without needing to hardcode the repo name.
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
    plugins: [react()],
    // Relative base path so the build works on GitHub Pages subpaths
    base: './',
    // Keep local development on the agreed localhost port instead of Vite's
    // default 5173 so frontend and API development use a predictable URL.
    server: {
        port: 8000
    },
    build: {
        outDir: 'dist',
    },
});
