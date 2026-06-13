import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { LabSessionModule } from '../lab-session/lab-session.module';
import { LabAnalyticsController, LabSessionAnalyticsController } from './lab-analytics.controller';
import { LabAnalyticsService } from './lab-analytics.service';

@Module({
  imports: [AuthModule, LabSessionModule],
  controllers: [LabAnalyticsController, LabSessionAnalyticsController],
  providers: [LabAnalyticsService],
})
export class LabAnalyticsModule {}
