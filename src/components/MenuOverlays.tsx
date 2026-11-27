import React, { useEffect, useRef, useState } from 'react';
import {
  Check,
  ChevronLeft,
  ChevronRight,
  Copy,
  Eye,
  EyeOff,
  LogIn,
  LogOut,
  Mail,
  MessageSquare,
  Monitor,
  Palette,
  Play,
  Plus,
  Send,
  Shield,
  Smartphone,
  UserCheck,
  UserPlus,
  Users,
  X,
} from 'lucide-react';
import type { ControlScheme } from '../utils/deviceDetection';
import {
  COAT_COLORS,
  ChatMessageData,
  DIFFICULTIES,
  DifficultyId,
  FriendRecord,
  GameRoomData,
  HAT_STYLES,
  HatStyle,
  HudSnapshot,
  RoomPlayerData,
  SCARF_COLORS,
  SurvivorProfile,
  getLevelScaling,
  xpForNextLevel,
} from '../game/types';

interface MenuOverlaysProps {
  hud: HudSnapshot;
  selectedDifficulty: DifficultyId;
  selectedLevel: number;
  maxUnlockedLevel: number;
  currentXp: number;
  lastMatchReward: { earnedXp: number; leveledUp: boolean; newLevel: number } | null;
  onSelectDifficulty: (id: DifficultyId) => void;
  onSelectLevel: (level: number) => void;
  onStartSolo: (levelOverride?: number) => void;
  onResume: () => void;
  onReturnMenu: () => void;
  isMobileDevice: boolean;
  showMobileControls: boolean;
  controlScheme: ControlScheme;
  onSetControlScheme: (scheme: ControlScheme) => void;

  // Auth & Account
  authLoading: boolean;
  authError: string | null;
  profile: SurvivorProfile | null;
  onSignIn: () => Promise<void>;
  onSignUpWithEmail: (email: string, password: string, displayName: string) => Promise<void>;
  onSignInWithEmail: (email: string, password: string) => Promise<void>;
  onResetPassword: (email: string) => Promise<void>;
  onClearAuthError: () => void;
  onSignOut: () => Promise<void>;
  onUpdateAccount: (updates: {
    displayName: string;
    coatColor: string;
    scarfColor: string;
    hatStyle: HatStyle;
  }) => Promise<void>;

  // Friends
  friends: FriendRecord[];
  friendError: string | null;
  friendNotice: string | null;
  onAddFriendByCode: (code: string) => Promise<void>;
  onAddFriendByUid: (uid: string) => Promise<void>;
  onAcceptFriend: (friendUid: string) => Promise<void>;
  onRemoveFriend: (friendUid: string) => Promise<void>;

  // Rooms & Chat
  publicRooms: GameRoomData[];
  activeRoom: GameRoomData | null;
  roomPlayers: RoomPlayerData[];
  globalChat: ChatMessageData[];
  roomChat: ChatMessageData[];
  roomError: string | null;
  onCreateRoom: (roomName: string, isPublic: boolean) => Promise<void>;
  onJoinRoom: (roomId: string) => Promise<void>;
  onLeaveRoom: () => Promise<void>;
  onStartRoomMatch: () => Promise<void>;
  onSendGlobalChat: (text: string) => Promise<void>;
  onSendRoomChat: (text: string) => Promise<void>;
  onClearGlobalChat: () => Promise<void>;
}

type RightTab = 'coop' | 'customize' | 'friends';

function formatTime(sec: number): string {
  const whole = Math.max(0, Math.floor(sec));
  const m = Math.floor(whole / 60);
  const s = whole % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

const SurvivorAvatarPreview: React.FC<{
  coatColor: string;
  scarfColor: string;
  hatStyle: HatStyle;
  name: string;
}> = ({ coatColor, scarfColor, hatStyle, name }) => {
  return (
    <div className="flex flex-col items-center justify-center bg-[#060a14] border border-white/12 rounded-xl p-4 w-full sm:w-44 shrink-0">
      <svg viewBox="0 0 120 140" className="w-28 h-32" aria-label="Survivor character preview">
        {/* Background winter glow */}
        <circle cx="60" cy="70" r="52" fill="#0d172b" />
        {/* Parka Torso & Shoulders */}
        <path
          d="M24 132 C24 98, 36 86, 60 86 C84 86, 96 98, 96 132 Z"
          fill={coatColor}
          stroke="#0f172a"
          strokeWidth="2"
        />
        {/* Parka center zip */}
        <line x1="60" y1="90" x2="60" y2="132" stroke="#0f172a" strokeWidth="2.5" />
        {/* Scarf wrap */}
        <rect x="40" y="76" width="40" height="14" rx="6" fill={scarfColor} stroke="#0f172a" strokeWidth="1.5" />
        <rect x="63" y="86" width="10" height="22" rx="3" fill={scarfColor} stroke="#0f172a" strokeWidth="1.5" />

        {/* Hood base behind head */}
        {hatStyle === 'hood' && (
          <circle cx="60" cy="54" r="26" fill={coatColor} stroke="#0f172a" strokeWidth="2" />
        )}

        {/* Head */}
        <circle cx="60" cy="55" r="19" fill="#e8c3a5" stroke="#0f172a" strokeWidth="1.5" />
        {/* Eyes */}
        <circle cx="53" cy="55" r="2.2" fill="#0f172a" />
        <circle cx="67" cy="55" r="2.2" fill="#0f172a" />

        {/* Hat Styles */}
        {hatStyle === 'hood' && (
          <path
            d="M37 52 C37 32, 83 32, 83 52 C77 41, 43 41, 37 52 Z"
            fill={coatColor}
            stroke="#0f172a"
            strokeWidth="1.5"
          />
        )}
        {hatStyle === 'beanie' && (
          <>
            <path d="M40 48 C42 29, 78 29, 80 48 Z" fill={scarfColor} stroke="#0f172a" strokeWidth="1.5" />
            <rect x="38" y="43" width="44" height="8" rx="4" fill="#cbd5e1" stroke="#0f172a" strokeWidth="1.2" />
            <circle cx="60" cy="28" r="5" fill="#f8fafc" stroke="#0f172a" strokeWidth="1.2" />
          </>
        )}
        {hatStyle === 'santa_hat' && (
          <>
            <path d="M40 46 L58 18 L82 46 Z" fill="#b91c1c" stroke="#0f172a" strokeWidth="1.5" />
            <rect x="38" y="42" width="44" height="8" rx="4" fill="#f8fafc" stroke="#0f172a" strokeWidth="1.2" />
            <circle cx="80" cy="30" r="5.5" fill="#f8fafc" stroke="#0f172a" strokeWidth="1.2" />
          </>
        )}
        {hatStyle === 'ushanka' && (
          <>
            <rect x="39" y="31" width="42" height="17" rx="5" fill="#475569" stroke="#0f172a" strokeWidth="1.5" />
            <rect x="35" y="43" width="9" height="22" rx="4" fill="#64748b" stroke="#0f172a" strokeWidth="1.3" />
            <rect x="76" y="43" width="9" height="22" rx="4" fill="#64748b" stroke="#0f172a" strokeWidth="1.3" />
            <rect x="44" y="36" width="32" height="9" rx="3" fill="#94a3b8" />
          </>
        )}
      </svg>
      <div className="text-xs font-semibold text-slate-100 truncate max-w-full mt-1">
        {name || 'Survivor'}
      </div>
      <div className="text-[11px] text-slate-400">
        {HAT_STYLES.find((h) => h.id === hatStyle)?.label || 'Winter Hood'}
      </div>
    </div>
  );
};

export const MenuOverlays: React.FC<MenuOverlaysProps> = ({
  hud,
  selectedDifficulty,
  selectedLevel,
  maxUnlockedLevel,
  currentXp,
  lastMatchReward,
  onSelectDifficulty,
  onSelectLevel,
  onStartSolo,
  onResume,
  onReturnMenu,
  isMobileDevice,
  showMobileControls,
  controlScheme,
  onSetControlScheme,
  authLoading,
  authError,
  profile,
  onSignIn,
  onSignUpWithEmail,
  onSignInWithEmail,
  onResetPassword,
  onClearAuthError,
  onSignOut,
  onUpdateAccount,
  friends,
  friendError,
  friendNotice,
  onAddFriendByCode,
  onAddFriendByUid,
  onAcceptFriend,
  onRemoveFriend,
  publicRooms,
  activeRoom,
  roomPlayers,
  globalChat,
  roomChat,
  roomError,
  onCreateRoom,
  onJoinRoom,
  onLeaveRoom,
  onStartRoomMatch,
  onSendGlobalChat,
  onSendRoomChat,
  onClearGlobalChat,
}) => {
  const [rightTab, setRightTab] = useState<RightTab>('coop');

  const [authMode, setAuthMode] = useState<'login' | 'signup'>('login');
  const [authName, setAuthName] = useState('');
  const [authEmail, setAuthEmail] = useState('');
  const [authPassword, setAuthPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [authBusy, setAuthBusy] = useState(false);
  const [resetSentMsg, setResetSentMsg] = useState<string | null>(null);

  const [nameDraft, setNameDraft] = useState(profile?.displayName || '');
  const [coatDraft, setCoatDraft] = useState(profile?.coatColor || COAT_COLORS[0].hex);
  const [scarfDraft, setScarfDraft] = useState(profile?.scarfColor || SCARF_COLORS[0].hex);
  const [hatDraft, setHatDraft] = useState<HatStyle>(profile?.hatStyle || 'hood');
  const [savingAccount, setSavingAccount] = useState(false);
  const [accountSavedMsg, setAccountSavedMsg] = useState(false);

  const [friendCodeInput, setFriendCodeInput] = useState('');
  const [friendBusy, setFriendBusy] = useState(false);
  const [copiedFriendCode, setCopiedFriendCode] = useState(false);

  const [roomNameDraft, setRoomNameDraft] = useState('');
  const [roomIsPublic, setRoomIsPublic] = useState(true);
  const [joinCodeDraft, setJoinCodeDraft] = useState('');
  const [roomBusy, setRoomBusy] = useState(false);
  const [copiedCode, setCopiedCode] = useState(false);

  const [globalMsgDraft, setGlobalMsgDraft] = useState('');
  const [roomMsgDraft, setRoomMsgDraft] = useState('');

  const globalChatScrollRef = useRef<HTMLDivElement | null>(null);
  const roomChatScrollRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (profile) {
      setNameDraft(profile.displayName);
      setCoatDraft(profile.coatColor);
      setScarfDraft(profile.scarfColor);
      setHatDraft(profile.hatStyle);
    }
  }, [profile?.uid, profile?.displayName, profile?.coatColor, profile?.scarfColor, profile?.hatStyle]);

  useEffect(() => {
    if (globalChatScrollRef.current) {
      globalChatScrollRef.current.scrollTop = globalChatScrollRef.current.scrollHeight;
    }
  }, [globalChat]);

  useEffect(() => {
    if (roomChatScrollRef.current) {
      roomChatScrollRef.current.scrollTop = roomChatScrollRef.current.scrollHeight;
    }
  }, [roomChat]);

  if (hud.webglError) {
    return (
      <div className="fixed inset-0 z-30 flex items-center justify-center bg-[#050811] px-6">
        <div className="max-w-md w-full bg-[#0b1020] border border-white/15 rounded-xl p-8 text-center">
          <h1 className="font-display text-2xl font-bold text-slate-100 mb-3">
            3D Rendering Unavailable
          </h1>
          <p className="text-sm text-slate-300 leading-relaxed mb-6">{hud.webglError}</p>
        </div>
      </div>
    );
  }

  if (hud.phase === 'playing') return null;

  const levelScaling = getLevelScaling(selectedLevel, selectedDifficulty);
  const nextLevelXp = xpForNextLevel(maxUnlockedLevel);
  const xpPct = Math.min(100, Math.round((currentXp / nextLevelXp) * 100));

  const incomingRequests = friends.filter((f) => f.status === 'pending_received');
  const acceptedFriends = friends.filter((f) => f.status === 'accepted');
  const sentRequests = friends.filter((f) => f.status === 'pending_sent');
  const friendStatusMap = new Map(friends.map((f) => [f.friendUid, f.status]));

  const handleSwitchAuthMode = (mode: 'login' | 'signup') => {
    setAuthMode(mode);
    setResetSentMsg(null);
    onClearAuthError();
  };

  const handleEmailAuthSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (authBusy) return;
    setResetSentMsg(null);
    setAuthBusy(true);
    try {
      if (authMode === 'signup') {
        await onSignUpWithEmail(authEmail, authPassword, authName);
      } else {
        await onSignInWithEmail(authEmail, authPassword);
      }
      setAuthPassword('');
    } catch {
      // authError is surfaced via App state
    } finally {
      setAuthBusy(false);
    }
  };

  const handleForgotPasswordClick = async () => {
    if (authBusy) return;
    setResetSentMsg(null);
    setAuthBusy(true);
    try {
      await onResetPassword(authEmail);
      setResetSentMsg('Password reset link sent! Check your email inbox.');
    } catch {
      // authError is surfaced via App state
    } finally {
      setAuthBusy(false);
    }
  };

  const handleSaveAccount = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!profile || savingAccount) return;
    setSavingAccount(true);
    try {
      await onUpdateAccount({
        displayName: nameDraft,
        coatColor: coatDraft,
        scarfColor: scarfDraft,
        hatStyle: hatDraft,
      });
      setAccountSavedMsg(true);
      window.setTimeout(() => setAccountSavedMsg(false), 2000);
    } finally {
      setSavingAccount(false);
    }
  };

  const handleAddFriendCodeSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!friendCodeInput.trim() || friendBusy) return;
    setFriendBusy(true);
    try {
      await onAddFriendByCode(friendCodeInput);
      setFriendCodeInput('');
    } finally {
      setFriendBusy(false);
    }
  };

  const handleCreateRoomSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (roomBusy) return;
    setRoomBusy(true);
    try {
      await onCreateRoom(roomNameDraft, roomIsPublic);
      setRoomNameDraft('');
    } finally {
      setRoomBusy(false);
    }
  };

  const handleJoinCodeSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!joinCodeDraft.trim() || roomBusy) return;
    setRoomBusy(true);
    try {
      await onJoinRoom(joinCodeDraft);
      setJoinCodeDraft('');
    } finally {
      setRoomBusy(false);
    }
  };

  const handleSendGlobal = async (e: React.FormEvent) => {
    e.preventDefault();
    const txt = globalMsgDraft.trim();
    if (!txt) return;
    setGlobalMsgDraft('');
    await onSendGlobalChat(txt);
  };

  const handleSendRoom = async (e: React.FormEvent) => {
    e.preventDefault();
    const txt = roomMsgDraft.trim();
    if (!txt) return;
    setRoomMsgDraft('');
    await onSendRoomChat(txt);
  };

  const handleCopyCode = () => {
    if (!activeRoom) return;
    navigator.clipboard?.writeText(activeRoom.roomId).catch(() => {});
    setCopiedCode(true);
    window.setTimeout(() => setCopiedCode(false), 1800);
  };

  const handleCopyFriendCode = () => {
    if (!profile) return;
    navigator.clipboard?.writeText(profile.friendCode).catch(() => {});
    setCopiedFriendCode(true);
    window.setTimeout(() => setCopiedFriendCode(false), 1800);
  };

  if (hud.phase === 'menu') {
    return (
      <div className="fixed inset-0 z-20 flex items-start sm:items-center justify-center bg-gradient-to-t from-[#050811]/92 via-[#050811]/72 to-[#050811]/80 px-3 sm:px-6 py-4 sm:py-6 overflow-y-auto touch-pan-y">
        <div className="max-w-5xl w-full grid grid-cols-1 lg:grid-cols-12 gap-4 sm:gap-5 my-auto">
          {/* Left Panel: Solo Entry, Level Progression & Difficulty */}
          <div className="lg:col-span-5 bg-[#080d1a]/95 border border-white/15 rounded-xl p-5 sm:p-7 flex flex-col justify-between">
            <div>
              <p className="text-xs font-medium tracking-wide text-red-400 mb-1.5">
                First-Person Labyrinth Survival
              </p>
              <h1 className="font-display text-4xl sm:text-5xl font-bold text-slate-50 tracking-tight mb-2.5 [text-wrap:balance]">
                Hollow Eve
              </h1>
              <p className="text-sm text-slate-300 leading-relaxed mb-5">
                Recover cursed ornaments, dodge around corners to lose Evil Santa, grab 60s weapons to
                stun him for 30s, and collect green batteries before your flashlight dies.
              </p>

              {/* Survivor Level & XP Progress */}
              <div className="mb-4 bg-[#050811]/90 border border-white/10 rounded-lg p-3">
                <div className="flex items-center justify-between text-xs mb-1.5">
                  <span className="font-semibold text-amber-300 flex items-center gap-1.5">
                    <Shield className="w-3.5 h-3.5" />
                    <span>Survivor Level {maxUnlockedLevel}</span>
                  </span>
                  <span className="font-mono-tabular text-slate-400">
                    {currentXp} / {nextLevelXp} XP
                  </span>
                </div>
                <div className="w-full h-1.5 bg-slate-800 rounded-sm overflow-hidden">
                  <div
                    className="h-full bg-amber-400 transition-all duration-300"
                    style={{ width: `${xpPct}%` }}
                  />
                </div>
              </div>

              {/* Level Selector */}
              <div className="mb-4">
                <div className="flex items-center justify-between text-xs font-medium text-slate-400 mb-1.5">
                  <span>Maze Level (Harder at Higher Lv)</span>
                  <span className="text-slate-300">{levelScaling.label}</span>
                </div>
                <div className="flex items-center justify-between gap-2 bg-[#050811] border border-white/10 rounded-lg p-1.5">
                  <button
                    type="button"
                    disabled={selectedLevel <= 1}
                    onClick={() => onSelectLevel(Math.max(1, selectedLevel - 1))}
                    aria-label="Previous level"
                    className="w-8 h-8 flex items-center justify-center rounded-md bg-slate-900 hover:bg-slate-800 disabled:opacity-40 text-slate-200 cursor-pointer"
                  >
                    <ChevronLeft className="w-4 h-4" />
                  </button>
                  <div className="text-center">
                    <div className="text-sm font-semibold text-slate-100">
                      Level {selectedLevel} / {maxUnlockedLevel}
                    </div>
                    <div className="text-[11px] text-slate-400">
                      {levelScaling.mazeSize}×{levelScaling.mazeSize} · {levelScaling.ornamentCount} Stars ·{' '}
                      {levelScaling.batteryCount} Batteries · Santa {levelScaling.santaChaseSpeed} m/s
                    </div>
                  </div>
                  <button
                    type="button"
                    disabled={selectedLevel >= maxUnlockedLevel}
                    onClick={() => onSelectLevel(Math.min(maxUnlockedLevel, selectedLevel + 1))}
                    aria-label="Next level"
                    className="w-8 h-8 flex items-center justify-center rounded-md bg-slate-900 hover:bg-slate-800 disabled:opacity-40 text-slate-200 cursor-pointer"
                  >
                    <ChevronRight className="w-4 h-4" />
                  </button>
                </div>
              </div>

              {/* Difficulty Selector */}
              <div className="mb-5">
                <div className="text-xs font-medium text-slate-400 mb-1.5">Difficulty</div>
                <div className="grid grid-cols-3 gap-1.5 p-1 bg-[#050811] border border-white/10 rounded-lg">
                  {(['normal', 'nightmare', 'insane'] as DifficultyId[]).map((id) => {
                    const cfg = DIFFICULTIES[id];
                    const active = selectedDifficulty === id;
                    return (
                      <button
                        key={id}
                        type="button"
                        onClick={() => onSelectDifficulty(id)}
                        className={`px-2.5 py-2 text-xs font-medium rounded-md transition-colors truncate cursor-pointer ${
                          active
                            ? 'bg-red-700 text-white shadow-lg shadow-red-900/40'
                            : 'text-slate-300 hover:text-white hover:bg-white/5'
                        }`}
                      >
                        {cfg.label.split(' ')[0]}
                      </button>
                    );
                  })}
                </div>
                <p className="mt-1.5 text-xs text-slate-400">
                  {DIFFICULTIES[selectedDifficulty].description}
                </p>
              </div>

              <div className="flex flex-col gap-2.5">
                <button
                  type="button"
                  onClick={() => onStartSolo(selectedLevel)}
                  className="w-full py-3 px-6 bg-red-700 hover:bg-red-600 text-white text-base font-semibold rounded-lg transition-colors whitespace-nowrap cursor-pointer shadow-lg shadow-red-900/30"
                >
                  Play Level {selectedLevel} Solo
                </button>
                <button
                  type="button"
                  onClick={() => {
                    onSelectDifficulty('insane');
                    onSelectLevel(99);
                    onStartSolo(99);
                  }}
                  className="w-full py-2.5 px-5 bg-gradient-to-r from-red-900 via-rose-800 to-amber-900 hover:from-red-800 hover:to-amber-800 text-amber-200 text-xs font-bold rounded-lg transition-all tracking-wide uppercase border border-red-500/40 shadow-xl shadow-red-950/60 cursor-pointer flex items-center justify-center gap-2"
                >
                  <span>🔥 Play Level 99 Insane Abyss (Ultimate Hardcore)</span>
                </button>
              </div>
            </div>

            <div className="mt-5 pt-3.5 border-t border-white/10 flex flex-col gap-2.5 text-xs text-slate-400">
              <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
                {showMobileControls ? (
                  <>
                    <span>Left Stick Move</span>
                    <span aria-hidden="true">·</span>
                    <span>Drag Screen Look</span>
                    <span aria-hidden="true">·</span>
                    <span>Tap Buttons Act</span>
                  </>
                ) : (
                  <>
                    <span>WASD Move</span>
                    <span aria-hidden="true">·</span>
                    <span>Space Dodge</span>
                    <span aria-hidden="true">·</span>
                    <span>Click/G Weapon</span>
                    <span aria-hidden="true">·</span>
                    <span>F Light</span>
                    <span aria-hidden="true">·</span>
                    <span>C Chime Trail</span>
                    <span aria-hidden="true">·</span>
                    <span>Tab Map</span>
                  </>
                )}
              </div>

              <div className="flex items-center justify-between gap-2 pt-1">
                <span className="inline-flex items-center gap-1.5 text-[11px] text-slate-300">
                  {isMobileDevice ? (
                    <Smartphone className="w-3.5 h-3.5 text-emerald-400" />
                  ) : (
                    <Monitor className="w-3.5 h-3.5 text-sky-400" />
                  )}
                  <span>Detected: {isMobileDevice ? 'Mobile / Touch' : 'Desktop'}</span>
                </span>
                <div className="flex items-center gap-1 bg-[#050811] border border-white/10 rounded-md p-0.5 text-[11px]">
                  {(['auto', 'mobile', 'desktop'] as ControlScheme[]).map((scheme) => (
                    <button
                      key={scheme}
                      type="button"
                      onClick={() => onSetControlScheme(scheme)}
                      className={`px-2 py-0.5 rounded capitalize transition-colors cursor-pointer ${
                        controlScheme === scheme
                          ? 'bg-red-700 text-white font-medium'
                          : 'text-slate-400 hover:text-white'
                      }`}
                    >
                      {scheme}
                    </button>
                  ))}
                </div>
              </div>
            </div>
          </div>

          {/* Right Panel: Account, Customize, Friends & Online Co-op */}
          <div className="lg:col-span-7 bg-[#080d1a]/95 border border-white/15 rounded-xl p-5 sm:p-7 flex flex-col gap-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <h2 className="text-lg font-semibold text-slate-100">
                  {profile ? `${profile.displayName} · Lv ${profile.level}` : 'Online Co-op, Customize & Friends'}
                </h2>
                <p className="text-xs text-slate-400">
                  {profile
                    ? `${profile.escapes} Escapes · ${profile.gamesPlayed} Runs · Friend Code: ${profile.friendCode}`
                    : 'Sign in to unlock multiplayer rooms, survivor customization, friends, and cloud XP.'}
                </p>
              </div>
              {profile && (
                <button
                  type="button"
                  onClick={onSignOut}
                  className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-300 bg-slate-900 border border-white/12 rounded-lg hover:text-white hover:bg-slate-800 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
                >
                  <LogOut className="w-3.5 h-3.5" />
                  <span>Sign Out</span>
                </button>
              )}
            </div>

            {authLoading ? (
              <div className="py-12 text-center text-sm text-slate-400">
                Checking survivor account...
              </div>
            ) : !profile ? (
              <div className="flex-1 flex flex-col justify-center py-5 px-4 sm:px-6 bg-[#050811]/70 border border-white/10 rounded-xl">
                <div className="w-full max-w-md mx-auto">
                  <div className="flex items-center gap-2.5 mb-2">
                    <Users className="w-5 h-5 text-red-400 shrink-0" />
                    <h3 className="text-base font-semibold text-slate-100">
                      {authMode === 'signup' ? 'Create Your Survivor Account' : 'Sign In to Your Account'}
                    </h3>
                  </div>
                  <p className="text-xs text-slate-400 mb-4 leading-relaxed">
                    Customize your winter parka, scarf & hat, add friends by code, save your level XP,
                    and play online co-op.
                  </p>

                  {/* Mode Switcher: Sign In vs Create Account */}
                  <div className="grid grid-cols-2 gap-1 p-1 bg-[#080d1a] border border-white/10 rounded-lg mb-4">
                    <button
                      type="button"
                      onClick={() => handleSwitchAuthMode('login')}
                      className={`py-1.5 px-3 rounded-md text-xs font-medium transition-colors cursor-pointer ${
                        authMode === 'login'
                          ? 'bg-red-700 text-white'
                          : 'text-slate-300 hover:text-white hover:bg-white/5'
                      }`}
                    >
                      Sign In
                    </button>
                    <button
                      type="button"
                      onClick={() => handleSwitchAuthMode('signup')}
                      className={`py-1.5 px-3 rounded-md text-xs font-medium transition-colors cursor-pointer ${
                        authMode === 'signup'
                          ? 'bg-red-700 text-white'
                          : 'text-slate-300 hover:text-white hover:bg-white/5'
                      }`}
                    >
                      Create Account
                    </button>
                  </div>

                  {/* Email & Password Form */}
                  <form onSubmit={handleEmailAuthSubmit} className="space-y-3">
                    {authMode === 'signup' && (
                      <div>
                        <label
                          htmlFor="auth-survivor-name"
                          className="block text-[11px] font-medium text-slate-300 mb-1"
                        >
                          Survivor Name
                        </label>
                        <input
                          id="auth-survivor-name"
                          type="text"
                          required
                          minLength={2}
                          maxLength={24}
                          autoComplete="nickname"
                          value={authName}
                          onChange={(e) => setAuthName(e.target.value)}
                          placeholder="Enter your survivor name"
                          className="w-full px-3 py-2 text-sm text-slate-100 bg-[#080d1a] border border-white/15 rounded-lg placeholder:text-slate-500 focus:outline-none focus:border-red-500"
                        />
                      </div>
                    )}

                    <div>
                      <label
                        htmlFor="auth-email"
                        className="block text-[11px] font-medium text-slate-300 mb-1"
                      >
                        Email Address
                      </label>
                      <input
                        id="auth-email"
                        type="email"
                        required
                        autoComplete="email"
                        value={authEmail}
                        onChange={(e) => setAuthEmail(e.target.value)}
                        placeholder="you@example.com"
                        className="w-full px-3 py-2 text-sm text-slate-100 bg-[#080d1a] border border-white/15 rounded-lg placeholder:text-slate-500 focus:outline-none focus:border-red-500"
                      />
                    </div>

                    <div>
                      <div className="flex items-center justify-between mb-1">
                        <label
                          htmlFor="auth-password"
                          className="block text-[11px] font-medium text-slate-300"
                        >
                          Password
                        </label>
                        {authMode === 'login' && (
                          <button
                            type="button"
                            onClick={handleForgotPasswordClick}
                            disabled={authBusy}
                            className="text-[11px] text-slate-400 hover:text-slate-200 transition-colors cursor-pointer"
                          >
                            Forgot password?
                          </button>
                        )}
                      </div>
                      <div className="relative">
                        <input
                          id="auth-password"
                          type={showPassword ? 'text' : 'password'}
                          required
                          minLength={6}
                          autoComplete={authMode === 'signup' ? 'new-password' : 'current-password'}
                          value={authPassword}
                          onChange={(e) => setAuthPassword(e.target.value)}
                          placeholder={authMode === 'signup' ? 'At least 6 characters' : 'Enter password'}
                          className="w-full pl-3 pr-10 py-2 text-sm text-slate-100 bg-[#080d1a] border border-white/15 rounded-lg placeholder:text-slate-500 focus:outline-none focus:border-red-500"
                        />
                        <button
                          type="button"
                          onClick={() => setShowPassword((prev) => !prev)}
                          aria-label={showPassword ? 'Hide password' : 'Show password'}
                          className="absolute right-2.5 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-200 p-1 cursor-pointer"
                        >
                          {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                        </button>
                      </div>
                    </div>

                    <button
                      type="submit"
                      disabled={authBusy}
                      className="w-full flex items-center justify-center gap-2 px-4 py-2.5 bg-red-700 hover:bg-red-600 disabled:opacity-60 text-white text-sm font-semibold rounded-lg transition-colors cursor-pointer"
                    >
                      <Mail className="w-4 h-4" />
                      <span>
                        {authBusy
                          ? authMode === 'signup'
                            ? 'Creating Account...'
                            : 'Signing In...'
                          : authMode === 'signup'
                            ? 'Create Account'
                            : 'Sign In with Email'}
                      </span>
                    </button>
                  </form>

                  {resetSentMsg && (
                    <p className="mt-2.5 text-xs text-emerald-400 leading-relaxed">{resetSentMsg}</p>
                  )}
                  {authError && (
                    <p className="mt-2.5 text-xs text-red-400 leading-relaxed">{authError}</p>
                  )}

                  {/* Divider */}
                  <div className="relative my-4 flex items-center">
                    <div className="flex-grow border-t border-white/10" />
                    <span className="px-3 text-[11px] uppercase tracking-wider text-slate-500">or</span>
                    <div className="flex-grow border-t border-white/10" />
                  </div>

                  {/* Google Sign-In */}
                  <button
                    type="button"
                    disabled={authBusy}
                    onClick={onSignIn}
                    className="w-full flex items-center justify-center gap-2 px-4 py-2.5 bg-slate-900 hover:bg-slate-800 border border-white/15 disabled:opacity-60 text-slate-100 text-sm font-medium rounded-lg transition-colors whitespace-nowrap cursor-pointer"
                  >
                    <LogIn className="w-4 h-4 text-red-400" />
                    <span>Continue with Google</span>
                  </button>
                </div>
              </div>
            ) : (
              <>
                {/* Navigation Tabs */}
                <div className="grid grid-cols-3 gap-1.5 p-1 bg-[#050811] border border-white/10 rounded-lg">
                  <button
                    type="button"
                    onClick={() => setRightTab('coop')}
                    className={`flex items-center justify-center gap-1.5 py-2 px-3 rounded-md text-xs font-medium transition-colors whitespace-nowrap cursor-pointer ${
                      rightTab === 'coop'
                        ? 'bg-red-700 text-white'
                        : 'text-slate-300 hover:text-white hover:bg-white/5'
                    }`}
                  >
                    <Users className="w-3.5 h-3.5" />
                    <span>Co-op & Chat</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => setRightTab('customize')}
                    className={`flex items-center justify-center gap-1.5 py-2 px-3 rounded-md text-xs font-medium transition-colors whitespace-nowrap cursor-pointer ${
                      rightTab === 'customize'
                        ? 'bg-red-700 text-white'
                        : 'text-slate-300 hover:text-white hover:bg-white/5'
                    }`}
                  >
                    <Palette className="w-3.5 h-3.5" />
                    <span>Customize</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => setRightTab('friends')}
                    className={`flex items-center justify-center gap-1.5 py-2 px-3 rounded-md text-xs font-medium transition-colors whitespace-nowrap cursor-pointer ${
                      rightTab === 'friends'
                        ? 'bg-red-700 text-white'
                        : 'text-slate-300 hover:text-white hover:bg-white/5'
                    }`}
                  >
                    <UserPlus className="w-3.5 h-3.5" />
                    <span>
                      Friends ({acceptedFriends.length}
                      {incomingRequests.length > 0 ? ` +${incomingRequests.length}` : ''})
                    </span>
                  </button>
                </div>

                {/* TAB 1: CO-OP & GLOBAL CHAT */}
                {rightTab === 'coop' && (
                  <>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                      <form
                        onSubmit={handleCreateRoomSubmit}
                        className="bg-[#050811]/80 border border-white/10 rounded-lg p-3.5 flex flex-col gap-2.5"
                      >
                        <div className="flex items-center justify-between text-xs">
                          <span className="font-medium text-slate-300">Host New Room</span>
                          <span className="text-[11px] text-amber-300">Lv {selectedLevel}</span>
                        </div>
                        <input
                          type="text"
                          value={roomNameDraft}
                          maxLength={40}
                          onChange={(e) => setRoomNameDraft(e.target.value)}
                          placeholder={`${profile.displayName}'s Maze`}
                          className="bg-[#0b1120] border border-white/15 rounded-lg px-3 py-1.5 text-xs text-slate-100 placeholder-slate-500 focus:outline-none focus:border-red-500"
                        />
                        <div className="flex items-center justify-between gap-2">
                          <label className="flex items-center gap-2 text-xs text-slate-400 cursor-pointer select-none">
                            <input
                              type="checkbox"
                              checked={roomIsPublic}
                              onChange={(e) => setRoomIsPublic(e.target.checked)}
                              className="accent-red-600"
                            />
                            <span>Public room</span>
                          </label>
                          <button
                            type="submit"
                            disabled={roomBusy}
                            className="flex items-center gap-1.5 px-3 py-1.5 bg-red-700 hover:bg-red-600 disabled:opacity-50 text-white text-xs font-semibold rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer"
                          >
                            <Plus className="w-3.5 h-3.5" />
                            <span>Create</span>
                          </button>
                        </div>
                      </form>

                      <form
                        onSubmit={handleJoinCodeSubmit}
                        className="bg-[#050811]/80 border border-white/10 rounded-lg p-3.5 flex flex-col justify-between gap-2.5"
                      >
                        <div className="text-xs font-medium text-slate-300">Join by Room Code</div>
                        <div className="flex items-center gap-2">
                          <input
                            type="text"
                            value={joinCodeDraft}
                            maxLength={16}
                            onChange={(e) => setJoinCodeDraft(e.target.value.toUpperCase())}
                            placeholder="EVE-XXXXX"
                            className="flex-1 min-w-0 bg-[#0b1120] border border-white/15 rounded-lg px-3 py-1.5 text-xs font-mono-tabular uppercase text-slate-100 placeholder-slate-500 focus:outline-none focus:border-red-500"
                          />
                          <button
                            type="submit"
                            disabled={roomBusy || !joinCodeDraft.trim()}
                            className="px-3.5 py-1.5 bg-slate-800 hover:bg-slate-700 disabled:opacity-50 text-slate-100 text-xs font-medium rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer"
                          >
                            Join
                          </button>
                        </div>
                        {roomError && <p className="text-[11px] text-red-400">{roomError}</p>}
                      </form>
                    </div>

                    {/* Open Public Rooms */}
                    <div className="bg-[#050811]/80 border border-white/10 rounded-lg p-3.5">
                      <div className="flex items-center justify-between mb-2">
                        <span className="text-xs font-medium text-slate-300">Open Public Rooms</span>
                        <span className="text-[11px] text-slate-500">{publicRooms.length} active</span>
                      </div>
                      {publicRooms.length === 0 ? (
                        <p className="text-xs text-slate-500 py-2">
                          No public rooms open right now. Create one to invite friends!
                        </p>
                      ) : (
                        <div className="flex flex-col gap-1.5 max-h-28 overflow-y-auto pr-1">
                          {publicRooms.map((r) => (
                            <div
                              key={r.roomId}
                              className="flex items-center justify-between gap-3 bg-[#0b1120] border border-white/10 rounded-lg px-3 py-2 text-xs"
                            >
                              <div className="min-w-0">
                                <div className="font-medium text-slate-100 truncate">{r.name}</div>
                                <div className="text-[11px] text-slate-400 truncate">
                                  Host: {r.hostName} · Lv {r.level} ·{' '}
                                  <span className="capitalize">{r.difficulty}</span> · {r.playerCount}/12 ·{' '}
                                  {r.status === 'waiting' ? 'Lobby' : 'In Maze'}
                                </div>
                              </div>
                              <button
                                type="button"
                                disabled={roomBusy}
                                onClick={() => onJoinRoom(r.roomId)}
                                className="px-3 py-1 bg-red-700 hover:bg-red-600 text-white text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer"
                              >
                                Join
                              </button>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>

                    {/* Global Survivor Chat */}
                    <div className="bg-[#050811]/80 border border-white/10 rounded-lg p-3.5 flex flex-col gap-2">
                      <div className="flex items-center justify-between text-xs font-medium text-slate-300">
                        <div className="flex items-center gap-1.5">
                          <MessageSquare className="w-3.5 h-3.5 text-sky-400" />
                          <span>Global Survivor Chat</span>
                        </div>
                        <button
                          type="button"
                          onClick={() => void onClearGlobalChat()}
                          className="text-[10px] text-slate-400 hover:text-red-400 transition-colors cursor-pointer px-1.5 py-0.5 bg-white/5 hover:bg-white/10 rounded"
                        >
                          Clear Chat
                        </button>
                      </div>
                      <div
                        ref={globalChatScrollRef}
                        className="h-28 overflow-y-auto flex flex-col gap-1.5 bg-[#060913] border border-white/8 rounded-md p-2.5 text-xs"
                      >
                        {globalChat.length === 0 ? (
                          <p className="text-slate-500">No messages yet. Say hello to online players!</p>
                        ) : (
                          globalChat.map((m) => {
                            const isSelf = m.senderId === profile.uid;
                            const fStatus = friendStatusMap.get(m.senderId);
                            return (
                              <div
                                key={m.id}
                                className="flex items-start justify-between gap-2 leading-snug text-slate-200"
                              >
                                <div className="min-w-0 break-words">
                                  <span
                                    className="inline-block w-2 h-2 rounded-sm mr-1.5 align-middle"
                                    style={{ backgroundColor: m.coatColor }}
                                  />
                                  <span className="font-semibold text-slate-100 mr-1.5">{m.senderName}:</span>
                                  <span className="text-slate-300">{m.text}</span>
                                </div>
                                {!isSelf && !fStatus && m.senderId && (
                                  <button
                                    type="button"
                                    onClick={() => onAddFriendByUid(m.senderId)}
                                    title={`Add ${m.senderName} as friend`}
                                    className="text-slate-400 hover:text-sky-300 shrink-0 cursor-pointer"
                                  >
                                    <UserPlus className="w-3.5 h-3.5" />
                                  </button>
                                )}
                              </div>
                            );
                          })
                        )}
                      </div>
                      <form onSubmit={handleSendGlobal} className="flex items-center gap-2">
                        <input
                          type="text"
                          value={globalMsgDraft}
                          maxLength={240}
                          onChange={(e) => setGlobalMsgDraft(e.target.value)}
                          placeholder="Chat with online survivors..."
                          className="flex-1 min-w-0 bg-[#0b1120] border border-white/15 rounded-lg px-3 py-1.5 text-xs text-slate-100 placeholder-slate-500 focus:outline-none focus:border-red-500"
                        />
                        <button
                          type="submit"
                          disabled={!globalMsgDraft.trim()}
                          aria-label="Send global chat message"
                          className="flex items-center gap-1 px-3 py-1.5 bg-slate-800 hover:bg-slate-700 disabled:opacity-50 text-slate-100 text-xs font-medium rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer"
                        >
                          <Send className="w-3.5 h-3.5" />
                          <span>Send</span>
                        </button>
                      </form>
                    </div>
                  </>
                )}

                {/* TAB 2: PLAYER CUSTOMIZATION */}
                {rightTab === 'customize' && (
                  <form
                    onSubmit={handleSaveAccount}
                    className="bg-[#050811]/80 border border-white/10 rounded-lg p-4 flex flex-col sm:flex-row gap-5"
                  >
                    <SurvivorAvatarPreview
                      coatColor={coatDraft}
                      scarfColor={scarfDraft}
                      hatStyle={hatDraft}
                      name={nameDraft}
                    />

                    <div className="flex-1 flex flex-col gap-3.5">
                      <div>
                        <label className="block text-xs font-medium text-slate-300 mb-1">
                          Survivor Callsign
                        </label>
                        <input
                          type="text"
                          value={nameDraft}
                          minLength={2}
                          maxLength={24}
                          onChange={(e) => setNameDraft(e.target.value)}
                          placeholder="Callsign"
                          className="w-full bg-[#0b1120] border border-white/15 rounded-lg px-3 py-2 text-sm text-slate-100 focus:outline-none focus:border-red-500"
                        />
                      </div>

                      <div>
                        <div className="text-xs font-medium text-slate-300 mb-1.5">Parka Color</div>
                        <div className="flex flex-wrap items-center gap-2">
                          {COAT_COLORS.map((c) => (
                            <button
                              key={c.hex}
                              type="button"
                              onClick={() => setCoatDraft(c.hex)}
                              title={c.name}
                              className={`w-7 h-7 rounded-md border-2 transition-transform cursor-pointer ${
                                coatDraft === c.hex
                                  ? 'border-white scale-110'
                                  : 'border-transparent opacity-75 hover:opacity-100'
                              }`}
                              style={{ backgroundColor: c.hex }}
                            />
                          ))}
                        </div>
                      </div>

                      <div>
                        <div className="text-xs font-medium text-slate-300 mb-1.5">Scarf Color</div>
                        <div className="flex flex-wrap items-center gap-2">
                          {SCARF_COLORS.map((c) => (
                            <button
                              key={c.hex}
                              type="button"
                              onClick={() => setScarfDraft(c.hex)}
                              title={c.name}
                              className={`w-7 h-7 rounded-md border-2 transition-transform cursor-pointer ${
                                scarfDraft === c.hex
                                  ? 'border-white scale-110'
                                  : 'border-transparent opacity-75 hover:opacity-100'
                              }`}
                              style={{ backgroundColor: c.hex }}
                            />
                          ))}
                        </div>
                      </div>

                      <div>
                        <div className="text-xs font-medium text-slate-300 mb-1.5">Headgear Style</div>
                        <div className="grid grid-cols-2 gap-2">
                          {HAT_STYLES.map((h) => (
                            <button
                              key={h.id}
                              type="button"
                              onClick={() => setHatDraft(h.id)}
                              className={`px-3 py-1.5 rounded-lg border text-xs font-medium transition-colors whitespace-nowrap cursor-pointer ${
                                hatDraft === h.id
                                  ? 'bg-red-700/90 border-red-400 text-white'
                                  : 'bg-[#0b1120] border-white/12 text-slate-300 hover:text-white'
                              }`}
                            >
                              {h.label}
                            </button>
                          ))}
                        </div>
                      </div>

                      <div className="pt-1 flex items-center justify-end gap-3">
                        {accountSavedMsg && (
                          <span className="text-xs text-emerald-400 font-medium">Appearance saved!</span>
                        )}
                        <button
                          type="submit"
                          disabled={savingAccount || nameDraft.trim().length < 2}
                          className="px-4 py-2 bg-red-700 hover:bg-red-600 disabled:opacity-50 text-white text-xs font-semibold rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer"
                        >
                          {savingAccount ? 'Saving...' : 'Save Customization'}
                        </button>
                      </div>
                    </div>
                  </form>
                )}

                {/* TAB 3: FRIENDS & REQUESTS */}
                {rightTab === 'friends' && (
                  <div className="flex flex-col gap-3">
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                      {/* My Friend Code */}
                      <div className="bg-[#050811]/80 border border-white/10 rounded-lg p-3.5 flex flex-col justify-between gap-2">
                        <div className="text-xs font-medium text-slate-300">Your Friend Code</div>
                        <div className="flex items-center justify-between gap-2 bg-[#0b1120] border border-white/15 rounded-lg px-3 py-2">
                          <span className="font-mono-tabular text-sm font-semibold text-amber-300">
                            {profile.friendCode}
                          </span>
                          <button
                            type="button"
                            onClick={handleCopyFriendCode}
                            className="flex items-center gap-1 text-xs text-slate-300 hover:text-white cursor-pointer"
                          >
                            {copiedFriendCode ? (
                              <>
                                <Check className="w-3.5 h-3.5 text-emerald-400" />
                                <span className="text-emerald-400">Copied</span>
                              </>
                            ) : (
                              <>
                                <Copy className="w-3.5 h-3.5" />
                                <span>Copy</span>
                              </>
                            )}
                          </button>
                        </div>
                      </div>

                      {/* Add Friend by Code */}
                      <form
                        onSubmit={handleAddFriendCodeSubmit}
                        className="bg-[#050811]/80 border border-white/10 rounded-lg p-3.5 flex flex-col justify-between gap-2"
                      >
                        <div className="text-xs font-medium text-slate-300">Add Friend by Code</div>
                        <div className="flex items-center gap-2">
                          <input
                            type="text"
                            value={friendCodeInput}
                            maxLength={16}
                            onChange={(e) => setFriendCodeInput(e.target.value.toUpperCase())}
                            placeholder="SV-XXXXXX"
                            className="flex-1 min-w-0 bg-[#0b1120] border border-white/15 rounded-lg px-3 py-1.5 text-xs font-mono-tabular uppercase text-slate-100 placeholder-slate-500 focus:outline-none focus:border-red-500"
                          />
                          <button
                            type="submit"
                            disabled={friendBusy || !friendCodeInput.trim()}
                            className="px-3 py-1.5 bg-red-700 hover:bg-red-600 disabled:opacity-50 text-white text-xs font-semibold rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer"
                          >
                            Add
                          </button>
                        </div>
                      </form>
                    </div>

                    {friendError && <p className="text-xs text-red-400">{friendError}</p>}
                    {friendNotice && <p className="text-xs text-emerald-400">{friendNotice}</p>}

                    {/* Incoming Requests */}
                    {incomingRequests.length > 0 && (
                      <div className="bg-[#050811]/80 border border-amber-400/25 rounded-lg p-3.5">
                        <div className="text-xs font-semibold text-amber-300 mb-2">
                          Incoming Friend Requests ({incomingRequests.length})
                        </div>
                        <div className="flex flex-col gap-1.5">
                          {incomingRequests.map((f) => (
                            <div
                              key={f.friendUid}
                              className="flex items-center justify-between gap-2 bg-[#0b1120] border border-white/10 rounded-md px-3 py-2 text-xs"
                            >
                              <div className="flex items-center gap-2 min-w-0">
                                <span
                                  className="w-3 h-3 rounded-sm shrink-0"
                                  style={{ backgroundColor: f.coatColor }}
                                />
                                <span className="font-medium text-slate-100 truncate">{f.displayName}</span>
                                <span className="text-slate-400 shrink-0">Lv {f.level}</span>
                              </div>
                              <div className="flex items-center gap-1.5 shrink-0">
                                <button
                                  type="button"
                                  onClick={() => onAcceptFriend(f.friendUid)}
                                  className="px-2.5 py-1 bg-emerald-600 hover:bg-emerald-500 text-white rounded text-xs font-medium cursor-pointer"
                                >
                                  Accept
                                </button>
                                <button
                                  type="button"
                                  onClick={() => onRemoveFriend(f.friendUid)}
                                  aria-label="Decline friend request"
                                  className="p-1 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded cursor-pointer"
                                >
                                  <X className="w-3.5 h-3.5" />
                                </button>
                              </div>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}

                    {/* Accepted Friends & Outgoing */}
                    <div className="bg-[#050811]/80 border border-white/10 rounded-lg p-3.5">
                      <div className="text-xs font-medium text-slate-300 mb-2">
                        Survivor Friends ({acceptedFriends.length})
                      </div>
                      {acceptedFriends.length === 0 && sentRequests.length === 0 ? (
                        <p className="text-xs text-slate-500 py-3">
                          No friends added yet. Share your code ({profile.friendCode}) or click + next to
                          players in chat!
                        </p>
                      ) : (
                        <div className="flex flex-col gap-1.5 max-h-44 overflow-y-auto pr-1">
                          {acceptedFriends.map((f) => (
                            <div
                              key={f.friendUid}
                              className="flex items-center justify-between gap-2 bg-[#0b1120] border border-white/10 rounded-md px-3 py-2 text-xs"
                            >
                              <div className="flex items-center gap-2 min-w-0">
                                <span
                                  className="w-3 h-3 rounded-sm shrink-0"
                                  style={{ backgroundColor: f.coatColor }}
                                />
                                <span className="font-medium text-slate-100 truncate">{f.displayName}</span>
                                <span className="text-[11px] text-amber-300 shrink-0">Lv {f.level}</span>
                                <span className="text-[11px] text-slate-500 font-mono-tabular shrink-0">
                                  {f.friendCode}
                                </span>
                              </div>
                              <button
                                type="button"
                                onClick={() => onRemoveFriend(f.friendUid)}
                                className="text-[11px] text-slate-400 hover:text-red-400 cursor-pointer shrink-0"
                              >
                                Remove
                              </button>
                            </div>
                          ))}
                          {sentRequests.map((f) => (
                            <div
                              key={f.friendUid}
                              className="flex items-center justify-between gap-2 bg-[#0b1120]/70 border border-white/8 rounded-md px-3 py-2 text-xs text-slate-400"
                            >
                              <span className="truncate">Pending request → {f.displayName}</span>
                              <button
                                type="button"
                                onClick={() => onRemoveFriend(f.friendUid)}
                                className="text-[11px] text-slate-400 hover:text-slate-200 cursor-pointer shrink-0"
                              >
                                Cancel
                              </button>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>
                )}
              </>
            )}
          </div>
        </div>
      </div>
    );
  }

  // Waiting Room Lobby
  if (hud.phase === 'waiting' && activeRoom) {
    const roomScaling = getLevelScaling(activeRoom.level, activeRoom.difficulty);
    return (
      <div className="fixed inset-0 z-20 flex items-start sm:items-center justify-center bg-[#050811]/86 px-3 sm:px-6 py-4 sm:py-6 overflow-y-auto touch-pan-y">
        <div className="max-w-3xl w-full bg-[#080d1a]/96 border border-white/15 rounded-xl p-5 sm:p-8 flex flex-col gap-5 sm:gap-6 my-auto">
          <div className="flex flex-wrap items-start justify-between gap-4 border-b border-white/10 pb-4">
            <div>
              <p className="text-xs font-medium text-red-400 mb-1">Online Staging Lobby</p>
              <h2 className="font-display text-3xl font-bold text-slate-50">{activeRoom.name}</h2>
              <p className="text-xs text-slate-400 mt-1">
                Level {activeRoom.level} ·{' '}
                <span className="capitalize text-slate-200">{activeRoom.difficulty}</span> ·{' '}
                {activeRoom.ornamentsTotal} Ornaments · {roomScaling.mazeSize}×{roomScaling.mazeSize} Labyrinth
              </p>
            </div>
            <div className="flex items-center gap-2 bg-[#050811] border border-white/15 rounded-lg px-3 py-2">
              <span className="text-xs text-slate-400">Room Code</span>
              <span className="font-mono-tabular text-sm font-semibold text-amber-300">
                {activeRoom.roomId}
              </span>
              <button
                type="button"
                onClick={handleCopyCode}
                aria-label="Copy room code"
                className="text-slate-300 hover:text-white cursor-pointer"
              >
                {copiedCode ? <Check className="w-4 h-4 text-emerald-400" /> : <Copy className="w-4 h-4" />}
              </button>
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-12 gap-5">
            {/* Players List */}
            <div className="md:col-span-5 bg-[#050811]/80 border border-white/10 rounded-lg p-4 flex flex-col gap-2.5">
              <div className="flex items-center justify-between text-xs font-medium text-slate-300">
                <span>Survivors ({roomPlayers.length}/12)</span>
              </div>
              <div className="flex flex-col gap-2 max-h-56 overflow-y-auto">
                {roomPlayers.map((p) => {
                  const isSelf = profile && p.uid === profile.uid;
                  const fStatus = friendStatusMap.get(p.uid);
                  return (
                    <div
                      key={p.uid}
                      className="flex items-center justify-between gap-2 bg-[#0b1120] border border-white/10 rounded-md px-3 py-2 text-xs"
                    >
                      <div className="flex items-center gap-2 min-w-0">
                        <span
                          className="w-3 h-3 rounded-sm shrink-0"
                          style={{ backgroundColor: p.coatColor }}
                        />
                        <span className="text-slate-100 font-medium truncate">{p.displayName}</span>
                      </div>
                      <div className="flex items-center gap-2 shrink-0">
                        {p.uid === activeRoom.hostId && (
                          <span className="text-[11px] text-amber-300 font-medium">Host</span>
                        )}
                        {!isSelf && profile && (
                          fStatus === 'accepted' ? (
                            <span title="Friend" className="inline-flex">
                              <UserCheck className="w-3.5 h-3.5 text-emerald-400" />
                            </span>
                          ) : !fStatus ? (
                            <button
                              type="button"
                              onClick={() => onAddFriendByUid(p.uid)}
                              title={`Add ${p.displayName} as friend`}
                              className="text-slate-400 hover:text-sky-300 cursor-pointer"
                            >
                              <UserPlus className="w-3.5 h-3.5" />
                            </button>
                          ) : null
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>

            {/* Room Chat */}
            <div className="md:col-span-7 bg-[#050811]/80 border border-white/10 rounded-lg p-4 flex flex-col gap-2.5">
              <div className="text-xs font-medium text-slate-300">Room Chat</div>
              <div
                ref={roomChatScrollRef}
                className="h-44 overflow-y-auto flex flex-col gap-1.5 bg-[#060913] border border-white/8 rounded-md p-3 text-xs"
              >
                {roomChat.length === 0 ? (
                  <p className="text-slate-500">Coordinate your strategy before entering the maze.</p>
                ) : (
                  roomChat.map((m) => (
                    <div key={m.id} className="leading-snug break-words text-slate-200">
                      <span
                        className="inline-block w-2 h-2 rounded-sm mr-1.5 align-middle"
                        style={{ backgroundColor: m.coatColor }}
                      />
                      <span className="font-semibold text-slate-100 mr-1.5">{m.senderName}:</span>
                      <span className="text-slate-300">{m.text}</span>
                    </div>
                  ))
                )}
              </div>
              <form onSubmit={handleSendRoom} className="flex items-center gap-2">
                <input
                  type="text"
                  value={roomMsgDraft}
                  maxLength={240}
                  onChange={(e) => setRoomMsgDraft(e.target.value)}
                  placeholder="Message room..."
                  className="flex-1 min-w-0 bg-[#0b1120] border border-white/15 rounded-lg px-3 py-1.5 text-xs text-slate-100 placeholder-slate-500 focus:outline-none focus:border-red-500"
                />
                <button
                  type="submit"
                  disabled={!roomMsgDraft.trim()}
                  className="flex items-center gap-1 px-3 py-1.5 bg-slate-800 hover:bg-slate-700 disabled:opacity-50 text-slate-100 text-xs font-medium rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer"
                >
                  <Send className="w-3.5 h-3.5" />
                  <span>Send</span>
                </button>
              </form>
            </div>
          </div>

          <div className="flex flex-wrap items-center justify-between gap-3 pt-2 border-t border-white/10">
            <button
              type="button"
              onClick={onLeaveRoom}
              className="px-4 py-2.5 bg-slate-800 hover:bg-slate-700 text-slate-200 text-sm font-medium rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer"
            >
              Leave Room
            </button>

            {hud.isHost ? (
              <button
                type="button"
                onClick={onStartRoomMatch}
                className="flex items-center gap-2 px-6 py-2.5 bg-red-700 hover:bg-red-600 text-white text-sm font-semibold rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer"
              >
                <Play className="w-4 h-4" />
                <span>Start Level {activeRoom.level}</span>
              </button>
            ) : (
              <span className="text-sm text-slate-300">
                Waiting for {activeRoom.hostName} to start Level {activeRoom.level}...
              </span>
            )}
          </div>
        </div>
      </div>
    );
  }

  if (hud.phase === 'paused') {
    return (
      <div className="fixed inset-0 z-20 flex items-center justify-center bg-[#050811]/82 px-4 sm:px-6 overflow-y-auto touch-pan-y">
        <div className="max-w-sm w-full bg-[#080d1a]/96 border border-white/15 rounded-xl p-6 sm:p-8 text-center my-auto">
          <h2 className="font-display text-3xl font-bold text-slate-100 mb-2">
            {hud.isMultiplayer ? 'Match Menu' : 'Paused'}
          </h2>
          <p className="text-sm text-slate-400 mb-5">
            Level {hud.level} · Ornaments {hud.ornamentsCollected} / {hud.ornamentsTotal} ·{' '}
            {formatTime(hud.elapsedSeconds)}
          </p>

          <div className="mb-5 bg-[#050811]/90 border border-white/10 rounded-lg p-2.5 flex items-center justify-between gap-2 text-xs">
            <span className="text-slate-300">Controls</span>
            <div className="flex items-center gap-1 bg-[#0b1120] border border-white/10 rounded-md p-0.5 text-[11px]">
              {(['auto', 'mobile', 'desktop'] as ControlScheme[]).map((scheme) => (
                <button
                  key={scheme}
                  type="button"
                  onClick={() => onSetControlScheme(scheme)}
                  className={`px-2 py-0.5 rounded capitalize transition-colors cursor-pointer ${
                    controlScheme === scheme
                      ? 'bg-red-700 text-white font-medium'
                      : 'text-slate-400 hover:text-white'
                  }`}
                >
                  {scheme}
                </button>
              ))}
            </div>
          </div>

          <div className="flex flex-col gap-3">
            <button
              type="button"
              onClick={onResume}
              className="w-full py-3 px-5 bg-red-700 hover:bg-red-600 text-white text-sm font-semibold rounded-lg transition-colors whitespace-nowrap cursor-pointer"
            >
              Resume
            </button>
            {!hud.isMultiplayer && (
              <button
                type="button"
                onClick={() => onStartSolo(hud.level)}
                className="w-full py-3 px-5 bg-slate-800 hover:bg-slate-700 text-slate-100 text-sm font-medium rounded-lg transition-colors whitespace-nowrap cursor-pointer"
              >
                Restart Level {hud.level}
              </button>
            )}
            <button
              type="button"
              onClick={hud.isMultiplayer ? onLeaveRoom : onReturnMenu}
              className="w-full py-2.5 px-5 text-slate-300 hover:text-white text-sm font-medium rounded-lg transition-colors whitespace-nowrap cursor-pointer"
            >
              {hud.isMultiplayer ? 'Leave Room' : 'Main Menu'}
            </button>
          </div>
        </div>
      </div>
    );
  }

  if (hud.phase === 'caught') {
    return (
      <div className="fixed inset-0 z-20 flex items-center justify-center bg-[#180306]/88 px-6">
        <div className="max-w-md w-full bg-[#0c0609]/96 border border-red-500/35 rounded-xl p-8 text-center">
          <p className="text-xs font-medium text-red-400 mb-2">Level {hud.level} · Claimed by the North Pole</p>
          <h2 className="font-display text-4xl font-bold text-red-100 mb-3">Santa Found You</h2>
          <p className="text-sm text-slate-300 mb-4">
            Recovered {hud.ornamentsCollected} of {hud.ornamentsTotal} ornaments in{' '}
            <span className="font-mono-tabular text-slate-100">{formatTime(hud.elapsedSeconds)}</span>.
          </p>
          {lastMatchReward && (
            <div className="mb-5 text-xs bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-amber-200">
              +{lastMatchReward.earnedXp} XP earned
              {lastMatchReward.leveledUp ? ` · Level Up! Reached Level ${lastMatchReward.newLevel}!` : ''}
            </div>
          )}
          <div className="flex flex-col sm:flex-row gap-3">
            {!hud.isMultiplayer && (
              <button
                type="button"
                onClick={() => onStartSolo(hud.level)}
                className="flex-1 py-3 px-5 bg-red-700 hover:bg-red-600 text-white text-sm font-semibold rounded-lg transition-colors whitespace-nowrap cursor-pointer"
              >
                Retry Level {hud.level}
              </button>
            )}
            <button
              type="button"
              onClick={hud.isMultiplayer ? onLeaveRoom : onReturnMenu}
              className="flex-1 py-3 px-5 bg-slate-800 hover:bg-slate-700 text-slate-100 text-sm font-medium rounded-lg transition-colors whitespace-nowrap cursor-pointer"
            >
              {hud.isMultiplayer ? 'Return to Lobby' : 'Main Menu'}
            </button>
          </div>
        </div>
      </div>
    );
  }

  // Escaped / Victory
  const nextSoloLevel = Math.min(99, hud.level + 1);
  return (
    <div className="fixed inset-0 z-20 flex items-center justify-center bg-[#041410]/86 px-6">
      <div className="max-w-md w-full bg-[#071210]/96 border border-emerald-400/35 rounded-xl p-8 text-center">
        <p className="text-xs font-medium text-emerald-400 mb-2">Level {hud.level} Cleared</p>
        <h2 className="font-display text-4xl font-bold text-emerald-50 mb-3">You Escaped</h2>
        <p className="text-sm text-slate-300 mb-4">
          All {hud.ornamentsTotal} ornaments recovered on <span className="capitalize">{hud.difficulty}</span>{' '}
          in <span className="font-mono-tabular text-emerald-200">{formatTime(hud.elapsedSeconds)}</span>.
        </p>
        {lastMatchReward && (
          <div className="mb-5 text-xs bg-emerald-500/12 border border-emerald-400/30 rounded-lg px-3 py-2 text-emerald-200">
            +{lastMatchReward.earnedXp} XP earned
            {lastMatchReward.leveledUp
              ? ` · Level Up! Unlocked Level ${lastMatchReward.newLevel}!`
              : ` · Level ${maxUnlockedLevel}`}
          </div>
        )}
        <div className="flex flex-col sm:flex-row gap-3">
          {!hud.isMultiplayer && (
            <button
              type="button"
              onClick={() => onStartSolo(nextSoloLevel)}
              className="flex-1 py-3 px-5 bg-emerald-600 hover:bg-emerald-500 text-white text-sm font-semibold rounded-lg transition-colors whitespace-nowrap cursor-pointer"
            >
              Next Level (Lv {nextSoloLevel})
            </button>
          )}
          <button
            type="button"
            onClick={hud.isMultiplayer ? onLeaveRoom : onReturnMenu}
            className="flex-1 py-3 px-5 bg-slate-800 hover:bg-slate-700 text-slate-100 text-sm font-medium rounded-lg transition-colors whitespace-nowrap cursor-pointer"
          >
            {hud.isMultiplayer ? 'Return to Lobby' : 'Main Menu'}
          </button>
        </div>
      </div>
    </div>
  );
};
