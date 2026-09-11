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
  // Exported for ZacModule (Phase 2 Workstream 3), which reads stock, dead
  // stock and low stock through this service with the resolved actor — exactly
  // as InventoryController does. Listing both modules in AppModule does NOT
  // share the provider; without this export Nest refuses to construct
  // ZacToolRegistryService and the whole API fails to boot (the failure
  // ColourPrepModule's own header documents).
  //
  // Exporting the class does NOT widen access: every method re-checks
  // `inventory.manage` and location scope via assertManagerOrOwner, and ZAC
  // narrows it to a read-only Pick<> port at the registry boundary so the write
  // methods are not callable from a tool.
  exports: [InventoryService],
})
export class InventoryModule {}
