import { isFailureStatus, mapTwilioStatus, shouldApplyStatus } from './twilio-status';

describe('mapTwilioStatus', () => {
  it('maps Twilio message statuses to our delivery enum', () => {
    expect(mapTwilioStatus('accepted')).toBe('queued');
    expect(mapTwilioStatus('queued')).toBe('queued');
    expect(mapTwilioStatus('sending')).toBe('sent');
    expect(mapTwilioStatus('sent')).toBe('sent');
    expect(mapTwilioStatus('delivered')).toBe('delivered');
    expect(mapTwilioStatus('read')).toBe('read');
    expect(mapTwilioStatus('undelivered')).toBe('undelivered');
    expect(mapTwilioStatus('failed')).toBe('failed');
  });

  it('is case-insensitive and ignores untracked/inbound statuses', () => {
    expect(mapTwilioStatus('DELIVERED')).toBe('delivered');
    expect(mapTwilioStatus('received')).toBeNull();
    expect(mapTwilioStatus(undefined)).toBeNull();
  });
});

describe('shouldApplyStatus (out-of-order / replay safety)', () => {
  it('moves the status forward', () => {
    expect(shouldApplyStatus('queued', 'sent')).toBe(true);
    expect(shouldApplyStatus('sent', 'delivered')).toBe(true);
    expect(shouldApplyStatus('delivered', 'read')).toBe(true);
    expect(shouldApplyStatus(null, 'sent')).toBe(true);
  });

  it('never downgrades a more-advanced status', () => {
    expect(shouldApplyStatus('delivered', 'sent')).toBe(false);
    expect(shouldApplyStatus('read', 'delivered')).toBe(false);
    expect(shouldApplyStatus('delivered', 'delivered')).toBe(false);
  });

  it('always applies a failure status (terminal truth)', () => {
    expect(shouldApplyStatus('sent', 'failed')).toBe(true);
    expect(shouldApplyStatus('delivered', 'undelivered')).toBe(true);
    expect(isFailureStatus('failed')).toBe(true);
    expect(isFailureStatus('delivered')).toBe(false);
  });
});
