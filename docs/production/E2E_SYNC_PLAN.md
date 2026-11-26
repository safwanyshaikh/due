# Synced data: what is done now, and the end-to-end encryption plan

Audit finding H3 (25 Nov 2026): synced account and household data was stored as plain JSON on the server, including statement summaries with daily balances.

## Done in the November 2026 fix pass (minimum fix)

- **Encrypted per account and per household on the server.** `PUT /api/account/data` and the household document are stored sealed with AES-256-GCM. Each row has its own key, derived with HKDF-SHA256 from the current `DATA_ENCRYPTION_KEY` and the row scope (`account:<id>`, `household:<id>`); the scope is also bound as authenticated data, so a ciphertext copied to another row does not open (`server/src/consumer/syncCrypto.ts`). The `data` column then holds `{}`; the ciphertext is in `data_enc` (`d1:<kid>:...`).
- **Existing synced accounts are migrated on their next sync**: a plain row (or one sealed under an older key) is re-sealed under the current key the next time it is read or written. **Dormant accounts too:** the daily `sync_seal` job (queue type `sync.seal_backfill`) seals every remaining plain or old-key row in batches until none is left.
- **After the backfill (one-off, owner/ops):** old row versions can still sit in dead tuples and in backups.
  1. Check it is done: `SELECT count(*) FROM account_data WHERE version > 0 AND (data_enc IS NULL OR data_enc NOT LIKE 'd1:<current kid>:%');` and the same for `household_data` must be 0.
  2. Rewrite the tables so no old plain tuple remains on disk: `VACUUM (FULL, ANALYZE) account_data; VACUUM (FULL, ANALYZE) household_data;` (takes an exclusive lock for a few seconds on small tables; run it in a quiet hour).
  3. Expire every backup taken before step 2: delete older off-site dumps (`BACKUP.md`) and, on Render, let the daily snapshots age out (or ask Render support to delete them). Note the date in the incident/ops log.
- **Production refuses to start without `DATA_ENCRYPTION_KEY`.** Key rotation: prepend a new `kid:key` to the ring; rows move to the new key as they are read; drop the old key once `SELECT count(*) FROM account_data WHERE data_enc NOT LIKE 'd1:<new kid>:%'` (and the same for `household_data`) is 0.
- **The most revealing detail stays on the device** unless the person opts in (Account > Backup and sync > "Also back up statement detail"): the day-by-day morning balances, SMA (overdue loan) recovery sweeps, and recurring payment lines from bank and UPI statements (`src/lib/account/syncScope.ts`). When a server copy is adopted, the local-only detail on the device is kept.
- Export and deletion decrypt or remove the sealed document like before.

What this protects against: a leaked database dump or backup, SQL-level access by someone without the key, and casual operator browsing. What it does not: someone who controls the running server (it has the key), or a legal demand served on Due. That is what end-to-end encryption fixes.

## End-to-end encryption plan (not built yet)

Goal: the server stores only ciphertext and a key check; only the person's devices can read their backup.

1. **Account key.** On first "turn on backup", the device creates a random 256-bit data key (DK) and a recovery code (24 characters from a 32-letter alphabet, about 120 bits, shown once in groups of four). A key-encryption key is derived from the recovery code with Argon2id (via a maintained WASM build such as `hash-wasm`; m = 64 MiB, t = 3, p = 1) or, if WASM cannot be used, PBKDF2-SHA256 with at least 600,000 iterations; both have a random 16-byte salt. The wrapped DK (AES-GCM) and the salt and parameters go to the server, plus a key check (HMAC of a fixed label under DK) so a wrong code is detected without decrypting data.
2. **On the device.** Native: DK is stored in the Keychain (iOS) / Keystore-backed storage (Android) through the existing secure-storage adapter (`@aparajita/capacitor-secure-storage`), behind the app lock. Web: DK is imported as a non-extractable WebCrypto `CryptoKey` and kept in IndexedDB (the browser can use it but script cannot read the raw key).
3. **Data.** The sync document is encrypted on the device with AES-256-GCM (random 96-bit IV per upload, the account id and version as authenticated data). The server stores `{ v: 'e2e1', iv, ct, keyCheck }` and keeps optimistic concurrency on the version number only. Reminder emails keep working through the separate, consented reminder schedule (titles and dates only), which the server needs to send them.
4. **New device.** Sign in, then enter the recovery code: the device unwraps DK and stores it locally. A device that is already set up can show a QR code to pass DK to a new device directly.
5. **Plain-language UX.** "This code unlocks your backup. Write it down or save it in your password manager. If you lose this code and your phone, we cannot recover your data. We cannot see your backup." The person must type back two groups of the code before backup turns on.
6. **Migration.** Accounts synced today: on next sync after the update, the device asks to set up the recovery code, encrypts the current data and uploads it with `baseVersion`; the server then deletes the server-sealed copy (`data_enc`) and refuses non-E2E uploads for that account.
7. **Households.** Each member has an X25519 key pair (private key stored like DK). The household key (HK) is wrapped to each member's public key; the inviter wraps HK for the invitee when they accept (both devices online, or the owner's device completes it on next open). Removing a member rotates HK and re-wraps it for the remaining members. Until this is built, household data stays server-sealed per household (above), which is documented in the privacy notice.
8. **Tests to add.** Wrong recovery code is refused by the key check; ciphertext tampering fails; a second device restores with the code; the server never receives DK or the code (request bodies checked in tests); household member removal rotates HK.

Why not shipped in this pass: key loss is unrecoverable by design, so the recovery-code flow, native key storage, migration of existing accounts and the household key exchange need their own careful release, device testing and support copy. Shipping half of it would risk people losing their data.
