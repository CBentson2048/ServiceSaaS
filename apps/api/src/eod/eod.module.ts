import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { AuthModule } from '../auth/auth.module';
import { EodController } from './eod.controller';
import { EodService } from './eod.service';

@Module({
  imports: [AuthModule, AuditModule],
  controllers: [EodController],
  providers: [EodService],
  exports: [EodService],
})
export class EodModule {}
