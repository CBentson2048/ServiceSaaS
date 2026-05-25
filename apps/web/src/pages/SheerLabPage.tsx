import { useCallback, useEffect, useMemo, useState } from 'react';
import { Navigate } from 'react-router-dom';
import type { LabDeviceRegistrationResponse, LabPinCredentialStatus } from '@sheer/domain';
import { ApiRequestError, listLabPinStatuses, registerLabDevice, resetLabPin, setLabPin } from '../auth/api';
import { useAuth } from '../auth/AuthProvider';

export function SheerLabPage() {
  const auth = useAuth();
  const accessToken = auth.session?.accessToken;
  const [stylists, setStylists] = useState<LabPinCredentialStatus[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [actionMessage, setActionMessage] = useState<string | null>(null);
  const [locationFilter, setLocationFilter] = useState('all');
  const [pinInputs, setPinInputs] = useState<Record<string, string>>({});
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [deviceLocationId, setDeviceLocationId] = useState('');
  const [deviceName, setDeviceName] = useState('Sheer Lab iPad');
  const [stationLabel, setStationLabel] = useState('');
  const [registeredDevice, setRegisteredDevice] = useState<LabDeviceRegistrationResponse | null>(null);

  const reload = useCallback(async () => {
    if (!accessToken) return;
    setLoading(true);
    setError(null);
    try {
      const response = await listLabPinStatuses(accessToken);
      setStylists(Array.isArray(response.stylists) ? response.stylists : []);
    } catch (err: unknown) {
      if (err instanceof ApiRequestError) setError(err.message);
      else if (err instanceof Error) setError(err.message);
      else setError('Could not load Sheer Lab PIN status');
    } finally {
      setLoading(false);
    }
  }, [accessToken]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const locations = useMemo(() => {
    const byId = new Map<string, string>();
    stylists.forEach((stylist) => byId.set(stylist.locationId, stylist.locationName));
    return Array.from(byId.entries()).map(([id, name]) => ({ id, name }));
  }, [stylists]);

  const filteredStylists = useMemo(
    () =>
      locationFilter === 'all'
        ? stylists
        : stylists.filter((stylist) => stylist.locationId === locationFilter),
    [locationFilter, stylists],
  );

  useEffect(() => {
    if (!deviceLocationId && locations.length > 0) {
      setDeviceLocationId(locations[0].id);
    }
  }, [deviceLocationId, locations]);

  if (auth.status === 'authenticated' && auth.user?.role === 'stylist') {
    return <Navigate to="/unauthorized" replace />;
  }

  async function handleSetPin(stylist: LabPinCredentialStatus) {
    if (!accessToken) return;
    const key = rowKey(stylist);
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
        locationId: stylist.locationId,
        userProfileId: stylist.userProfileId,
        pin,
      });
      setStylists((current) => replaceCredential(current, result.credential));
      setPinInputs((current) => ({ ...current, [key]: '' }));
      setActionMessage(`PIN set for ${stylist.displayName}.`);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Could not set PIN');
    } finally {
      setBusyKey(null);
    }
  }

  async function handleResetPin(stylist: LabPinCredentialStatus) {
    if (!accessToken) return;
    const key = rowKey(stylist);
    setBusyKey(key);
    setError(null);
    setActionMessage(null);
    try {
      const result = await resetLabPin(accessToken, {
        locationId: stylist.locationId,
        userProfileId: stylist.userProfileId,
      });
      setStylists((current) => replaceCredential(current, result.credential));
      setActionMessage(`PIN reset for ${stylist.displayName}. Set a new PIN before their next Lab login.`);
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
        deviceName: deviceName.trim() || 'Sheer Lab iPad',
        stationLabel: stationLabel.trim() || undefined,
      });
      setRegisteredDevice(result);
      setActionMessage(
        `Registered ${result.device.deviceName} for ${locationName(locations, result.device.locationId)}. Enter the one-time token in the Sheer Lab app now.`,
      );
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Could not register Lab device');
    } finally {
      setBusyKey(null);
    }
  }

  return (
    <div className="mx-auto w-full max-w-6xl px-4 py-6 lg:px-8">
      <header className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="text-[22px] font-semibold leading-7 text-text-primary">Sheer Lab Access</h1>
          <p className="mt-1 text-[13px] text-text-secondary">
            Set and reset stylist PINs for the separate shared-device Sheer Lab app.
          </p>
        </div>
        <button
          type="button"
          className="inline-flex h-10 items-center justify-center rounded-pill border border-border-strong bg-surface px-5 text-[13px] font-semibold text-text-primary transition hover:bg-surface-alt"
          onClick={() => void reload()}
          disabled={loading}
        >
          Refresh
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

      <section className="mb-6 rounded-card-lg border border-border bg-surface">
        <header className="border-b border-border bg-surface-alt px-4 py-3">
          <div className="text-[12px] font-semibold uppercase tracking-[0.12em] text-text-secondary">
            Shared Lab devices
          </div>
          <div className="mt-1 text-[13px] text-text-secondary">
            Register shared iPads to a location. The token is shown once and should be entered directly in the Sheer Lab app.
          </div>
        </header>

        <div className="grid gap-4 px-4 py-4 lg:grid-cols-[1fr_1.2fr]">
          <div className="space-y-3">
            <label className="block text-[12px] font-semibold uppercase tracking-[0.08em] text-text-secondary">
              Location
              <select
                value={deviceLocationId}
                onChange={(event) => setDeviceLocationId(event.target.value)}
                className="mt-1 h-10 w-full rounded-input-lg border border-border-strong bg-surface px-3 text-[13px] font-normal normal-case tracking-normal text-text-primary outline-none focus:border-primary"
              >
                {locations.map((location) => (
                  <option key={location.id} value={location.id}>
                    {location.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="block text-[12px] font-semibold uppercase tracking-[0.08em] text-text-secondary">
              Device name
              <input
                value={deviceName}
                onChange={(event) => setDeviceName(event.target.value)}
                placeholder="Sheer Lab iPad"
                className="mt-1 h-10 w-full rounded-input-lg border border-border-strong bg-surface px-3 text-[13px] font-normal normal-case tracking-normal text-text-primary outline-none focus:border-primary"
              />
            </label>
            <label className="block text-[12px] font-semibold uppercase tracking-[0.08em] text-text-secondary">
              Station label
              <input
                value={stationLabel}
                onChange={(event) => setStationLabel(event.target.value)}
                placeholder="Optional, e.g. Colour bar"
                className="mt-1 h-10 w-full rounded-input-lg border border-border-strong bg-surface px-3 text-[13px] font-normal normal-case tracking-normal text-text-primary outline-none focus:border-primary"
              />
            </label>
            <button
              type="button"
              className="h-10 rounded-pill bg-primary px-5 text-[13px] font-semibold text-text-on-primary transition hover:bg-primary-deep disabled:opacity-50"
              onClick={() => void handleRegisterDevice()}
              disabled={busyKey === 'register-device' || !accessToken || !deviceLocationId}
            >
              Register iPad
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
                  Open the Sheer Lab app on the iPad, paste this token into Register this iPad, then tap Register device.
                  Do not store this token in notes or messages.
                </div>
              </>
            ) : (
              <div className="mt-2 text-[12px] text-text-secondary">
                Register a device to generate a secure session token. Existing token values are never shown again.
              </div>
            )}
          </div>
        </div>
      </section>

      <section className="rounded-card-lg border border-border bg-surface">
        <header className="flex flex-col gap-3 border-b border-border bg-surface-alt px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <div className="text-[12px] font-semibold uppercase tracking-[0.12em] text-text-secondary">
              Stylist PIN management
            </div>
            <div className="mt-1 text-[13px] text-text-secondary">
              PINs are stored hashed. Existing PIN values are never displayed.
            </div>
          </div>
          {auth.user?.role === 'owner' && locations.length > 1 ? (
            <select
              value={locationFilter}
              onChange={(event) => setLocationFilter(event.target.value)}
              className="h-9 rounded-input-lg border border-border-strong bg-surface px-3 text-[13px] outline-none focus:border-primary"
            >
              <option value="all">All locations</option>
              {locations.map((location) => (
                <option key={location.id} value={location.id}>
                  {location.name}
                </option>
              ))}
            </select>
          ) : null}
        </header>

        {loading ? (
          <div className="px-4 py-8 text-center text-[13px] text-text-secondary">Loading Lab access...</div>
        ) : filteredStylists.length === 0 ? (
          <div className="px-4 py-10 text-center">
            <div className="text-[14px] font-medium text-text-primary">No stylists available</div>
            <div className="mt-1 text-[13px] text-text-secondary">
              Invite active stylists before assigning Sheer Lab PINs.
            </div>
          </div>
        ) : (
          <table className="w-full text-left text-[13px]">
            <thead className="bg-surface-alt text-[11px] font-medium uppercase tracking-[0.08em] text-text-secondary">
              <tr>
                <th className="px-4 py-3">Stylist</th>
                <th className="px-4 py-3">Location</th>
                <th className="px-4 py-3">PIN status</th>
                <th className="px-4 py-3">Set / reset PIN</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {filteredStylists.map((stylist) => {
                const key = rowKey(stylist);
                const busy = busyKey === key;
                return (
                  <tr key={key}>
                    <td className="px-4 py-3">
                      <div className="font-medium text-text-primary">{stylist.displayName}</div>
                      <div className="text-[12px] text-text-secondary">{stylist.email}</div>
                    </td>
                    <td className="px-4 py-3 text-text-secondary">{stylist.locationName}</td>
                    <td className="px-4 py-3">
                      <StatusPill status={stylist.status} />
                      <div className="mt-1 text-[11px] text-text-secondary">
                        {stylist.lastRotatedAt
                          ? `Updated ${formatDate(stylist.lastRotatedAt)}`
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
                          onClick={() => void handleSetPin(stylist)}
                        >
                          {stylist.status === 'not_set' ? 'Set PIN' : 'Update PIN'}
                        </button>
                        <button
                          type="button"
                          className="h-9 rounded-pill border border-border-strong px-4 text-[12px] font-semibold text-text-secondary transition hover:bg-surface-alt disabled:opacity-50"
                          disabled={busy || stylist.status === 'not_set'}
                          onClick={() => void handleResetPin(stylist)}
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
        )}
      </section>
    </div>
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

function locationName(locations: Array<{ id: string; name: string }>, locationId: string): string {
  return locations.find((location) => location.id === locationId)?.name ?? 'selected location';
}
