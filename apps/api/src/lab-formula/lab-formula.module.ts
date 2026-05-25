import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { LabFormulaController } from './lab-formula.controller';
import { LabFormulaService } from './lab-formula.service';

@Module({
  imports: [AuthModule],
  controllers: [LabFormulaController],
  providers: [LabFormulaService],
})
export class LabFormulaModule {}
