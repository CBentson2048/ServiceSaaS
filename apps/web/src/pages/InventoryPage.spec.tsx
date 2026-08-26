/**
 * Product Management — the Products tab as a whole (§33).
 *
 * These cover the redesign's promises at the page level: the catalogue is the
 * primary surface, filters work, editing opens a drawer without leaving the
 * list, activity reads in salon language, and a failed query offers a retry.
 */
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { InventoryStockMovement } from '@sheer/domain';
import { InventoryPage } from './InventoryPage';

jest.mock('../auth/api', () => {
  class ApiRequestError extends Error {
    status: number;
    constructor(message: string, status: number) {
      super(message);
      this.status = status;
    }
  }
  return {
    ApiRequestError,
    listInventoryProducts: jest.fn(),
    listInventoryCategories: jest.fn(),
    listInventorySuppliers: jest.fn(),
    listInventoryStock: jest.fn(),
    listInventoryMovements: jest.fn(),
    listInventoryDeadStock: jest.fn(),
    archiveInventoryProduct: jest.fn(),
    updateInventoryStockThreshold: jest.fn(),
    // Used by the drawer's availability + pricing panels.
    getProductAvailability: jest.fn(),
    setProductAvailability: jest.fn(),
    getEffectiveRetailPricing: jest.fn(),
    createInventoryProduct: jest.fn(),
    updateInventoryProduct: jest.fn(),
    lookupInventoryBarcode: jest.fn(),
    recordProductConsumption: jest.fn(),
    adjustInventoryStock: jest.fn(),
  };
});

jest.mock('../auth/AuthProvider', () => ({
  useAuth: () => ({
    status: 'authenticated',
    session: { accessToken: 'token' },
    user: {
      id: 'user-1',
      roles: ['owner'],
      primaryRole: 'owner',
      permissions: ['inventory.manage', 'settings.billing.manage'],
      locations: [{ id: 'loc-1', name: 'Pinner' }],
      allowedLocationIds: ['loc-1'],
    },
  }),
}));

jest.mock('../components/LocationScopeContext', () => ({
  useLocationScope: () => ({
    selectedLocationId: 'loc-1',
    isAllLocations: false,
    locations: [{ id: 'loc-1', name: 'Pinner' }],
    firstLocationId: 'loc-1',
    setSelectedLocationId: jest.fn(),
  }),
}));

jest.mock('react-router-dom', () => ({
  Navigate: () => null,
  Link: ({ children }: { children: React.ReactNode }) => <a href="/">{children}</a>,
}));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const api = require('../auth/api') as Record<string, jest.Mock>;

const product = (overrides: Record<string, unknown> = {}) => ({
  id: 'prod-1',
  businessId: 'biz-1',
  name: 'Majirel 6.0',
  brand: 'L’Oréal',
  sku: 'MAJ-60',
  categoryId: 'cat-1',
  category: 'Colour',
  sizeUnit: 'g',
  defaultUnit: 'g',
  lowStockThresholdGrams: 50,
  isActive: true,
  stockUnit: 'gram',
  packSize: 100,
  minimumOrderQuantity: 1,
  orderMultiple: 1,
  isSalonUse: true,
  isLabUse: true,
  isRetail: false,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  ...overrides,
});

const stockRow = (overrides: Record<string, unknown> = {}) => ({
  id: 'stock-1',
  businessId: 'biz-1',
  locationId: 'loc-1',
  locationName: 'Pinner',
  productId: 'prod-1',
  productName: 'Majirel 6.0',
  quantityOnHandGrams: 500,
  effectiveLowStockThresholdGrams: 50,
  isLowStock: false,
  isActive: true,
  updatedAt: '2026-08-01T00:00:00.000Z',
  ...overrides,
});

const movement: InventoryStockMovement = {
  id: 'mv-1',
  businessId: 'biz-1',
  locationId: 'loc-1',
  locationName: 'Pinner',
  productId: 'prod-1',
  productName: 'Majirel 6.0',
  brand: 'L’Oréal',
  movementType: 'restock',
  quantityDeltaGrams: 200,
  createdBy: 'bf09e3e5-0a3f-4a1c-9a1b-2f7c1a5e8d90',
  createdByName: 'Ada Lovelace',
  createdAt: new Date().toISOString(),
};

beforeEach(() => {
  jest.clearAllMocks();
  api.listInventoryProducts.mockResolvedValue({
    products: [product(), product({ id: 'prod-2', name: 'Blondor', sku: 'BLND', categoryId: 'cat-2', category: 'Lightener' })],
  });
  api.listInventoryCategories.mockResolvedValue({
    categories: [
      { id: 'cat-1', businessId: 'biz-1', name: 'Colour', isActive: true, createdAt: '', updatedAt: '' },
      { id: 'cat-2', businessId: 'biz-1', name: 'Lightener', isActive: true, createdAt: '', updatedAt: '' },
    ],
  });
  api.listInventorySuppliers.mockResolvedValue({ suppliers: [] });
  api.listInventoryStock.mockResolvedValue({
    stock: [stockRow(), stockRow({ id: 'stock-2', productId: 'prod-2', productName: 'Blondor', quantityOnHandGrams: 10 })],
    locations: [{ id: 'loc-1', name: 'Pinner' }],
    scope: 'owner',
  });
  api.listInventoryMovements.mockResolvedValue({ movements: [movement] });
  api.listInventoryDeadStock.mockResolvedValue({ items: [], locations: [], totalEstimatedValueCents: 0 });
  api.getProductAvailability.mockResolvedValue({
    productId: 'prod-1',
    locations: [{ locationId: 'loc-1', locationName: 'Pinner', available: true }],
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
      sourceRuleId: 'rule-1',
      sourceLabel: 'Product default',
      currencyCode: 'GBP',
    },
  });
});

async function renderPage() {
  render(<InventoryPage />);
  // The catalogue and the activity feed both name products, so every
  // assertion below is scoped to the section it is really about.
  await screen.findAllByText('Majirel 6.0');
}

const inventory = () => within(screen.getByRole('region', { name: 'Product inventory' }));
/** The rows only — excludes the filter controls, which use the same words. */
const inventoryTable = () => within(inventory().getByRole('table'));
/** The table row for a product, so actions target the right one. */
const rowFor = (name: string) =>
  within(inventoryTable().getByRole('button', { name }).closest('tr') as HTMLElement);
const activity = () => within(screen.getByRole('region', { name: 'Recent stock activity' }));

describe('the catalogue is the primary surface', () => {
  it('renders the product inventory with stock, threshold and status', async () => {
    await renderPage();
    const table = inventoryTable();
    expect(table.getByRole('button', { name: 'Majirel 6.0' })).toBeTruthy();
    expect(table.getByText('500g')).toBeTruthy();
    expect(rowFor('Majirel 6.0').getByText('Healthy')).toBeTruthy();
    // The low row is flagged, not silently equal to the healthy one.
    expect(rowFor('Blondor').getByText('Low stock')).toBeTruthy();
  });

  it('shows overview counts that agree with the table, unpadded', async () => {
    await renderPage();
    // Two products in view, exactly one of them low — the cards must agree.
    const productsCard = screen.getByRole('button', { name: /Low stock/ });
    expect(productsCard.textContent).toContain('1');
    expect(screen.getByRole('button', { name: /Out of stock/ }).textContent).toContain('0');
  });

  it('has no permanent product form above the list', async () => {
    await renderPage();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.queryByText('Basic information')).toBeNull();
  });
});

describe('filters', () => {
  it('searches by name', async () => {
    await renderPage();
    fireEvent.change(screen.getByLabelText('Search products'), { target: { value: 'blondor' } });
    expect(inventoryTable().queryByRole('button', { name: 'Majirel 6.0' })).toBeNull();
    expect(inventoryTable().getByRole('button', { name: 'Blondor' })).toBeTruthy();
  });

  it('searches by SKU', async () => {
    await renderPage();
    fireEvent.change(screen.getByLabelText('Search products'), { target: { value: 'MAJ-60' } });
    expect(inventoryTable().getByRole('button', { name: 'Majirel 6.0' })).toBeTruthy();
    expect(inventoryTable().queryByRole('button', { name: 'Blondor' })).toBeNull();
  });

  it('filters by category', async () => {
    await renderPage();
    fireEvent.change(screen.getByLabelText('Filter by category'), { target: { value: 'cat-2' } });
    expect(inventoryTable().getByRole('button', { name: 'Blondor' })).toBeTruthy();
    expect(inventoryTable().queryByRole('button', { name: 'Majirel 6.0' })).toBeNull();
  });

  it('filters by status', async () => {
    await renderPage();
    fireEvent.change(screen.getByLabelText('Filter by stock status'), { target: { value: 'low' } });
    expect(inventoryTable().getByRole('button', { name: 'Blondor' })).toBeTruthy();
    expect(inventoryTable().queryByRole('button', { name: 'Majirel 6.0' })).toBeNull();
  });

  it('explains an empty filter result and offers a way back', async () => {
    await renderPage();
    fireEvent.change(screen.getByLabelText('Search products'), { target: { value: 'zzzz' } });
    expect(screen.getByText('No products match these filters')).toBeTruthy();
    fireEvent.click(screen.getAllByRole('button', { name: 'Clear filters' })[0]);
    expect(await inventoryTable().findByRole('button', { name: 'Majirel 6.0' })).toBeTruthy();
  });
});

describe('editing', () => {
  it('opens the product drawer from a row without leaving the list', async () => {
    await renderPage();
    fireEvent.click(rowFor('Majirel 6.0').getByRole('button', { name: 'Edit' }));

    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('Basic information')).toBeTruthy();
    // The catalogue is still mounted behind the drawer.
    expect(screen.getByRole('region', { name: 'Product inventory' })).toBeTruthy();
  });

  it('loads the product’s existing values into the drawer', async () => {
    await renderPage();
    fireEvent.click(rowFor('Majirel 6.0').getByRole('button', { name: 'Edit' }));
    const dialog = await screen.findByRole('dialog');
    expect((within(dialog).getByLabelText(/Product name/) as HTMLInputElement).value).toBe('Majirel 6.0');
    expect((within(dialog).getByLabelText(/SKU/) as HTMLInputElement).value).toBe('MAJ-60');
  });

  it('opens an empty drawer for a new product', async () => {
    await renderPage();
    fireEvent.click(screen.getByRole('button', { name: '+ New product' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByRole('heading', { name: 'New product' })).toBeTruthy();
    expect((within(dialog).getByLabelText(/Product name/) as HTMLInputElement).value).toBe('');
  });
});

describe('row actions', () => {
  it('offers the secondary actions in an overflow menu, not as a row of buttons', async () => {
    await renderPage();
    // One visible action per row keeps the table readable.
    expect(rowFor('Majirel 6.0').getAllByRole('button').length).toBeLessThanOrEqual(3);

    fireEvent.click(rowFor('Majirel 6.0').getByRole('button', { name: /More actions/ }));
    const menu = within(await screen.findByRole('menu'));
    expect(menu.getByRole('menuitem', { name: 'Adjust stock' })).toBeTruthy();
    expect(menu.getByRole('menuitem', { name: 'Restock' })).toBeTruthy();
    expect(menu.getByRole('menuitem', { name: 'Movement history' })).toBeTruthy();
    expect(menu.getByRole('menuitem', { name: 'Archive product' })).toBeTruthy();
  });

  it('opens the adjust dialog for that row’s product', async () => {
    await renderPage();
    fireEvent.click(rowFor('Majirel 6.0').getByRole('button', { name: /More actions/ }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Adjust stock' }));

    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('Adjust stock')).toBeTruthy();
    expect((within(dialog).getByLabelText('Product') as HTMLSelectElement).value).toBe('prod-1');
  });

  it('carries the row’s own location into the stock dialog', async () => {
    // Two salons in view: adjusting the Kensington row must target Kensington.
    api.listInventoryStock.mockResolvedValue({
      stock: [
        stockRow(),
        stockRow({ id: 'stock-k', locationId: 'loc-2', locationName: 'Kensington', quantityOnHandGrams: 80 }),
      ],
      locations: [
        { id: 'loc-1', name: 'Pinner' },
        { id: 'loc-2', name: 'Kensington' },
      ],
      scope: 'owner',
    });
    render(<InventoryPage />);
    await screen.findAllByText('Majirel 6.0');

    const kensingtonRow = within(
      inventoryTable().getAllByText('Kensington')[0].closest('tr') as HTMLElement,
    );
    fireEvent.click(kensingtonRow.getByRole('button', { name: /More actions/ }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Adjust stock' }));

    const dialog = await screen.findByRole('dialog');
    expect((within(dialog).getByLabelText('Location') as HTMLSelectElement).value).toBe('loc-2');
  });

  it('is operable from the keyboard: opening focuses an item, arrows move, Escape returns', async () => {
    await renderPage();
    const trigger = rowFor('Majirel 6.0').getByRole('button', { name: /More actions/ });
    fireEvent.click(trigger);

    const menu = await screen.findByRole('menu');
    const items = within(menu).getAllByRole('menuitem');
    // Focus lands inside the menu even though the portal puts it at the end
    // of the document, where Tab order would never reach it next.
    await waitFor(() => expect(document.activeElement).toBe(items[0]));

    fireEvent.keyDown(menu, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(items[1]);
    fireEvent.keyDown(menu, { key: 'ArrowUp' });
    expect(document.activeElement).toBe(items[0]);
    fireEvent.keyDown(menu, { key: 'End' });
    expect(document.activeElement).toBe(items[items.length - 1]);

    fireEvent.keyDown(menu, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull());
    expect(document.activeElement).toBe(trigger);
  });

  it('closes the menu on Escape', async () => {
    await renderPage();
    fireEvent.click(rowFor('Majirel 6.0').getByRole('button', { name: /More actions/ }));
    expect(await screen.findByRole('menu')).toBeTruthy();
    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull());
  });

  it('archives a product through the API after confirmation', async () => {
    const confirmSpy = jest.spyOn(window, 'confirm').mockReturnValue(true);
    api.archiveInventoryProduct.mockResolvedValue({ product: product({ isActive: false }) });
    await renderPage();
    fireEvent.click(rowFor('Majirel 6.0').getByRole('button', { name: /More actions/ }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Archive product' }));

    await waitFor(() => expect(api.archiveInventoryProduct).toHaveBeenCalledWith('token', 'prod-1'));
    confirmSpy.mockRestore();
  });
});

describe('after saving a product', () => {
  it('reopens with the SAVED values while the catalogue refetch is still in flight', async () => {
    await renderPage();
    fireEvent.click(rowFor('Majirel 6.0').getByRole('button', { name: 'Edit' }));
    await screen.findByRole('dialog');

    const saved = product({ name: 'Majirel 6.0', sku: 'CHANGED-SKU', updatedAt: '2026-08-26T12:00:00.000Z' });
    api.updateInventoryProduct.mockResolvedValue({ product: saved });
    // The refetch has not answered yet — the window in which the page used to
    // serve the pre-save snapshot back to the drawer.
    api.listInventoryProducts.mockReturnValue(new Promise(() => undefined));

    fireEvent.change(screen.getByLabelText(/SKU/), { target: { value: 'CHANGED-SKU' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());

    fireEvent.click(rowFor('Majirel 6.0').getByRole('button', { name: 'Edit' }));
    const reopened = await screen.findByRole('dialog');
    expect((within(reopened).getByLabelText(/SKU/) as HTMLInputElement).value).toBe('CHANGED-SKU');
  });

  it('recomputes dead stock, because the threshold that drives it lives on the product', async () => {
    await renderPage();
    api.listInventoryDeadStock.mockClear();
    fireEvent.click(rowFor('Majirel 6.0').getByRole('button', { name: 'Edit' }));
    await screen.findByRole('dialog');
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(api.listInventoryDeadStock).toHaveBeenCalled());
  });
});

describe('safety rails', () => {
  it('refuses a nonsense safety threshold instead of silently clearing it', async () => {
    await renderPage();
    const cell = inventoryTable().getByLabelText(/Safety threshold for Majirel/);
    fireEvent.blur(cell, { target: { value: 'abc' } });

    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(api.updateInventoryStockThreshold).not.toHaveBeenCalled();
  });

  it('does not write a threshold that has not changed', async () => {
    await renderPage();
    const cell = inventoryTable().getByLabelText(/Safety threshold for Majirel/);
    fireEvent.blur(cell, { target: { value: '50' } });
    expect(api.updateInventoryStockThreshold).not.toHaveBeenCalled();
  });
});

describe('stock activity', () => {
  it('reads in salon language and never shows a raw id as the description', async () => {
    await renderPage();
    expect(activity().getByText('+200g')).toBeTruthy();
    expect(activity().getByText(/Restocked at Pinner · by Ada Lovelace/)).toBeTruthy();
    expect(screen.queryByText(/bf09e3e5/)).toBeNull();
  });

  it('opens the audit detail with the internal ids on demand', async () => {
    await renderPage();
    fireEvent.click(activity().getByText(/Restocked at Pinner/));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('Movement detail')).toBeTruthy();
    expect(within(dialog).getByText('mv-1')).toBeTruthy();
  });

  it('says so when the period has no movements', async () => {
    api.listInventoryMovements.mockResolvedValue({ movements: [] });
    await renderPage();
    expect(await screen.findByText('No stock movements in this period')).toBeTruthy();
  });
});

describe('failure states', () => {
  it('offers a retry when the inventory query fails, and recovers', async () => {
    api.listInventoryStock.mockRejectedValueOnce(new Error('network'));
    render(<InventoryPage />);
    expect(await screen.findByText('Unable to load the product inventory.')).toBeTruthy();

    fireEvent.click(screen.getAllByRole('button', { name: 'Retry' })[0]);
    expect(await inventoryTable().findByRole('button', { name: 'Majirel 6.0' })).toBeTruthy();
  });

  it('offers a retry when the activity query fails', async () => {
    api.listInventoryMovements.mockRejectedValue(new Error('network'));
    render(<InventoryPage />);
    expect(await screen.findByText('Unable to load stock activity.')).toBeTruthy();
  });
});
