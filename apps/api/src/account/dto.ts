import type { BusinessTier } from '@sheer/domain';
import { IsIn } from 'class-validator';

const BUSINESS_TIERS: BusinessTier[] = ['spark', 'pulse', 'infinity'];

export class UpdateAccountTierDto {
  @IsIn(BUSINESS_TIERS, { message: 'tier must be one of spark, pulse, infinity' })
  tier!: BusinessTier;
}
