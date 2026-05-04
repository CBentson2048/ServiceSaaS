import { Module } from '@nestjs/common';
import { LabFormulaController } from './lab-formula.controller';
import { LabFormulaService } from './lab-formula.service';

@Module({
  controllers: [LabFormulaController],
  providers: [LabFormulaService],
})
export class LabFormulaModule {}
