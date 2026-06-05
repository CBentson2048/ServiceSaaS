import { createHmac } from 'node:crypto';
import { verifySvixSignature } from './resend-signature';

const SECRET_RAW = Buffer.from('a-very-secret-signing-key-1234567890');
const SECRET = `whsec_${SECRET_RAW.toString('base64')}`;
const ID = 'msg_2abcdef';
const BODY = JSON.stringify({ type: 'email.delivered', data: { email_id: 'resend-1' } });

function sign(id: string, ts: number, body: string, secretRaw: Buffer = SECRET_RAW): string {
  const signed = `${id}.${ts}.${body}`;
  const sig = createHmac('sha256', secretRaw).update(signed, 'utf8').digest('base64');
  return `v1,${sig}`;
}

describe('verifySvixSignature', () => {
  const ts = 1_700_000_000;
  const now = ts * 1000;

  it('accepts a correctly-signed payload within the tolerance window', () => {
    const headers = { id: ID, timestamp: String(ts), signature: sign(ID, ts, BODY) };
    expect(verifySvixSignature(SECRET, headers, BODY, now)).toBe(true);
  });

  it('accepts when one of several space-separated signatures matches', () => {
    const headers = { id: ID, timestamp: String(ts), signature: `v1,bogus ${sign(ID, ts, BODY)}` };
    expect(verifySvixSignature(SECRET, headers, BODY, now)).toBe(true);
  });

  it('rejects a tampered body', () => {
    const headers = { id: ID, timestamp: String(ts), signature: sign(ID, ts, BODY) };
    expect(verifySvixSignature(SECRET, headers, `${BODY} `, now)).toBe(false);
  });

  it('rejects a signature made with a different secret', () => {
    const headers = { id: ID, timestamp: String(ts), signature: sign(ID, ts, BODY, Buffer.from('wrong-key')) };
    expect(verifySvixSignature(SECRET, headers, BODY, now)).toBe(false);
  });

  it('rejects a stale timestamp (replay protection)', () => {
    const headers = { id: ID, timestamp: String(ts), signature: sign(ID, ts, BODY) };
    expect(verifySvixSignature(SECRET, headers, BODY, now + 10 * 60 * 1000)).toBe(false);
  });

  it('rejects when the secret or any header is missing', () => {
    const headers = { id: ID, timestamp: String(ts), signature: sign(ID, ts, BODY) };
    expect(verifySvixSignature(undefined, headers, BODY, now)).toBe(false);
    expect(verifySvixSignature(SECRET, { ...headers, signature: undefined }, BODY, now)).toBe(false);
    expect(verifySvixSignature(SECRET, { ...headers, id: undefined }, BODY, now)).toBe(false);
    expect(verifySvixSignature(SECRET, { ...headers, timestamp: undefined }, BODY, now)).toBe(false);
  });
});
