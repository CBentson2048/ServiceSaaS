import type { LocationCommunicationSettings } from '@sheer/domain';
import { resolveChannelPlan, smsAllowedByPlan, type ContactEligibility } from './channel-policy';

type Settings = Pick<LocationCommunicationSettings, 'enabled' | 'enabledChannels' | 'smsFallbackEnabled'>;

const base: Settings = { enabled: true, enabledChannels: ['whatsapp'], smsFallbackEnabled: false };
const reachable: ContactEligibility = { phoneValid: true, emailValid: true };
const phoneOnly: ContactEligibility = { phoneValid: true, emailValid: false };
const emailOnly: ContactEligibility = { phoneValid: false, emailValid: true };

describe('resolveChannelPlan (preference-driven channel selection)', () => {
  it('uses WhatsApp as primary with no fallback when SMS is disabled', () => {
    expect(resolveChannelPlan(base, 'whatsapp', reachable)).toEqual({ deliverable: true, primary: 'whatsapp' });
  });

  it('adds SMS as the fallback when SMS fallback is enabled', () => {
    const plan = resolveChannelPlan({ ...base, smsFallbackEnabled: true }, 'whatsapp', reachable);
    expect(plan).toEqual({ deliverable: true, primary: 'whatsapp', fallback: 'sms' });
    expect(smsAllowedByPlan(plan)).toBe(true);
  });

  it('treats no explicit preference as WhatsApp-first', () => {
    expect(resolveChannelPlan({ ...base, smsFallbackEnabled: true }, null, reachable)).toEqual({
      deliverable: true,
      primary: 'whatsapp',
      fallback: 'sms',
    });
  });

  it('makes SMS the primary channel when the client prefers SMS (and SMS enabled)', () => {
    expect(resolveChannelPlan({ ...base, smsFallbackEnabled: true }, 'sms', phoneOnly)).toEqual({
      deliverable: true,
      primary: 'sms',
    });
  });

  it('does not deliver to an SMS-preferring client when SMS is disabled', () => {
    expect(resolveChannelPlan(base, 'sms', phoneOnly).deliverable).toBe(false);
  });

  it('delivers by EMAIL when the client prefers email and has a valid address (no phone needed)', () => {
    expect(resolveChannelPlan(base, 'email', emailOnly)).toEqual({ deliverable: true, primary: 'email' });
  });

  it('skips an email-preferring client with no valid email address', () => {
    const plan = resolveChannelPlan(base, 'email', { phoneValid: true, emailValid: false });
    expect(plan).toEqual({ deliverable: false, skipReason: expect.stringContaining('email') });
    expect(smsAllowedByPlan(plan)).toBe(false);
  });

  it('does not deliver when notifications are disabled', () => {
    expect(resolveChannelPlan({ ...base, enabled: false }, 'whatsapp', reachable).deliverable).toBe(false);
    expect(resolveChannelPlan({ ...base, enabled: false }, 'email', emailOnly).deliverable).toBe(false);
  });

  it('does not deliver a WhatsApp/SMS notification without a valid phone', () => {
    expect(resolveChannelPlan(base, 'whatsapp', emailOnly).deliverable).toBe(false);
  });

  it('falls through to SMS as primary when WhatsApp is not an enabled channel', () => {
    expect(
      resolveChannelPlan({ enabled: true, enabledChannels: [], smsFallbackEnabled: true }, 'whatsapp', phoneOnly),
    ).toEqual({ deliverable: true, primary: 'sms' });
  });
});
