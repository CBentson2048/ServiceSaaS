import { useCallback, useEffect, useMemo, useState } from 'react';
import { Navigate } from 'react-router-dom';
import type {
  EffectiveRetailPricing,
  InventoryCategory,
  InventoryProduct,
  RetailPricingRule,
  RetailPricingScope,
} from '@sheer/domain';
import { RETAIL_PRICING_SOURCE_LABELS, userHasPermission } from '@sheer/domain';
import {
  ApiRequestError,
  deleteRetailPricingRule,
  getEffectiveRetailPricing,
  listInventoryCategories,
  listInventoryProducts,
  listRetailPricingRules,
  upsertRetailPricingRule,
} from '../auth/api';
import { useAuth } from '../auth/AuthProvider';
import {
  describeRule,
  planRuleSave,
  ruleToFormState,
  type PricingMethodChoice,
  type PricingRuleFormState,
} from '../components/inventory/pricingRuleForm';

/**
 * Retail pricing configuration (approved CR). Three separate concerns, three
 * separate panels: what a product IS FOR lives on the product form; WHERE it
 * is sold lives in availability; THIS page owns only what it COSTS. The
 * precedence is Luke's confirmed order — location product > product default >
 * location category > category default > location default — and the effective
 * panel always shows the canonical resolver's answer with its source.
 */
export function RetailPricingPage() {
  const auth = useAuth();
  const accessToken = auth.session?.accessToken;
  const canConfigure = userHasPermission(auth.user, 'settings.billing.manage');
  const locations = auth.user?.locations ?? [];

  const [products, setProducts] = useState<InventoryProduct[]>([]);
  const [categories, setCategories] = useState<InventoryCategory[]>([]);
  const [rules, setRules] = useState<RetailPricingRule[]>([]);
  const [productId, setProductId] = useState('');
  const [categoryId, setCategoryId] = useState('');
  const [effective, setEffective] = useState<Map<string, EffectiveRetailPricing>>(new Map());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const reload = useCallback(async () => {
    if (!accessToken) return;
    setLoading(true);
    setError(null);
    try {
      const [productRes, categoryRes, ruleRes] = await Promise.all([
        listInventoryProducts(accessToken),
        listInventoryCategories(accessToken),
        listRetailPricingRules(accessToken),
      ]);
      setProducts(productRes.products.filter((product) => product.isActive));
      setCategories(categoryRes.categories);
      setRules(ruleRes.rules);
    } catch (err: unknown) {
      setError(err instanceof ApiRequestError ? err.message : 'Unable to load pricing configuration');
    } finally {
      setLoading(false);
    }
  }, [accessToken]);

  useEffect(() => {
    void reload();
  }, [reload]);

  // The effective panel always comes from the canonical resolver on the
  // server — never recomputed in browser state.
  const refreshEffective = useCallback(async () => {
    if (!accessToken || !productId) {
      setEffective(new Map());
      return;
    }
    const entries = await Promise.all(
      locations.map(async (location) => {
        try {
          const res = await getEffectiveRetailPricing(accessToken, { productId, locationId: location.id });
          return [location.id, res.pricing] as const;
        } catch {
          return null;
        }
      }),
    );
    setEffective(new Map(entries.filter((entry): entry is [string, EffectiveRetailPricing] => entry !== null)));
  }, [accessToken, productId, locations]);

  useEffect(() => {
    void refreshEffective();
  }, [refreshEffective]);

  if (auth.status === 'authenticated' && !canConfigure) {
    return <Navigate to="/unauthorized" replace />;
  }

  const findRule = (scope: RetailPricingScope, ids: { productId?: string; categoryId?: string; locationId?: string }) =>
    rules.find(
      (rule) =>
        rule.scope === scope &&
        (rule.productId ?? undefined) === ids.productId &&
        (rule.categoryId ?? undefined) === ids.categoryId &&
        (rule.locationId ?? undefined) === ids.locationId,
    );

  async function saveRule(
    scope: RetailPricingScope,
    ids: { productId?: string; categoryId?: string; locationId?: string },
    state: PricingRuleFormState,
  ): Promise<string | null> {
    if (!accessToken) return 'Not signed in';
    const existing = findRule(scope, ids);
    const plan = planRuleSave(state, existing);
    if (plan.action === 'invalid') return plan.message;
    setNotice(null);
    setError(null);
    try {
      if (plan.action === 'delete' && existing) {
        await deleteRetailPricingRule(accessToken, existing.id);
        setNotice('Rule cleared — this level now inherits.');
      } else if (plan.action === 'upsert') {
        await upsertRetailPricingRule(accessToken, {
          scope,
          ...ids,
          pricingMode: plan.pricingMode,
          ...(plan.markupPercent !== undefined ? { markupPercent: plan.markupPercent } : {}),
          ...(plan.fixedPriceCents !== undefined ? { fixedPriceCents: plan.fixedPriceCents } : {}),
        });
        setNotice('Pricing rule saved.');
      } else {
        return null;
      }
      await reload();
      await refreshEffective();
      return null;
    } catch (err: unknown) {
      return err instanceof ApiRequestError ? err.message : 'Could not save the pricing rule';
    }
  }

  const selectedProduct = useMemo(
    () => products.find((product) => product.id === productId) ?? null,
    [products, productId],
  );

  return (
    <>
      <h2 className="sr-only">Retail pricing</h2>
      <header className="mb-5">
        <p className="max-w-2xl text-[13px] text-text-secondary">
          What products sell for. The first configured rule wins, checked in this order:{' '}
          <span className="font-medium text-text-primary">
            location product → product default → location category → category default → location default
          </span>
          . Rules never combine. Leaving a level on <em>Inherit</em> passes the decision down; an explicit{' '}
          <span className="font-medium text-text-primary">0% markup is a real price</span> (cost price) and stops
          inheritance. With no rules anywhere, the product&rsquo;s stored retail price applies as before.
        </p>
      </header>

      {notice ? (
        <div className="mb-4 rounded-input-lg border border-success-border bg-success-soft px-4 py-3 text-[13px] text-success">
          {notice}
        </div>
      ) : null}
      {error ? (
        <div className="mb-4 rounded-input-lg border border-danger-border bg-danger-soft px-4 py-3 text-[13px] text-danger">
          {error}
        </div>
      ) : null}
      {loading ? <div className="mb-4 text-[13px] text-text-secondary">Loading pricing configuration…</div> : null}

      {/* ------------------------------------------------------------------ */}
      <section className="mb-8 rounded-card-lg border border-border bg-surface shadow-card">
        <div className="border-b border-border px-5 py-4">
          <div className="text-[15px] font-semibold text-text-primary">Product pricing</div>
          <div className="mt-0.5 text-[13px] text-text-secondary">
            A product&rsquo;s default rule applies at every location unless a location override exists.
          </div>
        </div>
        <div className="space-y-5 px-5 py-4">
          <select
            value={productId}
            onChange={(event) => setProductId(event.target.value)}
            className="h-10 w-full max-w-md rounded-input-lg border border-border-strong bg-surface px-3 text-[13px] outline-none focus:border-primary"
            aria-label="Product"
          >
            <option value="">Choose a product…</option>
            {products.map((product) => (
              <option key={product.id} value={product.id}>
                {[product.brand, product.name].filter(Boolean).join(' · ')}
              </option>
            ))}
          </select>

          {selectedProduct ? (
            <>
              <RuleEditor
                title="Product default"
                subtitle="Applies at every location unless overridden below."
                rule={findRule('product', { productId })}
                onSave={(state) => saveRule('product', { productId }, state)}
              />
              <div>
                <div className="mb-2 text-[13px] font-semibold text-text-primary">Location overrides</div>
                <div className="grid gap-3 lg:grid-cols-2">
                  {locations.map((location) => (
                    <RuleEditor
                      key={location.id}
                      title={location.name}
                      rule={findRule('location_product', { productId, locationId: location.id })}
                      onSave={(state) => saveRule('location_product', { productId, locationId: location.id }, state)}
                    />
                  ))}
                </div>
              </div>

              {/* Effective — straight from the canonical resolver. */}
              <div>
                <div className="mb-2 text-[13px] font-semibold text-text-primary">Effective price by location</div>
                <div className="grid gap-3 lg:grid-cols-2">
                  {locations.map((location) => {
                    const pricing = effective.get(location.id);
                    return (
                      <div key={location.id} className="rounded-input-lg border border-border bg-surface-alt px-4 py-3">
                        <div className="flex items-baseline justify-between gap-3">
                          <span className="text-[13px] font-medium text-text-primary">{location.name}</span>
                          <span className="text-[16px] font-semibold tabular-nums text-text-primary">
                            {pricing?.sellingPriceCents !== null && pricing?.sellingPriceCents !== undefined
                              ? `£${(pricing.sellingPriceCents / 100).toFixed(2)}`
                              : '—'}
                          </span>
                        </div>
                        <div className="mt-1 text-[12px] text-text-secondary">
                          {pricing ? (
                            <>
                              {RETAIL_PRICING_SOURCE_LABELS[pricing.source]}
                              {pricing.effectiveMarkupPercent !== null
                                ? ` · effective markup ${pricing.effectiveMarkupPercent}%`
                                : pricing.pricingMode === 'percentage_markup' && pricing.sellingPriceCents === null
                                  ? ' · set a product cost to compute this price'
                                  : ''}
                            </>
                          ) : (
                            'Resolving…'
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            </>
          ) : (
            <p className="text-[13px] text-text-muted">Choose a product to configure its pricing.</p>
          )}
        </div>
      </section>

      {/* ------------------------------------------------------------------ */}
      <section className="mb-8 rounded-card-lg border border-border bg-surface shadow-card">
        <div className="border-b border-border px-5 py-4">
          <div className="text-[15px] font-semibold text-text-primary">Category pricing</div>
          <div className="mt-0.5 text-[13px] text-text-secondary">
            Applies to every product in the category that has no product-level rule of its own.
          </div>
        </div>
        <div className="space-y-5 px-5 py-4">
          <select
            value={categoryId}
            onChange={(event) => setCategoryId(event.target.value)}
            className="h-10 w-full max-w-md rounded-input-lg border border-border-strong bg-surface px-3 text-[13px] outline-none focus:border-primary"
            aria-label="Product category"
          >
            <option value="">Choose a category…</option>
            {categories.map((category) => (
              <option key={category.id} value={category.id}>
                {category.name}
              </option>
            ))}
          </select>

          {categoryId ? (
            <>
              <RuleEditor
                title="Category default"
                rule={findRule('category', { categoryId })}
                onSave={(state) => saveRule('category', { categoryId }, state)}
              />
              <div>
                <div className="mb-2 text-[13px] font-semibold text-text-primary">Location overrides</div>
                <div className="grid gap-3 lg:grid-cols-2">
                  {locations.map((location) => (
                    <RuleEditor
                      key={location.id}
                      title={location.name}
                      rule={findRule('location_category', { categoryId, locationId: location.id })}
                      onSave={(state) => saveRule('location_category', { categoryId, locationId: location.id }, state)}
                    />
                  ))}
                </div>
              </div>
            </>
          ) : (
            <p className="text-[13px] text-text-muted">Choose a category to configure its pricing.</p>
          )}
        </div>
      </section>

      {/* ------------------------------------------------------------------ */}
      <section className="rounded-card-lg border border-border bg-surface shadow-card">
        <div className="border-b border-border px-5 py-4">
          <div className="text-[15px] font-semibold text-text-primary">Location defaults</div>
          <div className="mt-0.5 text-[13px] text-text-secondary">
            The final fallback when neither the product nor its category carries a rule.
          </div>
        </div>
        <div className="grid gap-3 px-5 py-4 lg:grid-cols-2">
          {locations.map((location) => (
            <RuleEditor
              key={location.id}
              title={location.name}
              rule={findRule('location', { locationId: location.id })}
              onSave={(state) => saveRule('location', { locationId: location.id }, state)}
            />
          ))}
        </div>
      </section>
    </>
  );
}

// ---------------------------------------------------------------------------

function RuleEditor({
  title,
  subtitle,
  rule,
  onSave,
}: {
  title: string;
  subtitle?: string;
  rule: RetailPricingRule | undefined;
  onSave: (state: PricingRuleFormState) => Promise<string | null>;
}) {
  const [state, setState] = useState<PricingRuleFormState>(() => ruleToFormState(rule));
  const [saving, setSaving] = useState(false);
  const [fieldError, setFieldError] = useState<string | null>(null);

  // Re-sync when the underlying rule changes (reload after save/select).
  const ruleKey = rule ? `${rule.id}:${rule.updatedAt}` : 'none';
  useEffect(() => {
    setState(ruleToFormState(rule));
    setFieldError(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ruleKey]);

  async function handleSave() {
    setSaving(true);
    setFieldError(null);
    const problem = await onSave(state);
    if (problem) setFieldError(problem);
    setSaving(false);
  }

  return (
    <div className="rounded-input-lg border border-border bg-surface p-3.5">
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-[13px] font-semibold text-text-primary">{title}</span>
        <span className="text-[12px] text-text-muted">{describeRule(rule)}</span>
      </div>
      {subtitle ? <p className="mt-0.5 text-[12px] text-text-muted">{subtitle}</p> : null}
      <div className="mt-2.5 flex flex-wrap items-center gap-2">
        <select
          value={state.method}
          onChange={(event) =>
            setState((current) => ({ ...current, method: event.target.value as PricingMethodChoice }))
          }
          className="h-9 rounded-input-lg border border-border-strong bg-surface px-2.5 text-[13px] outline-none focus:border-primary"
          aria-label={`${title} pricing method`}
        >
          <option value="inherit">Inherit</option>
          <option value="percentage_markup">Percentage markup</option>
          <option value="fixed_price">Fixed selling price</option>
        </select>
        {state.method === 'percentage_markup' ? (
          <label className="flex items-center gap-1 text-[13px] text-text-secondary">
            <input
              value={state.markupInput}
              onChange={(event) =>
                setState((current) => ({ ...current, markupInput: event.target.value.replace(/[^0-9.]/g, '') }))
              }
              inputMode="decimal"
              placeholder="e.g. 25"
              aria-label={`${title} markup percent`}
              className="h-9 w-24 rounded-input-lg border border-border-strong bg-surface px-2.5 text-right text-[13px] outline-none focus:border-primary"
            />
            %
          </label>
        ) : null}
        {state.method === 'fixed_price' ? (
          <label className="flex items-center gap-1 text-[13px] text-text-secondary">
            £
            <input
              value={state.priceInput}
              onChange={(event) =>
                setState((current) => ({ ...current, priceInput: event.target.value.replace(/[^0-9.]/g, '') }))
              }
              inputMode="decimal"
              placeholder="e.g. 18.50"
              aria-label={`${title} fixed price`}
              className="h-9 w-28 rounded-input-lg border border-border-strong bg-surface px-2.5 text-right text-[13px] outline-none focus:border-primary"
            />
          </label>
        ) : null}
        <button
          type="button"
          onClick={() => void handleSave()}
          disabled={saving}
          className="h-9 rounded-pill bg-primary px-4 text-[12px] font-semibold text-text-on-primary transition hover:bg-primary-deep disabled:opacity-50"
        >
          {saving ? 'Saving…' : 'Save'}
        </button>
      </div>
      {fieldError ? <p className="mt-2 text-[12px] text-danger">{fieldError}</p> : null}
    </div>
  );
}
