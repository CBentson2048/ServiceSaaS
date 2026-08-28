import { isProviderOptOut, parseOptOutKeyword } from './opt-out';

describe('parseOptOutKeyword', () => {
  it.each(['STOP', 'stop', 'Stop.', 'STOPALL', 'unsubscribe', 'CANCEL', 'end', 'quit', ' stop '])(
    'treats %s as an opt-out',
    (body) => {
      expect(parseOptOutKeyword(body)).toBe('opt_out');
    },
  );

  it.each(['START', 'yes', 'UNSTOP'])('treats %s as an opt-in', (body) => {
    expect(parseOptOutKeyword(body)).toBe('opt_in');
  });

  it('does not treat a sentence containing a keyword as a command', () => {
    // The distinction matters: "please cancel my appointment" is a client talking to the salon, not
    // a request to never be messaged again.
    expect(parseOptOutKeyword('please cancel my appointment')).toBeNull();
    expect(parseOptOutKeyword('can you stop the reminders for next week?')).toBeNull();
    expect(parseOptOutKeyword('Yes please, 2pm works')).toBeNull();
  });

  it('returns null for empty or missing bodies', () => {
    expect(parseOptOutKeyword('')).toBeNull();
    expect(parseOptOutKeyword('   ')).toBeNull();
    expect(parseOptOutKeyword(null)).toBeNull();
    expect(parseOptOutKeyword(undefined)).toBeNull();
  });
});

describe('isProviderOptOut', () => {
  it('recognises Twilio 21610 (attempt to send to unsubscribed recipient)', () => {
    expect(isProviderOptOut('21610', 'Attempt to send to unsubscribed recipient')).toBe(true);
    expect(isProviderOptOut(' 21610 ', undefined)).toBe(true);
  });

  it('recognises an unsubscribe stated in the error text', () => {
    expect(isProviderOptOut(undefined, 'The recipient has opted-out of receiving messages')).toBe(true);
    expect(isProviderOptOut('30007', 'Recipient has replied with STOP')).toBe(true);
  });

  it('does NOT infer an opt-out from an ordinary delivery failure', () => {
    // Guessing here would permanently silence a channel for a client who never unsubscribed.
    expect(isProviderOptOut('30006', 'Landline or unreachable carrier')).toBe(false);
    expect(isProviderOptOut('63016', 'Failed to send freeform message outside the session window')).toBe(false);
    expect(isProviderOptOut('21211', 'Invalid To phone number')).toBe(false);
    expect(isProviderOptOut(undefined, undefined)).toBe(false);
  });
});
