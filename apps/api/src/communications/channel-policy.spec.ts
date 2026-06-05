import type { LocationCommunicationSettings } from '@sheer/domain';
import {
  channelAllowedByPlan,
  channelChain,
  nextChannelAfter,
  resolveChannelPlan,
  type ChannelPlan,
  type ContactEligibility,
} from './channel-policy';

type Settings = Pick<
  LocationCommunicationSettings,
  'enabled' | 'enabledChannels' | 'emailFallbackEnabled' | 'smsFallbackEnabled'
>;

function settings(overrides: Partial<Settings> = {}): Settings {
  return {
    enabled: true,
    enabledChannels: ['whatsapp'],
    emailFallbackEnabled: false,
    smsFallbackEnabled: false,
    ...overrides,
  };
}

const reachable: ContactEligibility = { phoneValid: true, emailValid: true };
const phoneOnly: ContactEligibility = { phoneValid: true, emailValid: false };
const emailOnly: ContactEligibility = { phoneValid: false, emailValid: true };

describe('resolveChannelPlan (WhatsApp → Email → SMS, preference picks the starting point)', () => {
  it('uses WhatsApp as primary with no fallbacks when email + SMS are disabled', () => {
    expect(resolveChannelPlan(settings(), 'whatsapp', reachable)).toEqual({
      deliverable: true,
      primary: 'whatsapp',
      fallbacks: [],
    });
  });

  it('builds the full WhatsApp → Email → SMS chain when both fallbacks are enabled', () => {
    const plan = resolveChannelPlan(
      settings({ emailFallbackEnabled: true, smsFallbackEnabled: true }),
      'whatsapp',
      reachable,
    );
    expect(plan).toEqual({ deliverable: true, primary: 'whatsapp', fallbacks: ['email', 'sms'] });
  });

  it('treats no explicit preference as the full chain (WhatsApp-first)', () => {
    const plan = resolveChannelPlan(
      settings({ emailFallbackEnabled: true, smsFallbackEnabled: true }),
      null,
      reachable,
    );
    expect(plan).toEqual({ deliverable: true, primary: 'whatsapp', fallbacks: ['email', 'sms'] });
  });

  it('skips Email in the chain when only SMS fallback is enabled (WhatsApp → SMS)', () => {
    const plan = resolveChannelPlan(settings({ smsFallbackEnabled: true }), 'whatsapp', reachable);
    expect(plan).toEqual({ deliverable: true, primary: 'whatsapp', fallbacks: ['sms'] });
  });

  it('skips SMS in the chain when only Email fallback is enabled (WhatsApp → Email)', () => {
    const plan = resolveChannelPlan(settings({ emailFallbackEnabled: true }), 'whatsapp', reachable);
    expect(plan).toEqual({ deliverable: true, primary: 'whatsapp', fallbacks: ['email'] });
  });

  it('drops Email from the chain when the client has no valid email', () => {
    const plan = resolveChannelPlan(
      settings({ emailFallbackEnabled: true, smsFallbackEnabled: true }),
      'whatsapp',
      phoneOnly,
    );
    expect(plan).toEqual({ deliverable: true, primary: 'whatsapp', fallbacks: ['sms'] });
  });

  it('email preference starts the chain at Email (Email → SMS), never WhatsApp', () => {
    const plan = resolveChannelPlan(
      settings({ emailFallbackEnabled: true, smsFallbackEnabled: true }),
      'email',
      reachable,
    );
    expect(plan).toEqual({ deliverable: true, primary: 'email', fallbacks: ['sms'] });
  });

  it('email preference delivers email as PRIMARY without the emailFallbackEnabled toggle (explicit choice)', () => {
    // emailFallbackEnabled is OFF here; an explicit email preference still gets email.
    const plan = resolveChannelPlan(settings(), 'email', reachable);
    expect(plan).toEqual({ deliverable: true, primary: 'email', fallbacks: [] });
  });

  it('email preference adds SMS as a fallback when SMS is enabled (still no email toggle needed)', () => {
    const plan = resolveChannelPlan(settings({ smsFallbackEnabled: true }), 'email', reachable);
    expect(plan).toEqual({ deliverable: true, primary: 'email', fallbacks: ['sms'] });
  });

  it('email-preferring client is undeliverable only when they have no valid email', () => {
    const plan = resolveChannelPlan(settings(), 'email', phoneOnly);
    expect(plan.deliverable).toBe(false);
  });

  it('SMS preference is primary SMS (no further fallback) when SMS is enabled', () => {
    expect(resolveChannelPlan(settings({ smsFallbackEnabled: true }), 'sms', phoneOnly)).toEqual({
      deliverable: true,
      primary: 'sms',
      fallbacks: [],
    });
  });

  it('does not deliver to an SMS-preferring client when SMS is disabled', () => {
    expect(resolveChannelPlan(settings(), 'sms', phoneOnly).deliverable).toBe(false);
  });

  it('routes a no-phone WhatsApp-preferring client to Email when email is enabled + valid', () => {
    const plan = resolveChannelPlan(
      settings({ emailFallbackEnabled: true, smsFallbackEnabled: true }),
      'whatsapp',
      emailOnly,
    );
    // No phone → WhatsApp and SMS drop out; Email becomes primary with no fallbacks.
    expect(plan).toEqual({ deliverable: true, primary: 'email', fallbacks: [] });
  });

  it('does not deliver when notifications are disabled', () => {
    expect(resolveChannelPlan(settings({ enabled: false }), 'whatsapp', reachable).deliverable).toBe(false);
    expect(
      resolveChannelPlan(settings({ enabled: false, emailFallbackEnabled: true }), 'email', emailOnly).deliverable,
    ).toBe(false);
  });

  it('does not deliver a WhatsApp-only setup without a valid phone', () => {
    expect(resolveChannelPlan(settings(), 'whatsapp', emailOnly).deliverable).toBe(false);
  });

  it('falls through to SMS as primary when WhatsApp is not an enabled channel', () => {
    expect(
      resolveChannelPlan(
        settings({ enabledChannels: [], smsFallbackEnabled: true }),
        'whatsapp',
        phoneOnly,
      ),
    ).toEqual({ deliverable: true, primary: 'sms', fallbacks: [] });
  });
});

describe('chain helpers', () => {
  const full: ChannelPlan = { deliverable: true, primary: 'whatsapp', fallbacks: ['email', 'sms'] };

  it('channelChain returns primary then fallbacks', () => {
    expect(channelChain(full)).toEqual(['whatsapp', 'email', 'sms']);
    expect(channelChain({ deliverable: false, skipReason: 'x' })).toEqual([]);
  });

  it('channelAllowedByPlan reflects membership in the chain', () => {
    expect(channelAllowedByPlan(full, 'whatsapp')).toBe(true);
    expect(channelAllowedByPlan(full, 'email')).toBe(true);
    expect(channelAllowedByPlan(full, 'sms')).toBe(true);
    expect(channelAllowedByPlan({ deliverable: true, primary: 'whatsapp', fallbacks: [] }, 'sms')).toBe(false);
  });

  it('nextChannelAfter walks WhatsApp → Email → SMS and stops at the end', () => {
    expect(nextChannelAfter(full, 'whatsapp')).toBe('email');
    expect(nextChannelAfter(full, 'email')).toBe('sms');
    expect(nextChannelAfter(full, 'sms')).toBeNull();
    // A channel not in the chain has no successor.
    expect(nextChannelAfter({ deliverable: true, primary: 'whatsapp', fallbacks: [] }, 'email')).toBeNull();
  });

  it('nextChannelAfter skips a disabled middle channel (WhatsApp → SMS)', () => {
    const plan: ChannelPlan = { deliverable: true, primary: 'whatsapp', fallbacks: ['sms'] };
    expect(nextChannelAfter(plan, 'whatsapp')).toBe('sms');
  });
});
