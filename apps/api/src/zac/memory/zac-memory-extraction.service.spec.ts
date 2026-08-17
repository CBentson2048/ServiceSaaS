import { ZacMemoryExtractionService } from './zac-memory-extraction.service';
import { containsForbiddenMemoryContent, redactForStorage } from './zac-redaction';

describe('ZacMemoryExtractionService', () => {
  const extraction = new ZacMemoryExtractionService();

  describe('explicit memory commands', () => {
    it('captures the Luke rebooking goal verbatim as a business goal', () => {
      const command = extraction.detectCommand(
        'My main goal this month is to increase rebooking to 60%. Please remember that.',
        'owner',
      );

      expect(command).not.toBeNull();
      expect(command!.kind).toBe('business_goal');
      expect(command!.topic).toBe('rebooking');
      expect(command!.content).toBe('My main goal this month is to increase rebooking to 60%.');
      expect(command!.updateIntent).toBe(false);
      expect(command!.statedValue).toBe('60%');
    });

    it('captures "I prefer concise answers" as a private communication preference', () => {
      const command = extraction.detectCommand(
        'Please remember that I prefer concise answers.',
        'owner',
      );

      expect(command).not.toBeNull();
      expect(command!.kind).toBe('user_preference');
      expect(command!.topic).toBe('communication_style');
      expect(command!.content).toBe('I prefer concise answers.');
    });

    it('captures a colour-waste priority', () => {
      const command = extraction.detectCommand(
        'Our biggest priority this month is reducing colour waste.',
        'owner',
      );

      expect(command).not.toBeNull();
      expect(command!.kind).toBe('business_priority');
      expect(command!.topic).toBe('colour_waste');
    });

    it("captures a manager's team-coaching theme", () => {
      const command = extraction.detectCommand(
        'Remember that I want to coach the team on rebooking this week.',
        'manager',
      );

      expect(command).not.toBeNull();
      expect(command!.kind).toBe('manager_team_theme');
      expect(command!.topic).toBe('rebooking');
    });

    it("captures a stylist's stated aspiration as a coaching focus without an explicit remember", () => {
      const command = extraction.detectCommand(
        'I want to get more confident asking clients to rebook.',
        'stylist',
      );

      expect(command).not.toBeNull();
      expect(command!.kind).toBe('coaching_focus');
      expect(command!.topic).toBe('rebooking');
    });

    it('captures a bare goal statement ("My rebooking goal is 55%")', () => {
      const command = extraction.detectCommand('My rebooking goal is 55%.', 'owner');

      expect(command).not.toBeNull();
      expect(command!.kind).toBe('business_goal');
      expect(command!.topic).toBe('rebooking');
      expect(command!.statedValue).toBe('55%');
    });

    it('flags "update that goal to 60%" as an update with a stated value', () => {
      const command = extraction.detectCommand('Update that goal to 60%.', 'owner');

      expect(command).not.toBeNull();
      expect(command!.updateIntent).toBe(true);
      expect(command!.statedValue).toBe('60%');
      expect(command!.topic).toBe('general');
    });

    it('handles "from now on" phrasing', () => {
      const command = extraction.detectCommand(
        'From now on I prefer short answers.',
        'manager',
      );

      expect(command).not.toBeNull();
      expect(command!.kind).toBe('user_preference');
      expect(command!.topic).toBe('communication_style');
    });

    it('does not treat ordinary questions as memory commands', () => {
      expect(extraction.detectCommand('How is my business doing?', 'owner')).toBeNull();
      expect(extraction.detectCommand('What should I focus on today?', 'stylist')).toBeNull();
      expect(extraction.detectCommand('Who works here?', 'owner')).toBeNull();
      expect(extraction.detectCommand('How can I improve my rebooking?', 'owner')).toBeNull();
    });

    it('never captures question-shaped messages that merely mention goals or targets', () => {
      // How-to question containing "set … target … to" — an ask, not a command.
      expect(
        extraction.detectCommand('How do I set my revenue target to £2000 in QLOOQO?', 'owner'),
      ).toBeNull();
      // Statement + trailing question: the question must win the turn.
      expect(
        extraction.detectCommand('My focus is rebooking this month, how are we doing?', 'owner'),
      ).toBeNull();
      // Reminiscence, not a store request.
      expect(extraction.detectCommand('Remember when we talked about revenue?', 'owner')).toBeNull();
    });

    it('still captures an explicit remember phrased as a polite question', () => {
      const command = extraction.detectCommand(
        'Can you remember that I prefer short answers?',
        'owner',
      );
      expect(command).not.toBeNull();
      expect(command!.kind).toBe('user_preference');
    });

    it('extracts the value being SET, not the first number in the sentence', () => {
      const command = extraction.detectCommand(
        'Change my 2025 rebooking target to 65%.',
        'owner',
      );
      expect(command).not.toBeNull();
      expect(command!.updateIntent).toBe(true);
      expect(command!.statedValue).toBe('65%');

      const currency = extraction.detectCommand('Set my week 4 retail target to £300.', 'owner');
      expect(currency).not.toBeNull();
      expect(currency!.statedValue).toBe('£300');
    });

    it('does not treat recall questions as memory commands', () => {
      expect(extraction.detectCommand('What goal did I just give you?', 'owner')).toBeNull();
      expect(
        extraction.detectCommand('What do you remember about my business?', 'owner'),
      ).toBeNull();
    });
  });

  describe('memory recall questions', () => {
    it.each([
      ['What goal did I just give you?', 'goals'],
      ['What are my current goals?', 'goals'],
      ['What do you remember about me?', 'about_me'],
      ['What do you remember about my business?', 'about_business'],
      ['What do you remember about the team?', 'about_team'],
      ['What communication preference have I given you?', 'preferences'],
      ['What preference have I asked you to remember?', 'preferences'],
    ])('classifies %j as %s', (question, subject) => {
      expect(extraction.detectRecallSubject(question)).toBe(subject);
    });

    it('leaves non-memory questions alone', () => {
      expect(extraction.detectRecallSubject('What should I focus on today?')).toBeNull();
      expect(extraction.detectRecallSubject('How is my business doing?')).toBeNull();
      expect(extraction.detectRecallSubject('Who works here?')).toBeNull();
      expect(extraction.detectRecallSubject('What can you help me with?')).toBeNull();
    });
  });
});

describe('zac-redaction', () => {
  it('refuses credential and payment content outright', () => {
    expect(containsForbiddenMemoryContent('remember my password is hunter2')).toBe(true);
    expect(containsForbiddenMemoryContent('remember the api key sk-abc')).toBe(true);
    expect(containsForbiddenMemoryContent('note card number 4111 1111 1111 1111')).toBe(true);
    expect(
      containsForbiddenMemoryContent("remember the client's phone number for me"),
    ).toBe(true);
    expect(containsForbiddenMemoryContent('my goal is 60% rebooking')).toBe(false);
  });

  it('strips PII-shaped substrings but keeps goal numbers', () => {
    expect(redactForStorage('Reach owner@example.com about the 60% target')).toBe(
      'Reach [redacted] about the 60% target',
    );
    expect(redactForStorage('Call +44 7911 123456 tomorrow')).toBe('Call [redacted] tomorrow');
    expect(redactForStorage('Increase rebooking to 60% this month')).toBe(
      'Increase rebooking to 60% this month',
    );
  });

  it('caps runaway text', () => {
    const long = 'a'.repeat(500);
    expect(redactForStorage(long).length).toBeLessThanOrEqual(300);
  });
});
