import { BadRequestException, Injectable, InternalServerErrorException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Stripe from 'stripe';

export type StripeClient = InstanceType<typeof Stripe>;
export type StripePaymentIntent = Awaited<ReturnType<StripeClient['paymentIntents']['retrieve']>>;
type StripePaymentIntentCreateParams = Parameters<StripeClient['paymentIntents']['create']>[0];
type StripeEvent = ReturnType<StripeClient['webhooks']['constructEvent']>;

export interface BookingPaymentIntentInput {
  amount: number;
  currency: string;
  bookingAttemptId: string;
  locationId: string;
  serviceIds: string[];
  stylistProfileId: string;
  clientProfileId: string;
  userProfileId: string;
  existingPaymentIntentId?: string | null;
}

@Injectable()
export class StripeService {
  private readonly webhookSecret?: string;
  private readonly stripe?: StripeClient;

  constructor(config: ConfigService) {
    const secretKey = config.get<string>('STRIPE_SECRET_KEY');
    this.webhookSecret = config.get<string>('STRIPE_WEBHOOK_SECRET');
    this.stripe = secretKey
      ? new Stripe(secretKey, {
          apiVersion: '2026-04-22.dahlia',
        })
      : undefined;
  }

  async createPaymentIntentForBookingAttempt(
    input: BookingPaymentIntentInput,
  ): Promise<StripePaymentIntent> {
    const stripe = this.requireStripe();
    const amountInMinorUnits = toMinorUnits(input.amount);
    if (amountInMinorUnits <= 0) {
      throw new BadRequestException('A positive deposit amount is required to start checkout');
    }

    const params: StripePaymentIntentCreateParams = {
      amount: amountInMinorUnits,
      currency: input.currency.toLowerCase(),
      // Card includes Apple Pay and Google Pay wallets in Stripe Payment Element.
      // Explicitly listing it prevents Klarna/Revolut Pay on deposit collection.
      payment_method_types: ['card'],
      metadata: {
        booking_attempt_id: input.bookingAttemptId,
        location_id: input.locationId,
        service_ids: input.serviceIds.join(','),
        stylist_profile_id: input.stylistProfileId,
        client_profile_id: input.clientProfileId,
        user_profile_id: input.userProfileId,
      },
    };

    if (input.existingPaymentIntentId) {
      const existing = await stripe.paymentIntents.retrieve(input.existingPaymentIntentId);
      if (existing.status === 'requires_payment_method' || existing.status === 'requires_confirmation') {
        return stripe.paymentIntents.update(existing.id, params);
      }
      return existing;
    }

    return stripe.paymentIntents.create(params, {
      idempotencyKey: `booking_attempt:${input.bookingAttemptId}`,
    });
  }

  verifyWebhookSignature(rawBody: Buffer, signature: string | undefined): StripeEvent {
    const stripe = this.requireStripe();
    if (!this.webhookSecret) {
      throw new InternalServerErrorException('Stripe webhook secret is not configured');
    }
    if (!signature) {
      throw new BadRequestException('Missing Stripe signature');
    }

    try {
      return stripe.webhooks.constructEvent(rawBody, signature, this.webhookSecret);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Invalid Stripe webhook signature';
      throw new BadRequestException(message);
    }
  }

  private requireStripe(): StripeClient {
    if (!this.stripe) {
      throw new InternalServerErrorException('Stripe is not configured');
    }
    return this.stripe;
  }
}

function toMinorUnits(amount: number): number {
  return Math.round(amount * 100);
}
