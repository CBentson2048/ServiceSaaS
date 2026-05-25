import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { LabAnalyticsController } from './lab-analytics.controller';
import { LabAnalyticsService } from './lab-analytics.service';

@Module({
  imports: [AuthModule],
  controllers: [LabAnalyticsController],
  providers: [LabAnalyticsService],
})
export class LabAnalyticsModule {}
