import { defineConfig } from 'vite';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Vite plugin that scans public/ for folders containing scene.ply
 * and serves a virtual scenes.json manifest.
 * This allows any folder name — no naming convention required.
 */
function scenesPlugin() {
    const publicDir = path.resolve(__dirname, 'public');

    function discoverScenes() {
        if (!fs.existsSync(publicDir)) return [];
        return fs.readdirSync(publicDir, { withFileTypes: true })
            .filter(d => d.isDirectory())
            .filter(d => fs.existsSync(path.join(publicDir, d.name, 'scene.ply')))
            .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }))
            .map(d => ({
                name: d.name,
                ply: `${d.name}/scene.ply`,
                temporal: fs.existsSync(path.join(publicDir, d.name, 'scene.4d.bin'))
                    ? `${d.name}/scene.4d.bin`
                    : null,
            }));
    }

    return {
        name: 'scenes-manifest',
        configureServer(server) {
            server.middlewares.use((req, res, next) => {
                const urlPath = req.url?.split('?')[0];
                if (urlPath === '/scenes.json') {
                    const scenes = discoverScenes();
                    res.setHeader('Content-Type', 'application/json');
                    res.setHeader('Cache-Control', 'no-cache');
                    res.end(JSON.stringify(scenes));
                    return;
                }
                next();
            });
        },
        generateBundle() {
            // Don't emit a local scenes.json in production builds —
            // the runtime fetches the manifest from R2 instead.
        },
    };
}

const isBuild = process.env.NODE_ENV === 'production' || process.argv.includes('build');

export default defineConfig({
    root: '.',
    base: './',
    // During build, use an empty public dir so large .ply/.bin assets are
    // never copied into dist/ (they're served from Cloudflare R2 instead).
    // During dev, use the real public/ dir for local testing.
    publicDir: isBuild ? false : 'public',
    plugins: [scenesPlugin()],
    server: {
        host: true,
        port: 8080,
        allowedHosts: ['pentacoxian.dev'],
        headers: {
            'Cross-Origin-Opener-Policy': 'same-origin',
            'Cross-Origin-Embedder-Policy': 'require-corp',
        },
    },
    build: {
        outDir: 'dist',
        assetsDir: 'assets',
    },
});
