import { Module } from '@nestjs/common';
import { LabSessionModule } from '../lab-session/lab-session.module';
import { LabBillingRulesController } from './lab-billing-rules.controller';
import { LabBillingRulesService } from './lab-billing-rules.service';

@Module({
  imports: [LabSessionModule],
  controllers: [LabBillingRulesController],
  providers: [LabBillingRulesService],
})
export class LabBillingRulesModule {}
