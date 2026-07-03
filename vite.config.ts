// Vite config for the distribution template.
// `base` is set to "./" so all asset paths are relative — works on any GitHub Pages subpath
// e.g. https://username.github.io/repo-name/ without needing to hardcode the repo name.
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
    plugins: [react()],
    // Relative base path so the build works on GitHub Pages subpaths
    base: './',
    build: {
        outDir: 'dist',
    },
});
