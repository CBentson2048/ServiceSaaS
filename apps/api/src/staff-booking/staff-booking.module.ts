import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { AuditModule } from '../audit/audit.module';
import { CrmModule } from '../crm/crm.module';
import { PublicBookingModule } from '../public-booking/public-booking.module';
import { StaffBookingController } from './staff-booking.controller';
import { StaffBookingService } from './staff-booking.service';

@Module({
  imports: [AuthModule, PublicBookingModule, CrmModule, AuditModule],
  controllers: [StaffBookingController],
  providers: [StaffBookingService],
})
export class StaffBookingModule {}
