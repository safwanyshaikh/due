import type { KeyboardEvent } from 'react';
import { profilesOf, type ProfileSelection } from '../../lib/profiles';
import type { AppData } from '../../lib/types';
import './profiles.css';

/**
 * "All · Personal · <Business>" filter. Shown only when there is more than one profile, so a
 * personal-only Home stays exactly as it was. Arrow keys move between choices (radio group).
 */
export function ProfileSwitcher({
  data,
  value,
  onChange,
}: {
  data: Pick<AppData, 'profiles'>;
  value: ProfileSelection;
  onChange: (s: ProfileSelection) => void;
}) {
  const profiles = profilesOf(data);
  if (profiles.length < 2) return null;
  const choices: { id: ProfileSelection; label: string }[] = [
    { id: 'all', label: 'All' },
    ...profiles.map((p) => ({ id: p.id, label: p.name })),
  ];
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const i = choices.findIndex((c) => c.id === value);
    const step =
      e.key === 'ArrowRight' || e.key === 'ArrowDown'
        ? 1
        : e.key === 'ArrowLeft' || e.key === 'ArrowUp'
          ? -1
          : 0;
    if (!step) return;
    e.preventDefault();
    const next = choices[(i + step + choices.length) % choices.length];
    onChange(next.id);
    const btn = e.currentTarget.querySelector<HTMLButtonElement>(`[data-profile="${next.id}"]`);
    btn?.focus();
  };
  return (
    <div
      className="pf-switch"
      role="radiogroup"
      aria-label="Show dues for"
      data-testid="profile-switcher"
      onKeyDown={onKey}
    >
      {choices.map((c) => (
        <button
          key={c.id}
          type="button"
          role="radio"
          aria-checked={value === c.id}
          tabIndex={value === c.id ? 0 : -1}
          className="chip-btn press"
          data-profile={c.id}
          onClick={() => onChange(c.id)}
        >
          {c.label}
        </button>
      ))}
    </div>
  );
}
