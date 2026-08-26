/**
 * Adjust vs Restock (§17/§18). The distinction is a ledger fact, not wording:
 * a correction must not be recorded as a supplier delivery.
 */
import { EMPTY_STOCK_OPERATION, baseUnitLabel, planStockOperation } from './stockOperationForm';

const base = { ...EMPTY_STOCK_OPERATION, locationId: 'loc-1', productId: 'prod-1', quantity: '50' };

describe('restock', () => {
  it('adds stock and records a restock movement', () => {
    const plan = planStockOperation('restock', base);
    expect(plan.ok).toBe(true);
    if (plan.ok) {
      expect(plan.request).toMatchObject({
        locationId: 'loc-1',
        productId: 'prod-1',
        quantityDeltaGrams: 50,
        movementType: 'restock',
      });
    }
  });

  it('is always inbound, whatever direction the state carries', () => {
    const plan = planStockOperation('restock', { ...base, direction: 'loss' });
    if (plan.ok) expect(plan.request.quantityDeltaGrams).toBe(50);
  });

  it('does not demand a reason — the delivery itself is the record', () => {
    expect(planStockOperation('restock', { ...base, reason: '' }).ok).toBe(true);
  });
});

describe('adjust', () => {
  it('records an inbound correction as a manual adjustment, NOT a restock', () => {
    const plan = planStockOperation('adjust', { ...base, direction: 'inbound' });
    if (plan.ok) {
      expect(plan.request.movementType).toBe('manual_adjustment');
      expect(plan.request.quantityDeltaGrams).toBe(50);
    }
  });

  it('signs a loss negative', () => {
    const plan = planStockOperation('adjust', { ...base, direction: 'loss', reason: 'breakage' });
    if (plan.ok) expect(plan.request.quantityDeltaGrams).toBe(-50);
  });

  it('requires a reason for a loss — it is the only record of the missing stock', () => {
    expect(planStockOperation('adjust', { ...base, direction: 'loss', reason: '  ' })).toMatchObject({
      ok: false,
      field: 'reason',
    });
  });

  it('carries the reason into both the movement reason and its notes', () => {
    const plan = planStockOperation('adjust', { ...base, direction: 'loss', reason: 'Cycle count' });
    if (plan.ok) {
      expect(plan.request.reason).toBe('Cycle count');
      expect(plan.request.notes).toBe('Cycle count');
    }
  });
});

describe('validation', () => {
  it('requires a location and a product', () => {
    expect(planStockOperation('adjust', { ...base, locationId: '' })).toMatchObject({ ok: false, field: 'locationId' });
    expect(planStockOperation('adjust', { ...base, productId: '' })).toMatchObject({ ok: false, field: 'productId' });
  });

  it('rejects blank, zero, negative and non-numeric quantities', () => {
    for (const quantity of ['', '0', '-5', 'abc']) {
      expect(planStockOperation('restock', { ...base, quantity })).toMatchObject({ ok: false, field: 'quantity' });
    }
  });

  it('rejects sub-milligram precision the API would reject anyway', () => {
    expect(planStockOperation('restock', { ...base, quantity: '1.23456' })).toMatchObject({ ok: false, field: 'quantity' });
    expect(planStockOperation('restock', { ...base, quantity: '1.234' }).ok).toBe(true);
  });
});

describe('unit labels', () => {
  it('speaks the product’s own unit', () => {
    expect(baseUnitLabel('gram')).toBe('g');
    expect(baseUnitLabel('millilitre')).toBe('ml');
    expect(baseUnitLabel('unit')).toBe('units');
    expect(baseUnitLabel(undefined)).toBe('g');
  });
});
