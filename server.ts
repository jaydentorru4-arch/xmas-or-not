import 'dotenv/config';
import express, { type NextFunction, type Request, type Response } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import {
  attachDefaultRoomSnapshot,
  getActiveDatabaseState,
  getAdminDatabaseOverview,
  getMirrorJob,
  isAdminUser,
  proxyAcceptFriendRequest,
  proxyClaimHost,
  proxyClearGlobalChat,
  proxyCreateRoom,
  proxyDeleteRoom,
  proxyEnsureProfile,
  proxyGetRoomSnapshot,
  proxyJoinRoom,
  proxyLeaveRoom,
  proxyListFriends,
  proxyListGlobalChat,
  proxyListPublicRooms,
  proxyRecordOutcome,
  proxyRemoveFriend,
  proxyRoomAction,
  proxySendFriendRequest,
  proxySendGlobalChat,
  proxySendRoomChat,
  proxyStartRoom,
  proxySyncPlayer,
  proxySyncSanta,
  proxyUpdateProfile,
  recordUsageOps,
  restoreFromBackup,
  startMirrorJob,
  subscribeActiveDatabaseChanges,
  switchActiveDatabase,
  verifyBearerToken,
  type AuthUser,
  type ConflictStrategy,
  type DatabaseId,
  type MirrorDirection,
} from './server/dbManager.ts';

interface AuthedRequest extends Request {
  authUser?: AuthUser;
}

const VALID_ID_RE = /^[a-zA-Z0-9_\-]{1,128}$/;
const VALID_ROOM_ID_RE = /^[a-zA-Z0-9_\-]{4,32}$/;

async function requireAuth(req: AuthedRequest, res: Response, next: NextFunction): Promise<void> {
  const user = await verifyBearerToken(req.headers.authorization);
  if (!user) {
    res.status(401).json({ error: 'Authentication required. Please sign in.' });
    return;
  }
  req.authUser = user;
  next();
}

async function requireAdmin(req: AuthedRequest, res: Response, next: NextFunction): Promise<void> {
  const user = await verifyBearerToken(req.headers.authorization);
  if (!user) {
    res.status(401).json({ error: 'Authentication required.' });
    return;
  }
  if (!isAdminUser(user)) {
    res.status(403).json({ error: 'Administrator permission required.' });
    return;
  }
  req.authUser = user;
  next();
}

function sendError(res: Response, err: unknown, fallbackStatus = 500): void {
  const raw = err instanceof Error ? err.message : String(err);
  if (/PERMISSION_DENIED|403/i.test(raw)) {
    res.status(503).json({
      code: 'DEFAULT_DB_SETUP_REQUIRED',
      error: raw,
    });
    return;
  }
  if (/not found/i.test(raw)) {
    res.status(404).json({ error: raw });
    return;
  }
  if (/invalid|already|cannot|must be|only the room host/i.test(raw)) {
    res.status(400).json({ error: raw });
    return;
  }
  res.status(fallbackStatus).json({ error: raw || 'Unexpected server error.' });
}

export async function createApp(): Promise<express.Express> {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '1mb' }));

  // ============================================================
  // Active Database Discovery & Switch Broadcast
  // ============================================================

  app.get('/api/database/active', async (req: AuthedRequest, res: Response) => {
    const active = getActiveDatabaseState();
    const user = req.headers.authorization ? await verifyBearerToken(req.headers.authorization) : null;
    res.json({
      activeDatabase: active.activeDatabase,
      lastSwitchAt: active.lastSwitchAt,
      isAdmin: isAdminUser(user),
    });
  });

  app.get('/api/database/stream', (_req: Request, res: Response) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders?.();

    const writeEvent = (payload: unknown) => {
      res.write(`data: ${JSON.stringify(payload)}\n\n`);
    };
    writeEvent(getActiveDatabaseState());

    const unsub = subscribeActiveDatabaseChanges((activeDatabase, lastSwitchAt) => {
      writeEvent({ activeDatabase, lastSwitchAt });
    });

    const keepAlive = setInterval(() => {
      res.write(': ping\n\n');
    }, 25_000);

    res.on('close', () => {
      clearInterval(keepAlive);
      unsub();
    });
  });

  app.post('/api/database/ai-shared-usage', requireAuth, (req: AuthedRequest, res: Response) => {
    const reads = Math.max(0, Math.min(500, Math.floor(Number(req.body?.reads || 0))));
    const writes = Math.max(0, Math.min(500, Math.floor(Number(req.body?.writes || 0))));
    const deletes = Math.max(0, Math.min(500, Math.floor(Number(req.body?.deletes || 0))));
    const error = typeof req.body?.error === 'string' ? req.body.error.slice(0, 300) : null;
    recordUsageOps('ai_shared', { reads, writes, deletes, error });
    res.json({ ok: true });
  });

  // ============================================================
  // Admin Database Management API (Admin Email Verified)
  // ============================================================

  app.get('/api/admin/database/overview', requireAdmin, async (req: AuthedRequest, res: Response) => {
    try {
      const overview = await getAdminDatabaseOverview(req.authUser!.idToken);
      res.json(overview);
    } catch (err) {
      sendError(res, err);
    }
  });

  app.post('/api/admin/database/switch', requireAdmin, async (req: AuthedRequest, res: Response) => {
    try {
      const targetDatabase = req.body?.targetDatabase as DatabaseId;
      const confirm = req.body?.confirm === true;
      if (targetDatabase !== 'default' && targetDatabase !== 'ai_shared') {
        res.status(400).json({ error: 'Invalid target database selection.' });
        return;
      }
      if (!confirm) {
        res.status(400).json({ error: 'Confirmation is required before switching active databases.' });
        return;
      }
      const result = await switchActiveDatabase(targetDatabase, req.authUser!.idToken);
      res.json(result);
    } catch (err) {
      sendError(res, err);
    }
  });

  app.post('/api/admin/database/mirror', requireAdmin, (req: AuthedRequest, res: Response) => {
    try {
      const direction = req.body?.direction as MirrorDirection;
      const strategy = (req.body?.conflictStrategy || 'newest_wins') as ConflictStrategy;
      if (
        direction !== 'default_to_ai' &&
        direction !== 'ai_shared_to_default' &&
        direction !== 'bidirectional_sync'
      ) {
        res.status(400).json({ error: 'Invalid mirroring direction.' });
        return;
      }
      if (
        strategy !== 'newest_wins' &&
        strategy !== 'skip_conflicts' &&
        strategy !== 'overwrite_with_backup'
      ) {
        res.status(400).json({ error: 'Invalid conflict resolution strategy.' });
        return;
      }
      const job = startMirrorJob(direction, strategy, req.authUser!.idToken);
      res.status(202).json(job);
    } catch (err) {
      res.status(409).json({ error: err instanceof Error ? err.message : 'Unable to start sync job.' });
    }
  });

  app.get('/api/admin/database/jobs/:jobId', requireAdmin, (req: AuthedRequest, res: Response) => {
    const job = getMirrorJob(String(req.params.jobId || ''));
    if (!job) {
      res.status(404).json({ error: 'Sync job not found.' });
      return;
    }
    res.json(job);
  });

  app.post('/api/admin/database/restore', requireAdmin, async (req: AuthedRequest, res: Response) => {
    try {
      const backupId = String(req.body?.backupId || '').trim();
      if (!backupId || !VALID_ID_RE.test(backupId)) {
        res.status(400).json({ error: 'Valid backupId is required.' });
        return;
      }
      const result = await restoreFromBackup(backupId, req.authUser!.idToken);
      res.json(result);
    } catch (err) {
      sendError(res, err);
    }
  });

  // ============================================================
  // Application Data Proxy Routes (Default Database: holloweve-1d459)
  // ============================================================

  app.post('/api/db/profile/ensure', requireAuth, async (req: AuthedRequest, res: Response) => {
    try {
      const preferredName =
        typeof req.body?.preferredName === 'string' ? req.body.preferredName : undefined;
      const profile = await proxyEnsureProfile(req.authUser!, preferredName);
      res.json(profile);
    } catch (err) {
      sendError(res, err);
    }
  });

  app.patch('/api/db/profile', requireAuth, async (req: AuthedRequest, res: Response) => {
    try {
      const updated = await proxyUpdateProfile(req.authUser!.uid, {
        displayName: String(req.body?.displayName || 'Survivor'),
        coatColor: String(req.body?.coatColor || '#b91c1c'),
        scarfColor: String(req.body?.scarfColor || '#f8fafc'),
        hatStyle: String(req.body?.hatStyle || 'hood'),
      });
      res.json(updated);
    } catch (err) {
      sendError(res, err);
    }
  });

  app.post('/api/db/profile/outcome', requireAuth, async (req: AuthedRequest, res: Response) => {
    try {
      const result = await proxyRecordOutcome(
        req.authUser!.uid,
        Boolean(req.body?.escaped),
        Number(req.body?.earnedXp || 0)
      );
      res.json(result);
    } catch (err) {
      sendError(res, err);
    }
  });

  app.get('/api/db/friends', requireAuth, async (req: AuthedRequest, res: Response) => {
    try {
      const friends = await proxyListFriends(req.authUser!.uid);
      res.json({ friends });
    } catch (err) {
      sendError(res, err);
    }
  });

  app.post('/api/db/friends/request', requireAuth, async (req: AuthedRequest, res: Response) => {
    try {
      await proxySendFriendRequest(req.authUser!.uid, {
        targetUid: typeof req.body?.targetUid === 'string' ? req.body.targetUid : undefined,
        code: typeof req.body?.code === 'string' ? req.body.code : undefined,
      });
      res.json({ ok: true });
    } catch (err) {
      sendError(res, err);
    }
  });

  app.post('/api/db/friends/accept', requireAuth, async (req: AuthedRequest, res: Response) => {
    try {
      const friendUid = String(req.body?.friendUid || '');
      if (!VALID_ID_RE.test(friendUid)) {
        res.status(400).json({ error: 'Invalid friend UID.' });
        return;
      }
      await proxyAcceptFriendRequest(req.authUser!.uid, friendUid);
      res.json({ ok: true });
    } catch (err) {
      sendError(res, err);
    }
  });

  app.delete('/api/db/friends/:friendUid', requireAuth, async (req: AuthedRequest, res: Response) => {
    try {
      const friendUid = String(req.params.friendUid || '');
      if (!VALID_ID_RE.test(friendUid)) {
        res.status(400).json({ error: 'Invalid friend UID.' });
        return;
      }
      await proxyRemoveFriend(req.authUser!.uid, friendUid);
      res.json({ ok: true });
    } catch (err) {
      sendError(res, err);
    }
  });

  app.get('/api/db/global-chat', requireAuth, async (_req: AuthedRequest, res: Response) => {
    try {
      const messages = await proxyListGlobalChat();
      res.json({ messages });
    } catch (err) {
      sendError(res, err);
    }
  });

  app.post('/api/db/global-chat', requireAuth, async (req: AuthedRequest, res: Response) => {
    try {
      await proxySendGlobalChat(req.authUser!.uid, {
        displayName: String(req.body?.displayName || 'Survivor'),
        coatColor: String(req.body?.coatColor || '#38bdf8'),
        text: String(req.body?.text || ''),
      });
      res.json({ ok: true });
    } catch (err) {
      sendError(res, err);
    }
  });

  app.delete('/api/db/global-chat', requireAuth, async (_req: AuthedRequest, res: Response) => {
    try {
      await proxyClearGlobalChat();
      res.json({ ok: true });
    } catch (err) {
      sendError(res, err);
    }
  });

  app.get('/api/db/rooms/public', requireAuth, async (_req: AuthedRequest, res: Response) => {
    try {
      const rooms = await proxyListPublicRooms();
      res.json({ rooms });
    } catch (err) {
      sendError(res, err);
    }
  });

  app.post('/api/db/rooms', requireAuth, async (req: AuthedRequest, res: Response) => {
    try {
      const room = await proxyCreateRoom(req.authUser!.uid, req.body || {});
      res.json(room);
    } catch (err) {
      sendError(res, err);
    }
  });

  app.post('/api/db/rooms/:roomId/join', requireAuth, async (req: AuthedRequest, res: Response) => {
    try {
      const roomId = String(req.params.roomId || '').trim().toUpperCase();
      if (!VALID_ROOM_ID_RE.test(roomId)) {
        res.status(400).json({ error: 'Invalid room code format.' });
        return;
      }
      const room = await proxyJoinRoom(req.authUser!.uid, roomId, req.body || {});
      res.json(room);
    } catch (err) {
      sendError(res, err);
    }
  });

  app.post('/api/db/rooms/:roomId/leave', requireAuth, async (req: AuthedRequest, res: Response) => {
    try {
      const roomId = String(req.params.roomId || '').trim().toUpperCase();
      if (!VALID_ROOM_ID_RE.test(roomId)) {
        res.status(400).json({ error: 'Invalid room code.' });
        return;
      }
      await proxyLeaveRoom(roomId, req.authUser!.uid);
      res.json({ ok: true });
    } catch (err) {
      sendError(res, err);
    }
  });

  app.post('/api/db/rooms/:roomId/claim-host', requireAuth, async (req: AuthedRequest, res: Response) => {
    try {
      const roomId = String(req.params.roomId || '').trim().toUpperCase();
      if (!VALID_ROOM_ID_RE.test(roomId)) {
        res.status(400).json({ error: 'Invalid room code.' });
        return;
      }
      const claimed = await proxyClaimHost(
        roomId,
        req.authUser!.uid,
        String(req.body?.displayName || 'Survivor')
      );
      res.json({ claimed });
    } catch (err) {
      sendError(res, err);
    }
  });

  app.post('/api/db/rooms/:roomId/start', requireAuth, async (req: AuthedRequest, res: Response) => {
    try {
      const roomId = String(req.params.roomId || '').trim().toUpperCase();
      if (!VALID_ROOM_ID_RE.test(roomId)) {
        res.status(400).json({ error: 'Invalid room code.' });
        return;
      }
      await proxyStartRoom(roomId, req.authUser!.uid);
      res.json({ ok: true });
    } catch (err) {
      sendError(res, err);
    }
  });

  app.delete('/api/db/rooms/:roomId', requireAuth, async (req: AuthedRequest, res: Response) => {
    try {
      const roomId = String(req.params.roomId || '').trim().toUpperCase();
      if (!VALID_ROOM_ID_RE.test(roomId)) {
        res.status(400).json({ error: 'Invalid room code.' });
        return;
      }
      await proxyDeleteRoom(roomId);
      res.json({ ok: true });
    } catch (err) {
      sendError(res, err);
    }
  });

  app.post('/api/db/rooms/:roomId/action', requireAuth, async (req: AuthedRequest, res: Response) => {
    try {
      const roomId = String(req.params.roomId || '').trim().toUpperCase();
      if (!VALID_ROOM_ID_RE.test(roomId)) {
        res.status(400).json({ error: 'Invalid room code.' });
        return;
      }
      const out = await proxyRoomAction(roomId, req.authUser!.uid, req.body || {});
      res.json(out);
    } catch (err) {
      sendError(res, err);
    }
  });

  app.put('/api/db/rooms/:roomId/player', requireAuth, async (req: AuthedRequest, res: Response) => {
    try {
      const roomId = String(req.params.roomId || '').trim().toUpperCase();
      if (!VALID_ROOM_ID_RE.test(roomId)) {
        res.status(400).json({ error: 'Invalid room code.' });
        return;
      }
      await proxySyncPlayer(roomId, req.authUser!.uid, req.body || {});
      res.json({ ok: true });
    } catch (err) {
      sendError(res, err);
    }
  });

  app.put('/api/db/rooms/:roomId/santa', requireAuth, async (req: AuthedRequest, res: Response) => {
    try {
      const roomId = String(req.params.roomId || '').trim().toUpperCase();
      if (!VALID_ROOM_ID_RE.test(roomId)) {
        res.status(400).json({ error: 'Invalid room code.' });
        return;
      }
      await proxySyncSanta(roomId, req.authUser!.uid, req.body || {});
      res.json({ ok: true });
    } catch (err) {
      sendError(res, err);
    }
  });

  app.get('/api/db/rooms/:roomId/snapshot', requireAuth, async (req: AuthedRequest, res: Response) => {
    try {
      const roomId = String(req.params.roomId || '').trim().toUpperCase();
      if (!VALID_ROOM_ID_RE.test(roomId)) {
        res.status(400).json({ error: 'Invalid room code.' });
        return;
      }
      const snapshot = await proxyGetRoomSnapshot(roomId);
      res.json(snapshot);
    } catch (err) {
      sendError(res, err);
    }
  });

  app.get('/api/db/rooms/:roomId/stream', requireAuth, (req: AuthedRequest, res: Response) => {
    const roomId = String(req.params.roomId || '').trim().toUpperCase();
    if (!VALID_ROOM_ID_RE.test(roomId)) {
      res.status(400).json({ error: 'Invalid room code.' });
      return;
    }

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders?.();

    const pushEvent = (event: string, data: unknown) => {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };

    let unsub = () => {};
    try {
      unsub = attachDefaultRoomSnapshot(roomId, {
        onRoom: (room) => pushEvent('room', room),
        onPlayers: (players) => pushEvent('players', players),
        onSanta: (santa) => pushEvent('santa', santa),
        onMessages: (msgs) => pushEvent('messages', msgs),
        onError: (error) => pushEvent('error', { error }),
      });
    } catch (err) {
      pushEvent('error', { error: err instanceof Error ? err.message : 'Stream setup failed' });
    }

    const keepAlive = setInterval(() => {
      res.write(': ping\n\n');
    }, 20_000);

    res.on('close', () => {
      clearInterval(keepAlive);
      unsub();
    });
  });

  app.post('/api/db/rooms/:roomId/messages', requireAuth, async (req: AuthedRequest, res: Response) => {
    try {
      const roomId = String(req.params.roomId || '').trim().toUpperCase();
      if (!VALID_ROOM_ID_RE.test(roomId)) {
        res.status(400).json({ error: 'Invalid room code.' });
        return;
      }
      await proxySendRoomChat(roomId, req.authUser!.uid, {
        displayName: String(req.body?.displayName || 'Survivor'),
        coatColor: String(req.body?.coatColor || '#38bdf8'),
        text: String(req.body?.text || ''),
      });
      res.json({ ok: true });
    } catch (err) {
      sendError(res, err);
    }
  });

  // ============================================================
  // Vite Dev Middleware or Static Production Build
  // ============================================================

  if (process.env.NODE_ENV !== 'production') {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distDir = path.resolve(process.cwd(), 'dist');
    app.use(express.static(distDir));
    app.get('*', (_req, res) => {
      const indexHtml = path.join(distDir, 'index.html');
      if (fs.existsSync(indexHtml)) {
        res.sendFile(indexHtml);
      } else {
        res.status(404).send('Build output not found.');
      }
    });
  }


  return app;
}

async function startServer(): Promise<void> {
  const app = await createApp();
  const portArgIdx = process.argv.findIndex((arg) => arg === '--port' || arg.startsWith('--port='));
  let cliPort: number | undefined;
  if (portArgIdx >= 0) {
    const rawPort = process.argv[portArgIdx].startsWith('--port=')
      ? process.argv[portArgIdx].split('=')[1]
      : process.argv[portArgIdx + 1];
    const parsed = Number(rawPort);
    if (Number.isFinite(parsed) && parsed > 0) cliPort = parsed;
  }
  const port = cliPort || Number(process.env.PORT || 3000);
  app.listen(port, '0.0.0.0', () => {
    console.log(`Hollow Eve server listening on http://0.0.0.0:${port}`);
  });
}

// Vercel imports createApp() from api/[...path].ts. Do not start a second
// listener inside a serverless function. Local development still starts the
// persistent Express server through the existing npm run dev script.
if (process.env.VERCEL !== '1') {
  void startServer();
}
