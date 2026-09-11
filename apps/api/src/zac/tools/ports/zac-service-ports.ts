/**
 * Phase 2 Workstream 3 — READ-ONLY SERVICE PORTS.
 *
 * WHY THIS FILE EXISTS
 *
 * Workstreams 1 and 2 read services whose surface is almost entirely reads, so
 * "ZAC never writes" held by convention and code review. Workstream 3 is the
 * first to reach into services whose surface is mostly WRITES:
 *
 *   InventoryService  — 12 reads, 14 writes (adjustStock, recordConsumption,
 *                       initializeStock, createProduct, deleteSupplier, …)
 *   OrdersService     —  2 reads,  5 writes (generate, update, submit, cancel,
 *                       send — `generate` allocates a gapless purchase-order
 *                       number and emails a supplier)
 *
 * Convention is not a boundary when the write is one autocomplete away from the
 * read. These `Pick<>` types make it a COMPILE ERROR instead: a method absent
 * from the port does not exist as far as a tool is concerned. The registry
 * injects the full Nest provider and narrows it exactly once, at the
 * constructor boundary, so there is a single reviewable place where the
 * narrowing happens.
 *
 * This is structural, not nominal — `Pick<InventoryService, 'listStock'>`
 * accepts the real service and a hand-rolled test double alike, so the specs
 * need no @nestjs/testing and no cast to the full class.
 *
 * `import type` only: no value is imported, so this file creates no Nest
 * dependency and no runtime import cycle.
 *
 * SECOND LINE OF DEFENCE. Ports stop a tool CALLING a write. They do not stop
 * someone widening a Pick<> later. `zac-ws3-boundary.spec.ts` scans every WS3
 * tool source for write-method tokens, PII field tokens, `waste_events` and
 * bare percentage arithmetic, and fails on a hit.
 */
import type {
  BusinessLocationSummary,
  DeadStockThresholdSource,
  InventoryStockMovementType,
  StockUnit,
} from '@sheer/domain';
import type { ColourPrepService } from '../../../colour-prep/colour-prep.service';
import type { InventoryService } from '../../../inventory/inventory.service';
import type { LabAnalyticsService } from '../../../lab-analytics/lab-analytics.service';
import type { OrdersService } from '../../../orders/orders.service';

// ---------------------------------------------------------------------------
// Ports
// ---------------------------------------------------------------------------

/**
 * Stock reads. Deliberately EXCLUDES every mutation on InventoryService:
 * createProduct, updateProduct, archiveProduct, initializeStock, adjustStock,
 * updateStockThreshold, setProductAvailability, recordConsumption,
 * createCategory, updateCategory, deleteCategory, createSupplier,
 * updateSupplier, deleteSupplier.
 *
 * Also excludes the `*ForLabSession` variants: those authenticate through a
 * PIN-unlocked station session rather than a JWT actor, and ZAC is JWT-only.
 */
export type ZacInventoryRead = Pick<
  InventoryService,
  'listStock' | 'listLowStock' | 'listDeadStock' | 'listMovements' | 'listProducts' | 'listSuppliers' | 'listCategories'
>;

/**
 * Colour analytics. `summary` is the only member — `summaryForLabSession` is a
 * lab-session variant ZAC must never call.
 *
 * CAUTION, load-bearing: `summary` re-checks the caller's ROLE and location
 * scope but NOT `report.lab_analytics.view`. On the ZAC path that permission is
 * enforced solely by the tool's own `requiredPermissions` declaration. Weakening
 * that declaration silently hands colour financials — and, on `byStylist`, staff
 * pay data — to anyone holding `zac.access`.
 */
export type ZacLabAnalyticsRead = Pick<LabAnalyticsService, 'summary'>;

/** Planned-appointment/stock correlation. The service has exactly one public read. */
export type ZacColourPrepRead = Pick<ColourPrepService, 'getPlan'>;

/**
 * Ordering reads ONLY. `previewReorder` is the read-only computation added by
 * Workstream 3; `generate`, `update`, `submit`, `cancel` and `send` are absent
 * and therefore uncallable from a tool.
 *
 * `generate` is the dangerous one: it writes purchase orders AND emails
 * suppliers. `previewReorder` exists precisely so no tool ever needs it.
 */
export type ZacOrdersRead = Pick<OrdersService, 'list' | 'getOrder' | 'previewReorder'>;

// ---------------------------------------------------------------------------
// PII / pay-data projections
// ---------------------------------------------------------------------------

/**
 * PROJECTORS EXIST BECAUSE `sensitiveFields` DOES NOT WORK.
 *
 * `ZacReadOnlyTool.sensitiveFields` is declarative only — its own doc comment
 * says nothing reads it and listing a field there strips nothing. Masking has to
 * be executable code. These projector return types make it a TYPE ERROR to carry
 * a forbidden field into a tool payload, because the field simply is not on the
 * output type.
 *
 * Each projector is a pure function over a single row. Tools map with them
 * immediately after the service call and never retain the raw row.
 */

/**
 * Colour performance for ONE LOCATION. Note what is missing by construction:
 * there is no stylist projector anywhere in this file.
 *
 * `SheerLabAnalyticsResponse.byStylist` carries `stylistName`, `hourlyRate`,
 * `contractedHours` and `averageBillBenchmark`, read straight from
 * `core.staff_profiles` under `report.lab_analytics.view` with NO payroll
 * permission anywhere in the path. A ZAC tool naming a stylist's colour margin
 * would also be disclosing their hourly rate to anyone with a reporting key.
 * `byStylist` is therefore never read, never projected and never summarised.
 */
export interface ZacSafeColourLocation {
  locationId: string;
  locationName: string;
  colourRevenueCents: number;
  formulaCostCents: number;
  grossMarginCents: number;
  formulasMixed: number;
  wasteCostCents: number;
  currencyCode: string;
}

export function projectColourLocation(row: {
  locationId: string;
  locationName: string;
  colourRevenueCents: number;
  formulaCostCents: number;
  grossMarginCents: number;
  formulasMixed: number;
  wasteCostCents: number;
  currencyCode: string;
}): ZacSafeColourLocation {
  return {
    locationId: row.locationId,
    locationName: row.locationName,
    colourRevenueCents: row.colourRevenueCents,
    formulaCostCents: row.formulaCostCents,
    grossMarginCents: row.grossMarginCents,
    formulasMixed: row.formulasMixed,
    wasteCostCents: row.wasteCostCents,
    currencyCode: row.currencyCode,
  };
}

/** A product is not a person; the whole row is safe. Projected for symmetry and to pin the shape. */
export interface ZacSafeStockLevel {
  locationId: string;
  locationName: string;
  productId: string;
  productName: string;
  brand?: string;
  quantityOnHandGrams: number;
  effectiveLowStockThresholdGrams: number;
  isLowStock: boolean;
  updatedAt: string;
}

export function projectStockLevel(row: {
  locationId: string;
  locationName: string;
  productId: string;
  productName: string;
  brand?: string;
  quantityOnHandGrams: number;
  effectiveLowStockThresholdGrams: number;
  isLowStock: boolean;
  updatedAt: string;
}): ZacSafeStockLevel {
  return {
    locationId: row.locationId,
    locationName: row.locationName,
    productId: row.productId,
    productName: row.productName,
    ...(row.brand === undefined ? {} : { brand: row.brand }),
    quantityOnHandGrams: row.quantityOnHandGrams,
    effectiveLowStockThresholdGrams: row.effectiveLowStockThresholdGrams,
    isLowStock: row.isLowStock,
    updatedAt: row.updatedAt,
  };
}

/**
 * Dead stock. `thresholdSource` and `thresholdDays` are carried DELIBERATELY:
 * on the live data every row is flagged against a threshold the location itself
 * configured (Kensington sets 30 days against a platform default of 90), so the
 * verdict is a function of a setting the owner controls. Reporting the verdict
 * without its threshold would present a configuration choice as a business
 * finding.
 */
export interface ZacSafeDeadStock {
  locationId: string;
  locationName: string;
  productId: string;
  productName: string;
  brand?: string;
  supplierName?: string;
  quantityOnHandGrams: number;
  stockUnit: StockUnit;
  daysIdle: number;
  thresholdDays: number;
  thresholdSource: DeadStockThresholdSource;
  lastOutboundAt?: string;
  /** Undefined when the product records no cost — NEVER coerced to 0. */
  estimatedValueCents?: number;
}

export function projectDeadStock(row: {
  locationId: string;
  locationName: string;
  productId: string;
  productName: string;
  brand?: string;
  supplierName?: string;
  quantityOnHandGrams: number;
  stockUnit: StockUnit;
  daysIdle: number;
  thresholdDays: number;
  thresholdSource: DeadStockThresholdSource;
  lastOutboundAt?: string;
  estimatedValueCents?: number;
}): ZacSafeDeadStock {
  return {
    locationId: row.locationId,
    locationName: row.locationName,
    productId: row.productId,
    productName: row.productName,
    ...(row.brand === undefined ? {} : { brand: row.brand }),
    ...(row.supplierName === undefined ? {} : { supplierName: row.supplierName }),
    quantityOnHandGrams: row.quantityOnHandGrams,
    stockUnit: row.stockUnit,
    daysIdle: row.daysIdle,
    thresholdDays: row.thresholdDays,
    thresholdSource: row.thresholdSource,
    ...(row.lastOutboundAt === undefined ? {} : { lastOutboundAt: row.lastOutboundAt }),
    // Left ABSENT rather than zeroed. A cost-less product contributing 0 to a
    // value total is the single easiest way to under-report dead capital.
    ...(row.estimatedValueCents === undefined ? {} : { estimatedValueCents: row.estimatedValueCents }),
  };
}

/**
 * A stock movement, WITHOUT the actor.
 *
 * `InventoryStockMovement` resolves `created_by` into `createdByName` — a staff
 * member's display name. WS3 reads movements for ONE purpose: how recent is the
 * ledger. Who moved the stock is never part of that answer, and surfacing it
 * would turn a stock question into staff surveillance.
 */
export interface ZacSafeMovement {
  locationId: string;
  locationName: string;
  productId: string;
  productName: string;
  movementType: InventoryStockMovementType;
  quantityDeltaGrams: number;
  createdAt: string;
}

export function projectMovement(row: {
  locationId: string;
  locationName: string;
  productId: string;
  productName: string;
  movementType: InventoryStockMovementType;
  quantityDeltaGrams: number;
  createdAt: string;
}): ZacSafeMovement {
  return {
    locationId: row.locationId,
    locationName: row.locationName,
    productId: row.productId,
    productName: row.productName,
    movementType: row.movementType,
    quantityDeltaGrams: row.quantityDeltaGrams,
    createdAt: row.createdAt,
  };
}

/**
 * Colour-prep product requirement.
 *
 * There is NO projector for `ColourPrepAppointment`, and that omission is the
 * control: `ColourPrepAppointment.clientName` is a client's full name and
 * `stylistName` is a staff member's. The colour-prep tool reads `plan.products`,
 * `plan.summary` and the window fields only — never `plan.appointments` — which
 * is what makes its `piiLevel: 'none'` structurally true rather than merely
 * asserted.
 */
export interface ZacSafePrepRequirement {
  productId?: string;
  productName: string;
  brand?: string;
  stockUnit: StockUnit;
  requiredGrams: number;
  onHandGrams: number;
  shortfallGrams: number;
  state: 'sufficient' | 'low_stock' | 'shortfall' | 'not_stocked' | 'unmapped_product';
  appointmentCount: number;
}

export function projectPrepRequirement(row: {
  productId?: string;
  productName: string;
  brand?: string;
  stockUnit: StockUnit;
  requiredGrams: number;
  onHandGrams: number;
  shortfallGrams: number;
  state: 'sufficient' | 'low_stock' | 'shortfall' | 'not_stocked' | 'unmapped_product';
  appointmentCount: number;
}): ZacSafePrepRequirement {
  return {
    ...(row.productId === undefined ? {} : { productId: row.productId }),
    productName: row.productName,
    ...(row.brand === undefined ? {} : { brand: row.brand }),
    stockUnit: row.stockUnit,
    requiredGrams: row.requiredGrams,
    onHandGrams: row.onHandGrams,
    shortfallGrams: row.shortfallGrams,
    state: row.state,
    appointmentCount: row.appointmentCount,
  };
}

/** Location identity is not PII and every tool needs it to name a site. */
export function projectLocation(row: BusinessLocationSummary): { id: string; name: string } {
  return { id: row.id, name: row.name };
}
