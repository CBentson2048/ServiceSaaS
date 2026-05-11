import { Module } from '@nestjs/common';
import { StripeController } from '../stripe/stripe.controller';
import { StripeModule } from '../stripe/stripe.module';
import { PublicBookingController } from './public-booking.controller';
import { PublicBookingService } from './public-booking.service';

@Module({
  imports: [StripeModule],
  controllers: [PublicBookingController, StripeController],
  providers: [PublicBookingService],
  exports: [PublicBookingService],
})
export class PublicBookingModule {}
