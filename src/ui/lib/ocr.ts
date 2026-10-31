/**
 * Local text recognition for JPG/PNG photos of bills, using tesseract.js entirely in the browser.
 * Every asset (worker script, WebAssembly core and English language data) is served from Due's own origin
 * under /ocr/ (copied at build time by the `due-ocr-assets` Vite plugin); nothing is fetched from a CDN and
 * the image never leaves the device. The recognised text is redacted before anything reads or shows it.
 */
import { redactSensitive, type Redaction } from '../../lib/sensitive';

export const OCR_FAILED =
  'Due couldn’t read text from this photo on your device. Try a sharper, well-lit photo, upload a PDF, paste the text, or add it manually.';

export const OCR_EMPTY =
  'No readable text was found in this photo. Try a sharper, well-lit photo, paste the text, or add it manually.';

export interface OcrAssets {
  workerPath?: string;
  corePath?: string;
  langPath?: string;
}

export type OcrResult =
  | { ok: true; text: string; redactions: Redaction[]; confidence: number }
  | { ok: false; reason: 'failed' | 'empty'; message: string };

/** Same-origin asset locations used in the browser build. */
export function browserOcrAssets(base = '/'): Required<OcrAssets> {
  const b = base.endsWith('/') ? base : `${base}/`;
  return {
    workerPath: `${b}ocr/worker.min.js`,
    corePath: `${b}ocr/core`,
    langPath: `${b}ocr/lang`,
  };
}

interface OcrWorker {
  recognize: (i: never) => Promise<{ data: { text: string; confidence: number } }>;
  terminate: () => Promise<unknown>;
}

type ImageInput = Blob | ArrayBuffer | Uint8Array | string;

/**
 * Recognises English text in an image and returns it already redacted (Aadhaar, PAN, card numbers, card security codes,
 * OTPs and similar are masked by redactSensitive). `assets` overrides the asset paths (tests use local
 * files); omitted keys use tesseract.js defaults, which only apply outside the browser build.
 */
/** Upper bound for one recognition (worker start, language data and recognition). */
export const OCR_TIMEOUT_MS = 120_000;

export interface OcrOptions {
  /** Defaults to OCR_TIMEOUT_MS. A worker that cannot start (e.g. WebAssembly blocked) never answers otherwise. */
  timeoutMs?: number;
  /** tesseract.js language-data cache; tests pass 'none' so nothing is written to disk. */
  cacheMethod?: 'write' | 'readOnly' | 'refresh' | 'none';
}

export async function recognizeImage(
  image: ImageInput,
  assets: OcrAssets = browserOcrAssets(),
  onProgress?: (p: number) => void,
  opts: OcrOptions = {},
): Promise<OcrResult> {
  const held: { worker: OcrWorker | null; timedOut: boolean } = { worker: null, timedOut: false };
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      held.timedOut = true;
      reject(new Error('ocr_timeout'));
    }, opts.timeoutMs ?? OCR_TIMEOUT_MS);
  });
  try {
    return await Promise.race([run(), deadline]);
  } catch {
    return { ok: false, reason: 'failed', message: OCR_FAILED };
  } finally {
    clearTimeout(timer);
    if (held.worker) await held.worker.terminate().catch(() => undefined);
  }

  async function run(): Promise<OcrResult> {
    const { createWorker, OEM } = await import('tesseract.js');
    const options: Record<string, unknown> = {
      // A same-origin script URL (not a blob) so a strict worker-src CSP still allows it.
      workerBlobURL: false,
      // Rejections already reach the awaiting call; without a handler tesseract.js also throws globally.
      errorHandler: () => undefined,
      logger: (m: { status: string; progress: number }) => {
        if (m.status === 'recognizing text') onProgress?.(m.progress);
      },
    };
    for (const k of ['workerPath', 'corePath', 'langPath'] as const)
      if (assets[k]) options[k] = assets[k];
    if (opts.cacheMethod) options.cacheMethod = opts.cacheMethod;
    const worker = (await createWorker('eng', OEM.LSTM_ONLY, options)) as unknown as OcrWorker;
    // A worker that finished starting after the deadline is stopped straight away.
    if (held.timedOut) {
      await worker.terminate().catch(() => undefined);
      throw new Error('ocr_timeout');
    }
    held.worker = worker;
    const input = image instanceof Uint8Array ? toNodeBuffer(image) : image;
    const { data } = await worker.recognize(input as never);
    const raw = (data.text ?? '').replace(/[ \t]+\n/g, '\n').trim();
    if (!raw) return { ok: false, reason: 'empty', message: OCR_EMPTY };
    const red = redactSensitive(raw);
    return {
      ok: true,
      text: red.text,
      redactions: red.redactions,
      confidence: data.confidence ?? 0,
    };
  }
}

function toNodeBuffer(u: Uint8Array): unknown {
  const B = (globalThis as { Buffer?: { from: (u: Uint8Array) => unknown } }).Buffer;
  return B ? B.from(u) : u;
}
