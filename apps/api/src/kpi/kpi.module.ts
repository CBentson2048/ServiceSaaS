import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { KpiController } from './kpi.controller';
import { KpiService } from './kpi.service';
import { UtilisationService } from './utilisation.service';

@Module({
  imports: [AuthModule],
  controllers: [KpiController],
  providers: [KpiService, UtilisationService],
  exports: [KpiService, UtilisationService],
})
export class KpiModule {}
