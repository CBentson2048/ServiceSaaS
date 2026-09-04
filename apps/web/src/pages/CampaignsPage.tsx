import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type {
  CampaignAudiencePreview,
  CampaignChannel,
  CampaignDetail,
  CampaignStatus,
  CampaignType,
  UpsertCampaignRequest,
} from '@sheer/domain';
import {
  CAMPAIGN_BOUNDS,
  CAMPAIGN_PREVIEW_VALUES,
  CAMPAIGN_TEMPLATE_VARIABLES,
  defaultCampaignConfig,
  renderCampaignTemplate,
  validateCampaignTemplate,
} from '@sheer/domain';
import { cn } from '@sheer/utils';
import { AppButton, Drawer, Pill, StatusBadge } from '../design';
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
 * Written for a salon owner, not a marketer. The page follows the house
 * management pattern (§9, as in the inventory catalogue): a summary strip, one
 * filterable table that is the single source of truth, and right-side drawers
 * for reading a record and for editing it — so the list never disappears
 * underneath the person working on it.
 *
 * Every campaign still answers four questions in plain words — who it reaches,
 * when it goes, how it is delivered, and whether it is on — and the editor
 * shows ONLY the settings that apply to the chosen type. The audience preview
 * is deliberately prominent: seeing "23 clients would receive this, 4 are
 * suppressed and here is why" before switching a campaign on is the single most
 * useful safety feature on the screen.
 *
 * Nothing here can send a message. Saving creates a draft; sending requires
 * enabling the campaign, and even then the server decides the audience.
 */

type LoadState = 'loading' | 'ready' | 'failed';
/** `all` deliberately means "everything still in use" — archived has its own tab. */
type StatusFilter = 'all' | CampaignStatus;
type EditorState = { mode: 'create' } | { mode: 'edit'; campaign: CampaignDetail };

export function CampaignsPage() {
  const auth = useAuth();
  const accessToken = auth.session?.accessToken;
  const user = auth.user;

  const [campaigns, setCampaigns] = useState<CampaignDetail[]>([]);
  const [loadState, setLoadState] = useState<LoadState>('loading');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const [search, setSearch] = useState('');
  const [typeFilter, setTypeFilter] = useState<CampaignType | 'all'>('all');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');

  const [editor, setEditor] = useState<EditorState | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const [preview, setPreview] = useState<CampaignAudiencePreview | null>(null);
  const [previewFor, setPreviewFor] = useState<string | null>(null);
  const [previewing, setPreviewing] = useState(false);

  const locations = useMemo(() => user?.locations ?? [], [user]);

  // Archived campaigns are fetched with the rest and filtered in the browser:
  // there are only ever a handful, and it keeps the tab counts honest without a
  // second round trip every time the filter changes.
  const load = useCallback(async () => {
    if (!accessToken) return;
    try {
      const result = await listCampaigns(accessToken, { includeArchived: true });
      setCampaigns(result.campaigns);
      setLoadState('ready');
      setError(null);
    } catch (err) {
      setError(toMessage(err, 'Could not load campaigns'));
      setLoadState('failed');
    }
  }, [accessToken]);

  useEffect(() => {
    void load();
  }, [load]);

  const selected = useMemo(
    () => campaigns.find((campaign) => campaign.id === selectedId) ?? null,
    [campaigns, selectedId],
  );

  const counts = useMemo(() => {
    const tally = { all: 0, draft: 0, active: 0, paused: 0, archived: 0 };
    for (const campaign of campaigns) {
      tally[campaign.status] += 1;
      if (campaign.status !== 'archived') tally.all += 1;
    }
    return tally;
  }, [campaigns]);

  const totals = useMemo(
    () =>
      campaigns.reduce(
        (sum, campaign) => ({
          runs: sum.runs + campaign.totals.runCount,
          queued: sum.queued + campaign.totals.queuedCount,
          suppressed: sum.suppressed + campaign.totals.suppressedCount,
        }),
        { runs: 0, queued: 0, suppressed: 0 },
      ),
    [campaigns],
  );

  const visible = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return campaigns.filter((campaign) => {
      if (statusFilter === 'all' ? campaign.status === 'archived' : campaign.status !== statusFilter) {
        return false;
      }
      if (typeFilter !== 'all' && campaign.campaignType !== typeFilter) return false;
      if (!needle) return true;
      return [
        campaign.name,
        campaign.messageTemplate,
        campaign.locationName ?? 'All locations',
        CAMPAIGN_TYPE_META.find((meta) => meta.type === campaign.campaignType)?.label ?? '',
      ]
        .join(' ')
        .toLowerCase()
        .includes(needle);
    });
  }, [campaigns, search, statusFilter, typeFilter]);

  const filtersActive = search.trim() !== '' || typeFilter !== 'all' || statusFilter !== 'all';

  function openDetail(campaign: CampaignDetail) {
    setSelectedId(campaign.id);
    setPreview(null);
    setPreviewFor(null);
  }

  async function handleStatus(campaign: CampaignDetail, status: CampaignStatus) {
    if (!accessToken) return;
    if (
      status === 'archived' &&
      !window.confirm(`Archive “${campaign.name}”? It stops sending and moves out of your active list.`)
    ) {
      return;
    }
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await setCampaignStatus(accessToken, campaign.id, status);
      setNotice(
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
      setBusy(false);
    }
  }

  async function handlePreview(campaign: CampaignDetail) {
    if (!accessToken) return;
    setPreviewing(true);
    setError(null);
    try {
      const result = await previewCampaignAudience(accessToken, campaign.id);
      setPreview(result);
      setPreviewFor(campaign.id);
    } catch (err) {
      setError(toMessage(err, 'Could not preview the audience'));
    } finally {
      setPreviewing(false);
    }
  }

  async function handleRunNow(campaign: CampaignDetail) {
    if (!accessToken) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const result = await runCampaignNow(accessToken, campaign.id);
      setNotice(result.message);
      await load();
    } catch (err) {
      setError(toMessage(err, 'Could not run the campaign'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mx-auto w-full max-w-7xl px-4 py-6 lg:px-8">
      <header className="mb-5 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h1 className="text-[22px] font-semibold leading-7 text-text-primary">Campaigns</h1>
          <p className="mt-1 max-w-3xl text-[13px] text-text-secondary">
            Automatic messages to your clients — win-backs, birthdays, promotions and loyalty
            milestones. Every message goes out on WhatsApp first, falling back to text and email
            exactly like your booking reminders, and only ever to clients who have agreed to
            marketing.
          </p>
        </div>
        <AppButton onClick={() => setEditor({ mode: 'create' })}>+ New campaign</AppButton>
      </header>

      {notice ? (
        <div className="mb-4 flex items-start justify-between gap-3 rounded-input-lg border border-success-border bg-success-soft px-4 py-3 text-[13px] text-success">
          <span role="status">{notice}</span>
          <button
            type="button"
            onClick={() => setNotice(null)}
            aria-label="Dismiss"
            className="opacity-70 hover:opacity-100"
          >
            ✕
          </button>
        </div>
      ) : null}
      {error ? (
        <div
          role="alert"
          className="mb-4 rounded-input-lg border border-danger-border bg-danger-soft px-4 py-3 text-[13px] text-danger"
        >
          {error}
        </div>
      ) : null}

      {/* ------------------------------------------------------------------ */}
      {/* 1. Overview                                                         */}
      {/* ------------------------------------------------------------------ */}
      <section className="mb-6 grid gap-3 sm:grid-cols-2 xl:grid-cols-4" aria-label="Campaign overview">
        <SummaryTile
          label="Switched on"
          value={formatCount(counts.active)}
          hint={counts.active === 0 ? 'nothing is sending right now' : 'sending automatically'}
          icon={<BoltIcon className="h-4 w-4 text-success" />}
          badge={counts.active > 0 ? { label: 'Live', tone: 'success' } : undefined}
        />
        <SummaryTile
          label="Not sending"
          value={formatCount(counts.draft + counts.paused)}
          hint={`${formatCount(counts.draft)} draft, ${formatCount(counts.paused)} switched off`}
          icon={<PauseIcon className="h-4 w-4 text-text-secondary" />}
        />
        <SummaryTile
          label="Messages sent"
          value={formatCount(totals.queued)}
          hint={totals.runs === 0 ? 'no campaign has run yet' : `across ${formatCount(totals.runs)} run${totals.runs === 1 ? '' : 's'}`}
          icon={<SendIcon className="h-4 w-4 text-primary" />}
        />
        <SummaryTile
          label="Held back"
          value={formatCount(totals.suppressed)}
          hint="opted out, no contact details, or already messaged"
          icon={<ShieldIcon className="h-4 w-4 text-warning" />}
        />
      </section>

      {/* ------------------------------------------------------------------ */}
      {/* 2. The campaign list — the primary surface                          */}
      {/* ------------------------------------------------------------------ */}
      <section aria-label="Campaigns" className="rounded-card-lg border border-border bg-surface shadow-card">
        <div className="flex flex-col gap-3 border-b border-border px-5 py-4 xl:flex-row xl:items-center xl:justify-between">
          <div>
            <h2 className="text-[15px] font-semibold text-text-primary">All campaigns</h2>
            <p className="mt-0.5 text-[13px] text-text-secondary">
              Open a campaign to preview who it reaches before switching it on.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2" role="tablist" aria-label="Filter by status">
            {STATUS_TABS.map((tab) => (
              <Pill
                key={tab.value}
                tone="ink"
                label={`${tab.label} ${counts[tab.value === 'all' ? 'all' : tab.value]}`}
                active={statusFilter === tab.value}
                onClick={() => setStatusFilter(tab.value)}
              />
            ))}
          </div>
        </div>

        <div className="flex flex-col gap-2 border-b border-border px-5 py-3 lg:flex-row lg:items-center">
          <div className="relative flex-1 lg:max-w-xs">
            <SearchIcon className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-text-muted" />
            <input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Search name, message or location…"
              aria-label="Search campaigns"
              className="h-9 w-full rounded-input-lg border border-border-strong bg-surface pl-9 pr-3 text-[13px] outline-none focus:border-primary"
            />
          </div>
          <select
            value={typeFilter}
            onChange={(event) => setTypeFilter(event.target.value as CampaignType | 'all')}
            aria-label="Filter by campaign type"
            className="h-9 rounded-input-lg border border-border-strong bg-surface px-3 text-[13px] text-text-primary outline-none focus:border-primary"
          >
            <option value="all">All types</option>
            {CAMPAIGN_TYPE_META.map((meta) => (
              <option key={meta.type} value={meta.type}>
                {meta.label}
              </option>
            ))}
          </select>
          {filtersActive ? (
            <AppButton
              size="sm"
              variant="ghost"
              onClick={() => {
                setSearch('');
                setTypeFilter('all');
                setStatusFilter('all');
              }}
            >
              Clear filters
            </AppButton>
          ) : null}
        </div>

        {loadState === 'failed' ? (
          <RetryState title="Unable to load campaigns." onRetry={() => void load()} />
        ) : loadState === 'loading' ? (
          <EmptyState title="Loading campaigns…" body="Reading your campaign configuration." />
        ) : campaigns.length === 0 ? (
          <EmptyState
            title="No campaigns yet"
            body="Create your first one — it starts switched off, so nothing is sent until you preview the audience and say so."
            action={<AppButton size="sm" onClick={() => setEditor({ mode: 'create' })}>+ New campaign</AppButton>}
          />
        ) : visible.length === 0 ? (
          <EmptyState
            title="No campaigns match these filters"
            body="Try a different status tab, another type, or clear the search."
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[1040px] text-left text-[13px]">
              <thead className="border-b border-border bg-surface-alt text-[11px] uppercase tracking-[0.08em] text-text-secondary">
                <tr>
                  <th scope="col" className="px-5 py-2.5 font-medium">Campaign</th>
                  <th scope="col" className="px-4 py-2.5 font-medium">Type</th>
                  <th scope="col" className="px-4 py-2.5 font-medium">Where</th>
                  <th scope="col" className="px-4 py-2.5 font-medium">Schedule</th>
                  <th scope="col" className="px-4 py-2.5 text-right font-medium">Sent</th>
                  <th scope="col" className="px-4 py-2.5 font-medium">Last run</th>
                  <th scope="col" className="px-4 py-2.5 font-medium">Status</th>
                  <th scope="col" className="px-4 py-2.5 text-right font-medium">
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {visible.map((campaign) => {
                  const meta = CAMPAIGN_TYPE_META.find((entry) => entry.type === campaign.campaignType);
                  return (
                    <tr key={campaign.id} className="align-top transition hover:bg-surface-alt">
                      <td className="px-5 py-3">
                        <button
                          type="button"
                          onClick={() => openDetail(campaign)}
                          className="text-left font-medium text-text-primary underline-offset-2 hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
                        >
                          {campaign.name}
                        </button>
                        {/* One sentence, no jargon: who, when, how. */}
                        <div className="mt-0.5 max-w-md text-[12px] text-text-muted">
                          {describeCampaign(campaign)}
                        </div>
                      </td>
                      <td className="px-4 py-3">
                        <StatusBadge label={meta?.label ?? campaign.campaignType} tone="neutral" />
                      </td>
                      <td className="px-4 py-3 text-text-secondary">
                        {campaign.locationName ?? 'All locations'}
                      </td>
                      <td className="px-4 py-3">
                        <div className="tabular-nums text-text-primary">
                          {formatHour(campaign.sendAtLocalHour)}
                        </div>
                        <div className="text-[11px] text-text-muted">{CHANNEL_SHORT[campaign.channel]}</div>
                      </td>
                      <td className="px-4 py-3 text-right">
                        <div className="font-semibold tabular-nums text-text-primary">
                          {formatCount(campaign.totals.queuedCount)}
                        </div>
                        {campaign.totals.suppressedCount > 0 ? (
                          <div className="text-[11px] text-text-muted">
                            {formatCount(campaign.totals.suppressedCount)} held back
                          </div>
                        ) : null}
                      </td>
                      <td className="px-4 py-3 text-text-secondary">
                        {campaign.lastEvaluatedAt ? formatDateTime(campaign.lastEvaluatedAt) : 'Never'}
                      </td>
                      <td className="px-4 py-3">
                        <StatusBadge
                          label={STATUS_LABEL[campaign.status]}
                          tone={STATUS_TONE[campaign.status]}
                        />
                      </td>
                      <td className="px-4 py-3 text-right">
                        <AppButton size="sm" variant="secondary" onClick={() => openDetail(campaign)}>
                          Manage
                        </AppButton>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* ------------------------------------------------------------------ */}
      {/* Drawers                                                             */}
      {/* ------------------------------------------------------------------ */}
      <CampaignDetailDrawer
        campaign={selected}
        busy={busy}
        previewing={previewing}
        preview={selected && previewFor === selected.id ? preview : null}
        onClose={() => setSelectedId(null)}
        // One drawer at a time: the editor replaces the detail view rather than
        // stacking on top of it, so Escape cannot dismiss both at once.
        onEdit={(campaign) => {
          setSelectedId(null);
          setEditor({ mode: 'edit', campaign });
        }}
        onPreview={handlePreview}
        onRunNow={handleRunNow}
        onStatus={handleStatus}
      />

      <CampaignEditorDrawer
        state={editor}
        accessToken={accessToken}
        locations={locations}
        onClose={() => setEditor(null)}
        onSaved={(campaign, mode) => {
          setEditor(null);
          setError(null);
          setNotice(
            mode === 'updated'
              ? `${campaign.name} updated.`
              : `${campaign.name} saved as a draft. Preview the audience, then switch it on when you are happy.`,
          );
          // Land on the saved campaign so the next step — previewing the
          // audience — is one click away. Any earlier preview is discarded:
          // the settings behind it have just changed.
          setPreview(null);
          setPreviewFor(null);
          setSelectedId(campaign.id);
          void load();
        }}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Detail drawer — read the campaign, then act on it
// ---------------------------------------------------------------------------

function CampaignDetailDrawer({
  campaign,
  busy,
  previewing,
  preview,
  onClose,
  onEdit,
  onPreview,
  onRunNow,
  onStatus,
}: {
  campaign: CampaignDetail | null;
  busy: boolean;
  previewing: boolean;
  preview: CampaignAudiencePreview | null;
  onClose: () => void;
  onEdit: (campaign: CampaignDetail) => void;
  onPreview: (campaign: CampaignDetail) => void;
  onRunNow: (campaign: CampaignDetail) => void;
  onStatus: (campaign: CampaignDetail, status: CampaignStatus) => void;
}) {
  if (!campaign) return null;

  const meta = CAMPAIGN_TYPE_META.find((entry) => entry.type === campaign.campaignType);
  const archived = campaign.status === 'archived';

  return (
    <Drawer
      open
      onClose={onClose}
      title={campaign.name}
      description={meta?.label}
      widthClassName="sm:max-w-2xl"
      footer={
        <>
          {!archived ? (
            <AppButton
              size="sm"
              variant="ghost"
              onClick={() => onStatus(campaign, 'archived')}
              disabled={busy}
            >
              Archive
            </AppButton>
          ) : null}
          <AppButton size="sm" variant="secondary" onClick={() => onEdit(campaign)} disabled={busy || archived}>
            Edit
          </AppButton>
          {campaign.status === 'active' ? (
            <>
              <AppButton size="sm" variant="secondary" onClick={() => onRunNow(campaign)} loading={busy}>
                Run now
              </AppButton>
              <AppButton size="sm" variant="secondary" onClick={() => onStatus(campaign, 'paused')} disabled={busy}>
                Switch off
              </AppButton>
            </>
          ) : !archived ? (
            <AppButton size="sm" onClick={() => onStatus(campaign, 'active')} loading={busy}>
              Switch on
            </AppButton>
          ) : (
            <AppButton size="sm" variant="secondary" onClick={() => onStatus(campaign, 'paused')} disabled={busy}>
              Restore
            </AppButton>
          )}
        </>
      }
    >
      <div className="space-y-6">
        <section>
          <div className="flex flex-wrap items-center gap-2">
            <StatusBadge label={STATUS_LABEL[campaign.status]} tone={STATUS_TONE[campaign.status]} />
            {campaign.status === 'active' ? (
              <span className="text-[12px] text-text-secondary">
                Runs every day at {formatHour(campaign.sendAtLocalHour)} salon time.
              </span>
            ) : (
              <span className="text-[12px] text-text-secondary">Not evaluated — no messages are created.</span>
            )}
          </div>
          <p className="mt-2 text-[13px] text-text-secondary">{describeCampaign(campaign)}</p>
        </section>

        <Section title="At a glance">
          <dl className="grid grid-cols-2 gap-x-6 gap-y-3">
            <Fact label="Where" value={campaign.locationName ?? 'All locations'} />
            <Fact label="When" value={`${formatHour(campaign.sendAtLocalHour)} · ${campaign.timezone}`} />
            <Fact label="Delivered by" value={CHANNEL_LABEL[campaign.channel]} />
            <Fact
              label="Last run"
              value={campaign.lastEvaluatedAt ? formatDateTime(campaign.lastEvaluatedAt) : 'Never'}
            />
          </dl>
        </Section>

        <Section title="Message" subtitle={campaign.messageSubject ? `Email subject: ${campaign.messageSubject}` : undefined}>
          <p className="whitespace-pre-wrap rounded-input-lg border border-border bg-surface-alt px-4 py-3 text-[13px] text-text-primary">
            {campaign.messageTemplate}
          </p>
        </Section>

        <Section title="Delivery so far">
          {campaign.totals.runCount === 0 ? (
            <p className="text-[13px] text-text-secondary">
              This campaign has not run yet, so nothing has been sent.
            </p>
          ) : (
            <div className="grid grid-cols-3 gap-3">
              <Metric label="Sent" value={formatCount(campaign.totals.queuedCount)} />
              <Metric label="Held back" value={formatCount(campaign.totals.suppressedCount)} />
              <Metric
                label="Failed"
                value={formatCount(campaign.totals.failedCount)}
                tone={campaign.totals.failedCount > 0 ? 'danger' : undefined}
              />
            </div>
          )}
        </Section>

        <Section
          title="Audience"
          subtitle="A dry run against today's clients. Counts are exact; the list is a sample with masked contact details."
        >
          {preview ? (
            <AudiencePreview preview={preview} />
          ) : (
            <p className="text-[13px] text-text-secondary">
              Check who would receive this before switching it on.
            </p>
          )}
          <div className="mt-3">
            <AppButton size="sm" variant="secondary" onClick={() => onPreview(campaign)} loading={previewing}>
              {preview ? 'Refresh preview' : 'Preview audience'}
            </AppButton>
          </div>
        </Section>
      </div>
    </Drawer>
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
    <div className="space-y-3 rounded-input-lg border border-border bg-surface-alt px-4 py-3">
      <div className="flex flex-wrap items-center gap-2">
        <p className="text-[13px] font-medium text-text-primary">
          {preview.eligibleCount} client{preview.eligibleCount === 1 ? '' : 's'} would receive this today
        </p>
        {preview.suppressedCount > 0 ? (
          <StatusBadge label={`${preview.suppressedCount} held back`} tone="warning" />
        ) : null}
      </div>

      {preview.wouldNotRunToday && preview.wouldNotRunReason ? (
        <p className="rounded-input border border-warning-border bg-warning-soft px-3 py-2 text-[12px] text-warning">
          {preview.wouldNotRunReason}
        </p>
      ) : null}

      <div className="rounded-input border border-border bg-surface px-3 py-2">
        <p className="text-[11px] font-medium uppercase tracking-[0.08em] text-text-secondary">
          What they will see
        </p>
        <p className="mt-1 whitespace-pre-wrap text-[13px] text-text-primary">{preview.renderedPreview}</p>
      </div>

      {suppressions.length > 0 ? (
        <div>
          <p className="text-[11px] font-medium uppercase tracking-[0.08em] text-text-secondary">
            Why some clients are held back
          </p>
          <ul className="mt-1 space-y-0.5 text-[12px] text-text-secondary">
            {suppressions.map(([reason, count]) => (
              <li key={reason}>
                <span className="font-medium tabular-nums text-text-primary">{count}</span> — {reason}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {preview.sample.length > 0 ? (
        <div className="overflow-x-auto rounded-input border border-border bg-surface">
          <table className="w-full min-w-[30rem] text-left text-[12px]">
            <thead className="border-b border-border bg-surface-alt text-[10px] uppercase tracking-[0.08em] text-text-secondary">
              <tr>
                <th scope="col" className="px-3 py-2 font-medium">Client</th>
                <th scope="col" className="px-3 py-2 font-medium">Contact</th>
                <th scope="col" className="px-3 py-2 font-medium">Why</th>
                <th scope="col" className="px-3 py-2 font-medium">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {preview.sample.map((row) => (
                <tr key={row.clientId}>
                  <td className="px-3 py-2 text-text-primary">{row.displayName}</td>
                  <td className="px-3 py-2 text-text-secondary">{row.maskedContact ?? '—'}</td>
                  <td className="px-3 py-2 text-text-secondary">{row.reason}</td>
                  <td className="px-3 py-2">
                    <StatusBadge
                      label={row.eligible ? 'Will receive' : row.suppressionReason ?? 'Held back'}
                      tone={row.eligible ? 'success' : 'warning'}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}

      {preview.sampleTruncated ? (
        <p className="text-[11px] text-text-muted">
          Showing the first {preview.sample.length} of {preview.candidateCount}.
        </p>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Editor drawer — the fields change with the campaign type (Wrike section 47)
// ---------------------------------------------------------------------------

function CampaignEditorDrawer({
  state,
  accessToken,
  locations,
  onClose,
  onSaved,
}: {
  state: EditorState | null;
  accessToken: string | undefined;
  locations: Array<{ id: string; name: string }>;
  onClose: () => void;
  onSaved: (campaign: CampaignDetail, mode: 'created' | 'updated') => void;
}) {
  const isEdit = state?.mode === 'edit';
  const editingCampaign = state?.mode === 'edit' ? state.campaign : undefined;

  const [form, setForm] = useState<FormState>(() => emptyForm('rebooking'));
  const [pristine, setPristine] = useState<FormState>(() => emptyForm('rebooking'));
  const [saving, setSaving] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const templateRef = useRef<HTMLTextAreaElement>(null);

  // Reset whenever the drawer opens for a different record.
  const recordKey = editingCampaign ? `${editingCampaign.id}:${editingCampaign.updatedAt}` : 'new';
  const open = state !== null;
  useEffect(() => {
    if (!open) return;
    const initial = editingCampaign ? formFromCampaign(editingCampaign) : emptyForm('rebooking');
    setForm(initial);
    setPristine(initial);
    setSubmitError(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, recordKey]);

  if (!state) return null;

  const set = <K extends keyof FormState>(key: K, value: FormState[K]) =>
    setForm((current) => ({ ...current, [key]: value }));

  const meta = CAMPAIGN_TYPE_META.find((entry) => entry.type === form.campaignType);
  const templateCheck = validateCampaignTemplate(form.messageTemplate);
  const templateTouched = form.messageTemplate.trim().length > 0;
  const isDirty = JSON.stringify(form) !== JSON.stringify(pristine);

  function requestClose() {
    if (saving) return;
    if (isDirty && !window.confirm('Discard your unsaved changes to this campaign?')) return;
    onClose();
  }

  /** Type is immutable once saved, so switching it only ever happens on a new campaign. */
  function chooseType(type: CampaignType) {
    setForm((current) => ({ ...emptyForm(type), name: current.name }));
  }

  function insertVariable(variable: string) {
    const token = `{{${variable}}}`;
    const element = templateRef.current;
    if (!element) {
      set('messageTemplate', `${form.messageTemplate}${token}`);
      return;
    }
    const start = element.selectionStart ?? element.value.length;
    const end = element.selectionEnd ?? start;
    set('messageTemplate', `${element.value.slice(0, start)}${token}${element.value.slice(end)}`);
    // The value lands on the next render; move the caret past the inserted token then.
    window.requestAnimationFrame(() => {
      element.focus();
      element.setSelectionRange(start + token.length, start + token.length);
    });
  }

  async function handleSave() {
    if (!accessToken) return;

    if (!form.name.trim()) {
      setSubmitError('Give the campaign a name so you can recognise it later.');
      return;
    }
    // Validated here as well as on the server, so a typo in a placeholder is a
    // sentence in the form rather than a round trip.
    if (!templateCheck.valid) {
      setSubmitError(templateCheck.errors.join(' '));
      return;
    }
    if (form.campaignType === 'promotion' && form.endDate < form.startDate) {
      setSubmitError('The promotion must end on or after the day it starts.');
      return;
    }

    setSaving(true);
    setSubmitError(null);
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

      if (editingCampaign) {
        const { campaignType: _ignored, ...patch } = payload;
        const updated = await updateCampaign(accessToken, editingCampaign.id, patch);
        onSaved(updated, 'updated');
      } else {
        const created = await createCampaign(accessToken, payload);
        onSaved(created, 'created');
      }
    } catch (err) {
      setSubmitError(toMessage(err, 'Could not save the campaign'));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Drawer
      open
      onClose={requestClose}
      title={isEdit ? 'Edit campaign' : 'New campaign'}
      description={
        isEdit
          ? 'Changes apply to the next run. The campaign type cannot be changed.'
          : 'Saved switched off — nothing is sent until you preview the audience and switch it on.'
      }
      widthClassName="sm:max-w-2xl"
      footer={
        <>
          <AppButton size="sm" variant="ghost" onClick={requestClose} disabled={saving}>
            Cancel
          </AppButton>
          <AppButton size="sm" onClick={() => void handleSave()} loading={saving}>
            {isEdit ? 'Save changes' : 'Save as draft'}
          </AppButton>
        </>
      }
    >
      {submitError ? (
        <div
          role="alert"
          className="mb-4 rounded-input-lg border border-danger-border bg-danger-soft px-3 py-2.5 text-[13px] text-danger"
        >
          {submitError}
        </div>
      ) : null}

      <div className="space-y-6">
        <Section
          title="Campaign type"
          subtitle={isEdit ? undefined : 'Each type has its own audience rule. Pick the one that matches the message.'}
        >
          {isEdit ? (
            <div className="rounded-input-lg border border-border bg-surface-alt px-4 py-3">
              <div className="text-[13px] font-medium text-text-primary">{meta?.label}</div>
              <p className="mt-0.5 text-[12px] text-text-secondary">{meta?.description}</p>
            </div>
          ) : (
            <div className="grid gap-2 sm:grid-cols-2">
              {CAMPAIGN_TYPE_META.map((entry) => (
                <button
                  key={entry.type}
                  type="button"
                  aria-pressed={form.campaignType === entry.type}
                  onClick={() => chooseType(entry.type)}
                  className={cn(
                    'rounded-input-lg border px-4 py-3 text-left transition focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/40',
                    form.campaignType === entry.type
                      ? 'border-primary bg-primary-soft'
                      : 'border-border hover:border-border-strong hover:bg-surface-alt',
                  )}
                >
                  <span className="block text-[13px] font-semibold text-text-primary">{entry.label}</span>
                  <span className="mt-0.5 block text-[12px] text-text-secondary">{entry.short}</span>
                </button>
              ))}
            </div>
          )}
        </Section>

        <Section title="Basics">
          <Grid>
            <Field label="Name" required>
              <input
                className={INPUT}
                value={form.name}
                onChange={(event) => set('name', event.target.value)}
                maxLength={CAMPAIGN_BOUNDS.nameLength.max}
                placeholder={`e.g. ${meta?.label} nudge`}
              />
            </Field>
            <Field label="Applies to">
              <select
                className={INPUT}
                value={form.locationId}
                onChange={(event) => set('locationId', event.target.value)}
              >
                <option value="">All locations</option>
                {locations.map((location) => (
                  <option key={location.id} value={location.id}>
                    {location.name}
                  </option>
                ))}
              </select>
            </Field>
          </Grid>
        </Section>

        {/* Type-specific settings. Nothing irrelevant is ever shown. */}
        <Section title="Who it reaches" subtitle={meta?.description}>
          {form.campaignType === 'rebooking' ? (
            <Grid>
              <Field label="Reach clients who are">
                <select
                  className={INPUT}
                  value={form.rebookingTarget}
                  onChange={(event) =>
                    set('rebookingTarget', event.target.value as FormState['rebookingTarget'])
                  }
                >
                  <option value="lapsed">Overdue for their next visit</option>
                  <option value="at_risk">Just about due, or overdue</option>
                </select>
              </Field>
              <Field label="Wait this many extra days first" hint="0 sends as soon as they are overdue.">
                <input
                  className={INPUT}
                  type="number"
                  min={CAMPAIGN_BOUNDS.rebookingMinOverdueDays.min}
                  max={CAMPAIGN_BOUNDS.rebookingMinOverdueDays.max}
                  value={form.minOverdueDays}
                  onChange={(event) => set('minOverdueDays', event.target.value)}
                />
              </Field>
            </Grid>
          ) : null}

          {form.campaignType === 'birthday' ? (
            <Field label="Send in advance" hint="0 sends on the day itself.">
              <div className="flex items-center gap-2">
                <input
                  className={`${INPUT} w-24`}
                  type="number"
                  min={CAMPAIGN_BOUNDS.birthdayDaysBefore.min}
                  max={CAMPAIGN_BOUNDS.birthdayDaysBefore.max}
                  value={form.daysBefore}
                  onChange={(event) => set('daysBefore', event.target.value)}
                />
                <span className="text-[13px] text-text-secondary">days before their birthday</span>
              </div>
            </Field>
          ) : null}

          {form.campaignType === 'promotion' ? (
            <div className="grid gap-3 sm:grid-cols-3">
              <Field label="Runs from" required>
                <input
                  className={INPUT}
                  type="date"
                  value={form.startDate}
                  onChange={(event) => set('startDate', event.target.value)}
                />
              </Field>
              <Field label="Until" required>
                <input
                  className={INPUT}
                  type="date"
                  value={form.endDate}
                  onChange={(event) => set('endDate', event.target.value)}
                />
              </Field>
              <Field label="Minimum past visits" hint="0 includes every client.">
                <input
                  className={INPUT}
                  type="number"
                  min={CAMPAIGN_BOUNDS.promotionMinCompletedVisits.min}
                  max={CAMPAIGN_BOUNDS.promotionMinCompletedVisits.max}
                  value={form.minCompletedVisits}
                  onChange={(event) => set('minCompletedVisits', event.target.value)}
                />
              </Field>
            </div>
          ) : null}

          {form.campaignType === 'loyalty_milestone' ? (
            <Grid>
              <Field label="Milestone">
                <select
                  className={INPUT}
                  value={form.loyaltyMetric}
                  onChange={(event) => set('loyaltyMetric', event.target.value as FormState['loyaltyMetric'])}
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
                  onChange={(event) => set('loyaltyThreshold', event.target.value)}
                />
              </Field>
            </Grid>
          ) : null}
        </Section>

        <Section title="Delivery">
          <Grid>
            <Field label="Send at" hint="In the salon's own local time.">
              <select
                className={INPUT}
                value={form.sendAtLocalHour}
                onChange={(event) => set('sendAtLocalHour', event.target.value)}
              >
                {SEND_HOURS.map((hour) => (
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
                onChange={(event) => set('channel', event.target.value as CampaignChannel)}
              >
                <option value="auto">Automatic (recommended)</option>
                <option value="whatsapp">WhatsApp</option>
                <option value="sms">Text message</option>
                <option value="email">Email</option>
              </select>
            </Field>
          </Grid>
        </Section>

        <Section title="Message">
          <Field
            label="What the client receives"
            required
            error={templateTouched && !templateCheck.valid ? templateCheck.errors.join(' ') : undefined}
          >
            <textarea
              ref={templateRef}
              className={`${INPUT} min-h-[7rem] py-2`}
              value={form.messageTemplate}
              onChange={(event) => set('messageTemplate', event.target.value)}
              maxLength={CAMPAIGN_BOUNDS.templateLength.max}
            />
          </Field>

          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            <span className="text-[11px] text-text-muted">Insert:</span>
            {CAMPAIGN_TEMPLATE_VARIABLES.map((variable) => (
              <button
                key={variable}
                type="button"
                onClick={() => insertVariable(variable)}
                className="rounded-pill border border-border px-2.5 py-0.5 text-[11px] font-medium text-text-secondary transition hover:border-border-strong hover:text-text-primary focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/30"
              >
                {`{{${variable}}}`}
              </button>
            ))}
            <span className="ml-auto text-[11px] tabular-nums text-text-muted">
              {form.messageTemplate.length}/{CAMPAIGN_BOUNDS.templateLength.max}
            </span>
          </div>

          {form.channel === 'email' ? (
            <div className="mt-3">
              <Field label="Email subject">
                <input
                  className={INPUT}
                  value={form.messageSubject}
                  onChange={(event) => set('messageSubject', event.target.value)}
                  maxLength={CAMPAIGN_BOUNDS.subjectLength.max}
                />
              </Field>
            </div>
          ) : null}

          {/* Rendered with representative values — never a real client's data. */}
          {form.messageTemplate.trim() ? (
            <div className="mt-3 rounded-input-lg border border-border bg-surface-alt px-4 py-3">
              <p className="text-[11px] font-medium uppercase tracking-[0.08em] text-text-secondary">
                Preview
              </p>
              <p className="mt-1 whitespace-pre-wrap text-[13px] text-text-primary">
                {renderCampaignTemplate(form.messageTemplate, CAMPAIGN_PREVIEW_VALUES)}
              </p>
            </div>
          ) : null}
        </Section>
      </div>
    </Drawer>
  );
}

// ---------------------------------------------------------------------------
// Small presentational pieces
// ---------------------------------------------------------------------------

function SummaryTile({
  label,
  value,
  hint,
  icon,
  badge,
}: {
  label: string;
  value: string;
  hint?: string;
  icon: ReactNode;
  badge?: { label: string; tone: 'success' | 'warning' | 'danger' };
}) {
  return (
    <div className="rounded-card-lg border border-border bg-surface p-4 shadow-card">
      <div className="flex items-start justify-between">
        <span className="text-[12px] font-medium text-text-secondary">{label}</span>
        <span className="flex h-8 w-8 items-center justify-center rounded-input bg-surface-alt">{icon}</span>
      </div>
      <div className="mt-2 text-[26px] font-semibold leading-none tabular-nums text-text-primary">{value}</div>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        {badge ? <StatusBadge label={badge.label} tone={badge.tone} /> : null}
        {hint ? <span className="text-[11px] text-text-muted">{hint}</span> : null}
      </div>
    </div>
  );
}

function Metric({ label, value, tone }: { label: string; value: string; tone?: 'danger' }) {
  return (
    <div className="rounded-input-lg border border-border bg-surface-alt px-3 py-2">
      <div className="text-[11px] uppercase tracking-[0.08em] text-text-secondary">{label}</div>
      <div
        className={cn(
          'mt-0.5 text-[18px] font-semibold tabular-nums',
          tone === 'danger' ? 'text-danger' : 'text-text-primary',
        )}
      >
        {value}
      </div>
    </div>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-[11px] uppercase tracking-[0.08em] text-text-secondary">{label}</dt>
      <dd className="mt-0.5 text-[13px] text-text-primary">{value}</dd>
    </div>
  );
}

function Section({ title, subtitle, children }: { title: string; subtitle?: string; children: ReactNode }) {
  return (
    <section>
      <h3 className="text-[13px] font-semibold uppercase tracking-[0.06em] text-text-secondary">{title}</h3>
      {subtitle ? <p className="mt-0.5 text-[12px] text-text-muted">{subtitle}</p> : null}
      <div className="mt-3">{children}</div>
    </section>
  );
}

function Grid({ children }: { children: ReactNode }) {
  return <div className="grid gap-3 sm:grid-cols-2">{children}</div>;
}

/**
 * A labelled field. The hint and error sit OUTSIDE the <label> so they never
 * become part of the control's accessible name.
 */
function Field({
  label,
  children,
  hint,
  error,
  required,
}: {
  label: string;
  children: ReactNode;
  hint?: string;
  error?: string;
  required?: boolean;
}) {
  return (
    <div className="block">
      <label className="mb-1 block text-[12px] font-medium text-text-secondary">
        <span>
          {label}
          {required ? <span className="text-danger"> *</span> : null}
        </span>
        {children}
      </label>
      {error ? (
        <span role="alert" className="mt-1 block text-[11px] text-danger">
          {error}
        </span>
      ) : hint ? (
        <span className="mt-1 block text-[11px] text-text-muted">{hint}</span>
      ) : null}
    </div>
  );
}

function EmptyState({ title, body, action }: { title: string; body: string; action?: ReactNode }) {
  return (
    <div className="px-5 py-12 text-center">
      <div className="text-[14px] font-medium text-text-primary">{title}</div>
      <p className="mx-auto mt-1 max-w-sm text-[13px] text-text-secondary">{body}</p>
      {action ? <div className="mt-3 flex justify-center">{action}</div> : null}
    </div>
  );
}

function RetryState({ title, onRetry }: { title: string; onRetry: () => void }) {
  return (
    <div className="px-5 py-10 text-center" role="alert">
      <div className="text-[14px] font-medium text-text-primary">{title}</div>
      <p className="mx-auto mt-1 max-w-sm text-[13px] text-text-secondary">
        The data could not be fetched. Check your connection and try again.
      </p>
      <div className="mt-3 flex justify-center">
        <AppButton size="sm" variant="secondary" onClick={onRetry}>
          Retry
        </AppButton>
      </div>
    </div>
  );
}

const INPUT =
  'h-10 w-full rounded-input-lg border border-border-strong bg-surface px-3 text-[13px] text-text-primary outline-none focus:border-primary focus:ring-2 focus:ring-primary/20';

function SearchIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden>
      <circle cx="11" cy="11" r="7" />
      <path d="m20 20-3.2-3.2" strokeLinecap="round" />
    </svg>
  );
}

function BoltIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden>
      <path d="M13 2 4 14h7l-1 8 9-12h-7l1-8Z" strokeLinejoin="round" />
    </svg>
  );
}

function PauseIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden>
      <path d="M9 5v14M15 5v14" strokeLinecap="round" />
    </svg>
  );
}

function SendIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden>
      <path d="M21 3 10.5 13.5M21 3l-7 18-3.5-7.5L3 10l18-7Z" strokeLinejoin="round" />
    </svg>
  );
}

function ShieldIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden>
      <path d="M12 3l7 3v5.5c0 4.2-2.9 7.9-7 9.5-4.1-1.6-7-5.3-7-9.5V6l7-3Z" strokeLinejoin="round" />
    </svg>
  );
}

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

const CAMPAIGN_TYPE_META: Array<{
  type: CampaignType;
  label: string;
  /** One line for the type picker. */
  short: string;
  description: string;
}> = [
  {
    type: 'rebooking',
    label: 'Rebooking',
    short: 'Win back clients who are overdue a visit.',
    description:
      'Reaches clients who are overdue for their next visit and have nothing in the diary. Anyone already booked in is skipped automatically.',
  },
  {
    type: 'birthday',
    label: 'Birthday',
    short: 'A message on, or just before, their birthday.',
    description: 'A birthday message, on the day or a few days before.',
  },
  {
    type: 'promotion',
    label: 'Promotion',
    short: 'A one-off offer between two dates.',
    description:
      'A one-off offer to a chosen group of clients, between two dates. Each client hears about it once.',
  },
  {
    type: 'loyalty_milestone',
    label: 'Loyalty milestone',
    short: 'Thank a client at a number of visits or spend.',
    description: 'Congratulates a client the first time they reach a number of visits or an amount spent.',
  },
];

const STATUS_TABS: Array<{ value: StatusFilter; label: string }> = [
  { value: 'all', label: 'All' },
  { value: 'active', label: 'On' },
  { value: 'draft', label: 'Drafts' },
  { value: 'paused', label: 'Off' },
  { value: 'archived', label: 'Archived' },
];

const SEND_HOURS = Array.from(
  { length: CAMPAIGN_BOUNDS.sendAtLocalHour.max - CAMPAIGN_BOUNDS.sendAtLocalHour.min + 1 },
  (_, index) => CAMPAIGN_BOUNDS.sendAtLocalHour.min + index,
);

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

/** The same idea, short enough for a table cell. */
const CHANNEL_SHORT: Record<CampaignChannel, string> = {
  auto: 'WhatsApp → text → email',
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

function formatCount(value: number): string {
  return value.toLocaleString('en-GB');
}

function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString('en-GB', {
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function toMessage(error: unknown, fallback: string): string {
  if (error instanceof ApiRequestError) return error.message || fallback;
  if (error instanceof Error && error.message) return error.message;
  return fallback;
}
