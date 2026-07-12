import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { AuditModule } from '../audit/audit.module';
import { LabSessionModule } from '../lab-session/lab-session.module';
import { InventoryController, LabSessionInventoryController } from './inventory.controller';
import { InventoryService } from './inventory.service';

@Module({
  imports: [AuthModule, LabSessionModule, AuditModule],
  controllers: [InventoryController, LabSessionInventoryController],
  providers: [InventoryService],
})
export class InventoryModule {}
