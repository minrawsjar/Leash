import { fileURLToPath } from 'node:url';
import { defineConfig, loadEnv, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import draft from './api/draft.ts';

// `npm run dev` serves POST /api/draft from the same handler Vercel runs (api/draft.ts). The key comes from the
// repo root .env and stays in this Node process: it is not VITE_-prefixed, so it never reaches the client bundle.
const api = (mode: string): Plugin => ({
  name: 'leash-api',
  configureServer(s) {
    const key = loadEnv(mode, fileURLToPath(new URL('..', import.meta.url)), '').OPENROUTER_API_KEY;
    s.middlewares.use('/api/draft', (req, res) => void draft(req, res, key));
  },
});

// Relative base so the build works from any path (e.g. GitHub Pages under /Leash/).
// fs.allow: the app imports the repo's deployments/*.json (addresses and ABI) at build time.
export default defineConfig(({ mode }) => ({ plugins: [react(), api(mode)], base: './', server: { fs: { allow: ['..'] } } }));
