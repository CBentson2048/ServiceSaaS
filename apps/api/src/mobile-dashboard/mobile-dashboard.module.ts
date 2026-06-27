import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { OwnerTaxSettingsModule } from '../owner-tax-settings/owner-tax-settings.module';
import { MobileDashboardController } from './mobile-dashboard.controller';
import { MobileDashboardService } from './mobile-dashboard.service';

@Module({
  imports: [AuthModule, OwnerTaxSettingsModule],
  controllers: [MobileDashboardController],
  providers: [MobileDashboardService],
})
export class MobileDashboardModule {}
