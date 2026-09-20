import type { Request } from 'express';
import type { StaffPrincipal } from '../auth/staff-principal';

/**
 * The request shape admin-core actually works with. Express types `req.body` and the
 * properties middleware attaches as loose, which turns every read of `req.staff` into
 * an unchecked `any`; declaring it once here keeps the guards and interceptors typed.
 */
export interface AdminRequest extends Request {
  /** Attached by SessionGuard once the session and its permissions are resolved. */
  staff?: StaffPrincipal;
  /** Attached by RequestIdMiddleware; matches the id in api-core's logs. */
  id?: string;
  /** Present because the app is created with `rawBody`, for HMAC verification. */
  rawBody?: Buffer;
}

/** The same request once a guard has guaranteed a staff principal is present. */
export interface AuthenticatedRequest extends AdminRequest {
  staff: StaffPrincipal;
}

/** Body fields the shared interceptors read before a DTO has been applied. */
export interface ReasonedBody {
  reason?: string;
}
