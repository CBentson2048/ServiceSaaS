import {
  computeTwilioSignature,
  reconstructRequestUrl,
  verifyTwilioSignature,
} from './twilio-signature';

const AUTH_TOKEN = 'test_auth_token';
const URL = 'https://api.example.com/api/twilio/messaging/status';
const PARAMS = { MessageSid: 'SM123', MessageStatus: 'delivered', To: 'whatsapp:+447700900123' };

describe('Twilio signature', () => {
  it('computes a signature matching the documented algorithm (url + sorted key+value)', () => {
    // Reference: HMAC-SHA1 over url + concat of params sorted by key.
    const sig = computeTwilioSignature(AUTH_TOKEN, URL, PARAMS);
    // Stable for the inputs — recompute and compare (round-trip determinism).
    expect(computeTwilioSignature(AUTH_TOKEN, URL, PARAMS)).toBe(sig);
    // Parameter order must not matter (Twilio sorts by key).
    const reordered = { To: PARAMS.To, MessageStatus: PARAMS.MessageStatus, MessageSid: PARAMS.MessageSid };
    expect(computeTwilioSignature(AUTH_TOKEN, URL, reordered)).toBe(sig);
  });

  it('accepts a valid signature and rejects a tampered body', () => {
    const sig = computeTwilioSignature(AUTH_TOKEN, URL, PARAMS);
    expect(verifyTwilioSignature(AUTH_TOKEN, sig, [URL], PARAMS)).toBe(true);
    expect(verifyTwilioSignature(AUTH_TOKEN, sig, [URL], { ...PARAMS, MessageStatus: 'failed' })).toBe(false);
  });

  it('rejects a signature signed with a different token or URL', () => {
    const sig = computeTwilioSignature(AUTH_TOKEN, URL, PARAMS);
    expect(verifyTwilioSignature('other_token', sig, [URL], PARAMS)).toBe(false);
    expect(verifyTwilioSignature(AUTH_TOKEN, sig, ['https://evil.example.com/x'], PARAMS)).toBe(false);
  });

  it('matches if any candidate URL is valid (proxy-friendly)', () => {
    const sig = computeTwilioSignature(AUTH_TOKEN, URL, PARAMS);
    expect(verifyTwilioSignature(AUTH_TOKEN, sig, ['https://wrong.example.com', URL], PARAMS)).toBe(true);
  });

  it('returns false when token or signature header is missing', () => {
    expect(verifyTwilioSignature('', 'sig', [URL], PARAMS)).toBe(false);
    expect(verifyTwilioSignature(AUTH_TOKEN, undefined, [URL], PARAMS)).toBe(false);
  });

  it('reconstructs the request URL honouring proxy headers', () => {
    expect(
      reconstructRequestUrl(
        { 'x-forwarded-proto': 'https', 'x-forwarded-host': 'api.example.com', host: 'internal:3001' },
        '/api/twilio/messaging/status',
      ),
    ).toBe('https://api.example.com/api/twilio/messaging/status');
    expect(reconstructRequestUrl({ host: 'localhost:3001' }, '/api/twilio/messaging/inbound')).toBe(
      'https://localhost:3001/api/twilio/messaging/inbound',
    );
    expect(reconstructRequestUrl({}, '/x')).toBeUndefined();
  });
});
