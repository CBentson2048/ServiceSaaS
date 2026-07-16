import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { LabFormulaModule } from '../lab-formula/lab-formula.module';
import { CrmController } from './crm.controller';
import { CrmService } from './crm.service';

@Module({
  imports: [AuthModule, LabFormulaModule],
  controllers: [CrmController],
  providers: [CrmService],
  exports: [CrmService],
})
export class CrmModule {}
