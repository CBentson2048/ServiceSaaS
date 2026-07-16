import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { LabSessionModule } from '../lab-session/lab-session.module';
import { LabFormulaController, LabSessionFormulaController } from './lab-formula.controller';
import { LabFormulaService } from './lab-formula.service';

@Module({
  imports: [AuthModule, LabSessionModule],
  controllers: [LabFormulaController, LabSessionFormulaController],
  providers: [LabFormulaService],
  exports: [LabFormulaService],
})
export class LabFormulaModule {}
