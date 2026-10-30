# Research evidence: vendor source registry

Generated: 2026-10-30T08:14:01Z by the WebFetch research agent. Machine-readable output: `server/seed/registry.json`.

## Summary

**No vendor source could be verified in this run.** The container shell is blocked by the proxy (403), and WebFetch was also blocked by the cloud session's network policy:

- `www.jio.com`: `getaddrinfo ENOTFOUND www.jio.com` (the 4 Jio pages and `/robots.txt` were attempted)
- `support.google.com`: `getaddrinfo ENOTFOUND support.google.com` (help article 9155746 was attempted)

The tool said to stop trying more hosts after two had failed this way, so the other cited URLs were **not attempted**. No titles, excerpts, prices, feeds, robots rules or extra URLs were collected, and nothing was made up to fill the gap. Every source is `inaccessible`, robots is `unknown`, and every description is `null`.
The `officialWebsite` values are the vendors' usual domains. They are listed so the company records can be made, but they have **not** been checked by fetching them. BSNL, JioHotstar, Netflix India and Apple have no sources, because none were cited and discovery needed network access.

**To unblock:** allow the vendor domains in the session's Network access settings (environment menu → Edit → Allowed domains, or a broader access level). Needed: www.jio.com, www.airtel.in, www.myvi.in, www.amazon.in, www.primevideo.com, gemini.google, support.google.com, one.google.com, pay.google.com, www.npci.org.in, www.rupay.co.in, paytm.com, business.paytm.com, www.bsnl.co.in, www.jiohotstar.com, www.netflix.com, help.netflix.com, www.apple.com. Then re-run this agent. See https://code.claude.com/docs/en/cloud-environments#network-access.

## Reliance Jio

Official website (unverified): https://www.jio.com

| URL | Category | Priority | Status | Fetched at | Title |
|---|---|---|---|---|---|
| https://www.jio.com/google-gemini-offer/ | product_page | critical | inaccessible (attempted, ENOTFOUND) | 2026-10-30T08:14:01Z | - |
| https://www.jio.com/jcms/en-in/jio-google-gemini-terms-and-conditions/ | terms | critical | inaccessible (attempted, ENOTFOUND) | 2026-10-30T08:14:01Z | - |
| https://www.jio.com/help/faq/mobile/offers/google-gemini-offer/ | help | regular | inaccessible (attempted, ENOTFOUND) | 2026-10-30T08:14:01Z | - |
| https://www.jio.com/selfcare/plans/mobility/prepaid-plans-home/ | pricing | critical | inaccessible (attempted, ENOTFOUND) | 2026-10-30T08:14:01Z | - |

## Bharti Airtel

Official website (unverified): https://www.airtel.in

| URL | Category | Priority | Status | Fetched at | Title |
|---|---|---|---|---|---|
| https://www.airtel.in/press-release/09-2026/airtel-enhances-its-postpaid-offering-by-adding-apples-newly-expanded-icloud-with-apple-tv-and-apple-arcade/ | press | critical | inaccessible (not attempted) | - | - |
| https://www.airtel.in/plans/broadband | pricing | critical | inaccessible (not attempted) | - | - |
| https://www.airtel.in/press-release/01-2026/in-a-global-first-airtel-provides-360-million-indians-with-free-access-to-adobe-express-premium/ | press | critical | inaccessible (not attempted) | - | - |

## Vodafone Idea (Vi)

Official website (unverified): https://www.myvi.in

| URL | Category | Priority | Status | Fetched at | Title |
|---|---|---|---|---|---|
| https://www.myvi.in/vi-movies-and-tv/all-ott-in-one-app | product_page | regular | inaccessible (not attempted) | - | - |
| https://www.myvi.in/prepaid/recharge-cashback-offers | pricing | critical | inaccessible (not attempted) | - | - |

## Amazon India (Prime)

Official website (unverified): https://www.amazon.in

| URL | Category | Priority | Status | Fetched at | Title |
|---|---|---|---|---|---|
| https://www.amazon.in/b?ie=UTF8&node=16700000031 | product_page | critical | inaccessible (not attempted) | - | - |
| https://www.amazon.in/gp/help/customer/display.html?nodeId=G6RZ3AA6NQMCKYEM | help | regular | inaccessible (not attempted) | - | - |
| https://www.amazon.in/gp/help/customer/display.html?nodeId=G2B9L3YR7LR8J4XP | help | regular | inaccessible (not attempted) | - | - |
| https://www.primevideo.com/help?nodeId=202095490 | help | regular | inaccessible (not attempted) | - | - |
| https://www.amazon.in/b?ie=UTF8&node=207354383031 | product_page | regular | inaccessible (not attempted) | - | - |

## Google (Google One / Gemini subscriptions India)

Official website (unverified): https://gemini.google

| URL | Category | Priority | Status | Fetched at | Title |
|---|---|---|---|---|---|
| https://gemini.google/in/subscriptions/?hl=en-IN | pricing | critical | inaccessible (not attempted) | - | - |
| https://support.google.com/googleone/answer/9155746?hl=en-IN | help | regular | inaccessible (attempted, ENOTFOUND) | 2026-10-30T08:14:01Z | - |
| https://support.google.com/googleone/answer/9056360?hl=en-IN | help | regular | inaccessible (not attempted) | - | - |
| https://support.google.com/googleone/answer/15801606?hl=en-IN | help | regular | inaccessible (not attempted) | - | - |

## Google Pay India

Official website (unverified): https://pay.google.com

| URL | Category | Priority | Status | Fetched at | Title |
|---|---|---|---|---|---|
| https://support.google.com/pay/india/answer/18815856 | help | regular | inaccessible (not attempted) | - | - |

## NPCI (UPI, RuPay)

Official website (unverified): https://www.npci.org.in

| URL | Category | Priority | Status | Fetched at | Title |
|---|---|---|---|---|---|
| https://www.rupay.co.in/rupay-credit-card-on-upi | product_page | regular | inaccessible (not attempted) | - | - |

## Paytm

Official website (unverified): https://paytm.com

| URL | Category | Priority | Status | Fetched at | Title |
|---|---|---|---|---|---|
| https://business.paytm.com/subscriptions | product_page | regular | inaccessible (not attempted) | - | - |

## BSNL

Official website (unverified): https://www.bsnl.co.in

No sources cited. Discovery was not possible without network access.

## JioHotstar

Official website (unverified): https://www.jiohotstar.com

No sources cited. Discovery was not possible without network access.

## Netflix India

Official website (unverified): https://www.netflix.com/in/

No sources cited. Discovery was not possible without network access.

## Apple (India subscriptions / Apple One)

Official website (unverified): https://www.apple.com/in/

No sources cited. Discovery was not possible without network access.

## Not accessible, and why

- All 4 www.jio.com pages and https://www.jio.com/robots.txt: WebFetch `getaddrinfo ENOTFOUND www.jio.com` (session network policy).
- https://support.google.com/googleone/answer/9155746?hl=en-IN: WebFetch `getaddrinfo ENOTFOUND support.google.com` (session network policy).
- All other cited URLs (airtel.in, myvi.in, amazon.in, primevideo.com, gemini.google, the rest of support.google.com, rupay.co.in, business.paytm.com): not attempted, because the session policy said to stop after hosts failed this way.
- RSS/Atom feeds: none found, since no newsroom page could be fetched.
- robots.txt: not checked for any host.
