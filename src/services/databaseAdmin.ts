import { auth } from '../firebase';

export type DatabaseId = 'default' | 'ai_shared';
export type MirrorDirection = 'default_to_ai' | 'ai_shared_to_default' | 'bidirectional_sync';
export type ConflictStrategy = 'newest_wins' | 'skip_conflicts' | 'overwrite_with_backup';

export interface DailyUsageStats {
  dateKey: string;
  reads: number;
  writes: number;
  deletes: number;
  totalLifetimeOps: number;
  lastError: string | null;
  lastErrorAt: string | null;
  lastQuotaError: string | null;
  lastQuotaErrorAt: string | null;
}

export interface SyncConflictRecord {
  docPath: string;
  collection: string;
  sourceUpdatedAt: string | null;
  targetUpdatedAt: string | null;
  resolution: 'copied_source' | 'copied_target' | 'kept_target' | 'skipped_conflict' | 'error';
  note: string;
}

export interface BackupMetadata {
  backupId: string;
  createdAt: string;
  targetDatabase: DatabaseId;
  direction: MirrorDirection | 'restore';
  recordCount: number;
  sizeBytes: number;
}

export interface LastSyncSummary {
  timestamp: string;
  direction: MirrorDirection;
  strategy: ConflictStrategy;
  status: 'success' | 'partial' | 'failed';
  copiedCount: number;
  skippedCount: number;
  conflictsCount: number;
  errorCount: number;
  backupId: string | null;
  error: string | null;
  summary: string;
}

export interface MirrorJobState {
  jobId: string;
  direction: MirrorDirection;
  strategy: ConflictStrategy;
  status: 'running' | 'completed' | 'partial' | 'failed';
  phase: string;
  startedAt: string;
  finishedAt: string | null;
  processedDocs: number;
  totalDocs: number;
  progressPct: number;
  copiedCount: number;
  skippedCount: number;
  conflictsCount: number;
  errorCount: number;
  backupId: string | null;
  error: string | null;
  conflicts: SyncConflictRecord[];
  errors: string[];
}

export interface DbStatusInfo {
  id: DatabaseId;
  label: string;
  projectId: string;
  databaseId: string;
  connected: boolean;
  authMode: 'service_account' | 'adc_iam' | 'user_token_rest' | 'unconfigured';
  latencyMs: number | null;
  error: string | null;
  docCounts: Record<string, number>;
  totalDocs: number;
  estimatedBytes: number;
  latestRecordAt: string | null;
  usage: DailyUsageStats;
  quota: {
    dailyReadLimit: number;
    dailyWriteLimit: number;
    dailyDeleteLimit: number;
    storageLimitBytes: number;
    readsRemaining: number;
    writesRemaining: number;
    deletesRemaining: number;
    storageRemainingBytes: number;
    quotaProviderNote: string;
  };
}

export interface DbAdminOverview {
  activeDatabase: DatabaseId;
  lastSwitchAt: string | null;
  latestDataWinner: DatabaseId | 'in_sync' | 'unknown';
  databases: {
    default: DbStatusInfo;
    ai_shared: DbStatusInfo;
  };
  lastSync: LastSyncSummary | null;
  currentJob: MirrorJobState | null;
  backups: BackupMetadata[];
  notifications: { level: 'error' | 'warning' | 'info'; message: string }[];
}

export class DbApiError extends Error {
  status: number;
  code?: string;
  constructor(message: string, status: number, code?: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

let cachedActiveDb: DatabaseId = 'default';
let cachedLastSwitchAt: string | null = null;
let initPromise: Promise<DatabaseId> | null = null;
let streamStarted = false;
const activeDbWatchers = new Set<(dbId: DatabaseId, switchedAt: string | null) => void>();

export function getCachedActiveDatabase(): DatabaseId {
  return cachedActiveDb;
}

export function getCachedLastSwitchAt(): string | null {
  return cachedLastSwitchAt;
}

function notifyActiveDbWatchers(nextDb: DatabaseId, switchedAt: string | null): void {
  const changed = nextDb !== cachedActiveDb || switchedAt !== cachedLastSwitchAt;
  cachedActiveDb = nextDb;
  cachedLastSwitchAt = switchedAt;
  if (changed) {
    for (const cb of activeDbWatchers) {
      try {
        cb(nextDb, switchedAt);
      } catch {
        // ignore watcher failure
      }
    }
  }
}

export function subscribeActiveDatabase(
  cb: (dbId: DatabaseId, switchedAt: string | null) => void
): () => void {
  activeDbWatchers.add(cb);
  ensureActiveDbStream();
  return () => {
    activeDbWatchers.delete(cb);
  };
}

function ensureActiveDbStream(): void {
  if (streamStarted || typeof window === 'undefined' || typeof EventSource === 'undefined') return;
  streamStarted = true;
  try {
    const es = new EventSource('/api/database/stream');
    es.onmessage = (evt) => {
      try {
        const parsed = JSON.parse(evt.data) as {
          activeDatabase?: DatabaseId;
          lastSwitchAt?: string | null;
        };
        if (parsed.activeDatabase === 'default' || parsed.activeDatabase === 'ai_shared') {
          notifyActiveDbWatchers(parsed.activeDatabase, parsed.lastSwitchAt || null);
        }
      } catch {
        // ignore malformed ping
      }
    };
    es.onerror = () => {
      es.close();
      streamStarted = false;
    };
  } catch {
    streamStarted = false;
  }
}

export async function ensureActiveDatabaseLoaded(): Promise<DatabaseId> {
  if (initPromise) return initPromise;
  initPromise = (async () => {
    try {
      const token = await auth.currentUser?.getIdToken().catch(() => undefined);
      const res = await fetch('/api/database/active', {
        headers: token ? { Authorization: `Bearer ${token}` } : undefined,
      });
      if (res.ok) {
        const data = (await res.json()) as {
          activeDatabase?: DatabaseId;
          lastSwitchAt?: string | null;
        };
        const dbId: DatabaseId = data.activeDatabase === 'ai_shared' ? 'ai_shared' : 'default';
        notifyActiveDbWatchers(dbId, data.lastSwitchAt || null);
      }
    } catch {
      // keep default database fallback
    }
    ensureActiveDbStream();
    return cachedActiveDb;
  })();
  return initPromise;
}

export async function checkServerIsAdmin(): Promise<boolean> {
  try {
    const token = await auth.currentUser?.getIdToken();
    if (!token) return false;
    const res = await fetch('/api/database/active', {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) return false;
    const data = (await res.json()) as {
      activeDatabase?: DatabaseId;
      lastSwitchAt?: string | null;
      isAdmin?: boolean;
    };
    if (data.activeDatabase === 'default' || data.activeDatabase === 'ai_shared') {
      notifyActiveDbWatchers(data.activeDatabase, data.lastSwitchAt || null);
    }
    return Boolean(data.isAdmin);
  } catch {
    return false;
  }
}

export async function authedApiFetch<T>(url: string, init: RequestInit = {}): Promise<T> {
  const user = auth.currentUser;
  if (!user) {
    throw new DbApiError('You must be signed in.', 401);
  }
  const token = await user.getIdToken();
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
    ...((init.headers as Record<string, string>) || {}),
  };

  const res = await fetch(url, { ...init, headers });
  const text = await res.text();
  let parsed: Record<string, unknown> = {};
  try {
    parsed = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  } catch {
    parsed = { error: text || `HTTP ${res.status}` };
  }

  if (!res.ok) {
    throw new DbApiError(
      String(parsed.error || `Request failed (${res.status})`),
      res.status,
      typeof parsed.code === 'string' ? parsed.code : undefined
    );
  }

  return parsed as T;
}

export async function fetchAdminDatabaseOverview(): Promise<DbAdminOverview> {
  return authedApiFetch<DbAdminOverview>('/api/admin/database/overview');
}

export async function switchAdminActiveDatabase(
  targetDatabase: DatabaseId
): Promise<{ activeDatabase: DatabaseId; lastSwitchAt: string }> {
  const res = await authedApiFetch<{ activeDatabase: DatabaseId; lastSwitchAt: string }>(
    '/api/admin/database/switch',
    {
      method: 'POST',
      body: JSON.stringify({ targetDatabase, confirm: true }),
    }
  );
  notifyActiveDbWatchers(res.activeDatabase, res.lastSwitchAt);
  return res;
}

export async function startAdminMirrorJob(
  direction: MirrorDirection,
  conflictStrategy: ConflictStrategy
): Promise<MirrorJobState> {
  return authedApiFetch<MirrorJobState>('/api/admin/database/mirror', {
    method: 'POST',
    body: JSON.stringify({ direction, conflictStrategy }),
  });
}

export async function pollAdminMirrorJob(jobId: string): Promise<MirrorJobState> {
  return authedApiFetch<MirrorJobState>(`/api/admin/database/jobs/${encodeURIComponent(jobId)}`);
}

export async function restoreAdminBackup(
  backupId: string
): Promise<{ restoredCount: number; targetDatabase: DatabaseId }> {
  return authedApiFetch<{ restoredCount: number; targetDatabase: DatabaseId }>(
    '/api/admin/database/restore',
    {
      method: 'POST',
      body: JSON.stringify({ backupId }),
    }
  );
}

// Batched telemetry reporter when AI Shared Database is active (zero extra Firestore reads)
let pendingAiReads = 0;
let pendingAiWrites = 0;
let pendingAiDeletes = 0;
let pendingAiError: string | null = null;
let flushTimer: number | null = null;

export function trackAiSharedClientOp(counts: {
  reads?: number;
  writes?: number;
  deletes?: number;
  error?: string | null;
}): void {
  pendingAiReads += counts.reads || 0;
  pendingAiWrites += counts.writes || 0;
  pendingAiDeletes += counts.deletes || 0;
  if (counts.error) pendingAiError = counts.error;

  if (flushTimer !== null || typeof window === 'undefined') return;
  flushTimer = window.setTimeout(() => {
    flushTimer = null;
    const reads = pendingAiReads;
    const writes = pendingAiWrites;
    const deletes = pendingAiDeletes;
    const error = pendingAiError;
    pendingAiReads = 0;
    pendingAiWrites = 0;
    pendingAiDeletes = 0;
    pendingAiError = null;

    if ((reads > 0 || writes > 0 || deletes > 0 || error) && auth.currentUser) {
      void authedApiFetch('/api/database/ai-shared-usage', {
        method: 'POST',
        body: JSON.stringify({ reads, writes, deletes, error }),
      }).catch(() => {});
    }
  }, 1500);
}
