import type {
  AbsenceMutationResponse,
  AcceptStaffInvitationRequest,
  AcceptStaffInvitationResponse,
  ApproveLeaveRequestRequest,
  BreakMutationResponse,
  BusinessSlugAvailabilityResponse,
  CreateAbsenceRequest,
  CreateAccountRequest,
  CreateBreakRequest,
  CreateCrmAllergyRecordRequest,
  CreateCrmClientNoteRequest,
  CreateCrmClientRequest,
  CreateCrmPatchTestRequest,
  CreateCrmVisitPhotoRequest,
  DashboardInventoryAlertsResponse,
  DashboardKpisResponse,
  DashboardStylistPerformanceResponse,
  DashboardTopServicesResponse,
  CreateLocationRequest,
  LabDeviceRegistrationResponse,
  InventoryProductResponse,
  InventoryStockMutationResponse,
  CreateShiftRequest,
  CreateStaffInvitationRequest,
  CrmClientDetailResponse,
  CurrentUserResponse,
  InvitationLookupResponse,
  InvitationStatus,
  LeaveRequestMutationResponse,
  LeaveRequestStatus,
  LabPinMutationResponse,
  ListInventoryLowStockResponse,
  ListInventoryMovementsResponse,
  ListInventoryProductsResponse,
  ListInventoryStockResponse,
  ListLabPinStatusesResponse,
  ListStaffBookingsResponse,
  ListCrmClientAllergiesResponse,
  ListCrmClientMessagesResponse,
  ListCrmClientNotesResponse,
  ListCrmClientPatchTestsResponse,
  ListCrmClientVisitsResponse,
  ListCrmClientsResponse,
  ListCrmVisitPhotosResponse,
  ListLeaveRequestsResponse,
  ListLocationsResponse,
  ListStaffResponse,
  LocationDetailResponse,
  LoginResponse,
  OwnerBookingSettingsResponse,
  OwnerOnboardingBootstrap,
  OwnerOnboardingRequest,
  OwnerOnboardingResponse,
  PasswordResetCompleteResponse,
  PasswordResetInspectResponse,
  PasswordResetRequestResponse,
  CreateNewWeekRequest,
  CreateNewWeekResponse,
  CreatePublicBookingRequest,
  CreatePublicBookingResponse,
  PreviewNewWeekRequest,
  PreviewNewWeekResponse,
  PublicBookingAttemptResponse,
  PublicBookingAvailabilityResponse,
  PublicBookingLocationsResponse,
  PublicBookingServiceSelectionResponse,
  PublicBookingStylistsResponse,
  RejectLeaveRequestRequest,
  SaveWeeklyRotaRequest,
  SaveWeeklyRotaResponse,
  SheerLabAnalyticsRange,
  SheerLabAnalyticsResponse,
  ShiftMutationResponse,
  StartPublicBookingCheckoutRequest,
  StartPublicBookingCheckoutResponse,
  StaffInvitation,
  StaffInvitationWithToken,
  UpdateBreakRequest,
  UpdateCrmClientRequest,
  UpdateLocationRequest,
  UpdateShiftRequest,
  UpdateStaffMemberRequest,
  UpdateStaffMemberResponse,
  UpsertServiceRequirementRuleRequest,
  UpsertServiceUpgradeSuggestionRequest,
  WeeklyRotaResponse,
} from '@sheer/domain';

const API_BASE_URL = (import.meta.env.VITE_API_URL ?? 'http://localhost:3001').replace(/\/$/, '');

interface LoginInput {
  email: string;
  password: string;
}

export async function login(input: LoginInput): Promise<LoginResponse> {
  return request<LoginResponse>('/auth/login', {
    method: 'POST',
    body: { ...input, surface: 'web_dashboard' },
  });
}

export async function createAccount(
  input: Omit<CreateAccountRequest, 'surface'>,
): Promise<LoginResponse> {
  return request<LoginResponse>('/auth/register', {
    method: 'POST',
    body: { ...input, surface: 'web_dashboard' },
  });
}

export async function refreshSession(refreshToken: string): Promise<LoginResponse> {
  return request<LoginResponse>('/auth/refresh', {
    method: 'POST',
    body: { refreshToken, surface: 'web_dashboard' },
  });
}

export async function getCurrentUser(accessToken: string): Promise<CurrentUserResponse> {
  return request<CurrentUserResponse>('/auth/me', {
    accessToken,
  });
}

export async function logout(accessToken?: string, refreshToken?: string): Promise<void> {
  await request<void>('/auth/logout', {
    method: 'POST',
    accessToken,
    body: { refreshToken },
  });
}

// -------------------- Public booking flow --------------------

export async function listPublicBookingLocations(): Promise<PublicBookingLocationsResponse> {
  return request<PublicBookingLocationsResponse>('/public/booking/locations');
}

export async function getPublicBookingSelection(params: {
  locationId?: string;
  businessSlug?: string;
  locationSlug?: string;
}): Promise<PublicBookingServiceSelectionResponse> {
  const search = new URLSearchParams();
  if (params.locationId) search.set('locationId', params.locationId);
  if (params.businessSlug) search.set('businessSlug', params.businessSlug);
  if (params.locationSlug) search.set('locationSlug', params.locationSlug);
  return request<PublicBookingServiceSelectionResponse>(
    `/public/booking/selection?${search.toString()}`,
  );
}

export async function getPublicBookingStylists(params: {
  serviceIds: string[];
  locationId?: string;
  businessSlug?: string;
  locationSlug?: string;
}): Promise<PublicBookingStylistsResponse> {
  const search = new URLSearchParams();
  search.set('serviceIds', params.serviceIds.join(','));
  if (params.locationId) search.set('locationId', params.locationId);
  if (params.businessSlug) search.set('businessSlug', params.businessSlug);
  if (params.locationSlug) search.set('locationSlug', params.locationSlug);
  return request<PublicBookingStylistsResponse>(
    `/public/booking/stylists?${search.toString()}`,
  );
}

export async function getPublicBookingAvailability(params: {
  locationId: string;
  serviceIds: string[];
  stylistId?: string;
  nextAvailable?: boolean;
  dateFrom: string;
  dateTo: string;
}): Promise<PublicBookingAvailabilityResponse> {
  const search = new URLSearchParams();
  search.set('locationId', params.locationId);
  search.set('serviceIds', params.serviceIds.join(','));
  if (params.stylistId) search.set('stylistId', params.stylistId);
  if (params.nextAvailable) search.set('nextAvailable', 'true');
  search.set('dateFrom', params.dateFrom);
  search.set('dateTo', params.dateTo);
  return request<PublicBookingAvailabilityResponse>(
    `/public/booking/availability?${search.toString()}`,
  );
}

export async function createPublicBooking(
  payload: CreatePublicBookingRequest,
): Promise<CreatePublicBookingResponse> {
  return request<CreatePublicBookingResponse>('/public/booking/appointments', {
    method: 'POST',
    body: payload,
  });
}

export async function startPublicBookingCheckout(
  payload: StartPublicBookingCheckoutRequest,
): Promise<StartPublicBookingCheckoutResponse> {
  return request<StartPublicBookingCheckoutResponse>('/public/booking/start-checkout', {
    method: 'POST',
    body: payload,
  });
}

export async function getPublicBookingAttempt(
  bookingAttemptId: string,
): Promise<PublicBookingAttemptResponse> {
  return request<PublicBookingAttemptResponse>(
    `/public/booking/attempts/${encodeURIComponent(bookingAttemptId)}`,
  );
}

// -------------------- CRM (owner / manager / scoped stylist) --------------------

export async function listCrmClients(
  accessToken: string,
  params: { q?: string; locationId?: string } = {},
): Promise<ListCrmClientsResponse> {
  const search = new URLSearchParams();
  if (params.q) search.set('q', params.q);
  if (params.locationId) search.set('locationId', params.locationId);
  const query = search.toString();
  return request<ListCrmClientsResponse>(`/crm/clients${query ? `?${query}` : ''}`, {
    accessToken,
  });
}

// -------------------- Bookings (owner / manager dashboard) --------------------

export async function listBookings(
  accessToken: string,
  params: { locationId?: string } = {},
): Promise<ListStaffBookingsResponse> {
  const search = new URLSearchParams();
  if (params.locationId) search.set('locationId', params.locationId);
  const query = search.toString();
  return request<ListStaffBookingsResponse>(`/lab/appointments${query ? `?${query}` : ''}`, {
    accessToken,
  });
}

export async function getSheerLabAnalytics(
  accessToken: string,
  params: { range?: SheerLabAnalyticsRange; locationId?: string } = {},
): Promise<SheerLabAnalyticsResponse> {
  const search = new URLSearchParams();
  if (params.range) search.set('range', params.range);
  if (params.locationId) search.set('locationId', params.locationId);
  const query = search.toString();
  return request<SheerLabAnalyticsResponse>(`/lab/analytics/summary${query ? `?${query}` : ''}`, {
    accessToken,
  });
}

export async function getDashboardKpis(
  accessToken: string,
  params: { locationId?: string; from: string; to: string },
): Promise<DashboardKpisResponse> {
  const search = dashboardDateRangeSearch(params);
  return request<DashboardKpisResponse>(`/dashboard/kpis?${search.toString()}`, { accessToken });
}

export async function getDashboardTopServices(
  accessToken: string,
  params: { locationId?: string; from: string; to: string },
): Promise<DashboardTopServicesResponse> {
  const search = dashboardDateRangeSearch(params);
  return request<DashboardTopServicesResponse>(`/dashboard/top-services?${search.toString()}`, { accessToken });
}

export async function getDashboardStylistPerformance(
  accessToken: string,
  params: { locationId?: string; from: string; to: string },
): Promise<DashboardStylistPerformanceResponse> {
  const search = dashboardDateRangeSearch(params);
  return request<DashboardStylistPerformanceResponse>(`/dashboard/stylist-performance?${search.toString()}`, {
    accessToken,
  });
}

export async function getDashboardInventoryAlerts(
  accessToken: string,
  params: { locationId?: string } = {},
): Promise<DashboardInventoryAlertsResponse> {
  const search = new URLSearchParams();
  if (params.locationId) search.set('locationId', params.locationId);
  const query = search.toString();
  return request<DashboardInventoryAlertsResponse>(`/dashboard/inventory-alerts${query ? `?${query}` : ''}`, {
    accessToken,
  });
}

export async function listLabPinStatuses(
  accessToken: string,
  params: { locationId?: string } = {},
): Promise<ListLabPinStatusesResponse> {
  const search = new URLSearchParams();
  if (params.locationId) search.set('locationId', params.locationId);
  const query = search.toString();
  return request<ListLabPinStatusesResponse>(`/lab/pins/status${query ? `?${query}` : ''}`, {
    accessToken,
  });
}

export async function setLabPin(
  accessToken: string,
  payload: { locationId: string; userProfileId: string; pin: string },
): Promise<LabPinMutationResponse> {
  return request<LabPinMutationResponse>('/lab/pins/assign', {
    method: 'POST',
    accessToken,
    body: payload,
  });
}

export async function resetLabPin(
  accessToken: string,
  payload: { locationId: string; userProfileId: string },
): Promise<LabPinMutationResponse> {
  return request<LabPinMutationResponse>('/lab/pins/reset', {
    method: 'POST',
    accessToken,
    body: payload,
  });
}

export async function registerLabDevice(
  accessToken: string,
  payload: { businessId: string; locationId: string; deviceName: string; stationLabel?: string },
): Promise<LabDeviceRegistrationResponse> {
  return request<LabDeviceRegistrationResponse>('/lab/device/register', {
    method: 'POST',
    accessToken,
    body: payload,
  });
}

export async function listInventoryProducts(
  accessToken: string,
  params: { q?: string; includeInactive?: boolean } = {},
): Promise<ListInventoryProductsResponse> {
  const search = new URLSearchParams();
  if (params.q) search.set('q', params.q);
  if (params.includeInactive) search.set('includeInactive', 'true');
  const query = search.toString();
  return request<ListInventoryProductsResponse>(`/inventory/products${query ? `?${query}` : ''}`, { accessToken });
}

export async function createInventoryProduct(
  accessToken: string,
  payload: {
    brand?: string | null;
    name: string;
    category?: string | null;
    sku?: string | null;
    sizeValue?: number | null;
    sizeUnit?: string | null;
    defaultCostPerGramCents?: number | null;
    retailPriceCents?: number | null;
    lowStockThresholdGrams?: number | null;
  },
): Promise<InventoryProductResponse> {
  return request<InventoryProductResponse>('/inventory/products', { method: 'POST', accessToken, body: payload });
}

export async function updateInventoryProduct(
  accessToken: string,
  productId: string,
  payload: Parameters<typeof createInventoryProduct>[1],
): Promise<InventoryProductResponse> {
  return request<InventoryProductResponse>(`/inventory/products/${encodeURIComponent(productId)}`, {
    method: 'PATCH',
    accessToken,
    body: payload,
  });
}

export async function archiveInventoryProduct(
  accessToken: string,
  productId: string,
): Promise<InventoryProductResponse> {
  return request<InventoryProductResponse>(`/inventory/products/${encodeURIComponent(productId)}/archive`, {
    method: 'POST',
    accessToken,
  });
}

export async function listInventoryStock(
  accessToken: string,
  params: { locationId?: string; q?: string; lowStockOnly?: boolean } = {},
): Promise<ListInventoryStockResponse> {
  const search = new URLSearchParams();
  if (params.locationId) search.set('locationId', params.locationId);
  if (params.q) search.set('q', params.q);
  if (params.lowStockOnly) search.set('lowStockOnly', 'true');
  const query = search.toString();
  return request<ListInventoryStockResponse>(`/inventory/stock${query ? `?${query}` : ''}`, { accessToken });
}

export async function initializeInventoryStock(
  accessToken: string,
  payload: { locationId: string; productId: string; quantityOnHandGrams?: number; lowStockThresholdGrams?: number | null },
): Promise<InventoryStockMutationResponse> {
  return request<InventoryStockMutationResponse>('/inventory/stock/initialize', {
    method: 'POST',
    accessToken,
    body: payload,
  });
}

export async function adjustInventoryStock(
  accessToken: string,
  payload: {
    locationId: string;
    productId: string;
    quantityDeltaGrams: number;
    movementType: 'opening_balance' | 'restock' | 'manual_adjustment' | 'retail_sale' | 'correction';
    reason?: string | null;
    notes?: string | null;
  },
): Promise<InventoryStockMutationResponse> {
  return request<InventoryStockMutationResponse>('/inventory/stock/adjust', {
    method: 'POST',
    accessToken,
    body: payload,
  });
}

export async function updateInventoryStockThreshold(
  accessToken: string,
  stockId: string,
  payload: { lowStockThresholdGrams?: number | null; isActive?: boolean },
): Promise<InventoryStockMutationResponse> {
  return request<InventoryStockMutationResponse>(`/inventory/stock/${encodeURIComponent(stockId)}`, {
    method: 'PATCH',
    accessToken,
    body: payload,
  });
}

export async function listInventoryMovements(
  accessToken: string,
  params: { locationId?: string; productId?: string; limit?: number } = {},
): Promise<ListInventoryMovementsResponse> {
  const search = new URLSearchParams();
  if (params.locationId) search.set('locationId', params.locationId);
  if (params.productId) search.set('productId', params.productId);
  if (params.limit) search.set('limit', String(params.limit));
  const query = search.toString();
  return request<ListInventoryMovementsResponse>(`/inventory/movements${query ? `?${query}` : ''}`, { accessToken });
}

export async function listInventoryLowStock(
  accessToken: string,
  params: { locationId?: string } = {},
): Promise<ListInventoryLowStockResponse> {
  const search = new URLSearchParams();
  if (params.locationId) search.set('locationId', params.locationId);
  const query = search.toString();
  return request<ListInventoryLowStockResponse>(`/inventory/low-stock${query ? `?${query}` : ''}`, { accessToken });
}

export async function createCrmClient(
  accessToken: string,
  payload: CreateCrmClientRequest,
): Promise<{ client: ListCrmClientsResponse['clients'][number] }> {
  return request<{ client: ListCrmClientsResponse['clients'][number] }>('/crm/clients', {
    method: 'POST',
    accessToken,
    body: payload,
  });
}

export async function getCrmClientDetail(
  accessToken: string,
  clientId: string,
): Promise<CrmClientDetailResponse> {
  return request<CrmClientDetailResponse>(`/crm/clients/${encodeURIComponent(clientId)}`, {
    accessToken,
  });
}

export async function updateCrmClient(
  accessToken: string,
  clientId: string,
  payload: UpdateCrmClientRequest,
): Promise<{ client: ListCrmClientsResponse['clients'][number] }> {
  return request<{ client: ListCrmClientsResponse['clients'][number] }>(
    `/crm/clients/${encodeURIComponent(clientId)}`,
    { method: 'PATCH', accessToken, body: payload },
  );
}

export async function listCrmClientVisits(
  accessToken: string,
  clientId: string,
): Promise<ListCrmClientVisitsResponse> {
  return request<ListCrmClientVisitsResponse>(
    `/crm/clients/${encodeURIComponent(clientId)}/visits`,
    { accessToken },
  );
}

export async function listCrmClientNotes(
  accessToken: string,
  clientId: string,
): Promise<ListCrmClientNotesResponse> {
  return request<ListCrmClientNotesResponse>(
    `/crm/clients/${encodeURIComponent(clientId)}/notes`,
    { accessToken },
  );
}

export async function createCrmClientNote(
  accessToken: string,
  clientId: string,
  payload: CreateCrmClientNoteRequest,
): Promise<ListCrmClientNotesResponse> {
  return request<ListCrmClientNotesResponse>(
    `/crm/clients/${encodeURIComponent(clientId)}/notes`,
    { method: 'POST', accessToken, body: payload },
  );
}

export async function listCrmClientAllergies(
  accessToken: string,
  clientId: string,
): Promise<ListCrmClientAllergiesResponse> {
  return request<ListCrmClientAllergiesResponse>(
    `/crm/clients/${encodeURIComponent(clientId)}/allergies`,
    { accessToken },
  );
}

export async function createCrmClientAllergy(
  accessToken: string,
  clientId: string,
  payload: CreateCrmAllergyRecordRequest,
): Promise<ListCrmClientAllergiesResponse> {
  return request<ListCrmClientAllergiesResponse>(
    `/crm/clients/${encodeURIComponent(clientId)}/allergies`,
    { method: 'POST', accessToken, body: payload },
  );
}

export async function listCrmClientPatchTests(
  accessToken: string,
  clientId: string,
): Promise<ListCrmClientPatchTestsResponse> {
  return request<ListCrmClientPatchTestsResponse>(
    `/crm/clients/${encodeURIComponent(clientId)}/patch-tests`,
    { accessToken },
  );
}

export async function createCrmClientPatchTest(
  accessToken: string,
  clientId: string,
  payload: CreateCrmPatchTestRequest,
): Promise<ListCrmClientPatchTestsResponse> {
  return request<ListCrmClientPatchTestsResponse>(
    `/crm/clients/${encodeURIComponent(clientId)}/patch-tests`,
    { method: 'POST', accessToken, body: payload },
  );
}

export async function listCrmClientMessages(
  accessToken: string,
  clientId: string,
): Promise<ListCrmClientMessagesResponse> {
  return request<ListCrmClientMessagesResponse>(
    `/crm/clients/${encodeURIComponent(clientId)}/messages`,
    { accessToken },
  );
}

export async function listCrmVisitPhotos(
  accessToken: string,
  visitId: string,
): Promise<ListCrmVisitPhotosResponse> {
  return request<ListCrmVisitPhotosResponse>(`/crm/visits/${encodeURIComponent(visitId)}/photos`, {
    accessToken,
  });
}

export async function createCrmVisitPhoto(
  accessToken: string,
  visitId: string,
  payload: CreateCrmVisitPhotoRequest,
): Promise<{ photo: ListCrmVisitPhotosResponse['photos'][number] }> {
  return request<{ photo: ListCrmVisitPhotosResponse['photos'][number] }>(
    `/crm/visits/${encodeURIComponent(visitId)}/photos`,
    { method: 'POST', accessToken, body: payload },
  );
}

export async function createClientBookingAccount(payload: {
  locationId: string;
  email: string;
  password: string;
  firstName: string;
  lastName: string;
  phone?: string;
  communicationPreference: 'whatsapp' | 'sms' | 'email';
}): Promise<LoginResponse> {
  return request<LoginResponse>('/auth/client-booking/register', {
    method: 'POST',
    body: payload,
  });
}

export async function loginClientBookingAccount(payload: {
  locationId: string;
  email: string;
  password: string;
  phone?: string;
}): Promise<LoginResponse> {
  return request<LoginResponse>('/auth/client-booking/login', {
    method: 'POST',
    body: payload,
  });
}

// -------------------- Password reset (public) --------------------

export async function requestPasswordReset(
  email: string,
): Promise<PasswordResetRequestResponse> {
  return request<PasswordResetRequestResponse>('/auth/password-reset/request', {
    method: 'POST',
    body: { email },
  });
}

export async function inspectPasswordResetToken(
  token: string,
): Promise<PasswordResetInspectResponse> {
  return request<PasswordResetInspectResponse>(
    `/auth/password-reset/inspect?token=${encodeURIComponent(token)}`,
  );
}

export async function completePasswordReset(input: {
  token: string;
  password: string;
}): Promise<PasswordResetCompleteResponse> {
  return request<PasswordResetCompleteResponse>('/auth/password-reset/complete', {
    method: 'POST',
    body: input,
  });
}

export async function getOwnerOnboardingBootstrap(): Promise<OwnerOnboardingBootstrap> {
  return request<OwnerOnboardingBootstrap>('/owner/onboarding/bootstrap');
}

export async function checkBusinessSlugAvailability(
  slug: string,
): Promise<BusinessSlugAvailabilityResponse> {
  return request<BusinessSlugAvailabilityResponse>(
    `/owner/onboarding/check-business-slug?slug=${encodeURIComponent(slug)}`,
  );
}

export async function registerOwnerOnboarding(
  payload: OwnerOnboardingRequest,
): Promise<OwnerOnboardingResponse> {
  return request<OwnerOnboardingResponse>('/owner/onboarding/register', {
    method: 'POST',
    body: payload,
  });
}

// -------------------- Staff management (owner-only) --------------------

export async function listStaff(accessToken: string): Promise<ListStaffResponse> {
  return request<ListStaffResponse>('/owner/staff', { accessToken });
}

export async function updateStaffMember(
  accessToken: string,
  userId: string,
  payload: UpdateStaffMemberRequest,
): Promise<UpdateStaffMemberResponse> {
  return request<UpdateStaffMemberResponse>(`/owner/staff/${encodeURIComponent(userId)}`, {
    method: 'PATCH',
    body: payload,
    accessToken,
  });
}

export async function deactivateStaffMember(
  accessToken: string,
  userId: string,
): Promise<UpdateStaffMemberResponse> {
  return request<UpdateStaffMemberResponse>(
    `/owner/staff/${encodeURIComponent(userId)}/deactivate`,
    { method: 'POST', accessToken },
  );
}

export async function reactivateStaffMember(
  accessToken: string,
  userId: string,
): Promise<UpdateStaffMemberResponse> {
  return request<UpdateStaffMemberResponse>(
    `/owner/staff/${encodeURIComponent(userId)}/reactivate`,
    { method: 'POST', accessToken },
  );
}

export async function listStaffInvitations(
  accessToken: string,
  status?: InvitationStatus | 'all',
): Promise<StaffInvitation[]> {
  const path =
    status && status !== 'all'
      ? `/owner/staff/invitations?status=${encodeURIComponent(status)}`
      : '/owner/staff/invitations';
  return request<StaffInvitation[]>(path, { accessToken });
}

export async function createStaffInvitation(
  accessToken: string,
  payload: CreateStaffInvitationRequest,
): Promise<StaffInvitationWithToken> {
  return request<StaffInvitationWithToken>('/owner/staff/invitations', {
    method: 'POST',
    body: payload,
    accessToken,
  });
}

export async function resendStaffInvitation(
  accessToken: string,
  invitationId: string,
): Promise<StaffInvitationWithToken> {
  return request<StaffInvitationWithToken>(
    `/owner/staff/invitations/${encodeURIComponent(invitationId)}/resend`,
    { method: 'POST', accessToken },
  );
}

export async function revokeStaffInvitation(
  accessToken: string,
  invitationId: string,
): Promise<StaffInvitation> {
  return request<StaffInvitation>(
    `/owner/staff/invitations/${encodeURIComponent(invitationId)}/revoke`,
    { method: 'POST', accessToken },
  );
}

// -------------------- Locations (owner + manager) --------------------

export async function listLocations(accessToken: string): Promise<ListLocationsResponse> {
  return request<ListLocationsResponse>('/locations', { accessToken });
}

export async function getLocation(
  accessToken: string,
  locationId: string,
): Promise<LocationDetailResponse> {
  return request<LocationDetailResponse>(
    `/locations/${encodeURIComponent(locationId)}`,
    { accessToken },
  );
}

export async function createLocation(
  accessToken: string,
  payload: CreateLocationRequest,
): Promise<LocationDetailResponse> {
  return request<LocationDetailResponse>('/owner/locations', {
    method: 'POST',
    body: payload,
    accessToken,
  });
}

export async function updateLocation(
  accessToken: string,
  locationId: string,
  payload: UpdateLocationRequest,
): Promise<LocationDetailResponse> {
  return request<LocationDetailResponse>(
    `/owner/locations/${encodeURIComponent(locationId)}`,
    { method: 'PATCH', body: payload, accessToken },
  );
}

export async function deactivateLocation(
  accessToken: string,
  locationId: string,
): Promise<LocationDetailResponse> {
  return request<LocationDetailResponse>(
    `/owner/locations/${encodeURIComponent(locationId)}/deactivate`,
    { method: 'POST', accessToken },
  );
}

export async function reactivateLocation(
  accessToken: string,
  locationId: string,
): Promise<LocationDetailResponse> {
  return request<LocationDetailResponse>(
    `/owner/locations/${encodeURIComponent(locationId)}/reactivate`,
    { method: 'POST', accessToken },
  );
}

// -------------------- Owner booking settings --------------------

export async function getOwnerBookingSettings(
  accessToken: string,
  params: { locationId?: string } = {},
): Promise<OwnerBookingSettingsResponse> {
  const search = new URLSearchParams();
  if (params.locationId) search.set('locationId', params.locationId);
  const query = search.toString();
  return request<OwnerBookingSettingsResponse>(
    `/owner/booking-settings${query ? `?${query}` : ''}`,
    { accessToken },
  );
}

export async function createServiceRequirementRule(
  accessToken: string,
  payload: UpsertServiceRequirementRuleRequest,
): Promise<OwnerBookingSettingsResponse['requirementRules'][number]> {
  const result = await request<{ rule: OwnerBookingSettingsResponse['requirementRules'][number] }>(
    '/owner/booking-settings/requirement-rules',
    { method: 'POST', accessToken, body: payload },
  );
  return result.rule;
}

export async function updateServiceRequirementRule(
  accessToken: string,
  ruleId: string,
  payload: UpsertServiceRequirementRuleRequest,
): Promise<OwnerBookingSettingsResponse['requirementRules'][number]> {
  const result = await request<{ rule: OwnerBookingSettingsResponse['requirementRules'][number] }>(
    `/owner/booking-settings/requirement-rules/${encodeURIComponent(ruleId)}`,
    { method: 'PATCH', accessToken, body: payload },
  );
  return result.rule;
}

export async function deleteServiceRequirementRule(
  accessToken: string,
  ruleId: string,
): Promise<void> {
  await request<void>(`/owner/booking-settings/requirement-rules/${encodeURIComponent(ruleId)}`, {
    method: 'DELETE',
    accessToken,
  });
}

export async function createServiceUpgradeSuggestion(
  accessToken: string,
  payload: UpsertServiceUpgradeSuggestionRequest,
): Promise<OwnerBookingSettingsResponse['upgradeSuggestions'][number]> {
  const result = await request<{ suggestion: OwnerBookingSettingsResponse['upgradeSuggestions'][number] }>(
    '/owner/booking-settings/upgrade-suggestions',
    { method: 'POST', accessToken, body: payload },
  );
  return result.suggestion;
}

export async function updateServiceUpgradeSuggestion(
  accessToken: string,
  suggestionId: string,
  payload: UpsertServiceUpgradeSuggestionRequest,
): Promise<OwnerBookingSettingsResponse['upgradeSuggestions'][number]> {
  const result = await request<{ suggestion: OwnerBookingSettingsResponse['upgradeSuggestions'][number] }>(
    `/owner/booking-settings/upgrade-suggestions/${encodeURIComponent(suggestionId)}`,
    { method: 'PATCH', accessToken, body: payload },
  );
  return result.suggestion;
}

export async function deleteServiceUpgradeSuggestion(
  accessToken: string,
  suggestionId: string,
): Promise<void> {
  await request<void>(
    `/owner/booking-settings/upgrade-suggestions/${encodeURIComponent(suggestionId)}`,
    { method: 'DELETE', accessToken },
  );
}

// -------------------- Rota (manager + owner) --------------------

export async function getWeeklyRota(
  accessToken: string,
  params: { locationId?: string; weekStart: string },
): Promise<WeeklyRotaResponse> {
  const search = new URLSearchParams();
  if (params.locationId) search.set('locationId', params.locationId);
  search.set('weekStart', params.weekStart);
  return request<WeeklyRotaResponse>(`/rota/week?${search.toString()}`, { accessToken });
}

export async function createRotaShift(
  accessToken: string,
  payload: CreateShiftRequest,
): Promise<ShiftMutationResponse> {
  return request<ShiftMutationResponse>('/rota/shifts', {
    method: 'POST',
    body: payload,
    accessToken,
  });
}

export async function updateRotaShift(
  accessToken: string,
  shiftId: string,
  payload: UpdateShiftRequest,
): Promise<ShiftMutationResponse> {
  return request<ShiftMutationResponse>(`/rota/shifts/${encodeURIComponent(shiftId)}`, {
    method: 'PATCH',
    body: payload,
    accessToken,
  });
}

export async function deleteRotaShift(
  accessToken: string,
  shiftId: string,
  pastEditReason?: string,
): Promise<{ success: true }> {
  const search = pastEditReason
    ? `?pastEditReason=${encodeURIComponent(pastEditReason)}`
    : '';
  return request<{ success: true }>(
    `/rota/shifts/${encodeURIComponent(shiftId)}${search}`,
    { method: 'DELETE', accessToken },
  );
}

export async function addRotaBreak(
  accessToken: string,
  shiftId: string,
  payload: CreateBreakRequest,
): Promise<BreakMutationResponse> {
  return request<BreakMutationResponse>(
    `/rota/shifts/${encodeURIComponent(shiftId)}/breaks`,
    { method: 'POST', body: payload, accessToken },
  );
}

export async function updateRotaBreak(
  accessToken: string,
  shiftId: string,
  breakId: string,
  payload: UpdateBreakRequest,
): Promise<BreakMutationResponse> {
  return request<BreakMutationResponse>(
    `/rota/shifts/${encodeURIComponent(shiftId)}/breaks/${encodeURIComponent(breakId)}`,
    { method: 'PATCH', body: payload, accessToken },
  );
}

export async function deleteRotaBreak(
  accessToken: string,
  shiftId: string,
  breakId: string,
  pastEditReason?: string,
): Promise<{ success: true }> {
  const search = pastEditReason
    ? `?pastEditReason=${encodeURIComponent(pastEditReason)}`
    : '';
  return request<{ success: true }>(
    `/rota/shifts/${encodeURIComponent(shiftId)}/breaks/${encodeURIComponent(breakId)}${search}`,
    { method: 'DELETE', accessToken },
  );
}

export async function listRotaLeaveRequests(
  accessToken: string,
  params: { locationId?: string; status?: LeaveRequestStatus | 'all' } = {},
): Promise<ListLeaveRequestsResponse> {
  const search = new URLSearchParams();
  if (params.locationId) search.set('locationId', params.locationId);
  if (params.status) search.set('status', params.status);
  const query = search.toString();
  return request<ListLeaveRequestsResponse>(
    `/rota/leave-requests${query ? `?${query}` : ''}`,
    { accessToken },
  );
}

export async function approveRotaLeaveRequest(
  accessToken: string,
  requestId: string,
  payload: ApproveLeaveRequestRequest = {},
): Promise<LeaveRequestMutationResponse> {
  return request<LeaveRequestMutationResponse>(
    `/rota/leave-requests/${encodeURIComponent(requestId)}/approve`,
    { method: 'POST', body: payload, accessToken },
  );
}

export async function rejectRotaLeaveRequest(
  accessToken: string,
  requestId: string,
  payload: RejectLeaveRequestRequest = {},
): Promise<LeaveRequestMutationResponse> {
  return request<LeaveRequestMutationResponse>(
    `/rota/leave-requests/${encodeURIComponent(requestId)}/reject`,
    { method: 'POST', body: payload, accessToken },
  );
}

export async function markRotaAbsence(
  accessToken: string,
  payload: CreateAbsenceRequest,
): Promise<AbsenceMutationResponse> {
  return request<AbsenceMutationResponse>('/rota/absence-events', {
    method: 'POST',
    body: payload,
    accessToken,
  });
}

export async function saveWeeklyRota(
  accessToken: string,
  payload: SaveWeeklyRotaRequest,
): Promise<SaveWeeklyRotaResponse> {
  return request<SaveWeeklyRotaResponse>('/rota/week/save', {
    method: 'POST',
    body: payload,
    accessToken,
  });
}

export async function previewNewWeek(
  accessToken: string,
  payload: PreviewNewWeekRequest,
): Promise<PreviewNewWeekResponse> {
  return request<PreviewNewWeekResponse>('/rota/weeks/preview', {
    method: 'POST',
    body: payload,
    accessToken,
  });
}

export async function createNewWeek(
  accessToken: string,
  payload: CreateNewWeekRequest,
): Promise<CreateNewWeekResponse> {
  return request<CreateNewWeekResponse>('/rota/weeks/create', {
    method: 'POST',
    body: payload,
    accessToken,
  });
}

// -------------------- Public invitation acceptance --------------------

export async function inspectStaffInvitation(token: string): Promise<InvitationLookupResponse> {
  return request<InvitationLookupResponse>(
    `/staff/invitations/inspect?token=${encodeURIComponent(token)}`,
  );
}

export async function acceptStaffInvitation(
  payload: AcceptStaffInvitationRequest,
): Promise<AcceptStaffInvitationResponse> {
  return request<AcceptStaffInvitationResponse>('/staff/invitations/accept', {
    method: 'POST',
    body: payload,
  });
}

export class ApiRequestError extends Error {
  readonly status: number;
  readonly details?: unknown;

  constructor(message: string, status: number, details?: unknown) {
    super(message);
    this.name = 'ApiRequestError';
    this.status = status;
    this.details = details;
  }
}

function dashboardDateRangeSearch(params: { locationId?: string; from: string; to: string }): URLSearchParams {
  const search = new URLSearchParams();
  search.set('from', params.from);
  search.set('to', params.to);
  if (params.locationId) search.set('locationId', params.locationId);
  return search;
}

async function request<T>(
  path: string,
  init: { method?: string; body?: unknown; accessToken?: string } = {},
): Promise<T> {
  const response = await fetch(`${API_BASE_URL}/api${path}`, {
    method: init.method ?? 'GET',
    headers: {
      'Content-Type': 'application/json',
      ...(init.accessToken ? { Authorization: `Bearer ${init.accessToken}` } : {}),
    },
    body: init.body ? JSON.stringify(init.body) : undefined,
  });

  if (!response.ok) {
    const raw = await response.text();
    let parsed: unknown;
    try {
      parsed = raw ? JSON.parse(raw) : undefined;
    } catch {
      parsed = undefined;
    }
    const message = extractErrorMessage(parsed) ?? raw ?? `Request failed with ${response.status}`;
    throw new ApiRequestError(message, response.status, parsed);
  }

  if (response.status === 204) {
    return undefined as T;
  }

  return (await response.json()) as T;
}

function extractErrorMessage(payload: unknown): string | undefined {
  if (!payload || typeof payload !== 'object') return undefined;
  const value = (payload as { message?: unknown }).message;
  if (typeof value === 'string') return value;
  if (Array.isArray(value) && value.length > 0) {
    return value.map((entry) => (typeof entry === 'string' ? entry : JSON.stringify(entry))).join(', ');
  }
  return undefined;
}
