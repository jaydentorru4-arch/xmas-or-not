import { useCallback, useEffect, useRef, useState } from 'react';
import { onAuthStateChanged, type User } from 'firebase/auth';
import { GameHUD } from './components/GameHUD';
import { InGameChat } from './components/InGameChat';
import { MenuOverlays } from './components/MenuOverlays';
import { auth } from './firebase';
import { MazeEngine } from './game/MazeEngine';
import { useDeviceDetection } from './utils/deviceDetection';
import {
  applyXpGain,
  ChatMessageData,
  DifficultyId,
  FriendRecord,
  GameRoomData,
  HatStyle,
  HudSnapshot,
  RoomPlayerData,
  SurvivorProfile,
  xpForNextLevel,
} from './game/types';
import {
  acceptFriendRequest,
  advanceRoomWeaponWave,
  claimRoomHost,
  collectRoomBattery,
  collectRoomOrnament,
  collectRoomWeapon,
  createMultiplayerRoom,
  finishMultiplayerRoom,
  joinMultiplayerRoom,
  leaveMultiplayerRoom,
  loadOrCreateSurvivorProfile,
  recordMatchOutcome,
  registerSurvivorWithEmail,
  removeOrDeclineFriend,
  resetSurvivorPassword,
  sendFriendRequestByCode,
  sendFriendRequestByUid,
  sendGlobalChatMessage,
  sendRoomChatMessage,
  signInSurvivorWithEmail,
  signInSurvivorWithGoogle,
  signOutSurvivor,
  startMultiplayerRoom,
  subscribeFriends,
  subscribeGlobalChat,
  subscribePublicRooms,
  subscribeRoom,
  subscribeRoomChat,
  subscribeRoomPlayers,
  subscribeRoomSanta,
  syncHostSantaState,
  syncLocalPlayerState,
  triggerRoomSantaStun,
  triggerRoomTrap,
  updateSurvivorAccount,
} from './services/multiplayer';

const LOCAL_PROGRESS_KEY = 'hollow_eve_progression_v1';

function loadLocalProgression(): { level: number; xp: number } {
  try {
    const raw = window.localStorage.getItem(LOCAL_PROGRESS_KEY);
    if (!raw) return { level: 1, xp: 0 };
    const parsed = JSON.parse(raw) as { level?: number; xp?: number };
    return {
      level: Math.max(1, Math.min(99, Number(parsed.level || 1))),
      xp: Math.max(0, Number(parsed.xp || 0)),
    };
  } catch {
    return { level: 1, xp: 0 };
  }
}

function saveLocalProgression(level: number, xp: number): void {
  try {
    window.localStorage.setItem(LOCAL_PROGRESS_KEY, JSON.stringify({ level, xp }));
  } catch {
    // ignore storage quota errors
  }
}

const INITIAL_HUD: HudSnapshot = {
  phase: 'menu',
  difficulty: 'normal',
  level: 1,
  ornamentsCollected: 0,
  ornamentsTotal: 5,
  exitUnlocked: false,
  stamina: 100,
  battery: 100,
  flashlightOn: true,
  darknessOverlay: 0,
  elapsedSeconds: 0,
  santaDistance: 50,
  santaAngleDeg: 0,
  santaAlerted: false,
  santaStunRemaining: 0,
  playerHeadingDeg: 0,
  exitAngleDeg: 0,
  exitDistance: 60,
  nearestOrnamentAngleDeg: null,
  nearestOrnamentDistance: null,
  nearestWeaponAngleDeg: null,
  nearestWeaponDistance: null,
  nearestBatteryDistance: null,
  equippedWeapon: null,
  nextWeaponSpawnIn: 60,
  dodgeCooldown: 0,
  pointerLocked: false,
  chimeCooldown: 0,
  chimeAngleDeg: null,
  chimeTargetLabel: '',
  chimeTargetDistance: null,
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
  mapState: null,
};

export default function App() {
  const mountRef = useRef<HTMLDivElement | null>(null);
  const engineRef = useRef<MazeEngine | null>(null);
  const startedRoomKeyRef = useRef<string | null>(null);
  const outcomeRecordedRef = useRef<boolean>(false);

  const [hud, setHud] = useState<HudSnapshot>(INITIAL_HUD);
  const [selectedDifficulty, setSelectedDifficulty] = useState<DifficultyId>('normal');
  const [localProgress, setLocalProgress] = useState<{ level: number; xp: number }>(() =>
    loadLocalProgression()
  );
  const [selectedLevel, setSelectedLevel] = useState<number>(() => loadLocalProgression().level);
  const [lastMatchReward, setLastMatchReward] = useState<{
    earnedXp: number;
    leveledUp: boolean;
    newLevel: number;
  } | null>(null);
  const [mapExpanded, setMapExpanded] = useState(false);
  const [mobileSprinting, setMobileSprinting] = useState(false);
  const {
    isMobileDevice,
    controlScheme,
    setControlScheme,
    showMobileControls,
  } = useDeviceDetection();

  // Firebase Auth & Survivor Account
  const [authLoading, setAuthLoading] = useState(true);
  const [authError, setAuthError] = useState<string | null>(null);
  const [user, setUser] = useState<User | null>(null);
  const [profile, setProfile] = useState<SurvivorProfile | null>(null);

  // Friends State
  const [friends, setFriends] = useState<FriendRecord[]>([]);
  const [friendError, setFriendError] = useState<string | null>(null);
  const [friendNotice, setFriendNotice] = useState<string | null>(null);

  // Lobby & Multiplayer Room State
  const [publicRooms, setPublicRooms] = useState<GameRoomData[]>([]);
  const [globalChat, setGlobalChat] = useState<ChatMessageData[]>([]);
  const [activeRoomId, setActiveRoomId] = useState<string | null>(null);
  const [activeRoom, setActiveRoom] = useState<GameRoomData | null>(null);
  const [roomPlayers, setRoomPlayers] = useState<RoomPlayerData[]>([]);
  const [roomChat, setRoomChat] = useState<ChatMessageData[]>([]);
  const [roomError, setRoomError] = useState<string | null>(null);

  const maxUnlockedLevel = profile ? Math.max(profile.level, localProgress.level) : localProgress.level;
  const currentXp = profile ? profile.xp : localProgress.xp;

  // Initialize Three.js WebGL Engine once
  useEffect(() => {
    const container = mountRef.current;
    if (!container) return;

    const engine = new MazeEngine(container, (snapshot) => {
      setHud(snapshot);
    });
    engine.setMobileMode(showMobileControls);
    engineRef.current = engine;

    return () => {
      engine.dispose();
      engineRef.current = null;
    };
  }, []);

  useEffect(() => {
    engineRef.current?.setMobileMode(showMobileControls);
  }, [showMobileControls]);

  useEffect(() => {
    if (hud.phase !== 'playing') {
      setMobileSprinting(false);
    }
  }, [hud.phase]);

  // Listen to Firebase Auth state and load survivor profile
  useEffect(() => {
    const unsub = onAuthStateChanged(auth, async (nextUser) => {
      setUser(nextUser);
      if (!nextUser) {
        setProfile(null);
        setFriends([]);
        setAuthLoading(false);
        return;
      }
      setAuthLoading(true);
      setAuthError(null);
      try {
        const loaded = await loadOrCreateSurvivorProfile(nextUser);
        setProfile(loaded);
        setSelectedLevel((prev) => Math.max(prev, loaded.level));
      } catch (err) {
        setAuthError(err instanceof Error ? err.message : 'Unable to load survivor profile.');
      } finally {
        setAuthLoading(false);
      }
    });
    return () => unsub();
  }, []);

  // Subscribe to Friends when signed in
  useEffect(() => {
    if (!user || !profile) return;
    const unsubFriends = subscribeFriends(profile.uid, setFriends);
    return () => unsubFriends();
  }, [user, profile?.uid]);

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
            room.level,
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
            level: room.level,
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
              onCollectWeapon: (weaponId) => {
                collectRoomWeapon(room.roomId, weaponId);
              },
              onCollectBattery: (batteryId) => {
                collectRoomBattery(room.roomId, batteryId);
              },
              onTriggerTrap: (trapId) => {
                triggerRoomTrap(room.roomId, trapId);
              },
              onAdvanceWeaponWave: (waveIndex) => {
                advanceRoomWeaponWave(room.roomId, waveIndex);
              },
              onClaimHost: () => {
                void claimRoomHost(room.roomId, profile);
              },
              onTriggerSantaStun: () => {
                triggerRoomSantaStun(room.roomId);
              },
            },
          });
        }
        engineRef.current?.setRoomHostStatus(room.hostId === profile.uid);
        engineRef.current?.applyRoomState(
          room.collectedOrnaments,
          room.exitUnlocked,
          room.collectedWeapons ?? [],
          room.collectedBatteries ?? [],
          room.triggeredTraps ?? [],
          room.weaponWave ?? 0,
          room.santaStunNonce ?? 0
        );
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

  // Record match outcome & grant XP/Level progression once per finished match
  useEffect(() => {
    if ((hud.phase === 'escaped' || hud.phase === 'caught') && !outcomeRecordedRef.current) {
      outcomeRecordedRef.current = true;
      setMapExpanded(false);
      const escaped = hud.phase === 'escaped';
      const earnedXp = escaped
        ? Math.max(xpForNextLevel(hud.level), 110 + hud.level * 65 + (hud.difficulty === 'nightmare' ? 45 : 0))
        : 15 + hud.ornamentsCollected * 15;

      // Always update local progression too
      const localNext = applyXpGain(localProgress.level, localProgress.xp, earnedXp);
      saveLocalProgression(localNext.level, localNext.xp);
      setLocalProgress({ level: localNext.level, xp: localNext.xp });

      if (profile) {
        recordMatchOutcome(profile.uid, escaped, earnedXp)
          .then((res) => {
            if (res) {
              setProfile((prev) =>
                prev
                  ? {
                      ...prev,
                      level: res.level,
                      xp: res.xp,
                      escapes: res.escapes,
                      gamesPlayed: res.gamesPlayed,
                    }
                  : prev
              );
              setLastMatchReward({
                earnedXp,
                leveledUp: res.leveledUp,
                newLevel: res.level,
              });
              if (res.leveledUp) {
                setSelectedLevel(res.level);
              }
            }
          })
          .catch(() => {
            setLastMatchReward({
              earnedXp,
              leveledUp: localNext.leveledUp,
              newLevel: localNext.level,
            });
          });
      } else {
        setLastMatchReward({
          earnedXp,
          leveledUp: localNext.leveledUp,
          newLevel: localNext.level,
        });
        if (localNext.leveledUp) {
          setSelectedLevel(localNext.level);
        }
      }
    } else if (hud.phase === 'playing') {
      outcomeRecordedRef.current = false;
      setLastMatchReward(null);
    } else {
      setMapExpanded(false);
    }
  }, [hud.phase, hud.level, hud.difficulty, hud.ornamentsCollected, profile]);

  // Global keyboard shortcuts: Tab for Tactical Map, T/Enter for Multiplayer Chat
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (hud.phase !== 'playing') return;
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) {
        return;
      }
      if (e.code === 'Tab' && !hud.chatOpen) {
        e.preventDefault();
        setMapExpanded((prev) => !prev);
        return;
      }
      if (hud.isMultiplayer && !hud.chatOpen && (e.code === 'KeyT' || e.code === 'Enter')) {
        e.preventDefault();
        setMapExpanded(false);
        engineRef.current?.setChatOpen(true);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [hud.phase, hud.isMultiplayer, hud.chatOpen]);

  const formatError = (err: unknown, fallback: string): string => {
    if (!(err instanceof Error)) return fallback;
    if (err.message.startsWith('{')) {
      try {
        const parsed = JSON.parse(err.message) as { error?: string };
        return parsed.error || fallback;
      } catch {
        return fallback;
      }
    }
    return err.message;
  };

  const handleSelectDifficulty = (id: DifficultyId) => {
    setSelectedDifficulty(id);
    engineRef.current?.setDifficulty(id, selectedLevel);
  };

  const handleSelectLevel = (level: number) => {
    const clamped = Math.max(1, Math.min(maxUnlockedLevel, level));
    setSelectedLevel(clamped);
    engineRef.current?.setSelectedLevel(clamped);
  };

  const handleStartSolo = (levelOverride?: number) => {
    const lvl = levelOverride !== undefined ? Math.max(1, Math.min(99, levelOverride)) : selectedLevel;
    setSelectedLevel(lvl);
    setMapExpanded(false);
    engineRef.current?.startNewGame(selectedDifficulty, lvl);
  };

  const handleSignIn = async () => {
    setAuthError(null);
    try {
      await signInSurvivorWithGoogle();
    } catch (err) {
      setAuthError(err instanceof Error ? err.message : 'Google Sign-In was cancelled or failed.');
    }
  };

  const handleSignUpWithEmail = async (email: string, password: string, displayName: string) => {
    setAuthError(null);
    try {
      await registerSurvivorWithEmail(email, password, displayName);
    } catch (err) {
      setAuthError(err instanceof Error ? err.message : 'Could not create account.');
      throw err;
    }
  };

  const handleSignInWithEmail = async (email: string, password: string) => {
    setAuthError(null);
    try {
      await signInSurvivorWithEmail(email, password);
    } catch (err) {
      setAuthError(err instanceof Error ? err.message : 'Could not sign in.');
      throw err;
    }
  };

  const handleResetPassword = async (email: string) => {
    setAuthError(null);
    try {
      await resetSurvivorPassword(email);
    } catch (err) {
      setAuthError(err instanceof Error ? err.message : 'Could not send reset email.');
      throw err;
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

  const handleUpdateAccount = async (updates: {
    displayName: string;
    coatColor: string;
    scarfColor: string;
    hatStyle: HatStyle;
  }) => {
    if (!profile) return;
    const updated = await updateSurvivorAccount(profile.uid, updates);
    setProfile(updated);
  };

  const handleAddFriendByCode = async (code: string) => {
    if (!profile) return;
    setFriendError(null);
    setFriendNotice(null);
    try {
      await sendFriendRequestByCode(profile, code);
      setFriendNotice(`Friend request sent to ${code.toUpperCase()}!`);
    } catch (err) {
      setFriendError(formatError(err, 'Could not add friend.'));
    }
  };

  const handleAddFriendByUid = async (targetUid: string) => {
    if (!profile) return;
    setFriendError(null);
    setFriendNotice(null);
    try {
      await sendFriendRequestByUid(profile, targetUid);
      setFriendNotice('Friend request sent!');
    } catch (err) {
      setFriendError(formatError(err, 'Could not send friend request.'));
    }
  };

  const handleAcceptFriend = async (friendUid: string) => {
    if (!profile) return;
    setFriendError(null);
    try {
      await acceptFriendRequest(profile, friendUid);
    } catch (err) {
      setFriendError(formatError(err, 'Could not accept friend request.'));
    }
  };

  const handleRemoveFriend = async (friendUid: string) => {
    if (!profile) return;
    await removeOrDeclineFriend(profile.uid, friendUid);
  };

  const handleCreateRoom = async (roomName: string, isPublic: boolean) => {
    if (!profile) return;
    setRoomError(null);
    try {
      const room = await createMultiplayerRoom(
        profile,
        roomName,
        selectedDifficulty,
        selectedLevel,
        isPublic
      );
      startedRoomKeyRef.current = null;
      setActiveRoom(room);
      setActiveRoomId(room.roomId);
    } catch (err) {
      setRoomError(formatError(err, 'Could not create room.'));
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
      setRoomError(formatError(err, 'Could not join room.'));
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

  const handleMobileMove = useCallback((x: number, z: number) => {
    engineRef.current?.setTouchMoveVector(x, z);
  }, []);

  const handleMobileLook = useCallback((dx: number, dy: number) => {
    engineRef.current?.applyTouchLookDelta(dx, dy);
  }, []);

  const handleToggleMobileSprint = useCallback((sprinting: boolean) => {
    setMobileSprinting(sprinting);
    engineRef.current?.setTouchSprint(sprinting);
  }, []);

  const handleUnlockAudio = useCallback(() => {
    engineRef.current?.unlockAudio();
  }, []);

  return (
    <main className="relative w-screen h-[100dvh] overflow-hidden bg-[#050811]">
      {/* Isolated WebGL canvas container (never re-created on HUD updates) */}
      <div ref={mountRef} className="w-full h-full" />

      <GameHUD
        hud={hud}
        teammateCount={Math.max(1, roomPlayers.length)}
        mapExpanded={mapExpanded}
        showMobileControls={showMobileControls}
        mobileSprinting={mobileSprinting}
        onToggleMapExpanded={() => setMapExpanded((prev) => !prev)}
        onToggleMute={() => engineRef.current?.toggleMute()}
        onPause={() => engineRef.current?.pauseGame()}
        onToggleFlashlight={() => engineRef.current?.toggleFlashlight()}
        onTriggerChime={() => engineRef.current?.triggerChimeSense()}
        onUseWeapon={() => engineRef.current?.useEquippedWeapon()}
        onDodge={() => engineRef.current?.triggerDodge()}
        onToggleHudHidden={() => engineRef.current?.toggleHudHidden()}
        onLockPointer={() => engineRef.current?.requestPointerLockSafe()}
        onToggleChat={() => engineRef.current?.setChatOpen(!hud.chatOpen)}
        onUnlockAudio={handleUnlockAudio}
        onMobileMove={handleMobileMove}
        onMobileLook={handleMobileLook}
        onToggleMobileSprint={handleToggleMobileSprint}
      />

      <InGameChat
        visible={hud.phase === 'playing' && hud.isMultiplayer}
        chatOpen={hud.chatOpen}
        showMobileControls={showMobileControls}
        messages={roomChat}
        onSetChatOpen={(open) => engineRef.current?.setChatOpen(open)}
        onSendMessage={handleSendRoomChat}
      />

      <MenuOverlays
        hud={hud}
        selectedDifficulty={selectedDifficulty}
        selectedLevel={selectedLevel}
        maxUnlockedLevel={maxUnlockedLevel}
        currentXp={currentXp}
        lastMatchReward={lastMatchReward}
        onSelectDifficulty={handleSelectDifficulty}
        onSelectLevel={handleSelectLevel}
        onStartSolo={handleStartSolo}
        onResume={() => engineRef.current?.resumeGame()}
        onReturnMenu={() => engineRef.current?.returnToMenu()}
        isMobileDevice={isMobileDevice}
        showMobileControls={showMobileControls}
        controlScheme={controlScheme}
        onSetControlScheme={setControlScheme}
        authLoading={authLoading}
        authError={authError}
        profile={profile}
        onSignIn={handleSignIn}
        onSignUpWithEmail={handleSignUpWithEmail}
        onSignInWithEmail={handleSignInWithEmail}
        onResetPassword={handleResetPassword}
        onClearAuthError={() => setAuthError(null)}
        onSignOut={handleSignOut}
        onUpdateAccount={handleUpdateAccount}
        friends={friends}
        friendError={friendError}
        friendNotice={friendNotice}
        onAddFriendByCode={handleAddFriendByCode}
        onAddFriendByUid={handleAddFriendByUid}
        onAcceptFriend={handleAcceptFriend}
        onRemoveFriend={handleRemoveFriend}
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
