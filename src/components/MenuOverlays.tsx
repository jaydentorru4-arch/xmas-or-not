import React, { useEffect, useRef, useState } from 'react';
import {
  Check,
  Copy,
  LogIn,
  LogOut,
  MessageSquare,
  Play,
  Plus,
  Send,
  Users,
} from 'lucide-react';
import {
  COAT_COLORS,
  ChatMessageData,
  DIFFICULTIES,
  DifficultyId,
  GameRoomData,
  HudSnapshot,
  RoomPlayerData,
  SurvivorProfile,
} from '../game/types';

interface MenuOverlaysProps {
  hud: HudSnapshot;
  selectedDifficulty: DifficultyId;
  onSelectDifficulty: (id: DifficultyId) => void;
  onStartSolo: () => void;
  onResume: () => void;
  onReturnMenu: () => void;

  // Auth & Account
  authLoading: boolean;
  authError: string | null;
  profile: SurvivorProfile | null;
  onSignIn: () => Promise<void>;
  onSignOut: () => Promise<void>;
  onUpdateAccount: (displayName: string, coatColor: string) => Promise<void>;

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
}

function formatTime(sec: number): string {
  const whole = Math.max(0, Math.floor(sec));
  const m = Math.floor(whole / 60);
  const s = whole % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

export const MenuOverlays: React.FC<MenuOverlaysProps> = ({
  hud,
  selectedDifficulty,
  onSelectDifficulty,
  onStartSolo,
  onResume,
  onReturnMenu,
  authLoading,
  authError,
  profile,
  onSignIn,
  onSignOut,
  onUpdateAccount,
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
}) => {
  const [nameDraft, setNameDraft] = useState(profile?.displayName || '');
  const [colorDraft, setColorDraft] = useState(profile?.coatColor || COAT_COLORS[0].hex);
  const [savingAccount, setSavingAccount] = useState(false);
  const [accountSavedMsg, setAccountSavedMsg] = useState(false);

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
      setColorDraft(profile.coatColor);
    }
  }, [profile?.uid, profile?.displayName, profile?.coatColor]);

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

  const handleSaveAccount = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!profile || savingAccount) return;
    setSavingAccount(true);
    try {
      await onUpdateAccount(nameDraft, colorDraft);
      setAccountSavedMsg(true);
      window.setTimeout(() => setAccountSavedMsg(false), 2000);
    } finally {
      setSavingAccount(false);
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

  if (hud.phase === 'menu') {
    return (
      <div className="fixed inset-0 z-20 flex items-center justify-center bg-gradient-to-t from-[#050811]/92 via-[#050811]/72 to-[#050811]/80 px-4 sm:px-6 py-6 overflow-y-auto">
        <div className="max-w-5xl w-full grid grid-cols-1 lg:grid-cols-12 gap-5 my-auto">
          {/* Left Panel: Solo Entry & Controls */}
          <div className="lg:col-span-5 bg-[#080d1a]/95 border border-white/15 rounded-xl p-6 sm:p-8 flex flex-col justify-between">
            <div>
              <p className="text-xs font-medium tracking-wide text-red-400 mb-2">
                First-Person Labyrinth Survival
              </p>
              <h1 className="font-display text-4xl sm:text-5xl font-bold text-slate-50 tracking-tight mb-3 [text-wrap:balance]">
                Hollow Eve
              </h1>
              <p className="text-sm text-slate-300 leading-relaxed mb-6">
                Trapped inside a 27×27 frostbitten North Pole hedge maze at midnight, recover cursed
                star ornaments to unseal the exit gate, dodge around corners to lose Evil Santa, and
                grab 60s weapon drops to knock him out for 30 seconds.
              </p>

              {/* Difficulty Selector */}
              <div className="mb-6">
                <div className="text-xs font-medium text-slate-400 mb-2">Difficulty</div>
                <div className="grid grid-cols-2 gap-2 p-1 bg-[#050811] border border-white/10 rounded-lg">
                  {(['normal', 'nightmare'] as DifficultyId[]).map((id) => {
                    const cfg = DIFFICULTIES[id];
                    const active = selectedDifficulty === id;
                    return (
                      <button
                        key={id}
                        type="button"
                        onClick={() => onSelectDifficulty(id)}
                        className={`px-4 py-2 text-sm font-medium rounded-md transition-colors whitespace-nowrap cursor-pointer ${
                          active
                            ? 'bg-red-700 text-white'
                            : 'text-slate-300 hover:text-white hover:bg-white/5'
                        }`}
                      >
                        {cfg.label}
                      </button>
                    );
                  })}
                </div>
                <p className="mt-2 text-xs text-slate-400">
                  {DIFFICULTIES[selectedDifficulty].description}
                </p>
              </div>

              <button
                type="button"
                onClick={onStartSolo}
                className="w-full py-3 px-6 bg-red-700 hover:bg-red-600 text-white text-base font-semibold rounded-lg transition-colors whitespace-nowrap cursor-pointer"
              >
                Play Solo
              </button>
            </div>

            <div className="mt-6 pt-4 border-t border-white/10 flex flex-wrap items-center gap-x-2.5 gap-y-1 text-xs text-slate-400">
              <span>WASD Move</span>
              <span aria-hidden="true">·</span>
              <span>Mouse / Q-E Look</span>
              <span aria-hidden="true">·</span>
              <span>Shift Sprint</span>
              <span aria-hidden="true">·</span>
              <span>Space Dodge</span>
              <span aria-hidden="true">·</span>
              <span>Click/G Weapon</span>
              <span aria-hidden="true">·</span>
              <span>F Light</span>
              <span aria-hidden="true">·</span>
              <span>C Chime</span>
              <span aria-hidden="true">·</span>
              <span>T Chat</span>
            </div>
          </div>

          {/* Right Panel: Survivor Account, Online Co-op & Global Chat */}
          <div className="lg:col-span-7 bg-[#080d1a]/95 border border-white/15 rounded-xl p-6 sm:p-7 flex flex-col gap-5">
            <div className="flex items-center justify-between gap-3">
              <div>
                <h2 className="text-lg font-semibold text-slate-100">Online Co-op & Lobby Chat</h2>
                <p className="text-xs text-slate-400">
                  Team up with online survivors in the same maze and coordinate in real time.
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
              <div className="flex-1 flex flex-col items-center justify-center text-center py-8 px-4 bg-[#050811]/70 border border-white/10 rounded-xl">
                <Users className="w-9 h-9 text-red-400 mb-3" />
                <h3 className="text-base font-semibold text-slate-100 mb-1.5">
                  Create Your Survivor Account
                </h3>
                <p className="text-xs text-slate-400 max-w-sm mb-5 leading-relaxed">
                  Sign in with Google to set your survivor callsign, customize your winter parka,
                  host or join multiplayer rooms, and chat with players online.
                </p>
                <button
                  type="button"
                  onClick={onSignIn}
                  className="flex items-center gap-2 px-5 py-2.5 bg-red-700 hover:bg-red-600 text-white text-sm font-semibold rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer"
                >
                  <LogIn className="w-4 h-4" />
                  <span>Sign in with Google</span>
                </button>
                {authError && (
                  <p className="mt-3 text-xs text-red-400 max-w-sm">{authError}</p>
                )}
              </div>
            ) : (
              <>
                {/* Account Customization Bar */}
                <form
                  onSubmit={handleSaveAccount}
                  className="bg-[#050811]/80 border border-white/10 rounded-lg p-3.5 flex flex-col gap-3"
                >
                  <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
                    <span className="font-medium text-slate-300">Survivor Account</span>
                    <span className="font-mono-tabular text-slate-400">
                      {profile.escapes} Escapes · {profile.gamesPlayed} Runs
                    </span>
                  </div>
                  <div className="flex flex-wrap items-center gap-2.5">
                    <input
                      type="text"
                      value={nameDraft}
                      minLength={2}
                      maxLength={24}
                      onChange={(e) => setNameDraft(e.target.value)}
                      placeholder="Callsign"
                      className="flex-1 min-w-[140px] bg-[#0b1120] border border-white/15 rounded-lg px-3 py-1.5 text-sm text-slate-100 focus:outline-none focus:border-red-500"
                    />
                    <div className="flex items-center gap-1.5">
                      {COAT_COLORS.map((c) => (
                        <button
                          key={c.hex}
                          type="button"
                          onClick={() => setColorDraft(c.hex)}
                          title={c.name}
                          aria-label={`Parka color ${c.name}`}
                          className={`w-6 h-6 rounded-md border-2 transition-transform cursor-pointer ${
                            colorDraft === c.hex ? 'border-white scale-110' : 'border-transparent opacity-75 hover:opacity-100'
                          }`}
                          style={{ backgroundColor: c.hex }}
                        />
                      ))}
                    </div>
                    <button
                      type="submit"
                      disabled={savingAccount || nameDraft.trim().length < 2}
                      className="px-3 py-1.5 bg-slate-800 hover:bg-slate-700 disabled:opacity-50 text-slate-100 text-xs font-medium rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer"
                    >
                      {accountSavedMsg ? 'Saved' : savingAccount ? 'Saving...' : 'Save'}
                    </button>
                  </div>
                </form>

                {/* Create & Join Rooms */}
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <form
                    onSubmit={handleCreateRoomSubmit}
                    className="bg-[#050811]/80 border border-white/10 rounded-lg p-3.5 flex flex-col gap-2.5"
                  >
                    <div className="text-xs font-medium text-slate-300">Host New Room</div>
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
                      No public rooms open right now. Create one to invite others!
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
                              Host: {r.hostName} · <span className="capitalize">{r.difficulty}</span> ·{' '}
                              {r.playerCount}/12 · {r.status === 'waiting' ? 'Lobby' : 'In Maze'}
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
                  <div className="flex items-center gap-1.5 text-xs font-medium text-slate-300">
                    <MessageSquare className="w-3.5 h-3.5 text-sky-400" />
                    <span>Global Survivor Chat</span>
                  </div>
                  <div
                    ref={globalChatScrollRef}
                    className="h-28 overflow-y-auto flex flex-col gap-1 bg-[#060913] border border-white/8 rounded-md p-2.5 text-xs"
                  >
                    {globalChat.length === 0 ? (
                      <p className="text-slate-500">No messages yet. Say hello to online players!</p>
                    ) : (
                      globalChat.map((m) => (
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
          </div>
        </div>
      </div>
    );
  }

  // Waiting Room Lobby
  if (hud.phase === 'waiting' && activeRoom) {
    return (
      <div className="fixed inset-0 z-20 flex items-center justify-center bg-[#050811]/86 px-4 sm:px-6 py-6 overflow-y-auto">
        <div className="max-w-3xl w-full bg-[#080d1a]/96 border border-white/15 rounded-xl p-6 sm:p-8 flex flex-col gap-6 my-auto">
          <div className="flex flex-wrap items-start justify-between gap-4 border-b border-white/10 pb-4">
            <div>
              <p className="text-xs font-medium text-red-400 mb-1">Online Staging Lobby</p>
              <h2 className="font-display text-3xl font-bold text-slate-50">{activeRoom.name}</h2>
              <p className="text-xs text-slate-400 mt-1">
                Difficulty: <span className="capitalize text-slate-200">{activeRoom.difficulty}</span> ·{' '}
                {activeRoom.ornamentsTotal} Ornaments · 27×27 Labyrinth
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
                {roomPlayers.map((p) => (
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
                    {p.uid === activeRoom.hostId && (
                      <span className="text-[11px] text-amber-300 font-medium shrink-0">Host</span>
                    )}
                  </div>
                ))}
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
                <span>Start Match</span>
              </button>
            ) : (
              <span className="text-sm text-slate-300">
                Waiting for {activeRoom.hostName} to start the match...
              </span>
            )}
          </div>
        </div>
      </div>
    );
  }

  if (hud.phase === 'paused') {
    return (
      <div className="fixed inset-0 z-20 flex items-center justify-center bg-[#050811]/82 px-6">
        <div className="max-w-sm w-full bg-[#080d1a]/96 border border-white/15 rounded-xl p-8 text-center">
          <h2 className="font-display text-3xl font-bold text-slate-100 mb-2">
            {hud.isMultiplayer ? 'Match Menu' : 'Paused'}
          </h2>
          <p className="text-sm text-slate-400 mb-6">
            Ornaments {hud.ornamentsCollected} / {hud.ornamentsTotal} · {formatTime(hud.elapsedSeconds)}
          </p>
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
                onClick={onStartSolo}
                className="w-full py-3 px-5 bg-slate-800 hover:bg-slate-700 text-slate-100 text-sm font-medium rounded-lg transition-colors whitespace-nowrap cursor-pointer"
              >
                Restart Maze
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
          <p className="text-xs font-medium text-red-400 mb-2">Claimed by the North Pole</p>
          <h2 className="font-display text-4xl font-bold text-red-100 mb-3">
            Santa Found You
          </h2>
          <p className="text-sm text-slate-300 mb-6">
            Recovered {hud.ornamentsCollected} of {hud.ornamentsTotal} ornaments in{' '}
            <span className="font-mono-tabular text-slate-100">{formatTime(hud.elapsedSeconds)}</span>.
          </p>
          <div className="flex flex-col sm:flex-row gap-3">
            {!hud.isMultiplayer && (
              <button
                type="button"
                onClick={onStartSolo}
                className="flex-1 py-3 px-5 bg-red-700 hover:bg-red-600 text-white text-sm font-semibold rounded-lg transition-colors whitespace-nowrap cursor-pointer"
              >
                Play Again
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
  return (
    <div className="fixed inset-0 z-20 flex items-center justify-center bg-[#041410]/86 px-6">
      <div className="max-w-md w-full bg-[#071210]/96 border border-emerald-400/35 rounded-xl p-8 text-center">
        <p className="text-xs font-medium text-emerald-400 mb-2">Labyrinth Cleared</p>
        <h2 className="font-display text-4xl font-bold text-emerald-50 mb-3">
          You Escaped
        </h2>
        <p className="text-sm text-slate-300 mb-6">
          All {hud.ornamentsTotal} ornaments recovered on <span className="capitalize">{hud.difficulty}</span>{' '}
          in <span className="font-mono-tabular text-emerald-200">{formatTime(hud.elapsedSeconds)}</span>.
        </p>
        <div className="flex flex-col sm:flex-row gap-3">
          {!hud.isMultiplayer && (
            <button
              type="button"
              onClick={onStartSolo}
              className="flex-1 py-3 px-5 bg-emerald-600 hover:bg-emerald-500 text-white text-sm font-semibold rounded-lg transition-colors whitespace-nowrap cursor-pointer"
            >
              Play Again
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
