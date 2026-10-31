/// <reference types="vitest/config" />
import { createReadStream, existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, type Plugin } from 'vite';
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

export default defineConfig({
  plugins: [react(), ocrAssets()],
  test: {
    environment: 'node',
    include: ['src/**/*.test.{ts,tsx}'],
  },
});
