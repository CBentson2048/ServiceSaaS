// Tax configuration contracts + the single trusted tax logic layer.
export * from './tax';
// Financial Rules Engine contracts (payroll, commission, settlement).
export * from './payroll';
// Client Intelligence contracts + the single trusted lapsed-client calculation.
export * from './client-intelligence';

export * from './campaigns';

export * from './formula-change';

export * from './operational-signals';

export * from './message-usage';
// In-app notification contracts + the canonical notification-type registry.
export * from './notifications';
// Upsell contracts + the canonical rule/pattern precedence and ranking.
export * from './upsell';
// ZAC routing inspector: the closed routing vocabulary + its one display label set.
export * from './zac-routing';
// Local calendar dates ('YYYY-MM-DD'): validation and day counts, no timezone.
export * from './local-date';
// QLOOQO 10 reporting foundation: report registry, fail-closed access, filter codec.
export * from './reporting';
export * from './money-report';
export * from './cash-up-report';
export * from './team-report';
import type { AppointmentBillingTax } from './tax';
import type { FormulaChangeAssessment } from './formula-change';
import type { NoShowRiskSignal, SpendTrendSignal } from './operational-signals';

export type UserRole = 'owner' | 'manager' | 'stylist' | 'client';

export type AppSurface = 'sheer_app' | 'sheer_lab' | 'web_dashboard' | 'api';

/**
 * Account product tier. The single account-level flag that drives every
 * downstream feature limit and upgrade prompt. Sliced by BOOKABLE COLUMNS
 * (bookable service providers); non-bookable staff (reception, managers,
 * assistants, apprentices) never count.
 *
 * - `spark`    — independent professional. 1 location, 1 bookable column (hard
 *                cap: a 2nd column means upgrading to Pulse).
 * - `pulse`    — single-location salon. 1 location, 5 included bookable columns
 *                (extra columns are billable, not blocked).
 * - `infinity` — multi-location / enterprise. Unlimited locations, 10 included
 *                bookable columns per location (extras billable).
 *
 * All three are chosen explicitly at sign-up (there is no automatic usage-based
 * upgrade). Tiers NEVER gate inventory or colour tracking — those are core
 * product at every tier from day one.
 */
export type BusinessTier = 'spark' | 'pulse' | 'infinity';

/** Lowest → highest tier. Used to compare and order tiers. */
export const BUSINESS_TIER_ORDER: readonly BusinessTier[] = ['spark', 'pulse', 'infinity'];

export interface BusinessTierLimits {
  tier: BusinessTier;
  /** Max active locations, or `null` for unlimited. */
  maxLocations: number | null;
  /**
   * Included bookable columns (bookable service providers) per location. `null`
   * means unbounded. Where {@link bookableColumnsHardCapped} is false, columns
   * beyond this are allowed and billed separately (billing is a separate ticket);
   * where true, the included count is a hard cap.
   */
  includedBookableColumnsPerLocation: number | null;
  /**
   * When true, {@link includedBookableColumnsPerLocation} is a HARD cap — adding
   * another bookable column requires a tier upgrade. When false, extra columns
   * are permitted (billable). Only Spark is hard-capped.
   */
  bookableColumnsHardCapped: boolean;
  /**
   * Included outbound billable messages (WhatsApp/SMS) per location per calendar
   * month before overage. `null` for unlimited. Enforcement (counters + overage)
   * lands in Week 6; this is the authoritative cap the counters snapshot against.
   */
  messagingMonthlyCapPerLocation: number | null;
}

/**
 * Feature limits per tier. The authoritative source consumed by the API when
 * enforcing limits and by the web/mobile clients when rendering plan usage.
 */
export const BUSINESS_TIER_LIMITS: Record<BusinessTier, BusinessTierLimits> = {
  spark: {
    tier: 'spark',
    maxLocations: 1,
    includedBookableColumnsPerLocation: 1,
    bookableColumnsHardCapped: true,
    messagingMonthlyCapPerLocation: 100,
  },
  pulse: {
    tier: 'pulse',
    maxLocations: 1,
    includedBookableColumnsPerLocation: 5,
    bookableColumnsHardCapped: false,
    messagingMonthlyCapPerLocation: 600,
  },
  infinity: {
    tier: 'infinity',
    maxLocations: null,
    includedBookableColumnsPerLocation: 10,
    bookableColumnsHardCapped: false,
    messagingMonthlyCapPerLocation: 1000,
  },
};

/** Human-friendly tier labels for UI. */
export const BUSINESS_TIER_LABELS: Record<BusinessTier, string> = {
  spark: 'Spark',
  pulse: 'Pulse',
  infinity: 'Infinity',
};

/** One-line "who it's for" positioning per tier, for pricing/onboarding UIs. */
export const BUSINESS_TIER_TAGLINES: Record<BusinessTier, string> = {
  spark: 'For independent professionals — 1 bookable column.',
  pulse: 'For single-location salons — 5 bookable columns included.',
  infinity: 'For multi-location businesses — 10 bookable columns per location.',
};

/** Limits for a tier, defaulting to the safest (spark) for unknown values. */
export function getBusinessTierLimits(tier: BusinessTier | null | undefined): BusinessTierLimits {
  return (tier && BUSINESS_TIER_LIMITS[tier]) || BUSINESS_TIER_LIMITS.spark;
}

/**
 * Included monthly messaging allowance (billable channels) per location for a
 * tier; `null` means unlimited. Defaults to the spark cap for unknown tiers.
 */
export function getMessagingMonthlyCap(tier: BusinessTier | null | undefined): number | null {
  return getBusinessTierLimits(tier).messagingMonthlyCapPerLocation;
}

/**
 * The tier to recommend upgrading to when a limit is hit, or `null` if the
 * current tier already covers the need.
 *
 * - `columns`   — needs another bookable column. Only Spark is hard-capped, so
 *                 Spark → Pulse; Pulse/Infinity permit extra (billable) columns.
 * - `locations` — needs more than one location → Infinity (Spark and Pulse are
 *                 single-location).
 */
export function suggestTierUpgrade(
  current: BusinessTier,
  reason: 'columns' | 'locations',
): BusinessTier | null {
  if (reason === 'columns') {
    return current === 'spark' ? 'pulse' : null;
  }
  return current === 'infinity' ? null : 'infinity';
}

export type AllowedLocationScope =
  | { kind: 'all'; locationIds: string[] }
  | { kind: 'locations'; locationIds: string[] }
  | { kind: 'self'; locationIds: string[] };

export interface AuthLocation {
  id: string;
  name: string;
  code?: string;
  slug?: string;
}

export interface AuthProfileSummary {
  id: string;
  email: string;
  firstName?: string;
  lastName?: string;
  fullName: string;
  displayName?: string;
  phone?: string;
  avatarUrl?: string;
  isActive?: boolean;
}

export interface AuthUser {
  id: string;
  /**
   * Every active role this user holds in the current business. A single user
   * can legitimately be owner AND manager AND stylist at once, so this is the
   * authoritative source for authorization — gate capabilities with
   * `userHasRole(user, …)` / `userHasAnyRole(user, …)`, never on a single role.
   * Ordered highest-privilege first (owner > manager > stylist > client).
   */
  roles: UserRole[];
  /**
   * Highest-privilege role (= `roles[0]`). Use ONLY to pick a default landing
   * surface and for display/echo — never to gate a capability a secondary role
   * grants, or a multi-role user silently loses access to it.
   */
  primaryRole: UserRole;
  /**
   * The business this session is resolved against. Empty string ('') for a
   * customer who has registered but not yet joined any salon — they hold no
   * membership until their first booking creates one (see {@link userHasJoinedSalon}).
   * Business-scoped API endpoints are unreachable for such a user; never query
   * with an empty businessId — branch on `userHasJoinedSalon` first.
   */
  businessId: string;
  businessName?: string;
  businessSlug?: string;
  /** Account product tier of the current business. Drives feature limits. */
  businessTier?: BusinessTier;
  allowedLocationIds: string[];
  locationScope: AllowedLocationScope;
  locations: AuthLocation[];
  profile: AuthProfileSummary;
  staffProfileId?: string;
  clientProfileId?: string;
  clientCode?: string;
  clientCommunicationPreference?: 'whatsapp' | 'sms' | 'email';
  /** IANA timezone for the signed-in user (e.g. 'Europe/London'). Drives app-wide date/time display. */
  timezone?: string;
  /**
   * Effective, resolved permission keys for the current business — the union of
   * every membership's security-level permissions (or base-role defaults when a
   * membership has no level). Gate feature/report/financial access with
   * {@link userHasPermission}. Owners always hold every permission.
   */
  permissions: Permission[];
  /**
   * Per-membership report grants (QLOOQO 10). One entry per ACTIVE MANAGER
   * membership at a location of this business whose security level is
   * explicitly assigned, exists and belongs to this business. Unlike
   * {@link permissions} there is no role-default fallback: a NULL level grants
   * nothing, and stylist memberships never grant. Omitted for owners, who may
   * open every report. Absent means no grants. Read it only through
   * `canOpenReport` / `reportLocationIds`.
   */
  membershipGrants?: MembershipGrant[];
}

/** One manager membership's explicit security-level permissions, for reporting. */
export interface MembershipGrant {
  locationId: string;
  /** The level's permissions, expanded over prerequisites. */
  permissions: Permission[];
}

/**
 * Role privilege ranking — lower number = higher privilege. The single source
 * of truth for "primary role" selection across the platform (auth resolution,
 * surface routing, display). Keep aligned with the membership role enum.
 */
export const ROLE_PRIORITY: Record<UserRole, number> = {
  owner: 0,
  manager: 1,
  stylist: 2,
  client: 3,
};

/** Sort roles highest-privilege first and drop duplicates. */
export function sortRolesByPriority(roles: readonly UserRole[]): UserRole[] {
  return [...new Set(roles)].sort((a, b) => ROLE_PRIORITY[a] - ROLE_PRIORITY[b]);
}

/** The highest-privilege role in a set (owner > manager > stylist > client). */
export function pickPrimaryRole(roles: readonly UserRole[]): UserRole {
  return sortRolesByPriority(roles)[0];
}

/**
 * True when the user actively holds the given role. Null-safe: a missing user
 * (e.g. an optional `auth.user`) returns false, so call sites can pass
 * `auth.user` directly without a separate guard.
 */
export function userHasRole(user: Pick<AuthUser, 'roles'> | null | undefined, role: UserRole): boolean {
  return !!user && user.roles.includes(role);
}

/** True when the user actively holds ANY of the given roles. Null-safe (see {@link userHasRole}). */
export function userHasAnyRole(
  user: Pick<AuthUser, 'roles'> | null | undefined,
  roles: readonly UserRole[],
): boolean {
  return !!user && user.roles.some((role) => roles.includes(role));
}

/**
 * True once the user belongs to at least one salon — i.e. they hold a resolved
 * business context. False for a freshly-registered customer who has not booked
 * anywhere yet ({@link AuthUser.businessId} is ''). Use this, not a truthy check
 * on businessId, to gate salon-scoped UI (dashboards, bookings) vs. the
 * "find a salon & book your first appointment" onboarding state.
 */
export function userHasJoinedSalon(user: Pick<AuthUser, 'businessId'> | null | undefined): boolean {
  return !!user && user.businessId !== '';
}

// ===========================================================================
// Expanded security model — configurable permissions & security levels.
// A "security level" is a named set of permissions an owner assigns to team
// members, layered on top of the base membership role (which still drives DB
// scoping/RLS). System levels mirror the base roles (incl. Receptionist and
// Group Admin); owners can also create custom levels (e.g. Senior Stylist,
// Bookkeeper view-only). See migration 0055.
// ===========================================================================

/**
 * Every permission key the platform understands. `report.*` keys gate visibility
 * of reports/financial data; the rest gate feature access. This is the fixed
 * catalogue consumed by both the API guard and the client UI — later weeks add
 * new keys here and reference them, never invent ad-hoc strings.
 */
export type Permission =
  // Reports / financial visibility
  | 'report.dashboard.view'
  | 'report.performance.view'
  | 'report.commission.view'
  | 'report.financials.view'
  | 'report.lab_analytics.view'
  | 'report.pnl.view'
  // Operational features
  | 'bookings.manage'
  | 'bookings.services.modify_after_checkin'
  | 'crm.view'
  | 'crm.manage'
  | 'inventory.manage'
  | 'services.view'
  | 'services.manage'
  | 'rota.view'
  | 'rota.manage'
  | 'retail.record'
  | 'bills.view'
  | 'eod.manage'
  | 'eod.sign_off'
  // Ordering (Week 6 tickets 8/9)
  | 'orders.view'
  | 'orders.manage'
  | 'orders.approve'
  // Team / staff
  | 'staff.view'
  | 'staff.manage'
  | 'staff.pay.manage'
  // Business administration
  | 'locations.manage'
  | 'settings.location.manage'
  | 'settings.billing.manage'
  | 'settings.tax.manage'
  | 'settings.booking.manage'
  | 'account.manage'
  | 'security.manage'
  | 'audit.read'
  // Intelligence (ZAC)
  | 'zac.access'
  // Payroll / Financial Rules Engine
  | 'payroll.view'
  | 'payroll.edit'
  | 'payroll.approve'
  | 'payroll.lock'
  | 'payroll.export'
  | 'payroll.email'
  | 'payroll.self.view';

export type PermissionKind = 'report' | 'feature';

export interface PermissionDefinition {
  key: Permission;
  label: string;
  description: string;
  kind: PermissionKind;
  /** Coarse grouping for UI (e.g. 'Reports & financials', 'Team', 'Settings'). */
  group: string;
  /**
   * Direct prerequisite permissions. Granting this key is meaningless without
   * these (e.g. `crm.manage` needs `crm.view`; the Appointment Book needs the
   * read side of services/rota/clients to render). The full catalogue forms a
   * dependency tree: use {@link expandPermissions} to close a selection over its
   * prerequisites, and {@link getPermissionDependents} for the reverse edge.
   */
  requires?: Permission[];
}

/** The full, ordered permission catalogue (source of truth for the UI + guard). */
export const PERMISSION_CATALOG: readonly PermissionDefinition[] = [
  { key: 'report.dashboard.view', label: 'Dashboard', description: 'View the business dashboard and its KPIs.', kind: 'report', group: 'Reports & financials' },
  { key: 'report.performance.view', label: 'Team performance', description: 'View stylist performance reports.', kind: 'report', group: 'Reports & financials' },
  { key: 'report.commission.view', label: 'Commission', description: 'View commission figures and readiness.', kind: 'report', group: 'Reports & financials' },
  { key: 'report.financials.view', label: 'Financials (revenue)', description: 'View revenue and retail sales figures.', kind: 'report', group: 'Reports & financials' },
  { key: 'report.lab_analytics.view', label: 'Colour lab analytics', description: 'View Qlooqo Lab analytics and margins.', kind: 'report', group: 'Reports & financials' },
  // Owner-only by default: in no manager role default and no system security
  // level (see SYSTEM_SECURITY_LEVELS). An owner delegates it by adding it to a
  // custom level. Catalogue-only — owners hold it through ALL_PERMISSIONS, so no
  // migration seeds it. Deliberately no `requires` edge.
  { key: 'report.pnl.view', label: 'Profit & loss', description: 'View the profit and loss report, including revenue and costs. Owners only unless granted here.', kind: 'report', group: 'Reports & financials' },
  { key: 'crm.view', label: 'View clients', description: 'View client records.', kind: 'feature', group: 'Front of house' },
  { key: 'crm.manage', label: 'Manage clients', description: 'Create and edit client records.', kind: 'feature', group: 'Front of house', requires: ['crm.view'] },
  { key: 'services.view', label: 'View services', description: 'View the service catalogue without changing it.', kind: 'feature', group: 'Operations' },
  { key: 'rota.view', label: 'View rota', description: 'View working hours and rota coverage without changing shifts.', kind: 'feature', group: 'Operations' },
  { key: 'bookings.manage', label: 'Manage bookings', description: 'Create and manage appointments (needs read access to clients, services and rota).', kind: 'feature', group: 'Front of house', requires: ['crm.view', 'services.view', 'rota.view'] },
  { key: 'bookings.services.modify_after_checkin', label: 'Amend services during a visit', description: 'Add, remove or replace services on an appointment after the client has checked in, up to payment. Every change is recorded with who made it.', kind: 'feature', group: 'Front of house', requires: ['bookings.manage'] },
  { key: 'retail.record', label: 'Record retail sales', description: 'Take retail sales at the till.', kind: 'feature', group: 'Front of house' },
  // Seeded into core.security_levels by migration 0086 — this catalog entry is the
  // mandatory other half (auth.service / owner-security-levels strip keys missing
  // from ALL_PERMISSIONS on read and save).
  { key: 'bills.view', label: 'Bill finder', description: 'Search and open the stored bills of completed visits.', kind: 'feature', group: 'Front of house' },
  // Seeded into core.security_levels by migration 0088 (blocker B1 pairing).
  { key: 'eod.manage', label: 'End of day', description: 'Open the trading day, enter counted takings, float and petty cash.', kind: 'feature', group: 'Front of house' },
  { key: 'eod.sign_off', label: 'End of day sign-off', description: 'Sign off the daily cash-up, freezing its variance permanently.', kind: 'feature', group: 'Front of house', requires: ['eod.manage'] },
  { key: 'inventory.manage', label: 'Manage inventory', description: 'Manage products and stock.', kind: 'feature', group: 'Operations' },
  // Seeded into core.security_levels by migration 0094 — these catalog entries are
  // the mandatory other half (keys missing from ALL_PERMISSIONS are stripped on save).
  { key: 'orders.view', label: 'View purchase orders', description: 'View draft and sent supplier orders and their history.', kind: 'feature', group: 'Operations' },
  { key: 'orders.manage', label: 'Prepare purchase orders', description: 'Generate, edit and submit draft supplier orders ready for sending.', kind: 'feature', group: 'Operations', requires: ['orders.view'] },
  { key: 'orders.approve', label: 'Send orders to suppliers', description: 'Email submitted orders to suppliers. This is the spend control: remove it to require someone else to send what a manager prepares.', kind: 'feature', group: 'Operations', requires: ['orders.view'] },
  { key: 'services.manage', label: 'Manage services', description: 'Manage the service catalogue.', kind: 'feature', group: 'Operations', requires: ['services.view'] },
  { key: 'rota.manage', label: 'Manage rota', description: 'Manage schedules and shifts.', kind: 'feature', group: 'Operations', requires: ['rota.view'] },
  { key: 'staff.view', label: 'View team', description: 'View the team list.', kind: 'feature', group: 'Team' },
  { key: 'staff.manage', label: 'Manage team', description: 'Invite, edit and deactivate team members.', kind: 'feature', group: 'Team', requires: ['staff.view'] },
  { key: 'staff.pay.manage', label: 'Manage pay & commission', description: 'View and edit pay, rates and commission fields.', kind: 'feature', group: 'Team', requires: ['staff.manage'] },
  { key: 'locations.manage', label: 'Manage locations', description: 'Create and edit locations.', kind: 'feature', group: 'Settings' },
  { key: 'settings.location.manage', label: 'Location settings', description: 'Edit location record, thresholds and fixed costs.', kind: 'feature', group: 'Settings' },
  { key: 'settings.billing.manage', label: 'Billing settings', description: 'Edit product auto-billing settings.', kind: 'feature', group: 'Settings' },
  { key: 'settings.tax.manage', label: 'Tax settings', description: 'Edit tax configuration.', kind: 'feature', group: 'Settings' },
  { key: 'settings.booking.manage', label: 'Booking settings', description: 'Edit online booking and notification settings.', kind: 'feature', group: 'Settings' },
  { key: 'account.manage', label: 'Account & plan', description: 'Change the account tier/plan.', kind: 'feature', group: 'Administration' },
  { key: 'security.manage', label: 'Security levels', description: 'Create and assign security levels.', kind: 'feature', group: 'Administration' },
  { key: 'audit.read', label: 'Audit log', description: 'View the activity/audit trail of who did what and when.', kind: 'report', group: 'Administration' },
  { key: 'zac.access', label: 'ZAC assistant', description: 'Open and use the ZAC intelligence assistant. Grants no data access by itself — every ZAC tool independently re-checks the underlying report/feature permission it needs.', kind: 'feature', group: 'Intelligence' },
  // Payroll. Seeded into core.security_levels by migration 0074; these entries are
  // the follow-up that migration's header required, without which auth.service and
  // owner-security-levels silently strip the seeded keys on read and on save.
  { key: 'payroll.view', label: 'View payroll', description: 'View pay periods, wage and commission summaries, and settlement statements for the whole business.', kind: 'report', group: 'Payroll' },
  { key: 'payroll.edit', label: 'Edit payroll', description: 'Create pay periods, generate and regenerate draft summaries, and record payroll adjustments.', kind: 'feature', group: 'Payroll', requires: ['payroll.view'] },
  { key: 'payroll.approve', label: 'Approve payroll', description: 'Move a pay period from review to approved.', kind: 'feature', group: 'Payroll', requires: ['payroll.view'] },
  { key: 'payroll.lock', label: 'Lock payroll', description: 'Lock an approved pay period and mark it paid. Locked periods can never be reopened — corrections go to the next period.', kind: 'feature', group: 'Payroll', requires: ['payroll.view'] },
  { key: 'payroll.export', label: 'Export payroll', description: 'Export pay summaries and settlement statements.', kind: 'feature', group: 'Payroll', requires: ['payroll.view'] },
  { key: 'payroll.email', label: 'Email payroll', description: 'Email pay summaries to staff or an accountant.', kind: 'feature', group: 'Payroll', requires: ['payroll.view'] },
  // Deliberately has NO `requires` edge. Adding `requires: ['payroll.view']` would make
  // expandPermissions() close every stylist's self-view over business-wide payroll
  // visibility - the exact wage leak migration 0074 was written to prevent.
  { key: 'payroll.self.view', label: 'View own pay', description: 'View only your own pay summaries. Grants no visibility of any colleague’s pay.', kind: 'report', group: 'Payroll' },
];

export const ALL_PERMISSIONS: readonly Permission[] = PERMISSION_CATALOG.map((p) => p.key);

const PERMISSION_DEFINITION_BY_KEY: ReadonlyMap<Permission, PermissionDefinition> = new Map(
  PERMISSION_CATALOG.map((def) => [def.key, def]),
);

/** Direct prerequisite permissions for a single key (one edge up the tree). */
export function getPermissionPrerequisites(permission: Permission): Permission[] {
  return [...(PERMISSION_DEFINITION_BY_KEY.get(permission)?.requires ?? [])];
}

/**
 * Close a permission selection over its prerequisites: for every selected key,
 * pull in everything it (transitively) requires. Result is deduped and returned
 * in catalogue order for stable storage/output. This is the single source of
 * truth used by the API on save/resolve and by the UI when toggling.
 */
export function expandPermissions(permissions: Iterable<Permission>): Permission[] {
  const resolved = new Set<Permission>();
  const visit = (permission: Permission) => {
    if (resolved.has(permission)) return;
    resolved.add(permission);
    for (const prerequisite of getPermissionPrerequisites(permission)) visit(prerequisite);
  };
  for (const permission of permissions) visit(permission);
  return ALL_PERMISSIONS.filter((p) => resolved.has(p));
}

/**
 * Every permission that (transitively) requires the given key — i.e. the keys
 * that must be removed when this one is switched off. Returned in catalogue
 * order.
 */
export function getPermissionDependents(permission: Permission): Permission[] {
  const dependents = new Set<Permission>();
  let changed = true;
  while (changed) {
    changed = false;
    for (const def of PERMISSION_CATALOG) {
      if (dependents.has(def.key)) continue;
      const requires = def.requires ?? [];
      if (requires.includes(permission) || requires.some((r) => dependents.has(r))) {
        dependents.add(def.key);
        changed = true;
      }
    }
  }
  return ALL_PERMISSIONS.filter((p) => dependents.has(p));
}

/** Base membership role a security level maps to for DB scoping/RLS. */
export type SecurityLevelBaseRole = Extract<UserRole, 'owner' | 'manager' | 'stylist'>;

/** Stable keys for the built-in (non-deletable) system security levels. */
export type SystemSecurityLevelKey =
  | 'owner'
  | 'group_admin'
  | 'manager'
  | 'receptionist'
  | 'stylist';

/**
 * Default permissions for a base role when a membership has NO security level
 * assigned. Preserves V1 behaviour exactly: owners keep everything, managers
 * keep reports + settings they already had, stylists/clients keep their subset.
 */
export const DEFAULT_ROLE_PERMISSIONS: Record<UserRole, Permission[]> = {
  owner: [...ALL_PERMISSIONS],
  // *** DO NOT add payroll.view here. *** 'receptionist' is not a role -
  // core.membership_role_enum is only owner/manager/stylist/client - and the
  // receptionist system security level has base_role = 'manager'. Any membership
  // without an explicit security_level_id falls back to DEFAULT_ROLE_PERMISSIONS[role],
  // so a manager role default would hand wage data to every unassigned front-desk
  // user. Managers receive payroll.view through the 'manager' security level below
  // (matching migration 0074's seed), never through this list.
  manager: [
    'report.dashboard.view',
    'report.performance.view',
    'report.commission.view',
    'report.financials.view',
    'report.lab_analytics.view',
    'bookings.manage',
    // Post-check-in service changes (0110): a consultation-driven toner or
    // treatment is added by whoever is with the client. Scoped by the API to
    // appointments the actor can already see.
    'bookings.services.modify_after_checkin',
    'crm.view',
    'crm.manage',
    'retail.record',
    'bills.view',
    'eod.manage',
    'eod.sign_off',
    'inventory.manage',
    'services.view',
    'services.manage',
    'rota.view',
    'rota.manage',
    'staff.view',
    'settings.location.manage',
    'settings.billing.manage',
    'settings.tax.manage',
    'settings.booking.manage',
    'audit.read',
    // ZAC left dark launch 2026-08-07: every staff role now opens the assistant
    // by default. Surface-only — each ZAC tool re-checks the exact underlying
    // report/feature permission it needs, so this widens no data access.
    'zac.access',
  ],
  // `payroll.self.view` is safe as a ROLE DEFAULT because it is scoped to the actor,
  // not to a business: every endpoint guarded by it must resolve the staff profile
  // server-side from the authenticated actor and must NOT accept a staffProfileId
  // parameter. That constraint is binding on the self-view endpoints - if a future
  // route ever takes a staff id, this key must come back out of the role default.
  // Contrast the manager entry above, which must never carry `payroll.view`.
  stylist: [
    'bookings.manage',
    'bookings.services.modify_after_checkin',
    'crm.view',
    'retail.record',
    'services.view',
    'rota.view',
    'payroll.self.view',
    // Surface-only, same as the manager entry: the ZAC registry serves stylists
    // a stylist-safe tool catalogue and self-scoped answers.
    'zac.access',
  ],
  client: [],
};

export interface SystemSecurityLevelDefinition {
  key: SystemSecurityLevelKey;
  name: string;
  description: string;
  baseRole: SecurityLevelBaseRole;
  permissions: Permission[];
}

/**
 * The built-in security levels seeded for every business. `owner`/`manager`/
 * `stylist` mirror the base-role defaults; `group_admin` and `receptionist` are
 * the expanded base levels called for in the brief.
 */
export const SYSTEM_SECURITY_LEVELS: readonly SystemSecurityLevelDefinition[] = [
  // Neither the Owner nor the Group Admin LEVEL carries `report.pnl.view`: the
  // P&L is owner-only by default, and a level is assigned to non-owner
  // memberships. Owners themselves hold it through their role
  // (DEFAULT_ROLE_PERMISSIONS.owner). Existing businesses never had the key on
  // these rows, so permissions agree for new and existing businesses. The
  // descriptions do not: ensureSystemLevels only inserts, so existing rows keep
  // their seeded text (ADR §6).
  {
    key: 'owner',
    name: 'Owner',
    description: 'Full access to everything, including account and security settings. Profit & loss must be granted separately.',
    baseRole: 'owner',
    permissions: ALL_PERMISSIONS.filter((p) => p !== 'report.pnl.view'),
  },
  {
    key: 'group_admin',
    name: 'Group Admin',
    description: 'Runs the whole group across all locations, but cannot change the account plan or the security model. Profit & loss must be granted separately.',
    baseRole: 'owner',
    permissions: ALL_PERMISSIONS.filter(
      (p) => p !== 'account.manage' && p !== 'security.manage' && p !== 'report.pnl.view',
    ),
  },
  {
    key: 'manager',
    name: 'Manager',
    description: 'Runs a location: reports, settings, rota, clients and stock, plus read-only payroll. No account, security, pay editing or location creation.',
    baseRole: 'manager',
    // Read-only payroll is granted on the LEVEL, deliberately not on the manager role
    // default (see DEFAULT_ROLE_PERMISSIONS.manager). Mirrors migration 0074, which
    // added payroll.view to this system level only. Owners can grant the remaining
    // payroll keys per business at /settings/security-levels.
    // Ordering (0094, revised by 0100): ordering is a two-step manager-facing
    // flow, so the manager level prepares AND sends its own location's orders.
    // orders.approve is still the spend control — an owner who wants sign-off
    // removes it here per business, and the manager's flow then stops after
    // "Submit for order" with the owner's "Send to supplier" acting as approval.
    // Must stay in step with the seed in migration 0100, or a newly provisioned
    // business would get a manager level that cannot send.
    permissions: [
      ...DEFAULT_ROLE_PERMISSIONS.manager,
      'payroll.view',
      'orders.view',
      'orders.manage',
      'orders.approve',
    ],
  },
  {
    key: 'receptionist',
    name: 'Receptionist',
    description: 'Front desk: bookings, clients and taking payments. No reports, financials, pay or settings.',
    baseRole: 'manager',
    permissions: [
      'bookings.manage',
      // The desk adds a last-minute treatment before checkout (0110).
      'bookings.services.modify_after_checkin',
      'crm.view',
      'crm.manage',
      'retail.record',
      // The bill finder is a front-desk tool ("a client is on the phone about a
      // charge") — read-only over stored bills, no reports or pay visibility.
      'bills.view',
      // Receptionists run the till count; sign-off stays a management act.
      'eod.manage',
      'services.view',
      'rota.view',
    ],
  },
  {
    key: 'stylist',
    name: 'Stylist',
    description: 'Their own column: bookings, clients and taking payments.',
    baseRole: 'stylist',
    permissions: [...DEFAULT_ROLE_PERMISSIONS.stylist],
  },
];

export interface SecurityLevel {
  id: string;
  businessId: string;
  /** System-level key (e.g. 'receptionist'); `null` for owner-created custom levels. */
  key: SystemSecurityLevelKey | null;
  name: string;
  description?: string | null;
  baseRole: SecurityLevelBaseRole;
  isSystem: boolean;
  permissions: Permission[];
  createdAt: string;
  updatedAt: string;
}

export interface ListSecurityLevelsResponse {
  levels: SecurityLevel[];
}

export interface SecurityLevelResponse {
  level: SecurityLevel;
}

export interface PermissionCatalogResponse {
  permissions: PermissionDefinition[];
}

// ===========================================================================
// Audit log (R10 Audit & Compliance foundation)
// ===========================================================================

/**
 * Broad category of the audited entity. Free-form at the DB layer (so new
 * entities don't require a migration) but enumerated here for the shared UI.
 */
export type AuditEntityType =
  | 'booking'
  | 'payment'
  | 'stock'
  | 'security_level'
  | 'membership'
  | 'account'
  | 'order';

/**
 * Dotted `entity.verb` action key, e.g. `booking.created`, `booking.cancelled`,
 * `payment.recorded`, `stock.adjusted`, `security_level.updated`,
 * `membership.security_level.changed`, `account.tier.changed`.
 */
export type AuditAction = string;

export interface AuditLogActor {
  userProfileId: string | null;
  role: string | null;
  name: string | null;
}

export interface AuditLogEntry {
  id: string;
  businessId: string;
  actor: AuditLogActor;
  locationId: string | null;
  locationName: string | null;
  action: AuditAction;
  entityType: string;
  entityId: string | null;
  /** Prior values for edits; null for creates. */
  before: Record<string, unknown> | null;
  /** New values for creates/edits; null for deletes. */
  after: Record<string, unknown> | null;
  metadata: Record<string, unknown>;
  createdAt: string;
}

export interface ListAuditLogResponse {
  entries: AuditLogEntry[];
  /** Opaque cursor for the next page, or null when there are no more rows. */
  nextCursor: string | null;
}

export interface CreateSecurityLevelRequest {
  name: string;
  description?: string | null;
  baseRole: SecurityLevelBaseRole;
  permissions: Permission[];
}

export interface UpdateSecurityLevelRequest {
  name?: string;
  description?: string | null;
  permissions?: Permission[];
}

/**
 * True when the user holds the given permission. Null-safe. Owners resolve with
 * every permission, so this is safe as the single capability gate on the client.
 */
export function userHasPermission(
  user: Pick<AuthUser, 'permissions'> | null | undefined,
  permission: Permission,
): boolean {
  return !!user && user.permissions.includes(permission);
}

/** True when the user holds ALL of the given permissions. Null-safe. */
export function userHasAllPermissions(
  user: Pick<AuthUser, 'permissions'> | null | undefined,
  permissions: readonly Permission[],
): boolean {
  return !!user && permissions.every((p) => user.permissions.includes(p));
}

/** True when the user holds ANY of the given permissions. Null-safe. */
export function userHasAnyPermission(
  user: Pick<AuthUser, 'permissions'> | null | undefined,
  permissions: readonly Permission[],
): boolean {
  return !!user && permissions.some((p) => user.permissions.includes(p));
}

export interface AuthSession {
  accessToken: string;
  refreshToken: string;
  expiresAt?: string;
}

export interface AuthContext extends AuthUser {}

export interface LoginRequest {
  email: string;
  password: string;
  surface?: Extract<AppSurface, 'api' | 'web_dashboard' | 'sheer_app' | 'sheer_lab'>;
}

export interface CreateAccountRequest {
  email: string;
  password: string;
  fullName: string;
  businessName: string;
  surface?: Extract<AppSurface, 'api' | 'web_dashboard'>;
}

export interface LoginResponse {
  session: AuthSession;
  user: AuthUser;
}

/**
 * A booking sign-in (or sign-up) at one salon. `user` is resolved from the
 * account's highest-role membership, which can belong to a different salon, so
 * its `clientProfileId` must not be used for this booking; `bookingClient` is
 * the client profile the sign-in found or created at the booking salon.
 */
export interface ClientBookingLoginResponse extends LoginResponse {
  bookingClient: {
    businessId: string;
    clientProfileId: string;
    clientCode?: string;
    communicationPreference?: CommunicationPreference;
  };
}

export interface CreateAccountResponse extends LoginResponse {}

export interface OwnerOnboardingOwnerInput {
  firstName: string;
  lastName: string;
  email: string;
  password: string;
  phone?: string;
}

export interface OwnerOnboardingBusinessInput {
  name: string;
  slug: string;
  defaultCurrency: string;
  defaultTimezone: string;
  countryCode: string;
  /**
   * Account tier chosen at the sign-up fork. The web routes the "Independent
   * Stylist" choice to `solo` and "Salon" to `salon`. Defaults to `solo` when
   * omitted. Upgradeable later from account settings.
   */
  tier?: BusinessTier;
}

export interface OwnerOnboardingLocationInput {
  name: string;
  slug: string;
  phone?: string;
  email?: string;
  timezone?: string;
  addressLine1?: string;
  addressLine2?: string;
  city?: string;
  region?: string;
  postalCode?: string;
  countryCode?: string;
}

export interface OwnerOnboardingRequest {
  owner: OwnerOnboardingOwnerInput;
  business: OwnerOnboardingBusinessInput;
  location: OwnerOnboardingLocationInput;
}

// ---------------------------------------------------------------------------
// Account tier management (owner)
// ---------------------------------------------------------------------------

export interface AccountTierUsage {
  /** Active locations in the business. */
  locationCount: number;
  /**
   * Bookable columns in use — active staff profiles flagged bookable (service
   * providers). Non-bookable staff (reception, managers, assistants) never
   * count. This is the metric the tier limits are sliced by.
   */
  bookableColumnCount: number;
}

export interface AccountTierUpgradeSuggestion {
  toTier: BusinessTier;
  reason: 'columns' | 'locations';
}

export interface AccountTierState {
  tier: BusinessTier;
  limits: BusinessTierLimits;
  usage: AccountTierUsage;
  /** Set when current usage is at/over a limit and an upgrade is recommended. */
  upgradeSuggestion?: AccountTierUpgradeSuggestion | null;
}

export interface GetAccountResponse {
  account: AccountTierState;
}

export interface UpdateAccountTierRequest {
  tier: BusinessTier;
}

export interface UpdateAccountTierResponse {
  account: AccountTierState;
}

/**
 * Where the freshly-created account is supposed to land.
 *
 * - `web`    — owner / manager. They keep using the dashboard.
 * - `mobile` — stylist / client. The web flow only existed to claim the
 *              account; the actual product surface for them is the Sheer App.
 */
export type AccountCreationTargetSurface = 'web' | 'mobile';

/**
 * What the web client should do immediately after a successful account
 * creation / invitation acceptance.
 *
 * - `redirect_to_dashboard` — owner / manager: enter the web dashboard.
 * - `show_completion_page`  — stylist / client: render the post-claim
 *                             completion page that points them to the
 *                             Sheer App. They MUST NOT be auto-logged into
 *                             the web dashboard.
 */
export type AccountCreationNextAction = 'redirect_to_dashboard' | 'show_completion_page';

export interface OwnerOnboardingResult {
  userProfileId: string;
  businessId: string;
  locationId: string;
  nextStep: 'sign_in' | 'dashboard';
  redirectTo: string;
  /** Always `'owner'` — onboarding cannot produce any other role. */
  role: Extract<UserRole, 'owner'>;
  /** Owners always continue on the web dashboard. */
  targetSurface: Extract<AccountCreationTargetSurface, 'web'>;
  /** Owners always continue on the web dashboard. */
  nextAction: Extract<AccountCreationNextAction, 'redirect_to_dashboard'>;
}

export interface OwnerOnboardingResponse extends OwnerOnboardingResult {
  /**
   * Optional auto-issued session. Present when the API was able to sign
   * the new owner in immediately, otherwise the client should redirect
   * to `/login` and use the email it just registered.
   */
  session?: AuthSession;
  user?: AuthUser;
}

export interface BusinessSlugAvailabilityResponse {
  slug: string;
  available: boolean;
  reason?: string;
}

export interface OwnerOnboardingBootstrap {
  defaultCurrency: string;
  defaultTimezone: string;
  defaultCountryCode: string;
  currencies: Array<{ code: string; label: string }>;
  timezones: Array<{ value: string; label: string }>;
  countries: Array<{ code: string; label: string }>;
}

// ---------------------------------------------------------------------------
// Staff invitation + management (Phase 2)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Password reset (self-serve, web)
// ---------------------------------------------------------------------------

export type PasswordResetTokenStatus = 'valid' | 'expired' | 'used' | 'unknown';

export interface PasswordResetRequestRequest {
  email: string;
}

export interface PasswordResetRequestResponse {
  /**
   * Always `true` — the endpoint never reveals whether the email matched a
   * real account. Operators can still inspect logs to see whether a token
   * was actually issued + delivered.
   */
  accepted: true;
}

export interface PasswordResetInspectResponse {
  status: PasswordResetTokenStatus;
  /**
   * Masked form of the user's email (e.g. `j***@example.com`). Only present
   * when the token resolves to a real row, regardless of validity. The web
   * UI can render this as a hint without leaking the full address.
   */
  emailMasked?: string;
  /** ISO timestamp the token expires at — for "Link expires in N minutes" UI. */
  expiresAt?: string;
}

export interface PasswordResetCompleteRequest {
  token: string;
  /** New password. The server enforces minimum length (8). */
  password: string;
}

export interface PasswordResetCompleteResponse {
  success: true;
  /**
   * Default redirect target the web client should use if it does not need
   * any custom branching. The role-aware fields below override this for
   * stylist/client (see `nextAction`).
   */
  redirectTo: string;
  /**
   * Role of the account whose password was just reset. Derived from the
   * user's primary active membership (NOT from the request body), so the
   * client can render the role-aware completion screen safely.
   */
  role: UserRole;
  /**
   * Where the user's primary product surface lives.
   * - `web`    — owner / manager — continue to web sign-in.
   * - `mobile` — stylist / client — direct them to the Sheer App.
   */
  targetSurface: AccountCreationTargetSurface;
  /**
   * What the web client should do after success.
   * Mirrors the staff-invitation acceptance contract.
   */
  nextAction: AccountCreationNextAction;
}

export type InvitableRole = Extract<UserRole, 'manager' | 'stylist'>;

export type InvitationStatus = 'pending' | 'accepted' | 'revoked' | 'expired';

export type MembershipStatus = 'invited' | 'active' | 'suspended' | 'revoked';

export interface BusinessLocationSummary {
  id: string;
  name: string;
  code?: string;
  slug?: string;
}

// ---------------------------------------------------------------------------
// Location management (owner CRUD; manager: read-own only)
// ---------------------------------------------------------------------------

export interface BusinessLocation {
  id: string;
  businessId: string;
  name: string;
  slug: string;
  /** Internal, per-business code derived from the slug. */
  code: string;
  /**
   * Globally-unique, public-facing Salon Code clients use to find this
   * salon/location. Stable and immutable once issued.
   */
  publicCode: string;
  timezone: string;
  phone?: string;
  email?: string;
  addressLine1?: string;
  addressLine2?: string;
  city?: string;
  region?: string;
  postalCode?: string;
  countryCode: string;
  isActive: boolean;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
}

export interface ListLocationsResponse {
  locations: BusinessLocation[];
  /** Echoes the requesting user's role so the client can branch UI without re-querying /auth/me. */
  scope: 'owner' | 'manager';
}

export interface LocationDetailResponse {
  location: BusinessLocation;
}

// ---------------------------------------------------------------------------
// Location record settings — operating, policy & reporting fields that every
// later report / P&L / policy check reads from (owner + manager editable).
// ---------------------------------------------------------------------------

/** A single day of trading hours. weekday: 0=Sunday .. 6=Saturday. */
export interface LocationOpeningHoursEntry {
  weekday: number;
  isOpen: boolean;
  /** 'HH:MM' 24h. */
  opensAt: string;
  /** 'HH:MM' 24h. */
  closesAt: string;
}

export type LocationDepositType = 'none' | 'fixed_amount' | 'percentage';

/**
 * The closed set of per-location diary granularities. Single source of truth
 * for the settings UI select, the API DTO validation and the DB check
 * constraint (0084) — change all three together or not at all.
 */
export const APPOINTMENT_SLOT_OPTIONS = [15, 30, 60] as const;
export type AppointmentSlotMinutes = (typeof APPOINTMENT_SLOT_OPTIONS)[number];

export interface LocationRecordSettings {
  locationId: string;
  currencyCode: string;

  // Operating
  openingHours: LocationOpeningHoursEntry[];
  /** Working chairs/stations — the denominator for utilisation reporting. */
  chairCount: number;
  appointmentSlotMinutes: number;
  defaultDepositType: LocationDepositType;
  defaultDepositValue: number;

  // Policy thresholds
  /** Discount % above which a manager/owner authorisation is required. */
  discountAuthorisationThresholdPercent: number;
  /** Acceptable end-of-day till variance before it is flagged (major units). */
  cashVarianceThresholdAmount: number;

  // Reporting targets / warning thresholds
  colourMarginTargetPercent: number;
  wasteAllowancePercent: number;
  rebookRateBenchmarkPercent: number;
  utilisationWarningThresholdPercent: number;
  /** Days without outbound movement before on-hand stock counts as dead; per-product deadStockDays overrides. */
  deadStockDaysDefault: number;
  /** Trailing weeks of outbound usage the reorder suggestion averages over. */
  reorderUsageWindowWeeks: number;
  /** Weeks of forecast usage a suggested order should cover. */
  reorderCoverageWeeks: number;
  /** Payroll cost as % of revenue: amber warning threshold. */
  payrollWarningPercent: number;
  /** Payroll cost as % of revenue: red critical threshold. */
  payrollCriticalPercent: number;

  // Sunday Night Report
  sundayReportEnabled: boolean;
  sundayReportRecipients: string[];
  /** Local hour (0-23) the weekly report is dispatched. */
  sundayReportSendHour: number;
}

export type UpdateLocationRecordSettingsRequest = Partial<
  Omit<LocationRecordSettings, 'locationId' | 'currencyCode'>
> & { locationId: string };

export interface LocationRecordSettingsResponse {
  settings: LocationRecordSettings;
}

// --- Effective-dated fixed costs (Week 7 P&L reads these) -------------------

export type FixedCostCategory =
  | 'rent'
  | 'rates'
  | 'utilities'
  | 'insurance'
  | 'software'
  | 'marketing'
  | 'equipment'
  | 'other';

export type FixedCostCadence = 'weekly' | 'monthly' | 'quarterly' | 'annual';

export const FIXED_COST_CATEGORY_LABELS: Record<FixedCostCategory, string> = {
  rent: 'Rent',
  rates: 'Business rates',
  utilities: 'Utilities',
  insurance: 'Insurance',
  software: 'Software & subscriptions',
  marketing: 'Marketing',
  equipment: 'Equipment & leasing',
  other: 'Other',
};

export const FIXED_COST_CADENCE_LABELS: Record<FixedCostCadence, string> = {
  weekly: 'Weekly',
  monthly: 'Monthly',
  quarterly: 'Quarterly',
  annual: 'Annual',
};

export interface LocationFixedCost {
  id: string;
  locationId: string;
  category: FixedCostCategory;
  label?: string | null;
  amount: number;
  cadence: FixedCostCadence;
  /** 'YYYY-MM-DD'. */
  effectiveFrom: string;
  /** 'YYYY-MM-DD' exclusive end; null = still in force. */
  effectiveTo?: string | null;
  notes?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreateLocationFixedCostRequest {
  locationId: string;
  category: FixedCostCategory;
  label?: string | null;
  amount: number;
  cadence?: FixedCostCadence;
  effectiveFrom: string;
  effectiveTo?: string | null;
  notes?: string | null;
}

export type UpdateLocationFixedCostRequest = Partial<
  Omit<CreateLocationFixedCostRequest, 'locationId'>
>;

export interface ListLocationFixedCostsResponse {
  fixedCosts: LocationFixedCost[];
}

export interface LocationFixedCostResponse {
  fixedCost: LocationFixedCost;
}

export interface EffectiveFixedCostsResponse {
  /** The date the costs were resolved for ('YYYY-MM-DD'). */
  date: string;
  /** Monthly-equivalent total of all fixed costs in force on `date`. */
  monthlyEquivalentTotal: number;
  items: LocationFixedCost[];
}

/** Normalise a fixed cost to a comparable monthly figure. */
export function monthlyEquivalentFixedCost(amount: number, cadence: FixedCostCadence): number {
  switch (cadence) {
    case 'weekly':
      return (amount * 52) / 12;
    case 'quarterly':
      return amount / 3;
    case 'annual':
      return amount / 12;
    case 'monthly':
    default:
      return amount;
  }
}

/** Standard trading week: Mon–Sat open, Sunday closed. Mirrors migration 0053. */
export function defaultOpeningHours(): LocationOpeningHoursEntry[] {
  return [
    { weekday: 0, isOpen: false, opensAt: '09:00', closesAt: '18:00' },
    { weekday: 1, isOpen: true, opensAt: '09:00', closesAt: '18:00' },
    { weekday: 2, isOpen: true, opensAt: '09:00', closesAt: '18:00' },
    { weekday: 3, isOpen: true, opensAt: '09:00', closesAt: '18:00' },
    { weekday: 4, isOpen: true, opensAt: '09:00', closesAt: '20:00' },
    { weekday: 5, isOpen: true, opensAt: '09:00', closesAt: '18:00' },
    { weekday: 6, isOpen: true, opensAt: '09:00', closesAt: '17:00' },
  ];
}

/** Safe defaults mirroring the core.location_settings column defaults. */
export function defaultLocationRecordSettings(
  locationId: string,
  currencyCode = 'GBP',
): LocationRecordSettings {
  return {
    locationId,
    currencyCode,
    openingHours: defaultOpeningHours(),
    chairCount: 1,
    appointmentSlotMinutes: 15,
    defaultDepositType: 'none',
    defaultDepositValue: 0,
    discountAuthorisationThresholdPercent: 20,
    cashVarianceThresholdAmount: 5,
    colourMarginTargetPercent: 65,
    wasteAllowancePercent: 10,
    rebookRateBenchmarkPercent: 50,
    utilisationWarningThresholdPercent: 60,
    deadStockDaysDefault: 90,
    reorderUsageWindowWeeks: 8,
    reorderCoverageWeeks: 4,
    payrollWarningPercent: 45,
    payrollCriticalPercent: 55,
    sundayReportEnabled: true,
    sundayReportRecipients: [],
    sundayReportSendHour: 18,
  };
}

export interface CreateLocationRequest {
  name: string;
  slug: string;
  /** Falls back to the business default timezone server-side if omitted. */
  timezone?: string;
  phone?: string;
  email?: string;
  addressLine1?: string;
  addressLine2?: string;
  city?: string;
  region?: string;
  postalCode?: string;
  /** ISO 3166-1 alpha-2; falls back to business default. */
  countryCode?: string;
}

export interface UpdateLocationRequest {
  name?: string;
  slug?: string;
  timezone?: string;
  phone?: string | null;
  email?: string | null;
  addressLine1?: string | null;
  addressLine2?: string | null;
  city?: string | null;
  region?: string | null;
  postalCode?: string | null;
  countryCode?: string;
}

// ---------------------------------------------------------------------------
// Owner booking settings
// ---------------------------------------------------------------------------

export interface OwnerBookingService {
  id: string;
  businessId: string;
  locationId?: string;
  name: string;
  description?: string;
  category?: string;
  estimatedDurationMinutes: number;
  startingPriceAmount: number;
  depositRequiredAmount: number;
  currencyCode: string;
  isActive: boolean;
  sortOrder: number;
}

export interface OwnerServiceRequirementRule {
  id: string;
  businessId: string;
  locationId?: string;
  triggerServiceId: string;
  title: string;
  description?: string;
  isActive: boolean;
  requiredServiceIds: string[];
  createdAt: string;
  updatedAt: string;
}

export interface OwnerServiceUpgradeSuggestion {
  id: string;
  businessId: string;
  locationId?: string;
  triggerServiceId: string;
  suggestedServiceId: string;
  title: string;
  description: string;
  isActive: boolean;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
}

export interface OwnerBookingSettingsResponse {
  locations: BusinessLocationSummary[];
  services: OwnerBookingService[];
  requirementRules: OwnerServiceRequirementRule[];
  upgradeSuggestions: OwnerServiceUpgradeSuggestion[];
  /**
   * Communication / reminder settings for the location passed via `locationId`.
   * `null` when the request was not scoped to a specific location (global view).
   */
  communicationSettings?: LocationCommunicationSettings | null;
}

// ---------------------------------------------------------------------------
// WhatsApp booking notifications & reminder rules (per location)
// ---------------------------------------------------------------------------

/**
 * Owner-configurable WhatsApp confirmation + reminder rules for a single
 * location. Persisted under `core.location_settings.metadata.communication`.
 * Reminder timings are stored canonically as `reminderOffsetsHours` but
 * surfaced to owners as discrete toggles (24h / 48h / 1 week).
 */
export interface LocationCommunicationSettings {
  locationId: string;
  /** Master switch — when false no confirmations or reminders are scheduled. */
  enabled: boolean;
  /** Channels permitted for this location. WhatsApp is the primary delivery channel. */
  enabledChannels: CommunicationPreference[];
  /** Send a confirmation immediately after a successful booking (WhatsApp first). */
  sendBookingConfirmation: boolean;
  /** Short-notice reminder 2 hours before the appointment (Wrike 4507281442). */
  reminder2hEnabled: boolean;
  reminder24hEnabled: boolean;
  reminder48hEnabled: boolean;
  reminder1wEnabled: boolean;
  /**
   * Last-resort fallback. When true, a notification falls back to **email** once the channels before
   * it in the WhatsApp → SMS → Email chain are ineligible or have a real failure (when the client
   * has a valid email). Email is never sent while a prior channel is merely pending/queued.
   */
  emailFallbackEnabled: boolean;
  /**
   * Secondary fallback. When true, a real WhatsApp failure, a WhatsApp opt-out or
   * WhatsApp-ineligibility falls back to **SMS** for the same notification (when the client has a
   * valid phone). SMS is never sent while WhatsApp is merely pending/queued.
   */
  smsFallbackEnabled: boolean;
}

export interface UpdateLocationCommunicationSettingsRequest {
  locationId: string;
  enabled?: boolean;
  sendBookingConfirmation?: boolean;
  reminder2hEnabled?: boolean;
  reminder24hEnabled?: boolean;
  reminder48hEnabled?: boolean;
  reminder1wEnabled?: boolean;
  emailFallbackEnabled?: boolean;
  smsFallbackEnabled?: boolean;
}

export interface LocationCommunicationSettingsResponse {
  settings: LocationCommunicationSettings;
}

export interface UpsertServiceRequirementRuleRequest {
  locationId?: string | null;
  triggerServiceId: string;
  title: string;
  description?: string | null;
  requiredServiceIds: string[];
  isActive?: boolean;
}

export interface UpsertServiceUpgradeSuggestionRequest {
  locationId?: string | null;
  triggerServiceId: string;
  suggestedServiceId: string;
  title: string;
  description: string;
  isActive?: boolean;
  sortOrder?: number;
}

export interface ServiceRequirementRuleResponse {
  rule: OwnerServiceRequirementRule;
}

export interface ServiceUpgradeSuggestionResponse {
  suggestion: OwnerServiceUpgradeSuggestion;
}

// ---------------------------------------------------------------------------
// Product auto-billing (per-location configuration)
// ---------------------------------------------------------------------------

export type ProductBillingRule = 'cost_only' | 'cost_plus_markup_percent' | 'fixed_uplift';

export interface LocationProductBillingSettings {
  locationId: string;
  productBillingEnabled: boolean;
  productBillingRule: ProductBillingRule;
  /** Required when productBillingRule = 'cost_plus_markup_percent'. >= 0 */
  productMarkupPercent: number | null;
  /** Required when productBillingRule = 'fixed_uplift'. >= 0, decimal (e.g. 4.00 = £4) */
  productFixedUpliftAmount: number | null;
  /** When true, the billable amount is rounded UP to the nearest productRoundUpIncrement after the rule is applied. */
  productRoundUpEnabled: boolean;
  /** Round-up step in decimal GBP (e.g. 0.50, 1.00). Required when productRoundUpEnabled. > 0 */
  productRoundUpIncrement: number | null;
}

export interface GetLocationProductBillingSettingsResponse {
  settings: LocationProductBillingSettings;
}

export interface UpdateLocationProductBillingSettingsRequest {
  locationId: string;
  productBillingEnabled?: boolean;
  productBillingRule?: ProductBillingRule;
  productMarkupPercent?: number | null;
  productFixedUpliftAmount?: number | null;
  productRoundUpEnabled?: boolean;
  productRoundUpIncrement?: number | null;
}

export interface UpdateLocationProductBillingSettingsResponse {
  settings: LocationProductBillingSettings;
}

export interface ProductBillingSnapshot {
  costAmountCents: number;
  billableAmountCents: number;
  billingRuleSnapshot: ProductBillingRule;
  markupPercentSnapshot: number | null;
  fixedUpliftAmountSnapshot: number | null;
  roundUpEnabledSnapshot: boolean;
  roundUpIncrementSnapshot: number | null;
}

// ---------------------------------------------------------------------------
// Service-category billing & revenue rules (Sheer Lab "Billing Rules" page)
//
// Per colour-service-category rules describing how product usage is charged:
// a charging strategy, an included gram allowance, and a salon markup. These
// live per location and are managed by owners/managers on the lab station.
// ---------------------------------------------------------------------------

/** The fixed catalogue of colour service categories these rules apply to. */
export type ServiceBillingCategory =
  | 'permanent_colour'
  | 'lightener_bleach'
  | 'semi_toners'
  | 'special_treatments';

/**
 * How a category's product usage becomes a charge:
 *  - `track_only`: record usage, never charge the client.
 *  - `overage`:    charge only grams used beyond the standard allowance.
 *  - `charge_all`: charge every gram used.
 */
export type ChargingStrategy = 'track_only' | 'overage' | 'charge_all';

export interface ServiceBillingRule {
  id: string;
  locationId: string;
  category: ServiceBillingCategory;
  /** Human label, e.g. "Permanent Colour". Derived server-side from `category`. */
  categoryLabel: string;
  /** Short descriptor, e.g. "Standard single-process applications". */
  categoryDescription: string;
  chargingStrategy: ChargingStrategy;
  /** Included grams that are never charged. >= 0 */
  standardAllowanceGrams: number;
  /** Markup applied to the chargeable cost, as a percentage. >= 0 */
  salonMarkupPercent: number;
}

/** Location-level parameters that power the live billing preview. */
export interface ServiceBillingGlobalParameters {
  locationId: string;
  /** Sample grams used in the preview simulation. >= 0 */
  sampleUsageGrams: number;
  /** Base product cost per gram in minor units (e.g. 18 = £0.18). >= 0 */
  baseCostPerGramCents: number;
  /** ISO 4217 currency code, e.g. "GBP". */
  currencyCode: string;
  /** Default markup suggested when seeding new categories. >= 0 */
  defaultMarkupPercent: number;
}

export interface ServiceBillingRulesResponse {
  rules: ServiceBillingRule[];
  globalParameters: ServiceBillingGlobalParameters;
}

export interface UpdateServiceBillingRuleInput {
  category: ServiceBillingCategory;
  chargingStrategy?: ChargingStrategy;
  standardAllowanceGrams?: number;
  salonMarkupPercent?: number;
}

export interface UpdateServiceBillingRulesRequest {
  rules?: UpdateServiceBillingRuleInput[];
  globalParameters?: {
    sampleUsageGrams?: number;
    baseCostPerGramCents?: number;
    currencyCode?: string;
    defaultMarkupPercent?: number;
  };
}

export interface UpdateServiceBillingRulesResponse {
  rules: ServiceBillingRule[];
  globalParameters: ServiceBillingGlobalParameters;
}

export interface ResetServiceBillingRulesResponse {
  rules: ServiceBillingRule[];
  globalParameters: ServiceBillingGlobalParameters;
}

export interface StaffInvitation {
  id: string;
  businessId: string;
  locationId: string;
  email: string;
  firstName: string;
  lastName: string;
  phone?: string;
  role: InvitableRole;
  status: InvitationStatus;
  expiresAt: string;
  createdAt: string;
  updatedAt: string;
  invitedByUserProfileId: string;
  acceptedByUserProfileId?: string;
  acceptedAt?: string;
  revokedAt?: string;
  location?: BusinessLocationSummary;
  invitedBy?: { id: string; fullName: string; email: string };
}

export interface StaffInvitationWithToken extends StaffInvitation {
  /**
   * Plaintext invite token. Returned only at creation/resend time so the
   * caller can email the deep link to the invitee. The DB only stores the
   * SHA-256 hash.
   */
  inviteToken: string;
  inviteUrl: string;
}

export interface CreateStaffInvitationRequest {
  firstName: string;
  lastName: string;
  email: string;
  phone?: string;
  role: InvitableRole;
  locationId: string;
  /** Optional stylist-only: display name for the chair. */
  displayName?: string;
  colorHex?: string;
  bio?: string;
  /** Optional override; defaults to 14 days from now on the server. */
  expiresInHours?: number;
}

export interface ListStaffInvitationsQuery {
  status?: InvitationStatus | 'all';
}

export interface AcceptStaffInvitationRequest {
  token: string;
  password: string;
  firstName?: string;
  lastName?: string;
  phone?: string;
  displayName?: string;
}

export interface AcceptStaffInvitationResponse {
  userProfileId: string;
  businessId: string;
  locationId: string;
  membershipId: string;
  staffProfileId?: string;
  /** Owner-onboarding-style next step + redirect for the web app. */
  nextStep: 'sign_in' | 'dashboard';
  redirectTo: string;
  /**
   * The role the invitee just claimed. Derived server-side from the
   * invitation row (never trusted from the client) so the frontend can
   * render the role-aware completion flow without re-querying `/auth/me`.
   */
  role: UserRole;
  /**
   * Where this user's primary product surface lives. `mobile` means the
   * web is only an account-claim shell and the next product step is in
   * the Sheer App (stylist / client). `web` means the dashboard is their
   * day-to-day surface (owner / manager).
   */
  targetSurface: AccountCreationTargetSurface;
  /**
   * What the web client should do right after acceptance succeeds.
   * Branches `redirectTo` between dashboard and the completion page.
   */
  nextAction: AccountCreationNextAction;
  session?: AuthSession;
  user?: AuthUser;
}

export interface InvitationLookupResponse {
  /** Subset of fields safe to return from the public `inspect` endpoint. */
  invitationId: string;
  businessName: string;
  locationName: string;
  role: InvitableRole;
  email: string;
  firstName: string;
  lastName: string;
  expiresAt: string;
  status: InvitationStatus;
}

export type StaffEmploymentType = 'employed' | 'self_employed' | 'hybrid';
export type StaffCommissionStructure = 'tiered' | 'flat' | 'none';
export type StaffEmploymentStatus = 'active' | 'on_leave' | 'notice' | 'terminated';
/**
 * How a staff member's Service Revenue Target is applied.
 * - `flat`: the stored amount is used exactly as entered.
 * - `pro_rated`: the stored amount is a full-week basis; the pay engine scales it
 *   by the hours actually worked that week relative to the member's contracted
 *   hours, so working more/fewer hours moves the target automatically. Hours are
 *   used (not days) as the fairest basis. See {@link proRateServiceRevenueTarget}.
 */
export type StaffServiceRevenueTargetMode = 'flat' | 'pro_rated';

export const STAFF_EMPLOYMENT_TYPE_LABELS: Record<StaffEmploymentType, string> = {
  employed: 'Employed',
  self_employed: 'Self-employed',
  hybrid: 'Hybrid',
};

export const STAFF_COMMISSION_STRUCTURE_LABELS: Record<StaffCommissionStructure, string> = {
  tiered: 'Tiered (KPI)',
  flat: 'Flat rate',
  none: 'No commission',
};

export const STAFF_EMPLOYMENT_STATUS_LABELS: Record<StaffEmploymentStatus, string> = {
  active: 'Active',
  on_leave: 'On leave',
  notice: 'On notice',
  terminated: 'Terminated',
};

export const STAFF_SERVICE_REVENUE_TARGET_MODE_LABELS: Record<StaffServiceRevenueTargetMode, string> = {
  flat: 'Flat',
  pro_rated: 'Pro-rated (by hours worked)',
};

/** Human-readable explanation of each Service Revenue Target mode, for UI hints. */
export const STAFF_SERVICE_REVENUE_TARGET_MODE_DESCRIPTIONS: Record<StaffServiceRevenueTargetMode, string> = {
  flat: 'Target is used exactly as entered, regardless of hours worked.',
  pro_rated:
    'Target scales with hours actually worked vs contracted hours, so a shorter/longer week moves it automatically.',
};

/** Standard full-time hours used as the pro-rata baseline when a member has no contracted hours set. */
export const DEFAULT_CONTRACTED_HOURS_PER_WEEK = 40;

/**
 * Resolve the effective Service Revenue Target for a period given the member's
 * target mode. For `flat` the base amount is returned unchanged; for `pro_rated`
 * it is scaled by the hours actually worked relative to the member's contracted
 * hours, so a shorter/longer week automatically moves the target. Hours (not
 * days) are used as the fairest basis (per Wrike #4507280825 review feedback).
 *
 * @param baseTarget            The stored `serviceRevenueTargetAmount` (major currency).
 * @param hoursWorked           Hours the member worked in the period.
 * @param mode                  The member's Service Revenue Target mode.
 * @param contractedHoursPerWeek The member's contracted-hours baseline; defaults to
 *                              {@link DEFAULT_CONTRACTED_HOURS_PER_WEEK} when 0/unset.
 */
export function proRateServiceRevenueTarget(
  baseTarget: number,
  hoursWorked: number,
  mode: StaffServiceRevenueTargetMode = 'flat',
  contractedHoursPerWeek = DEFAULT_CONTRACTED_HOURS_PER_WEEK,
): number {
  if (mode !== 'pro_rated') return baseTarget;
  const baseline = contractedHoursPerWeek > 0 ? contractedHoursPerWeek : DEFAULT_CONTRACTED_HOURS_PER_WEEK;
  const factor = Math.max(0, hoursWorked) / baseline;
  return baseTarget * factor;
}

export interface StaffMember {
  userProfileId: string;
  email: string;
  fullName: string;
  phone?: string;
  avatarUrl?: string;
  /**
   * Every role this member holds at their location, highest-privilege first.
   * A member can be both manager AND stylist at the same location. Owners
   * appear as `['owner']`.
   */
  roles: UserRole[];
  /** The highest-privilege membership's id (representative of the member's set). */
  membershipId: string;
  membershipStatus: MembershipStatus;
  /** Representative/primary location (highest-privilege membership). */
  location?: BusinessLocationSummary;
  /**
   * Every distinct location this member is attached to, across all roles. A
   * manager may oversee several salons ("area manager"); a stylist is bookable
   * at a single location.
   */
  locations?: BusinessLocationSummary[];
  /**
   * Location ids where the member holds the MANAGER role. Empty when they are
   * not a manager. Drives the location tick-boxes when editing the member.
   */
  managerLocationIds?: string[];
  /** The single location where the member is a bookable stylist, when applicable. */
  stylistLocationId?: string | null;
  /** Assigned security level id (null = base-role defaults). */
  securityLevelId?: string | null;
  /** Assigned security level display name, when set. */
  securityLevelName?: string | null;
  staffProfile?: {
    id: string;
    displayName: string;
    employmentStatus: StaffEmploymentStatus;
    isBookable: boolean;
    /** Hidden unless the caller can manage staff pay. */
    hourlyRate?: number;
    /**
     * Hidden unless the caller can manage staff pay. Contracted hours are a direct
     * input to payable hours and therefore to base pay and to any
     * `multiple_of_base_pay` commission threshold.
     */
    contractedHours?: number;
    /**
     * Hidden unless the caller can manage staff pay. Read by payroll accelerator
     * conditions with `basis = 'staff_benchmark'`, so editing it moves a stylist
     * between commission band rates.
     */
    averageBillBenchmark?: number;
    sheerLabPinEnabled: boolean;
    leaveNotes?: string;
    colorHex?: string;
    bio?: string;
    /**
     * Employment basis — drives wage & commission handling, and is snapshotted onto
     * every pay summary as `employment_type_snapshot`. Hidden unless the caller can
     * manage staff pay.
     */
    employmentType?: StaffEmploymentType;
    /** Commission model. `tiered` uses the V1 KPI engine. */
    commissionStructure?: StaffCommissionStructure;
    /** Flat commission rate (%), applied when commissionStructure is `flat`. */
    commissionFlatRatePercent?: number;
    /** Optional owner-set Service Revenue Target (major currency). Null = computed target. */
    serviceRevenueTargetAmount?: number | null;
    /** Whether the Service Revenue Target is a flat figure or a pro-rated basis. */
    serviceRevenueTargetMode?: StaffServiceRevenueTargetMode;
    /**
     * Annual paid-holiday entitlement in days. Hidden unless the caller can manage
     * staff pay — paid holiday is payable time, so this feeds base pay.
     */
    holidayEntitlementDays?: number;
    /** Periodic colour/product allowance (major currency). */
    colourAllowanceAmount?: number;
    /** Provider photo (internal + client-facing). Distinct from account avatarUrl. */
    photoUrl?: string | null;
    /** Globally-unique, immutable provider Q Code. */
    qCode: string;
    /** Employment start date ('YYYY-MM-DD'), backed by hire_date. */
    startDate?: string | null;
    /**
     * IDs of the services this stylist is qualified to perform. Empty/undefined
     * means the stylist has no service eligibility yet. See
     * booking.staff_service_eligibility.
     */
    serviceIds?: string[];
    /**
     * Per-stylist price overrides for the services this stylist can perform.
     * `priceAmount` is in major currency units; `null` means the service's base
     * price applies. Entries mirror `serviceIds`. See
     * booking.staff_service_eligibility.price_amount.
     */
    servicePricing?: { serviceId: string; priceAmount: number | null }[];
  };
  invitedAt?: string;
  activatedAt?: string;
  suspendedAt?: string;
  revokedAt?: string;
}

export interface ListStaffResponse {
  staff: StaffMember[];
  pendingInvitations: StaffInvitation[];
  locations: BusinessLocationSummary[];
}

export interface UpdateStaffMemberRequest {
  /**
   * Full desired set of the member's roles at their location (manager and/or
   * stylist). When provided, the member's role memberships are synced to exactly
   * these. Omit to leave the current roles unchanged (e.g. status-only updates).
   */
  roles?: InvitableRole[];
  /**
   * Primary/stylist location. Required (directly or via existing membership)
   * while the member keeps the stylist role. Also used as the manager fallback
   * when `managerLocationIds` is omitted.
   */
  locationId?: string;
  /**
   * Locations where the member holds the MANAGER role. When the desired role
   * set includes `manager`, the manager memberships are synced to exactly these
   * locations — letting one manager oversee several salons ("area manager")
   * while another oversees a different subset. Ignored for non-managers; falls
   * back to `locationId` when omitted.
   */
  managerLocationIds?: string[];
  membershipStatus?: Extract<MembershipStatus, 'active' | 'suspended' | 'revoked'>;
  /** Security level to apply to this member's memberships; null clears it (base-role defaults). */
  securityLevelId?: string | null;
  displayName?: string;
  colorHex?: string;
  bio?: string;
  isBookable?: boolean;
  hourlyRate?: number;
  contractedHours?: number;
  averageBillBenchmark?: number;
  leaveNotes?: string | null;
  /** Employment basis. */
  employmentType?: StaffEmploymentType;
  /** Employment status override (active/on_leave/notice/terminated). */
  employmentStatus?: StaffEmploymentStatus;
  /** Commission model. */
  commissionStructure?: StaffCommissionStructure;
  /** Flat commission rate (%) for the `flat` structure. */
  commissionFlatRatePercent?: number;
  /** Owner-set Service Revenue Target (major currency); null clears the override. */
  serviceRevenueTargetAmount?: number | null;
  /** Whether the Service Revenue Target is a flat figure or a pro-rated basis. */
  serviceRevenueTargetMode?: StaffServiceRevenueTargetMode;
  /** Annual paid-holiday entitlement in days. */
  holidayEntitlementDays?: number;
  /** Periodic colour/product allowance (major currency). */
  colourAllowanceAmount?: number;
  /** Provider photo URL; null clears it. */
  photoUrl?: string | null;
  /** Employment start date ('YYYY-MM-DD'); null clears it. Backed by hire_date. */
  startDate?: string | null;
  /**
   * Full replacement set of services this stylist can perform. When provided,
   * the stylist's service eligibility is replaced with exactly these IDs.
   * Omit to leave eligibility unchanged. Legacy alias for `serviceAssignments`
   * with no per-stylist prices (all prices inherit the service base price).
   */
  serviceIds?: string[];
  /**
   * Full replacement set of services this stylist can perform, each with an
   * optional per-stylist price (`priceAmount` in major currency units;
   * `null`/omitted inherits the service base price). When provided, replaces the
   * stylist's eligibility AND prices. Takes precedence over `serviceIds`.
   */
  serviceAssignments?: { serviceId: string; priceAmount?: number | null }[];
}

export interface UpdateStaffMemberResponse {
  staff: StaffMember;
}

/** Result of uploading a provider photo; the URL should be saved on the profile. */
export interface StaffPhotoUploadResponse {
  photoUrl: string;
}

export interface RefreshSessionRequest {
  refreshToken: string;
  surface?: Extract<AppSurface, 'api' | 'web_dashboard' | 'sheer_app' | 'sheer_lab'>;
}

export interface LogoutRequest {
  refreshToken?: string;
}

export interface CurrentUserResponse {
  user: AuthUser;
}

export type CommunicationPreference = 'whatsapp' | 'sms' | 'email';

export interface UserProfileIdentity {
  userProfileId: string;
  email: string;
  firstName: string;
  lastName: string;
  fullName: string;
  displayName: string;
  phone?: string;
  avatarUrl?: string;
  role: UserRole;
  isActive: boolean;
  /** IANA timezone (e.g. 'Europe/London'). Defaults server-side when unset. */
  timezone?: string;
}

export interface ClientProfileDetails {
  id: string;
  businessId: string;
  userProfileId?: string;
  primaryLocationId?: string;
  clientCode: string;
  firstName: string;
  lastName: string;
  displayName: string;
  email?: string;
  phone?: string;
  communicationPreference?: CommunicationPreference;
  notes?: string;
  source?: string;
  tags: string[];
  lastVisitAt?: string;
  visitCount: number;
  activeAllergies: number;
  expiredPatchTests: number;
}

export interface StaffProfileDetails {
  id: string;
  businessId: string;
  userProfileId: string;
  assignedLocationId: string;
  displayName: string;
  employmentStatus: 'active' | 'on_leave' | 'notice' | 'terminated';
  isBookable: boolean;
  colorHex?: string;
  bio?: string;
  hourlyRate: number;
  contractedHours: number;
  averageBillBenchmark: number;
  sheerLabPinEnabled: boolean;
  leaveNotes?: string;
  pendingLeaveRequests: number;
  openAbsences: number;
}

export interface LocationProfileScope {
  kind: AllowedLocationScope['kind'];
  locationIds: string[];
}

export interface UserProfileResponse {
  identity: UserProfileIdentity;
  clientProfile?: ClientProfileDetails;
  staffProfile?: StaffProfileDetails;
  locations: AuthLocation[];
  scope: LocationProfileScope;
  editableFields: string[];
}

export interface ListProfilesResponse {
  profiles: UserProfileResponse[];
  scope: 'owner' | 'manager';
}

export interface UpdateCurrentProfileRequest {
  firstName?: string;
  lastName?: string;
  phone?: string | null;
  avatarUrl?: string | null;
  communicationPreference?: CommunicationPreference;
  /** IANA timezone (e.g. 'Europe/London'). */
  timezone?: string;
  /** Staff self-editable bio. Ignored for non-staff accounts. */
  bio?: string | null;
}

export interface AdminUpdateProfileRequest {
  firstName?: string;
  lastName?: string;
  phone?: string | null;
  avatarUrl?: string | null;
  communicationPreference?: CommunicationPreference | null;
  clientNotes?: string | null;
  assignedLocationId?: string;
  staffDisplayName?: string;
  hourlyRate?: number;
  contractedHours?: number;
  averageBillBenchmark?: number;
  leaveNotes?: string | null;
  isBookable?: boolean;
}

export interface UpdateProfileResponse {
  profile: UserProfileResponse;
}

/**
 * One service line on a booked appointment, with its scheduled window and ordered
 * segments. Lets the appointment-book calendar draw segment sub-bands within the
 * appointment tile and shade stylist-free ("development") time differently.
 */
export interface StaffBookingServiceLine {
  /** Appointment service line id — the target of a per-service resize. */
  id?: string;
  serviceId?: string;
  name: string;
  /** ISO start of this service within the appointment. */
  startsAt: string;
  /** ISO end of this service within the appointment. */
  endsAt: string;
  durationMinutes: number;
  /** Ordered segment breakdown; empty when the service had no segments. */
  segments: BookingSegmentSummary[];
}

export interface StaffBookingSummary {
  id: string;
  businessId: string;
  locationId: string;
  clientProfileId: string;
  assignedStaffProfileId?: string;
  requestedStaffProfileId?: string;
  status: AppointmentStatus;
  startsAt: string;
  endsAt: string;
  clientDisplayName: string;
  serviceNames: string[];
  /**
   * Catalogue service IDs backing this appointment, in booking order. Lets the
   * book's "Edit appointment" editor pre-select the current services (names alone
   * can't be mapped back to IDs reliably). Optional — not every summary builder
   * populates it.
   */
  serviceIds?: string[];
  /**
   * Per-service breakdown with each service's scheduled window and its ordered
   * segments, so the appointment-book calendar can split a tile into segment
   * sub-bands (occupied vs stylist-free "development" time). Ordered by booking
   * sequence. Optional — not every summary builder populates it; when absent the
   * calendar falls back to a single block from startsAt/endsAt.
   */
  services?: StaffBookingServiceLine[];
  /**
   * Every service line on the appointment — booked, added during the visit and
   * removed — with provenance and attribution (0110). `serviceNames` /
   * `serviceIds` above list only the PERFORMED lines; this is the full picture
   * the in-visit service panel and the audit view need. Optional — only the
   * staff booking builders populate it.
   */
  serviceLines?: AppointmentServiceLineSummary[];
  durationMinutes?: number;
  depositRequiredAmount?: number;
  depositStatus?: string;
  clientNote?: string;
  patchTest?: StaffBookingPatchTestSummary;
  completedAt?: string;
  completedByUserProfileId?: string;
  completedByStaffProfileId?: string;
  /**
   * The location's cancellation-notice window in hours (from
   * `core.location_settings.cancellation_notice_hours`). Lets the client app show
   * the policy and decide refund-vs-forfeit. Only populated on client-facing
   * summaries.
   */
  cancellationWindowHours?: number;
  /**
   * ISO deadline (= `startsAt − cancellationWindowHours`). Cancelling on or before
   * this refunds the deposit and rebooking is allowed; after it, a cancel forfeits
   * the deposit and rebooking is blocked. Only populated on client-facing summaries.
   */
  refundCutoffAt?: string;
}

export interface StaffBookingDetail extends StaffBookingSummary {
  communicationPreference?: string;
  internalNote?: string;
}

export interface AppointmentCompletionLineItem {
  lineType: 'service' | 'product_usage' | string;
  description: string;
  amountCents: number;
  currencyCode: string;
  /** For itemised service lines: the booking.appointment_services row behind it (0110). */
  appointmentServiceId?: string;
  /** For itemised service lines: booked, or added/replaced during the visit (0110). */
  origin?: AppointmentServiceOrigin;
  /** For itemised service lines: who the revenue is attributed to (0110). */
  staffProfileId?: string;
}

export interface AppointmentCompletionCheckout {
  status: 'awaiting_payment' | 'paid' | 'not_ready' | 'voided';
  readyAt?: string;
  route?: string;
  message: string;
}

export type BillLineType =
  | 'service'
  | 'product_usage'
  | 'retail'
  | 'deposit_credit'
  | 'discount'
  /** Reconciles a late-written bill to the payments ledger (see ensureBillForVisit). */
  | 'adjustment';

/** One itemised line of a stored bill, exactly as the till displayed it. */
export interface BillLineRecord {
  id: string;
  sequenceNo: number;
  lineType: BillLineType | string;
  description: string;
  staffProfileId?: string;
  netCents: number;
  taxCents: number;
  grossCents: number;
  /** Tax rate frozen onto this line when the bill was recorded. */
  taxRatePercent: number;
}

/**
 * The immutable bill snapshot stored when a visit's payment is confirmed
 * (billing.bills, 0085). Unlike the recomputed `billing` block, these figures
 * never change after the till closes — they are what money reporting reads.
 */
export interface BillRecord {
  id: string;
  /** Human-readable per-business sequence (render as e.g. "#000123"). */
  billNumber: number;
  businessId: string;
  locationId: string;
  visitId: string;
  appointmentId?: string;
  clientProfileId?: string;
  staffProfileId?: string;
  status: 'paid' | 'voided';
  netCents: number;
  taxCents: number;
  grossCents: number;
  discountCents: number;
  /** Deposit credit consumed by this bill (explicit deposit redemption). */
  depositAppliedCents: number;
  /** What the till actually collected (gross minus deposit applied). */
  balanceCollectedCents: number;
  currencyCode: string;
  taxLabel?: string;
  taxRatePercent: number;
  occurredAt: string;
  createdAt: string;
  lines: BillLineRecord[];
}

/** One row of the bill finder: the stored bill plus display names stitched in. */
// --- End of day (cash-up) — Week 5 -----------------------------------------

export interface EodPettyCashEntry {
  id: string;
  amountCents: number;
  reason: string;
  recordedByUserProfileId?: string;
  createdAt: string;
}

/**
 * One location's cash-up for one trading day (billing.eod_reconciliations).
 * Expected figures are auto-fed from checkout records; counted figures are
 * entered at the till; sign-off freezes `varianceCents` permanently.
 */
export interface EodReconciliation {
  id: string;
  businessId: string;
  locationId: string;
  /** Location-local trading date, YYYY-MM-DD. */
  businessDate: string;
  status: 'open' | 'signed_off';
  openingFloatCents: number;
  expectedCashCents?: number;
  countedCashCents?: number;
  expectedCardCents?: number;
  countedCardCents?: number;
  /** Retail rows recorded without a payment method — never guessed into cash/card. */
  unclassifiedRetailCents: number;
  depositsCollectedCents: number;
  depositsRedeemedCents: number;
  /** Manual until the refund/void data model exists. */
  voidsCents: number;
  refundsCents: number;
  pettyCashOutCents: number;
  /** (counted cash + card) − (expected cash + card); frozen at sign-off. */
  varianceCents?: number;
  notes?: string;
  signedOffByUserProfileId?: string;
  signedOffAt?: string;
  currencyCode: string;
  createdAt: string;
  updatedAt: string;
  pettyCash: EodPettyCashEntry[];
}

export interface EodDayResponse {
  /** Null when the day has not been opened yet. */
  day: EodReconciliation | null;
  /** Visits completed but not yet paid inside this trading day (warning). */
  openVisits: number;
  /** The location's configured acceptable till variance, in cents. */
  cashVarianceThresholdCents: number;
  /** Money categories the platform does not capture automatically yet. */
  notCaptured: string[];
}

export interface OpenEodDayRequest {
  locationId: string;
  /** Defaults to today in the location's timezone. */
  businessDate?: string;
}

export interface UpdateEodDayRequest {
  openingFloatCents?: number;
  countedCashCents?: number | null;
  countedCardCents?: number | null;
  voidsCents?: number;
  refundsCents?: number;
  notes?: string | null;
}

export interface AddEodPettyCashRequest {
  amountCents: number;
  reason: string;
}

export interface ListEodDaysResponse {
  days: EodReconciliation[];
}

export interface BillFinderItem {
  id: string;
  billNumber: number;
  visitId: string;
  locationId: string;
  clientProfileId?: string;
  clientName?: string;
  staffProfileId?: string;
  staffName?: string;
  status: 'paid' | 'voided';
  grossCents: number;
  depositAppliedCents: number;
  balanceCollectedCents: number;
  currencyCode: string;
  occurredAt: string;
}

export interface ListBillsResponse {
  bills: BillFinderItem[];
  /** Same offset-pagination shape the CRM table uses. */
  pagination: CrmClientsPagination;
}

export interface AppointmentCompletionResponse {
  appointment: StaffBookingDetail;
  visit: CrmVisitSummary;
  checkout: AppointmentCompletionCheckout;
  /**
   * The stored bill for this visit (0085). Present once payment has been
   * confirmed; absent on pre-payment completion responses and for legacy
   * visits until their bill is backfilled.
   */
  bill?: BillRecord;
  billing: {
    lineItems: AppointmentCompletionLineItem[];
    serviceTotalCents: number;
    productUsageTotalCents: number;
    depositPaidCents: number;
    totalCents: number;
    balanceDueCents: number;
    currencyCode: string;
    /**
     * Location tax rollup for this bill. Always present; `enabled: false` when the
     * location has no active tax configuration. `totalCents`/`balanceDueCents`
     * above remain the tax-exclusive figures for backward compatibility — consume
     * `tax` to render inc/ex-tax figures per the configured display mode.
     */
    tax: AppointmentBillingTax;
  };
  alreadyCompleted: boolean;
}

export type SalonPaymentMethod = 'cash' | 'card_reader';

/** One way the client settles part of the bill at the till (e.g. £30 cash). */
export interface AppointmentPaymentTender {
  paymentMethod: SalonPaymentMethod;
  amountCents: number;
}

/**
 * Settles the visit's full balance in one confirmation. Either shape works:
 * the legacy single `paymentMethod` + `amountCents` pair, or `payments` with
 * one tender per method for a split bill (£30 cash + £42 card). Tender amounts
 * must sum to exactly `balanceDueCents` — the bill always tallies to zero.
 */
export interface AppointmentPaymentConfirmationRequest {
  paymentMethod?: SalonPaymentMethod;
  amountCents?: number;
  /** Split-tender shape; takes precedence over the single pair when present. */
  payments?: AppointmentPaymentTender[];
  notes?: string;
}

export interface AppointmentPaymentRecord {
  id: string;
  appointmentId: string;
  visitId: string;
  paymentMethod: SalonPaymentMethod;
  amountCents: number;
  currencyCode: string;
  paidAt: string;
  confirmedByUserProfileId?: string;
  confirmedByStaffProfileId?: string;
  notes?: string;
}

export interface AppointmentPaymentConfirmationResponse extends AppointmentCompletionResponse {
  /** Largest tender — kept for callers that predate split payments. */
  payment: AppointmentPaymentRecord;
  /** Every tender recorded against the visit (one per method). */
  payments: AppointmentPaymentRecord[];
  alreadyPaid: boolean;
}

/**
 * A settled (or settling) visit's bill, retrievable any time after checkout:
 * the same itemised billing breakdown the till showed plus every payment
 * taken. Rendered at /checkout/visits/:visitId — the route `checkout.route`
 * has always pointed at.
 */
export interface VisitBillResponse extends AppointmentCompletionResponse {
  payments: AppointmentPaymentRecord[];
}

// --- Client booking acceptance (owner/manager approve or reject) ---
// Appointments a client books start as 'awaiting_acceptance'. An owner or
// manager accepts (→ 'confirmed', client confirmation + reminders scheduled) or
// rejects (→ 'cancelled', any paid deposit auto-refunded).

export interface AcceptBookingResponse {
  appointment: StaffBookingDetail;
}

export interface RejectBookingRequest {
  reason?: string;
}

export interface RejectBookingResponse {
  appointment: StaffBookingDetail;
  /** True when a paid deposit was refunded via Stripe as part of the rejection. */
  depositRefunded: boolean;
  /** Set when a refund was attempted but failed — the appointment is still cancelled. */
  refundError?: string;
}

export interface LinkStylistRebookingRequest {
  sourceVisitId?: string;
  rebookedAppointmentId: string;
}

export interface CreateStylistRebookingRequest {
  sourceVisitId?: string;
  selectedStartAt: string;
  staffProfileId?: string;
  clientNote?: string;
}

// --- Appointment book actions (staff-facing day calendar) ---
// Surfaced from the tile action menu: arrive a client (check-in), cancel a
// confirmed booking, or reschedule/reassign it. Check-out reuses the existing
// complete → confirm-payment flow above.

export interface CheckInAppointmentResponse {
  appointment: StaffBookingDetail;
}

export interface CancelAppointmentRequest {
  reason?: string;
  /**
   * Whether a paid deposit should be refunded as part of the cancellation. The
   * owner/manager decides this at cancel time from the book. Defaults to `true`
   * (refund) when omitted, preserving the previous auto-refund behaviour. When
   * `false` and a deposit was paid, the deposit is kept and the response returns
   * `depositForfeited: true`.
   */
  refundDeposit?: boolean;
}

export interface CancelAppointmentResponse {
  appointment: StaffBookingDetail;
  /** True when a paid deposit was refunded via Stripe as part of the cancellation. */
  depositRefunded: boolean;
  /** Set when a refund was attempted but failed — the appointment is still cancelled. */
  refundError?: string;
  /**
   * True when a paid deposit was deliberately NOT refunded — either the customer
   * cancelled inside the salon's cancellation window, or an owner/manager chose to
   * keep the deposit when cancelling from the book (deposit forfeited).
   */
  depositForfeited?: boolean;
}

// ---------------------------------------------------------------------------
// Post-check-in service lifecycle (0110) — booked vs performed
// ---------------------------------------------------------------------------
//
// An appointment's service lines are ONE table with provenance. What was booked
// is `origin = 'booked'` (whatever its status now); what was performed is every
// line whose status is not `cancelled`. Lines are never deleted after check-in,
// so both questions stay answerable from structured data after payment.

export type AppointmentServiceOrigin = 'booked' | 'post_checkin_add' | 'post_checkin_replace';

export type AppointmentServiceLineStatus = 'scheduled' | 'in_progress' | 'completed' | 'cancelled';

/** One service line of an appointment, with provenance and attribution. */
export interface AppointmentServiceLineSummary {
  id: string;
  serviceId?: string;
  name: string;
  sequenceNo: number;
  /** Major units, as snapshotted from the catalogue when the line was created. */
  priceAmount: number;
  durationMinutes: number;
  status: AppointmentServiceLineStatus;
  /** True when this line counts towards the bill (status is not `cancelled`). */
  performed: boolean;
  origin: AppointmentServiceOrigin;
  assignedStaffProfileId?: string;
  addedAt?: string;
  addedByUserProfileId?: string;
  removedAt?: string;
  removedByUserProfileId?: string;
  removalReason?: string;
  /** For a `post_checkin_replace` line: the booked line it was performed instead of. */
  replacesAppointmentServiceId?: string;
}

export type AppointmentServiceChangeAction = 'added' | 'removed' | 'replaced' | 'reassigned';

/** Structured before/after state of a line inside a change record. */
export interface AppointmentServiceChangeSnapshot {
  lineId?: string;
  serviceId?: string;
  serviceName?: string;
  priceAmount?: number;
  staffProfileId?: string;
  staffDisplayName?: string;
  status?: AppointmentServiceLineStatus;
  origin?: AppointmentServiceOrigin;
}

/** One post-check-in mutation, exactly as recorded with the line change. */
export interface AppointmentServiceChange {
  id: string;
  appointmentId: string;
  appointmentServiceId?: string;
  replacedAppointmentServiceId?: string;
  action: AppointmentServiceChangeAction;
  appointmentStatusAtChange: AppointmentStatus;
  actorUserProfileId?: string;
  actorStaffProfileId?: string;
  actorDisplayName?: string;
  before?: AppointmentServiceChangeSnapshot;
  after?: AppointmentServiceChangeSnapshot;
  reason?: string;
  createdAt: string;
}

export interface AddAppointmentServiceRequest {
  /** Catalogue service to perform. Must be active and available at the appointment's location. */
  serviceId: string;
  /** Who performs it. Defaults to the appointment's assigned stylist. */
  staffProfileId?: string;
  /** When set, the named performed line is taken off the visit and this service performed instead. */
  replacesAppointmentServiceId?: string;
  reason?: string;
  /** Client-generated key. A retried request with the same key returns the original change. */
  idempotencyKey?: string;
}

export interface RemoveAppointmentServiceRequest {
  reason?: string;
  idempotencyKey?: string;
}

export interface ReassignAppointmentServiceRequest {
  staffProfileId: string;
  idempotencyKey?: string;
}

export interface AmendAppointmentServicesResponse {
  appointment: StaffBookingDetail;
  /** The recorded change; absent only when a remove/reassign was already applied. */
  change?: AppointmentServiceChange;
  /** True when the request replayed an earlier change with the same idempotency key. */
  replayed: boolean;
  /** True when the requested state already held (e.g. removing an already-removed line). */
  alreadyApplied: boolean;
  /** Present once the visit exists (awaiting payment): the recomputed bill. */
  billing?: AppointmentCompletionResponse['billing'];
}

/**
 * One service as it stood in the ORIGINAL booking (T0). Read from the immutable
 * `original_services_snapshot`, so it is not a line id and cannot be acted on —
 * it is evidence of what the client first asked for.
 */
export interface OriginalBookedService {
  serviceId?: string;
  serviceName: string;
  /** Major units, as snapshotted from the catalogue when the appointment was created. */
  priceAmount?: number;
  durationMinutes?: number;
  staffProfileId?: string;
  sequenceNo?: number;
}

export interface AppointmentServiceChangesResponse {
  appointmentId: string;
  /**
   * T0 — what the client ORIGINALLY booked, captured once when the appointment
   * was created and immutable thereafter, so a pre-check-in edit cannot erase
   * it. Empty when `originalBookingAvailable` is false.
   */
  originalBookedServices: OriginalBookedService[];
  /**
   * False for every appointment created before the snapshot existed. The
   * original booking is then genuinely unknown — never substitute the current
   * set, which may already be the result of a pre-check-in edit.
   */
  originalBookingAvailable: boolean;
  /**
   * T1 — lines with origin `booked`: the booking as it stood when the client
   * arrived, regardless of what happened later.
   */
  bookedServices: AppointmentServiceLineSummary[];
  /** T2 — lines not `cancelled`: what was (or is being) performed. */
  performedServices: AppointmentServiceLineSummary[];
  changes: AppointmentServiceChange[];
}

export interface RescheduleAppointmentRequest {
  /**
   * New ISO start time for the appointment. Duration is preserved unless
   * `serviceIds` changes the service list (then it's recomputed from the new
   * services) or `durationMinutes` resizes it.
   */
  scheduledStartAt: string;
  /** Optional new assigned stylist. Omit to keep the current stylist. */
  staffProfileId?: string;
  /**
   * Optional new total duration in minutes — resizes the appointment (e.g. a
   * drag on the calendar to give a client a little more or less time). The delta
   * versus the current total is applied to the last service (and its last
   * stylist-occupied segment); ignored when `serviceIds` also changes, since the
   * duration is then recomputed from the new services. Omit to keep the length.
   */
  durationMinutes?: number;
  /**
   * Optional resize of ONE service (e.g. a drag on that service's slice in the
   * calendar). Later services are pushed along, so the total changes by the same
   * amount. Mutually exclusive with `durationMinutes`; ignored when `serviceIds`
   * also changes.
   */
  resizeService?: RescheduleServiceResize;
  /**
   * Optional replacement service list (catalogue service IDs). When provided, the
   * appointment's services — and therefore its price, deposit and total duration —
   * are replaced with these. Omit to keep the current services unchanged. The
   * assigned stylist must be eligible for every service in the list.
   */
  serviceIds?: string[];
}

export interface RescheduleServiceResize {
  /** The booked appointment service line to resize (`StaffBookingServiceLine.id`). */
  lineId: string;
  /**
   * Index of the stylist-occupied segment to resize. Required when the line has
   * segments (development time can't be resized); omit for a segment-less line.
   */
  segmentIndex?: number;
  /** New length in minutes of that segment, or of the whole line when it has none. */
  durationMinutes: number;
}

export interface RescheduleAppointmentResponse {
  appointment: StaffBookingDetail;
}

// ---------------------------------------------------------------------------
// Cancellation policy (owner/manager-configured, per location)
//
// Controls how far ahead of an appointment a customer may self-cancel with a
// deposit refund, and rebook. Persisted as `core.location_settings
// .cancellation_notice_hours`; this contract is expressed in whole days because
// that is how the policy is configured and communicated.
// ---------------------------------------------------------------------------

export interface LocationCancellationPolicy {
  locationId: string;
  /**
   * Days before the appointment start that a customer may cancel (with a deposit
   * refund) or rebook. Cancelling inside this window forfeits the deposit and
   * rebooking is blocked.
   */
  cancellationWindowDays: number;
}

export interface GetCancellationPolicyResponse {
  settings: LocationCancellationPolicy;
}

export interface UpdateCancellationPolicyRequest {
  locationId: string;
  cancellationWindowDays: number;
}

export interface UpdateCancellationPolicyResponse {
  settings: LocationCancellationPolicy;
}

export interface StaffBookingPatchTestSummary {
  status: 'unknown' | 'pending' | 'passed' | 'failed' | 'expired';
  performedAt?: string;
  expiresAt?: string;
}

export interface ListStaffBookingsResponse {
  bookings: StaffBookingSummary[];
  scope: 'owner' | 'manager' | 'stylist';
  rangeStart?: string;
  rangeEnd?: string;
}

export type LabSessionStatus = 'unlocking' | 'active' | 'locked' | 'expired' | 'logged_out';

export type DevicePairingStatus = 'unpaired' | 'pairing' | 'paired' | 'disconnected' | 'revoked';

// Canonical appointment lifecycle: pending → accepted / rejected →
// checked_in → awaiting_payment → paid, plus the terminal states cancelled
// (customer/salon cancellation) and no_show. Backed by
// booking.appointment_status_enum.
export type AppointmentStatus =
  | 'pending'
  | 'accepted'
  | 'rejected'
  | 'checked_in'
  | 'awaiting_payment'
  | 'paid'
  | 'cancelled'
  | 'no_show';

export type FormulaStatus = 'draft' | 'mixing' | 'ready_for_review' | 'saved' | 'voided';

export type StylistPinCredentialStatus = 'active' | 'inactive' | 'locked' | 'rotation_required';

export interface PinUnlockRequest {
  deviceId: string;
  locationId: string;
  pin: string;
}

export interface PinUnlockResponse {
  sessionId: string;
  status: LabSessionStatus;
  businessId?: string;
  locationId?: string;
  sharedDeviceId?: string;
  userProfileId: string;
  staffProfileId?: string;
  displayName: string;
  role: Extract<UserRole, 'owner' | 'manager' | 'stylist'>;
  expiresAt: string;
}

export interface LabPinCredentialStatus {
  userProfileId: string;
  staffProfileId?: string;
  displayName: string;
  email: string;
  /** The member's role for this location — drives lab capabilities on unlock. */
  role: Extract<UserRole, 'owner' | 'manager' | 'stylist'>;
  locationId: string;
  locationName: string;
  status: 'not_set' | StylistPinCredentialStatus;
  isActive: boolean;
  failedAttempts: number;
  lockedUntil?: string;
  lastVerifiedAt?: string;
  lastRotatedAt?: string;
  updatedAt?: string;
}

export interface ListLabPinStatusesResponse {
  /** PIN-eligible members (owners, managers and stylists) across the scope. */
  credentials: LabPinCredentialStatus[];
  scope: 'owner' | 'manager';
}

export interface SetLabPinRequest {
  locationId: string;
  userProfileId: string;
  pin: string;
}

export interface ResetLabPinRequest {
  locationId: string;
  userProfileId: string;
}

export interface LabPinMutationResponse {
  credential: LabPinCredentialStatus;
}

export interface LabSessionContext {
  sessionId: string;
  businessId: string;
  locationId: string;
  sharedDeviceId: string;
  userProfileId: string;
  displayName: string;
  role: Extract<UserRole, 'owner' | 'manager' | 'stylist'>;
  status: LabSessionStatus;
  startedAt: string;
  lastActivityAt: string;
  expiresAt: string;
}

export interface SharedDevice {
  id: string;
  businessId: string;
  locationId: string;
  deviceName: string;
  deviceType: 'ipad' | 'tablet' | 'browser';
  stationLabel?: string;
  appMode: 'sheer_lab';
  status: 'registered' | 'active' | 'inactive' | 'revoked';
  registeredAt: string;
  lastSeenAt?: string;
}

export interface LabDeviceRegistrationResponse {
  device: SharedDevice;
  deviceSessionToken: string;
}

export interface LabDeviceResolveResponse {
  device: SharedDevice;
  location: BusinessLocationSummary;
}

export interface SharedDeviceSummary extends SharedDevice {
  locationName: string;
}

export interface ListLabDevicesResponse {
  devices: SharedDeviceSummary[];
  scope: 'owner' | 'manager';
}

export interface RevokeLabDeviceRequest {
  deviceId: string;
}

export interface LabDeviceMutationResponse {
  device: SharedDeviceSummary;
}

export type SheerLabAnalyticsRange = 'today' | 'week' | 'month' | 'custom';

export interface SheerLabAnalyticsSummary {
  colourRevenueCents: number;
  formulaCostCents: number;
  grossMarginCents: number;
  grossMarginPercent: number;
  wasteCostCents: number;
  wastePercentOfRevenue: number;
  formulasMixed: number;
  worstLocationName?: string;
  currencyCode: string;
}

export interface SheerLabLocationMetric {
  locationId: string;
  locationName: string;
  colourRevenueCents: number;
  formulaCostCents: number;
  grossMarginCents: number;
  grossMarginPercent: number;
  wasteCostCents: number;
  formulasMixed: number;
  currencyCode: string;
}

export interface SheerLabStylistMetric {
  stylistProfileId?: string;
  stylistName: string;
  locationId: string;
  locationName: string;
  hourlyRate?: number;
  contractedHours?: number;
  averageBillBenchmark?: number;
  colourRevenueCents: number;
  formulaCostCents: number;
  grossMarginCents: number;
  grossMarginPercent: number;
  wasteCostCents: number;
  formulasMixed: number;
  currencyCode: string;
}

export interface SheerLabServiceTypeMetric {
  serviceType: string;
  formulaCount: number;
  averageFormulaCostCents: number;
  currencyCode: string;
}

export interface SheerLabProductUsageMetric {
  productId?: string;
  productName: string;
  brand?: string;
  totalWeightGrams: number;
  totalCostCents: number;
  formulaCount: number;
  currencyCode: string;
}

export interface SheerLabLowStockAlert {
  id: string;
  locationId: string;
  locationName: string;
  productId: string;
  productName: string;
  brand?: string;
  remainingQuantityGrams: number;
  thresholdQuantityGrams: number;
  status: 'open' | 'acknowledged' | 'resolved';
  lastTriggeredAt: string;
}

export interface SheerLabAnalyticsResponse {
  range: SheerLabAnalyticsRange;
  rangeStart: string;
  rangeEnd: string;
  scope: 'owner' | 'manager';
  summary: SheerLabAnalyticsSummary;
  byLocation: SheerLabLocationMetric[];
  byStylist: SheerLabStylistMetric[];
  averageFormulaCostByServiceType: SheerLabServiceTypeMetric[];
  mostUsedProductsByWeight: SheerLabProductUsageMetric[];
  mostUsedProductsByCost: SheerLabProductUsageMetric[];
  lowStockAlerts: SheerLabLowStockAlert[];
}

// ---------------------------------------------------------------------------
// Owner / manager dashboard KPIs
// ---------------------------------------------------------------------------

export type DashboardDateRange = 'today' | 'week' | 'month';

export interface DashboardLocationSummary {
  id: string;
  name: string;
  code?: string;
  addressLine1?: string;
  city?: string;
}

export interface DashboardKpiSummary {
  totalRevenueCents: number;
  totalBookings: number;
  completedBookings: number;
  cancelledBookings: number;
  noShowBookings: number;
  newClients: number;
  repeatClients: number;
  rebookedVisits: number;
  rebookingRatePercent: number;
  stylistRebookedVisits: number;
  clientRebookedVisits: number;
  completedPaidBookings: number;
  averageBookingValueCents: number;
  lowStockProducts: number;
  currencyCode: string;
}

export interface DashboardLocationKpiSummary extends DashboardKpiSummary {
  locationId: string;
  locationName: string;
}

export interface DashboardKpisResponse {
  rangeStart: string;
  rangeEnd: string;
  scope: 'owner' | 'manager';
  selectedLocationId?: string;
  locations: DashboardLocationSummary[];
  summary: DashboardKpiSummary;
  byLocation: DashboardLocationKpiSummary[];
}

export interface DashboardTopService {
  serviceName: string;
  bookingCount: number;
  revenueCents: number;
  currencyCode: string;
}

export interface DashboardTopServicesResponse {
  rangeStart: string;
  rangeEnd: string;
  scope: 'owner' | 'manager';
  selectedLocationId?: string;
  services: DashboardTopService[];
}

export interface DashboardStylistPerformance {
  staffProfileId?: string;
  stylistName: string;
  locationId: string;
  locationName: string;
  hourlyRate?: number;
  contractedHours?: number;
  averageBillBenchmark?: number;
  totalBookings: number;
  completedBookings: number;
  cancelledBookings: number;
  noShowBookings: number;
  rebookedVisits: number;
  rebookingRatePercent: number;
  revenueCents: number;
  averageBookingValueCents: number;
  currencyCode: string;
}

export interface DashboardStylistPerformanceResponse {
  rangeStart: string;
  rangeEnd: string;
  scope: 'owner' | 'manager';
  selectedLocationId?: string;
  stylists: DashboardStylistPerformance[];
}

export interface DashboardInventoryAlert {
  locationId: string;
  locationName: string;
  productId: string;
  productName: string;
  brand?: string;
  quantityOnHandGrams: number;
  thresholdGrams: number;
}

export interface DashboardInventoryAlertsResponse {
  scope: 'owner' | 'manager';
  selectedLocationId?: string;
  count: number;
  alerts: DashboardInventoryAlert[];
}

// ---------------------------------------------------------------------------
// KPI engine
//
// Trusted, per-stylist KPI outputs computed entirely from persisted business
// data (rota hours, billing visits + line items, rebooking outcomes, retail
// stock movements). These are the authoritative inputs the commission engine
// will consume — `allKpisMet` is the commission lock/unlock gate.
//
// Money is expressed in integer minor units (cents) everywhere for parity
// with the billing tables. Percentages are integers (e.g. 50 == 50%).
// ---------------------------------------------------------------------------

/** Named reporting windows the dashboards already use. */
export type KpiPeriod = 'today' | 'week' | 'month';

/**
 * Data-quality markers attached to a stylist result so dashboards never
 * present a misleading number as if it were authoritative.
 */
export type KpiDataNote =
  | 'no_hours_worked' // no rostered hours in the window → no service/retail target
  | 'no_completed_visits' // rebooking / average-bill denominators are zero
  | 'missing_benchmark' // stylist has no owner-defined average-bill benchmark
  | 'retail_attribution_approximate'; // retail derived from inventory movements (see notes)

/** Rebooking KPI — rate of completed source visits that led to a real follow-up. */
export interface RebookingKpiResult {
  completedVisits: number;
  rebookedVisits: number;
  /** Of the rebooked visits, the split by who initiated it (both count equally). */
  stylistRebookedVisits: number;
  clientRebookedVisits: number;
  rebookingRatePercent: number;
  thresholdPercent: number; // 50
  met: boolean;
}

/** Retail KPI — actual retail sales vs the retail target (10% of service target). */
export interface RetailKpiResult {
  retailTargetCents: number;
  actualRetailSalesCents: number;
  /** actual − target: positive is a surplus, negative is a shortfall. */
  varianceCents: number;
  met: boolean;
}

/** Average-bill KPI — stylist's realised average bill vs their owner-set benchmark. */
export interface AverageBillKpiResult {
  benchmarkCents: number; // 0 when unset
  hasBenchmark: boolean;
  paidVisits: number;
  actualAverageBillCents: number;
  /** actual − benchmark. */
  varianceCents: number;
  met: boolean;
}

/**
 * Commission tier for the period, by service-revenue multiple of labour cost.
 *  - `below_3x`        multiple < 3.0          → 0%
 *  - `tier_3x`         3.0 ≤ multiple < 3.5    → 10%
 *  - `tier_3_5x`       multiple ≥ 3.5, KPIs not all met → 15%
 *  - `tier_3_5x_unlocked` multiple ≥ 3.5 AND all KPIs met → 30% (replaces 15%)
 */
export type CommissionTier = 'below_3x' | 'tier_3x' | 'tier_3_5x' | 'tier_3_5x_unlocked';

/**
 * Commission engine output for one stylist over one period (V1 rules).
 *
 * Base = service revenue only, where service revenue INCLUDES the formula/colour
 * charge (product_usage) but EXCLUDES retail and deposits. Tiers are decided by
 * the multiple of that base over labour cost (hourly rate × hours worked); the
 * all-KPIs gate only promotes the 3.5x tier from 15% → 30%.
 */
export interface CommissionResult {
  /** Labour cost = hourly rate × hours worked (the 1.0x reference). */
  laborCostCents: number;
  /** Service revenue used as the commission base (service + colour, no retail). */
  commissionBaseCents: number;
  /** commissionBase ÷ labourCost, e.g. 3.42. 0 when there is no labour cost. */
  serviceMultiple: number;
  tier: CommissionTier;
  /** 0 | 10 | 15 | 30. */
  ratePercent: number;
  /** Payable commission = base × rate%. */
  commissionAmountCents: number;
  /** True when all-KPIs-met promoted the 3.5x tier from 15% to 30%. */
  kpiUnlockApplied: boolean;
  /**
   * If not already on the top tier, what the next step needs. Helps dashboards
   * show "X away from the next tier" without re-deriving the rules.
   */
  nextTier?: {
    tier: CommissionTier;
    ratePercent: number;
    /** Extra service-revenue (cents) needed to reach the next multiple, if any. */
    additionalServiceRevenueCents?: number;
    /** True when the next tier additionally requires all KPIs to be met. */
    requiresAllKpis?: boolean;
  };
}

/** The full KPI snapshot for one stylist over one period. */
export interface StylistKpiResult {
  staffProfileId: string;
  stylistName: string;
  locationId: string;
  locationName: string;
  currencyCode: string;

  // Target engine outputs
  hoursWorked: number; // net of breaks, approved leave and absence
  hourlyRateCents: number;
  serviceTargetCents: number; // hourlyRate × 3 × hoursWorked
  retailTargetCents: number; // 10% of service target

  // Realised actuals (from paid visits + retail movements)
  actualServiceRevenueCents: number;
  actualRetailRevenueCents: number;
  serviceTargetProgressPercent: number;
  retailTargetProgressPercent: number;

  // KPI categories
  rebooking: RebookingKpiResult;
  retail: RetailKpiResult;
  averageBill: AverageBillKpiResult;

  // Convenience mirrors of the per-category outcomes
  rebookingKpiMet: boolean;
  retailKpiMet: boolean;
  averageBillKpiMet: boolean;

  /** Commission lock/unlock gate: true only when all three KPIs are met. */
  allKpisMet: boolean;

  /** Commission engine output derived from the targets, revenue and KPI gate. */
  commission: CommissionResult;

  notes: KpiDataNote[];
}

export interface StylistKpiResponse {
  periodStart: string; // ISO
  periodEnd: string; // ISO (exclusive)
  period?: KpiPeriod;
  scope: 'owner' | 'manager' | 'stylist';
  selectedLocationId?: string;
  stylist: StylistKpiResult;
}

export interface StylistKpiListResponse {
  periodStart: string; // ISO
  periodEnd: string; // ISO (exclusive)
  period?: KpiPeriod;
  scope: 'owner' | 'manager';
  selectedLocationId?: string;
  locations: DashboardLocationSummary[];
  stylists: StylistKpiResult[];
  /** Stylists whose every KPI is met — i.e. eligible for commission unlock. */
  commissionReadyCount: number;
}

// ---------------------------------------------------------------------------
// Retail sales — first-class retail revenue
//
// Stylist-attributed product sales with stock deduction. The authoritative
// source for the retail KPI and (indirectly) commission. Money in cents.
// ---------------------------------------------------------------------------

export type RetailPaymentMethod = 'cash' | 'card_reader' | 'other';

export interface RetailSale {
  id: string;
  businessId: string;
  locationId: string;
  staffProfileId?: string;
  productId: string;
  productName?: string;
  clientProfileId?: string;
  visitId?: string;
  quantity: number;
  unitPriceCents: number;
  totalAmountCents: number;
  currencyCode: string;
  paymentMethod?: RetailPaymentMethod;
  soldAt: string; // ISO
  notes?: string;
  createdAt: string; // ISO
  // Pricing provenance snapshot taken at the moment of sale (0096). Absent on
  // sales recorded before the pricing feature or rung up without the resolver.
  unitCostCents?: number;
  pricingMode?: RetailPricingMode;
  pricingSource?: RetailPricingSource;
  /** The configured rule value at sale time: markup % or fixed price cents. 0 is real. */
  pricingConfiguredValue?: number;
  effectiveMarkupPercent?: number;
}

export interface RecordRetailSaleRequest {
  locationId: string;
  productId: string;
  /** Selling stylist credited for the retail KPI. Optional for desk sales. */
  staffProfileId?: string;
  clientProfileId?: string;
  visitId?: string;
  quantity: number;
  /** Omit to default to the product's configured retail price. */
  unitPriceCents?: number;
  paymentMethod?: RetailPaymentMethod;
  /** ISO timestamp of the sale; defaults to now server-side. */
  soldAt?: string;
  notes?: string;
}

export interface RecordRetailSaleResponse {
  sale: RetailSale;
}

export interface RetailSalesListResponse {
  scope: 'owner' | 'manager';
  selectedLocationId?: string;
  rangeStart?: string; // ISO
  rangeEnd?: string; // ISO
  sales: RetailSale[];
  totalAmountCents: number;
  currencyCode: string;
}

// ---------------------------------------------------------------------------
// Sheer mobile app dashboard
// ---------------------------------------------------------------------------

export interface MobileClientProfileSummary {
  id: string;
  displayName: string;
  communicationPreference?: 'whatsapp' | 'sms' | 'email';
}

export interface MobileClientDashboardResponse {
  role: 'client';
  profile: MobileClientProfileSummary;
  nextAppointment?: StaffBookingSummary;
  upcomingAppointments: StaffBookingSummary[];
  visitHistory: CrmVisitSummary[];
}

// ---------------------------------------------------------------------------
// Customer self-profile: salons the customer has joined.
//
// A QLOOQO customer account is a single global identity (name/phone) that can
// belong to many salons — one `client_profile` per salon, each with its own
// immutable client code and communication preference. The customer's own
// profile lists these as tiles (see {@link CustomerSalonsResponse}); tapping a
// tile opens the per-salon detail (see {@link CustomerSalonDetailResponse}).
// ---------------------------------------------------------------------------
export interface CustomerSalonSummary {
  /** The customer's client-profile id at this salon (their per-salon record). */
  clientProfileId: string;
  businessId: string;
  businessName: string;
  locationId?: string;
  locationName?: string;
  city?: string;
  /** Per-salon client code (globally unique, immutable). */
  clientCode: string;
  communicationPreference?: CommunicationPreference;
  visitCount: number;
  lastVisitAt?: string;
}

export interface CustomerSalonsResponse {
  salons: CustomerSalonSummary[];
}

export interface CustomerSalonDetailResponse {
  salon: CustomerSalonSummary;
  /** Recent visits at this salon (most recent first). */
  visits: CrmVisitSummary[];
  /** The customer's colour formulas recorded at this salon (client-safe view). */
  formulas: ClientLabFormulaSummary[];
}

// Client-facing lab/colour history: a cost-stripped view of a customer's own
// saved formulas so they can see what colour and products were used on them.
// Salon cost, waste, billing and inventory data are intentionally omitted — the
// raw FormulaHistoryRecord (in @sheer/lab-core) must never be returned to clients.
export interface ClientLabFormulaItem {
  productName: string;
  brand?: string;
  shade?: string;
  developer?: string;
  ratio?: string;
  processingTimeMinutes?: number;
  // Note: item `notes` are intentionally excluded — that free-text field can
  // carry stylist-internal remarks and is not safe to surface to clients.
}

export interface ClientLabFormulaSummary {
  id: string;
  savedAt: string;
  serviceType?: string;
  appointmentId?: string;
  visitId?: string;
  items: ClientLabFormulaItem[];
}

export interface ClientLabHistoryResponse {
  formulas: ClientLabFormulaSummary[];
}

/** One service performed during a visit (snapshot taken at booking time). */
export interface ClientVisitServiceLine {
  name: string;
  priceAmount?: number;
  durationMinutes?: number;
}

/**
 * A single colour product used in a visit's formula. Unlike the cost-stripped
 * `ClientLabFormulaItem` (client Lab tab), the visit detail also exposes the
 * amount used and its recorded cost.
 */
export interface ClientVisitColourItem {
  productName: string;
  brand?: string;
  shade?: string;
  developer?: string;
  ratio?: string;
  processingTimeMinutes?: number;
  /** Grams of product used in the finalized mix. */
  grams?: number;
  /** Recorded cost for this colour, in major currency units. */
  priceAmount?: number;
}

export interface ClientVisitColourFormula {
  id: string;
  savedAt?: string;
  items: ClientVisitColourItem[];
}

/**
 * Full detail for a single past visit shown when a client taps a row in their
 * visit history: the services performed, the stylist, the colour products used,
 * and how much was paid.
 */
export interface ClientVisitDetail {
  id: string;
  status: string;
  occurredAt: string;
  stylistName?: string;
  serviceSummary?: string;
  services: ClientVisitServiceLine[];
  /** Saved colour formulas recorded against this visit; each lists its products. */
  colourFormulas: ClientVisitColourFormula[];
  /** Total count of colour products used across every formula on the visit. */
  colourCount: number;
  /**
   * Tax label (e.g. "VAT") when the location applies tax and all displayed
   * service/colour prices are tax-inclusive; undefined when tax is disabled.
   */
  taxLabel?: string;
  /** Full bill (services + colours, VAT-inclusive), in major currency units. */
  totalAmount?: number;
  /** Deposit paid at booking (= total − balance collected at checkout). */
  depositAmount?: number;
  /** Balance collected at checkout (salon_payments), in major currency units. */
  amountPaid?: number;
  currencyCode?: string;
  paymentMethod?: string;
  paidAt?: string;
}

export interface MobileStylistDashboardResponse {
  role: 'stylist';
  displayName: string;
  today: {
    rangeStart: string;
    rangeEnd: string;
    totalAppointments: number;
    nextAppointment?: StaffBookingSummary;
    appointments: StaffBookingSummary[];
  };
}

export interface MobileManagerDashboardResponse {
  role: 'manager';
  location: AuthLocation;
  today: {
    rangeStart: string;
    rangeEnd: string;
    bookingsCount: number;
    completedBookingsCount: number;
    upcomingBookingsCount: number;
    stylistsWorkingToday: number;
    lowStockAlertCount: number;
    recentAppointments: StaffBookingSummary[];
  };
}

export interface MobileOwnerDashboardResponse {
  role: 'owner';
  displayName: string;
  message: string;
  locations: AuthLocation[];
}

// ---------------------------------------------------------------------------
// Inventory management
// ---------------------------------------------------------------------------

export type InventoryStockMovementType =
  | 'opening_balance'
  | 'restock'
  | 'manual_adjustment'
  | 'formula_usage'
  | 'formula_waste'
  | 'formula_reversal'
  | 'retail_sale'
  | 'salon_consumption'
  | 'correction';

export interface InventoryProduct {
  id: string;
  businessId: string;
  brand?: string;
  name: string;
  /** FK to the inventory category, or undefined when uncategorised. */
  categoryId?: string;
  /** Resolved category name for display; undefined when uncategorised. */
  category?: string;
  sku?: string;
  sizeValue?: number;
  sizeUnit: string;
  defaultUnit: string;
  defaultCostPerGramCents?: number;
  retailPriceCents?: number;
  lowStockThresholdGrams: number;
  isActive: boolean;
  /**
   * What one unit of the stored stock quantity means for this product.
   * `gram`/`millilitre` keep the historical gram semantics; `unit` means the
   * stored quantity counts whole items.
   */
  stockUnit: StockUnit;
  /** Base quantities in one sellable/orderable pack (a 100g tube = 100). */
  packSize?: number;
  /** Scannable identifier (EAN/UPC or supplier code); unique per business. */
  barcode?: string;
  /** Supplier this product is ordered from; undefined when unassigned. */
  supplierId?: string;
  /** Resolved supplier name for display; undefined when unassigned. */
  supplierName?: string;
  /** Smallest order the supplier accepts, in packs of `packSize`. Default 1. */
  minimumOrderQuantity: number;
  /** Supplier order step in packs (6 = sold by the half-dozen). Default 1. */
  orderMultiple: number;
  /** Days without outbound movement before stock counts as dead; undefined falls back to the location default. */
  deadStockDays?: number;
  /** Product-use classification (0079). Consumed by the salon itself. */
  isSalonUse: boolean;
  /** Product-use classification (0079). Used by QLOOQO Lab formulas. */
  isLabUse: boolean;
  /** Product-use classification (0079). Sold to clients to take home. */
  isRetail: boolean;
  /** Markup applied when billed through Lab usage. Stored even when off. */
  labMarkupPercent?: number;
  createdAt: string;
  updatedAt: string;
}

export interface InventoryLocationStock {
  id: string;
  businessId: string;
  locationId: string;
  locationName: string;
  productId: string;
  productName: string;
  brand?: string;
  sku?: string;
  category?: string;
  quantityOnHandGrams: number;
  lowStockThresholdGrams?: number;
  effectiveLowStockThresholdGrams: number;
  isLowStock: boolean;
  isActive: boolean;
  updatedAt: string;
}

export interface InventoryStockMovement {
  id: string;
  businessId: string;
  locationId: string;
  locationName: string;
  productId: string;
  productName: string;
  brand?: string;
  locationStockId?: string;
  movementType: InventoryStockMovementType;
  quantityDeltaGrams: number;
  unitCostCents?: number;
  totalCostCents?: number;
  referenceType?: string;
  referenceId?: string;
  reason?: string;
  notes?: string;
  /** Acting user profile id — an internal identifier, never a primary display value. */
  createdBy?: string;
  /** Resolved actor name for display; undefined for system/automated movements. */
  createdByName?: string;
  createdAt: string;
}

export interface InventoryLowStockAlert {
  id: string;
  locationId: string;
  locationName: string;
  productId: string;
  productName: string;
  brand?: string;
  remainingQuantityGrams: number;
  thresholdQuantityGrams: number;
  status: 'open' | 'acknowledged' | 'resolved';
  lastTriggeredAt: string;
}

export interface ListInventoryProductsResponse {
  products: InventoryProduct[];
}

export interface InventoryProductResponse {
  product: InventoryProduct;
}

export interface UpsertInventoryProductRequest {
  brand?: string | null;
  name: string;
  categoryId?: string | null;
  sku?: string | null;
  sizeValue?: number | null;
  sizeUnit?: string | null;
  defaultUnit?: string | null;
  defaultCostPerGramCents?: number | null;
  retailPriceCents?: number | null;
  lowStockThresholdGrams?: number | null;
  stockUnit?: StockUnit | null;
  packSize?: number | null;
  barcode?: string | null;
  supplierId?: string | null;
  minimumOrderQuantity?: number | null;
  orderMultiple?: number | null;
  deadStockDays?: number | null;
  isSalonUse?: boolean | null;
  isLabUse?: boolean | null;
  isRetail?: boolean | null;
  labMarkupPercent?: number | null;
}

export interface ListInventoryStockResponse {
  stock: InventoryLocationStock[];
  locations: BusinessLocationSummary[];
  scope: 'owner' | 'manager';
}

export interface InitializeInventoryStockRequest {
  locationId: string;
  productId: string;
  quantityOnHandGrams?: number;
  lowStockThresholdGrams?: number | null;
}

export interface AdjustInventoryStockRequest {
  locationId: string;
  productId: string;
  quantityDeltaGrams: number;
  movementType: Extract<InventoryStockMovementType, 'opening_balance' | 'restock' | 'manual_adjustment' | 'retail_sale' | 'correction'>;
  reason?: string | null;
  notes?: string | null;
}

export interface UpdateInventoryStockThresholdRequest {
  lowStockThresholdGrams?: number | null;
  isActive?: boolean;
}

export interface InventoryStockMutationResponse {
  stock: InventoryLocationStock;
}

export interface ListInventoryMovementsResponse {
  movements: InventoryStockMovement[];
}

export interface ListInventoryLowStockResponse {
  alerts: InventoryLowStockAlert[];
}

// --- Dead stock (Week 6 ticket 7) -------------------------------------------

/** Which threshold classified the item: the product override or the location default. */
export type DeadStockThresholdSource = 'product' | 'category' | 'location_default';

export interface InventoryDeadStockItem {
  locationId: string;
  locationName: string;
  productId: string;
  productName: string;
  brand?: string;
  sku?: string;
  category?: string;
  supplierName?: string;
  quantityOnHandGrams: number;
  /** How to read the quantity: grams/millilitres, or whole units. */
  stockUnit: StockUnit;
  /** Last time stock left the shelf; undefined when it never has. */
  lastOutboundAt?: string;
  /** What the idle clock is anchored to (last outbound, else first stocked). */
  idleSince: string;
  daysIdle: number;
  thresholdDays: number;
  thresholdSource: DeadStockThresholdSource;
  /** quantityOnHand × default cost per base unit; undefined when no cost is recorded. */
  estimatedValueCents?: number;
}

export interface ListInventoryDeadStockResponse {
  items: InventoryDeadStockItem[];
  locations: BusinessLocationSummary[];
  /** Sum of estimatedValueCents across items (items with no cost contribute 0). */
  totalEstimatedValueCents: number;
}

// --- Purchase orders (Week 6 tickets 8/9) -----------------------------------

export type PurchaseOrderStatus = 'draft' | 'pending_approval' | 'approved' | 'sent' | 'cancelled';

export interface PurchaseOrderLine {
  id: string;
  productId: string;
  /** Snapshot at draft time — survives later product renames. */
  productName: string;
  /** Base quantities per pack at draft time. */
  packSize?: number;
  stockUnit: StockUnit;
  /** Packs the algorithm suggested. */
  suggestedQuantity: number;
  /** Packs actually being ordered (editable while draft). */
  orderedQuantity: number;
  /** Estimated cost per pack at draft time. */
  unitCostCents?: number;
  lineTotalCents: number;
}

export interface PurchaseOrder {
  id: string;
  orderNumber: string;
  businessId: string;
  locationId: string;
  locationName: string;
  supplierId: string;
  supplierName: string;
  /** Where a send will go; undefined when the supplier has no order email. */
  supplierEmail?: string;
  status: PurchaseOrderStatus;
  currencyCode: string;
  subtotalCents: number;
  notes?: string;
  createdBy?: string;
  submittedAt?: string;
  approvedAt?: string;
  approvedBy?: string;
  sentAt?: string;
  sentToEmail?: string;
  /** Last delivery failure; cleared by a successful send. */
  sendError?: string;
  cancelledAt?: string;
  createdAt: string;
  updatedAt: string;
  lines: PurchaseOrderLine[];
}

export interface ListPurchaseOrdersResponse {
  orders: PurchaseOrder[];
  locations: BusinessLocationSummary[];
}

export interface PurchaseOrderResponse {
  order: PurchaseOrder;
}

/** Result of POST /orders/:id/send. The order state is persisted either way. */
export interface SendPurchaseOrderResponse {
  order: PurchaseOrder;
  delivered: boolean;
  error?: string;
}

/** A product the generator wanted to order but could not. */
export interface UnorderableProduct {
  productId: string;
  productName: string;
  reason: 'no_supplier' | 'no_pack_size';
}

export interface GeneratePurchaseOrdersResponse {
  /** Draft orders created by this run. */
  created: PurchaseOrder[];
  /** Suppliers skipped because an open order already exists. */
  skippedExistingOrder: { supplierId: string; supplierName: string; orderId: string; orderNumber: string }[];
  /** Products with a shortfall the generator could not turn into a line. */
  unorderable: UnorderableProduct[];
  /** True when no product needed ordering at all. */
  nothingNeeded: boolean;
}

export interface InventoryCategory {
  id: string;
  businessId: string;
  name: string;
  description?: string;
  /**
   * Days idle before stock in this category counts as dead. Undefined = inherit
   * the location default. Overrides that default; overridden in turn by a
   * product's own deadStockDays. See inventory.dead_stock_report (0101) for the
   * single place the precedence is applied.
   */
  deadStockDays?: number;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface ListInventoryCategoriesResponse {
  categories: InventoryCategory[];
}

export interface InventoryCategoryResponse {
  category: InventoryCategory;
}

export interface CreateInventoryCategoryRequest {
  name: string;
  description?: string | null;
  isActive?: boolean;
}

export interface UpdateInventoryCategoryRequest {
  name?: string;
  description?: string | null;
  isActive?: boolean;
}

export interface InventorySupplier {
  id: string;
  businessId: string;
  name: string;
  /** Where the Week 7 automated order form is sent. */
  contactEmail?: string;
  contactPhone?: string;
  /** The salon's account number with this supplier, quoted on orders. */
  accountReference?: string;
  /** Typical days from order to delivery; informs reorder planning. */
  leadTimeDays?: number;
  notes?: string;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface ListInventorySuppliersResponse {
  suppliers: InventorySupplier[];
}

export interface InventorySupplierResponse {
  supplier: InventorySupplier;
}

export interface CreateInventorySupplierRequest {
  name: string;
  contactEmail?: string | null;
  contactPhone?: string | null;
  accountReference?: string | null;
  leadTimeDays?: number | null;
  notes?: string | null;
  isActive?: boolean;
}

export interface UpdateInventorySupplierRequest {
  name?: string;
  contactEmail?: string | null;
  contactPhone?: string | null;
  accountReference?: string | null;
  leadTimeDays?: number | null;
  notes?: string | null;
  isActive?: boolean;
}

// ---------------------------------------------------------------------------
// Service catalogue (managed services + service categories)
//
// Service categories live in the `booking` schema and are completely
// independent from product categories (`inventory.categories`). Services may
// only belong to a ServiceCategory; products may only belong to an
// InventoryCategory. The two never overlap.
// ---------------------------------------------------------------------------

export interface ServiceCategory {
  id: string;
  businessId: string;
  name: string;
  description?: string;
  /** #RRGGBB tile colour for the appointment book; undefined uses the neutral default. */
  colorHex?: string;
  /**
   * Which kind of colour work this category is (0091). Drives Colour Prep and
   * the colour billing rules; undefined means "not a colour service" and its
   * appointments are excluded from prep planning.
   */
  billingCategory?: ServiceBillingCategory;
  isActive: boolean;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
}

export interface ListServiceCategoriesResponse {
  categories: ServiceCategory[];
}

export interface ServiceCategoryResponse {
  category: ServiceCategory;
}

export interface CreateServiceCategoryRequest {
  name: string;
  description?: string | null;
  colorHex?: string | null;
  /** Null/omitted = not colour work. */
  billingCategory?: ServiceBillingCategory | null;
  isActive?: boolean;
  sortOrder?: number;
}

export interface UpdateServiceCategoryRequest {
  name?: string;
  description?: string | null;
  colorHex?: string | null;
  /** Explicit null clears the tag; omitted keeps it. */
  billingCategory?: ServiceBillingCategory | null;
  isActive?: boolean;
  sortOrder?: number;
}

export type ServiceDepositType = 'none' | 'fixed_amount' | 'percentage';

/**
 * An ordered step within a service (e.g. "Apply colour"), with its own time to
 * complete. When a service has segments, its total duration is the sum of its
 * segment durations.
 */
export interface ServiceSegment {
  id: string;
  businessId: string;
  serviceId: string;
  name: string;
  /** Time to complete this segment, in minutes (always ≥ 1). */
  durationMinutes: number;
  /**
   * When true the stylist is free during this segment (e.g. colour development),
   * so the window is bookable for another client even though the appointment
   * still spans it. The segment still counts toward the service's total duration.
   */
  isStylistFree: boolean;
  /** Position within the service, 0-based; the display order. */
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
}

/**
 * A segment to persist as part of an upsert. Order is taken from the array
 * position, so no explicit sortOrder is sent.
 */
export interface ServiceSegmentInput {
  name: string;
  durationMinutes: number;
  /** Marks this segment as stylist-free ("development time"). Defaults to false. */
  isStylistFree?: boolean;
}

/**
 * A segment as it appears on a booked appointment or a bookable service — the
 * minimal shape the booking engine and the appointment-book calendar need to
 * split a service into occupied vs stylist-free (development) windows.
 */
export interface BookingSegmentSummary {
  name: string;
  durationMinutes: number;
  isStylistFree: boolean;
}

/** A bookable service in the managed catalogue. */
export interface ManagedService {
  id: string;
  businessId: string;
  /** Null/undefined means the service applies to every location. */
  locationId?: string;
  name: string;
  description?: string;
  /** FK to the service category, or undefined when uncategorised. */
  serviceCategoryId?: string;
  /** Resolved category name for display; undefined when uncategorised. */
  category?: string;
  estimatedDurationMinutes: number;
  /** Price in major currency units (e.g. pounds), matching numeric(12,2). */
  basePrice: number;
  depositType: ServiceDepositType;
  depositValue: number;
  requiresPatchTest: boolean;
  /**
   * When true, completing an appointment that includes this service schedules a
   * retention "time to rebook" nudge (see Wrike #4507281502). Suppressed if the
   * client has already rebooked.
   */
  rebookingNudgeEnabled: boolean;
  /** Days after completion to send the nudge (default 35 ≈ 5 weeks). */
  rebookingNudgeIntervalDays: number;
  isActive: boolean;
  sortOrder: number;
  currencyCode: string;
  /**
   * Ordered segments that make up the service. Empty when the service has no
   * breakdown, in which case estimatedDurationMinutes is a manual value.
   */
  segments: ServiceSegment[];
  createdAt: string;
  updatedAt: string;
}

export interface ListManagedServicesResponse {
  services: ManagedService[];
}

/**
 * Active services that currently have no bookable stylist qualified to perform
 * them. Surfaced as a dashboard warning so owners can assign stylists — an
 * unassigned service cannot be booked.
 */
export interface UnassignedServicesResponse {
  services: ManagedService[];
}

export interface ManagedServiceResponse {
  service: ManagedService;
}

export interface UpsertServiceRequest {
  name: string;
  description?: string | null;
  serviceCategoryId?: string | null;
  locationId?: string | null;
  estimatedDurationMinutes: number;
  basePrice?: number;
  depositType?: ServiceDepositType;
  depositValue?: number;
  requiresPatchTest?: boolean;
  /** Toggle the per-service rebooking nudge (Wrike #4507281502). */
  rebookingNudgeEnabled?: boolean;
  /** Days after completion to send the nudge (1–365, default 35). */
  rebookingNudgeIntervalDays?: number;
  isActive?: boolean;
  sortOrder?: number;
  /**
   * Ordered segments to replace the service's current set (array order = display
   * order). When non-empty, estimatedDurationMinutes is derived server-side from
   * the sum of these segments. An empty array clears all segments (the manual
   * estimatedDurationMinutes then applies). Omit the field entirely to leave the
   * service's existing segments unchanged.
   */
  segments?: ServiceSegmentInput[];
}

/**
 * Persist a new display order for the catalogue. `ids` are the rows in the
 * desired order; the server assigns sort_order by index and pushes any rows not
 * listed (e.g. inactive rows hidden in the UI) after them. Shared shape for both
 * service categories and services.
 */
export interface ReorderCatalogueRequest {
  ids: string[];
}

// ---------------------------------------------------------------------------
// Public client booking flow
// ---------------------------------------------------------------------------

export interface PublicBookingLocationSummary {
  id: string;
  businessId: string;
  name: string;
  slug: string;
  /** Public-facing Salon Code for this location (see {@link PublicSalonSummary}). */
  salonCode?: string;
  timezone: string;
  currencyCode: string;
  appointmentSlotMinutes: number;
  allowNextAvailable: boolean;
  cancellationNoticeHours?: number;
  addressLine1?: string;
  addressLine2?: string;
  city?: string;
  region?: string;
  postalCode?: string;
  countryCode?: string;
  phone?: string;
}

export interface PublicBookingServiceSummary {
  id: string;
  name: string;
  description?: string;
  /** FK to the managed service category; undefined when uncategorised. */
  serviceCategoryId?: string;
  /** Resolved category name, used to group services in the booking flow. */
  category?: string;
  /** #RRGGBB tint for the category, for section headers. */
  categoryColorHex?: string;
  /** Category display order (lower sorts first); undefined when uncategorised. */
  categorySortOrder?: number;
  estimatedDurationMinutes: number;
  startingPriceAmount: number;
  depositRequiredAmount: number;
  /**
   * Deposit policy for this service. Carried so a per-stylist price change can
   * recompute a percentage deposit off the effective price (see
   * {@link depositForServicePrice}). Undefined on summaries built before this
   * field existed (treated as a non-recomputable deposit).
   */
  depositType?: ServiceDepositType;
  /** Deposit value: a fixed amount for `fixed_amount`, a percent for `percentage`. */
  depositValue?: number;
  currencyCode: string;
  /**
   * Ordered segment breakdown (empty when the service has no segments). The
   * booking engine uses this to work out which sub-windows actually occupy the
   * stylist so bookings can interleave during stylist-free (development) time.
   */
  segments: BookingSegmentSummary[];
}

export interface PublicBookingUpgradeSuggestion {
  id: string;
  triggerServiceId: string;
  suggestedServiceId: string;
  title: string;
  description: string;
  service: PublicBookingServiceSummary;
}

export interface PublicBookingFinishingRequirement {
  id: string;
  triggerServiceId: string;
  title: string;
  description?: string;
  requiredServiceIds: string[];
  requiredServices: PublicBookingServiceSummary[];
}

export interface PublicBookingStylistSummary {
  staffProfileId: string;
  displayName: string;
  colorHex?: string;
  bio?: string;
  /**
   * Public URL of the provider's photo, when set. The same
   * `staff_profiles.photo_url` field surfaced internally (Team Module) — reused
   * here for the client-facing stylist picker, no duplicate storage. See Wrike
   * #4507281523.
   */
  photoUrl?: string;
  nextAvailableAt?: string;
  /**
   * This stylist's effective price for each selected service — the per-stylist
   * override where set, otherwise the service base price. Lets the selection UI
   * show the stylist's price the moment they are picked, without a round-trip.
   * See booking.staff_service_eligibility.price_amount.
   */
  servicePrices?: { serviceId: string; priceAmount: number }[];
  /** Sum of this stylist's effective per-service prices for the selected services. */
  totalPriceAmount?: number;
}

export interface PublicBookingServiceSelectionResponse {
  location: PublicBookingLocationSummary;
  services: PublicBookingServiceSummary[];
  finishingRequirements: PublicBookingFinishingRequirement[];
  upgradeSuggestions: PublicBookingUpgradeSuggestion[];
}

export interface PublicBookingLocationsResponse {
  locations: PublicBookingLocationSummary[];
}

// ---------------------------------------------------------------------------
// Salon directory — public discovery by Salon Code or name (Week 9 Salon Suite)
// ---------------------------------------------------------------------------

/**
 * Minimal, public-safe view of a salon/location resolved from its Salon Code.
 * Contains only information that is safe to expose to unauthenticated clients
 * searching the directory — never internal codes, billing or staff data.
 */
export interface PublicSalonSummary {
  locationId: string;
  businessId: string;
  /** The globally-unique, public-facing Salon Code. */
  salonCode: string;
  name: string;
  businessName: string;
  slug: string;
  businessSlug: string;
  city?: string;
  region?: string;
  postalCode?: string;
  countryCode?: string;
  phone?: string;
}

/**
 * Canonical form of a Salon Code as typed, pasted or put in a link: upper-cased
 * with separators and spaces removed ("k7m-2qx" → "K7M2QX").
 */
export function normalizeSalonCode(value: string): string {
  return (value ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

/** Resolve a single salon from an exact Salon Code. */
export interface SalonLookupResponse {
  salon: PublicSalonSummary | null;
}

/** Search the salon directory by Salon Code, salon name, or provider Q Code. */
export interface SalonSearchResponse {
  salons: PublicSalonSummary[];
}

export interface PublicBookingStylistsResponse {
  location: PublicBookingLocationSummary;
  services: PublicBookingServiceSummary[];
  totalDurationMinutes: number;
  totalPriceAmount: number;
  totalDepositRequiredAmount: number;
  stylists: PublicBookingStylistSummary[];
  nextAvailableAt?: string;
}

export interface PublicBookingAvailabilitySlot {
  startAt: string;
  endAt: string;
  startTime?: string;
  endTime?: string;
  date: string;
  locationId: string;
  staffProfileId: string;
  stylistId?: string;
  stylistName: string;
  totalDurationMinutes?: number;
}

export interface PublicBookingAvailabilityResponse {
  location: PublicBookingLocationSummary;
  services: PublicBookingServiceSummary[];
  totalDurationMinutes: number;
  /**
   * Estimated total for the selected services. When the query targets a specific
   * stylist, `services[].startingPriceAmount` and this total reflect that
   * stylist's per-service prices; otherwise they are the service base prices.
   */
  totalPriceAmount: number;
  totalDepositRequiredAmount: number;
  slots: PublicBookingAvailabilitySlot[];
  /**
   * Per-stylist effective prices for the bookable stylists behind `slots`, so a
   * "next available" selection can show + charge the stylist actually resolved
   * for the chosen slot. Look the stylist up by the selected slot's
   * staffProfileId, then feed `servicePrices` to {@link applyStylistServicePrices}.
   * Present for both specific-stylist and next-available queries.
   */
  stylists?: PublicBookingStylistSummary[];
}

/**
 * The deposit due for a service at a (possibly stylist-overridden) price. A
 * `percentage` deposit follows the effective price; `fixed_amount` and `none`
 * deposits do not depend on price, so the service's existing
 * `depositRequiredAmount` is kept. Mirrors the server's calculateServiceDeposit
 * so the deposit is resolved identically on API + clients once a per-stylist
 * price override is applied. Rounds percentage deposits to the nearest whole
 * unit, matching the server.
 */
export function depositForServicePrice(
  service: PublicBookingServiceSummary,
  priceAmount: number,
): number {
  if (service.depositType === 'percentage' && service.depositValue !== undefined) {
    return Math.max(0, Math.round((priceAmount * service.depositValue) / 100));
  }
  return service.depositRequiredAmount;
}

/**
 * Returns a copy of `services` with each `startingPriceAmount` replaced by the
 * stylist's effective price for that service (from
 * PublicBookingStylistSummary.servicePrices), and `depositRequiredAmount`
 * recomputed for percentage deposits off that price (see
 * {@link depositForServicePrice}). Services without an entry keep their base
 * price + deposit. Shared by web + mobile so per-stylist estimate pricing is
 * resolved identically everywhere. Returns the original array when there are no
 * per-stylist prices (e.g. "any available" / next-available before a slot is
 * resolved).
 */
export function applyStylistServicePrices(
  services: PublicBookingServiceSummary[],
  servicePrices?: { serviceId: string; priceAmount: number }[] | null,
): PublicBookingServiceSummary[] {
  if (!servicePrices || servicePrices.length === 0) return services;
  const byServiceId = new Map(servicePrices.map((p) => [p.serviceId, p.priceAmount]));
  return services.map((service) => {
    const price = byServiceId.get(service.id);
    return price === undefined
      ? service
      : { ...service, startingPriceAmount: price, depositRequiredAmount: depositForServicePrice(service, price) };
  });
}

export interface PublicBookingClientDetails {
  firstName: string;
  lastName: string;
  email?: string;
  phone?: string;
}

export interface CreatePublicBookingRequest {
  locationId: string;
  serviceIds: string[];
  staffProfileId: string;
  selectedStartAt: string;
  staffRequestMode: 'specific_staff' | 'next_available';
  client: PublicBookingClientDetails;
  communicationPreference: 'whatsapp' | 'sms' | 'email';
  clientProfileId: string;
  bookedByUserProfileId: string;
  clientNote?: string;
  source?: 'public_booking_flow' | 'mobile_app';
}

export interface StartPublicBookingCheckoutRequest {
  locationId: string;
  serviceIds: string[];
  staffProfileId: string;
  selectedStartAt: string;
  staffRequestMode: 'specific_staff' | 'next_available';
  client: PublicBookingClientDetails;
  communicationPreference: 'whatsapp' | 'sms' | 'email';
  clientProfileId: string;
  bookedByUserProfileId: string;
  clientNote?: string;
  source?: 'public_booking_flow' | 'mobile_app';
}

export interface MobileBookingConfirmRequest {
  locationId: string;
  serviceIds: string[];
  staffProfileId: string;
  selectedStartAt: string;
  staffRequestMode: 'specific_staff' | 'next_available';
  communicationPreference: 'whatsapp' | 'sms' | 'email';
  clientNote?: string;
}

export interface MobileBookingStartCheckoutRequest extends MobileBookingConfirmRequest {}

export interface PublicBookingAppointmentSummary {
  id: string;
  locationId: string;
  serviceIds: string[];
  serviceNames: string[];
  totalDurationMinutes: number;
  totalPriceAmount: number;
  staffProfileId: string;
  stylistName: string;
  scheduledStartAt: string;
  scheduledEndAt: string;
  status: AppointmentStatus;
  clientDisplayName: string;
  communicationPreference: string;
  depositRequiredAmount: number;
  currencyCode: string;
}

export type PublicBookingAttemptStatus =
  | 'pending_payment'
  | 'confirmed'
  | 'payment_failed'
  | 'cancelled'
  | 'expired';

export interface PublicBookingAttemptSummary {
  id: string;
  status: PublicBookingAttemptStatus;
  locationId: string;
  serviceIds: string[];
  serviceNames: string[];
  totalDurationMinutes: number;
  totalPriceAmount: number;
  staffProfileId: string;
  stylistName: string;
  selectedStartAt: string;
  selectedEndAt: string;
  clientDisplayName: string;
  communicationPreference: string;
  depositAmount: number;
  currencyCode: string;
  paymentStatus: 'pending' | 'paid' | 'failed' | 'cancelled';
  appointment?: PublicBookingAppointmentSummary;
}

export interface StartPublicBookingCheckoutResponse {
  bookingAttempt: PublicBookingAttemptSummary;
  bookingAttemptId: string;
  clientSecret: string;
  depositAmount: number;
  currencyCode: string;
}

export interface PublicBookingAttemptResponse {
  bookingAttempt: PublicBookingAttemptSummary;
}

export interface CreatePublicBookingResponse {
  appointment: PublicBookingAppointmentSummary;
  depositRequired: boolean;
  depositPlaceholder: boolean;
}

// ---------------------------------------------------------------------------
// Staff (internal) booking
//
// Owner/manager/front-desk/stylist create appointments on behalf of clients —
// walk-ins, phone bookings, manual appointments. This reuses the SAME
// availability engine, appointment schema, and notification pipeline as the
// public/client flow; it differs only in who books (a staff member, not the
// client), the booking channel/source, internal notes, and flexible payment
// handling that does not force the public Stripe deposit path.
// ---------------------------------------------------------------------------

/** How an internal booking originated. Maps onto booking.booking_channel_enum. */
export type StaffBookingSource = 'walk_in' | 'phone_booking' | 'staff_booking';

/**
 * Internal payment handling for a staff-created booking. Unlike the public flow
 * (which forces a Stripe deposit when one is configured), staff record how the
 * booking will be settled without necessarily collecting anything up front.
 */
export type StaffBookingPaymentMode =
  | 'pay_in_salon' // settle at the salon via the normal completion flow
  | 'deposit_waived' // a deposit is configured but the staff member waived it
  | 'deposit_due' // deposit owed; not collected yet (follow up later)
  | 'paid_in_full' // already settled (e.g. cash taken up front)
  | 'no_deposit'; // no deposit configured for the selected services

export interface CreateStaffBookingRequest {
  locationId: string;
  serviceIds: string[];
  staffProfileId: string;
  selectedStartAt: string;
  staffRequestMode: 'specific_staff' | 'next_available';
  /** Existing CRM client to book for. Quick-create a client first if needed. */
  clientProfileId: string;
  communicationPreference: 'whatsapp' | 'sms' | 'email';
  bookingSource: StaffBookingSource;
  paymentMode: StaffBookingPaymentMode;
  /** Client-facing note (may surface to the client). */
  clientNote?: string;
  /** Internal, staff-only note. Never sent to the client. */
  internalNote?: string;
  /** Send the client a confirmation now (still subject to location comms settings). Defaults to true. */
  sendConfirmation?: boolean;
}

export interface CreateStaffBookingResponse {
  appointment: PublicBookingAppointmentSummary;
  bookingSource: StaffBookingSource;
  paymentMode: StaffBookingPaymentMode;
  depositRequiredAmount: number;
  /**
   * Whether a client confirmation send was requested for this booking. Actual
   * delivery still depends on the location's communication settings and the
   * client having a reachable phone/email.
   */
  confirmationScheduled: boolean;
}

export interface ClientBookingSelection {
  locationId: string;
  location?: PublicBookingLocationSummary;
  serviceIds: string[];
  services?: PublicBookingServiceSummary[];
  finishingRequirements?: PublicBookingFinishingRequirement[];
  upgradeSuggestions?: PublicBookingUpgradeSuggestion[];
  staffRequestMode: 'specific_staff' | 'next_available';
  staffProfileId?: string;
  nextAvailableAt?: string;
  selectedSlot?: PublicBookingAvailabilitySlot;
  client?: PublicBookingClientDetails;
  communicationPreference?: 'whatsapp' | 'sms' | 'email';
  account?: {
    accessToken: string;
    refreshToken: string;
    userProfileId: string;
    clientProfileId: string;
    email: string;
  };
  appointment?: PublicBookingAppointmentSummary;
  bookingAttempt?: PublicBookingAttemptSummary;
  bookingAttemptId?: string;
  paymentClientSecret?: string;
}

// ---------------------------------------------------------------------------
// CRM — staff-facing client records
// ---------------------------------------------------------------------------

export type CrmNoteType = 'general' | 'consultation' | 'formula_note' | 'service_note' | 'gdpr';

export type CrmAllergySeverity = 'unknown' | 'mild' | 'moderate' | 'severe';

export type CrmPatchTestStatus = 'pending' | 'passed' | 'failed' | 'expired';

export type CrmVisitPhotoType = 'before' | 'after' | 'inspiration' | 'condition' | 'other';

/**
 * Delivery channels for the messaging foundation. Channel-agnostic by design so
 * the provider abstraction (Twilio for now) can be swapped without touching core
 * tables. `in_app`/`push` are recorded for in-app notification states; the
 * outbound fallback chain is WhatsApp → SMS → Email (Wrike #4507284095).
 */
export type MessageChannel = 'whatsapp' | 'sms' | 'email' | 'in_app' | 'push';

export const MESSAGE_CHANNELS: readonly MessageChannel[] = [
  'whatsapp',
  'sms',
  'email',
  'in_app',
  'push',
];

/** Billable channels that count against the per-location monthly messaging cap. */
export const BILLABLE_MESSAGE_CHANNELS: readonly MessageChannel[] = ['whatsapp', 'sms'];

/**
 * Lifecycle states a message record can move through. Mirrors
 * `comms.notification_status_enum` exactly so DB, API and clients stay aligned:
 * outbound delivery (`queued`→`sent`→`delivered`/`undelivered`/`failed`),
 * in-app read state (`read`), the pre-fallback holding state
 * (`fallback_pending`) and the terminal non-send states (`cancelled`, `skipped`).
 */
export type MessageDeliveryStatus =
  | 'queued'
  | 'sent'
  | 'delivered'
  | 'failed'
  | 'undelivered'
  | 'read'
  | 'fallback_pending'
  | 'cancelled'
  | 'skipped';

export const MESSAGE_DELIVERY_STATES: readonly MessageDeliveryStatus[] = [
  'queued',
  'sent',
  'delivered',
  'failed',
  'undelivered',
  'read',
  'fallback_pending',
  'cancelled',
  'skipped',
];

/** Terminal states — no further transition is expected. */
export const TERMINAL_MESSAGE_DELIVERY_STATES: readonly MessageDeliveryStatus[] = [
  'delivered',
  'failed',
  'undelivered',
  'read',
  'cancelled',
  'skipped',
];

export type CrmMessageChannel = MessageChannel;

export type CrmMessageDeliveryStatus = MessageDeliveryStatus;

/**
 * Per-location, per-month messaging usage counter — the foundation for tier caps
 * and overage tracking. Rows are keyed by (business, location, period) and
 * snapshot the tier cap in force for the period so historical usage stays
 * accurate even if the plan later changes. Enforcement lands in Week 6.
 */
export interface MessagingUsageCounter {
  id: string;
  businessId: string;
  locationId: string;
  /** First day of the calendar month (UTC), ISO date `YYYY-MM-01`. */
  periodMonth: string;
  /** Tier cap snapshot for this period; `null` for unlimited. */
  monthlyCap: number | null;
  /** Billable messages counted this period. */
  sentCount: number;
  /** Messages sent beyond {@link monthlyCap}. */
  overageCount: number;
  updatedAt: string;
  createdAt: string;
}

export interface CrmClientSummary {
  id: string;
  businessId: string;
  clientCode: string;
  primaryLocationId?: string;
  firstName: string;
  lastName: string;
  displayName: string;
  email?: string;
  phone?: string;
  communicationPreference?: 'whatsapp' | 'sms' | 'email' | string;
  notes?: string;
  marketingOptIn: boolean;
  tags: string[];
  source?: string;
  createdAt: string;
  updatedAt: string;
  lastVisitAt?: string;
  alertCounts: {
    activeAllergies: number;
    expiredPatchTests: number;
  };
}

export interface CrmClientProfile extends CrmClientSummary {
  dateOfBirth?: string;
  notesSummary?: string;
  gdpr: {
    exportReady: boolean;
    pendingRequests: number;
    deletionRequestPending: boolean;
  };
}

export interface CrmClientNote {
  id: string;
  businessId: string;
  locationId?: string;
  clientProfileId: string;
  visitId?: string;
  noteType: CrmNoteType;
  content: string;
  createdByUserId?: string;
  createdAt: string;
  updatedAt: string;
}

export interface CrmAllergyRecord {
  id: string;
  businessId: string;
  clientProfileId: string;
  allergenName: string;
  severity: CrmAllergySeverity;
  notes?: string;
  isActive: boolean;
  recordedAt: string;
  recordedByUserId?: string;
}

export interface CrmPatchTestRecord {
  id: string;
  businessId: string;
  locationId?: string;
  clientProfileId: string;
  performedAt: string;
  expiresAt?: string;
  status: CrmPatchTestStatus;
  notes?: string;
  recordedByUserId?: string;
  createdAt: string;
  isExpired: boolean;
}

export interface CrmVisitSummary {
  id: string;
  businessId: string;
  locationId: string;
  appointmentId?: string;
  clientProfileId: string;
  primaryStaffProfileId?: string;
  stylistName?: string;
  status: string;
  occurredAt: string;
  serviceSummary?: string;
  /**
   * What the client originally booked, when it differs from what was performed
   * (0110). Absent when nothing changed after check-in.
   */
  bookedServiceSummary?: string;
  clientVisibleSummary?: string;
  /**
   * Amount associated with the visit in major currency units. Its meaning
   * depends on {@link amountKind}: the deposit paid so far while the appointment
   * is unprocessed, or the full amount paid once it has been checked out.
   */
  priceAmount?: number;
  /** What {@link priceAmount} represents: a deposit (unprocessed) or the full paid total. */
  amountKind?: 'deposit' | 'paid';
  currencyCode?: string;
  rebooked?: boolean;
  rebookSource?: 'stylist' | 'client';
  rebookedAppointmentId?: string;
  rebookedAt?: string;
}

export interface CrmMessageLog {
  id: string;
  businessId: string;
  locationId: string;
  clientProfileId?: string;
  appointmentId?: string;
  visitId?: string;
  channel: CrmMessageChannel;
  primaryIntendedChannel?: CrmMessageChannel;
  eventKey?: string;
  messageType?: string;
  deliveryStatus: CrmMessageDeliveryStatus;
  provider?: string;
  providerMessageId?: string;
  providerStatus?: string;
  recipient?: string;
  templateKey?: string;
  contentPreview?: string;
  renderedSummary?: string;
  failureReason?: string;
  sentAt?: string;
  deliveredAt?: string;
  failedAt?: string;
  createdAt: string;
}

export interface CrmVisitPhoto {
  id: string;
  businessId: string;
  locationId: string;
  visitId: string;
  clientProfileId: string;
  photoType: CrmVisitPhotoType;
  storageBucket: string;
  storagePath: string;
  mimeType?: string;
  uploadedByUserId?: string;
  createdAt: string;
}

/** A single ingredient row of a saved colour formula, as shown on the client profile. */
export interface CrmClientFormulaItem {
  productName: string;
  brand?: string;
  shade?: string;
  developer?: string;
  ratio?: string;
  processingTimeMinutes?: number;
}

/**
 * A saved colour formula surfaced on a client's staff-facing profile: the recipe
 * plus when it was mixed and by which stylist. Deliberately omits product costs,
 * waste and billing — those stay in the Sheer Lab billing views, not the CRM.
 */
export interface CrmClientFormula {
  id: string;
  savedAt: string;
  appointmentId?: string;
  visitId?: string;
  staffProfileId?: string;
  stylistName?: string;
  serviceType?: string;
  /** Formula-level stylist notes. Staff-facing only — never surfaced to clients. */
  notes?: string;
  /** True for a durably-saved draft (recipe persisted, billing/stock reconcile at finalize). */
  isDraft?: boolean;
  items: CrmClientFormulaItem[];
}

export interface CrmClientDetailResponse {
  profile: CrmClientProfile;
  notes: CrmClientNote[];
  visits: CrmVisitSummary[];
  /** Saved colour-formula history for the client, newest first. */
  formulas: CrmClientFormula[];
  /**
   * Deterministic formula-change intelligence (Wrike 4507283774). Computed on
   * read, so it always reflects the salon's current sensitivity settings.
   * Undefined when detection was unavailable — the profile still renders.
   */
  formulaChange?: FormulaChangeAssessment;
  /**
   * Deterministic client-level operational signals (Wrike 4507283793). Computed
   * on read, so they always reflect current data and current thresholds.
   * Undefined when the calculation was unavailable — the profile still renders.
   *
   * Diary signals (back-to-back colour, slot gaps) are deliberately absent: they
   * describe a stylist's day, not a client.
   */
  spendTrend?: SpendTrendSignal;
  noShowRisk?: NoShowRiskSignal;
  allergies: CrmAllergyRecord[];
  patchTests: CrmPatchTestRecord[];
  messages: CrmMessageLog[];
  photos: CrmVisitPhoto[];
}

export interface CrmClientsPagination {
  /** Total clients matching the query across all pages. */
  total: number;
  /** 1-based index of the returned page. */
  page: number;
  /** Page size used for this response. */
  pageSize: number;
  /** Total number of pages (>= 1, even when total is 0). */
  pageCount: number;
}

export interface ListCrmClientsResponse {
  clients: CrmClientSummary[];
  scope: 'owner' | 'manager' | 'stylist';
  /**
   * Present on the CRM Client Hub listing (server-side paginated). The staff
   * booking client search reuses this response shape but omits it.
   */
  pagination?: CrmClientsPagination;
}

/**
 * Lean row returned by the global client search typeahead. Deliberately omits
 * the visit/alert enrichment carried by {@link CrmClientSummary} — the palette
 * refetches on every keystroke, so the endpoint stays a single indexed query.
 */
export interface CrmClientSearchResult {
  id: string;
  clientCode: string;
  firstName: string;
  lastName: string;
  displayName: string;
  email?: string;
  phone?: string;
  primaryLocationId?: string;
}

export interface SearchCrmClientsResponse {
  results: CrmClientSearchResult[];
  pagination: CrmClientsPagination;
}

export interface ListCrmClientNotesResponse {
  notes: CrmClientNote[];
}

export interface ListCrmClientAllergiesResponse {
  allergies: CrmAllergyRecord[];
}

export interface ListCrmClientPatchTestsResponse {
  patchTests: CrmPatchTestRecord[];
}

export interface ListCrmClientVisitsResponse {
  visits: CrmVisitSummary[];
}

export interface ListCrmClientMessagesResponse {
  messages: CrmMessageLog[];
}

export interface ListCrmVisitPhotosResponse {
  photos: CrmVisitPhoto[];
}

export interface CreateCrmClientRequest {
  firstName: string;
  lastName: string;
  email?: string;
  phone?: string;
  primaryLocationId?: string;
  communicationPreference?: 'whatsapp' | 'sms' | 'email';
  marketingOptIn?: boolean;
  source?: string;
  /**
   * When true, skip the "a client with this email already exists" guard and
   * create the record anyway (staff explicitly confirmed a legitimate duplicate,
   * e.g. two people sharing an inbox). Defaults to false.
   */
  allowDuplicate?: boolean;
}

export interface UpdateCrmClientRequest {
  firstName?: string;
  lastName?: string;
  email?: string | null;
  phone?: string | null;
  primaryLocationId?: string | null;
  communicationPreference?: 'whatsapp' | 'sms' | 'email' | null;
  marketingOptIn?: boolean;
  tags?: string[];
  notesSummary?: string | null;
  /**
   * Confirms an email change that collides with another client's email
   * (shared-inbox case). Without it such an edit 409s, mirroring create.
   */
  allowDuplicate?: boolean;
}

/**
 * Payload carried in the 409 ConflictException when a create/update matches an
 * existing client by email or phone. `client` is the full summary so a till
 * flow can adopt the existing record in place ("Use this client").
 */
export interface DuplicateClientConflict {
  message: string;
  matchedBy: 'email' | 'phone';
  existingClient: {
    id: string;
    displayName: string;
    clientCode: string;
  };
  client?: CrmClientSummary;
}

/** Clients sharing an email or phone within the business (possible duplicates). */
export interface ClientDuplicateGroup {
  matchType: 'email' | 'phone';
  /** The shared value as stored (email, or the first row's phone rendering). */
  value: string;
  clients: CrmClientSearchResult[];
}

export interface ListClientDuplicatesResponse {
  groups: ClientDuplicateGroup[];
}

export interface MergeClientsRequest {
  /** The tombstoned profile whose history moves onto the surviving client. */
  duplicateClientId: string;
}

export interface MergeClientsResponse {
  /** The surviving client after the merge (contact gaps filled). */
  client: CrmClientSummary;
  /** Rows repointed per table, e.g. { "booking.appointments": 4 }. */
  movedRecords: Record<string, number>;
}

export interface CreateCrmClientNoteRequest {
  locationId?: string;
  visitId?: string;
  noteType?: CrmNoteType;
  content: string;
}

export interface CreateCrmAllergyRecordRequest {
  allergenName: string;
  severity?: CrmAllergySeverity;
  notes?: string;
  isActive?: boolean;
}

export interface CreateCrmPatchTestRequest {
  locationId?: string;
  performedAt: string;
  expiresAt?: string;
  status: CrmPatchTestStatus;
  notes?: string;
}

export interface CreateCrmVisitPhotoRequest {
  clientProfileId: string;
  photoType?: CrmVisitPhotoType;
  storageBucket: string;
  storagePath: string;
  mimeType?: string;
}

// ---------------------------------------------------------------------------
// Rota — manager-facing core (also reusable by future owner + stylist UIs)
// ---------------------------------------------------------------------------

export type ShiftStatus = 'draft' | 'published' | 'completed' | 'cancelled';

export type LeaveRequestStatus = 'pending' | 'approved' | 'rejected' | 'cancelled';

export type AbsenceType =
  | 'sickness'
  | 'emergency'
  | 'bereavement'
  | 'unauthorised'
  | 'other';

// ---------------------------------------------------------------------------
// Book Out Types — configurable, per-business calendar block-out / absence
// reasons whose three flags drive availability, utilisation and (future)
// payroll. See Wrike #4507280825 review feedback.
// ---------------------------------------------------------------------------

export interface BookOutType {
  id: string;
  businessId: string;
  /** Stable machine key, unique per business (system rows use well-known keys). */
  key: string;
  name: string;
  /** When false, clients can still be booked over this block. */
  blocksAppointments: boolean;
  /** When true, the time is removed from the utilisation denominator (available hours). */
  reducesAvailableHours: boolean;
  /** When true, the time counts as paid working time (reserved for payroll/reporting). */
  countsAsPaidTime: boolean;
  colorHex?: string;
  /** System rows are platform-seeded — editable but not deletable. */
  isSystem: boolean;
  isActive: boolean;
  sortOrder: number;
}

/** Behavioural flags a book-out type contributes; used by the utilisation engine. */
export interface BookOutTypeBehaviour {
  blocksAppointments: boolean;
  reducesAvailableHours: boolean;
  countsAsPaidTime: boolean;
}

/**
 * Legacy fallback: absences with no book-out type (created before the catalog,
 * or via the old enum path) both block appointments and reduce available hours,
 * preserving the historical behaviour.
 */
export const LEGACY_BOOK_OUT_BEHAVIOUR: BookOutTypeBehaviour = {
  blocksAppointments: true,
  reducesAvailableHours: true,
  countsAsPaidTime: false,
};

/** System book-out types seeded for every business (mirrors migration 0061). */
export const SYSTEM_BOOK_OUT_TYPES: Array<
  Pick<
    BookOutType,
    'key' | 'name' | 'blocksAppointments' | 'reducesAvailableHours' | 'countsAsPaidTime' | 'colorHex' | 'sortOrder'
  >
> = [
  { key: 'lunch', name: 'Lunch', blocksAppointments: true, reducesAvailableHours: true, countsAsPaidTime: false, colorHex: '#94a3b8', sortOrder: 10 },
  { key: 'staff_meeting', name: 'Staff meeting', blocksAppointments: true, reducesAvailableHours: true, countsAsPaidTime: true, colorHex: '#6366f1', sortOrder: 20 },
  { key: 'training', name: 'Training', blocksAppointments: true, reducesAvailableHours: false, countsAsPaidTime: true, colorHex: '#8b5cf6', sortOrder: 30 },
  { key: 'admin', name: 'Admin', blocksAppointments: true, reducesAvailableHours: false, countsAsPaidTime: true, colorHex: '#0ea5e9', sortOrder: 40 },
  { key: 'marketing', name: 'Marketing', blocksAppointments: true, reducesAvailableHours: false, countsAsPaidTime: true, colorHex: '#14b8a6', sortOrder: 50 },
  { key: 'annual_leave', name: 'Annual leave', blocksAppointments: true, reducesAvailableHours: true, countsAsPaidTime: false, colorHex: '#22c55e', sortOrder: 60 },
  { key: 'sick_leave', name: 'Sick leave', blocksAppointments: true, reducesAvailableHours: true, countsAsPaidTime: true, colorHex: '#f59e0b', sortOrder: 70 },
  { key: 'other', name: 'Other book out', blocksAppointments: true, reducesAvailableHours: true, countsAsPaidTime: false, colorHex: '#94a3b8', sortOrder: 80 },
];

export interface CreateBookOutTypeRequest {
  name: string;
  blocksAppointments?: boolean;
  reducesAvailableHours?: boolean;
  countsAsPaidTime?: boolean;
  colorHex?: string | null;
  sortOrder?: number;
}

export interface UpdateBookOutTypeRequest {
  name?: string;
  blocksAppointments?: boolean;
  reducesAvailableHours?: boolean;
  countsAsPaidTime?: boolean;
  colorHex?: string | null;
  isActive?: boolean;
  sortOrder?: number;
}

export interface ListBookOutTypesResponse {
  bookOutTypes: BookOutType[];
}

export interface BookOutTypeMutationResponse {
  bookOutType: BookOutType;
}

export interface RotaBreak {
  id: string;
  shiftId: string;
  startedAt: string;
  endedAt: string;
  isPaid: boolean;
  notes?: string;
}

export interface RotaShift {
  id: string;
  businessId: string;
  locationId: string;
  staffProfileId: string;
  status: ShiftStatus;
  scheduledStartAt: string;
  scheduledEndAt: string;
  publishedAt?: string;
  notes?: string;
  breaks: RotaBreak[];
}

export interface RotaStaffSummary {
  staffProfileId: string;
  userProfileId: string;
  fullName: string;
  displayName: string;
  email: string;
  colorHex?: string;
  isBookable: boolean;
  contractedHours: number;
  /** Default break length in minutes (per-stylist config). */
  defaultBreakMinutes: number;
  /** Whether the default break is paid (per-stylist config). */
  defaultBreakIsPaid: boolean;
  defaultBreakNotes?: string;
}

export interface RotaLeaveIndicator {
  id: string;
  staffProfileId: string;
  status: LeaveRequestStatus;
  startDate: string;
  endDate: string;
  reason?: string;
}

export interface RotaAbsenceIndicator {
  id: string;
  staffProfileId: string;
  absenceType: AbsenceType;
  startsAt: string;
  endsAt?: string;
  notes?: string;
  /** Linked configurable book-out type, when one was chosen. */
  bookOutTypeId?: string | null;
  bookOutTypeName?: string;
  bookOutTypeColorHex?: string;
  /**
   * Effective behaviour flags resolved from the linked type (or
   * {@link LEGACY_BOOK_OUT_BEHAVIOUR} when unlinked). Duplicated onto each
   * indicator so the calendar can compute utilisation without a second lookup.
   */
  blocksAppointments: boolean;
  reducesAvailableHours: boolean;
  countsAsPaidTime: boolean;
}

export interface WeeklyRotaResponse {
  locationId: string;
  /** ISO date for the Monday at the start of the requested week (local to the location). */
  weekStart: string;
  /** ISO date for the Monday _after_ the requested week (exclusive end). */
  weekEnd: string;
  staff: RotaStaffSummary[];
  shifts: RotaShift[];
  leave: RotaLeaveIndicator[];
  absences: RotaAbsenceIndicator[];
  /** Echoed location holiday-notice rule (in days). */
  holidayNoticeDays: number;
  /**
   * The location's configured diary granularity (15/30/60). Carried on the
   * rota response because the appointment book is the rota's primary consumer
   * and every diary viewer may read the rota, while the owner-only location
   * settings endpoint is gated too narrowly to serve the grid.
   */
  appointmentSlotMinutes: number;
  /** Echoes the actor's role so the client can branch UI without re-querying /auth/me. */
  scope: 'owner' | 'manager';
}

export interface CreateShiftRequest {
  staffProfileId: string;
  locationId: string;
  /** ISO timestamp. */
  scheduledStartAt: string;
  /** ISO timestamp; must be strictly after scheduledStartAt. */
  scheduledEndAt: string;
  status?: ShiftStatus;
  notes?: string;
  /** Required when scheduledStartAt is in the past. */
  pastEditReason?: string;
}

export interface UpdateShiftRequest {
  scheduledStartAt?: string;
  scheduledEndAt?: string;
  status?: ShiftStatus;
  notes?: string | null;
  /** Required if the shift is in the past or being moved into the past. */
  pastEditReason?: string;
}

export interface ShiftMutationResponse {
  shift: RotaShift;
}

export interface CreateBreakRequest {
  startedAt: string;
  endedAt: string;
  isPaid?: boolean;
  notes?: string;
  pastEditReason?: string;
}

export interface UpdateBreakRequest {
  startedAt?: string;
  endedAt?: string;
  isPaid?: boolean;
  notes?: string | null;
  pastEditReason?: string;
}

export interface BreakMutationResponse {
  shift: RotaShift;
  break: RotaBreak;
}

export interface RotaLeaveRequest {
  id: string;
  businessId: string;
  locationId: string;
  staffProfileId: string;
  startDate: string;
  endDate: string;
  status: LeaveRequestStatus;
  reason?: string;
  reviewedAt?: string;
  reviewedByUserProfileId?: string;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  /** Hydrated staff identity for list rendering. */
  staff?: RotaStaffSummary;
  /** Number of days between today and start_date — useful to render the threshold pill. */
  noticeDays: number;
  /** True when the leave request falls inside the location holiday-notice rule. */
  insideNoticeWindow: boolean;
}

export interface ListLeaveRequestsResponse {
  leaveRequests: RotaLeaveRequest[];
  holidayNoticeDays: number;
  scope: 'owner' | 'manager';
}

export interface ApproveLeaveRequestRequest {
  /** Manager override of the holiday-notice auto-decline rule. Captured in audit. */
  override?: boolean;
  /** Free-form note attached to the approval audit row. */
  reviewerNote?: string;
}

export interface RejectLeaveRequestRequest {
  /** Reason returned to the requesting stylist + captured in audit. */
  reason?: string;
}

export interface LeaveRequestMutationResponse {
  leaveRequest: RotaLeaveRequest;
}

export interface StylistMyWeekResponse {
  weekStart: string;
  weekEnd: string;
  staffProfileId: string;
  locationId: string;
  shifts: RotaShift[];
  leave: RotaLeaveIndicator[];
  absences: RotaAbsenceIndicator[];
}

export interface MyLeaveRequestsResponse {
  leaveRequests: RotaLeaveRequest[];
  holidayNoticeDays: number;
}

export interface CreateMyLeaveRequest {
  startDate: string;
  endDate: string;
  reason?: string;
}

export interface CreateAbsenceRequest {
  staffProfileId: string;
  locationId: string;
  absenceType: AbsenceType;
  startsAt: string;
  endsAt?: string;
  notes?: string;
  /** Optional configurable book-out type driving availability/utilisation. */
  bookOutTypeId?: string;
}

/**
 * Move / reschedule / reassign a placed bookout (rota absence). All fields are
 * optional so the calendar can send only what a drag changed: `startsAt` +
 * `endsAt` for a move or resize, `staffProfileId` to drop it on another stylist.
 */
export interface UpdateAbsenceRequest {
  startsAt?: string;
  endsAt?: string | null;
  staffProfileId?: string;
}

export interface AbsenceMutationResponse {
  absence: RotaAbsenceIndicator;
}

// ---------------------------------------------------------------------------
// Utilisation
//
// Utilisation is measured against AVAILABLE working hours, not raw scheduled
// hours: a stylist rostered 9–6 (9h) who takes a 30m lunch and a 1h staff
// meeting has 7.5h available, so 6h of appointments is 80% — not 66.7%.
// Which blocks reduce "available" is driven by each book-out type's
// `reducesAvailableHours` flag (breaks always reduce it). Pure + deterministic
// so it can be shared by the calendar badge, KPI reports and tests.
// ---------------------------------------------------------------------------

export interface UtilisationIntervalMs {
  startMs: number;
  endMs: number;
}

export interface DailyUtilisationInput {
  /** Rostered (non-cancelled) shift spans, already clamped to the day. */
  shifts: UtilisationIntervalMs[];
  /** All breaks within the shifts — always reduce available hours. */
  breaks: UtilisationIntervalMs[];
  /** Block-out/leave spans whose type has `reducesAvailableHours = true`. */
  reducingBlocks: UtilisationIntervalMs[];
  /** Stylist-occupied appointment time (numerator), in milliseconds. */
  bookedMs: number;
}

export interface DailyUtilisation {
  availableMs: number;
  bookedMs: number;
  /** booked ÷ available × 100, rounded. Null when there is no available time. */
  utilisationPercent: number | null;
}

/**
 * Appointment statuses that occupy the stylist's time and so count toward the
 * utilisation numerator. Cancelled / rejected / no-show bookings free the slot.
 * Shared by the web calendar badge and the server utilisation summary so the
 * two surfaces can never disagree about what "booked" means.
 */
export const UTILISATION_BOOKED_STATUSES = [
  'pending',
  'accepted',
  'checked_in',
  'awaiting_payment',
  'paid',
] as const;

export function normaliseIntervalsMs(intervals: UtilisationIntervalMs[]): UtilisationIntervalMs[] {
  const valid = intervals.filter((i) => i.endMs > i.startMs).sort((a, b) => a.startMs - b.startMs);
  const merged: UtilisationIntervalMs[] = [];
  for (const interval of valid) {
    const last = merged[merged.length - 1];
    if (last && interval.startMs <= last.endMs) last.endMs = Math.max(last.endMs, interval.endMs);
    else merged.push({ startMs: interval.startMs, endMs: interval.endMs });
  }
  return merged;
}

export function subtractIntervalsMs(a: UtilisationIntervalMs[], b: UtilisationIntervalMs[]): UtilisationIntervalMs[] {
  const cuts = normaliseIntervalsMs(b);
  let current = normaliseIntervalsMs(a);
  for (const cut of cuts) {
    const next: UtilisationIntervalMs[] = [];
    for (const interval of current) {
      if (cut.endMs <= interval.startMs || cut.startMs >= interval.endMs) {
        next.push(interval);
        continue;
      }
      if (cut.startMs > interval.startMs) next.push({ startMs: interval.startMs, endMs: cut.startMs });
      if (cut.endMs < interval.endMs) next.push({ startMs: cut.endMs, endMs: interval.endMs });
    }
    current = next;
  }
  return current;
}

export function totalIntervalMs(intervals: UtilisationIntervalMs[]): number {
  return intervals.reduce((sum, i) => sum + Math.max(0, i.endMs - i.startMs), 0);
}

/**
 * Available time = scheduled shift time minus breaks and any book-out/leave
 * blocks flagged as reducing available hours. Utilisation = booked ÷ available.
 */
export function computeDailyUtilisation(input: DailyUtilisationInput): DailyUtilisation {
  const available = subtractIntervalsMs(input.shifts, [...input.breaks, ...input.reducingBlocks]);
  const availableMs = totalIntervalMs(available);
  const bookedMs = Math.max(0, input.bookedMs);
  const utilisationPercent = availableMs > 0 ? Math.round((bookedMs / availableMs) * 100) : null;
  return { availableMs, bookedMs, utilisationPercent };
}

/** Resolve a book-out type's behaviour flags, falling back to legacy defaults. */
export function resolveBookOutBehaviour(type?: BookOutTypeBehaviour | null): BookOutTypeBehaviour {
  return type ?? LEGACY_BOOK_OUT_BEHAVIOUR;
}

export interface SaveWeeklyRotaShiftInput {
  /** Optional id — when set, the shift is updated; otherwise created. */
  id?: string;
  staffProfileId: string;
  scheduledStartAt: string;
  scheduledEndAt: string;
  status?: ShiftStatus;
  notes?: string;
}

export interface SaveWeeklyRotaRequest {
  locationId: string;
  weekStart: string;
  shifts: SaveWeeklyRotaShiftInput[];
  /** Required if any shift in the payload starts before now. */
  pastEditReason?: string;
}

export interface SaveWeeklyRotaResponse {
  saved: RotaShift[];
}

export type RotaCreationMode = 'blank' | 'clone_last_week' | 'generate_from_defaults';

export interface NewWeekDraftBreakInput {
  startedAt: string;
  endedAt: string;
  isPaid?: boolean;
  notes?: string;
}

export interface NewWeekDraftShiftInput {
  staffProfileId: string;
  scheduledStartAt: string;
  scheduledEndAt: string;
  notes?: string;
  breaks?: NewWeekDraftBreakInput[];
}

export interface PreviewNewWeekRequest {
  weekStart: string;
  creationMode: RotaCreationMode;
  locationId?: string;
}

export interface PreviewNewWeekResponse {
  weekStart: string;
  creationMode: RotaCreationMode;
  staffCount: number;
  shiftsToCreate: number;
  breaksToCreate: number;
  warnings: string[];
  draftShifts?: RotaShift[];
}

export interface CreateNewWeekRequest {
  weekStart: string;
  creationMode: RotaCreationMode;
  locationId?: string;
  shifts?: NewWeekDraftShiftInput[];
}

export interface CreateNewWeekResponse {
  weekStart: string;
  shiftsCreated: number;
  breaksCreated: number;
}

// ---------------------------------------------------------------------------
// V1.1 Week 6 — stock units, barcode consumption and Colour Prep
// ---------------------------------------------------------------------------

/**
 * What one unit of the stored stock quantity means for a product. The stored
 * column is still named `quantity_on_hand_grams` for compatibility; renaming it
 * is tracked as technical debt rather than done inside a delivery week.
 */
export type StockUnit = 'gram' | 'millilitre' | 'unit';

/** How a caller expressed a quantity: in base units, or in whole packs. */
export type StockQuantityUnit = 'base' | 'pack';

export interface BarcodeLookupResponse {
  product: InventoryProduct;
  locationId: string;
  quantityOnHandGrams: number;
  lowStockThresholdGrams?: number;
}

export interface RecordProductConsumptionRequest {
  locationId: string;
  /** Either productId or barcode must be supplied. */
  productId?: string;
  barcode?: string;
  /** Positive amount consumed, expressed in `unit`. */
  quantity: number;
  /** Defaults to `base`. `pack` multiplies by the product pack size. */
  unit?: StockQuantityUnit;
  reason?: string;
  notes?: string;
  /** Makes the call safe to retry: a repeat returns the original movement. */
  idempotencyKey?: string;
}

export interface RecordProductConsumptionResponse {
  movementId: string;
  productId: string;
  productName: string;
  locationId: string;
  quantityDeductedGrams: number;
  quantityOnHandGrams: number;
  lowStockThresholdGrams?: number;
  /** True when this call replayed an earlier movement rather than deducting. */
  idempotentReplay: boolean;
}

/** Planning window presets for Colour Prep. */
export type ColourPrepRange = 'today' | 'this_week' | 'next_week' | 'custom';

/**
 * Stock verdict for one required product. `unmapped_product` and `not_stocked`
 * exist so missing data can never be displayed as "enough stock" — the user has
 * to be able to see that intervention is required.
 */
export type ColourPrepStockState =
  | 'sufficient'
  | 'low_stock'
  | 'shortfall'
  | 'not_stocked'
  | 'unmapped_product';

/**
 * Whether a colour appointment resolved a formula. A first-time colour client
 * has no formula and must still appear in the plan as needing consultation,
 * never silently dropped.
 */
export type ColourPrepAppointmentState = 'formula_on_file' | 'no_formula_on_file';

export interface ColourPrepAppointmentItem {
  /** Undefined when the formula line was never linked to a catalogue product. */
  productId?: string;
  productName: string;
  requiredGrams: number;
}

export interface ColourPrepAppointment {
  appointmentId: string;
  scheduledStartAt: string;
  clientProfileId: string;
  clientName: string;
  /** Omitted when the caller may not see staff assignment. */
  stylistName?: string;
  serviceNames: string[];
  billingCategories: ServiceBillingCategory[];
  state: ColourPrepAppointmentState;
  formulaId?: string;
  formulaSavedAt?: string;
  items: ColourPrepAppointmentItem[];
  /**
   * Present ONLY when the client's latest formula differs significantly from
   * their previous comparable one (Wrike 4507283774). Minor changes and clients
   * with no comparable history are omitted entirely, so the prep card stays
   * quiet unless it has something worth a stylist's attention.
   */
  formulaChange?: FormulaChangeAssessment;
}

export interface ColourPrepProductRequirement {
  productId?: string;
  productName: string;
  brand?: string;
  stockUnit: StockUnit;
  /** Sum across appointments, including the waste allowance uplift. */
  requiredGrams: number;
  onHandGrams: number;
  /** max(0, required - onHand). */
  shortfallGrams: number;
  lowStockThresholdGrams?: number;
  state: ColourPrepStockState;
  appointmentCount: number;
}

export interface ColourPrepSummary {
  appointmentCount: number;
  appointmentsWithoutFormula: number;
  productCount: number;
  shortfallProductCount: number;
  lowStockProductCount: number;
  unmappedProductCount: number;
}

export interface ColourPrepPlan {
  locationId: string;
  locationName: string;
  /** IANA zone the window was computed in (core.locations.timezone). */
  timezone: string;
  range: ColourPrepRange;
  /** Inclusive window start as an ISO instant. */
  from: string;
  /** Exclusive window end as an ISO instant. */
  to: string;
  /** Window in local calendar dates, for display. */
  fromDate: string;
  toDate: string;
  /** Uplift applied to required grams (core.location_settings). */
  wasteAllowancePercent: number;
  appointments: ColourPrepAppointment[];
  products: ColourPrepProductRequirement[];
  summary: ColourPrepSummary;
}

export interface ColourPrepResponse {
  plan: ColourPrepPlan;
}

// ---------------------------------------------------------------------------
// Retail pricing (Product Use Classification & Pricing CR — final rules)
//
// One canonical resolver for the retail selling price. Luke's confirmed
// precedence, evaluated strictly in this order, stopping at the FIRST
// configured rule (rules never stack, never add, never multiply):
//
//   1. location_product   — this product at this location
//   2. product            — the product's default
//   3. location_category  — the product's category at this location
//   4. category           — the category's default
//   5. location           — the location's default
//
// Null-vs-zero is structural: NO rule at a level means "inherit from the next
// level"; a rule with markup 0 is an INTENTIONAL zero-markup override that
// stops inheritance. When no rule exists at any level, the legacy behaviour
// applies unchanged: products.retail_price_cents is the selling price.
// ---------------------------------------------------------------------------

export type RetailPricingScope =
  | 'location_product'
  | 'product'
  | 'location_category'
  | 'category'
  | 'location';

export type RetailPricingMode = 'percentage_markup' | 'fixed_price';

export type RetailPricingSource =
  | 'location_product'
  | 'product_default'
  | 'location_category'
  | 'category_default'
  | 'location_default'
  | 'legacy_retail_price'
  | 'manual'
  | 'none';

/** Precedence order, highest first. The resolver walks exactly this list. */
export const RETAIL_PRICING_PRECEDENCE: readonly RetailPricingScope[] = [
  'location_product',
  'product',
  'location_category',
  'category',
  'location',
];

export const RETAIL_PRICING_SOURCE_LABELS: Record<RetailPricingSource, string> = {
  location_product: 'Location-specific product',
  product_default: 'Product default',
  location_category: 'Location-specific category',
  category_default: 'Category default',
  location_default: 'Location default',
  legacy_retail_price: 'Product retail price (legacy)',
  manual: 'Manual till override',
  none: 'No pricing configured',
};

const SCOPE_TO_SOURCE: Record<RetailPricingScope, RetailPricingSource> = {
  location_product: 'location_product',
  product: 'product_default',
  location_category: 'location_category',
  category: 'category_default',
  location: 'location_default',
};

/** A stored pricing rule (one level of the hierarchy). */
export interface RetailPricingRule {
  id: string;
  businessId: string;
  scope: RetailPricingScope;
  productId?: string;
  categoryId?: string;
  locationId?: string;
  pricingMode: RetailPricingMode;
  /** Percent for percentage_markup mode. 0 is a real, intentional value. */
  markupPercent?: number;
  /** Cents for fixed_price mode — the FINAL selling price, not an uplift. */
  fixedPriceCents?: number;
  createdAt: string;
  updatedAt: string;
}

/** The candidate rules for one product+location, keyed by scope. */
export type RetailPricingCandidates = Partial<
  Record<RetailPricingScope, Pick<RetailPricingRule, 'id' | 'pricingMode' | 'markupPercent' | 'fixedPriceCents'>>
>;

/** The canonical resolution result — provenance included, never just a number. */
export interface EffectiveRetailPricing {
  productId: string;
  locationId: string;
  /** Cost per sellable unit in cents; null when the product has no recorded cost. */
  unitCostCents: number | null;
  /**
   * The selling price the winning rule produces. Null only when a percentage
   * rule wins but the product has no cost to mark up (the rule still wins —
   * the price is honestly unknown, never invented).
   */
  sellingPriceCents: number | null;
  pricingMode: RetailPricingMode | null;
  /** The configured value of the winning rule (percent, or fixed cents). */
  configuredValue: number | null;
  /**
   * Markup implied by the final price over cost, for display. Echoes the
   * percent for percentage rules; derived for fixed rules; null when cost is
   * missing or zero (never divide by zero, never fabricate a percentage).
   */
  effectiveMarkupPercent: number | null;
  source: RetailPricingSource;
  sourceRuleId: string | null;
  sourceLabel: string;
  currencyCode: string;
}

/** House rounding: integer cents, cost + round(cost × pct / 100). */
export function applyPercentageMarkup(costCents: number, markupPercent: number): number {
  return costCents + Math.round((costCents * markupPercent) / 100);
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * THE canonical retail pricing resolver. Pure: all data is passed in, so the
 * API, the tests and any display surface share one implementation and cannot
 * diverge. Checks are explicit (`!== undefined`) throughout — 0 is a valid
 * configured value and must never be treated as "unset".
 */
export function resolveRetailPricing(input: {
  productId: string;
  locationId: string;
  /** Cost per sellable unit in cents (pack for weight products, item for unit). */
  unitCostCents: number | null;
  /** products.retail_price_cents — the legacy fallback when no rule exists. */
  legacyRetailPriceCents: number | null;
  candidates: RetailPricingCandidates;
  currencyCode?: string;
}): EffectiveRetailPricing {
  const currencyCode = input.currencyCode ?? 'GBP';
  const base = {
    productId: input.productId,
    locationId: input.locationId,
    unitCostCents: input.unitCostCents,
    currencyCode,
  };

  for (const scope of RETAIL_PRICING_PRECEDENCE) {
    const rule = input.candidates[scope];
    if (rule === undefined) continue; // no rule at this level -> inherit

    const source = SCOPE_TO_SOURCE[scope];
    if (rule.pricingMode === 'fixed_price') {
      const selling = rule.fixedPriceCents ?? null;
      const cost = input.unitCostCents;
      return {
        ...base,
        sellingPriceCents: selling,
        pricingMode: 'fixed_price',
        configuredValue: selling,
        effectiveMarkupPercent:
          selling !== null && cost !== null && cost > 0
            ? round2(((selling - cost) / cost) * 100)
            : null,
        source,
        sourceRuleId: rule.id ?? null,
        sourceLabel: RETAIL_PRICING_SOURCE_LABELS[source],
      };
    }

    // Percentage markup. 0% is a real override: it wins and stops inheritance.
    const percent = rule.markupPercent;
    const cost = input.unitCostCents;
    return {
      ...base,
      sellingPriceCents:
        percent !== undefined && cost !== null ? applyPercentageMarkup(cost, percent) : null,
      pricingMode: 'percentage_markup',
      configuredValue: percent !== undefined ? percent : null,
      effectiveMarkupPercent: percent !== undefined && cost !== null ? percent : null,
      source,
      sourceRuleId: rule.id ?? null,
      sourceLabel: RETAIL_PRICING_SOURCE_LABELS[source],
    };
  }

  // No rule at any level: legacy behaviour, unchanged — the product's stored
  // retail price is the selling price (this is what the till has always done).
  if (input.legacyRetailPriceCents !== null && input.legacyRetailPriceCents !== undefined) {
    const cost = input.unitCostCents;
    const selling = input.legacyRetailPriceCents;
    return {
      ...base,
      sellingPriceCents: selling,
      pricingMode: 'fixed_price',
      configuredValue: selling,
      effectiveMarkupPercent: cost !== null && cost > 0 ? round2(((selling - cost) / cost) * 100) : null,
      source: 'legacy_retail_price',
      sourceRuleId: null,
      sourceLabel: RETAIL_PRICING_SOURCE_LABELS.legacy_retail_price,
    };
  }

  return {
    ...base,
    sellingPriceCents: null,
    pricingMode: null,
    configuredValue: null,
    effectiveMarkupPercent: null,
    source: 'none',
    sourceRuleId: null,
    sourceLabel: RETAIL_PRICING_SOURCE_LABELS.none,
  };
}

/**
 * Cost per SELLABLE unit in cents: what one till transaction of quantity 1
 * costs the salon. Mirrors the deduction arithmetic in record_retail_sale —
 * a weight product sells a pack (pack_size × per-base cost), a unit product
 * sells an item (per-item cost). Null when the product has no recorded cost
 * or no resolvable pack.
 */
export function retailUnitCostCents(product: {
  stockUnit: StockUnit;
  packSize?: number | null;
  sizeValue?: number | null;
  defaultCostPerGramCents?: number | null;
}): number | null {
  const perBase = product.defaultCostPerGramCents;
  if (perBase === null || perBase === undefined) return null;
  if (product.stockUnit === 'unit') return Math.round(perBase);
  const pack = product.packSize ?? product.sizeValue;
  if (pack === null || pack === undefined || pack <= 0) return null;
  return Math.round(perBase * pack);
}

// --- API contracts ----------------------------------------------------------

export interface UpsertRetailPricingRuleRequest {
  scope: RetailPricingScope;
  productId?: string;
  categoryId?: string;
  locationId?: string;
  pricingMode: RetailPricingMode;
  markupPercent?: number;
  fixedPriceCents?: number;
}

export interface RetailPricingRuleResponse {
  rule: RetailPricingRule;
}

export interface ListRetailPricingRulesResponse {
  rules: RetailPricingRule[];
}

export interface EffectiveRetailPricingResponse {
  pricing: EffectiveRetailPricing;
}

/** A product the till may sell at a location, with its resolved price. */
export interface SellableProduct {
  product: InventoryProduct;
  pricing: EffectiveRetailPricing;
}

export interface ListSellableProductsResponse {
  locationId: string;
  products: SellableProduct[];
}

/** Availability of one product across the business's locations. */
export interface ProductLocationAvailability {
  locationId: string;
  locationName: string;
  available: boolean;
}

export interface ProductAvailabilityResponse {
  productId: string;
  locations: ProductLocationAvailability[];
}
