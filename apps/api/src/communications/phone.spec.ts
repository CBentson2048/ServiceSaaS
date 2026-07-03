import { isValidEmail, normalizeE164, toWhatsAppAddress } from './phone';

// Note: `07700 900xxx` / `+4479...900...` are Ofcom's *reserved fictitious* ranges, which
// libphonenumber correctly rejects as not-real — so these tests use genuine-format numbers.
describe('normalizeE164', () => {
  it('keeps a valid international number', () => {
    expect(normalizeE164('+447725485160')).toBe('+447725485160');
  });

  it('adds a leading + to a bare international number', () => {
    expect(normalizeE164('447725485160')).toBe('+447725485160');
  });

  it('strips spaces, parentheses, hyphens and dots', () => {
    expect(normalizeE164('+1 (415) 523-8886')).toBe('+14155238886');
  });

  it('strips a whatsapp: prefix', () => {
    expect(normalizeE164('whatsapp:+447725485160')).toBe('+447725485160');
  });

  it('converts an international-access (00) prefix to +', () => {
    expect(normalizeE164('0044 7725 485160')).toBe('+447725485160');
  });

  it('promotes a UK national-format number (leading 0) using the default region', () => {
    // Platform default region is GB, so "07…" resolves without any env configuration.
    expect(normalizeE164('07725485160')).toBe('+447725485160');
    expect(normalizeE164('07725 485 160')).toBe('+447725485160');
  });

  it('honours an explicit default region for national-format numbers', () => {
    expect(normalizeE164('07725485160', 'GB')).toBe('+447725485160');
  });

  it('still honours DEFAULT_PHONE_COUNTRY_CALLING_CODE from env (mapped to a region)', () => {
    const prev = process.env.DEFAULT_PHONE_COUNTRY_CALLING_CODE;
    const prevIso = process.env.DEFAULT_PHONE_COUNTRY;
    delete process.env.DEFAULT_PHONE_COUNTRY;
    process.env.DEFAULT_PHONE_COUNTRY_CALLING_CODE = '44';
    try {
      expect(normalizeE164('07725485160')).toBe('+447725485160');
    } finally {
      if (prev === undefined) delete process.env.DEFAULT_PHONE_COUNTRY_CALLING_CODE;
      else process.env.DEFAULT_PHONE_COUNTRY_CALLING_CODE = prev;
      if (prevIso !== undefined) process.env.DEFAULT_PHONE_COUNTRY = prevIso;
    }
  });

  it('rejects a right-length-but-not-real number (e.g. the 99999999999 placeholder)', () => {
    // This is the number that was reaching Twilio and failing; libphonenumber rejects it up front.
    expect(normalizeE164('99999999999')).toBeUndefined();
    expect(normalizeE164('+99999999999')).toBeUndefined();
  });

  it('rejects a leading-zero-after-plus number', () => {
    expect(normalizeE164('+07700900123')).toBeUndefined();
  });

  it('rejects junk, too-short, and empty input', () => {
    expect(normalizeE164('not a phone')).toBeUndefined();
    expect(normalizeE164('+12')).toBeUndefined();
    expect(normalizeE164('073')).toBeUndefined();
    expect(normalizeE164('')).toBeUndefined();
    expect(normalizeE164(null)).toBeUndefined();
    expect(normalizeE164(undefined)).toBeUndefined();
  });
});

describe('toWhatsAppAddress', () => {
  it('wraps a valid number in the whatsapp: scheme', () => {
    expect(toWhatsAppAddress('+447725485160')).toBe('whatsapp:+447725485160');
  });

  it('promotes and wraps a national-format number', () => {
    expect(toWhatsAppAddress('07725485160')).toBe('whatsapp:+447725485160');
  });

  it('returns undefined for an unusable number', () => {
    expect(toWhatsAppAddress('99999999999')).toBeUndefined();
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
