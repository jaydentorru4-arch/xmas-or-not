import { useEffect, useRef, useState } from 'react';
import { onAuthStateChanged, type User } from 'firebase/auth';
import { GameHUD } from './components/GameHUD';
import { InGameChat } from './components/InGameChat';
import { MenuOverlays } from './components/MenuOverlays';
import { auth } from './firebase';
import { MazeEngine } from './game/MazeEngine';
import {
  ChatMessageData,
  DifficultyId,
  GameRoomData,
  HudSnapshot,
  RoomPlayerData,
  SurvivorProfile,
} from './game/types';
import {
  collectRoomOrnament,
  createMultiplayerRoom,
  finishMultiplayerRoom,
  joinMultiplayerRoom,
  leaveMultiplayerRoom,
  loadOrCreateSurvivorProfile,
  recordMatchOutcome,
  sendGlobalChatMessage,
  sendRoomChatMessage,
  signInSurvivorWithGoogle,
  signOutSurvivor,
  startMultiplayerRoom,
  subscribeGlobalChat,
  subscribePublicRooms,
  subscribeRoom,
  subscribeRoomChat,
  subscribeRoomPlayers,
  subscribeRoomSanta,
  syncHostSantaState,
  syncLocalPlayerState,
  updateSurvivorAccount,
} from './services/multiplayer';

const INITIAL_HUD: HudSnapshot = {
  phase: 'menu',
  difficulty: 'normal',
  ornamentsCollected: 0,
  ornamentsTotal: 6,
  exitUnlocked: false,
  stamina: 100,
  battery: 100,
  flashlightOn: true,
  elapsedSeconds: 0,
  santaDistance: 50,
  santaAngleDeg: 0,
  santaAlerted: false,
  playerHeadingDeg: 0,
  exitAngleDeg: 0,
  exitDistance: 60,
  nearestOrnamentAngleDeg: null,
  nearestOrnamentDistance: null,
  pointerLocked: false,
  chimeCooldown: 0,
  chimeAngleDeg: null,
  chimeTargetLabel: '',
  statusBanner: null,
  muted: false,
  hudHidden: false,
  webglError: null,
  isMultiplayer: false,
  roomId: null,
  isHost: false,
  alive: true,
  spectating: false,
  chatOpen: false,
};

export default function App() {
  const mountRef = useRef<HTMLDivElement | null>(null);
  const engineRef = useRef<MazeEngine | null>(null);
  const startedRoomKeyRef = useRef<string | null>(null);
  const outcomeRecordedRef = useRef<boolean>(false);

  const [hud, setHud] = useState<HudSnapshot>(INITIAL_HUD);
  const [selectedDifficulty, setSelectedDifficulty] = useState<DifficultyId>('normal');

  // Firebase Auth & Survivor Account
  const [authLoading, setAuthLoading] = useState(true);
  const [authError, setAuthError] = useState<string | null>(null);
  const [user, setUser] = useState<User | null>(null);
  const [profile, setProfile] = useState<SurvivorProfile | null>(null);

  // Lobby & Multiplayer Room State
  const [publicRooms, setPublicRooms] = useState<GameRoomData[]>([]);
  const [globalChat, setGlobalChat] = useState<ChatMessageData[]>([]);
  const [activeRoomId, setActiveRoomId] = useState<string | null>(null);
  const [activeRoom, setActiveRoom] = useState<GameRoomData | null>(null);
  const [roomPlayers, setRoomPlayers] = useState<RoomPlayerData[]>([]);
  const [roomChat, setRoomChat] = useState<ChatMessageData[]>([]);
  const [roomError, setRoomError] = useState<string | null>(null);

  // Initialize Three.js WebGL Engine once
  useEffect(() => {
    const container = mountRef.current;
    if (!container) return;

    const engine = new MazeEngine(container, (snapshot) => {
      setHud(snapshot);
    });
    engineRef.current = engine;

    return () => {
      engine.dispose();
      engineRef.current = null;
    };
  }, []);

  // Listen to Firebase Auth state and load survivor profile
  useEffect(() => {
    const unsub = onAuthStateChanged(auth, async (nextUser) => {
      setUser(nextUser);
      if (!nextUser) {
        setProfile(null);
        setAuthLoading(false);
        return;
      }
      setAuthLoading(true);
      setAuthError(null);
      try {
        const loaded = await loadOrCreateSurvivorProfile(nextUser);
        setProfile(loaded);
      } catch (err) {
        setAuthError(err instanceof Error ? err.message : 'Unable to load survivor profile.');
      } finally {
        setAuthLoading(false);
      }
    });
    return () => unsub();
  }, []);

  // Subscribe to Global Chat & Open Public Rooms when signed in and in Menu
  useEffect(() => {
    if (!user || !profile || activeRoomId) return;
    const unsubChat = subscribeGlobalChat(setGlobalChat);
    const unsubRooms = subscribePublicRooms(setPublicRooms);
    return () => {
      unsubChat();
      unsubRooms();
    };
  }, [user, profile, activeRoomId]);

  // Subscribe to Active Room state, players, Santa, and room chat
  useEffect(() => {
    if (!activeRoomId || !profile) return;

    const unsubRoom = subscribeRoom(activeRoomId, (room) => {
      setActiveRoom(room);
      if (!room) {
        startedRoomKeyRef.current = null;
        setActiveRoomId(null);
        engineRef.current?.returnToMenu();
        return;
      }

      if (room.status === 'waiting') {
        if (startedRoomKeyRef.current !== `waiting:${room.roomId}`) {
          startedRoomKeyRef.current = `waiting:${room.roomId}`;
          engineRef.current?.enterWaitingRoom(
            room.difficulty,
            room.mazeSeed,
            room.roomId,
            room.hostId === profile.uid,
            profile.uid
          );
        }
      } else if (room.status === 'playing') {
        const playKey = `playing:${room.roomId}:${room.mazeSeed}`;
        if (startedRoomKeyRef.current !== playKey) {
          startedRoomKeyRef.current = playKey;
          outcomeRecordedRef.current = false;
          engineRef.current?.startMultiplayerSession({
            difficulty: room.difficulty,
            mazeSeed: room.mazeSeed,
            roomId: room.roomId,
            isHost: room.hostId === profile.uid,
            localUid: profile.uid,
            callbacks: {
              onLocalPlayerSync: (state) => {
                syncLocalPlayerState(room.roomId, profile, state);
              },
              onHostSantaSync: (santaState) => {
                syncHostSantaState(room.roomId, santaState);
              },
              onCollectOrnament: (ornamentId) => {
                collectRoomOrnament(room.roomId, ornamentId, room.ornamentsTotal);
              },
            },
          });
        }
        engineRef.current?.applyRoomOrnaments(room.collectedOrnaments, room.exitUnlocked);
      }
    });

    const unsubPlayers = subscribeRoomPlayers(activeRoomId, (players) => {
      setRoomPlayers(players);
      engineRef.current?.applyRemotePlayers(players);
    });

    const unsubSanta = subscribeRoomSanta(activeRoomId, (santa) => {
      engineRef.current?.applyRemoteSantaState(santa);
    });

    const unsubChat = subscribeRoomChat(activeRoomId, setRoomChat);

    return () => {
      unsubRoom();
      unsubPlayers();
      unsubSanta();
      unsubChat();
    };
  }, [activeRoomId, profile]);

  // Record match outcome to Survivor Profile stats once per finished match
  useEffect(() => {
    if (!profile) return;
    if ((hud.phase === 'escaped' || hud.phase === 'caught') && !outcomeRecordedRef.current) {
      outcomeRecordedRef.current = true;
      const escaped = hud.phase === 'escaped';
      recordMatchOutcome(profile.uid, escaped)
        .then(() => {
          setProfile((prev) =>
            prev
              ? {
                  ...prev,
                  escapes: prev.escapes + (escaped ? 1 : 0),
                  gamesPlayed: prev.gamesPlayed + 1,
                }
              : prev
          );
        })
        .catch(() => {});
    } else if (hud.phase === 'playing') {
      outcomeRecordedRef.current = false;
    }
  }, [hud.phase, profile]);

  // Global keyboard shortcut (T or Enter) to open in-game chat during multiplayer
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (hud.phase !== 'playing' || !hud.isMultiplayer || hud.chatOpen) return;
      if (
        e.target instanceof HTMLInputElement ||
        e.target instanceof HTMLTextAreaElement
      ) {
        return;
      }
      if (e.code === 'KeyT' || e.code === 'Enter') {
        e.preventDefault();
        engineRef.current?.setChatOpen(true);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [hud.phase, hud.isMultiplayer, hud.chatOpen]);

  const handleSelectDifficulty = (id: DifficultyId) => {
    setSelectedDifficulty(id);
    engineRef.current?.setDifficulty(id);
  };

  const handleSignIn = async () => {
    setAuthError(null);
    try {
      await signInSurvivorWithGoogle();
    } catch (err) {
      setAuthError(err instanceof Error ? err.message : 'Google Sign-In was cancelled or failed.');
    }
  };

  const handleSignOut = async () => {
    if (activeRoomId && profile) {
      await leaveMultiplayerRoom(activeRoomId, profile.uid);
      setActiveRoomId(null);
      setActiveRoom(null);
      startedRoomKeyRef.current = null;
      engineRef.current?.returnToMenu();
    }
    await signOutSurvivor();
  };

  const handleUpdateAccount = async (displayName: string, coatColor: string) => {
    if (!profile) return;
    const updated = await updateSurvivorAccount(profile.uid, displayName, coatColor);
    setProfile(updated);
  };

  const handleCreateRoom = async (roomName: string, isPublic: boolean) => {
    if (!profile) return;
    setRoomError(null);
    try {
      const room = await createMultiplayerRoom(profile, roomName, selectedDifficulty, isPublic);
      startedRoomKeyRef.current = null;
      setActiveRoom(room);
      setActiveRoomId(room.roomId);
    } catch (err) {
      setRoomError(err instanceof Error ? err.message : 'Could not create room.');
    }
  };

  const handleJoinRoom = async (roomId: string) => {
    if (!profile) return;
    setRoomError(null);
    try {
      const room = await joinMultiplayerRoom(profile, roomId);
      startedRoomKeyRef.current = null;
      setActiveRoom(room);
      setActiveRoomId(room.roomId);
    } catch (err) {
      setRoomError(err instanceof Error ? err.message : 'Could not join room.');
    }
  };

  const handleLeaveRoom = async () => {
    if (activeRoomId && profile) {
      if (activeRoom?.hostId === profile.uid && activeRoom.playerCount <= 1) {
        await finishMultiplayerRoom(activeRoomId);
      }
      await leaveMultiplayerRoom(activeRoomId, profile.uid);
    }
    startedRoomKeyRef.current = null;
    setActiveRoomId(null);
    setActiveRoom(null);
    setRoomPlayers([]);
    setRoomChat([]);
    engineRef.current?.returnToMenu();
  };

  const handleStartRoomMatch = async () => {
    if (!activeRoomId) return;
    await startMultiplayerRoom(activeRoomId);
  };

  const handleSendGlobalChat = async (text: string) => {
    if (!profile) return;
    await sendGlobalChatMessage(profile, text);
  };

  const handleSendRoomChat = async (text: string) => {
    if (!profile || !activeRoomId) return;
    await sendRoomChatMessage(activeRoomId, profile, text);
  };

  return (
    <main className="relative w-screen h-screen overflow-hidden bg-[#050811]">
      {/* Isolated WebGL canvas container (never re-created on HUD updates) */}
      <div ref={mountRef} className="w-full h-full" />

      <GameHUD
        hud={hud}
        teammateCount={Math.max(1, roomPlayers.length)}
        onToggleMute={() => engineRef.current?.toggleMute()}
        onPause={() => engineRef.current?.pauseGame()}
        onToggleFlashlight={() => engineRef.current?.toggleFlashlight()}
        onTriggerChime={() => engineRef.current?.triggerChimeSense()}
        onToggleHudHidden={() => engineRef.current?.toggleHudHidden()}
        onLockPointer={() => engineRef.current?.requestPointerLockSafe()}
        onToggleChat={() => engineRef.current?.setChatOpen(!hud.chatOpen)}
      />

      <InGameChat
        visible={hud.phase === 'playing' && hud.isMultiplayer}
        chatOpen={hud.chatOpen}
        messages={roomChat}
        onSetChatOpen={(open) => engineRef.current?.setChatOpen(open)}
        onSendMessage={handleSendRoomChat}
      />

      <MenuOverlays
        hud={hud}
        selectedDifficulty={selectedDifficulty}
        onSelectDifficulty={handleSelectDifficulty}
        onStartSolo={() => engineRef.current?.startNewGame(selectedDifficulty)}
        onResume={() => engineRef.current?.resumeGame()}
        onReturnMenu={() => engineRef.current?.returnToMenu()}
        authLoading={authLoading}
        authError={authError}
        profile={profile}
        onSignIn={handleSignIn}
        onSignOut={handleSignOut}
        onUpdateAccount={handleUpdateAccount}
        publicRooms={publicRooms}
        activeRoom={activeRoom}
        roomPlayers={roomPlayers}
        globalChat={globalChat}
        roomChat={roomChat}
        roomError={roomError}
        onCreateRoom={handleCreateRoom}
        onJoinRoom={handleJoinRoom}
        onLeaveRoom={handleLeaveRoom}
        onStartRoomMatch={handleStartRoomMatch}
        onSendGlobalChat={handleSendGlobalChat}
        onSendRoomChat={handleSendRoomChat}
      />
    </main>
  );
}
