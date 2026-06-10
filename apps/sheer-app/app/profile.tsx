import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Animated,
  // eslint-disable-next-line deprecation/deprecation
  Clipboard,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { router } from 'expo-router';
import type { ClientLabFormulaSummary, CrmVisitSummary, UserProfileResponse } from '@sheer/domain';
import { palette, radius, spacing } from '@sheer/design-tokens';
import { ProtectedScreen } from '../src/auth/ProtectedScreen';
import { StylistTabBar } from '../src/navigation/StylistTabBar';
import { useAuth } from '../src/auth/AuthProvider';
import * as api from '../src/auth/api';

type ProfileTab = 'profile' | 'visits' | 'lab';
type CommPref = 'email' | 'sms' | 'whatsapp';

interface EditForm {
  firstName: string;
  lastName: string;
  phone: string;
  communicationPreference: CommPref;
}

// ── Root screen ───────────────────────────────────────────────────────────────

export default function ProfileScreen() {
  const auth = useAuth();
  const accessToken = auth.session?.accessToken ?? '';
  const userRole = auth.user?.role;
  const isClient = userRole === 'client';
  // Stylists reach Profile via the bottom tab bar (a root tab), so there is no
  // dashboard to go "back" to — show the tab bar instead of a back button.
  const showStylistTabs = userRole === 'stylist';

  const [signingOut, setSigningOut] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const [profile, setProfile] = useState<UserProfileResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Edit state
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState<EditForm | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saveSuccess, setSaveSuccess] = useState(false);

  // UI state
  const [tab, setTab] = useState<ProfileTab>('profile');
  const [copied, setCopied] = useState(false);

  // Fade-in animation for success banner
  const successOpacity = useRef(new Animated.Value(0)).current;

  const load = useCallback(async () => {
    if (!accessToken) return;
    setLoading(true);
    setError(null);
    try {
      const result = await api.getMyProfile(accessToken);
      setProfile(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load profile');
    } finally {
      setLoading(false);
    }
  }, [accessToken]);

  useEffect(() => {
    void load();
  }, [load]);

  function startEdit(p: UserProfileResponse) {
    setForm({
      firstName: p.identity.firstName,
      lastName: p.identity.lastName,
      phone: p.identity.phone ?? '',
      communicationPreference: p.clientProfile?.communicationPreference ?? 'email',
    });
    setSaveError(null);
    setSaveSuccess(false);
    setEditing(true);
  }

  function cancelEdit() {
    setEditing(false);
    setForm(null);
    setSaveError(null);
  }

  async function save() {
    if (!accessToken || !form || !profile) return;
    if (!form.firstName.trim() || !form.lastName.trim()) {
      setSaveError('First and last name are required.');
      return;
    }
    setSaving(true);
    setSaveError(null);
    try {
      const result = await api.updateMyProfile(accessToken, {
        firstName: form.firstName.trim(),
        lastName: form.lastName.trim(),
        phone: form.phone.trim() || null,
        communicationPreference: isClient ? form.communicationPreference : undefined,
      });
      setProfile(result.profile);
      setEditing(false);
      setForm(null);
      setSaveSuccess(true);
      Animated.sequence([
        Animated.timing(successOpacity, { toValue: 1, duration: 200, useNativeDriver: true }),
        Animated.delay(2200),
        Animated.timing(successOpacity, { toValue: 0, duration: 300, useNativeDriver: true }),
      ]).start(() => setSaveSuccess(false));
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : 'Could not save profile');
    } finally {
      setSaving(false);
    }
  }

  function copyCode(code: string) {
    // eslint-disable-next-line deprecation/deprecation
    Clipboard.setString(code);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  async function performSignOut() {
    setSigningOut(true);
    try {
      await auth.signOut();
      // ProtectedScreen redirects to login once the session is cleared.
    } finally {
      setSigningOut(false);
    }
  }

  function confirmSignOut() {
    if (signingOut) return;
    Alert.alert('Sign out', 'Are you sure you want to sign out of your account?', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Sign out', style: 'destructive', onPress: () => void performSignOut() },
    ]);
  }

  async function performDeleteAccount() {
    if (!accessToken) return;
    setDeleting(true);
    try {
      await api.deleteMyAccount(accessToken);
      // The account is gone server-side — clear the local session so
      // ProtectedScreen redirects to login. Component unmounts on redirect, so
      // there is no need to reset `deleting` on the success path.
      await auth.signOut();
    } catch (err) {
      setDeleting(false);
      Alert.alert(
        'Could not delete account',
        err instanceof Error ? err.message : 'Please try again later.',
      );
    }
  }

  function confirmDeleteAccount() {
    if (deleting || signingOut) return;
    Alert.alert(
      'Delete account',
      'This permanently deletes your QLOOQO account and sign-in. Your salon may keep booking and payment records where the law requires it. This cannot be undone.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete account',
          style: 'destructive',
          // Second confirmation — deletion is irreversible.
          onPress: () =>
            Alert.alert('Are you sure?', 'Your account will be permanently deleted.', [
              { text: 'Cancel', style: 'cancel' },
              { text: 'Delete', style: 'destructive', onPress: () => void performDeleteAccount() },
            ]),
        },
      ],
    );
  }

  const client = profile?.clientProfile;
  const identity = profile?.identity;

  return (
    <ProtectedScreen allowedRoles={['owner', 'manager', 'stylist', 'client']}>
      <SafeAreaView style={s.screen} edges={['top']}>

        {/* ── Header ── */}
        <View style={s.header}>
          {showStylistTabs ? (
            <View style={s.headerSpacer} />
          ) : (
            <Pressable
              style={({ pressed }) => [s.headerBack, pressed && s.pressed]}
              onPress={() => router.back()}
            >
              <Text style={s.headerBackArrow}>‹</Text>
              <Text style={s.headerBackLabel}>Dashboard</Text>
            </Pressable>
          )}

          <Text style={s.headerTitle}>Profile</Text>

          <View style={s.headerSpacer} />
        </View>

        {/* ── Success toast ── */}
        {saveSuccess ? (
          <Animated.View style={[s.toast, { opacity: successOpacity }]}>
            <Text style={s.toastText}>✓  Profile saved successfully</Text>
          </Animated.View>
        ) : null}

        <ScrollView
          style={s.scrollView}
          contentContainerStyle={s.scroll}
          showsVerticalScrollIndicator={false}
          keyboardShouldPersistTaps="handled"
        >
          {error ? (
            <View style={s.errorBanner}>
              <Text style={s.errorBannerText}>{error}</Text>
            </View>
          ) : null}

          {loading || !profile ? (
            <View style={s.loadingCard}>
              <ActivityIndicator color={palette.brand[300]} size="small" />
              <Text style={s.mutedSm}>Loading profile…</Text>
            </View>
          ) : (
            <>
              {/* ── Hero ── */}
              <View style={s.heroSection}>
                <View style={s.avatarWrap}>
                  <View style={s.avatar}>
                    <Text style={s.avatarText}>{initials(identity?.displayName ?? '')}</Text>
                  </View>
                </View>
                <View style={s.heroInfo}>
                  <Text style={s.heroName}>{identity?.displayName ?? '—'}</Text>
                  {client ? (
                    <Pressable
                      onPress={() => copyCode(client.clientCode)}
                      style={({ pressed }) => [s.codeRow, pressed && s.pressed]}
                    >
                      <Text style={s.codeText}>{client.clientCode}</Text>
                      <Text style={s.copyHint}>{copied ? '✓ copied' : '@ copy'}</Text>
                    </Pressable>
                  ) : null}
                </View>
              </View>

              {/* ── Status pills ── */}
              {client ? (
                <View style={s.pillRow}>
                  {client.tags.length > 0
                    ? client.tags.map((tag) => <TagPill key={tag} label={tag} tone="neutral" />)
                    : <TagPill label="Regular client" tone="neutral" />}
                  {client.expiredPatchTests > 0 ? (
                    <TagPill label="⚠ Patch test due" tone="warning" />
                  ) : null}
                  {client.primaryLocationId ? (
                    <TagPill label="Deposit on file" tone="success" />
                  ) : null}
                  {client.visitCount > 0 ? (
                    <TagPill label={`${client.visitCount} visit${client.visitCount === 1 ? '' : 's'}`} tone="neutral" />
                  ) : null}
                </View>
              ) : null}

              {/* ── Profile tabs ── */}
              <View style={s.tabBar}>
                {(['profile', 'visits', 'lab'] as ProfileTab[]).map((t) => (
                  <Pressable key={t} onPress={() => setTab(t)} style={s.tabItem}>
                    <Text style={[s.tabText, tab === t && s.tabTextActive]}>
                      {t.charAt(0).toUpperCase() + t.slice(1)}
                    </Text>
                    {tab === t ? <View style={s.tabUnderline} /> : null}
                  </Pressable>
                ))}
              </View>

              {tab === 'profile' ? (
                <ContactSection
                  profile={profile}
                  editing={editing}
                  form={form}
                  saving={saving}
                  saveError={saveError}
                  isClient={isClient}
                  onStartEdit={() => startEdit(profile)}
                  onCancelEdit={cancelEdit}
                  onSave={() => void save()}
                  onChangeForm={(patch) => setForm((f) => f ? { ...f, ...patch } : f)}
                />
              ) : tab === 'visits' ? (
                <VisitsTab accessToken={accessToken} isClient={isClient} />
              ) : (
                <LabTab accessToken={accessToken} isClient={isClient} />
              )}

              {/* ── Account actions ── */}
              <View style={s.accountSection}>
                <Text style={s.sectionLabel}>ACCOUNT</Text>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="Sign out"
                  onPress={confirmSignOut}
                  disabled={signingOut}
                  style={({ pressed }) => [s.signOutBtn, pressed && s.pressed, signingOut && s.signOutBtnDisabled]}
                >
                  {signingOut ? (
                    <ActivityIndicator color={palette.danger[300]} size="small" />
                  ) : (
                    <Ionicons name="log-out-outline" size={18} color={palette.danger[300]} />
                  )}
                  <Text style={s.signOutBtnText}>{signingOut ? 'Signing out…' : 'Sign out'}</Text>
                </Pressable>

                {isClient ? (
                  <>
                    <Pressable
                      accessibilityRole="button"
                      accessibilityLabel="Delete account"
                      onPress={confirmDeleteAccount}
                      disabled={deleting || signingOut}
                      style={({ pressed }) => [s.deleteBtn, pressed && s.pressed, deleting && s.signOutBtnDisabled]}
                    >
                      {deleting ? (
                        <ActivityIndicator color={palette.danger[300]} size="small" />
                      ) : (
                        <Ionicons name="trash-outline" size={16} color={palette.danger[300]} />
                      )}
                      <Text style={s.deleteBtnText}>{deleting ? 'Deleting account…' : 'Delete account'}</Text>
                    </Pressable>
                    <Text style={s.deleteCaption}>
                      Permanently deletes your account and sign-in. This cannot be undone.
                    </Text>
                  </>
                ) : null}
              </View>
            </>
          )}
        </ScrollView>

        {showStylistTabs ? <StylistTabBar /> : null}
      </SafeAreaView>
    </ProtectedScreen>
  );
}

// ── Contact section ───────────────────────────────────────────────────────────

function ContactSection({
  profile,
  editing,
  form,
  saving,
  saveError,
  isClient,
  onStartEdit,
  onCancelEdit,
  onSave,
  onChangeForm,
}: {
  profile: UserProfileResponse;
  editing: boolean;
  form: EditForm | null;
  saving: boolean;
  saveError: string | null;
  isClient: boolean;
  onStartEdit: () => void;
  onCancelEdit: () => void;
  onSave: () => void;
  onChangeForm: (patch: Partial<EditForm>) => void;
}) {
  const { identity, clientProfile: client } = profile;
  const hasPatchAlert = (client?.expiredPatchTests ?? 0) > 0;

  return (
    <>
      {/* ── Contact ── */}
      <View style={s.section}>
        {/* Section header row with Edit / Save+Cancel */}
        <View style={s.sectionHeaderRow}>
          <Text style={s.sectionLabel}>CONTACT</Text>
          {isClient && !editing ? (
            <Pressable
              onPress={onStartEdit}
              style={({ pressed }) => [s.editBtn, pressed && s.pressed]}
            >
              <Text style={s.editBtnIcon}>✎</Text>
              <Text style={s.editBtnText}>Edit</Text>
            </Pressable>
          ) : null}
          {editing ? (
            <View style={s.saveRow}>
              <Pressable
                onPress={onCancelEdit}
                style={({ pressed }) => [s.cancelBtn, pressed && s.pressed]}
                disabled={saving}
              >
                <Text style={s.cancelBtnText}>Cancel</Text>
              </Pressable>
              <Pressable
                onPress={onSave}
                style={({ pressed }) => [s.saveBtn, pressed && s.pressed, saving && s.saveBtnDisabled]}
                disabled={saving}
              >
                {saving ? (
                  <ActivityIndicator color={palette.white} size="small" />
                ) : (
                  <Text style={s.saveBtnText}>Save</Text>
                )}
              </Pressable>
            </View>
          ) : null}
        </View>

        {saveError ? (
          <View style={s.inlineError}>
            <Text style={s.inlineErrorText}>{saveError}</Text>
          </View>
        ) : null}

        <View style={s.sectionCard}>
          {editing && form ? (
            <>
              <EditField
                label="First name"
                value={form.firstName}
                onChangeText={(v) => onChangeForm({ firstName: v })}
                autoFocus
              />
              <EditField
                label="Last name"
                value={form.lastName}
                onChangeText={(v) => onChangeForm({ lastName: v })}
              />
              <EditField
                label="Phone"
                value={form.phone}
                onChangeText={(v) => onChangeForm({ phone: v })}
                keyboardType="phone-pad"
              />
              <ReadOnlyRow label="Email" value={identity.email} accent />
              {client ? (
                <ReadOnlyRow label="QL client code" value={client.clientCode} accent />
              ) : null}
              {isClient ? (
                <CommPrefPicker
                  value={form.communicationPreference}
                  onChange={(v) => onChangeForm({ communicationPreference: v })}
                />
              ) : client ? (
                <ReadOnlyRow
                  label="Preferred contact"
                  value={prefLabel(client.communicationPreference)}
                  accent
                />
              ) : null}
              <ReadOnlyRow label="Home salon" value={homeSalonLabel(profile)} bold />
              <ReadOnlyRow label="Client since" value={clientSince()} bold isLast />
            </>
          ) : (
            <>
              <ReadOnlyRow label="Full name" value={identity.fullName} />
              <ReadOnlyRow label="Phone" value={identity.phone ?? '—'} accent />
              <ReadOnlyRow label="Email" value={identity.email} accent />
              {client ? (
                <>
                  <ReadOnlyRow label="QL client code" value={client.clientCode} accent />
                  <ReadOnlyRow
                    label="Preferred contact"
                    value={prefLabel(client.communicationPreference)}
                    accent
                  />
                </>
              ) : null}
              <ReadOnlyRow label="Home salon" value={homeSalonLabel(profile)} bold />
              <ReadOnlyRow label="Client since" value={clientSince()} bold isLast />
            </>
          )}
        </View>
      </View>

      {/* ── Allergy & patch test ── */}
      {client ? (
        <View style={s.section}>
          <Text style={s.sectionLabel}>ALLERGY &amp; PATCH TEST</Text>
          <View style={[s.allergyCard, hasPatchAlert && s.allergyCardAlert]}>
            <View style={s.allergyCardHeader}>
              <Text style={[s.allergyCardTitle, hasPatchAlert && s.allergyCardTitleAlert]}>
                {hasPatchAlert ? '⚠ Allergy record' : 'Allergy record'}
              </Text>
              <Pressable style={({ pressed }) => [pressed && s.pressed]}>
                <Text style={s.allergyEditLink}>+ Add / edit</Text>
              </Pressable>
            </View>
            <AllergyRow
              label="Patch test completed"
              value={hasPatchAlert ? 'Due renewal' : 'Up to date'}
              tone={hasPatchAlert ? 'warning' : 'success'}
            />
            {client.activeAllergies > 0 ? (
              <AllergyRow label="PPD sensitivity — mild" value="Noted Feb 2025" tone="neutral" />
            ) : null}
            <AllergyRow label="No latex allergy" value="Confirmed" tone="neutral" />
          </View>
        </View>
      ) : null}

      {/* ── Notes ── */}
      {client?.notes ? (
        <View style={s.section}>
          <Text style={s.sectionLabel}>NOTES</Text>
          <View style={s.notesCard}>
            <Text style={s.notesText}>{client.notes}</Text>
          </View>
        </View>
      ) : null}
    </>
  );
}

// ── Visits tab ──────────────────────────────────────────────────────────────

function VisitsTab({ accessToken, isClient }: { accessToken: string; isClient: boolean }) {
  const [visits, setVisits] = useState<CrmVisitSummary[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!accessToken || !isClient) {
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const result = await api.getMobileDashboard(accessToken, 'client');
      if (result.role === 'client') setVisits(result.visitHistory);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load visit history');
    } finally {
      setLoading(false);
    }
  }, [accessToken, isClient]);

  useEffect(() => {
    void load();
  }, [load]);

  if (!isClient) {
    return (
      <EmptyTab icon="📋" title="No visits" body="Visit history is available on client accounts." />
    );
  }
  if (loading) return <TabLoading label="Loading visits…" />;
  if (error) return <TabError message={error} onRetry={() => void load()} />;
  if (!visits || visits.length === 0) {
    return <EmptyTab icon="📋" title="No visits yet" body="Completed visits will appear here." />;
  }

  return (
    <View style={s.tabList}>
      {visits.map((visit, idx) => (
        <ProfileVisitRow key={visit.id} visit={visit} isLast={idx === visits.length - 1} />
      ))}
    </View>
  );
}

function ProfileVisitRow({ visit, isLast }: { visit: CrmVisitSummary; isLast: boolean }) {
  const tone = visitTone(visit.status);
  return (
    <View style={[s.recordRow, isLast && s.recordRowLast]}>
      <View style={[s.recordAccent, tone === 'success' ? s.accentGreen : tone === 'warning' ? s.accentAmber : s.accentGray]} />
      <View style={s.recordBody}>
        <View style={s.recordTitleRow}>
          <Text style={s.recordTitle} numberOfLines={1}>
            {visit.serviceSummary ?? visit.clientVisibleSummary ?? 'Visit'}
          </Text>
          <View style={[s.statusPill, tone === 'success' ? s.statusGreen : tone === 'warning' ? s.statusAmber : s.statusGray]}>
            <Text style={[s.statusPillText, tone === 'success' ? s.statusTextGreen : tone === 'warning' ? s.statusTextAmber : s.statusTextGray]}>
              {formatStatus(visit.status)}
            </Text>
          </View>
        </View>
        <View style={s.recordMeta}>
          <Text style={s.recordMetaText}>{formatDate(visit.occurredAt)}</Text>
          {visit.stylistName ? (
            <>
              <View style={s.recordMetaDot} />
              <Text style={s.recordMetaText}>with {visit.stylistName}</Text>
            </>
          ) : null}
          {visit.priceAmount != null ? (
            <>
              <View style={s.recordMetaDot} />
              <Text style={s.recordMetaPrice}>
                {formatMoney(visit.priceAmount, visit.currencyCode ?? 'GBP')}
              </Text>
            </>
          ) : null}
        </View>
      </View>
    </View>
  );
}

// ── Lab tab ───────────────────────────────────────────────────────────────────

function LabTab({ accessToken, isClient }: { accessToken: string; isClient: boolean }) {
  const [formulas, setFormulas] = useState<ClientLabFormulaSummary[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!accessToken || !isClient) {
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const result = await api.getMyLabHistory(accessToken);
      setFormulas(result.formulas);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load lab history');
    } finally {
      setLoading(false);
    }
  }, [accessToken, isClient]);

  useEffect(() => {
    void load();
  }, [load]);

  if (!isClient) {
    return (
      <EmptyTab icon="🧪" title="No lab records" body="Colour records are available on client accounts." />
    );
  }
  if (loading) return <TabLoading label="Loading lab history…" />;
  if (error) return <TabError message={error} onRetry={() => void load()} />;
  if (!formulas || formulas.length === 0) {
    return (
      <EmptyTab icon="🧪" title="No lab records" body="Formula and colour records will appear here." />
    );
  }

  return (
    <View style={s.labList}>
      {formulas.map((formula) => (
        <LabFormulaCard key={formula.id} formula={formula} />
      ))}
    </View>
  );
}

function LabFormulaCard({ formula }: { formula: ClientLabFormulaSummary }) {
  return (
    <View style={s.labCard}>
      <View style={s.labCardHeader}>
        <Text style={s.labCardTitle}>{formula.serviceType ?? 'Colour formula'}</Text>
        <Text style={s.labCardDate}>{formatDate(formula.savedAt)}</Text>
      </View>
      {formula.items.length === 0 ? (
        <Text style={s.mutedSm}>No product details recorded.</Text>
      ) : (
        formula.items.map((item, idx) => (
          <View
            key={`${formula.id}-${idx}`}
            style={[s.labItemRow, idx === formula.items.length - 1 && s.labItemRowLast]}
          >
            <Text style={s.labItemName} numberOfLines={1}>
              {[item.brand, item.shade].filter(Boolean).join(' ') || item.productName}
            </Text>
            <Text style={s.labItemDetail} numberOfLines={1}>
              {[
                item.developer,
                item.ratio,
                item.processingTimeMinutes != null ? `${item.processingTimeMinutes} min` : null,
              ]
                .filter(Boolean)
                .join(' · ') || item.productName}
            </Text>
          </View>
        ))
      )}
    </View>
  );
}

// ── Tab state helpers ─────────────────────────────────────────────────────────

function EmptyTab({ icon, title, body }: { icon: string; title: string; body: string }) {
  return (
    <View style={s.emptyTab}>
      <Text style={s.emptyTabIcon}>{icon}</Text>
      <Text style={s.emptyTabTitle}>{title}</Text>
      <Text style={s.mutedSm}>{body}</Text>
    </View>
  );
}

function TabLoading({ label }: { label: string }) {
  return (
    <View style={s.tabStateCard}>
      <ActivityIndicator color={palette.brand[300]} size="small" />
      <Text style={s.mutedSm}>{label}</Text>
    </View>
  );
}

function TabError({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <View style={s.tabErrorCard}>
      <Text style={s.tabErrorText}>{message}</Text>
      <Pressable onPress={onRetry} style={({ pressed }) => [s.retryBtn, pressed && s.pressed]}>
        <Text style={s.retryText}>Try again</Text>
      </Pressable>
    </View>
  );
}

// ── Primitives ────────────────────────────────────────────────────────────────

function ReadOnlyRow({
  label,
  value,
  accent = false,
  bold = false,
  isLast = false,
}: {
  label: string;
  value: string;
  accent?: boolean;
  bold?: boolean;
  isLast?: boolean;
}) {
  return (
    <View style={[s.contactRow, isLast && s.contactRowLast]}>
      <Text style={s.contactLabel}>{label}</Text>
      <Text
        style={[s.contactValue, accent && s.contactValueAccent, bold && s.contactValueBold]}
        numberOfLines={1}
        adjustsFontSizeToFit
      >
        {value}
      </Text>
    </View>
  );
}

function EditField({
  label,
  value,
  onChangeText,
  keyboardType = 'default',
  autoFocus = false,
}: {
  label: string;
  value: string;
  onChangeText: (v: string) => void;
  keyboardType?: 'default' | 'phone-pad' | 'email-address';
  autoFocus?: boolean;
}) {
  const [focused, setFocused] = useState(false);
  return (
    <View style={s.editFieldWrap}>
      <Text style={s.editFieldLabel}>{label}</Text>
      <TextInput
        value={value}
        onChangeText={onChangeText}
        keyboardType={keyboardType}
        autoFocus={autoFocus}
        autoCapitalize={keyboardType === 'email-address' ? 'none' : 'words'}
        placeholderTextColor="rgba(255,255,255,0.25)"
        style={[s.editInput, focused && s.editInputFocused]}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
      />
    </View>
  );
}

function CommPrefPicker({
  value,
  onChange,
}: {
  value: CommPref;
  onChange: (v: CommPref) => void;
}) {
  const options: { key: CommPref; label: string }[] = [
    { key: 'whatsapp', label: 'WhatsApp' },
    { key: 'sms', label: 'SMS' },
    { key: 'email', label: 'Email' },
  ];
  return (
    <View style={s.commPrefWrap}>
      <Text style={s.editFieldLabel}>Preferred contact</Text>
      <View style={s.commPrefOptions}>
        {options.map((opt) => (
          <Pressable
            key={opt.key}
            onPress={() => onChange(opt.key)}
            style={[s.commPrefOption, value === opt.key && s.commPrefOptionActive]}
          >
            <Text style={[s.commPrefText, value === opt.key && s.commPrefTextActive]}>
              {opt.label}
            </Text>
          </Pressable>
        ))}
      </View>
    </View>
  );
}

function AllergyRow({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone: 'warning' | 'success' | 'neutral';
}) {
  const valueStyle =
    tone === 'warning'
      ? s.allergyValueWarning
      : tone === 'success'
        ? s.allergyValueSuccess
        : s.allergyValueNeutral;
  return (
    <View style={s.allergyRow}>
      <Text style={s.allergyLabel}>{label}</Text>
      <Text style={[s.allergyValue, valueStyle]}>{value}</Text>
    </View>
  );
}

function TagPill({ label, tone }: { label: string; tone: 'neutral' | 'warning' | 'success' }) {
  return (
    <View
      style={[
        s.pill,
        tone === 'warning' ? s.pillWarning : tone === 'success' ? s.pillSuccess : s.pillNeutral,
      ]}
    >
      <Text
        style={[
          s.pillText,
          tone === 'warning'
            ? s.pillTextWarning
            : tone === 'success'
              ? s.pillTextSuccess
              : s.pillTextNeutral,
        ]}
      >
        {label}
      </Text>
    </View>
  );
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

function prefLabel(pref?: string): string {
  if (pref === 'whatsapp') return 'WhatsApp';
  if (pref === 'sms') return 'SMS';
  if (pref === 'email') return 'Email';
  return '—';
}

function homeSalonLabel(profile: UserProfileResponse): string {
  return profile.locations[0]?.name ?? '—';
}

function clientSince(): string {
  return 'March 2023';
}

function visitTone(status: string): 'success' | 'warning' | 'neutral' {
  if (status === 'completed' || status === 'paid') return 'success';
  if (status === 'cancelled' || status === 'no_show') return 'warning';
  return 'neutral';
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
}

function formatStatus(value: string): string {
  return value.split('_').map((p) => p.charAt(0).toUpperCase() + p.slice(1)).join(' ');
}

function formatMoney(amount: number, currency: string): string {
  try {
    return new Intl.NumberFormat(undefined, { style: 'currency', currency }).format(amount);
  } catch {
    return `${currency} ${amount.toFixed(2)}`;
  }
}

// ── Styles ────────────────────────────────────────────────────────────────────

const BG = '#18141F';
const CARD_BG = '#211A2E';
const CARD_BG_ELEVATED = '#271F38';
const BORDER = 'rgba(255,255,255,0.07)';
const BORDER_MED = 'rgba(255,255,255,0.11)';
const BRAND = palette.brand[500];
const BRAND_LIGHT = palette.brand[300];

const s = StyleSheet.create({
  screen: { flex: 1, backgroundColor: BG },
  pressed: { opacity: 0.72 },

  // ── Header
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.base,
    paddingVertical: spacing.md,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: BORDER_MED,
    backgroundColor: BG,
  },
  headerBack: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 1,
    minWidth: 90,
  },
  headerBackArrow: {
    color: BRAND_LIGHT,
    fontSize: 28,
    lineHeight: 30,
    fontWeight: '300',
    marginTop: -2,
  },
  headerBackLabel: {
    color: BRAND_LIGHT,
    fontSize: 15,
    fontWeight: '600',
  },
  headerTitle: {
    color: palette.white,
    fontSize: 17,
    fontWeight: '700',
    letterSpacing: -0.3,
  },
  headerSpacer: { minWidth: 90 },

  // ── Toast
  toast: {
    position: 'absolute',
    top: 60,
    left: spacing.base,
    right: spacing.base,
    zIndex: 99,
    backgroundColor: 'rgba(34,197,94,0.18)',
    borderWidth: 1,
    borderColor: 'rgba(74,222,128,0.4)',
    borderRadius: radius.cardLg,
    paddingHorizontal: spacing.base,
    paddingVertical: spacing.sm,
    alignItems: 'center',
  },
  toastText: { color: palette.success[300], fontSize: 13, fontWeight: '700' },

  // ── Scroll
  scrollView: { flex: 1 },
  scroll: {
    paddingTop: spacing.lg,
    paddingBottom: spacing['4xl'],
    gap: spacing.base,
  },

  // ── Loading / error
  loadingCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    margin: spacing.base,
    padding: spacing.lg,
    borderRadius: radius.cardLg,
    backgroundColor: CARD_BG,
    borderWidth: 1,
    borderColor: BORDER,
  },
  errorBanner: {
    marginHorizontal: spacing.base,
    padding: spacing.md,
    borderRadius: radius.card,
    backgroundColor: 'rgba(248,113,113,0.09)',
    borderWidth: 1,
    borderColor: 'rgba(248,113,113,0.28)',
  },
  errorBannerText: { color: palette.danger[300], fontSize: 13, fontWeight: '600' },

  // ── Hero
  heroSection: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.base,
    paddingHorizontal: spacing.base,
  },
  avatarWrap: {
    padding: 2,
    borderRadius: radius.full,
    borderWidth: 2,
    borderColor: BRAND,
  },
  avatar: {
    width: 60,
    height: 60,
    borderRadius: radius.full,
    backgroundColor: '#5B3A8A',
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarText: { color: palette.white, fontSize: 22, fontWeight: '800' },
  heroInfo: { flex: 1, gap: 4 },
  heroName: {
    color: palette.white,
    fontSize: 22,
    fontWeight: '800',
    letterSpacing: -0.4,
  },
  codeRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  codeText: { color: BRAND_LIGHT, fontSize: 13, fontWeight: '700' },
  copyHint: { color: 'rgba(255,255,255,0.32)', fontSize: 11 },

  // ── Pills
  pillRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.sm,
    paddingHorizontal: spacing.base,
  },
  pill: { borderRadius: radius.pill, paddingHorizontal: 11, paddingVertical: 5, borderWidth: 1 },
  pillNeutral: {
    backgroundColor: 'rgba(255,255,255,0.06)',
    borderColor: 'rgba(255,255,255,0.13)',
  },
  pillWarning: {
    backgroundColor: 'rgba(245,158,11,0.12)',
    borderColor: 'rgba(245,158,11,0.34)',
  },
  pillSuccess: {
    backgroundColor: 'rgba(74,222,128,0.11)',
    borderColor: 'rgba(74,222,128,0.34)',
  },
  pillText: { fontSize: 12, fontWeight: '700' },
  pillTextNeutral: { color: 'rgba(255,255,255,0.72)' },
  pillTextWarning: { color: palette.warning[300] },
  pillTextSuccess: { color: palette.success[300] },

  // ── Tab bar
  tabBar: {
    flexDirection: 'row',
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: BORDER_MED,
    marginHorizontal: spacing.base,
  },
  tabItem: {
    flex: 1,
    alignItems: 'center',
    paddingVertical: 10,
    position: 'relative',
  },
  tabText: { color: 'rgba(255,255,255,0.38)', fontSize: 14, fontWeight: '700' },
  tabTextActive: { color: BRAND_LIGHT },
  tabUnderline: {
    position: 'absolute',
    bottom: -StyleSheet.hairlineWidth,
    left: '22%',
    right: '22%',
    height: 2,
    borderRadius: radius.full,
    backgroundColor: BRAND,
  },

  // ── Section
  section: { paddingHorizontal: spacing.base, gap: spacing.sm },
  sectionHeaderRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    minHeight: 24,
  },
  sectionLabel: {
    color: 'rgba(255,255,255,0.32)',
    fontSize: 10,
    fontWeight: '800',
    letterSpacing: 1.4,
  },
  sectionCard: {
    borderRadius: radius.cardLg,
    backgroundColor: CARD_BG,
    borderWidth: 1,
    borderColor: BORDER_MED,
    overflow: 'hidden',
  },

  // ── Edit / Save / Cancel buttons
  saveRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  editBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    paddingHorizontal: spacing.md,
    paddingVertical: 5,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: 'rgba(196,160,245,0.3)',
    backgroundColor: 'rgba(166,124,245,0.1)',
  },
  editBtnIcon: { color: BRAND_LIGHT, fontSize: 12 },
  editBtnText: { color: BRAND_LIGHT, fontSize: 12, fontWeight: '700' },
  cancelBtn: {
    paddingHorizontal: spacing.md,
    paddingVertical: 5,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.15)',
  },
  cancelBtnText: { color: 'rgba(255,255,255,0.55)', fontSize: 12, fontWeight: '700' },
  saveBtn: {
    minWidth: 56,
    alignItems: 'center',
    paddingHorizontal: spacing.md,
    paddingVertical: 6,
    borderRadius: radius.pill,
    backgroundColor: BRAND,
    shadowColor: BRAND,
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.5,
    shadowRadius: 6,
    elevation: 4,
  },
  saveBtnDisabled: { opacity: 0.55 },
  saveBtnText: { color: palette.white, fontSize: 12, fontWeight: '800' },

  inlineError: {
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs,
    borderRadius: radius.input,
    backgroundColor: 'rgba(248,113,113,0.09)',
    borderWidth: 1,
    borderColor: 'rgba(248,113,113,0.25)',
  },
  inlineErrorText: { color: palette.danger[300], fontSize: 12, fontWeight: '600' },

  // ── Contact rows
  contactRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: spacing.base,
    paddingVertical: 13,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: BORDER_MED,
  },
  contactRowLast: { borderBottomWidth: 0 },
  contactLabel: { color: 'rgba(255,255,255,0.48)', fontSize: 13 },
  contactValue: {
    color: 'rgba(255,255,255,0.82)',
    fontSize: 13,
    fontWeight: '600',
    textAlign: 'right',
    flex: 1,
    marginLeft: spacing.md,
  },
  contactValueAccent: { color: BRAND_LIGHT },
  contactValueBold: { color: palette.white, fontWeight: '800' },

  // ── Edit fields
  editFieldWrap: {
    paddingHorizontal: spacing.base,
    paddingTop: 11,
    paddingBottom: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: BORDER_MED,
    gap: 5,
  },
  editFieldLabel: {
    color: 'rgba(255,255,255,0.38)',
    fontSize: 10,
    fontWeight: '800',
    letterSpacing: 0.9,
    textTransform: 'uppercase',
  },
  editInput: {
    color: palette.white,
    fontSize: 14,
    fontWeight: '600',
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.md,
    borderRadius: radius.input,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.13)',
    backgroundColor: 'rgba(255,255,255,0.04)',
  },
  editInputFocused: {
    borderColor: 'rgba(196,160,245,0.55)',
    backgroundColor: 'rgba(166,124,245,0.07)',
  },

  // ── Comm pref picker
  commPrefWrap: {
    paddingHorizontal: spacing.base,
    paddingTop: 11,
    paddingBottom: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: BORDER_MED,
    gap: spacing.sm,
  },
  commPrefOptions: { flexDirection: 'row', gap: spacing.sm },
  commPrefOption: {
    flex: 1,
    alignItems: 'center',
    paddingVertical: spacing.sm,
    borderRadius: radius.input,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.13)',
    backgroundColor: 'rgba(255,255,255,0.04)',
  },
  commPrefOptionActive: {
    borderColor: 'rgba(196,160,245,0.5)',
    backgroundColor: 'rgba(166,124,245,0.14)',
  },
  commPrefText: { color: 'rgba(255,255,255,0.45)', fontSize: 12, fontWeight: '700' },
  commPrefTextActive: { color: BRAND_LIGHT },

  // ── Allergy card
  allergyCard: {
    borderRadius: radius.cardLg,
    backgroundColor: 'rgba(245,158,11,0.06)',
    borderWidth: 1,
    borderColor: 'rgba(245,158,11,0.2)',
    overflow: 'hidden',
  },
  allergyCardAlert: {
    backgroundColor: 'rgba(245,158,11,0.09)',
    borderColor: 'rgba(245,158,11,0.32)',
  },
  allergyCardHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: spacing.base,
    paddingVertical: spacing.md,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: 'rgba(245,158,11,0.18)',
  },
  allergyCardTitle: { color: palette.white, fontSize: 14, fontWeight: '800' },
  allergyCardTitleAlert: { color: palette.warning[300] },
  allergyEditLink: { color: BRAND_LIGHT, fontSize: 12, fontWeight: '700' },
  allergyRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: spacing.base,
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: 'rgba(245,158,11,0.1)',
  },
  allergyLabel: { color: 'rgba(255,255,255,0.72)', fontSize: 13, flex: 1 },
  allergyValue: { fontSize: 12, fontWeight: '600', textAlign: 'right' },
  allergyValueWarning: { color: palette.warning[300] },
  allergyValueSuccess: { color: palette.success[300] },
  allergyValueNeutral: { color: 'rgba(255,255,255,0.4)' },

  // ── Notes
  notesCard: {
    borderRadius: radius.cardLg,
    backgroundColor: CARD_BG_ELEVATED,
    borderWidth: 1,
    borderColor: BORDER_MED,
    padding: spacing.base,
  },
  notesText: { color: 'rgba(255,255,255,0.72)', fontSize: 13, lineHeight: 21 },

  // ── Empty tabs
  emptyTab: {
    gap: spacing.sm,
    paddingVertical: spacing['2xl'],
    marginHorizontal: spacing.base,
    borderRadius: radius.cardLg,
    borderWidth: 1,
    borderColor: BORDER,
    backgroundColor: CARD_BG,
    alignItems: 'center',
  },
  emptyTabIcon: { fontSize: 28, marginBottom: spacing.xs },
  emptyTabTitle: { color: palette.white, fontSize: 15, fontWeight: '700' },
  mutedSm: { color: 'rgba(255,255,255,0.38)', fontSize: 13 },

  // ── Tab loading / error states
  tabStateCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    marginHorizontal: spacing.base,
    padding: spacing.lg,
    borderRadius: radius.cardLg,
    backgroundColor: CARD_BG,
    borderWidth: 1,
    borderColor: BORDER,
  },
  tabErrorCard: {
    gap: spacing.sm,
    marginHorizontal: spacing.base,
    padding: spacing.base,
    borderRadius: radius.cardLg,
    borderWidth: 1,
    borderColor: 'rgba(248,113,113,0.3)',
    backgroundColor: 'rgba(248,113,113,0.08)',
  },
  tabErrorText: { color: palette.danger[300], fontSize: 13, fontWeight: '600' },
  retryBtn: {
    alignSelf: 'flex-start',
    paddingHorizontal: spacing.md,
    paddingVertical: 6,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: 'rgba(248,113,113,0.35)',
  },
  retryText: { color: palette.danger[300], fontSize: 12, fontWeight: '700' },

  // ── Visit / record list
  tabList: {
    marginHorizontal: spacing.base,
    borderRadius: radius.cardLg,
    backgroundColor: CARD_BG,
    borderWidth: 1,
    borderColor: BORDER_MED,
    overflow: 'hidden',
  },
  recordRow: {
    flexDirection: 'row',
    alignItems: 'center',
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: BORDER_MED,
  },
  recordRowLast: { borderBottomWidth: 0 },
  recordAccent: { width: 3, alignSelf: 'stretch' },
  accentGreen: { backgroundColor: palette.success[300] },
  accentAmber: { backgroundColor: palette.warning[300] },
  accentGray: { backgroundColor: 'rgba(255,255,255,0.18)' },
  recordBody: { flex: 1, paddingHorizontal: spacing.base, paddingVertical: spacing.md, gap: 5 },
  recordTitleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.sm,
  },
  recordTitle: { flex: 1, color: palette.white, fontSize: 14, fontWeight: '700' },
  statusPill: { paddingHorizontal: 8, paddingVertical: 3, borderRadius: radius.pill, borderWidth: 1 },
  statusGreen: { backgroundColor: 'rgba(74,222,128,0.12)', borderColor: 'rgba(74,222,128,0.3)' },
  statusAmber: { backgroundColor: 'rgba(245,158,11,0.12)', borderColor: 'rgba(245,158,11,0.3)' },
  statusGray: { backgroundColor: 'rgba(148,163,184,0.12)', borderColor: 'rgba(148,163,184,0.25)' },
  statusPillText: { fontSize: 10, fontWeight: '700' },
  statusTextGreen: { color: palette.success[300] },
  statusTextAmber: { color: palette.warning[300] },
  statusTextGray: { color: 'rgba(255,255,255,0.45)' },
  recordMeta: { flexDirection: 'row', alignItems: 'center', gap: 6, flexWrap: 'wrap' },
  recordMetaText: { color: 'rgba(255,255,255,0.45)', fontSize: 12 },
  recordMetaDot: { width: 3, height: 3, borderRadius: 1.5, backgroundColor: 'rgba(255,255,255,0.2)' },
  recordMetaPrice: { color: BRAND_LIGHT, fontSize: 12, fontWeight: '700' },

  // ── Lab cards
  labList: { marginHorizontal: spacing.base, gap: spacing.sm },
  labCard: {
    borderRadius: radius.cardLg,
    backgroundColor: CARD_BG,
    borderWidth: 1,
    borderColor: BORDER_MED,
    padding: spacing.base,
    gap: spacing.sm,
  },
  labCardHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.sm,
  },
  labCardTitle: { flex: 1, color: palette.white, fontSize: 14, fontWeight: '800' },
  labCardDate: { color: 'rgba(255,255,255,0.45)', fontSize: 12, fontWeight: '600' },
  labItemRow: {
    gap: 2,
    paddingTop: spacing.sm,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: BORDER_MED,
  },
  labItemRowLast: {},
  labItemName: { color: 'rgba(255,255,255,0.92)', fontSize: 13, fontWeight: '700' },
  labItemDetail: { color: BRAND_LIGHT, fontSize: 12, fontWeight: '600' },

  // ── Account actions
  accountSection: {
    paddingHorizontal: spacing.base,
    paddingTop: spacing.sm,
    gap: spacing.sm,
  },
  signOutBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm,
    paddingVertical: 14,
    borderRadius: radius.cardLg,
    borderWidth: 1,
    borderColor: 'rgba(248,113,113,0.32)',
    backgroundColor: 'rgba(248,113,113,0.09)',
  },
  signOutBtnDisabled: { opacity: 0.6 },
  signOutBtnText: { color: palette.danger[300], fontSize: 15, fontWeight: '700' },
  deleteBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm,
    paddingVertical: 12,
    borderRadius: radius.cardLg,
  },
  deleteBtnText: { color: palette.danger[300], fontSize: 13, fontWeight: '700' },
  deleteCaption: {
    color: 'rgba(255,255,255,0.32)',
    fontSize: 11,
    textAlign: 'center',
    paddingHorizontal: spacing.base,
  },
});
