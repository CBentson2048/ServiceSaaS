import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { RetailPricingModule } from '../retail-pricing/retail-pricing.module';
import { RetailSalesController } from './retail-sales.controller';
import { RetailSalesService } from './retail-sales.service';

@Module({
  imports: [AuthModule, RetailPricingModule],
  controllers: [RetailSalesController],
  providers: [RetailSalesService],
  exports: [RetailSalesService],
})
export class RetailSalesModule {}
