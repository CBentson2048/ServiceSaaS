import { ForbiddenException, Injectable } from '@nestjs/common';
import type { ZacRoleContext } from '../context/zac-context.types';
import type { ZacRoleProfile } from './zac-role-profile.types';

const ROLE_PROFILES: Record<ZacRoleContext, ZacRoleProfile> = {
  owner: {
    key: 'owner',
    displayName: 'Owner',
    dataScope: 'business',
    scopeDescription: 'Business-wide, across every location the business owns.',
    leadResponseTypes: ['Insight', 'Opportunity', 'Risk', 'Watch Point'],
    systemPromptSeed:
      'You are ZAC, the salon intelligence assistant, answering for the business owner. ' +
      'Speak to business-wide revenue and activity health. Every number must come from a ' +
      'permission-checked tool; state limitations plainly and never invent data.',
  },
  manager: {
    key: 'manager',
    displayName: 'Manager',
    dataScope: 'locations',
    scopeDescription: 'Limited to the locations the manager is assigned to.',
    leadResponseTypes: ['Insight', 'Watch Point', 'Coaching Point'],
    systemPromptSeed:
      'You are ZAC, the salon intelligence assistant, answering for a location manager. ' +
      'Stay inside the assigned locations and name which locations an answer aggregates. ' +
      'Every number must come from a permission-checked tool; state limitations plainly ' +
      'and never invent data.',
  },
  stylist: {
    key: 'stylist',
    displayName: 'Stylist',
    dataScope: 'self',
    scopeDescription: 'The acting stylist only — never colleagues or business financials.',
    leadResponseTypes: ['Coaching Point', 'Explanation'],
    systemPromptSeed:
      'You are ZAC, a supportive coach for an individual stylist. Discuss only their own ' +
      'work: no colleague comparisons, no shaming, no pay or employment judgements. Every ' +
      'number must come from a permission-checked tool; state limitations plainly and ' +
      'never invent data.',
  },
};

@Injectable()
export class ZacRoleProfileService {
  /**
   * Map the resolved role context to its profile. Owner > manager > stylist is
   * decided by the context resolver; client roles never reach here (guards +
   * resolver both fail closed).
   */
  selectFor(roleContext: ZacRoleContext): ZacRoleProfile {
    const profile = ROLE_PROFILES[roleContext];
    if (!profile) {
      throw new ForbiddenException('ZAC is not available for this role');
    }
    return profile;
  }
}
