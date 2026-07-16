import { useEffect, useMemo, useState } from 'react';
import { Link, Navigate, useParams } from 'react-router-dom';
import type {
  CrmAllergyRecord,
  CrmClientDetailResponse,
  CrmClientFormula,
  CrmClientNote,
  CrmMessageLog,
  CrmPatchTestRecord,
  CrmVisitPhoto,
  CrmVisitSummary,
} from '@sheer/domain';
import { userHasAnyRole } from '@sheer/domain';
import {
  ApiRequestError,
  createCrmClientAllergy,
  createCrmClientNote,
  createCrmClientPatchTest,
  getCrmClientDetail,
} from '../auth/api';
import { useAuth } from '../auth/AuthProvider';

export function CrmClientDetailPage() {
  const auth = useAuth();
  const params = useParams<{ id: string }>();
  const accessToken = auth.session?.accessToken;
  const [detail, setDetail] = useState<CrmClientDetailResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [actionMessage, setActionMessage] = useState<string | null>(null);
  const [noteContent, setNoteContent] = useState('');
  const [allergyName, setAllergyName] = useState('');
  const [patchStatus, setPatchStatus] = useState<'pending' | 'passed' | 'failed' | 'expired'>('passed');
  const [patchPerformedAt, setPatchPerformedAt] = useState(() => new Date().toISOString().slice(0, 16));

  useEffect(() => {
    let cancelled = false;
    async function load() {
      if (!accessToken || !params.id) return;
      setLoading(true);
      setError(null);
      try {
        const result = await getCrmClientDetail(accessToken, params.id);
        if (!cancelled) setDetail(result);
      } catch (err: unknown) {
        if (cancelled) return;
        if (err instanceof ApiRequestError) setError(err.message);
        else if (err instanceof Error) setError(err.message);
        else setError('Could not load client');
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, [accessToken, params.id]);

  const activeAllergies = useMemo(
    () => detail?.allergies.filter((allergy) => allergy.isActive) ?? [],
    [detail],
  );
  const expiredPatchTests = useMemo(
    () => detail?.patchTests.filter((patchTest) => patchTest.isExpired) ?? [],
    [detail],
  );

  // Staff-only: block users with NO staff role. An owner/manager/stylist who is
  // also a client keeps access (mirrors backend CrmService.assertStaffRole).
  if (
    auth.status === 'authenticated' &&
    !userHasAnyRole(auth.user, ['owner', 'manager', 'stylist'])
  ) {
    return <Navigate to="/unauthorized" replace />;
  }

  async function handleAddNote(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!accessToken || !params.id || !noteContent.trim()) return;
    setError(null);
    setActionMessage(null);
    try {
      const result = await createCrmClientNote(accessToken, params.id, {
        noteType: 'general',
        content: noteContent,
      });
      setDetail((current) => (current ? { ...current, notes: result.notes } : current));
      setNoteContent('');
      setActionMessage('Note saved.');
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Could not save note');
    }
  }

  async function handleAddAllergy(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!accessToken || !params.id || !allergyName.trim()) return;
    setError(null);
    setActionMessage(null);
    try {
      const result = await createCrmClientAllergy(accessToken, params.id, {
        allergenName: allergyName,
        severity: 'unknown',
        isActive: true,
      });
      setDetail((current) => (current ? { ...current, allergies: result.allergies } : current));
      setAllergyName('');
      setActionMessage('Allergy record saved.');
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Could not save allergy');
    }
  }

  async function handleAddPatchTest(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!accessToken || !params.id) return;
    setError(null);
    setActionMessage(null);
    try {
      const result = await createCrmClientPatchTest(accessToken, params.id, {
        status: patchStatus,
        performedAt: new Date(patchPerformedAt).toISOString(),
      });
      setDetail((current) => (current ? { ...current, patchTests: result.patchTests } : current));
      setActionMessage('Patch test saved.');
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Could not save patch test');
    }
  }

  return (
    <div className="mx-auto w-full max-w-6xl px-4 py-6 lg:px-8">
      <nav className="mb-4 text-[12px] text-text-secondary">
        <Link to="/crm" className="hover:text-text-primary">
          Client Hub
        </Link>
        <span className="mx-1.5">/</span>
        <span className="text-text-primary">{detail?.profile.displayName ?? 'Client'}</span>
      </nav>

      {loading ? (
        <Panel>
          <Empty title="Loading client…" body="Fetching client detail." />
        </Panel>
      ) : error && !detail ? (
        <div className="rounded-input-lg border border-danger-border bg-danger-soft px-4 py-3 text-[13px] text-danger">
          {error}
        </div>
      ) : detail ? (
        <>
          <header className="mb-5 rounded-card-lg border border-border bg-surface p-5 shadow-card">
            <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
              <div className="flex items-start gap-4">
                <Avatar name={detail.profile.displayName} />
                <div>
                  <h1 className="text-[24px] font-semibold leading-7 text-text-primary">
                    {detail.profile.displayName}
                  </h1>
                  <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[13px] text-text-secondary">
                    <span className="rounded-pill bg-surface-alt px-2 py-0.5 font-mono text-[12px] text-text-primary ring-1 ring-inset ring-border">
                      {detail.profile.clientCode}
                    </span>
                    <span>{detail.profile.email ?? 'No email'}</span>
                    <Dot />
                    <span>{detail.profile.phone ?? 'No phone'}</span>
                    <Dot />
                    <span className="capitalize">
                      {detail.profile.communicationPreference ?? 'No preference'}
                    </span>
                  </div>
                </div>
              </div>
              <div className="flex flex-wrap gap-2">
                {activeAllergies.length > 0 ? (
                  <AlertPill tone="danger" label={`${activeAllergies.length} active allergy alert`} />
                ) : (
                  <AlertPill tone="quiet" label="No active allergy alerts" />
                )}
                {expiredPatchTests.length > 0 ? (
                  <AlertPill tone="danger" label={`${expiredPatchTests.length} expired patch test`} />
                ) : (
                  <AlertPill tone="quiet" label="Patch tests current or absent" />
                )}
              </div>
            </div>
            {detail.profile.notesSummary ? (
              <p className="mt-4 rounded-input-lg bg-surface-alt px-3 py-2 text-[13px] text-text-secondary">
                {detail.profile.notesSummary}
              </p>
            ) : null}
            <div className="mt-4 grid grid-cols-2 gap-3 text-[13px] md:grid-cols-5">
              <Metric label="Visits" value={detail.visits.length.toString()} />
              <Metric label="Formulas" value={detail.formulas.length.toString()} />
              <Metric label="Notes" value={detail.notes.length.toString()} />
              <Metric label="Messages" value={detail.messages.length.toString()} />
              <Metric label="GDPR pending" value={detail.profile.gdpr.pendingRequests.toString()} />
            </div>
          </header>

          {actionMessage ? (
            <div className="mb-4 rounded-input-lg border border-success-border bg-success-soft px-4 py-3 text-[13px] text-success">
              {actionMessage}
            </div>
          ) : null}
          {error ? (
            <div className="mb-4 rounded-input-lg border border-danger-border bg-danger-soft px-4 py-3 text-[13px] text-danger">
              {error}
            </div>
          ) : null}

          <div className="grid gap-5 lg:grid-cols-[1.15fr_0.85fr]">
            <div className="space-y-5">
              <VisitHistory visits={detail.visits} />
              <ColourFormulas formulas={detail.formulas} />
              <Notes notes={detail.notes} value={noteContent} onChange={setNoteContent} onSubmit={handleAddNote} />
              <Messages messages={detail.messages} />
            </div>
            <div className="space-y-5">
              <Allergies
                allergies={detail.allergies}
                value={allergyName}
                onChange={setAllergyName}
                onSubmit={handleAddAllergy}
                canWrite={userHasAnyRole(auth.user, ['owner', 'manager'])}
              />
              <PatchTests
                patchTests={detail.patchTests}
                status={patchStatus}
                performedAt={patchPerformedAt}
                onStatusChange={setPatchStatus}
                onPerformedAtChange={setPatchPerformedAt}
                onSubmit={handleAddPatchTest}
                canWrite={userHasAnyRole(auth.user, ['owner', 'manager'])}
              />
              <Photos photos={detail.photos} />
              <GdprFoundation pendingRequests={detail.profile.gdpr.pendingRequests} />
            </div>
          </div>
        </>
      ) : null}
    </div>
  );
}

function VisitHistory({ visits }: { visits: CrmVisitSummary[] }) {
  return (
    <Panel title="Visit History" count={visits.length}>
      {visits.length === 0 ? (
        <Empty title="No visits yet" body="Completed visit history will appear here." />
      ) : (
        <ScrollList>
          <ol className="flex flex-col gap-1">
            {visits.map((visit) => (
              <li
                key={visit.id}
                className="rounded-input-lg px-3 py-2.5 transition-colors hover:bg-surface-alt"
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="truncate font-medium text-text-primary">
                      {visit.clientVisibleSummary ?? visit.serviceSummary ?? 'Service visit'}
                    </div>
                    <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[12px] text-text-secondary">
                      <span>{formatDateTime(visit.occurredAt)}</span>
                      {visit.stylistName ? (
                        <>
                          <Dot />
                          <span>{visit.stylistName}</span>
                        </>
                      ) : null}
                      {typeof visit.priceAmount === 'number' ? (
                        <>
                          <Dot />
                          <span>{formatMoney(visit.priceAmount, visit.currencyCode)}</span>
                        </>
                      ) : null}
                    </div>
                  </div>
                  <StatusPill status={visit.status} />
                </div>
              </li>
            ))}
          </ol>
        </ScrollList>
      )}
      {visits.length > 0 ? (
        <p className="mt-3 border-t border-border-divider pt-3 text-[11px] text-text-muted">
          Client-visible summaries only — formula ingredients, product costs and lab internals are shown
          separately.
        </p>
      ) : null}
    </Panel>
  );
}

function ColourFormulas({ formulas }: { formulas: CrmClientFormula[] }) {
  return (
    <Panel title="Colour Formulas" count={formulas.length}>
      {formulas.length === 0 ? (
        <Empty
          title="No colour formulas yet"
          body="Saved colour formulas from Sheer Lab will appear here, newest first."
        />
      ) : (
        <ScrollList maxHeightClass="max-h-[26rem]">
          <ol className="flex flex-col gap-2">
            {formulas.map((formula) => (
              <li key={formula.id} className="rounded-input-lg border border-border bg-surface-alt/40 p-3">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="truncate font-medium text-text-primary">
                      {formula.serviceType ?? 'Colour formula'}
                    </div>
                    <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[12px] text-text-secondary">
                      <span>{formatDateTime(formula.savedAt)}</span>
                      {formula.stylistName ? (
                        <>
                          <Dot />
                          <span>{formula.stylistName}</span>
                        </>
                      ) : null}
                    </div>
                  </div>
                  <span className="shrink-0 rounded-pill bg-surface px-2.5 py-1 text-[11px] font-medium text-text-secondary ring-1 ring-inset ring-border">
                    {formula.items.length} {formula.items.length === 1 ? 'ingredient' : 'ingredients'}
                  </span>
                </div>
                {formula.items.length > 0 ? (
                  <ul className="mt-2 space-y-1 border-t border-border-divider pt-2">
                    {formula.items.map((item, index) => (
                      <li key={index} className="flex gap-2 text-[12px] text-text-secondary">
                        <span className="mt-1.5 h-1 w-1 shrink-0 rounded-full bg-border-strong" />
                        <span>
                          <span className="font-medium text-text-primary">{item.productName}</span>
                          {formatFormulaItemDetail(item)}
                        </span>
                      </li>
                    ))}
                  </ul>
                ) : null}
              </li>
            ))}
          </ol>
        </ScrollList>
      )}
    </Panel>
  );
}

function formatFormulaItemDetail(item: CrmClientFormula['items'][number]): string {
  const parts = [item.shade, item.developer, item.ratio].filter(Boolean);
  if (typeof item.processingTimeMinutes === 'number') {
    parts.push(`${item.processingTimeMinutes} min`);
  }
  return parts.length > 0 ? ` — ${parts.join(' · ')}` : '';
}

function Notes({
  notes,
  value,
  onChange,
  onSubmit,
}: {
  notes: CrmClientNote[];
  value: string;
  onChange: (value: string) => void;
  onSubmit: (event: React.FormEvent<HTMLFormElement>) => void;
}) {
  return (
    <Panel title="Operational Notes" count={notes.length}>
      <form onSubmit={onSubmit} className="mb-4">
        <textarea
          value={value}
          onChange={(event) => onChange(event.target.value)}
          placeholder="Add an internal operational note"
          className="min-h-24 w-full rounded-input-lg border border-border-strong bg-surface px-3 py-2 text-[13px] outline-none transition focus:border-primary focus:ring-2 focus:ring-primary/20"
        />
        <div className="mt-2 flex justify-end">
          <button className="h-9 rounded-pill bg-primary px-4 text-[13px] font-semibold text-text-on-primary transition-colors hover:bg-primary-deep">
            Save note
          </button>
        </div>
      </form>
      {notes.length === 0 ? (
        <Empty title="No notes" body="Operational notes will appear here." />
      ) : (
        <ScrollList>
          <div className="space-y-2">
            {notes.map((note) => (
              <div key={note.id} className="rounded-input-lg border border-border bg-surface-alt/50 px-3 py-2">
                <div className="mb-1 flex items-center gap-2 text-[11px] uppercase tracking-[0.08em] text-text-secondary">
                  <span className="rounded-pill bg-surface px-2 py-0.5 font-medium ring-1 ring-inset ring-border">
                    {note.noteType}
                  </span>
                  <span className="normal-case tracking-normal">{formatDateTime(note.createdAt)}</span>
                </div>
                <div className="whitespace-pre-wrap text-[13px] text-text-primary">{note.content}</div>
              </div>
            ))}
          </div>
        </ScrollList>
      )}
    </Panel>
  );
}

function Allergies({
  allergies,
  value,
  onChange,
  onSubmit,
  canWrite,
}: {
  allergies: CrmAllergyRecord[];
  value: string;
  onChange: (value: string) => void;
  onSubmit: (event: React.FormEvent<HTMLFormElement>) => void;
  canWrite: boolean;
}) {
  return (
    <Panel title="Allergies" count={allergies.length}>
      {canWrite ? (
        <form onSubmit={onSubmit} className="mb-3 flex gap-2">
          <input
            value={value}
            onChange={(event) => onChange(event.target.value)}
            placeholder="Allergen name"
            className="h-9 min-w-0 flex-1 rounded-input-lg border border-border-strong bg-surface px-3 text-[13px] outline-none transition focus:border-primary focus:ring-2 focus:ring-primary/20"
          />
          <button className="h-9 rounded-pill bg-primary px-4 text-[13px] font-semibold text-text-on-primary transition-colors hover:bg-primary-deep">
            Add
          </button>
        </form>
      ) : null}
      {allergies.length === 0 ? (
        <Empty title="No allergy records" body="Active allergy alerts will be prominent here." />
      ) : (
        <ScrollList maxHeightClass="max-h-[18rem]">
          <div className="space-y-2">
            {allergies.map((allergy) => (
              <div
                key={allergy.id}
                className={`rounded-input-lg border px-3 py-2 ${
                  allergy.isActive
                    ? 'border-danger-border bg-danger-soft text-danger'
                    : 'border-border bg-surface-alt text-text-secondary'
                }`}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="font-medium">{allergy.allergenName}</span>
                  {allergy.isActive ? (
                    <span className="rounded-pill bg-danger/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.06em]">
                      Active
                    </span>
                  ) : null}
                </div>
                <div className="mt-0.5 text-[12px] capitalize">Severity: {allergy.severity}</div>
              </div>
            ))}
          </div>
        </ScrollList>
      )}
    </Panel>
  );
}

function PatchTests({
  patchTests,
  status,
  performedAt,
  onStatusChange,
  onPerformedAtChange,
  onSubmit,
  canWrite,
}: {
  patchTests: CrmPatchTestRecord[];
  status: 'pending' | 'passed' | 'failed' | 'expired';
  performedAt: string;
  onStatusChange: (value: 'pending' | 'passed' | 'failed' | 'expired') => void;
  onPerformedAtChange: (value: string) => void;
  onSubmit: (event: React.FormEvent<HTMLFormElement>) => void;
  canWrite: boolean;
}) {
  return (
    <Panel title="Patch Tests" count={patchTests.length}>
      {canWrite ? (
        <form onSubmit={onSubmit} className="mb-3 grid gap-2 sm:grid-cols-[1fr_1fr_auto]">
          <input
            type="datetime-local"
            value={performedAt}
            onChange={(event) => onPerformedAtChange(event.target.value)}
            className="h-9 rounded-input-lg border border-border-strong bg-surface px-3 text-[13px] outline-none transition focus:border-primary focus:ring-2 focus:ring-primary/20"
          />
          <select
            value={status}
            onChange={(event) => onStatusChange(event.target.value as typeof status)}
            className="h-9 rounded-input-lg border border-border-strong bg-surface px-3 text-[13px] outline-none transition focus:border-primary focus:ring-2 focus:ring-primary/20"
          >
            <option value="pending">Pending</option>
            <option value="passed">Passed</option>
            <option value="failed">Failed</option>
            <option value="expired">Expired</option>
          </select>
          <button className="h-9 rounded-pill bg-primary px-4 text-[13px] font-semibold text-text-on-primary transition-colors hover:bg-primary-deep">
            Add
          </button>
        </form>
      ) : null}
      {patchTests.length === 0 ? (
        <Empty title="No patch tests" body="Patch-test alert structure is ready for downstream workflows." />
      ) : (
        <ScrollList maxHeightClass="max-h-[18rem]">
          <div className="space-y-2">
            {patchTests.map((patchTest) => (
              <div
                key={patchTest.id}
                className={`rounded-input-lg border px-3 py-2 ${
                  patchTest.isExpired || patchTest.status === 'failed'
                    ? 'border-danger-border bg-danger-soft text-danger'
                    : 'border-border bg-surface-alt text-text-secondary'
                }`}
              >
                <div className="font-medium capitalize">{patchTest.status}</div>
                <div className="mt-0.5 text-[12px]">
                  Performed {formatDateTime(patchTest.performedAt)}
                  {patchTest.expiresAt ? ` · expires ${formatDateTime(patchTest.expiresAt)}` : ''}
                </div>
              </div>
            ))}
          </div>
        </ScrollList>
      )}
    </Panel>
  );
}

function Messages({ messages }: { messages: CrmMessageLog[] }) {
  return (
    <Panel title="Message Log" count={messages.length}>
      {messages.length === 0 ? (
        <Empty title="No messages" body="Comms message logs will appear here when present." />
      ) : (
        <ScrollList>
          <ol className="flex flex-col gap-1">
            {messages.map((message) => (
              <li
                key={message.id}
                className="rounded-input-lg px-3 py-2 transition-colors hover:bg-surface-alt"
              >
                <div className="flex items-center justify-between gap-3 text-[13px]">
                  <span className="font-medium capitalize text-text-primary">{message.channel}</span>
                  <span className="text-[12px] capitalize text-text-secondary">{message.deliveryStatus}</span>
                </div>
                <div className="mt-1 truncate text-[12px] text-text-secondary">
                  {message.contentPreview ?? 'No content preview'}
                  <Dot />
                  {formatDateTime(message.createdAt)}
                </div>
              </li>
            ))}
          </ol>
        </ScrollList>
      )}
    </Panel>
  );
}

function Photos({ photos }: { photos: CrmVisitPhoto[] }) {
  return (
    <Panel title="Visit Photos" count={photos.length}>
      {photos.length === 0 ? (
        <Empty title="No visit photos" body="Visit-linked photo records will appear here once uploaded." />
      ) : (
        <ScrollList maxHeightClass="max-h-[18rem]">
          <div className="space-y-2">
            {photos.map((photo) => (
              <div key={photo.id} className="rounded-input-lg border border-border bg-surface-alt px-3 py-2">
                <div className="font-medium capitalize text-text-primary">{photo.photoType}</div>
                <div className="break-all font-mono text-[12px] text-text-secondary">
                  {photo.storageBucket}/{photo.storagePath}
                </div>
              </div>
            ))}
          </div>
        </ScrollList>
      )}
    </Panel>
  );
}

function GdprFoundation({ pendingRequests }: { pendingRequests: number }) {
  return (
    <Panel title="GDPR Foundations">
      <div className="text-[13px] text-text-secondary">
        Export-friendly record sections are separated by profile, notes, visits, messages, and photos.
        Deletion/export request tracking is scaffolded for a later legal workflow.
      </div>
      <div className="mt-3 rounded-input-lg bg-surface-alt px-3 py-2 text-[13px] text-text-primary">
        Pending requests: {pendingRequests}
      </div>
    </Panel>
  );
}

function Panel({
  title,
  count,
  action,
  children,
}: {
  title?: string;
  count?: number;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="overflow-hidden rounded-card-lg border border-border bg-surface shadow-card">
      {title ? (
        <div className="flex items-center justify-between gap-3 border-b border-border-divider px-4 py-3">
          <h2 className="flex items-center gap-2 text-[14px] font-semibold text-text-primary">
            {title}
            {typeof count === 'number' ? (
              <span className="inline-flex h-5 min-w-[1.25rem] items-center justify-center rounded-pill bg-surface-alt px-1.5 text-[11px] font-medium text-text-secondary">
                {count}
              </span>
            ) : null}
          </h2>
          {action ? <div className="shrink-0">{action}</div> : null}
        </div>
      ) : null}
      <div className="p-4">{children}</div>
    </section>
  );
}

// Caps a record list to a professional, scrollable height. Short lists never
// scroll; longer ones get the thin `.scroll-area` scrollbar. The negative right
// margin keeps the scrollbar clear of the content without shifting alignment.
function ScrollList({
  children,
  maxHeightClass = 'max-h-[22rem]',
}: {
  children: React.ReactNode;
  maxHeightClass?: string;
}) {
  return <div className={`scroll-area -mr-2 pr-2 ${maxHeightClass}`}>{children}</div>;
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-input-lg border border-border bg-surface-alt px-3 py-2.5 transition-colors hover:border-border-strong">
      <div className="text-[11px] uppercase tracking-[0.08em] text-text-secondary">{label}</div>
      <div className="mt-1 text-[20px] font-semibold leading-6 text-text-primary">{value}</div>
    </div>
  );
}

function AlertPill({ tone, label }: { tone: 'danger' | 'quiet'; label: string }) {
  return (
    <span
      className={`inline-flex rounded-pill border px-3 py-1.5 text-[12px] font-medium ${
        tone === 'danger'
          ? 'border-danger-border bg-danger-soft text-danger'
          : 'border-border bg-surface-alt text-text-secondary'
      }`}
    >
      {label}
    </span>
  );
}

function Empty({ title, body }: { title: string; body: string }) {
  return (
    <div className="py-4 text-center">
      <div className="text-[14px] font-medium text-text-primary">{title}</div>
      <div className="mt-1 text-[13px] text-text-secondary">{body}</div>
    </div>
  );
}

function Avatar({ name }: { name: string }) {
  return (
    <div className="hidden h-12 w-12 shrink-0 select-none items-center justify-center rounded-full bg-primary-soft text-[16px] font-semibold text-primary-deep ring-1 ring-inset ring-border sm:flex">
      {initialsOf(name)}
    </div>
  );
}

// A thin middle-dot separator used between inline metadata (date · stylist · …).
function Dot() {
  return <span aria-hidden className="inline-block h-1 w-1 shrink-0 rounded-full bg-border-strong align-middle" />;
}

function StatusPill({ status }: { status: string }) {
  return (
    <span
      className={`shrink-0 rounded-pill px-2.5 py-1 text-[11px] font-medium capitalize ring-1 ring-inset ${statusTone(
        status,
      )}`}
    >
      {status.replace(/_/g, ' ')}
    </span>
  );
}

function statusTone(status: string): string {
  const normalized = status.toLowerCase();
  if (['paid', 'completed', 'checked_out'].includes(normalized)) {
    return 'bg-success-soft text-success ring-success-border';
  }
  if (['cancelled', 'canceled', 'no_show', 'rejected'].includes(normalized)) {
    return 'bg-danger-soft text-danger ring-danger-border';
  }
  if (['awaiting_payment', 'pending'].includes(normalized)) {
    return 'bg-warning-soft text-warning ring-warning-border';
  }
  return 'bg-surface-alt text-text-secondary ring-border';
}

function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

function formatMoney(amount: number, currencyCode?: string): string {
  try {
    return new Intl.NumberFormat('en-GB', {
      style: 'currency',
      currency: currencyCode ?? 'GBP',
    }).format(amount);
  } catch {
    return `${currencyCode ?? 'GBP'} ${amount.toFixed(2)}`;
  }
}

function formatDateTime(value?: string): string {
  if (!value) return 'Not recorded';
  return new Intl.DateTimeFormat('en-GB', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(value));
}
