/**
 * Shared booking links carry the Salon Code, never the internal location id:
 * `/s/:salonCode` is what owners hand out, and it opens that salon's service
 * page with the code still in the address bar.
 */
import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { ClientBookingShell } from './ClientBookingShell';
import { SalonBookingLinkPage } from './SalonBookingLinkPage';
import { bookingServicePath, salonBookingLinkPath, salonBookingUrl } from './bookingLinks';
import { sessionBookingClient } from './clientBookingFlow';

function CurrentUrl() {
  const location = useLocation();
  return <output aria-label="url">{`${location.pathname}${location.search}`}</output>;
}

describe('booking links', () => {
  it('builds the owner link from the Salon Code, on the site in use', () => {
    expect(salonBookingLinkPath('k7m-2qx')).toBe('/s/K7M2QX');
    expect(salonBookingUrl('https://qlooqo.com/', 'K7M2QX')).toBe('https://qlooqo.com/s/K7M2QX');
    expect(salonBookingUrl('http://localhost:5173', 'K7M2QX')).toBe(
      'http://localhost:5173/s/K7M2QX',
    );
  });

  it('sends customers to the service page by Salon Code, falling back to the id only without one', () => {
    expect(bookingServicePath({ id: 'loc-1', salonCode: 'K7M2QX' })).toBe(
      '/book/service?salonCode=K7M2QX',
    );
    expect(bookingServicePath({ id: 'loc-1' })).toBe('/book/service?locationId=loc-1');
    expect(bookingServicePath({ salonCode: '--' })).toBe('/book/location');
  });

  it('opens /s/:salonCode on the service page with the normalised code', () => {
    render(
      <MemoryRouter initialEntries={['/s/k7m-2qx']}>
        <Routes>
          <Route path="/s/:salonCode" element={<SalonBookingLinkPage />} />
          <Route path="*" element={<CurrentUrl />} />
        </Routes>
      </MemoryRouter>,
    );

    expect(screen.getByLabelText('url').textContent).toBe('/book/service?salonCode=K7M2QX');
  });
});

describe('ClientBookingShell Back', () => {
  function renderShellAt(entries: string[]) {
    render(
      <MemoryRouter initialEntries={entries} initialIndex={entries.length - 1}>
        <Routes>
          <Route
            path="/book/service"
            element={
              <ClientBookingShell title="Service" step="Step 2 of 6">
                <span />
              </ClientBookingShell>
            }
          />
          <Route path="*" element={<CurrentUrl />} />
        </Routes>
      </MemoryRouter>,
    );
  }

  afterEach(() => window.history.replaceState(null, ''));

  it('goes to salon search when the page was opened straight from a shared link', () => {
    window.history.replaceState({ idx: 0 }, '');
    renderShellAt(['/book/service?salonCode=K7M2QX']);

    fireEvent.click(screen.getByRole('button', { name: 'Back' }));

    expect(screen.getByLabelText('url').textContent).toBe('/book/location');
  });

  it('goes back normally when the customer came from an earlier booking page', () => {
    window.history.replaceState({ idx: 1 }, '');
    renderShellAt(['/somewhere-earlier', '/book/service?salonCode=K7M2QX']);

    fireEvent.click(screen.getByRole('button', { name: 'Back' }));

    expect(screen.getByLabelText('url').textContent).toBe('/somewhere-earlier');
  });
});

describe('sessionBookingClient', () => {
  const clientOfSalonA = {
    businessId: 'business-a',
    clientProfileId: 'client-at-a',
    clientCommunicationPreference: 'sms' as const,
  };

  it('reuses the session only at the salon its client profile belongs to', () => {
    expect(sessionBookingClient(clientOfSalonA, 'business-a')).toEqual({
      clientProfileId: 'client-at-a',
      communicationPreference: 'sms',
    });
    expect(sessionBookingClient(clientOfSalonA, 'business-b')).toBeNull();
    expect(sessionBookingClient(clientOfSalonA, undefined)).toBeNull();
  });

  it('never reuses a staff or owner session, which has no client profile', () => {
    expect(sessionBookingClient({ businessId: 'business-a' }, 'business-a')).toBeNull();
  });
});
