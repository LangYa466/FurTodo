// KV list() and get() are eventually consistent (up to about 60s). Every write
// goes through the user's Durable Object, which hands readers the entities it
// wrote recently (the journal) to overlay on KV results, so users always see
// their own writes.

import {
  entityKeyPrefix,
  parseEntityKey,
  type EntityMetadata,
  type JournalEntry,
  type Kind,
  type StoredEntity,
} from '../domain/model';

/** Charges KV operations against the user's daily quota; throws when exhausted. */
export interface QuotaCharger {
  charge(kind: 'reads' | 'lists', count: number): Promise<void> | void;
}

export interface MetadataRow {
  key: string;
  kind: Kind;
  id: string;
  metadata: EntityMetadata;
}

/** KV bulk get() accepts at most 100 keys. */
export const BULK_GET_MAX_KEYS = 100;
const BULK_GET_CONCURRENCY = 6;

/** Lists entity metadata of one kind (or all kinds), overlaid with the journal. */
export async function scanMetadata(
  kv: KVNamespace,
  userId: string,
  kind: Kind | null,
  charger: QuotaCharger,
  overlay: ReadonlyMap<string, JournalEntry>,
): Promise<Map<string, MetadataRow>> {
  const prefix = entityKeyPrefix(userId, kind ?? undefined);
  const rows = new Map<string, MetadataRow>();
  let cursor: string | undefined;
  do {
    await charger.charge('lists', 1);
    const page = await kv.list<EntityMetadata>({prefix, cursor});
    for (const listed of page.keys) {
      const parsed = parseEntityKey(listed.name);
      if (parsed && listed.metadata) {
        rows.set(listed.name, {
          key: listed.name,
          ...parsed,
          metadata: listed.metadata,
        });
      }
    }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);

  for (const entry of overlay.values()) {
    if (!entry.key.startsWith(prefix)) continue;
    const listed = rows.get(entry.key);
    if (listed && listed.metadata.rev >= entry.metadata.rev) continue;
    const parsed = parseEntityKey(entry.key);
    if (parsed) {
      rows.set(entry.key, {
        key: entry.key,
        ...parsed,
        metadata: entry.metadata,
      });
    }
  }
  return rows;
}

export interface LoadedEntities {
  entities: Map<string, StoredEntity>;
  /** Keys whose value is older than (or missing behind) the listed metadata. */
  stale: Set<string>;
}

/** Reads entity values for `rows`, preferring journal copies over KV. */
export async function loadEntities(
  kv: KVNamespace,
  rows: readonly MetadataRow[],
  charger: QuotaCharger,
  overlay: ReadonlyMap<string, JournalEntry>,
): Promise<LoadedEntities> {
  const entities = new Map<string, StoredEntity>();
  const stale = new Set<string>();
  const missing: MetadataRow[] = [];
  for (const row of rows) {
    const journal = overlay.get(row.key);
    if (journal && journal.metadata.rev >= row.metadata.rev) {
      entities.set(row.key, journal.body);
    } else {
      missing.push(row);
    }
  }
  if (missing.length === 0) return {entities, stale};

  await charger.charge('reads', missing.length);
  const chunks: MetadataRow[][] = [];
  for (let i = 0; i < missing.length; i += BULK_GET_MAX_KEYS) {
    chunks.push(missing.slice(i, i + BULK_GET_MAX_KEYS));
  }
  for (let i = 0; i < chunks.length; i += BULK_GET_CONCURRENCY) {
    const batch = chunks.slice(i, i + BULK_GET_CONCURRENCY);
    const results = await Promise.all(
      batch.map(chunk =>
        kv.get<StoredEntity>(
          chunk.map(row => row.key),
          'json',
        ),
      ),
    );
    for (const [batchIndex, chunk] of batch.entries()) {
      const values = results[batchIndex];
      for (const row of chunk) {
        const entity = values?.get(row.key);
        if (!entity) {
          stale.add(row.key);
          continue;
        }
        if (entity.rev < row.metadata.rev) stale.add(row.key);
        entities.set(row.key, entity);
      }
    }
  }
  return {entities, stale};
}
