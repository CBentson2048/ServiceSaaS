/**
 * Stock activity must read as salon language, never as database output (§19).
 * The rule these tests exist to defend: a raw UUID can never reach the primary
 * display, whatever the movement or the state of the actor lookup.
 */
import type { InventoryStockMovement } from '@sheer/domain';
import {
  formatAbsoluteTime,
  formatMovementQuantity,
  formatRelativeTime,
  movementActorName,
  movementAuditFields,
  movementSource,
  presentMovement,
} from './movementPresentation';

const UUID = 'bf09e3e5-0a3f-4a1c-9a1b-2f7c1a5e8d90';

const movement = (overrides: Partial<InventoryStockMovement> = {}): InventoryStockMovement => ({
  id: 'mv-1',
  businessId: 'biz-1',
  locationId: 'loc-1',
  locationName: 'Pinner',
  productId: 'prod-1',
  productName: 'Majirel 6.0 Dark Blonde',
  brand: 'L’Oréal',
  movementType: 'restock',
  quantityDeltaGrams: 200,
  createdAt: '2026-08-26T09:00:00.000Z',
  ...overrides,
});

describe('no raw identifiers in the primary display', () => {
  it('names the person when the server resolved one', () => {
    const view = presentMovement(movement({ createdBy: UUID, createdByName: 'Ada Lovelace' }));
    expect(view.actor).toBe('Ada Lovelace');
    expect(view.contextLabel).toContain('by Ada Lovelace');
    expect(view.contextLabel).not.toContain(UUID);
  });

  it('falls back to the mechanism — NEVER the id — when the name is missing', () => {
    const view = presentMovement(movement({ movementType: 'formula_usage', createdBy: UUID }));
    expect(view.actor).toBe('QLAB');
    expect(JSON.stringify(view)).not.toContain(UUID);
  });

  it('uses a sensible system actor for each unattributed movement type', () => {
    expect(movementActorName({ movementType: 'retail_sale' })).toBe('Point of sale');
    expect(movementActorName({ movementType: 'formula_waste' })).toBe('QLAB');
    expect(movementActorName({ movementType: 'opening_balance' })).toBe('System');
  });

  it('ignores a whitespace-only name rather than printing a blank actor', () => {
    expect(movementActorName({ movementType: 'restock', createdByName: '   ' })).toBe('System');
  });

  it('keeps internal ids available for the audit panel only', () => {
    const fields = movementAuditFields(movement({ createdBy: UUID, referenceType: 'barcode_scan', referenceId: 'ref-9' }));
    const labels = fields.map((field) => field.label);
    expect(labels).toEqual(expect.arrayContaining(['Movement ID', 'Product ID', 'Actor ID', 'Reference']));
    expect(fields.find((field) => field.label === 'Actor ID')?.value).toBe(UUID);
  });
});

describe('headline and context', () => {
  it('reads "+200g Majirel 6.0 · Restocked at Pinner · by … · time"', () => {
    const now = new Date('2026-08-26T10:00:00.000Z').getTime();
    const view = presentMovement(movement({ createdByName: 'Ada Lovelace' }), { now });
    expect(view.quantityLabel).toBe('+200g');
    expect(view.productLabel).toBe('Majirel 6.0 Dark Blonde');
    expect(view.contextLabel).toBe('Restocked at Pinner · by Ada Lovelace · 1 hour ago');
    expect(view.direction).toBe('in');
  });

  it('marks an outbound movement with a minus sign and out direction', () => {
    const view = presentMovement(movement({ movementType: 'salon_consumption', quantityDeltaGrams: -30 }));
    expect(view.quantityLabel).toBe('−30g');
    expect(view.direction).toBe('out');
    expect(view.contextLabel).toContain('Salon use at Pinner');
  });

  it('speaks in the product’s own unit', () => {
    expect(formatMovementQuantity(-2, 'unit')).toBe('−2 items');
    expect(formatMovementQuantity(1, 'unit')).toBe('+1 item');
    expect(formatMovementQuantity(150, 'millilitre')).toBe('+150ml');
  });
});

describe('movement source', () => {
  it('distinguishes a barcode scan from other salon use', () => {
    expect(movementSource({ movementType: 'salon_consumption', referenceType: 'barcode_scan' })).toBe('Barcode scan');
    expect(movementSource({ movementType: 'salon_consumption' })).toBe('Salon use');
  });

  it('maps every movement type to salon language', () => {
    expect(movementSource({ movementType: 'formula_usage' })).toBe('QLAB');
    expect(movementSource({ movementType: 'retail_sale' })).toBe('Retail sale');
    expect(movementSource({ movementType: 'restock' })).toBe('Restock');
    expect(movementSource({ movementType: 'manual_adjustment' })).toBe('Manual adjustment');
    expect(movementSource({ movementType: 'correction' })).toBe('Correction');
  });
});

describe('time formatting', () => {
  const base = new Date('2026-08-26T12:00:00.000Z').getTime();

  it('reads in salon time, not ISO', () => {
    expect(formatRelativeTime('2026-08-26T11:59:40.000Z', base)).toBe('just now');
    expect(formatRelativeTime('2026-08-26T11:59:00.000Z', base)).toBe('1 minute ago');
    expect(formatRelativeTime('2026-08-26T11:30:00.000Z', base)).toBe('30 minutes ago');
    expect(formatRelativeTime('2026-08-26T09:00:00.000Z', base)).toBe('3 hours ago');
    expect(formatRelativeTime('2026-08-25T12:00:00.000Z', base)).toBe('yesterday');
    expect(formatRelativeTime('2026-08-23T12:00:00.000Z', base)).toBe('3 days ago');
  });

  it('falls back to a date beyond a week', () => {
    expect(formatRelativeTime('2026-07-01T12:00:00.000Z', base)).toMatch(/Jul/);
  });

  it('never renders "Invalid Date"', () => {
    expect(formatRelativeTime('not-a-date')).toBe('—');
    expect(formatAbsoluteTime('not-a-date')).toBe('—');
  });
});
