import {
  signInWithPopup,
  signOut,
  type User,
} from 'firebase/auth';
import {
  collection,
  deleteDoc,
  doc,
  getDoc,
  limit,
  onSnapshot,
  query,
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
  ChatMessageData,
  COAT_COLORS,
  DIFFICULTIES,
  DifficultyId,
  GameRoomData,
  RoomPlayerData,
  SantaLiveData,
  SurvivorProfile,
} from '../game/types';

function sanitizeDisplayName(raw: string): string {
  const cleaned = raw.trim().replace(/\s+/g, ' ').slice(0, 24);
  return cleaned.length >= 2 ? cleaned : 'Survivor';
}

function sanitizeCoatColor(hex: string): string {
  return /^#[0-9a-fA-F]{6}$/.test(hex) ? hex : COAT_COLORS[0].hex;
}

function sanitizeChatText(raw: string): string {
  return raw.trim().slice(0, 240);
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

export async function signInSurvivorWithGoogle(): Promise<User> {
  const res = await signInWithPopup(auth, googleProvider);
  return res.user;
}

export async function signOutSurvivor(): Promise<void> {
  await signOut(auth);
}

export async function loadOrCreateSurvivorProfile(user: User): Promise<SurvivorProfile> {
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
    handleFirestoreError(error, OperationType.WRITE, privatePath);
  }

  // Load or initialize public survivor profile
  try {
    const pubRef = doc(db, 'users', user.uid, 'public', 'profile');
    const pubSnap = await getDoc(pubRef);
    if (pubSnap.exists()) {
      const d = pubSnap.data();
      return {
        uid: user.uid,
        displayName: String(d.displayName || 'Survivor'),
        coatColor: String(d.coatColor || COAT_COLORS[0].hex),
        escapes: Number(d.escapes || 0),
        gamesPlayed: Number(d.gamesPlayed || 0),
      };
    }

    const defaultName = sanitizeDisplayName(
      user.displayName || (user.email ? user.email.split('@')[0] : 'Survivor')
    );
    const defaultColor = COAT_COLORS[Math.floor(Math.random() * COAT_COLORS.length)].hex;

    await setDoc(pubRef, {
      uid: user.uid,
      displayName: defaultName,
      coatColor: defaultColor,
      escapes: 0,
      gamesPlayed: 0,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });

    return {
      uid: user.uid,
      displayName: defaultName,
      coatColor: defaultColor,
      escapes: 0,
      gamesPlayed: 0,
    };
  } catch (error) {
    handleFirestoreError(error, OperationType.WRITE, publicPath);
  }
}

export async function updateSurvivorAccount(
  uid: string,
  displayName: string,
  coatColor: string
): Promise<SurvivorProfile> {
  const path = `users/${uid}/public/profile`;
  const cleanName = sanitizeDisplayName(displayName);
  const cleanColor = sanitizeCoatColor(coatColor);
  try {
    const ref = doc(db, 'users', uid, 'public', 'profile');
    await updateDoc(ref, {
      displayName: cleanName,
      coatColor: cleanColor,
      updatedAt: serverTimestamp(),
    });
    const snap = await getDoc(ref);
    const d = snap.data() || {};
    return {
      uid,
      displayName: cleanName,
      coatColor: cleanColor,
      escapes: Number(d.escapes || 0),
      gamesPlayed: Number(d.gamesPlayed || 0),
    };
  } catch (error) {
    handleFirestoreError(error, OperationType.UPDATE, path);
  }
}

export async function recordMatchOutcome(uid: string, escaped: boolean): Promise<void> {
  const path = `users/${uid}/public/profile`;
  try {
    const ref = doc(db, 'users', uid, 'public', 'profile');
    const snap = await getDoc(ref);
    if (!snap.exists()) return;
    const d = snap.data();
    await updateDoc(ref, {
      escapes: Number(d.escapes || 0) + (escaped ? 1 : 0),
      gamesPlayed: Number(d.gamesPlayed || 0) + 1,
      updatedAt: serverTimestamp(),
    });
  } catch (error) {
    handleFirestoreError(error, OperationType.UPDATE, path);
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
            mazeSeed: Number(d.mazeSeed || 1),
            status: (d.status as GameRoomData['status']) || 'waiting',
            collectedOrnaments: Array.isArray(d.collectedOrnaments) ? d.collectedOrnaments.map(Number) : [],
            collectedWeapons: Array.isArray(d.collectedWeapons) ? d.collectedWeapons.map(Number) : [],
            santaStunNonce: Number(d.santaStunNonce || 0),
            ornamentsTotal: Number(d.ornamentsTotal || 6),
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
  isPublic = true
): Promise<GameRoomData> {
  const roomId = generateRoomId();
  const cleanName = roomName.trim().slice(0, 40) || `${profile.displayName}'s Maze`;
  const finalName = cleanName.length >= 2 ? cleanName : 'North Pole Room';
  const mazeSeed = Math.floor(100000 + Math.random() * 899999);
  const ornamentsTotal = DIFFICULTIES[difficulty].ornamentCount;

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
      mazeSeed,
      status: 'waiting',
      collectedOrnaments: [],
      collectedWeapons: [],
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
      x: 0,
      z: 0,
      yaw: 0,
      flashlightOn: true,
      alive: true,
      escaped: false,
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
    mazeSeed,
    status: 'waiting',
    collectedOrnaments: [],
    collectedWeapons: [],
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

    const playerRef = doc(db, 'rooms', roomId, 'players', profile.uid);
    const existingPlayer = await getDoc(playerRef);

    await setDoc(playerRef, {
      uid: profile.uid,
      roomId,
      displayName: sanitizeDisplayName(profile.displayName),
      coatColor: sanitizeCoatColor(profile.coatColor),
      x: 0,
      z: 0,
      yaw: 0,
      flashlightOn: true,
      alive: true,
      escaped: false,
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
      difficulty: d.difficulty === 'nightmare' ? 'nightmare' : 'normal',
      mazeSeed: Number(d.mazeSeed || 1),
      status: (d.status as GameRoomData['status']) || 'waiting',
      collectedOrnaments: Array.isArray(d.collectedOrnaments) ? d.collectedOrnaments.map(Number) : [],
      collectedWeapons: Array.isArray(d.collectedWeapons) ? d.collectedWeapons.map(Number) : [],
      santaStunNonce: Number(d.santaStunNonce || 0),
      ornamentsTotal: Number(d.ornamentsTotal || 6),
      exitUnlocked: Boolean(d.exitUnlocked),
      isPublic: Boolean(d.isPublic),
      playerCount: Number(d.playerCount || 1) + (existingPlayer.exists() ? 0 : 1),
    };
  } catch (error) {
    if (error instanceof Error && (error.message.includes('was not found') || error.message.includes('already ended') || error.message.includes('Invalid room'))) {
      throw error;
    }
    handleFirestoreError(error, OperationType.WRITE, roomPath);
  }
}

export async function leaveMultiplayerRoom(
  roomId: string,
  uid: string
): Promise<void> {
  const roomRef = doc(db, 'rooms', roomId);
  const playerRef = doc(db, 'rooms', roomId, 'players', uid);
  try {
    const snap = await getDoc(roomRef);
    if (snap.exists()) {
      const d = snap.data();
      if (d.status !== 'finished') {
        const nextCount = Math.max(0, Number(d.playerCount || 1) - 1);
        await updateDoc(roomRef, {
          playerCount: nextCount,
          updatedAt: serverTimestamp(),
        });
      }
    }
    await deleteDoc(playerRef);
  } catch {
    // Ignore cleanup race if room already deleted
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
  const path = `rooms/${roomId}`;
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
    const snap = await getDoc(roomRef);
    if (!snap.exists()) return;
    const d = snap.data();
    if (d.status === 'finished') return;
    const current: number[] = Array.isArray(d.collectedOrnaments) ? d.collectedOrnaments.map(Number) : [];
    if (current.includes(ornamentId)) return;
    const next = [...current, ornamentId].slice(0, 10);
    await updateDoc(roomRef, {
      collectedOrnaments: next,
      exitUnlocked: next.length >= ornamentsTotal,
      updatedAt: serverTimestamp(),
    });
  } catch (error) {
    handleFirestoreError(error, OperationType.UPDATE, path);
  }
}

export async function collectRoomWeapon(roomId: string, weaponId: number): Promise<void> {
  const path = `rooms/${roomId}`;
  try {
    const roomRef = doc(db, 'rooms', roomId);
    const snap = await getDoc(roomRef);
    if (!snap.exists()) return;
    const d = snap.data();
    if (d.status === 'finished') return;
    const current: number[] = Array.isArray(d.collectedWeapons) ? d.collectedWeapons.map(Number) : [];
    if (current.includes(weaponId)) return;
    const next = [...current, weaponId].slice(-40);
    await updateDoc(roomRef, {
      collectedWeapons: next,
      updatedAt: serverTimestamp(),
    });
  } catch (error) {
    handleFirestoreError(error, OperationType.UPDATE, path);
  }
}

export async function triggerRoomSantaStun(roomId: string): Promise<void> {
  const path = `rooms/${roomId}`;
  try {
    const roomRef = doc(db, 'rooms', roomId);
    const snap = await getDoc(roomRef);
    if (!snap.exists()) return;
    const d = snap.data();
    if (d.status === 'finished') return;
    const nextNonce = Math.min(10000, Number(d.santaStunNonce || 0) + 1);
    await updateDoc(roomRef, {
      santaStunNonce: nextNonce,
      updatedAt: serverTimestamp(),
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
  }
): Promise<void> {
  const path = `rooms/${roomId}/players/${profile.uid}`;
  try {
    await updateDoc(doc(db, 'rooms', roomId, 'players', profile.uid), {
      displayName: sanitizeDisplayName(profile.displayName),
      coatColor: sanitizeCoatColor(profile.coatColor),
      x: Number(state.x.toFixed(2)),
      z: Number(state.z.toFixed(2)),
      yaw: Number(state.yaw.toFixed(3)),
      flashlightOn: state.flashlightOn,
      alive: state.alive,
      escaped: state.escaped,
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
        difficulty: d.difficulty === 'nightmare' ? 'nightmare' : 'normal',
        mazeSeed: Number(d.mazeSeed || 1),
        status: (d.status as GameRoomData['status']) || 'waiting',
        collectedOrnaments: Array.isArray(d.collectedOrnaments) ? d.collectedOrnaments.map(Number) : [],
        collectedWeapons: Array.isArray(d.collectedWeapons) ? d.collectedWeapons.map(Number) : [],
        santaStunNonce: Number(d.santaStunNonce || 0),
        ornamentsTotal: Number(d.ornamentsTotal || 6),
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
          coatColor: String(d.coatColor || '#3b82f6'),
          x: Number(d.x || 0),
          z: Number(d.z || 0),
          yaw: Number(d.yaw || 0),
          flashlightOn: Boolean(d.flashlightOn),
          alive: d.alive !== false,
          escaped: Boolean(d.escaped),
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
