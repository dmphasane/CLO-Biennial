# Stage 2 — Accommodation Pricing Correction Plan (5-night → 4-night)

**Status: BUILT. Code is in place; the correction is applied manually via the portal
button after deploy. No member data changes until an admin runs it.**

## Decisions taken (confirmed)
1. Legacy members: 4-night accommodation over their 12-month schedule.
2. Overpayments: reduce remaining instalments (ledger rebuilt at the new monthly rate).
3. New existing-hotel registrants use distinct codes **OPT-1N..OPT-6N** (no collision with legacy OPT-1..6).
4. Members notified after verification (via Communications → statements).

## Automatic code remap for early registrations
~20 members registered via the public form BEFORE the OPT-xN codes existed, so they are
stored under legacy codes OPT-1..6 but with `cohort:'new'`. The correction **automatically
remaps** these (and only these) to OPT-1N..6N as part of Apply. The dry-run shows the change
as `OPT-2 → OPT-2N`. Genuine legacy members (cohort = legacy) are never remapped.

Buckets among the ~20:
- **Reg Only** (`REG-ONLY`): no code change; reg amount unchanged.
- **New hotels** (`CAP-*`, `CAT-*`): no code change; amounts corrected to 4-night.
- **Existing hotels** (`OPT-1..6`, cohort=new): remapped to `OPT-xN` + amounts corrected.

## How to run it (after deploy)
Portal → **Members** → **🏨 4-Night Price Correction**:
1. First **export a backup** (Members → Export CSV).
2. Click the button → review the **dry-run** table (before/after per member, paid, credit,
   and any `OPT-x → OPT-xN` remap).
3. Optionally **Export Dry-Run CSV** for records.
4. Click **Apply Correction** → codes remapped, amounts updated, ledgers rebuilt, audit-logged.
5. Verify on Dashboard/Reports, then send updated statements from Communications.

## 1. Background

Accommodation totals were originally calculated on a **5-night** basis. The correct
basis is **4 nights**. Stage 1 already fixed the public registration forms and the
portal's Capital/Catalyst new-registration prices. Stage 2 corrects **existing member
records** whose stored amounts and ledgers were built on the old 5-night figures.

## 2. Correct 4-night accommodation totals (per person)

| Code | Hotel / Type | Occupancy | Per-person/night | Nights | 4-night accom total |
|------|--------------|-----------|------------------|--------|---------------------|
| OPT-4 | Sandton Towers – Sharing | 2 | R2,127.50 | 4 | R8,510.00 |
| OPT-2 | Sandton Sun – Sharing | 2 | R2,177.50 | 4 | R8,710.00 |
| CAP-S | The Capital – Single B&B | 1 | R2,450.00 | 4 | R9,800.00 |
| OPT-1 | Sandton Sun – Not Sharing | 1 | R3,955.00 | 4 | R15,820.00 |
| OPT-3 | Sandton Towers – Not Sharing | 1 | R4,255.00 | 4 | R17,020.00 |
| CAT-SH | The Catalyst – Sharing B&B (pp) | 2 | R945.00 | 4 | R3,780.00 |
| OPT-6 | Garden Court – Sharing | 2 | R1,042.50 | 4 | R4,170.00 |
| CAP-SH | The Capital – Sharing B&B (pp) | 2 | R1,380.00 | 4 | R5,520.00 |
| CAT-S | The Catalyst – Single B&B | 1 | R1,590.00 | 4 | R6,360.00 |
| OPT-5 | Garden Court – Not Sharing | 1 | R1,795.00 | 4 | R7,180.00 |

Registration (R5,700) is unchanged.

## 3. Who is affected

Two groups, distinguished by `cohort`:

- **New cohort (8-month schedule):** monthly = (4-night accom + R5,700) / 8
- **Legacy cohort (12-month schedule):** monthly = (4-night accom + R5,700) / 12
  - Legacy currently splits registration as R475/month × 12.

> Members on `REG-ONLY` and `OPT-7` (once-off/flex) are **not** affected — no accommodation component.

## 4. Open DECISIONS required before running (please confirm)

1. **Legacy monthly basis.** Confirm legacy accommodation should also drop to the
   4-night totals above, still spread over the **12-month** legacy schedule.
   - New legacy monthly = (4-night accom + R5,700) / 12. Example OPT-1:
     (15,820 + 5,700) / 12 = **R1,793.33/month** (was R2,122.92).

2. **Members who have already paid.** Lowering the expected amount can create an
   overpayment/credit for anyone who paid instalments at the old rate. Choose one:
   - (a) Reduce the member's **remaining** instalments so their total lands on the new figure.
   - (b) Keep instalments equal and **shorten** the schedule (finish earlier).
   - (c) Record the surplus as a **credit/refund** and keep the schedule.
   - Recommended: (a) — simplest for members and reconciliation.

3. **Existing-hotel new registrants (code collision).** New members who chose an
   existing hotel share codes OPT-1..6 with legacy members. Decide:
   - (a) Introduce distinct new codes (OPT-1N..OPT-6N) for new-cohort existing-hotel
     members so cohorts never collide (cleaner long-term), OR
   - (b) Keep shared codes and rely on `cohort` + a per-member stored amount.
   - Recommended: (a).

4. **Member communication.** Should members receive an email/statement notifying them
   their monthly amount has decreased? (Recommended: yes, via the portal's bulk statement
   or announcement tool, after the correction is verified.)

## 5. Proposed method (safe, reversible)

Executed as a **one-time, auditable migration**, not a silent code change:

1. **Backup first.** Export the full members table (portal → Members → Export CSV) and
   take a database snapshot/export. Keep the backup until the correction is signed off.
2. **Dry-run report.** Generate a read-only before/after table for every affected member:
   old monthly, new monthly, amount paid to date, resulting credit/shortfall. No writes.
   This is reviewed and approved before any update.
3. **Apply correction** per the approved decisions:
   - Recompute `expectedAccom`, `expectedReg`, `expectedMonthlyTotal` from the 4-night
     total and the member's cohort schedule.
   - Rebuild each affected member's `ledger` months to the new monthly amount.
   - Re-run matching / recalc ledgers so payments re-allocate against the new figures.
4. **Verify.** Re-run the dashboard and a monthly/quarterly report; spot-check several
   members across hotels and both cohorts against the dry-run report.
5. **Communicate.** Optionally send updated statements to affected members.

## 6. Rollback

If anything looks wrong after applying, restore from the Step-1 CSV/snapshot and
re-import. Because we back up first and dry-run before writing, the blast radius is
contained and recoverable.

## 7. Scope / effort estimate

- Dry-run report tool: small-to-moderate (read-only, no risk).
- Migration routine: moderate (touches money; must be exact and audited).
- Code-collision fix (OPT-xN), if chosen: moderate (new codes + mapping).
- Member comms: small (uses existing bulk email).

## 8. What is NOT in this plan

- Changing the public forms or portal new-registration prices — already done in Stage 1.
- Any automatic overwrite of legacy amounts by the portal's existing auto-sync routine,
  which deliberately leaves OPT-1..6 locked. Stage 2 updates records explicitly instead.
