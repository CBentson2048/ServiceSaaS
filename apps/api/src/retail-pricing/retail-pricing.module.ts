import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { AuthModule } from '../auth/auth.module';
import { RetailPricingController } from './retail-pricing.controller';
import { RetailPricingService } from './retail-pricing.service';

@Module({
  imports: [AuthModule, AuditModule],
  controllers: [RetailPricingController],
  providers: [RetailPricingService],
  exports: [RetailPricingService],
})
export class RetailPricingModule {}
