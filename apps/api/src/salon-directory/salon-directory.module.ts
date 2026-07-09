import { Module } from '@nestjs/common';
import { SalonDirectoryController } from './salon-directory.controller';
import { SalonDirectoryService } from './salon-directory.service';

@Module({
  controllers: [SalonDirectoryController],
  providers: [SalonDirectoryService],
  exports: [SalonDirectoryService],
})
export class SalonDirectoryModule {}
