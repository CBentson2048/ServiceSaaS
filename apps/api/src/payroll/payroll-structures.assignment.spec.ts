/**
 * Assignment lifecycle invariants.
 *
 * Switching plans is append-only: the open row closes at the new start and a
 * new row opens (never edited in place). Correcting a START DATE is the one
 * sanctioned in-place edit: the open row's start moves and the welded
 * predecessor's end moves with it — earlier moves shrink the predecessor
 * first, later moves extend it after, so the chain never gaps or overlaps.
 * Periods that priced the old date are flagged stale; locked/paid periods are
 * counted for messaging but never touched.
 */

import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import type { AuthUser } from '@sheer/domain';
import { createSupabaseFake, createSupabaseFakeState } from '../common/testing/supabase-fake';
import { PayrollStructuresService } from './payroll-structures.service';

jest.mock('@supabase/supabase-js', () => ({
  createClient: jest.fn(() => (globalThis as { __supabaseFake?: unknown }).__supabaseFake),
}));

const BUSINESS_ID = 'b1000000-0000-0000-0000-000000000001';
const STAFF_ID = 's1000000-0000-0000-0000-000000000001';
const STRUCTURE_A = 'a0000000-0000-0000-0000-00000000000a';
const STRUCTURE_B = 'b0000000-0000-0000-0000-00000000000b';
const OPEN_ID = 'e2000000-0000-0000-0000-000000000002';
const PREDECESSOR_ID = 'e1000000-0000-0000-0000-000000000001';

function owner(): AuthUser {
  return {
    id: 'u1',
    roles: ['owner'],
    primaryRole: 'owner',
    businessId: BUSINESS_ID,
    allowedLocationIds: [],
    permissions: ['payroll.view', 'payroll.edit'],
  } as unknown as AuthUser;
}

function manager(allowedLocationIds: string[]): AuthUser {
  return {
    id: 'u2',
    roles: ['manager'],
    primaryRole: 'manager',
    businessId: BUSINESS_ID,
    allowedLocationIds,
    permissions: ['payroll.view', 'payroll.edit'],
  } as unknown as AuthUser;
}

function structureRows() {
  return [
    {
      id: STRUCTURE_A,
      business_id: BUSINESS_ID,
      name: 'Tiered commission',
      description: null,
      is_system: false,
      is_active: true,
    },
    {
      id: STRUCTURE_B,
      business_id: BUSINESS_ID,
      name: 'Flat commission',
      description: null,
      is_system: false,
      is_active: true,
    },
  ];
}

function assignmentRow(overrides: Record<string, unknown>) {
  return {
    business_id: BUSINESS_ID,
    staff_profile_id: STAFF_ID,
    structure_id: STRUCTURE_A,
    effective_to: null,
    ...overrides,
  };
}

function buildService(state = createSupabaseFakeState()) {
  (globalThis as { __supabaseFake?: unknown }).__supabaseFake = createSupabaseFake(state);
  const config = { getOrThrow: (key: string) => `fake-${key}` } as never;
  const inputs = {
    loadStaff: jest
      .fn()
      .mockResolvedValue([
        { staffProfileId: STAFF_ID, staffName: 'Jonrel B', primaryLocationId: 'loc-1' },
      ]),
  } as never;
  const audit = { record: jest.fn().mockResolvedValue(undefined) };
  return {
    service: new PayrollStructuresService(config, inputs, audit as never),
    audit,
    state,
  };
}

function rows(state: ReturnType<typeof createSupabaseFakeState>, table: string) {
  return state.tables.get(table) ?? [];
}

describe('assign — plan switches stay append-only', () => {
  it('refuses re-assigning the structure the staff member is already on', async () => {
    const { service } = buildService(
      createSupabaseFakeState({
        'payroll.pay_structures': structureRows(),
        'payroll.staff_pay_assignments': [
          assignmentRow({ id: OPEN_ID, effective_from: '2026-08-01' }),
        ],
      }),
    );
    await expect(
      service.assign(owner(), STAFF_ID, { structureId: STRUCTURE_A, effectiveFrom: '2026-09-01' }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('refuses a switch that does not start strictly after the current start', async () => {
    const { service } = buildService(
      createSupabaseFakeState({
        'payroll.pay_structures': structureRows(),
        'payroll.staff_pay_assignments': [
          assignmentRow({ id: OPEN_ID, effective_from: '2026-08-01' }),
        ],
      }),
    );
    await expect(
      service.assign(owner(), STAFF_ID, { structureId: STRUCTURE_B, effectiveFrom: '2026-08-01' }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('closes the open row at the new start and opens the new plan there', async () => {
    const { service, audit, state } = buildService(
      createSupabaseFakeState({
        'payroll.pay_structures': structureRows(),
        'payroll.staff_pay_assignments': [
          assignmentRow({ id: OPEN_ID, effective_from: '2026-08-01' }),
        ],
      }),
    );
    const response = await service.assign(owner(), STAFF_ID, {
      structureId: STRUCTURE_B,
      effectiveFrom: '2026-09-01',
    });

    const stored = rows(state, 'payroll.staff_pay_assignments');
    expect(stored).toHaveLength(2);
    expect(stored[0]).toMatchObject({ id: OPEN_ID, effective_to: '2026-09-01' });
    expect(stored[1]).toMatchObject({
      structure_id: STRUCTURE_B,
      effective_from: '2026-09-01',
    });
    // The insert omits effective_to (DB default null) — open either way.
    expect(stored[1]['effective_to'] ?? null).toBeNull();
    expect(response.closedAssignment).toMatchObject({
      id: OPEN_ID,
      effectiveTo: '2026-09-01',
    });
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'u1' }),
      expect.objectContaining({ action: 'pay_structure.assigned' }),
    );
  });
});

describe('amendAssignmentStart — start-date correction', () => {
  it('404s when there is no open assignment to amend', async () => {
    const { service } = buildService(
      createSupabaseFakeState({ 'payroll.pay_structures': structureRows() }),
    );
    await expect(
      service.amendAssignmentStart(owner(), STAFF_ID, { effectiveFrom: '2026-08-05' }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('rejects amending to the date the plan already starts on', async () => {
    const { service } = buildService(
      createSupabaseFakeState({
        'payroll.pay_structures': structureRows(),
        'payroll.staff_pay_assignments': [
          assignmentRow({ id: OPEN_ID, effective_from: '2026-08-01' }),
        ],
      }),
    );
    await expect(
      service.amendAssignmentStart(owner(), STAFF_ID, { effectiveFrom: '2026-08-01' }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('moves the start LATER and extends the welded predecessor to keep the chain gapless', async () => {
    const { service, audit, state } = buildService(
      createSupabaseFakeState({
        'payroll.pay_structures': structureRows(),
        'payroll.staff_pay_assignments': [
          assignmentRow({
            id: PREDECESSOR_ID,
            structure_id: STRUCTURE_B,
            effective_from: '2026-06-01',
            effective_to: '2026-08-01',
          }),
          assignmentRow({ id: OPEN_ID, effective_from: '2026-08-01' }),
        ],
      }),
    );
    const response = await service.amendAssignmentStart(owner(), STAFF_ID, {
      effectiveFrom: '2026-08-05',
    });

    const stored = rows(state, 'payroll.staff_pay_assignments');
    expect(stored[0]).toMatchObject({ id: PREDECESSOR_ID, effective_to: '2026-08-05' });
    expect(stored[1]).toMatchObject({ id: OPEN_ID, effective_from: '2026-08-05' });
    expect(response).toMatchObject({
      previousEffectiveFrom: '2026-08-01',
      staleFlaggedCount: 0,
      lockedPeriodCount: 0,
    });
    expect(response.assignment).toMatchObject({
      id: OPEN_ID,
      structureName: 'Tiered commission',
      effectiveFrom: '2026-08-05',
      effectiveTo: null,
    });
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'u1' }),
      expect.objectContaining({
        action: 'pay_structure.assignment_date_changed',
        before: { staffProfileId: STAFF_ID, effectiveFrom: '2026-08-01' },
        after: { staffProfileId: STAFF_ID, effectiveFrom: '2026-08-05' },
      }),
    );
  });

  it('moves the start EARLIER and shrinks the welded predecessor with it', async () => {
    const { service, state } = buildService(
      createSupabaseFakeState({
        'payroll.pay_structures': structureRows(),
        'payroll.staff_pay_assignments': [
          assignmentRow({
            id: PREDECESSOR_ID,
            structure_id: STRUCTURE_B,
            effective_from: '2026-06-01',
            effective_to: '2026-08-01',
          }),
          assignmentRow({ id: OPEN_ID, effective_from: '2026-08-01' }),
        ],
      }),
    );
    await service.amendAssignmentStart(owner(), STAFF_ID, { effectiveFrom: '2026-07-15' });

    const stored = rows(state, 'payroll.staff_pay_assignments');
    expect(stored[0]).toMatchObject({ id: PREDECESSOR_ID, effective_to: '2026-07-15' });
    expect(stored[1]).toMatchObject({ id: OPEN_ID, effective_from: '2026-07-15' });
  });

  it('refuses a date at or before the predecessor started (it would erase that plan)', async () => {
    const { service, state } = buildService(
      createSupabaseFakeState({
        'payroll.pay_structures': structureRows(),
        'payroll.staff_pay_assignments': [
          assignmentRow({
            id: PREDECESSOR_ID,
            structure_id: STRUCTURE_B,
            effective_from: '2026-06-01',
            effective_to: '2026-08-01',
          }),
          assignmentRow({ id: OPEN_ID, effective_from: '2026-08-01' }),
        ],
      }),
    );
    await expect(
      service.amendAssignmentStart(owner(), STAFF_ID, { effectiveFrom: '2026-06-01' }),
    ).rejects.toBeInstanceOf(BadRequestException);
    // Nothing moved.
    const stored = rows(state, 'payroll.staff_pay_assignments');
    expect(stored[0]).toMatchObject({ effective_to: '2026-08-01' });
    expect(stored[1]).toMatchObject({ effective_from: '2026-08-01' });
  });

  it('moves a first assignment (no predecessor) as a single-row edit', async () => {
    const { service, state } = buildService(
      createSupabaseFakeState({
        'payroll.pay_structures': structureRows(),
        'payroll.staff_pay_assignments': [
          assignmentRow({ id: OPEN_ID, effective_from: '2026-08-01' }),
        ],
      }),
    );
    const response = await service.amendAssignmentStart(owner(), STAFF_ID, {
      effectiveFrom: '2026-07-01',
    });
    expect(rows(state, 'payroll.staff_pay_assignments')).toHaveLength(1);
    expect(rows(state, 'payroll.staff_pay_assignments')[0]).toMatchObject({
      effective_from: '2026-07-01',
      effective_to: null,
    });
    expect(response.previousEffectiveFrom).toBe('2026-08-01');
  });

  it('flags summaries in re-openable periods inside the moved window stale; locked periods are only counted', async () => {
    const DRAFT_PERIOD = 'd0000000-0000-0000-0000-000000000001';
    const LOCKED_PERIOD = 'd0000000-0000-0000-0000-000000000002';
    const OUTSIDE_PERIOD = 'd0000000-0000-0000-0000-000000000003';
    const { service, state } = buildService(
      createSupabaseFakeState({
        'payroll.pay_structures': structureRows(),
        'payroll.staff_pay_assignments': [
          assignmentRow({ id: OPEN_ID, effective_from: '2026-08-01' }),
        ],
        'payroll.pay_periods': [
          { id: DRAFT_PERIOD, business_id: BUSINESS_ID, status: 'draft', period_start: '2026-08-03' },
          { id: LOCKED_PERIOD, business_id: BUSINESS_ID, status: 'locked', period_start: '2026-08-06' },
          { id: OUTSIDE_PERIOD, business_id: BUSINESS_ID, status: 'draft', period_start: '2026-07-20' },
        ],
        'payroll.pay_summaries': [
          {
            id: 'f0000000-0000-0000-0000-000000000001',
            business_id: BUSINESS_ID,
            pay_period_id: DRAFT_PERIOD,
            staff_profile_id: STAFF_ID,
            superseded_by_id: null,
            is_stale: false,
            stale_reason: null,
          },
          {
            id: 'f0000000-0000-0000-0000-000000000002',
            business_id: BUSINESS_ID,
            pay_period_id: LOCKED_PERIOD,
            staff_profile_id: STAFF_ID,
            superseded_by_id: null,
            is_stale: false,
            stale_reason: null,
          },
          {
            id: 'f0000000-0000-0000-0000-000000000003',
            business_id: BUSINESS_ID,
            pay_period_id: OUTSIDE_PERIOD,
            staff_profile_id: STAFF_ID,
            superseded_by_id: null,
            is_stale: false,
            stale_reason: null,
          },
        ],
      }),
    );

    const response = await service.amendAssignmentStart(owner(), STAFF_ID, {
      effectiveFrom: '2026-08-10',
    });

    const summaries = rows(state, 'payroll.pay_summaries');
    expect(summaries[0]).toMatchObject({
      is_stale: true,
      stale_reason: 'Pay plan start date changed from 2026-08-01 to 2026-08-10 after pay was calculated',
    });
    expect(summaries[1]).toMatchObject({ is_stale: false, stale_reason: null });
    expect(summaries[2]).toMatchObject({ is_stale: false, stale_reason: null });
    expect(response.staleFlaggedCount).toBe(1);
    expect(response.lockedPeriodCount).toBe(1);
  });

  it('404s for a manager whose locations do not cover the staff member', async () => {
    const { service } = buildService(
      createSupabaseFakeState({
        'payroll.pay_structures': structureRows(),
        'payroll.staff_pay_assignments': [
          assignmentRow({ id: OPEN_ID, effective_from: '2026-08-01' }),
        ],
      }),
    );
    await expect(
      service.amendAssignmentStart(manager(['loc-2']), STAFF_ID, { effectiveFrom: '2026-08-05' }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('getCurrentAssignment — in-force vs open', () => {
  it('reports a future-dated open assignment separately from the plan in force today', async () => {
    const today = new Date().toISOString().slice(0, 10);
    const addDays = (iso: string, days: number) => {
      const date = new Date(`${iso}T00:00:00Z`);
      date.setUTCDate(date.getUTCDate() + days);
      return date.toISOString().slice(0, 10);
    };
    const futureStart = addDays(today, 10);
    const { service } = buildService(
      createSupabaseFakeState({
        'payroll.pay_structures': structureRows(),
        'payroll.staff_pay_assignments': [
          assignmentRow({
            id: PREDECESSOR_ID,
            structure_id: STRUCTURE_B,
            effective_from: addDays(today, -30),
            effective_to: futureStart,
          }),
          assignmentRow({ id: OPEN_ID, effective_from: futureStart }),
        ],
      }),
    );

    const response = await service.getCurrentAssignment(owner(), STAFF_ID);
    expect(response.assignment).toMatchObject({ id: PREDECESSOR_ID, structureId: STRUCTURE_B });
    expect(response.openAssignment).toMatchObject({
      id: OPEN_ID,
      structureId: STRUCTURE_A,
      effectiveFrom: futureStart,
    });
  });
});
