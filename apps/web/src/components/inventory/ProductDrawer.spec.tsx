/**
 * The product drawer (§9/§10/§11/§33): every field reachable, classification
 * multi-select and separate from availability, validation before the API, a
 * server failure shown as the server worded it, and a location load failure
 * that offers Retry instead of a dead end.
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { InventoryProduct } from '@sheer/domain';
import { ProductDrawer } from './ProductDrawer';

jest.mock('../../auth/api', () => {
  class ApiRequestError extends Error {
    status: number;
    constructor(message: string, status: number) {
      super(message);
      this.status = status;
    }
  }
  return {
    ApiRequestError,
    createInventoryProduct: jest.fn(),
    updateInventoryProduct: jest.fn(),
    getProductAvailability: jest.fn(),
    setProductAvailability: jest.fn(),
    getEffectiveRetailPricing: jest.fn(),
  };
});

jest.mock('react-router-dom', () => ({
  Link: ({ children }: { children: React.ReactNode }) => <a href="/">{children}</a>,
}));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const api = require('../../auth/api') as Record<string, jest.Mock> & {
  ApiRequestError: new (message: string, status: number) => Error & { status: number };
};

const product: InventoryProduct = {
  id: 'prod-1',
  businessId: 'biz-1',
  name: 'Majirel 6.0',
  brand: 'L’Oréal',
  sku: 'MAJ-60',
  categoryId: 'cat-1',
  category: 'Colour',
  sizeValue: 100,
  sizeUnit: 'g',
  defaultUnit: 'g',
  defaultCostPerGramCents: 5,
  lowStockThresholdGrams: 50,
  isActive: true,
  stockUnit: 'gram',
  packSize: 100,
  barcode: '5010000000001',
  supplierId: 'sup-1',
  supplierName: 'Wella',
  minimumOrderQuantity: 6,
  orderMultiple: 6,
  deadStockDays: 90,
  isSalonUse: true,
  isLabUse: true,
  isRetail: false,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

function renderDrawer(overrides: Partial<React.ComponentProps<typeof ProductDrawer>> = {}) {
  const onSaved = jest.fn();
  render(
    <ProductDrawer
      open
      product={product}
      categories={[{ id: 'cat-1', businessId: 'biz-1', name: 'Colour', isActive: true, createdAt: '', updatedAt: '' }]}
      suppliers={[{ id: 'sup-1', businessId: 'biz-1', name: 'Wella', isActive: true, createdAt: '', updatedAt: '' }]}
      locations={[{ id: 'loc-1', name: 'Pinner' }, { id: 'loc-2', name: 'Kensington' }]}
      accessToken="token"
      canManage
      pricingLocationId="loc-1"
      onClose={jest.fn()}
      onSaved={onSaved}
      {...overrides}
    />,
  );
  return { onSaved };
}

beforeEach(() => {
  jest.clearAllMocks();
  api.updateInventoryProduct.mockResolvedValue({ product });
  api.createInventoryProduct.mockResolvedValue({ product });
  api.getProductAvailability.mockResolvedValue({
    productId: 'prod-1',
    locations: [
      { locationId: 'loc-1', locationName: 'Pinner', available: true },
      { locationId: 'loc-2', locationName: 'Kensington', available: false },
    ],
  });
  api.setProductAvailability.mockResolvedValue({
    productId: 'prod-1',
    locations: [
      { locationId: 'loc-1', locationName: 'Pinner', available: true },
      { locationId: 'loc-2', locationName: 'Kensington', available: true },
    ],
  });
  api.getEffectiveRetailPricing.mockResolvedValue({
    pricing: {
      productId: 'prod-1',
      locationId: 'loc-1',
      unitCostCents: 500,
      sellingPriceCents: 1500,
      pricingMode: 'percentage_markup',
      configuredValue: 200,
      effectiveMarkupPercent: 200,
      source: 'product_default',
      sourceRuleId: 'r1',
      sourceLabel: 'Product default',
      currencyCode: 'GBP',
    },
  });
});

describe('fields', () => {
  it('carries every Week 6 / pricing-CR field into the form', async () => {
    renderDrawer();
    const value = (label: RegExp) => (screen.getByLabelText(label) as HTMLInputElement).value;
    expect(value(/Product name/)).toBe('Majirel 6.0');
    expect(value(/Pack size/)).toBe('100');
    expect(value(/Safety threshold/)).toBe('50');
    expect(value(/Dead stock after/)).toBe('90');
    expect(value(/Minimum order/)).toBe('6');
    expect(value(/Order multiple/)).toBe('6');
    expect(value(/Barcode \(EAN/)).toBe('5010000000001');
    expect((screen.getByLabelText(/Supplier/) as HTMLSelectElement).value).toBe('sup-1');
    expect((screen.getByLabelText(/Stocked in/) as HTMLSelectElement).value).toBe('gram');
  });

  it('keeps the legacy retail price editable — it is still the till fallback', async () => {
    renderDrawer();
    const price = screen.getByLabelText(/Retail price/) as HTMLInputElement;
    expect(price).toBeTruthy();
    fireEvent.change(price, { target: { value: '1899' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(api.updateInventoryProduct).toHaveBeenCalled());
    expect(api.updateInventoryProduct.mock.calls[0][2].retailPriceCents).toBe(1899);
  });

  it('keeps product use, availability and pricing as three separate sections', async () => {
    renderDrawer();
    expect(screen.getByText('Product use')).toBeTruthy();
    expect(screen.getByText('Available locations')).toBeTruthy();
    expect(screen.getByText('Pricing')).toBeTruthy();
    expect(screen.getByText('What is this product for? More than one can apply.')).toBeTruthy();
    expect(screen.getByText('Where do we stock or sell this product?')).toBeTruthy();
  });

  it('allows more than one classification at once', async () => {
    renderDrawer();
    const retail = screen.getByRole('checkbox', { name: /Retail/ }) as HTMLInputElement;
    const salon = screen.getByRole('checkbox', { name: /Salon use/ }) as HTMLInputElement;
    expect(salon.checked).toBe(true);
    fireEvent.click(retail);
    expect(retail.checked).toBe(true);
    // Ticking Retail must not clear the others — they are not exclusive.
    expect(salon.checked).toBe(true);
  });
});

describe('saving', () => {
  it('sends the edited values and reports success to the caller', async () => {
    const { onSaved } = renderDrawer();
    fireEvent.change(screen.getByLabelText(/Product name/), { target: { value: 'Majirel 6.1' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));

    await waitFor(() => expect(api.updateInventoryProduct).toHaveBeenCalled());
    const [, productId, payload] = api.updateInventoryProduct.mock.calls[0];
    expect(productId).toBe('prod-1');
    expect(payload).toMatchObject({
      name: 'Majirel 6.1',
      packSize: 100,
      minimumOrderQuantity: 6,
      orderMultiple: 6,
      deadStockDays: 90,
      barcode: '5010000000001',
      supplierId: 'sup-1',
      isSalonUse: true,
      isLabUse: true,
    });
    expect(onSaved).toHaveBeenCalledWith(product, 'updated');
  });

  it('creates a new product when opened empty', async () => {
    const { onSaved } = renderDrawer({ product: undefined });
    fireEvent.change(screen.getByLabelText(/Product name/), { target: { value: 'New Serum' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create product' }));
    await waitFor(() => expect(api.createInventoryProduct).toHaveBeenCalled());
    expect(api.createInventoryProduct.mock.calls[0][1]).toMatchObject({ name: 'New Serum' });
    expect(onSaved).toHaveBeenCalledWith(product, 'created');
  });

  it('blocks an invalid field before any request', async () => {
    renderDrawer();
    fireEvent.change(screen.getByLabelText(/Product name/), { target: { value: '  ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    expect(await screen.findByText('Product name is required.')).toBeTruthy();
    expect(api.updateInventoryProduct).not.toHaveBeenCalled();
  });

  it('shows the server’s own message when the save is refused', async () => {
    api.updateInventoryProduct.mockRejectedValue(
      new api.ApiRequestError('A product with this barcode already exists', 409),
    );
    renderDrawer();
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    expect((await screen.findByRole('alert')).textContent).toContain('barcode already exists');
  });

  it('asks before discarding unsaved edits, and keeps them when the user cancels', () => {
    const confirmSpy = jest.spyOn(window, 'confirm').mockReturnValue(false);
    const onClose = jest.fn();
    renderDrawer({ onClose });
    fireEvent.change(screen.getByLabelText(/Product name/), { target: { value: 'Half-typed' } });
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(confirmSpy).toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    expect((screen.getByLabelText(/Product name/) as HTMLInputElement).value).toBe('Half-typed');
    confirmSpy.mockRestore();
  });

  it('closes without asking when nothing was edited', () => {
    const confirmSpy = jest.spyOn(window, 'confirm').mockReturnValue(true);
    const onClose = jest.fn();
    renderDrawer({ onClose });
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(confirmSpy).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
    confirmSpy.mockRestore();
  });

  it('hides the save action from a user who cannot manage products', () => {
    renderDrawer({ canManage: false });
    expect(screen.queryByRole('button', { name: 'Save changes' })).toBeNull();
  });
});

describe('location availability', () => {
  it('lists each location with its own availability, independent of classification', async () => {
    renderDrawer();
    expect(await screen.findByRole('checkbox', { name: 'Pinner' })).toHaveProperty('checked', true);
    expect(screen.getByRole('checkbox', { name: 'Kensington' })).toHaveProperty('checked', false);
  });

  it('toggles availability through the API', async () => {
    renderDrawer();
    fireEvent.click(await screen.findByRole('checkbox', { name: 'Kensington' }));
    await waitFor(() => expect(api.setProductAvailability).toHaveBeenCalled());
    expect(api.setProductAvailability.mock.calls[0][2]).toEqual({ locationId: 'loc-2', available: true });
  });

  it('offers Retry when locations cannot be loaded, and recovers without losing the form', async () => {
    api.getProductAvailability.mockRejectedValueOnce(new Error('network'));
    renderDrawer();
    fireEvent.change(screen.getByLabelText(/Product name/), { target: { value: 'Edited name' } });

    expect(await screen.findByText('Unable to load locations.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));

    expect(await screen.findByRole('checkbox', { name: 'Pinner' })).toBeTruthy();
    // The retry must not have reset what the user typed.
    expect((screen.getByLabelText(/Product name/) as HTMLInputElement).value).toBe('Edited name');
  });
});

describe('pricing summary', () => {
  it('summarises the effective price with its source and links to the Pricing tab', async () => {
    renderDrawer();
    expect(await screen.findByText('£15.00')).toBeTruthy();
    const summary = screen.getByText(/Product default/);
    expect(summary.textContent).toContain('at Pinner');
    expect(screen.getByRole('link', { name: /Configure pricing/ })).toBeTruthy();
  });

  it('does not duplicate the Pricing tab controls', async () => {
    renderDrawer();
    await screen.findByText('£15.00');
    expect(screen.queryByText('Percentage markup')).toBeNull();
    expect(screen.queryByText('Fixed selling price')).toBeNull();
  });
});
