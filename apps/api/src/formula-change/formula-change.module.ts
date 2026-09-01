import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { AuthModule } from '../auth/auth.module';
import { ClientFormulaChangeController, FormulaChangeSettingsController } from './formula-change.controller';
import { FormulaChangeService } from './formula-change.service';

/**
 * Formula change detection (V1.1, Wrike 4507283774).
 *
 * Imports Auth and Audit only. It is exported so the CRM client profile and
 * Colour Prep can embed an assessment in payloads they already build — but it
 * imports NEITHER of them, and nothing in the QLAB formula save or stock
 * reconciliation path imports this module. Detection is therefore structurally
 * incapable of failing a formula save or altering stock: it is a reader that
 * sits beside those workflows, never inside them.
 */
@Module({
  imports: [AuthModule, AuditModule],
  controllers: [ClientFormulaChangeController, FormulaChangeSettingsController],
  providers: [FormulaChangeService],
  exports: [FormulaChangeService],
})
export class FormulaChangeModule {}
