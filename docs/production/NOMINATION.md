# Nominee requests (DPDP Act 2023, s.14)

Users may name one nominee in Account > Nominee: name, email, optional relationship. It is stored sealed (AES-256-GCM, bound to the account), included in the account export, and deleted with the account. **Due never emails or contacts the nominee, and an entry alone never releases data.** A nominee's request is a grievance handled by a person, as below.

## What the system does and does not do
| Does | Does not |
| --- | --- |
| Keep the nominee entry encrypted and tied to the account | Email the nominee at any time |
| Show it to the user in Account and in their export | Give the nominee a login or any automatic access |
| Let the user change or remove it at any time | Treat the entry as proof that the user has died or is incapacitated |

## Procedure when someone says they are a nominee
Owner: the Grievance Officer (see `docs/legal/CONTACT.md`). Reply within 7 days; finish within the 90-day grievance limit.

1. **Log it.** Record the date and the requester's email. Do not discuss the account yet.
2. **Ask for proof of the event.** A death certificate, or for incapacity a court order, guardianship order or a registered medical certificate. Ask for the proof of identity of the requester (government photo ID).
3. **Check the entry.** In Admin, check that the account has a nominee and that the requester's name and email match it. Read the entry only through the admin tool or a database console under the existing break-glass rules; never copy it into a ticket. No nominee on record, or a mismatch: the requester is not treated as the nominee. They may still apply as a legal heir, with a succession certificate or probate; take legal advice before acting.
4. **Verify by a second route.** Reply only to the nominee email on record and ask for the documents there; a request from any other address is not acted on. Two people (Grievance Officer and a second owner) must both agree in writing.
5. **Decide the scope narrowly.** Allowed: export of the user's data to the nominee, or deletion of the account. Never: signing in as the user, reading content to the nominee over email or phone, changing plan or payment.
6. **Act.** For export, generate it with the existing export and send it as an encrypted file to the nominee email on record, with the password sent by a different route (phone number from the documents). For deletion, use the standard account-deletion job (Admin > Users). Never release data on a phone call or from an unverified email.
7. **Record.** Save a note (date, who checked, documents seen, what was done) in the grievance log, and delete copies of the identity documents within 30 days of closing the request.
8. **Refuse when unsure.** If documents look doubtful, the user may still be alive, or there is a dispute between family members, release nothing and tell the requester they may seek a court order.
