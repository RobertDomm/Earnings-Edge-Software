import path from 'path';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

import runtimeErrorOverlay from '@replit/vite-plugin-runtime-error-modal';

const rawPort = process.env.PORT;

if (!rawPort) {
  throw new Error(
    'PORT environment variable is required but was not provided.',
  );
}

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

const basePath = process.env.BASE_PATH;

if (!basePath) {
  throw new Error(
    'BASE_PATH environment variable is required but was not provided.',
  );
}

export default defineConfig({
  base: basePath,
  define: {
    // Expose the server-side CLERK_PUBLISHABLE_KEY as VITE_CLERK_PUBLISHABLE_KEY
    // so the frontend can access it without requiring a separate secret.
    'import.meta.env.VITE_CLERK_PUBLISHABLE_KEY': JSON.stringify(
      process.env.CLERK_PUBLISHABLE_KEY ?? ''
    ),
    // VITE_CLERK_PROXY_URL is empty in dev (Clerk hits FAPI directly) and
    // should be set to https://<domain>/api/__clerk in production if needed.
    'import.meta.env.VITE_CLERK_PROXY_URL': JSON.stringify(
      process.env.VITE_CLERK_PROXY_URL ?? ''
    ),
  },
  plugins: [
    react(),
    tailwindcss({ optimize: false }),
    runtimeErrorOverlay(),
    VitePWA({
      strategies: 'injectManifest',
      srcDir: 'src',
      filename: 'sw.ts',
      registerType: 'autoUpdate',
      includeAssets: ['favicon.svg', 'edgefinder-logo.png'],
      manifest: {
        name: 'EE Software Screener',
        short_name: 'EE Screener',
        description: 'Stock & Options Screener for EE Software members',
        theme_color: '#0f172a',
        background_color: '#0f172a',
        display: 'standalone',
        scope: basePath,
        start_url: basePath,
        icons: [
          {
            src: 'edgefinder-logo.png',
            sizes: '192x192',
            type: 'image/png',
          },
          {
            src: 'edgefinder-logo.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'any maskable',
          },
        ],
      },
      injectManifest: {
        // offline.html is in public/ so it is automatically included in
        // __WB_MANIFEST via the default **/*.html glob — no extra entry needed.
      },
    }),
    ...(process.env.NODE_ENV !== 'production' &&
    process.env.REPL_ID !== undefined
      ? [
          await import('@replit/vite-plugin-cartographer').then((m) =>
            m.cartographer({
              root: path.resolve(import.meta.dirname, '..'),
            }),
          ),
          await import('@replit/vite-plugin-dev-banner').then((m) =>
            m.devBanner(),
          ),
        ]
      : []),
  ],
  resolve: {
    alias: {
      '@': path.resolve(import.meta.dirname, 'src'),
      '@assets': path.resolve(
        import.meta.dirname,
        '..',
        '..',
        'attached_assets',
      ),
    },
    dedupe: ['react', 'react-dom'],
  },
  root: path.resolve(import.meta.dirname),
  build: {
    outDir: path.resolve(import.meta.dirname, 'dist/public'),
    emptyOutDir: true,
  },
  server: {
    port,
    strictPort: true,
    host: '0.0.0.0',
    allowedHosts: true,
    fs: {
      strict: true,
    },
  },
  preview: {
    port,
    host: '0.0.0.0',
    allowedHosts: true,
  },
});
