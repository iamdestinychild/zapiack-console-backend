import { Injectable } from '@nestjs/common';
import { ZapiackPrismaService } from '../../common/prisma/zapiack-prisma.service';

const TTL_MS = 10 * 60_000;
const MAX_ENTRIES = 2_000;

/**
 * Who a project belongs to, for labelling live traffic. The activity log records a
 * project, not a customer, so the name is looked up here: the business name from a
 * sender ID filing where there is one, otherwise the owner's display name.
 *
 * Names are held for ten minutes, misses included, so a busy minute of traffic from
 * a handful of projects costs one lookup per project, not one per request.
 */
@Injectable()
export class CustomerNames {
  private readonly known = new Map<
    string,
    { name: string | null; expires: number }
  >();

  constructor(private readonly zapiack: ZapiackPrismaService) {}

  async resolve(
    projectIds: (string | null | undefined)[],
  ): Promise<Map<string, string>> {
    const now = Date.now();
    const wanted = [...new Set(projectIds.filter((id): id is string => !!id))];
    const missing = wanted.filter((id) => {
      const hit = this.known.get(id);
      return !hit || hit.expires <= now;
    });

    if (missing.length) {
      const projects = await this.zapiack.read.projects.findMany({
        where: { id: { in: missing } },
        select: {
          id: true,
          account: {
            select: {
              owner: { select: { displayName: true } },
              senderIdApplications: {
                select: { businessName: true },
                orderBy: { createdAt: 'desc' },
                take: 1,
              },
            },
          },
        },
      });
      const found = new Map(
        projects.map((p) => [
          p.id,
          p.account.senderIdApplications[0]?.businessName ??
            p.account.owner.displayName ??
            null,
        ]),
      );
      if (this.known.size + missing.length > MAX_ENTRIES) this.known.clear();
      for (const id of missing) {
        this.known.set(id, {
          name: found.get(id) ?? null,
          expires: now + TTL_MS,
        });
      }
    }

    const names = new Map<string, string>();
    for (const id of wanted) {
      const name = this.known.get(id)?.name;
      if (name) names.set(id, name);
    }
    return names;
  }
}
