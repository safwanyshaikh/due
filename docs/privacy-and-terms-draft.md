# Recurring Payables Planner — India policy and privacy starter

**Status: working product-policy draft for Indian legal counsel. Not legal advice, not a final privacy policy or terms of service, and not a guarantee that the product complies with all laws or platform rules.** Replace bracketed items only after the real data flows, vendors, hosting, and company details are confirmed. Do not publish this draft as-is.

## Product scope the legal review assumes

The app is an informational planner for a user’s manually entered recurring commitments: subscriptions, EMIs, other loan instalments, credit-card due amounts, school fees, and household bills. It summarizes amounts by month/year, stores reminder dates, and helps users plan. **It does not originate or arrange loans, recommend taking credit, underwrite borrowers, collect debt, initiate or route payments, hold funds, change a mandate, cancel a service, or guarantee that a creditor or merchant has been paid.**

The first beta has no automatic mailbox, WhatsApp-chat, SMS-inbox, bank-account, or payment-app access. Users can enter details and select the billing email label themselves. Any future message-forwarding, OAuth, or data-provider feature needs a separate legal, security, and platform-policy review before release.

## Draft privacy notice outline

### 1\. Who is responsible for the data

**\[Legal entity name\]**, with registered address **\[address\]**, operates **\[product name\]**. For privacy questions, contact **\[privacy/grievance email\]**. Add a working postal and support contact after incorporation and operations are confirmed.

### 2\. Data we may collect in the manual beta

The beta may process an account email address, optional name, user-entered creditor or service name, commitment category, EMI/fee/bill amount, currency, due date, payment frequency, remaining term if entered, card/loan/bill label, reminder preference, user-selected status, and billing-email label. It may also process basic technical/security records such as login time, device/browser information, and error logs. Do not collect full card numbers, CVV, UPI PINs, bank login credentials, Aadhaar/PAN, or loan account passwords.

If an optional message-forwarding feature is later enabled, list exactly what it receives, which sender/content fields are parsed, whether a human or processor can access the original message, where it is processed, how long raw content and derived fields are retained, and how the user deletes it. Do not use a broad phrase such as “we may collect financial information” as a substitute for explaining the actual message and parsing flow.

### 3\. Purpose and consent

Use data only to provide the functions the user selects: display their own recurring-payables inventory; calculate monthly and yearly totals from entered information; schedule reminders; provide export, account support, security, and deletion; and improve reliability using appropriately minimized data. Obtain clear, purpose-specific affirmative consent before optional integration or forwarding. Do not bundle an inbox/SMS/WhatsApp consent with account creation or make unrelated processing a condition of the basic manual tracker.

Suggested in-product consent copy for the **manual beta** (adapt after counsel review):

“We’ll store the payment and commitment details you enter so we can show your estimated monthly and yearly payables and schedule the reminders you choose. We do not connect to or read your email, WhatsApp, SMS, bank, or payment apps in this beta. We do not make payments or cancel or pause services for you. You can export or delete your records in Settings.”

If message forwarding is introduced, replace—not merely append to—the relevant language with a just-in-time notice describing the specific message, recipient, data extracted, processor, storage and deletion period, and whether anything is sent to an AI or external service. Provide an explicit “send this message” action and a separate “do not save” option.

### 4\. Sharing and service providers

List the actual hosting, authentication, email delivery, error-monitoring, customer-support, and messaging vendors before launch. State which data each receives and for what purpose. Do not sell payment, loan, or message data; do not target credit offers using these records; do not use financial messages to train a general AI model. If a future feature uses a model to extract a user-forwarded message, disclose the processor and data handling before the user submits the message and provide a non-AI/manual alternative.

### 5\. Retention, access, deletion, and security

Set retention by data type and purpose. Provide export and deletion controls; explain any backup expiry or legal retention exception. Restrict internal access, maintain audit logs, encrypt data in transit and at rest through the chosen services, keep secrets out of source control, test tenant isolation, and maintain an incident response and breach-notification procedure. Do not promise “end-to-end encrypted,” “never stored,” or “deleted instantly” unless technically verified end to end.

### 6\. User control, corrections, and complaints

Allow users to correct amounts, dates, lenders, school names, status, and reminder settings. Provide a documented channel for access, correction, deletion, consent withdrawal, security reports, and complaints. Publish a real grievance/privacy contact and response process before public release. Build the app so a user can withdraw an optional integration without deleting unrelated manually entered records.

### 7\. Children and family information

School-fee entries can identify children. The beta should be adult-account-only, avoid collecting a child’s full name, date of birth, school ID, or other unnecessary identifiers, and store only an optional generic label such as “School fees.” Do not create child profiles, behavioral analytics, or targeted advertising. Ask Indian counsel to review the DPDP Act’s child-data rules and staged commencement before supporting a child as a direct user or collecting identifiable child data.

### 8\. Cross-border and legal updates

As of 30 October 2026, the DPDP Act and DPDP Rules are enacted with staged commencement; the main processing provisions are scheduled for 13 May 2027 under the notified timeline. Build for notice, purpose limitation, consent records, withdrawal, security, deletion, and grievance handling now. Separate RBI, payment-system, consumer-protection, platform, and contract obligations may still apply depending on the actual role and data flow. Counsel must assess the final architecture, hosting region, partners, and integrations, not just the product name. [1](https://www.meity.gov.in/static/uploads/2024/06/2bf1f0e9f04e6fb4f8fef35e82c42aa5.pdf) [2](https://www.meity.gov.in/static/uploads/2025/11/53450e6e5dc0bfa85ebd78686cadad39.pdf) [3](https://www.meity.gov.in/static/uploads/2025/11/c56ceae6c383460ca69577428d36828b.pdf)

## Draft terms outline for legal review

### Service description and important limits

“\[Product name\] helps you organize information you choose to enter about recurring subscriptions, loan instalments, EMIs, credit-card bills, school fees, and other commitments. It displays estimates based on the information you provide and lets you schedule reminders. It is not a bank, lender, credit bureau, financial adviser, debt counsellor, payment system, biller, or mandate manager.”

“\[Product name\] does not move money, make payments, change a payment mandate, cancel a service, negotiate with a lender, or contact a creditor on your behalf. A reminder is not proof that a bill is due or paid. Verify the current amount, due date, interest, fees, payment instructions, outstanding balance, and account status with the relevant provider. Your lender’s agreement and official statement control.”

“Amounts and totals may be incomplete, stale, or inaccurate if the information entered is incomplete or changes. For loans, variable rates, prepayments, late fees, taxes, and lender-specific rules can make a simple EMI-times-term estimate differ from the actual amount payable. The app must label estimates and show their source and last-confirmed date.”

### User responsibilities

Users must enter information they are authorized to store, correct it when circumstances change, protect account access, and use official provider channels to pay or change a commitment. Do not upload or forward another person’s financial message without authority. Avoid collecting or displaying full account credentials or identifiers that the planner does not need.

### No-pressure financial design

The app provides neutral planning tools, not a recommendation to borrow, refinance, pay only a minimum, defer an essential bill, or cancel an essential service. Do not rank loan providers by commission. Present actions such as “review,” “contact provider,” or “open provider’s official page,” and make any sponsored placement clearly distinct and optional. Do not create urgency countdowns, shame language, default payment prompts, or “one-tap borrow” flows.

### Reminders and service status

“Reminders are an organizational aid. Delivery can be delayed, blocked, or unavailable because of device, network, email, WhatsApp, operating-system, provider, or time-zone issues. Keep checking statements and provider notices.”

“‘Planned pause’ means only that the user recorded an intention. It does not pause a loan, subscription, payment mandate, credit-card charge, or school-fee obligation. ‘Confirmed’ status should only be shown after the user reports that the provider has confirmed the relevant action; the app does not independently verify it unless a future integration explicitly does so.”

### Beta, complaints, liability, and governing law

Use a clear beta notice and disclose material limits. Do not insert a blanket waiver of statutory consumer rights. Have Indian counsel draft any limitation of liability, indemnity, dispute process, jurisdiction, and consumer-grievance language against the actual legal entity, service, and applicable Indian law. Avoid promising that terms alone eliminate legal risk.

## Messaging and data-connection decision record

### WhatsApp: user-forwarded item only, not personal-chat reading

Meta’s WhatsApp Business Platform is built for businesses to message users and to receive webhook events for messages users send to the business number. It is not a documented API for reading a person’s existing WhatsApp history or silently scanning chats. A future intake could let the user deliberately forward one selected bank/creditor message to the product’s official business number and then confirm the parsed amount/date before saving. Store as little raw content as possible and expose a deletion control. [4](https://developers.facebook.com/documentation/business-messaging/whatsapp/about-the-platform)

For outgoing WhatsApp reminders, obtain the required opt-in. Meta says template messages generally require approval and are used outside the customer-service window. Let users switch reminders off and use app/email/calendar channels instead. Set up a real Meta Business account, approved number/templates, webhook security, retention rules, and deletion process before making this a production feature. Do not scrape WhatsApp Web or use unofficial automation. [4](https://developers.facebook.com/documentation/business-messaging/whatsapp/about-the-platform)

### SMS: no general inbox permission in the first product

Google Play restricts high-risk SMS and Call Log permissions and requires policy eligibility/declaration; it warns that apps lacking a permitted use must remove the permission and that noncompliance can lead to removal. SMS Retriever is for app-specific verification messages such as OTPs, not for reading a user’s general bank/loan/SMS history. A planning-only PWA should not request <u>READ_SMS</u>. If a future native Android build proposes transaction-SMS capture, get Play-policy and legal review, prove it is an eligible core use, explain the scope at runtime, and retain a manual alternative. [5](https://support.google.com/googleplay/android-developer/answer/10208820?hl=en) [6](https://developers.google.com/identity/sms-retriever/overview)

### Email: multiple labels now; optional mailbox connection later

In the beta, users add several billing-email labels and assign each commitment to one. Do not state “linked inbox” if the app does not actually connect. Later Gmail OAuth must request the least necessary scopes and meet Google’s verification, security assessment, user-data, disclosure, and deletion requirements. Keep an email-forward/upload option only if its server processing, retention, and consent are specified.

### iPhone and App Store disclosures

Apple requires accurate privacy details for the app and integrated third parties. Financial information and email/text message content are named data types; ongoing collection must be disclosed. Complete App Store privacy labels from the real implemented data flow, including analytics, support, authentication, and messaging SDKs. Do not promise iOS access to other apps’ SMS or inbox content. [7](https://developer.apple.com/app-store/app-privacy-details/)

## Required pre-public-launch sign-offs

- Indian counsel has reviewed the final product role, Terms, Privacy Notice, consumer disclosures, child/family data, grievance channel, and each data integration.

- A data-flow diagram names every field, system, vendor, storage region, retention period, access role, and deletion path.

- Gmail OAuth, WhatsApp Business, Android SMS permissions, and any Account Aggregator partner have separate approval checklists; none is enabled by default.

- Security tests cover authentication, authorization/tenant isolation, backups, encryption, deletion, audit logs, and incident response.

- Every total is labeled as user-entered/estimated and has a last-confirmed date; no screen implies that the app paid, paused, or cancelled a commitment.

- Privacy claims match App Store/Google Play disclosures and the actual vendor configuration.

## References
