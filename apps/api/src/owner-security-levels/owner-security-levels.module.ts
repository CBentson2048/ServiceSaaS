import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { AuditModule } from '../audit/audit.module';
import { OwnerSecurityLevelsController } from './owner-security-levels.controller';
import { OwnerSecurityLevelsService } from './owner-security-levels.service';

@Module({
  imports: [AuthModule, AuditModule],
  controllers: [OwnerSecurityLevelsController],
  providers: [OwnerSecurityLevelsService],
  exports: [OwnerSecurityLevelsService],
})
export class OwnerSecurityLevelsModule {}
