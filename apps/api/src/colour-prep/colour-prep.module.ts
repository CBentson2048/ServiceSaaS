import { Module } from '@nestjs/common';
import { ColourPrepController } from './colour-prep.controller';
import { ColourPrepService } from './colour-prep.service';

/**
 * Colour Prep — V1.1 Week 6. Reads booking, lab and inventory data to answer
 * "what do we need to mix for the colour work coming up, and have we got it?".
 * Owns no tables of its own.
 */
@Module({
  controllers: [ColourPrepController],
  providers: [ColourPrepService],
  exports: [ColourPrepService],
})
export class ColourPrepModule {}
