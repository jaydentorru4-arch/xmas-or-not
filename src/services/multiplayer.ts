import {
  createUserWithEmailAndPassword,
  sendPasswordResetEmail,
  signInWithEmailAndPassword,
  signInWithPopup,
  signOut,
  updateProfile,
  type User,
} from 'firebase/auth';
import {
  collection,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  limit,
  onSnapshot,
  query,
  runTransaction,
  serverTimestamp,
  setDoc,
  updateDoc,
  where,
  type Unsubscribe,
} from 'firebase/firestore';
import {
  auth,
  db,
  googleProvider,
  handleFirestoreError,
  OperationType,
} from '../firebase';
import {
  authedApiFetch,
  DbApiError,
  ensureActiveDatabaseLoaded,
  getBackendStatus,
  getCachedActiveDatabase,
  trackAiSharedClientOp,
} from './databaseAdmin';
import { CELL_SIZE, cellToWorld, generateMaze } from '../game/maze';
import {
  applyXpGain,
  ChatMessageData,
  COAT_COLORS,
  DifficultyId,
  FriendRecord,
  FriendStatus,
  GameRoomData,
  getLevelScaling,
  HAT_STYLES,
  HatStyle,
  RoomPlayerData,
  SantaLiveData,
  SCARF_COLORS,
  SurvivorProfile,
  WeaponType,
} from '../game/types';

function useDefaultProxy(): boolean {
  return getCachedActiveDatabase() === 'default';
}

function sanitizeEquippedWeapon(raw: unknown): WeaponType | '' {
  if (raw === 'tranq_dart' || raw === 'cryo_blaster' || raw === 'candy_bat') return raw;
  return '';
}

function sanitizeDisplayName(raw: string): string {
  const cleaned = raw.trim().replace(/\s+/g, ' ').slice(0, 24);
  return cleaned.length >= 2 ? cleaned : 'Survivor';
}

function sanitizeCoatColor(hex: string): string {
  return /^#[0-9a-fA-F]{6}$/.test(hex) ? hex : COAT_COLORS[0].hex;
}

function sanitizeScarfColor(hex: string): string {
  return /^#[0-9a-fA-F]{6}$/.test(hex) ? hex : SCARF_COLORS[0].hex;
}

function sanitizeHatStyle(raw: string): HatStyle {
  return HAT_STYLES.some((h) => h.id === raw) ? (raw as HatStyle) : 'hood';
}

function sanitizeChatText(raw: string): string {
  return raw.trim().slice(0, 240);
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

function generateRoomId(): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = 'EVE-';
  for (let i = 0; i < 5; i++) {
    code += chars[Math.floor(Math.random() * chars.length)];
  }
  return code;
}

function generateMessageId(): string {
  return `m_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
}

async function ensureFriendCodeLookup(uid: string, friendCode: string): Promise<void> {
  try {
    const codeRef = doc(db, 'friendCodes', friendCode);
    const snap = await getDoc(codeRef);
    trackAiSharedClientOp({ reads: 1 });
    if (!snap.exists()) {
      await setDoc(codeRef, {
        uid,
        friendCode,
        createdAt: serverTimestamp(),
      });
      trackAiSharedClientOp({ writes: 1 });
    }
  } catch {
    // Non-fatal if already registered or offline
  }
}

let pendingRegistrationName: string | null = null;
const friendsRefreshListeners = new Set<() => void>();
const globalChatRefreshListeners = new Set<() => void>();
const publicRoomsRefreshListeners = new Set<() => void>();

function triggerFriendsRefresh(): void {
  for (const fn of friendsRefreshListeners) fn();
}

function triggerGlobalChatRefresh(): void {
  for (const fn of globalChatRefreshListeners) fn();
}

function triggerPublicRoomsRefresh(): void {
  for (const fn of publicRoomsRefreshListeners) fn();
}

function mapFirebaseAuthError(error: unknown, fallback: string): Error {
  const code =
    typeof error === 'object' && error !== null && 'code' in error
      ? String((error as { code?: unknown }).code || '')
      : '';

  switch (code) {
    case 'auth/operation-not-allowed':
      return new Error(
        'Email/Password sign-in is not enabled in Firebase Console yet. Enable the Email/Password provider in Authentication -> Sign-in method, or sign in with Google.'
      );
    case 'auth/email-already-in-use':
      return new Error('An account with this email already exists. Switch to Sign In instead.');
    case 'auth/invalid-email':
      return new Error('Please enter a valid email address.');
    case 'auth/weak-password':
      return new Error('Password must be at least 6 characters long.');
    case 'auth/invalid-credential':
    case 'auth/wrong-password':
    case 'auth/user-not-found':
      return new Error('Incorrect email or password.');
    case 'auth/user-disabled':
      return new Error('This account has been disabled.');
    case 'auth/too-many-requests':
      return new Error('Too many attempts. Please wait a moment and try again.');
    case 'auth/popup-closed-by-user':
      return new Error('Google sign-in popup was closed before completing.');
    case 'auth/network-request-failed':
      return new Error('Network error. Check your connection and try again.');
    default:
      return error instanceof Error ? error : new Error(fallback);
  }
}

// Shared SSE + Snapshot Hub for Default Database rooms
interface DefaultRoomStreamHub {
  roomCbs: Set<(room: GameRoomData | null) => void>;
  playerCbs: Set<(players: RoomPlayerData[]) => void>;
  santaCbs: Set<(santa: SantaLiveData) => void>;
  msgCbs: Set<(msgs: ChatMessageData[]) => void>;
  abort: AbortController;
  pollId: number | null;
}

const roomStreamHubs = new Map<string, DefaultRoomStreamHub>();

function getOrStartRoomHub(roomId: string): DefaultRoomStreamHub {
  const existing = roomStreamHubs.get(roomId);
  if (existing) return existing;

  const abort = new AbortController();
  const hub: DefaultRoomStreamHub = {
    roomCbs: new Set(),
    playerCbs: new Set(),
    santaCbs: new Set(),
    msgCbs: new Set(),
    abort,
    pollId: null,
  };
  roomStreamHubs.set(roomId, hub);

  const emitEvent = (eventType: string, rawData: string) => {
    try {
      const parsed = JSON.parse(rawData);
      if (eventType === 'room') {
        for (const cb of hub.roomCbs) cb(parsed as GameRoomData | null);
      } else if (eventType === 'players') {
        for (const cb of hub.playerCbs) cb(parsed as RoomPlayerData[]);
      } else if (eventType === 'santa' && parsed) {
        for (const cb of hub.santaCbs) cb(parsed as SantaLiveData);
      } else if (eventType === 'messages') {
        for (const cb of hub.msgCbs) cb(parsed as ChatMessageData[]);
      }
    } catch {
      // ignore malformed chunk
    }
  };

  const fetchSnapshotFallback = async () => {
    try {
      const snap = await authedApiFetch<{
        room: GameRoomData | null;
        players: RoomPlayerData[];
        santa: SantaLiveData | null;
        messages: ChatMessageData[];
      }>(`/api/db/rooms/${encodeURIComponent(roomId)}/snapshot`);
      for (const cb of hub.roomCbs) cb(snap.room);
      for (const cb of hub.playerCbs) cb(snap.players);
      if (snap.santa) for (const cb of hub.santaCbs) cb(snap.santa);
      for (const cb of hub.msgCbs) cb(snap.messages);
    } catch {
      // ignore transient poll error
    }
  };

  const startSse = async () => {
    try {
      const token = await auth.currentUser?.getIdToken();
      if (!token || abort.signal.aborted) return;

      const resp = await fetch(`/api/db/rooms/${encodeURIComponent(roomId)}/stream`, {
        headers: { Authorization: `Bearer ${token}` },
        signal: abort.signal,
      });
      if (!resp.ok || !resp.body) throw new Error('Stream unavailable');

      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (!abort.signal.aborted) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const blocks = buffer.split('\n\n');
        buffer = blocks.pop() || '';
        for (const block of blocks) {
          if (!block.trim() || block.startsWith(':')) continue;
          let eventType = 'message';
          let dataLine = '';
          for (const line of block.split('\n')) {
            if (line.startsWith('event:')) eventType = line.slice(6).trim();
            else if (line.startsWith('data:')) dataLine += line.slice(5).trim();
          }
          if (dataLine) emitEvent(eventType, dataLine);
        }
      }
    } catch {
      if (!abort.signal.aborted && hub.pollId === null) {
        void fetchSnapshotFallback();
        hub.pollId = window.setInterval(() => {
          if (!abort.signal.aborted) void fetchSnapshotFallback();
        }, 700);
      }
    }
  };

  void startSse();
  return hub;
}

function cleanupRoomHubIfEmpty(roomId: string): void {
  const hub = roomStreamHubs.get(roomId);
  if (!hub) return;
  if (
    hub.roomCbs.size === 0 &&
    hub.playerCbs.size === 0 &&
    hub.santaCbs.size === 0 &&
    hub.msgCbs.size === 0
  ) {
    hub.abort.abort();
    if (hub.pollId !== null) clearInterval(hub.pollId);
    roomStreamHubs.delete(roomId);
  }
}

export async function signInSurvivorWithGoogle(): Promise<User> {
  try {
    const res = await signInWithPopup(auth, googleProvider);
    return res.user;
  } catch (error) {
    throw mapFirebaseAuthError(error, 'Google Sign-In was cancelled or failed.');
  }
}

export async function registerSurvivorWithEmail(
  email: string,
  password: string,
  displayName: string
): Promise<User> {
  const cleanEmail = email.trim();
  const cleanName = displayName.trim().replace(/\s+/g, ' ').slice(0, 24);
  if (cleanName.length < 2) {
    throw new Error('Survivor name must be at least 2 characters.');
  }
  if (!cleanEmail || !cleanEmail.includes('@')) {
    throw new Error('Please enter a valid email address.');
  }
  if (password.length < 6) {
    throw new Error('Password must be at least 6 characters long.');
  }

  pendingRegistrationName = cleanName;
  try {
    const cred = await createUserWithEmailAndPassword(auth, cleanEmail, password);
    try {
      await updateProfile(cred.user, { displayName: cleanName });
    } catch {
      // Non-fatal; Firestore public profile also stores cleanName
    }
    return cred.user;
  } catch (error) {
    pendingRegistrationName = null;
    throw mapFirebaseAuthError(error, 'Could not create your survivor account.');
  }
}

export async function signInSurvivorWithEmail(email: string, password: string): Promise<User> {
  const cleanEmail = email.trim();
  if (!cleanEmail || !cleanEmail.includes('@')) {
    throw new Error('Please enter a valid email address.');
  }
  if (!password) {
    throw new Error('Please enter your password.');
  }

  try {
    const cred = await signInWithEmailAndPassword(auth, cleanEmail, password);
    return cred.user;
  } catch (error) {
    throw mapFirebaseAuthError(error, 'Could not sign in with email and password.');
  }
}

export async function resetSurvivorPassword(email: string): Promise<void> {
  const cleanEmail = email.trim();
  if (!cleanEmail || !cleanEmail.includes('@')) {
    throw new Error('Enter your account email first to receive a reset link.');
  }
  try {
    await sendPasswordResetEmail(auth, cleanEmail);
  } catch (error) {
    throw mapFirebaseAuthError(error, 'Could not send password reset email.');
  }
}

export async function signOutSurvivor(): Promise<void> {
  pendingRegistrationName = null;
  await signOut(auth);
}

export async function loadOrCreateSurvivorProfile(user: User): Promise<SurvivorProfile> {
  await ensureActiveDatabaseLoaded();
  const chosenPendingName = pendingRegistrationName;
  pendingRegistrationName = null;
  const fallbackName = sanitizeDisplayName(
    chosenPendingName || user.displayName || (user.email ? user.email.split('@')[0] : 'Survivor')
  );

  if (useDefaultProxy()) {
    if (getBackendStatus() !== 'available') {
      throw new DbApiError(
        'Database API server is not reachable on this URL. Refresh the page or start the full-stack server.',
        503,
        'BACKEND_UNAVAILABLE'
      );
    }
    try {
      return await authedApiFetch<SurvivorProfile>('/api/db/profile/ensure', {
        method: 'POST',
        body: JSON.stringify({ preferredName: fallbackName }),
      });
    } catch (error) {
      if (error instanceof DbApiError && error.code === 'DEFAULT_DB_SETUP_REQUIRED') {
        throw error;
      }
      throw error;
    }
  }

  const publicPath = `users/${user.uid}/public/profile`;

  try {
    const privRef = doc(db, 'users', user.uid, 'private', 'info');
    const privSnap = await getDoc(privRef);
    trackAiSharedClientOp({ reads: 1 });
    if (!privSnap.exists()) {
      await setDoc(privRef, {
        uid: user.uid,
        email: (user.email || 'survivor@example.com').slice(0, 254),
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
      trackAiSharedClientOp({ writes: 1 });
    }
  } catch (error) {
    trackAiSharedClientOp({ error: error instanceof Error ? error.message : String(error) });
    console.warn('Non-critical private profile log ignored:', error);
  }

  try {
    const pubRef = doc(db, 'users', user.uid, 'public', 'profile');
    const pubSnap = await getDoc(pubRef);
    trackAiSharedClientOp({ reads: 1 });
    if (pubSnap.exists()) {
      const d = pubSnap.data();
      const friendCode =
        typeof d.friendCode === 'string' && /^[A-Z0-9_-]{4,16}$/.test(d.friendCode)
          ? d.friendCode
          : deriveFriendCode(user.uid);
      const profile: SurvivorProfile = {
        uid: user.uid,
        displayName: sanitizeDisplayName(String(d.displayName || 'Survivor')),
        coatColor: sanitizeCoatColor(String(d.coatColor || COAT_COLORS[0].hex)),
        scarfColor: sanitizeScarfColor(String(d.scarfColor || SCARF_COLORS[0].hex)),
        hatStyle: sanitizeHatStyle(String(d.hatStyle || 'hood')),
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
        await updateDoc(pubRef, {
          scarfColor: profile.scarfColor,
          hatStyle: profile.hatStyle,
          friendCode: profile.friendCode,
          level: profile.level,
          xp: profile.xp,
          updatedAt: serverTimestamp(),
        });
        trackAiSharedClientOp({ writes: 1 });
      }

      await ensureFriendCodeLookup(user.uid, profile.friendCode);
      return profile;
    }

    const defaultName = fallbackName;
    const defaultColor = COAT_COLORS[Math.floor(Math.random() * COAT_COLORS.length)].hex;
    const defaultScarf = SCARF_COLORS[Math.floor(Math.random() * SCARF_COLORS.length)].hex;
    const defaultHat: HatStyle = 'hood';
    const friendCode = deriveFriendCode(user.uid);

    await setDoc(pubRef, {
      uid: user.uid,
      displayName: defaultName,
      coatColor: defaultColor,
      scarfColor: defaultScarf,
      hatStyle: defaultHat,
      friendCode,
      level: 1,
      xp: 0,
      escapes: 0,
      gamesPlayed: 0,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });
    trackAiSharedClientOp({ writes: 1 });

    await ensureFriendCodeLookup(user.uid, friendCode);

    return {
      uid: user.uid,
      displayName: defaultName,
      coatColor: defaultColor,
      scarfColor: defaultScarf,
      hatStyle: defaultHat,
      friendCode,
      level: 1,
      xp: 0,
      escapes: 0,
      gamesPlayed: 0,
    };
  } catch (error) {
    trackAiSharedClientOp({ error: error instanceof Error ? error.message : String(error) });
    handleFirestoreError(error, OperationType.WRITE, publicPath);
    return {
      uid: user.uid,
      displayName: fallbackName,
      coatColor: COAT_COLORS[0].hex,
      scarfColor: SCARF_COLORS[0].hex,
      hatStyle: 'hood',
      friendCode: deriveFriendCode(user.uid),
      level: 1,
      xp: 0,
      escapes: 0,
      gamesPlayed: 0,
    };
  }
}

export async function updateSurvivorAccount(
  uid: string,
  updates: {
    displayName: string;
    coatColor: string;
    scarfColor: string;
    hatStyle: HatStyle;
  }
): Promise<SurvivorProfile> {
  if (useDefaultProxy()) {
    return authedApiFetch<SurvivorProfile>('/api/db/profile', {
      method: 'PATCH',
      body: JSON.stringify(updates),
    });
  }

  const path = `users/${uid}/public/profile`;
  const cleanName = sanitizeDisplayName(updates.displayName);
  const cleanCoat = sanitizeCoatColor(updates.coatColor);
  const cleanScarf = sanitizeScarfColor(updates.scarfColor);
  const cleanHat = sanitizeHatStyle(updates.hatStyle);

  try {
    const ref = doc(db, 'users', uid, 'public', 'profile');
    await updateDoc(ref, {
      displayName: cleanName,
      coatColor: cleanCoat,
      scarfColor: cleanScarf,
      hatStyle: cleanHat,
      updatedAt: serverTimestamp(),
    });
    const snap = await getDoc(ref);
    trackAiSharedClientOp({ writes: 1, reads: 1 });
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
  } catch (error) {
    trackAiSharedClientOp({ error: error instanceof Error ? error.message : String(error) });
    handleFirestoreError(error, OperationType.UPDATE, path);
    return {
      uid,
      displayName: cleanName,
      coatColor: cleanCoat,
      scarfColor: cleanScarf,
      hatStyle: cleanHat,
      friendCode: deriveFriendCode(uid),
      level: 1,
      xp: 0,
      escapes: 0,
      gamesPlayed: 0,
    };
  }
}

export async function recordMatchOutcome(
  uid: string,
  escaped: boolean,
  earnedXp: number
): Promise<{ level: number; xp: number; leveledUp: boolean; escapes: number; gamesPlayed: number } | null> {
  if (useDefaultProxy()) {
    try {
      return await authedApiFetch('/api/db/profile/outcome', {
        method: 'POST',
        body: JSON.stringify({ escaped, earnedXp }),
      });
    } catch {
      return null;
    }
  }

  const path = `users/${uid}/public/profile`;
  try {
    const ref = doc(db, 'users', uid, 'public', 'profile');
    const snap = await getDoc(ref);
    trackAiSharedClientOp({ reads: 1 });
    if (!snap.exists()) return null;
    const d = snap.data();
    const prevLevel = Math.max(1, Math.min(99, Number(d.level || 1)));
    const prevXp = Math.max(0, Number(d.xp || 0));
    const progressed = applyXpGain(prevLevel, prevXp, earnedXp);
    const nextXp = Math.min(1000000, progressed.xp);
    const nextEscapes = Math.min(100000, Number(d.escapes || 0) + (escaped ? 1 : 0));
    const nextGames = Math.min(100000, Number(d.gamesPlayed || 0) + 1);

    await updateDoc(ref, {
      level: progressed.level,
      xp: nextXp,
      escapes: nextEscapes,
      gamesPlayed: nextGames,
      updatedAt: serverTimestamp(),
    });
    trackAiSharedClientOp({ writes: 1 });

    return {
      ...progressed,
      xp: nextXp,
      escapes: nextEscapes,
      gamesPlayed: nextGames,
    };
  } catch (error) {
    trackAiSharedClientOp({ error: error instanceof Error ? error.message : String(error) });
    handleFirestoreError(error, OperationType.UPDATE, path);
    return null;
  }
}

// Friends & Friend Codes
export function subscribeFriends(
  uid: string,
  onFriends: (friends: FriendRecord[]) => void
): Unsubscribe {
  if (useDefaultProxy()) {
    let active = true;
    const load = async () => {
      if (!active || document.hidden) return;
      try {
        const res = await authedApiFetch<{ friends: FriendRecord[] }>('/api/db/friends');
        if (active) onFriends(res.friends || []);
      } catch {
        // ignore transient errors
      }
    };
    const refreshHandler = () => {
      void load();
    };
    friendsRefreshListeners.add(refreshHandler);
    void load();
    const id = window.setInterval(() => {
      void load();
    }, 4500);
    return () => {
      active = false;
      friendsRefreshListeners.delete(refreshHandler);
      clearInterval(id);
    };
  }

  const path = `users/${uid}/friends`;
  const q = query(collection(db, 'users', uid, 'friends'), where('ownerUid', '==', uid));
  return onSnapshot(
    q,
    (snap) => {
      trackAiSharedClientOp({ reads: Math.max(1, snap.size) });
      const list: FriendRecord[] = snap.docs.map((docSnap) => {
        const d = docSnap.data();
        return {
          ownerUid: String(d.ownerUid || uid),
          friendUid: String(d.friendUid || docSnap.id),
          displayName: String(d.displayName || 'Survivor'),
          coatColor: sanitizeCoatColor(String(d.coatColor || COAT_COLORS[0].hex)),
          scarfColor: sanitizeScarfColor(String(d.scarfColor || SCARF_COLORS[0].hex)),
          hatStyle: sanitizeHatStyle(String(d.hatStyle || 'hood')),
          friendCode: String(d.friendCode || ''),
          level: Math.max(1, Math.min(99, Number(d.level || 1))),
          status: (d.status as FriendStatus) || 'accepted',
        };
      });
      const order: Record<FriendStatus, number> = {
        pending_received: 0,
        accepted: 1,
        pending_sent: 2,
      };
      list.sort((a, b) => order[a.status] - order[b.status] || a.displayName.localeCompare(b.displayName));
      onFriends(list);
    },
    (error) => {
      trackAiSharedClientOp({ error: error.message });
      handleFirestoreError(error, OperationType.LIST, path);
    }
  );
}

export async function sendFriendRequestByUid(
  myProfile: SurvivorProfile,
  targetUid: string
): Promise<void> {
  if (useDefaultProxy()) {
    await authedApiFetch('/api/db/friends/request', {
      method: 'POST',
      body: JSON.stringify({ targetUid }),
    });
    triggerFriendsRefresh();
    return;
  }

  if (!targetUid || targetUid === myProfile.uid) {
    throw new Error('You cannot add yourself as a friend.');
  }

  const targetProfileSnap = await getDoc(doc(db, 'users', targetUid, 'public', 'profile'));
  trackAiSharedClientOp({ reads: 1 });
  if (!targetProfileSnap.exists()) {
    throw new Error('Survivor profile not found.');
  }
  const td = targetProfileSnap.data();
  const targetName = sanitizeDisplayName(String(td.displayName || 'Survivor'));
  const targetCoat = sanitizeCoatColor(String(td.coatColor || COAT_COLORS[0].hex));
  const targetScarf = sanitizeScarfColor(String(td.scarfColor || SCARF_COLORS[0].hex));
  const targetHat = sanitizeHatStyle(String(td.hatStyle || 'hood'));
  const targetCode = String(td.friendCode || deriveFriendCode(targetUid));
  const targetLevel = Math.max(1, Math.min(99, Number(td.level || 1)));

  const myFriendRef = doc(db, 'users', myProfile.uid, 'friends', targetUid);
  const myExisting = await getDoc(myFriendRef);
  trackAiSharedClientOp({ reads: 1 });
  if (myExisting.exists()) {
    const status = myExisting.data().status;
    if (status === 'accepted') throw new Error(`Already friends with ${targetName}.`);
    if (status === 'pending_sent') throw new Error(`Friend request already sent to ${targetName}.`);
    if (status === 'pending_received') {
      await acceptFriendRequest(myProfile, targetUid);
      return;
    }
  }

  try {
    await setDoc(myFriendRef, {
      ownerUid: myProfile.uid,
      friendUid: targetUid,
      displayName: targetName,
      coatColor: targetCoat,
      scarfColor: targetScarf,
      hatStyle: targetHat,
      friendCode: targetCode,
      level: targetLevel,
      status: 'pending_sent',
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });
    trackAiSharedClientOp({ writes: 1 });
  } catch (error) {
    trackAiSharedClientOp({ error: error instanceof Error ? error.message : String(error) });
    handleFirestoreError(error, OperationType.CREATE, `users/${myProfile.uid}/friends/${targetUid}`);
  }

  const theirFriendRef = doc(db, 'users', targetUid, 'friends', myProfile.uid);
  try {
    await setDoc(theirFriendRef, {
      ownerUid: targetUid,
      friendUid: myProfile.uid,
      displayName: sanitizeDisplayName(myProfile.displayName),
      coatColor: sanitizeCoatColor(myProfile.coatColor),
      scarfColor: sanitizeScarfColor(myProfile.scarfColor),
      hatStyle: sanitizeHatStyle(myProfile.hatStyle),
      friendCode: myProfile.friendCode,
      level: Math.max(1, Math.min(99, myProfile.level)),
      status: 'pending_received',
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });
    trackAiSharedClientOp({ writes: 1 });
  } catch (error) {
    trackAiSharedClientOp({ error: error instanceof Error ? error.message : String(error) });
    handleFirestoreError(error, OperationType.CREATE, `users/${targetUid}/friends/${myProfile.uid}`);
  }
}

export async function sendFriendRequestByCode(
  myProfile: SurvivorProfile,
  rawCode: string
): Promise<void> {
  if (useDefaultProxy()) {
    await authedApiFetch('/api/db/friends/request', {
      method: 'POST',
      body: JSON.stringify({ code: rawCode }),
    });
    triggerFriendsRefresh();
    return;
  }

  const code = rawCode.trim().toUpperCase();
  if (!/^[A-Z0-9_-]{4,16}$/.test(code)) {
    throw new Error('Enter a valid Friend Code (e.g. SV-XXXXXX).');
  }
  if (code === myProfile.friendCode) {
    throw new Error('That is your own Friend Code.');
  }

  const snap = await getDoc(doc(db, 'friendCodes', code));
  trackAiSharedClientOp({ reads: 1 });
  if (!snap.exists()) {
    throw new Error(`No survivor found with Friend Code "${code}".`);
  }
  const targetUid = String(snap.data().uid || '');
  await sendFriendRequestByUid(myProfile, targetUid);
}

export async function acceptFriendRequest(
  myProfile: SurvivorProfile,
  friendUid: string
): Promise<void> {
  if (useDefaultProxy()) {
    await authedApiFetch('/api/db/friends/accept', {
      method: 'POST',
      body: JSON.stringify({ friendUid }),
    });
    triggerFriendsRefresh();
    return;
  }

  const targetSnap = await getDoc(doc(db, 'users', friendUid, 'public', 'profile'));
  trackAiSharedClientOp({ reads: 1 });
  const td = targetSnap.data() || {};

  try {
    await updateDoc(doc(db, 'users', myProfile.uid, 'friends', friendUid), {
      status: 'accepted',
      displayName: sanitizeDisplayName(String(td.displayName || 'Survivor')),
      coatColor: sanitizeCoatColor(String(td.coatColor || COAT_COLORS[0].hex)),
      scarfColor: sanitizeScarfColor(String(td.scarfColor || SCARF_COLORS[0].hex)),
      hatStyle: sanitizeHatStyle(String(td.hatStyle || 'hood')),
      level: Math.max(1, Math.min(99, Number(td.level || 1))),
      updatedAt: serverTimestamp(),
    });
    trackAiSharedClientOp({ writes: 1 });
  } catch (error) {
    trackAiSharedClientOp({ error: error instanceof Error ? error.message : String(error) });
    handleFirestoreError(error, OperationType.UPDATE, `users/${myProfile.uid}/friends/${friendUid}`);
  }

  try {
    const theirRef = doc(db, 'users', friendUid, 'friends', myProfile.uid);
    await updateDoc(theirRef, {
      status: 'accepted',
      displayName: sanitizeDisplayName(myProfile.displayName),
      coatColor: sanitizeCoatColor(myProfile.coatColor),
      scarfColor: sanitizeScarfColor(myProfile.scarfColor),
      hatStyle: sanitizeHatStyle(myProfile.hatStyle),
      level: Math.max(1, Math.min(99, myProfile.level)),
      updatedAt: serverTimestamp(),
    });
    trackAiSharedClientOp({ writes: 1 });
  } catch {
    // Ignore if requester canceled simultaneously
  }
}

export async function removeOrDeclineFriend(myUid: string, friendUid: string): Promise<void> {
  if (useDefaultProxy()) {
    await authedApiFetch(`/api/db/friends/${encodeURIComponent(friendUid)}`, {
      method: 'DELETE',
    }).catch(() => {});
    triggerFriendsRefresh();
    return;
  }

  try {
    await deleteDoc(doc(db, 'users', myUid, 'friends', friendUid));
    trackAiSharedClientOp({ deletes: 1 });
  } catch {
    // ignore
  }
  try {
    await deleteDoc(doc(db, 'users', friendUid, 'friends', myUid));
    trackAiSharedClientOp({ deletes: 1 });
  } catch {
    // ignore
  }
}

// Global Lobby Chat
export function subscribeGlobalChat(
  onMessages: (msgs: ChatMessageData[]) => void
): Unsubscribe {
  if (useDefaultProxy()) {
    let active = true;
    const load = async () => {
      if (!active || document.hidden) return;
      try {
        const res = await authedApiFetch<{ messages: ChatMessageData[] }>('/api/db/global-chat');
        if (active) onMessages(res.messages || []);
      } catch {
        // ignore transient error
      }
    };
    const refreshHandler = () => {
      void load();
    };
    globalChatRefreshListeners.add(refreshHandler);
    void load();
    const id = window.setInterval(() => {
      void load();
    }, 2800);
    return () => {
      active = false;
      globalChatRefreshListeners.delete(refreshHandler);
      clearInterval(id);
    };
  }

  const path = 'globalChat';
  const q = query(collection(db, path), where('channel', '==', 'global'), limit(60));
  return onSnapshot(
    q,
    (snap) => {
      trackAiSharedClientOp({ reads: Math.max(1, snap.size) });
      const oneHourAgo = Date.now() - 3600000;
      const msgs: ChatMessageData[] = snap.docs
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
        .filter((m) => m.createdAtMs >= oneHourAgo);
      msgs.sort((a, b) => a.createdAtMs - b.createdAtMs);
      onMessages(msgs.slice(-40));
    },
    (error) => {
      trackAiSharedClientOp({ error: error.message });
      handleFirestoreError(error, OperationType.LIST, path);
    }
  );
}

export async function clearGlobalChat(): Promise<void> {
  if (useDefaultProxy()) {
    await authedApiFetch('/api/db/global-chat', { method: 'DELETE' }).catch(() => {});
    triggerGlobalChatRefresh();
    return;
  }

  try {
    const q = query(collection(db, 'globalChat'), where('channel', '==', 'global'));
    const snap = await getDocs(q);
    trackAiSharedClientOp({ reads: Math.max(1, snap.size), deletes: snap.size });
    await Promise.allSettled(snap.docs.map((d) => deleteDoc(d.ref)));
  } catch {
    // ignore
  }
}

export async function sendGlobalChatMessage(
  profile: SurvivorProfile,
  rawText: string
): Promise<void> {
  const text = sanitizeChatText(rawText);
  if (!text) return;

  if (useDefaultProxy()) {
    await authedApiFetch('/api/db/global-chat', {
      method: 'POST',
      body: JSON.stringify({
        displayName: profile.displayName,
        coatColor: profile.coatColor,
        text,
      }),
    });
    triggerGlobalChatRefresh();
    return;
  }

  const msgId = generateMessageId();
  const path = `globalChat/${msgId}`;
  try {
    await setDoc(doc(db, 'globalChat', msgId), {
      senderId: profile.uid,
      senderName: sanitizeDisplayName(profile.displayName),
      coatColor: sanitizeCoatColor(profile.coatColor),
      channel: 'global',
      text,
      createdAt: serverTimestamp(),
    });
    trackAiSharedClientOp({ writes: 1 });
  } catch (error) {
    trackAiSharedClientOp({ error: error instanceof Error ? error.message : String(error) });
    handleFirestoreError(error, OperationType.CREATE, path);
  }
}

// Public Rooms List
export function subscribePublicRooms(
  onRooms: (rooms: GameRoomData[]) => void
): Unsubscribe {
  if (useDefaultProxy()) {
    let active = true;
    const load = async () => {
      if (!active || document.hidden) return;
      try {
        const res = await authedApiFetch<{ rooms: GameRoomData[] }>('/api/db/rooms/public');
        if (active) onRooms(res.rooms || []);
      } catch {
        // ignore transient error
      }
    };
    const refreshHandler = () => {
      void load();
    };
    publicRoomsRefreshListeners.add(refreshHandler);
    void load();
    const id = window.setInterval(() => {
      void load();
    }, 3000);
    return () => {
      active = false;
      publicRoomsRefreshListeners.delete(refreshHandler);
      clearInterval(id);
    };
  }

  const path = 'rooms';
  const q = query(collection(db, path), where('isPublic', '==', true), limit(30));
  return onSnapshot(
    q,
    (snap) => {
      trackAiSharedClientOp({ reads: Math.max(1, snap.size) });
      const list: GameRoomData[] = snap.docs
        .map((docSnap) => {
          const d = docSnap.data();
          return {
            roomId: docSnap.id,
            name: String(d.name || 'North Pole Room'),
            hostId: String(d.hostId || ''),
            hostName: String(d.hostName || 'Host'),
            difficulty:
              d.difficulty === 'nightmare'
                ? ('nightmare' as DifficultyId)
                : d.difficulty === 'insane'
                  ? ('insane' as DifficultyId)
                  : ('normal' as DifficultyId),
            level: Math.max(1, Math.min(99, Number(d.level || 1))),
            mazeSeed: Number(d.mazeSeed || 1),
            status: (d.status as GameRoomData['status']) || 'waiting',
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
        })
        .filter((r) => r.status !== 'finished' && r.playerCount > 0 && Date.now() - (r.updatedAtMs || 0) < 180000);
      list.sort((a, b) => (b.updatedAtMs || 0) - (a.updatedAtMs || 0));
      onRooms(list);
    },
    (error) => {
      trackAiSharedClientOp({ error: error.message });
      handleFirestoreError(error, OperationType.LIST, path);
    }
  );
}

export async function createMultiplayerRoom(
  profile: SurvivorProfile,
  roomName: string,
  difficulty: DifficultyId,
  level: number,
  isPublic = true
): Promise<GameRoomData> {
  const roomId = generateRoomId();
  const cleanName = roomName.trim().slice(0, 40) || `${profile.displayName}'s Maze`;
  const finalName = cleanName.length >= 2 ? cleanName : 'North Pole Room';
  const cleanLevel = Math.max(1, Math.min(99, Math.floor(level || 1)));
  const mazeSeed = Math.floor(100000 + Math.random() * 899999);
  const scaling = getLevelScaling(cleanLevel, difficulty);
  const ornamentsTotal = scaling.ornamentCount;
  const spawnW = cellToWorld(1, 1, scaling.mazeSize, CELL_SIZE);

  const initialMaze = generateMaze(
    scaling.ornamentCount,
    mazeSeed,
    scaling.mazeSize,
    scaling.batteryCount,
    scaling.santaCount
  );
  const santaSpawnWorld = cellToWorld(
    initialMaze.santaSpawn.r,
    initialMaze.santaSpawn.c,
    scaling.mazeSize,
    CELL_SIZE
  );
  const extraSantaWorlds = initialMaze.santaSpawns.slice(1, 3).map((coord) => {
    const pos = cellToWorld(coord.r, coord.c, scaling.mazeSize, CELL_SIZE);
    return {
      x: Number(pos.x.toFixed(2)),
      z: Number(pos.z.toFixed(2)),
      yaw: 0,
      speed: 0,
      alerted: false,
      stunRemaining: 0,
    };
  });

  if (useDefaultProxy()) {
    const room = await authedApiFetch<GameRoomData>('/api/db/rooms', {
      method: 'POST',
      body: JSON.stringify({
        roomId,
        name: finalName,
        hostName: profile.displayName,
        coatColor: profile.coatColor,
        scarfColor: profile.scarfColor,
        hatStyle: profile.hatStyle,
        difficulty,
        level: cleanLevel,
        mazeSeed,
        ornamentsTotal,
        isPublic,
        spawnX: spawnW.x,
        spawnZ: spawnW.z,
        santaState: {
          x: santaSpawnWorld.x,
          z: santaSpawnWorld.z,
          extras: extraSantaWorlds,
        },
      }),
    });
    triggerPublicRoomsRefresh();
    return room;
  }

  const roomPath = `rooms/${roomId}`;
  const playerPath = `rooms/${roomId}/players/${profile.uid}`;
  const santaPath = `rooms/${roomId}/santa/live`;

  try {
    await setDoc(doc(db, 'rooms', roomId), {
      roomId,
      name: finalName,
      hostId: profile.uid,
      hostName: sanitizeDisplayName(profile.displayName),
      difficulty,
      level: cleanLevel,
      mazeSeed,
      status: 'waiting',
      collectedOrnaments: [],
      collectedWeapons: [],
      collectedBatteries: [],
      triggeredTraps: [],
      weaponWave: 0,
      santaStunNonce: 0,
      ornamentsTotal,
      exitUnlocked: false,
      isPublic,
      playerCount: 1,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });
    trackAiSharedClientOp({ writes: 1 });
  } catch (error) {
    trackAiSharedClientOp({ error: error instanceof Error ? error.message : String(error) });
    handleFirestoreError(error, OperationType.CREATE, roomPath);
  }

  try {
    await setDoc(doc(db, 'rooms', roomId, 'players', profile.uid), {
      uid: profile.uid,
      roomId,
      displayName: sanitizeDisplayName(profile.displayName),
      coatColor: sanitizeCoatColor(profile.coatColor),
      scarfColor: sanitizeScarfColor(profile.scarfColor),
      hatStyle: sanitizeHatStyle(profile.hatStyle),
      x: Number(spawnW.x.toFixed(2)),
      z: Number(spawnW.z.toFixed(2)),
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
      updatedAt: serverTimestamp(),
    });
    trackAiSharedClientOp({ writes: 1 });
  } catch (error) {
    trackAiSharedClientOp({ error: error instanceof Error ? error.message : String(error) });
    handleFirestoreError(error, OperationType.CREATE, playerPath);
  }

  try {
    await setDoc(doc(db, 'rooms', roomId, 'santa', 'live'), {
      x: Number(santaSpawnWorld.x.toFixed(2)),
      z: Number(santaSpawnWorld.z.toFixed(2)),
      yaw: 0,
      speed: 0,
      alerted: false,
      stunRemaining: 0,
      extras: extraSantaWorlds,
      updatedAt: serverTimestamp(),
    });
    trackAiSharedClientOp({ writes: 1 });
  } catch (error) {
    trackAiSharedClientOp({ error: error instanceof Error ? error.message : String(error) });
    handleFirestoreError(error, OperationType.CREATE, santaPath);
  }

  return {
    roomId,
    name: finalName,
    hostId: profile.uid,
    hostName: sanitizeDisplayName(profile.displayName),
    difficulty,
    level: cleanLevel,
    mazeSeed,
    status: 'waiting',
    collectedOrnaments: [],
    collectedWeapons: [],
    collectedBatteries: [],
    triggeredTraps: [],
    weaponWave: 0,
    santaStunNonce: 0,
    ornamentsTotal,
    exitUnlocked: false,
    isPublic,
    playerCount: 1,
  };
}

export async function joinMultiplayerRoom(
  profile: SurvivorProfile,
  rawRoomId: string
): Promise<GameRoomData> {
  const roomId = rawRoomId.trim().toUpperCase();
  if (!/^[a-zA-Z0-9_\-]{4,32}$/.test(roomId)) {
    throw new Error('Invalid room code format.');
  }

  if (useDefaultProxy()) {
    const defaultScaling = getLevelScaling(1, 'normal');
    const spawnW = cellToWorld(1, 1, defaultScaling.mazeSize, CELL_SIZE);
    return authedApiFetch<GameRoomData>(`/api/db/rooms/${encodeURIComponent(roomId)}/join`, {
      method: 'POST',
      body: JSON.stringify({
        displayName: profile.displayName,
        coatColor: profile.coatColor,
        scarfColor: profile.scarfColor,
        hatStyle: profile.hatStyle,
        spawnX: spawnW.x,
        spawnZ: spawnW.z,
      }),
    });
  }

  const roomPath = `rooms/${roomId}`;
  try {
    const roomRef = doc(db, 'rooms', roomId);
    const snap = await getDoc(roomRef);
    trackAiSharedClientOp({ reads: 1 });
    if (!snap.exists()) {
      throw new Error(`Room "${roomId}" was not found.`);
    }
    const d = snap.data();
    if (d.status === 'finished') {
      throw new Error(`Room "${roomId}" has already ended.`);
    }

    const level = Math.max(1, Math.min(99, Number(d.level || 1)));
    const difficulty: DifficultyId = d.difficulty === 'nightmare' ? 'nightmare' : d.difficulty === 'insane' ? 'insane' : 'normal';
    const scaling = getLevelScaling(level, difficulty);
    const spawnW = cellToWorld(1, 1, scaling.mazeSize, CELL_SIZE);

    const playerRef = doc(db, 'rooms', roomId, 'players', profile.uid);
    const existingPlayer = await getDoc(playerRef);
    trackAiSharedClientOp({ reads: 1 });

    const prevPlayer = existingPlayer.exists() ? existingPlayer.data() : null;
    await setDoc(playerRef, {
      uid: profile.uid,
      roomId,
      displayName: sanitizeDisplayName(profile.displayName),
      coatColor: sanitizeCoatColor(profile.coatColor),
      scarfColor: sanitizeScarfColor(profile.scarfColor),
      hatStyle: sanitizeHatStyle(profile.hatStyle),
      x: Number(spawnW.x.toFixed(2)),
      z: Number(spawnW.z.toFixed(2)),
      yaw: 0,
      flashlightOn: true,
      alive: true,
      escaped: false,
      stunned: false,
      equippedWeapon: '',
      shotCount: 0,
      lastShotHit: false,
      reviveCount: prevPlayer ? Number(prevPlayer.reviveCount || 0) : 0,
      revivedBy: prevPlayer ? String(prevPlayer.revivedBy || '').slice(0, 24) : '',
      updatedAt: serverTimestamp(),
    });
    trackAiSharedClientOp({ writes: 1 });

    if (!existingPlayer.exists()) {
      await updateDoc(roomRef, {
        playerCount: Math.min(12, Number(d.playerCount || 0) + 1),
        updatedAt: serverTimestamp(),
      });
      trackAiSharedClientOp({ writes: 1 });
    }

    return {
      roomId,
      name: String(d.name || 'North Pole Room'),
      hostId: String(d.hostId || ''),
      hostName: String(d.hostName || 'Host'),
      difficulty,
      level,
      mazeSeed: Number(d.mazeSeed || 1),
      status: (d.status as GameRoomData['status']) || 'waiting',
      collectedOrnaments: Array.isArray(d.collectedOrnaments) ? d.collectedOrnaments.map(Number) : [],
      collectedWeapons: Array.isArray(d.collectedWeapons) ? d.collectedWeapons.map(Number) : [],
      collectedBatteries: Array.isArray(d.collectedBatteries) ? d.collectedBatteries.map(Number) : [],
      triggeredTraps: Array.isArray(d.triggeredTraps) ? d.triggeredTraps.map(Number) : [],
      weaponWave: Math.max(0, Math.min(99, Number(d.weaponWave || 0))),
      santaStunNonce: Number(d.santaStunNonce || 0),
      ornamentsTotal: Number(d.ornamentsTotal || 5),
      exitUnlocked: Boolean(d.exitUnlocked),
      isPublic: Boolean(d.isPublic),
      playerCount: Number(d.playerCount || 1) + (existingPlayer.exists() ? 0 : 1),
    };
  } catch (error) {
    if (
      error instanceof Error &&
      (error.message.includes('was not found') ||
        error.message.includes('already ended') ||
        error.message.includes('Invalid room'))
    ) {
      throw error;
    }
    trackAiSharedClientOp({ error: error instanceof Error ? error.message : String(error) });
    handleFirestoreError(error, OperationType.WRITE, roomPath);
    const message = error instanceof Error ? error.message : 'Unable to join room.';
    throw new Error(message);
  }
}

export async function leaveMultiplayerRoom(roomId: string, uid: string): Promise<void> {
  if (useDefaultProxy()) {
    await authedApiFetch(`/api/db/rooms/${encodeURIComponent(roomId)}/leave`, {
      method: 'POST',
    }).catch(() => {});
    triggerPublicRoomsRefresh();
    return;
  }

  const roomRef = doc(db, 'rooms', roomId);
  const playerRef = doc(db, 'rooms', roomId, 'players', uid);
  try {
    const playersBeforeSnap = await getDocs(collection(db, 'rooms', roomId, 'players'));
    trackAiSharedClientOp({ reads: Math.max(1, playersBeforeSnap.size) });
    const remainingBefore = playersBeforeSnap.docs.filter((d) => d.id !== uid);
    if (remainingBefore.length === 0) {
      await deleteDoc(roomRef);
      await deleteDoc(playerRef);
      trackAiSharedClientOp({ deletes: 2 });
      return;
    }

    await deleteDoc(playerRef);
    const snap = await getDoc(roomRef);
    trackAiSharedClientOp({ deletes: 1, reads: 1 });
    if (snap.exists()) {
      const d = snap.data();
      const nextCount = remainingBefore.length;
      if (d.hostId === uid) {
        const nextHostDoc = remainingBefore[0];
        const hd = nextHostDoc.data();
        await updateDoc(roomRef, {
          hostId: nextHostDoc.id,
          hostName: sanitizeDisplayName(String(hd.displayName || 'Survivor')),
          playerCount: nextCount,
          updatedAt: serverTimestamp(),
        });
      } else {
        await updateDoc(roomRef, {
          playerCount: nextCount,
          updatedAt: serverTimestamp(),
        });
      }
      trackAiSharedClientOp({ writes: 1 });
    }
  } catch {
    // Ignore cleanup race if room already deleted
  }
}

export async function claimRoomHost(roomId: string, profile: SurvivorProfile): Promise<boolean> {
  if (useDefaultProxy()) {
    try {
      const res = await authedApiFetch<{ claimed: boolean }>(
        `/api/db/rooms/${encodeURIComponent(roomId)}/claim-host`,
        {
          method: 'POST',
          body: JSON.stringify({ displayName: profile.displayName }),
        }
      );
      return Boolean(res.claimed);
    } catch {
      return false;
    }
  }

  try {
    const roomRef = doc(db, 'rooms', roomId);
    const snap = await getDoc(roomRef);
    trackAiSharedClientOp({ reads: 1 });
    if (!snap.exists()) return false;
    const d = snap.data();
    if (d.status === 'finished' || d.hostId === profile.uid) return d.hostId === profile.uid;
    const oldHostPlayerSnap = await getDoc(doc(db, 'rooms', roomId, 'players', String(d.hostId || '')));
    trackAiSharedClientOp({ reads: 1 });
    if (oldHostPlayerSnap.exists()) return false;
    await updateDoc(roomRef, {
      hostId: profile.uid,
      hostName: sanitizeDisplayName(profile.displayName),
      playerCount: Math.max(1, Number(d.playerCount || 1)),
      updatedAt: serverTimestamp(),
    });
    trackAiSharedClientOp({ writes: 1 });
    return true;
  } catch {
    return false;
  }
}

export async function startMultiplayerRoom(roomId: string): Promise<void> {
  if (useDefaultProxy()) {
    await authedApiFetch(`/api/db/rooms/${encodeURIComponent(roomId)}/start`, {
      method: 'POST',
    });
    return;
  }

  const path = `rooms/${roomId}`;
  try {
    await updateDoc(doc(db, 'rooms', roomId), {
      status: 'playing',
      updatedAt: serverTimestamp(),
    });
    trackAiSharedClientOp({ writes: 1 });
  } catch (error) {
    trackAiSharedClientOp({ error: error instanceof Error ? error.message : String(error) });
    handleFirestoreError(error, OperationType.UPDATE, path);
  }
}

export async function finishMultiplayerRoom(roomId: string): Promise<void> {
  if (useDefaultProxy()) {
    await authedApiFetch(`/api/db/rooms/${encodeURIComponent(roomId)}`, {
      method: 'DELETE',
    }).catch(() => {});
    return;
  }

  try {
    await deleteDoc(doc(db, 'rooms', roomId));
    trackAiSharedClientOp({ deletes: 1 });
  } catch {
    // ignore if already deleted
  }
}

export async function collectRoomOrnament(
  roomId: string,
  ornamentId: number,
  ornamentsTotal: number
): Promise<void> {
  if (useDefaultProxy()) {
    await authedApiFetch(`/api/db/rooms/${encodeURIComponent(roomId)}/action`, {
      method: 'POST',
      body: JSON.stringify({ type: 'ornament', ornamentId, ornamentsTotal }),
    }).catch(() => {});
    return;
  }

  const path = `rooms/${roomId}`;
  try {
    const roomRef = doc(db, 'rooms', roomId);
    await runTransaction(db, async (tx) => {
      const snap = await tx.get(roomRef);
      if (!snap.exists()) return;
      const d = snap.data();
      if (d.status === 'finished') return;
      const current: number[] = Array.isArray(d.collectedOrnaments) ? d.collectedOrnaments.map(Number) : [];
      if (current.includes(ornamentId)) return;
      const next = [...current, ornamentId].slice(0, 18);
      tx.update(roomRef, {
        collectedOrnaments: next,
        exitUnlocked: next.length >= ornamentsTotal,
        updatedAt: serverTimestamp(),
      });
    });
    trackAiSharedClientOp({ reads: 1, writes: 1 });
  } catch (error) {
    trackAiSharedClientOp({ error: error instanceof Error ? error.message : String(error) });
    handleFirestoreError(error, OperationType.UPDATE, path);
  }
}

export async function collectRoomWeapon(roomId: string, weaponId: number): Promise<void> {
  if (useDefaultProxy()) {
    await authedApiFetch(`/api/db/rooms/${encodeURIComponent(roomId)}/action`, {
      method: 'POST',
      body: JSON.stringify({ type: 'weapon', itemId: weaponId }),
    }).catch(() => {});
    return;
  }

  const path = `rooms/${roomId}`;
  try {
    const roomRef = doc(db, 'rooms', roomId);
    await runTransaction(db, async (tx) => {
      const snap = await tx.get(roomRef);
      if (!snap.exists()) return;
      const d = snap.data();
      if (d.status === 'finished') return;
      const current: number[] = Array.isArray(d.collectedWeapons) ? d.collectedWeapons.map(Number) : [];
      if (current.includes(weaponId)) return;
      const next = [...current, weaponId].slice(-40);
      tx.update(roomRef, {
        collectedWeapons: next,
        updatedAt: serverTimestamp(),
      });
    });
    trackAiSharedClientOp({ reads: 1, writes: 1 });
  } catch (error) {
    trackAiSharedClientOp({ error: error instanceof Error ? error.message : String(error) });
    handleFirestoreError(error, OperationType.UPDATE, path);
  }
}

export async function collectRoomBattery(roomId: string, batteryId: number): Promise<void> {
  if (useDefaultProxy()) {
    await authedApiFetch(`/api/db/rooms/${encodeURIComponent(roomId)}/action`, {
      method: 'POST',
      body: JSON.stringify({ type: 'battery', itemId: batteryId }),
    }).catch(() => {});
    return;
  }

  const path = `rooms/${roomId}`;
  try {
    const roomRef = doc(db, 'rooms', roomId);
    await runTransaction(db, async (tx) => {
      const snap = await tx.get(roomRef);
      if (!snap.exists()) return;
      const d = snap.data();
      if (d.status === 'finished') return;
      const current: number[] = Array.isArray(d.collectedBatteries) ? d.collectedBatteries.map(Number) : [];
      if (current.includes(batteryId)) return;
      const next = [...current, batteryId].slice(-30);
      tx.update(roomRef, {
        collectedBatteries: next,
        updatedAt: serverTimestamp(),
      });
    });
    trackAiSharedClientOp({ reads: 1, writes: 1 });
  } catch (error) {
    trackAiSharedClientOp({ error: error instanceof Error ? error.message : String(error) });
    handleFirestoreError(error, OperationType.UPDATE, path);
  }
}

export async function triggerRoomTrap(roomId: string, trapId: number): Promise<void> {
  if (useDefaultProxy()) {
    await authedApiFetch(`/api/db/rooms/${encodeURIComponent(roomId)}/action`, {
      method: 'POST',
      body: JSON.stringify({ type: 'trap', itemId: trapId }),
    }).catch(() => {});
    return;
  }

  const path = `rooms/${roomId}`;
  try {
    const roomRef = doc(db, 'rooms', roomId);
    await runTransaction(db, async (tx) => {
      const snap = await tx.get(roomRef);
      if (!snap.exists()) return;
      const d = snap.data();
      if (d.status === 'finished') return;
      const current: number[] = Array.isArray(d.triggeredTraps) ? d.triggeredTraps.map(Number) : [];
      if (current.includes(trapId)) return;
      const next = [...current, trapId].slice(0, 20);
      tx.update(roomRef, {
        triggeredTraps: next,
        updatedAt: serverTimestamp(),
      });
    });
    trackAiSharedClientOp({ reads: 1, writes: 1 });
  } catch (error) {
    trackAiSharedClientOp({ error: error instanceof Error ? error.message : String(error) });
    handleFirestoreError(error, OperationType.UPDATE, path);
  }
}

export async function advanceRoomWeaponWave(roomId: string, wave: number): Promise<void> {
  if (useDefaultProxy()) {
    await authedApiFetch(`/api/db/rooms/${encodeURIComponent(roomId)}/action`, {
      method: 'POST',
      body: JSON.stringify({ type: 'wave', wave }),
    }).catch(() => {});
    return;
  }

  const cleanWave = Math.max(0, Math.min(99, Math.floor(wave)));
  try {
    await updateDoc(doc(db, 'rooms', roomId), {
      weaponWave: cleanWave,
      updatedAt: serverTimestamp(),
    });
    trackAiSharedClientOp({ writes: 1 });
  } catch {
    // Non-fatal if room finished
  }
}

export async function triggerRoomSantaStun(roomId: string): Promise<void> {
  if (useDefaultProxy()) {
    await authedApiFetch(`/api/db/rooms/${encodeURIComponent(roomId)}/action`, {
      method: 'POST',
      body: JSON.stringify({ type: 'stun' }),
    }).catch(() => {});
    return;
  }

  const path = `rooms/${roomId}`;
  try {
    const roomRef = doc(db, 'rooms', roomId);
    await runTransaction(db, async (tx) => {
      const snap = await tx.get(roomRef);
      if (!snap.exists()) return;
      const d = snap.data();
      if (d.status === 'finished') return;
      const nextNonce = Math.min(10000, Number(d.santaStunNonce || 0) + 1);
      tx.update(roomRef, {
        santaStunNonce: nextNonce,
        updatedAt: serverTimestamp(),
      });
    });
    trackAiSharedClientOp({ reads: 1, writes: 1 });
  } catch (error) {
    trackAiSharedClientOp({ error: error instanceof Error ? error.message : String(error) });
    handleFirestoreError(error, OperationType.UPDATE, path);
  }
}

export async function syncLocalPlayerState(
  roomId: string,
  profile: SurvivorProfile,
  state: {
    x: number;
    z: number;
    yaw: number;
    flashlightOn: boolean;
    alive: boolean;
    escaped: boolean;
    stunned: boolean;
    equippedWeapon: WeaponType | '';
    shotCount: number;
    lastShotHit: boolean;
  }
): Promise<void> {
  if (useDefaultProxy()) {
    await authedApiFetch(`/api/db/rooms/${encodeURIComponent(roomId)}/player`, {
      method: 'PUT',
      body: JSON.stringify({
        displayName: profile.displayName,
        coatColor: profile.coatColor,
        scarfColor: profile.scarfColor,
        hatStyle: profile.hatStyle,
        ...state,
      }),
    }).catch(() => {});
    return;
  }

  try {
    await updateDoc(doc(db, 'rooms', roomId, 'players', profile.uid), {
      displayName: sanitizeDisplayName(profile.displayName),
      coatColor: sanitizeCoatColor(profile.coatColor),
      scarfColor: sanitizeScarfColor(profile.scarfColor),
      hatStyle: sanitizeHatStyle(profile.hatStyle),
      x: Number(state.x.toFixed(2)),
      z: Number(state.z.toFixed(2)),
      yaw: Number(state.yaw.toFixed(3)),
      flashlightOn: state.flashlightOn,
      alive: state.alive,
      escaped: state.escaped,
      stunned: state.stunned,
      equippedWeapon: sanitizeEquippedWeapon(state.equippedWeapon),
      shotCount: Math.max(0, Math.min(10000, Math.floor(state.shotCount || 0))),
      lastShotHit: Boolean(state.lastShotHit),
      updatedAt: serverTimestamp(),
    });
    trackAiSharedClientOp({ writes: 1 });
  } catch {
    // Silent on transient tick sync if player left or room closed
  }
}

export async function reviveRoomPlayer(
  roomId: string,
  targetUid: string,
  reviverName: string
): Promise<boolean> {
  if (useDefaultProxy()) {
    try {
      const res = await authedApiFetch<{ revived: boolean }>(
        `/api/db/rooms/${encodeURIComponent(roomId)}/action`,
        {
          method: 'POST',
          body: JSON.stringify({ type: 'revive', targetUid, reviverName }),
        }
      );
      return Boolean(res.revived);
    } catch {
      return false;
    }
  }

  const targetRef = doc(db, 'rooms', roomId, 'players', targetUid);
  try {
    let revived = false;
    await runTransaction(db, async (tx) => {
      const snap = await tx.get(targetRef);
      if (!snap.exists()) return;
      const d = snap.data();
      if (d.alive !== false || Boolean(d.escaped)) return;
      const nextCount = Math.min(1000, Number(d.reviveCount || 0) + 1);
      tx.update(targetRef, {
        alive: true,
        reviveCount: nextCount,
        revivedBy: sanitizeDisplayName(reviverName),
        updatedAt: serverTimestamp(),
      });
      revived = true;
    });
    trackAiSharedClientOp({ reads: 1, writes: revived ? 1 : 0 });
    return revived;
  } catch {
    return false;
  }
}

export async function syncHostSantaState(
  roomId: string,
  state: SantaLiveData
): Promise<void> {
  if (useDefaultProxy()) {
    await authedApiFetch(`/api/db/rooms/${encodeURIComponent(roomId)}/santa`, {
      method: 'PUT',
      body: JSON.stringify(state),
    }).catch(() => {});
    return;
  }

  try {
    const cleanExtras = Array.isArray(state.extras)
      ? state.extras.slice(0, 2).map((e) => ({
          x: Number(Math.max(-260, Math.min(260, e.x)).toFixed(2)),
          z: Number(Math.max(-260, Math.min(260, e.z)).toFixed(2)),
          yaw: Number(e.yaw.toFixed(3)),
          speed: Number(Math.max(0, Math.min(25, e.speed)).toFixed(2)),
          alerted: Boolean(e.alerted),
          stunRemaining: Number(Math.max(0, Math.min(35, e.stunRemaining)).toFixed(1)),
        }))
      : [];
    await updateDoc(doc(db, 'rooms', roomId, 'santa', 'live'), {
      x: Number(Math.max(-260, Math.min(260, state.x)).toFixed(2)),
      z: Number(Math.max(-260, Math.min(260, state.z)).toFixed(2)),
      yaw: Number(state.yaw.toFixed(3)),
      speed: Number(Math.max(0, Math.min(25, state.speed)).toFixed(2)),
      alerted: state.alerted,
      stunRemaining: Number(Math.max(0, Math.min(35, state.stunRemaining)).toFixed(1)),
      extras: cleanExtras,
      updatedAt: serverTimestamp(),
    });
    trackAiSharedClientOp({ writes: 1 });
  } catch {
    // Silent on transient tick sync
  }
}

export function subscribeRoom(
  roomId: string,
  onRoom: (room: GameRoomData | null) => void
): Unsubscribe {
  if (useDefaultProxy()) {
    const hub = getOrStartRoomHub(roomId);
    hub.roomCbs.add(onRoom);
    return () => {
      hub.roomCbs.delete(onRoom);
      cleanupRoomHubIfEmpty(roomId);
    };
  }

  const path = `rooms/${roomId}`;
  return onSnapshot(
    doc(db, 'rooms', roomId),
    (snap) => {
      trackAiSharedClientOp({ reads: 1 });
      if (!snap.exists()) {
        onRoom(null);
        return;
      }
      const d = snap.data();
      onRoom({
        roomId: snap.id,
        name: String(d.name || 'North Pole Room'),
        hostId: String(d.hostId || ''),
        hostName: String(d.hostName || 'Host'),
        difficulty: d.difficulty === 'nightmare' ? 'nightmare' : d.difficulty === 'insane' ? 'insane' : 'normal',
        level: Math.max(1, Math.min(99, Number(d.level || 1))),
        mazeSeed: Number(d.mazeSeed || 1),
        status: (d.status as GameRoomData['status']) || 'waiting',
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
      });
    },
    (error) => {
      trackAiSharedClientOp({ error: error.message });
      handleFirestoreError(error, OperationType.GET, path);
    }
  );
}

export function subscribeRoomPlayers(
  roomId: string,
  onPlayers: (players: RoomPlayerData[]) => void
): Unsubscribe {
  if (useDefaultProxy()) {
    const hub = getOrStartRoomHub(roomId);
    hub.playerCbs.add(onPlayers);
    return () => {
      hub.playerCbs.delete(onPlayers);
      cleanupRoomHubIfEmpty(roomId);
    };
  }

  const path = `rooms/${roomId}/players`;
  const q = query(collection(db, 'rooms', roomId, 'players'), where('roomId', '==', roomId));
  return onSnapshot(
    q,
    (snap) => {
      trackAiSharedClientOp({ reads: Math.max(1, snap.size) });
      const list: RoomPlayerData[] = snap.docs.map((docSnap) => {
        const d = docSnap.data();
        return {
          uid: String(d.uid || docSnap.id),
          roomId: String(d.roomId || roomId),
          displayName: String(d.displayName || 'Survivor'),
          coatColor: sanitizeCoatColor(String(d.coatColor || '#3b82f6')),
          scarfColor: sanitizeScarfColor(String(d.scarfColor || SCARF_COLORS[0].hex)),
          hatStyle: sanitizeHatStyle(String(d.hatStyle || 'hood')),
          x: Number(d.x || 0),
          z: Number(d.z || 0),
          yaw: Number(d.yaw || 0),
          flashlightOn: Boolean(d.flashlightOn),
          alive: d.alive !== false,
          escaped: Boolean(d.escaped),
          stunned: Boolean(d.stunned),
          equippedWeapon: sanitizeEquippedWeapon(d.equippedWeapon),
          shotCount: Number(d.shotCount || 0),
          lastShotHit: Boolean(d.lastShotHit),
          reviveCount: Number(d.reviveCount || 0),
          revivedBy: String(d.revivedBy || ''),
        };
      });
      onPlayers(list);
    },
    (error) => {
      trackAiSharedClientOp({ error: error.message });
      handleFirestoreError(error, OperationType.LIST, path);
    }
  );
}

export function subscribeRoomSanta(
  roomId: string,
  onSanta: (santa: SantaLiveData) => void
): Unsubscribe {
  if (useDefaultProxy()) {
    const hub = getOrStartRoomHub(roomId);
    hub.santaCbs.add(onSanta);
    return () => {
      hub.santaCbs.delete(onSanta);
      cleanupRoomHubIfEmpty(roomId);
    };
  }

  const path = `rooms/${roomId}/santa/live`;
  return onSnapshot(
    doc(db, 'rooms', roomId, 'santa', 'live'),
    (snap) => {
      trackAiSharedClientOp({ reads: 1 });
      if (!snap.exists()) return;
      const d = snap.data();
      const rawExtras = Array.isArray(d.extras) ? d.extras.slice(0, 2) : [];
      const extras = rawExtras.map((e: Record<string, unknown>) => ({
        x: Number(e?.x || 0),
        z: Number(e?.z || 0),
        yaw: Number(e?.yaw || 0),
        speed: Number(e?.speed || 0),
        alerted: Boolean(e?.alerted),
        stunRemaining: Number(e?.stunRemaining || 0),
      }));
      onSanta({
        x: Number(d.x || 0),
        z: Number(d.z || 0),
        yaw: Number(d.yaw || 0),
        speed: Number(d.speed || 0),
        alerted: Boolean(d.alerted),
        stunRemaining: Number(d.stunRemaining || 0),
        extras,
        updatedAtMs: Date.now(),
      });
    },
    (error) => {
      trackAiSharedClientOp({ error: error.message });
      handleFirestoreError(error, OperationType.GET, path);
    }
  );
}

export function subscribeRoomChat(
  roomId: string,
  onMessages: (msgs: ChatMessageData[]) => void
): Unsubscribe {
  if (useDefaultProxy()) {
    const hub = getOrStartRoomHub(roomId);
    hub.msgCbs.add(onMessages);
    return () => {
      hub.msgCbs.delete(onMessages);
      cleanupRoomHubIfEmpty(roomId);
    };
  }

  const path = `rooms/${roomId}/messages`;
  const q = query(collection(db, 'rooms', roomId, 'messages'), where('roomId', '==', roomId));
  return onSnapshot(
    q,
    (snap) => {
      trackAiSharedClientOp({ reads: Math.max(1, snap.size) });
      const oneHourAgo = Date.now() - 3600000;
      const msgs: ChatMessageData[] = snap.docs
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
        .filter((m) => m.createdAtMs >= oneHourAgo);
      msgs.sort((a, b) => a.createdAtMs - b.createdAtMs);
      onMessages(msgs.slice(-60));
    },
    (error) => {
      trackAiSharedClientOp({ error: error.message });
      handleFirestoreError(error, OperationType.LIST, path);
    }
  );
}

export async function sendRoomChatMessage(
  roomId: string,
  profile: SurvivorProfile,
  rawText: string
): Promise<void> {
  const text = sanitizeChatText(rawText);
  if (!text) return;

  if (useDefaultProxy()) {
    await authedApiFetch(`/api/db/rooms/${encodeURIComponent(roomId)}/messages`, {
      method: 'POST',
      body: JSON.stringify({
        displayName: profile.displayName,
        coatColor: profile.coatColor,
        text,
      }),
    });
    return;
  }

  const msgId = generateMessageId();
  const path = `rooms/${roomId}/messages/${msgId}`;
  try {
    await setDoc(doc(db, 'rooms', roomId, 'messages', msgId), {
      senderId: profile.uid,
      senderName: sanitizeDisplayName(profile.displayName),
      coatColor: sanitizeCoatColor(profile.coatColor),
      roomId,
      text,
      createdAt: serverTimestamp(),
    });
    trackAiSharedClientOp({ writes: 1 });
  } catch (error) {
    trackAiSharedClientOp({ error: error instanceof Error ? error.message : String(error) });
    handleFirestoreError(error, OperationType.CREATE, path);
  }
}
