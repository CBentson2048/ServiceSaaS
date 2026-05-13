import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { OwnerBookingSettingsController } from './owner-booking-settings.controller';
import { OwnerBookingSettingsService } from './owner-booking-settings.service';

@Module({
  imports: [AuthModule],
  controllers: [OwnerBookingSettingsController],
  providers: [OwnerBookingSettingsService],
})
export class OwnerBookingSettingsModule {}
