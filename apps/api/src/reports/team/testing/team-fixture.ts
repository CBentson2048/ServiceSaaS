/**
 * The R2 Team reconciliation fixture: one hand-built ledger, pence, custom range
 * 14 Sep 2026 (every location Europe/London), generated at 2026-09-16T10:00:00Z.
 *
 * STAFF                         current membership (today)      facts on 14 Sep
 *   Alice   active              London                          London bills, colour, retail
 *   Ben     active              London and Other                London shared bill + retail; Other bill
 *   Dan     active (moved)      Other only                      London bill (before the move)
 *   Eve     active              London                          none (zero activity)
 *   Fay     terminated          none                            London bill
 *   Gil     active              Other                           Other bill only
 *   Cara    profile deleted     —                               London bill → Former staff
 *   Hal     another business    —                               a bill in another business
 *
 * LONDON bills (gross = lines unless noted)
 *   B1 shared   service Alice 8000 (6667/1333) · service Ben 3000 (2500/500) · colour Alice 1000 (833/167)   12000
 *   B2          service Alice 5000 rolled up (not itemised per service)                                     5000
 *   B3          service — (no staff) 3500 (2917/583) · adjustment −500                                       3000
 *   B4          header only, no lines                                                                       2000  → not itemised 2000
 *   B5          service Cara 2500 (former)                                                                  2500
 *   B6          service Dan 1500                                                                            1500
 *   B7          service Fay 1000 · colour — (no staff) 600 (500/100)                                         1600
 *   B8 VOIDED   service Alice 9999                                                                          excluded
 *   B9 13 Sep   service Alice 7777 (London 13 Sep 23:59:59.999999 BST)                                        excluded
 *   retail      Alice 1200 · no seller 800 · Ben 500                                                        2500
 * London: service 24500 (net 20417) · colour 1600 (net 1333) · lines 25600 on 6 itemised bills · gross 27600
 *         not itemised 2000 · other lines −500 · retail 2500 · retail share 2500 ÷ 24500 = 1020 bp
 *   Alice service 13000 colour 1000 · average bill 14000 ÷ 2 = 7000 · retail 1200
 *   Ben   service 3000 · average bill 3000 ÷ 1 · retail 500
 *   Dan 1500 · Fay 1000 · Cara (former) 2500 · Unattributed service 3500 colour 600 · average 4100 ÷ 2 = 2050
 *   Eve   service £0.00 · average bill unavailable (no bills)
 * OTHER bills
 *   B10         service Ben 2000                                                                            2000
 *   B11         service Gil 4000                                                                            4000
 * Other: service 6000 · retail none · retail share 0 ÷ 6000 = 0 bp
 * SUMMARY (London + Other, GBP): service 30500 · colour 1600 · retail 2500 · share 2500 ÷ 30500 = 820 bp
 *          average bill 31600 ÷ 8
 * Selected Ben: London 3000 · Other 2000 · summary 5000, average bill 5000 ÷ 2 bills
 * Selected Alice + Ben at London: average bill 17000 ÷ 2 distinct bills (B1 counts once) = 8500
 */
import type { ReportFilter } from '@sheer/domain';
import type { Ledger, LedgerBill, LedgerLine } from '../../money/testing/memory-money-source';
import { instant as at } from '../../money/testing/money-scope';
import { emptyTeamLedger, type TeamLedger } from './memory-team-source';

export const BIZ = 'biz-1';
export const OTHER_BIZ = 'biz-2';

export const LONDON = '20000000-0000-4000-8000-000000000001';
export const OTHER = '20000000-0000-4000-8000-000000000002';

export const ALICE = '30000000-0000-4000-8000-00000000000a';
export const BEN = '30000000-0000-4000-8000-00000000000b';
export const CARA = '30000000-0000-4000-8000-00000000000c';
export const DAN = '30000000-0000-4000-8000-00000000000d';
export const EVE = '30000000-0000-4000-8000-00000000000e';
export const FAY = '30000000-0000-4000-8000-00000000000f';
export const GIL = '30000000-0000-4000-8000-000000000010';
export const HAL = '30000000-0000-4000-8000-000000000011';

export const LOCATIONS = [
  { id: LONDON, name: 'London', timezone: 'Europe/London' },
  { id: OTHER, name: 'Other', timezone: 'Europe/London' },
];

export const AS_OF = new Date('2026-09-16T10:00:00Z');
export const DAY: ReportFilter = { preset: 'custom', from: '2026-09-14', to: '2026-09-14', locationIds: [], staffProfileIds: [], view: 'summary' };

let serial = 0;
export const uid = (): string => `00000000-0000-4000-8000-${(++serial).toString(16).padStart(12, '0')}`;

type Line = [LedgerLine['lineType'], string | null, number, number, number, boolean?];

export function bill(
  ledger: Ledger,
  fields: Partial<LedgerBill> & { locationId: string; at: string; gross: number },
  lines: Line[],
): string {
  const id = uid();
  ledger.bills.push({
    id,
    visitId: uid(),
    businessId: fields.businessId ?? BIZ,
    status: fields.status ?? 'paid',
    locationId: fields.locationId,
    at: at(fields.at),
    billNumber: serial,
    grossCents: fields.gross,
    netCents: fields.netCents ?? fields.gross,
    taxCents: fields.taxCents ?? 0,
    depositAppliedCents: 0,
    currencyCode: fields.currencyCode ?? 'GBP',
  });
  for (const [lineType, staffProfileId, gross, net, tax, perService] of lines) {
    ledger.lines.push({ id: uid(), billId: id, lineType, grossCents: gross, netCents: net, taxCents: tax, staffProfileId, perService: perService ?? true });
  }
  return id;
}

export function retail(ledger: Ledger, locationId: string, when: string, cents: number, seller: string | null, currencyCode = 'GBP'): void {
  ledger.retail.push({ id: uid(), businessId: BIZ, locationId, at: at(when), totalCents: cents, quantity: 1, method: 'card_reader', currencyCode, sellerStaffProfileId: seller });
}

export function moneyLedger(): Ledger {
  const ledger: Ledger = {
    bills: [],
    lines: [],
    payments: [],
    retail: [],
    deposits: [],
    locations: [LONDON, OTHER].map((id) => ({ id, businessId: BIZ, currencyCode: 'GBP' })),
  };
  const t = '2026-09-14T10:00:00Z';
  bill(ledger, { locationId: LONDON, at: t, gross: 12000 }, [
    ['service', ALICE, 8000, 6667, 1333],
    ['service', BEN, 3000, 2500, 500],
    ['product_usage', ALICE, 1000, 833, 167],
  ]);
  bill(ledger, { locationId: LONDON, at: '2026-09-14T11:00:00Z', gross: 5000 }, [['service', ALICE, 5000, 4167, 833, false]]);
  bill(ledger, { locationId: LONDON, at: '2026-09-14T12:00:00Z', gross: 3000 }, [
    ['service', null, 3500, 2917, 583],
    ['adjustment', null, -500, -500, 0],
  ]);
  bill(ledger, { locationId: LONDON, at: '2026-09-14T13:00:00Z', gross: 2000 }, []);
  bill(ledger, { locationId: LONDON, at: '2026-09-14T14:00:00Z', gross: 2500 }, [['service', CARA, 2500, 2083, 417]]);
  bill(ledger, { locationId: LONDON, at: '2026-09-14T15:00:00Z', gross: 1500 }, [['service', DAN, 1500, 1250, 250]]);
  bill(ledger, { locationId: LONDON, at: '2026-09-14T16:00:00Z', gross: 1600 }, [
    ['service', FAY, 1000, 833, 167],
    ['product_usage', null, 600, 500, 100],
  ]);
  bill(ledger, { locationId: LONDON, at: '2026-09-14T17:00:00Z', gross: 9999, status: 'voided' }, [['service', ALICE, 9999, 9999, 0]]);
  bill(ledger, { locationId: LONDON, at: '2026-09-13T22:59:59.999999Z', gross: 7777 }, [['service', ALICE, 7777, 7777, 0]]);
  bill(ledger, { locationId: LONDON, at: t, gross: 88888, businessId: OTHER_BIZ }, [['service', HAL, 88888, 88888, 0]]);
  retail(ledger, LONDON, '2026-09-14T09:00:00Z', 1200, ALICE);
  retail(ledger, LONDON, '2026-09-14T09:30:00Z', 800, null);
  retail(ledger, LONDON, '2026-09-14T09:45:00Z', 500, BEN);
  bill(ledger, { locationId: OTHER, at: t, gross: 2000 }, [['service', BEN, 2000, 1667, 333]]);
  bill(ledger, { locationId: OTHER, at: '2026-09-14T11:00:00Z', gross: 4000 }, [['service', GIL, 4000, 3333, 667]]);
  return ledger;
}

export function teamLedger(): TeamLedger {
  const staff = (id: string, name: string, employmentStatus: 'active' | 'terminated' = 'active', businessId = BIZ) => ({
    id,
    businessId,
    userProfileId: `u${id.slice(1)}`,
    name,
    employmentStatus,
  });
  const member = (staffId: string, locationId: string, role: 'manager' | 'stylist' = 'stylist', status: 'active' | 'revoked' = 'active') => ({
    id: uid(),
    businessId: BIZ,
    userProfileId: `u${staffId.slice(1)}`,
    locationId,
    role,
    status,
  });
  return {
    ...emptyTeamLedger(),
    staff: [
      staff(ALICE, 'Alice'),
      staff(BEN, 'Ben'),
      staff(DAN, 'Dan'),
      staff(EVE, 'Eve'),
      staff(FAY, 'Fay', 'terminated'),
      staff(GIL, 'Gil'),
      staff(HAL, 'Hal', 'active', OTHER_BIZ),
      // Cara's profile no longer exists.
    ],
    memberships: [
      member(ALICE, LONDON),
      member(BEN, LONDON, 'manager'),
      member(BEN, OTHER),
      member(DAN, OTHER),
      // Dan's London membership was deleted by the move; a revoked row stays revoked.
      member(DAN, LONDON, 'stylist', 'revoked'),
      member(EVE, LONDON),
      member(GIL, OTHER),
    ],
  };
}
