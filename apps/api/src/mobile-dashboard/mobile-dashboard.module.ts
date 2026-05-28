import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { MobileDashboardController } from './mobile-dashboard.controller';
import { MobileDashboardService } from './mobile-dashboard.service';

@Module({
  imports: [AuthModule],
  controllers: [MobileDashboardController],
  providers: [MobileDashboardService],
})
export class MobileDashboardModule {}
