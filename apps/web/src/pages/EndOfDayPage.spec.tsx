/**
 * End of Day petty cash: a failed add may still have saved the entry (the API
 * answers "Petty cash was recorded…"). The page must then show the stored day
 * and clear the form, so one more click can't add the entry twice.
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { EodDayResponse, EodReconciliation } from '@sheer/domain';
import type { addEodPettyCash, getEodDay } from '../auth/api';
import { EndOfDayPage } from './EndOfDayPage';

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
    addEodPettyCash: jest.fn(),
    getEodDay: jest.fn(),
    openEodDay: jest.fn(),
    refreshEodDay: jest.fn(),
    signOffEodDay: jest.fn(),
    updateEodDay: jest.fn(),
  };
});

jest.mock('../auth/AuthProvider', () => ({
  useAuth: () => ({
    status: 'authenticated',
    session: { accessToken: 'token' },
    user: { id: 'user-1', roles: ['manager'], primaryRole: 'manager', permissions: ['eod.manage', 'eod.sign_off'] },
  }),
}));

jest.mock('../components/LocationScopeContext', () => ({
  useLocationScope: () => ({ locations: [{ id: 'loc-1', name: 'Kensington' }], resolvedLocationId: 'loc-1' }),
}));

const api = jest.requireMock('../auth/api') as {
  ApiRequestError: new (message: string, status: number) => Error;
  addEodPettyCash: jest.MockedFunction<typeof addEodPettyCash>;
  getEodDay: jest.MockedFunction<typeof getEodDay>;
};

const RECORDED = 'Petty cash was recorded, but the day could not be reloaded. Reload the day before adding it again.';

function dayWith(pettyCash: EodReconciliation['pettyCash']): EodDayResponse {
  return {
    day: {
      id: 'eod-1',
      businessId: 'biz-1',
      locationId: 'loc-1',
      businessDate: '2026-09-15',
      status: 'open',
      openingFloatCents: 0,
      expectedCashCents: 1000,
      expectedCardCents: 0,
      unclassifiedRetailCents: 0,
      depositsCollectedCents: 0,
      depositsRedeemedCents: 0,
      voidsCents: 0,
      refundsCents: 0,
      pettyCashOutCents: pettyCash.reduce((sum, entry) => sum + entry.amountCents, 0),
      currencyCode: 'GBP',
      createdAt: '2026-09-15T08:00:00.000Z',
      updatedAt: '2026-09-15T08:00:00.000Z',
      pettyCash,
    },
    openVisits: 0,
    cashVarianceThresholdCents: 500,
    notCaptured: ['refunds', 'voids'],
  };
}

const windowCleaner = { id: 'p-1', amountCents: 700, reason: 'window cleaner', createdAt: '2026-09-15T10:00:00.000Z' };
const milk = { id: 'p-2', amountCents: 300, reason: 'milk', createdAt: '2026-09-15T11:00:00.000Z' };

async function addMilk() {
  render(<EndOfDayPage />);
  await screen.findByText('window cleaner');
  fireEvent.change(screen.getByLabelText('Amount (£)'), { target: { value: '3.00' } });
  fireEvent.change(screen.getByLabelText('Reason'), { target: { value: 'milk' } });
  fireEvent.click(screen.getByRole('button', { name: 'Add' }));
}

beforeEach(() => {
  jest.clearAllMocks();
});

it('when the entry was saved but the day could not be reloaded, the page shows the saved entry and clears the form', async () => {
  api.getEodDay.mockResolvedValueOnce(dayWith([windowCleaner])).mockResolvedValueOnce(dayWith([windowCleaner, milk]));
  api.addEodPettyCash.mockRejectedValueOnce(new api.ApiRequestError(RECORDED, 500));

  await addMilk();

  expect(await screen.findByText(RECORDED)).toBeTruthy();
  expect(await screen.findByText('milk')).toBeTruthy();
  expect((screen.getByLabelText('Amount (£)') as HTMLInputElement).value).toBe('');
  expect((screen.getByLabelText('Reason') as HTMLInputElement).value).toBe('');
  expect((screen.getByRole('button', { name: 'Add' }) as HTMLButtonElement).disabled).toBe(true);
  expect(api.addEodPettyCash).toHaveBeenCalledTimes(1);
});

it('when the entry was not saved, the form keeps what was typed so it can be tried again', async () => {
  api.getEodDay.mockResolvedValue(dayWith([windowCleaner]));
  api.addEodPettyCash.mockRejectedValueOnce(new api.ApiRequestError('Unable to record petty cash', 500));

  await addMilk();

  expect(await screen.findByText('Unable to record petty cash')).toBeTruthy();
  await waitFor(() => expect(api.getEodDay).toHaveBeenCalledTimes(2));
  expect((screen.getByLabelText('Amount (£)') as HTMLInputElement).value).toBe('3.00');
  expect((screen.getByLabelText('Reason') as HTMLInputElement).value).toBe('milk');
  expect(screen.queryByText('milk', { selector: 'span' })).toBeNull();
});
