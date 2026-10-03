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
import { cookieScope } from '../../common/auth/cookie-scope';
import { cookieValues } from '../../common/auth/session-cookie';
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

    this.setSessionCookies(req, res, result.session);

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
    const sessionIds = cookieValues(req, this.cfg.session.accessCookie);
    if (!sessionIds.length) throw new UnauthorizedException('Sign in first');

    const session = await this.auth.verifyTotp(sessionIds, dto.code, {
      ip: req.ip,
      userAgent: req.get('user-agent') ?? undefined,
    });

    this.setSessionCookies(req, res, session);
    return { status: 'authenticated', csrfToken: session.csrfToken };
  }

  @Post('logout')
  @HttpCode(204)
  async logout(
    @CurrentStaff() staff: StaffPrincipal,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    await this.auth.logout(staff);
    this.clearSessionCookies(req, res);
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

  private cookieOptions(req: Request, maxAgeMs: number): CookieOptions {
    const { domain, sameSite } = cookieScope(
      {
        domain: this.cfg.session.cookieDomain,
        sameSite: this.cfg.session.sameSite,
        secure: this.cfg.session.secureCookies,
      },
      req.hostname,
      req.get('origin'),
    );
    return {
      httpOnly: true,
      secure: this.cfg.session.secureCookies,
      sameSite,
      domain,
      path: '/',
      maxAge: maxAgeMs,
    };
  }

  private setSessionCookies(
    req: Request,
    res: Response,
    session: SessionRecord,
  ) {
    const maxAge = session.absoluteExpiresAt - Date.now();
    res.cookie(
      this.cfg.session.accessCookie,
      session.sessionId,
      this.cookieOptions(req, maxAge),
    );
    // Readable by the frontend so it can echo the double-submit token on writes.
    res.cookie(this.cfg.session.csrfCookie, session.csrfToken, {
      ...this.cookieOptions(req, maxAge),
      httpOnly: false,
    });
  }

  private clearSessionCookies(req: Request, res: Response) {
    const base = { ...this.cookieOptions(req, 0), maxAge: undefined };
    res.clearCookie(this.cfg.session.accessCookie, base);
    res.clearCookie(this.cfg.session.csrfCookie, base);
    // A cookie set earlier under a different Domain is a different cookie and survives
    // the clear above, so clear the host-only variant too.
    {
      const hostOnly = { ...base, domain: undefined };
      res.clearCookie(this.cfg.session.accessCookie, hostOnly);
      res.clearCookie(this.cfg.session.csrfCookie, hostOnly);
    }
  }
}
