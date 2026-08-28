import { isEmailFailure, mapResendEvent, shouldApplyEmailStatus } from './resend-status';

describe('mapResendEvent', () => {
  it('maps delivered (no escalation)', () => {
    expect(mapResendEvent('email.delivered')).toEqual({ status: 'delivered', escalate: false, optOut: false });
  });

  it('maps a hard bounce to a failure that escalates', () => {
    expect(mapResendEvent('email.bounced')).toEqual({ status: 'failed', escalate: true, optOut: false });
  });

  it('maps a spam complaint to a failure that opts the client out rather than escalating', () => {
    expect(mapResendEvent('email.complained')).toEqual({ status: 'failed', escalate: false, optOut: true });
  });

  it('is case-insensitive on the event type', () => {
    expect(mapResendEvent('EMAIL.DELIVERED')).toEqual({ status: 'delivered', escalate: false, optOut: false });
  });

  it('ignores untracked events', () => {
    expect(mapResendEvent('email.delivery_delayed')).toBeNull();
    expect(mapResendEvent('email.opened')).toBeNull();
    expect(mapResendEvent(undefined)).toBeNull();
  });
});

describe('shouldApplyEmailStatus', () => {
  it('always applies a failure (terminal truth)', () => {
    expect(shouldApplyEmailStatus('delivered', 'failed')).toBe(true);
    expect(isEmailFailure('failed')).toBe(true);
  });

  it('moves forward but never downgrades', () => {
    expect(shouldApplyEmailStatus('sent', 'delivered')).toBe(true);
    expect(shouldApplyEmailStatus(null, 'sent')).toBe(true);
    expect(shouldApplyEmailStatus('delivered', 'sent')).toBe(false);
    expect(shouldApplyEmailStatus('delivered', 'delivered')).toBe(false);
  });
});
