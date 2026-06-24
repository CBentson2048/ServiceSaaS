import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type {
  ChargingStrategy,
  PinUnlockResponse,
  ServiceBillingGlobalParameters,
  ServiceBillingRule,
} from '@sheer/domain';
import { palette } from '@sheer/design-tokens';
import type React from 'react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import type { RootStackParamList } from '../../app/navigation/routes';
import { useBleScale } from '../../features/ble/hooks/useBleScale';
import {
  getServiceBillingRules,
  resetServiceBillingRules,
  updateServiceBillingRules,
} from '../../features/billing/serviceBillingRulesApi';
import { getActiveLabSession } from '../../features/sheer-lab/labSession';
import { LabShell, Pill, c, t, useLabLayout } from '../shared/LabShell';
import { formatMoney } from '../Home/dashboardHelpers';

type BillingRulesScreenProps = NativeStackScreenProps<RootStackParamList, 'BillingRules'>;

type Tab = 'pricing' | 'global';

const STRATEGY_OPTIONS: { key: ChargingStrategy; label: string; hint: string }[] = [
  { key: 'track_only', label: 'Track Only', hint: 'No cost on bill' },
  { key: 'overage', label: 'Overage', hint: 'Charge above allowance' },
  { key: 'charge_all', label: 'Charge All', hint: 'Charge every gram' },
];

function strategyLabel(strategy: ChargingStrategy): string {
  return STRATEGY_OPTIONS.find((o) => o.key === strategy)?.label ?? strategy;
}

export function BillingRulesScreen({ navigation }: BillingRulesScreenProps): React.JSX.Element {
  const ble = useBleScale();
  const layout = useLabLayout();
  const wide = layout.isWide;

  const [session, setSession] = useState<PinUnlockResponse | undefined>();
  const [rules, setRules] = useState<ServiceBillingRule[]>([]);
  const [params, setParams] = useState<ServiceBillingGlobalParameters | undefined>();
  const [baseline, setBaseline] = useState<string>('');

  const [tab, setTab] = useState<Tab>('pricing');
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [notice, setNotice] = useState<string | undefined>();
  const [forbidden, setForbidden] = useState(false);
  // Bumped on every server sync so the uncontrolled number inputs remount and
  // re-seed from the freshly loaded/saved/restored values.
  const [revision, setRevision] = useState(0);

  const canManage = session ? session.role === 'owner' || session.role === 'manager' : false;

  const applyServerState = useCallback(
    (next: { rules: ServiceBillingRule[]; globalParameters: ServiceBillingGlobalParameters }) => {
      setRules(next.rules);
      setParams(next.globalParameters);
      setBaseline(JSON.stringify({ rules: next.rules, params: next.globalParameters }));
      setRevision((r) => r + 1);
    },
    [],
  );

  const load = useCallback(async () => {
    setError(undefined);
    try {
      const active = await getActiveLabSession();
      if (!active) {
        navigation.replace('Auth');
        return;
      }
      setSession(active);

      if (active.role !== 'owner' && active.role !== 'manager') {
        setForbidden(true);
        return;
      }
      setForbidden(false);

      const result = await getServiceBillingRules(active.sessionId);
      applyServerState(result);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Could not load billing rules');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [navigation, applyServerState]);

  useEffect(() => {
    void load();
  }, [load]);

  const handleRefresh = useCallback(() => {
    setRefreshing(true);
    void load();
  }, [load]);

  const dirty = useMemo(() => {
    if (!params || !baseline) return false;
    return JSON.stringify({ rules, params }) !== baseline;
  }, [rules, params, baseline]);

  const updateRule = useCallback((category: ServiceBillingRule['category'], patch: Partial<ServiceBillingRule>) => {
    setRules((prev) => prev.map((r) => (r.category === category ? { ...r, ...patch } : r)));
    setNotice(undefined);
  }, []);

  const updateParam = useCallback((patch: Partial<ServiceBillingGlobalParameters>) => {
    setParams((prev) => (prev ? { ...prev, ...patch } : prev));
    setNotice(undefined);
  }, []);

  const handleSave = useCallback(async () => {
    if (!session || !params || saving) return;
    setSaving(true);
    setError(undefined);
    setNotice(undefined);
    try {
      const result = await updateServiceBillingRules(session.sessionId, {
        rules: rules.map((r) => ({
          category: r.category,
          chargingStrategy: r.chargingStrategy,
          standardAllowanceGrams: r.standardAllowanceGrams,
          salonMarkupPercent: r.salonMarkupPercent,
        })),
        globalParameters: {
          sampleUsageGrams: params.sampleUsageGrams,
          baseCostPerGramCents: params.baseCostPerGramCents,
          currencyCode: params.currencyCode,
          defaultMarkupPercent: params.defaultMarkupPercent,
        },
      });
      applyServerState(result);
      setNotice('Billing & revenue rules saved.');
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Could not save billing rules');
    } finally {
      setSaving(false);
    }
  }, [session, params, rules, saving, applyServerState]);

  const handleReset = useCallback(async () => {
    if (!session || saving) return;
    setSaving(true);
    setError(undefined);
    setNotice(undefined);
    try {
      const result = await resetServiceBillingRules(session.sessionId);
      applyServerState(result);
      setNotice('Standard industry defaults restored.');
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Could not restore defaults');
    } finally {
      setSaving(false);
    }
  }, [session, saving, applyServerState]);

  // ----- render -------------------------------------------------------------

  if (forbidden) {
    return (
      <LabShell active="billing" session={session} bleStatus={ble.status}>
        <View style={styles.lockCard}>
          <Text style={styles.lockGlyph}>🔒</Text>
          <Text style={styles.lockTitle}>Billing rules are owner & manager only</Text>
          <Text style={styles.lockBody}>
            Ask an owner or manager to sign in on this station to configure charging strategies,
            allowances and markups.
          </Text>
        </View>
      </LabShell>
    );
  }

  const previewRule = rules.find((r) => r.category === 'permanent_colour') ?? rules[0];

  return (
    <LabShell
      active="billing"
      session={session}
      bleStatus={ble.status}
      refreshing={refreshing}
      onRefresh={handleRefresh}
    >
      <View style={styles.headerRow}>
        <View style={styles.headerTitleWrap}>
          <View style={styles.shieldBadge}>
            <Text style={styles.shieldGlyph}>🛡️</Text>
          </View>
          <View style={{ flex: 1 }}>
            <Text style={styles.h1}>Billing &amp; Revenue Rules</Text>
            <Text style={styles.sub}>Authorized manager access · live revenue configuration.</Text>
          </View>
        </View>
        {canManage ? (
          <View style={styles.headerActions}>
            <Pressable
              accessibilityRole="button"
              onPress={handleReset}
              disabled={saving}
              style={[styles.resetBtn, saving && styles.btnDisabled]}
            >
              <Text style={styles.resetBtnLabel}>↺ Reset</Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              onPress={handleSave}
              disabled={saving || !dirty}
              style={[styles.saveBtn, (saving || !dirty) && styles.btnDisabled]}
            >
              {saving ? (
                <ActivityIndicator color={c.textOnPrimary} size="small" />
              ) : (
                <Text style={styles.saveBtnLabel}>Save Changes</Text>
              )}
            </Pressable>
          </View>
        ) : null}
      </View>

      {notice ? <Text style={styles.notice}>{notice}</Text> : null}
      {error ? <Text style={styles.errorBanner}>{error}</Text> : null}

      {/* Tabs */}
      <View style={styles.tabBar}>
        <TabButton label="Service Pricing" active={tab === 'pricing'} onPress={() => setTab('pricing')} />
        <TabButton label="Global Parameters" active={tab === 'global'} onPress={() => setTab('global')} />
      </View>

      {loading && rules.length === 0 ? (
        <View style={styles.loading}>
          <ActivityIndicator color={c.primary} />
          <Text style={styles.loadingText}>Loading billing rules…</Text>
        </View>
      ) : (
        <View style={[styles.split, wide && styles.splitWide]}>
          {/* Main column */}
          <View style={styles.flex1}>
            {tab === 'pricing' ? (
              <View key={`pricing-${revision}`} style={styles.cardGrid}>
                {rules.map((rule) => (
                  <ServiceRuleCard
                    key={rule.id}
                    rule={rule}
                    editable={canManage}
                    onChange={(patch) => updateRule(rule.category, patch)}
                  />
                ))}
              </View>
            ) : params ? (
              <GlobalParametersForm
                key={`global-${revision}`}
                params={params}
                editable={canManage}
                onChange={updateParam}
              />
            ) : null}
          </View>

          {/* Right rail */}
          <View style={wide ? styles.rail : undefined}>
            {previewRule && params ? <BillingPreviewPanel rule={previewRule} params={params} /> : null}
            {canManage ? <SmartDefaultsCard onRestore={handleReset} disabled={saving} /> : null}
          </View>
        </View>
      )}
    </LabShell>
  );
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function TabButton({ label, active, onPress }: { label: string; active: boolean; onPress: () => void }) {
  return (
    <Pressable accessibilityRole="tab" onPress={onPress} style={[styles.tabBtn, active && styles.tabBtnActive]}>
      <Text style={[styles.tabBtnLabel, active && styles.tabBtnLabelActive]}>{label}</Text>
    </Pressable>
  );
}

function ServiceRuleCard({
  rule,
  editable,
  onChange,
}: {
  rule: ServiceBillingRule;
  editable: boolean;
  onChange: (patch: Partial<ServiceBillingRule>) => void;
}): React.JSX.Element {
  return (
    <View style={styles.ruleCard}>
      <View style={styles.ruleHead}>
        <View style={{ flex: 1 }}>
          <Text style={styles.ruleTitle}>{rule.categoryLabel}</Text>
          <Text style={styles.ruleDesc}>{rule.categoryDescription}</Text>
        </View>
        <Pill label={strategyLabel(rule.chargingStrategy)} tone="brand" subtle />
      </View>

      <Text style={styles.groupLabel}>CHARGING STRATEGY</Text>
      <View style={styles.segment}>
        {STRATEGY_OPTIONS.map((opt) => {
          const active = opt.key === rule.chargingStrategy;
          return (
            <Pressable
              key={opt.key}
              accessibilityRole="button"
              disabled={!editable}
              onPress={() => onChange({ chargingStrategy: opt.key })}
              style={[styles.segmentItem, active && styles.segmentItemActive]}
            >
              <Text style={[styles.segmentLabel, active && styles.segmentLabelActive]}>{opt.label}</Text>
              <Text style={[styles.segmentHint, active && styles.segmentHintActive]}>{opt.hint}</Text>
            </Pressable>
          );
        })}
      </View>

      <View style={styles.ruleFields}>
        <NumberField
          label="Standard Allowance (g)"
          defaultValue={String(rule.standardAllowanceGrams)}
          editable={editable}
          prefix="⚖"
          onChangeNumber={(n) => onChange({ standardAllowanceGrams: n })}
        />
        <NumberField
          label="Salon Markup (%)"
          defaultValue={String(rule.salonMarkupPercent)}
          editable={editable}
          suffix="%"
          onChangeNumber={(n) => onChange({ salonMarkupPercent: n })}
        />
      </View>
    </View>
  );
}

function GlobalParametersForm({
  params,
  editable,
  onChange,
}: {
  params: ServiceBillingGlobalParameters;
  editable: boolean;
  onChange: (patch: Partial<ServiceBillingGlobalParameters>) => void;
}): React.JSX.Element {
  return (
    <View style={styles.panel}>
      <View style={styles.panelHead}>
        <Text style={styles.panelTitle}>Global Parameters</Text>
        <Text style={styles.panelSub}>Baseline costs and the sample used in the live preview.</Text>
      </View>
      <View style={styles.panelBody}>
        <NumberField
          label="Sample usage for preview (g)"
          defaultValue={String(params.sampleUsageGrams)}
          editable={editable}
          prefix="⚖"
          onChangeNumber={(n) => onChange({ sampleUsageGrams: n })}
        />
        <NumberField
          label={`Base product cost / gram (${params.currencyCode})`}
          defaultValue={(params.baseCostPerGramCents / 100).toFixed(2)}
          editable={editable}
          prefix={currencySymbol(params.currencyCode)}
          onChangeNumber={(n) => onChange({ baseCostPerGramCents: Math.round(n * 100) })}
        />
        <NumberField
          label="Default markup for new rules (%)"
          defaultValue={String(params.defaultMarkupPercent)}
          editable={editable}
          suffix="%"
          onChangeNumber={(n) => onChange({ defaultMarkupPercent: n })}
        />
        <Text style={styles.fieldHint}>
          The base cost per gram feeds the billing preview and is used as the default costing basis
          when a product has no recorded cost.
        </Text>
      </View>
    </View>
  );
}

function BillingPreviewPanel({
  rule,
  params,
}: {
  rule: ServiceBillingRule;
  params: ServiceBillingGlobalParameters;
}): React.JSX.Element {
  const cc = params.currencyCode;
  const used = params.sampleUsageGrams;
  const allowance = rule.standardAllowanceGrams;
  const overageGrams = Math.max(0, used - allowance);
  const chargeableGrams =
    rule.chargingStrategy === 'charge_all' ? used : rule.chargingStrategy === 'overage' ? overageGrams : 0;
  const baseChargeCents = Math.round(chargeableGrams * params.baseCostPerGramCents);
  const markupCents = Math.round(baseChargeCents * (rule.salonMarkupPercent / 100));
  const totalCents = baseChargeCents + markupCents;

  const chargeableLabel =
    rule.chargingStrategy === 'overage'
      ? `Overage (${trimNumber(overageGrams)}g)`
      : rule.chargingStrategy === 'charge_all'
        ? `Chargeable (${trimNumber(used)}g)`
        : 'Chargeable (0g)';

  return (
    <View style={styles.previewCard}>
      <Text style={styles.previewEyebrow}>✦ Billing Preview</Text>
      <Text style={styles.previewSub}>Live simulation of rule outcomes</Text>

      <View style={styles.previewDivider} />
      <PreviewRow label="Sample Usage (Grams)" value={`${trimNumber(used)}g`} strong />
      <PreviewRow label="Base Cost/g" value={formatMoney(params.baseCostPerGramCents, cc)} strong />

      <View style={styles.previewDivider} />
      <PreviewRow label={`Calculated Allowance (${trimNumber(allowance)}g)`} value={formatMoney(0, cc)} />
      <PreviewRow label={chargeableLabel} value={formatMoney(baseChargeCents, cc)} accent />
      <PreviewRow label={`Markup (${trimNumber(rule.salonMarkupPercent)}%)`} value={formatMoney(markupCents, cc)} accent />

      <View style={styles.previewTotalBox}>
        <Text style={styles.previewTotalLabel}>TOTAL BILLING VALUE</Text>
        <View style={styles.previewTotalRow}>
          <Text style={styles.previewTotalValue}>{formatMoney(totalCents, cc)}</Text>
          <View style={styles.roiBadge}>
            <Text style={styles.roiText}>+{trimNumber(rule.salonMarkupPercent)}% ROI</Text>
          </View>
        </View>
      </View>

      <Text style={styles.previewFootnote}>Example based on {rule.categoryLabel} settings</Text>
    </View>
  );
}

function PreviewRow({
  label,
  value,
  strong,
  accent,
}: {
  label: string;
  value: string;
  strong?: boolean;
  accent?: boolean;
}): React.JSX.Element {
  return (
    <View style={styles.previewRow}>
      <Text style={styles.previewRowLabel}>{label}</Text>
      <Text style={[styles.previewRowValue, strong && styles.previewRowValueStrong, accent && styles.previewRowValueAccent]}>
        {value}
      </Text>
    </View>
  );
}

function SmartDefaultsCard({ onRestore, disabled }: { onRestore: () => void; disabled: boolean }): React.JSX.Element {
  return (
    <View style={styles.smartCard}>
      <Text style={styles.smartTitle}>✦ Smart Defaults</Text>
      <Text style={styles.smartBody}>Apply standard industry rules across all service types.</Text>
      <Pressable
        accessibilityRole="button"
        onPress={onRestore}
        disabled={disabled}
        style={[styles.smartBtn, disabled && styles.btnDisabled]}
      >
        <Text style={styles.smartBtnLabel}>Restore Defaults</Text>
      </Pressable>
    </View>
  );
}

function NumberField({
  label,
  defaultValue,
  editable,
  prefix,
  suffix,
  onChangeNumber,
}: {
  label: string;
  defaultValue: string;
  editable: boolean;
  prefix?: string;
  suffix?: string;
  onChangeNumber: (value: number) => void;
}): React.JSX.Element {
  return (
    <View style={styles.field}>
      <Text style={styles.fieldLabel}>{label}</Text>
      <View style={[styles.fieldInputWrap, !editable && styles.fieldInputWrapDisabled]}>
        {prefix ? <Text style={styles.fieldAffix}>{prefix}</Text> : null}
        <TextInput
          defaultValue={defaultValue}
          editable={editable}
          onChangeText={(raw) => {
            const parsed = Number.parseFloat(raw.replace(/[^0-9.]/g, ''));
            onChangeNumber(Number.isFinite(parsed) ? parsed : 0);
          }}
          keyboardType="decimal-pad"
          placeholderTextColor={c.textMuted}
          style={styles.fieldInput}
        />
        {suffix ? <Text style={styles.fieldAffix}>{suffix}</Text> : null}
      </View>
    </View>
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// Drop trailing ".00" / ".50" cruft so a value reads "40" not "40.00" — shared
// by gram allowances and the percentage markups shown in the preview.
function trimNumber(value: number): string {
  if (!Number.isFinite(value)) return '0';
  return Number.isInteger(value) ? String(value) : String(Number(value.toFixed(2)));
}

function currencySymbol(code: string): string {
  switch (code.toUpperCase()) {
    case 'GBP':
      return '£';
    case 'USD':
      return '$';
    case 'EUR':
      return '€';
    default:
      return `${code} `;
  }
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

const PREVIEW_BG = palette.brand[900]; // deep purple
const PREVIEW_ACCENT = palette.brand[300]; // light purple
const PREVIEW_LINE = palette.alpha.whiteLine; // hairline dividers on the dark panel
const PREVIEW_MUTED = palette.alpha.whiteSubtle; // secondary text on the dark panel

const styles = StyleSheet.create({
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: t.spacing.md,
    flexWrap: 'wrap',
  },
  headerTitleWrap: { flexDirection: 'row', alignItems: 'center', gap: t.spacing.md, flex: 1, minWidth: 240 },
  shieldBadge: {
    width: 40,
    height: 40,
    borderRadius: t.radius.card,
    backgroundColor: c.primarySoft,
    alignItems: 'center',
    justifyContent: 'center',
  },
  shieldGlyph: { fontSize: 18 },
  h1: { color: c.textPrimary, fontSize: t.typography.fontSize.heading, fontWeight: '700' },
  sub: { color: c.textSecondary, fontSize: t.typography.fontSize.small, marginTop: 2 },

  headerActions: { flexDirection: 'row', alignItems: 'center', gap: t.spacing.sm },
  resetBtn: {
    minHeight: 42,
    paddingHorizontal: t.spacing.base,
    borderRadius: t.radius.full,
    borderWidth: 1,
    borderColor: c.borderStrong,
    backgroundColor: c.surface,
    alignItems: 'center',
    justifyContent: 'center',
  },
  resetBtnLabel: { color: c.textSecondary, fontWeight: '700', fontSize: t.typography.fontSize.small },
  saveBtn: {
    minHeight: 42,
    minWidth: 132,
    paddingHorizontal: t.spacing.base,
    borderRadius: t.radius.full,
    backgroundColor: c.primary,
    alignItems: 'center',
    justifyContent: 'center',
  },
  saveBtnLabel: { color: c.textOnPrimary, fontWeight: '800', fontSize: t.typography.fontSize.small },
  btnDisabled: { opacity: 0.5 },

  notice: {
    color: c.successText,
    backgroundColor: c.successBg,
    borderColor: c.successBorder,
    borderWidth: 1,
    borderRadius: t.radius.input,
    paddingHorizontal: t.spacing.md,
    paddingVertical: t.spacing.sm,
    fontSize: t.typography.fontSize.small,
  },
  errorBanner: {
    color: c.dangerText,
    backgroundColor: c.dangerBg,
    borderColor: c.dangerBorder,
    borderWidth: 1,
    borderRadius: t.radius.input,
    paddingHorizontal: t.spacing.md,
    paddingVertical: t.spacing.sm,
    fontSize: t.typography.fontSize.small,
  },

  tabBar: {
    flexDirection: 'row',
    gap: t.spacing.xs,
    backgroundColor: c.surfaceAlt,
    borderRadius: t.radius.full,
    borderWidth: 1,
    borderColor: c.border,
    padding: 4,
    alignSelf: 'flex-start',
  },
  tabBtn: { paddingHorizontal: t.spacing.base, paddingVertical: t.spacing.sm, borderRadius: t.radius.full },
  tabBtnActive: { backgroundColor: c.primary },
  tabBtnLabel: { color: c.textSecondary, fontWeight: '700', fontSize: t.typography.fontSize.small },
  tabBtnLabelActive: { color: c.textOnPrimary },

  loading: { padding: t.spacing['2xl'], alignItems: 'center', gap: t.spacing.sm },
  loadingText: { color: c.textMuted, fontSize: t.typography.fontSize.small },

  split: { gap: t.spacing.base },
  splitWide: { flexDirection: 'row', alignItems: 'flex-start' },
  flex1: { flex: 1 },
  rail: { width: 340, flexGrow: 0, flexShrink: 0, gap: t.spacing.base },

  cardGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: t.spacing.base },
  ruleCard: {
    flexGrow: 1,
    flexBasis: 320,
    minWidth: 260,
    backgroundColor: c.surface,
    borderRadius: t.radius.cardLg,
    borderWidth: 1,
    borderColor: c.border,
    padding: t.spacing.base,
    gap: t.spacing.md,
  },
  ruleHead: { flexDirection: 'row', alignItems: 'flex-start', gap: t.spacing.sm },
  ruleTitle: { color: c.textPrimary, fontSize: t.typography.fontSize.bodyLg, fontWeight: '700' },
  ruleDesc: { color: c.textMuted, fontSize: t.typography.fontSize.caption, marginTop: 2 },

  groupLabel: {
    color: c.textMuted,
    fontSize: t.typography.fontSize.micro,
    fontWeight: '700',
    letterSpacing: 0.6,
    textTransform: 'uppercase',
  },
  segment: {
    flexDirection: 'row',
    gap: t.spacing.xs,
    backgroundColor: c.surfaceAlt,
    borderRadius: t.radius.input,
    padding: 4,
  },
  segmentItem: {
    flex: 1,
    paddingVertical: t.spacing.sm,
    paddingHorizontal: 4,
    borderRadius: t.radius.sm,
    alignItems: 'center',
    gap: 2,
  },
  segmentItemActive: { backgroundColor: c.primary },
  segmentLabel: {
    color: c.textSecondary,
    fontSize: t.typography.fontSize.caption,
    fontWeight: '700',
    textTransform: 'uppercase',
    textAlign: 'center',
  },
  segmentLabelActive: { color: c.textOnPrimary },
  segmentHint: { color: c.textMuted, fontSize: 9, textAlign: 'center' },
  segmentHintActive: { color: palette.alpha.whiteHi },

  ruleFields: { flexDirection: 'row', gap: t.spacing.sm },

  field: { flex: 1, gap: 6 },
  fieldLabel: { color: c.textSecondary, fontSize: t.typography.fontSize.caption, fontWeight: '600' },
  fieldInputWrap: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: t.spacing.xs,
    borderWidth: 1,
    borderColor: c.borderStrong,
    borderRadius: t.radius.input,
    paddingHorizontal: t.spacing.md,
    backgroundColor: c.surface,
    minHeight: 44,
  },
  fieldInputWrapDisabled: { opacity: 0.6 },
  fieldAffix: { color: c.textMuted, fontSize: t.typography.fontSize.small, fontWeight: '700' },
  fieldInput: { flex: 1, color: c.textPrimary, fontSize: t.typography.fontSize.body, fontWeight: '700', paddingVertical: t.spacing.sm },
  fieldHint: { color: c.textMuted, fontSize: t.typography.fontSize.caption, lineHeight: t.typography.lineHeight.caption },

  panel: { backgroundColor: c.surface, borderRadius: t.radius.cardLg, borderWidth: 1, borderColor: c.border, overflow: 'hidden' },
  panelHead: { paddingHorizontal: t.spacing.base, paddingVertical: t.spacing.md, borderBottomWidth: 1, borderBottomColor: c.border },
  panelTitle: { color: c.textPrimary, fontSize: t.typography.fontSize.bodyLg, fontWeight: '700' },
  panelSub: { color: c.textMuted, fontSize: t.typography.fontSize.caption, marginTop: 2 },
  panelBody: { padding: t.spacing.base, gap: t.spacing.base },

  // Billing preview (purple)
  previewCard: { backgroundColor: PREVIEW_BG, borderRadius: t.radius.cardLg, padding: t.spacing.lg, gap: 4 },
  previewEyebrow: { color: palette.white, fontSize: t.typography.fontSize.bodyLg, fontWeight: '800' },
  previewSub: { color: PREVIEW_MUTED, fontSize: t.typography.fontSize.caption, marginBottom: t.spacing.sm },
  previewDivider: { height: 1, backgroundColor: PREVIEW_LINE, marginVertical: t.spacing.sm },
  previewRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: t.spacing.sm, paddingVertical: 5 },
  previewRowLabel: { color: PREVIEW_MUTED, fontSize: t.typography.fontSize.small, flex: 1 },
  previewRowValue: { color: palette.white, fontSize: t.typography.fontSize.small, fontWeight: '700' },
  previewRowValueStrong: { color: palette.white },
  previewRowValueAccent: { color: PREVIEW_ACCENT },
  previewTotalBox: {
    marginTop: t.spacing.sm,
    backgroundColor: palette.alpha.whiteSoft,
    borderRadius: t.radius.card,
    borderWidth: 1,
    borderColor: PREVIEW_LINE,
    padding: t.spacing.base,
    gap: t.spacing.xs,
  },
  previewTotalLabel: { color: PREVIEW_ACCENT, fontSize: t.typography.fontSize.micro, fontWeight: '800', letterSpacing: 0.8 },
  previewTotalRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: t.spacing.sm },
  previewTotalValue: { color: palette.white, fontSize: t.typography.fontSize.heading, fontWeight: '800' },
  roiBadge: { backgroundColor: 'rgba(74,222,128,0.18)', borderRadius: t.radius.full, paddingHorizontal: t.spacing.sm, paddingVertical: 4 },
  roiText: { color: palette.success[300], fontSize: t.typography.fontSize.micro, fontWeight: '800' },
  previewFootnote: { color: PREVIEW_MUTED, fontSize: t.typography.fontSize.micro, marginTop: t.spacing.sm, fontStyle: 'italic' },

  // Smart defaults
  smartCard: { backgroundColor: c.surface, borderRadius: t.radius.cardLg, borderWidth: 1, borderColor: c.border, padding: t.spacing.base, gap: t.spacing.sm },
  smartTitle: { color: c.textPrimary, fontSize: t.typography.fontSize.body, fontWeight: '700' },
  smartBody: { color: c.textSecondary, fontSize: t.typography.fontSize.caption, lineHeight: t.typography.lineHeight.caption },
  smartBtn: {
    alignSelf: 'flex-start',
    minHeight: 40,
    paddingHorizontal: t.spacing.base,
    borderRadius: t.radius.full,
    borderWidth: 1,
    borderColor: c.primary,
    backgroundColor: c.primarySoft,
    alignItems: 'center',
    justifyContent: 'center',
  },
  smartBtnLabel: { color: c.primary, fontWeight: '800', fontSize: t.typography.fontSize.small },

  lockCard: { alignItems: 'center', justifyContent: 'center', gap: t.spacing.sm, padding: t.spacing['2xl'], backgroundColor: c.surface, borderRadius: t.radius.cardLg, borderWidth: 1, borderColor: c.border },
  lockGlyph: { fontSize: 34 },
  lockTitle: { color: c.textPrimary, fontSize: t.typography.fontSize.subtitle, fontWeight: '700', textAlign: 'center' },
  lockBody: { color: c.textSecondary, fontSize: t.typography.fontSize.small, textAlign: 'center', maxWidth: 360 },
});
