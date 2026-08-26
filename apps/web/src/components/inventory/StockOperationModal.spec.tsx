/**
 * Adjust Stock / Restock as dialogs (§17/§18/§33): both write through the
 * existing adjust-stock API, a loss must be explained, and a server refusal
 * (e.g. insufficient stock) is shown as the server worded it.
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { BusinessLocationSummary, InventoryLocationStock, InventoryProduct } from '@sheer/domain';
import { StockOperationModal } from './StockOperationModal';

jest.mock('../../auth/api', () => {
  class ApiRequestError extends Error {
    status: number;
    constructor(message: string, status: number) {
      super(message);
      this.status = status;
    }
  }
  return { ApiRequestError, adjustInventoryStock: jest.fn() };
});

// eslint-disable-next-line @typescript-eslint/no-var-requires
const api = require('../../auth/api') as {
  ApiRequestError: new (message: string, status: number) => Error & { status: number };
  adjustInventoryStock: jest.Mock;
};

const locations: BusinessLocationSummary[] = [{ id: 'loc-1', name: 'Pinner' }];

const products: InventoryProduct[] = [
  {
    id: 'prod-1',
    businessId: 'biz-1',
    name: 'Majirel 6.0',
    sizeUnit: 'g',
    defaultUnit: 'g',
    lowStockThresholdGrams: 50,
    isActive: true,
    stockUnit: 'gram',
    minimumOrderQuantity: 1,
    orderMultiple: 1,
    isSalonUse: true,
    isLabUse: false,
    isRetail: false,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  },
];

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

function renderModal(operation: 'adjust' | 'restock', onRecorded = jest.fn()) {
  render(
    <StockOperationModal
      open
      operation={operation}
      accessToken="token"
      locations={locations}
      products={products}
      stock={stock}
      defaultLocationId="loc-1"
      onClose={jest.fn()}
      onRecorded={onRecorded}
    />,
  );
  return { onRecorded };
}

beforeEach(() => {
  jest.clearAllMocks();
  api.adjustInventoryStock.mockResolvedValue({
    stock: { ...stock[0], quantityOnHandGrams: 250 },
  });
});

describe('restock', () => {
  it('records an inbound restock movement', async () => {
    const { onRecorded } = renderModal('restock');
    fireEvent.change(screen.getByLabelText('Product'), { target: { value: 'prod-1' } });
    fireEvent.change(screen.getByLabelText('Quantity in g'), { target: { value: '50' } });
    fireEvent.click(screen.getByRole('button', { name: 'Record restock' }));

    await waitFor(() => expect(api.adjustInventoryStock).toHaveBeenCalled());
    expect(api.adjustInventoryStock.mock.calls[0][1]).toMatchObject({
      locationId: 'loc-1',
      productId: 'prod-1',
      quantityDeltaGrams: 50,
      movementType: 'restock',
    });
    expect(onRecorded).toHaveBeenCalled();
  });

  it('explains that it means a delivery, not a correction', () => {
    renderModal('restock');
    expect(screen.getByText(/received from a supplier/i)).toBeTruthy();
  });
});

describe('adjust', () => {
  it('records an inbound correction as a manual adjustment, not a restock', async () => {
    renderModal('adjust');
    fireEvent.change(screen.getByLabelText('Product'), { target: { value: 'prod-1' } });
    fireEvent.change(screen.getByLabelText('Quantity in g'), { target: { value: '20' } });
    fireEvent.click(screen.getByRole('button', { name: 'Record adjustment' }));

    await waitFor(() => expect(api.adjustInventoryStock).toHaveBeenCalled());
    expect(api.adjustInventoryStock.mock.calls[0][1]).toMatchObject({
      quantityDeltaGrams: 20,
      movementType: 'manual_adjustment',
    });
  });

  it('signs a loss negative and carries its reason', async () => {
    renderModal('adjust');
    fireEvent.change(screen.getByLabelText('Product'), { target: { value: 'prod-1' } });
    fireEvent.click(screen.getByText('Loss / remove'));
    fireEvent.change(screen.getByLabelText('Quantity in g'), { target: { value: '15' } });
    fireEvent.change(screen.getByPlaceholderText(/Cycle count/), { target: { value: 'Breakage' } });
    fireEvent.click(screen.getByRole('button', { name: 'Record adjustment' }));

    await waitFor(() => expect(api.adjustInventoryStock).toHaveBeenCalled());
    expect(api.adjustInventoryStock.mock.calls[0][1]).toMatchObject({
      quantityDeltaGrams: -15,
      reason: 'Breakage',
    });
  });

  it('refuses a loss with no reason, before calling the API', async () => {
    renderModal('adjust');
    fireEvent.change(screen.getByLabelText('Product'), { target: { value: 'prod-1' } });
    fireEvent.click(screen.getByText('Loss / remove'));
    fireEvent.change(screen.getByLabelText('Quantity in g'), { target: { value: '15' } });
    fireEvent.click(screen.getByRole('button', { name: 'Record adjustment' }));

    expect(await screen.findByText(/only record of it/i)).toBeTruthy();
    expect(api.adjustInventoryStock).not.toHaveBeenCalled();
  });

  it('refuses a missing product or quantity', async () => {
    renderModal('adjust');
    fireEvent.click(screen.getByRole('button', { name: 'Record adjustment' }));
    expect(await screen.findByText('Choose a product.')).toBeTruthy();
    expect(api.adjustInventoryStock).not.toHaveBeenCalled();
  });

  it('shows the current shelf level for the chosen product', () => {
    renderModal('adjust');
    fireEvent.change(screen.getByLabelText('Product'), { target: { value: 'prod-1' } });
    expect(screen.getByText(/Currently 200g on hand here/)).toBeTruthy();
  });

  it('surfaces the server’s own refusal wording', async () => {
    api.adjustInventoryStock.mockRejectedValue(
      new api.ApiRequestError('Insufficient stock: Majirel 6.0 at Pinner', 409),
    );
    renderModal('adjust');
    fireEvent.change(screen.getByLabelText('Product'), { target: { value: 'prod-1' } });
    fireEvent.change(screen.getByLabelText('Quantity in g'), { target: { value: '999' } });
    fireEvent.click(screen.getByRole('button', { name: 'Record adjustment' }));

    expect((await screen.findByRole('alert')).textContent).toContain('Insufficient stock');
  });
});
