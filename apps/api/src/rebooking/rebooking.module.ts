import { Module } from '@nestjs/common';
import { RebookingService } from './rebooking.service';

@Module({
  providers: [RebookingService],
  exports: [RebookingService],
})
export class RebookingModule {}
