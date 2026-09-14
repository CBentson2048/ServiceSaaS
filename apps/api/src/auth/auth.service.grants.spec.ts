/**
 * resolveAuthUser → AuthUser.membershipGrants, through the real AuthService
 * wiring (the pure rules are pinned in membership-grants.spec.ts).
 *
 * Proves the parts only the service can get wrong: the security-level select
 * carries business_id, the resolver receives the business's locations and
 * same-business memberships, grants land on the AuthUser (and not for owners),
 * and the merged `permissions` keep their existing role-default behaviour.
 */
import type { ConfigService } from '@nestjs/config';
import { createClient } from '@supabase/supabase-js';
import { DEFAULT_ROLE_PERMISSIONS, SYSTEM_SECURITY_LEVELS, type Permission } from '@sheer/domain';
import type { EmailService } from '../email/email.service';
import { AuthService } from './auth.service';

jest.mock('@supabase/supabase-js', () => ({ createClient: jest.fn() }));
const mockedCreateClient = createClient as jest.MockedFunction<typeof createClient>;

const BIZ = 'biz-1';
const OTHER_BIZ = 'biz-2';
const A = 'loc-a';
const B = 'loc-b';
const CLOSED = 'loc-closed';

const managerLevel = (SYSTEM_SECURITY_LEVELS.find((l) => l.key === 'manager')?.permissions ?? []) as Permission[];

type Row = Record<string, unknown>;
interface Tables {
  memberships: Row[];
  levels: Row[];
}

function fakeAdmin(tables: Tables) {
  const selects: Record<string, string[]> = {};
  const client = {
    schema: () => ({
      from: (table: string) => {
        const builder: Record<string, unknown> = {};
        const chain = () => builder;
        for (const op of ['eq', 'in', 'order', 'limit', 'update']) builder[op] = chain;
        builder.select = (columns: string) => {
          (selects[table] ??= []).push(columns);
          return builder;
        };
        const rows = (): unknown => {
          switch (table) {
            case 'user_profiles':
              return { id: 'user-1', email: 'x@example.com', full_name: 'X', phone: null, avatar_url: null, is_customer: false };
            case 'user_memberships':
              return tables.memberships;
            case 'businesses':
              return { id: BIZ, name: 'Salon', slug: 'salon', tier: 'infinity' };
            case 'locations':
              return [
                { id: A, name: 'London', code: null, slug: null, is_active: true },
                { id: B, name: 'Tokyo', code: null, slug: null, is_active: true },
                { id: CLOSED, name: 'Old Street', code: null, slug: null, is_active: false },
              ];
            case 'security_levels':
              return tables.levels;
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
  return { client, selects };
}

function serviceWith(tables: Tables) {
  const fake = fakeAdmin(tables);
  mockedCreateClient.mockReturnValue(fake.client as unknown as ReturnType<typeof createClient>);
  const config = {
    getOrThrow: (key: string) => `placeholder-${key}`,
    get: () => undefined,
  } as unknown as ConfigService;
  return { service: new AuthService(config, {} as EmailService), selects: fake.selects };
}

const membership = (role: string, location: string | null, level: string | null, overrides: Row = {}): Row => ({
  business_id: BIZ,
  location_id: location,
  role,
  status: 'active',
  security_level_id: level,
  ...overrides,
});

describe('AuthService.resolveAuthUser — membership grants', () => {
  it('grants manager@A with an explicit Manager level at A only, never at the stylist row’s B', async () => {
    const { service, selects } = serviceWith({
      memberships: [membership('manager', A, 'lvl-manager'), membership('stylist', B, 'lvl-manager')],
      levels: [{ id: 'lvl-manager', business_id: BIZ, permissions: managerLevel }],
    });
    const user = await service.resolveAuthUser('user-1');
    expect(user.membershipGrants?.map((g) => g.locationId)).toEqual([A]);
    expect(user.membershipGrants?.[0].permissions).toContain('report.financials.view');
    // The merged union still spans both rows, as before Ticket A.
    expect(user.allowedLocationIds.sort()).toEqual([A, B]);
    expect(selects.security_levels).toEqual(['id,business_id,permissions']);
  });

  it('gives a NULL-level manager an empty grant list while merged permissions keep the role defaults', async () => {
    const { service, selects } = serviceWith({ memberships: [membership('manager', A, null)], levels: [] });
    const user = await service.resolveAuthUser('user-1');
    expect(user.membershipGrants).toEqual([]);
    expect(user.permissions).toEqual(expect.arrayContaining(DEFAULT_ROLE_PERMISSIONS.manager));
    expect(selects.security_levels).toBeUndefined();
  });

  it('gives no grant for a level that belongs to another business', async () => {
    const { service } = serviceWith({
      memberships: [membership('manager', A, 'lvl-foreign')],
      levels: [{ id: 'lvl-foreign', business_id: OTHER_BIZ, permissions: managerLevel }],
    });
    const user = await service.resolveAuthUser('user-1');
    expect(user.membershipGrants).toEqual([]);
    // Merged permissions are unchanged by Ticket A: they still read the level as before.
    expect(user.permissions).toEqual(expect.arrayContaining(['report.financials.view']));
  });

  it('keeps a grant at an inactive business location', async () => {
    const { service } = serviceWith({
      memberships: [membership('manager', CLOSED, 'lvl-manager')],
      levels: [{ id: 'lvl-manager', business_id: BIZ, permissions: managerLevel }],
    });
    const user = await service.resolveAuthUser('user-1');
    expect(user.membershipGrants?.map((g) => g.locationId)).toEqual([CLOSED]);
  });

  it('gives an owner no grants key and reads no security level', async () => {
    const { service, selects } = serviceWith({
      memberships: [membership('owner', null, null), membership('stylist', A, 'lvl-manager')],
      levels: [{ id: 'lvl-manager', business_id: BIZ, permissions: managerLevel }],
    });
    const user = await service.resolveAuthUser('user-1');
    expect(user).not.toHaveProperty('membershipGrants');
    expect(user.roles).toContain('owner');
    expect(selects.security_levels).toBeUndefined();
  });
});
