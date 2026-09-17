/**
 * R2 Team money figures from R1 Money's facts. Pure — no I/O, no clock.
 *
 * The universe is R1's: paid bills in each location's own window (with their
 * lines) and retail sales recorded. Attribution adds nothing and drops nothing:
 * - service and colour lines go to `bill_lines.staff_profile_id`; a line with no
 *   staff is Unattributed;
 * - retail goes to the seller; a sale with no seller is Unattributed;
 * - lines that are neither service nor colour (adjustments) stay team-level.
 * So Σ staff + Unattributed = R1's composition figure, by construction.
 * docs/V1.1/week-8-r2-team.md §3.
 */
import type { MoneyFacts } from '../money/money-totals';

/** A staff member's id, or `null` for Unattributed facts. */
export type StaffKey = string | null;

interface LineSums {
  serviceGross: number;
  serviceNet: number;
  colourGross: number;
  colourNet: number;
}

/** One bill's service and colour lines, per staff key. */
interface BillAttribution {
  billId: string;
  byStaff: Map<StaffKey, LineSums>;
}

export interface TeamMoneyFacts {
  bills: BillAttribution[];
  /** Σ retail by seller key. */
  retailBySeller: Map<StaffKey, number>;
  totals: {
    serviceGross: number;
    serviceNet: number;
    colourGross: number;
    colourNet: number;
    /** Σ gross of every line on every bill: R1 gross − not itemised. */
    allLinesGross: number;
    /** Bills holding at least one line. */
    itemisedBills: number;
    /** Lines that are neither service nor colour. */
    otherLinesGross: number;
    notItemised: number;
    retail: number;
  };
  /** Service lines rolled up rather than itemised per service. */
  rolledUpServiceLines: number;
}

/** The raw sums for one set of staff keys. */
export interface StaffMoneySums {
  serviceGross: number;
  serviceNet: number;
  colourGross: number;
  colourNet: number;
  /** Σ service + colour gross of the keys' lines. */
  averageBillTotal: number;
  /** Distinct bills holding at least one service or colour line of the keys. */
  averageBillBills: number;
  retail: number;
}

const zeroSums = (): LineSums => ({ serviceGross: 0, serviceNet: 0, colourGross: 0, colourNet: 0 });

export function attributeMoney(facts: MoneyFacts): TeamMoneyFacts {
  const bills: BillAttribution[] = [];
  const totals = {
    serviceGross: 0,
    serviceNet: 0,
    colourGross: 0,
    colourNet: 0,
    allLinesGross: 0,
    itemisedBills: 0,
    otherLinesGross: 0,
    notItemised: 0,
    retail: 0,
  };
  let rolledUpServiceLines = 0;
  for (const { bill, lines } of facts.bills) {
    const byStaff = new Map<StaffKey, LineSums>();
    let linesGross = 0;
    for (const line of lines) {
      linesGross += line.grossCents;
      if (line.lineType !== 'service' && line.lineType !== 'product_usage') {
        totals.otherLinesGross += line.grossCents;
        continue;
      }
      const sums = byStaff.get(line.staffProfileId) ?? zeroSums();
      if (line.lineType === 'service') {
        sums.serviceGross += line.grossCents;
        sums.serviceNet += line.netCents;
        totals.serviceGross += line.grossCents;
        totals.serviceNet += line.netCents;
        if (!line.perService) rolledUpServiceLines += 1;
      } else {
        sums.colourGross += line.grossCents;
        sums.colourNet += line.netCents;
        totals.colourGross += line.grossCents;
        totals.colourNet += line.netCents;
      }
      byStaff.set(line.staffProfileId, sums);
    }
    totals.allLinesGross += linesGross;
    if (lines.length > 0) totals.itemisedBills += 1;
    totals.notItemised += bill.grossCents - linesGross;
    bills.push({ billId: bill.id, byStaff });
  }
  const retailBySeller = new Map<StaffKey, number>();
  for (const sale of facts.retail) {
    totals.retail += sale.totalCents;
    retailBySeller.set(sale.sellerStaffProfileId, (retailBySeller.get(sale.sellerStaffProfileId) ?? 0) + sale.totalCents);
  }
  return { bills, retailBySeller, totals, rolledUpServiceLines };
}

/** Every staff key with a money fact (service or colour line, or retail sale). */
export function moneyStaffKeys(money: TeamMoneyFacts): Set<StaffKey> {
  const keys = new Set<StaffKey>(money.retailBySeller.keys());
  for (const bill of money.bills) for (const key of bill.byStaff.keys()) keys.add(key);
  return keys;
}

/**
 * The sums for a set of keys. A bill counts once for the set however many of the
 * keys have lines on it — for one key that is "once for each staff member".
 */
export function staffMoneySums(money: TeamMoneyFacts, keys: ReadonlySet<StaffKey>): StaffMoneySums {
  const sums: StaffMoneySums = {
    serviceGross: 0,
    serviceNet: 0,
    colourGross: 0,
    colourNet: 0,
    averageBillTotal: 0,
    averageBillBills: 0,
    retail: 0,
  };
  for (const bill of money.bills) {
    let counted = false;
    for (const [key, line] of bill.byStaff) {
      if (!keys.has(key)) continue;
      sums.serviceGross += line.serviceGross;
      sums.serviceNet += line.serviceNet;
      sums.colourGross += line.colourGross;
      sums.colourNet += line.colourNet;
      counted = true;
    }
    if (counted) sums.averageBillBills += 1;
  }
  sums.averageBillTotal = sums.serviceGross + sums.colourGross;
  for (const [key, cents] of money.retailBySeller) if (keys.has(key)) sums.retail += cents;
  return sums;
}

/** Every staff key's own sums in one pass over the bills — the same figures as `staffMoneySums` for one key. */
export function staffMoneyIndex(money: TeamMoneyFacts): Map<StaffKey, StaffMoneySums> {
  const index = new Map<StaffKey, StaffMoneySums>();
  const entry = (key: StaffKey) => {
    let sums = index.get(key);
    if (!sums) {
      sums = { serviceGross: 0, serviceNet: 0, colourGross: 0, colourNet: 0, averageBillTotal: 0, averageBillBills: 0, retail: 0 };
      index.set(key, sums);
    }
    return sums;
  };
  for (const bill of money.bills) {
    for (const [key, line] of bill.byStaff) {
      const sums = entry(key);
      sums.serviceGross += line.serviceGross;
      sums.serviceNet += line.serviceNet;
      sums.colourGross += line.colourGross;
      sums.colourNet += line.colourNet;
      sums.averageBillTotal += line.serviceGross + line.colourGross;
      sums.averageBillBills += 1;
    }
  }
  for (const [key, cents] of money.retailBySeller) entry(key).retail += cents;
  return index;
}

/** Combine the facts of several locations (bills are per location, so bill counts add). */
export function combineMoney(all: readonly TeamMoneyFacts[]): TeamMoneyFacts {
  const retailBySeller = new Map<StaffKey, number>();
  const totals = {
    serviceGross: 0,
    serviceNet: 0,
    colourGross: 0,
    colourNet: 0,
    allLinesGross: 0,
    itemisedBills: 0,
    otherLinesGross: 0,
    notItemised: 0,
    retail: 0,
  };
  let rolledUpServiceLines = 0;
  for (const money of all) {
    for (const [key, cents] of money.retailBySeller) retailBySeller.set(key, (retailBySeller.get(key) ?? 0) + cents);
    for (const field of Object.keys(totals) as Array<keyof typeof totals>) totals[field] += money.totals[field];
    rolledUpServiceLines += money.rolledUpServiceLines;
  }
  return { bills: all.flatMap((money) => money.bills), retailBySeller, totals, rolledUpServiceLines };
}
