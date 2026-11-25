import { useId } from 'react';
import {
  findProfile,
  liabilityOwner,
  profilesOf,
  PERSONAL_PROFILE_ID,
  type SignedAs,
} from '../../lib/profiles';
import type { AppData, CommitmentType } from '../../lib/types';
import { ENTITY_LABEL, OWNER_TEXT } from '../../content/profiles';
import './profiles.css';

const LOAN_TYPES: CommitmentType[] = ['emi', 'other_loan', 'credit_card'];

/**
 * "Belongs to" for a due: Personal or a business. For a separate entity's loan, also asks whether
 * the person signed it as guarantor or co-applicant, and says whose due it then is.
 */
export function BelongsToField({
  data,
  profileId,
  signedAs,
  type,
  onChange,
  idPrefix,
}: {
  data: Pick<AppData, 'profiles'>;
  profileId: string;
  signedAs: SignedAs | null;
  type: CommitmentType;
  onChange: (profileId: string, signedAs: SignedAs | null) => void;
  idPrefix?: string;
}) {
  const auto = useId();
  const id = idPrefix ?? auto;
  const profiles = profilesOf(data);
  const p = findProfile(data, profileId) ?? profiles[0];
  const separate = p.kind === 'business' && !p.samePanAsOwner;
  const loan = LOAN_TYPES.includes(type);
  const owner = liabilityOwner({ profileId: p.id, signedAs, type }, data);
  return (
    <div className="stack-8" data-testid="belongs-to">
      <div className="field2">
        <label htmlFor={`${id}-profile`}>Belongs to</label>
        <select
          id={`${id}-profile`}
          value={p.id}
          onChange={(e) =>
            onChange(e.target.value, e.target.value === PERSONAL_PROFILE_ID ? null : signedAs)
          }
        >
          {profiles.map((x) => (
            <option key={x.id} value={x.id}>
              {x.kind === 'personal' ? 'Personal' : `${x.name} · ${ENTITY_LABEL[x.entityType]}`}
            </option>
          ))}
        </select>
      </div>
      {separate && loan && (
        <div className="field2">
          <label htmlFor={`${id}-signed`}>Did you sign this loan too?</label>
          <select
            id={`${id}-signed`}
            value={signedAs ?? 'no'}
            onChange={(e) =>
              onChange(p.id, e.target.value === 'no' ? null : (e.target.value as SignedAs))
            }
          >
            <option value="no">No, or not sure</option>
            <option value="guarantor">Yes, as guarantor</option>
            <option value="co_applicant">Yes, as co-applicant</option>
          </select>
        </div>
      )}
      {profiles.length > 1 && (
        <p className="muted small" data-testid="whose-due">
          Whose due: {OWNER_TEXT[owner]}.
        </p>
      )}
    </div>
  );
}
