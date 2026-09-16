import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { AuthModule } from '../auth/auth.module';
import { MONEY_SOURCE, SupabaseMoneySource } from '../reports/money/money-source';
import { EodController } from './eod.controller';
import { EodService } from './eod.service';

@Module({
  imports: [AuthModule, AuditModule],
  controllers: [EodController],
  // The location currency comes from R1's reader, so End of Day and the reports
  // share one rule.
  providers: [EodService, { provide: MONEY_SOURCE, useClass: SupabaseMoneySource }],
  exports: [EodService],
})
export class EodModule {}
