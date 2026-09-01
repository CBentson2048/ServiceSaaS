import { useCallback, useEffect, useMemo, useState } from 'react';
import type {
  CampaignAudiencePreview,
  CampaignChannel,
  CampaignDetail,
  CampaignStatus,
  CampaignType,
  UpsertCampaignRequest,
} from '@sheer/domain';
import {
  CAMPAIGN_TEMPLATE_VARIABLES,
  defaultCampaignConfig,
  validateCampaignTemplate,
} from '@sheer/domain';
import { AppButton, AppCard, StatusBadge } from '../design';
import {
  ApiRequestError,
  createCampaign,
  listCampaigns,
  previewCampaignAudience,
  runCampaignNow,
  setCampaignStatus,
  updateCampaign,
} from '../auth/api';
import { useAuth } from '../auth/AuthProvider';

/**
 * Owner configuration for automated marketing campaigns.
 *
 * Written for a salon owner, not a marketer. Every campaign renders as a card
 * that answers four questions in plain words — who it reaches, when it goes,
 * how it is delivered, and whether it is on — and the editor shows ONLY the
 * settings that apply to the chosen type. The audience preview is deliberately
 * prominent: seeing "23 clients would receive this, 4 are suppressed and here
 * is why" before switching a campaign on is the single most useful safety
 * feature on the screen.
 *
 * Nothing here can send a message. Saving creates a draft; sending requires
 * enabling the campaign, and even then the server decides the audience.
 */
export function CampaignsPage() {
  const auth = useAuth();
  const accessToken = auth.session?.accessToken;
  const user = auth.user;

  const [campaigns, setCampaigns] = useState<CampaignDetail[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const [editorOpen, setEditorOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<FormState>(() => emptyForm('rebooking'));
  const [saving, setSaving] = useState(false);

  const [preview, setPreview] = useState<CampaignAudiencePreview | null>(null);
  const [previewFor, setPreviewFor] = useState<string | null>(null);

  const locations = useMemo(() => user?.locations ?? [], [user]);

  const load = useCallback(async () => {
    if (!accessToken) return;
    setLoading(true);
    try {
      const result = await listCampaigns(accessToken);
      setCampaigns(result.campaigns);
      setError(null);
    } catch (err) {
      setError(toMessage(err, 'Could not load campaigns'));
    } finally {
      setLoading(false);
    }
  }, [accessToken]);

  useEffect(() => {
    void load();
  }, [load]);

  function startNew(type: CampaignType) {
    setEditingId(null);
    setForm(emptyForm(type));
    setPreview(null);
    setPreviewFor(null);
    setEditorOpen(true);
    setMessage(null);
    setError(null);
  }

  function startEdit(campaign: CampaignDetail) {
    setEditingId(campaign.id);
    setForm(formFromCampaign(campaign));
    setPreview(null);
    setPreviewFor(null);
    setEditorOpen(true);
    setMessage(null);
    setError(null);
  }

  async function handleSave(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!accessToken) return;

    // Validated here as well as on the server, so a typo in a placeholder is a
    // sentence in the form rather than a round trip.
    const templateCheck = validateCampaignTemplate(form.messageTemplate);
    if (!templateCheck.valid) {
      setError(templateCheck.errors.join(' '));
      return;
    }

    setSaving(true);
    setError(null);
    setMessage(null);
    try {
      const payload: UpsertCampaignRequest = {
        campaignType: form.campaignType,
        name: form.name.trim(),
        locationId: form.locationId || null,
        channel: form.channel,
        messageTemplate: form.messageTemplate.trim(),
        messageSubject: form.messageSubject.trim() || null,
        sendAtLocalHour: Number(form.sendAtLocalHour),
        config: configFromForm(form),
      };

      if (editingId) {
        const { campaignType: _ignored, ...patch } = payload;
        await updateCampaign(accessToken, editingId, patch);
        setMessage('Campaign updated.');
      } else {
        await createCampaign(accessToken, payload);
        setMessage('Campaign saved as a draft. Preview the audience, then switch it on when you are happy.');
      }
      setEditorOpen(false);
      setEditingId(null);
      await load();
    } catch (err) {
      setError(toMessage(err, 'Could not save the campaign'));
    } finally {
      setSaving(false);
    }
  }

  async function handleStatus(campaign: CampaignDetail, status: CampaignStatus) {
    if (!accessToken) return;
    setBusyId(campaign.id);
    setError(null);
    setMessage(null);
    try {
      await setCampaignStatus(accessToken, campaign.id, status);
      setMessage(
        status === 'active'
          ? `${campaign.name} is now on. It will run at ${formatHour(campaign.sendAtLocalHour)} each day.`
          : status === 'archived'
            ? `${campaign.name} has been archived.`
            : `${campaign.name} is off. No new messages will be created.`,
      );
      await load();
    } catch (err) {
      setError(toMessage(err, 'Could not change the campaign'));
    } finally {
      setBusyId(null);
    }
  }

  async function handlePreview(campaign: CampaignDetail) {
    if (!accessToken) return;
    setBusyId(campaign.id);
    setError(null);
    setMessage(null);
    try {
      const result = await previewCampaignAudience(accessToken, campaign.id);
      setPreview(result);
      setPreviewFor(campaign.id);
    } catch (err) {
      setError(toMessage(err, 'Could not preview the audience'));
    } finally {
      setBusyId(null);
    }
  }

  async function handleRunNow(campaign: CampaignDetail) {
    if (!accessToken) return;
    setBusyId(campaign.id);
    setError(null);
    setMessage(null);
    try {
      const result = await runCampaignNow(accessToken, campaign.id);
      setMessage(result.message);
      await load();
    } catch (err) {
      setError(toMessage(err, 'Could not run the campaign'));
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="space-y-6 p-6">
      <header className="space-y-1">
        <h1 className="text-2xl font-semibold text-text-primary">Campaigns</h1>
        <p className="max-w-3xl text-sm text-text-secondary">
          Automatic messages to your clients — win-backs, birthdays, promotions and loyalty
          milestones. Every message goes out on WhatsApp first, falling back to text and email
          exactly like your booking reminders, and only ever to clients who have agreed to
          marketing.
        </p>
      </header>

      {error && (
        <div className="rounded-lg bg-danger-soft px-4 py-3 text-sm text-danger" role="alert">
          {error}
        </div>
      )}
      {message && (
        <div className="rounded-lg bg-success-soft px-4 py-3 text-sm text-success" role="status">
          {message}
        </div>
      )}

      <div className="flex flex-wrap gap-2">
        {CAMPAIGN_TYPE_META.map((meta) => (
          <AppButton key={meta.type} variant="secondary" onClick={() => startNew(meta.type)}>
            New {meta.label.toLowerCase()} campaign
          </AppButton>
        ))}
      </div>

      {editorOpen && (
        <CampaignEditor
          form={form}
          setForm={setForm}
          locations={locations}
          saving={saving}
          isEdit={Boolean(editingId)}
          onCancel={() => {
            setEditorOpen(false);
            setEditingId(null);
          }}
          onSubmit={handleSave}
        />
      )}

      {loading ? (
        <p className="text-sm text-text-secondary">Loading campaigns…</p>
      ) : campaigns.length === 0 ? (
        <AppCard>
          <p className="text-sm text-text-secondary">
            No campaigns yet. Pick a type above to create your first one — it starts switched off,
            so nothing is sent until you say so.
          </p>
        </AppCard>
      ) : (
        <div className="space-y-4">
          {campaigns.map((campaign) => (
            <CampaignRow
              key={campaign.id}
              campaign={campaign}
              busy={busyId === campaign.id}
              preview={previewFor === campaign.id ? preview : null}
              onEdit={() => startEdit(campaign)}
              onPreview={() => handlePreview(campaign)}
              onRunNow={() => handleRunNow(campaign)}
              onStatus={(status) => handleStatus(campaign, status)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// One campaign
// ---------------------------------------------------------------------------

function CampaignRow({
  campaign,
  busy,
  preview,
  onEdit,
  onPreview,
  onRunNow,
  onStatus,
}: {
  campaign: CampaignDetail;
  busy: boolean;
  preview: CampaignAudiencePreview | null;
  onEdit: () => void;
  onPreview: () => void;
  onRunNow: () => void;
  onStatus: (status: CampaignStatus) => void;
}) {
  const meta = CAMPAIGN_TYPE_META.find((m) => m.type === campaign.campaignType);

  return (
    <AppCard>
      <div className="space-y-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="space-y-1">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-lg font-semibold text-text-primary">{campaign.name}</h2>
              <StatusBadge label={meta?.label ?? campaign.campaignType} tone="neutral" />
              <StatusBadge label={STATUS_LABEL[campaign.status]} tone={STATUS_TONE[campaign.status]} />
            </div>
            {/* One sentence, no jargon: who, when, how. */}
            <p className="text-sm text-text-secondary">{describeCampaign(campaign)}</p>
          </div>

          <div className="flex flex-wrap gap-2">
            <AppButton variant="secondary" onClick={onPreview} disabled={busy}>
              Preview audience
            </AppButton>
            <AppButton variant="secondary" onClick={onEdit} disabled={busy}>
              Edit
            </AppButton>
            {campaign.status === 'active' ? (
              <>
                <AppButton variant="secondary" onClick={onRunNow} disabled={busy}>
                  Run now
                </AppButton>
                <AppButton variant="secondary" onClick={() => onStatus('paused')} disabled={busy}>
                  Switch off
                </AppButton>
              </>
            ) : campaign.status !== 'archived' ? (
              <AppButton onClick={() => onStatus('active')} disabled={busy}>
                Switch on
              </AppButton>
            ) : null}
          </div>
        </div>

        <dl className="grid grid-cols-2 gap-x-6 gap-y-2 text-sm md:grid-cols-4">
          <Fact label="Where" value={campaign.locationName ?? 'All locations'} />
          <Fact label="When" value={`${formatHour(campaign.sendAtLocalHour)} (${campaign.timezone})`} />
          <Fact label="Delivered by" value={CHANNEL_LABEL[campaign.channel]} />
          <Fact
            label="Last run"
            value={campaign.lastEvaluatedAt ? new Date(campaign.lastEvaluatedAt).toLocaleString() : 'Never'}
          />
        </dl>

        <div className="rounded-lg bg-surface-alt px-4 py-3">
          <p className="text-xs font-medium uppercase tracking-wide text-text-secondary">Message</p>
          <p className="mt-1 whitespace-pre-wrap text-sm text-text-primary">{campaign.messageTemplate}</p>
        </div>

        {campaign.totals.runCount > 0 && (
          <p className="text-xs text-text-secondary">
            {campaign.totals.queuedCount} message{campaign.totals.queuedCount === 1 ? '' : 's'} sent,{' '}
            {campaign.totals.suppressedCount} held back across {campaign.totals.runCount} run
            {campaign.totals.runCount === 1 ? '' : 's'}.
          </p>
        )}

        {preview && <AudiencePreview preview={preview} />}
      </div>
    </AppCard>
  );
}

/**
 * The dry run. Counts are exact; the list is a capped sample with masked contact
 * details, because an owner needs to recognise who is in the audience, not to be
 * handed an export of it.
 */
function AudiencePreview({ preview }: { preview: CampaignAudiencePreview }) {
  const suppressions = Object.entries(preview.suppressionBreakdown);

  return (
    <div className="space-y-3 rounded-lg border border-border bg-surface px-4 py-3">
      <div className="flex flex-wrap items-center gap-3">
        <p className="text-sm font-medium text-text-primary">
          {preview.eligibleCount} client{preview.eligibleCount === 1 ? '' : 's'} would receive this today
        </p>
        {preview.suppressedCount > 0 && (
          <StatusBadge label={`${preview.suppressedCount} held back`} tone="warning" />
        )}
      </div>

      {preview.wouldNotRunToday && preview.wouldNotRunReason && (
        <p className="text-sm text-warning">{preview.wouldNotRunReason}</p>
      )}

      <div className="rounded-lg bg-surface-alt px-3 py-2">
        <p className="text-xs font-medium uppercase tracking-wide text-text-secondary">
          What they will see
        </p>
        <p className="mt-1 whitespace-pre-wrap text-sm text-text-primary">{preview.renderedPreview}</p>
      </div>

      {suppressions.length > 0 && (
        <div>
          <p className="text-xs font-medium uppercase tracking-wide text-text-secondary">
            Why some clients are held back
          </p>
          <ul className="mt-1 space-y-0.5 text-sm text-text-secondary">
            {suppressions.map(([reason, count]) => (
              <li key={reason}>
                {count} — {reason}
              </li>
            ))}
          </ul>
        </div>
      )}

      {preview.sample.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[32rem] text-left text-sm">
            <thead>
              <tr className="text-xs uppercase tracking-wide text-text-secondary">
                <th className="py-1 pr-4 font-medium">Client</th>
                <th className="py-1 pr-4 font-medium">Contact</th>
                <th className="py-1 pr-4 font-medium">Why</th>
                <th className="py-1 font-medium">Status</th>
              </tr>
            </thead>
            <tbody>
              {preview.sample.map((row) => (
                <tr key={row.clientId} className="border-t border-border">
                  <td className="py-1.5 pr-4 text-text-primary">{row.displayName}</td>
                  <td className="py-1.5 pr-4 text-text-secondary">{row.maskedContact ?? '—'}</td>
                  <td className="py-1.5 pr-4 text-text-secondary">{row.reason}</td>
                  <td className="py-1.5">
                    <StatusBadge
                      label={row.eligible ? 'Will receive' : row.suppressionReason ?? 'Held back'}
                      tone={row.eligible ? 'success' : 'warning'}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {preview.sampleTruncated && (
            <p className="mt-2 text-xs text-text-secondary">
              Showing the first {preview.sample.length} of {preview.candidateCount}.
            </p>
          )}
        </div>
      )}
    </div>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-xs uppercase tracking-wide text-text-secondary">{label}</dt>
      <dd className="text-text-primary">{value}</dd>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Editor — the fields change with the campaign type (Wrike section 47)
// ---------------------------------------------------------------------------

function CampaignEditor({
  form,
  setForm,
  locations,
  saving,
  isEdit,
  onCancel,
  onSubmit,
}: {
  form: FormState;
  setForm: (updater: (previous: FormState) => FormState) => void;
  locations: Array<{ id: string; name: string }>;
  saving: boolean;
  isEdit: boolean;
  onCancel: () => void;
  onSubmit: (event: React.FormEvent<HTMLFormElement>) => void;
}) {
  const set = <K extends keyof FormState>(key: K, value: FormState[K]) =>
    setForm((previous) => ({ ...previous, [key]: value }));

  const meta = CAMPAIGN_TYPE_META.find((m) => m.type === form.campaignType);

  return (
    <AppCard>
      <form className="space-y-5" onSubmit={onSubmit}>
        <div>
          <h2 className="text-lg font-semibold text-text-primary">
            {isEdit ? 'Edit campaign' : `New ${meta?.label.toLowerCase()} campaign`}
          </h2>
          <p className="text-sm text-text-secondary">{meta?.description}</p>
        </div>

        <div className="grid gap-4 md:grid-cols-2">
          <Field label="Name">
            <input
              className={INPUT}
              value={form.name}
              onChange={(e) => set('name', e.target.value)}
              maxLength={120}
              required
            />
          </Field>

          <Field label="Applies to">
            <select className={INPUT} value={form.locationId} onChange={(e) => set('locationId', e.target.value)}>
              <option value="">All locations</option>
              {locations.map((location) => (
                <option key={location.id} value={location.id}>
                  {location.name}
                </option>
              ))}
            </select>
          </Field>
        </div>

        {/* Type-specific settings. Nothing irrelevant is ever shown. */}
        {form.campaignType === 'rebooking' && (
          <div className="grid gap-4 md:grid-cols-2">
            <Field label="Reach clients who are">
              <select
                className={INPUT}
                value={form.rebookingTarget}
                onChange={(e) => set('rebookingTarget', e.target.value as FormState['rebookingTarget'])}
              >
                <option value="lapsed">Overdue for their next visit</option>
                <option value="at_risk">Just about due, or overdue</option>
              </select>
            </Field>
            <Field label="Wait this many extra days first" hint="0 sends as soon as they are overdue.">
              <input
                className={INPUT}
                type="number"
                min={0}
                max={365}
                value={form.minOverdueDays}
                onChange={(e) => set('minOverdueDays', e.target.value)}
              />
            </Field>
          </div>
        )}

        {form.campaignType === 'birthday' && (
          <Field label="Send" hint="0 sends on the day itself.">
            <div className="flex items-center gap-2">
              <input
                className={`${INPUT} w-24`}
                type="number"
                min={0}
                max={30}
                value={form.daysBefore}
                onChange={(e) => set('daysBefore', e.target.value)}
              />
              <span className="text-sm text-text-secondary">days before their birthday</span>
            </div>
          </Field>
        )}

        {form.campaignType === 'promotion' && (
          <div className="grid gap-4 md:grid-cols-3">
            <Field label="Runs from">
              <input
                className={INPUT}
                type="date"
                value={form.startDate}
                onChange={(e) => set('startDate', e.target.value)}
                required
              />
            </Field>
            <Field label="Until">
              <input
                className={INPUT}
                type="date"
                value={form.endDate}
                onChange={(e) => set('endDate', e.target.value)}
                required
              />
            </Field>
            <Field label="Minimum past visits" hint="0 includes every client.">
              <input
                className={INPUT}
                type="number"
                min={0}
                max={100}
                value={form.minCompletedVisits}
                onChange={(e) => set('minCompletedVisits', e.target.value)}
              />
            </Field>
          </div>
        )}

        {form.campaignType === 'loyalty_milestone' && (
          <div className="grid gap-4 md:grid-cols-2">
            <Field label="Milestone">
              <select
                className={INPUT}
                value={form.loyaltyMetric}
                onChange={(e) => set('loyaltyMetric', e.target.value as FormState['loyaltyMetric'])}
              >
                <option value="completed_visits">Number of visits</option>
                <option value="total_spend">Total spent</option>
              </select>
            </Field>
            <Field
              label={form.loyaltyMetric === 'completed_visits' ? 'Number of visits' : 'Amount spent (£)'}
              hint="Each client is congratulated once for each milestone."
            >
              <input
                className={INPUT}
                type="number"
                min={1}
                step={form.loyaltyMetric === 'completed_visits' ? 1 : 0.01}
                value={form.loyaltyThreshold}
                onChange={(e) => set('loyaltyThreshold', e.target.value)}
              />
            </Field>
          </div>
        )}

        <div className="grid gap-4 md:grid-cols-2">
          <Field label="Send at" hint="In the salon's own local time.">
            <select
              className={INPUT}
              value={form.sendAtLocalHour}
              onChange={(e) => set('sendAtLocalHour', e.target.value)}
            >
              {Array.from({ length: 13 }, (_, i) => i + 8).map((hour) => (
                <option key={hour} value={hour}>
                  {formatHour(hour)}
                </option>
              ))}
            </select>
          </Field>

          <Field
            label="Send by"
            hint="Automatic uses WhatsApp first, then text, then email — the same as your booking reminders."
          >
            <select
              className={INPUT}
              value={form.channel}
              onChange={(e) => set('channel', e.target.value as CampaignChannel)}
            >
              <option value="auto">Automatic (recommended)</option>
              <option value="whatsapp">WhatsApp</option>
              <option value="sms">Text message</option>
              <option value="email">Email</option>
            </select>
          </Field>
        </div>

        <Field
          label="Message"
          hint={`You can use ${CAMPAIGN_TEMPLATE_VARIABLES.map((v) => `{{${v}}}`).join(', ')}.`}
        >
          <textarea
            className={`${INPUT} min-h-[7rem]`}
            value={form.messageTemplate}
            onChange={(e) => set('messageTemplate', e.target.value)}
            maxLength={1000}
            required
          />
        </Field>

        {form.channel === 'email' && (
          <Field label="Email subject">
            <input
              className={INPUT}
              value={form.messageSubject}
              onChange={(e) => set('messageSubject', e.target.value)}
              maxLength={200}
            />
          </Field>
        )}

        <div className="flex flex-wrap gap-2">
          <AppButton type="submit" disabled={saving}>
            {saving ? 'Saving…' : isEdit ? 'Save changes' : 'Save as draft'}
          </AppButton>
          <AppButton type="button" variant="secondary" onClick={onCancel} disabled={saving}>
            Cancel
          </AppButton>
        </div>
        {!isEdit && (
          <p className="text-xs text-text-secondary">
            New campaigns are saved switched off. Nothing is sent until you preview the audience and
            switch it on.
          </p>
        )}
      </form>
    </AppCard>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="block space-y-1">
      <span className="text-sm font-medium text-text-primary">{label}</span>
      {children}
      {hint && <span className="block text-xs text-text-secondary">{hint}</span>}
    </label>
  );
}

const INPUT =
  'w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-text-primary outline-none focus:border-primary';

// ---------------------------------------------------------------------------
// Form state
// ---------------------------------------------------------------------------

interface FormState {
  campaignType: CampaignType;
  name: string;
  locationId: string;
  channel: CampaignChannel;
  messageTemplate: string;
  messageSubject: string;
  sendAtLocalHour: string;
  rebookingTarget: 'lapsed' | 'at_risk';
  minOverdueDays: string;
  daysBefore: string;
  startDate: string;
  endDate: string;
  minCompletedVisits: string;
  loyaltyMetric: 'completed_visits' | 'total_spend';
  /** Visits, or POUNDS for spend — converted to pence on save. */
  loyaltyThreshold: string;
}

function emptyForm(campaignType: CampaignType): FormState {
  const today = new Date().toISOString().slice(0, 10);
  const config = defaultCampaignConfig(campaignType, today);
  return {
    campaignType,
    name: '',
    locationId: '',
    channel: 'auto',
    messageTemplate: SUGGESTED_TEMPLATE[campaignType],
    messageSubject: '',
    sendAtLocalHour: '10',
    rebookingTarget: 'lapsed',
    minOverdueDays: '0',
    daysBefore: '0',
    startDate: config.type === 'promotion' ? config.startDate : today,
    endDate: config.type === 'promotion' ? config.endDate : today,
    minCompletedVisits: '0',
    loyaltyMetric: 'completed_visits',
    loyaltyThreshold: '10',
  };
}

function formFromCampaign(campaign: CampaignDetail): FormState {
  const base = emptyForm(campaign.campaignType);
  const config = campaign.config;
  return {
    ...base,
    name: campaign.name,
    locationId: campaign.locationId ?? '',
    channel: campaign.channel,
    messageTemplate: campaign.messageTemplate,
    messageSubject: campaign.messageSubject ?? '',
    sendAtLocalHour: String(campaign.sendAtLocalHour),
    ...(config.type === 'rebooking'
      ? {
          rebookingTarget: config.targetStatuses.includes('at_risk')
            ? ('at_risk' as const)
            : ('lapsed' as const),
          minOverdueDays: String(config.minOverdueDays),
        }
      : {}),
    ...(config.type === 'birthday' ? { daysBefore: String(config.daysBefore) } : {}),
    ...(config.type === 'promotion'
      ? {
          startDate: config.startDate,
          endDate: config.endDate,
          minCompletedVisits: String(config.minCompletedVisits),
        }
      : {}),
    ...(config.type === 'loyalty_milestone'
      ? {
          loyaltyMetric: config.metric,
          // Pence back to pounds for display; converted again on save.
          loyaltyThreshold:
            config.metric === 'total_spend' ? (config.threshold / 100).toFixed(2) : String(config.threshold),
        }
      : {}),
  };
}

function configFromForm(form: FormState): Record<string, unknown> {
  switch (form.campaignType) {
    case 'rebooking':
      return {
        targetStatuses: form.rebookingTarget === 'at_risk' ? ['at_risk', 'lapsed'] : ['lapsed'],
        minOverdueDays: Number(form.minOverdueDays) || 0,
        serviceCategoryId: null,
      };
    case 'birthday':
      return { daysBefore: Number(form.daysBefore) || 0 };
    case 'promotion':
      return {
        startDate: form.startDate,
        endDate: form.endDate,
        lapseStatuses: [],
        serviceCategoryId: null,
        minCompletedVisits: Number(form.minCompletedVisits) || 0,
      };
    case 'loyalty_milestone':
      return {
        metric: form.loyaltyMetric,
        // Money is stored and compared in integer pence, never as a decimal.
        threshold:
          form.loyaltyMetric === 'total_spend'
            ? Math.round(Number(form.loyaltyThreshold) * 100)
            : Number(form.loyaltyThreshold),
      };
  }
}

// ---------------------------------------------------------------------------
// Presentation
// ---------------------------------------------------------------------------

const CAMPAIGN_TYPE_META: Array<{ type: CampaignType; label: string; description: string }> = [
  {
    type: 'rebooking',
    label: 'Rebooking',
    description:
      'Reaches clients who are overdue for their next visit and have nothing in the diary. Anyone already booked in is skipped automatically.',
  },
  {
    type: 'birthday',
    label: 'Birthday',
    description: 'A birthday message, on the day or a few days before.',
  },
  {
    type: 'promotion',
    label: 'Promotion',
    description: 'A one-off offer to a chosen group of clients, between two dates. Each client hears about it once.',
  },
  {
    type: 'loyalty_milestone',
    label: 'Loyalty milestone',
    description: 'Congratulates a client the first time they reach a number of visits or an amount spent.',
  },
];

const SUGGESTED_TEMPLATE: Record<CampaignType, string> = {
  rebooking:
    "Hi {{first_name}}, it's been a while! We'd love to see you back at {{salon_name}}. Book here: {{booking_link}}",
  birthday: 'Happy birthday {{first_name}}! Everyone at {{salon_name}} is wishing you a wonderful day.',
  promotion: 'Hi {{first_name}}, we have something special on at {{salon_name}} this month. {{booking_link}}',
  loyalty_milestone:
    'Hi {{first_name}}, thank you for being such a loyal client of {{salon_name}} — it means the world to us.',
};

const STATUS_LABEL: Record<CampaignStatus, string> = {
  draft: 'Draft',
  active: 'On',
  paused: 'Off',
  archived: 'Archived',
};

const STATUS_TONE: Record<CampaignStatus, 'success' | 'warning' | 'neutral'> = {
  draft: 'neutral',
  active: 'success',
  paused: 'warning',
  archived: 'neutral',
};

const CHANNEL_LABEL: Record<CampaignChannel, string> = {
  auto: 'WhatsApp, then text, then email',
  whatsapp: 'WhatsApp',
  sms: 'Text message',
  email: 'Email',
};

/** One plain sentence describing what a campaign does. No jargon, no ids. */
function describeCampaign(campaign: CampaignDetail): string {
  const config = campaign.config;
  switch (config.type) {
    case 'rebooking': {
      const who = config.targetStatuses.includes('at_risk')
        ? 'clients who are due or overdue for their next visit'
        : 'clients who are overdue for their next visit';
      const wait = config.minOverdueDays > 0 ? `, after ${config.minOverdueDays} extra days` : '';
      return `Messages ${who}${wait}. Anyone with a booking already in the diary is skipped.`;
    }
    case 'birthday':
      return config.daysBefore === 0
        ? 'Messages clients on their birthday.'
        : `Messages clients ${config.daysBefore} day${config.daysBefore === 1 ? '' : 's'} before their birthday.`;
    case 'promotion': {
      const floor =
        config.minCompletedVisits > 0
          ? ` who have visited at least ${config.minCompletedVisits} times`
          : '';
      return `Messages clients${floor} once, between ${config.startDate} and ${config.endDate}.`;
    }
    case 'loyalty_milestone':
      return config.metric === 'completed_visits'
        ? `Congratulates a client the first time they reach ${config.threshold} visits.`
        : `Congratulates a client the first time they have spent £${(config.threshold / 100).toFixed(2)}.`;
  }
}

function formatHour(hour: number): string {
  return `${String(hour).padStart(2, '0')}:00`;
}

function toMessage(error: unknown, fallback: string): string {
  if (error instanceof ApiRequestError) return error.message || fallback;
  if (error instanceof Error && error.message) return error.message;
  return fallback;
}
