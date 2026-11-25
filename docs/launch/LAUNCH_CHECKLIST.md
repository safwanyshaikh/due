# Launch checklist: free public beta

Target: this weekend. Owner is **Founder** (needs your accounts or decisions) or **Claude** (done in the repo or by instructions). Do the steps in order; tick as you go.

Fixed values: app `https://due.karigarai.com`, mailbox `saas@karigarai.com`, tagline "Same life. Smaller bills."

| # | Done | Owner | Step |
| --- | --- | --- | --- |
| 1 | [ ] | Founder | Render: sync the Blueprint (`render.yaml`): web `due`, worker `due-worker`, database `due-db`, env group `due-shared`. |
| 2 | [ ] | Founder | Render env group `due-shared`: set `PUBLIC_BASE_URL=https://due.karigarai.com`, `SMTP_URL`, `SMTP_FROM`; set `ADMIN_SETUP_TOKEN` on the web service; leave Razorpay vars empty for now. |
| 3 | [ ] | Founder | DNS: point `due.karigarai.com` at the Render web service (CNAME as shown in Render > Custom Domains); wait for the TLS certificate. |
| 4 | [ ] | Founder | DNS: add SPF, DKIM and DMARC records for karigarai.com (see `docs/production/EMAIL_SETUP.md`). |
| 5 | [ ] | Founder | Create the Google App Password for `saas@karigarai.com` and build `SMTP_URL` (`docs/production/EMAIL_SETUP.md`, steps 1 to 5). |
| 6 | [ ] | Founder | Create the first owner at `https://due.karigarai.com/admin/setup` with `ADMIN_SETUP_TOKEN`, then delete the token from Render. |
| 7 | [ ] | Founder | SMTP test: Admin > Integration health > "Send test email to me"; check the email arrives in the inbox, not spam. |
| 8 | [ ] | Claude | Confirm Integration health shows database, queue (worker heartbeat) and email as OK; list anything "Not configured" that is expected (Razorpay, Gmail, inbound). |
| 9 | [ ] | Founder | Legal details: Admin > Legal: entity name = Safco Skill Academy Private Limited, registered address, grievance officer, contact details, support email, effective date (entered by you in Admin, never hard-coded in the app); have counsel review Privacy and Terms (the app shows "Legal details incomplete" until filled). |
| 9b | [ ] | Founder | Admin > Settings > GST: GST registered = Yes, enter your GSTIN (validated; never put it in code or docs). |
| 10 | [ ] | Founder | Admin > Settings > Free public beta: tick it on; optionally set an end date. |
| 11 | [ ] | Claude | Smoke test on the live URL: start page shows tagline and "Free during beta"; sign in by email link; account shows Plus; Plans screen shows "Free during beta" and no checkout; add an item; reminder email; sign out. |
| 12 | [ ] | Founder | Invite the first 10 users (friends, colleagues) with a personal message and one question: "what confused you?" Track replies in a note. |
| 13 | [ ] | Claude | Review admin audit log, error tracking and Integration health after 48 hours; summarise issues and fixes. |
| 14 | [ ] | Founder | Announce publicly (LinkedIn, WhatsApp groups, X) using the tagline and the store text in `docs/launch/STORE_LISTING.md`. No guaranteed-saving wording. |

Optional: once the apps are published, paste the store links in Admin > Settings > App store links; the landing shows each button only when its link is set.

Later (not this weekend): add a "Send mail as" alias `due@karigarai.com` and change `SMTP_FROM`; set up Razorpay (keys, plans, webhook) then turn the beta flag off to start charging, with no rebuild; open store developer accounts as an organisation (start the D-U-N-S request now; see `docs/launch/STORE_LISTING.md`).
