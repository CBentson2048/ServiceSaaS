/**
 * resolveAuthUser → AuthUser.allowedLocationIds ordering.
 *
 * `allowedLocationIds[0]` is read as a stable default location (the rota's
 * server-side fallback, `resolveLocationForActor`, is the live example), and
 * the clients fall back to `locations[0]`. The membership query is unordered,
 * so the union has to be projected through the business's own location order —
 * otherwise the two disagree and the "home" location drifts between logins.
 */
import type { ConfigService } from '@nestjs/config';
import { createClient } from '@supabase/supabase-js';
import type { EmailService } from '../email/email.service';
import { AuthService } from './auth.service';

jest.mock('@supabase/supabase-js', () => ({ createClient: jest.fn() }));
const mockedCreateClient = createClient as jest.MockedFunction<typeof createClient>;

const BIZ = 'biz-1';
const A = 'loc-a';
const B = 'loc-b';
const CLOSED = 'loc-closed';
const GONE = 'loc-gone';

type Row = Record<string, unknown>;

// `locations` comes back ordered by sort_order; the fake preserves that order
// the way the real query does.
function fakeAdmin(memberships: Row[]) {
  return {
    schema: () => ({
      from: (table: string) => {
        const builder: Record<string, unknown> = {};
        const chain = () => builder;
        for (const op of ['eq', 'in', 'order', 'limit', 'update', 'select']) builder[op] = chain;
        const rows = (): unknown => {
          switch (table) {
            case 'user_profiles':
              return { id: 'user-1', email: 'x@example.com', full_name: 'X', phone: null, avatar_url: null, is_customer: false };
            case 'user_memberships':
              return memberships;
            case 'businesses':
              return { id: BIZ, name: 'Salon', slug: 'salon', tier: 'infinity' };
            case 'locations':
              return [
                { id: A, name: 'London', code: null, slug: null, is_active: true },
                { id: B, name: 'Tokyo', code: null, slug: null, is_active: true },
                { id: CLOSED, name: 'Old Street', code: null, slug: null, is_active: false },
              ];
            default:
              return null;
          }
        };
        builder.single = () => Promise.resolve({ data: rows(), error: null });
        builder.maybeSingle = () => Promise.resolve({ data: rows(), error: null });
        builder.returns = () => Promise.resolve({ data: rows(), error: null });
        return builder;
      },
    }),
  };
}

function serviceWith(memberships: Row[]) {
  mockedCreateClient.mockReturnValue(
    fakeAdmin(memberships) as unknown as ReturnType<typeof createClient>,
  );
  const config = {
    getOrThrow: (key: string) => `placeholder-${key}`,
    get: () => undefined,
  } as unknown as ConfigService;
  return new AuthService(config, {} as EmailService);
}

const membership = (role: string, location: string | null): Row => ({
  business_id: BIZ,
  location_id: location,
  role,
  status: 'active',
  security_level_id: null,
});

describe('AuthService.resolveAuthUser — allowedLocationIds ordering', () => {
  it('orders a manager’s locations by the business order, not by membership row order', async () => {
    // Rows arrive B-first; the business lists A first.
    const service = serviceWith([membership('manager', B), membership('manager', A)]);
    const user = await service.resolveAuthUser('user-1');
    expect(user.allowedLocationIds).toEqual([A, B]);
  });

  it('keeps allowedLocationIds[0] in step with locations[0]', async () => {
    const service = serviceWith([membership('manager', B), membership('stylist', A)]);
    const user = await service.resolveAuthUser('user-1');
    expect(user.allowedLocationIds).toEqual(user.locations.map((location) => location.id));
    expect(user.allowedLocationIds[0]).toBe(user.locations[0].id);
  });

  it('keeps a membership at a location the business no longer lists', async () => {
    const service = serviceWith([membership('manager', GONE), membership('manager', A)]);
    const user = await service.resolveAuthUser('user-1');
    expect(user.allowedLocationIds).toEqual([A, GONE]);
  });

  it('leaves the owner scope on the business’s active locations', async () => {
    const service = serviceWith([membership('owner', null)]);
    const user = await service.resolveAuthUser('user-1');
    expect(user.allowedLocationIds).toEqual([A, B]);
  });
});
