import { Controller, Get, Param, Query } from '@nestjs/common';
import type { SalonLookupResponse, SalonSearchResponse } from '@sheer/domain';
import { SalonCodeParamDto, SalonSearchQueryDto } from './dto';
import { SalonDirectoryService } from './salon-directory.service';

/**
 * Public salon directory. Unauthenticated on purpose — this is how clients find
 * a salon by its Salon Code or name before booking (Week 9 Salon Suite).
 */
@Controller('public/salons')
export class SalonDirectoryController {
  constructor(private readonly directory: SalonDirectoryService) {}

  @Get()
  async search(@Query() query: SalonSearchQueryDto): Promise<SalonSearchResponse> {
    return { salons: await this.directory.search(query.query) };
  }

  @Get(':code')
  async lookup(@Param() params: SalonCodeParamDto): Promise<SalonLookupResponse> {
    return { salon: await this.directory.lookupByCode(params.code) };
  }
}
