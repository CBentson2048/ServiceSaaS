import { Body, Controller, Get, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import type {
  AuthUser,
  CrmClientDetailResponse,
  CrmClientSummary,
  CrmVisitPhoto,
  ListCrmClientAllergiesResponse,
  ListCrmClientMessagesResponse,
  ListCrmClientNotesResponse,
  ListCrmClientPatchTestsResponse,
  ListCrmClientVisitsResponse,
  ListCrmClientsResponse,
  ListCrmVisitPhotosResponse,
} from '@sheer/domain';
import { CurrentUser } from '../auth/current-user.decorator';
import { PermissionsGuard, RequirePermissions } from '../auth/permissions.guard';
import { RequireRoles, RolesGuard } from '../auth/roles.guard';
import { SupabaseAuthGuard } from '../auth/supabase-auth.guard';
import {
  CreateCrmAllergyDto,
  CreateCrmClientDto,
  CreateCrmNoteDto,
  CreateCrmPatchTestDto,
  CreateCrmVisitPhotoDto,
  ListCrmClientsQueryDto,
  UpdateCrmClientDto,
} from './dto';
import { CrmService } from './crm.service';

@Controller('crm')
@UseGuards(SupabaseAuthGuard, RolesGuard, PermissionsGuard)
@RequireRoles('owner', 'manager', 'stylist')
@RequirePermissions('crm.view')
export class CrmController {
  constructor(private readonly crm: CrmService) {}

  @Get('clients')
  listClients(
    @CurrentUser() actor: AuthUser,
    @Query() query: ListCrmClientsQueryDto,
  ): Promise<ListCrmClientsResponse> {
    return this.crm.listClients(actor, query);
  }

  @Post('clients')
  @RequirePermissions('crm.manage')
  createClient(
    @CurrentUser() actor: AuthUser,
    @Body() body: CreateCrmClientDto,
  ): Promise<{ client: CrmClientSummary }> {
    return this.crm.createClient(actor, body);
  }

  @Get('clients/:id')
  getClient(
    @CurrentUser() actor: AuthUser,
    @Param('id') id: string,
  ): Promise<CrmClientDetailResponse> {
    return this.crm.getClientDetail(actor, id);
  }

  @Patch('clients/:id')
  @RequirePermissions('crm.manage')
  updateClient(
    @CurrentUser() actor: AuthUser,
    @Param('id') id: string,
    @Body() body: UpdateCrmClientDto,
  ): Promise<{ client: CrmClientSummary }> {
    return this.crm.updateClient(actor, id, body);
  }

  @Get('clients/:id/visits')
  listVisits(
    @CurrentUser() actor: AuthUser,
    @Param('id') id: string,
  ): Promise<ListCrmClientVisitsResponse> {
    return this.crm.listVisits(actor, id);
  }

  @Get('clients/:id/notes')
  listNotes(
    @CurrentUser() actor: AuthUser,
    @Param('id') id: string,
  ): Promise<ListCrmClientNotesResponse> {
    return this.crm.listNotes(actor, id);
  }

  @Post('clients/:id/notes')
  @RequirePermissions('crm.manage')
  createNote(
    @CurrentUser() actor: AuthUser,
    @Param('id') id: string,
    @Body() body: CreateCrmNoteDto,
  ): Promise<ListCrmClientNotesResponse> {
    return this.crm.createNote(actor, id, body);
  }

  @Get('clients/:id/allergies')
  listAllergies(
    @CurrentUser() actor: AuthUser,
    @Param('id') id: string,
  ): Promise<ListCrmClientAllergiesResponse> {
    return this.crm.listAllergies(actor, id);
  }

  @Post('clients/:id/allergies')
  @RequirePermissions('crm.manage')
  createAllergy(
    @CurrentUser() actor: AuthUser,
    @Param('id') id: string,
    @Body() body: CreateCrmAllergyDto,
  ): Promise<ListCrmClientAllergiesResponse> {
    return this.crm.createAllergy(actor, id, body);
  }

  @Get('clients/:id/patch-tests')
  listPatchTests(
    @CurrentUser() actor: AuthUser,
    @Param('id') id: string,
  ): Promise<ListCrmClientPatchTestsResponse> {
    return this.crm.listPatchTests(actor, id);
  }

  @Post('clients/:id/patch-tests')
  @RequirePermissions('crm.manage')
  createPatchTest(
    @CurrentUser() actor: AuthUser,
    @Param('id') id: string,
    @Body() body: CreateCrmPatchTestDto,
  ): Promise<ListCrmClientPatchTestsResponse> {
    return this.crm.createPatchTest(actor, id, body);
  }

  @Get('clients/:id/messages')
  listMessages(
    @CurrentUser() actor: AuthUser,
    @Param('id') id: string,
  ): Promise<ListCrmClientMessagesResponse> {
    return this.crm.listMessages(actor, id);
  }

  @Get('clients/:id/summary')
  summary(
    @CurrentUser() actor: AuthUser,
    @Param('id') id: string,
  ): Promise<CrmClientDetailResponse> {
    return this.crm.getClientDetail(actor, id);
  }

  @Get('visits/:visitId/photos')
  listVisitPhotos(
    @CurrentUser() actor: AuthUser,
    @Param('visitId') visitId: string,
  ): Promise<ListCrmVisitPhotosResponse> {
    return this.crm.listVisitPhotos(actor, visitId);
  }

  @Post('visits/:visitId/photos')
  @RequirePermissions('crm.manage')
  createVisitPhoto(
    @CurrentUser() actor: AuthUser,
    @Param('visitId') visitId: string,
    @Body() body: CreateCrmVisitPhotoDto,
  ): Promise<{ photo: CrmVisitPhoto }> {
    return this.crm.createVisitPhoto(actor, visitId, body);
  }
}
