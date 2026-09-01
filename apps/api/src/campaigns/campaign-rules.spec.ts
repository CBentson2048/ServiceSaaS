/**
 * The pure campaign rules in @sheer/domain.
 *
 * Everything here is deterministic and clock-free, which is exactly why it can
 * be asserted so tightly: send identity, leap-day handling, timezone-boundary
 * behaviour, channel narrowing, template safety and configuration bounds are all
 * total functions of their inputs.
 *
 * The I/O halves are tested separately — audience resolution in
 * campaign-audience.service.spec.ts, the run lifecycle in
 * campaign-evaluator.service.spec.ts, and the database's own constraints in
 * supabase/tests/campaign_configuration.sql.
 */
import {
  CAMPAIGN_BOUNDS,
  CAMPAIGN_PREVIEW_VALUES,
  birthdayDedupeKey,
  birthdayOccurrence,
  birthdaySendMatch,
  campaignEventKey,
  campaignPreviewLine,
  defaultCampaignConfig,
  loyaltyDedupeKey,
  narrowCampaignChannel,
  promotionDedupeKey,
  promotionWindowIsOpen,
  rebookingDedupeKey,
  renderCampaignTemplate,
  shouldEvaluateToday,
  validateCampaignConfig,
  validateCampaignTemplate,
  type PromotionCampaignConfig,
} from '@sheer/domain';
import { salonNow } from './campaign-evaluator.service';

const CAMPAIGN = '11111111-1111-4111-8111-111111111111';
const CLIENT = '22222222-2222-4222-8222-222222222222';

describe('campaign type vocabulary', () => {
  it('uses one canonical event key per type', () => {
    expect(campaignEventKey('rebooking')).toBe('campaign_rebooking');
    expect(campaignEventKey('birthday')).toBe('campaign_birthday');
    expect(campaignEventKey('promotion')).toBe('campaign_promotion');
    expect(campaignEventKey('loyalty_milestone')).toBe('campaign_loyalty_milestone');
  });
});

// ---------------------------------------------------------------------------
// Send identity — Wrike sections 26, 27
// ---------------------------------------------------------------------------

describe('send identity', () => {
  it('gives a birthday one identity per client per BIRTHDAY year', () => {
    expect(birthdayDedupeKey(CAMPAIGN, CLIENT, 2026)).toBe(
      `campaign:${CAMPAIGN}:birthday:${CLIENT}:2026`,
    );
    expect(birthdayDedupeKey(CAMPAIGN, CLIENT, 2026)).not.toBe(
      birthdayDedupeKey(CAMPAIGN, CLIENT, 2027),
    );
  });

  it('gives a loyalty milestone one identity per client per threshold', () => {
    const ten = loyaltyDedupeKey(CAMPAIGN, CLIENT, 'completed_visits', 10);
    const twenty = loyaltyDedupeKey(CAMPAIGN, CLIENT, 'completed_visits', 20);
    const spend = loyaltyDedupeKey(CAMPAIGN, CLIENT, 'total_spend', 10);

    expect(ten).not.toBe(twenty); // a later milestone is a new message
    expect(ten).not.toBe(spend); // metric is part of the identity
    expect(loyaltyDedupeKey(CAMPAIGN, CLIENT, 'completed_visits', 10)).toBe(ten); // stable
  });

  it('gives a promotion exactly one identity per client, ever', () => {
    expect(promotionDedupeKey(CAMPAIGN, CLIENT)).toBe(promotionDedupeKey(CAMPAIGN, CLIENT));
  });

  it('keys a rebooking nudge on the rebooking OPPORTUNITY, not the day', () => {
    // While a client stays overdue their expected return does not move, so a
    // daily evaluator computes the same key every day and sends once.
    const day1 = rebookingDedupeKey(CAMPAIGN, CLIENT, '2026-08-01');
    const day2 = rebookingDedupeKey(CAMPAIGN, CLIENT, '2026-08-01');
    expect(day2).toBe(day1);

    // Once they come in, their next expected return is a NEW opportunity.
    expect(rebookingDedupeKey(CAMPAIGN, CLIENT, '2026-09-12')).not.toBe(day1);
  });

  it('never includes the message text, so editing the wording re-targets nobody', () => {
    // Every key is a function of (campaign, client, opportunity) only. This is
    // the structural guarantee behind Wrike section 27.
    for (const key of [
      birthdayDedupeKey(CAMPAIGN, CLIENT, 2026),
      loyaltyDedupeKey(CAMPAIGN, CLIENT, 'total_spend', 50_000),
      promotionDedupeKey(CAMPAIGN, CLIENT),
      rebookingDedupeKey(CAMPAIGN, CLIENT, '2026-08-01'),
    ]) {
      expect(key).toContain(CAMPAIGN);
      expect(key).toContain(CLIENT);
    }
  });

  it('separates campaigns, so two campaigns can each reach the same client', () => {
    const other = '33333333-3333-4333-8333-333333333333';
    expect(promotionDedupeKey(CAMPAIGN, CLIENT)).not.toBe(promotionDedupeKey(other, CLIENT));
  });
});

// ---------------------------------------------------------------------------
// Birthday calendar — Wrike sections 11, 42
// ---------------------------------------------------------------------------

describe('birthday occurrence', () => {
  it('returns the same month/day in a normal year', () => {
    expect(birthdayOccurrence('1990-07-14', 2026)).toBe('2026-07-14');
  });

  it('observes a 29 February birthday on 28 February in a common year', () => {
    expect(birthdayOccurrence('1992-02-29', 2027)).toBe('2027-02-28'); // 2027 is common
    expect(birthdayOccurrence('1992-02-29', 2028)).toBe('2028-02-29'); // 2028 is a leap year
  });

  it('handles century leap rules', () => {
    expect(birthdayOccurrence('1992-02-29', 1900)).toBe('1900-02-28'); // 1900 is NOT a leap year
    expect(birthdayOccurrence('1992-02-29', 2000)).toBe('2000-02-29'); // 2000 IS a leap year
  });

  it('never infers a birthday from a missing or malformed value', () => {
    expect(birthdayOccurrence(null, 2026)).toBeNull();
    expect(birthdayOccurrence(undefined, 2026)).toBeNull();
    expect(birthdayOccurrence('', 2026)).toBeNull();
    expect(birthdayOccurrence('not-a-date', 2026)).toBeNull();
    expect(birthdayOccurrence('1990-13-01', 2026)).toBeNull();
    expect(birthdayOccurrence('1990-02-30', 2026)).toBeNull();
  });
});

describe('birthday send matching', () => {
  it('matches on the day when daysBefore is 0', () => {
    expect(birthdaySendMatch('1990-09-01', '2026-09-01', 0)).toEqual({
      birthdayYear: 2026,
      birthdayDate: '2026-09-01',
    });
  });

  it('does not match any other day', () => {
    expect(birthdaySendMatch('1990-09-01', '2026-08-31', 0)).toBeNull();
    expect(birthdaySendMatch('1990-09-01', '2026-09-02', 0)).toBeNull();
  });

  it('matches the configured lead time', () => {
    expect(birthdaySendMatch('1990-09-08', '2026-09-01', 7)).toEqual({
      birthdayYear: 2026,
      birthdayDate: '2026-09-08',
    });
  });

  it('reaches an early-January birthday from late December, keyed to the NEXT year', () => {
    // The send happens in 2026 but the birthday is 2027's, so the identity is
    // 2027 — otherwise a 10-day lead would send in December AND again in January.
    expect(birthdaySendMatch('1990-01-03', '2026-12-27', 7)).toEqual({
      birthdayYear: 2027,
      birthdayDate: '2027-01-03',
    });
  });

  it('sends a leap-day client on 28 February in a common year, once', () => {
    expect(birthdaySendMatch('1992-02-29', '2027-02-28', 0)).toEqual({
      birthdayYear: 2027,
      birthdayDate: '2027-02-28',
    });
    // ...and not also on 1 March.
    expect(birthdaySendMatch('1992-02-29', '2027-03-01', 0)).toBeNull();
  });

  it('suppresses a missing date of birth', () => {
    expect(birthdaySendMatch(null, '2026-09-01', 0)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Timezone — Wrike section 22
// ---------------------------------------------------------------------------

describe('salon-local now', () => {
  it('resolves the salon-local date, not the server UTC date', () => {
    // 2026-09-01T23:30Z is already 2 September in Auckland and still 1 September
    // in New York. A birthday campaign in each salon must use its own calendar.
    const at = new Date('2026-09-01T23:30:00Z');
    expect(salonNow('Pacific/Auckland', at).localDate).toBe('2026-09-02');
    expect(salonNow('America/New_York', at).localDate).toBe('2026-09-01');
    expect(salonNow('Europe/London', at).localDate).toBe('2026-09-02');
  });

  it('resolves the salon-local hour', () => {
    const at = new Date('2026-09-01T09:15:00Z');
    expect(salonNow('Europe/London', at).localHour).toBe(10); // BST
    expect(salonNow('UTC', at).localHour).toBe(9);
  });

  it('is DST-safe across a British Summer Time boundary', () => {
    // 2026-10-25 01:30Z: the clocks have gone back, so London is 01:30 GMT.
    expect(salonNow('Europe/London', new Date('2026-10-25T01:30:00Z')).localHour).toBe(1);
    // The day before the same wall clock was BST.
    expect(salonNow('Europe/London', new Date('2026-10-24T01:30:00Z')).localHour).toBe(2);
  });

  it('falls back to the platform default rather than crashing on an unknown zone', () => {
    const result = salonNow('Not/AZone', new Date('2026-09-01T09:15:00Z'));
    expect(result.localDate).toBe('2026-09-01');
    expect(result.localHour).toBe(10); // Europe/London
  });
});

describe('shouldEvaluateToday', () => {
  const base = {
    status: 'active' as const,
    todayLocalDate: '2026-09-01',
    localHour: 10,
    sendAtLocalHour: 10,
    lastRunLocalDate: null,
  };

  it('runs once the salon-local send hour has arrived', () => {
    expect(shouldEvaluateToday(base)).toBe(true);
    expect(shouldEvaluateToday({ ...base, localHour: 23 })).toBe(true);
  });

  it('waits until the send hour', () => {
    expect(shouldEvaluateToday({ ...base, localHour: 9 })).toBe(false);
  });

  it('does not run twice on the same salon-local day', () => {
    expect(shouldEvaluateToday({ ...base, lastRunLocalDate: '2026-09-01' })).toBe(false);
    expect(shouldEvaluateToday({ ...base, lastRunLocalDate: '2026-08-31' })).toBe(true);
  });

  it('never evaluates anything but an active campaign', () => {
    for (const status of ['draft', 'paused', 'archived'] as const) {
      expect(shouldEvaluateToday({ ...base, status })).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// Channel narrowing — Wrike sections 17, 18
// ---------------------------------------------------------------------------

describe('channel narrowing', () => {
  it('leaves the canonical chain untouched for auto', () => {
    expect(narrowCampaignChannel('auto', null)).toBeNull(); // WhatsApp-first, unmodified
    expect(narrowCampaignChannel('auto', 'sms')).toBe('sms'); // the client's own choice
  });

  it('lets a campaign narrow a client further down the chain', () => {
    expect(narrowCampaignChannel('email', 'whatsapp')).toBe('email');
    expect(narrowCampaignChannel('sms', 'whatsapp')).toBe('sms');
  });

  it('NEVER drags a client back UP the chain', () => {
    // The client chose email. A WhatsApp campaign does not override that.
    expect(narrowCampaignChannel('whatsapp', 'email')).toBe('email');
    expect(narrowCampaignChannel('sms', 'email')).toBe('email');
    expect(narrowCampaignChannel('whatsapp', 'sms')).toBe('sms');
  });

  it('preserves WhatsApp-first when neither side narrows', () => {
    expect(narrowCampaignChannel('whatsapp', null)).toBe('whatsapp');
    expect(narrowCampaignChannel('whatsapp', 'whatsapp')).toBe('whatsapp');
  });
});

// ---------------------------------------------------------------------------
// Templates — Wrike sections 19, 20, 21
// ---------------------------------------------------------------------------

describe('template validation', () => {
  it('accepts a plain message with approved placeholders', () => {
    const result = validateCampaignTemplate('Hi {{first_name}}, {{salon_name}} misses you! {{booking_link}}');
    expect(result.valid).toBe(true);
    expect(result.usedVariables).toEqual(['first_name', 'salon_name', 'booking_link']);
  });

  it('rejects an empty or whitespace-only message', () => {
    expect(validateCampaignTemplate('').valid).toBe(false);
    expect(validateCampaignTemplate('   \n  ').valid).toBe(false);
  });

  it('rejects an over-long message', () => {
    const long = 'a'.repeat(CAMPAIGN_BOUNDS.templateLength.max + 1);
    expect(validateCampaignTemplate(long).valid).toBe(false);
  });

  it('rejects unknown placeholders rather than shipping them to a client', () => {
    const result = validateCampaignTemplate('Hi {{first_name}}, your {{discount_code}} awaits');
    expect(result.valid).toBe(false);
    expect(result.unknownVariables).toEqual(['discount_code']);
    expect(result.errors.join(' ')).toContain('{{discount_code}}');
  });

  it('rejects an unclosed placeholder', () => {
    expect(validateCampaignTemplate('Hi {{first_name, welcome back').valid).toBe(false);
  });

  it('rejects raw HTML, which WhatsApp and SMS cannot render', () => {
    const result = validateCampaignTemplate('Hi <b>{{first_name}}</b>');
    expect(result.valid).toBe(false);
    expect(result.errors.join(' ')).toContain('HTML');
  });

  it('tolerates whitespace inside a placeholder', () => {
    expect(validateCampaignTemplate('Hi {{ first_name }}').valid).toBe(true);
  });
});

describe('template rendering', () => {
  const values = {
    first_name: 'Jane',
    last_name: 'Smith',
    salon_name: 'Luke Ormsby Hair',
    location_name: 'Primrose Hill',
    booking_link: 'https://book.example/book/location',
  };

  it('substitutes every approved variable', () => {
    expect(
      renderCampaignTemplate('Hi {{first_name}} {{last_name}} — {{location_name}} at {{salon_name}}: {{booking_link}}', values),
    ).toBe('Hi Jane Smith — Primrose Hill at Luke Ormsby Hair: https://book.example/book/location');
  });

  it('never executes anything — a placeholder is a map lookup', () => {
    // Values are inserted verbatim; nothing in the body is evaluated.
    expect(renderCampaignTemplate('{{first_name}}', { ...values, first_name: '{{salon_name}}' })).toBe(
      '{{salon_name}}',
    );
  });

  it('leaves an unknown placeholder visible rather than silently blanking it', () => {
    // Validation already refuses to store one; if it ever reaches here it must
    // be obvious, not swallowed.
    expect(renderCampaignTemplate('Hi {{mystery}}', values)).toBe('Hi {{mystery}}');
  });

  it('renders the owner preview with representative values, never a real client', () => {
    const preview = renderCampaignTemplate('Hi {{first_name}}, {{salon_name}} here', CAMPAIGN_PREVIEW_VALUES);
    expect(preview).toBe('Hi Jane, Your salon here');
  });

  it('produces a single-line, bounded log preview', () => {
    expect(campaignPreviewLine('Hi Jane,\n\n  time for your colour!')).toBe('Hi Jane, time for your colour!');
    expect(campaignPreviewLine('x'.repeat(500)).length).toBeLessThanOrEqual(120);
  });
});

// ---------------------------------------------------------------------------
// Configuration — Wrike section 5
// ---------------------------------------------------------------------------

describe('configuration validation', () => {
  it('accepts each type default', () => {
    for (const type of ['rebooking', 'birthday', 'promotion', 'loyalty_milestone'] as const) {
      const config = defaultCampaignConfig(type, '2026-09-01');
      expect(validateCampaignConfig(type, config).valid).toBe(true);
    }
  });

  describe('rebooking', () => {
    const valid = { targetStatuses: ['lapsed'], minOverdueDays: 0, serviceCategoryId: null };

    it('requires at least one target group', () => {
      expect(validateCampaignConfig('rebooking', { ...valid, targetStatuses: [] }).valid).toBe(false);
    });

    it('refuses to target clients who are already booked or on cadence', () => {
      // `booked`, `active` and `insufficient_history` are not targetable at all —
      // this is what enforces "do not message a client who has rebooked".
      for (const status of ['booked', 'active', 'insufficient_history']) {
        expect(validateCampaignConfig('rebooking', { ...valid, targetStatuses: [status] }).valid).toBe(false);
      }
    });

    it('bounds the extra overdue delay', () => {
      expect(validateCampaignConfig('rebooking', { ...valid, minOverdueDays: -1 }).valid).toBe(false);
      expect(validateCampaignConfig('rebooking', { ...valid, minOverdueDays: 366 }).valid).toBe(false);
      expect(validateCampaignConfig('rebooking', { ...valid, minOverdueDays: 7 }).valid).toBe(true);
    });
  });

  describe('birthday', () => {
    it('bounds the lead time', () => {
      expect(validateCampaignConfig('birthday', { daysBefore: 0 }).valid).toBe(true);
      expect(validateCampaignConfig('birthday', { daysBefore: 30 }).valid).toBe(true);
      expect(validateCampaignConfig('birthday', { daysBefore: -1 }).valid).toBe(false);
      expect(validateCampaignConfig('birthday', { daysBefore: 31 }).valid).toBe(false);
      expect(validateCampaignConfig('birthday', { daysBefore: 1.5 }).valid).toBe(false);
    });
  });

  describe('promotion', () => {
    const valid = {
      startDate: '2026-09-01',
      endDate: '2026-09-30',
      lapseStatuses: [],
      serviceCategoryId: null,
      minCompletedVisits: 0,
    };

    it('requires a real, ordered window', () => {
      expect(validateCampaignConfig('promotion', valid).valid).toBe(true);
      expect(validateCampaignConfig('promotion', { ...valid, endDate: '2026-08-01' }).valid).toBe(false);
      expect(validateCampaignConfig('promotion', { ...valid, startDate: 'soon' }).valid).toBe(false);
      expect(validateCampaignConfig('promotion', { ...valid, endDate: '2030-01-01' }).valid).toBe(false);
    });

    it('restricts audience filters to the controlled set', () => {
      expect(validateCampaignConfig('promotion', { ...valid, lapseStatuses: ['everyone'] }).valid).toBe(false);
      expect(validateCampaignConfig('promotion', { ...valid, minCompletedVisits: 200 }).valid).toBe(false);
    });
  });

  describe('loyalty milestone', () => {
    it('requires a canonical metric', () => {
      expect(validateCampaignConfig('loyalty_milestone', { metric: 'vibes', threshold: 5 }).valid).toBe(false);
    });

    it('bounds a visit milestone', () => {
      expect(validateCampaignConfig('loyalty_milestone', { metric: 'completed_visits', threshold: 10 }).valid).toBe(true);
      expect(validateCampaignConfig('loyalty_milestone', { metric: 'completed_visits', threshold: 0 }).valid).toBe(false);
    });

    it('treats a spend milestone as integer MINOR units', () => {
      // £500.00 as 50000 pence. A decimal amount is rejected outright, so money
      // never enters this feature as a float.
      expect(validateCampaignConfig('loyalty_milestone', { metric: 'total_spend', threshold: 50_000 }).valid).toBe(true);
      expect(validateCampaignConfig('loyalty_milestone', { metric: 'total_spend', threshold: 500.5 }).valid).toBe(false);
      expect(validateCampaignConfig('loyalty_milestone', { metric: 'total_spend', threshold: 50 }).valid).toBe(false);
    });
  });

  it('reports every problem at once', () => {
    const result = validateCampaignConfig('rebooking', { targetStatuses: [], minOverdueDays: -5 });
    expect(result.errors.length).toBeGreaterThan(1);
  });
});

describe('promotion window', () => {
  const config: PromotionCampaignConfig = {
    startDate: '2026-09-01',
    endDate: '2026-09-30',
    lapseStatuses: [],
    serviceCategoryId: null,
    minCompletedVisits: 0,
  };

  it('is inclusive at both ends', () => {
    expect(promotionWindowIsOpen(config, '2026-09-01')).toBe(true);
    expect(promotionWindowIsOpen(config, '2026-09-30')).toBe(true);
  });

  it('is closed outside the window', () => {
    expect(promotionWindowIsOpen(config, '2026-08-31')).toBe(false);
    expect(promotionWindowIsOpen(config, '2026-10-01')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Stored-config integrity
// ---------------------------------------------------------------------------

describe('stored config type precedence', () => {
  it('validates against the declared type, not a type smuggled into the config', () => {
    // A stored config carrying its own `type` key must not be able to re-label a
    // campaign. Validation is always driven by the campaign_type COLUMN.
    const smuggled = { type: 'birthday', daysBefore: 0 };
    expect(validateCampaignConfig('rebooking', smuggled).valid).toBe(false);
    expect(validateCampaignConfig('loyalty_milestone', smuggled).valid).toBe(false);
  });
});
