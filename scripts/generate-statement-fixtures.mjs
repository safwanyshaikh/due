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

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'lib', 'savings', '__tests__', 'fixtures');

/** The invented customer. */
const PERSON = { name: 'DEMO CUSTOMER', address: 'FLAT 7, SAMPLE CHS', area: 'SAMPLE NAGAR 400099', email: 'demo.customer@example.com' };

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
const intl = (n) => n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const MON = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
const cap = (s) => s[0] + s.slice(1).toLowerCase();
const d2 = (n) => String(n).padStart(2, '0');
/** "2026-10-08" -> parts */
const ymd = (iso) => iso.split('-').map(Number);
const dmyUpper = (iso) => { const [y, m, d] = ymd(iso); return `${d2(d)}-${MON[m - 1]}-${y}`; };
const dmyShort = (iso) => { const [y, m, d] = ymd(iso); return `${d2(d)}-${cap(MON[m - 1])}-${String(y).slice(2)}`; };
const dmyLong = (iso) => { const [y, m, d] = ymd(iso); return `${d2(d)}-${cap(MON[m - 1])}-${y}`; };
const slashDmy = (iso) => { const [y, m, d] = ymd(iso); return `${d2(d)}/${d2(m)}/${y}`; };
const dashDmy = (iso) => { const [y, m, d] = ymd(iso); return `${d2(d)}-${d2(m)}-${y}`; };

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
  history: { payments: ['02-OCT', '02-SEP', 756.0, 756.0], bills: ['02-OCT', '02-SEP', 731.4, 756.0] },
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
    const dr = (b) => (b === 0 ? '0.00' : r.date === '2026-03-31' ? `${inr(b)}\nDR` : `${inr(b)}DR`);
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

// ---- main -----------------------------------------------------------------------------------------

const FILES = {
  'jio-postpaid-bill.txt': jioPostpaid,
  'jio-fiber-bill.txt': jioFiber,
  'ltf-home-loan-welcome.txt': welcome,
  'sbi-gold-loan-od.txt': goldLoan,
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
