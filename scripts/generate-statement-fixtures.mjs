/* global process, console */
/**
 * Generates fully synthetic statement fixtures for src/lib/savings/__tests__/fixtures (audit M7).
 *
 * Every name, address, number, merchant, amount and date below is invented. Only the document layouts
 * (labels, column order, line breaks the PDF text extraction produces, and the issuers' public terms text)
 * follow the real formats, so the parsers are tested on realistic shapes. Nothing here is copied from a
 * real person's document.
 *
 *   node scripts/generate-statement-fixtures.mjs          # write the files
 *   node scripts/generate-statement-fixtures.mjs --check  # fail if a committed file differs
 *
 * Files generated so far: jio-postpaid-bill.txt, jio-fiber-bill.txt, ltf-home-loan-welcome.txt,
 * sbi-gold-loan-od.txt. See docs/production/SECURITY_AUDIT_2026-11-25.md (fix status) for the rest.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'src',
  'lib',
  'savings',
  '__tests__',
  'fixtures',
);

/** The invented customer. */
const PERSON = {
  name: 'DEMO CUSTOMER',
  address: 'FLAT 7, SAMPLE CHS',
  area: 'SAMPLE NAGAR 400099',
  email: 'demo.customer@example.com',
};

// ---- formatting ---------------------------------------------------------------------------------

const r2 = (n) => Math.round(n * 100) / 100;
/** 1234567.5 -> "12,34,567.50" (Indian grouping). */
function inr(n) {
  const neg = n < 0;
  const [int, dec] = Math.abs(n).toFixed(2).split('.');
  const last3 = int.slice(-3);
  const rest = int.slice(0, -3).replace(/\B(?=(\d{2})+(?!\d))/g, ',');
  return `${neg ? '-' : ''}${rest ? `${rest},${last3}` : last3}.${dec}`;
}
/** 1234567.5 -> "1,234,567.50" (international grouping, used by some lenders). */
const intl = (n) =>
  n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const MON = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
const cap = (s) => s[0] + s.slice(1).toLowerCase();
const d2 = (n) => String(n).padStart(2, '0');
/** "2026-10-08" -> parts */
const ymd = (iso) => iso.split('-').map(Number);
const dmyUpper = (iso) => {
  const [y, m, d] = ymd(iso);
  return `${d2(d)}-${MON[m - 1]}-${y}`;
};
const dmyShort = (iso) => {
  const [y, m, d] = ymd(iso);
  return `${d2(d)}-${cap(MON[m - 1])}-${String(y).slice(2)}`;
};
const dmyLong = (iso) => {
  const [y, m, d] = ymd(iso);
  return `${d2(d)}-${cap(MON[m - 1])}-${y}`;
};
const slashDmy = (iso) => {
  const [y, m, d] = ymd(iso);
  return `${d2(d)}/${d2(m)}/${y}`;
};
const dashDmy = (iso) => {
  const [y, m, d] = ymd(iso);
  return `${d2(d)}-${d2(m)}-${y}`;
};

/** Standard EMI formula, rounded to paise. */
function emi(p, annualPct, n) {
  const r = annualPct / 1200;
  return r2((p * r * (1 + r) ** n) / ((1 + r) ** n - 1));
}

// ---- Jio Postpaid ---------------------------------------------------------------------------------

export const JIO_POSTPAID = {
  plan: '399 - Prime',
  creditLimit: 1900,
  deposit: 1250,
  statementDate: '2026-10-08',
  periodFrom: '2026-09-07',
  periodTo: '2026-10-06',
  dueDate: '2026-10-16',
  previousDue: 1512.4,
  paymentReceived: 1512.4,
  connectivity: 451.88,
  platform: 422.36,
  taxes: 157.38,
  history: [
    { month: 'SEP-26', due: 1188.2, paid: 1512.4 },
    { month: 'AUG-26', due: 1650.75, paid: 1325.0 },
  ],
};

function jioPostpaid(b = JIO_POSTPAID) {
  const current = r2(b.connectivity + b.platform + b.taxes);
  const balance = r2(b.previousDue - b.paymentReceived + current);
  return `Hi Mr. ${PERSON.name},
Here is your Invoice Summary.
or pay via
Jio.com   MyJio App
Credit Limit
Security Deposit
Statement Date
Bill Period
Due Date
:   Rs ${b.creditLimit.toFixed(2)}
Rs ${b.deposit.toFixed(2)} :
:   ${dmyShort(b.statementDate)}
${dmyShort(b.periodFrom)} :
${dmyShort(b.dueDate)} :
${dmyShort(b.periodTo)}
to
Jio Mobile Number   000000000
Statement Number   000000000
Current Plan
:
:
Scan & Pay
:
${b.plan} Rs 0
ii.   Payment Received
Amount (Rs.)
${inr(b.paymentReceived)}
iii.   Current Months Charges   ${inr(current)}
${inr(b.previousDue)} i.   Previous Balance Due
Connectivity Services
Monthly Plan Charges
Other Charges
Adjustments / Discounts
Platform Services
Monthly Plan Charges
Other Charges
Adjustments / Discounts
Other Credits
Taxes
iv.   Previous Balance with RRL
v.   Current Balance (i - ii + iii + iv)
vi.   Total Payable   ${inr(balance)}
0.00
${inr(balance)}
${inr(r2(b.connectivity + b.platform))}
${inr(b.connectivity)}
0.00
${inr(b.platform)}
0.00
0.00
0.00
0.00
0.00
${inr(b.taxes)}
You can download your detailed tax invoices on MyJio app / jio.com in the invoice history section.
Reach Us:   Call 199 from your Jio number | 1800-889-9999 from other networks |   ${PERSON.email}
Manage your world of Jio with   MyJio   app or visit   www.jio.com .
Invoice Plan Details   Period
Connectivity Services:
${b.plan} Rs 0   ${dmyUpper(b.periodFrom)} to ${dmyUpper(b.periodTo)}
${b.history.map((h) => `${h.month}\nDue Amount : ${h.due.toFixed(2)}\nPayment : ${h.paid.toFixed(2)}`).join('\n')}

Important Information:
Payments
Complaints & Service Requests
Other
l   No charge will be levied for any service without your explicit consent.
l   No migration fee is chargeable for changing tariff plan.
l   In case you are on an unlimited data plan, post consumption of your allocated data limit,
you will experience a downgrade in speed as per Fair Usage Policy.
l   You can call 199 (toll-free) from your Jio number or 1800-889-9999 from other networks to
register your service request / complaint.
l   You can also visit   www.jio.com , login with your Jio ID and password; click on "Service
Request" option under Profile menu to raise a complaint. To track the status of your existing
complaint, use your unique Service Request Number.
l   In the event of non-payment, part payment or late payment of the outstanding amount by the due date,
the service provider reserves the right to disconnect the services.
`;
}

// ---- JioFiber -------------------------------------------------------------------------------------

export const JIO_FIBER = {
  plan: '399+200(13 OTT) 1M',
  activation: '2025-06-14',
  cycleDate: '2026-11-03',
  payBy: '2026-11-12',
  periodTo: '2026-12-02',
  previousDue: 731.4,
  paymentReceived: 731.4,
  connectivity: 507.62,
  platform: 133.06,
  history: {
    payments: ['02-OCT', '02-SEP', 756.0, 756.0],
    bills: ['02-OCT', '02-SEP', 731.4, 756.0],
  },
};

function jioFiber(b = JIO_FIBER) {
  const plan = r2(b.connectivity + b.platform);
  const half = r2(plan * 0.09);
  const tax = r2(half * 2);
  const total = r2(plan + tax);
  return `Mr. ${PERSON.name}
${PERSON.address}
SAMPLE ROAD
${PERSON.area}
Sample City Maharashtra India
Scan & Pay
Amount (\`) Summary Of Charges
Jio Number   000000000 Statement Number   000000000
Activation Date   ${dmyUpper(b.activation)}
Current Plan
: :
:
:
Account Number   000000000
:
Billing Cycle Date   : ${dmyUpper(b.cycleDate)}
Email: ${PERSON.email}
Registered Mobile Number: +000000000
JioFiber Bill Summary
${b.plan}
Pay By : ${dmyUpper(b.payBy)}
Total Payable : ${total.toFixed(2)}
Previous Balance Due   ${b.previousDue.toFixed(2)}
Payment Received   ${b.paymentReceived.toFixed(2)}
Total Current Month Charges   ${total.toFixed(2)}
Advance Payment Received   0.00
Current Balance   ${total.toFixed(2)}
Total Payable   ${total.toFixed(2)}
${b.plan}:   1)Unlimited Data @ 30 Mbps 2)Unlimited Voice 3)Subscription to 13 PAID OTT apps 4)Connectivity Rental includes
provision of all CPE(s)
Note: This plan is an advance rental plan.
Plan Details :
(\`) ${total.toFixed(2)} Total Current Charges (A+B)
A.   Plan Charges (Excluding Taxes)
Sr.No.   Description   Services   From Date   To Date   No. Of Days   Amount (\`)
1   Monthly Plan Charges   Connectivity   ${dmyUpper(b.cycleDate)}   ${dmyUpper(b.periodTo)}   30   ${b.connectivity.toFixed(2)}
2   Monthly Plan Charges   Platform   ${dmyUpper(b.cycleDate)}   ${dmyUpper(b.periodTo)}   30   ${b.platform.toFixed(2)}
Total   ${plan.toFixed(2)}
B.   Taxes
Sr.No.   Description   Charges (\`)   CGST (\`)   SGST (\`)   Amount (\`)
1   Tax   ${plan.toFixed(2)}   ${half.toFixed(2)}   ${half.toFixed(2)}   ${tax.toFixed(2)}
Payment History
${b.history.payments[0]}   ${b.history.payments[1]}
\` ${b.history.payments[2].toFixed(2)}   \` ${b.history.payments[3].toFixed(2)}
Your Payment History
Bill History
${b.history.bills[0]}   ${b.history.bills[1]}
\` ${b.history.bills[2].toFixed(2)}   \` ${b.history.bills[3].toFixed(2)}
Page Repeat
Reach Us :
o   1800-89-69999 ( from other networks) or Call 199 (from Jio Fixed Line Number) Write to ${PERSON.email} Manage your world of Jio with MyJio app Visit
www.jio.com
o   You can now download your detailed tax invoices on MyJio / jio.com in the invoice history section.
o   Current month charges reflect the charges levied in any bill period including taxes as applicable.
o   All the plan rentals are charged in advance for the no. of days till your next bill cycle, except for first bill generated post activation, where it also includes prorated
charges from activation date to your billing cycle date.
o   Connectivity service (includes Data Services) & Platform services (includes Device charges & Subscription of OTT services).
For Your Information :
`;
}

// ---- L&T Finance home loan welcome letter ---------------------------------------------------------

export const WELCOME = {
  loan: 2850000,
  tenure: 216,
  ratePct: 8.65,
  processingFee: 24516.4,
  brokenPeriodInterest: 5120.33,
  disbursed: '2024-06-12',
  emiStart: '2024-08-03',
};

function addMonths(iso, n) {
  const [y, m, d] = ymd(iso);
  const t = new Date(Date.UTC(y, m - 1 + n, d));
  return t.toISOString().slice(0, 10);
}

function welcome(w = WELCOME) {
  const e = emi(w.loan, w.ratePct, w.tenure);
  return `Welcome Letter for your Loan Account Number: H000000000000000000
Customer Details   Product & Property Details
Name:   ${PERSON.name}
Address:   ${PERSON.address}, MUMBAI 400099
Mobile Number:   9000000000
Email ID:   ${PERSON.email}
Product:   HOME LOAN
Property Address:   SAMPLE PROPERTY, THANE 400601
Dear Customer,
Greetings from L&T Finance Limited (formerly known as L&T Finance Holdings Limited) (LTF/L&T Finance),
We welcome you to the L&T Finance family and thank you for choosing us as your partner in growth.
Given below are your loan and details.
Loan Amount (Rs.)   Tenure   EMI Amount (Rs.)   EMI Cycle and Frequency
Rs. ${intl(w.loan)}/-   ${w.tenure}   Rs. ${intl(e)}/-   3rd - Monthly
Loan details   Deductions from disbursement
Sanction Amount   Rs. ${intl(w.loan)}/-   Processing Fees   Rs. ${intl(w.processingFee)}/-
Disbursement Amount   Rs. ${intl(w.loan)}/-   Broken Period Interest   Rs. ${intl(w.brokenPeriodInterest)}/-
Disbursement Date   ${dmyLong(w.disbursed)}
Disbursement Status   Fully disbursed
Annualised Interest Rate   ${w.ratePct.toFixed(2).padStart(5, '0')}% p.a.
Interest Type   Floating - Monthly
Scheme   NA
Subvention End Date   NA
Repayment details
Mode of Repayment   Auto Debit   EMI Start Date   ${dmyLong(w.emiStart)}
Repayment Bank Name   SAMPLE BANK OF
INDIA   EMI End Date   ${dmyLong(addMonths(w.emiStart, w.tenure - 1))}

We encourage you to honour the financial commitments as per terms of the agreement. Kindly refer attached repayment
schedule for repayment details for further terms & conditions.
Please mention your loan agreement number stated above in all future correspondence with us.
We value our relationship and assure you of our best services.
Thanking you,
L&T Finance Limited
(formerly known as L&T Finance Holdings Limited)
This is a system generated letter and hence does not require any signature.
Enclosed: Repayment Schedule, Schedule of Charges, Provisional Interest Certificate & List of Documents.
Important Points:
1. Please mention your Loan Account No. stated above for all future correspondence with us.
2. Please ensure that your bank account is adequately funded at least a day before the Instalment date. This will avoid levy
of additional charges/bounce charges for non-receipt of payment and ensure a smooth track record of your repayment.
3. In case your loan is being closed through the process of pre-payment, the upcoming instalment is likely to be presented
on originally scheduled date. You are requested to issue a 'Stop Payment' instruction to your banker in respect of
repayment instruments with respect to future loan instalments.

Disclaimer:
Personal details, NOC and EMI related QR Codes are not applicable for Warehouse Receipt Finance.
NOC QR Code-Not applicable for Home loans.
`;
}

// ---- SBI Gold Loan OD statement -------------------------------------------------------------------

export const GOLD = {
  limit: 960000,
  ratePct: 9.7,
  statementDate: '2026-11-24',
  opened: '2026-03-12',
};

/** Chronological rows: debit (+) increases what is owed, credit (-) reduces it. */
function goldRows() {
  const t = (date, kind, amount, label) => ({ date, kind, amount, label });
  return [
    t('2026-03-12', 'wdl_ch', 5400),
    t('2026-03-12', 'dep_rlms', -5400),
    t('2026-03-12', 'wdl', 210000, 'Loan Repayment'),
    t('2026-03-12', 'wdl', 280000, 'Loan Repayment'),
    t('2026-03-12', 'wdl', 190000, 'Transfer to Family or'),
    t('2026-03-13', 'wdl', 95500.75, 'Loan Repayment'),
    t('2026-03-13', 'wdl', 120000, 'Business in service s'),
    t('2026-03-14', 'dep', -40000, 'Loan Repayment'),
    t('2026-03-31', 'interest', 3912.4),
    t('2026-03-31', 'penal', 11.2),
    t('2026-04-09', 'dep', -24000, 'Loan Repayment'),
    t('2026-04-30', 'interest', 7456.18),
    t('2026-04-30', 'penal', 18.75),
    t('2026-05-27', 'debit', 7800),
    t('2026-05-27', 'salary', -7800),
    t('2026-05-31', 'interest', 7702.33),
    t('2026-05-31', 'penal', 4.9),
    t('2026-06-27', 'salary', -9600),
    t('2026-06-30', 'interest', 7515.06),
    t('2026-06-30', 'penal', 38.1),
    t('2026-07-07', 'dep_label', -7210.45, 'SMA REC'),
    t('2026-07-09', 'dep', -9600, 'Loan Repayment'),
    t('2026-07-23', 'dep_label', -17330.6, 'SMA REC'),
    t('2026-07-31', 'interest', 7598.71),
    t('2026-07-31', 'penal', 50.35),
    t('2026-08-31', 'interest', 7487.92),
    t('2026-08-31', 'penal', 13.4),
    t('2026-09-17', 'wdl', 24000, 'Deposit or Investment'),
    t('2026-09-30', 'interest', 7390.44),
    t('2026-10-07', 'dep_label', -24118.9, 'Irregularity Recovery'),
    t('2026-10-31', 'interest', 7611.85),
    t('2026-10-31', 'penal', 31.62),
    t('2026-11-03', 'dep', -28800, 'Loan Repayment'),
    t('2026-11-03', 'dep', -3100, 'Loan Repayment'),
  ];
}

function goldLoan(g = GOLD) {
  let bal = 0;
  const rows = goldRows().map((r, i) => {
    bal = r2(bal + r.amount);
    return { ...r, balance: bal, ref: `SBIY02260000000000000000${String(1000 + i)}` };
  });
  const outstanding = rows[rows.length - 1].balance;
  const owner = `000000000 OF Mr. ${PERSON.name}\nSAMPLE AT 00999 SAMPLE NAGAR`;
  const line = (r) => {
    // Month-end rows of the first month print "DR" on the next line, as the bank's PDF wraps it.
    const dr = (b) =>
      b === 0 ? '0.00' : r.date === '2026-03-31' ? `${inr(b)}\nDR` : `${inr(b)}DR`;
    const d = `${slashDmy(r.date)}   ${slashDmy(r.date)}`;
    const amt = Math.abs(r.amount);
    switch (r.kind) {
      case 'interest':
        return `${d}   TO INTEREST   -   ${inr(amt)}   -   ${dr(r.balance)}`;
      case 'penal':
        return `${d}   OD Penal Charge   -   ${inr(amt)}   -   ${dr(r.balance)}`;
      case 'salary':
        return `${d}   CEMTEX DEP   BY SALARY   -   -   ${inr(amt)}   ${dr(r.balance)}`;
      case 'debit':
        return `${d}   DEBIT   -   ${inr(amt)}   -   ${dr(r.balance)}`;
      case 'dep_label':
        return `${d}   DEP TFR   ${r.label}\n${owner}\n-   -   ${inr(amt)}   ${dr(r.balance)}`;
      case 'dep_rlms':
        return `${d}   DEP TFR   RLMS\n${owner}\n-   -   ${inr(amt)}   ${dr(r.balance)}`;
      case 'wdl_ch':
        return `${d}   WDL TFR CH   000000000 AT\n00999 SAMPLE NAGAR   -   ${inr(amt)}   -   ${dr(r.balance)}`;
      case 'dep':
        return `${d}   DEP TFR\n${r.ref}/M/\n${r.label}\n${owner}\n-   -   ${inr(amt)}   ${dr(r.balance)}`;
      case 'wdl':
        return `${d}   WDL TFR\n${r.ref}/M/\n${r.label}\n${owner}\n-   ${inr(amt)}   -   ${dr(r.balance)}`;
      default:
        throw new Error(r.kind);
    }
  };
  const newestFirst = [...rows].reverse().map(line);
  const header = 'Post Date   Value Date   Details   Ref No/Cheque   Debit   Credit   Balance';
  const pages = [newestFirst.slice(0, 11), newestFirst.slice(11, 24), newestFirst.slice(24)];
  const body = pages.map((p, i) => `${header}\n${p.join('\n')}\n${i + 1} Page no-\n`).join('\n');
  return `Account Summary
Welcome:
Customer XXXXXXX0000
STATEMENT OF ACCOUNT
${PERSON.name}
${PERSON.email}
${PERSON.address}
SAMPLE ROAD
MUMBAI 400099, Mumbai, Maharashtra, 400099
Date of Statement   :   ${dashDmy(g.statementDate)}
Outstanding Amount
Sanctioned Amount
Rate of Interest
Loan Term
Remaining Tenure
EMI
:
:
:
:
:
:
Account open Date   :
${inr(g.limit)}
-${inr(outstanding)}
${g.ratePct.toFixed(2)}%
Months
null Months
0.00
${dashDmy(g.opened)}
State Bank of India
MUMBAI
1 SAMPLE BRANCH ROAD, SAMPLE NAGAR,
DIST:MUMBAI, MAHARASHTRA, 400099
Branch Code
Branch Email
IFSC Code   :
:
:   00999
branch@example.com
SBIN0000000
: CIF NO
: Account No
: Account
: Currency
: Product
000000000
000000000
Gold Loan OD
INR
Open
Statement   :   ${dashDmy(g.opened)} to ${dashDmy(g.statementDate)}
As on ${dashDmy(g.statementDate)}
Ownership   :   OWN
${body}`;
}

// ---- SBI Card statements --------------------------------------------------------------------------

const cdate = (iso) => {
  const [y, m, d] = ymd(iso);
  return `${d2(d)} ${cap(MON[m - 1])} ${String(y).slice(2)}`;
};
const clong = (iso) => {
  const [y, m, d] = ymd(iso);
  return `${d2(d)} ${cap(MON[m - 1])} ${y}`;
};
const IGST = 'IGST DB @ 18.00%';
const gst = (n) => r2(n * 0.18);

/** One card row. `tax` prints "(EXCL TAX n)" in the shape given by `form`. */
function crow(r) {
  const head = r.undated ? '' : `${cdate(r.iso)}   `;
  let text = r.text;
  if (r.tax !== undefined) {
    const t = r.tax.toFixed(2);
    if (r.form === 'wide') text = `${r.text} (EXCL TAX   ${t})`;
    else if (r.form === 'trail') text = `${r.text}   (EXCL TAX ${t})`;
    else if (r.form === 'glued') text = `${r.text}(EXCL TAX ${t})`;
    else text = `${r.text} (EXCL TAX ${t})`;
  }
  const fx = r.fx ? `${r.fx}   ` : '';
  return `${head}${text}   ${fx}${inr(r.amt)}   ${r.mk}`;
}

/** Totals printed in the account summary, derived from the rows so they always reconcile. */
function cardTotals(c) {
  const all = [...c.credits, ...c.fees, ...c.buys, ...(c.more ?? [])];
  const payments = r2(all.filter((r) => r.mk === 'C').reduce((s, r) => s + r.amt, 0));
  const fees = r2(c.fees.filter((r) => r.mk === 'D').reduce((s, r) => s + r.amt, 0));
  const purchases = r2(
    [...c.buys, ...(c.more ?? [])].filter((r) => r.mk === 'D').reduce((s, r) => s + r.amt, 0),
  );
  const total = r2(c.previous - payments + purchases + fees);
  const minimum = r2(Math.max(200, total * 0.05));
  const available = Math.max(0, r2(c.limit - total));
  return { payments, fees, purchases, total, minimum, available };
}

const CARD_TERMS = `A day after the statement is generated post account
classification as NPA, all EMI plans (excluding restructured plans)
available on the account shall be closed & the principal
outstanding along with the outstanding interest accrued till the
date of such EMI plans shall be debited to the Credit Card
Account & appear in the subsequent monthly statement.
Payments made through digital channels such as UPI, BBPS, NEFT, etc will
continue to be free of any additional charges.
Important Notes
•Description of Services :- Credit Card Services
•HSN Code : 000000
•Declaration : We hereby declare that the tax in relation to this
statement is not payable under reverse charge mechanism
•Name and the address of the supplier : SBI Cards and Payment
Services Limited (SBI Card) , Sample Tower, Sample Road, Gurugram,
HR - 000000
•Kindly note that this temporary credit (T) has been rendered to
you in the interim and though the amount is included in your
available credit limit, you will not be able to spend the amount
while the dispute is still under investigation.
Important Information on Disputed Transaction(s):
SBI Card (SBICPSL) is a Corporate Agent of Sample Insurance Co. Limited.
Instant information 24X7, by just sending an SMS to 5676791
Balance Enquiry:   Available Credit & Cash limit:
BAL XXXX   AVAIL XXXX
Hotlist Lost/Stolen Card:
BLOCK XXXX
XXXX = Last 4 Digits of the Card No.
For SBI Cards and Payment Services Limited (SBI Card).
Authorized Signatory
Version 1.1 / OCT, 2025
SAVINGS AND BENEFITS SECTION
For this statement   For this year   From the card issue date`;

const CARD_SCHEDULE = `Schedule of Charges
SBI Card PRIME   2,999   2,999 (Waived off on annual spends of 3 Lakh or more
in the preceding year)
Shaurya SBI Card   250   250 (Waived off on annual spends of 50,000 or more
in the preceding year)
SimplyCLICK SBI Card   499   499 (Waived off on annual spends of 1 Lakh or more
in the preceding year)
20-50 days (applicable only on retail purchases and
if previous month’s outstanding balance is paid in full)
3.75% p.m. (45% p.a.) for Unsecured Cards; 2.75% p.m.
(33% p.a.) for Shaurya, Defence Cards and Secured cards
\` 25
100% of GST + 100% of EMI amount + 100% of Fees/Charges
+ 100% of finance charges + Overlimit Amount (if any) + 2% of
remaining balance outstanding.
Cash Back
Petrol Surcharge Waiver
Reward Points
Important Terms & Conditions   Charges & Cardholder Agreement   Privacy Policy   Reach Us   Payment Options .   .   .   .   .
IMPORTANT INFORMATION
Order of payment settlement   -Payment received against the Cardholder's outstanding will be adjusted
against 100% of GST, 100% of EMI amount, 100% of Fees/Charges, 100% of Finance charges, Balance
transfer, Retail Spends and Cash Advance, in that order.
Ways to make payment for your SBI Credit Card
Pay via UPI
You can pay your bill faster via UPI payment mode on SBI Credit Card app or on website using QR
code.
Cheque
Pay your SBI Credit Card dues through cheque. You can drop your cheque at any of the SBI Card
drop boxes available across India.`;

function rewardBlock(c, labels) {
  const [prev, earned, redeemed] = c.points;
  const closing = prev + earned + redeemed;
  return `${prev}   ${earned}   ${redeemed}   ${closing}${labels}`;
}

function cardTail(c, t, noneLine) {
  const w = c.waiver ?? 0;
  return (
    `${CARD_TERMS}
${inr(0)}   ${inr(0)}   ${inr(0)}
${inr(w)}   ${inr(c.waiverYear)}   ${inr(c.waiverTotal)}
${c.points[1]}   ${c.pointsYear}   ${c.pointsTotal}
${CARD_SCHEDULE}
${noneLine ?? ''}`.trimEnd() + '\n'
  );
}

/** Layout A: the summary block comes before the transaction rows (pdf.js value block). */
function cardA(c) {
  const t = cardTotals(c);
  const rowsOf = (list) => list.map(crow).join('\n');
  const second = c.more
    ? `${rowsOf(c.more)}
Date   Transaction Details
for Statement Period: ${cdate(c.from)} to ${cdate(c.to)}   Amount   ( \` )
`
    : '';
  return `**Minimum Amount Due
Credit Card Number
*Total Amount Due
Statement Date Cash Limit Credit Limit
Available Credit Limit   Available Cash Limit   Payment Due Date
Previous Balance   Total Outstanding
Payments,
Reversals & other
Credits
Additions
Purchases & Other
Debits
Fee, Taxes &
Interest Charges
ACCOUNT SUMMARY
Important Messages
*Total Amount Due (TAD) needs to be paid by payment due date to avoid levy of finance charges on new transactions done after the statement date.The difference,if any, between the Total Amount
Due and the Total Outstanding is the balance on the Flexipay/Encash/Installments as applicable.** To keep your credit card in good standing,you have the option of paying atleast the minimum
amount due on or before the due date.The Minimum Amount Due includes the EMI on Flexipay/Encash/Installment amounts & 100% of all applicable taxes.Content of this statement will be considered
correct if no error is reported within 20 days.
(including cash)   (as part of credit limit)
( \` )
( \` )
( \` ) ( \` )
( \` )   ( \` )
( \` )   ( \` )   ( \` )   ( \` )   ( \` )
for Statement Period: ${cdate(c.from)} to ${cdate(c.to)}
Date   Amount Transaction Details
GSTIN of SBI Card : 06AAAAA0000A1ZV   Stmt/Debit Note/Credit Note/Tax Invoice
Transactions highlighted in grey color, if any, do not form part of Purchases & Other Debits; #Transactions fully/partially converted to Flexipay/Encash/Merchant EMI.
(DUPLICATE FOR SUPPLIER)
C=Credit ;   D=Debit; EN=Encash; FP=Flexipay; EMD=Easy Money Draft; BT=Balance Transfer; M=Monthly Installments; TAD=Total Amount Due; T=Temporary Credit.
Pay Now
XXXX XXXX XXXX XX00
STMT No.
PLACE OF SUPPLY   :
:   T000000000
MAH/27/MAHARASHTRA
CKYC No. : 00000000000000
${inr(t.total)}
${inr(t.minimum)}
${inr(c.limit)}   ${inr(c.cashLimit)}
${inr(t.available)}   ${inr(c.cashLimit)}
${inr(t.payments)}   ${inr(t.purchases)}   ${inr(t.fees)}
${clong(c.to)}
${clong(c.due)}
${inr(t.total)} ${inr(c.previous)}
${rowsOf(c.credits)}
${rowsOf(c.fees)}
TRANSACTIONS FOR ${PERSON.name}
${rowsOf(c.buys)}
${rewardBlock(
  c,
  `
Previous Balance   Earned   Redeemed/Expired
/Reversed   Closing Balance   Points Expiry Details
NONE
SHOP & SMILE SUMMARY
${PERSON.name}
`,
)}
${second}
${cardTail(c, t)}`;
}

/** Layout B: labels first, then everything else; the value block follows "Pay Now". */
function cardB(c) {
  const t = cardTotals(c);
  const rowsOf = (list) => list.map(crow).join('\n');
  return `Important Messages
GSTIN of SBI Card : 06AAAAA0000A1ZV   Stmt/Debit Note/Credit Note/Tax Invoice
Transactions highlighted in grey color, if any, do not form part of Purchases & Other Debits; #Transactions fully/partially converted to Flexipay/Encash/Merchant EMI.
(DUPLICATE FOR SUPPLIER)
Credit Card Number
*Total Amount Due
**Minimum Amount Due   ( \`
)
Statement Date Cash Limit   ( \`
)
(as part of credit limit) ( \` )   (including cash) Credit Limit
Payment Due Date ( \` ) Available Cash Limit ( \` ) Available Credit Limit
( \` ) ( \` ) ( \` ) ( \` ) ( \` )
Total Outstanding Fee, Taxes &
Interest Charges
Additions
Purchases & Other
Debits
Payments,
Reversals & other
Credits
Previous Balance
Transaction Details Date   Amount   ( \` )
*Total Amount Due (TAD) needs to be paid by payment due date to avoid levy of finance charges on new transactions done after the statement date.The difference,if any, between the Total Amount
Due and the Total Outstanding is the balance on the Flexipay/Encash/Installments as applicable.** To keep your credit card in good standing,you have the option of paying atleast the minimum
amount due on or before the due date.The Minimum Amount Due includes the EMI on Flexipay/Encash/Installment amounts & 100% of all applicable taxes.Content of this statement will be considered
correct if no error is reported within 20 days.Subject to meeting the eligible spend amount,the Annual Fee reversal will reflect in your SBI Card account within 10 days of the fee being levied.
( \` )
for Statement Period: ${cdate(c.from)} to ${cdate(c.to)}
ACCOUNT SUMMARY
C=Credit ;   D=Debit; EN=Encash; FP=Flexipay; EMD=Easy Money Draft; BT=Balance Transfer; M=Monthly Installments; TAD=Total Amount Due; T=Temporary Credit.
Pay Now
XXXX XXXX XXXX XX00
STMT No.
PLACE OF SUPPLY   :
:   T000000000
MAH/27/MAHARASHTRA
CKYC No. : 00000000000000
${inr(t.total)}
${inr(t.minimum)}
${inr(c.limit)}   ${inr(0)}
${inr(t.available)}   ${inr(0)}
${inr(t.payments)}   ${inr(t.purchases)}   ${inr(t.fees)}
${clong(c.to)}
${clong(c.due)}
${inr(t.total)} ${inr(c.previous)}
${rowsOf(c.credits)}
${rowsOf(c.fees)}
TRANSACTIONS FOR ${PERSON.name}
${rowsOf(c.buys)}
${c.points[0]}   ${c.points[1]}   ${c.points[2]}   ${c.points[0] + c.points[1] + c.points[2]}   NONE
Previous Balance   Earned   Redeemed/Expired/
Reversed   Closing Balance   Points Expiry Details
${PERSON.name}

${cardTail(c, t)}`;
}

const buy = (iso, text, amt, extra = {}) => ({ iso, text, amt, mk: 'D', ...extra });
const pay = (iso, amt) => ({ iso, text: 'PAYMENT RECEIVED 0000000000REF', amt, mk: 'C' });

// Card A: a revolving card, three consecutive statements.
export const CARD_A = [
  {
    from: '2026-08-13',
    to: '2026-09-12',
    due: '2026-10-02',
    limit: 85000,
    cashLimit: 4250,
    previous: 17484.6,
    points: [412, 96, 0],
    pointsYear: 1210,
    pointsTotal: 5320,
    waiver: 24.18,
    waiverYear: 61.9,
    waiverTotal: 188.35,
    credits: [
      pay('2026-08-24', 3100),
      pay('2026-09-02', 5850),
      pay('2026-09-06', 8534.6),
      { iso: '2026-09-09', text: 'FUEL SURCHARGE WAIVER EXCL TAX', amt: 24.18, mk: 'C' },
    ],
    fees: [
      { iso: '2026-09-12', text: 'FIN CHARGE ON RETAIL', tax: gst(648.2), amt: 648.2, mk: 'D' },
      { undated: true, text: IGST, amt: gst(648.2), mk: 'D' },
    ],
    buys: [
      buy('2026-09-07', 'UPI-Meta Verified', 1199),
      buy('2026-09-07', 'UPI-FACEBOOK INDIA ONLIERVICES PVT LTD', 1199),
      buy('2026-09-07', 'UPI-FACEBOOK INDIA ONLIERVICES PVT LTD', 1199),
      buy('2026-09-07', 'UPI-Meta Verified', 1199),
      buy('2026-09-08', 'UPI-Euronet Services InPvt Ltd', 1180.5),
      buy('2026-09-08', 'UPI-ACME STORE 01', 436.2),
      buy('2026-09-09', 'UPI-ACME STORE 02', 187.75),
      buy('2026-09-09', 'UPI-ACME STORE 03', 214.3),
      buy('2026-09-09', 'UPI-ACME STORE 04', 52.4),
      buy('2026-09-10', 'ACME STORE 05   IN', 3340.9),
      buy('2026-09-10', 'UPI-ACME STORE 06', 905.65),
      buy('2026-09-11', 'ACME STORE 07   IN', 6212.35),
      buy('2026-09-12', 'UPI-Facebook India Onliervices Private L', 2399),
    ],
  },
  {
    from: '2026-09-13',
    to: '2026-10-12',
    due: '2026-11-01',
    limit: 85000,
    cashLimit: 4250,
    previous: 0,
    points: [508, 84, 0],
    pointsYear: 1294,
    pointsTotal: 5404,
    waiver: 0,
    waiverYear: 61.9,
    waiverTotal: 188.35,
    credits: [
      pay('2026-09-21', 1150),
      pay('2026-09-29', 2400),
      pay('2026-10-02', 640),
      pay('2026-10-05', 2400),
      pay('2026-10-08', 1150),
      pay('2026-10-10', 1150),
      pay('2026-10-12', 1150),
    ],
    fees: [
      { iso: '2026-10-12', text: 'FIN CHARGE ON RETAIL', tax: gst(702.45), amt: 702.45, mk: 'D' },
      { undated: true, text: IGST, amt: gst(702.45), mk: 'D' },
    ],
    buys: [
      buy('2026-09-13', 'UPI-ACME STORE 08', 263.1),
      buy('2026-09-14', 'UPI-ACME STORE 09', 644.55),
      buy('2026-09-14', 'UPI-ACME STORE 10', 301.2),
      buy('2026-09-15', 'UPI-Euronet Services InPvt Ltd', 1175.9),
      buy('2026-09-17', 'UPI-ACME STORE 11', 219.7),
      buy('2026-09-21', 'GOOGLECLOUD   IN', 590),
      buy('2026-09-23', 'GOOGLECLOUD   IN', 590),
      buy('2026-09-30', 'GOOGLECLOUD   IN', 1180),
      buy('2026-09-30', 'LOVABLE   US', 1790.35),
      buy('2026-10-03', 'GOOGLECLOUD   IN', 590),
      buy('2026-10-03', 'LOVABLE   US', 1801.2),
      buy('2026-10-07', 'GOOGLECLOUD   IN', 590),
      buy('2026-10-12', 'UPI-Facebook India Onliervices Private L', 899),
      buy('2026-10-12', 'UPI-Meta Verified', 559.8),
    ],
  },
  {
    from: '2026-10-13',
    to: '2026-11-12',
    due: '2026-12-02',
    limit: 85000,
    cashLimit: 4250,
    previous: 0,
    points: [592, 313, 0],
    pointsYear: 1607,
    pointsTotal: 5717,
    waiver: 7.12,
    waiverYear: 69.02,
    waiverTotal: 195.47,
    credits: [
      pay('2026-10-17', 1500),
      pay('2026-10-18', 235),
      pay('2026-10-24', 2400),
      pay('2026-10-26', 1180),
      pay('2026-10-27', 355),
      pay('2026-10-28', 590),
      pay('2026-10-29', 1180),
      pay('2026-10-31', 475),
      pay('2026-11-02', 22800),
      { iso: '2026-11-06', text: 'FUEL SURCHARGE WAIVER EXCL TAX', amt: 7.12, mk: 'C' },
      pay('2026-11-10', 14900),
    ],
    fees: [
      {
        iso: '2026-11-12',
        text: 'FIN CHARGE ON RETAIL',
        tax: gst(412.8),
        amt: 412.8,
        mk: 'D',
        form: 'wide',
      },
      {
        undated: true,
        text: 'FORGN CURR MARKUP DB',
        tax: gst(58.35),
        amt: 58.35,
        mk: 'D',
        form: 'wide',
      },
      { undated: true, text: IGST, amt: r2(gst(412.8) + gst(58.35)), mk: 'D' },
    ],
    buys: [
      buy('2026-10-13', 'UPI-META', 515.4),
      buy('2026-10-17', 'UPI-ACME STORE 12', 201.9),
      buy('2026-10-17', 'UPI-ACME STORE 13', 38.55),
      buy('2026-10-17', 'ANTHROPIC   US', 1310.6, { fx: '13.85 USD' }),
      buy('2026-10-24', 'UPI-Meta Verified', 1799),
      buy('2026-10-24', 'LOVABLE   US', 1698.4),
      buy('2026-10-26', 'GOOGLECLOUD   IN', 590),
      buy('2026-10-26', 'LOVABLE   US', 604.75),
      buy('2026-10-27', 'FACEBOOKCOMADSMANAGER   IN', 1180),
      buy('2026-10-27', 'FACEBOOKCOMADSMANAGER   IN', 3.5),
      { iso: '2026-10-27', text: 'FACEBOOKCOMADSMANAGER   IN', amt: 3.5, mk: 'C' },
      buy('2026-10-29', 'ANTHROPIC   US', 568.2, { fx: '6.02 USD' }),
      buy('2026-11-02', 'GOOGLECLOUD   IN', 590),
      buy('2026-11-02', 'UPI-ACME STORE 14', 61.2),
      buy('2026-11-02', 'UPI-ACME STORE 15', 17.75),
      buy('2026-11-03', 'UPI-AIRTEL PAYMENTS BANMITED', 2360),
      buy('2026-11-03', 'UPI-ACME STORE 16', 765.4),
    ],
    more: [
      buy('2026-11-04', 'UPI-ACME STORE 17', 113.6),
      buy('2026-11-04', 'UPI-ACME STORE 18', 47.3),
      buy('2026-11-04', 'UPI-ACME STORE 18', 23.65),
      buy('2026-11-07', 'UPI-Jio Prepaid Recharg', 789),
      buy('2026-11-07', 'UPI-ACME STORE 19', 712.9),
      buy('2026-11-08', 'UPI-ACME STORE 14', 178.4),
      buy('2026-11-08', 'UPI-URBAN COMPANY LIMIT', 1935.8),
      buy('2026-11-09', 'UPI-ACME STORE 20', 685.55),
      buy('2026-11-09', 'UPI-NATURES BASKET LTD', 687.15),
      buy('2026-11-11', 'UPI-ACME STORE 21', 261.3),
      buy('2026-11-11', 'UPI-META', 2360),
      buy('2026-11-12', 'UPI-ACME STORE 22', 3540.75),
      buy('2026-11-12', 'UPI-facebookadsmanager', 1416),
    ],
  },
];
// Each statement opens with the previous statement's closing balance.
for (let i = 1; i < CARD_A.length; i++) CARD_A[i].previous = cardTotals(CARD_A[i - 1]).total;

// Card B: a different card with the same last digits, a large revolving balance, an annual-fee reversal,
// a late-payment fee, forex markup and a USD purchase.
export const CARD_B = {
  from: '2026-08-19',
  to: '2026-09-18',
  due: '2026-10-08',
  limit: 410000,
  cashLimit: 0,
  previous: 396214.37,
  points: [-6240, 188, 0],
  pointsYear: -5902,
  pointsTotal: -6052,
  waiver: 0,
  waiverYear: 0,
  waiverTotal: 0,
  credits: [
    {
      iso: '2026-08-18',
      text: 'SBR ANNUAL FEE REVERSA',
      tax: gst(3399),
      amt: 3399,
      mk: 'C',
      form: 'glued',
    },
    { iso: '2026-09-04', text: 'PAYMENT RECEIVED 0000000000REF', amt: 3850.25, mk: 'C' },
    { iso: '2026-09-05', text: 'PAYMENT RECEIVED 0000000000REF', amt: 9250, mk: 'C' },
    { iso: '2026-09-07', text: 'PAYMENT RECEIVED 0000000000REF', amt: 14800, mk: 'C' },
  ],
  fees: [
    {
      iso: '2026-09-07',
      text: 'FEE - LATE PAYMENT',
      tax: gst(1180),
      amt: 1180,
      mk: 'D',
      form: 'trail',
    },
    { iso: '2026-09-18', text: 'FIN CHARGE ON RETAIL', tax: gst(14310.62), amt: 14310.62, mk: 'D' },
    {
      undated: true,
      text: 'FORGN CURR MARKUP DB',
      tax: gst(52.64),
      amt: 52.64,
      mk: 'D',
      form: 'wide',
    },
    { undated: true, text: IGST, amt: r2(gst(14310.62) + gst(52.64)), mk: 'D' },
  ],
  buys: [
    buy('2026-09-07', 'ANTHROPIC* CLAUDE SUB ANTHROPIC.COM CA', 2631.8, { fx: '27.84 USD' }),
    buy('2026-09-08', 'LOVABLE   LOVABLE.DEV   DE', 2905.4),
    buy('2026-09-14', 'GOOGLE WORKSPACE   MUMBAI   IN', 1180),
  ],
};

// ---- shared helpers for the bank-style fixtures ----------------------------------------------------

/** Small deterministic PRNG so the generated fixtures never change between runs. */
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const randInt = (rand, lo, hi) => lo + Math.floor(rand() * (hi - lo + 1));
const pickOf = (rand, list) => list[Math.floor(rand() * list.length)];
const hms = (s) => `${d2(Math.floor(s / 3600))}:${d2(Math.floor((s % 3600) / 60))}:${d2(s % 60)}`;
const BANKS4 = ['KKBK', 'UBIN', 'YESB', 'HDFC', 'UTIB', 'IBKL', 'SBIN', 'ICIC', 'DCBL', 'PUNB'];

/** Walk dated events in order, keeping the balance non-negative by inserting a funding credit first. */
function chainRows(events, opening, fund) {
  const sorted = events
    .map((e, i) => ({ ...e, i }))
    .sort(
      (a, b) =>
        (a.date + (a.time ?? '12:00:00')).localeCompare(b.date + (b.time ?? '12:00:00')) ||
        a.i - b.i,
    );
  const out = [];
  let bal = opening;
  for (const e of sorted) {
    let amount = e.amount;
    if (e.sweep) amount = r2(bal - e.sweep);
    if (e.drain !== undefined) amount = r2(bal - e.drain);
    if (
      e.dir === 'dr' &&
      (amount <= 0 || (e.sweep === undefined && e.drain === undefined && amount > bal))
    ) {
      if (e.drain !== undefined || e.sweep !== undefined) continue;
      const need = r2(amount - bal + fund.pad(amount));
      const f = fund.make(e, need);
      bal = r2(bal + f.amount);
      out.push({ ...f, balance: bal });
    }
    bal = e.dir === 'dr' ? r2(bal - amount) : r2(bal + amount);
    out.push({ ...e, amount, balance: bal });
  }
  return { rows: out, opening };
}

// ---- SBI savings (two-date rows, separate debit / credit columns) -----------------------------------

const SBI_BRANCH = ['0000000 AT 00999', 'DEMOBR'];

function sbiSavingsEvents() {
  const R = rng(20260611);
  const ev = [];
  const day = (d) => `2026-${d}`;
  const add = (d, t, e) => ev.push({ date: day(d), time: hms(t), ...e });
  // Plain UPI debits to invented payees, spread over the two months.
  const days = [];
  for (const m of ['06', '07'])
    for (let d = 1; d <= (m === '06' ? 30 : 31); d++) days.push(`${m}-${d2(d)}`);
  let payee = 100;
  for (const d of days) {
    const n = randInt(R, 0, 2);
    for (let k = 0; k < n; k++) {
      payee = payee >= 124 ? 100 : payee + 1;
      const amt = r2(randInt(R, 40, 1400) + pickOf(R, [0, 0, 0.4, 0.75, 0.87]));
      add(d, 30000 + k * 900 + randInt(R, 0, 500), {
        dir: 'dr',
        amount: amt,
        kind: 'upi',
        payee: `PAYEE${payee}`,
        bank: pickOf(R, BANKS4),
        form: randInt(R, 0, 3),
      });
    }
  }
  // UPI Lite top-ups (wallet).
  for (const [d, a] of [
    ['06-02', 1100],
    ['06-03', 1500],
    ['06-04', 2000],
    ['06-07', 3000],
    ['06-09', 1200],
    ['06-10', 1000],
    ['06-12', 2500],
    ['06-14', 1800],
    ['06-16', 1000],
    ['06-17', 2200],
    ['06-19', 1400],
    ['06-21', 2000],
    ['06-24', 1500],
    ['06-26', 1000],
    ['06-29', 1750],
    ['07-02', 1300],
    ['07-05', 1100],
    ['07-09', 2400],
    ['07-12', 1000],
    ['07-16', 1900],
    ['07-20', 1200],
    ['07-27', 1500],
  ])
    add(d, 45000 + randInt(R, 0, 5000), { dir: 'dr', amount: a, kind: 'lite' });
  // Cards, telecom, mandates.
  add('06-03', 38000, { dir: 'dr', amount: 2425, kind: 'sbicard' });
  add('06-04', 61000, { dir: 'dr', amount: 4310, kind: 'sbicard' });
  add('06-25', 50400, { dir: 'dr', amount: 5120, kind: 'sbicard' });
  add('06-06', 52000, { dir: 'dr', amount: 719, kind: 'jio' });
  add('07-06', 52100, { dir: 'dr', amount: 3190.5, kind: 'jio' });
  add('06-12', 40000, { dir: 'dr', amount: 4900, kind: 'family' });
  add('06-21', 40000, { dir: 'dr', amount: 16200, kind: 'family' });
  // Cash.
  add('06-03', 43000, { dir: 'dr', amount: 4500, kind: 'atm', branch: 'ACME BANK BRANCH' });
  add('06-08', 36000, { dir: 'dr', amount: 4500, kind: 'atm', branch: '+BRANCH' });
  add('06-06', 53000, { dir: 'cr', amount: 18350, kind: 'cdm', ref: '6101' });
  add('06-06', 53100, { dir: 'cr', amount: 12120, kind: 'cdm', ref: '6102' });
  add('06-06', 53200, { dir: 'cr', amount: 2940, kind: 'cashself' });
  add('06-04', 53200, { dir: 'cr', amount: 8200, kind: 'cashself' });
  add('06-22', 53200, { dir: 'cr', amount: 6400, kind: 'cashself' });
  add('06-07', 39000, { dir: 'cr', amount: 37800, kind: 'chq' });
  add('07-27', 39000, { dir: 'cr', amount: 37800, kind: 'chq' });
  // Loan repayments and SMA recoveries (the bank sweeps what is in the account).
  add('06-05', 70000, { dir: 'dr', kind: 'sma', sweep: 0.64 });
  add('06-09', 60000, { dir: 'dr', amount: 9800, kind: 'loan' });
  add('06-09', 60100, { dir: 'dr', amount: 9800, kind: 'loan' });
  add('06-23', 70000, { dir: 'dr', kind: 'sma', sweep: 0.29 });
  // Credits: own-account transfers, LIC, reversal, dividends, small ACH.
  for (const [d, a] of [
    ['06-02', 2000],
    ['06-04', 4900],
    ['06-07', 3500],
    ['06-10', 1500],
    ['06-12', 4800],
    ['06-14', 2500],
    ['06-17', 1900],
    ['06-19', 3200],
    ['06-21', 2700],
    ['06-24', 1600],
    ['06-26', 4400],
    ['06-28', 2100],
    ['07-01', 3000],
    ['07-04', 1800],
    ['07-08', 2600],
    ['07-11', 3300],
    ['07-14', 2300],
    ['07-17', 2900],
    ['07-21', 1700],
    ['07-24', 3600],
    ['07-28', 2200],
    ['07-30', 4100],
  ])
    add(d, 41000 + randInt(R, 0, 4000), { dir: 'cr', amount: a, kind: 'self' });
  add('06-29', 33000, { dir: 'cr', amount: 487.65, kind: 'lic' });
  add('06-10', 33000, { dir: 'cr', amount: 51.18, kind: 'div' });
  add('06-14', 33500, { dir: 'cr', amount: 128.4, kind: 'reversal' });
  add('07-26', 34000, { dir: 'cr', amount: 4.88, kind: 'ach' });
  return ev;
}

function sbiLines(e) {
  const split = (s) => s;
  switch (e.kind) {
    case 'upi': {
      const v = e.form;
      const b = e.bank;
      const mid =
        v === 0
          ? [`UPI/DR/0000000/${e.payee}/`, 'RATN/amznpltwcr/UPI']
          : v === 1
            ? [`UPI/DR/0000000/${e.payee}`, `x/${b}/xxxx/UPI`]
            : v === 2
              ? [`UPI/DR/0000000/${e.payee}`, `/${b.toLowerCase()}/0000000/UPI`]
              : [`UPI/DR/0000000/${e.payee}`, `x/${b}/xxxx/Mand`];
      return ['WDL TFR', ...mid, ...SBI_BRANCH];
    }
    case 'lite':
      return ['WDL TFR', 'UPI/DR/0000000/UPILITE', ...SBI_BRANCH];
    case 'sbicard':
      return ['WDL TFR', 'UPI/DR/0000000/SBI', 'Card/KKBK/sbicardp.b/Pay', ...SBI_BRANCH];
    case 'jio':
      return ['WDL TFR', 'UPI/DR/0000000/JIO', 'Post/YESB/paytm-0000/UPI', ...SBI_BRANCH];
    case 'family':
      return [
        'WDL TFR',
        'SBIY000000000000000000000/M/',
        'Transfer to Family or',
        '0000000 OF PERSON 031',
        'ACME TRAVELS AT 00999',
        'DEMOBR',
      ];
    case 'atm':
      return ['ATM WDL   ATM CASH', `0000000 ${e.branch}`, 'BRANCH SAMPLE'];
    case 'sma':
      return [
        'WDL TFR   SMA REC',
        `0000000 OF Mr. ${PERSON.name}`,
        `${PERSON.name} ${PERSON.name} AT 00999 DEMOBR`,
      ];
    case 'loan':
      return [
        'WDL TFR',
        'SBIY000000000000000000000/M/',
        'Loan Repayment',
        `0000000 OF Mr. ${PERSON.name}`,
        `${PERSON.name} ${PERSON.name} AT 00999 DEMOBR`,
      ];
    case 'self':
      return [
        'DEP TFR',
        `UPI/CR/0000000/${PERSON.name}`,
        `x/UBIN/xxxx/${split('UPI')}`,
        ...SBI_BRANCH,
      ];
    case 'lic':
      return ['CEMTEX DEP   ACHCr', 'NACH00000000060085 LIFE', 'INSURANCE CORPO'];
    case 'div':
      return ['CEMTEX DEP   ACHCr', 'ACME01790000000001', 'SAMPLEDIV2025 2026'];
    case 'reversal':
      return ['CEMTEX DEP', 'UPI/REVERSAL/0000000/11', '062026/3504'];
    case 'ach':
      return ['CEMTEX DEP', 'C00000000000', '00000000000ACME FINANCIAL', 'SERVICE'];
    case 'cdm':
    case 'cashself':
    case 'chq':
      return [''];
    default:
      throw new Error(e.kind);
  }
}

function sbiSavings() {
  const { rows, opening } = chainRows(sbiSavingsEvents(), 9418.36, {
    pad: () => 400,
    make: (e, need) => ({
      date: e.date,
      time: e.time,
      dir: 'cr',
      amount: Math.ceil(need / 100) * 100 + 50,
      kind: 'self',
    }),
  });
  const dd = (iso) => slashDmy(iso);
  const out = [];
  const perPage = [5, 11, 10, 9, 11, 10, 9, 11];
  let page = 0;
  let onPage = 0;
  const cols = (r, frag) =>
    r.dir === 'dr'
      ? `${frag ? `${frag}   ` : ''}-   ${inr(r.amount)}   -   ${inr(r.balance)}`
      : `${frag ? `${frag}   ` : ''}-   -   ${inr(r.amount)}   ${inr(r.balance)}`;
  const debits = rows.filter((r) => r.dir === 'dr');
  const credits = rows.filter((r) => r.dir === 'cr');
  const sum = (l) => r2(l.reduce((s, r) => s + r.amount, 0));
  const last = rows[rows.length - 1];
  const header = `STATEMENT OF ACCOUNT
State Bank of India
${PERSON.name}
Account Number   :   00000000000
Product   :   REGULAR SB CHQ-INDIVIDUALS
IFSC Code   :   SBIN0000000
Interest Rate   :   2.50 % p.a.
Statement From   : 01-06-2026 to 31-07-2026
As on 03-08-2026
CKYCR Number   :   Not Available
MICR Code   :   0000000
STATEMENT OF ACCOUNT
State Bank of India
Branch Name   :   DEMOBR
Balance`;
  for (const r of rows) {
    if (onPage >= perPage[Math.min(page, perPage.length - 1)]) {
      page++;
      onPage = 0;
      out.push(`${page} Page no.\n\nBalance`);
    }
    const lines = sbiLines(r);
    // Rows whose last text line carries the columns after a reference fragment.
    let text = `${dd(r.date)}   ${dd(r.date)}   ${lines[0]}`;
    const rest = lines.slice(1);
    if (r.kind === 'cdm') {
      text = `${dd(r.date)}   ${dd(r.date)}   CSH DEP (CDM)   0000000\n${cols(r, r.ref)}`;
    } else if (r.kind === 'cashself') {
      text = `${dd(r.date)}   ${dd(r.date)}   CASH DEPOSIT SELF   AT 00999\nDEMOBR   -   -   ${inr(r.amount)}   ${inr(r.balance)}`;
    } else if (r.kind === 'chq') {
      text = `${dd(r.date)}   ${dd(r.date)}   CREDIT   Chq 000000 FBL PrBr\n${cols(r, '00999')}`;
    } else {
      text = `${[text, ...rest].join('\n')}\n${cols(r)}`;
    }
    out.push(text);
    onPage++;
  }
  page++;
  const summary = `${page} Page no.

Statement Summary   : 01-06-2026 To 31-07-2026
Brought Forward   Dr Count   Cr Count   Total Debits   Total Credits   Closing Balance
${inr(opening)}CR   ${inr(sum(debits))}   ${inr(sum(credits))}   ${inr(last.balance)}CR ${debits.length}   ${credits.length}
Please do not share your ATM, Debit/Credit Card number, PIN (Personal Identification number ), OTP (One-Time Password), Username or Password with
anyone via email, SMS, phone call, or any other medium. Bank never asks for such information.
If your account is operated by a Power of Attorney holder, please review the transactions with extra care.
This is a computer generated statement and does not require a signature.
(   )   (   )   (   )   (   )
`;
  return `${header}\n${out.join('\n')}\n${summary}`;
}

// ---- Union Bank savings (pdf.js multi-line rows: date, time, remarks, "instr amount balance") --------

export const UNION = { emiTotalHint: null };

function unionEvents(emiTotal) {
  const R = rng(20261104);
  const ev = [];
  const add = (iso, t, e) => ev.push({ date: iso, time: hms(t), ...e });
  const monthDays = { '08': 31, '09': 30, 10: 31, 11: 21 };
  const upi = (payeeN, form) => ({
    dir: 'dr',
    kind: 'upi',
    payee: `PAYEE${String(payeeN).padStart(3, '0')}`,
    form,
  });
  let p = 10;
  for (const m of ['08', '09', '10', '11']) {
    for (let d = m === '08' ? 2 : 1; d <= monthDays[m]; d++) {
      const iso = `2026-${m}-${d2(d)}`;
      const n = randInt(R, 0, 2);
      for (let k = 0; k < n; k++) {
        p = p >= 150 ? 10 : p + 1;
        const amount = r2(randInt(R, 60, 4200) + pickOf(R, [0, 0, 0.5, 0.97, 0.13]));
        add(iso, 26000 + k * 7000 + randInt(R, 0, 6000), {
          ...upi(p, randInt(R, 0, 3)),
          amount,
          bank: pickOf(R, BANKS4),
        });
      }
      if (R() < 0.25)
        add(iso, 52000 + randInt(R, 0, 9000), {
          dir: 'cr',
          kind: 'upiab',
          payee: 'PAYEE002',
          amount: pickOf(R, [1600, 4800, 2400, 640, 1250]),
        });
    }
  }
  // The first row of the statement is a payment, so the opening balance is unambiguous.
  ev.splice(0, ev.length, ...ev.filter((e) => !(e.date === '2026-08-02')));
  add('2026-08-02', 68196, { ...upi(0, 1), amount: 187.25, bank: 'UBIN' });
  // Workspace: a prorated first month, then the full price.
  const ws = [
    ['2026-08-03', 62.15],
    ['2026-09-03', 1185.5],
    ['2026-10-03', 1185.5],
    ['2026-11-03', 1185.5],
  ];
  for (const [d, a] of ws)
    add(d, 23482, {
      dir: 'dr',
      kind: 'brand',
      lines: ['UPIAR/000000', '/DR/Google', 'W/utib/googleworkspa', 'c'],
      amount: a,
    });
  // The EMI auto-debit fails at 08:56 on the 3rd: a pair of service charges (the second with a split Tran Id).
  const fee = 531.3;
  const fails = { '2026-08-03': 2, '2026-09-03': 2, '2026-10-03': 2, '2026-11-03': 2 };
  for (const [d, n] of Object.entries(fails)) {
    add(d, 32182, { dir: 'dr', kind: 'mand', amount: fee, split: false });
    if (n === 2) add(d, 32182, { dir: 'dr', kind: 'mand', amount: fee, split: true });
  }
  add('2026-08-12', 49396, { dir: 'dr', kind: 'mand', amount: fee, split: false });
  add('2026-10-14', 50116, { dir: 'dr', kind: 'mand', amount: fee, split: false });
  add('2026-11-08', 33716, { dir: 'dr', kind: 'mand', amount: fee, split: false });
  add('2026-11-08', 33716, { dir: 'dr', kind: 'mand', amount: fee, split: true });
  // Known merchants (public brands the alias catalogue recognises).
  const brand = (d, t, lines, amount, dir = 'dr') =>
    add(d, t, { dir, kind: 'brand', lines, amount });
  brand('2026-08-10', 70000, ['UPIAR/000000', '/DR/Google', 'I/UTIB/gpay-utility@o'], 842.6);
  brand('2026-09-09', 65000, ['UPIAR/000000', '/DR/Google', 'I/UTIB/gpay-utility@o'], 1210.4);
  brand('2026-10-11', 64000, ['UPIAR/000000', '/DR/Google', 'I/UTIB/gpay.bp.utilit'], 695.75);
  brand('2026-08-20', 61000, ['UPIAR/000000', '/DR/Google', 'I/UTIB/gpay.bp.toll@o'], 355);
  brand('2026-10-02', 60000, ['UPIAR/000000', '/DR/Google', 'I/UTIB/gpay.bp.toll@o'], 355);
  brand('2026-09-21', 59000, ['UPIAR/000000', '/DR/Google', 'I/UTIB/gpay-toll@okpa'], 140);
  brand('2026-08-18', 30000, ['UPIAR/000000', '/DR/Indian R/SBIN/', 'bdpg.iruts@sb'], 512.3);
  brand('2026-09-26', 36000, ['UPIAR/000000', '/DR/', 'MYGATE/HDFC/myga'], 4180.55);
  brand('2026-08-23', 29000, ['UPIAR/000000', '/DR/Euronet', '/UTIB/gpayrecharge2'], 749);
  brand('2026-10-23', 29500, ['UPIAR/000000', '/DR/Euronet', '/UTIB/gpayrecharge2'], 749);
  brand('2026-09-02', 55000, ['UPIAR/000000', '/DR/', 'Lovable/NSPB/cf.lova'], 1802.6);
  brand('2026-10-02', 55000, ['UPIAR/000000', '/DR/', 'Lovable/NSPB/cf.lova'], 1809.45);
  brand('2026-08-27', 47000, ['UPIAR/000000', '/DR/', 'Blinkit/HDFC/blinkit.rz'], 612.8);
  brand('2026-10-19', 47000, ['UPIAR/000000', '/DR/', 'BLINKIT/HDFC/blinkit'], 934.15);
  brand('2026-08-15', 33000, ['UPIAR/000000', '/DR/', 'META/ICIC/facebooka', 'x'], 1399);
  brand('2026-09-30', 33000, ['UPIAR/000000', '/DR/', 'META/ICIC/facebooka', 'x'], 665);
  brand('2026-10-05', 33000, ['UPIAR/000000', '/DR/', 'META/ICIC/facebooka', 'x'], 710.5);
  brand('2026-09-17', 30000, ['UPIAR/000000', '/DR/Facebook/INDB/fa', 'x'], 899);
  brand('2026-10-17', 30000, ['UPIAR/000000', '/DR/Facebook/INDB/fa', 'x'], 899);
  brand('2026-11-14', 30000, ['UPIAR/000000', '/DR/facebook/UTIB/fa', 'x'], 1249);
  // Shop QR / UPI handles without a name.
  for (const [d, a] of [
    ['2026-09-01', 480],
    ['2026-09-12', 1325],
    ['2026-10-09', 760.2],
    ['2026-11-10', 215],
  ])
    brand(d, 35000, ['UPIAR/000000', '/DR/', 'SHOP/YESB/paytmqr'], a);
  for (const [d, a] of [
    ['2026-08-31', 2400],
    ['2026-09-27', 3100],
    ['2026-10-25', 1950],
    ['2026-11-19', 2700],
  ])
    brand(d, 36500, ['UPIAR/000000', '/DR/', '/sbin/000000@s', 'b'], a);
  // Cash-like and bank-initiated rows.
  const etxn = (d, t, lines, amount, dir) =>
    add(d, t, { dir, kind: 'plain', lines, amount, instr: '-' });
  etxn('2026-08-05', 56000, ['eTXN/By:000000', '000000/ubi sys'], 5650, 'cr');
  etxn('2026-08-14', 52000, ['eTXN/By:000000', '000000/own'], 11300, 'cr');
  etxn('2026-09-04', 54000, ['eTXN/By:000000', '000000/Self'], 22600, 'cr');
  etxn('2026-10-06', 52500, ['eTXN/By:000000', '000000/SAY'], 6780, 'cr');
  etxn('2026-11-07', 59800, ['eTXN/To:000000', '000000/Sal'], 17250, 'dr');
  add('2026-08-08', 34700, {
    dir: 'dr',
    kind: 'plain',
    lines: ['000000/6', '000000/000000', '000000'],
    amount: 5650,
    instr: '-',
  });
  add('2026-08-21', 41400, {
    dir: 'dr',
    kind: 'plain',
    lines: ['000000/6', '000000/000000', '000000'],
    amount: 2373,
    instr: '-',
  });
  // Salary-like NEFT credits from PAYEE009 (no instrument id on these rows).
  [
    ['2026-08-06', 7080],
    ['2026-08-12', 910.4],
    ['2026-08-30', 7080],
    ['2026-09-20', 7080],
    ['2026-10-27', 7080],
    ['2026-11-17', 7080],
  ].forEach(([d, a], i) => add(d, 49000 + i * 600, { dir: 'cr', kind: 'neft', amount: a, n: i }));
  // The loan EMI: UPI part-payments in September, one NEFT for both EMIs in November.
  const lt = (d, t, a) =>
    add(d, t, {
      dir: 'dr',
      kind: 'brand',
      lines: ['UPIAR/000000', '/DR/L AND T', '/HDFC/landtfinance1.'],
      amount: a,
    });
  lt('2026-09-10', 66691, 24318.4);
  lt('2026-09-16', 55610, 27905.12);
  add('2026-09-11', 53740, {
    dir: 'cr',
    kind: 'plain',
    lines: ['UPI DRC TXN', '000000'],
    amount: 24318.4,
    instr: '-',
  });
  add('2026-09-16', 50000, {
    dir: 'cr',
    kind: 'plain',
    lines: ['UPI DRC TXN', '000000'],
    amount: 27905.12,
    instr: '-',
  });
  add('2026-11-02', 70000, { dir: 'dr', kind: 'neftout', amount: emiTotal });
  add('2026-11-02', 60000, { dir: 'cr', kind: 'neft', amount: emiTotal, n: 99 });
  // Draining the account late on the 2nd leaves a small balance for the 09:00 check on the 3rd.
  for (const [d, target] of [
    ['2026-09-02', 8442.74],
    ['2026-10-02', 6114.84],
    ['2026-11-02', 8201.2],
  ])
    add(d, d === '2026-11-02' ? 82000 : 80000, {
      dir: 'dr',
      kind: 'upi',
      payee: 'PAYEE002',
      form: 0,
      bank: 'UBIN',
      drain: target,
    });
  return ev;
}

function unionRemarks(r) {
  const mask = ['x/XXXX/xxxxxxxx'];
  switch (r.kind) {
    case 'upi': {
      const forms = [
        [`UPIAR/000000`, `/DR/${r.payee}`, ...mask, ...mask],
        [`UPIAR/000000`, `/DR/${r.payee}/${r.bank}/`, ...mask],
        [`UPIAR/000000`, `/DR/${r.payee}/${r.bank.slice(0, 2)}`, ...mask],
        [`UPIAR/000000`, `/DR/${r.payee}/${r.bank}/pa`, ...mask],
      ];
      return forms[r.form % 4];
    }
    case 'upiab':
      return [`UPIAB/000000`, `/CR/${r.payee}`, ...mask, ...mask];
    case 'mand':
      return r.split
        ? ['SMB8D170', '0', 'MAND DR-Insufficient', 'Balance-Service', 'Charges']
        : [`MAND DR-Insufficient`, 'Balance-Service', 'Charges'];
    case 'neft':
      return [
        `NEFT:PAYEE009`,
        'x',
        'x x',
        `SAL SBIN1262${r.n % 10}`,
        'x',
        `No:SBIN1262${r.n % 10}88`,
        '000000',
      ];
    case 'neftout':
      return ['NEFTO-PAYEE123', 'FINANCE LIMITED', '000000'];
    default:
      return [...r.lines];
  }
}

function unionStatement() {
  const emiTotal = SOA_EMI_TOTAL;
  const { rows } = chainRows(unionEvents(emiTotal), 6112.4, {
    pad: () => 900,
    make: (e, need) => ({
      date: e.date,
      time: e.time,
      dir: 'cr',
      kind: 'upiab',
      payee: 'PAYEE002',
      amount: Math.ceil(need / 50) * 50 + 25,
    }),
  });
  const footer = (n) => `Page No${n}
For any queries, please get in touch with us on our 24 x 7 customer service help line no.1800 2222 44 #. Customers outside India need to dial +91 80 2530 2510.
This is a system generated output and requires no signature. Customers are requested to immediately notify the Bank of any discrepancy in the statement
TO AVAIL OUR LOAN PRODUCTS GIVE MISSED CALL AT 000000 OR SMS <ULOAN> TO 000000
`;
  const out = [];
  let page = 0;
  const perPage = 17;
  const midRow = Math.floor(rows.length * 0.6);
  rows.forEach((r, i) => {
    const [d, m, y] = [r.date.slice(8), r.date.slice(5, 7), r.date.slice(0, 4)];
    const body = unionRemarks(r);
    if (!(r.kind === 'mand' && r.split)) body[0] = `TX0000000 ${body[0]}`;
    const instr = r.kind === 'neft' ? '' : '-   ';
    const end = `${instr}${inr(r.amount)}   ${inr(r.balance)}`;
    const head = `${d}-${m}-${y}\n${r.time}`;
    if (i === midRow) {
      // A page break lands between the remarks and the amount line of this row.
      page++;
      out.push(`${head}\n${body.join('\n')}\n${footer(page)}${end}`);
    } else out.push(`${head}\n${body.join('\n')}\n${end}`);
    if ((i + 1) % perPage === 0 && i !== midRow && i + 1 < rows.length) {
      page++;
      if (page === 1)
        out.push(`Records from 1 to ${rows.length}.   No more records available.
x
x
x
x x
x
x
Statement Period From -01/08/2026 To 21/11/2026
${footer(page)}`);
      else out.push(footer(page));
    }
  });
  page++;
  out.push(footer(page).trimEnd());
  return `Statement of Account
${PERSON.name}   Union Bank of India
DEMO ADDRESS   Branch   DEMO BRANCH, MUMBAI
Customer Id   000000
City   MUMBAI
Account No   000000
State   MAHARASHTRA
Account Currency INR
Country   INDIA
Account Type   Saving Account
Zip   000000
IFSC Code   UBIN0000000
Statement Date : 21/11/2026 11:12
Statement Period From -01/08/2026 To 21/11/2026
Records from 1 to ${rows.length}.   No more records available.
Date   Tran Id-1 Remarks   UTR Number   Instr. ID   Withdrawals   Deposits   Balance
${out.join('\n')}
`;
}

// ---- Google Pay "Transaction statement" (pdf.js order) ----------------------------------------------

const gpAmount = (n) =>
  `₹${n.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`;
const GP_CARD = 'State Bank of India 0000 | RuPay credit card';
const GP_LITE = 'UPI Lite | State Bank of India 0000';
const GP_SBI = 'State Bank of India 0000';
const GP_UNION = 'Union Bank of India 0000';

function gpayRows() {
  const R = rng(20260503);
  const rows = [];
  const MERCH = [
    ['ACME HOTEL', GP_CARD, [146.35, 245, 389.9]],
    ['ACME CHEMIST', GP_LITE, [172.6, 96.4, 211.75]],
    ['SAMPLE ENCLAVE OWNERS ASSOCIATION', GP_UNION, [4820.35]],
    ['ACME GENERAL STORE', GP_LITE, [241.3, 74.5, 131.1]],
    ['SAMPLE DAIRY', GP_LITE, [61, 122]],
    ['ACME FUELS', GP_CARD, [2100, 1500, 3250.4]],
    ['SAMPLE CAFE', GP_CARD, [310.5, 187, 442.25]],
    ['ACME BAKERY', GP_LITE, [90.4, 38.6, 135]],
    ['SAMPLE MART', GP_CARD, [684.3, 1275.9]],
  ];
  const times = () => 6 * 3600 + randInt(R, 0, 15 * 3600);
  let person = 0;
  for (let day = 3; day <= 16; day++) {
    const n = randInt(R, 6, 9);
    const list = [];
    for (let k = 0; k < n; k++) {
      const roll = R();
      if (roll < 0.55) {
        person = (person + randInt(R, 1, 7)) % 60;
        list.push({
          kind: 'Paid to',
          payee: `PERSON ${String(person).padStart(3, '0')}`,
          by: R() < 0.85 ? GP_LITE : GP_SBI,
          amt: r2(randInt(R, 10, 360) + pickOf(R, [0, 0.5, 0.9, 0.2])),
        });
      } else {
        const [name, by, amts] = pickOf(R, MERCH);
        list.push({ kind: 'Paid to', payee: name, by, amt: pickOf(R, amts) });
      }
    }
    for (const x of list) rows.push({ day, t: times(), ...x });
  }
  const add = (day, kind, payee, by, amt) =>
    rows.push({ day, t: 11 * 3600 + 45 * 60 + rows.length, kind, payee, by, amt });
  add(3, 'Top-up to', 'UPI Lite', GP_SBI, 1100);
  add(6, 'Top-up to', 'UPI Lite', GP_SBI, 1500);
  add(9, 'Top-up to', 'UPI Lite', GP_SBI, 2000);
  add(13, 'Top-up to', 'UPI Lite', GP_SBI, 1200);
  add(5, 'Self transfer to', 'PERSON 005', GP_UNION, 4500);
  add(8, 'Received from', 'Google Cloud', GP_SBI, 590);
  add(12, 'Received from', 'PERSON 038', GP_SBI, 750);
  rows.sort((a, b) => a.day - b.day || a.t - b.t);
  return rows;
}

function gpayStatement() {
  const rows = gpayRows();
  const furniture = (n) => `
Transaction statement
000000000, user@example.com
Note: This statement reflects payments made by you on the Google Pay app. Self transfer payments are not included in the total money paid and
received. Any payments transactions and activity deleted from your Google Account will not show up in this statement.
Page ${n} of 179
Date & time   Transaction details   Amount
`;
  const clock = (s) => {
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    return `${d2(((h + 11) % 12) + 1)}:${d2(m)} ${h >= 12 ? 'PM' : 'AM'}`;
  };
  const sent = r2(
    rows.filter((r) => r.kind !== 'Received from').reduce((s, r) => s + r.amt, 0) * 31,
  );
  const parts = [
    `Transaction statement
000000000, user@example.com
Note: This statement reflects payments made by you on the Google Pay app. Self transfer payments are not included in the total money paid and
received. Any payments transactions and activity deleted from your Google Account will not show up in this statement.
Page 1 of 179
Transaction statement period
01 May 2026 - 31 October 2026
Sent
₹${intl(sent)}
Received
₹${intl(r2(sent * 0.14))}
Date & time   Transaction details   Amount`,
  ];
  let page = 1;
  rows.forEach((r, i) => {
    if (i > 0 && i % 9 === 0) parts.push(furniture(++page).trimEnd());
    const lines = [
      `${d2(r.day)} May, 2026`,
      clock(r.t),
      `${r.kind} ${r.payee}`,
      'UPI Transaction ID: 000000000000',
    ];
    if (r.kind === 'Received from') lines.push(`Paid to ${r.to ?? 'PERSON 005'}`);
    else if (r.by) lines.push(`Paid by ${r.by}`);
    lines.push(gpAmount(r.amt));
    const body = lines.join('\n');
    // The last row is cut off by the end of the extract: no amount.
    parts.push(i === rows.length - 1 ? body.slice(0, body.lastIndexOf('\n')) : body);
  });
  return parts.join('\n');
}

// ---- L&T Finance home loan statement of account ------------------------------------------------------

export const SOA = {
  loan: 6240000,
  ratePct: 8.15,
  tenure: 240,
  disbursed: '2024-04-30',
  firstEmi: '2024-06-03',
  statementDate: '2026-11-24',
  processingFee: 14751.2,
  brokenPeriodInterest: 7226.45,
  firstDisbursal: 312000,
  bounceCharge: 1770,
  // Instalment months that bounced: [yyyy-mm, reason, charged, re-presented]
  bounces: [
    ['2024-09', 'kyc', false, false],
    ['2024-10', 'kyc', false, false],
    ['2024-11', 'kyc', false, false],
    ['2025-08', 'ib', true, false],
    ['2025-10', 'ib', true, false],
    ['2026-01', 'ib', true, false],
    ['2026-02', 'ib', true, false],
    ['2026-03', 'ib', true, false],
    ['2026-05', 'ib', true, false],
    ['2026-07', 'ib', true, true],
    ['2026-08', 'ib', true, true],
    ['2026-09', 'ib', true, true],
    ['2026-10', 'ib', true, true],
    ['2026-11', 'ib', true, true],
  ],
};

/** Total of the loan statement's EMI and the welcome letter's EMI (both on the 3rd of the month). */
export const SOA_EMI_TOTAL = r2(
  emi(SOA.loan, SOA.ratePct, SOA.tenure) + emi(WELCOME.loan, WELCOME.ratePct, WELCOME.tenure),
);

const eom = (mk) => {
  const [y, m] = mk.split('-').map(Number);
  return `${mk}-${d2(new Date(Date.UTC(y, m, 0)).getUTCDate())}`;
};

function soa(s = SOA) {
  const e = emi(s.loan, s.ratePct, s.tenure);
  const lt = (iso) => dmyUpper(iso);
  const monthKey = (iso) => iso.slice(0, 7);
  const label = (iso) => `${MON[ymd(iso)[1] - 1]}/${ymd(iso)[0]}`;
  const rows = [];
  let bal = 0;
  const push = (text, dr, cr, d1, d2v) => {
    bal = r2(bal + dr - cr);
    rows.push({ d1, d2: d2v ?? d1, text, dr, cr, bal });
  };
  // Disbursement and fees.
  const d2nd = r2(s.loan - s.firstDisbursal);
  push('Processing Fees- Due (Incl. Tax)', s.processingFee, 0, s.disbursed);
  push('Broken Period Interest-', s.brokenPeriodInterest, 0, s.disbursed);
  push(`\nNet Amount Transferred In Favour Of:${PERSON.name}`, s.firstDisbursal, 0, s.disbursed);
  const builder = r2(s.loan - bal);
  push(
    '\nNet Amount Transferred In Favour Of:ACME BUILDERS\nPrivate Limited',
    builder,
    0,
    s.disbursed,
  );
  push('Amt Financed', 0, s.firstDisbursal, s.disbursed);
  push('Amt Financed', 0, d2nd, s.disbursed);
  // Amortisation, for the printed principal / interest split.
  const rate = s.ratePct / 1200;
  let principalLeft = s.loan;
  let principalBilled = 0;
  let interestBilled = 0;
  let lastSplit = { p: 0, i: 0 };
  let lateInterest = 0;
  let bounceChargesBilled = 0;
  const bounceByMonth = new Map(s.bounces.map((b) => [b[0], b]));
  let k = 0;
  const lateRows = [];
  for (let iso = s.firstEmi; iso <= s.statementDate; iso = addMonths(iso, 1)) {
    k++;
    const mk = monthKey(iso);
    const interest = r2(principalLeft * rate);
    const prin = r2(e - interest);
    principalLeft = r2(principalLeft - prin);
    principalBilled = r2(principalBilled + prin);
    interestBilled = r2(interestBilled + interest);
    lastSplit = { p: prin, i: interest };
    push(`Due For Instalment   ${k}`, e, 0, iso);
    const b = bounceByMonth.get(mk);
    const cheque = `Cheque Pmnt Rcvd Vide E0000000~ Receipt No.   E0000000`;
    if (!b) {
      push(`${cheque}\nClear ${label(iso)}`, 0, e, iso);
      continue;
    }
    push(`${cheque}\nBounced ${label(iso)}`, 0, e, iso);
    const nextDay = addMonths(iso, 0).slice(0, 8) + d2(ymd(iso)[2] + 1);
    if (b[1] === 'kyc') {
      push(
        `E0000000~ Receipt No. E0000000   Bounced\nMiscellaneous KYC Doc Pending`,
        e,
        0,
        nextDay,
        iso,
      );
      const pd = `${mk}-${d2(ymd(iso)[2] + 5)}`;
      push(`Online Pmnt Rcvd Vide ~ Receipt No.   O0000000 Clear\n${label(iso)}`, 0, e, pd);
      if (k === 4) {
        const late = r2(e * 0.00348);
        lateRows.push(late);
        push(
          `Late Payment Charges Due (Incl. Tax)${dmyShort(iso).replace(/-/g, ' ').toUpperCase()} Installment\nNo : ${k}`,
          late,
          late,
          eom(mk),
        );
      }
      continue;
    }
    push(`E0000000~ Receipt No. E0000000   Bounced   INSUFFICIENT\nBALANCE`, e, 0, iso);
    if (b[2]) {
      push(`Bounce Charges-Installment${k}- NA`, s.bounceCharge, 0, iso);
      bounceChargesBilled = r2(bounceChargesBilled + s.bounceCharge);
    }
    const last = mk === monthKey(s.statementDate);
    if (b[3]) {
      const rd = `${mk}-${d2(Math.min(ymd(iso)[2] + 10, 28))}`;
      push(
        `${cheque.replace('E0000000~', 'R0000000~').replace('E0000000', 'R0000000')}\nBounced ${label(iso)}`,
        0,
        e,
        rd,
      );
      push(`R0000000~ Receipt No. R0000000   Bounced   Insufficient\nBalance`, e, 0, rd);
    }
    if (!last) {
      // The instalment is paid later in parts; the bounce charge stays on the account.
      const parts = [r2(e * 0.55), r2(e * 0.25)];
      parts.push(r2(e - parts[0] - parts[1]));
      parts.forEach((a, j) => {
        const pd = `${mk}-${d2(Math.min(ymd(iso)[2] + 12 + j * 3, 28))}`;
        if (j === parts.length - 1)
          push(
            `Online Pmnt Rcvd Vide ~ Receipt No   . O0000000 INR ${Math.floor(a / 1000)}\n${(a % 1000).toFixed(2).padStart(6, '0')} For Instalment   ${k}   Clear ${label(iso)}`,
            0,
            a,
            pd,
          );
        else push(`Online Pmnt Rcvd Vide ~ Receipt No.   O0000000 Clear\n${label(iso)}`, 0, a, pd);
      });
      const late = r2(e * (0.0046 + 0.0004 * (k % 4)));
      lateInterest = r2(lateInterest + late);
      push(
        `Late Payment Interest ${dmyShort(iso).replace(/-/g, ' ').toUpperCase()} Installment No : ${k}\n`,
        late,
        0,
        eom(mk),
      );
    }
  }
  // The statement ends mid-month with the current month's overdue interest.
  const overdueNow = r2(e * 0.014);
  push('Current Month Overdue-', overdueNow, 0, s.statementDate);

  // Row text: rows with a newline in `text` start with the dates alone on the first line.
  const body = [];
  rows.forEach((r, idx) => {
    const lines = r.text.split('\n');
    const money = `${inr(r.dr)}   ${inr(r.cr)}   ${inr(r.bal)}`;
    const lastLine = lines[lines.length - 1];
    const tailText = `${lastLine ? `${lastLine}   ` : ''}${money}`;
    let out;
    if (lines.length === 1) {
      out = `${lt(r.d1)}   ${lt(r.d2)}   ${tailText}`;
    } else if (lines[0] === '') {
      out = [`${lt(r.d1)}   ${lt(r.d2)}`, ...lines.slice(1, -1), tailText].join('\n');
    } else {
      out = [`${lt(r.d1)}   ${lt(r.d2)}`, ...lines.slice(0, -1), tailText].join('\n');
    }
    body.push(out);
    if ((idx + 1) % 38 === 0)
      body.push('\nDate   Value Date   Particulars   DR (Rs)   CR (Rs)   Balance');
  });

  const dueDay = ymd(s.firstEmi)[2];
  const paidInst = k - 1;
  const balanceTenure = s.tenure - k;
  const prinPaid = r2(principalBilled - lastSplit.p);
  const intPaid = r2(interestBilled - lastSplit.i);
  const futurePrincipal = r2(s.loan - principalBilled);
  const misc = r2(bounceChargesBilled + overdueNow);
  const lateCharged = r2(lateRows.reduce((a, b) => a + b, 0));
  const accrued = r2((principalLeft * rate * (ymd(s.statementDate)[2] - 3)) / 30);
  const csLate = r2(lateInterest);
  const total = bal;
  const endDate = addMonths(s.firstEmi, s.tenure - 1);
  const chargeLines = s.bounces.filter((b) => b[2]).length;
  void paidInst;
  void chargeLines;
  void misc;
  const bounceSummary = [];
  for (const b of s.bounces) {
    const [y, m] = b[0].split('-').map(Number);
    const dt = `${y}-${d2(m)}-${d2(dueDay)}`;
    const reason =
      b[1] === 'kyc'
        ? m % 2
          ? 'Miscellaneous KYC Doc Pending'
          : 'Misc-KYC documents pending'
        : 'INSUFFICIENT BALANCE';
    const num = (y - 2024) * 12 + m - 5;
    bounceSummary.push(
      `${lt(dt)}   EMI-${num} - ${MON[m - 1]}/${y}   ${Math.round(e * 0.885)}   ${reason}`,
    );
    if (b[3])
      bounceSummary.push(
        `${lt(`${y}-${d2(m)}-${d2(dueDay + 10)}`)}   EMI-${num} - ${MON[m - 1]}/${y}   ${Math.round(e * 0.885)}   Insufficient Balance`,
      );
  }
  return `Loan account statement of H000000000000000000 for the period ${lt(s.disbursed)} to ${dmyLong(s.statementDate)} Dated ${dmyLong(s.statementDate)}
Click here To Update Contact Details
Click here to pay overdue
Customer Name & Contact Details   Product & Property Details
${PERSON.name}
${PERSON.address}, MUMBAI 400099
Phone No.:   900XXXXX00
Mobile No.:   900XXXXX00
Email:   deXXXXXXr@example.com
Customer GSTIN ID:   NA
State Code:   27
Product:   HOME LOAN
Property Address:   SAMPLE PROPERTY, THANE 400601
HSN Code:   997113
Customer & Bank Details   Loan Details   Instalment and Payment Details
Applicant name:   ${PERSON.name}
Agreement No:   H000000000000000000
Customer ID: 00000000
LTF GSTIN ID:   27AAAAA0000A1ZZ
Central KYC:   XXXXXXXXXX0000
CKYC) Id
Branch:   SAMPLE-MUMBAI-100
Co-Applicant Name(s): CO APPLICANT
Place of Supply   MAHARASHTRA
_________________________________________
Bank Name:   UNION BANK OF INDIA
Bank Account:   xxxxxxxxxxxx000
Mandate Status:   REGISTERED
Disbursement Date   ${lt(s.disbursed)}
Amount Sanctioned (Rs)   ${intl(s.loan)}
Amount Disbursed (Rs):   ${intl(s.loan)}
Annualised Interest Rate %   ${s.ratePct.toFixed(2)}
Interest Rate Type   Floating
Loan Tenure (Months)   ${s.tenure}
Balance Tenure (Months)   ${balanceTenure}
Subvention   NA
Subvention Period(Months)   0
Loan Status   Active
Currency   INR
Moratorium:   N
EMI Amount (Rs)   ${intl(e)}
BPI Amount (Rs)   ${Math.round(s.brokenPeriodInterest)}
Instalment start date   ${lt(s.firstEmi)}
Instalment End date   ${lt(endDate)}
Frequency   MONTHLY
BPI Due Date   NA
EMI Due Date   ${dueDay}rd of Every Month
Repayment Mode   AUTO-DEBIT
________________________________________
Principal Paid (Rs)   ${intl(prinPaid)}
Interest Paid (Rs)   ${intl(intPaid)}
Instalment overdue (Rs)   ${intl(e)}
Late Payment Charges (Rs) ${intl(csLate)}
Excess amount   0.00
Amount Under Clearance   0.00
Loan Finance Summary as on ${dmyLong(s.statementDate)}
Particulars   Instalments / Pre-payments   Late Payment Charges   Misc. Charges*   Total
PRIN   INT
Op.Bal   .00   .00   .00   .00   .00
Debits   ${intl(principalBilled)}   ${intl(interestBilled)}   ${intl(r2(csLate + lateCharged))}   ${intl(misc)}   ${intl(r2(principalBilled + interestBilled + csLate + lateCharged + misc))}
Credits   ${intl(prinPaid)}   ${intl(intPaid)}   ${intl(lateCharged)}   .00   ${intl(r2(prinPaid + intPaid + lateCharged))}
Cl.Bal.   ${intl(lastSplit.p)}   ${intl(lastSplit.i)}   ${intl(csLate)}   ${intl(misc)}   ${intl(total)}
Current OS   Excess   Receivable   Accrued Interest   Future Principal   Total Receivable
${intl(total)}   .00   ${intl(total)}   ${intl(accrued)}   ${intl(futurePrincipal)}   ${intl(r2(total + accrued + futurePrincipal))}
DISBURSEMENT SUMMARY
Disbursal No   Disbursal Date   Disbursal Amount   Particulars
1   ${lt(s.disbursed)}   ${intl(s.firstDisbursal)}   FIRST DISBURSMENT
2   ${lt(s.disbursed)}   ${intl(d2nd)}   SECOND DISBURSMENT

Date   Value Date   Particulars   DR (Rs)   CR (Rs)   Balance
${body.join('\n')}
PART PAYMENT SUMMARY
Repayment Effective Date   Part payment amount   Impact
NA   NA   NA
The amounts reflected above do not include (i) payment bounce charges (ii) legal and repossession charges, if applicable. These charges with
applicable taxes will be payable by the borrower at the time of loan foreclosure if any.
BOUNCE SUMMARY
Date of Bounce   Narration   Amount   REASON
${bounceSummary.join('\n')}
The Company shall have a right to recover the bounce charges as per the below table.
BOUNCE CHARGES
A. Repayment/EMI Bounce Charges   Charges in Rs   Loan sanction amount in Rs.
500   <5 Lacs
1000   5-50 Lacs
1500   >50 Lacs-2 Cr.
2000   >2 Cr.

Disclaimer:
•   The information contained in this SOA is intended to provide a summary of personal data, payment details and loan particulars to
the customer/borrower. It should be used by the customer/borrower only for the purpose of ascertaining the accounting status of
the loan and not for any statutory or regulatory purpose.
•   This SOA is a system generated document, hence no signature is required. Any unauthorized use, disclosure, dissemination or
copying of this document is strictly prohibited and may be unlawful.
•   Deposits are subject to realization.
`;
}

// ---- main -----------------------------------------------------------------------------------------

const FILES = {
  'jio-postpaid-bill.txt': jioPostpaid,
  'jio-fiber-bill.txt': jioFiber,
  'ltf-home-loan-welcome.txt': welcome,
  'sbi-gold-loan-od.txt': goldLoan,
  'sbi-card-a-2026-09.txt': () => cardA(CARD_A[0]),
  'sbi-card-a-2026-10.txt': () => cardA(CARD_A[1]),
  'sbi-card-a-2026-11.txt': () => cardA(CARD_A[2]),
  'sbi-card-b-2026-09.txt': () => cardB(CARD_B),
  'union-bank-savings.txt': unionStatement,
  'sbi-savings.txt': sbiSavings,
  'gpay-statement.txt': gpayStatement,
  'ltf-home-loan-soa.txt': soa,
};

const check = process.argv.includes('--check');
let bad = 0;
for (const [name, make] of Object.entries(FILES)) {
  const text = make();
  const path = join(OUT, name);
  if (check) {
    let cur;
    try {
      cur = readFileSync(path, 'utf8');
    } catch {
      cur = '';
    }
    if (cur !== text) {
      console.error(`${name} differs from the generator output`);
      bad++;
    }
  } else {
    writeFileSync(path, text);
    console.log(`wrote ${name}`);
  }
}
if (bad) process.exit(1);
