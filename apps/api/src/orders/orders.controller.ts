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
 * Purchase orders (Week 6 tickets 8/9; two-step flow since 0100).
 *
 * Two actions move an order: `submit` (draft -> ready to send) and `send` (email
 * the supplier). The class gate is the READ key; preparing (generate/edit/submit)
 * needs orders.manage, and SENDING needs orders.approve — that permission is the
 * spend control now that the separate approve step is gone. The service re-checks
 * both, so the decorator here is the surface and the service check is the
 * authority.
 *
 * Managers hold orders.approve by default (0100), so they complete their own
 * location's orders end to end. An owner who wants sign-off removes that key: the
 * manager's flow then stops after `submit` and the owner's `send` is the approval.
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
