import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  AlertTriangle,
  ArrowLeftRight,
  ArrowRight,
  CheckCircle2,
  Database,
  HardDrive,
  RefreshCw,
  RotateCcw,
  Shield,
  X,
} from 'lucide-react';
import {
  type ConflictStrategy,
  type DatabaseId,
  type DbAdminOverview,
  type DbStatusInfo,
  type MirrorDirection,
  type MirrorJobState,
  fetchAdminDatabaseOverview,
  pollAdminMirrorJob,
  restoreAdminBackup,
  startAdminMirrorJob,
  switchAdminActiveDatabase,
} from '../services/databaseAdmin';

interface AdminDatabaseModalProps {
  open: boolean;
  onClose: () => void;
  onSwitched?: (dbId: DatabaseId) => void;
}

function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return 'Never';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return 'Never';
  return d.toLocaleString();
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function formatDirection(direction: MirrorDirection | 'restore'): string {
  if (direction === 'default_to_ai') return 'Default -> AI Shared';
  if (direction === 'ai_shared_to_default') return 'AI Shared -> Default';
  if (direction === 'bidirectional_sync') return 'Bidirectional Smart Sync';
  return 'Backup Restore';
}

function formatAuthMode(mode: DbStatusInfo['authMode']): string {
  if (mode === 'service_account') return 'Server Service Account';
  if (mode === 'adc_iam') return 'Server ADC / IAM';
  if (mode === 'user_token_rest') return 'Admin Token REST';
  return 'Unconfigured';
}

export const AdminDatabaseModal: React.FC<AdminDatabaseModalProps> = ({
  open,
  onClose,
  onSwitched,
}) => {
  const [overview, setOverview] = useState<DbAdminOverview | null>(null);
  const [loading, setLoading] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionNotice, setActionNotice] = useState<string | null>(null);

  // Switch confirmation state
  const [pendingSwitchTarget, setPendingSwitchTarget] = useState<DatabaseId | null>(null);
  const [switchBusy, setSwitchBusy] = useState(false);

  // Mirroring & restore state
  const [strategy, setStrategy] = useState<ConflictStrategy>('newest_wins');
  const [activeJob, setActiveJob] = useState<MirrorJobState | null>(null);
  const [mirrorStarting, setMirrorStarting] = useState(false);
  const [pendingRestoreId, setPendingRestoreId] = useState<string | null>(null);
  const [restoreBusy, setRestoreBusy] = useState(false);
  const [lastAttemptedSync, setLastAttemptedSync] = useState<{
    direction: MirrorDirection;
    strategy: ConflictStrategy;
  } | null>(null);

  const pollTimerRef = useRef<number | null>(null);

  const stopPolling = useCallback(() => {
    if (pollTimerRef.current !== null) {
      window.clearTimeout(pollTimerRef.current);
      pollTimerRef.current = null;
    }
  }, []);

  const loadOverview = useCallback(async () => {
    setLoading(true);
    setActionError(null);
    try {
      const data = await fetchAdminDatabaseOverview();
      setOverview(data);
      if (data.currentJob) {
        setActiveJob(data.currentJob);
      }
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Unable to load database overview.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!open) {
      stopPolling();
      setPendingSwitchTarget(null);
      setPendingRestoreId(null);
      return;
    }
    void loadOverview();
    return () => stopPolling();
  }, [open, loadOverview, stopPolling]);

  // Poll active mirror job while running
  useEffect(() => {
    if (!open || !activeJob || activeJob.status !== 'running') {
      stopPolling();
      return;
    }

    let cancelled = false;
    const scheduleNext = () => {
      pollTimerRef.current = window.setTimeout(async () => {
        if (cancelled) return;
        try {
          const updated = await pollAdminMirrorJob(activeJob.jobId);
          if (cancelled) return;
          setActiveJob(updated);
          if (updated.status === 'running') {
            scheduleNext();
          } else {
            if (updated.status === 'completed') {
              setActionNotice(
                `Sync completed (${formatDirection(updated.direction)}): ${updated.copiedCount} copied, ${updated.skippedCount} skipped.`
              );
            } else {
              setActionError(
                updated.error || `Sync finished with ${updated.errorCount} error(s).`
              );
            }
            void loadOverview();
          }
        } catch (err) {
          if (!cancelled) {
            setActionError(err instanceof Error ? err.message : 'Lost sync job status updates.');
          }
        }
      }, 900);
    };

    scheduleNext();
    return () => {
      cancelled = true;
      stopPolling();
    };
  }, [open, activeJob?.jobId, activeJob?.status, loadOverview, stopPolling]);

  if (!open) return null;

  const handleConfirmSwitch = async () => {
    if (!pendingSwitchTarget) return;
    setSwitchBusy(true);
    setActionError(null);
    setActionNotice(null);
    try {
      const res = await switchAdminActiveDatabase(pendingSwitchTarget);
      setPendingSwitchTarget(null);
      setActionNotice(
        `Active database switched to ${
          res.activeDatabase === 'default' ? 'Default Database' : 'AI Shared Database'
        }. Signed-in sessions were preserved.`
      );
      onSwitched?.(res.activeDatabase);
      await loadOverview();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Failed to switch active database.');
    } finally {
      setSwitchBusy(false);
    }
  };

  const handleStartMirror = async (direction: MirrorDirection, overrideStrategy?: ConflictStrategy) => {
    const chosenStrategy = overrideStrategy || strategy;
    setMirrorStarting(true);
    setActionError(null);
    setActionNotice(null);
    setLastAttemptedSync({ direction, strategy: chosenStrategy });
    try {
      const job = await startAdminMirrorJob(direction, chosenStrategy);
      setActiveJob(job);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Failed to start mirroring job.');
    } finally {
      setMirrorStarting(false);
    }
  };

  const handleConfirmRestore = async () => {
    if (!pendingRestoreId) return;
    setRestoreBusy(true);
    setActionError(null);
    setActionNotice(null);
    try {
      const res = await restoreAdminBackup(pendingRestoreId);
      setPendingRestoreId(null);
      setActionNotice(
        `Restored ${res.restoredCount} documents to ${
          res.targetDatabase === 'default' ? 'Default Database' : 'AI Shared Database'
        }.`
      );
      await loadOverview();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Backup restore failed.');
    } finally {
      setRestoreBusy(false);
    }
  };

  const latestWinnerLabel =
    overview?.latestDataWinner === 'default'
      ? 'Default Database has newer data'
      : overview?.latestDataWinner === 'ai_shared'
        ? 'AI Shared Database has newer data'
        : overview?.latestDataWinner === 'in_sync'
          ? 'Both databases in sync'
          : 'Comparison unavailable';

  const isJobRunning = activeJob?.status === 'running';

  return (
    <div
      className="fixed inset-0 z-40 overflow-y-auto bg-[#03050c]/88 backdrop-blur-sm px-4 py-6"
      role="dialog"
      aria-modal="true"
      aria-labelledby="admin-db-modal-title"
    >
      <div className="max-w-5xl mx-auto bg-[#080d1a] border border-white/15 rounded-xl p-5 sm:p-6 shadow-2xl text-slate-100">
        {/* Header */}
        <div className="flex flex-wrap items-center justify-between gap-3 pb-4 border-b border-white/10">
          <div className="flex items-center gap-2.5">
            <div className="w-9 h-9 rounded-lg bg-amber-500/15 border border-amber-400/30 flex items-center justify-center shrink-0">
              <Shield className="w-5 h-5 text-amber-400" />
            </div>
            <div>
              <h2 id="admin-db-modal-title" className="text-lg font-bold text-slate-100">
                Admin Panel · Database Management
              </h2>
              <p className="text-xs text-slate-400">
                Switch active databases, monitor status & Spark quotas, and safely mirror records.
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => void loadOverview()}
              disabled={loading}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-200 bg-slate-900 hover:bg-slate-800 border border-white/12 rounded-lg transition-colors disabled:opacity-50 cursor-pointer"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
              <span>{loading ? 'Checking...' : 'Refresh Status'}</span>
            </button>
            <button
              type="button"
              onClick={onClose}
              aria-label="Close Database Management"
              className="p-2 text-slate-400 hover:text-white bg-slate-900 hover:bg-slate-800 border border-white/12 rounded-lg transition-colors cursor-pointer"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* Notifications & Feedback Banners */}
        <div className="space-y-2 mt-4">
          {actionError && (
            <div className="flex items-start gap-2.5 px-3.5 py-2.5 rounded-lg bg-red-950/70 border border-red-500/40 text-xs text-red-200">
              <AlertTriangle className="w-4 h-4 text-red-400 shrink-0 mt-0.5" />
              <div className="flex-1 leading-relaxed">{actionError}</div>
            </div>
          )}
          {actionNotice && (
            <div className="flex items-start gap-2.5 px-3.5 py-2.5 rounded-lg bg-emerald-950/60 border border-emerald-500/40 text-xs text-emerald-200">
              <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0 mt-0.5" />
              <div className="flex-1 leading-relaxed">{actionNotice}</div>
            </div>
          )}
          {overview?.notifications.map((note, idx) => (
            <div
              key={`${note.level}-${idx}`}
              className={`flex items-start gap-2.5 px-3.5 py-2.5 rounded-lg border text-xs leading-relaxed ${
                note.level === 'error'
                  ? 'bg-red-950/65 border-red-500/35 text-red-200'
                  : note.level === 'warning'
                    ? 'bg-amber-950/55 border-amber-500/35 text-amber-200'
                    : 'bg-sky-950/45 border-sky-500/30 text-sky-200'
              }`}
            >
              <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
              <span>{note.message}</span>
            </div>
          ))}
        </div>

        {loading && !overview ? (
          <div className="py-16 text-center text-sm text-slate-400">
            Inspecting Default & AI Shared databases...
          </div>
        ) : overview ? (
          <div className="space-y-5 mt-5">
            {/* 1. Active Database Section */}
            <section className="bg-[#050811] border border-white/12 rounded-xl p-4 sm:p-5">
              <div className="flex flex-wrap items-center justify-between gap-3 mb-3">
                <div>
                  <h3 className="text-sm font-semibold text-slate-100 flex items-center gap-2">
                    <Database className="w-4 h-4 text-red-400" />
                    <span>Active Database</span>
                  </h3>
                  <p className="text-xs text-slate-400 mt-0.5">
                    Last switched: <span className="text-slate-200">{formatDateTime(overview.lastSwitchAt)}</span>
                  </p>
                </div>
                <span className="text-[11px] px-2.5 py-1 rounded-md bg-white/5 border border-white/10 text-slate-300">
                  Auth stays unified so switching never logs users out
                </span>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                {(['default', 'ai_shared'] as DatabaseId[]).map((dbId) => {
                  const info = overview.databases[dbId];
                  const isActive = overview.activeDatabase === dbId;
                  return (
                    <div
                      key={dbId}
                      className={`rounded-lg p-3.5 border transition-colors ${
                        isActive
                          ? 'bg-emerald-950/25 border-emerald-400/50'
                          : 'bg-[#080d1a] border-white/10'
                      }`}
                    >
                      <div className="flex items-start justify-between gap-2">
                        <div>
                          <div className="flex items-center gap-2">
                            <span className="text-sm font-semibold text-slate-100">{info.label}</span>
                            {isActive ? (
                              <span className="text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded bg-emerald-500/20 text-emerald-300 border border-emerald-400/40">
                                Active
                              </span>
                            ) : (
                              <span className="text-[10px] font-medium uppercase tracking-wider px-2 py-0.5 rounded bg-white/5 text-slate-400 border border-white/10">
                                Standby
                              </span>
                            )}
                          </div>
                          <p className="text-[11px] text-slate-400 font-mono mt-1">
                            {info.projectId} · {info.databaseId}
                          </p>
                        </div>

                        {!isActive && (
                          <button
                            type="button"
                            disabled={switchBusy || isJobRunning}
                            onClick={() => setPendingSwitchTarget(dbId)}
                            className="px-3 py-1.5 text-xs font-semibold rounded-lg bg-red-700 hover:bg-red-600 disabled:opacity-50 text-white transition-colors shrink-0 cursor-pointer"
                          >
                            Switch Here
                          </button>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>

              {/* Switch Confirmation Box */}
              {pendingSwitchTarget && (
                <div className="mt-3 p-3.5 rounded-lg bg-amber-950/50 border border-amber-400/45 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                  <div className="text-xs text-amber-100 leading-relaxed">
                    <span className="font-semibold">Confirm database switch:</span> All new reads & writes
                    across the app will immediately target{' '}
                    <span className="font-semibold underline">
                      {pendingSwitchTarget === 'default'
                        ? 'Default Database (holloweve-1d459)'
                        : 'AI Shared Database (holloweve)'}
                    </span>
                    . Signed-in accounts stay logged in, and existing data in both databases stays untouched.
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <button
                      type="button"
                      disabled={switchBusy}
                      onClick={() => setPendingSwitchTarget(null)}
                      className="px-3 py-1.5 text-xs font-medium bg-slate-800 hover:bg-slate-700 text-slate-200 rounded-lg cursor-pointer"
                    >
                      Cancel
                    </button>
                    <button
                      type="button"
                      disabled={switchBusy}
                      onClick={() => void handleConfirmSwitch()}
                      className="px-3 py-1.5 text-xs font-semibold bg-amber-600 hover:bg-amber-500 disabled:opacity-50 text-white rounded-lg cursor-pointer"
                    >
                      {switchBusy ? 'Switching...' : 'Confirm Switch'}
                    </button>
                  </div>
                </div>
              )}
            </section>

            {/* 2. Database Mirroring & Synchronisation Section */}
            <section className="bg-[#050811] border border-white/12 rounded-xl p-4 sm:p-5 space-y-4">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <h3 className="text-sm font-semibold text-slate-100 flex items-center gap-2">
                    <ArrowLeftRight className="w-4 h-4 text-sky-400" />
                    <span>Database Mirroring & Synchronisation</span>
                  </h3>
                  <p className="text-xs text-slate-400 mt-0.5">
                    Creates an automatic pre-sync backup before writing to any target database.
                  </p>
                </div>

                <div className="flex flex-wrap items-center gap-2">
                  <span
                    className={`text-xs font-medium px-2.5 py-1 rounded-md border ${
                      overview.latestDataWinner === 'in_sync'
                        ? 'bg-emerald-950/40 border-emerald-500/35 text-emerald-300'
                        : overview.latestDataWinner === 'default'
                          ? 'bg-sky-950/40 border-sky-500/35 text-sky-300'
                          : overview.latestDataWinner === 'ai_shared'
                            ? 'bg-amber-950/40 border-amber-500/35 text-amber-300'
                            : 'bg-white/5 border-white/10 text-slate-300'
                    }`}
                  >
                    Latest Data: {latestWinnerLabel}
                  </span>
                </div>
              </div>

              {/* Last Successful Sync Summary & Strategy Selector */}
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                <div className="bg-[#080d1a] border border-white/10 rounded-lg p-3 text-xs space-y-1">
                  <div className="text-slate-400">Last Synchronisation</div>
                  {overview.lastSync ? (
                    <>
                      <div className="font-semibold text-slate-100">
                        {formatDateTime(overview.lastSync.timestamp)} ·{' '}
                        <span
                          className={
                            overview.lastSync.status === 'success'
                              ? 'text-emerald-400'
                              : overview.lastSync.status === 'partial'
                                ? 'text-amber-400'
                                : 'text-red-400'
                          }
                        >
                          {overview.lastSync.status.toUpperCase()}
                        </span>
                      </div>
                      <div className="text-slate-300">
                        {formatDirection(overview.lastSync.direction)} · {overview.lastSync.summary}
                      </div>
                    </>
                  ) : (
                    <div className="text-slate-300">No synchronisation runs recorded yet.</div>
                  )}
                </div>

                <div className="bg-[#080d1a] border border-white/10 rounded-lg p-3 text-xs space-y-1.5">
                  <label htmlFor="sync-conflict-strategy" className="block text-slate-400">
                    Conflict Handling Policy
                  </label>
                  <select
                    id="sync-conflict-strategy"
                    value={strategy}
                    disabled={isJobRunning}
                    onChange={(e) => setStrategy(e.target.value as ConflictStrategy)}
                    className="w-full px-2.5 py-1.5 rounded-md bg-[#050811] border border-white/15 text-slate-100 text-xs focus:outline-none focus:border-red-500"
                  >
                    <option value="newest_wins">
                      Smart Merge (Newest Timestamp Wins, Preserve Unique Records)
                    </option>
                    <option value="skip_conflicts">
                      Safe Copy Only (Copy Missing Docs, Skip Differing Conflicts)
                    </option>
                    <option value="overwrite_with_backup">
                      Overwrite Differing Docs (With Automatic Pre-Sync Backup)
                    </option>
                  </select>
                </div>
              </div>

              {/* Action Buttons */}
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-2.5">
                <button
                  type="button"
                  disabled={isJobRunning || mirrorStarting}
                  onClick={() => void handleStartMirror('default_to_ai')}
                  className="flex items-center justify-center gap-2 px-3.5 py-2.5 rounded-lg bg-slate-900 hover:bg-slate-800 border border-white/15 disabled:opacity-50 text-xs font-semibold text-slate-100 transition-colors cursor-pointer"
                >
                  <span>Mirror Default</span>
                  <ArrowRight className="w-3.5 h-3.5 text-sky-400" />
                  <span>AI Shared</span>
                </button>

                <button
                  type="button"
                  disabled={isJobRunning || mirrorStarting}
                  onClick={() => void handleStartMirror('ai_shared_to_default')}
                  className="flex items-center justify-center gap-2 px-3.5 py-2.5 rounded-lg bg-slate-900 hover:bg-slate-800 border border-white/15 disabled:opacity-50 text-xs font-semibold text-slate-100 transition-colors cursor-pointer"
                >
                  <span>Mirror AI Shared</span>
                  <ArrowRight className="w-3.5 h-3.5 text-emerald-400" />
                  <span>Default</span>
                </button>

                <button
                  type="button"
                  disabled={isJobRunning || mirrorStarting}
                  onClick={() => void handleStartMirror('bidirectional_sync', 'newest_wins')}
                  className="flex items-center justify-center gap-2 px-3.5 py-2.5 rounded-lg bg-red-700 hover:bg-red-600 disabled:opacity-50 text-xs font-semibold text-white transition-colors cursor-pointer"
                >
                  <RefreshCw className={`w-3.5 h-3.5 ${isJobRunning ? 'animate-spin' : ''}`} />
                  <span>Manual Sync Both</span>
                </button>
              </div>

              {/* Live Job Progress & Errors */}
              {activeJob && (
                <div className="bg-[#080d1a] border border-white/12 rounded-lg p-3.5 space-y-2.5">
                  <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
                    <span className="font-semibold text-slate-100">
                      {formatDirection(activeJob.direction)} · {activeJob.phase}
                    </span>
                    <span className="font-mono text-slate-300">
                      {activeJob.progressPct}% ({activeJob.processedDocs}/{activeJob.totalDocs} docs)
                    </span>
                  </div>

                  <div className="h-2 bg-slate-900 rounded-full overflow-hidden border border-white/10">
                    <div
                      className={`h-full transition-all duration-300 ${
                        activeJob.status === 'failed'
                          ? 'bg-red-500'
                          : activeJob.status === 'partial'
                            ? 'bg-amber-500'
                            : 'bg-emerald-500'
                      }`}
                      style={{ width: `${Math.max(4, activeJob.progressPct)}%` }}
                    />
                  </div>

                  <div className="flex flex-wrap items-center justify-between gap-2 text-[11px] text-slate-400">
                    <span>
                      Copied: <strong className="text-slate-200">{activeJob.copiedCount}</strong> ·
                      Skipped: <strong className="text-slate-200">{activeJob.skippedCount}</strong> ·
                      Conflicts: <strong className="text-amber-300">{activeJob.conflictsCount}</strong> ·
                      Errors: <strong className="text-red-300">{activeJob.errorCount}</strong>
                    </span>

                    {(activeJob.status === 'failed' || activeJob.status === 'partial') &&
                      lastAttemptedSync && (
                        <button
                          type="button"
                          onClick={() =>
                            void handleStartMirror(
                              lastAttemptedSync.direction,
                              lastAttemptedSync.strategy
                            )
                          }
                          className="px-2.5 py-1 rounded bg-amber-600 hover:bg-amber-500 text-white font-semibold cursor-pointer"
                        >
                          Retry Sync
                        </button>
                      )}
                  </div>

                  {activeJob.errors.length > 0 && (
                    <div className="max-h-24 overflow-y-auto bg-red-950/40 border border-red-500/30 rounded p-2 text-[11px] text-red-200 space-y-1">
                      {activeJob.errors.map((errMsg, idx) => (
                        <div key={idx}>{errMsg}</div>
                      ))}
                    </div>
                  )}

                  {activeJob.conflicts.length > 0 && (
                    <details className="text-[11px] text-slate-300">
                      <summary className="cursor-pointer text-amber-300 hover:text-amber-200">
                        View {activeJob.conflicts.length} conflict resolution record(s)
                      </summary>
                      <div className="mt-1.5 max-h-32 overflow-y-auto bg-[#050811] border border-white/10 rounded p-2 space-y-1 font-mono">
                        {activeJob.conflicts.slice(0, 40).map((c, idx) => (
                          <div key={`${c.docPath}-${idx}`} className="text-slate-300">
                            {c.docPath} — <span className="text-amber-300">{c.resolution}</span> ({c.note})
                          </div>
                        ))}
                      </div>
                    </details>
                  )}
                </div>
              )}

              {/* Pre-Sync Backups & Recovery */}
              <div className="bg-[#080d1a] border border-white/10 rounded-lg p-3.5 space-y-2">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-semibold text-slate-200 flex items-center gap-1.5">
                    <RotateCcw className="w-3.5 h-3.5 text-slate-400" />
                    <span>Pre-Sync Backups & Recovery</span>
                  </span>
                  <span className="text-[11px] text-slate-400">Up to 10 snapshots kept server-side</span>
                </div>

                {overview.backups.length === 0 ? (
                  <p className="text-xs text-slate-400">
                    No backup snapshots yet. A snapshot is automatically saved before each sync.
                  </p>
                ) : (
                  <div className="max-h-36 overflow-y-auto divide-y divide-white/8">
                    {overview.backups.map((bk) => (
                      <div
                        key={bk.backupId}
                        className="py-2 flex flex-wrap items-center justify-between gap-2 text-xs"
                      >
                        <div>
                          <div className="text-slate-200 font-medium">
                            {bk.targetDatabase === 'default' ? 'Default DB' : 'AI Shared DB'} ·{' '}
                            {bk.recordCount} docs ({formatBytes(bk.sizeBytes)})
                          </div>
                          <div className="text-[11px] text-slate-400">
                            {formatDateTime(bk.createdAt)} · {formatDirection(bk.direction)}
                          </div>
                        </div>

                        {pendingRestoreId === bk.backupId ? (
                          <div className="flex items-center gap-1.5">
                            <button
                              type="button"
                              disabled={restoreBusy}
                              onClick={() => setPendingRestoreId(null)}
                              className="px-2 py-1 text-[11px] bg-slate-800 text-slate-300 rounded cursor-pointer"
                            >
                              Cancel
                            </button>
                            <button
                              type="button"
                              disabled={restoreBusy}
                              onClick={() => void handleConfirmRestore()}
                              className="px-2.5 py-1 text-[11px] font-semibold bg-amber-600 hover:bg-amber-500 text-white rounded cursor-pointer"
                            >
                              {restoreBusy ? 'Restoring...' : 'Confirm Restore'}
                            </button>
                          </div>
                        ) : (
                          <button
                            type="button"
                            disabled={isJobRunning || restoreBusy}
                            onClick={() => setPendingRestoreId(bk.backupId)}
                            className="px-2.5 py-1 text-[11px] font-medium bg-slate-900 hover:bg-slate-800 border border-white/12 text-slate-200 rounded cursor-pointer"
                          >
                            Restore
                          </button>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </section>

            {/* 3. Database Status & Quota Section */}
            <section className="grid grid-cols-1 lg:grid-cols-2 gap-4">
              {(['default', 'ai_shared'] as DatabaseId[]).map((dbId) => {
                const db = overview.databases[dbId];
                const storagePct = Math.min(
                  100,
                  Math.round((db.estimatedBytes / Math.max(1, db.quota.storageLimitBytes)) * 1000) / 10
                );
                const readPct = Math.min(
                  100,
                  Math.round((db.usage.reads / Math.max(1, db.quota.dailyReadLimit)) * 100)
                );
                const writePct = Math.min(
                  100,
                  Math.round((db.usage.writes / Math.max(1, db.quota.dailyWriteLimit)) * 100)
                );

                return (
                  <div
                    key={dbId}
                    className="bg-[#050811] border border-white/12 rounded-xl p-4 space-y-3"
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div>
                        <h3 className="text-sm font-semibold text-slate-100 flex items-center gap-2">
                          <HardDrive className="w-4 h-4 text-slate-300" />
                          <span>{db.label} Status</span>
                        </h3>
                        <p className="text-[11px] text-slate-400 font-mono mt-0.5">
                          {db.projectId} · {formatAuthMode(db.authMode)}
                        </p>
                      </div>
                      <span
                        className={`text-[11px] font-semibold px-2.5 py-0.5 rounded-md border ${
                          db.connected
                            ? 'bg-emerald-950/50 border-emerald-500/40 text-emerald-300'
                            : 'bg-red-950/60 border-red-500/40 text-red-300'
                        }`}
                      >
                        {db.connected
                          ? `Connected${db.latencyMs !== null ? ` · ${db.latencyMs}ms` : ''}`
                          : 'Disconnected'}
                      </span>
                    </div>

                    {db.error && (
                      <div className="p-2.5 rounded-lg bg-red-950/60 border border-red-500/35 text-[11px] text-red-200 leading-relaxed">
                        {db.error}
                      </div>
                    )}

                    {/* Storage & Document Counts */}
                    <div className="bg-[#080d1a] border border-white/10 rounded-lg p-3 space-y-2 text-xs">
                      <div className="flex items-center justify-between">
                        <span className="text-slate-400">Stored Records & Volume</span>
                        <span className="font-mono text-slate-200">
                          {db.totalDocs.toLocaleString()} docs · {formatBytes(db.estimatedBytes)}
                        </span>
                      </div>
                      <div className="h-1.5 bg-slate-900 rounded-full overflow-hidden">
                        <div
                          className="h-full bg-sky-500"
                          style={{ width: `${Math.max(storagePct, db.totalDocs > 0 ? 2 : 0)}%` }}
                        />
                      </div>
                      <div className="flex items-center justify-between text-[11px] text-slate-400">
                        <span>Free Tier Storage: {formatBytes(db.quota.storageRemainingBytes)} free</span>
                        <span>Latest Doc: {formatDateTime(db.latestRecordAt)}</span>
                      </div>

                      <div className="grid grid-cols-3 gap-1.5 pt-1 text-[11px] text-slate-300">
                        <div>Users: {db.docCounts.users ?? 0}</div>
                        <div>Friends: {db.docCounts.friends ?? 0}</div>
                        <div>Chat: {db.docCounts.global_chat ?? 0}</div>
                        <div>Rooms: {db.docCounts.rooms ?? 0}</div>
                        <div>Players: {db.docCounts.room_players ?? 0}</div>
                        <div>Codes: {db.docCounts.friend_codes ?? 0}</div>
                      </div>
                    </div>

                    {/* Tracked Usage & Remaining Quota */}
                    <div className="bg-[#080d1a] border border-white/10 rounded-lg p-3 space-y-2 text-xs">
                      <div className="flex items-center justify-between">
                        <span className="text-slate-300 font-medium">
                          Today&apos;s Usage ({db.usage.dateKey})
                        </span>
                        <span className="text-[11px] text-slate-400">
                          Lifetime ops: {db.usage.totalLifetimeOps.toLocaleString()}
                        </span>
                      </div>

                      <div className="space-y-1.5 text-[11px]">
                        <div>
                          <div className="flex justify-between text-slate-300 mb-0.5">
                            <span>
                              Reads: {db.usage.reads.toLocaleString()} /{' '}
                              {db.quota.dailyReadLimit.toLocaleString()}
                            </span>
                            <span className="text-emerald-300">
                              {db.quota.readsRemaining.toLocaleString()} left
                            </span>
                          </div>
                          <div className="h-1.5 bg-slate-900 rounded-full overflow-hidden">
                            <div
                              className={`h-full ${readPct > 80 ? 'bg-amber-500' : 'bg-emerald-500'}`}
                              style={{ width: `${Math.max(readPct, db.usage.reads > 0 ? 2 : 0)}%` }}
                            />
                          </div>
                        </div>

                        <div>
                          <div className="flex justify-between text-slate-300 mb-0.5">
                            <span>
                              Writes: {db.usage.writes.toLocaleString()} /{' '}
                              {db.quota.dailyWriteLimit.toLocaleString()}
                            </span>
                            <span className="text-emerald-300">
                              {db.quota.writesRemaining.toLocaleString()} left
                            </span>
                          </div>
                          <div className="h-1.5 bg-slate-900 rounded-full overflow-hidden">
                            <div
                              className={`h-full ${writePct > 80 ? 'bg-amber-500' : 'bg-sky-500'}`}
                              style={{ width: `${Math.max(writePct, db.usage.writes > 0 ? 2 : 0)}%` }}
                            />
                          </div>
                        </div>

                        <div className="flex justify-between text-slate-400">
                          <span>
                            Deletes: {db.usage.deletes.toLocaleString()} /{' '}
                            {db.quota.dailyDeleteLimit.toLocaleString()}
                          </span>
                          <span>{db.quota.deletesRemaining.toLocaleString()} left</span>
                        </div>
                      </div>

                      <p className="text-[10px] text-slate-400 leading-relaxed pt-1">
                        {db.quota.quotaProviderNote}
                      </p>
                    </div>
                  </div>
                );
              })}
            </section>
          </div>
        ) : null}
      </div>
    </div>
  );
};
