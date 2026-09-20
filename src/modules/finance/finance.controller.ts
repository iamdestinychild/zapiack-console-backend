import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import {
  CurrentStaff,
  Idempotent,
  RequirePermissions,
} from '../../common/auth/decorators';
import type { StaffPrincipal } from '../../common/auth/staff-principal';
import { DateRangeDto } from '../../common/dto/common.dto';
import { resolveRange } from '../../common/time/lagos';
import { FinanceService } from './finance.service';
import { ReconciliationService } from './reconciliation.service';
import { ExportsService } from './exports.service';
import { CreateExportDto, FinanceQueryDto } from './dto/finance.dto';

@Controller()
export class FinanceController {
  constructor(
    private readonly finance: FinanceService,
    private readonly reconciliation: ReconciliationService,
    private readonly exports: ExportsService,
  ) {}

  @Get('finance/revenue')
  @RequirePermissions('finance.read')
  revenue(@Query() query: FinanceQueryDto) {
    return this.finance.revenueTimeseries(query);
  }

  @Get('finance/profit')
  @RequirePermissions('finance.read')
  profit(@Query() query: FinanceQueryDto) {
    return this.finance.profit(query);
  }

  @Get('finance/cash')
  @RequirePermissions('finance.read')
  cash(@Query() query: FinanceQueryDto) {
    return this.finance.cash(query);
  }

  @Get('finance/cohorts')
  @RequirePermissions('finance.read')
  cohorts(@Query() query: FinanceQueryDto) {
    return this.finance.cohortMetrics(query);
  }

  @Get('finance/reconciliation')
  @RequirePermissions('finance.read')
  reconciliationRuns(@Query() query: DateRangeDto) {
    const { start, end } = resolveRange(query.from, query.to, 30);
    return this.reconciliation.list(start, end);
  }

  // ---------------------------------------------------------------- exports

  @Post('exports')
  @RequirePermissions('finance.export')
  @Throttle({ exports: { limit: 10, ttl: 60_000 } })
  @Idempotent()
  createExport(
    @CurrentStaff() staff: StaffPrincipal,
    @Body() dto: CreateExportDto,
  ) {
    return this.exports.create(staff, dto);
  }

  @Get('exports')
  @RequirePermissions('finance.export')
  listExports(@CurrentStaff() staff: StaffPrincipal) {
    return this.exports.list(staff);
  }

  @Get('exports/:id/download')
  @RequirePermissions('finance.export')
  @Throttle({ exports: { limit: 20, ttl: 60_000 } })
  download(@CurrentStaff() staff: StaffPrincipal, @Param('id') id: string) {
    return this.exports.download(staff, id);
  }
}
