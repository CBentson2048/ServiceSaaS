/**
 * Roles available across the Sheer Platform.
 * Keep this list aligned with Supabase RLS policies in `database/policies`.
 */
export type UserRole =
  | 'owner'
  | 'manager'
  | 'stylist'
  | 'client';

export interface UserProfile {
  id: string;
  email: string;
  fullName: string;
  role: UserRole;
  primaryLocationId?: string;
}
