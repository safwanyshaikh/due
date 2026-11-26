import { useEffect, useRef, useState } from 'react';
import type { Move } from '../../lib/savings/types';
import {
  COMMUNITY_NOTE,
  RESEARCH_NOTE,
  SAVINGS_INFO_NOTE,
  UNVERIFIED_PRICE,
} from '../../content/savings';
import { Badge } from '../components/ui';
import { Glyph } from '../components/Glyph';
import { useT } from '../lib/lang';
import { useSavings } from './SavingsProvider';
import { MoveSheet } from './MoveSheet';
import { CommuteSetup } from './CommuteSetup';
import { loadCommunity, profileEdits, sendResearch, unsent, type CommunityRow } from './engine';
import { CONFIDENCE_LABEL, CONFIDENCE_TONE, perMonth, rupees } from './format';
import { useApp } from '../store';
import { runRate } from '../../lib/totals';
import { useToast } from '../components/Toast';
import { buildShareText } from './shareCard';
import { findProfile, gstNoteFor, profilesOf, PERSONAL_PROFILE_ID } from '../../lib/profiles';
import { ProfileSwitcher } from '../profiles/ProfileSwitcher';
import { useProfileSelection } from '../profiles/useProfileSelection';
import './savings.css';

function MoveRow({
  m,
  rank,
  onOpen,
  done,
  tag = 'Marked done',
  profileName,
}: {
  m: Move;
  rank: number;
  onOpen: () => void;
  done?: boolean;
  tag?: string;
  /** Shown in the "All" view for a business profile's move. */
  profileName?: string | null;
}) {
  return (
    <li>
      <button
        type="button"
        className={`sv-move press jelly ${done ? 'sv-move-done' : ''}`}
        onClick={onOpen}
        data-move={m.id}
      >
        {!done && (
          <span className="sv-rank" aria-hidden="true">
            {rank}
          </span>
        )}
        <span className="sv-move-body">
          <strong className="sv-move-title">{m.title}</strong>
          <span className="sv-move-why muted small">{m.why}</span>
          <span className="chips">
            <Badge tone={CONFIDENCE_TONE[m.confidence]}>{CONFIDENCE_LABEL[m.confidence]}</Badge>
            {m.unverifiedPrice && <Badge tone="warm">{UNVERIFIED_PRICE}</Badge>}
            {done && <Badge tone="calm">{tag}</Badge>}
            {profileName && <Badge>{profileName}</Badge>}
          </span>
        </span>
        {m.severity === 'urgent' ? (
          <span className="sv-move-amt">
            <Badge tone="warm">Urgent</Badge>
          </span>
        ) : (
          <span className="sv-move-amt amt">
            {rupees(m.monthlySavingInr)}
            <span className="muted small">/month</span>
          </span>
        )}
      </button>
    </li>
  );
}

/** Sends each new research label once (anonymous, number-free), then remembers it on the device. */
function useResearchSender() {
  const { research, state, edit } = useSavings();
  const sending = useRef(new Set<string>());
  const cityPack = state.profile.cityPack;
  useEffect(() => {
    const fresh = unsent(research, state).filter((r) => !sending.current.has(r.providerLabel));
    for (const r of fresh) {
      sending.current.add(r.providerLabel);
      void sendResearch(r, cityPack).then((ok) => {
        if (ok) edit((s) => profileEdits.markSent(s, [r.providerLabel]));
      });
    }
  }, [research, state, cityPack, edit]);
}

/** Aha: one sentence with two rounded numbers, no names, shared only when the person taps. */
function ShareNumber({ found }: { found: number }) {
  const { data } = useApp();
  const toast = useToast();
  const yearly = (runRate(data).totalPaise / 100) * 12;
  if (yearly < 1) return null;
  const text = buildShareText(yearly, found);
  const share = async () => {
    try {
      if (typeof navigator !== 'undefined' && typeof navigator.share === 'function') {
        await navigator.share({ text });
        return;
      }
      await navigator.clipboard.writeText(text);
      toast.show({ message: 'Copied. Paste it anywhere.', tone: 'success' });
    } catch {
      /* cancelled or blocked: nothing is sent */
    }
  };
  return (
    <section className="panel2 stack-8" aria-labelledby="sv-share-num-h" data-testid="share-number">
      <h2 id="sv-share-num-h">Share your number</h2>
      <p className="muted small">{text}</p>
      <button type="button" className="btn btn-secondary press align-start" onClick={share}>
        Share, no names
      </button>
    </section>
  );
}

function Community() {
  const { state } = useSavings();
  const cityPack = state.profile.cityPack;
  const [items, setItems] = useState<CommunityRow[]>([]);
  useEffect(() => {
    let live = true;
    void loadCommunity(cityPack).then((r) => {
      if (live) setItems(r);
    });
    return () => {
      live = false;
    };
  }, [cityPack]);
  if (!items.length) return null;
  return (
    <section className="panel2" aria-labelledby="sv-comm-h" data-testid="community">
      <h2 id="sv-comm-h">What others changed</h2>
      <ul className="sv-comm">
        {items.map((i) => (
          <li key={`${i.moveKind}:${i.moduleId ?? ''}`}>
            <strong>{i.label}</strong>
            <span className="muted small">
              {i.reports} people reported · typical {perMonth(i.medianSavedMonthlyInr)}
            </span>
          </li>
        ))}
      </ul>
      <p className="muted small">{COMMUNITY_NOTE}</p>
    </section>
  );
}

export function SavingsScreen() {
  const s = useSavings();
  const t = useT();
  const { data } = useApp();
  const [sel, setSel] = useProfileSelection(data);
  const [openId, setOpenId] = useState<string | null>(null);
  useResearchSender();
  const multi = profilesOf(data).length > 1;
  const inScope = (m: Move) => sel === 'all' || (m.profileId ?? PERSONAL_PROFILE_ID) === sel;
  const open = s.open.filter(inScope);
  const done = s.done.filter(inScope);
  const hidden = s.hidden.filter(inScope);
  const foundMonthlyInr = open.reduce((n, m) => n + m.monthlySavingInr, 0);
  const scopedMoveIds = new Set(s.all.filter(inScope).map((m) => m.id));
  const savedMonthlyInr =
    sel === 'all'
      ? s.savedMonthlyInr
      : s.ledger
          .filter((l) => scopedMoveIds.has(l.moveId))
          .reduce((n, l) => n + (l.savedMonthlyInr ?? 0), 0);
  const badge = (m: Move) => {
    if (!multi || sel !== 'all') return null;
    const p = findProfile(data, m.profileId ?? PERSONAL_PROFILE_ID);
    return p && p.kind === 'business' ? p.name : null;
  };
  const current = s.all.find((m) => m.id === openId) ?? null;
  // The open move can disappear (an edited assumption removes the saving): close the sheet for good
  // so it does not pop open again later, and keep keyboard focus on the page.
  if (openId && !current) setOpenId(null);
  const movesHead = useRef<HTMLHeadingElement>(null);
  const wasOpen = useRef(false);
  useEffect(() => {
    if (openId) {
      wasOpen.current = true;
      return;
    }
    if (!wasOpen.current) return;
    wasOpen.current = false;
    // The row that opened the sheet may be gone (moved to "You did these", or removed).
    const a = document.activeElement;
    if (!a || a === document.body) movesHead.current?.focus();
  }, [openId]);
  const optIn = s.state.profile.communityOptIn;

  return (
    <div className="page2 sv-page">
      <header className="page-head">
        <h1>{t('savings.title')}</h1>
        <p className="muted">
          Moves worked out on this device from your own items. Each one shows what it’s based on.
        </p>
      </header>

      <ProfileSwitcher data={data} value={sel} onChange={setSel} />

      <section
        className={`sv-totals ${open.length > 0 && foundMonthlyInr > 0 ? 'sv-totals-hero' : ''}`}
        aria-label="Savings totals"
        data-testid="savings-totals"
      >
        <div className="sv-total sv-total-found">
          <h2 className="eyebrow">{t('savings.found')}</h2>
          <p className="sv-big amt" data-testid="found-total">
            {rupees(foundMonthlyInr)}
            <span className="per">{t('home.perMonth')}</span>
          </p>
          <p className="muted small">
            {open.length} move{open.length === 1 ? '' : 's'} to look at
          </p>
        </div>
        <div className="sv-total">
          <h2 className="eyebrow">{t('savings.saved')}</h2>
          <p className="sv-big amt" data-testid="saved-total">
            {rupees(savedMonthlyInr)}
            <span className="per">{t('home.perMonth')}</span>
          </p>
          <p className="muted small">Counted once your bills show the change</p>
        </div>
      </section>

      <section className="stack-12" aria-labelledby="sv-moves-h">
        <div className="section-head">
          <h2 id="sv-moves-h" ref={movesHead} tabIndex={-1}>
            Moves, best first
          </h2>
          {s.phase === 'unavailable' && (
            <button type="button" className="text-btn press" onClick={s.refresh}>
              Try again
            </button>
          )}
        </div>
        {s.phase === 'loading' && !s.catalog ? (
          <p className="muted" role="status">
            Loading price information…
          </p>
        ) : !s.catalog ? (
          <p className="muted" role="status">
            Price information isn’t available right now, so no moves can be worked out yet.
          </p>
        ) : open.length ? (
          <ol className="sv-moves" data-testid="moves">
            {open.map((m, i) => (
              <MoveRow
                key={m.id}
                m={m}
                rank={i + 1}
                onOpen={() => setOpenId(m.id)}
                profileName={badge(m)}
              />
            ))}
          </ol>
        ) : (
          <p className="muted">
            Nothing to change right now. Add your subscriptions, recharges, rides or EMIs, or import
            a statement, and Due will check them.
          </p>
        )}
      </section>

      {s.research.length > 0 && (
        <section className="panel2" aria-labelledby="sv-research-h" data-testid="research">
          <h2 id="sv-research-h">No cheaper plan found yet</h2>
          <p className="muted small" data-testid="research-lead">
            No cheaper plan found for {s.research.map((r) => r.providerLabel).join(', ')} yet. That
            is not a judgement on your plan: these are being added to Due’s price list.
          </p>
          <ul className="chip-row" aria-label="Bills being studied">
            {s.research.map((r) => (
              <li key={r.providerLabel}>
                <Badge>{r.providerLabel}</Badge>
              </li>
            ))}
          </ul>
          <p className="muted small">{RESEARCH_NOTE}</p>
        </section>
      )}

      <div className="sv-grid">
        <CommuteSetup />
        <section className="panel2" aria-labelledby="sv-import-h">
          <h2 id="sv-import-h">Import a statement</h2>
          <p className="muted small">
            Paste a bank or card statement, or choose a PDF or CSV. Due finds repeat payments such
            as AutoPay mandates on this device.
          </p>
          <a className="btn btn-secondary press jelly align-start" href="#/savings-import">
            <Glyph name="upload" size={18} /> Find repeat payments
          </a>
        </section>
      </div>

      {done.length > 0 && (
        <section className="stack-12" aria-labelledby="sv-done-h">
          <h2 id="sv-done-h">You did these</h2>
          <ul className="sv-moves">
            {done.map((m, i) => (
              <MoveRow key={m.id} m={m} rank={i + 1} done onOpen={() => setOpenId(m.id)} />
            ))}
          </ul>
        </section>
      )}

      {hidden.length > 0 && (
        <details className="panel2" data-testid="hidden-moves">
          <summary>Hidden moves ({hidden.length})</summary>
          <ul className="sv-moves">
            {hidden.map((m, i) => (
              <MoveRow
                key={m.id}
                m={m}
                rank={i + 1}
                done
                tag="Hidden"
                onOpen={() => setOpenId(m.id)}
              />
            ))}
          </ul>
        </details>
      )}

      <ShareNumber found={foundMonthlyInr} />

      <Community />

      <section className="panel2" aria-labelledby="sv-share-h">
        <h2 id="sv-share-h">Help others</h2>
        <label className="switch-row">
          <input
            type="checkbox"
            checked={optIn}
            onChange={(e) => s.edit((st) => profileEdits.setOptIn(st, e.target.checked))}
          />
          <span>Share anonymous, rounded savings once a change shows on your bills</span>
        </label>
        <p className="muted small">No name, account, provider account or exact amount is sent.</p>
      </section>

      <p className="muted small">{SAVINGS_INFO_NOTE}</p>

      {current && (
        <MoveSheet
          move={current}
          status={s.statusOf(current.id)}
          onClose={() => setOpenId(null)}
          onMark={(st) => {
            s.mark(current, st);
            setOpenId(null);
          }}
          onOverride={(key, value) => s.edit((st) => profileEdits.setOverride(st, key, value))}
          profileNote={gstNoteFor(current, data)}
        />
      )}
    </div>
  );
}
