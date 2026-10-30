import { useState, type ChangeEvent } from 'react';
import { addImportItems, importItemsFromCsv, type ImportItem } from '../../lib/imports';
import { CSV_TEMPLATE, MAX_CSV_BYTES } from '../../lib/csv';
import { exportCSV } from '../../lib/data';
import { useApp } from '../store';
import { Field, Notice } from '../components/ui';
import { download } from '../common';
import { nav } from '../lib/nav';

/** CSV rows go into the review queue (not straight into the list). */
export function CsvScreen() {
  const { data, mutate, ctx, current } = useApp();
  const [text, setText] = useState('');
  const [parsed, setParsed] = useState<{ items: ImportItem[]; errors: string[] } | null>(null);

  const onFile = async (e: ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    e.target.value = '';
    if (!f) return;
    if (f.size > MAX_CSV_BYTES) {
      setParsed({ items: [], errors: ['This file is larger than 1 MB.'] });
      return;
    }
    const t = await f.text();
    setText(t);
    setParsed(importItemsFromCsv(current(), t, new Date().toISOString()));
  };

  return (
    <div className="page2">
      <header className="page-head">
        <h1>Import a CSV</h1>
        <p className="muted">
          Columns: type, provider, nickname, amount, frequency, next_due, importance, notes. Rows go
          to the review queue first. The file is read in this browser.
        </p>
      </header>
      <section className="panel2 stack-16">
        <label className="btn btn-primary press file-btn">
          <input
            type="file"
            accept=".csv,text/csv"
            className="sr-only"
            onChange={onFile}
            aria-label="Choose a CSV file"
          />
          Choose CSV file
        </label>
        <Field label="Or paste CSV" htmlFor="csv-ta">
          <textarea id="csv-ta" rows={5} value={text} onChange={(e) => setText(e.target.value)} />
        </Field>
        <div className="btn-row">
          <button
            type="button"
            className="btn btn-secondary press"
            disabled={!text.trim()}
            onClick={() => setParsed(importItemsFromCsv(current(), text, new Date().toISOString()))}
          >
            Check rows
          </button>
          <button
            type="button"
            className="btn btn-quiet press"
            onClick={() => download('due-template.csv', CSV_TEMPLATE, 'text/csv')}
          >
            Download template
          </button>
          <button
            type="button"
            className="btn btn-quiet press"
            onClick={() => download('due-export.csv', exportCSV(data), 'text/csv')}
          >
            Export my list (CSV)
          </button>
        </div>
      </section>
      {parsed && (
        <section className="stack-16" aria-live="polite">
          {parsed.errors.length > 0 && (
            <Notice tone="warn" title="Some rows can’t be imported">
              <ul className="errors2">
                {parsed.errors.map((e) => (
                  <li key={e}>{e}</li>
                ))}
              </ul>
            </Notice>
          )}
          <p>
            {parsed.items.length} row{parsed.items.length === 1 ? '' : 's'} ready for review.
          </p>
          <button
            type="button"
            className="btn btn-primary press"
            disabled={!parsed.items.length}
            onClick={() => {
              const r = mutate((d) =>
                addImportItems(
                  d,
                  parsed.items.map((item) => ({ item })),
                  ctx(),
                ),
              );
              if (r) nav.go({ name: 'import' });
            }}
          >
            Add to review queue
          </button>
        </section>
      )}
    </div>
  );
}
