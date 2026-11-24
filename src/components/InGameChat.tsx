import React, { useEffect, useRef, useState } from 'react';
import { MessageSquare, Send, X } from 'lucide-react';
import { ChatMessageData } from '../game/types';

interface InGameChatProps {
  visible: boolean;
  chatOpen: boolean;
  messages: ChatMessageData[];
  onSetChatOpen: (open: boolean) => void;
  onSendMessage: (text: string) => Promise<void> | void;
}

export const InGameChat: React.FC<InGameChatProps> = ({
  visible,
  chatOpen,
  messages,
  onSetChatOpen,
  onSendMessage,
}) => {
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (chatOpen) {
      const id = window.setTimeout(() => inputRef.current?.focus(), 20);
      return () => window.clearTimeout(id);
    }
  }, [chatOpen]);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages, chatOpen]);

  if (!visible) return null;

  const displayed = chatOpen ? messages.slice(-24) : messages.slice(-4);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = draft.trim();
    if (!trimmed || sending) return;
    setSending(true);
    setDraft('');
    try {
      await onSendMessage(trimmed);
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="fixed bottom-24 left-4 lg:bottom-5 lg:left-5 z-20 w-72 sm:w-80 max-w-[calc(100vw-2rem)] pointer-events-none flex flex-col gap-1.5">
      {(displayed.length > 0 || chatOpen) && (
        <div
          ref={scrollRef}
          className={`flex flex-col gap-1.5 rounded-xl px-3 py-2.5 text-xs border transition-colors ${
            chatOpen
              ? 'pointer-events-auto bg-[#060913]/94 border-white/20 max-h-52 overflow-y-auto'
              : 'bg-[#060913]/78 border-white/10 max-h-36 overflow-hidden'
          }`}
        >
          {displayed.length === 0 ? (
            <p className="text-slate-400">No messages yet. Say hello to your team.</p>
          ) : (
            displayed.map((m) => (
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
      )}

      {chatOpen ? (
        <form
          onSubmit={handleSubmit}
          className="pointer-events-auto flex items-center gap-1.5 bg-[#060913]/95 border border-white/20 rounded-xl p-1.5"
        >
          <input
            ref={inputRef}
            type="text"
            value={draft}
            maxLength={240}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                e.preventDefault();
                e.stopPropagation();
                onSetChatOpen(false);
              }
            }}
            placeholder="Message team..."
            className="flex-1 min-w-0 bg-transparent px-2.5 py-1.5 text-xs text-slate-100 placeholder-slate-500 focus:outline-none"
          />
          <button
            type="submit"
            disabled={!draft.trim() || sending}
            aria-label="Send message"
            className="flex items-center justify-center w-8 h-8 rounded-lg bg-red-700 hover:bg-red-600 disabled:bg-slate-800 disabled:text-slate-500 text-white transition-colors shrink-0 cursor-pointer"
          >
            <Send className="w-3.5 h-3.5" />
          </button>
          <button
            type="button"
            onClick={() => onSetChatOpen(false)}
            aria-label="Close chat"
            className="flex items-center justify-center w-8 h-8 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 transition-colors shrink-0 cursor-pointer"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </form>
      ) : (
        <button
          type="button"
          onClick={() => onSetChatOpen(true)}
          className="pointer-events-auto self-start flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-[#060913]/85 border border-white/12 text-[11px] font-medium text-slate-300 hover:text-white hover:bg-[#0e1528] transition-colors whitespace-nowrap shrink-0 cursor-pointer"
        >
          <MessageSquare className="w-3 h-3" />
          <span>Chat (T)</span>
        </button>
      )}
    </div>
  );
};
