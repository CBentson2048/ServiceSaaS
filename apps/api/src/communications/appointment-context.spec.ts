/**
 * What a confirmation/reminder says the client is booked for.
 *
 * The defect these cover: message content used to come from
 * `appointments.metadata.service_names`, a creation-time copy that is never
 * updated — so a pre-check-in service change left every later reminder naming
 * the service the client is no longer booked for.
 */
import { loadAppointmentContext } from './appointment-context';

interface Line {
  service_name_snapshot: string | null;
  sequence_no: number | null;
  origin: string | null;
  status: string | null;
}

function buildAdmin(options: {
  lines: Line[];
  metadataServiceNames?: string[];
  linesError?: string;
}) {
  const appointment = {
    id: 'appointment_1',
    business_id: 'business_1',
    location_id: 'location_1',
    client_profile_id: 'client_1',
    status: 'accepted',
    scheduled_start_at: '2026-05-13T09:00:00.000Z',
    communication_preference: null,
    metadata: options.metadataServiceNames ? { service_names: options.metadataServiceNames } : {},
  };

  const results: Record<string, unknown> = {
    appointments: { data: appointment, error: null },
    locations: { data: { name: 'Pinner', timezone: 'Europe/London' }, error: null },
    client_profiles: {
      data: { first_name: 'Jane', phone: '+447700900001', email: 'jane@example.com', communication_preference: null },
      error: null,
    },
    appointment_services: options.linesError
      ? { data: null, error: { message: options.linesError } }
      : { data: options.lines, error: null },
  };

  const chain = (table: string) => {
    const q: Record<string, unknown> = {};
    for (const method of ['select', 'eq', 'order']) q[method] = jest.fn(() => q);
    for (const terminal of ['maybeSingle', 'returns']) q[terminal] = jest.fn(() => Promise.resolve(results[table]));
    return q;
  };

  return {
    schema: jest.fn(() => ({ from: jest.fn((table: string) => chain(table)) })),
  } as never;
}

const BOOKED_B: Line = { service_name_snapshot: 'Service B', sequence_no: 1, origin: 'booked', status: 'scheduled' };

describe('loadAppointmentContext — service names on client messages', () => {
  it('names the service that is actually booked, not the creation-time copy', async () => {
    // Booked as Service A, swapped to Service B before check-in. The stale
    // metadata still says A; the message must say B.
    const context = await loadAppointmentContext(
      buildAdmin({ lines: [BOOKED_B], metadataServiceNames: ['Service A'] }),
      'appointment_1',
    );
    expect(context?.serviceNames).toEqual(['Service B']);
    expect(context?.serviceNames).not.toContain('Service A');
  });

  it('keeps every booked line, in booking order', async () => {
    const context = await loadAppointmentContext(
      buildAdmin({
        lines: [
          BOOKED_B,
          { service_name_snapshot: 'Cut & Finish', sequence_no: 2, origin: 'booked', status: 'scheduled' },
        ],
      }),
      'appointment_1',
    );
    expect(context?.serviceNames).toEqual(['Service B', 'Cut & Finish']);
  });

  it('does NOT let a service added during the visit rewrite a booking reminder', async () => {
    // A toner added after check-in is performed work, not booked work. A
    // "your appointment is tomorrow for ..." message must not claim it.
    const context = await loadAppointmentContext(
      buildAdmin({
        lines: [
          BOOKED_B,
          { service_name_snapshot: 'Toner', sequence_no: 2, origin: 'post_checkin_add', status: 'completed' },
        ],
      }),
      'appointment_1',
    );
    expect(context?.serviceNames).toEqual(['Service B']);
  });

  it('drops a booked line that was taken off the visit', async () => {
    const context = await loadAppointmentContext(
      buildAdmin({
        lines: [
          BOOKED_B,
          { service_name_snapshot: 'Cut & Finish', sequence_no: 2, origin: 'booked', status: 'cancelled' },
        ],
      }),
      'appointment_1',
    );
    expect(context?.serviceNames).toEqual(['Service B']);
  });

  it('falls back to the creation-time copy only when there are no line rows at all', async () => {
    const context = await loadAppointmentContext(
      buildAdmin({ lines: [], metadataServiceNames: ['Legacy Service'] }),
      'appointment_1',
    );
    expect(context?.serviceNames).toEqual(['Legacy Service']);
  });

  it('treats a line with no recorded origin as booked (pre-0110 rows)', async () => {
    const context = await loadAppointmentContext(
      buildAdmin({ lines: [{ service_name_snapshot: 'Legacy Line', sequence_no: 1, origin: null, status: null }] }),
      'appointment_1',
    );
    expect(context?.serviceNames).toEqual(['Legacy Line']);
  });

  it('surfaces a failed line read rather than silently rendering the stale copy', async () => {
    await expect(
      loadAppointmentContext(buildAdmin({ lines: [], linesError: 'boom', metadataServiceNames: ['Service A'] }), 'appointment_1'),
    ).rejects.toThrow(/load appointment services failed/);
  });
});
