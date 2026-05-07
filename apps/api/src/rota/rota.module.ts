import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { RotaController } from './rota.controller';
import { RotaService } from './rota.service';

@Module({
  imports: [AuthModule],
  controllers: [RotaController],
  providers: [RotaService],
  exports: [RotaService],
})
export class RotaModule {}
