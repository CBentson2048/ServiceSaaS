import {
  DEFAULT_COMMUNICATION_SETTINGS,
  metadataToSettings,
  REMINDER_OFFSET_HOURS,
  NotificationEventKey,
  reminderOccurrenceKey,
  settingsToMetadata,
} from './notification.types';

describe('metadataToSettings', () => {
  it('applies defaults when metadata is absent', () => {
    const s = metadataToSettings('loc-1', null);
    expect(s).toMatchObject({ locationId: 'loc-1', ...DEFAULT_COMMUNICATION_SETTINGS });
  });

  it('derives reminder toggles from reminderOffsetsHours', () => {
    const s = metadataToSettings('loc-1', {
      enabled: true,
      enabledChannels: ['whatsapp'],
      sendBookingConfirmation: true,
      reminderOffsetsHours: [168, 24],
    });
    expect(s.reminder1wEnabled).toBe(true);
    expect(s.reminder24hEnabled).toBe(true);
    expect(s.reminder48hEnabled).toBe(false);
    expect(s.reminder2hEnabled).toBe(false);
    expect(s.sendBookingConfirmation).toBe(true);
    expect(s.enabled).toBe(true);
  });

  it('derives the 2-hour reminder toggle from a 2h offset (Wrike 4507281442)', () => {
    const s = metadataToSettings('loc-1', {
      enabled: true,
      enabledChannels: ['whatsapp'],
      reminderOffsetsHours: [48, 2],
    });
    expect(s.reminder2hEnabled).toBe(true);
    expect(s.reminder48hEnabled).toBe(true);
    expect(s.reminder24hEnabled).toBe(false);
    // Round-trips back to the same offsets.
    expect(new Set(settingsToMetadata(s, null).reminderOffsetsHours)).toEqual(new Set([48, 2]));
  });
});

describe('settingsToMetadata', () => {
  it('serialises enabled toggles back to canonical offsets', () => {
    const meta = settingsToMetadata(
      {
        locationId: 'loc-1',
        enabled: true,
        enabledChannels: ['whatsapp'],
        sendBookingConfirmation: true,
        reminder2hEnabled: false,
        reminder24hEnabled: true,
        reminder48hEnabled: false,
        reminder1wEnabled: true,
        emailFallbackEnabled: true,
        smsFallbackEnabled: false,
      },
      null,
    );
    expect(meta.reminderOffsetsHours).toEqual([
      REMINDER_OFFSET_HOURS[NotificationEventKey.Reminder1w],
      REMINDER_OFFSET_HOURS[NotificationEventKey.Reminder24h],
    ]);
    expect(meta.sendBookingConfirmation).toBe(true);
    expect(meta.emailFallbackEnabled).toBe(true);
  });

  it('preserves unknown keys already present in metadata (e.g. cancellation notice)', () => {
    const meta = settingsToMetadata(
      {
        locationId: 'loc-1',
        enabled: true,
        enabledChannels: ['whatsapp'],
        sendBookingConfirmation: false,
        reminder2hEnabled: false,
        reminder24hEnabled: false,
        reminder48hEnabled: false,
        reminder1wEnabled: false,
        emailFallbackEnabled: false,
        smsFallbackEnabled: false,
      },
      { sendCancellationNotice: true, sendWaitlistNotifications: true },
    );
    expect(meta.sendCancellationNotice).toBe(true);
    expect(meta.sendWaitlistNotifications).toBe(true);
  });

  it('round-trips the email + SMS fallback toggles through metadata', () => {
    const settings = metadataToSettings('loc-1', {
      enabled: true,
      enabledChannels: ['whatsapp'],
      emailFallbackEnabled: true,
      smsFallbackEnabled: true,
    });
    expect(settings.emailFallbackEnabled).toBe(true);
    expect(settings.smsFallbackEnabled).toBe(true);
    const meta = settingsToMetadata(settings, null);
    expect(meta.emailFallbackEnabled).toBe(true);
    expect(meta.smsFallbackEnabled).toBe(true);
  });

  it('round-trips through metadata → settings → metadata', () => {
    const original = {
      enabled: true,
      enabledChannels: ['whatsapp'] as const,
      sendBookingConfirmation: true,
      reminderOffsetsHours: [168, 48, 24],
    };
    const settings = metadataToSettings('loc-1', { ...original, enabledChannels: ['whatsapp'] });
    const meta = settingsToMetadata(settings, null);
    expect(new Set(meta.reminderOffsetsHours)).toEqual(new Set([168, 48, 24]));
  });
});

// ===========================================================================
// Reminder occurrence identity — Wrike 4507284256 section 13
// ===========================================================================

describe('reminderOccurrenceKey', () => {
  const start = '2026-10-01T09:00:00Z';

  it('returns the snapshotted appointment start for every reminder offset', () => {
    for (const key of [
      NotificationEventKey.Reminder2h,
      NotificationEventKey.Reminder24h,
      NotificationEventKey.Reminder48h,
      NotificationEventKey.Reminder1w,
    ]) {
      expect(reminderOccurrenceKey(key, { appointment_start: start })).toBe(start);
    }
  });

  it('returns null for one-shot appointment messages', () => {
    // A confirmation and a nudge have no second occurrence, and their prechecks
    // do not pin the snapshot — so their payload can legitimately be refreshed
    // mid-fallback. Including them would split one chain into two units.
    expect(reminderOccurrenceKey(NotificationEventKey.BookingConfirmation, { appointment_start: start })).toBeNull();
    expect(reminderOccurrenceKey(NotificationEventKey.RebookingNudge, { appointment_start: start })).toBeNull();
  });

  it('returns null for a campaign or any non-appointment key', () => {
    expect(reminderOccurrenceKey('campaign:winback', { appointment_start: start })).toBeNull();
  });

  it('returns null when the snapshot is missing, blank or not a string', () => {
    const key = NotificationEventKey.Reminder24h;
    expect(reminderOccurrenceKey(key, null)).toBeNull();
    expect(reminderOccurrenceKey(key, {})).toBeNull();
    expect(reminderOccurrenceKey(key, { appointment_start: '   ' })).toBeNull();
    expect(reminderOccurrenceKey(key, { appointment_start: 12345 })).toBeNull();
  });

  it('is stable for one occurrence and different across two', () => {
    const key = NotificationEventKey.Reminder24h;
    expect(reminderOccurrenceKey(key, { appointment_start: start })).toBe(
      reminderOccurrenceKey(key, { appointment_start: start }),
    );
    expect(reminderOccurrenceKey(key, { appointment_start: start })).not.toBe(
      reminderOccurrenceKey(key, { appointment_start: '2026-10-08T09:00:00Z' }),
    );
  });
});
