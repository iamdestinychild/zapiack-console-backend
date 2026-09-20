import { Global, Module } from '@nestjs/common';
import { SessionService } from '../../common/auth/session.service';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { PasswordService } from './password.service';
import { TotpService } from './totp.service';

@Global()
@Module({
  controllers: [AuthController],
  providers: [AuthService, PasswordService, TotpService, SessionService],
  exports: [SessionService, PasswordService, TotpService],
})
export class AuthModule {}
