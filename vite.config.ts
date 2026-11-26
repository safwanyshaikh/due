/// <reference types="vitest/config" />
import { createReadStream, existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, loadEnv, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';

const root = dirname(fileURLToPath(import.meta.url));
const nm = (p: string) => join(root, 'node_modules', p);

/**
 * Self-hosted OCR assets: tesseract.js would otherwise fetch its worker, WebAssembly core and language data
 * from a CDN at runtime. These are served from our own origin under /ocr/ (dev) and copied into dist/ocr/
 * (build), so photo text recognition makes no third-party request.
 */
export const OCR_ASSETS: Record<string, string> = {
  'ocr/worker.min.js': nm('tesseract.js/dist/worker.min.js'),
  'ocr/core/tesseract-core-lstm.wasm.js': nm('tesseract.js-core/tesseract-core-lstm.wasm.js'),
  'ocr/core/tesseract-core-simd-lstm.wasm.js': nm(
    'tesseract.js-core/tesseract-core-simd-lstm.wasm.js',
  ),
  'ocr/core/tesseract-core-relaxedsimd-lstm.wasm.js': nm(
    'tesseract.js-core/tesseract-core-relaxedsimd-lstm.wasm.js',
  ),
  'ocr/lang/eng.traineddata.gz': nm('@tesseract.js-data/eng/4.0.0_best_int/eng.traineddata.gz'),
};

function ocrAssets(): Plugin {
  return {
    name: 'due-ocr-assets',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const path = (req.url ?? '').split('?')[0].replace(/^\//, '');
        const file = OCR_ASSETS[path];
        if (!file || !existsSync(file)) return next();
        res.setHeader(
          'Content-Type',
          path.endsWith('.js') ? 'text/javascript' : 'application/octet-stream',
        );
        createReadStream(file).pipe(res);
      });
    },
    generateBundle() {
      for (const [fileName, file] of Object.entries(OCR_ASSETS)) {
        if (!existsSync(file)) this.error(`OCR asset missing: ${file} (run npm install)`);
        this.emitFile({ type: 'asset', fileName, source: readFileSync(file) });
      }
    },
  };
}

/**
 * Content Security Policy for the native (Capacitor) build (M10). The web build gets its CSP as an HTTP header
 * from the Due server; inside the app's WebView there is no server, so the policy goes in a <meta> tag. Only the
 * app's own files and the Due API origin are allowed (no inline scripts, no third-party origins).
 * frame-ancestors cannot be set in a meta tag; the WebView does not embed the app in frames anyway.
 */
export function nativeCsp(apiOrigin: string): string {
  const api = apiOrigin.trim().replace(/\/+$/, '');
  if (api && !/^https:\/\/[A-Za-z0-9.-]+(:\d+)?$/.test(api)) {
    throw new Error(`VITE_API_ORIGIN must be an https origin for the native build, got "${api}"`);
  }
  return [
    "default-src 'self'",
    "script-src 'self' 'wasm-unsafe-eval'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    `connect-src 'self'${api ? ` ${api}` : ''}`,
    "worker-src 'self' blob:",
    "manifest-src 'self'",
    "media-src 'self' blob:",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'none'",
  ].join('; ');
}

function nativeCspMeta(mode: string, apiOrigin: string): Plugin {
  return {
    name: 'due-native-csp',
    transformIndexHtml(html) {
      if (mode !== 'native') return html;
      const tag = `<meta http-equiv="Content-Security-Policy" content="${nativeCsp(apiOrigin)}" />`;
      return html.replace('<meta charset="UTF-8" />', `<meta charset="UTF-8" />\n    ${tag}`);
    },
  };
}

export default defineConfig(({ mode }) => ({
  plugins: [
    react(),
    ocrAssets(),
    nativeCspMeta(mode, loadEnv(mode, root, 'VITE_').VITE_API_ORIGIN ?? loadEnv(mode, root, 'VITE_').VITE_API_BASE ?? ''),
  ],
  test: {
    environment: 'node',
    include: ['src/**/*.test.{ts,tsx}'],
  },
}));
