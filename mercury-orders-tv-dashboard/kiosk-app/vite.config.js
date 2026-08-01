import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
export default defineConfig(function (_a) {
    var _b;
    var mode = _a.mode;
    var env = loadEnv(mode, '.', '');
    var runtimeEnv = ((_b = globalThis.process) === null || _b === void 0 ? void 0 : _b.env) || {};
    var proxyTarget = String(runtimeEnv.VITE_WORKFLOW_PROXY_TARGET
        || env.VITE_WORKFLOW_PROXY_TARGET
        || 'http://127.0.0.1:17344').trim();
    return {
        // Relative (not root-absolute) asset URLs, so the same build works
        // whether it's served from the site root (raw port, e.g. TVs hitting
        // :5173 directly) or from a subpath behind a reverse proxy (e.g. IIS at
        // /Talaria/) - no separate build needed per deployment target.
        base: './',
        plugins: [react()],
        server: {
            host: true,
            port: 5173,
            proxy: {
                '/api': {
                    target: proxyTarget,
                    changeOrigin: true,
                    secure: false,
                },
            },
        },
    };
});
