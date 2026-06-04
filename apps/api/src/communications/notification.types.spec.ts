import {
  DEFAULT_COMMUNICATION_SETTINGS,
  metadataToSettings,
  REMINDER_OFFSET_HOURS,
  NotificationEventKey,
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
    expect(s.sendBookingConfirmation).toBe(true);
    expect(s.enabled).toBe(true);
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
        reminder24hEnabled: true,
        reminder48hEnabled: false,
        reminder1wEnabled: true,
        smsFallbackEnabled: false,
      },
      null,
    );
    expect(meta.reminderOffsetsHours).toEqual([
      REMINDER_OFFSET_HOURS[NotificationEventKey.Reminder1w],
      REMINDER_OFFSET_HOURS[NotificationEventKey.Reminder24h],
    ]);
    expect(meta.sendBookingConfirmation).toBe(true);
  });

  it('preserves unknown keys already present in metadata (e.g. cancellation notice)', () => {
    const meta = settingsToMetadata(
      {
        locationId: 'loc-1',
        enabled: true,
        enabledChannels: ['whatsapp'],
        sendBookingConfirmation: false,
        reminder24hEnabled: false,
        reminder48hEnabled: false,
        reminder1wEnabled: false,
        smsFallbackEnabled: false,
      },
      { sendCancellationNotice: true, sendWaitlistNotifications: true },
    );
    expect(meta.sendCancellationNotice).toBe(true);
    expect(meta.sendWaitlistNotifications).toBe(true);
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
