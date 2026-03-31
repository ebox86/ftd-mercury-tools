import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
export default defineConfig(function (_a) {
    var mode = _a.mode;
    var env = loadEnv(mode, '.', '');
    var proxyTarget = String(env.VITE_WORKFLOW_PROXY_TARGET || 'http://127.0.0.1:17344').trim();
    return {
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
