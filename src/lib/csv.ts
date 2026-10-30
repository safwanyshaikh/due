import { isValidISO } from './dates';
import { findDuplicates } from './duplicates';
import { parseRupees } from './money';
import { blockedHeader, looksSensitive } from './sensitive';
import type { Commitment, CommitmentType, Frequency, Importance } from './types';
import { TYPES } from './status';

export const MAX_CSV_BYTES = 1_000_000;
export const MAX_CSV_ROWS = 500;

export function parseCSV(text: string): string[][] {
  const src = text.replace(/^\uFEFF/, '');
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let inQ = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (inQ) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          cell += '"';
          i++;
        } else inQ = false;
      } else cell += ch;
    } else if (ch === '"') inQ = true;
    else if (ch === ',') {
      row.push(cell);
      cell = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i++;
      row.push(cell);
      cell = '';
      if (row.some((c) => c.trim() !== '')) rows.push(row);
      row = [];
    } else cell += ch;
  }
  row.push(cell);
  if (row.some((c) => c.trim() !== '')) rows.push(row);
  return rows;
}

export interface PreviewRow {
  line: number;
  candidate: ImportCandidate | null;
  errors: string[];
  duplicateOf: string[];
}

export interface ImportCandidate {
  type: CommitmentType;
  provider: string;
  nickname: string;
  amountPaise: number | null;
  frequency: Frequency;
  nextDue: string;
  importance: Importance;
  notes: string;
}

export interface CsvPreview {
  rows: PreviewRow[];
  fileErrors: string[];
  ignoredColumns: string[];
}

const KNOWN = [
  'type',
  'provider',
  'nickname',
  'amount',
  'frequency',
  'next_due',
  'importance',
  'notes',
];
const FREQS: Frequency[] = ['one_time', 'monthly', 'quarterly', 'half_yearly', 'annual'];
const IMPS: Importance[] = ['essential', 'important', 'optional'];

export const CSV_TEMPLATE =
  'type,provider,nickname,amount,frequency,next_due,importance,notes\n' +
  'subscription,Example Streaming,Movies,499,monthly,2026-12-05,optional,Sample row\n';

export function previewCSV(text: string, existing: Commitment[]): CsvPreview {
  const fileErrors: string[] = [];
  if (text.length > MAX_CSV_BYTES)
    return { rows: [], fileErrors: ['File is too large (limit about 1 MB).'], ignoredColumns: [] };
  const table = parseCSV(text);
  if (table.length < 2)
    return { rows: [], fileErrors: ['No data rows found.'], ignoredColumns: [] };
  const header = table[0].map((h) => h.trim().toLowerCase());
  const blocked = header.filter(blockedHeader);
  if (blocked.length) {
    return {
      rows: [],
      fileErrors: [
        `This file has columns we never accept (${blocked.join(', ')}). Remove them and try again. We do not store card numbers, PINs, passwords, PAN or Aadhaar.`,
      ],
      ignoredColumns: [],
    };
  }
  const ignoredColumns = header.filter((h) => !KNOWN.includes(h));
  if (table.length - 1 > MAX_CSV_ROWS)
    fileErrors.push(`Only the first ${MAX_CSV_ROWS} rows are shown.`);
  const idx = (name: string) => header.indexOf(name);
  const rows: PreviewRow[] = [];
  const seen: Commitment[] = [...existing];
  table.slice(1, MAX_CSV_ROWS + 1).forEach((cells, i) => {
    const get = (name: string) => (idx(name) >= 0 ? (cells[idx(name)] ?? '').trim() : '');
    const errors: string[] = [];
    const type = get('type').toLowerCase() as CommitmentType;
    if (!TYPES.includes(type)) errors.push(`Type must be one of: ${TYPES.join(', ')}.`);
    const provider = get('provider');
    if (!provider) errors.push('Provider is required.');
    const amountRaw = get('amount');
    const amountPaise = amountRaw === '' ? null : parseRupees(amountRaw);
    if (amountRaw !== '' && amountPaise === null) errors.push('Amount is not a valid rupee value.');
    const frequency = (get('frequency').toLowerCase() || 'monthly') as Frequency;
    if (!FREQS.includes(frequency)) errors.push(`Frequency must be one of: ${FREQS.join(', ')}.`);
    const nextDue = get('next_due');
    if (!isValidISO(nextDue)) errors.push('next_due must be a valid date as YYYY-MM-DD.');
    const impRaw = (get('importance').toLowerCase() || 'important') as Importance;
    if (!IMPS.includes(impRaw)) errors.push(`Importance must be one of: ${IMPS.join(', ')}.`);
    const nickname = get('nickname');
    const notes = get('notes');
    for (const t of [provider, nickname, notes]) {
      const p = looksSensitive(t);
      if (p) {
        errors.push(p);
        break;
      }
    }
    if (errors.length) {
      rows.push({ line: i + 2, candidate: null, errors, duplicateOf: [] });
      return;
    }
    const candidate: ImportCandidate = {
      type,
      provider,
      nickname,
      amountPaise,
      frequency,
      nextDue,
      importance: impRaw,
      notes,
    };
    const dups = findDuplicates({ provider, type, amountPaise }, seen).map(
      (d) => d.nickname || d.provider,
    );
    rows.push({ line: i + 2, candidate, errors: [], duplicateOf: dups });
    // Suggest-only: rows within the same file also count as potential duplicates for later rows.
    seen.push({ provider, type, amountPaise, id: `csv-${i}` } as Commitment);
  });
  return { rows, fileErrors, ignoredColumns };
}
