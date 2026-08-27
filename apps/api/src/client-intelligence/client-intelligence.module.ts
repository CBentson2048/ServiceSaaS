import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { ClientIntelligenceController } from './client-intelligence.controller';
import { ClientIntelligenceService } from './client-intelligence.service';

/**
 * Client Intelligence (V1.1 Week 7).
 *
 * `ClientIntelligenceService` is exported so the Week 7/8 retention campaigns,
 * the QLOOQO 10 Clients/Retention reports and (later) a ZAC tool can all consume
 * the SAME lapse calculation by injecting it — none of them re-derives cadence.
 */
@Module({
  imports: [AuthModule],
  controllers: [ClientIntelligenceController],
  providers: [ClientIntelligenceService],
  exports: [ClientIntelligenceService],
})
export class ClientIntelligenceModule {}
