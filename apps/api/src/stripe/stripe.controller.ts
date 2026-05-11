import { Controller, Headers, HttpCode, Post, RawBodyRequest, Req } from '@nestjs/common';
import type { Request } from 'express';
import { PublicBookingService } from '../public-booking/public-booking.service';
import { StripeService, type StripePaymentIntent } from './stripe.service';

@Controller('stripe')
export class StripeController {
  constructor(
    private readonly stripe: StripeService,
    private readonly publicBooking: PublicBookingService,
  ) {}

  @Post('webhook')
  @HttpCode(200)
  async webhook(
    @Req() request: RawBodyRequest<Request>,
    @Headers('stripe-signature') signature?: string,
  ): Promise<{ received: true }> {
    const event = this.stripe.verifyWebhookSignature(request.rawBody ?? Buffer.alloc(0), signature);

    if (event.type === 'payment_intent.succeeded') {
      await this.publicBooking.handlePaymentIntentSucceeded(event.data.object as StripePaymentIntent);
    } else if (event.type === 'payment_intent.payment_failed') {
      await this.publicBooking.handlePaymentIntentFailed(event.data.object as StripePaymentIntent);
    }

    return { received: true };
  }
}
