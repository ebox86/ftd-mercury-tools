import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, '.', '');
  const runtimeEnv = (
    globalThis as unknown as { process?: { env?: Record<string, string | undefined> } }
  ).process?.env || {};
  const proxyTarget = String(
    runtimeEnv.VITE_WORKFLOW_PROXY_TARGET
    || env.VITE_WORKFLOW_PROXY_TARGET
    || 'http://127.0.0.1:17344',
  ).trim();

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
