/**
 * Campaigns — the page as a whole.
 *
 * Covers the redesign's promises: the list is the primary surface, a campaign
 * opens in a drawer without losing it, the audience dry run reads in salon
 * language, and the editor swaps its type-specific settings and previews the
 * message with representative values.
 */
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { CampaignDetail } from '@sheer/domain';
import { CampaignsPage } from './CampaignsPage';

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
    listCampaigns: jest.fn(),
    createCampaign: jest.fn(),
    updateCampaign: jest.fn(),
    setCampaignStatus: jest.fn(),
    previewCampaignAudience: jest.fn(),
    runCampaignNow: jest.fn(),
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
      permissions: ['settings.booking.manage'],
      locations: [{ id: 'loc-1', name: 'Pinner' }],
      allowedLocationIds: ['loc-1'],
    },
  }),
}));

const api = jest.requireMock('../auth/api') as {
  listCampaigns: jest.Mock;
  previewCampaignAudience: jest.Mock;
};

const campaign: CampaignDetail = {
  id: 'c-1',
  businessId: 'b-1',
  locationId: null,
  locationName: null,
  campaignType: 'rebooking',
  name: 'Six week win-back',
  status: 'active',
  channel: 'auto',
  messageTemplate: 'Hi {{first_name}}, come back to {{salon_name}}.',
  messageSubject: null,
  sendAtLocalHour: 10,
  timezone: 'Europe/London',
  config: { type: 'rebooking', targetStatuses: ['lapsed'], minOverdueDays: 0, serviceCategoryId: null },
  createdByUserProfileId: null,
  createdAt: '2026-08-01T09:00:00.000Z',
  updatedAt: '2026-08-01T09:00:00.000Z',
  lastEvaluatedAt: '2026-09-01T09:00:00.000Z',
  totals: { runCount: 3, queuedCount: 24, suppressedCount: 5, failedCount: 0 },
};

test('lists campaigns, opens the detail drawer and previews the audience', async () => {
  api.listCampaigns.mockResolvedValue({ campaigns: [campaign] });
  api.previewCampaignAudience.mockResolvedValue({
    campaignId: 'c-1',
    campaignType: 'rebooking',
    evaluatedOn: '2026-09-03',
    timezone: 'Europe/London',
    candidateCount: 6,
    eligibleCount: 4,
    suppressedCount: 2,
    suppressionBreakdown: { 'Opted out of marketing': 2 },
    sample: [
      {
        clientId: 'cl-1',
        displayName: 'Jane S.',
        maskedContact: '+44 ***** **1234',
        reason: '9 weeks overdue',
        eligible: true,
        suppressionReason: null,
      },
    ],
    sampleTruncated: false,
    wouldNotRunToday: false,
    wouldNotRunReason: null,
    renderedPreview: 'Hi Jane, come back to Your salon.',
  });

  render(<CampaignsPage />);

  expect(await screen.findByText('Six week win-back')).toBeTruthy();
  // Summary strip totals.
  expect(screen.getAllByText('24').length).toBeGreaterThan(0);

  fireEvent.click(screen.getByRole('button', { name: 'Manage' }));
  expect(await screen.findByRole('dialog')).toBeTruthy();

  fireEvent.click(screen.getByRole('button', { name: 'Preview audience' }));
  await waitFor(() => expect(screen.getByText(/4 clients would receive this today/)).toBeTruthy());
  expect(screen.getByText('Hi Jane, come back to Your salon.')).toBeTruthy();
});

test('the new-campaign drawer switches type and renders a live message preview', async () => {
  api.listCampaigns.mockResolvedValue({ campaigns: [] });

  render(<CampaignsPage />);
  await screen.findByText('No campaigns yet');

  fireEvent.click(screen.getAllByRole('button', { name: '+ New campaign' })[0]);
  const dialog = await screen.findByRole('dialog');
  fireEvent.click(screen.getByRole('button', { name: /Birthday/ }));

  expect(
    within(dialog).getByText('Happy birthday Jane! Everyone at Your salon is wishing you a wonderful day.'),
  ).toBeTruthy();
  expect(screen.getByText('days before their birthday')).toBeTruthy();
});
