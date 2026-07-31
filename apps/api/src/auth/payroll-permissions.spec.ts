import {
  ALL_PERMISSIONS,
  DEFAULT_ROLE_PERMISSIONS,
  PERMISSION_CATALOG,
  SYSTEM_SECURITY_LEVELS,
  expandPermissions,
  getPermissionPrerequisites,
  type Permission,
} from '@sheer/domain';

/**
 * Migration 0074 seeded seven `payroll.*` keys into core.security_levels and its
 * header required a matching @sheer/domain change to ship WITH it. That follow-up
 * did not ship, so until now every consumer silently discarded the seeded keys.
 *
 * These tests pin the invariants that follow-up depends on. They are deliberately
 * written against the *predicate* each consumer uses rather than by mocking the
 * consumers, because all four use the same one — membership of ALL_PERMISSIONS:
 *
 *   1. auth.service.ts fetchSecurityLevelPermissions - `new Set(ALL_PERMISSIONS)`,
 *      filters on READ, so an unknown key never reaches a session.
 *   2. owner-security-levels.service.ts sanitisePermissions - filters on SAVE,
 *      which is what made this destructive: the first owner to save any security
 *      level would have permanently deleted the 0074 seed.
 *   3. owner-security-levels.service.ts toSecurityLevel - filters on READ and
 *      re-orders through ALL_PERMISSIONS.
 *   4. owner-security-levels/dto.ts - `PERMISSION_KEYS = [...ALL_PERMISSIONS]`
 *      rejects unknown keys at validation.
 */

const MANAGEMENT_KEYS: Permission[] = [
  'payroll.view',
  'payroll.edit',
  'payroll.approve',
  'payroll.lock',
  'payroll.export',
  'payroll.email',
];

const ALL_PAYROLL_KEYS: Permission[] = [...MANAGEMENT_KEYS, 'payroll.self.view'];

/** The exact predicate used by all four strip sites. */
const isRecognised = (p: Permission) => new Set<string>(ALL_PERMISSIONS).has(p);

describe('payroll permission catalogue', () => {
  it('registers all seven keys seeded by migration 0074', () => {
    for (const key of ALL_PAYROLL_KEYS) {
      expect(ALL_PERMISSIONS).toContain(key);
    }
  });

  it('survives the ALL_PERMISSIONS filter that strips unknown keys on read and on save', () => {
    // Regression for the 0074 follow-up: before the catalogue entries existed,
    // every one of these was dropped by auth.service and DELETED by the first
    // security-level save.
    for (const key of ALL_PAYROLL_KEYS) {
      expect(isRecognised(key)).toBe(true);
    }
  });

  it('round-trips a seeded manager level through sanitisation without losing payroll.view', () => {
    // sanitisePermissions() is filter-then-expandPermissions. Reproduced here
    // because the method is private on the service.
    const seeded: Permission[] = ['staff.view', 'payroll.view'];
    const sanitised = expandPermissions(seeded.filter(isRecognised));
    expect(sanitised).toContain('payroll.view');
  });

  it('gives every payroll key a catalogue definition with a label and description', () => {
    for (const key of ALL_PAYROLL_KEYS) {
      const def = PERMISSION_CATALOG.find((d) => d.key === key);
      expect(def).toBeDefined();
      expect(def?.label?.length).toBeGreaterThan(0);
      expect(def?.description?.length).toBeGreaterThan(0);
      expect(def?.group).toBe('Payroll');
    }
  });
});

describe('payroll permission dependency edges', () => {
  it.each(MANAGEMENT_KEYS.filter((k) => k !== 'payroll.view'))(
    '%s requires payroll.view',
    (key) => {
      expect(getPermissionPrerequisites(key)).toContain('payroll.view');
      expect(expandPermissions([key])).toContain('payroll.view');
    },
  );

  it('payroll.view itself has no prerequisites', () => {
    expect(getPermissionPrerequisites('payroll.view')).toEqual([]);
  });

  it('payroll.self.view has NO prerequisites, so it can never widen to business-wide pay', () => {
    // The load-bearing assertion of the whole payroll permission model. Adding
    // `requires: ['payroll.view']` here would make expandPermissions() close every
    // stylist's self-view over business-wide payroll visibility - the exact wage
    // leak migration 0074 was written to prevent.
    expect(getPermissionPrerequisites('payroll.self.view')).toEqual([]);
    expect(expandPermissions(['payroll.self.view'])).not.toContain('payroll.view');
  });

  it('holding only self-view never expands to any management key', () => {
    const expanded = expandPermissions(['payroll.self.view']);
    for (const key of MANAGEMENT_KEYS) {
      expect(expanded).not.toContain(key);
    }
  });
});

describe('payroll role defaults', () => {
  it('owners hold every payroll key through the all-permissions pattern', () => {
    for (const key of ALL_PAYROLL_KEYS) {
      expect(DEFAULT_ROLE_PERMISSIONS.owner).toContain(key);
    }
  });

  it('does NOT put any payroll management key in the manager role default', () => {
    // Guards the capitalised prohibition in migration 0074: 'receptionist' is not a
    // role, and the receptionist system level has base_role 'manager', so a manager
    // role default would expose wage data to every unassigned front-desk user.
    for (const key of MANAGEMENT_KEYS) {
      expect(DEFAULT_ROLE_PERMISSIONS.manager).not.toContain(key);
    }
  });

  it('grants stylists self-view only, never business-wide payroll', () => {
    expect(DEFAULT_ROLE_PERMISSIONS.stylist).toContain('payroll.self.view');
    for (const key of MANAGEMENT_KEYS) {
      expect(DEFAULT_ROLE_PERMISSIONS.stylist).not.toContain(key);
    }
  });

  it('grants clients no payroll access at all', () => {
    for (const key of ALL_PAYROLL_KEYS) {
      expect(DEFAULT_ROLE_PERMISSIONS.client).not.toContain(key);
    }
  });
});

describe('payroll system security levels', () => {
  const levelFor = (key: string) => SYSTEM_SECURITY_LEVELS.find((l) => l.key === key);

  it('owner and group_admin receive all seven keys via ALL_PERMISSIONS', () => {
    for (const levelKey of ['owner', 'group_admin']) {
      const level = levelFor(levelKey);
      expect(level).toBeDefined();
      for (const key of ALL_PAYROLL_KEYS) {
        expect(level?.permissions).toContain(key);
      }
    }
  });

  it('manager receives payroll.view and nothing else, matching the 0074 seed', () => {
    const manager = levelFor('manager');
    expect(manager?.permissions).toContain('payroll.view');
    for (const key of MANAGEMENT_KEYS.filter((k) => k !== 'payroll.view')) {
      expect(manager?.permissions).not.toContain(key);
    }
    expect(manager?.permissions).not.toContain('payroll.self.view');
  });

  it('receptionist receives no payroll access, deliberately', () => {
    const receptionist = levelFor('receptionist');
    expect(receptionist).toBeDefined();
    for (const key of ALL_PAYROLL_KEYS) {
      expect(receptionist?.permissions).not.toContain(key);
    }
  });

  it('stylist receives self-view only', () => {
    const stylist = levelFor('stylist');
    expect(stylist?.permissions).toContain('payroll.self.view');
    for (const key of MANAGEMENT_KEYS) {
      expect(stylist?.permissions).not.toContain(key);
    }
  });

  it('keeps the receptionist level free of payroll even though its base role is manager', () => {
    // The receptionist level is an explicit list rather than a spread of the
    // manager role default, which is what keeps it clean. If it ever becomes a
    // spread, this test is the tripwire.
    const receptionist = levelFor('receptionist');
    expect(receptionist?.baseRole).toBe('manager');
    expect(receptionist?.permissions.some((p) => p.startsWith('payroll.'))).toBe(false);
  });
});
