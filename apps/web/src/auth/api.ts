import type {
  AbsenceMutationResponse,
  AcceptBookingResponse,
  CancelAppointmentRequest,
  CancelAppointmentResponse,
  CheckInAppointmentResponse,
  RescheduleAppointmentRequest,
  RescheduleAppointmentResponse,
  AcceptStaffInvitationRequest,
  AcceptStaffInvitationResponse,
  AppointmentCompletionResponse,
  AppointmentPaymentConfirmationRequest,
  AppointmentPaymentConfirmationResponse,
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
  KpiPeriod,
  StylistKpiListResponse,
  StylistKpiResponse,
  CreateLocationRequest,
  LabDeviceMutationResponse,
  LabDeviceRegistrationResponse,
  ListLabDevicesResponse,
  InventoryCategoryResponse,
  InventoryProductResponse,
  InventoryStockMutationResponse,
  CreateShiftRequest,
  CreateStaffInvitationRequest,
  CreateStylistRebookingRequest,
  CrmClientDetailResponse,
  CurrentUserResponse,
  InvitationLookupResponse,
  InvitationStatus,
  LeaveRequestMutationResponse,
  LinkStylistRebookingRequest,
  LeaveRequestStatus,
  LabPinMutationResponse,
  ListInventoryCategoriesResponse,
  ListInventoryLowStockResponse,
  ListInventoryMovementsResponse,
  ListInventoryProductsResponse,
  ListInventoryStockResponse,
  ListManagedServicesResponse,
  ManagedServiceResponse,
  UnassignedServicesResponse,
  ListServiceCategoriesResponse,
  ServiceCategoryResponse,
  CreateServiceCategoryRequest,
  UpdateServiceCategoryRequest,
  UpsertServiceRequest,
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
  LocationCommunicationSettings,
  LocationCommunicationSettingsResponse,
  LocationDetailResponse,
  LoginResponse,
  OwnerBookingSettingsResponse,
  OwnerOnboardingBootstrap,
  UpdateLocationCommunicationSettingsRequest,
  OwnerOnboardingRequest,
  OwnerOnboardingResponse,
  GetAccountResponse,
  UpdateAccountTierRequest,
  UpdateAccountTierResponse,
  PasswordResetCompleteResponse,
  PasswordResetInspectResponse,
  PasswordResetRequestResponse,
  CreateNewWeekRequest,
  CreateNewWeekResponse,
  CreatePublicBookingRequest,
  CreatePublicBookingResponse,
  CreateStaffBookingRequest,
  CreateStaffBookingResponse,
  CrmClientSummary,
  PreviewNewWeekRequest,
  PreviewNewWeekResponse,
  PublicBookingAttemptResponse,
  PublicBookingAvailabilityResponse,
  PublicBookingLocationsResponse,
  PublicBookingServiceSelectionResponse,
  PublicBookingStylistsResponse,
  RejectBookingRequest,
  RejectBookingResponse,
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
  AdminUpdateProfileRequest,
  GetCancellationPolicyResponse,
  GetLocationProductBillingSettingsResponse,
  GetLocationTaxSettingsResponse,
  LocationRecordSettingsResponse,
  UpdateLocationRecordSettingsRequest,
  ListLocationFixedCostsResponse,
  LocationFixedCostResponse,
  EffectiveFixedCostsResponse,
  CreateLocationFixedCostRequest,
  UpdateLocationFixedCostRequest,
  ListProfilesResponse,
  UpdateCancellationPolicyRequest,
  UpdateCancellationPolicyResponse,
  UpdateCurrentProfileRequest,
  UpdateLocationProductBillingSettingsRequest,
  UpdateLocationProductBillingSettingsResponse,
  UpdateLocationTaxSettingsRequest,
  UpdateLocationTaxSettingsResponse,
  UpdateProfileResponse,
  UserProfileResponse,
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

// -------------------- User profiles --------------------

export async function getMyProfile(accessToken: string): Promise<UserProfileResponse> {
  return request<UserProfileResponse>('/profiles/me', { accessToken });
}

export async function updateMyProfile(
  accessToken: string,
  payload: UpdateCurrentProfileRequest,
): Promise<UpdateProfileResponse> {
  return request<UpdateProfileResponse>('/profiles/me', {
    method: 'PATCH',
    accessToken,
    body: payload,
  });
}

export async function listProfiles(
  accessToken: string,
  params: { locationId?: string; kind?: 'staff' | 'client'; q?: string } = {},
): Promise<ListProfilesResponse> {
  const search = new URLSearchParams();
  if (params.locationId) search.set('locationId', params.locationId);
  if (params.kind) search.set('kind', params.kind);
  if (params.q) search.set('q', params.q);
  const query = search.toString();
  return request<ListProfilesResponse>(`/profiles${query ? `?${query}` : ''}`, { accessToken });
}

export async function updateProfile(
  accessToken: string,
  userProfileId: string,
  payload: AdminUpdateProfileRequest,
): Promise<UpdateProfileResponse> {
  return request<UpdateProfileResponse>(`/profiles/${encodeURIComponent(userProfileId)}`, {
    method: 'PATCH',
    accessToken,
    body: payload,
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

// -------------------- Staff booking (internal: owner / manager / stylist) --------------------

export async function getStaffBookingSelection(
  accessToken: string,
  params: { locationId: string },
): Promise<PublicBookingServiceSelectionResponse> {
  const search = new URLSearchParams({ locationId: params.locationId });
  return request<PublicBookingServiceSelectionResponse>(
    `/staff/booking/selection?${search.toString()}`,
    { accessToken },
  );
}

export async function getStaffBookingStylists(
  accessToken: string,
  params: { locationId: string; serviceIds: string[] },
): Promise<PublicBookingStylistsResponse> {
  const search = new URLSearchParams({ locationId: params.locationId });
  search.set('serviceIds', params.serviceIds.join(','));
  return request<PublicBookingStylistsResponse>(
    `/staff/booking/stylists?${search.toString()}`,
    { accessToken },
  );
}

export async function getStaffBookingAvailability(
  accessToken: string,
  params: {
    locationId: string;
    serviceIds: string[];
    stylistId?: string;
    nextAvailable?: boolean;
    dateFrom: string;
    dateTo: string;
  },
): Promise<PublicBookingAvailabilityResponse> {
  const search = new URLSearchParams({ locationId: params.locationId });
  search.set('serviceIds', params.serviceIds.join(','));
  if (params.stylistId) search.set('stylistId', params.stylistId);
  if (params.nextAvailable) search.set('nextAvailable', 'true');
  search.set('dateFrom', params.dateFrom);
  search.set('dateTo', params.dateTo);
  return request<PublicBookingAvailabilityResponse>(
    `/staff/booking/availability?${search.toString()}`,
    { accessToken },
  );
}

export async function searchStaffBookingClients(
  accessToken: string,
  params: { q?: string; locationId?: string } = {},
): Promise<ListCrmClientsResponse> {
  const search = new URLSearchParams();
  if (params.q) search.set('q', params.q);
  if (params.locationId) search.set('locationId', params.locationId);
  const query = search.toString();
  return request<ListCrmClientsResponse>(`/staff/booking/clients${query ? `?${query}` : ''}`, {
    accessToken,
  });
}

export async function createStaffBookingClient(
  accessToken: string,
  payload: CreateCrmClientRequest,
): Promise<{ client: CrmClientSummary }> {
  return request<{ client: CrmClientSummary }>('/staff/booking/clients', {
    method: 'POST',
    accessToken,
    body: payload,
  });
}

export async function createStaffBooking(
  accessToken: string,
  payload: CreateStaffBookingRequest,
): Promise<CreateStaffBookingResponse> {
  return request<CreateStaffBookingResponse>('/staff/booking/appointments', {
    method: 'POST',
    accessToken,
    body: payload,
  });
}

// -------------------- CRM (owner / manager / scoped stylist) --------------------

export async function listCrmClients(
  accessToken: string,
  params: { q?: string; locationId?: string; page?: number; pageSize?: number } = {},
): Promise<ListCrmClientsResponse> {
  const search = new URLSearchParams();
  if (params.q) search.set('q', params.q);
  if (params.locationId) search.set('locationId', params.locationId);
  if (params.page) search.set('page', String(params.page));
  if (params.pageSize) search.set('pageSize', String(params.pageSize));
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

export async function acceptBooking(
  accessToken: string,
  bookingId: string,
): Promise<AcceptBookingResponse> {
  return request<AcceptBookingResponse>(
    `/lab/appointments/${encodeURIComponent(bookingId)}/accept`,
    { method: 'POST', accessToken },
  );
}

export async function rejectBooking(
  accessToken: string,
  bookingId: string,
  payload: RejectBookingRequest = {},
): Promise<RejectBookingResponse> {
  return request<RejectBookingResponse>(
    `/lab/appointments/${encodeURIComponent(bookingId)}/reject`,
    { method: 'POST', accessToken, body: payload },
  );
}

export async function completeBooking(
  accessToken: string,
  bookingId: string,
): Promise<AppointmentCompletionResponse> {
  return request<AppointmentCompletionResponse>(
    `/lab/appointments/${encodeURIComponent(bookingId)}/complete`,
    {
      method: 'POST',
      accessToken,
    },
  );
}

export async function checkInBooking(
  accessToken: string,
  bookingId: string,
): Promise<CheckInAppointmentResponse> {
  return request<CheckInAppointmentResponse>(
    `/lab/appointments/${encodeURIComponent(bookingId)}/check-in`,
    { method: 'POST', accessToken },
  );
}

export async function cancelBooking(
  accessToken: string,
  bookingId: string,
  payload: CancelAppointmentRequest = {},
): Promise<CancelAppointmentResponse> {
  return request<CancelAppointmentResponse>(
    `/lab/appointments/${encodeURIComponent(bookingId)}/cancel`,
    { method: 'POST', accessToken, body: payload },
  );
}

export async function rescheduleBooking(
  accessToken: string,
  bookingId: string,
  payload: RescheduleAppointmentRequest,
): Promise<RescheduleAppointmentResponse> {
  return request<RescheduleAppointmentResponse>(
    `/lab/appointments/${encodeURIComponent(bookingId)}/reschedule`,
    { method: 'POST', accessToken, body: payload },
  );
}

export async function confirmBookingPayment(
  accessToken: string,
  bookingId: string,
  payload: AppointmentPaymentConfirmationRequest,
): Promise<AppointmentPaymentConfirmationResponse> {
  return request<AppointmentPaymentConfirmationResponse>(
    `/lab/appointments/${encodeURIComponent(bookingId)}/confirm-payment`,
    {
      method: 'POST',
      accessToken,
      body: payload,
    },
  );
}

export async function linkStylistRebooking(
  accessToken: string,
  bookingId: string,
  payload: LinkStylistRebookingRequest,
): Promise<AppointmentCompletionResponse> {
  return request<AppointmentCompletionResponse>(
    `/lab/appointments/${encodeURIComponent(bookingId)}/rebooking/link`,
    {
      method: 'POST',
      accessToken,
      body: payload,
    },
  );
}

export async function createStylistRebooking(
  accessToken: string,
  bookingId: string,
  payload: CreateStylistRebookingRequest,
): Promise<AppointmentCompletionResponse> {
  return request<AppointmentCompletionResponse>(
    `/lab/appointments/${encodeURIComponent(bookingId)}/rebooking`,
    {
      method: 'POST',
      accessToken,
      body: payload,
    },
  );
}

export async function getSheerLabAnalytics(
  accessToken: string,
  params: { range?: SheerLabAnalyticsRange; locationId?: string; from?: string; to?: string } = {},
): Promise<SheerLabAnalyticsResponse> {
  const search = new URLSearchParams();
  if (params.range) search.set('range', params.range);
  if (params.locationId) search.set('locationId', params.locationId);
  if (params.from) search.set('from', params.from);
  if (params.to) search.set('to', params.to);
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

function kpiSearch(params: { locationId?: string; period?: KpiPeriod; from?: string; to?: string }): string {
  const search = new URLSearchParams();
  if (params.locationId) search.set('locationId', params.locationId);
  if (params.period) search.set('period', params.period);
  if (params.from) search.set('from', params.from);
  if (params.to) search.set('to', params.to);
  const query = search.toString();
  return query ? `?${query}` : '';
}

// Owner/manager: per-stylist KPI status (targets, rebooking, retail, average
// bill, and the commission unlock gate) for the selected period + location.
export async function getStylistKpis(
  accessToken: string,
  params: { locationId?: string; period?: KpiPeriod; from?: string; to?: string },
): Promise<StylistKpiListResponse> {
  return request<StylistKpiListResponse>(`/kpi/stylists${kpiSearch(params)}`, { accessToken });
}

// Stylist-facing: the caller's own KPI progress and unlock state.
export async function getMyKpi(
  accessToken: string,
  params: { period?: KpiPeriod; from?: string; to?: string } = {},
): Promise<StylistKpiResponse> {
  return request<StylistKpiResponse>(`/kpi/me${kpiSearch(params)}`, { accessToken });
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

export async function listLabDevices(accessToken: string): Promise<ListLabDevicesResponse> {
  return request<ListLabDevicesResponse>('/lab/device/list', { accessToken });
}

export async function revokeLabDevice(
  accessToken: string,
  payload: { deviceId: string },
): Promise<LabDeviceMutationResponse> {
  return request<LabDeviceMutationResponse>('/lab/device/revoke', {
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
    categoryId?: string | null;
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
  params: { locationId?: string; productId?: string; limit?: number; from?: string; to?: string } = {},
): Promise<ListInventoryMovementsResponse> {
  const search = new URLSearchParams();
  if (params.locationId) search.set('locationId', params.locationId);
  if (params.productId) search.set('productId', params.productId);
  if (params.limit) search.set('limit', String(params.limit));
  if (params.from) search.set('from', params.from);
  if (params.to) search.set('to', params.to);
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

export async function listInventoryCategories(
  accessToken: string,
  params: { q?: string; includeInactive?: boolean } = {},
): Promise<ListInventoryCategoriesResponse> {
  const search = new URLSearchParams();
  if (params.q) search.set('q', params.q);
  if (params.includeInactive) search.set('includeInactive', 'true');
  const query = search.toString();
  return request<ListInventoryCategoriesResponse>(`/inventory/categories${query ? `?${query}` : ''}`, { accessToken });
}

export async function createInventoryCategory(
  accessToken: string,
  payload: { name: string; description?: string | null; isActive?: boolean },
): Promise<InventoryCategoryResponse> {
  return request<InventoryCategoryResponse>('/inventory/categories', { method: 'POST', accessToken, body: payload });
}

export async function updateInventoryCategory(
  accessToken: string,
  categoryId: string,
  payload: { name?: string; description?: string | null; isActive?: boolean },
): Promise<InventoryCategoryResponse> {
  return request<InventoryCategoryResponse>(`/inventory/categories/${encodeURIComponent(categoryId)}`, {
    method: 'PATCH',
    accessToken,
    body: payload,
  });
}

export async function deleteInventoryCategory(
  accessToken: string,
  categoryId: string,
): Promise<InventoryCategoryResponse> {
  return request<InventoryCategoryResponse>(`/inventory/categories/${encodeURIComponent(categoryId)}`, {
    method: 'DELETE',
    accessToken,
  });
}

// --- Service categories -----------------------------------------------------

export async function listServiceCategories(
  accessToken: string,
  params: { q?: string; includeInactive?: boolean } = {},
): Promise<ListServiceCategoriesResponse> {
  const search = new URLSearchParams();
  if (params.q) search.set('q', params.q);
  if (params.includeInactive) search.set('includeInactive', 'true');
  const query = search.toString();
  return request<ListServiceCategoriesResponse>(`/services/categories${query ? `?${query}` : ''}`, { accessToken });
}

export async function createServiceCategory(
  accessToken: string,
  payload: CreateServiceCategoryRequest,
): Promise<ServiceCategoryResponse> {
  return request<ServiceCategoryResponse>('/services/categories', { method: 'POST', accessToken, body: payload });
}

export async function updateServiceCategory(
  accessToken: string,
  categoryId: string,
  payload: UpdateServiceCategoryRequest,
): Promise<ServiceCategoryResponse> {
  return request<ServiceCategoryResponse>(`/services/categories/${encodeURIComponent(categoryId)}`, {
    method: 'PATCH',
    accessToken,
    body: payload,
  });
}

export async function deleteServiceCategory(
  accessToken: string,
  categoryId: string,
): Promise<ServiceCategoryResponse> {
  return request<ServiceCategoryResponse>(`/services/categories/${encodeURIComponent(categoryId)}`, {
    method: 'DELETE',
    accessToken,
  });
}

/** Persist a new display order for service categories. `ids` is the full list in the desired order. */
export async function reorderServiceCategories(
  accessToken: string,
  ids: string[],
): Promise<ListServiceCategoriesResponse> {
  return request<ListServiceCategoriesResponse>('/services/categories/reorder', {
    method: 'PATCH',
    accessToken,
    body: { ids },
  });
}

// --- Services ---------------------------------------------------------------

export async function listServices(
  accessToken: string,
  params: { q?: string; serviceCategoryId?: string; locationId?: string; includeInactive?: boolean } = {},
): Promise<ListManagedServicesResponse> {
  const search = new URLSearchParams();
  if (params.q) search.set('q', params.q);
  if (params.serviceCategoryId) search.set('serviceCategoryId', params.serviceCategoryId);
  if (params.locationId) search.set('locationId', params.locationId);
  if (params.includeInactive) search.set('includeInactive', 'true');
  const query = search.toString();
  return request<ListManagedServicesResponse>(`/services${query ? `?${query}` : ''}`, { accessToken });
}

/** Active services with no bookable stylist assigned — drives the dashboard warning. */
export async function listUnassignedServices(
  accessToken: string,
): Promise<UnassignedServicesResponse> {
  return request<UnassignedServicesResponse>('/services/unassigned', { accessToken });
}

export async function createService(
  accessToken: string,
  payload: UpsertServiceRequest,
): Promise<ManagedServiceResponse> {
  return request<ManagedServiceResponse>('/services', { method: 'POST', accessToken, body: payload });
}

export async function updateService(
  accessToken: string,
  serviceId: string,
  payload: UpsertServiceRequest,
): Promise<ManagedServiceResponse> {
  return request<ManagedServiceResponse>(`/services/${encodeURIComponent(serviceId)}`, {
    method: 'PATCH',
    accessToken,
    body: payload,
  });
}

export async function archiveService(
  accessToken: string,
  serviceId: string,
): Promise<ManagedServiceResponse> {
  return request<ManagedServiceResponse>(`/services/${encodeURIComponent(serviceId)}/archive`, {
    method: 'POST',
    accessToken,
  });
}

/** Persist a new display order for services. `ids` is the full list in the desired order. */
export async function reorderServices(
  accessToken: string,
  ids: string[],
): Promise<ListManagedServicesResponse> {
  return request<ListManagedServicesResponse>('/services/reorder', {
    method: 'PATCH',
    accessToken,
    body: { ids },
  });
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

// -------------------- Account deletion (public; App Store Guideline 5.1.1(v)) --------------------

// Authenticates a client for self-service account deletion. Uses the `sheer_app`
// surface — the same one the qlooqo mobile app signs in with — because the
// `web_dashboard` surface rejects client logins (see assertSurfaceAccess in the
// API). The returned access token is used only to call deleteMyAccount below.
export async function signInForAccountDeletion(input: LoginInput): Promise<LoginResponse> {
  return request<LoginResponse>('/auth/login', {
    method: 'POST',
    body: { ...input, surface: 'sheer_app' },
  });
}

// Permanently deletes the signed-in caller's own account. The API restricts this
// to client accounts (DELETE /profiles/me → 403 for staff/owner/manager).
export async function deleteMyAccount(accessToken: string): Promise<void> {
  await request<void>('/profiles/me', { method: 'DELETE', accessToken });
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

// -------------------- Account tier (owner / manager) --------------------

export async function getAccount(accessToken: string): Promise<GetAccountResponse> {
  return request<GetAccountResponse>('/owner/account', { accessToken });
}

export async function updateAccountTier(
  accessToken: string,
  payload: UpdateAccountTierRequest,
): Promise<UpdateAccountTierResponse> {
  return request<UpdateAccountTierResponse>('/owner/account/tier', {
    method: 'PATCH',
    body: payload,
    accessToken,
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

export async function updateLocationCommunicationSettings(
  accessToken: string,
  payload: UpdateLocationCommunicationSettingsRequest,
): Promise<LocationCommunicationSettings> {
  const result = await request<LocationCommunicationSettingsResponse>('/owner/booking-settings/communication', {
    method: 'PUT',
    accessToken,
    body: payload,
  });
  return result.settings;
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

// -------------------- Product auto-billing settings --------------------

export async function getLocationProductBillingSettings(
  accessToken: string,
  locationId: string,
): Promise<GetLocationProductBillingSettingsResponse> {
  return request<GetLocationProductBillingSettingsResponse>(
    `/owner/billing-settings/product?locationId=${encodeURIComponent(locationId)}`,
    { accessToken },
  );
}

export async function updateLocationProductBillingSettings(
  accessToken: string,
  payload: UpdateLocationProductBillingSettingsRequest,
): Promise<UpdateLocationProductBillingSettingsResponse> {
  return request<UpdateLocationProductBillingSettingsResponse>(
    '/owner/billing-settings/product',
    { method: 'PATCH', body: payload, accessToken },
  );
}

// -------------------- Tax configuration settings --------------------

export async function getLocationTaxSettings(
  accessToken: string,
  locationId: string,
): Promise<GetLocationTaxSettingsResponse> {
  return request<GetLocationTaxSettingsResponse>(
    `/owner/tax-settings?locationId=${encodeURIComponent(locationId)}`,
    { accessToken },
  );
}

export async function updateLocationTaxSettings(
  accessToken: string,
  payload: UpdateLocationTaxSettingsRequest,
): Promise<UpdateLocationTaxSettingsResponse> {
  return request<UpdateLocationTaxSettingsResponse>('/owner/tax-settings', {
    method: 'PATCH',
    body: payload,
    accessToken,
  });
}

// -------------------- Cancellation policy (owner + manager) --------------------

export async function getCancellationPolicy(
  accessToken: string,
  locationId: string,
): Promise<GetCancellationPolicyResponse> {
  return request<GetCancellationPolicyResponse>(
    `/owner/cancellation-policy?locationId=${encodeURIComponent(locationId)}`,
    { accessToken },
  );
}

export async function updateCancellationPolicy(
  accessToken: string,
  payload: UpdateCancellationPolicyRequest,
): Promise<UpdateCancellationPolicyResponse> {
  return request<UpdateCancellationPolicyResponse>('/owner/cancellation-policy', {
    method: 'PATCH',
    body: payload,
    accessToken,
  });
}

// -------------------- Location record settings & fixed costs --------------------

export async function getLocationRecordSettings(
  accessToken: string,
  locationId: string,
): Promise<LocationRecordSettingsResponse> {
  return request<LocationRecordSettingsResponse>(
    `/owner/location-settings?locationId=${encodeURIComponent(locationId)}`,
    { accessToken },
  );
}

export async function updateLocationRecordSettings(
  accessToken: string,
  payload: UpdateLocationRecordSettingsRequest,
): Promise<LocationRecordSettingsResponse> {
  return request<LocationRecordSettingsResponse>('/owner/location-settings', {
    method: 'PATCH',
    body: payload,
    accessToken,
  });
}

export async function listLocationFixedCosts(
  accessToken: string,
  locationId: string,
): Promise<ListLocationFixedCostsResponse> {
  return request<ListLocationFixedCostsResponse>(
    `/owner/location-settings/fixed-costs?locationId=${encodeURIComponent(locationId)}`,
    { accessToken },
  );
}

export async function getEffectiveFixedCosts(
  accessToken: string,
  params: { locationId: string; date?: string },
): Promise<EffectiveFixedCostsResponse> {
  const search = new URLSearchParams({ locationId: params.locationId });
  if (params.date) search.set('date', params.date);
  return request<EffectiveFixedCostsResponse>(
    `/owner/location-settings/fixed-costs/effective?${search.toString()}`,
    { accessToken },
  );
}

export async function createLocationFixedCost(
  accessToken: string,
  payload: CreateLocationFixedCostRequest,
): Promise<LocationFixedCostResponse> {
  return request<LocationFixedCostResponse>('/owner/location-settings/fixed-costs', {
    method: 'POST',
    body: payload,
    accessToken,
  });
}

export async function updateLocationFixedCost(
  accessToken: string,
  id: string,
  payload: UpdateLocationFixedCostRequest,
): Promise<LocationFixedCostResponse> {
  return request<LocationFixedCostResponse>(
    `/owner/location-settings/fixed-costs/${encodeURIComponent(id)}`,
    { method: 'PATCH', body: payload, accessToken },
  );
}

export async function deleteLocationFixedCost(
  accessToken: string,
  id: string,
): Promise<void> {
  return request<void>(`/owner/location-settings/fixed-costs/${encodeURIComponent(id)}`, {
    method: 'DELETE',
    accessToken,
  });
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
