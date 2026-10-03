import { BadRequestException } from '@nestjs/common';
import type { UpdatePlanDto } from './dto/catalogue.dto';

/** The columns of a plan an update may touch, as the product stores them. */
export interface PlanRow {
  name: string;
  slug: string;
  description: string | null;
  type: string;
  channel: string;
  billingInterval: string;
  basePrice: { toString(): string };
  overagePrice: { toString(): string };
  overageEnabled: boolean;
  monthlyQuota: number;
  dailyQuota: number | null;
  maxContacts: number;
  isActive: boolean;
  isPublic: boolean;
  isFree: boolean;
}

export type PlanChanges = Partial<{
  name: string;
  slug: string;
  description: string | null;
  type: string;
  channel: string;
  billingInterval: string;
  basePrice: string;
  overagePrice: string;
  overageEnabled: boolean;
  monthlyQuota: number;
  dailyQuota: number | null;
  maxContacts: number;
  isPublic: boolean;
  isFree: boolean;
}>;

/**
 * Turns a partial edit into exactly the columns that change.
 *
 * Fields the caller leaves out are left alone, which is the whole point: the old
 * edit path rebuilt the row from defaults, so changing a price quietly made a private
 * plan public and cleared its daily quota. A value equal to what is stored is dropped,
 * so the audit record shows only what really moved.
 */
export function planChanges(before: PlanRow, dto: UpdatePlanDto): PlanChanges {
  const next: PlanChanges = {};
  const set = <K extends keyof PlanChanges>(key: K, value: PlanChanges[K]) => {
    if (value !== undefined) next[key] = value;
  };

  set('name', dto.name);
  set('slug', dto.slug);
  set('description', dto.description);
  set('type', dto.type);
  set('channel', dto.channel);
  set('billingInterval', dto.billingInterval);
  set('basePrice', dto.basePrice);
  set('overagePrice', dto.overagePrice);
  set('overageEnabled', dto.overageEnabled);
  set('monthlyQuota', dto.monthlyQuota ? Number(dto.monthlyQuota) : undefined);
  // An explicit null clears the daily cap; leaving the field out keeps it.
  const daily = dto.dailyQuota as string | null | undefined;
  if (daily !== undefined)
    set('dailyQuota', daily === null ? null : Number(daily));
  set('maxContacts', dto.maxContacts ? Number(dto.maxContacts) : undefined);
  set('isPublic', dto.isPublic);
  set('isFree', dto.isFree);

  const changed: PlanChanges = {};
  for (const [key, value] of Object.entries(next) as [
    keyof PlanChanges,
    unknown,
  ][]) {
    const current = before[key as keyof PlanRow];
    const same =
      current !== null &&
      typeof current === 'object' &&
      'toString' in current &&
      typeof value === 'string'
        ? Number(current.toString()) === Number(value)
        : current === value;
    if (!same) (changed as Record<string, unknown>)[key] = value;
  }

  if (changed.isPublic === true && !before.isActive) {
    throw new BadRequestException(
      'A retired plan cannot be made public. Reactivate it first.',
    );
  }
  const finalFree = changed.isFree ?? before.isFree;
  const finalPrice = Number(changed.basePrice ?? before.basePrice.toString());
  if (finalFree && finalPrice !== 0) {
    throw new BadRequestException(
      'A free plan must have a base price of 0. Set the price to 0, or mark the plan as not free.',
    );
  }
  return changed;
}
