import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { AuditModule } from '../audit/audit.module';
import { EmailModule } from '../email/email.module';
import { OwnerStaffController } from './owner-staff.controller';
import { StaffInvitationsController } from './staff-invitations.controller';
import { StaffService } from './staff.service';

@Module({
  imports: [AuthModule, EmailModule, AuditModule],
  controllers: [OwnerStaffController, StaffInvitationsController],
  providers: [StaffService],
  exports: [StaffService],
})
export class StaffModule {}
