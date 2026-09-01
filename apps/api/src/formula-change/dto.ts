import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsUUID, Max, Min } from 'class-validator';
import { FORMULA_CHANGE_BOUNDS } from '@sheer/domain';

/**
 * Sensitivity thresholds (Wrike section 22).
 *
 * Bounds are declared here, in @sheer/domain's `FORMULA_CHANGE_BOUNDS` and in
 * the CHECK constraints of migration 0105 — the same three numbers in all three
 * places, so `-200%` or `5000 levels` is impossible whichever door it arrives
 * through. `@IsInt` matters as much as the range: a fractional threshold would
 * make boundary behaviour ("exactly 30% is significant") ambiguous.
 *
 * `businessId` appears nowhere; it comes from the authenticated context.
 */
export class UpsertFormulaChangeSettingsDto {
  /** Omitted / null = the business-wide default. */
  @IsOptional()
  @IsUUID()
  locationId?: string | null;

  @IsInt()
  @Min(FORMULA_CHANGE_BOUNDS.compositionChangePercent.min)
  @Max(FORMULA_CHANGE_BOUNDS.compositionChangePercent.max)
  @Type(() => Number)
  compositionChangePercent!: number;

  @IsInt()
  @Min(FORMULA_CHANGE_BOUNDS.componentMaterialityPercent.min)
  @Max(FORMULA_CHANGE_BOUNDS.componentMaterialityPercent.max)
  @Type(() => Number)
  componentMaterialityPercent!: number;

  @IsInt()
  @Min(FORMULA_CHANGE_BOUNDS.developerVolumeDelta.min)
  @Max(FORMULA_CHANGE_BOUNDS.developerVolumeDelta.max)
  @Type(() => Number)
  developerVolumeDelta!: number;
}
