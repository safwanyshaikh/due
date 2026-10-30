import { useState } from 'react';
import { useApp } from './store';
import { Card, download, inr } from './common';
import type { Nav } from './App';
import { CSV_TEMPLATE, MAX_CSV_BYTES, previewCSV, type CsvPreview } from '../lib/csv';
import { importCandidates } from '../lib/data';

export function ImportView({ nav }: { nav: Nav }) {
  const { data, today, update } = useApp();
  const [preview, setPreview] = useState<CsvPreview | null>(null);
  const [picked, setPicked] = useState<Set<number>>(new Set());

  async function onFile(f: File | undefined) {
    if (!f) return;
    if (f.size > MAX_CSV_BYTES)
      return setPreview({
        rows: [],
        fileErrors: ['File is too large (limit about 1 MB).'],
        ignoredColumns: [],
      });
    const text = await f.text();
    const p = previewCSV(text, data.commitments);
    setPreview(p);
    setPicked(
      new Set(p.rows.filter((r) => r.candidate && r.duplicateOf.length === 0).map((r) => r.line)),
    );
  }

  function confirm() {
    if (!preview) return;
    const chosen = preview.rows
      .filter((r) => r.candidate && picked.has(r.line))
      .map((r) => r.candidate!);
    update((d) => importCandidates(d, chosen, today));
    nav.go({ name: 'home' });
  }

  return (
    <>
      <button className="link" onClick={nav.back}>
        ‹ Back
      </button>
      <h1>Import from CSV</h1>
      <p className="muted">
        Choose a file from your device. It is read in your browser only; the file itself is not
        uploaded or kept. You will preview every row first. Do not include card numbers, PINs,
        passwords, PAN or Aadhaar.
      </p>
      <div className="actions">
        <button onClick={() => download('template.csv', CSV_TEMPLATE, 'text/csv')}>
          Download template
        </button>
      </div>
      <input
        type="file"
        accept=".csv,text/csv"
        onChange={(e) => void onFile(e.target.files?.[0])}
        aria-label="Choose CSV file"
      />
      {preview?.fileErrors.map((e) => (
        <p key={e} className="errors" role="alert">
          {e}
        </p>
      ))}
      {preview && preview.ignoredColumns.length > 0 && (
        <p className="muted">Ignored columns: {preview.ignoredColumns.join(', ')}</p>
      )}
      {preview && preview.rows.length > 0 && (
        <Card title="Preview. Nothing is saved until you confirm.">
          {preview.rows.map((r) => (
            <div key={r.line} className="row-static">
              {r.candidate ? (
                <label className="check">
                  <input
                    type="checkbox"
                    checked={picked.has(r.line)}
                    onChange={(e) => {
                      const n = new Set(picked);
                      if (e.target.checked) n.add(r.line);
                      else n.delete(r.line);
                      setPicked(n);
                    }}
                  />
                  <span>
                    Row {r.line}: {r.candidate.nickname || r.candidate.provider} ·{' '}
                    {r.candidate.type} ·{' '}
                    {r.candidate.amountPaise === null
                      ? 'amount not entered'
                      : inr(r.candidate.amountPaise)}{' '}
                    · {r.candidate.frequency} · {r.candidate.nextDue}
                    {r.duplicateOf.length > 0 && (
                      <em>
                        {' '}
                        · may duplicate: {r.duplicateOf.join(', ')} (suggestion only; tick it if it
                        is separate)
                      </em>
                    )}
                  </span>
                </label>
              ) : (
                <p className="errors">
                  Row {r.line} can’t be imported: {r.errors.join(' ')}
                </p>
              )}
            </div>
          ))}
          <div className="actions">
            <button className="primary" onClick={confirm} disabled={picked.size === 0}>
              Import {picked.size} row(s)
            </button>
          </div>
        </Card>
      )}
    </>
  );
}
