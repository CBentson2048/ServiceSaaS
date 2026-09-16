/**
 * Rota — location scoping.
 *
 * The weekly board is single-location, and the location comes from the shared
 * sidebar picker for EVERY role. This page used to pin non-owners to
 * `allowedLocationIds[0]`, so a manager assigned to two salons saw the picker
 * move while the board stayed on the other salon's rota.
 */
import { render, screen, waitFor } from '@testing-library/react';
import type { WeeklyRotaResponse } from '@sheer/domain';
import { RotaPage } from './RotaPage';

const KENSINGTON = 'loc-kensington';
const PRIMROSE = 'loc-primrose';

const mockAuth: {
  user: {
    id: string;
    roles: string[];
    primaryRole: string;
    permissions: string[];
    locations: { id: string; name: string }[];
    allowedLocationIds: string[];
  };
} = {
  user: {
    id: 'user-1',
    roles: ['manager'],
    primaryRole: 'manager',
    permissions: ['rota.view', 'rota.manage'],
    locations: [
      { id: KENSINGTON, name: 'Kensington' },
      { id: PRIMROSE, name: 'Primrose Hill' },
    ],
    // Deliberately Kensington-first: the old code read [0] and ignored the picker.
    allowedLocationIds: [KENSINGTON, PRIMROSE],
  },
};

const mockScope = { resolvedLocationId: KENSINGTON };

jest.mock('../auth/api', () => {
  class ApiRequestError extends Error {
    status: number;
    constructor(message: string, status: number) {
      super(message);
      this.status = status;
    }
  }
  return { ApiRequestError, getWeeklyRota: jest.fn() };
});

jest.mock('../auth/AuthProvider', () => ({
  useAuth: () => ({
    status: 'authenticated',
    session: { accessToken: 'token' },
    user: mockAuth.user,
  }),
}));

jest.mock('../components/LocationScopeContext', () => ({
  useLocationScope: () => ({
    selectedLocationId: mockScope.resolvedLocationId,
    isAllLocations: false,
    locations: mockAuth.user.locations,
    firstLocationId: mockAuth.user.locations[0]?.id ?? '',
    resolvedLocationId: mockScope.resolvedLocationId,
    setSelectedLocationId: jest.fn(),
  }),
}));

jest.mock('react-router-dom', () => ({
  Navigate: () => null,
  useNavigate: () => jest.fn(),
  useSearchParams: () => [new URLSearchParams(), jest.fn()],
}));

// The board and the leave/shift/absence surfaces have their own tests and their
// own API calls; this spec is only about which location the page asks for.
jest.mock('../components/rota/WeeklyRotaBoard', () => ({
  WeeklyRotaBoard: () => <div data-testid="board" />,
}));
jest.mock('../components/rota/LeaveRequestsPanel', () => ({
  LeaveRequestsPanel: ({ locationId }: { locationId: string }) => (
    <div data-testid="leave-panel">{locationId}</div>
  ),
}));
jest.mock('../components/rota/ShiftEditorModal', () => ({ ShiftEditorModal: () => null }));
jest.mock('../components/rota/MarkAbsenceModal', () => ({ MarkAbsenceModal: () => null }));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const api = require('../auth/api') as { getWeeklyRota: jest.Mock };

function rotaFor(locationId: string): WeeklyRotaResponse {
  return {
    locationId,
    weekStart: '2026-09-14',
    weekEnd: '2026-09-21',
    staff: [],
    shifts: [],
    leave: [],
    absences: [],
    holidayNoticeDays: 30,
    appointmentSlotMinutes: 15,
    scope: 'manager',
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockAuth.user.roles = ['manager'];
  mockAuth.user.primaryRole = 'manager';
  mockAuth.user.allowedLocationIds = [KENSINGTON, PRIMROSE];
  mockScope.resolvedLocationId = KENSINGTON;
  api.getWeeklyRota.mockImplementation((_token: string, params: { locationId?: string }) =>
    Promise.resolve(rotaFor(params.locationId ?? KENSINGTON)),
  );
});

describe('RotaPage location scope', () => {
  it('asks for the location the sidebar picker selected, not the first assigned one', async () => {
    mockScope.resolvedLocationId = PRIMROSE;

    render(<RotaPage />);

    await waitFor(() => expect(api.getWeeklyRota).toHaveBeenCalled());
    expect(api.getWeeklyRota).toHaveBeenCalledWith(
      'token',
      expect.objectContaining({ locationId: PRIMROSE }),
    );
    expect(await screen.findByText(/for Primrose Hill/)).toBeTruthy();
  });

  it('reloads for the new location when the picker moves', async () => {
    const { rerender } = render(<RotaPage />);
    await waitFor(() =>
      expect(api.getWeeklyRota).toHaveBeenCalledWith(
        'token',
        expect.objectContaining({ locationId: KENSINGTON }),
      ),
    );

    mockScope.resolvedLocationId = PRIMROSE;
    rerender(<RotaPage />);

    await waitFor(() =>
      expect(api.getWeeklyRota).toHaveBeenCalledWith(
        'token',
        expect.objectContaining({ locationId: PRIMROSE }),
      ),
    );
    expect(await screen.findByText(/for Primrose Hill/)).toBeTruthy();
  });

  it('scopes the leave panel to the selected location too', async () => {
    mockScope.resolvedLocationId = PRIMROSE;

    render(<RotaPage />);

    expect((await screen.findByTestId('leave-panel')).textContent).toBe(PRIMROSE);
  });

  it('follows the picker for owners as well', async () => {
    mockAuth.user.roles = ['owner'];
    mockAuth.user.primaryRole = 'owner';
    mockScope.resolvedLocationId = PRIMROSE;

    render(<RotaPage />);

    await waitFor(() =>
      expect(api.getWeeklyRota).toHaveBeenCalledWith(
        'token',
        expect.objectContaining({ locationId: PRIMROSE }),
      ),
    );
  });
});
