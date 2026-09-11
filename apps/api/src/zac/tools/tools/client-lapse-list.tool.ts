import type { AuthUser, ListClientLapseResponse } from '@sheer/domain';
import type { ClientIntelligenceService } from '../../../client-intelligence/client-intelligence.service';
import type { ZacActingContext } from '../../context/zac-context.types';
import type { ZacReadOnlyTool, ZacToolResult } from '../zac-tool.types';

/**
 * The default page of names. 25 is `DEFAULT_PAGE_SIZE` in the guarded service;
 * its hard cap is 100. Sorting there is total and stable — most overdue first,
 * then display name, then client id — so "the first 25" is deterministic and is
 * the 25 that actually matter.
 */
const NAMED_PAGE_SIZE = 25;

type LapseCohort = 'lapsed' | 'at_risk';

/**
 * NAMES THE CLIENTS BEHIND THE RETENTION COUNTS.
 *
 * `report.client_retention` stays counts-only and keeps its identity-free
 * guarantee; this is a SEPARATE tool so that guarantee survives. Both call the
 * same guarded service with the same gate — the difference is page size, and
 * what the answer is allowed to contain.
 *
 * THE GATE. `crm.view` plus base role owner or manager. `crm.view` IS QLOOQO's
 * client-record read permission and is all-or-nothing over name, email and
 * phone: the CRM mapper takes no actor and strips nothing, so anyone holding it
 * can already read these people's contact details through the HTTP API today.
 * `crm.manage` is deliberately NOT used — every one of its usages sits on a POST
 * or PATCH, so gating a read behind it would tie reading to an edit grant.
 * The service additionally refuses stylists on its own (assertIntelligenceAccess
 * checks ROLE only, not permission), which is why `allowedRoles` must stay
 * owner/manager rather than relying on the permission alone.
 *
 * WHY NAMES ARE NOT IN `answer`. `presentation.answer` travels to two places a
 * client name must never reach:
 *
 *   1. the evidence pack sent to the model provider — a third party — where the
 *      grounding guard could not protect them anyway, because it compares only
 *      NUMBERS and would happily pass a misspelled or invented name;
 *   2. `zac.outputs.body_redacted`, whose redactor has patterns for emails,
 *      tokens and digit runs but none for names, and whose read path re-checks
 *      no client permission.
 *
 * So the identities go on `identityDisclosure`, which the response builder
 * appends to the WIRE answer only. The stored form stays the counts sentence:
 * complete, honest, and free of names.
 *
 * CONTACT DETAILS ARE OMITTED ENTIRELY — name and client code only. The
 * repository's own precedent for a bulk audience is the campaign preview, which
 * masks contacts even for an owner whose whole purpose is to message them:
 * recognisable, not exportable. A lapsed list is bulk-audience shaped.
 *
 * NOT A CONTACTABLE AUDIENCE. The lapse row carries `marketingOptIn`, but the
 * domain is explicit that it is not a consent decision at this layer, and GDPR
 * state is absent from the row entirely — a named client here could have a
 * pending erasure request and nothing in the payload would say so. The next
 * step therefore points at Campaigns, which applies consent and suppression
 * itself.
 */
export class ClientLapseListTool implements ZacReadOnlyTool {
  readonly name = 'report.client_lapse_list' as const;
  readonly domain = 'report' as const;
  readonly description =
    'Names the clients behind the retention counts, for an actor whose access covers client records.';
  readonly allowedRoles = ['owner', 'manager'] as const;
  readonly requiredPermissions = ['crm.view'] as const;
  readonly anyOfPermissions = [] as const;
  readonly inputSchema = {
    type: 'object',
    properties: { cohort: { type: 'string', enum: ['lapsed', 'at_risk'] } },
    additionalProperties: true,
  };
  readonly outputSchema = {
    type: 'object',
    description:
      'Cohort, how many were named and the cohort total. Never the identities themselves — those travel only on the answer.',
  };
  readonly readOnly = true as const;
  /** Declarative only; the masking below is what actually holds. */
  readonly sensitiveFields = ['email', 'phone'] as const;
  readonly errorBehavior = 'fail_closed' as const;
  readonly fallbackBehavior = 'state_unavailable' as const;
  readonly piiLevel = 'high' as const;
  readonly cachePolicy = { ttlSeconds: 0, perTenant: true } as const;
  readonly rateLimit = { perMinute: 6 } as const;
  readonly requiresStaffSelf = false;
  readonly enabled = true;

  constructor(private readonly clientIntelligence: ClientIntelligenceService) {}

  async execute(
    actor: AuthUser,
    context: ZacActingContext,
    input: Record<string, unknown>,
  ): Promise<ZacToolResult> {
    const cohort: LapseCohort = input['cohort'] === 'at_risk' ? 'at_risk' : 'lapsed';
    const label = cohort === 'at_risk' ? 'overdue' : 'lapsed';

    let lapse: ListClientLapseResponse;
    try {
      lapse = await this.clientIntelligence.listLapsedClients(actor, {
        locationId: context.locationId ?? undefined,
        // Filtering server-side means we never page the whole client book to
        // find this cohort, and `pagination.total` is then the true size of the
        // FILTERED cohort rather than of everyone evaluated.
        status: [cohort],
        page: 1,
        pageSize: NAMED_PAGE_SIZE,
      } as never);
    } catch {
      return {
        status: 'unavailable',
        data: null,
        explanation: `I could not read your ${label} clients just now, so I have no list to show.`,
        rowCount: null,
      };
    }

    const clients = lapse.clients ?? [];
    const cohortTotal = lapse.pagination?.total ?? clients.length;

    if (clients.length === 0) {
      return {
        status: 'ok',
        data: { cohort, named_count: 0, cohort_total: 0 },
        explanation: `No clients are currently ${label}.`,
        rowCount: 0,
        presentation: {
          answer: `No clients are currently ${label}, so there is nobody to name.`,
          evidence: [this.evidence()],
          confidence: 'high',
          limitations: [
            'Retention is measured as it stands today; this is not a historical reconstruction.',
          ],
          suggestedNextStep: 'Ask "How many clients have lapsed?" for the full retention picture.',
          responseType: 'Explanation',
        },
      };
    }

    // The block is built HERE, deterministically, and never by a model. A model
    // handed these names could drop, merge, misspell or invent one, and the
    // grounding guard compares only numbers, so nothing downstream would catch it.
    const named = clients.map((c) => {
      const name = c.displayName?.trim() || `${c.firstName ?? ''} ${c.lastName ?? ''}`.trim();
      return c.clientCode ? `${name} (${c.clientCode})` : name;
    });
    const partialList = cohortTotal > named.length;
    const block = [
      partialList
        ? `Showing the ${named.length} most overdue of ${cohortTotal} ${label} clients:`
        : `The ${named.length} ${label} ${named.length === 1 ? 'client is' : 'clients are'}:`,
      named.join(', ') + '.',
    ].join(' ');

    const counts = lapse.counts;

    // THE OTHER COHORT. Naming the lapsed and staying silent about the overdue
    // hands back the half that is hardest to act on: a lapsed client has
    // already gone past their normal return point, while an overdue one is
    // drifting and still reachable. Answering only the question asked would be
    // technically correct and commercially useless, so the other group is
    // named as a count and offered — never disclosed unasked.
    const otherCohort = cohort === 'lapsed' ? 'at_risk' : 'lapsed';
    const otherCount = counts
      ? otherCohort === 'at_risk'
        ? counts.atRisk
        : counts.lapsed
      : 0;
    const otherPointer =
      otherCount > 0
        ? otherCohort === 'at_risk'
          ? `${otherCount} more ${otherCount === 1 ? 'client is' : 'clients are'} overdue but not yet lapsed — ask "who is overdue?" to see them.`
          : `${otherCount} more ${otherCount === 1 ? 'client has' : 'clients have'} already lapsed — ask "who has lapsed?" to see them.`
        : null;

    const answer = [
      `${cohortTotal} ${cohortTotal === 1 ? 'client is' : 'clients are'} ${label}${
        counts ? ` out of ${counts.active + counts.atRisk + counts.lapsed} I can judge` : ''
      }.`,
      partialList
        ? `I have named the ${named.length} most overdue.`
        : `I have named ${named.length === 1 ? 'them' : 'them all'} for you.`,
      ...(otherPointer ? [otherPointer] : []),
    ].join(' ');

    return {
      status: 'ok',
      data: {
        cohort,
        named_count: named.length,
        cohort_total: cohortTotal,
        // Deliberately no `clients` array, no name, no code, no contact detail.
        // `data` feeds evidence normalisation and the signal framework, both of
        // which must stay identity-free by construction rather than by review.
        counts_partial: lapse.truncated === true,
      },
      explanation:
        'Read from your client intelligence service with your own permissions and location scope.',
      rowCount: named.length,
      presentation: {
        answer,
        identityDisclosure: { block, namedCount: named.length, cohortTotal },
        evidence: [this.evidence()],
        confidence: lapse.truncated === true ? 'medium' : 'high',
        limitations: [
          'Names and client codes only — contact details are on the client record in QLOOQO, not here.',
          `"${label === 'lapsed' ? 'Lapsed' : 'Overdue'}" is measured against each client's own usual visit gap plus your grace period, not a fixed calendar rule.`,
          partialList
            ? `${cohortTotal - named.length} more ${label} clients are not named above; the ${named.length} shown are the most overdue.`
            : 'Every client in this cohort is named above.',
          ...(lapse.truncated === true
            ? ['The evaluated scope hit the platform cap, so the totals may be understated.']
            : []),
          'Retention is measured as it stands today; this is not a historical reconstruction.',
        ],
        // Consent and suppression are applied by Campaigns, not here — this row
        // does not even carry GDPR state, so it must not be treated as a
        // contactable audience.
        suggestedNextStep:
          'Build a win-back campaign from these — Campaigns applies your marketing consent and suppression rules, which this list does not.',
        responseType: 'Opportunity',
      },
    };
  }

  private evidence() {
    return {
      source_type: 'crm.client_intelligence',
      source_ref: 'ClientIntelligenceService.listLapsedClients',
      as_of: null,
      // Stays EMPTY. The column is persisted unredacted and its own contract
      // says safe handles only; nothing reads it today, so codes here would buy
      // nothing and cost a second copy of the identities.
      entities_used: [],
    };
  }
}
