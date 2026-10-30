import { useId, useState, type ChangeEvent } from 'react';
import { importItemFromText, type ImportItem } from '../../lib/imports';
import { exportStructuredRecord, organiseSharedSms, type UserEvent } from '../../lib/intake';
import { redactSensitive, type Redaction } from '../../lib/sensitive';
import { formatDate } from '../../lib/dates';
import { UPLOAD_NOTE } from '../../content/privacy';
import { useApp } from '../store';
import { useToast } from '../components/Toast';
import { ReviewCard } from '../components/ReviewCard';
import { useImportActions } from '../components/importActions';
import { Badge, Field, Notice } from '../components/ui';
import { download } from '../common';
import { ACCEPTED_TYPES, IMAGE_UNAVAILABLE, readDocumentText } from '../lib/documentText';
import { inr } from '../lib/format';
import { nav } from '../lib/nav';

interface Draft {
  item: ImportItem;
  userEvent: UserEvent;
  redactions: Redaction[];
  origin: string;
}

function mergeRedactions(a: Redaction[], b: Redaction[] = []): Redaction[] {
  const m = new Map<string, number>();
  for (const r of [...a, ...b]) m.set(r.kind, Math.max(m.get(r.kind) ?? 0, r.count));
  return [...m.entries()].map(([kind, count]) => ({ kind, count }) as Redaction);
}

/** Redacts first, then extracts. Nothing is stored until the user confirms. */
function useDraftBuilder() {
  const { current } = useApp();
  return (
    text: string,
    kind: 'document' | 'receipt_text' | 'shared_sms',
    origin: string,
    file?: { name: string; type: string },
  ): Draft => {
    const red = redactSensitive(text);
    const { item, userEvent } = importItemFromText(current(), {
      kind,
      text: red.text,
      receivedAt: new Date().toISOString(),
      ...(file ? { fileName: file.name, mimeType: file.type || undefined } : {}),
    });
    return {
      item,
      userEvent,
      redactions: mergeRedactions(red.redactions, item.redactions),
      origin,
    };
  };
}

function DraftReview({
  draft,
  onDone,
  deleteLabel,
}: {
  draft: Draft;
  onDone: (message: string) => void;
  deleteLabel: string;
}) {
  const actions = useImportActions();
  const unreadable = draft.userEvent.reviewStatus === 'unreadable';
  return (
    <div className="stack-16">
      <Notice tone="ok" title={`Read ${draft.origin}`}>
        {draft.redactions.length ? (
          <>
            Masked before reading:{' '}
            {draft.redactions.map((r) => `${r.count} ${r.kind.replace(/_/g, ' ')}`).join(', ')}.
          </>
        ) : (
          'No sensitive numbers were found to mask.'
        )}{' '}
        Nothing has been saved yet.
      </Notice>
      {unreadable && (
        <Notice tone="warn" title="No planning details found">
          Due couldn’t find a provider, amount or date in this text. You can edit the fields below,
          or <a href="#/add">add it manually</a>.
        </Notice>
      )}
      <ReviewCard
        item={draft.item}
        userEvent={draft.userEvent}
        actions={{
          confirmLabel: 'Confirm and save',
          onConfirm: (edits, opts) => {
            if (actions.confirmDraft(draft.item, draft.userEvent, edits, opts))
              nav.go({ name: 'home' });
          },
          onIgnore: () => onDone('Ignored. Nothing was saved.'),
          onDelete: () => onDone('Document removed from this browser. Nothing was saved.'),
          deleteLabel,
          onExport: () =>
            download(
              `due-record-${draft.item.id}.json`,
              exportStructuredRecord(draft.userEvent, { exportedAt: new Date().toISOString() }),
              'application/json',
            ),
        }}
      />
      <button
        type="button"
        className="btn btn-quiet press"
        onClick={() => {
          if (actions.queueDraft(draft.item, draft.userEvent)) nav.go({ name: 'import' });
        }}
      >
        Decide later (keep in review queue)
      </button>
    </div>
  );
}

export function UploadScreen() {
  const toast = useToast();
  const build = useDraftBuilder();
  const id = useId();
  const [phase, setPhase] = useState<'choose' | 'reading' | 'review'>('choose');
  const [draft, setDraft] = useState<Draft | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [pasted, setPasted] = useState('');

  const onFile = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setProblem(null);
    setPhase('reading');
    const r = await readDocumentText(file);
    if (!r.ok) {
      setProblem(r.message);
      setPhase('choose');
      return;
    }
    setDraft(
      build(
        r.text,
        'document',
        `${file.name}${r.pages ? ` (${r.pages} page${r.pages === 1 ? '' : 's'})` : ''}`,
        {
          name: file.name,
          type: file.type,
        },
      ),
    );
    setPhase('review');
  };

  const reset = (message: string) => {
    setDraft(null);
    setPasted('');
    setPhase('choose');
    toast.show({ message });
  };

  return (
    <div className="page2">
      <header className="page-head">
        <h1>Upload a bill or sanction letter</h1>
        <p className="muted">{UPLOAD_NOTE}</p>
      </header>

      {phase !== 'review' && (
        <>
          <section className="panel2 stack-16" aria-labelledby={`${id}-file`}>
            <h2 id={`${id}-file`}>Choose a file</h2>
            <p className="muted small">PDF, JPG, PNG or TXT, up to 15 MB.</p>
            <label className="btn btn-primary press file-btn">
              <input
                type="file"
                accept={ACCEPTED_TYPES}
                onChange={onFile}
                className="sr-only"
                aria-label="Choose a PDF, JPG, PNG or TXT file"
              />
              {phase === 'reading' ? 'Reading…' : 'Choose file'}
            </label>
            <p className="muted small">
              <Badge>Photos</Badge> {IMAGE_UNAVAILABLE}.
            </p>
            {problem && <Notice tone="warn">{problem}</Notice>}
          </section>

          <section className="panel2 stack-16" aria-labelledby={`${id}-paste`}>
            <h2 id={`${id}-paste`}>Or paste the text</h2>
            <Field label="Bill, letter or receipt text" htmlFor={`${id}-ta`}>
              <textarea
                id={`${id}-ta`}
                rows={6}
                value={pasted}
                onChange={(e) => setPasted(e.target.value)}
                placeholder="Paste the part with the amount and date"
              />
            </Field>
            <button
              type="button"
              className="btn btn-secondary press"
              disabled={!pasted.trim()}
              onClick={() => {
                setDraft(build(pasted, 'receipt_text', 'pasted text'));
                setPhase('review');
              }}
            >
              Organise this text
            </button>
          </section>
          <a className="btn btn-quiet press" href="#/add">
            Add it manually instead
          </a>
        </>
      )}

      {phase === 'review' && draft && (
        <DraftReview draft={draft} onDone={reset} deleteLabel="Delete document" />
      )}
    </div>
  );
}

export function SmsScreen() {
  const toast = useToast();
  const build = useDraftBuilder();
  const [text, setText] = useState('');
  const [draft, setDraft] = useState<Draft | null>(null);
  const [found, setFound] = useState<string[]>([]);

  return (
    <div className="page2">
      <header className="page-head">
        <h1>Share one SMS</h1>
        <p className="muted">
          Paste a single bill or renewal SMS. Due doesn’t ask for SMS access and never reads your
          messages. OTPs and card numbers are masked before anything is read.
        </p>
      </header>
      {!draft ? (
        <section className="panel2 stack-16">
          <Field label="SMS text" htmlFor="sms-ta">
            <textarea id="sms-ta" rows={5} value={text} onChange={(e) => setText(e.target.value)} />
          </Field>
          <button
            type="button"
            className="btn btn-primary press"
            disabled={!text.trim()}
            onClick={() => {
              const red = redactSensitive(text);
              const sms = organiseSharedSms(red.text);
              const bits: string[] = [];
              if (sms.provider) bits.push(`provider ${sms.provider.value}`);
              if (sms.amount) bits.push(`amount ${inr(sms.amount.value)}`);
              if (sms.dueDate) bits.push(`date ${formatDate(sms.dueDate.value)}`);
              if (sms.reference) bits.push(`reference ${sms.reference.value}`);
              setFound(bits);
              setDraft(build(text, 'shared_sms', 'your SMS'));
            }}
          >
            Organise this SMS
          </button>
        </section>
      ) : (
        <>
          <p className="muted small">
            Found: {found.length ? found.join(', ') : 'no planning details'}.
          </p>
          <DraftReview
            draft={draft}
            deleteLabel="Delete pasted SMS"
            onDone={(m) => {
              setDraft(null);
              setText('');
              toast.show({ message: m });
            }}
          />
        </>
      )}
    </div>
  );
}
