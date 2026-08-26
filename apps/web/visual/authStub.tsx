/** Visual-harness stub for useAuth (owner, one salon). Not shipped. */
export function useAuth() {
  return {
    status: 'authenticated' as const,
    session: { accessToken: 'harness' },
    user: {
      id: 'user-1',
      roles: ['owner'],
      primaryRole: 'owner',
      businessId: 'biz-1',
      permissions: ['inventory.manage', 'settings.billing.manage'],
      allowedLocationIds: ['loc-1', 'loc-2'],
      locations: [
        { id: 'loc-1', name: 'Pinner' },
        { id: 'loc-2', name: 'Kensington' },
      ],
      profile: { id: 'user-1', email: 'owner@salon.test', fullName: 'Luke Ormsby' },
    },
  };
}
