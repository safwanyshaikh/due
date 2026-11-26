# Email setup: Google Workspace SMTP (for the founder)

Due sends sign-in links, invites and reminder emails through a normal mailbox on your Google Workspace. You do this once, about 30 minutes, and no code change or rebuild is needed.

Values used below (from the founder's decisions):

| Setting | Value |
| --- | --- |
| Sending mailbox | `saas@karigarai.com` |
| App URL | `https://due.karigarai.com` |
| `SMTP_URL` | `smtps://saas%40karigarai.com:<APP_PASSWORD>@smtp.gmail.com:465` |
| `SMTP_FROM` | `Due <saas@karigarai.com>` |
| `PUBLIC_BASE_URL` | `https://due.karigarai.com` |

`<APP_PASSWORD>` is a placeholder. Never paste a real password into a document, chat, GitHub or an email. It only ever goes into Render (step 5).

> Later you can add a "Send mail as" alias such as `due@karigarai.com` in Google Workspace (Gmail settings of `saas@`, Accounts, "Send mail as") and then change `SMTP_FROM` to `Due <due@karigarai.com>`. No code change is needed.

## Option A (recommended for the beta): an App Password on `saas@karigarai.com`

### 1. Turn on 2-Step Verification (Google Admin)

1. Sign in at <https://admin.google.com> as a super admin.
2. Go to **Security > Authentication > 2-step verification**.
3. Tick **Allow users to turn on 2-Step Verification**. Save. (Do not choose "Security keys only": that hides App Passwords.)
4. Sign in to the `saas@karigarai.com` mailbox itself at <https://myaccount.google.com/security> and switch on **2-Step Verification** with your phone.

### 2. Create the App Password

1. While signed in as `saas@karigarai.com`, open <https://myaccount.google.com/apppasswords>. If the page says it is not available, 2-Step Verification is not on yet, or your admin has blocked it (step 1).
2. App name: `Due on Render`. Click **Create**.
3. Google shows a 16-letter password once. Copy it. Remove the spaces. This is `<APP_PASSWORD>`.

### 3. Build the SMTP_URL

Format: `smtps://USER:APP_PASSWORD@smtp.gmail.com:465`

The `@` inside the user name must be written as `%40`, otherwise the address is misread:

```
smtps://saas%40karigarai.com:<APP_PASSWORD>@smtp.gmail.com:465
```

If the password ever contains `@ : / ? # %` write them as `%40 %3A %2F %3F %23 %25`. Google App Passwords are plain letters, so usually nothing needs changing. Due's mailer (nodemailer) understands `smtps://` URLs: port 465, TLS on, user name URL-decoded. This is covered by an automated test.

### 4. Choose the sender name

`SMTP_FROM` = `Due <saas@karigarai.com>`. Google rewrites the From address to the signed-in mailbox, so keep it identical to the mailbox (or to a "Send mail as" alias, see the note above).

### 5. Put both values into Render

1. Render dashboard > **Env Groups** > `due-shared`.
2. Add or edit `SMTP_URL` and `SMTP_FROM` with the values above. Also check `PUBLIC_BASE_URL` is `https://due.karigarai.com` (links in emails use it).
3. Save. Render redeploys both the web service `due` and the worker `due-worker` because they share this group. Wait until both show "Live".

### 6. Test from the admin panel

1. Open `https://due.karigarai.com/admin/`, sign in as an admin.
2. **Integration health** > **Send test email to me**. The message goes to your own admin email address only.
3. "Accepted by the mail server" means Google took it. Check your inbox and the spam folder.
4. If it fails, the message shows Google's reason (never your password):
   - `Invalid login` / `535`: wrong App Password or 2-Step Verification is off. Create a new App Password.
   - `Username and Password not accepted` with a correct password: the `@` was not written `%40`.
   - timeout: Render could not reach `smtp.gmail.com:465`; retry, then contact Render support.
5. The button is limited to 5 sends per 10 minutes, admin only, and each use is recorded in the audit log.
6. Then check the public status: the app shows email as "Live" once `SMTP_URL` is set.

## Option B: Google SMTP relay (`smtp-relay.gmail.com`)

Use this only if you later outgrow a single mailbox or want to send from several addresses without passwords.

1. Admin console > **Apps > Google Workspace > Gmail > Routing > SMTP relay service > Add setting**.
2. Allowed senders: *Only addresses in my domains*. Authentication: require SMTP authentication, and require TLS.
3. Use `SMTP_URL=smtps://saas%40karigarai.com:<APP_PASSWORD>@smtp-relay.gmail.com:465`.
4. Test again with the admin button.

## Deliverability: SPF, DKIM, DMARC (DNS records for karigarai.com)

Without these, mail is more likely to land in spam. Add them where your DNS is managed (your domain registrar or Cloudflare). Confirm the exact values in Google Admin before saving; they are Google's current published values.

1. **SPF** (TXT on `karigarai.com`): `v=spf1 include:_spf.google.com ~all`
   - A domain may have only ONE SPF record. First look at what already exists. If one is there, add `include:_spf.google.com` to it; do not create a second record. Keep any other `include:` entries already in use.
2. **DKIM** (TXT): Google Admin > **Apps > Google Workspace > Gmail > Authenticate email**, choose `karigarai.com`, **Generate new record** (2048-bit, selector `google`). Add the shown TXT record at `google._domainkey.karigarai.com`, wait up to 48 hours, then click **Start authentication**.
3. **DMARC** (TXT on `_dmarc.karigarai.com`): start in monitoring mode: `v=DMARC1; p=none; rua=mailto:saas@karigarai.com`. After two weeks of clean reports and a successful test, tighten to `p=quarantine`.
4. Verify with a free checker (for example Google Admin Toolbox "Check MX" or mail-tester.com): send the admin test email and confirm SPF, DKIM and DMARC all say "pass".

## Limits and good practice

- A single Workspace mailbox has a daily sending cap (Google publishes it; roughly 2,000 messages a day at the time of writing). Fine for the first users; move to Option B or a transactional email service if you approach it.
- Replies to `saas@karigarai.com` land in that inbox: someone must read it, or set `Reply-To` / an alias later.
- To rotate the password: create a new App Password, update `SMTP_URL` in `due-shared`, delete the old App Password in Google.
- Never share the App Password in chat or email. If it leaks, delete it in Google at once.

## Recommended: AWS SES (Safco Skill Academy Pvt Ltd already has SES production access)

SES is built for bulk and transactional mail, so use it instead of a Google Workspace mailbox. No code change: the mailer accepts any SMTP URL.

1. AWS console → SES, region **ap-south-1 (Mumbai)** → Verified identities → add domain `karigarai.com` → add the 3 DKIM CNAME records at your DNS provider → wait for "Verified".
2. SES → SMTP settings → Create SMTP credentials (an IAM user is created; note the SMTP username and password once).
3. Render env group `due-shared`:
   - `SMTP_URL` = `smtps://<SMTP_USERNAME>:<URL-ENCODED_SMTP_PASSWORD>@email-smtp.ap-south-1.amazonaws.com:465`
   - `SMTP_FROM` = `Due <due@karigarai.com>` (any address on the verified domain; no mailbox needed)
4. DNS: one SPF record for karigarai.com that includes both Google Workspace and SES, e.g. `v=spf1 include:_spf.google.com include:amazonses.com ~all` (merge, never two SPF records); keep the DMARC record.
5. Optional: a custom MAIL FROM subdomain (e.g. `mail.karigarai.com`) in SES for full SPF alignment.
6. Admin → Health → "Send test email".
7. SES → Configuration sets → enable bounce and complaint notifications (SNS → email) so bad addresses are noticed.
