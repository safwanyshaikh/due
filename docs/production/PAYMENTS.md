# Payments (Cashfree or Razorpay) for Due subscriptions

> **The Cashfree adapter has only been tested against mocks.** No Cashfree sandbox keys existed when it was written, so endpoints, field names, event names and the hosted-checkout link were taken from Cashfree's public documentation and are NOT confirmed against a real account. Run the sandbox checklist at the bottom before charging anyone.

While the free public beta flag is on (Admin > Settings > Free public beta) nothing is charged and checkout is refused. This page is for when you turn it off.

## What the code does

- `BILLING_PROVIDER=razorpay` (default, unchanged behaviour) or `cashfree`. Both can be configured; only the active one sells.
- Cashfree: plans are created by you in the Cashfree dashboard (the price is fixed there). Due creates a subscription for the plan (UPI AutoPay or card mandate), sends the user to Cashfree's hosted checkout, and only a verified webhook (or a status fetch / the daily reconcile job) unlocks Plus. The app can never set a price or an entitlement.
- Webhook: `POST https://due.karigarai.com/api/billing/webhook/cashfree`. Signature = base64(HMAC-SHA256(`x-webhook-timestamp` + raw body, secret)) in `x-webhook-signature`. Bad or missing signature returns 400. Each delivery is applied once; older events are ignored; an ended subscription is never revived.
- Failed renewal: access continues for 3 days (grace, once per failure streak), then stops. A later successful charge resets it.
- Cancel: the Account > Plan button cancels at Cashfree (future charges stop) and Plus stays until the end of the paid period.
- Endpoint, API version and status names live in one file: `server/src/consumer/cashfree.config.ts` (`x-api-version` 2023-08-01; newer versions exist, check before upgrading).
- Sandbox vs production: `CASHFREE_ENV`.

## Cashfree x Startup India: steps for the founder

Safco Skill Academy Private Limited (DPIIT recognised since 2021, incorporated 21 Sep 2020) should qualify on paper for Cashfree's Startup India offer (zero payment-gateway fees up to Rs 10 lakh a month for eligible DPIIT-recognised startups; terms and conditions apply, check the current offer page). DPIIT recognition lasts up to 10 years from incorporation, so up to Sep 2030; confirm the certificate's own validity date.

1. Keep the DPIIT recognition certificate (PDF) ready.
2. Create a Cashfree merchant account for the company and complete business KYC as a Private Limited company: certificate of incorporation, company PAN, GSTIN (the company is GST-registered), board resolution or authorisation for the signatory, signatory ID, and a bank account in the company's name.
3. The settlement bank account is entered only in the Cashfree (or Razorpay) dashboard during KYC. It is never entered in Due, in code or in documents.
4. Apply to the Startup India offer from Cashfree's offer page, attaching the DPIIT certificate. Wait for written confirmation of the benefit and its limits.
5. In Cashfree: create Subscriptions plans, for example `due_plus_monthly` and `due_plus_yearly`, with the prices you decide (current prices are hypotheses, see `docs/launch/PRICING.md`). Plan ids use letters, digits, `-` and `_`.
6. In Cashfree: add the webhook `https://due.karigarai.com/api/billing/webhook/cashfree` for subscription events. Note whether Cashfree shows a separate webhook secret.
7. In Render env group `due-shared`: set `CASHFREE_APP_ID`, `CASHFREE_SECRET_KEY` (and `CASHFREE_WEBHOOK_SECRET` only if Cashfree gives a separate one), `CASHFREE_ENV=sandbox` first. Never paste keys into chat or documents.
8. In Admin > Plans: enter the Cashfree plan ids for Plus (monthly, yearly). The page shows which provider is active.
9. Run the sandbox checklist below with sandbox keys.
10. Switch for real: use production keys, `CASHFREE_ENV=production`, `BILLING_PROVIDER=cashfree`, redeploy both services, then turn the beta flag off. No rebuild is needed.

## Tax (GST)

The company is GST-registered. In Admin > Settings > GST set "We are registered under GST" and enter your GSTIN; it is validated (15 characters, state code, PAN pattern, check character). Then the Plans screen shows the tax wording ("Prices include 18% GST." unless you edit the tax note) and invoices and receipts carry the GSTIN. If a company is not registered, no GST is charged or shown and invoices say "Not registered under GST". GST registration becomes mandatory once services turnover crosses Rs 20 lakh; confirm thresholds and your obligations with your CA. Never put the GSTIN, PAN or bank details in code, tests or docs.

## Sandbox checklist (before real money)

1. Create a subscription from the Plans screen with a test mobile number; confirm Cashfree's hosted checkout opens (if the link is empty, fix `hostedCheckout` in `cashfree.config.ts`).
2. Complete the sandbox mandate; confirm the webhook arrives, the signature verifies (if every delivery returns 400, check the header names and the signed string in the config and Cashfree's current docs) and Plus unlocks.
3. Trigger a sandbox charge success and a failure; check the paid period and the 3-day grace.
4. Cancel from the app; confirm Cashfree shows the subscription cancelled and access stays until the paid period ends.
5. Replay the same webhook from the Cashfree dashboard; nothing changes.
6. Run the daily reconcile (`billing.reconcile`) and check the audit log (`entitlement.*`).
7. Compare field names in a real payload with `parseCashfreeEvent` in `server/src/consumer/cashfree.ts` and adjust.

## Razorpay (unchanged)

Set `BILLING_PROVIDER=razorpay` (default), keys `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`, `RAZORPAY_WEBHOOK_SECRET`, webhook `https://due.karigarai.com/api/billing/razorpay/webhook`, plan ids in Admin > Plans.
