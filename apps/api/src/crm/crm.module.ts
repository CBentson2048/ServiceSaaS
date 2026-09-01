import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { AuthModule } from '../auth/auth.module';
import { FormulaChangeModule } from '../formula-change/formula-change.module';
import { LabFormulaModule } from '../lab-formula/lab-formula.module';
import { OperationalSignalsModule } from '../operational-signals/operational-signals.module';
import { CrmController } from './crm.controller';
import { CrmService } from './crm.service';

@Module({
  imports: [AuthModule, AuditModule, LabFormulaModule, FormulaChangeModule, OperationalSignalsModule],
  controllers: [CrmController],
  providers: [CrmService],
  exports: [CrmService],
})
export class CrmModule {}
