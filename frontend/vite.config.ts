import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Relative base so the build works from any path (e.g. GitHub Pages under /Leash/).
export default defineConfig({ plugins: [react()], base: './' });
