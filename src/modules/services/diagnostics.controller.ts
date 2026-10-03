import { Controller, Get } from '@nestjs/common';
import { RequirePermissions } from '../../common/auth/decorators';
import { DiagnosticsService } from './diagnostics.service';

/** Staff-management level on purpose: it reveals how the platform is actually behaving. */
@Controller('diagnostics')
@RequirePermissions('staff.manage')
export class DiagnosticsController {
  constructor(private readonly diagnostics: DiagnosticsService) {}

  /** Product database vs console for today. Counts and sums only. */
  @Get('data-health')
  dataHealth() {
    return this.diagnostics.dataHealth();
  }
}
