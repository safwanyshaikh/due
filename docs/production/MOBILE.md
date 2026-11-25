# Due on iOS and Android (Capacitor)

The native apps are the same web build (`dist/`) inside a Capacitor shell. There is one UI codebase. The web/PWA build is unchanged: without a native shell, `src/lib/platform/` is a set of no-ops and nothing from Capacitor is loaded.

- App id `com.karigarai.due`, name "Due". Config: `capacitor.config.ts`. Projects: `android/`, `ios/` (committed; build outputs are git-ignored).
- Production origin for web, landing and API: `https://due.karigarai.com`.

## Build

```
npm ci
npm run build:native      # tsc + vite build --mode native (reads .env.native) + cap sync
npx cap open android      # Android Studio
npx cap open ios          # Xcode (macOS only)
```

`.env.native` sets `VITE_API_ORIGIN=https://due.karigarai.com`. Web builds leave it unset, so they call the API on their own origin. (`VITE_API_BASE` still works as a fallback.) Every client wrapper (account, identities, offers, savings) reads the one setting through `src/lib/platform/config.ts`.

Status of this repo's generation: the `ios/` project was generated on Linux (`cap add ios` needs no macOS tools, it writes a Swift Package based project). It has not been opened in Xcode here: CI builds it for the simulator on `macos-latest`. The Android project was generated but not compiled locally (no Android SDK on the dev box); CI builds it.

## Session design: bearer token, not cross-origin cookies

The app runs at `capacitor://localhost` (iOS) or `https://localhost` (Android) and calls `https://due.karigarai.com`. That is cross-site. Two options:

1. Cookies with `SameSite=None; Secure` plus CORS with credentials for those origins.
2. A bearer token kept in the iOS Keychain / Android Keystore.

We chose **2**, because:

- iOS WebKit (Intelligent Tracking Prevention) and Android WebView increasingly block or partition third-party cookies, so (1) would fail unpredictably.
- (1) would make the production session cookie `SameSite=None` and CORS-with-credentials for a `localhost` origin. `https://localhost` is not owned by us: any local web server or app on a user's device can use that origin. With ambient cookies that is a CSRF/credentialed-read exposure. A bearer token is never sent automatically, so there is nothing for a forged request to ride on.
- The web cookie stays `HttpOnly; SameSite=Lax; Secure` exactly as before.

How it works:

- Native `POST /api/account/verify` sends `tokenTransport: 'bearer'`. The server issues the same session as for cookies (stored only as an HMAC hash, 30 days idle, 180 days absolute, revocable per device in Account), returns it once as `sessionToken`, and sets **no cookie**. The server refuses `bearer` unless the request Origin is a configured native origin.
- The app sends `Authorization: Bearer <token>` with `credentials: 'omit'`.
- For a native origin the server **ignores cookies completely** and accepts only the bearer token. For any other origin it ignores the bearer token. So neither mechanism can be mixed up cross-origin.
- CORS (`server/src/http/security.ts`): only `capacitor://localhost` and `https://localhost` (env `MOBILE_APP_ORIGINS`, empty turns it off). Allowed on `/api/account`, `/api/intake`, `/api/telemetry` (all methods) and `/api/public`, `/api/health` (GET). Never `Access-Control-Allow-Credentials`. Admin, auth, billing, inbound and Gmail OAuth routes get no CORS headers for any origin. The CSRF guard still requires `X-Requested-With: due-app` (forces a preflight) and accepts the native origins only for the consumer API.
- Logout, "sign out everywhere" and revoking the current device delete the token on the phone as well as on the server. A 401 also clears it.
- **Token storage**: `@aparajita/capacitor-secure-storage`. iOS Keychain with accessibility "after first unlock, this device only" and iCloud sync off (so it is not in iCloud Keychain or backups to another device). Android: AES-GCM with a key held in the Android Keystore, ciphertext in app-private storage (`allowBackup=false`). A token left in Preferences by an earlier build is copied into secure storage and then deleted on first read; logout deletes both. Preferences never receives the token.
- **Token lifetime / rotation**: the token is an opaque, hashed, server-revocable session (30 days idle, 180 days absolute, per-device revoke and "sign out everywhere"). Short-lived access tokens with refresh rotation are **not** implemented: they need a refresh-token table, reuse detection and offline-retry handling in the sync client, which is not cheap with this session model and the security gain over a Keychain-held, revocable token is modest. Revisit if the threat model changes.
- **App lock (optional, off by default)**: Settings > App lock, via `@aparajita/capacitor-biometric-auth` (Face ID / Touch ID / fingerprint, with device passcode fallback). When on, Due shows nothing until unlocked at launch and after 30 seconds in the background. Turning it on or off needs a successful unlock. The flag is kept in secure storage. It is a convenience gate against someone using an unlocked phone, not encryption of local data (data stays in the app sandbox as before). `NSFaceIDUsageDescription` is in `Info.plist`.
- Guest (cookie-based temporary intake) sessions are not supported natively. The UI does not use them.
- Tests: `server/test/mobile.test.ts` (CORS, bearer auth, cookie-ignoring, no-CORS on admin, association files) and `src/lib/platform/__tests__/platform.test.ts`.

## Links that open the app (App Links / Universal Links)

The sign-in email link is `https://due.karigarai.com/api/account/verify?token=...`. When the app is installed it opens in the app, which shows "Confirm sign-in on this device" (the token is only consumed by the button, as on web). Only that path is claimed.

Server env (both optional; the endpoints return 404 until set; in `render.yaml` as `sync: false`):

| Env | Value |
| --- | --- |
| `ANDROID_SHA256_CERT_FINGERPRINTS` | Comma-separated SHA-256 fingerprints, `AA:BB:...` (32 bytes). Use the **Play app signing** key (Play Console > Test and release > App integrity > App signing) and, for sideloaded/internal builds, your upload key. Served at `/.well-known/assetlinks.json`. |
| `APPLE_TEAM_ID` | 10-character Team ID (developer.apple.com > Membership). Served at `/.well-known/apple-app-site-association` as `<TEAM>.com.karigarai.due`. |
| `MOBILE_APP_ORIGINS` | Leave unset (default is the two Capacitor origins). |

App side: the Android intent filter (`autoVerify`, host from `-PdueAppLinkHost`, default `due.karigarai.com`) and the iOS entitlement `applinks:due.karigarai.com` (`ios/App/App/App.entitlements`) are already in the projects. In Xcode, the App target must have the Associated Domains capability enabled for your team (automatic signing adds it).

## Native features (`src/lib/platform/`)

- **Open with Due / Share to Due (PDF)**: Android intent filters for `application/pdf` (VIEW and SEND; `MainActivity` turns a shared stream into a VIEW URL). iOS declares the PDF document type (appears under "Open in..."; copies the file in). The file goes through the normal Upload screen (same on-device PDF reading, same allowance). iOS share-sheet *extension* ("Share > Due" from any app's share button) needs a separate Xcode target and is not included; "Open in Due" and Files work.
- **Reminder notifications**: Reminders > "Notifications on this device" (native only, opt-in, asks the OS permission at that moment). Scheduled locally from the existing reminder plan (lead times, quiet hours, snooze), up to 60 soonest (iOS keeps 64). Rescheduled when data changes. They complement email, work offline, and need no account. Android 13+ needs the `POST_NOTIFICATIONS` runtime permission (declared). Exact-alarm permission is not used: delivery can be a few minutes late under battery saver.
- **Status bar and safe areas**: status bar style follows light/dark; the shell pads `env(safe-area-inset-*)` (`viewport-fit=cover` was already set).
- **Android back button**: goes back in the app history, then to Home, then minimises the app.
- **File picker**: the standard `<input type=file>` works in both WebViews (Capacitor wires the Android file chooser; iOS uses the system picker). Exports (CSV, JSON, calendar `.ics`) use the native share sheet because WebViews cannot save blob downloads.
- The service worker is not registered inside the native app.

## Mobile audit

`e2e/mobile.spec.ts` (Playwright, 360x800 and 390x844, touch): no horizontal scroll on 15 pages, every button/link/input at least 48px (inline text links exempt), no `:hover`-only reveal rules, safe-area CSS present. Fixed while doing it: footer links, `.btn.quiet`, disclosure rows, period toggle and stepper buttons, safe-area padding for the shell, toasts and bottom sheets.

## CI (`.github/workflows/mobile.yml`)

- `android` (ubuntu): `npm run build:native`, debug APK always (artifact `due-debug-apk`); if `ANDROID_KEYSTORE_BASE64` exists, a signed release AAB (`due-release-aab`) with `versionCode = run number`.
- `ios` (macos-latest): unsigned simulator build (`CODE_SIGNING_ALLOWED=NO`).

GitHub Actions secrets for Android release signing: `ANDROID_KEYSTORE_BASE64` (`base64 -w0 upload.jks`), `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS`, `ANDROID_KEY_PASSWORD`. For later iOS release (not wired yet): App Store Connect API key (`ASC_KEY_ID`, `ASC_ISSUER_ID`, `ASC_KEY_P8`), a distribution certificate (`.p12` + password) and a provisioning profile; those are added when you have the Apple account, with `xcodebuild archive` + `-exportArchive` and `xcrun altool`/Transporter or fastlane.

## What the founder must do

Store fees and rules change: check the current amounts on the pages named below.

### Accounts (start these first, they have waiting times)

1. **Google Play Console**: one-time registration fee (about US$25, charged in your card's currency, roughly INR 2,000 at today's rate). Register as an **individual** for the beta (see `docs/launch/STORE_LISTING.md`). Individual accounts need identity verification (government ID, a few days) and, for new personal accounts, a **closed test with at least the required number of testers for 14 days** before you can apply for production. Plan for about 3 weeks from start to public.
2. **Apple Developer Program**: US$99 per year (about INR 8,000+). Individual enrolment takes from hours to a few days; it needs an Apple ID with two-factor auth and identity verification. You need this before any TestFlight or App Store build, and for Universal Links (Team ID).
3. **D-U-N-S**: only if you publish as a company/organisation (Apple requires it, free from Dun & Bradstreet India, usually 1-2 weeks; Google also asks for it for organisation accounts). Not needed for individual accounts. Apps can be transferred to a company later.

### Signing keys

- **Android**: create an upload key once, keep it and its passwords in a password manager plus an offline copy (losing it is recoverable via Play support, but slow):
  `keytool -genkeypair -v -keystore upload.jks -alias upload -keyalg RSA -keysize 2048 -validity 10000`
  Enrol in **Play App Signing** (default for new apps): Google holds the real signing key. Put the *app signing* SHA-256 (and the upload key's) into `ANDROID_SHA256_CERT_FINGERPRINTS` on Render. Add the four GitHub secrets above.
- **iOS**: with automatic signing in Xcode, sign in with your Apple ID, pick your team on the App target, and Xcode manages certificates and profiles. Set `APPLE_TEAM_ID` on Render.

### Build and test

1. Android: `npm run build:native`, then `cd android && ./gradlew assembleDebug` (or take the CI artifact), install the APK on a phone. Check: sign-in via the emailed link, PDF open/share, reminders notification, back button.
2. iOS (needs a Mac): `npx cap open ios`, choose your team, run on a device. Then Product > Archive > Distribute to TestFlight.
3. Before each release raise the version: `versionName`/`versionCode` in `android/app/build.gradle` and Version/Build in Xcode.

### Store listing and submission

1. Copy text from `docs/launch/STORE_LISTING.md` (name, descriptions, URLs, age rating). Screenshots: take them at the sizes each store asks for (phone 6.7" and 6.1" for Apple, at least 2 phone screenshots for Play) from a real device or simulator.
2. Privacy: both stores need a privacy policy URL (`https://due.karigarai.com/#/legal/privacy`, fill the legal details in Admin first), an account-deletion path (in-app Account > Delete, plus the URL on Play's Data safety form), and a data-safety / App Privacy questionnaire. Answer from `docs/production/SECURITY.md` and the privacy text: email, on-device-first data, no ads, no tracking across apps, no payments in the app.
3. Reviewers need a way to sign in: give App Review notes explaining that sign-in is by emailed link, and provide a test account email you control (and be ready to forward the link), or a note that the app also works fully without an account.
4. Finance category: say plainly that Due is planning-only, never moves money and never offers loans or credit. Do not use "guaranteed savings" wording.
5. Submit: Play Console > Production (or closed test first) > upload the `.aab`; App Store Connect > the build from TestFlight > Submit for Review.

### Review timelines (typical, not promises)

- Apple App Review: usually 24-48 hours, longer for a first submission or a rejection round trip.
- Google Play: new personal accounts often 3-7 days for the first review (longer is possible); later updates usually within a day or two. The 14-day closed test comes before this for new personal accounts.
- Plan for at least one rejection round on the first submission (most often: privacy/data-safety mismatch, missing reviewer sign-in, or finance wording).

### Ongoing

- Renew the Apple membership every year; keep the Play account in good standing.
- Keep `ANDROID_SHA256_CERT_FINGERPRINTS` current if the signing key changes, or sign-in links open in the browser instead of the app (they still work there).
- Update Capacitor and plugins a few times a year (`npm outdated`), rebuild, test on a phone, release.
