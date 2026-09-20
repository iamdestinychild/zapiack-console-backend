import {
  Body,
  Controller,
  Get,
  HttpCode,
  Post,
  Req,
  Res,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Throttle } from '@nestjs/throttler';
import type { CookieOptions, Request, Response } from 'express';
import {
  CurrentStaff,
  Public,
  RequirePermissions,
} from '../../common/auth/decorators';
import type { StaffPrincipal } from '../../common/auth/staff-principal';
import type { AdminConfig } from '../../common/config/configuration';
import type { SessionRecord } from '../../common/auth/session.service';
import { AuthService } from './auth.service';
import {
  AcceptInviteDto,
  ChangePasswordDto,
  LoginDto,
  StartImpersonationDto,
  VerifyTotpDto,
} from './dto/auth.dto';

@Controller('auth')
export class AuthController {
  private readonly cfg: AdminConfig;

  constructor(
    private readonly auth: AuthService,
    config: ConfigService<{ admin: AdminConfig }, true>,
  ) {
    this.cfg = config.get('admin', { infer: true });
  }

  /** Rate limited hard: this is the one unauthenticated write on the service. */
  @Public()
  @Throttle({ login: { limit: 10, ttl: 60_000 } })
  @Post('login')
  @HttpCode(200)
  async login(
    @Body() dto: LoginDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const result = await this.auth.login(dto.email, dto.password, {
      ip: req.ip,
      userAgent: req.get('user-agent') ?? undefined,
    });

    this.setSessionCookies(res, result.session);

    return {
      status: 'totp_required',
      // Present only on first sign-in, while the staff member enrols their authenticator.
      enrolment: result.enrolment ?? null,
    };
  }

  @Public()
  @Throttle({ login: { limit: 10, ttl: 60_000 } })
  @Post('2fa/verify')
  @HttpCode(200)
  async verify(
    @Body() dto: VerifyTotpDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const sessionId = (req.cookies as Record<string, string> | undefined)?.[
      this.cfg.session.accessCookie
    ];
    if (!sessionId) throw new UnauthorizedException('Sign in first');

    const session = await this.auth.verifyTotp(sessionId, dto.code, {
      ip: req.ip,
      userAgent: req.get('user-agent') ?? undefined,
    });

    this.setSessionCookies(res, session);
    return { status: 'authenticated', csrfToken: session.csrfToken };
  }

  @Post('logout')
  @HttpCode(204)
  async logout(
    @CurrentStaff() staff: StaffPrincipal,
    @Res({ passthrough: true }) res: Response,
  ) {
    await this.auth.logout(staff);
    this.clearSessionCookies(res);
  }

  @Get('me')
  me(@CurrentStaff() staff: StaffPrincipal) {
    return this.auth.me(staff);
  }

  @Post('password')
  @HttpCode(204)
  async changePassword(
    @CurrentStaff() staff: StaffPrincipal,
    @Body() dto: ChangePasswordDto,
  ) {
    await this.auth.changePassword(staff, dto.currentPassword, dto.newPassword);
  }

  @Public()
  @Throttle({ login: { limit: 5, ttl: 60_000 } })
  @Post('invites/accept')
  @HttpCode(201)
  acceptInvite(@Body() dto: AcceptInviteDto, @Req() req: Request) {
    return this.auth.acceptInvite(dto.token, dto.password, {
      ip: req.ip,
      userAgent: req.get('user-agent') ?? undefined,
    });
  }

  @RequirePermissions('customers.impersonate')
  @Post('impersonate')
  startImpersonation(
    @CurrentStaff() staff: StaffPrincipal,
    @Body() dto: StartImpersonationDto,
  ) {
    return this.auth.startImpersonation(staff, dto.accountId, dto.reason);
  }

  @Post('impersonate/end')
  @HttpCode(204)
  async endImpersonation(@CurrentStaff() staff: StaffPrincipal) {
    await this.auth.endImpersonation(staff);
  }

  // ---------------------------------------------------------------- cookies

  private cookieOptions(maxAgeMs: number): CookieOptions {
    return {
      httpOnly: true,
      secure: this.cfg.session.secureCookies,
      // The console is a separate subdomain and never embedded, so strict is safe
      // and removes a whole class of cross-site request.
      sameSite: 'strict',
      domain: this.cfg.session.cookieDomain,
      path: '/',
      maxAge: maxAgeMs,
    };
  }

  private setSessionCookies(res: Response, session: SessionRecord) {
    const maxAge = session.absoluteExpiresAt - Date.now();
    res.cookie(
      this.cfg.session.accessCookie,
      session.sessionId,
      this.cookieOptions(maxAge),
    );
    // Readable by the frontend so it can echo the double-submit token on writes.
    res.cookie(this.cfg.session.csrfCookie, session.csrfToken, {
      ...this.cookieOptions(maxAge),
      httpOnly: false,
    });
  }

  private clearSessionCookies(res: Response) {
    const base = { ...this.cookieOptions(0), maxAge: undefined };
    res.clearCookie(this.cfg.session.accessCookie, base);
    res.clearCookie(this.cfg.session.csrfCookie, base);
  }
}
