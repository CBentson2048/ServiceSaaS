import { Transform } from 'class-transformer';
import { registerDecorator, type ValidationOptions } from 'class-validator';
import { normalizeE164 } from './phone';

/**
 * DTO field decorator for a user-supplied phone number. With the global `ValidationPipe({transform:true})`:
 *  1. **Transforms** a recognisable number to strict E.164 so it is STORED canonically
 *     (e.g. `"07725485160"` → `"+447725485160"`), which is exactly what the WhatsApp/SMS senders need.
 *  2. **Validates** that a non-empty value is a real, dialable number — rejecting placeholders/junk like
 *     `"99999999999"` with a 400 up front, instead of silently storing it and failing later at Twilio.
 *
 * Empty / `null` / absent values pass (pair with `@IsOptional()` for optional fields). National-format
 * numbers are interpreted with the platform default region (see {@link normalizeE164}).
 */
export function IsPhoneField(validationOptions?: ValidationOptions): PropertyDecorator {
  return (target: object, propertyKey: string | symbol) => {
    // Normalise to E.164 when possible; otherwise keep the trimmed original so the validator flags it.
    Transform(({ value }) => {
      if (typeof value !== 'string') return value;
      const trimmed = value.trim();
      if (!trimmed) return trimmed;
      return normalizeE164(trimmed) ?? trimmed;
    })(target, propertyKey);

    registerDecorator({
      name: 'isPhoneField',
      target: target.constructor,
      propertyName: propertyKey as string,
      options: validationOptions,
      validator: {
        validate(value: unknown) {
          if (value === undefined || value === null || value === '') return true;
          return typeof value === 'string' && normalizeE164(value) !== undefined;
        },
        defaultMessage() {
          return 'phone must be a valid phone number (e.g. 07725485160 or +447725485160)';
        },
      },
    });
  };
}
