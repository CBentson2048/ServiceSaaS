import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { IsOptional, validateSync } from 'class-validator';
import { IsPhoneField } from './phone-field.decorator';

class Dto {
  @IsOptional()
  @IsPhoneField()
  phone?: string | null;
}

function build(phone: unknown): { phone?: string | null; ok: boolean } {
  const dto = plainToInstance(Dto, { phone });
  const ok = validateSync(dto as object).length === 0;
  return { phone: dto.phone, ok };
}

describe('IsPhoneField', () => {
  it('normalises a national number to E.164 and passes', () => {
    const { phone, ok } = build('07725485160');
    expect(ok).toBe(true);
    expect(phone).toBe('+447725485160');
  });

  it('keeps an already-international number', () => {
    expect(build('+447725485160')).toEqual({ phone: '+447725485160', ok: true });
  });

  it('rejects a right-length-but-fake number (the 99999999999 placeholder)', () => {
    expect(build('99999999999').ok).toBe(false);
  });

  it('rejects junk', () => {
    expect(build('not a phone').ok).toBe(false);
  });

  it('allows empty / null / undefined (optional field)', () => {
    expect(build(undefined).ok).toBe(true);
    expect(build(null).ok).toBe(true);
    expect(build('').ok).toBe(true);
  });
});
