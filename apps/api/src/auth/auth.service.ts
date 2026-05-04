import { ForbiddenException, Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type {
  AppSurface,
  AuthLocation,
  AuthSession,
  AuthUser,
  LoginResponse,
  UserRole,
} from '@sheer/domain';

type RuntimeSurface = Extract<AppSurface, 'api' | 'web_dashboard' | 'sheer_app'>;

interface ProfileRow {
  id: string;
  email: string;
  full_name: string;
  avatar_url: string | null;
}

interface MembershipRow {
  business_id: string;
  location_id: string | null;
  role: UserRole;
  status: string;
}

interface BusinessRow {
  id: string;
  name: string;
  slug: string;
}

interface LocationRow {
  id: string;
  name: string;
  code: string | null;
  slug: string | null;
  is_active: boolean;
}

interface StaffProfileRow {
  id: string;
}

interface ClientProfileRow {
  id: string;
}

const ROLE_PRIORITY: Record<UserRole, number> = {
  owner: 0,
  manager: 1,
  stylist: 2,
  client: 3,
};

@Injectable()
export class AuthService {
  private readonly supabaseUrl: string;
  private readonly anonKey: string;
  private readonly anon: SupabaseClient;
  private readonly admin: SupabaseClient;

  constructor(config: ConfigService) {
    this.supabaseUrl = config.getOrThrow<string>('SUPABASE_URL');
    this.anonKey = config.getOrThrow<string>('SUPABASE_ANON_KEY');
    const serviceRoleKey = config.getOrThrow<string>('SUPABASE_SERVICE_ROLE_KEY');

    this.anon = createClient(this.supabaseUrl, this.anonKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
    this.admin = createClient(this.supabaseUrl, serviceRoleKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
  }

  async login(email: string, password: string, surface: RuntimeSurface = 'api'): Promise<LoginResponse> {
    const { data, error } = await this.anon.auth.signInWithPassword({
      email,
      password,
    });

    if (error || !data.user || !data.session) {
      throw new UnauthorizedException('Invalid email or password');
    }

    const user = await this.resolveAuthUser(data.user.id);
    this.assertSurfaceAccess(user, surface);

    return {
      session: this.toAuthSession(data.session),
      user,
    };
  }

  async refresh(refreshToken: string, surface: RuntimeSurface = 'api'): Promise<LoginResponse> {
    const { data, error } = await this.anon.auth.refreshSession({
      refresh_token: refreshToken,
    });

    if (error || !data.user || !data.session) {
      throw new UnauthorizedException('Session refresh failed');
    }

    const user = await this.resolveAuthUser(data.user.id);
    this.assertSurfaceAccess(user, surface);

    return {
      session: this.toAuthSession(data.session),
      user,
    };
  }

  async logout(accessToken?: string, refreshToken?: string): Promise<void> {
    if (accessToken && refreshToken) {
      const sessionClient = createClient(this.supabaseUrl, this.anonKey, {
        auth: { autoRefreshToken: false, persistSession: false },
      });

      await sessionClient.auth.setSession({
        access_token: accessToken,
        refresh_token: refreshToken,
      });
      await sessionClient.auth.signOut();
      return;
    }

    if (accessToken) {
      await this.admin.auth.admin.signOut(accessToken, 'global');
    }
  }

  async verifyAccessToken(accessToken: string): Promise<AuthUser> {
    const { data, error } = await this.anon.auth.getUser(accessToken);
    if (error || !data.user) {
      throw new UnauthorizedException('Invalid or expired session');
    }

    return this.resolveAuthUser(data.user.id);
  }

  async resolveAuthUser(userId: string): Promise<AuthUser> {
    const [profile, memberships] = await Promise.all([
      this.fetchProfile(userId),
      this.fetchMemberships(userId),
    ]);

    const activeMemberships = memberships.filter((m) => m.status === 'active');
    if (activeMemberships.length === 0) {
      throw new ForbiddenException('User has no active business membership');
    }

    const primaryMembership = [...activeMemberships].sort(
      (a, b) => ROLE_PRIORITY[a.role] - ROLE_PRIORITY[b.role],
    )[0];
    const sameBusinessMemberships = activeMemberships.filter(
      (m) => m.business_id === primaryMembership.business_id,
    );

    const [business, businessLocations, staffProfile, clientProfile] = await Promise.all([
      this.fetchBusiness(primaryMembership.business_id),
      this.fetchLocations(primaryMembership.business_id),
      this.fetchStaffProfile(primaryMembership.business_id, userId),
      this.fetchClientProfile(primaryMembership.business_id, userId),
    ]);

    const allowedLocationIds = this.resolveAllowedLocationIds(
      primaryMembership.role,
      sameBusinessMemberships,
      businessLocations,
    );
    const visibleLocations = businessLocations.filter((location) =>
      allowedLocationIds.includes(location.id),
    );

    await this.admin
      .schema('core')
      .from('user_profiles')
      .update({ last_seen_at: new Date().toISOString() })
      .eq('id', userId);

    return {
      id: profile.id,
      role: primaryMembership.role,
      businessId: business.id,
      businessName: business.name,
      businessSlug: business.slug,
      allowedLocationIds,
      locationScope:
        primaryMembership.role === 'owner'
          ? { kind: 'all', locationIds: allowedLocationIds }
          : primaryMembership.role === 'stylist' || primaryMembership.role === 'client'
            ? { kind: 'self', locationIds: allowedLocationIds }
            : { kind: 'locations', locationIds: allowedLocationIds },
      locations: visibleLocations.map((location) => ({
        id: location.id,
        name: location.name,
        code: location.code ?? undefined,
        slug: location.slug ?? undefined,
      })),
      profile: {
        id: profile.id,
        email: profile.email,
        fullName: profile.full_name,
        avatarUrl: profile.avatar_url ?? undefined,
      },
      staffProfileId: staffProfile?.id,
      clientProfileId: clientProfile?.id,
    };
  }

  canAccessLocation(user: AuthUser, locationId: string): boolean {
    return user.role === 'owner' || user.allowedLocationIds.includes(locationId);
  }

  canAccessOwnStaffProfile(user: AuthUser, staffProfileId: string): boolean {
    return user.role === 'owner' || user.role === 'manager' || user.staffProfileId === staffProfileId;
  }

  private assertSurfaceAccess(user: AuthUser, surface: RuntimeSurface): void {
    if (surface === 'web_dashboard' && user.role !== 'owner' && user.role !== 'manager') {
      throw new ForbiddenException('Web dashboard access is limited to owners and managers');
    }

    if (surface === 'sheer_app' && user.role !== 'stylist') {
      throw new ForbiddenException('Sheer App access is limited to stylist accounts');
    }
  }

  private resolveAllowedLocationIds(
    role: UserRole,
    memberships: MembershipRow[],
    businessLocations: LocationRow[],
  ): string[] {
    if (role === 'owner') {
      return businessLocations.filter((l) => l.is_active).map((l) => l.id);
    }

    return [
      ...new Set(
        memberships
          .filter((m) => m.role === role && m.location_id)
          .map((m) => m.location_id as string),
      ),
    ];
  }

  private async fetchProfile(userId: string): Promise<ProfileRow> {
    const { data, error } = await this.admin
      .schema('core')
      .from('user_profiles')
      .select('id,email,full_name,avatar_url')
      .eq('id', userId)
      .single<ProfileRow>();

    if (error || !data) {
      throw new ForbiddenException('User profile is not configured');
    }

    return data;
  }

  private async fetchMemberships(userId: string): Promise<MembershipRow[]> {
    const { data, error } = await this.admin
      .schema('core')
      .from('user_memberships')
      .select('business_id,location_id,role,status')
      .eq('user_profile_id', userId)
      .returns<MembershipRow[]>();

    if (error) {
      throw new ForbiddenException('Unable to resolve user memberships');
    }

    return data ?? [];
  }

  private async fetchBusiness(businessId: string): Promise<BusinessRow> {
    const { data, error } = await this.admin
      .schema('core')
      .from('businesses')
      .select('id,name,slug')
      .eq('id', businessId)
      .single<BusinessRow>();

    if (error || !data) {
      throw new ForbiddenException('Business is not configured');
    }

    return data;
  }

  private async fetchLocations(businessId: string): Promise<LocationRow[]> {
    const { data, error } = await this.admin
      .schema('core')
      .from('locations')
      .select('id,name,code,slug,is_active')
      .eq('business_id', businessId)
      .order('sort_order', { ascending: true })
      .returns<LocationRow[]>();

    if (error) {
      throw new ForbiddenException('Unable to resolve location scope');
    }

    return data ?? [];
  }

  private async fetchStaffProfile(
    businessId: string,
    userId: string,
  ): Promise<StaffProfileRow | undefined> {
    const { data, error } = await this.admin
      .schema('core')
      .from('staff_profiles')
      .select('id')
      .eq('business_id', businessId)
      .eq('user_profile_id', userId)
      .maybeSingle<StaffProfileRow>();

    if (error) {
      throw new ForbiddenException('Unable to resolve staff profile');
    }

    return data ?? undefined;
  }

  private async fetchClientProfile(
    businessId: string,
    userId: string,
  ): Promise<ClientProfileRow | undefined> {
    const { data, error } = await this.admin
      .schema('core')
      .from('client_profiles')
      .select('id')
      .eq('business_id', businessId)
      .eq('user_profile_id', userId)
      .maybeSingle<ClientProfileRow>();

    if (error) {
      throw new ForbiddenException('Unable to resolve client profile');
    }

    return data ?? undefined;
  }

  private toAuthSession(session: {
    access_token: string;
    refresh_token: string;
    expires_at?: number;
  }): AuthSession {
    return {
      accessToken: session.access_token,
      refreshToken: session.refresh_token,
      expiresAt: session.expires_at ? new Date(session.expires_at * 1000).toISOString() : undefined,
    };
  }
}
