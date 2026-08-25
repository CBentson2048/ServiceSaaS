import { Body, Controller, Get, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import type {
  AuthUser,
  GeneratePurchaseOrdersResponse,
  ListPurchaseOrdersResponse,
  PurchaseOrderResponse,
  SendPurchaseOrderResponse,
} from '@sheer/domain';
import { CurrentUser } from '../auth/current-user.decorator';
import { PermissionsGuard, RequirePermissions } from '../auth/permissions.guard';
import { RequireRoles, RolesGuard } from '../auth/roles.guard';
import { SupabaseAuthGuard } from '../auth/supabase-auth.guard';
import { GenerateOrdersDto, ListOrdersQueryDto, UpdateOrderDto } from './dto';
import { OrdersService } from './orders.service';

/**
 * Purchase orders (Week 6 tickets 8/9). The class gate is the READ key;
 * preparing (generate/edit/submit) needs orders.manage and the spend controls
 * (approve/send) need orders.approve — the service re-checks both, so the
 * decorator here is the surface and the service check is the authority.
 */
@Controller('orders')
@UseGuards(SupabaseAuthGuard, RolesGuard, PermissionsGuard)
@RequireRoles('owner', 'manager')
@RequirePermissions('orders.view')
export class OrdersController {
  constructor(private readonly orders: OrdersService) {}

  @Get()
  list(@CurrentUser() actor: AuthUser, @Query() query: ListOrdersQueryDto): Promise<ListPurchaseOrdersResponse> {
    return this.orders.list(actor, query);
  }

  @Post('generate')
  @RequirePermissions('orders.manage')
  generate(
    @CurrentUser() actor: AuthUser,
    @Body() dto: GenerateOrdersDto,
  ): Promise<GeneratePurchaseOrdersResponse> {
    return this.orders.generate(actor, dto);
  }

  @Get(':id')
  get(@CurrentUser() actor: AuthUser, @Param('id') id: string): Promise<PurchaseOrderResponse> {
    return this.orders.getOrder(actor, id);
  }

  @Patch(':id')
  @RequirePermissions('orders.manage')
  update(
    @CurrentUser() actor: AuthUser,
    @Param('id') id: string,
    @Body() dto: UpdateOrderDto,
  ): Promise<PurchaseOrderResponse> {
    return this.orders.update(actor, id, dto);
  }

  @Post(':id/submit')
  @RequirePermissions('orders.manage')
  submit(@CurrentUser() actor: AuthUser, @Param('id') id: string): Promise<PurchaseOrderResponse> {
    return this.orders.submit(actor, id);
  }

  @Post(':id/approve')
  @RequirePermissions('orders.approve')
  approve(@CurrentUser() actor: AuthUser, @Param('id') id: string): Promise<PurchaseOrderResponse> {
    return this.orders.approve(actor, id);
  }

  @Post(':id/send')
  @RequirePermissions('orders.approve')
  send(@CurrentUser() actor: AuthUser, @Param('id') id: string): Promise<SendPurchaseOrderResponse> {
    return this.orders.send(actor, id);
  }

  @Post(':id/cancel')
  @RequirePermissions('orders.manage')
  cancel(@CurrentUser() actor: AuthUser, @Param('id') id: string): Promise<PurchaseOrderResponse> {
    return this.orders.cancel(actor, id);
  }
}
