import { useEffect, useMemo, useState } from 'react';
import { Link, Navigate, useParams } from 'react-router-dom';
import type {
  CrmAllergyRecord,
  CrmClientDetailResponse,
  CrmClientNote,
  CrmMessageLog,
  CrmPatchTestRecord,
  CrmVisitPhoto,
  CrmVisitSummary,
} from '@sheer/domain';
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
        else setError('Could not load CRM client');
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

  if (auth.status === 'authenticated' && auth.user?.role === 'client') {
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
          CRM
        </Link>
        <span className="mx-1.5">/</span>
        <span className="text-text-primary">{detail?.profile.displayName ?? 'Client'}</span>
      </nav>

      {loading ? (
        <Panel>
          <Empty title="Loading client…" body="Fetching CRM detail." />
        </Panel>
      ) : error && !detail ? (
        <div className="rounded-input-lg border border-danger-border bg-danger-soft px-4 py-3 text-[13px] text-danger">
          {error}
        </div>
      ) : detail ? (
        <>
          <header className="mb-5 rounded-card-lg border border-border bg-surface p-5">
            <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
              <div>
                <h1 className="text-[24px] font-semibold leading-7 text-text-primary">
                  {detail.profile.displayName}
                </h1>
                <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[13px] text-text-secondary">
                  <span>Q code {detail.profile.clientCode}</span>
                  <span>{detail.profile.email ?? 'No email'}</span>
                  <span>{detail.profile.phone ?? 'No phone'}</span>
                  <span>{detail.profile.communicationPreference ?? 'No preference'}</span>
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
            <div className="mt-4 grid grid-cols-2 gap-3 text-[13px] md:grid-cols-4">
              <Metric label="Visits" value={detail.visits.length.toString()} />
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
              <Notes notes={detail.notes} value={noteContent} onChange={setNoteContent} onSubmit={handleAddNote} />
              <Messages messages={detail.messages} />
            </div>
            <div className="space-y-5">
              <Allergies
                allergies={detail.allergies}
                value={allergyName}
                onChange={setAllergyName}
                onSubmit={handleAddAllergy}
                canWrite={auth.user?.role !== 'stylist'}
              />
              <PatchTests
                patchTests={detail.patchTests}
                status={patchStatus}
                performedAt={patchPerformedAt}
                onStatusChange={setPatchStatus}
                onPerformedAtChange={setPatchPerformedAt}
                onSubmit={handleAddPatchTest}
                canWrite={auth.user?.role !== 'stylist'}
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
    <Panel title="Visit History">
      {visits.length === 0 ? (
        <Empty title="No visits yet" body="Completed visit history will appear here." />
      ) : (
        <div className="divide-y divide-border">
          {visits.map((visit) => (
            <div key={visit.id} className="py-3 first:pt-0 last:pb-0">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <div className="font-medium text-text-primary">
                    {visit.clientVisibleSummary ?? visit.serviceSummary ?? 'Service visit'}
                  </div>
                  <div className="mt-1 text-[12px] text-text-secondary">
                    {formatDateTime(visit.occurredAt)}
                    {visit.stylistName ? ` · ${visit.stylistName}` : ''}
                  </div>
                </div>
                <span className="rounded-pill bg-surface-alt px-2.5 py-1 text-[12px] text-text-secondary">
                  {visit.status}
                </span>
              </div>
              <div className="mt-2 text-[12px] text-text-secondary">
                Client-visible summaries only. Formula ingredients, product costs, and lab internals are not shown.
              </div>
            </div>
          ))}
        </div>
      )}
    </Panel>
  );
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
    <Panel title="Operational Notes">
      <form onSubmit={onSubmit} className="mb-4">
        <textarea
          value={value}
          onChange={(event) => onChange(event.target.value)}
          placeholder="Add an internal operational note"
          className="min-h-24 w-full rounded-input-lg border border-border-strong bg-surface px-3 py-2 text-[13px] outline-none focus:border-primary focus:ring-2 focus:ring-primary/20"
        />
        <div className="mt-2 flex justify-end">
          <button className="h-9 rounded-pill bg-primary px-4 text-[13px] font-semibold text-text-on-primary">
            Save note
          </button>
        </div>
      </form>
      {notes.length === 0 ? (
        <Empty title="No notes" body="Operational notes will appear here." />
      ) : (
        <div className="space-y-3">
          {notes.map((note) => (
            <div key={note.id} className="rounded-input-lg border border-border bg-surface-alt/50 px-3 py-2">
              <div className="mb-1 text-[11px] uppercase tracking-[0.08em] text-text-secondary">
                {note.noteType} · {formatDateTime(note.createdAt)}
              </div>
              <div className="whitespace-pre-wrap text-[13px] text-text-primary">{note.content}</div>
            </div>
          ))}
        </div>
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
    <Panel title="Allergies">
      {canWrite ? (
        <form onSubmit={onSubmit} className="mb-3 flex gap-2">
          <input
            value={value}
            onChange={(event) => onChange(event.target.value)}
            placeholder="Allergen name"
            className="h-9 min-w-0 flex-1 rounded-input-lg border border-border-strong bg-surface px-3 text-[13px] outline-none focus:border-primary"
          />
          <button className="h-9 rounded-pill bg-primary px-4 text-[13px] font-semibold text-text-on-primary">
            Add
          </button>
        </form>
      ) : null}
      {allergies.length === 0 ? (
        <Empty title="No allergy records" body="Active allergy alerts will be prominent here." />
      ) : (
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
              <div className="font-medium">{allergy.allergenName}</div>
              <div className="text-[12px]">Severity: {allergy.severity}</div>
            </div>
          ))}
        </div>
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
    <Panel title="Patch Tests">
      {canWrite ? (
        <form onSubmit={onSubmit} className="mb-3 grid gap-2 sm:grid-cols-[1fr_1fr_auto]">
          <input
            type="datetime-local"
            value={performedAt}
            onChange={(event) => onPerformedAtChange(event.target.value)}
            className="h-9 rounded-input-lg border border-border-strong bg-surface px-3 text-[13px]"
          />
          <select
            value={status}
            onChange={(event) => onStatusChange(event.target.value as typeof status)}
            className="h-9 rounded-input-lg border border-border-strong bg-surface px-3 text-[13px]"
          >
            <option value="pending">Pending</option>
            <option value="passed">Passed</option>
            <option value="failed">Failed</option>
            <option value="expired">Expired</option>
          </select>
          <button className="h-9 rounded-pill bg-primary px-4 text-[13px] font-semibold text-text-on-primary">
            Add
          </button>
        </form>
      ) : null}
      {patchTests.length === 0 ? (
        <Empty title="No patch tests" body="Patch-test alert structure is ready for downstream workflows." />
      ) : (
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
              <div className="text-[12px]">
                Performed {formatDateTime(patchTest.performedAt)}
                {patchTest.expiresAt ? ` · expires ${formatDateTime(patchTest.expiresAt)}` : ''}
              </div>
            </div>
          ))}
        </div>
      )}
    </Panel>
  );
}

function Messages({ messages }: { messages: CrmMessageLog[] }) {
  return (
    <Panel title="Message Log">
      {messages.length === 0 ? (
        <Empty title="No messages" body="Comms message logs will appear here when present." />
      ) : (
        <div className="divide-y divide-border">
          {messages.map((message) => (
            <div key={message.id} className="py-2 first:pt-0 last:pb-0">
              <div className="flex justify-between gap-3 text-[13px]">
                <span className="font-medium text-text-primary">{message.channel}</span>
                <span className="text-text-secondary">{message.deliveryStatus}</span>
              </div>
              <div className="mt-1 text-[12px] text-text-secondary">
                {message.contentPreview ?? 'No content preview'} · {formatDateTime(message.createdAt)}
              </div>
            </div>
          ))}
        </div>
      )}
    </Panel>
  );
}

function Photos({ photos }: { photos: CrmVisitPhoto[] }) {
  return (
    <Panel title="Visit Photos">
      {photos.length === 0 ? (
        <Empty title="No visit photos" body="Visit-linked photo records will appear here once uploaded." />
      ) : (
        <div className="space-y-2">
          {photos.map((photo) => (
            <div key={photo.id} className="rounded-input-lg border border-border bg-surface-alt px-3 py-2">
              <div className="font-medium text-text-primary">{photo.photoType}</div>
              <div className="break-all font-mono text-[12px] text-text-secondary">
                {photo.storageBucket}/{photo.storagePath}
              </div>
            </div>
          ))}
        </div>
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

function Panel({ title, children }: { title?: string; children: React.ReactNode }) {
  return (
    <section className="rounded-card-lg border border-border bg-surface p-4">
      {title ? <h2 className="mb-3 text-[15px] font-semibold text-text-primary">{title}</h2> : null}
      {children}
    </section>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-input-lg border border-border bg-surface-alt px-3 py-2">
      <div className="text-[11px] uppercase tracking-[0.08em] text-text-secondary">{label}</div>
      <div className="mt-1 text-[18px] font-semibold text-text-primary">{value}</div>
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
