import type { LocationCommunicationSettings } from '@sheer/domain';
import { resolveChannelPlan, smsAllowedByPlan } from './channel-policy';

type Settings = Pick<LocationCommunicationSettings, 'enabled' | 'enabledChannels' | 'smsFallbackEnabled'>;

const base: Settings = { enabled: true, enabledChannels: ['whatsapp'], smsFallbackEnabled: false };

describe('resolveChannelPlan (WhatsApp-first, SMS fallback)', () => {
  it('uses WhatsApp as primary with no fallback when SMS is disabled', () => {
    expect(resolveChannelPlan(base, 'whatsapp', true)).toEqual({ deliverable: true, primary: 'whatsapp' });
  });

  it('adds SMS as the fallback when SMS fallback is enabled', () => {
    const plan = resolveChannelPlan({ ...base, smsFallbackEnabled: true }, 'whatsapp', true);
    expect(plan).toEqual({ deliverable: true, primary: 'whatsapp', fallback: 'sms' });
    expect(smsAllowedByPlan(plan)).toBe(true);
  });

  it('treats no explicit preference as WhatsApp-first', () => {
    expect(resolveChannelPlan({ ...base, smsFallbackEnabled: true }, null, true)).toEqual({
      deliverable: true,
      primary: 'whatsapp',
      fallback: 'sms',
    });
  });

  it('makes SMS the primary channel when the client prefers SMS (and SMS enabled)', () => {
    expect(resolveChannelPlan({ ...base, smsFallbackEnabled: true }, 'sms', true)).toEqual({
      deliverable: true,
      primary: 'sms',
    });
  });

  it('does not deliver to an SMS-preferring client when SMS is disabled', () => {
    const plan = resolveChannelPlan(base, 'sms', true);
    expect(plan.deliverable).toBe(false);
  });

  it('skips clients who prefer email (not messaging)', () => {
    const plan = resolveChannelPlan({ ...base, smsFallbackEnabled: true }, 'email', true);
    expect(plan).toEqual({ deliverable: false, skipReason: expect.stringContaining('email') });
    expect(smsAllowedByPlan(plan)).toBe(false);
  });

  it('does not deliver when notifications are disabled or the phone is invalid', () => {
    expect(resolveChannelPlan({ ...base, enabled: false }, 'whatsapp', true).deliverable).toBe(false);
    expect(resolveChannelPlan(base, 'whatsapp', false).deliverable).toBe(false);
  });

  it('falls through to SMS as primary when WhatsApp is not an enabled channel', () => {
    expect(resolveChannelPlan({ enabled: true, enabledChannels: [], smsFallbackEnabled: true }, 'whatsapp', true)).toEqual(
      { deliverable: true, primary: 'sms' },
    );
  });
});
