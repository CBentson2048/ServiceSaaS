/**
 * The scan → identify → confirm → deduct workflow (§13, §15, §16).
 *
 * The rule under test everywhere here: a scan IDENTIFIES the product and never
 * moves stock; only an explicit confirmation calls the consumption API.
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { InventoryLocationStock, InventoryProduct } from '@sheer/domain';
import { ScanConsumeModal } from './ScanConsumeModal';

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
    lookupInventoryBarcode: jest.fn(),
    recordProductConsumption: jest.fn(),
  };
});

// eslint-disable-next-line @typescript-eslint/no-var-requires
const api = require('../../auth/api') as {
  ApiRequestError: new (message: string, status: number) => Error & { status: number };
  lookupInventoryBarcode: jest.Mock;
  recordProductConsumption: jest.Mock;
};

const product: InventoryProduct = {
  id: 'prod-1',
  businessId: 'biz-1',
  name: 'Majirel 6.0',
  brand: 'L’Oréal',
  sku: 'MAJ-60',
  sizeUnit: 'g',
  defaultUnit: 'g',
  lowStockThresholdGrams: 50,
  isActive: true,
  stockUnit: 'gram',
  packSize: 100,
  barcode: '5010000000001',
  minimumOrderQuantity: 1,
  orderMultiple: 1,
  isSalonUse: true,
  isLabUse: true,
  isRetail: false,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

const stock: InventoryLocationStock[] = [
  {
    id: 'stock-1',
    businessId: 'biz-1',
    locationId: 'loc-1',
    locationName: 'Pinner',
    productId: 'prod-1',
    productName: 'Majirel 6.0',
    quantityOnHandGrams: 200,
    effectiveLowStockThresholdGrams: 50,
    isLowStock: false,
    isActive: true,
    updatedAt: '2026-08-01T00:00:00.000Z',
  },
];

function renderModal(overrides: Partial<React.ComponentProps<typeof ScanConsumeModal>> = {}) {
  const onConsumed = jest.fn();
  const utils = render(
    <ScanConsumeModal
      open
      accessToken="token"
      locationId="loc-1"
      locationName="Pinner"
      locations={[{ id: 'loc-1', name: 'Pinner' }]}
      products={[product]}
      stock={stock}
      onClose={jest.fn()}
      onConsumed={onConsumed}
      {...overrides}
    />,
  );
  return { ...utils, onConsumed };
}

function scan(barcode: string) {
  const input = screen.getByLabelText('Barcode');
  fireEvent.change(input, { target: { value: barcode } });
  fireEvent.keyDown(input, { key: 'Enter' });
  return input;
}

const foundLookup = { product, locationId: 'loc-1', quantityOnHandGrams: 200 };

beforeEach(() => {
  jest.clearAllMocks();
  api.lookupInventoryBarcode.mockResolvedValue(foundLookup);
  api.recordProductConsumption.mockResolvedValue({
    movementId: 'mv-1',
    productId: 'prod-1',
    productName: 'Majirel 6.0',
    locationId: 'loc-1',
    quantityDeductedGrams: 30,
    quantityOnHandGrams: 170,
    idempotentReplay: false,
  });
});

describe('wedge scanner / manual entry', () => {
  it('autofocuses the scanner field so a scan can land immediately', () => {
    renderModal();
    expect(document.activeElement).toBe(screen.getByLabelText('Barcode'));
  });

  it('resolves a product on Enter and shows its current stock — without deducting', async () => {
    renderModal();
    scan('5010000000001');
    expect(await screen.findByText('Majirel 6.0')).toBeTruthy();
    expect(screen.getByText('200g')).toBeTruthy();
    expect(api.recordProductConsumption).not.toHaveBeenCalled();
  });

  it('strips the control characters a scanner appends', async () => {
    renderModal();
    scan('5010000000001\r\n');
    await waitFor(() => expect(api.lookupInventoryBarcode).toHaveBeenCalled());
    expect(api.lookupInventoryBarcode).toHaveBeenCalledWith('token', {
      barcode: '5010000000001',
      locationId: 'loc-1',
    });
  });

  it('ignores a repeated Enter while the lookup is in flight', async () => {
    let resolveLookup: (value: unknown) => void = () => undefined;
    api.lookupInventoryBarcode.mockReturnValue(new Promise((resolve) => { resolveLookup = resolve; }));
    renderModal();
    const input = scan('5010000000001');
    fireEvent.keyDown(input, { key: 'Enter' });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(api.lookupInventoryBarcode).toHaveBeenCalledTimes(1);
    resolveLookup(foundLookup);
    await screen.findByText('Majirel 6.0');
  });

  it('reports an unknown barcode distinctly, with the code and a fix', async () => {
    api.lookupInventoryBarcode.mockRejectedValue(new api.ApiRequestError('No product matches barcode 0000', 404));
    renderModal();
    scan('0000');
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('"0000"');
    expect(alert.textContent).toContain('Add the barcode');
  });

  it('reports an archived product as its own state', async () => {
    api.lookupInventoryBarcode.mockRejectedValue(new api.ApiRequestError('Majirel 6.0 is archived and cannot be used', 409));
    renderModal();
    scan('5010000000001');
    expect((await screen.findByRole('alert')).textContent).toContain('archived');
  });

  it('surfaces an out-of-scope location refusal from the server', async () => {
    api.lookupInventoryBarcode.mockRejectedValue(new api.ApiRequestError('Location is outside your inventory scope', 403));
    renderModal();
    scan('5010000000001');
    expect((await screen.findByRole('alert')).textContent).toContain('outside your inventory scope');
  });
});

describe('confirming consumption', () => {
  it('deducts only on confirmation and reports the new shelf level', async () => {
    const { onConsumed } = renderModal();
    scan('5010000000001');
    await screen.findByText('Majirel 6.0');

    fireEvent.change(screen.getByLabelText('Amount used'), { target: { value: '30' } });
    fireEvent.change(screen.getByLabelText('Quantity unit'), { target: { value: 'base' } });
    fireEvent.click(screen.getByRole('button', { name: 'Record consumption' }));

    await waitFor(() => expect(api.recordProductConsumption).toHaveBeenCalled());
    const payload = api.recordProductConsumption.mock.calls[0][1];
    expect(payload).toMatchObject({
      locationId: 'loc-1',
      productId: 'prod-1',
      quantity: 30,
      unit: 'base',
      reason: 'salon_consumption',
    });
    expect(payload.idempotencyKey).toMatch(/^scan-/);
    expect((await screen.findByRole('status')).textContent).toContain('consumed 30g');
    expect(onConsumed).toHaveBeenCalled();
  });

  it('rejects an invalid quantity before calling the API', async () => {
    renderModal();
    scan('5010000000001');
    await screen.findByText('Majirel 6.0');
    fireEvent.change(screen.getByLabelText('Amount used'), { target: { value: '0' } });
    fireEvent.click(screen.getByRole('button', { name: 'Record consumption' }));
    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(api.recordProductConsumption).not.toHaveBeenCalled();
  });

  it('keeps the product and the SAME idempotency key when the server errors, so a retry is safe', async () => {
    api.recordProductConsumption.mockRejectedValueOnce(new api.ApiRequestError('Insufficient stock', 409));
    renderModal();
    scan('5010000000001');
    await screen.findByText('Majirel 6.0');

    fireEvent.click(screen.getByRole('button', { name: 'Record consumption' }));
    expect((await screen.findByRole('alert')).textContent).toContain('Insufficient stock');

    fireEvent.click(screen.getByRole('button', { name: 'Record consumption' }));
    await waitFor(() => expect(api.recordProductConsumption).toHaveBeenCalledTimes(2));
    const [first, second] = api.recordProductConsumption.mock.calls;
    expect(second[1].idempotencyKey).toBe(first[1].idempotencyKey);
  });

  it('reports a replayed retry as deducting nothing more', async () => {
    api.recordProductConsumption.mockResolvedValue({
      movementId: 'mv-1',
      productId: 'prod-1',
      productName: 'Majirel 6.0',
      locationId: 'loc-1',
      quantityDeductedGrams: 0,
      quantityOnHandGrams: 170,
      idempotentReplay: true,
    });
    renderModal();
    scan('5010000000001');
    await screen.findByText('Majirel 6.0');
    fireEvent.click(screen.getByRole('button', { name: 'Record consumption' }));
    expect((await screen.findByRole('status')).textContent).toContain('already recorded');
  });

  it('returns to the scanner ready for the next product after success', async () => {
    renderModal();
    scan('5010000000001');
    await screen.findByText('Majirel 6.0');
    fireEvent.click(screen.getByRole('button', { name: 'Record consumption' }));
    const done = await screen.findByRole('status');
    expect(done.textContent).toContain('Ready for the next scan');
    expect(screen.getByLabelText('Barcode')).toHaveProperty('value', '');
  });
});

describe('choosing the salon', () => {
  it('hides the picker when there is only one location', () => {
    renderModal();
    expect(screen.queryByLabelText('Location')).toBeNull();
  });

  it('lets the user pick the salon, and consumes from THAT shelf', async () => {
    renderModal({
      locations: [
        { id: 'loc-1', name: 'Pinner' },
        { id: 'loc-2', name: 'Kensington' },
      ],
    });
    fireEvent.change(screen.getByLabelText('Location'), { target: { value: 'loc-2' } });
    scan('5010000000001');
    await waitFor(() => expect(api.lookupInventoryBarcode).toHaveBeenCalled());
    // The lookup — and therefore the deduction — targets the chosen salon.
    expect(api.lookupInventoryBarcode).toHaveBeenCalledWith('token', {
      barcode: '5010000000001',
      locationId: 'loc-2',
    });

    await screen.findByText('Majirel 6.0');
    fireEvent.click(screen.getByRole('button', { name: 'Record consumption' }));
    await waitFor(() => expect(api.recordProductConsumption).toHaveBeenCalled());
    expect(api.recordProductConsumption.mock.calls[0][1].locationId).toBe('loc-2');
  });
});

describe('manual product search fallback', () => {
  it('finds a product by name and resolves it without a barcode lookup', async () => {
    renderModal();
    fireEvent.click(screen.getByRole('tab', { name: 'Search product' }));
    fireEvent.change(screen.getByLabelText('Search products'), { target: { value: 'majirel' } });
    fireEvent.click(await screen.findByRole('button', { name: /Majirel 6.0/ }));

    expect(screen.getByText('200g')).toBeTruthy();
    expect(api.lookupInventoryBarcode).not.toHaveBeenCalled();
  });

  it('refuses a product that is not stocked at this location', async () => {
    renderModal({ stock: [] });
    fireEvent.click(screen.getByRole('tab', { name: 'Search product' }));
    fireEvent.change(screen.getByLabelText('Search products'), { target: { value: 'majirel' } });
    fireEvent.click(await screen.findByRole('button', { name: /Majirel 6.0/ }));
    expect((await screen.findByRole('alert')).textContent).toContain('not stocked at Pinner');
  });

  it('says so when nothing matches', async () => {
    renderModal();
    fireEvent.click(screen.getByRole('tab', { name: 'Search product' }));
    fireEvent.change(screen.getByLabelText('Search products'), { target: { value: 'zzzz' } });
    expect(await screen.findByText(/No products match/)).toBeTruthy();
  });
});
