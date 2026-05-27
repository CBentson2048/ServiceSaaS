import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { StripeController } from '../stripe/stripe.controller';
import { StripeModule } from '../stripe/stripe.module';
import { MobileBookingController, PublicBookingController } from './public-booking.controller';
import { PublicBookingService } from './public-booking.service';

@Module({
  imports: [AuthModule, StripeModule],
  controllers: [PublicBookingController, MobileBookingController, StripeController],
  providers: [PublicBookingService],
  exports: [PublicBookingService],
})
export class PublicBookingModule {}
