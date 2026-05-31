import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { OwnerBillingSettingsController } from './owner-billing-settings.controller';
import { OwnerBillingSettingsService } from './owner-billing-settings.service';

@Module({
  imports: [AuthModule],
  controllers: [OwnerBillingSettingsController],
  providers: [OwnerBillingSettingsService],
  exports: [OwnerBillingSettingsService],
})
export class OwnerBillingSettingsModule {}
