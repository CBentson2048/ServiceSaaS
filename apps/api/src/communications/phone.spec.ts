import { isValidEmail, normalizeE164, toWhatsAppAddress } from './phone';

describe('normalizeE164', () => {
  it('keeps a valid international number', () => {
    expect(normalizeE164('+447700900123')).toBe('+447700900123');
  });

  it('adds a leading + to a bare international number', () => {
    expect(normalizeE164('447700900123')).toBe('+447700900123');
  });

  it('strips spaces, parentheses, hyphens and dots', () => {
    expect(normalizeE164('+1 (415) 523-8886')).toBe('+14155238886');
  });

  it('strips a whatsapp: prefix', () => {
    expect(normalizeE164('whatsapp:+447700900123')).toBe('+447700900123');
  });

  it('converts an international-access (00) prefix to +', () => {
    expect(normalizeE164('0044 7700 900123')).toBe('+447700900123');
  });

  it('REJECTS a national-format number when no calling code is known (was previously a bug)', () => {
    // Previously this produced the bogus "+07700900123"; now it is correctly rejected.
    expect(normalizeE164('07700900123')).toBeUndefined();
  });

  it('promotes a national-format number using an explicit calling code', () => {
    expect(normalizeE164('07700900123', '44')).toBe('+447700900123');
  });

  it('promotes a national-format number using DEFAULT_PHONE_COUNTRY_CALLING_CODE from env', () => {
    const prev = process.env.DEFAULT_PHONE_COUNTRY_CALLING_CODE;
    process.env.DEFAULT_PHONE_COUNTRY_CALLING_CODE = '44';
    try {
      expect(normalizeE164('07700900123')).toBe('+447700900123');
    } finally {
      if (prev === undefined) delete process.env.DEFAULT_PHONE_COUNTRY_CALLING_CODE;
      else process.env.DEFAULT_PHONE_COUNTRY_CALLING_CODE = prev;
    }
  });

  it('rejects a leading-zero-after-plus number', () => {
    expect(normalizeE164('+07700900123')).toBeUndefined();
  });

  it('rejects junk, too-short, and empty input', () => {
    expect(normalizeE164('not a phone')).toBeUndefined();
    expect(normalizeE164('+12')).toBeUndefined();
    expect(normalizeE164('')).toBeUndefined();
    expect(normalizeE164(null)).toBeUndefined();
    expect(normalizeE164(undefined)).toBeUndefined();
  });
});

describe('toWhatsAppAddress', () => {
  it('wraps a valid number in the whatsapp: scheme', () => {
    expect(toWhatsAppAddress('+447700900123')).toBe('whatsapp:+447700900123');
  });

  it('returns undefined for an unusable number', () => {
    expect(toWhatsAppAddress('07700900123')).toBeUndefined();
  });
});

describe('isValidEmail', () => {
  it('accepts a plausible address and rejects malformed ones', () => {
    expect(isValidEmail('sam@example.com')).toBe(true);
    expect(isValidEmail('sam@example')).toBe(false);
    expect(isValidEmail('not-an-email')).toBe(false);
    expect(isValidEmail('')).toBe(false);
    expect(isValidEmail(null)).toBe(false);
  });
});
