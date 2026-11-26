# Cookies and Local Storage — Due by KAI

> DRAFT. Confirm against the shipped build.

**Effective date:** [EFFECTIVE DATE]

Due uses **no advertising, tracking or third-party analytics cookies**. We use only what is needed to run the service, so no cookie banner for non-essential cookies is needed. If we add anything optional, we will ask first.

| Name | Type | Purpose | Lifetime |
| --- | --- | --- | --- |
| `__Host-due_acct` (web app account session; `__Host-due_session` for admin staff only) | Essential, HttpOnly, Secure, first party | Keep you signed in | Up to 30 days idle / 180 days absolute |
| `__Host-due_intake` | Essential, HttpOnly, Secure, first party | Guest document/email review session without an account | Short (session) |
| Local storage / IndexedDB in your browser or app | Essential, on device only | Stores your commitments, settings and reminder plan on your device | Until you clear it |
| Service worker cache | Essential, on device | Lets the app load offline | Until cleared/updated |
| Secure storage (mobile app) | Essential, on device | Holds your sign-in token (Keychain/Keystore) | Until sign-out |

**Anonymous usage events** are not cookies and are off unless you opt in (see Privacy Policy).

**Control:** clear site data in your browser, or sign out (Settings → Account). Blocking essential cookies will stop sign-in from working.
