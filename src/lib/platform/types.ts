/**
 * The only seam between the web app and native (Capacitor) APIs. The UI and the account client talk to
 * this interface; the web build gets the no-op adapter and never loads a Capacitor plugin.
 */
export type PlatformName = 'web' | 'ios' | 'android';

export type NotificationPermission = 'granted' | 'denied' | 'prompt' | 'unsupported';

/** One device notification, computed by the pure planner in localReminders.ts. */
export interface LocalNotification {
  /** Stable positive 31-bit id derived from the reminder key (re-scheduling replaces, never duplicates). */
  id: number;
  title: string;
  body: string;
  /** UTC instant to fire at. */
  at: Date;
}

/** Where a native session token lives (iOS Keychain / Android Keystore-backed storage). The web build never stores a token: it uses the HttpOnly cookie. */
export interface TokenStore {
  get(): Promise<string | null>;
  set(token: string): Promise<void>;
  clear(): Promise<void>;
}

export interface PlatformHandlers {
  /** A PDF the person opened with Due or shared to Due. */
  onOpenFile?: (file: File) => void;
  /** A link opened in the app, e.g. the e-mailed sign-in link. */
  onOpenUrl?: (url: URL) => void;
  /** Android back button when the webview history cannot go back. Return true to consume it. */
  onBackAtRoot?: () => boolean;
}

export interface PlatformAdapter {
  readonly name: PlatformName;
  readonly isNative: boolean;
  readonly tokens: TokenStore;
  /** Status bar, splash screen, back button, open-with. Returns a cleanup function. */
  start(handlers?: PlatformHandlers): Promise<() => void>;
  /**
   * Optional app lock: Face ID / Touch ID / fingerprint, falling back to the device passcode. Off by default.
   * The setting itself lives in secure storage.
   */
  appLock: {
    supported: boolean;
    /** Whether the device has biometrics or a passcode set up. */
    available(): Promise<boolean>;
    isEnabled(): Promise<boolean>;
    /** Turning on first requires a successful unlock; turning off requires one too. Returns the new state. */
    setEnabled(on: boolean): Promise<boolean>;
    /** Shows the system prompt. True only when the person authenticated. */
    authenticate(reason: string): Promise<boolean>;
    /** Calls back with false when the app goes to the background and true when it returns. */
    onActiveChange(cb: (active: boolean) => void): Promise<() => void>;
  };
  /** Device notifications for reminders. */
  notifications: {
    supported: boolean;
    permission(): Promise<NotificationPermission>;
    request(): Promise<NotificationPermission>;
    /** Replaces every Due notification that is pending on the device with exactly this set. */
    replaceAll(items: LocalNotification[]): Promise<number>;
    cancelAll(): Promise<void>;
  };
  /** Native share sheet (or the Web Share API). Resolves false when nothing could be shared. */
  share(input: { title: string; text?: string; url?: string }): Promise<boolean>;
  /** Saves text as a file and offers it through the share sheet (native only; web uses a download). */
  saveAndShareFile(filename: string, text: string, mime: string): Promise<'shared' | 'unsupported'>;
}
