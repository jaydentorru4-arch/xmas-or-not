import fs from 'node:fs';
import path from 'node:path';
import {
  applicationDefault,
  cert,
  getApp,
  getApps,
  initializeApp,
  type App as AdminApp,
  type ServiceAccount,
} from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import {
  FieldValue,
  getFirestore,
  Timestamp,
  type DocumentData,
  type Firestore,
} from 'firebase-admin/firestore';

export type DatabaseId = 'default' | 'ai_shared';
export type MirrorDirection = 'default_to_ai' | 'ai_shared_to_default' | 'bidirectional_sync';
export type ConflictStrategy = 'newest_wins' | 'skip_conflicts' | 'overwrite_with_backup';

export interface AuthUser {
  uid: string;
  email: string;
  emailVerified: boolean;
  idToken: string;
}

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

interface PersistedState {
  activeDatabase: DatabaseId;
  lastSwitchAt: string | null;
  aiSharedUsage: DailyUsageStats;
  defaultUsage: DailyUsageStats;
  lastSync: LastSyncSummary | null;
  backups: BackupMetadata[];
}

interface ExportedDoc {
  docPath: string;
  group: string;
  data: Record<string, unknown>;
  updatedAtMs: number;
}

const SPARK_DAILY_READ_LIMIT = 50_000;
const SPARK_DAILY_WRITE_LIMIT = 20_000;
const SPARK_DAILY_DELETE_LIMIT = 20_000;
const SPARK_STORAGE_LIMIT_BYTES = 1_073_741_824;

const ROOT_DIR = process.cwd();
const DATA_DIR = path.join(ROOT_DIR, 'data');
const BACKUPS_DIR = path.join(DATA_DIR, 'backups');
const STATE_FILE = path.join(DATA_DIR, 'db-state.json');

interface AppletFirebaseConfig {
  projectId: string;
  firestoreDatabaseId?: string;
}

function loadAiSharedConfig(): AppletFirebaseConfig {
  try {
    const raw = fs.readFileSync(path.join(ROOT_DIR, 'firebase-applet-config.json'), 'utf8');
    const parsed = JSON.parse(raw) as AppletFirebaseConfig;
    return {
      projectId: parsed.projectId || 'holloweve',
      firestoreDatabaseId:
        parsed.firestoreDatabaseId || 'ai-studio-holloweveevilsan-f09d6375-9b7d-46e5-a021-86a3d0022ed0',
    };
  } catch {
    return {
      projectId: 'holloweve',
      firestoreDatabaseId: 'ai-studio-holloweveevilsan-f09d6375-9b7d-46e5-a021-86a3d0022ed0',
    };
  }
}

const AI_SHARED_CFG = loadAiSharedConfig();
const DEFAULT_PROJECT_ID = (process.env.DEFAULT_FIREBASE_PROJECT_ID || 'holloweve-1d459').trim();
const DEFAULT_DATABASE_ID = (process.env.DEFAULT_FIREBASE_DATABASE_ID || '(default)').trim();
const ADMIN_EMAIL = (process.env.ADMIN_EMAIL || 'jaydentorru4@gmail.com').trim().toLowerCase();

function utcDateKey(): string {
  return new Date().toISOString().slice(0, 10);
}

function emptyUsage(): DailyUsageStats {
  return {
    dateKey: utcDateKey(),
    reads: 0,
    writes: 0,
    deletes: 0,
    totalLifetimeOps: 0,
    lastError: null,
    lastErrorAt: null,
    lastQuotaError: null,
    lastQuotaErrorAt: null,
  };
}

function normalizeUsage(u: DailyUsageStats): DailyUsageStats {
  const today = utcDateKey();
  if (u.dateKey !== today) {
    return {
      ...u,
      dateKey: today,
      reads: 0,
      writes: 0,
      deletes: 0,
    };
  }
  return u;
}

function ensureDirs(): void {
  fs.mkdirSync(BACKUPS_DIR, { recursive: true });
}

function loadPersistedState(): PersistedState {
  ensureDirs();
  try {
    if (fs.existsSync(STATE_FILE)) {
      const raw = fs.readFileSync(STATE_FILE, 'utf8');
      const parsed = JSON.parse(raw) as Partial<PersistedState>;
      return {
        activeDatabase: parsed.activeDatabase === 'ai_shared' ? 'ai_shared' : 'default',
        lastSwitchAt: typeof parsed.lastSwitchAt === 'string' ? parsed.lastSwitchAt : null,
        aiSharedUsage: normalizeUsage(parsed.aiSharedUsage || emptyUsage()),
        defaultUsage: normalizeUsage(parsed.defaultUsage || emptyUsage()),
        lastSync: parsed.lastSync || null,
        backups: Array.isArray(parsed.backups) ? parsed.backups.slice(0, 15) : [],
      };
    }
  } catch {
    // fallback cleanly to default state
  }
  return {
    activeDatabase: 'default',
    lastSwitchAt: null,
    aiSharedUsage: emptyUsage(),
    defaultUsage: emptyUsage(),
    lastSync: null,
    backups: [],
  };
}

let state: PersistedState = loadPersistedState();
let currentMirrorJob: MirrorJobState | null = null;
const activeDbListeners = new Set<(activeDb: DatabaseId, lastSwitchAt: string | null) => void>();

function savePersistedState(): void {
  ensureDirs();
  state.aiSharedUsage = normalizeUsage(state.aiSharedUsage);
  state.defaultUsage = normalizeUsage(state.defaultUsage);
  const tmpFile = `${STATE_FILE}.tmp`;
  fs.writeFileSync(tmpFile, JSON.stringify(state, null, 2), 'utf8');
  fs.renameSync(tmpFile, STATE_FILE);
}

export function getActiveDatabaseState(): { activeDatabase: DatabaseId; lastSwitchAt: string | null } {
  return {
    activeDatabase: state.activeDatabase,
    lastSwitchAt: state.lastSwitchAt,
  };
}

export function subscribeActiveDatabaseChanges(
  listener: (activeDb: DatabaseId, lastSwitchAt: string | null) => void
): () => void {
  activeDbListeners.add(listener);
  return () => {
    activeDbListeners.delete(listener);
  };
}

export function recordUsageOps(
  dbId: DatabaseId,
  counts: { reads?: number; writes?: number; deletes?: number; error?: string | null }
): void {
  const bucket = dbId === 'ai_shared' ? (state.aiSharedUsage = normalizeUsage(state.aiSharedUsage)) : (state.defaultUsage = normalizeUsage(state.defaultUsage));
  const reads = Math.max(0, counts.reads || 0);
  const writes = Math.max(0, counts.writes || 0);
  const deletes = Math.max(0, counts.deletes || 0);
  bucket.reads += reads;
  bucket.writes += writes;
  bucket.deletes += deletes;
  bucket.totalLifetimeOps += reads + writes + deletes;

  if (counts.error) {
    const nowIso = new Date().toISOString();
    bucket.lastError = counts.error.slice(0, 400);
    bucket.lastErrorAt = nowIso;
    if (/quota|resource_exhausted|429/i.test(counts.error)) {
      bucket.lastQuotaError = counts.error.slice(0, 400);
      bucket.lastQuotaErrorAt = nowIso;
    }
  }
  savePersistedState();
}

// ============================================================
// Firebase Admin SDK & Auth Verification
// ============================================================

function getOrCreateApp(
  appName: string,
  projectId: string,
  serviceAccountJsonEnv?: string
): { app: AdminApp; authMode: 'service_account' | 'adc_iam' } {
  const existing = getApps().find((a) => a.name === appName);
  if (existing) {
    return {
      app: existing,
      authMode: serviceAccountJsonEnv?.trim() ? 'service_account' : 'adc_iam',
    };
  }
  if (serviceAccountJsonEnv && serviceAccountJsonEnv.trim()) {
    const parsed = JSON.parse(serviceAccountJsonEnv) as ServiceAccount;
    const app = initializeApp(
      {
        credential: cert(parsed),
        projectId: parsed.projectId || projectId,
      },
      appName
    );
    return { app, authMode: 'service_account' };
  }
  const app = initializeApp(
    {
      credential: applicationDefault(),
      projectId,
    },
    appName
  );
  return { app, authMode: 'adc_iam' };
}

function getAuthVerifierApp(): AdminApp {
  const appName = 'holloweve-auth-verifier';
  const existing = getApps().find((a) => a.name === appName);
  if (existing) return existing;
  return initializeApp({ projectId: AI_SHARED_CFG.projectId }, appName);
}

export async function verifyBearerToken(authHeader: string | undefined): Promise<AuthUser | null> {
  if (!authHeader || !authHeader.startsWith('Bearer ')) return null;
  const idToken = authHeader.slice(7).trim();
  if (!idToken) return null;
  try {
    const auth = getAuth(getAuthVerifierApp());
    const decoded = await auth.verifyIdToken(idToken);
    return {
      uid: decoded.uid,
      email: String(decoded.email || '').toLowerCase(),
      emailVerified: Boolean(decoded.email_verified),
      idToken,
    };
  } catch {
    return null;
  }
}

export function isAdminUser(user: AuthUser | null): boolean {
  if (!user) return false;
  return user.emailVerified && user.email === ADMIN_EMAIL;
}

export function getDefaultAdminFirestore(): {
  db: Firestore;
  authMode: 'service_account' | 'adc_iam';
} {
  const { app, authMode } = getOrCreateApp(
    'holloweve-default-db',
    DEFAULT_PROJECT_ID,
    process.env.DEFAULT_FIREBASE_SERVICE_ACCOUNT_JSON
  );
  const db =
    DEFAULT_DATABASE_ID && DEFAULT_DATABASE_ID !== '(default)'
      ? getFirestore(app, DEFAULT_DATABASE_ID)
      : getFirestore(app);
  return { db, authMode };
}

function getAiSharedAdminFirestoreIfConfigured(): {
  db: Firestore;
  authMode: 'service_account' | 'adc_iam';
} | null {
  const envSa = process.env.AI_SHARED_FIREBASE_SERVICE_ACCOUNT_JSON;
  if (!envSa || !envSa.trim()) return null;
  const { app, authMode } = getOrCreateApp(
    'holloweve-ai-shared-db',
    AI_SHARED_CFG.projectId,
    envSa
  );
  const dbId = AI_SHARED_CFG.firestoreDatabaseId;
  const db = dbId && dbId !== '(default)' ? getFirestore(app, dbId) : getFirestore(app);
  return { db, authMode };
}

// ============================================================
// Firestore Timestamp / Value Conversion Helpers
// ============================================================

function serializeAdminData(raw: DocumentData): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(raw)) {
    out[k] = serializeAdminValue(v);
  }
  return out;
}

function serializeAdminValue(v: unknown): unknown {
  if (v === null || v === undefined) return null;
  if (v instanceof Timestamp) {
    return { __fsType: 'timestamp', iso: v.toDate().toISOString() };
  }
  if (typeof v === 'object' && v !== null && 'toDate' in v && typeof (v as { toDate?: unknown }).toDate === 'function') {
    return { __fsType: 'timestamp', iso: (v as { toDate: () => Date }).toDate().toISOString() };
  }
  if (Array.isArray(v)) {
    return v.map(serializeAdminValue);
  }
  if (typeof v === 'object') {
    const obj: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      obj[k] = serializeAdminValue(val);
    }
    return obj;
  }
  return v;
}

function deserializeToAdminData(data: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(data)) {
    out[k] = deserializeToAdminValue(v);
  }
  return out;
}

function deserializeToAdminValue(v: unknown): unknown {
  if (v === null || v === undefined) return null;
  if (Array.isArray(v)) return v.map(deserializeToAdminValue);
  if (typeof v === 'object') {
    const rec = v as Record<string, unknown>;
    if (rec.__fsType === 'timestamp' && typeof rec.iso === 'string') {
      const ms = Date.parse(rec.iso);
      return Timestamp.fromMillis(Number.isFinite(ms) ? ms : Date.now());
    }
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(rec)) {
      out[k] = deserializeToAdminValue(val);
    }
    return out;
  }
  return v;
}

type RestFsValue =
  | { nullValue: null }
  | { booleanValue: boolean }
  | { integerValue: string }
  | { doubleValue: number }
  | { timestampValue: string }
  | { stringValue: string }
  | { arrayValue: { values?: RestFsValue[] } }
  | { mapValue: { fields?: Record<string, RestFsValue> } };

function fromRestFields(fields: Record<string, RestFsValue> | undefined): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (!fields) return out;
  for (const [k, v] of Object.entries(fields)) {
    out[k] = fromRestValue(v);
  }
  return out;
}

function fromRestValue(val: RestFsValue): unknown {
  if ('nullValue' in val) return null;
  if ('booleanValue' in val) return val.booleanValue;
  if ('integerValue' in val) return Number(val.integerValue);
  if ('doubleValue' in val) return val.doubleValue;
  if ('timestampValue' in val) return { __fsType: 'timestamp', iso: val.timestampValue };
  if ('stringValue' in val) return val.stringValue;
  if ('arrayValue' in val) return (val.arrayValue.values || []).map(fromRestValue);
  if ('mapValue' in val) return fromRestFields(val.mapValue.fields);
  return null;
}

function toRestFields(data: Record<string, unknown>): Record<string, RestFsValue> {
  const fields: Record<string, RestFsValue> = {};
  for (const [k, v] of Object.entries(data)) {
    fields[k] = toRestValue(v);
  }
  return fields;
}

function toRestValue(v: unknown): RestFsValue {
  if (v === null || v === undefined) return { nullValue: null };
  if (typeof v === 'boolean') return { booleanValue: v };
  if (typeof v === 'number') {
    if (Number.isInteger(v)) return { integerValue: String(v) };
    return { doubleValue: v };
  }
  if (typeof v === 'string') return { stringValue: v };
  if (Array.isArray(v)) {
    return { arrayValue: { values: v.map(toRestValue) } };
  }
  if (typeof v === 'object') {
    const rec = v as Record<string, unknown>;
    if (rec.__fsType === 'timestamp' && typeof rec.iso === 'string') {
      return { timestampValue: rec.iso };
    }
    return { mapValue: { fields: toRestFields(rec) } };
  }
  return { stringValue: String(v) };
}

function extractUpdatedAtMs(data: Record<string, unknown>): number {
  const tryParse = (val: unknown): number => {
    if (typeof val === 'object' && val !== null) {
      const rec = val as Record<string, unknown>;
      if (rec.__fsType === 'timestamp' && typeof rec.iso === 'string') {
        const ms = Date.parse(rec.iso);
        return Number.isFinite(ms) ? ms : 0;
      }
    }
    if (typeof val === 'string') {
      const ms = Date.parse(val);
      return Number.isFinite(ms) ? ms : 0;
    }
    return 0;
  };
  return tryParse(data.updatedAt) || tryParse(data.createdAt) || 0;
}

function stableStringify(val: unknown): string {
  if (val === null || val === undefined) return 'null';
  if (typeof val !== 'object') return JSON.stringify(val);
  if (Array.isArray(val)) {
    return `[${val.map(stableStringify).join(',')}]`;
  }
  const rec = val as Record<string, unknown>;
  const keys = Object.keys(rec).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(rec[k])}`).join(',')}}`;
}

function formatReadableError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  if (/PERMISSION_DENIED|403/i.test(msg)) {
    return `Permission denied (${msg}). Check IAM role roles/datastore.user or service account configuration.`;
  }
  if (/RESOURCE_EXHAUSTED|429|Quota/i.test(msg)) {
    return `Quota exceeded (${msg}).`;
  }
  return msg.slice(0, 320);
}

// ============================================================
// Firestore REST Client for AI Shared DB (when using User Token)
// ============================================================

function aiSharedBaseUrl(): string {
  const dbId = AI_SHARED_CFG.firestoreDatabaseId || '(default)';
  return `https://firestore.googleapis.com/v1/projects/${encodeURIComponent(
    AI_SHARED_CFG.projectId
  )}/databases/${encodeURIComponent(dbId)}/documents`;
}

interface RestDocResult {
  name: string;
  fields?: Record<string, RestFsValue>;
}

async function restRequest<T>(
  url: string,
  token: string,
  init: RequestInit = {}
): Promise<T> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
    ...((init.headers as Record<string, string>) || {}),
  };
  const resp = await fetch(url, { ...init, headers });
  if (!resp.ok) {
    const text = await resp.text();
    let msg = `HTTP ${resp.status}`;
    try {
      const parsed = JSON.parse(text) as { error?: { message?: string; status?: string } };
      msg = parsed.error?.message || parsed.error?.status || msg;
    } catch {
      if (text) msg = text.slice(0, 220);
    }
    throw new Error(msg);
  }
  if (resp.status === 204) return {} as T;
  return (await resp.json()) as T;
}

async function restListCollection(
  collectionPath: string,
  token: string,
  showMissing = false
): Promise<{ docs: RestDocResult[]; readOps: number }> {
  const docs: RestDocResult[] = [];
  let pageToken = '';
  let readOps = 0;
  do {
    const params = new URLSearchParams({ pageSize: '300' });
    if (showMissing) params.set('showMissing', 'true');
    if (pageToken) params.set('pageToken', pageToken);
    const url = `${aiSharedBaseUrl()}/${collectionPath}?${params.toString()}`;
    const res = await restRequest<{ documents?: RestDocResult[]; nextPageToken?: string }>(
      url,
      token
    );
    readOps += Math.max(1, res.documents?.length || 0);
    if (res.documents) {
      docs.push(...res.documents);
    }
    pageToken = res.nextPageToken || '';
  } while (pageToken);
  return { docs, readOps };
}

async function restGetDoc(docPath: string, token: string): Promise<RestDocResult | null> {
  const url = `${aiSharedBaseUrl()}/${docPath}`;
  const resp = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (resp.status === 404) return null;
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`HTTP ${resp.status}: ${text.slice(0, 180)}`);
  }
  return (await resp.json()) as RestDocResult;
}

async function restSetDoc(
  docPath: string,
  data: Record<string, unknown>,
  token: string
): Promise<void> {
  const url = `${aiSharedBaseUrl()}/${docPath}`;
  await restRequest(url, token, {
    method: 'PATCH',
    body: JSON.stringify({ fields: toRestFields(data) }),
  });
}

// ============================================================
// Export & Write Across Either Database
// ============================================================

async function exportAllFromAdminSdk(
  db: Firestore,
  dbId: DatabaseId
): Promise<ExportedDoc[]> {
  const results: ExportedDoc[] = [];
  let readCount = 0;

  try {
    // 1. Users (virtual parent refs work even when parent doc doesn't exist)
    const userRefs = await db.collection('users').listDocuments();
    readCount += 1;
    for (const userRef of userRefs) {
      const uid = userRef.id;
      const pubSnap = await userRef.collection('public').doc('profile').get();
      readCount += 1;
      if (pubSnap.exists) {
        const data = serializeAdminData(pubSnap.data() || {});
        results.push({
          docPath: `users/${uid}/public/profile`,
          group: 'publicProfiles',
          data,
          updatedAtMs: extractUpdatedAtMs(data),
        });
      }
      const privSnap = await userRef.collection('private').doc('info').get();
      readCount += 1;
      if (privSnap.exists) {
        const data = serializeAdminData(privSnap.data() || {});
        results.push({
          docPath: `users/${uid}/private/info`,
          group: 'privateInfos',
          data,
          updatedAtMs: extractUpdatedAtMs(data),
        });
      }
      const friendsSnap = await userRef.collection('friends').get();
      readCount += Math.max(1, friendsSnap.size);
      for (const fDoc of friendsSnap.docs) {
        const data = serializeAdminData(fDoc.data());
        results.push({
          docPath: `users/${uid}/friends/${fDoc.id}`,
          group: 'friends',
          data,
          updatedAtMs: extractUpdatedAtMs(data),
        });
      }
    }

    // 2. Friend Codes
    const codeSnap = await db.collection('friendCodes').get();
    readCount += Math.max(1, codeSnap.size);
    for (const cDoc of codeSnap.docs) {
      const data = serializeAdminData(cDoc.data());
      results.push({
        docPath: `friendCodes/${cDoc.id}`,
        group: 'friendCodes',
        data,
        updatedAtMs: extractUpdatedAtMs(data),
      });
    }

    // 3. Global Chat
    const chatSnap = await db.collection('globalChat').get();
    readCount += Math.max(1, chatSnap.size);
    for (const mDoc of chatSnap.docs) {
      const data = serializeAdminData(mDoc.data());
      results.push({
        docPath: `globalChat/${mDoc.id}`,
        group: 'globalChat',
        data,
        updatedAtMs: extractUpdatedAtMs(data),
      });
    }

    // 4. Rooms + Subcollections
    const roomSnap = await db.collection('rooms').get();
    readCount += Math.max(1, roomSnap.size);
    for (const rDoc of roomSnap.docs) {
      const data = serializeAdminData(rDoc.data());
      results.push({
        docPath: `rooms/${rDoc.id}`,
        group: 'rooms',
        data,
        updatedAtMs: extractUpdatedAtMs(data),
      });

      const playersSnap = await rDoc.ref.collection('players').get();
      readCount += Math.max(1, playersSnap.size);
      for (const pDoc of playersSnap.docs) {
        const pData = serializeAdminData(pDoc.data());
        results.push({
          docPath: `rooms/${rDoc.id}/players/${pDoc.id}`,
          group: 'roomPlayers',
          data: pData,
          updatedAtMs: extractUpdatedAtMs(pData),
        });
      }

      const santaSnap = await rDoc.ref.collection('santa').doc('live').get();
      readCount += 1;
      if (santaSnap.exists) {
        const sData = serializeAdminData(santaSnap.data() || {});
        results.push({
          docPath: `rooms/${rDoc.id}/santa/live`,
          group: 'roomSantas',
          data: sData,
          updatedAtMs: extractUpdatedAtMs(sData),
        });
      }

      const msgsSnap = await rDoc.ref.collection('messages').get();
      readCount += Math.max(1, msgsSnap.size);
      for (const mDoc of msgsSnap.docs) {
        const mData = serializeAdminData(mDoc.data());
        results.push({
          docPath: `rooms/${rDoc.id}/messages/${mDoc.id}`,
          group: 'roomMessages',
          data: mData,
          updatedAtMs: extractUpdatedAtMs(mData),
        });
      }
    }

    recordUsageOps(dbId, { reads: readCount });
    return results;
  } catch (err) {
    recordUsageOps(dbId, { reads: readCount, error: formatReadableError(err) });
    throw err;
  }
}

function docIdFromRestName(name: string): string {
  const parts = name.split('/');
  return parts[parts.length - 1] || '';
}

async function exportAllFromAiSharedRest(token: string): Promise<ExportedDoc[]> {
  const results: ExportedDoc[] = [];
  let readCount = 0;

  try {
    // 1. Users (showMissing lists parent UIDs even if parent doc does not exist)
    const usersRes = await restListCollection('users', token, true);
    readCount += usersRes.readOps;
    for (const uDoc of usersRes.docs) {
      const uid = docIdFromRestName(uDoc.name);
      if (!uid) continue;

      const pubDoc = await restGetDoc(`users/${uid}/public/profile`, token);
      readCount += 1;
      if (pubDoc?.fields) {
        const data = fromRestFields(pubDoc.fields);
        results.push({
          docPath: `users/${uid}/public/profile`,
          group: 'publicProfiles',
          data,
          updatedAtMs: extractUpdatedAtMs(data),
        });
      }

      const privDoc = await restGetDoc(`users/${uid}/private/info`, token);
      readCount += 1;
      if (privDoc?.fields) {
        const data = fromRestFields(privDoc.fields);
        results.push({
          docPath: `users/${uid}/private/info`,
          group: 'privateInfos',
          data,
          updatedAtMs: extractUpdatedAtMs(data),
        });
      }

      const friendsRes = await restListCollection(`users/${uid}/friends`, token);
      readCount += friendsRes.readOps;
      for (const fDoc of friendsRes.docs) {
        if (!fDoc.fields) continue;
        const fid = docIdFromRestName(fDoc.name);
        const data = fromRestFields(fDoc.fields);
        results.push({
          docPath: `users/${uid}/friends/${fid}`,
          group: 'friends',
          data,
          updatedAtMs: extractUpdatedAtMs(data),
        });
      }
    }

    // 2. Friend Codes
    const codesRes = await restListCollection('friendCodes', token);
    readCount += codesRes.readOps;
    for (const cDoc of codesRes.docs) {
      if (!cDoc.fields) continue;
      const cid = docIdFromRestName(cDoc.name);
      const data = fromRestFields(cDoc.fields);
      results.push({
        docPath: `friendCodes/${cid}`,
        group: 'friendCodes',
        data,
        updatedAtMs: extractUpdatedAtMs(data),
      });
    }

    // 3. Global Chat
    const chatRes = await restListCollection('globalChat', token);
    readCount += chatRes.readOps;
    for (const mDoc of chatRes.docs) {
      if (!mDoc.fields) continue;
      const mid = docIdFromRestName(mDoc.name);
      const data = fromRestFields(mDoc.fields);
      results.push({
        docPath: `globalChat/${mid}`,
        group: 'globalChat',
        data,
        updatedAtMs: extractUpdatedAtMs(data),
      });
    }

    // 4. Rooms + Subcollections
    const roomsRes = await restListCollection('rooms', token);
    readCount += roomsRes.readOps;
    for (const rDoc of roomsRes.docs) {
      if (!rDoc.fields) continue;
      const rid = docIdFromRestName(rDoc.name);
      const data = fromRestFields(rDoc.fields);
      results.push({
        docPath: `rooms/${rid}`,
        group: 'rooms',
        data,
        updatedAtMs: extractUpdatedAtMs(data),
      });

      const playersRes = await restListCollection(`rooms/${rid}/players`, token);
      readCount += playersRes.readOps;
      for (const pDoc of playersRes.docs) {
        if (!pDoc.fields) continue;
        const pid = docIdFromRestName(pDoc.name);
        const pData = fromRestFields(pDoc.fields);
        results.push({
          docPath: `rooms/${rid}/players/${pid}`,
          group: 'roomPlayers',
          data: pData,
          updatedAtMs: extractUpdatedAtMs(pData),
        });
      }

      const santaDoc = await restGetDoc(`rooms/${rid}/santa/live`, token);
      readCount += 1;
      if (santaDoc?.fields) {
        const sData = fromRestFields(santaDoc.fields);
        results.push({
          docPath: `rooms/${rid}/santa/live`,
          group: 'roomSantas',
          data: sData,
          updatedAtMs: extractUpdatedAtMs(sData),
        });
      }

      const msgsRes = await restListCollection(`rooms/${rid}/messages`, token);
      readCount += msgsRes.readOps;
      for (const mDoc of msgsRes.docs) {
        if (!mDoc.fields) continue;
        const mid = docIdFromRestName(mDoc.name);
        const mData = fromRestFields(mDoc.fields);
        results.push({
          docPath: `rooms/${rid}/messages/${mid}`,
          group: 'roomMessages',
          data: mData,
          updatedAtMs: extractUpdatedAtMs(mData),
        });
      }
    }

    recordUsageOps('ai_shared', { reads: readCount });
    return results;
  } catch (err) {
    recordUsageOps('ai_shared', { reads: readCount, error: formatReadableError(err) });
    throw err;
  }
}

async function exportDatabaseSnapshot(
  dbId: DatabaseId,
  adminToken: string
): Promise<ExportedDoc[]> {
  if (dbId === 'default') {
    const { db } = getDefaultAdminFirestore();
    return exportAllFromAdminSdk(db, 'default');
  }
  const saAi = getAiSharedAdminFirestoreIfConfigured();
  if (saAi) {
    return exportAllFromAdminSdk(saAi.db, 'ai_shared');
  }
  return exportAllFromAiSharedRest(adminToken);
}

async function writeExportedDoc(
  targetDb: DatabaseId,
  docPath: string,
  data: Record<string, unknown>,
  adminToken: string
): Promise<void> {
  if (targetDb === 'default') {
    const { db } = getDefaultAdminFirestore();
    await db.doc(docPath).set(deserializeToAdminData(data));
    recordUsageOps('default', { writes: 1 });
    return;
  }
  const saAi = getAiSharedAdminFirestoreIfConfigured();
  if (saAi) {
    await saAi.db.doc(docPath).set(deserializeToAdminData(data));
    recordUsageOps('ai_shared', { writes: 1 });
    return;
  }
  await restSetDoc(docPath, data, adminToken);
  recordUsageOps('ai_shared', { writes: 1 });
}

function summarizeDocs(docs: ExportedDoc[]): {
  docCounts: Record<string, number>;
  totalDocs: number;
  estimatedBytes: number;
  latestRecordAt: string | null;
  latestMs: number;
} {
  const docCounts: Record<string, number> = {
    publicProfiles: 0,
    privateInfos: 0,
    friends: 0,
    friendCodes: 0,
    globalChat: 0,
    rooms: 0,
    roomPlayers: 0,
    roomSantas: 0,
    roomMessages: 0,
  };
  let estimatedBytes = 0;
  let latestMs = 0;

  for (const d of docs) {
    docCounts[d.group] = (docCounts[d.group] || 0) + 1;
    estimatedBytes += Buffer.byteLength(d.docPath, 'utf8') + Buffer.byteLength(JSON.stringify(d.data), 'utf8');
    if (d.updatedAtMs > latestMs) latestMs = d.updatedAtMs;
  }

  return {
    docCounts,
    totalDocs: docs.length,
    estimatedBytes,
    latestRecordAt: latestMs > 0 ? new Date(latestMs).toISOString() : null,
    latestMs,
  };
}

function buildQuotaBlock(usage: DailyUsageStats, estimatedBytes: number, note: string) {
  return {
    dailyReadLimit: SPARK_DAILY_READ_LIMIT,
    dailyWriteLimit: SPARK_DAILY_WRITE_LIMIT,
    dailyDeleteLimit: SPARK_DAILY_DELETE_LIMIT,
    storageLimitBytes: SPARK_STORAGE_LIMIT_BYTES,
    readsRemaining: Math.max(0, SPARK_DAILY_READ_LIMIT - usage.reads),
    writesRemaining: Math.max(0, SPARK_DAILY_WRITE_LIMIT - usage.writes),
    deletesRemaining: Math.max(0, SPARK_DAILY_DELETE_LIMIT - usage.deletes),
    storageRemainingBytes: Math.max(0, SPARK_STORAGE_LIMIT_BYTES - estimatedBytes),
    quotaProviderNote: note,
  };
}

// ============================================================
// Admin Overview, Switching, Mirroring & Restore
// ============================================================

export async function getAdminDatabaseOverview(adminToken: string): Promise<DbAdminOverview> {
  const notifications: { level: 'error' | 'warning' | 'info'; message: string }[] = [];

  // Probe Default Database
  let defaultStatus: DbStatusInfo;
  const defStart = Date.now();
  const { authMode: defAuthMode } = getDefaultAdminFirestore();
  try {
    const defDocs = await exportDatabaseSnapshot('default', adminToken);
    const defSummary = summarizeDocs(defDocs);
    const defUsage = normalizeUsage(state.defaultUsage);
    defaultStatus = {
      id: 'default',
      label: 'Default Database',
      projectId: DEFAULT_PROJECT_ID,
      databaseId: DEFAULT_DATABASE_ID,
      connected: true,
      authMode: defAuthMode,
      latencyMs: Date.now() - defStart,
      error: null,
      docCounts: defSummary.docCounts,
      totalDocs: defSummary.totalDocs,
      estimatedBytes: defSummary.estimatedBytes,
      latestRecordAt: defSummary.latestRecordAt,
      usage: defUsage,
      quota: buildQuotaBlock(
        defUsage,
        defSummary.estimatedBytes,
        'Tracked server operations & serialized document volume.'
      ),
    };
  } catch (err) {
    const errMsg = formatReadableError(err);
    const defUsage = normalizeUsage(state.defaultUsage);
    defaultStatus = {
      id: 'default',
      label: 'Default Database',
      projectId: DEFAULT_PROJECT_ID,
      databaseId: DEFAULT_DATABASE_ID,
      connected: false,
      authMode: defAuthMode,
      latencyMs: Date.now() - defStart,
      error: errMsg,
      docCounts: {},
      totalDocs: 0,
      estimatedBytes: 0,
      latestRecordAt: null,
      usage: defUsage,
      quota: buildQuotaBlock(
        defUsage,
        0,
        'Grant roles/datastore.user to the runtime service account or configure DEFAULT_FIREBASE_SERVICE_ACCOUNT_JSON.'
      ),
    };
    notifications.push({
      level: 'error',
      message: `Default Database (${DEFAULT_PROJECT_ID}) connection failed: ${errMsg}`,
    });
  }

  // Probe AI Shared Database (only when Admin explicitly inspects overview)
  let aiStatus: DbStatusInfo;
  const aiStart = Date.now();
  const saAi = getAiSharedAdminFirestoreIfConfigured();
  const aiAuthMode = saAi ? saAi.authMode : 'user_token_rest';
  try {
    const aiDocs = await exportDatabaseSnapshot('ai_shared', adminToken);
    const aiSummary = summarizeDocs(aiDocs);
    const aiUsage = normalizeUsage(state.aiSharedUsage);
    aiStatus = {
      id: 'ai_shared',
      label: 'AI Shared Database',
      projectId: AI_SHARED_CFG.projectId,
      databaseId: AI_SHARED_CFG.firestoreDatabaseId || '(default)',
      connected: true,
      authMode: aiAuthMode,
      latencyMs: Date.now() - aiStart,
      error: null,
      docCounts: aiSummary.docCounts,
      totalDocs: aiSummary.totalDocs,
      estimatedBytes: aiSummary.estimatedBytes,
      latestRecordAt: aiSummary.latestRecordAt,
      usage: aiUsage,
      quota: buildQuotaBlock(
        aiUsage,
        aiSummary.estimatedBytes,
        'Tracked usage against Spark daily quotas (50k reads, 20k writes, 20k deletes, 1 GiB). Firebase does not expose live billing counters via client/Spark APIs.'
      ),
    };
  } catch (err) {
    const errMsg = formatReadableError(err);
    const aiUsage = normalizeUsage(state.aiSharedUsage);
    aiStatus = {
      id: 'ai_shared',
      label: 'AI Shared Database',
      projectId: AI_SHARED_CFG.projectId,
      databaseId: AI_SHARED_CFG.firestoreDatabaseId || '(default)',
      connected: false,
      authMode: aiAuthMode,
      latencyMs: Date.now() - aiStart,
      error: errMsg,
      docCounts: {},
      totalDocs: 0,
      estimatedBytes: 0,
      latestRecordAt: null,
      usage: aiUsage,
      quota: buildQuotaBlock(
        aiUsage,
        0,
        'Spark daily quota tracking active.'
      ),
    };
    notifications.push({
      level: 'error',
      message: `AI Shared Database (${AI_SHARED_CFG.projectId}) probe failed: ${errMsg}`,
    });
  }

  let latestDataWinner: DbAdminOverview['latestDataWinner'] = 'unknown';
  if (defaultStatus.connected && aiStatus.connected) {
    const defMs = defaultStatus.latestRecordAt ? Date.parse(defaultStatus.latestRecordAt) : 0;
    const aiMs = aiStatus.latestRecordAt ? Date.parse(aiStatus.latestRecordAt) : 0;
    if (defaultStatus.totalDocs === 0 && aiStatus.totalDocs === 0) {
      latestDataWinner = 'in_sync';
    } else if (Math.abs(defMs - aiMs) < 1500 && defaultStatus.totalDocs === aiStatus.totalDocs) {
      latestDataWinner = 'in_sync';
    } else if (defMs >= aiMs && defaultStatus.totalDocs > 0) {
      latestDataWinner = 'default';
    } else if (aiMs > defMs || (aiStatus.totalDocs > 0 && defaultStatus.totalDocs === 0)) {
      latestDataWinner = 'ai_shared';
    }
  } else if (defaultStatus.connected) {
    latestDataWinner = 'default';
  } else if (aiStatus.connected) {
    latestDataWinner = 'ai_shared';
  }

  if (state.aiSharedUsage.lastQuotaError) {
    notifications.push({
      level: 'warning',
      message: `AI Shared Database quota warning (${state.aiSharedUsage.lastQuotaErrorAt}): ${state.aiSharedUsage.lastQuotaError}`,
    });
  }
  if (state.lastSync?.status === 'failed' || state.lastSync?.status === 'partial') {
    notifications.push({
      level: 'warning',
      message: `Last sync (${state.lastSync.timestamp}) finished with status "${state.lastSync.status}": ${state.lastSync.error || state.lastSync.summary}`,
    });
  }

  return {
    activeDatabase: state.activeDatabase,
    lastSwitchAt: state.lastSwitchAt,
    latestDataWinner,
    databases: {
      default: defaultStatus,
      ai_shared: aiStatus,
    },
    lastSync: state.lastSync,
    currentJob: currentMirrorJob,
    backups: state.backups,
    notifications,
  };
}

export async function switchActiveDatabase(
  targetDatabase: DatabaseId,
  adminToken: string
): Promise<{ activeDatabase: DatabaseId; lastSwitchAt: string }> {
  if (targetDatabase !== 'default' && targetDatabase !== 'ai_shared') {
    throw new Error('Invalid target database.');
  }
  // Verify target is reachable before switching live traffic
  if (targetDatabase === 'default') {
    const { db } = getDefaultAdminFirestore();
    await db.collection('rooms').limit(1).get();
    recordUsageOps('default', { reads: 1 });
  } else {
    const saAi = getAiSharedAdminFirestoreIfConfigured();
    if (saAi) {
      await saAi.db.collection('rooms').limit(1).get();
      recordUsageOps('ai_shared', { reads: 1 });
    } else {
      await restListCollection('rooms', adminToken);
      recordUsageOps('ai_shared', { reads: 1 });
    }
  }

  const nowIso = new Date().toISOString();
  state.activeDatabase = targetDatabase;
  state.lastSwitchAt = nowIso;
  savePersistedState();

  for (const listener of activeDbListeners) {
    try {
      listener(state.activeDatabase, state.lastSwitchAt);
    } catch {
      // ignore closed listeners
    }
  }

  return { activeDatabase: state.activeDatabase, lastSwitchAt: nowIso };
}

function saveBackupSnapshot(
  targetDatabase: DatabaseId,
  direction: MirrorDirection | 'restore',
  docs: ExportedDoc[]
): BackupMetadata {
  ensureDirs();
  const backupId = `backup_${targetDatabase}_${Date.now()}`;
  const payload = JSON.stringify({
    backupId,
    createdAt: new Date().toISOString(),
    targetDatabase,
    direction,
    docs,
  });
  const filePath = path.join(BACKUPS_DIR, `${backupId}.json`);
  fs.writeFileSync(filePath, payload, 'utf8');

  const meta: BackupMetadata = {
    backupId,
    createdAt: new Date().toISOString(),
    targetDatabase,
    direction,
    recordCount: docs.length,
    sizeBytes: Buffer.byteLength(payload, 'utf8'),
  };
  state.backups = [meta, ...state.backups].slice(0, 15);
  savePersistedState();
  return meta;
}

export function startMirrorJob(
  direction: MirrorDirection,
  strategy: ConflictStrategy,
  adminToken: string
): MirrorJobState {
  if (currentMirrorJob && currentMirrorJob.status === 'running') {
    throw new Error('A mirroring or sync job is already in progress.');
  }

  const jobId = `job_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  currentMirrorJob = {
    jobId,
    direction,
    strategy,
    status: 'running',
    phase: 'Inspecting both databases & creating pre-sync backup...',
    startedAt: new Date().toISOString(),
    finishedAt: null,
    processedDocs: 0,
    totalDocs: 0,
    progressPct: 5,
    copiedCount: 0,
    skippedCount: 0,
    conflictsCount: 0,
    errorCount: 0,
    backupId: null,
    error: null,
    conflicts: [],
    errors: [],
  };

  void executeMirrorJob(currentMirrorJob, adminToken);
  return currentMirrorJob;
}

export function getMirrorJob(jobId: string): MirrorJobState | null {
  if (currentMirrorJob && currentMirrorJob.jobId === jobId) return currentMirrorJob;
  return null;
}

async function executeMirrorJob(job: MirrorJobState, adminToken: string): Promise<void> {
  try {
    job.phase = 'Reading Default & AI Shared snapshots...';
    const [defaultDocs, aiDocs] = await Promise.all([
      exportDatabaseSnapshot('default', adminToken),
      exportDatabaseSnapshot('ai_shared', adminToken),
    ]);

    job.progressPct = 20;
    job.phase = 'Creating pre-sync backup snapshot...';

    if (job.direction === 'default_to_ai') {
      const backup = saveBackupSnapshot('ai_shared', job.direction, aiDocs);
      job.backupId = backup.backupId;
    } else if (job.direction === 'ai_shared_to_default') {
      const backup = saveBackupSnapshot('default', job.direction, defaultDocs);
      job.backupId = backup.backupId;
    } else {
      const backup = saveBackupSnapshot('default', job.direction, defaultDocs);
      saveBackupSnapshot('ai_shared', job.direction, aiDocs);
      job.backupId = backup.backupId;
    }

    const defaultMap = new Map<string, ExportedDoc>(defaultDocs.map((d) => [d.docPath, d]));
    const aiMap = new Map<string, ExportedDoc>(aiDocs.map((d) => [d.docPath, d]));
    const allPaths = Array.from(new Set([...defaultMap.keys(), ...aiMap.keys()])).sort();

    job.totalDocs = Math.max(1, allPaths.length);
    job.progressPct = 30;
    job.phase = 'Synchronizing records safely...';

    for (let i = 0; i < allPaths.length; i++) {
      const docPath = allPaths[i];
      const defDoc = defaultMap.get(docPath);
      const aiDoc = aiMap.get(docPath);

      try {
        if (job.direction === 'default_to_ai') {
          if (!defDoc) {
            job.skippedCount += 1;
          } else if (!aiDoc) {
            await writeExportedDoc('ai_shared', docPath, defDoc.data, adminToken);
            job.copiedCount += 1;
          } else if (stableStringify(defDoc.data) === stableStringify(aiDoc.data)) {
            job.skippedCount += 1;
          } else {
            await resolveOneWayPair(job, 'ai_shared', defDoc, aiDoc, adminToken);
          }
        } else if (job.direction === 'ai_shared_to_default') {
          if (!aiDoc) {
            job.skippedCount += 1;
          } else if (!defDoc) {
            await writeExportedDoc('default', docPath, aiDoc.data, adminToken);
            job.copiedCount += 1;
          } else if (stableStringify(defDoc.data) === stableStringify(aiDoc.data)) {
            job.skippedCount += 1;
          } else {
            await resolveOneWayPair(job, 'default', aiDoc, defDoc, adminToken);
          }
        } else {
          // Bidirectional smart sync
          if (defDoc && !aiDoc) {
            await writeExportedDoc('ai_shared', docPath, defDoc.data, adminToken);
            job.copiedCount += 1;
          } else if (!defDoc && aiDoc) {
            await writeExportedDoc('default', docPath, aiDoc.data, adminToken);
            job.copiedCount += 1;
          } else if (defDoc && aiDoc) {
            if (stableStringify(defDoc.data) === stableStringify(aiDoc.data)) {
              job.skippedCount += 1;
            } else {
              await resolveBidirectionalPair(job, defDoc, aiDoc, adminToken);
            }
          }
        }
      } catch (docErr) {
        const msg = formatReadableError(docErr);
        job.errorCount += 1;
        job.errors.push(`${docPath}: ${msg}`);
        job.conflicts.push({
          docPath,
          collection: (defDoc || aiDoc)?.group || 'unknown',
          sourceUpdatedAt: defDoc?.updatedAtMs ? new Date(defDoc.updatedAtMs).toISOString() : null,
          targetUpdatedAt: aiDoc?.updatedAtMs ? new Date(aiDoc.updatedAtMs).toISOString() : null,
          resolution: 'error',
          note: msg,
        });
      }

      job.processedDocs = i + 1;
      job.progressPct = Math.min(99, 30 + Math.round(((i + 1) / allPaths.length) * 69));
    }

    job.finishedAt = new Date().toISOString();
    job.progressPct = 100;
    job.status = job.errorCount > 0 ? 'partial' : 'completed';
    job.phase =
      job.errorCount > 0
        ? `Completed with ${job.errorCount} error(s). Backup preserved (${job.backupId}).`
        : 'Synchronisation completed cleanly.';

    state.lastSync = {
      timestamp: job.finishedAt,
      direction: job.direction,
      strategy: job.strategy,
      status: job.errorCount > 0 ? 'partial' : 'success',
      copiedCount: job.copiedCount,
      skippedCount: job.skippedCount,
      conflictsCount: job.conflictsCount,
      errorCount: job.errorCount,
      backupId: job.backupId,
      error: job.errors[0] || null,
      summary: `${job.copiedCount} updated, ${job.skippedCount} unchanged/skipped, ${job.conflictsCount} conflict(s), ${job.errorCount} error(s).`,
    };
    savePersistedState();
  } catch (err) {
    const errMsg = formatReadableError(err);
    job.finishedAt = new Date().toISOString();
    job.status = 'failed';
    job.error = errMsg;
    job.errorCount += 1;
    job.errors.push(errMsg);
    job.phase = `Synchronisation failed: ${errMsg}`;

    state.lastSync = {
      timestamp: job.finishedAt,
      direction: job.direction,
      strategy: job.strategy,
      status: 'failed',
      copiedCount: job.copiedCount,
      skippedCount: job.skippedCount,
      conflictsCount: job.conflictsCount,
      errorCount: job.errorCount,
      backupId: job.backupId,
      error: errMsg,
      summary: `Failed before completion: ${errMsg}`,
    };
    savePersistedState();
  }
}

async function resolveOneWayPair(
  job: MirrorJobState,
  targetDb: DatabaseId,
  sourceDoc: ExportedDoc,
  targetDoc: ExportedDoc,
  adminToken: string
): Promise<void> {
  const srcIso = sourceDoc.updatedAtMs ? new Date(sourceDoc.updatedAtMs).toISOString() : null;
  const tgtIso = targetDoc.updatedAtMs ? new Date(targetDoc.updatedAtMs).toISOString() : null;

  if (job.strategy === 'skip_conflicts') {
    job.conflictsCount += 1;
    job.skippedCount += 1;
    job.conflicts.push({
      docPath: sourceDoc.docPath,
      collection: sourceDoc.group,
      sourceUpdatedAt: srcIso,
      targetUpdatedAt: tgtIso,
      resolution: 'skipped_conflict',
      note: 'Skipped existing differing document under Skip Conflicts policy.',
    });
    return;
  }

  if (job.strategy === 'newest_wins' && targetDoc.updatedAtMs > sourceDoc.updatedAtMs) {
    job.conflictsCount += 1;
    job.skippedCount += 1;
    job.conflicts.push({
      docPath: sourceDoc.docPath,
      collection: sourceDoc.group,
      sourceUpdatedAt: srcIso,
      targetUpdatedAt: tgtIso,
      resolution: 'kept_target',
      note: 'Target record is newer; preserved target to avoid stale overwrite.',
    });
    return;
  }

  await writeExportedDoc(targetDb, sourceDoc.docPath, sourceDoc.data, adminToken);
  job.copiedCount += 1;
  if (targetDoc.updatedAtMs > 0) {
    job.conflictsCount += 1;
    job.conflicts.push({
      docPath: sourceDoc.docPath,
      collection: sourceDoc.group,
      sourceUpdatedAt: srcIso,
      targetUpdatedAt: tgtIso,
      resolution: 'copied_source',
      note:
        job.strategy === 'overwrite_with_backup'
          ? 'Applied source after saving pre-sync backup.'
          : 'Source record was newer or equal; updated target.',
    });
  }
}

async function resolveBidirectionalPair(
  job: MirrorJobState,
  defDoc: ExportedDoc,
  aiDoc: ExportedDoc,
  adminToken: string
): Promise<void> {
  const defIso = defDoc.updatedAtMs ? new Date(defDoc.updatedAtMs).toISOString() : null;
  const aiIso = aiDoc.updatedAtMs ? new Date(aiDoc.updatedAtMs).toISOString() : null;

  if (job.strategy === 'skip_conflicts') {
    job.conflictsCount += 1;
    job.skippedCount += 1;
    job.conflicts.push({
      docPath: defDoc.docPath,
      collection: defDoc.group,
      sourceUpdatedAt: defIso,
      targetUpdatedAt: aiIso,
      resolution: 'skipped_conflict',
      note: 'Differing records on both databases; skipped under Skip Conflicts policy.',
    });
    return;
  }

  if (job.strategy === 'overwrite_with_backup' || defDoc.updatedAtMs >= aiDoc.updatedAtMs) {
    await writeExportedDoc('ai_shared', defDoc.docPath, defDoc.data, adminToken);
    job.copiedCount += 1;
    job.conflictsCount += 1;
    job.conflicts.push({
      docPath: defDoc.docPath,
      collection: defDoc.group,
      sourceUpdatedAt: defIso,
      targetUpdatedAt: aiIso,
      resolution: 'copied_source',
      note: 'Default Database record was newer/preferred; synced to AI Shared Database.',
    });
  } else {
    await writeExportedDoc('default', aiDoc.docPath, aiDoc.data, adminToken);
    job.copiedCount += 1;
    job.conflictsCount += 1;
    job.conflicts.push({
      docPath: defDoc.docPath,
      collection: defDoc.group,
      sourceUpdatedAt: defIso,
      targetUpdatedAt: aiIso,
      resolution: 'copied_target',
      note: 'AI Shared Database record was newer; synced to Default Database.',
    });
  }
}

export async function restoreFromBackup(
  backupId: string,
  adminToken: string
): Promise<{ restoredCount: number; targetDatabase: DatabaseId }> {
  const safeId = path.basename(backupId).replace(/[^a-zA-Z0-9_\-]/g, '');
  const resolved = path.resolve(BACKUPS_DIR, `${safeId}.json`);
  if (!resolved.startsWith(BACKUPS_DIR + path.sep) || !fs.existsSync(resolved)) {
    throw new Error('Backup snapshot not found.');
  }

  const parsed = JSON.parse(fs.readFileSync(resolved, 'utf8')) as {
    targetDatabase: DatabaseId;
    docs: ExportedDoc[];
  };

  let restoredCount = 0;
  for (const docItem of parsed.docs) {
    await writeExportedDoc(parsed.targetDatabase, docItem.docPath, docItem.data, adminToken);
    restoredCount += 1;
  }

  return { restoredCount, targetDatabase: parsed.targetDatabase };
}

// ============================================================
// Normal Application Data Proxy Helpers (Active Default DB)
// ============================================================

function sanitizeDisplayName(raw: string): string {
  const cleaned = raw.trim().replace(/\s+/g, ' ').slice(0, 24);
  return cleaned.length >= 2 ? cleaned : 'Survivor';
}

function sanitizeColor(hex: string, fallback: string): string {
  return /^#[0-9a-fA-F]{6}$/.test(hex) ? hex : fallback;
}

const VALID_HATS = new Set(['hood', 'beanie', 'santa_hat', 'ushanka']);
function sanitizeHat(raw: string): string {
  return VALID_HATS.has(raw) ? raw : 'hood';
}

function sanitizeWeapon(raw: unknown): string {
  if (raw === 'tranq_dart' || raw === 'cryo_blaster' || raw === 'candy_bat') return raw;
  return '';
}

function deriveFriendCode(uid: string): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let hash = 2166136261;
  for (let i = 0; i < uid.length; i++) {
    hash ^= uid.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  let suffix = '';
  let val = hash >>> 0;
  for (let i = 0; i < 6; i++) {
    suffix += alphabet[val % alphabet.length];
    val = Math.floor(val / alphabet.length) ^ ((uid.charCodeAt(i % uid.length) || 7) * 31);
    val = val >>> 0;
  }
  return `SV-${suffix}`;
}

const COAT_HEXES = ['#b91c1c', '#1d4ed8', '#15803d', '#a16207', '#6d28d9', '#0f766e'];
const SCARF_HEXES = ['#f8fafc', '#dc2626', '#16a34a', '#f59e0b', '#38bdf8'];

export async function proxyEnsureProfile(user: AuthUser, preferredName?: string) {
  const { db } = getDefaultAdminFirestore();
  const fallbackName = sanitizeDisplayName(
    preferredName || user.email.split('@')[0] || 'Survivor'
  );

  // Private PII record
  try {
    const privRef = db.doc(`users/${user.uid}/private/info`);
    const privSnap = await privRef.get();
    recordUsageOps('default', { reads: 1 });
    if (!privSnap.exists) {
      await privRef.set({
        uid: user.uid,
        email: (user.email || 'survivor@example.com').slice(0, 254),
        createdAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      });
      recordUsageOps('default', { writes: 1 });
    }
  } catch (err) {
    recordUsageOps('default', { error: formatReadableError(err) });
    throw err;
  }

  const pubRef = db.doc(`users/${user.uid}/public/profile`);
  const pubSnap = await pubRef.get();
  recordUsageOps('default', { reads: 1 });

  if (pubSnap.exists) {
    const d = pubSnap.data() || {};
    const friendCode =
      typeof d.friendCode === 'string' && /^[A-Z0-9_-]{4,16}$/.test(d.friendCode)
        ? d.friendCode
        : deriveFriendCode(user.uid);
    const profile = {
      uid: user.uid,
      displayName: sanitizeDisplayName(String(d.displayName || 'Survivor')),
      coatColor: sanitizeColor(String(d.coatColor || COAT_HEXES[0]), COAT_HEXES[0]),
      scarfColor: sanitizeColor(String(d.scarfColor || SCARF_HEXES[0]), SCARF_HEXES[0]),
      hatStyle: sanitizeHat(String(d.hatStyle || 'hood')),
      friendCode,
      level: Math.max(1, Math.min(99, Number(d.level || 1))),
      xp: Math.max(0, Number(d.xp || 0)),
      escapes: Math.max(0, Number(d.escapes || 0)),
      gamesPlayed: Math.max(0, Number(d.gamesPlayed || 0)),
    };

    if (
      d.scarfColor === undefined ||
      d.hatStyle === undefined ||
      d.friendCode === undefined ||
      d.level === undefined ||
      d.xp === undefined
    ) {
      await pubRef.update({
        scarfColor: profile.scarfColor,
        hatStyle: profile.hatStyle,
        friendCode: profile.friendCode,
        level: profile.level,
        xp: profile.xp,
        updatedAt: FieldValue.serverTimestamp(),
      });
      recordUsageOps('default', { writes: 1 });
    }

    const codeRef = db.doc(`friendCodes/${friendCode}`);
    const codeSnap = await codeRef.get();
    recordUsageOps('default', { reads: 1 });
    if (!codeSnap.exists) {
      await codeRef.set({
        uid: user.uid,
        friendCode,
        createdAt: FieldValue.serverTimestamp(),
      });
      recordUsageOps('default', { writes: 1 });
    }
    return profile;
  }

  const defaultColor = COAT_HEXES[Math.floor(Math.random() * COAT_HEXES.length)];
  const defaultScarf = SCARF_HEXES[Math.floor(Math.random() * SCARF_HEXES.length)];
  const friendCode = deriveFriendCode(user.uid);

  await pubRef.set({
    uid: user.uid,
    displayName: fallbackName,
    coatColor: defaultColor,
    scarfColor: defaultScarf,
    hatStyle: 'hood',
    friendCode,
    level: 1,
    xp: 0,
    escapes: 0,
    gamesPlayed: 0,
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  });
  await db.doc(`friendCodes/${friendCode}`).set({
    uid: user.uid,
    friendCode,
    createdAt: FieldValue.serverTimestamp(),
  });
  recordUsageOps('default', { writes: 2 });

  return {
    uid: user.uid,
    displayName: fallbackName,
    coatColor: defaultColor,
    scarfColor: defaultScarf,
    hatStyle: 'hood',
    friendCode,
    level: 1,
    xp: 0,
    escapes: 0,
    gamesPlayed: 0,
  };
}

export async function proxyUpdateProfile(
  uid: string,
  updates: { displayName: string; coatColor: string; scarfColor: string; hatStyle: string }
) {
  const { db } = getDefaultAdminFirestore();
  const ref = db.doc(`users/${uid}/public/profile`);
  const cleanName = sanitizeDisplayName(updates.displayName);
  const cleanCoat = sanitizeColor(updates.coatColor, COAT_HEXES[0]);
  const cleanScarf = sanitizeColor(updates.scarfColor, SCARF_HEXES[0]);
  const cleanHat = sanitizeHat(updates.hatStyle);

  await ref.update({
    displayName: cleanName,
    coatColor: cleanCoat,
    scarfColor: cleanScarf,
    hatStyle: cleanHat,
    updatedAt: FieldValue.serverTimestamp(),
  });
  const snap = await ref.get();
  recordUsageOps('default', { writes: 1, reads: 1 });
  const d = snap.data() || {};
  return {
    uid,
    displayName: cleanName,
    coatColor: cleanCoat,
    scarfColor: cleanScarf,
    hatStyle: cleanHat,
    friendCode: String(d.friendCode || deriveFriendCode(uid)),
    level: Math.max(1, Math.min(99, Number(d.level || 1))),
    xp: Math.max(0, Number(d.xp || 0)),
    escapes: Number(d.escapes || 0),
    gamesPlayed: Number(d.gamesPlayed || 0),
  };
}

function xpForNext(level: number): number {
  return Math.round(110 + Math.pow(Math.max(1, level), 1.45) * 45);
}

export async function proxyRecordOutcome(uid: string, escaped: boolean, earnedXp: number) {
  const { db } = getDefaultAdminFirestore();
  const ref = db.doc(`users/${uid}/public/profile`);
  const snap = await ref.get();
  recordUsageOps('default', { reads: 1 });
  if (!snap.exists) return null;

  const d = snap.data() || {};
  let lvl = Math.max(1, Math.min(99, Number(d.level || 1)));
  let xp = Math.max(0, Number(d.xp || 0)) + Math.max(0, Math.floor(earnedXp));
  let leveledUp = false;
  while (lvl < 99 && xp >= xpForNext(lvl)) {
    xp -= xpForNext(lvl);
    lvl += 1;
    leveledUp = true;
  }
  const nextXp = Math.min(1_000_000, xp);
  const nextEscapes = Math.min(100_000, Number(d.escapes || 0) + (escaped ? 1 : 0));
  const nextGames = Math.min(100_000, Number(d.gamesPlayed || 0) + 1);

  await ref.update({
    level: lvl,
    xp: nextXp,
    escapes: nextEscapes,
    gamesPlayed: nextGames,
    updatedAt: FieldValue.serverTimestamp(),
  });
  recordUsageOps('default', { writes: 1 });

  return { level: lvl, xp: nextXp, leveledUp, escapes: nextEscapes, gamesPlayed: nextGames };
}

export async function proxyListFriends(uid: string) {
  const { db } = getDefaultAdminFirestore();
  const snap = await db.collection(`users/${uid}/friends`).where('ownerUid', '==', uid).get();
  recordUsageOps('default', { reads: Math.max(1, snap.size) });
  const order: Record<string, number> = { pending_received: 0, accepted: 1, pending_sent: 2 };
  return snap.docs
    .map((docSnap) => {
      const d = docSnap.data();
      return {
        ownerUid: String(d.ownerUid || uid),
        friendUid: String(d.friendUid || docSnap.id),
        displayName: String(d.displayName || 'Survivor'),
        coatColor: sanitizeColor(String(d.coatColor || COAT_HEXES[0]), COAT_HEXES[0]),
        scarfColor: sanitizeColor(String(d.scarfColor || SCARF_HEXES[0]), SCARF_HEXES[0]),
        hatStyle: sanitizeHat(String(d.hatStyle || 'hood')),
        friendCode: String(d.friendCode || ''),
        level: Math.max(1, Math.min(99, Number(d.level || 1))),
        status: String(d.status || 'accepted'),
      };
    })
    .sort((a, b) => (order[a.status] ?? 3) - (order[b.status] ?? 3) || a.displayName.localeCompare(b.displayName));
}

export async function proxySendFriendRequest(
  myUid: string,
  opts: { targetUid?: string; code?: string }
): Promise<void> {
  const { db } = getDefaultAdminFirestore();
  const mySnap = await db.doc(`users/${myUid}/public/profile`).get();
  recordUsageOps('default', { reads: 1 });
  if (!mySnap.exists) throw new Error('Your survivor profile was not found.');
  const myData = mySnap.data() || {};

  let targetUid = (opts.targetUid || '').trim();
  if (!targetUid && opts.code) {
    const cleanCode = opts.code.trim().toUpperCase();
    if (!/^[A-Z0-9_-]{4,16}$/.test(cleanCode)) {
      throw new Error('Enter a valid Friend Code (e.g. SV-XXXXXX).');
    }
    if (cleanCode === myData.friendCode) {
      throw new Error('That is your own Friend Code.');
    }
    const codeSnap = await db.doc(`friendCodes/${cleanCode}`).get();
    recordUsageOps('default', { reads: 1 });
    if (!codeSnap.exists) throw new Error(`No survivor found with Friend Code "${cleanCode}".`);
    targetUid = String(codeSnap.data()?.uid || '');
  }

  if (!targetUid || targetUid === myUid) {
    throw new Error('You cannot add yourself as a friend.');
  }

  const targetSnap = await db.doc(`users/${targetUid}/public/profile`).get();
  recordUsageOps('default', { reads: 1 });
  if (!targetSnap.exists) throw new Error('Survivor profile not found.');
  const td = targetSnap.data() || {};
  const targetName = sanitizeDisplayName(String(td.displayName || 'Survivor'));

  const myFriendRef = db.doc(`users/${myUid}/friends/${targetUid}`);
  const existing = await myFriendRef.get();
  recordUsageOps('default', { reads: 1 });
  if (existing.exists) {
    const status = existing.data()?.status;
    if (status === 'accepted') throw new Error(`Already friends with ${targetName}.`);
    if (status === 'pending_sent') throw new Error(`Friend request already sent to ${targetName}.`);
    if (status === 'pending_received') {
      await proxyAcceptFriendRequest(myUid, targetUid);
      return;
    }
  }

  await myFriendRef.set({
    ownerUid: myUid,
    friendUid: targetUid,
    displayName: targetName,
    coatColor: sanitizeColor(String(td.coatColor || COAT_HEXES[0]), COAT_HEXES[0]),
    scarfColor: sanitizeColor(String(td.scarfColor || SCARF_HEXES[0]), SCARF_HEXES[0]),
    hatStyle: sanitizeHat(String(td.hatStyle || 'hood')),
    friendCode: String(td.friendCode || deriveFriendCode(targetUid)),
    level: Math.max(1, Math.min(99, Number(td.level || 1))),
    status: 'pending_sent',
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  });
  await db.doc(`users/${targetUid}/friends/${myUid}`).set({
    ownerUid: targetUid,
    friendUid: myUid,
    displayName: sanitizeDisplayName(String(myData.displayName || 'Survivor')),
    coatColor: sanitizeColor(String(myData.coatColor || COAT_HEXES[0]), COAT_HEXES[0]),
    scarfColor: sanitizeColor(String(myData.scarfColor || SCARF_HEXES[0]), SCARF_HEXES[0]),
    hatStyle: sanitizeHat(String(myData.hatStyle || 'hood')),
    friendCode: String(myData.friendCode || deriveFriendCode(myUid)),
    level: Math.max(1, Math.min(99, Number(myData.level || 1))),
    status: 'pending_received',
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  });
  recordUsageOps('default', { writes: 2 });
}

export async function proxyAcceptFriendRequest(myUid: string, friendUid: string): Promise<void> {
  const { db } = getDefaultAdminFirestore();
  const [mySnap, targetSnap] = await Promise.all([
    db.doc(`users/${myUid}/public/profile`).get(),
    db.doc(`users/${friendUid}/public/profile`).get(),
  ]);
  recordUsageOps('default', { reads: 2 });
  const md = mySnap.data() || {};
  const td = targetSnap.data() || {};

  await db.doc(`users/${myUid}/friends/${friendUid}`).update({
    status: 'accepted',
    displayName: sanitizeDisplayName(String(td.displayName || 'Survivor')),
    coatColor: sanitizeColor(String(td.coatColor || COAT_HEXES[0]), COAT_HEXES[0]),
    scarfColor: sanitizeColor(String(td.scarfColor || SCARF_HEXES[0]), SCARF_HEXES[0]),
    hatStyle: sanitizeHat(String(td.hatStyle || 'hood')),
    level: Math.max(1, Math.min(99, Number(td.level || 1))),
    updatedAt: FieldValue.serverTimestamp(),
  });
  try {
    await db.doc(`users/${friendUid}/friends/${myUid}`).update({
      status: 'accepted',
      displayName: sanitizeDisplayName(String(md.displayName || 'Survivor')),
      coatColor: sanitizeColor(String(md.coatColor || COAT_HEXES[0]), COAT_HEXES[0]),
      scarfColor: sanitizeColor(String(md.scarfColor || SCARF_HEXES[0]), SCARF_HEXES[0]),
      hatStyle: sanitizeHat(String(md.hatStyle || 'hood')),
      level: Math.max(1, Math.min(99, Number(md.level || 1))),
      updatedAt: FieldValue.serverTimestamp(),
    });
  } catch {
    // ignore if canceled concurrently
  }
  recordUsageOps('default', { writes: 2 });
}

export async function proxyRemoveFriend(myUid: string, friendUid: string): Promise<void> {
  const { db } = getDefaultAdminFirestore();
  await Promise.allSettled([
    db.doc(`users/${myUid}/friends/${friendUid}`).delete(),
    db.doc(`users/${friendUid}/friends/${myUid}`).delete(),
  ]);
  recordUsageOps('default', { deletes: 2 });
}

export async function proxyListGlobalChat() {
  const { db } = getDefaultAdminFirestore();
  const snap = await db.collection('globalChat').where('channel', '==', 'global').limit(60).get();
  recordUsageOps('default', { reads: Math.max(1, snap.size) });
  const oneHourAgo = Date.now() - 3_600_000;
  return snap.docs
    .map((docSnap) => {
      const d = docSnap.data();
      const ts = d.createdAt?.toMillis ? d.createdAt.toMillis() : Date.now();
      return {
        id: docSnap.id,
        senderId: String(d.senderId || ''),
        senderName: String(d.senderName || 'Survivor'),
        coatColor: String(d.coatColor || '#38bdf8'),
        text: String(d.text || ''),
        createdAtMs: ts,
      };
    })
    .filter((m) => m.createdAtMs >= oneHourAgo)
    .sort((a, b) => a.createdAtMs - b.createdAtMs)
    .slice(-40);
}

export async function proxySendGlobalChat(
  uid: string,
  payload: { displayName: string; coatColor: string; text: string }
): Promise<void> {
  const text = payload.text.trim().slice(0, 240);
  if (!text) return;
  const { db } = getDefaultAdminFirestore();
  const msgId = `m_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
  await db.doc(`globalChat/${msgId}`).set({
    senderId: uid,
    senderName: sanitizeDisplayName(payload.displayName),
    coatColor: sanitizeColor(payload.coatColor, '#38bdf8'),
    channel: 'global',
    text,
    createdAt: FieldValue.serverTimestamp(),
  });
  recordUsageOps('default', { writes: 1 });
}

export async function proxyClearGlobalChat(): Promise<void> {
  const { db } = getDefaultAdminFirestore();
  const snap = await db.collection('globalChat').where('channel', '==', 'global').get();
  recordUsageOps('default', { reads: Math.max(1, snap.size) });
  await Promise.allSettled(snap.docs.map((d) => d.ref.delete()));
  recordUsageOps('default', { deletes: snap.size });
}

export async function proxyListPublicRooms() {
  const { db } = getDefaultAdminFirestore();
  const snap = await db.collection('rooms').where('isPublic', '==', true).limit(30).get();
  recordUsageOps('default', { reads: Math.max(1, snap.size) });
  return snap.docs
    .map((docSnap) => mapRoomDoc(docSnap.id, docSnap.data()))
    .filter((r) => r.status !== 'finished' && r.playerCount > 0 && Date.now() - (r.updatedAtMs || 0) < 180_000)
    .sort((a, b) => (b.updatedAtMs || 0) - (a.updatedAtMs || 0));
}

function mapRoomDoc(roomId: string, d: DocumentData) {
  return {
    roomId,
    name: String(d.name || 'North Pole Room'),
    hostId: String(d.hostId || ''),
    hostName: String(d.hostName || 'Host'),
    difficulty:
      d.difficulty === 'nightmare' ? 'nightmare' : d.difficulty === 'insane' ? 'insane' : 'normal',
    level: Math.max(1, Math.min(99, Number(d.level || 1))),
    mazeSeed: Number(d.mazeSeed || 1),
    status: (d.status as 'waiting' | 'playing' | 'finished') || 'waiting',
    collectedOrnaments: Array.isArray(d.collectedOrnaments) ? d.collectedOrnaments.map(Number) : [],
    collectedWeapons: Array.isArray(d.collectedWeapons) ? d.collectedWeapons.map(Number) : [],
    collectedBatteries: Array.isArray(d.collectedBatteries) ? d.collectedBatteries.map(Number) : [],
    triggeredTraps: Array.isArray(d.triggeredTraps) ? d.triggeredTraps.map(Number) : [],
    weaponWave: Math.max(0, Math.min(99, Number(d.weaponWave || 0))),
    santaStunNonce: Number(d.santaStunNonce || 0),
    ornamentsTotal: Number(d.ornamentsTotal || 5),
    exitUnlocked: Boolean(d.exitUnlocked),
    isPublic: Boolean(d.isPublic),
    playerCount: Number(d.playerCount || 0),
    updatedAtMs: d.updatedAt?.toMillis ? d.updatedAt.toMillis() : 0,
  };
}

export async function proxyCreateRoom(
  uid: string,
  body: {
    roomId: string;
    name: string;
    hostName: string;
    coatColor: string;
    scarfColor: string;
    hatStyle: string;
    difficulty: string;
    level: number;
    mazeSeed: number;
    ornamentsTotal: number;
    isPublic: boolean;
    spawnX: number;
    spawnZ: number;
    santaState: {
      x: number;
      z: number;
      extras: { x: number; z: number; yaw: number; speed: number; alerted: boolean; stunRemaining: number }[];
    };
  }
) {
  const { db } = getDefaultAdminFirestore();
  const roomId = body.roomId.trim().toUpperCase();
  if (!/^[a-zA-Z0-9_\-]{4,32}$/.test(roomId)) throw new Error('Invalid room ID.');
  const cleanName = body.name.trim().slice(0, 40) || `${sanitizeDisplayName(body.hostName)}'s Maze`;
  const finalName = cleanName.length >= 2 ? cleanName : 'North Pole Room';
  const cleanLevel = Math.max(1, Math.min(99, Math.floor(body.level || 1)));
  const diff = body.difficulty === 'nightmare' ? 'nightmare' : body.difficulty === 'insane' ? 'insane' : 'normal';

  await db.doc(`rooms/${roomId}`).set({
    roomId,
    name: finalName,
    hostId: uid,
    hostName: sanitizeDisplayName(body.hostName),
    difficulty: diff,
    level: cleanLevel,
    mazeSeed: Number(body.mazeSeed || 1),
    status: 'waiting',
    collectedOrnaments: [],
    collectedWeapons: [],
    collectedBatteries: [],
    triggeredTraps: [],
    weaponWave: 0,
    santaStunNonce: 0,
    ornamentsTotal: Math.max(1, Math.min(18, Number(body.ornamentsTotal || 5))),
    exitUnlocked: false,
    isPublic: Boolean(body.isPublic),
    playerCount: 1,
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  });

  await db.doc(`rooms/${roomId}/players/${uid}`).set({
    uid,
    roomId,
    displayName: sanitizeDisplayName(body.hostName),
    coatColor: sanitizeColor(body.coatColor, COAT_HEXES[0]),
    scarfColor: sanitizeColor(body.scarfColor, SCARF_HEXES[0]),
    hatStyle: sanitizeHat(body.hatStyle),
    x: Number(Number(body.spawnX || 0).toFixed(2)),
    z: Number(Number(body.spawnZ || 0).toFixed(2)),
    yaw: 0,
    flashlightOn: true,
    alive: true,
    escaped: false,
    stunned: false,
    equippedWeapon: '',
    shotCount: 0,
    lastShotHit: false,
    reviveCount: 0,
    revivedBy: '',
    updatedAt: FieldValue.serverTimestamp(),
  });

  await db.doc(`rooms/${roomId}/santa/live`).set({
    x: Number(Number(body.santaState?.x || 0).toFixed(2)),
    z: Number(Number(body.santaState?.z || 0).toFixed(2)),
    yaw: 0,
    speed: 0,
    alerted: false,
    stunRemaining: 0,
    extras: Array.isArray(body.santaState?.extras) ? body.santaState.extras.slice(0, 2) : [],
    updatedAt: FieldValue.serverTimestamp(),
  });

  recordUsageOps('default', { writes: 3 });

  return {
    roomId,
    name: finalName,
    hostId: uid,
    hostName: sanitizeDisplayName(body.hostName),
    difficulty: diff,
    level: cleanLevel,
    mazeSeed: Number(body.mazeSeed || 1),
    status: 'waiting' as const,
    collectedOrnaments: [],
    collectedWeapons: [],
    collectedBatteries: [],
    triggeredTraps: [],
    weaponWave: 0,
    santaStunNonce: 0,
    ornamentsTotal: Math.max(1, Math.min(18, Number(body.ornamentsTotal || 5))),
    exitUnlocked: false,
    isPublic: Boolean(body.isPublic),
    playerCount: 1,
  };
}

export async function proxyJoinRoom(
  uid: string,
  rawRoomId: string,
  player: {
    displayName: string;
    coatColor: string;
    scarfColor: string;
    hatStyle: string;
    spawnX: number;
    spawnZ: number;
  }
) {
  const roomId = rawRoomId.trim().toUpperCase();
  if (!/^[a-zA-Z0-9_\-]{4,32}$/.test(roomId)) throw new Error('Invalid room code format.');
  const { db } = getDefaultAdminFirestore();
  const roomRef = db.doc(`rooms/${roomId}`);
  const snap = await roomRef.get();
  recordUsageOps('default', { reads: 1 });
  if (!snap.exists) throw new Error(`Room "${roomId}" was not found.`);
  const d = snap.data() || {};
  if (d.status === 'finished') throw new Error(`Room "${roomId}" has already ended.`);

  const playerRef = db.doc(`rooms/${roomId}/players/${uid}`);
  const existingPlayer = await playerRef.get();
  recordUsageOps('default', { reads: 1 });
  const prev = existingPlayer.exists ? existingPlayer.data() : null;

  await playerRef.set({
    uid,
    roomId,
    displayName: sanitizeDisplayName(player.displayName),
    coatColor: sanitizeColor(player.coatColor, COAT_HEXES[0]),
    scarfColor: sanitizeColor(player.scarfColor, SCARF_HEXES[0]),
    hatStyle: sanitizeHat(player.hatStyle),
    x: Number(Number(player.spawnX || 0).toFixed(2)),
    z: Number(Number(player.spawnZ || 0).toFixed(2)),
    yaw: 0,
    flashlightOn: true,
    alive: true,
    escaped: false,
    stunned: false,
    equippedWeapon: '',
    shotCount: 0,
    lastShotHit: false,
    reviveCount: prev ? Number(prev.reviveCount || 0) : 0,
    revivedBy: prev ? String(prev.revivedBy || '').slice(0, 24) : '',
    updatedAt: FieldValue.serverTimestamp(),
  });
  recordUsageOps('default', { writes: 1 });

  if (!existingPlayer.exists) {
    await roomRef.update({
      playerCount: Math.min(12, Number(d.playerCount || 0) + 1),
      updatedAt: FieldValue.serverTimestamp(),
    });
    recordUsageOps('default', { writes: 1 });
  }

  return {
    ...mapRoomDoc(roomId, d),
    playerCount: Number(d.playerCount || 1) + (existingPlayer.exists ? 0 : 1),
  };
}

export async function proxyLeaveRoom(roomId: string, uid: string): Promise<void> {
  const { db } = getDefaultAdminFirestore();
  const roomRef = db.doc(`rooms/${roomId}`);
  const playerRef = db.doc(`rooms/${roomId}/players/${uid}`);
  const playersSnap = await db.collection(`rooms/${roomId}/players`).get();
  recordUsageOps('default', { reads: Math.max(1, playersSnap.size) });

  const remaining = playersSnap.docs.filter((d) => d.id !== uid);
  if (remaining.length === 0) {
    // Delete room and subcollection docs cleanly when last player leaves
    const [msgsSnap, santaSnap] = await Promise.all([
      db.collection(`rooms/${roomId}/messages`).get(),
      db.doc(`rooms/${roomId}/santa/live`).get(),
    ]);
    await Promise.allSettled([
      ...playersSnap.docs.map((p) => p.ref.delete()),
      ...msgsSnap.docs.map((m) => m.ref.delete()),
      ...(santaSnap.exists ? [santaSnap.ref.delete()] : []),
      roomRef.delete(),
    ]);
    recordUsageOps('default', { deletes: playersSnap.size + msgsSnap.size + (santaSnap.exists ? 2 : 1) });
    return;
  }

  await playerRef.delete();
  recordUsageOps('default', { deletes: 1 });
  const snap = await roomRef.get();
  recordUsageOps('default', { reads: 1 });
  if (snap.exists) {
    const d = snap.data() || {};
    if (d.hostId === uid) {
      const nextHost = remaining[0];
      await roomRef.update({
        hostId: nextHost.id,
        hostName: sanitizeDisplayName(String(nextHost.data().displayName || 'Survivor')),
        playerCount: remaining.length,
        updatedAt: FieldValue.serverTimestamp(),
      });
    } else {
      await roomRef.update({
        playerCount: remaining.length,
        updatedAt: FieldValue.serverTimestamp(),
      });
    }
    recordUsageOps('default', { writes: 1 });
  }
}

export async function proxyClaimHost(roomId: string, uid: string, displayName: string): Promise<boolean> {
  const { db } = getDefaultAdminFirestore();
  const roomRef = db.doc(`rooms/${roomId}`);
  const snap = await roomRef.get();
  recordUsageOps('default', { reads: 1 });
  if (!snap.exists) return false;
  const d = snap.data() || {};
  if (d.status === 'finished' || d.hostId === uid) return d.hostId === uid;
  const oldHostPlayer = await db.doc(`rooms/${roomId}/players/${String(d.hostId || '')}`).get();
  recordUsageOps('default', { reads: 1 });
  if (oldHostPlayer.exists) return false;

  await roomRef.update({
    hostId: uid,
    hostName: sanitizeDisplayName(displayName),
    playerCount: Math.max(1, Number(d.playerCount || 1)),
    updatedAt: FieldValue.serverTimestamp(),
  });
  recordUsageOps('default', { writes: 1 });
  return true;
}

export async function proxyStartRoom(roomId: string, uid: string): Promise<void> {
  const { db } = getDefaultAdminFirestore();
  const roomRef = db.doc(`rooms/${roomId}`);
  const snap = await roomRef.get();
  recordUsageOps('default', { reads: 1 });
  if (!snap.exists) return;
  if (snap.data()?.hostId !== uid) throw new Error('Only the room host can start the match.');
  await roomRef.update({ status: 'playing', updatedAt: FieldValue.serverTimestamp() });
  recordUsageOps('default', { writes: 1 });
}

export async function proxyDeleteRoom(roomId: string): Promise<void> {
  const { db } = getDefaultAdminFirestore();
  const [playersSnap, msgsSnap, santaSnap] = await Promise.all([
    db.collection(`rooms/${roomId}/players`).get(),
    db.collection(`rooms/${roomId}/messages`).get(),
    db.doc(`rooms/${roomId}/santa/live`).get(),
  ]);
  await Promise.allSettled([
    ...playersSnap.docs.map((p) => p.ref.delete()),
    ...msgsSnap.docs.map((m) => m.ref.delete()),
    ...(santaSnap.exists ? [santaSnap.ref.delete()] : []),
    db.doc(`rooms/${roomId}`).delete(),
  ]);
  recordUsageOps('default', { deletes: playersSnap.size + msgsSnap.size + 2 });
}

export async function proxyRoomAction(
  roomId: string,
  uid: string,
  action: Record<string, unknown>
): Promise<unknown> {
  const { db } = getDefaultAdminFirestore();
  const roomRef = db.doc(`rooms/${roomId}`);
  const type = String(action.type || '');

  if (type === 'ornament') {
    const ornamentId = Number(action.ornamentId);
    const total = Number(action.ornamentsTotal || 5);
    await db.runTransaction(async (tx) => {
      const snap = await tx.get(roomRef);
      if (!snap.exists) return;
      const d = snap.data() || {};
      if (d.status === 'finished') return;
      const cur: number[] = Array.isArray(d.collectedOrnaments) ? d.collectedOrnaments.map(Number) : [];
      if (cur.includes(ornamentId)) return;
      const next = [...cur, ornamentId].slice(0, 18);
      tx.update(roomRef, {
        collectedOrnaments: next,
        exitUnlocked: next.length >= total,
        updatedAt: FieldValue.serverTimestamp(),
      });
    });
    recordUsageOps('default', { reads: 1, writes: 1 });
    return { ok: true };
  }

  if (type === 'weapon' || type === 'battery' || type === 'trap') {
    const field =
      type === 'weapon' ? 'collectedWeapons' : type === 'battery' ? 'collectedBatteries' : 'triggeredTraps';
    const maxLen = type === 'weapon' ? 40 : type === 'battery' ? 30 : 20;
    const itemId = Number(action.itemId);
    await db.runTransaction(async (tx) => {
      const snap = await tx.get(roomRef);
      if (!snap.exists) return;
      const d = snap.data() || {};
      if (d.status === 'finished') return;
      const cur: number[] = Array.isArray(d[field]) ? d[field].map(Number) : [];
      if (cur.includes(itemId)) return;
      const next = [...cur, itemId].slice(-maxLen);
      tx.update(roomRef, {
        [field]: next,
        updatedAt: FieldValue.serverTimestamp(),
      });
    });
    recordUsageOps('default', { reads: 1, writes: 1 });
    return { ok: true };
  }

  if (type === 'wave') {
    const wave = Math.max(0, Math.min(99, Math.floor(Number(action.wave || 0))));
    await roomRef.update({ weaponWave: wave, updatedAt: FieldValue.serverTimestamp() });
    recordUsageOps('default', { writes: 1 });
    return { ok: true };
  }

  if (type === 'stun') {
    await db.runTransaction(async (tx) => {
      const snap = await tx.get(roomRef);
      if (!snap.exists) return;
      const d = snap.data() || {};
      if (d.status === 'finished') return;
      const nextNonce = Math.min(10_000, Number(d.santaStunNonce || 0) + 1);
      tx.update(roomRef, { santaStunNonce: nextNonce, updatedAt: FieldValue.serverTimestamp() });
    });
    recordUsageOps('default', { reads: 1, writes: 1 });
    return { ok: true };
  }

  if (type === 'revive') {
    const targetUid = String(action.targetUid || '');
    if (!targetUid || targetUid === uid) return { revived: false };
    const reviverName = sanitizeDisplayName(String(action.reviverName || 'Teammate'));
    const targetRef = db.doc(`rooms/${roomId}/players/${targetUid}`);
    let revived = false;
    await db.runTransaction(async (tx) => {
      const snap = await tx.get(targetRef);
      if (!snap.exists) return;
      const d = snap.data() || {};
      if (d.alive !== false || Boolean(d.escaped)) return;
      tx.update(targetRef, {
        alive: true,
        reviveCount: Math.min(1000, Number(d.reviveCount || 0) + 1),
        revivedBy: reviverName,
        updatedAt: FieldValue.serverTimestamp(),
      });
      revived = true;
    });
    recordUsageOps('default', { reads: 1, writes: revived ? 1 : 0 });
    return { revived };
  }

  throw new Error('Unknown room action.');
}

export async function proxySyncPlayer(
  roomId: string,
  uid: string,
  body: Record<string, unknown>
): Promise<void> {
  const { db } = getDefaultAdminFirestore();
  await db.doc(`rooms/${roomId}/players/${uid}`).update({
    displayName: sanitizeDisplayName(String(body.displayName || 'Survivor')),
    coatColor: sanitizeColor(String(body.coatColor || COAT_HEXES[0]), COAT_HEXES[0]),
    scarfColor: sanitizeColor(String(body.scarfColor || SCARF_HEXES[0]), SCARF_HEXES[0]),
    hatStyle: sanitizeHat(String(body.hatStyle || 'hood')),
    x: Number(Number(body.x || 0).toFixed(2)),
    z: Number(Number(body.z || 0).toFixed(2)),
    yaw: Number(Number(body.yaw || 0).toFixed(3)),
    flashlightOn: Boolean(body.flashlightOn),
    alive: body.alive !== false,
    escaped: Boolean(body.escaped),
    stunned: Boolean(body.stunned),
    equippedWeapon: sanitizeWeapon(body.equippedWeapon),
    shotCount: Math.max(0, Math.min(10_000, Math.floor(Number(body.shotCount || 0)))),
    lastShotHit: Boolean(body.lastShotHit),
    updatedAt: FieldValue.serverTimestamp(),
  });
  recordUsageOps('default', { writes: 1 });
}

export async function proxySyncSanta(
  roomId: string,
  uid: string,
  body: Record<string, unknown>
): Promise<void> {
  const { db } = getDefaultAdminFirestore();
  const roomSnap = await db.doc(`rooms/${roomId}`).get();
  recordUsageOps('default', { reads: 1 });
  if (!roomSnap.exists || roomSnap.data()?.hostId !== uid) return;

  const rawExtras = Array.isArray(body.extras) ? body.extras.slice(0, 2) : [];
  const cleanExtras = rawExtras.map((e: Record<string, unknown>) => ({
    x: Number(Math.max(-260, Math.min(260, Number(e?.x || 0))).toFixed(2)),
    z: Number(Math.max(-260, Math.min(260, Number(e?.z || 0))).toFixed(2)),
    yaw: Number(Number(e?.yaw || 0).toFixed(3)),
    speed: Number(Math.max(0, Math.min(25, Number(e?.speed || 0))).toFixed(2)),
    alerted: Boolean(e?.alerted),
    stunRemaining: Number(Math.max(0, Math.min(35, Number(e?.stunRemaining || 0))).toFixed(1)),
  }));

  await db.doc(`rooms/${roomId}/santa/live`).update({
    x: Number(Math.max(-260, Math.min(260, Number(body.x || 0))).toFixed(2)),
    z: Number(Math.max(-260, Math.min(260, Number(body.z || 0))).toFixed(2)),
    yaw: Number(Number(body.yaw || 0).toFixed(3)),
    speed: Number(Math.max(0, Math.min(25, Number(body.speed || 0))).toFixed(2)),
    alerted: Boolean(body.alerted),
    stunRemaining: Number(Math.max(0, Math.min(35, Number(body.stunRemaining || 0))).toFixed(1)),
    extras: cleanExtras,
    updatedAt: FieldValue.serverTimestamp(),
  });
  recordUsageOps('default', { writes: 1 });
}

export async function proxySendRoomChat(
  roomId: string,
  uid: string,
  payload: { displayName: string; coatColor: string; text: string }
): Promise<void> {
  const text = payload.text.trim().slice(0, 240);
  if (!text) return;
  const { db } = getDefaultAdminFirestore();
  const msgId = `m_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
  await db.doc(`rooms/${roomId}/messages/${msgId}`).set({
    senderId: uid,
    senderName: sanitizeDisplayName(payload.displayName),
    coatColor: sanitizeColor(payload.coatColor, '#38bdf8'),
    roomId,
    text,
    createdAt: FieldValue.serverTimestamp(),
  });
  recordUsageOps('default', { writes: 1 });
}

export async function proxyGetRoomSnapshot(roomId: string) {
  const { db } = getDefaultAdminFirestore();
  const [roomSnap, playersSnap, santaSnap, msgsSnap] = await Promise.all([
    db.doc(`rooms/${roomId}`).get(),
    db.collection(`rooms/${roomId}/players`).where('roomId', '==', roomId).get(),
    db.doc(`rooms/${roomId}/santa/live`).get(),
    db.collection(`rooms/${roomId}/messages`).where('roomId', '==', roomId).get(),
  ]);
  recordUsageOps('default', {
    reads: 2 + Math.max(1, playersSnap.size) + Math.max(1, msgsSnap.size),
  });

  const room = roomSnap.exists ? mapRoomDoc(roomSnap.id, roomSnap.data() || {}) : null;
  const players = playersSnap.docs.map((docSnap) => {
    const d = docSnap.data();
    return {
      uid: String(d.uid || docSnap.id),
      roomId: String(d.roomId || roomId),
      displayName: String(d.displayName || 'Survivor'),
      coatColor: sanitizeColor(String(d.coatColor || '#3b82f6'), '#3b82f6'),
      scarfColor: sanitizeColor(String(d.scarfColor || SCARF_HEXES[0]), SCARF_HEXES[0]),
      hatStyle: sanitizeHat(String(d.hatStyle || 'hood')),
      x: Number(d.x || 0),
      z: Number(d.z || 0),
      yaw: Number(d.yaw || 0),
      flashlightOn: Boolean(d.flashlightOn),
      alive: d.alive !== false,
      escaped: Boolean(d.escaped),
      stunned: Boolean(d.stunned),
      equippedWeapon: sanitizeWeapon(d.equippedWeapon),
      shotCount: Number(d.shotCount || 0),
      lastShotHit: Boolean(d.lastShotHit),
      reviveCount: Number(d.reviveCount || 0),
      revivedBy: String(d.revivedBy || ''),
    };
  });

  let santa: Record<string, unknown> | null = null;
  if (santaSnap.exists) {
    const d = santaSnap.data() || {};
    const rawExtras = Array.isArray(d.extras) ? d.extras.slice(0, 2) : [];
    santa = {
      x: Number(d.x || 0),
      z: Number(d.z || 0),
      yaw: Number(d.yaw || 0),
      speed: Number(d.speed || 0),
      alerted: Boolean(d.alerted),
      stunRemaining: Number(d.stunRemaining || 0),
      extras: rawExtras.map((e: Record<string, unknown>) => ({
        x: Number(e?.x || 0),
        z: Number(e?.z || 0),
        yaw: Number(e?.yaw || 0),
        speed: Number(e?.speed || 0),
        alerted: Boolean(e?.alerted),
        stunRemaining: Number(e?.stunRemaining || 0),
      })),
      updatedAtMs: Date.now(),
    };
  }

  const oneHourAgo = Date.now() - 3_600_000;
  const messages = msgsSnap.docs
    .map((docSnap) => {
      const d = docSnap.data();
      const ts = d.createdAt?.toMillis ? d.createdAt.toMillis() : Date.now();
      return {
        id: docSnap.id,
        senderId: String(d.senderId || ''),
        senderName: String(d.senderName || 'Survivor'),
        coatColor: String(d.coatColor || '#38bdf8'),
        text: String(d.text || ''),
        createdAtMs: ts,
      };
    })
    .filter((m) => m.createdAtMs >= oneHourAgo)
    .sort((a, b) => a.createdAtMs - b.createdAtMs)
    .slice(-60);

  return { room, players, santa, messages };
}

// Shared room/lobby Firestore listener hubs (keeps Default DB reads low & low-latency)
export function attachDefaultRoomSnapshot(
  roomId: string,
  callbacks: {
    onRoom: (room: unknown) => void;
    onPlayers: (players: unknown[]) => void;
    onSanta: (santa: unknown) => void;
    onMessages: (msgs: unknown[]) => void;
    onError: (err: string) => void;
  }
): () => void {
  const { db } = getDefaultAdminFirestore();

  const u1 = db.doc(`rooms/${roomId}`).onSnapshot(
    (snap) => {
      recordUsageOps('default', { reads: 1 });
      callbacks.onRoom(snap.exists ? mapRoomDoc(snap.id, snap.data() || {}) : null);
    },
    (err) => callbacks.onError(formatReadableError(err))
  );

  const u2 = db
    .collection(`rooms/${roomId}/players`)
    .where('roomId', '==', roomId)
    .onSnapshot(
      (snap) => {
        recordUsageOps('default', { reads: Math.max(1, snap.size) });
        callbacks.onPlayers(
          snap.docs.map((docSnap) => {
            const d = docSnap.data();
            return {
              uid: String(d.uid || docSnap.id),
              roomId: String(d.roomId || roomId),
              displayName: String(d.displayName || 'Survivor'),
              coatColor: sanitizeColor(String(d.coatColor || '#3b82f6'), '#3b82f6'),
              scarfColor: sanitizeColor(String(d.scarfColor || SCARF_HEXES[0]), SCARF_HEXES[0]),
              hatStyle: sanitizeHat(String(d.hatStyle || 'hood')),
              x: Number(d.x || 0),
              z: Number(d.z || 0),
              yaw: Number(d.yaw || 0),
              flashlightOn: Boolean(d.flashlightOn),
              alive: d.alive !== false,
              escaped: Boolean(d.escaped),
              stunned: Boolean(d.stunned),
              equippedWeapon: sanitizeWeapon(d.equippedWeapon),
              shotCount: Number(d.shotCount || 0),
              lastShotHit: Boolean(d.lastShotHit),
              reviveCount: Number(d.reviveCount || 0),
              revivedBy: String(d.revivedBy || ''),
            };
          })
        );
      },
      (err) => callbacks.onError(formatReadableError(err))
    );

  const u3 = db.doc(`rooms/${roomId}/santa/live`).onSnapshot(
    (snap) => {
      recordUsageOps('default', { reads: 1 });
      if (!snap.exists) return;
      const d = snap.data() || {};
      const rawExtras = Array.isArray(d.extras) ? d.extras.slice(0, 2) : [];
      callbacks.onSanta({
        x: Number(d.x || 0),
        z: Number(d.z || 0),
        yaw: Number(d.yaw || 0),
        speed: Number(d.speed || 0),
        alerted: Boolean(d.alerted),
        stunRemaining: Number(d.stunRemaining || 0),
        extras: rawExtras.map((e: Record<string, unknown>) => ({
          x: Number(e?.x || 0),
          z: Number(e?.z || 0),
          yaw: Number(e?.yaw || 0),
          speed: Number(e?.speed || 0),
          alerted: Boolean(e?.alerted),
          stunRemaining: Number(e?.stunRemaining || 0),
        })),
        updatedAtMs: Date.now(),
      });
    },
    (err) => callbacks.onError(formatReadableError(err))
  );

  const u4 = db
    .collection(`rooms/${roomId}/messages`)
    .where('roomId', '==', roomId)
    .onSnapshot(
      (snap) => {
        recordUsageOps('default', { reads: Math.max(1, snap.size) });
        const oneHourAgo = Date.now() - 3_600_000;
        const msgs = snap.docs
          .map((docSnap) => {
            const d = docSnap.data();
            const ts = d.createdAt?.toMillis ? d.createdAt.toMillis() : Date.now();
            return {
              id: docSnap.id,
              senderId: String(d.senderId || ''),
              senderName: String(d.senderName || 'Survivor'),
              coatColor: String(d.coatColor || '#38bdf8'),
              text: String(d.text || ''),
              createdAtMs: ts,
            };
          })
          .filter((m) => m.createdAtMs >= oneHourAgo)
          .sort((a, b) => a.createdAtMs - b.createdAtMs)
          .slice(-60);
        callbacks.onMessages(msgs);
      },
      (err) => callbacks.onError(formatReadableError(err))
    );

  return () => {
    u1();
    u2();
    u3();
    u4();
  };
}
