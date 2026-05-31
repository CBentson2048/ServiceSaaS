import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { OwnerTaxSettingsController } from './owner-tax-settings.controller';
import { OwnerTaxSettingsService } from './owner-tax-settings.service';

@Module({
  imports: [AuthModule],
  controllers: [OwnerTaxSettingsController],
  providers: [OwnerTaxSettingsService],
  exports: [OwnerTaxSettingsService],
})
export class OwnerTaxSettingsModule {}
