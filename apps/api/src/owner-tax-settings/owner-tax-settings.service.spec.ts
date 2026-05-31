import { ForbiddenException } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { validate } from 'class-validator';
import type { AuthUser } from '@sheer/domain';
import { UpdateTaxSettingsDto } from './dto';
import { OwnerTaxSettingsService } from './owner-tax-settings.service';

function makeService(): OwnerTaxSettingsService {
  const config = {
    getOrThrow: (key: string) =>
      key === 'SUPABASE_URL' ? 'http://localhost:54321' : 'service-role-key',
  } as unknown as ConfigService;
  return new OwnerTaxSettingsService(config);
}

function actor(overrides: Partial<AuthUser> = {}): AuthUser {
  return {
    id: 'user-1',
    role: 'owner',
    businessId: 'biz-1',
    allowedLocationIds: ['loc-1'],
    locationScope: { kind: 'all', locationIds: ['loc-1'] },
    locations: [],
    profile: { id: 'p1', email: 'a@b.c', fullName: 'A B' },
    ...overrides,
  } as AuthUser;
}

describe('OwnerTaxSettingsService — permission enforcement', () => {
  it('rejects a stylist outright', async () => {
    const service = makeService();
    await expect(
      service.getTaxSettings(actor({ role: 'stylist' }), 'loc-1'),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('rejects a manager for a location they do not manage', async () => {
    const service = makeService();
    await expect(
      service.getTaxSettings(actor({ role: 'manager', allowedLocationIds: ['loc-2'] }), 'loc-1'),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('rejects a client', async () => {
    const service = makeService();
    await expect(
      service.updateTaxSettings(actor({ role: 'client' }), { locationId: 'loc-1', taxEnabled: false }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });
});

describe('UpdateTaxSettingsDto — validation', () => {
  async function validateDto(payload: Partial<UpdateTaxSettingsDto>): Promise<string[]> {
    const dto = Object.assign(new UpdateTaxSettingsDto(), payload);
    const errors = await validate(dto);
    return errors.map((e) => e.property);
  }

  it('accepts a well-formed payload', async () => {
    expect(
      await validateDto({
        locationId: '123e4567-e89b-12d3-a456-426614174000',
        taxEnabled: true,
        taxLabel: 'VAT',
        taxRatePercent: 20,
        appliesTo: 'both',
        displayMode: 'ex_tax',
      }),
    ).toEqual([]);
  });

  it('rejects a negative tax rate', async () => {
    expect(
      await validateDto({
        locationId: '123e4567-e89b-12d3-a456-426614174000',
        taxRatePercent: -1,
      }),
    ).toContain('taxRatePercent');
  });

  it('rejects an invalid appliesTo enum', async () => {
    expect(
      await validateDto({
        locationId: '123e4567-e89b-12d3-a456-426614174000',
        // @ts-expect-error intentional invalid enum
        appliesTo: 'everything',
      }),
    ).toContain('appliesTo');
  });

  it('rejects an invalid displayMode enum', async () => {
    expect(
      await validateDto({
        locationId: '123e4567-e89b-12d3-a456-426614174000',
        // @ts-expect-error intentional invalid enum
        displayMode: 'sometimes',
      }),
    ).toContain('displayMode');
  });

  it('rejects a non-UUID locationId', async () => {
    expect(await validateDto({ locationId: 'not-a-uuid' })).toContain('locationId');
  });
});
