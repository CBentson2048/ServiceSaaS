import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import { AddFormulaItemDto, CaptureWeightDto, SaveFormulaDto, StartFormulaDto } from './dto';
import { LabFormulaService } from './lab-formula.service';

@Controller('lab/formulas')
export class LabFormulaController {
  constructor(private readonly labFormulaService: LabFormulaService) {}

  @Post('start')
  start(@Body() dto: StartFormulaDto) {
    return this.labFormulaService.start(dto);
  }

  @Get(':id')
  get(@Param('id') id: string) {
    return this.labFormulaService.get(id);
  }

  @Post(':id/items')
  addItem(@Param('id') id: string, @Body() dto: AddFormulaItemDto) {
    return this.labFormulaService.addItem(id, dto);
  }

  @Post(':id/capture-weight')
  captureWeight(@Param('id') id: string, @Body() dto: CaptureWeightDto) {
    return this.labFormulaService.captureWeight(id, dto);
  }

  @Post(':id/finish-mixing')
  finishMixing(@Param('id') id: string) {
    return this.labFormulaService.finishMixing(id);
  }

  @Post(':id/save')
  save(@Param('id') id: string, @Body() dto: SaveFormulaDto) {
    return this.labFormulaService.save(id, dto);
  }

  @Post(':id/recalculate')
  recalculate(@Param('id') id: string) {
    return this.labFormulaService.recalculate(id);
  }

  @Post(':id/duplicate')
  duplicate(@Param('id') id: string) {
    return this.labFormulaService.duplicate(id);
  }
}
