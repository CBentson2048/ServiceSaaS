import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { LocationsController } from './locations.controller';
import { LocationsService } from './locations.service';
import { OwnerLocationsController } from './owner-locations.controller';

@Module({
  imports: [AuthModule],
  controllers: [LocationsController, OwnerLocationsController],
  providers: [LocationsService],
  exports: [LocationsService],
})
export class LocationsModule {}
