import { useAccount } from '../account/AccountContext';
import { Glyph } from './Glyph';

/** 56px top bar: wordmark left; profile and settings right. No category navigation. */
export function TopBar() {
  const { status, me } = useAccount();
  const signedIn = status === 'signed_in';
  return (
    <header className="topbar" data-block="topbar">
      <a className="wordmark press" href="#/">
        <span className="wordmark-mark" aria-hidden="true">
          D
        </span>
        Due<span className="sr-only"> home</span>
      </a>
      <nav className="topbar-actions" aria-label="Account and settings">
        <a
          className={`icon-btn press ${signedIn ? 'icon-btn-on' : ''}`}
          href="#/account"
          aria-label={
            signedIn ? `Account (${me?.account.email ?? 'signed in'})` : 'Account and sign-in'
          }
        >
          <Glyph name="user" />
        </a>
        <a className="icon-btn press" href="#/settings" aria-label="Settings">
          <Glyph name="gear" />
        </a>
      </nav>
    </header>
  );
}
