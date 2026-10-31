import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { AppProvider, useApp } from './store';
import { ToastProvider } from './components/Toast';
import { AccountProvider } from './account/AccountContext';
import { CatalogProvider } from './offers/catalogStore';
import { TopBar } from './components/TopBar';
import { AccountReturn } from './account/AccountReturn';
import { Home } from './screens/Home';
import { StartPaths } from './screens/Landing';
import { AllPage } from './screens/AllPage';
import { LegalScreen } from './screens/LegalScreen';
import { GmailReturnBanner, IncidentBanner } from './components/ShellBanners';
import { AddScreen } from './screens/AddScreen';
import { ItemScreen } from './screens/ItemScreen';
import { EditScreen } from './screens/EditScreen';
import { ImportScreen } from './screens/ImportScreen';
import { UploadScreen, SmsScreen } from './screens/IntakeScreens';
import { ForwardScreen } from './screens/ForwardScreen';
import { CsvScreen } from './screens/CsvScreen';
import { AccountScreen } from './screens/AccountScreen';
import { PlansScreen } from './screens/PlansScreen';
import { RemindersScreen } from './screens/RemindersScreen';
import { SettingsScreen } from './screens/SettingsScreen';
import { ConnectionsScreen } from './screens/ConnectionsScreen';
import { CommitmentForm } from './CommitmentForm';
import { BudgetView } from './BudgetView';
import { SeasonsView } from './SeasonsView';
import { RemindersView } from './RemindersView';
import { CalendarView } from './CalendarView';
import { CalcView } from './CalcView';
import { OffersHome } from './offers/OffersHome';
import { OfferDetail } from './offers/OfferDetail';
import { AddService } from './offers/AddService';
import { ServiceCard } from './offers/ServiceCard';
import { ScenarioCalculator } from './offers/ScenarioCalculator';
import { RelayInbox } from './offers/RelayInbox';
import type { AccountClient } from '../lib/account/client';
import type { AppData } from '../lib/types';
import { nav, parseRoute, toHash, type Route } from './lib/nav';
import { useMotionPreference, useTheme, type ThemeChoice } from './lib/motion';
import { download } from './common';
import { ConfirmButton } from './components/ui';

export { parseRoute, toHash, nav } from './lib/nav';
export type { Route, Nav } from './lib/nav';

interface UiPrefs {
  reduceMotion: boolean;
  setReduceMotion: (v: boolean) => void;
  theme: ThemeChoice;
  setTheme: (t: ThemeChoice) => void;
}
const UiPrefsCtx = createContext<UiPrefs | null>(null);
export function useUiPrefs(): UiPrefs {
  const c = useContext(UiPrefsCtx);
  if (!c) throw new Error('UiPrefs missing');
  return c;
}

function UiPrefsProvider({ children }: { children: ReactNode }) {
  const [reduceMotion, setReduceMotion] = useMotionPreference();
  const [theme, setTheme] = useTheme();
  return (
    <UiPrefsCtx.Provider value={{ reduceMotion, setReduceMotion, theme, setTheme }}>
      {children}
    </UiPrefsCtx.Provider>
  );
}

function View({ route }: { route: Route }) {
  switch (route.name) {
    case 'home':
      return <Home />;
    case 'legal':
      return <LegalScreen doc={route.doc} />;
    case 'start':
      return <StartPaths />;
    case 'all':
    case 'category':
      return <AllPage type={route.type} />;
    case 'add':
      return <AddScreen type={route.type} />;
    case 'item':
      return <ItemScreen id={route.id} />;
    case 'edit':
      return <EditScreen id={route.id} />;
    case 'details':
      return <CommitmentForm editId={route.id} nav={nav} />;
    case 'import':
      return <ImportScreen />;
    case 'upload':
      return <UploadScreen />;
    case 'sms':
      return <SmsScreen />;
    case 'forward':
      return <ForwardScreen />;
    case 'csv':
      return <CsvScreen />;
    case 'account':
      return <AccountScreen />;
    case 'plans':
      return <PlansScreen />;
    case 'reminders':
      return <RemindersScreen />;
    case 'settings':
      return <SettingsScreen />;
    case 'connections':
      return <ConnectionsScreen />;
    case 'budget':
      return <BudgetView />;
    case 'seasons':
      return <SeasonsView />;
    case 'reminders-ics':
      return <RemindersView />;
    case 'calendar':
      return <CalendarView nav={nav} />;
    case 'calc':
      return <CalcView />;
    case 'offers':
      return <OffersHome nav={nav} />;
    case 'offers-add':
      return <AddService nav={nav} />;
    case 'offers-calc':
      return <ScenarioCalculator />;
    case 'relay':
      return <RelayInbox nav={nav} />;
    case 'offer':
      return <OfferDetail id={route.id} />;
    case 'service':
      return <ServiceCard id={route.id} nav={nav} />;
  }
}

const LEGACY = new Set([
  'details',
  'budget',
  'seasons',
  'reminders-ics',
  'calendar',
  'calc',
  'offers',
  'offers-add',
  'offers-calc',
  'relay',
  'offer',
  'service',
]);

/** Shown while a copy of unreadable saved data is kept on this device; nothing syncs automatically meanwhile. */
function CorruptDataBanner() {
  const { corruptBackup, discardCorruptBackup } = useApp();
  if (!corruptBackup) return null;
  return (
    <div className="notice2 notice-warn shell-notice" role="alert">
      <p>
        <strong>Some saved data on this device couldn’t be read.</strong> Due kept an unchanged copy
        on this device and hasn’t synced or overwritten it. Export the copy to keep it safe.
        Automatic sync stays paused until you remove the copy.
      </p>
      <div className="btn-row">
        <button
          type="button"
          className="btn btn-secondary btn-sm press"
          onClick={() =>
            download(
              `due-unreadable-data-${corruptBackup.at.slice(0, 10)}.json`,
              corruptBackup.raw,
              'application/json',
            )
          }
        >
          Export the kept copy
        </button>
        <ConfirmButton
          label="Remove the kept copy"
          confirmLabel="Yes, remove it"
          className="btn btn-quiet btn-sm press"
          message="Remove the copy from this device? Export it first if you might need it."
          onConfirm={discardCorruptBackup}
        />
      </div>
    </div>
  );
}

function Shell() {
  const [route, setRoute] = useState<Route>(() => parseRoute(window.location.hash));
  const { persisted } = useApp();
  const mainRef = useRef<HTMLElement>(null);
  const firstRender = useRef(true);
  useEffect(() => {
    const on = () => setRoute(parseRoute(window.location.hash));
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  useEffect(() => {
    if (firstRender.current) {
      firstRender.current = false;
      return;
    }
    const h = mainRef.current?.querySelector<HTMLElement>('h1');
    if (h) {
      h.setAttribute('tabindex', '-1');
      h.focus({ preventScroll: true });
    }
  }, [route]);
  const key = toHash(route);
  const legacy = LEGACY.has(route.name);
  const inOffers = ['offer', 'service', 'offers-add', 'offers-calc', 'relay'].includes(route.name);
  return (
    <div className="shell">
      <a className="skip" href="#main">
        Skip to content
      </a>
      <TopBar />
      {!persisted && (
        <div className="notice2 notice-warn shell-notice" role="alert">
          Your browser isn’t saving data (private mode or storage blocked). Export from Settings
          before closing.
        </div>
      )}
      <IncidentBanner />
      <CorruptDataBanner />
      <AccountReturn />
      <GmailReturnBanner />
      <main id="main" key={key} ref={mainRef} className={legacy ? 'legacy' : undefined}>
        {legacy && (
          <div className="backrow2">
            <a className="text-btn press" href={inOffers ? '#/offers' : '#/'}>
              ‹ {inOffers ? 'Back to Due & Offers' : 'Back to Home'}
            </a>
          </div>
        )}
        <View route={route} />
      </main>
    </div>
  );
}

export function App({
  client,
  initialData,
}: {
  client?: AccountClient;
  initialData?: AppData;
} = {}) {
  return (
    <UiPrefsProvider>
      <ToastProvider>
        <AppProvider initialData={initialData}>
          <AccountProvider client={client}>
            <CatalogProvider>
              <Shell />
            </CatalogProvider>
          </AccountProvider>
        </AppProvider>
      </ToastProvider>
    </UiPrefsProvider>
  );
}
