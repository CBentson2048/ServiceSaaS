import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { ReportAccessGuard } from './report-access.guard';
import { ReportAvailabilityGuard } from './report-availability.guard';
import { ReportScopeService } from './report-scope.service';
import { reportSurfaceProvider } from './report-surface';
import { ReportsController } from './reports.controller';

/** QLOOQO 10 report foundation (V1.1 Week 8 Ticket A). */
@Module({
  imports: [AuthModule],
  controllers: [ReportsController],
  providers: [reportSurfaceProvider, ReportScopeService, ReportAvailabilityGuard, ReportAccessGuard],
  exports: [ReportScopeService],
})
export class ReportsModule {}
