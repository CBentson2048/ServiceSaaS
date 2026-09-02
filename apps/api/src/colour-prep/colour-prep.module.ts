import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { FormulaChangeModule } from '../formula-change/formula-change.module';
import { ColourPrepController } from './colour-prep.controller';
import { ColourPrepService } from './colour-prep.service';

/**
 * Colour Prep — V1.1 Week 6. Reads booking, lab and inventory data to answer
 * "what do we need to mix for the colour work coming up, and have we got it?".
 * Owns no tables of its own.
 *
 * Imports FormulaChangeModule because ColourPrepService injects
 * FormulaChangeService to flag a changed formula on the prep list (Week 7,
 * Wrike 4507283774). That import is what makes the dependency resolvable —
 * listing both modules in AppModule does NOT share their providers, and Nest
 * refused to construct ColourPrepService without it, so the whole API failed to
 * boot. CrmModule takes the same service by the same explicit import.
 */
@Module({
  imports: [AuthModule, FormulaChangeModule],
  controllers: [ColourPrepController],
  providers: [ColourPrepService],
  exports: [ColourPrepService],
})
export class ColourPrepModule {}
