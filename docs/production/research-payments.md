# Payments-ecosystem research (offers & benefits sources)

Generated 2026-10-30T08:15Z by the payments research agent. Machine-readable seed: `server/seed/registry-payments.json` (56 sources, 7 vendors).

## 0. Read this first: nothing was verified

Every WebFetch attempt failed at DNS resolution (`getaddrinfo ENOTFOUND <host>`). The session's network allow-list blocks these hosts; the network isn't down and the sites aren't missing. Hosts tried, all of which failed, at about 2026-10-30T08:15Z:

`www.phonepe.com`, `paytm.com`, `www.amazon.in`, `support.google.com`, `www.npci.org.in`, `cred.club`, `www.mobikwik.com`

After 7 of 7 hosts failed, I stopped trying further hosts (`blog.google`, `pay.google.com`, `ir.paytm.com`, `bhimupi.org.in`, `blog.phonepe.com`, `axisbank.com`, `tatapower-ddl.com`, `rupay.co.in`), following the tool's guidance.

As a result:
- Every source has `status: "inaccessible"`, `robots: "unknown"`, `title: null` and `excerpt: null`. The `reason` field explains why and, where one exists, quotes the **search-result title**. That title is not a page-verified title.
- `offerPatterns` and `partners` are **empty for every vendor**. The brief allows these only from fetched pages.
- The URLs came from WebSearch result listings. They are real indexed URLs, but no page content or current liveness has been confirmed.
- To unblock: add the hosts above to the cloud environment's Network access allow-list (environment settings → Network access → Allowed domains), then re-run this agent. Once allowed, the server monitor (running on Render, not this sandbox) should also validate each source with `POST /api/admin/sources/:id/validate`.

Section 3 lists "leads", meaning terms that appeared in **search-engine snippets** only. They are **not facts**, must not be seeded into `offers` and must not be shown to users. They are included only to help whoever writes the extraction rules decide what to look for once the pages can be fetched.

## 1. Sources per company

All rows have status **inaccessible** and fetched-at **2026-10-30T08:15Z (attempt)**. Reason: DNS failure caused by the session network allow-list. "Attempted" means WebFetch was tried on that exact URL. "Host-blocked" means the same host had already failed. "Not attempted" means the host was never tried (see section 0).

### PhonePe — https://www.phonepe.com
| URL | Category | Priority | Status |
|---|---|---|---|
| https://www.phonepe.com/robots.txt | document | regular | inaccessible (attempted) |
| https://www.phonepe.com/terms-conditions/recharge-bills/ | terms | critical | inaccessible (host-blocked) |
| https://www.phonepe.com/terms-conditions/general | terms | critical | inaccessible (host-blocked) |
| https://www.phonepe.com/terms-conditions/recharge-bills/app | terms | regular | inaccessible (host-blocked) |
| https://phonepe.com/terms-conditions/ | terms | regular | inaccessible (host-blocked) |
| https://www.phonepe.com/press/ | press | regular | inaccessible (host-blocked) |
| https://www.phonepe.com/press/indus-appstore-transforms-to-phonepe-appstore-introducing-a-unified-marketplace-for-indias-digital-goods | press | secondary | inaccessible (host-blocked) |
| https://www.phonepe.com/offers/2018/01/05/OF1801051434307589035174/en.html | terms (legacy offer) | secondary | inaccessible (host-blocked) |
| https://phonepe.com/app/offers/august/14/jio/app-en.html | terms (legacy offer) | secondary | inaccessible (host-blocked) |
| https://tatapower-ddl.com/.../PHONEPE_CASHBACK_OFFER_ON_BILL_PAYMENT_FOR_THE_PERIOD_of_July_to_Sept'22.pdf | secondary (partner-hosted) | secondary | inaccessible (not attempted) |

### Google Pay India — https://pay.google.com/intl/en_in/about/
| URL | Category | Priority | Status |
|---|---|---|---|
| https://support.google.com/robots.txt | document | regular | inaccessible (host-blocked) |
| https://support.google.com/pay/india/answer/7580493 (T&C: Offers and Rewards) | terms | critical | inaccessible (host-blocked) |
| https://support.google.com/pay/india/answer/7539588 (Rewards FAQs) | help | critical | inaccessible (host-blocked) |
| https://support.google.com/pay/india/answer/7579062 (Pay bills) | help | regular | inaccessible (host-blocked) |
| https://support.google.com/pay/india/answer/13267498?hl=en (Referral) | help | regular | inaccessible (host-blocked) |
| https://support.google.com/pay/india/answer/9010473 | help | secondary | inaccessible (attempted) |
| https://pay.google.com/intl/en_in/about/terms | terms | critical | inaccessible (not attempted) |
| https://pay.google.com/intl/en_in/about/ | official_site | regular | inaccessible (not attempted) |
| https://blog.google/intl/en-in/products/explore-communicate/google-pay-advancing-payments-credit-and-commerce-in-india/ | press | regular | inaccessible (not attempted) |
| https://blog.google/intl/en-in/products/explore-communicate/flex-by-google-pay-reimagining-everyday-credit-for-india/ | press | regular | inaccessible (not attempted) |
| https://blog.google/intl/en-in/products/explore-communicate/find-and-select-prepaid-mobile-recharge/ | press | secondary | inaccessible (not attempted) |

### Paytm — https://paytm.com
| URL | Category | Priority | Status |
|---|---|---|---|
| https://paytm.com/robots.txt | document | regular | inaccessible (attempted) |
| https://paytm.com/offer/recharge/mobile-recharge | product_page | critical | inaccessible (host-blocked) |
| https://paytm.com/offer/recharge/jio-rs-15-cashback | product_page | critical | inaccessible (host-blocked) |
| https://paytm.com/offer/app-super-cashback | product_page | critical | inaccessible (host-blocked) |
| https://paytm.com/offer/rs-2100-cashback-pay-using-upi/mobile-recharge-and-bill-payment-voucher-tnc | terms | critical | inaccessible (host-blocked) |
| https://paytm.com/offer/get-upto-rs10000-cashback/recharge-tnc | terms | regular | inaccessible (host-blocked) |
| https://paytm.com/offer/recharge/d2h150 | product_page (legacy) | secondary | inaccessible (host-blocked) |
| https://ir.paytm.com/stock-exchange-submissions | press | regular | inaccessible (not attempted) |
| https://paytm.com/blog/investor-relations/company-updates/ | press | regular | inaccessible (host-blocked) |
| https://paytm.com/blog/investor-relations/ | press | secondary | inaccessible (host-blocked) |
| https://www.axisbank.com/.../paytm-cashback-offer.pdf | secondary (partner-hosted) | secondary | inaccessible (not attempted) |

### Amazon Pay India — https://www.amazon.in
| URL | Category | Priority | Status |
|---|---|---|---|
| https://www.amazon.in/robots.txt | document | regular | inaccessible (attempted) |
| https://www.amazon.in/h/rewards/dp/amzn1.rewards.rewardAd.rechargeOrPayBills?rdpf=en | product_page | critical | inaccessible (host-blocked) |
| https://www.amazon.in/h/rewards/dp/amzn1.rewards.rewardAd.BAO4VIJVL6HAY?rdpf=en | terms | regular | inaccessible (host-blocked) |
| https://www.amazon.in/h/rewards/dp/amzn1.rewards.rewardAd.S2H3NGUBBH25K?rdpf=en | terms | regular | inaccessible (host-blocked) |
| https://www.amazon.in/gp/help/customer/display.html?nodeId=G9NSAWQVKB9KP2C9 (Service Payments T&C) | terms | critical | inaccessible (host-blocked) |
| https://www.amazon.in/gp/help/customer/display.html?nodeId=202159280 (Prepaid recharges help) | help | regular | inaccessible (host-blocked) |
| https://www.rupay.co.in/PDF/rupay/Amazon-T-and-C-FY-23-24.pdf | secondary (partner-hosted) | secondary | inaccessible (not attempted) |

### MobiKwik — https://www.mobikwik.com
| URL | Category | Priority | Status |
|---|---|---|---|
| https://www.mobikwik.com/robots.txt | document | regular | inaccessible (attempted) |
| https://www.mobikwik.com/offers | product_page | critical | inaccessible (host-blocked) |
| https://www.mobikwik.com/offers/rechargeandbills | product_page | critical | inaccessible (host-blocked) |
| https://www.mobikwik.com/offer/billpay | terms | critical | inaccessible (host-blocked) |
| https://www.mobikwik.com/offers/rechargeandbills/fullpay | terms | regular | inaccessible (host-blocked) |
| https://www.mobikwik.com/offers/rechargeandbills/myjioapp | terms | regular | inaccessible (host-blocked) |
| https://www.mobikwik.com/offer/india | terms | regular | inaccessible (host-blocked) |

### CRED — https://cred.club
| URL | Category | Priority | Status |
|---|---|---|---|
| https://cred.club/robots.txt | document | regular | inaccessible (attempted) |
| https://cred.club/terms | terms | critical | inaccessible (host-blocked) |
| https://cred.club/credit-card-bill-payment-online | product_page | regular | inaccessible (host-blocked) |
| https://cred.club/cred-pay | product_page | secondary | inaccessible (host-blocked) |

### NPCI / BHIM UPI — https://www.npci.org.in
| URL | Category | Priority | Status |
|---|---|---|---|
| https://www.npci.org.in/robots.txt | document | regular | inaccessible (attempted) |
| https://www.npci.org.in/product/autopay | product_page | critical | inaccessible (host-blocked) |
| https://www.npci.org.in/product/upi | product_page | regular | inaccessible (host-blocked) |
| https://www.bhimupi.org.in/upiautopay | product_page | critical | inaccessible (not attempted) |
| https://www.bhimupi.org.in/upiautopay/list-of-banks-and-apps-live-on-upi-autopay | document | regular | inaccessible (not attempted) |
| https://www.npci.org.in/uploads/UPI_Auto_Pay_Brand_Guidelines_bcabed7282.pdf | document | secondary | inaccessible (host-blocked) |

## 2. Offer patterns and partner relationships (verified)

**None.** No page was fetched, so no offer pattern, metadata field or partner relationship can be cited. The JSON arrays are empty on purpose.

## 3. Unverified leads from search-engine snippets (do NOT seed)

These come from WebSearch summary text describing the listed URLs. They may be stale, paraphrased or wrong. Use them only to design extraction rules, then confirm each one by fetching the page.

- **PhonePe**: legacy offer pages follow a dated scheme, `/offers/YYYY/MM/DD/OF<id>/en.html`. Snippets mention per-account limits ("one time per PhonePe registered account"), minimum recharge value, a cashback cap, wallet credit "within 24 hours" and wallet-payment exclusions. The recharge-bills terms reportedly cover prepaid and postpaid mobile, DTH, streaming subscriptions and utilities, and mention fees shown at payment time and separate AutoPay terms. The general terms reportedly contain an "Offers" section. Partner utilities (Tata Power-DDL) host PhonePe cashback T&C PDFs for specific quarters.
- **Google Pay**: snippets say the help article "Terms and Conditions: Offers and Rewards" puts offer eligibility in-app ("rewards page under the Promotions section") and says offers "may vary from User to User". In other words, offer specifics are app-only and personalised. The bill-pay help page reportedly describes convenience and platform fees by payment instrument and Bharat Connect (BBPS).
- **Paytm**: offer pages live at `paytm.com/offer/...` with separate `.../tnc` sub-pages. Snippets mention promo codes, a minimum transaction amount, a "selected users" restriction, one use per user per campaign, KYC conditions, credit "within 24 hours" and the ability to change terms "without prior notice". A Jio-specific cashback page exists (`/offer/recharge/jio-rs-15-cashback`). Partner banks (Axis) host Paytm cashback T&C PDFs. Press releases appear as Reg. 30 filings on ir.paytm.com.
- **Amazon Pay**: reward-ad pages (`/h/rewards/dp/amzn1.rewards.rewardAd.<ID>`) reportedly carry dated windows ("between 01-Jan-2026 ..."), a minimum value, a cap, the Amazon Pay UPI (@apl) instrument condition, category exclusions (FASTag, Google Play, Metro, subscriptions, insurance), "1 time(s) per user", Prime-only eligibility and a 24-hour or 3-working-day credit time.
- **MobiKwik**: offer pages reportedly carry coupon codes (e.g. BILLDAY, FULLPAY), a percentage plus a cap, a minimum spend, a per-month redemption cap, Full KYC eligibility and explicit validity dates (one page reportedly showed 30 Nov 2023, so it has expired). A MyJio partner offer page exists.
- **CRED**: `/terms` reportedly says bill-payment offers are "governed by their terms and conditions as displayed on the CRED App", so offer terms are app-only. Marketing pages describe chance-based "up to 100%" cashback.
- **NPCI/BHIM**: snippets mention a "BHIM UPI Offers" menu item but show no offer content. The AutoPay pages describe mandates and include a list of live banks and apps, which matters for Due's recurring-payables context, not for offers.

## 4. What can and cannot be monitored automatically

| Company | Likely monitorable (once host allowed + robots checked) | Likely NOT monitorable | Why |
|---|---|---|---|
| PhonePe | Terms pages (`/terms-conditions/recharge-bills/`, `/general`), press room | Live offer list | Current offers appear in-app. Legacy offer URLs are per-offer and undiscoverable without a listing page. |
| Google Pay | support.google.com help/terms articles, pay.google.com terms, blog.google India posts | Actual offers and scratch cards | Per snippets, offers are personalised and shown in the app's Rewards → Promotions. |
| Paytm | `paytm.com/offer/*` pages and their `tnc` sub-pages, IR filings, IR blog | Personalised "selected users" offers, Cashback tab | Many offers need the app or login. Some web offer pages are years old and need expiry detection. |
| Amazon Pay | Service Payments T&C help page, Prepaid Recharge help page | Reward-ad pages (probably) | amazon.in usually blocks generic crawlers in robots.txt and serves bot challenges. This is unverified: robots.txt could not be fetched. Reward-ad IDs rotate. |
| MobiKwik | `/offers`, `/offers/rechargeandbills`, individual offer pages | n/a known | Pages appear to be public HTML with dated T&Cs. robots.txt is unverified. |
| CRED | `/terms` only | All offers | Offer terms are shown in the app (per terms snippet). |
| NPCI/BHIM | AutoPay and UPI product pages, the live-apps list, press PDFs | BHIM offers | No offer content surfaced. Possibly a JS-rendered site (unverified). |

## 5. Recommended extraction rules for the monitoring engine

1. **Gate everything on robots.txt first.** None was verified. Leave `robots: unknown` until the server's own fetch resolves it. Expect amazon.in to disallow; if it does, mark `blocked_robots` and do not retry around it.
2. **Prioritise terms pages over offer pages.** `critical`: PhonePe recharge-bills terms, Google Pay Offers & Rewards T&C (7580493), Paytm recharge/bill voucher T&C, Amazon Service Payments T&C, CRED `/terms`, MobiKwik `/offer/billpay`. These are stable URLs where a change matters, so diff them weekly or daily.
3. **Treat offer pages as perishable records.** For `paytm.com/offer/*`, `mobikwik.com/offer*` and Amazon reward-ads, extract and store as `price_mention`/`page` records only after review. Parse candidate fields with regexes and keep the verbatim text: validity (`valid (till|until|from) <date>`, `between <date> and <date>`), min transaction (`min(imum)? (transaction|recharge|spend|order).{0,20}(₹|Rs\.?)\s?\d+`), cap (`up ?to (₹|Rs\.?)\s?\d+`, `max(imum)? cashback`), frequency (`\d+ time\(?s?\)? per user`, `once per (user|month)`), promo code (`(code|promo ?code)[: ]+[A-Z0-9]{4,}`), instrument (`UPI|@apl|@ikwik|wallet|credit card|RuPay`), eligibility (`selected users|Prime|KYC|first`). Never compute `computed_status: active` unless an end date was parsed and is in the future. Otherwise use "Verification pending".
4. **Detect staleness.** Flag a page `expired` when every parsed end date is before `fetched_at`. Snippets suggest many indexed Paytm and PhonePe offer URLs are years old.
5. **Handle personalised or app-only offers honestly.** For Google Pay, CRED and the PhonePe live offer list, show "Offers shown in-app only; Data unavailable" and do not scrape the app.
6. **Treat partner-hosted PDFs as secondary corroboration.** Tata Power-DDL, Axis Bank and RuPay host dated T&C PDFs. Keep them `secondary`/`isOfficial:false` and use them to corroborate, never as the only source of a user-facing offer.
7. **Merge duplicates by URL** with `server/seed/registry.json`, which is written by the general research agent.

## 6. Not found / not verifiable

- All 56 URLs: content, title, liveness, robots status (DNS blocked).
- RSS feeds: **none found**. No search surfaced an RSS/Atom feed for PhonePe press, Paytm IR, Google Pay or NPCI. `blog.google` is known to publish feeds in general, but I did not verify that for the India Google Pay category, so none is seeded.
- PhonePe consumer offers listing page: no URL found.
- BHIM UPI offers page: only seen as a menu label in a snippet, with no URL.
- Google Pay recharge-specific offer pages on the web: none found. Offers appear to be in-app only.
- Any telecom (Jio/Airtel/Vi/BSNL), OTT or DTH partner relationship: none verifiable. Snippet leads exist for Jio on Paytm and MobiKwik and for Videocon d2h on Paytm, but they are not seeded as partners.
- One-sentence neutral descriptions: left `null` because nothing was fetched.
