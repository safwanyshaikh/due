/**
 * Reads text from a user-chosen file entirely in the browser. Nothing is uploaded.
 * PDFs use pdf.js with its worker served from Due's own origin (bundled by Vite). JPG/PNG photos use
 * on-device OCR (tesseract.js, assets self-hosted under /ocr/); the recognised text is redacted first.
 */
import type { Redaction } from '../../lib/sensitive';
import { recognizeImage, browserOcrAssets } from './ocr';

export type DocumentRead =
  | { ok: true; text: string; pages?: number; ocr?: boolean; redactions?: Redaction[] }
  | {
      ok: false;
      reason: 'ocr_failed' | 'unsupported' | 'empty' | 'unreadable';
      message: string;
    };

export const ACCEPTED_TYPES =
  '.pdf,.jpg,.jpeg,.png,.txt,application/pdf,image/jpeg,image/png,text/plain';

export const PHOTO_NOTE =
  'Photos are read with text recognition on this device. Results can be imperfect, so check every field';

function baseUrl(): string {
  try {
    return (import.meta.env?.BASE_URL as string | undefined) ?? '/';
  } catch {
    return '/';
  }
}

export const MAX_FILE_BYTES = 15 * 1024 * 1024;

function kindOf(file: File): 'pdf' | 'image' | 'text' | 'other' {
  const name = file.name.toLowerCase();
  if (file.type === 'application/pdf' || name.endsWith('.pdf')) return 'pdf';
  if (/^image\/(jpeg|png)$/.test(file.type) || /\.(jpe?g|png)$/.test(name)) return 'image';
  if (file.type === 'text/plain' || name.endsWith('.txt')) return 'text';
  return 'other';
}

async function readPdf(buf: ArrayBuffer): Promise<{ text: string; pages: number }> {
  const [pdfjs, worker] = await Promise.all([
    import('pdfjs-dist'),
    import('pdfjs-dist/build/pdf.worker.min.mjs?url'),
  ]);
  pdfjs.GlobalWorkerOptions.workerSrc = worker.default;
  const task = pdfjs.getDocument({ data: new Uint8Array(buf) });
  const doc = await task.promise;
  const parts: string[] = [];
  const max = Math.min(doc.numPages, 30);
  for (let i = 1; i <= max; i++) {
    const page = await doc.getPage(i);
    const content = await page.getTextContent();
    let line = '';
    for (const it of content.items) {
      if (!('str' in it)) continue;
      line += it.str;
      if (it.hasEOL) {
        parts.push(line);
        line = '';
      } else line += ' ';
    }
    if (line.trim()) parts.push(line);
    parts.push('');
  }
  const pages = doc.numPages;
  await task.destroy();
  return {
    text: parts
      .join('\n')
      .replace(/[ \t]+\n/g, '\n')
      .trim(),
    pages,
  };
}

export async function readDocumentText(
  file: File,
  onProgress?: (p: number) => void,
): Promise<DocumentRead> {
  if (file.size > MAX_FILE_BYTES)
    return { ok: false, reason: 'unsupported', message: 'This file is larger than 15 MB.' };
  const kind = kindOf(file);
  if (kind === 'image') {
    const r = await recognizeImage(file, browserOcrAssets(baseUrl()), onProgress);
    return r.ok
      ? { ok: true, text: r.text, ocr: true, redactions: r.redactions }
      : { ok: false, reason: r.reason === 'empty' ? 'empty' : 'ocr_failed', message: r.message };
  }
  if (kind === 'other')
    return {
      ok: false,
      reason: 'unsupported',
      message: 'Choose a PDF, JPG, PNG or TXT file, or paste the text instead.',
    };
  try {
    if (kind === 'text') {
      const text = (await file.text()).trim();
      return text
        ? { ok: true, text }
        : { ok: false, reason: 'empty', message: 'This file has no text in it.' };
    }
    const { text, pages } = await readPdf(await file.arrayBuffer());
    if (!text)
      return {
        ok: false,
        reason: 'empty',
        message:
          'This PDF has no selectable text (it may be a scan). Paste the text or add it manually.',
      };
    return { ok: true, text, pages };
  } catch {
    return {
      ok: false,
      reason: 'unreadable',
      message:
        'This file couldn’t be read. It may be protected or damaged. Paste the text instead.',
    };
  }
}
