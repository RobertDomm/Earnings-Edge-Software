import path from 'path';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

import runtimeErrorOverlay from '@replit/vite-plugin-runtime-error-modal';

// PORT is only needed for the dev/preview server. Production builds
// (`vite build`) run without PORT — e.g. in the deployment build step —
// so only enforce it when a server will actually be started.
const isBuild = process.argv.includes('build');
const rawPort = process.env.PORT;

if (!isBuild && !rawPort) {
  throw new Error(
    'PORT environment variable is required but was not provided.',
  );
}

const port = rawPort ? Number(rawPort) : 0;

if (!isBuild && (Number.isNaN(port) || port <= 0)) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

// Deployed static site serves from the domain root; dev uses the value from
// artifact.toml [services.env].
const basePath = process.env.BASE_PATH ?? '/';

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
      includeAssets: ['favicon.png', 'ees-hex-logo.png', 'ees-hex-logo-192.png', 'ees-hex-logo-512.png', 'apple-touch-icon.png'],
      manifest: {
        name: 'Earnings Edge Software',
        short_name: 'Earnings Edge',
        description: 'Earnings Edge Software — Stock & Options Screener for earnings-driven trades.',
        theme_color: '#0f172a',
        background_color: '#0f172a',
        display: 'standalone',
        scope: basePath,
        start_url: basePath,
        icons: [
          {
            src: 'ees-hex-logo-192.png',
            sizes: '192x192',
            type: 'image/png',
          },
          {
            src: 'ees-hex-logo-512.png',
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
