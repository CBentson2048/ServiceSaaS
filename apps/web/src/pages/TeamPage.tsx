import { useCallback, useEffect, useMemo, useState } from 'react';
import { Navigate } from 'react-router-dom';
import type {
  BusinessLocationSummary,
  InvitationStatus,
  MembershipStatus,
  StaffInvitation,
  StaffInvitationWithToken,
  StaffMember,
} from '@sheer/domain';
import { userHasRole } from '@sheer/domain';
import {
  ApiRequestError,
  deactivateStaffMember,
  listStaff,
  listStaffInvitations,
  reactivateStaffMember,
  resendStaffInvitation,
  revokeStaffInvitation,
} from '../auth/api';
import { useAuth } from '../auth/AuthProvider';
import { EditStaffModal } from '../components/team/EditStaffModal';
import { InviteStaffModal } from '../components/team/InviteStaffModal';

type StatusFilter = 'all' | 'active' | 'suspended' | 'pending' | 'revoked';

const FILTER_BUTTONS: ReadonlyArray<{ id: StatusFilter; label: string }> = [
  { id: 'all', label: 'All' },
  { id: 'active', label: 'Active' },
  { id: 'suspended', label: 'Suspended' },
  { id: 'pending', label: 'Pending' },
  { id: 'revoked', label: 'Revoked' },
];

/** Membership statuses included for each filter. Empty array → hide staff list. */
function membershipStatusesForFilter(filter: StatusFilter): MembershipStatus[] | 'all' {
  switch (filter) {
    case 'all':
      return 'all';
    case 'active':
      return ['active'];
    case 'suspended':
      return ['suspended'];
    case 'revoked':
      return ['revoked'];
    case 'pending':
      return [];
  }
}

/** Invitation statuses included for each filter. Empty array → hide invitations card. */
function invitationStatusesForFilter(filter: StatusFilter): InvitationStatus[] {
  switch (filter) {
    case 'all':
      return ['pending', 'revoked'];
    case 'pending':
      return ['pending'];
    case 'revoked':
      return ['revoked'];
    case 'active':
    case 'suspended':
      return [];
  }
}

export function TeamPage() {
  const auth = useAuth();
  const accessToken = auth.session?.accessToken;
  const [staff, setStaff] = useState<StaffMember[]>([]);
  const [invitations, setInvitations] = useState<StaffInvitation[]>([]);
  const [locations, setLocations] = useState<BusinessLocationSummary[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [actionMessage, setActionMessage] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const [isInviteOpen, setInviteOpen] = useState(false);
  const [editingStaff, setEditingStaff] = useState<StaffMember | null>(null);
  const [busyUserId, setBusyUserId] = useState<string | null>(null);
  const [busyInvitationId, setBusyInvitationId] = useState<string | null>(null);

  const reload = useCallback(async () => {
    if (!accessToken) return;
    setLoading(true);
    setError(null);
    try {
      // Fetch staff + ALL invitations in parallel so the filter buttons
      // (especially "Pending" and "Revoked") work without a follow-up roundtrip.
      const [staffResult, allInvitations] = await Promise.all([
        listStaff(accessToken),
        listStaffInvitations(accessToken, 'all'),
      ]);
      setStaff(staffResult.staff);
      setLocations(staffResult.locations);
      setInvitations(allInvitations);
    } catch (err: unknown) {
      if (err instanceof ApiRequestError) setError(err.message);
      else if (err instanceof Error) setError(err.message);
      else setError('Could not load team data');
    } finally {
      setLoading(false);
    }
  }, [accessToken]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const term = search.trim().toLowerCase();

  const filteredStaff = useMemo(() => {
    const allowed = membershipStatusesForFilter(statusFilter);
    if (Array.isArray(allowed) && allowed.length === 0) return [];
    return staff.filter((member) => {
      if (allowed !== 'all' && !allowed.includes(member.membershipStatus)) return false;
      if (!term) return true;
      const haystack = [
        member.fullName,
        member.email,
        member.location?.name ?? '',
        member.roles.join(' '),
        member.staffProfile?.displayName ?? '',
      ]
        .join(' ')
        .toLowerCase();
      return haystack.includes(term);
    });
  }, [staff, term, statusFilter]);

  const filteredInvitations = useMemo(() => {
    const allowed = invitationStatusesForFilter(statusFilter);
    if (allowed.length === 0) return [];
    return invitations.filter((invitation) => {
      if (!allowed.includes(invitation.status)) return false;
      if (!term) return true;
      const haystack = [
        invitation.firstName,
        invitation.lastName,
        invitation.email,
        invitation.location?.name ?? '',
        invitation.role,
      ]
        .join(' ')
        .toLowerCase();
      return haystack.includes(term);
    });
  }, [invitations, term, statusFilter]);

  const membershipAllowed = membershipStatusesForFilter(statusFilter);
  const showStaffSection = membershipAllowed === 'all' || membershipAllowed.length > 0;
  const isFiltering = term.length > 0 || statusFilter !== 'all';

  if (auth.status === 'authenticated' && !userHasRole(auth.user, 'owner')) {
    return <Navigate to="/unauthorized" replace />;
  }

  async function handleDeactivate(member: StaffMember) {
    if (!accessToken) return;
    setBusyUserId(member.userProfileId);
    setActionMessage(null);
    setError(null);
    try {
      const result = await deactivateStaffMember(accessToken, member.userProfileId);
      setStaff((current) =>
        current.map((m) => (m.userProfileId === member.userProfileId ? result.staff : m)),
      );
      setActionMessage(`${member.fullName || member.email} has been deactivated.`);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Could not deactivate member');
    } finally {
      setBusyUserId(null);
    }
  }

  async function handleReactivate(member: StaffMember) {
    if (!accessToken) return;
    setBusyUserId(member.userProfileId);
    setActionMessage(null);
    setError(null);
    try {
      const result = await reactivateStaffMember(accessToken, member.userProfileId);
      setStaff((current) =>
        current.map((m) => (m.userProfileId === member.userProfileId ? result.staff : m)),
      );
      setActionMessage(`${member.fullName || member.email} has been reactivated.`);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Could not reactivate member');
    } finally {
      setBusyUserId(null);
    }
  }

  async function handleResendInvitation(invitation: StaffInvitation) {
    if (!accessToken) return;
    setBusyInvitationId(invitation.id);
    setActionMessage(null);
    setError(null);
    try {
      const refreshed = await resendStaffInvitation(accessToken, invitation.id);
      setInvitations((current) => upsertInvitation(current, refreshed));
      try {
        await navigator.clipboard.writeText(refreshed.inviteUrl);
        setActionMessage('New invitation link copied to clipboard.');
      } catch {
        setActionMessage('Invitation refreshed — copy the link from the modal.');
      }
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Could not resend invitation');
    } finally {
      setBusyInvitationId(null);
    }
  }

  async function handleRevokeInvitation(invitation: StaffInvitation) {
    if (!accessToken) return;
    setBusyInvitationId(invitation.id);
    setActionMessage(null);
    setError(null);
    try {
      const updated = await revokeStaffInvitation(accessToken, invitation.id);
      // Keep the row so it surfaces under the "Revoked" filter — don't drop it.
      setInvitations((current) => upsertInvitation(current, updated));
      setActionMessage(`Invitation for ${invitation.email} has been revoked.`);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Could not revoke invitation');
    } finally {
      setBusyInvitationId(null);
    }
  }

  function handleInvitationCreated(invitation: StaffInvitationWithToken) {
    setInvitations((current) => upsertInvitation(current, invitation));
  }

  function handleStaffUpdated(updated: StaffMember) {
    setStaff((current) =>
      current.map((member) => (member.userProfileId === updated.userProfileId ? updated : member)),
    );
  }

  return (
    <div className="mx-auto w-full max-w-6xl px-4 py-6 lg:px-8">
      <header className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="text-[22px] font-semibold leading-7 text-text-primary">Team</h1>
          <p className="mt-1 text-[13px] text-text-secondary">
            Invite managers and stylists, change their role or location, and manage access.
          </p>
        </div>
        <button
          type="button"
          className="inline-flex h-10 items-center justify-center rounded-pill bg-primary px-5 text-[13px] font-semibold text-text-on-primary transition hover:bg-primary-deep disabled:cursor-not-allowed disabled:opacity-60"
          onClick={() => setInviteOpen(true)}
          disabled={!accessToken || locations.length === 0}
        >
          Invite team member
        </button>
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

      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <input
          type="search"
          placeholder="Search by name, email, or location"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          className="h-9 w-full rounded-input-lg border border-border-strong bg-surface px-3 text-[13px] outline-none focus:border-primary focus:ring-2 focus:ring-primary/20 sm:w-72"
        />
        <div className="flex flex-wrap items-center gap-1.5">
          {FILTER_BUTTONS.map(({ id, label }) => (
            <button
              key={id}
              type="button"
              className={`h-8 rounded-pill border px-3 text-[12px] font-medium transition ${
                statusFilter === id
                  ? 'border-primary bg-primary-soft text-primary-deep'
                  : 'border-border-strong bg-surface text-text-secondary hover:bg-surface-alt'
              }`}
              onClick={() => setStatusFilter(id)}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      <InvitationsCard
        invitations={filteredInvitations}
        busyId={busyInvitationId}
        onResend={handleResendInvitation}
        onRevoke={handleRevokeInvitation}
      />

      {showStaffSection ? (
        <section className="mt-6 overflow-hidden rounded-card-lg border border-border bg-surface">
          <header className="border-b border-border bg-surface-alt px-4 py-3">
            <div className="text-[12px] font-semibold uppercase tracking-[0.12em] text-text-secondary">
              Team members
            </div>
          </header>

          {loading ? (
            <div className="px-4 py-8 text-center text-[13px] text-text-secondary">
              Loading team…
            </div>
          ) : filteredStaff.length === 0 ? (
            <div className="px-4 py-10 text-center">
              <div className="text-[14px] font-medium text-text-primary">
                {isFiltering ? 'No team members match these filters' : 'No team members yet'}
              </div>
              <div className="mt-1 text-[13px] text-text-secondary">
                {isFiltering
                  ? 'Try clearing the search or switching to "All".'
                  : 'Invite your first manager or stylist to get started.'}
              </div>
            </div>
          ) : (
            <table className="w-full text-left text-[13px]">
              <thead className="bg-surface-alt text-[11px] font-medium uppercase tracking-[0.08em] text-text-secondary">
                <tr>
                  <th className="px-4 py-3">Member</th>
                  <th className="px-4 py-3">Role</th>
                  <th className="px-4 py-3">Location</th>
                  <th className="px-4 py-3">Status</th>
                  <th className="px-4 py-3 text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {filteredStaff.map((member) => (
                  <StaffRow
                    key={member.userProfileId}
                    member={member}
                    busy={busyUserId === member.userProfileId}
                    onEdit={() => setEditingStaff(member)}
                    onDeactivate={() => handleDeactivate(member)}
                    onReactivate={() => handleReactivate(member)}
                  />
                ))}
              </tbody>
            </table>
          )}
        </section>
      ) : null}

      {!showStaffSection && !loading && filteredInvitations.length === 0 ? (
        <section className="mt-6 rounded-card-lg border border-border bg-surface px-4 py-10 text-center">
          <div className="text-[14px] font-medium text-text-primary">
            No invitations match this filter
          </div>
          <div className="mt-1 text-[13px] text-text-secondary">
            Try clearing the search or switching to &quot;All&quot;.
          </div>
        </section>
      ) : null}

      <InviteStaffModal
        open={isInviteOpen}
        onClose={() => setInviteOpen(false)}
        onCreated={handleInvitationCreated}
        accessToken={accessToken ?? ''}
        locations={locations}
      />
      <EditStaffModal
        open={editingStaff != null}
        onClose={() => setEditingStaff(null)}
        onSaved={handleStaffUpdated}
        accessToken={accessToken ?? ''}
        staff={editingStaff}
        locations={locations}
      />
    </div>
  );
}

function StaffRow({
  member,
  busy,
  onEdit,
  onDeactivate,
  onReactivate,
}: {
  member: StaffMember;
  busy: boolean;
  onEdit: () => void;
  onDeactivate: () => void;
  onReactivate: () => void;
}) {
  const initials = (member.fullName || member.email)
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? '')
    .join('');
  const statusTone = statusToneFor(member.membershipStatus);
  const isOwner = member.roles.includes('owner');

  return (
    <tr>
      <td className="px-4 py-3">
        <div className="flex items-center gap-3">
          <div
            className="grid h-9 w-9 place-items-center rounded-full text-[12px] font-semibold text-white"
            style={{ backgroundColor: member.staffProfile?.colorHex ?? '#A67CF5' }}
          >
            {initials || '·'}
          </div>
          <div>
            <div className="font-medium text-text-primary">
              {member.fullName || member.email}
            </div>
            <div className="text-[12px] text-text-secondary">{member.email}</div>
          </div>
        </div>
      </td>
      <td className="px-4 py-3 text-text-primary">
        <div className="flex flex-wrap gap-1">
          {member.roles.map((role) => (
            <span
              key={role}
              className="inline-flex h-5 items-center rounded-pill bg-surface-alt px-2 text-[11px] font-medium capitalize text-text-secondary"
            >
              {role}
            </span>
          ))}
        </div>
      </td>
      <td className="px-4 py-3 text-text-secondary">
        {isOwner
          ? 'Business-wide'
          : member.location?.name ?? <span className="text-warning">No location</span>}
      </td>
      <td className="px-4 py-3">
        <span
          className={`inline-flex h-6 items-center rounded-pill px-2.5 text-[11px] font-medium ${statusTone}`}
        >
          {labelForStatus(member.membershipStatus)}
        </span>
      </td>
      <td className="px-4 py-3 text-right">
        <div className="inline-flex items-center justify-end gap-1.5">
          {isOwner ? (
            <span className="text-[12px] text-text-muted">Owner — protected</span>
          ) : (
            <>
              <button
                type="button"
                className="h-8 rounded-pill border border-border-strong bg-surface px-3 text-[12px] font-medium text-text-secondary transition hover:bg-surface-alt"
                onClick={onEdit}
                disabled={busy}
              >
                Edit
              </button>
              {member.membershipStatus === 'active' ? (
                <button
                  type="button"
                  className="h-8 rounded-pill border border-warning-border bg-warning-soft px-3 text-[12px] font-medium text-warning transition hover:brightness-95 disabled:opacity-60"
                  onClick={onDeactivate}
                  disabled={busy}
                >
                  Deactivate
                </button>
              ) : (
                <button
                  type="button"
                  className="h-8 rounded-pill border border-success-border bg-success-soft px-3 text-[12px] font-medium text-success transition hover:brightness-95 disabled:opacity-60"
                  onClick={onReactivate}
                  disabled={busy}
                >
                  Reactivate
                </button>
              )}
            </>
          )}
        </div>
      </td>
    </tr>
  );
}

function InvitationsCard({
  invitations,
  busyId,
  onResend,
  onRevoke,
}: {
  invitations: StaffInvitation[];
  busyId: string | null;
  onResend: (invitation: StaffInvitation) => void;
  onRevoke: (invitation: StaffInvitation) => void;
}) {
  if (invitations.length === 0) return null;
  const hasRevoked = invitations.some((inv) => inv.status === 'revoked');
  const hasPending = invitations.some((inv) => inv.status === 'pending');
  const heading = hasRevoked && !hasPending ? 'Revoked invitations' : 'Invitations';

  return (
    <section className="mt-6 overflow-hidden rounded-card-lg border border-border bg-surface">
      <header className="border-b border-border bg-surface-alt px-4 py-3">
        <div className="text-[12px] font-semibold uppercase tracking-[0.12em] text-text-secondary">
          {heading}
        </div>
      </header>
      <ul className="divide-y divide-border">
        {invitations.map((invitation) => {
          const expiresAt = new Date(invitation.expiresAt);
          const expiresSoon =
            invitation.status === 'pending' &&
            expiresAt.getTime() - Date.now() < 24 * 3600 * 1000;
          const isPending = invitation.status === 'pending';
          const isBusy = busyId === invitation.id;
          return (
            <li
              key={invitation.id}
              className="flex flex-col gap-2 px-4 py-3 sm:flex-row sm:items-center sm:justify-between"
            >
              <div>
                <div className="text-[13px] font-medium text-text-primary">
                  {invitation.firstName} {invitation.lastName}{' '}
                  <span className="text-text-secondary">({invitation.email})</span>
                  <span
                    className={`ml-2 inline-flex h-5 items-center rounded-pill px-2 text-[10px] font-medium uppercase tracking-[0.06em] ${invitationStatusTone(
                      invitation.status,
                    )}`}
                  >
                    {invitation.status}
                  </span>
                </div>
                <div className="text-[12px] text-text-secondary">
                  {invitation.role.toUpperCase()} · {invitation.location?.name ?? 'unknown location'}
                  {isPending ? (
                    <>
                      {' '}
                      ·{' '}
                      <span className={expiresSoon ? 'text-warning' : ''}>
                        expires {expiresAt.toLocaleString()}
                      </span>
                    </>
                  ) : invitation.revokedAt ? (
                    <> · revoked {new Date(invitation.revokedAt).toLocaleString()}</>
                  ) : null}
                </div>
              </div>
              <div className="flex items-center gap-1.5">
                <button
                  type="button"
                  className="h-8 rounded-pill border border-border-strong bg-surface px-3 text-[12px] font-medium text-text-secondary transition hover:bg-surface-alt disabled:opacity-60"
                  onClick={() => onResend(invitation)}
                  disabled={isBusy}
                  title={
                    isPending
                      ? 'Rotate the token and email a fresh link'
                      : 'Re-issue this invitation with a new token'
                  }
                >
                  {isBusy ? 'Resending…' : isPending ? 'Resend' : 'Re-issue'}
                </button>
                {isPending ? (
                  <button
                    type="button"
                    className="h-8 rounded-pill border border-danger-border bg-danger-soft px-3 text-[12px] font-medium text-danger transition hover:brightness-95 disabled:opacity-60"
                    onClick={() => onRevoke(invitation)}
                    disabled={isBusy}
                  >
                    Revoke
                  </button>
                ) : null}
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function invitationStatusTone(status: InvitationStatus): string {
  switch (status) {
    case 'pending':
      return 'border border-primary/30 bg-primary-soft text-primary-deep';
    case 'accepted':
      return 'border border-success-border bg-success-soft text-success';
    case 'revoked':
      return 'border border-danger-border bg-danger-soft text-danger';
    case 'expired':
    default:
      return 'border border-border-strong bg-surface-alt text-text-secondary';
  }
}

function upsertInvitation(
  list: StaffInvitation[],
  next: StaffInvitation,
): StaffInvitation[] {
  const idx = list.findIndex((inv) => inv.id === next.id);
  if (idx === -1) return [next, ...list];
  const copy = list.slice();
  copy[idx] = next;
  return copy;
}

function statusToneFor(status: StaffMember['membershipStatus']): string {
  switch (status) {
    case 'active':
      return 'border border-success-border bg-success-soft text-success';
    case 'invited':
      return 'border border-primary/30 bg-primary-soft text-primary-deep';
    case 'suspended':
      return 'border border-warning-border bg-warning-soft text-warning';
    case 'revoked':
    default:
      return 'border border-danger-border bg-danger-soft text-danger';
  }
}

function labelForStatus(status: StaffMember['membershipStatus']): string {
  return status.charAt(0).toUpperCase() + status.slice(1);
}
