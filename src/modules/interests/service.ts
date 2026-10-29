import { asc, eq, inArray } from 'drizzle-orm';
import type { Db } from '../../db/client.js';
import { interestTopics, userInterests } from '../../db/schema.js';
import { AppError } from '../../lib/errors.js';

export class InterestsService {
  constructor(private readonly db: Db) {}

  listTopics() {
    return this.db
      .select({ id: interestTopics.id, name: interestTopics.name })
      .from(interestTopics)
      .where(eq(interestTopics.isActive, true))
      .orderBy(asc(interestTopics.sortOrder));
  }

  async getSelection(userId: string): Promise<number[]> {
    const rows = await this.db
      .select({ id: userInterests.topicId })
      .from(userInterests)
      .where(eq(userInterests.userId, userId))
      .orderBy(asc(userInterests.topicId));
    return rows.map((r) => r.id);
  }

  async replaceSelection(userId: string, topicIds: number[]): Promise<number[]> {
    const known = await this.db
      .select({ id: interestTopics.id })
      .from(interestTopics)
      .where(inArray(interestTopics.id, topicIds));
    const knownIds = new Set(known.map((k) => k.id));
    const invalidIds = topicIds.filter((id) => !knownIds.has(id));
    if (invalidIds.length > 0) {
      throw new AppError('INVALID_TOPICS', 'Some selected topics do not exist', { invalidIds });
    }

    await this.db.transaction(async (tx) => {
      await tx.delete(userInterests).where(eq(userInterests.userId, userId));
      await tx.insert(userInterests).values(topicIds.map((topicId) => ({ userId, topicId })));
    });
    return [...topicIds].sort((a, b) => a - b);
  }
}
