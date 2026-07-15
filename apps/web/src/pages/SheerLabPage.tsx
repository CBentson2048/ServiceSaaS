import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { Navigate } from 'react-router-dom';
import type {
  LabDeviceRegistrationResponse,
  LabPinCredentialStatus,
  SharedDeviceSummary,
  SheerLabAnalyticsRange,
} from '@sheer/domain';
import { userHasAnyRole, userHasRole } from '@sheer/domain';
import {
  ApiRequestError,
  listLabDevices,
  listLabPinStatuses,
  registerLabDevice,
  resetLabPin,
  revokeLabDevice,
  setLabPin,
} from '../auth/api';
import { useAuth } from '../auth/AuthProvider';
import { useLocationScope } from '../components/LocationScopeContext';
import { useSheerLabAnalytics } from '../hooks/useSheerLabAnalytics';

const ANALYTICS_RANGES: Array<{ value: SheerLabAnalyticsRange; label: string }> = [
  { value: 'today', label: 'Today' },
  { value: 'week', label: 'This week' },
  { value: 'month', label: 'This month' },
];

type DeviceStatusFilter = 'all' | 'active' | 'inactive' | 'revoked';

const DEVICE_STATUS_FILTERS: Array<{ value: DeviceStatusFilter; label: string }> = [
  { value: 'all', label: 'All' },
  { value: 'active', label: 'Active' },
  { value: 'inactive', label: 'Inactive' },
  { value: 'revoked', label: 'Revoked' },
];

function deviceStatusGroup(status: SharedDeviceSummary['status']): Exclude<DeviceStatusFilter, 'all'> {
  if (status === 'active' || status === 'registered') return 'active';
  if (status === 'revoked') return 'revoked';
  return 'inactive';
}

export function SheerLabPage() {
  const auth = useAuth();
  const accessToken = auth.session?.accessToken;
  const canViewAnalytics = userHasAnyRole(auth.user, ['owner', 'manager']);
  // The staff + device lists filter by the shared sidebar scope ("All" shows
  // every location). The sentinel is the literal 'all', matching the filter
  // checks below, so the scope value drops straight in.
  const { selectedLocationId: scopeLocationId } = useLocationScope();

  const [credentials, setCredentials] = useState<LabPinCredentialStatus[]>([]);
  const [devices, setDevices] = useState<SharedDeviceSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [actionMessage, setActionMessage] = useState<string | null>(null);
  const [deviceStatusFilter, setDeviceStatusFilter] = useState<DeviceStatusFilter>('all');
  const [pinInputs, setPinInputs] = useState<Record<string, string>>({});
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [deviceLocationId, setDeviceLocationId] = useState('');
  const [deviceName, setDeviceName] = useState('Qlooqo Lab iPad');
  const [stationLabel, setStationLabel] = useState('');
  const [registeredDevice, setRegisteredDevice] = useState<LabDeviceRegistrationResponse | null>(null);
  const [analyticsRange, setAnalyticsRange] = useState<SheerLabAnalyticsRange>('week');

  const analytics = useSheerLabAnalytics(analyticsRange);

  const reload = useCallback(async () => {
    if (!accessToken) return;
    setLoading(true);
    setError(null);
    try {
      const [pinResponse, deviceResponse] = await Promise.all([
        listLabPinStatuses(accessToken),
        listLabDevices(accessToken),
      ]);
      setCredentials(Array.isArray(pinResponse.credentials) ? pinResponse.credentials : []);
      setDevices(Array.isArray(deviceResponse.devices) ? deviceResponse.devices : []);
    } catch (err: unknown) {
      if (err instanceof ApiRequestError) setError(err.message);
      else if (err instanceof Error) setError(err.message);
      else setError('Could not load Qlooqo Lab access');
    } finally {
      setLoading(false);
    }
  }, [accessToken]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const locations = useMemo(() => {
    const byId = new Map<string, string>();
    credentials.forEach((member) => byId.set(member.locationId, member.locationName));
    devices.forEach((device) => {
      if (!byId.has(device.locationId)) byId.set(device.locationId, device.locationName);
    });
    return Array.from(byId.entries()).map(([id, name]) => ({ id, name }));
  }, [credentials, devices]);

  const filteredCredentials = useMemo(
    () =>
      scopeLocationId === 'all'
        ? credentials
        : credentials.filter((member) => member.locationId === scopeLocationId),
    [scopeLocationId, credentials],
  );

  const activeDeviceCount = useMemo(
    () => devices.filter((device) => device.status === 'active' || device.status === 'registered').length,
    [devices],
  );
  const membersWithPin = useMemo(
    () => credentials.filter((member) => member.status === 'active').length,
    [credentials],
  );

  const filteredDevices = useMemo(
    () =>
      devices.filter((device) => {
        if (scopeLocationId !== 'all' && device.locationId !== scopeLocationId) return false;
        if (deviceStatusFilter !== 'all' && deviceStatusGroup(device.status) !== deviceStatusFilter) return false;
        return true;
      }),
    [devices, scopeLocationId, deviceStatusFilter],
  );

  useEffect(() => {
    if (!deviceLocationId && locations.length > 0) {
      setDeviceLocationId(locations[0].id);
    }
  }, [deviceLocationId, locations]);

  // Access requires owner OR manager (mirrors the route's ProtectedRoute gate).
  // Gate on the role we REQUIRE, never on 'stylist' to exclude — an owner who
  // also holds the stylist role must keep access (same roles[] inversion bug
  // fixed in Client Hub, the Appointment Book, and Lab analytics).
  if (auth.status === 'authenticated' && !userHasAnyRole(auth.user, ['owner', 'manager'])) {
    return <Navigate to="/unauthorized" replace />;
  }

  async function handleSetPin(member: LabPinCredentialStatus) {
    if (!accessToken) return;
    const key = rowKey(member);
    const pin = pinInputs[key]?.trim() ?? '';
    if (!/^\d{4}$/.test(pin)) {
      setError('PIN must be exactly 4 digits.');
      return;
    }

    setBusyKey(key);
    setError(null);
    setActionMessage(null);
    try {
      const result = await setLabPin(accessToken, {
        locationId: member.locationId,
        userProfileId: member.userProfileId,
        pin,
      });
      setCredentials((current) => replaceCredential(current, result.credential));
      setPinInputs((current) => ({ ...current, [key]: '' }));
      setActionMessage(`PIN set for ${member.displayName}.`);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Could not set PIN');
    } finally {
      setBusyKey(null);
    }
  }

  async function handleResetPin(member: LabPinCredentialStatus) {
    if (!accessToken) return;
    const key = rowKey(member);
    setBusyKey(key);
    setError(null);
    setActionMessage(null);
    try {
      const result = await resetLabPin(accessToken, {
        locationId: member.locationId,
        userProfileId: member.userProfileId,
      });
      setCredentials((current) => replaceCredential(current, result.credential));
      setActionMessage(`PIN reset for ${member.displayName}. Set a new PIN before their next Lab login.`);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Could not reset PIN');
    } finally {
      setBusyKey(null);
    }
  }

  async function handleRegisterDevice() {
    if (!accessToken || !auth.user?.businessId) return;
    if (!deviceLocationId) {
      setError('Choose a location before registering a Lab device.');
      return;
    }

    setBusyKey('register-device');
    setError(null);
    setActionMessage(null);
    setRegisteredDevice(null);
    try {
      const result = await registerLabDevice(accessToken, {
        businessId: auth.user.businessId,
        locationId: deviceLocationId,
        deviceName: deviceName.trim() || 'Qlooqo Lab iPad',
        stationLabel: stationLabel.trim() || undefined,
      });
      setRegisteredDevice(result);
      setDevices((current) => [
        { ...result.device, locationName: locationName(locations, result.device.locationId) },
        ...current.filter((device) => device.id !== result.device.id),
      ]);
      setStationLabel('');
      setActionMessage(
        `Registered ${result.device.deviceName} for ${locationName(locations, result.device.locationId)}. Enter the one-time token in the Qlooqo Lab app now.`,
      );
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Could not register Lab device');
    } finally {
      setBusyKey(null);
    }
  }

  async function handleRevokeDevice(device: SharedDeviceSummary) {
    if (!accessToken) return;
    const confirmed = window.confirm(
      `Revoke ${device.deviceName}? The iPad will be signed out and must be re-registered to use Qlooqo Lab again.`,
    );
    if (!confirmed) return;

    const key = `revoke-${device.id}`;
    setBusyKey(key);
    setError(null);
    setActionMessage(null);
    try {
      const result = await revokeLabDevice(accessToken, { deviceId: device.id });
      setDevices((current) => current.map((item) => (item.id === device.id ? result.device : item)));
      if (registeredDevice?.device.id === device.id) setRegisteredDevice(null);
      setActionMessage(`${device.deviceName} has been revoked.`);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Could not revoke device');
    } finally {
      setBusyKey(null);
    }
  }

  return (
    <div className="mx-auto w-full max-w-6xl px-4 py-6 lg:px-8">
      <header className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="text-[22px] font-semibold leading-7 text-text-primary">Qlooqo Lab</h1>
          <p className="mt-1 max-w-2xl text-[13px] text-text-secondary">
            Manage the shared iPads, staff PINs, and colour-bar performance for the dedicated Qlooqo Lab app.
          </p>
        </div>
        <button
          type="button"
          className="inline-flex h-10 items-center justify-center gap-2 rounded-pill border border-border-strong bg-surface px-5 text-[13px] font-semibold text-text-primary transition hover:bg-surface-alt disabled:opacity-50"
          onClick={() => void reload()}
          disabled={loading}
        >
          {loading ? 'Refreshing…' : 'Refresh'}
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

      <div className="mb-6 grid gap-3 sm:grid-cols-3">
        <SummaryTile label="Registered devices" value={String(devices.length)} hint={`${activeDeviceCount} active`} />
        <SummaryTile label="Team members" value={String(credentials.length)} hint={`${membersWithPin} PIN active`} />
        <SummaryTile
          label="Locations"
          value={String(locations.length)}
          hint={userHasRole(auth.user, 'owner') ? 'Across business' : 'In your scope'}
        />
      </div>

      {canViewAnalytics ? (
        <section className="mb-6 rounded-card-lg border border-border bg-surface shadow-card">
          <header className="flex flex-col gap-3 border-b border-border bg-surface-alt px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <div className="text-[12px] font-semibold uppercase tracking-[0.12em] text-text-secondary">
                Colour bar performance
              </div>
              <div className="mt-1 text-[13px] text-text-secondary">
                Revenue, formula cost, and waste captured through the Qlooqo Lab app.
              </div>
            </div>
            <RangeToggle value={analyticsRange} onChange={setAnalyticsRange} />
          </header>

          {analytics.isLoading ? (
            <div className="px-4 py-8 text-center text-[13px] text-text-secondary">Loading performance…</div>
          ) : analytics.error ? (
            <div className="px-4 py-8 text-center text-[13px] text-text-secondary">
              Performance data is unavailable right now.
            </div>
          ) : analytics.data ? (
            <div className="grid gap-px bg-border sm:grid-cols-2 lg:grid-cols-4">
              <MetricCell
                label="Colour revenue"
                value={formatMoney(analytics.data.summary.colourRevenueCents, analytics.data.summary.currencyCode)}
              />
              <MetricCell
                label="Formula cost"
                value={formatMoney(analytics.data.summary.formulaCostCents, analytics.data.summary.currencyCode)}
              />
              <MetricCell
                label="Gross margin"
                value={formatMoney(analytics.data.summary.grossMarginCents, analytics.data.summary.currencyCode)}
                hint={`${analytics.data.summary.grossMarginPercent.toFixed(1)}% margin`}
              />
              <MetricCell
                label="Waste cost"
                value={formatMoney(analytics.data.summary.wasteCostCents, analytics.data.summary.currencyCode)}
                hint={`${analytics.data.summary.wastePercentOfRevenue.toFixed(1)}% of revenue`}
                tone="warning"
              />
            </div>
          ) : (
            <div className="px-4 py-8 text-center text-[13px] text-text-secondary">No performance data yet.</div>
          )}
        </section>
      ) : null}

      <section className="mb-6 rounded-card-lg border border-border bg-surface shadow-card">
        <header className="border-b border-border bg-surface-alt px-4 py-3">
          <div className="text-[12px] font-semibold uppercase tracking-[0.12em] text-text-secondary">
            Shared Lab devices
          </div>
          <div className="mt-1 text-[13px] text-text-secondary">
            Register shared iPads to a location and revoke them when they are lost, replaced, or retired. Tokens are
            shown once and entered directly in the Qlooqo Lab app.
          </div>
        </header>

        <div className="grid gap-4 border-b border-border px-4 py-4 lg:grid-cols-[1fr_1.2fr]">
          <div className="space-y-3">
            <FieldLabel text="Location">
              <select
                value={deviceLocationId}
                onChange={(event) => setDeviceLocationId(event.target.value)}
                className="mt-1 h-10 w-full rounded-input-lg border border-border-strong bg-surface px-3 text-[13px] font-normal normal-case tracking-normal text-text-primary outline-none focus:border-primary"
              >
                {locations.length === 0 ? <option value="">No locations available</option> : null}
                {locations.map((location) => (
                  <option key={location.id} value={location.id}>
                    {location.name}
                  </option>
                ))}
              </select>
            </FieldLabel>
            <FieldLabel text="Device name">
              <input
                value={deviceName}
                onChange={(event) => setDeviceName(event.target.value)}
                placeholder="Qlooqo Lab iPad"
                className="mt-1 h-10 w-full rounded-input-lg border border-border-strong bg-surface px-3 text-[13px] font-normal normal-case tracking-normal text-text-primary outline-none focus:border-primary"
              />
            </FieldLabel>
            <FieldLabel text="Station label">
              <input
                value={stationLabel}
                onChange={(event) => setStationLabel(event.target.value)}
                placeholder="Optional, e.g. Colour bar"
                className="mt-1 h-10 w-full rounded-input-lg border border-border-strong bg-surface px-3 text-[13px] font-normal normal-case tracking-normal text-text-primary outline-none focus:border-primary"
              />
            </FieldLabel>
            <button
              type="button"
              className="h-10 rounded-pill bg-primary px-5 text-[13px] font-semibold text-text-on-primary transition hover:bg-primary-deep disabled:opacity-50"
              onClick={() => void handleRegisterDevice()}
              disabled={busyKey === 'register-device' || !accessToken || !deviceLocationId}
            >
              {busyKey === 'register-device' ? 'Registering…' : 'Register iPad'}
            </button>
          </div>

          <div className="rounded-input-lg border border-border bg-surface-alt p-4">
            <div className="text-[13px] font-semibold text-text-primary">One-time app registration token</div>
            {registeredDevice ? (
              <>
                <div className="mt-2 rounded-input-lg border border-border-strong bg-surface px-3 py-2 font-mono text-[12px] text-text-primary break-all">
                  {registeredDevice.deviceSessionToken}
                </div>
                <div className="mt-2 text-[12px] text-text-secondary">
                  Open the Qlooqo Lab app on the iPad, paste this token into <strong>Register this iPad</strong>, then
                  tap <strong>Register device</strong>. Do not store this token in notes or messages.
                </div>
              </>
            ) : (
              <div className="mt-2 text-[12px] text-text-secondary">
                Register a device to generate a secure session token. Existing token values are never shown again.
              </div>
            )}
          </div>
        </div>

        {loading ? (
          <div className="px-4 py-8 text-center text-[13px] text-text-secondary">Loading devices…</div>
        ) : devices.length === 0 ? (
          <div className="px-4 py-10 text-center">
            <div className="text-[14px] font-medium text-text-primary">No devices registered</div>
            <div className="mt-1 text-[13px] text-text-secondary">
              Register your first shared iPad above to start using Qlooqo Lab.
            </div>
          </div>
        ) : (
          <>
            <div className="flex flex-col gap-3 border-b border-border px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
              <div className="flex flex-wrap items-center gap-2">
                <FilterToggle
                  options={DEVICE_STATUS_FILTERS}
                  value={deviceStatusFilter}
                  onChange={setDeviceStatusFilter}
                />
              </div>
              <div className="text-[12px] text-text-secondary">
                Showing {filteredDevices.length} of {devices.length}{' '}
                {devices.length === 1 ? 'device' : 'devices'}
              </div>
            </div>

            {filteredDevices.length === 0 ? (
              <div className="px-4 py-10 text-center">
                <div className="text-[14px] font-medium text-text-primary">No matching devices</div>
                <div className="mt-1 text-[13px] text-text-secondary">
                  No devices match the selected filters. Try clearing them to see every device.
                </div>
              </div>
            ) : (
              <div className="max-h-[460px] overflow-auto">
                <table className="w-full text-left text-[13px]">
                  <thead className="sticky top-0 z-10 bg-surface-alt text-[11px] font-medium uppercase tracking-[0.08em] text-text-secondary">
                    <tr className="border-b border-border">
                      <th className="border-b border-border px-4 py-3">Device</th>
                      <th className="border-b border-border px-4 py-3">Location</th>
                      <th className="border-b border-border px-4 py-3">Status</th>
                      <th className="border-b border-border px-4 py-3">Last seen</th>
                      <th className="border-b border-border px-4 py-3 text-right">Manage</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {filteredDevices.map((device) => {
                      const busy = busyKey === `revoke-${device.id}`;
                      const revoked = device.status === 'revoked';
                      return (
                        <tr key={device.id} className={revoked ? 'opacity-60' : undefined}>
                          <td className="px-4 py-3">
                            <div className="font-medium text-text-primary">{device.deviceName}</div>
                            <div className="text-[12px] text-text-secondary">
                              {device.stationLabel ? device.stationLabel : 'Shared iPad'} · Registered{' '}
                              {formatDate(device.registeredAt)}
                            </div>
                          </td>
                          <td className="px-4 py-3 text-text-secondary">{device.locationName}</td>
                          <td className="px-4 py-3">
                            <DeviceStatusPill status={device.status} />
                          </td>
                          <td className="px-4 py-3 text-text-secondary">
                            {device.lastSeenAt ? formatRelative(device.lastSeenAt) : 'Never'}
                          </td>
                          <td className="px-4 py-3 text-right">
                            <button
                              type="button"
                              className="h-9 rounded-pill border border-danger-border px-4 text-[12px] font-semibold text-danger transition hover:bg-danger-soft disabled:opacity-40"
                              disabled={busy || revoked}
                              onClick={() => void handleRevokeDevice(device)}
                            >
                              {busy ? 'Revoking…' : revoked ? 'Revoked' : 'Revoke'}
                            </button>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </>
        )}
      </section>

      <section className="rounded-card-lg border border-border bg-surface shadow-card">
        <header className="flex flex-col gap-3 border-b border-border bg-surface-alt px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <div className="text-[12px] font-semibold uppercase tracking-[0.12em] text-text-secondary">
              Staff PIN management
            </div>
            <div className="mt-1 text-[13px] text-text-secondary">
              PINs are stored hashed and unlock the shared iPad for owners, managers and stylists. Existing values are
              never displayed.
            </div>
          </div>
        </header>

        {loading ? (
          <div className="px-4 py-8 text-center text-[13px] text-text-secondary">Loading Lab access…</div>
        ) : filteredCredentials.length === 0 ? (
          <div className="px-4 py-10 text-center">
            <div className="text-[14px] font-medium text-text-primary">No team members available</div>
            <div className="mt-1 text-[13px] text-text-secondary">
              Invite active owners, managers or stylists before assigning Qlooqo Lab PINs.
            </div>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-[13px]">
              <thead className="bg-surface-alt text-[11px] font-medium uppercase tracking-[0.08em] text-text-secondary">
                <tr>
                  <th className="px-4 py-3">Team member</th>
                  <th className="px-4 py-3">Role</th>
                  <th className="px-4 py-3">Location</th>
                  <th className="px-4 py-3">PIN status</th>
                  <th className="px-4 py-3">Set / reset PIN</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {filteredCredentials.map((member) => {
                  const key = rowKey(member);
                  const busy = busyKey === key;
                  return (
                    <tr key={key}>
                      <td className="px-4 py-3">
                        <div className="font-medium text-text-primary">{member.displayName}</div>
                        <div className="text-[12px] text-text-secondary">{member.email}</div>
                      </td>
                      <td className="px-4 py-3">
                        <RoleBadge role={member.role} />
                      </td>
                      <td className="px-4 py-3 text-text-secondary">{member.locationName}</td>
                      <td className="px-4 py-3">
                        <StatusPill status={member.status} />
                        <div className="mt-1 text-[11px] text-text-secondary">
                          {member.lastRotatedAt
                            ? `Updated ${formatDate(member.lastRotatedAt)}`
                            : 'No PIN set yet'}
                        </div>
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex flex-wrap items-center gap-2">
                          <input
                            inputMode="numeric"
                            maxLength={4}
                            pattern="[0-9]*"
                            placeholder="4 digit PIN"
                            value={pinInputs[key] ?? ''}
                            onChange={(event) =>
                              setPinInputs((current) => ({
                                ...current,
                                [key]: event.target.value.replace(/\D/g, '').slice(0, 4),
                              }))
                            }
                            className="h-9 w-28 rounded-input-lg border border-border-strong bg-surface px-3 text-[13px] outline-none focus:border-primary focus:ring-2 focus:ring-primary/20"
                          />
                          <button
                            type="button"
                            className="h-9 rounded-pill bg-primary px-4 text-[12px] font-semibold text-text-on-primary transition hover:bg-primary-deep disabled:opacity-50"
                            disabled={busy || !/^\d{4}$/.test(pinInputs[key] ?? '')}
                            onClick={() => void handleSetPin(member)}
                          >
                            {member.status === 'not_set' ? 'Set PIN' : 'Update PIN'}
                          </button>
                          <button
                            type="button"
                            className="h-9 rounded-pill border border-border-strong px-4 text-[12px] font-semibold text-text-secondary transition hover:bg-surface-alt disabled:opacity-50"
                            disabled={busy || member.status === 'not_set'}
                            onClick={() => void handleResetPin(member)}
                          >
                            Reset
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}

function SummaryTile({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-card-lg border border-border bg-surface px-4 py-3 shadow-card">
      <div className="text-[11px] font-medium uppercase tracking-[0.08em] text-text-secondary">{label}</div>
      <div className="mt-1 text-[24px] font-semibold leading-7 text-text-primary">{value}</div>
      {hint ? <div className="mt-0.5 text-[12px] text-text-secondary">{hint}</div> : null}
    </div>
  );
}

function MetricCell({
  label,
  value,
  hint,
  tone = 'default',
}: {
  label: string;
  value: string;
  hint?: string;
  tone?: 'default' | 'warning';
}) {
  return (
    <div className="bg-surface px-4 py-4">
      <div className="text-[11px] font-medium uppercase tracking-[0.08em] text-text-secondary">{label}</div>
      <div
        className={`mt-1 text-[20px] font-semibold leading-7 ${tone === 'warning' ? 'text-warning' : 'text-text-primary'}`}
      >
        {value}
      </div>
      {hint ? <div className="mt-0.5 text-[12px] text-text-secondary">{hint}</div> : null}
    </div>
  );
}

function RangeToggle({
  value,
  onChange,
}: {
  value: SheerLabAnalyticsRange;
  onChange: (range: SheerLabAnalyticsRange) => void;
}) {
  return (
    <div className="inline-flex rounded-pill border border-border-strong bg-surface p-0.5">
      {ANALYTICS_RANGES.map((option) => {
        const active = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            onClick={() => onChange(option.value)}
            className={`h-8 rounded-pill px-3 text-[12px] font-semibold transition ${
              active ? 'bg-primary text-text-on-primary' : 'text-text-secondary hover:text-text-primary'
            }`}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}

function FilterToggle<T extends string>({
  options,
  value,
  onChange,
}: {
  options: Array<{ value: T; label: string }>;
  value: T;
  onChange: (value: T) => void;
}) {
  return (
    <div className="inline-flex rounded-pill border border-border-strong bg-surface p-0.5">
      {options.map((option) => {
        const active = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            onClick={() => onChange(option.value)}
            className={`h-8 rounded-pill px-3 text-[12px] font-semibold transition ${
              active ? 'bg-primary text-text-on-primary' : 'text-text-secondary hover:text-text-primary'
            }`}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}

function FieldLabel({ text, children }: { text: string; children: ReactNode }) {
  return (
    <label className="block text-[12px] font-semibold uppercase tracking-[0.08em] text-text-secondary">
      {text}
      {children}
    </label>
  );
}

function StatusPill({ status }: { status: LabPinCredentialStatus['status'] }) {
  const label = status === 'not_set' ? 'Not set' : status.replace(/_/g, ' ');
  const tone =
    status === 'active'
      ? 'border-success-border bg-success-soft text-success'
      : status === 'locked'
        ? 'border-danger-border bg-danger-soft text-danger'
        : 'border-border-strong bg-surface-alt text-text-secondary';
  return (
    <span className={`inline-flex rounded-pill border px-2.5 py-1 text-[11px] font-semibold capitalize ${tone}`}>
      {label}
    </span>
  );
}

function RoleBadge({ role }: { role: LabPinCredentialStatus['role'] }) {
  const tone =
    role === 'owner'
      ? 'border-primary/40 bg-primary-soft text-primary-deep'
      : role === 'manager'
        ? 'border-border-strong bg-surface-alt text-text-primary'
        : 'border-border-strong bg-surface-alt text-text-secondary';
  return (
    <span className={`inline-flex rounded-pill border px-2.5 py-1 text-[11px] font-semibold capitalize ${tone}`}>
      {role}
    </span>
  );
}

function DeviceStatusPill({ status }: { status: SharedDeviceSummary['status'] }) {
  const tone =
    status === 'active' || status === 'registered'
      ? 'border-success-border bg-success-soft text-success'
      : status === 'revoked'
        ? 'border-danger-border bg-danger-soft text-danger'
        : 'border-border-strong bg-surface-alt text-text-secondary';
  return (
    <span className={`inline-flex rounded-pill border px-2.5 py-1 text-[11px] font-semibold capitalize ${tone}`}>
      {status}
    </span>
  );
}

function rowKey(stylist: LabPinCredentialStatus): string {
  return `${stylist.userProfileId}:${stylist.locationId}`;
}

function replaceCredential(
  current: LabPinCredentialStatus[],
  updated: LabPinCredentialStatus,
): LabPinCredentialStatus[] {
  return current.map((item) => (rowKey(item) === rowKey(updated) ? updated : item));
}

function formatDate(value: string): string {
  return new Date(value).toLocaleDateString([], { day: '2-digit', month: 'short', year: 'numeric' });
}

function formatRelative(value: string): string {
  const then = new Date(value).getTime();
  const diffMs = Date.now() - then;
  if (Number.isNaN(then)) return 'Unknown';
  const minutes = Math.round(diffMs / 60000);
  if (minutes < 1) return 'Just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} hr ago`;
  const days = Math.round(hours / 24);
  if (days < 7) return `${days} day${days === 1 ? '' : 's'} ago`;
  return formatDate(value);
}

function formatMoney(cents: number, currencyCode: string): string {
  return new Intl.NumberFormat('en-GB', {
    style: 'currency',
    currency: currencyCode || 'GBP',
    maximumFractionDigits: 0,
  }).format(cents / 100);
}

function locationName(locations: Array<{ id: string; name: string }>, locationId: string): string {
  return locations.find((location) => location.id === locationId)?.name ?? 'selected location';
}
