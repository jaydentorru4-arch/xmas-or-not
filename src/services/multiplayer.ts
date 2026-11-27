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
import { CELL_SIZE, cellToWorld } from '../game/maze';
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
    if (!snap.exists()) {
      await setDoc(codeRef, {
        uid,
        friendCode,
        createdAt: serverTimestamp(),
      });
    }
  } catch {
    // Non-fatal if already registered or offline
  }
}

let pendingRegistrationName: string | null = null;

function mapFirebaseAuthError(error: unknown, fallback: string): Error {
  const code =
    typeof error === 'object' && error !== null && 'code' in error
      ? String((error as { code?: unknown }).code || '')
      : '';

  switch (code) {
    case 'auth/operation-not-allowed':
      return new Error(
        'Email/Password sign-in is not enabled in Firebase Console yet. Enable the Email/Password provider in Authentication → Sign-in method, or sign in with Google.'
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
  const chosenPendingName = pendingRegistrationName;
  pendingRegistrationName = null;
  const fallbackName = sanitizeDisplayName(
    chosenPendingName || user.displayName || (user.email ? user.email.split('@')[0] : 'Survivor')
  );
  const publicPath = `users/${user.uid}/public/profile`;
  const privatePath = `users/${user.uid}/private/info`;

  // Ensure private PII record exists
  try {
    const privRef = doc(db, 'users', user.uid, 'private', 'info');
    const privSnap = await getDoc(privRef);
    if (!privSnap.exists()) {
      await setDoc(privRef, {
        uid: user.uid,
        email: (user.email || 'survivor@example.com').slice(0, 254),
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
    }
  } catch (error) {
    // Gracefully absorb quota or permission errors for non-essential private logs
    console.warn('Non-critical private profile log ignored:', error);
  }

  // Load or initialize public survivor profile
  try {
    const pubRef = doc(db, 'users', user.uid, 'public', 'profile');
    const pubSnap = await getDoc(pubRef);
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

      // Backfill new customization/level fields for legacy profiles
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
  const path = `users/${uid}/public/profile`;
  try {
    const ref = doc(db, 'users', uid, 'public', 'profile');
    const snap = await getDoc(ref);
    if (!snap.exists()) return null;
    const d = snap.data();
    const prevLevel = Math.max(1, Math.min(99, Number(d.level || 1)));
    const prevXp = Math.max(0, Number(d.xp || 0));
    const progressed = applyXpGain(prevLevel, prevXp, earnedXp);
    const nextEscapes = Number(d.escapes || 0) + (escaped ? 1 : 0);
    const nextGames = Number(d.gamesPlayed || 0) + 1;

    await updateDoc(ref, {
      level: progressed.level,
      xp: progressed.xp,
      escapes: nextEscapes,
      gamesPlayed: nextGames,
      updatedAt: serverTimestamp(),
    });

    return {
      ...progressed,
      escapes: nextEscapes,
      gamesPlayed: nextGames,
    };
  } catch (error) {
    handleFirestoreError(error, OperationType.UPDATE, path);
    return null;
  }
}

// Friends & Friend Codes
export function subscribeFriends(
  uid: string,
  onFriends: (friends: FriendRecord[]) => void
): Unsubscribe {
  const path = `users/${uid}/friends`;
  const q = query(collection(db, 'users', uid, 'friends'), where('ownerUid', '==', uid));
  return onSnapshot(
    q,
    (snap) => {
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
    (error) => handleFirestoreError(error, OperationType.LIST, path)
  );
}

export async function sendFriendRequestByUid(
  myProfile: SurvivorProfile,
  targetUid: string
): Promise<void> {
  if (!targetUid || targetUid === myProfile.uid) {
    throw new Error('You cannot add yourself as a friend.');
  }

  const targetProfileSnap = await getDoc(doc(db, 'users', targetUid, 'public', 'profile'));
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
  } catch (error) {
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
  } catch (error) {
    handleFirestoreError(error, OperationType.CREATE, `users/${targetUid}/friends/${myProfile.uid}`);
  }
}

export async function sendFriendRequestByCode(
  myProfile: SurvivorProfile,
  rawCode: string
): Promise<void> {
  const code = rawCode.trim().toUpperCase();
  if (!/^[A-Z0-9_-]{4,16}$/.test(code)) {
    throw new Error('Enter a valid Friend Code (e.g. SV-XXXXXX).');
  }
  if (code === myProfile.friendCode) {
    throw new Error('That is your own Friend Code.');
  }

  const snap = await getDoc(doc(db, 'friendCodes', code));
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
  const targetSnap = await getDoc(doc(db, 'users', friendUid, 'public', 'profile'));
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
  } catch (error) {
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
  } catch {
    // Ignore if requester canceled simultaneously
  }
}

export async function removeOrDeclineFriend(myUid: string, friendUid: string): Promise<void> {
  try {
    await deleteDoc(doc(db, 'users', myUid, 'friends', friendUid));
  } catch {
    // ignore
  }
  try {
    await deleteDoc(doc(db, 'users', friendUid, 'friends', myUid));
  } catch {
    // ignore
  }
}

// Global Lobby Chat
export function subscribeGlobalChat(
  onMessages: (msgs: ChatMessageData[]) => void
): Unsubscribe {
  const path = 'globalChat';
  const q = query(collection(db, path), where('channel', '==', 'global'), limit(60));
  return onSnapshot(
    q,
    (snap) => {
      const msgs: ChatMessageData[] = snap.docs.map((docSnap) => {
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
      });
      msgs.sort((a, b) => a.createdAtMs - b.createdAtMs);
      onMessages(msgs.slice(-40));
    },
    (error) => handleFirestoreError(error, OperationType.LIST, path)
  );
}

export async function sendGlobalChatMessage(
  profile: SurvivorProfile,
  rawText: string
): Promise<void> {
  const text = sanitizeChatText(rawText);
  if (!text) return;
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
  } catch (error) {
    handleFirestoreError(error, OperationType.CREATE, path);
  }
}

// Public Rooms List
export function subscribePublicRooms(
  onRooms: (rooms: GameRoomData[]) => void
): Unsubscribe {
  const path = 'rooms';
  const q = query(collection(db, path), where('isPublic', '==', true), limit(30));
  return onSnapshot(
    q,
    (snap) => {
      const list: GameRoomData[] = snap.docs
        .map((docSnap) => {
          const d = docSnap.data();
          return {
            roomId: docSnap.id,
            name: String(d.name || 'North Pole Room'),
            hostId: String(d.hostId || ''),
            hostName: String(d.hostName || 'Host'),
            difficulty: d.difficulty === 'nightmare' ? ('nightmare' as DifficultyId) : ('normal' as DifficultyId),
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
        .filter((r) => r.status !== 'finished' && r.playerCount > 0);
      list.sort((a, b) => (b.updatedAtMs || 0) - (a.updatedAtMs || 0));
      onRooms(list);
    },
    (error) => handleFirestoreError(error, OperationType.LIST, path)
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
  } catch (error) {
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
      updatedAt: serverTimestamp(),
    });
  } catch (error) {
    handleFirestoreError(error, OperationType.CREATE, playerPath);
  }

  try {
    await setDoc(doc(db, 'rooms', roomId, 'santa', 'live'), {
      x: 0,
      z: 0,
      yaw: 0,
      speed: 0,
      alerted: false,
      stunRemaining: 0,
      updatedAt: serverTimestamp(),
    });
  } catch (error) {
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
  const roomPath = `rooms/${roomId}`;
  try {
    const roomRef = doc(db, 'rooms', roomId);
    const snap = await getDoc(roomRef);
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
      updatedAt: serverTimestamp(),
    });

    if (!existingPlayer.exists()) {
      await updateDoc(roomRef, {
        playerCount: Math.min(12, Number(d.playerCount || 0) + 1),
        updatedAt: serverTimestamp(),
      });
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
    handleFirestoreError(error, OperationType.WRITE, roomPath);
    throw new Error('Firestore quota exceeded. Unable to join room.');
  }
}

export async function leaveMultiplayerRoom(roomId: string, uid: string): Promise<void> {
  const roomRef = doc(db, 'rooms', roomId);
  const playerRef = doc(db, 'rooms', roomId, 'players', uid);
  try {
    await deleteDoc(playerRef);
    const playersSnap = await getDocs(collection(db, 'rooms', roomId, 'players'));
    const remainingPlayers = playersSnap.docs;
    if (remainingPlayers.length === 0) {
      await deleteDoc(roomRef);
    } else {
      const snap = await getDoc(roomRef);
      if (snap.exists()) {
        const d = snap.data();
        const nextCount = remainingPlayers.length;
        if (d.hostId === uid) {
          const nextHostDoc = remainingPlayers[0];
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
      }
    }
  } catch {
    // Ignore cleanup race if room already deleted
  }
}

export async function claimRoomHost(roomId: string, profile: SurvivorProfile): Promise<boolean> {
  try {
    const roomRef = doc(db, 'rooms', roomId);
    const snap = await getDoc(roomRef);
    if (!snap.exists()) return false;
    const d = snap.data();
    if (d.status === 'finished' || d.hostId === profile.uid) return d.hostId === profile.uid;
    const oldHostPlayerSnap = await getDoc(doc(db, 'rooms', roomId, 'players', String(d.hostId || '')));
    if (oldHostPlayerSnap.exists()) return false;
    await updateDoc(roomRef, {
      hostId: profile.uid,
      hostName: sanitizeDisplayName(profile.displayName),
      playerCount: Math.max(1, Number(d.playerCount || 1)),
      updatedAt: serverTimestamp(),
    });
    return true;
  } catch {
    return false;
  }
}

export async function startMultiplayerRoom(roomId: string): Promise<void> {
  const path = `rooms/${roomId}`;
  try {
    await updateDoc(doc(db, 'rooms', roomId), {
      status: 'playing',
      updatedAt: serverTimestamp(),
    });
  } catch (error) {
    handleFirestoreError(error, OperationType.UPDATE, path);
  }
}

export async function finishMultiplayerRoom(roomId: string): Promise<void> {
  try {
    await updateDoc(doc(db, 'rooms', roomId), {
      status: 'finished',
      updatedAt: serverTimestamp(),
    });
  } catch {
    // ignore if already finished
  }
}

export async function collectRoomOrnament(
  roomId: string,
  ornamentId: number,
  ornamentsTotal: number
): Promise<void> {
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
      const next = [...current, ornamentId].slice(0, 12);
      tx.update(roomRef, {
        collectedOrnaments: next,
        exitUnlocked: next.length >= ornamentsTotal,
        updatedAt: serverTimestamp(),
      });
    });
  } catch (error) {
    handleFirestoreError(error, OperationType.UPDATE, path);
  }
}

export async function collectRoomWeapon(roomId: string, weaponId: number): Promise<void> {
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
  } catch (error) {
    handleFirestoreError(error, OperationType.UPDATE, path);
  }
}

export async function collectRoomBattery(roomId: string, batteryId: number): Promise<void> {
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
  } catch (error) {
    handleFirestoreError(error, OperationType.UPDATE, path);
  }
}

export async function triggerRoomTrap(roomId: string, trapId: number): Promise<void> {
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
  } catch (error) {
    handleFirestoreError(error, OperationType.UPDATE, path);
  }
}

export async function advanceRoomWeaponWave(roomId: string, wave: number): Promise<void> {
  const cleanWave = Math.max(0, Math.min(99, Math.floor(wave)));
  try {
    await updateDoc(doc(db, 'rooms', roomId), {
      weaponWave: cleanWave,
      updatedAt: serverTimestamp(),
    });
  } catch {
    // Non-fatal if room finished
  }
}

export async function triggerRoomSantaStun(roomId: string): Promise<void> {
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
  } catch (error) {
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
  } catch {
    // Silent on transient tick sync if player left or room closed
  }
}

export async function syncHostSantaState(
  roomId: string,
  state: SantaLiveData
): Promise<void> {
  try {
    await updateDoc(doc(db, 'rooms', roomId, 'santa', 'live'), {
      x: Number(state.x.toFixed(2)),
      z: Number(state.z.toFixed(2)),
      yaw: Number(state.yaw.toFixed(3)),
      speed: Number(Math.max(0, Math.min(20, state.speed)).toFixed(2)),
      alerted: state.alerted,
      stunRemaining: Number(Math.max(0, Math.min(35, state.stunRemaining)).toFixed(1)),
      updatedAt: serverTimestamp(),
    });
  } catch {
    // Silent on transient tick sync
  }
}

export function subscribeRoom(
  roomId: string,
  onRoom: (room: GameRoomData | null) => void
): Unsubscribe {
  const path = `rooms/${roomId}`;
  return onSnapshot(
    doc(db, 'rooms', roomId),
    (snap) => {
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
    (error) => handleFirestoreError(error, OperationType.GET, path)
  );
}

export function subscribeRoomPlayers(
  roomId: string,
  onPlayers: (players: RoomPlayerData[]) => void
): Unsubscribe {
  const path = `rooms/${roomId}/players`;
  const q = query(collection(db, 'rooms', roomId, 'players'), where('roomId', '==', roomId));
  return onSnapshot(
    q,
    (snap) => {
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
        };
      });
      onPlayers(list);
    },
    (error) => handleFirestoreError(error, OperationType.LIST, path)
  );
}

export function subscribeRoomSanta(
  roomId: string,
  onSanta: (santa: SantaLiveData) => void
): Unsubscribe {
  const path = `rooms/${roomId}/santa/live`;
  return onSnapshot(
    doc(db, 'rooms', roomId, 'santa', 'live'),
    (snap) => {
      if (!snap.exists()) return;
      const d = snap.data();
      onSanta({
        x: Number(d.x || 0),
        z: Number(d.z || 0),
        yaw: Number(d.yaw || 0),
        speed: Number(d.speed || 0),
        alerted: Boolean(d.alerted),
        stunRemaining: Number(d.stunRemaining || 0),
        updatedAtMs: Date.now(),
      });
    },
    (error) => handleFirestoreError(error, OperationType.GET, path)
  );
}

export function subscribeRoomChat(
  roomId: string,
  onMessages: (msgs: ChatMessageData[]) => void
): Unsubscribe {
  const path = `rooms/${roomId}/messages`;
  const q = query(collection(db, 'rooms', roomId, 'messages'), where('roomId', '==', roomId));
  return onSnapshot(
    q,
    (snap) => {
      const msgs: ChatMessageData[] = snap.docs.map((docSnap) => {
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
      });
      msgs.sort((a, b) => a.createdAtMs - b.createdAtMs);
      onMessages(msgs.slice(-60));
    },
    (error) => handleFirestoreError(error, OperationType.LIST, path)
  );
}

export async function sendRoomChatMessage(
  roomId: string,
  profile: SurvivorProfile,
  rawText: string
): Promise<void> {
  const text = sanitizeChatText(rawText);
  if (!text) return;
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
  } catch (error) {
    handleFirestoreError(error, OperationType.CREATE, path);
  }
}
