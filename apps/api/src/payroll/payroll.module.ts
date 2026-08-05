import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { AuthModule } from '../auth/auth.module';
import { EmailModule } from '../email/email.module';
import { PayrollController } from './payroll.controller';
import { PayrollSelfController } from './payroll-self.controller';
import { PayrollExportService } from './payroll-export.service';
import { PayrollInputsService } from './payroll-inputs.service';
import { PayrollPeriodService } from './payroll-period.service';
import { PayrollReadinessService } from './payroll-readiness.service';
import { PayrollService } from './payroll.service';
import { PayrollStructuresService } from './payroll-structures.service';

@Module({
  imports: [AuthModule, AuditModule, EmailModule],
  controllers: [PayrollController, PayrollSelfController],
  providers: [
    PayrollExportService,
    PayrollInputsService,
    PayrollPeriodService,
    PayrollReadinessService,
    PayrollService,
    PayrollStructuresService,
  ],
  exports: [PayrollService],
})
export class PayrollModule {}
