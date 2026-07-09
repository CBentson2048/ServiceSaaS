import type { BusinessTier } from '@sheer/domain';
import { IsIn } from 'class-validator';

const BUSINESS_TIERS: BusinessTier[] = ['solo', 'studio', 'salon', 'group'];

export class UpdateAccountTierDto {
  @IsIn(BUSINESS_TIERS, { message: 'tier must be one of solo, studio, salon, group' })
  tier!: BusinessTier;
}
