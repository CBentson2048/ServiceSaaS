import { Body, Controller, Delete, Get, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import type {
  AuthUser,
  ListManagedServicesResponse,
  ListServiceCategoriesResponse,
  ManagedServiceResponse,
  ServiceCategoryResponse,
  UnassignedServicesResponse,
} from '@sheer/domain';
import { CurrentUser } from '../auth/current-user.decorator';
import { RequireRoles, RolesGuard } from '../auth/roles.guard';
import { SupabaseAuthGuard } from '../auth/supabase-auth.guard';
import {
  CreateServiceCategoryDto,
  ReorderDto,
  ServiceCategoryQueryDto,
  ServiceQueryDto,
  UpdateServiceCategoryDto,
  UpsertServiceDto,
} from './dto';
import { ServicesService } from './services.service';

@Controller('services')
@UseGuards(SupabaseAuthGuard, RolesGuard)
@RequireRoles('owner', 'manager')
export class ServicesController {
  constructor(private readonly services: ServicesService) {}

  // --- Service categories ---------------------------------------------------

  @Get('categories')
  listCategories(
    @CurrentUser() actor: AuthUser,
    @Query() query: ServiceCategoryQueryDto,
  ): Promise<ListServiceCategoriesResponse> {
    return this.services.listCategories(actor, query);
  }

  @Post('categories')
  createCategory(
    @CurrentUser() actor: AuthUser,
    @Body() dto: CreateServiceCategoryDto,
  ): Promise<ServiceCategoryResponse> {
    return this.services.createCategory(actor, dto);
  }

  // Declared before `categories/:id` so "reorder" is not matched as an id.
  @Patch('categories/reorder')
  reorderCategories(
    @CurrentUser() actor: AuthUser,
    @Body() dto: ReorderDto,
  ): Promise<ListServiceCategoriesResponse> {
    return this.services.reorderCategories(actor, dto.ids);
  }

  @Patch('categories/:id')
  updateCategory(
    @CurrentUser() actor: AuthUser,
    @Param('id') id: string,
    @Body() dto: UpdateServiceCategoryDto,
  ): Promise<ServiceCategoryResponse> {
    return this.services.updateCategory(actor, id, dto);
  }

  @Delete('categories/:id')
  deleteCategory(@CurrentUser() actor: AuthUser, @Param('id') id: string): Promise<ServiceCategoryResponse> {
    return this.services.deleteCategory(actor, id);
  }

  // --- Services -------------------------------------------------------------

  @Get()
  listServices(@CurrentUser() actor: AuthUser, @Query() query: ServiceQueryDto): Promise<ListManagedServicesResponse> {
    return this.services.listServices(actor, query);
  }

  // Services with no bookable stylist assigned — drives the dashboard warning.
  @Get('unassigned')
  listUnassignedServices(@CurrentUser() actor: AuthUser): Promise<UnassignedServicesResponse> {
    return this.services.listServicesMissingStaff(actor);
  }

  @Post()
  createService(@CurrentUser() actor: AuthUser, @Body() dto: UpsertServiceDto): Promise<ManagedServiceResponse> {
    return this.services.createService(actor, dto);
  }

  // Declared before `:id` so "reorder" is not matched as a service id.
  @Patch('reorder')
  reorderServices(@CurrentUser() actor: AuthUser, @Body() dto: ReorderDto): Promise<ListManagedServicesResponse> {
    return this.services.reorderServices(actor, dto.ids);
  }

  @Patch(':id')
  updateService(
    @CurrentUser() actor: AuthUser,
    @Param('id') id: string,
    @Body() dto: UpsertServiceDto,
  ): Promise<ManagedServiceResponse> {
    return this.services.updateService(actor, id, dto);
  }

  @Post(':id/archive')
  archiveService(@CurrentUser() actor: AuthUser, @Param('id') id: string): Promise<ManagedServiceResponse> {
    return this.services.archiveService(actor, id);
  }
}
