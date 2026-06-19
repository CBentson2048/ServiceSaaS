import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { OwnerCancellationPolicyController } from './owner-cancellation-policy.controller';
import { OwnerCancellationPolicyService } from './owner-cancellation-policy.service';

@Module({
  imports: [AuthModule],
  controllers: [OwnerCancellationPolicyController],
  providers: [OwnerCancellationPolicyService],
  exports: [OwnerCancellationPolicyService],
})
export class OwnerCancellationPolicyModule {}
