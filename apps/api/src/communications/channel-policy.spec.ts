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

describe('resolveChannelPlan (WhatsApp → SMS → Email, preference picks the starting point)', () => {
  it('uses WhatsApp as primary with no fallbacks when email + SMS are disabled', () => {
    expect(resolveChannelPlan(settings(), 'whatsapp', reachable)).toEqual({
      deliverable: true,
      primary: 'whatsapp',
      fallbacks: [],
    });
  });

  it('builds the full WhatsApp → SMS → Email chain when both fallbacks are enabled', () => {
    const plan = resolveChannelPlan(
      settings({ emailFallbackEnabled: true, smsFallbackEnabled: true }),
      'whatsapp',
      reachable,
    );
    expect(plan).toEqual({ deliverable: true, primary: 'whatsapp', fallbacks: ['sms', 'email'] });
  });

  it('treats no explicit preference as the full chain (WhatsApp-first)', () => {
    const plan = resolveChannelPlan(
      settings({ emailFallbackEnabled: true, smsFallbackEnabled: true }),
      null,
      reachable,
    );
    expect(plan).toEqual({ deliverable: true, primary: 'whatsapp', fallbacks: ['sms', 'email'] });
  });

  it('skips Email in the chain when only SMS fallback is enabled (WhatsApp → SMS)', () => {
    const plan = resolveChannelPlan(settings({ smsFallbackEnabled: true }), 'whatsapp', reachable);
    expect(plan).toEqual({ deliverable: true, primary: 'whatsapp', fallbacks: ['sms'] });
  });

  it('skips SMS in the chain when only Email fallback is enabled (WhatsApp → Email)', () => {
    const plan = resolveChannelPlan(settings({ emailFallbackEnabled: true }), 'whatsapp', reachable);
    expect(plan).toEqual({ deliverable: true, primary: 'whatsapp', fallbacks: ['email'] });
  });

  it('drops Email from the end of the chain when the client has no valid email', () => {
    const plan = resolveChannelPlan(
      settings({ emailFallbackEnabled: true, smsFallbackEnabled: true }),
      'whatsapp',
      phoneOnly,
    );
    expect(plan).toEqual({ deliverable: true, primary: 'whatsapp', fallbacks: ['sms'] });
  });

  it('email preference starts the chain at Email — the last link, so there is nothing after it', () => {
    const plan = resolveChannelPlan(
      settings({ emailFallbackEnabled: true, smsFallbackEnabled: true }),
      'email',
      reachable,
    );
    expect(plan).toEqual({ deliverable: true, primary: 'email', fallbacks: [] });
  });

  it('email preference delivers email as PRIMARY without the emailFallbackEnabled toggle (explicit choice)', () => {
    // emailFallbackEnabled is OFF here; an explicit email preference still gets email.
    const plan = resolveChannelPlan(settings(), 'email', reachable);
    expect(plan).toEqual({ deliverable: true, primary: 'email', fallbacks: [] });
  });

  it('email preference never falls back UP the chain to SMS, even when SMS is enabled', () => {
    // Preference is a starting point, not a filter: a client who asked for email is not moved onto a
    // channel they passed over. Email is last, so an email-preferring client has no fallback at all.
    const plan = resolveChannelPlan(settings({ smsFallbackEnabled: true }), 'email', reachable);
    expect(plan).toEqual({ deliverable: true, primary: 'email', fallbacks: [] });
  });

  it('email-preferring client is undeliverable only when they have no valid email', () => {
    const plan = resolveChannelPlan(settings(), 'email', phoneOnly);
    expect(plan.deliverable).toBe(false);
  });

  it('SMS preference starts at SMS and keeps Email as its fallback when email is enabled', () => {
    expect(
      resolveChannelPlan(settings({ smsFallbackEnabled: true, emailFallbackEnabled: true }), 'sms', reachable),
    ).toEqual({ deliverable: true, primary: 'sms', fallbacks: ['email'] });
  });

  it('SMS preference has no fallback when the client has no valid email', () => {
    expect(resolveChannelPlan(settings({ smsFallbackEnabled: true }), 'sms', phoneOnly)).toEqual({
      deliverable: true,
      primary: 'sms',
      fallbacks: [],
    });
  });

  it('SMS preference delivers SMS as PRIMARY without the smsFallbackEnabled toggle (explicit choice)', () => {
    // smsFallbackEnabled is OFF here; an explicit SMS preference still gets SMS, mirroring email.
    expect(resolveChannelPlan(settings(), 'sms', phoneOnly)).toEqual({
      deliverable: true,
      primary: 'sms',
      fallbacks: [],
    });
  });

  it('SMS-preferring client is undeliverable only when they have no valid phone', () => {
    expect(resolveChannelPlan(settings(), 'sms', emailOnly).deliverable).toBe(false);
  });

  it('does NOT add SMS as a downstream fallback without the smsFallbackEnabled toggle', () => {
    // WhatsApp-preferring: SMS is only a fallback here, so it still requires the toggle.
    const plan = resolveChannelPlan(settings({ emailFallbackEnabled: true }), 'whatsapp', reachable);
    expect(plan).toEqual({ deliverable: true, primary: 'whatsapp', fallbacks: ['email'] });
  });

  it('removes an opted-out channel from the chain entirely (WhatsApp STOP → SMS becomes primary)', () => {
    const plan = resolveChannelPlan(
      settings({ smsFallbackEnabled: true, emailFallbackEnabled: true }),
      'whatsapp',
      { ...reachable, optedOutChannels: ['whatsapp'] },
    );
    expect(plan).toEqual({ deliverable: true, primary: 'sms', fallbacks: ['email'] });
  });

  it('a WhatsApp opt-out does not silence email or SMS (opt-out is per channel)', () => {
    const plan = resolveChannelPlan(
      settings({ emailFallbackEnabled: true }),
      'whatsapp',
      { ...reachable, optedOutChannels: ['whatsapp'] },
    );
    expect(plan).toEqual({ deliverable: true, primary: 'email', fallbacks: [] });
  });

  it('is undeliverable when every channel in the chain is opted out', () => {
    const plan = resolveChannelPlan(
      settings({ smsFallbackEnabled: true, emailFallbackEnabled: true }),
      'whatsapp',
      { ...reachable, optedOutChannels: ['whatsapp', 'sms', 'email'] },
    );
    expect(plan.deliverable).toBe(false);
  });

  it('reports an opted-out explicit preference truthfully', () => {
    const plan = resolveChannelPlan(settings(), 'sms', { ...phoneOnly, optedOutChannels: ['sms'] });
    expect(plan).toEqual({ deliverable: false, skipReason: 'client has opted out of SMS' });
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

  it('falls through to Email as primary when WhatsApp and SMS are both unavailable', () => {
    expect(
      resolveChannelPlan(
        settings({ enabledChannels: [], emailFallbackEnabled: true }),
        'whatsapp',
        reachable,
      ),
    ).toEqual({ deliverable: true, primary: 'email', fallbacks: [] });
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
  const full: ChannelPlan = { deliverable: true, primary: 'whatsapp', fallbacks: ['sms', 'email'] };

  it('channelChain returns primary then fallbacks', () => {
    expect(channelChain(full)).toEqual(['whatsapp', 'sms', 'email']);
    expect(channelChain({ deliverable: false, skipReason: 'x' })).toEqual([]);
  });

  it('channelAllowedByPlan reflects membership in the chain', () => {
    expect(channelAllowedByPlan(full, 'whatsapp')).toBe(true);
    expect(channelAllowedByPlan(full, 'email')).toBe(true);
    expect(channelAllowedByPlan(full, 'sms')).toBe(true);
    expect(channelAllowedByPlan({ deliverable: true, primary: 'whatsapp', fallbacks: [] }, 'sms')).toBe(false);
  });

  it('nextChannelAfter walks WhatsApp → SMS → Email and stops at the end', () => {
    expect(nextChannelAfter(full, 'whatsapp')).toBe('sms');
    expect(nextChannelAfter(full, 'sms')).toBe('email');
    expect(nextChannelAfter(full, 'email')).toBeNull();
    // A channel not in the chain has no successor.
    expect(nextChannelAfter({ deliverable: true, primary: 'whatsapp', fallbacks: [] }, 'email')).toBeNull();
  });

  it('nextChannelAfter skips a disabled middle channel (WhatsApp → Email)', () => {
    const plan: ChannelPlan = { deliverable: true, primary: 'whatsapp', fallbacks: ['email'] };
    expect(nextChannelAfter(plan, 'whatsapp')).toBe('email');
  });

  it('hands a queued channel that has dropped out of the chain to the client’s current one', () => {
    // The client's preference moved to email after a WhatsApp event was already queued. Nothing
    // re-queues on a preference change, so returning null here would lose the message.
    expect(nextChannelAfter({ deliverable: true, primary: 'email', fallbacks: [] }, 'whatsapp')).toBe('email');
    expect(nextChannelAfter({ deliverable: true, primary: 'sms', fallbacks: ['email'] }, 'whatsapp')).toBe('sms');
    expect(nextChannelAfter({ deliverable: true, primary: 'email', fallbacks: [] }, 'sms')).toBe('email');
  });

  it('nextChannelAfter has nothing to hand over to when the plan is undeliverable', () => {
    expect(nextChannelAfter({ deliverable: false, skipReason: 'no channel' }, 'whatsapp')).toBeNull();
  });
});
