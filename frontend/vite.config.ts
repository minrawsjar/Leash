import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Relative base so the build works from any path (e.g. GitHub Pages under /Leash/).
// fs.allow: the app imports the repo's deployments/*.json (addresses and ABI) at build time.
export default defineConfig({ plugins: [react()], base: './', server: { fs: { allow: ['..'] } } });
