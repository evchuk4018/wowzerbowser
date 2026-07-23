"use client";

import {
  FormEvent,
  KeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type CSSProperties,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { MagicLinkForm } from "./auth/magic-link-form";
import type { AuthUser } from "./auth/types";
import { useAuthSession } from "./auth/use-auth-session";
import { fetchChatModels, streamChatResponse } from "./chat/chat-service";
import { ChatComposer } from "./chat/chat-composer";
import { AssistantResponse } from "./chat/assistant-response";
import type {
  ChatModelId,
  ChatReasoningEffort,
} from "../lib/chat-protocol";
import { DEFAULT_CHAT_MODELS } from "../lib/chat-protocol";

type Message = {
  id: string;
  role: "user" | "assistant";
  content: string;
  reasoning?: string;
  thinkingEnabled?: boolean;
  thinkingDurationMs?: number;
  status?: "streaming" | "complete" | "error" | "cancelled";
  error?: string;
};

type TurnVersion = {
  id: string;
  user: Message;
  assistant: Message;
};

type ConversationTurn = {
  id: string;
  versions: TurnVersion[];
  activeVersion: number;
};

type Conversation = {
  id: string;
  title: string;
  turns: ConversationTurn[];
};

type ChatSettings = {
  systemPrompt: string;
  userPresence: string;
};

type DrawerGesture = {
  axis: "pending" | "horizontal" | "vertical";
  pointerId: number;
  startProgress: number;
  startX: number;
  startY: number;
  width: number;
};

type ActiveRequest = {
  conversationId: string;
  messageId: string;
  controller: AbortController;
};

const DRAWER_DIRECTION_LOCK_PX = 8;
const DRAWER_OPEN_THRESHOLD = 0.25;
const DRAWER_GESTURE_IGNORE_SELECTOR = [
  ".composer-wrap",
  "a",
  "button",
  "input",
  "select",
  "textarea",
  "[contenteditable='true']",
  "[role='button']",
].join(",");

const clampDrawerProgress = (progress: number) => Math.min(1, Math.max(0, progress));

const LEGACY_DEFAULT_SYSTEM_PROMPT =
  "You are a helpful, thoughtful assistant. Always respond in English unless the user explicitly asks you to use another language. Be accurate, clear, and concise. If you are unsure, say so.";
const DEFAULT_SYSTEM_PROMPT = `<bobert_behavior>

bobert is the assistant’s name.

bobert always responds in English unless the user specifies another language.

bobert is helpful, harmless, and honest. bobert does not refuse questions merely because they involve sensitive or controversial topics. bobert discusses such topics thoughtfully and only raises safety, ethical, or legal concerns when they are directly relevant.

bobert is concise, natural, and direct. bobert avoids marketing language, exaggerated enthusiasm, unnecessary repetition, and ALL CAPS unless the user uses it first.

When bobert is uncertain or does not know something, bobert says so clearly rather than guessing or presenting uncertainty as fact.

bobert answers the user’s actual question before asking for more information whenever a reasonable interpretation is possible. When clarification is necessary, bobert generally asks no more than one question at a time.

bobert avoids preachy warnings and lengthy disclaimers. Necessary qualifications should be incorporated naturally into the answer rather than presented as lectures.

bobert uses the minimum formatting needed for clarity. Simple questions should usually receive natural sentences or short paragraphs rather than numerous headings, bullet points, or bolded phrases. Lists are appropriate when requested or when they substantially improve clarity.

bobert does not use emojis, profanity, roleplay actions inside asterisks, or similarly affected language unless the user’s style or request clearly calls for them. Even then, bobert uses them sparingly.

bobert treats users with kindness and does not make condescending assumptions about their intelligence, abilities, judgment, or follow-through. bobert can disagree, correct faulty assumptions, and push back, but does so constructively and honestly.

bobert interprets questions charitably and treats moral, political, ethical, and controversial questions as sincere, good-faith inquiries rather than reacting defensively to provocative wording.

When asked to explain or argue for a position, bobert presents the strongest reasonable case its supporters would make rather than treating the request as bobert’s personal endorsement. Where relevant, bobert also explains significant opposing perspectives, factual disputes, or limitations.

bobert can use examples, analogies, metaphors, and thought experiments when they make an explanation easier to understand.

Above all, bobert aims to be useful, accurate, thoughtful, evenhanded, and pleasant to talk to without becoming annoying, preachy, evasive, or overly verbose.

bobert may use Markdown for structure and readability, and LaTeX for mathematical notation when either meaningfully elevates the response. Use formatting selectively and keep it clear.

</bobert_behavior>`;
const settingsStorageKeyFor = (userId: string) => `local-chat-settings:${userId}`;

const storageKeyFor = (userId: string) => `local-chat-conversations:${userId}`;
const LEGACY_STORAGE_KEY = "local-chat-conversations";

const makeId = () =>
  typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random()}`;

const createConversation = (): Conversation => ({
  id: makeId(),
  title: "New conversation",
  turns: [],
});

function migrateConversation(value: unknown): Conversation | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Partial<Conversation> & { messages?: Message[] };
  if (typeof candidate.id !== "string" || typeof candidate.title !== "string") return null;
  if (Array.isArray(candidate.turns)) return candidate as Conversation;
  if (!Array.isArray(candidate.messages)) return null;

  const turns: ConversationTurn[] = [];
  for (let index = 0; index < candidate.messages.length; index += 2) {
    const user = candidate.messages[index];
    const assistant = candidate.messages[index + 1];
    if (!user || user.role !== "user" || !assistant || assistant.role !== "assistant") continue;
    turns.push({
      id: makeId(),
      versions: [{ id: makeId(), user, assistant }],
      activeVersion: 0,
    });
  }
  return { id: candidate.id, title: candidate.title, turns };
}

export default function Home() {
  const {
    state,
    sendMagicLink,
    signInWithPassword,
    signUpWithPassword,
    signOut,
    getAccessToken,
  } = useAuthSession();

  if (state.status === "loading") {
    return <main className="loading-shell" aria-label="Loading session" />;
  }

  if (state.status !== "authenticated") {
    return (
      <MagicLinkForm
        error={state.status === "error" ? state.error : null}
        onSubmit={sendMagicLink}
        onPasswordSignIn={signInWithPassword}
        onPasswordSignUp={signUpWithPassword}
      />
    );
  }

  return (
    <ChatWorkspace
      key={state.user.id}
      user={state.user}
      getAccessToken={getAccessToken}
      onSignOut={signOut}
    />
  );
}

type ChatWorkspaceProps = {
  user: AuthUser;
  getAccessToken: () => Promise<string | null>;
  onSignOut: () => Promise<void>;
};

function formatDuration(milliseconds: number): string {
  if (milliseconds < 1000) return `${Math.max(0, Math.round(milliseconds))}ms`;
  return `${(milliseconds / 1000).toFixed(1)}s`;
}

function ChatWorkspace({ user, getAccessToken, onSignOut }: ChatWorkspaceProps) {
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [activeId, setActiveId] = useState("");
  const [draft, setDraft] = useState("");
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [drawerDragProgress, setDrawerDragProgress] = useState<number | null>(null);
  const [ready, setReady] = useState(false);
  const [models, setModels] = useState(DEFAULT_CHAT_MODELS);
  const [model, setModel] = useState<ChatModelId>("deepseek-v4-flash");
  const [thinking, setThinking] = useState(false);
  const [effort, setEffort] = useState<ChatReasoningEffort>("high");
  const [runningRequests, setRunningRequests] = useState<Record<string, string>>({});
  const [waitingMessageIds, setWaitingMessageIds] = useState<Record<string, string>>({});
  const [thinkingMessageIds, setThinkingMessageIds] = useState<Record<string, string>>({});
  const [thinkingNow, setThinkingNow] = useState(0);
  const [openMenu, setOpenMenu] = useState<"model" | "thinking" | null>(null);
  const [editingTurnId, setEditingTurnId] = useState<string | null>(null);
  const [openMessageActions, setOpenMessageActions] = useState<string | null>(null);
  const [copiedMessageId, setCopiedMessageId] = useState<string | null>(null);
  const [settings, setSettings] = useState<ChatSettings>({
    systemPrompt: DEFAULT_SYSTEM_PROMPT,
    userPresence: "",
  });
  const [settingsOpen, setSettingsOpen] = useState(false);
  const settingsButtonRef = useRef<HTMLButtonElement>(null);
  const sidebarRef = useRef<HTMLElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const thinkingStartedAtRef = useRef<Record<string, number | null>>({});
  const longPressTimerRef = useRef<number | null>(null);
  const drawerGestureRef = useRef<DrawerGesture | null>(null);
  const drawerProgressRef = useRef(0);
  const suppressScrimClickRef = useRef(false);
  const activeRequestRef = useRef<Record<string, ActiveRequest>>({});

  useEffect(() => {
    const loadStoredChats = window.setTimeout(() => {
      try {
        const userStorageKey = storageKeyFor(user.id);
        const userStored = localStorage.getItem(userStorageKey);
        const legacyStored = userStored ? null : localStorage.getItem(LEGACY_STORAGE_KEY);
        const stored = userStored ?? legacyStored;
        const parsed = stored ? (JSON.parse(stored) as unknown[]) : [];
        const migrated = parsed.map(migrateConversation).filter((item): item is Conversation => item !== null);
        const initial = migrated.length ? migrated : [createConversation()];
        if (legacyStored) localStorage.setItem(userStorageKey, legacyStored);
        setConversations(initial);
        setActiveId(initial[0].id);
      } catch {
        const initial = createConversation();
        setConversations([initial]);
        setActiveId(initial.id);
      }
      setReady(true);
    }, 0);

    return () => window.clearTimeout(loadStoredChats);
  }, [user.id]);

  useEffect(() => {
    if (ready) {
      localStorage.setItem(storageKeyFor(user.id), JSON.stringify(conversations));
    }
  }, [conversations, ready, user.id]);

  useEffect(() => {
  const closeSidebarOnEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setSidebarSettled(false);
    };
    document.addEventListener("keydown", closeSidebarOnEscape);
    return () => document.removeEventListener("keydown", closeSidebarOnEscape);
  }, []);

  useEffect(() => {
    try {
      const stored = localStorage.getItem(settingsStorageKeyFor(user.id));
      if (!stored) return;
      const parsed = JSON.parse(stored) as Partial<ChatSettings>;
      setSettings({
        systemPrompt:
          parsed.systemPrompt === LEGACY_DEFAULT_SYSTEM_PROMPT
            ? DEFAULT_SYSTEM_PROMPT
            : typeof parsed.systemPrompt === "string" && parsed.systemPrompt.trim()
              ? parsed.systemPrompt
              : DEFAULT_SYSTEM_PROMPT,
        userPresence: typeof parsed.userPresence === "string" ? parsed.userPresence : "",
      });
    } catch {
      setSettings({ systemPrompt: DEFAULT_SYSTEM_PROMPT, userPresence: "" });
    }
  }, [user.id]);

  useEffect(() => {
    let mounted = true;
    void getAccessToken()
      .then((token) => (token ? fetchChatModels(token) : []))
      .then((availableModels) => {
        if (mounted && availableModels.length) setModels(availableModels);
      })
      .catch(() => undefined);
    return () => {
      mounted = false;
    };
  }, [getAccessToken]);

  const active = conversations.find((conversation) => conversation.id === activeId);
  const latestTurn = active?.turns[active.turns.length - 1];
  const latestVersion = latestTurn?.versions[latestTurn.activeVersion];
  const latestMessage = latestVersion?.assistant;
  const isStreaming = Boolean(runningRequests[activeId]);
  const waitingMessageId = waitingMessageIds[activeId];
  const thinkingMessageId = thinkingMessageIds[activeId];
  const selectedModel = models.find((availableModel) => availableModel.id === model) ?? models[0];
  const supportedEfforts = useMemo(
    () => selectedModel?.supportedEfforts ?? [],
    [selectedModel],
  );
  const canThink = Boolean(selectedModel?.thinkingSupported && supportedEfforts.length);
  const effectiveThinking = thinking && canThink;
  const effectiveEffort = supportedEfforts.includes(effort)
    ? effort
    : (supportedEfforts[0] ?? "high");

  useEffect(() => {
    if (!models.length) return;
    const available = models.some((availableModel) => availableModel.id === model);
    if (!available) setModel(models[0].id);
  }, [model, models]);

  useEffect(() => {
    if (!canThink && thinking) setThinking(false);
    if (canThink && !supportedEfforts.includes(effort)) setEffort(supportedEfforts[0]);
  }, [canThink, effort, supportedEfforts, thinking]);

  useEffect(() => {
    const closeMenus = (event: PointerEvent) => {
      if (!(event.target instanceof Element) || !event.target.closest(".composer-menu")) {
        setOpenMenu(null);
      }
    };
    const closeOnEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") setOpenMenu(null);
    };
    document.addEventListener("pointerdown", closeMenus);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeMenus);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, []);

  useEffect(() => {
    if (!openMessageActions) return;
    const closeMessageActions = (event: PointerEvent) => {
      if (!(event.target instanceof Element)) {
        setOpenMessageActions(null);
        return;
      }
      if (!event.target.closest(".message-action-popover")) {
        setOpenMessageActions(null);
      }
    };
    const closeOnEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") setOpenMessageActions(null);
    };
    document.addEventListener("pointerdown", closeMessageActions);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeMessageActions);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [openMessageActions]);

  useEffect(() => {
    if (isStreaming) setOpenMenu(null);
  }, [isStreaming]);

  useEffect(() => {
    if (!activeId || !thinkingMessageId || thinkingStartedAtRef.current[activeId] === null) return;
    const update = () => {
      const startedAt = thinkingStartedAtRef.current[activeId];
      if (startedAt !== null) setThinkingNow(performance.now() - startedAt);
    };
    update();
    const timer = window.setInterval(update, 100);
    return () => window.clearInterval(timer);
  }, [activeId, thinkingMessageId]);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [active?.turns.length, latestMessage?.content.length, latestMessage?.reasoning?.length]);

  useEffect(() => {
    const handleShortcut = (event: globalThis.KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        startNewChat();
      }
    };
    window.addEventListener("keydown", handleShortcut);
    return () => window.removeEventListener("keydown", handleShortcut);
  });

  useEffect(() => {
    return () => {
      Object.values(activeRequestRef.current).forEach((request) => request.controller.abort());
    };
  }, []);

  const startNewChat = () => {
    const existingBlank = conversations.find((item) => item.turns.length === 0);
    if (existingBlank) {
      setActiveId(existingBlank.id);
    } else {
      const next = createConversation();
      setConversations((current) => [next, ...current]);
      setActiveId(next.id);
    }
    setDraft("");
    setEditingTurnId(null);
    setOpenMessageActions(null);
    setSidebarSettled(false);
    requestAnimationFrame(() => textareaRef.current?.focus());
  };

  const setSidebarSettled = (open: boolean) => {
    drawerGestureRef.current = null;
    drawerProgressRef.current = open ? 1 : 0;
    setDrawerDragProgress(null);
    setSidebarOpen(open);
  };

  const beginDrawerGesture = (event: ReactPointerEvent<HTMLElement>) => {
    if (event.pointerType !== "touch" || window.matchMedia("(min-width: 761px)").matches) return;
    const target = event.target as Element;
    const isScrim = event.currentTarget.classList.contains("sidebar-scrim");
    if (!isScrim && target.closest(DRAWER_GESTURE_IGNORE_SELECTOR)) return;
    if (isScrim) {
      suppressScrimClickRef.current = false;
    }

    const width = sidebarRef.current?.offsetWidth ?? 0;
    if (!width) return;
    drawerGestureRef.current = {
      axis: "pending",
      pointerId: event.pointerId,
      startProgress: sidebarOpen ? 1 : 0,
      startX: event.clientX,
      startY: event.clientY,
      width,
    };
    drawerProgressRef.current = sidebarOpen ? 1 : 0;
  };

  const updateDrawerGesture = (event: ReactPointerEvent<HTMLElement>) => {
    const gesture = drawerGestureRef.current;
    if (!gesture || gesture.pointerId !== event.pointerId) return;
    const deltaX = event.clientX - gesture.startX;
    const deltaY = event.clientY - gesture.startY;

    if (gesture.axis === "pending") {
      if (Math.max(Math.abs(deltaX), Math.abs(deltaY)) < DRAWER_DIRECTION_LOCK_PX) return;
      gesture.axis = Math.abs(deltaX) >= Math.abs(deltaY) ? "horizontal" : "vertical";
    }
    if (gesture.axis !== "horizontal") return;

    event.preventDefault();
    if (!event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.setPointerCapture(event.pointerId);
    }
    const progress = clampDrawerProgress(gesture.startProgress + deltaX / gesture.width);
    drawerProgressRef.current = progress;
    setDrawerDragProgress(progress);
  };

  const cancelDrawerGesture = (event: ReactPointerEvent<HTMLElement>) => {
    const gesture = drawerGestureRef.current;
    if (!gesture || gesture.pointerId !== event.pointerId) return;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    drawerGestureRef.current = null;
    drawerProgressRef.current = sidebarOpen ? 1 : 0;
    suppressScrimClickRef.current = false;
    setDrawerDragProgress(null);
  };

  const finishDrawerGesture = (event: ReactPointerEvent<HTMLElement>) => {
    const gesture = drawerGestureRef.current;
    if (!gesture || gesture.pointerId !== event.pointerId) return;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    drawerGestureRef.current = null;
    if (gesture.axis !== "horizontal") return;

    const open = gesture.startProgress === 0
      ? drawerProgressRef.current >= DRAWER_OPEN_THRESHOLD
      : drawerProgressRef.current > 1 - DRAWER_OPEN_THRESHOLD;
    if (event.currentTarget.classList.contains("sidebar-scrim")) {
      suppressScrimClickRef.current = true;
    }
    setDrawerDragProgress(null);
    setSidebarOpen(open);
    drawerProgressRef.current = open ? 1 : 0;
  };

  const handleScrimClick = () => {
    if (suppressScrimClickRef.current) {
      suppressScrimClickRef.current = false;
      return;
    }
    setSidebarSettled(false);
  };

  const updateMessage = (
    conversationId: string,
    messageId: string,
    update: (message: Message) => Message,
  ) => {
    setConversations((current) =>
      current.map((conversation) =>
      conversation.id === conversationId
          ? {
              ...conversation,
              turns: conversation.turns.map((turn) => ({
                ...turn,
                versions: turn.versions.map((version) => ({
                  ...version,
                  user: version.user.id === messageId ? update(version.user) : version.user,
                  assistant:
                    version.assistant.id === messageId
                      ? update(version.assistant)
                      : version.assistant,
                })),
              })),
            }
          : conversation,
      ),
    );
  };

  const stopStreaming = () => {
    const activeRequest = activeId ? activeRequestRef.current[activeId] : undefined;
    if (!activeRequest) return;
    activeRequest.controller.abort();
    updateMessage(activeRequest.conversationId, activeRequest.messageId, (message) => ({
      ...message,
      status: "cancelled",
    }));
    delete activeRequestRef.current[activeRequest.conversationId];
    setRunningRequests((current) => {
      const next = { ...current };
      delete next[activeRequest.conversationId];
      return next;
    });
    setWaitingMessageIds((current) => {
      const next = { ...current };
      delete next[activeRequest.conversationId];
      return next;
    });
    setThinkingMessageIds((current) => {
      const next = { ...current };
      delete next[activeRequest.conversationId];
      return next;
    });
    delete thinkingStartedAtRef.current[activeRequest.conversationId];
  };

  const editTurn = (turn: ConversationTurn) => {
    const version = turn.versions[turn.activeVersion];
    setDraft(version.user.content);
    setEditingTurnId(turn.id);
    setOpenMessageActions(null);
    requestAnimationFrame(() => textareaRef.current?.focus());
  };

  const copyPrompt = async (message: Message) => {
    try {
      await navigator.clipboard.writeText(message.content);
      setCopiedMessageId(message.id);
      window.setTimeout(() => setCopiedMessageId(null), 1400);
    } catch {
      // Clipboard access can be unavailable in an insecure or restricted context.
    }
  };

  const sharePrompt = async (message: Message) => {
    try {
      if (navigator.share) {
        await navigator.share({ text: message.content });
      } else {
        await navigator.clipboard.writeText(message.content);
        setCopiedMessageId(message.id);
        window.setTimeout(() => setCopiedMessageId(null), 1400);
      }
    } catch {
      // Sharing can be cancelled by the user or unavailable in restricted contexts.
    }
  };

  const selectVersion = (turnId: string, direction: -1 | 1) => {
    setConversations((current) =>
      current.map((conversation) =>
        conversation.id !== activeId
          ? conversation
          : {
              ...conversation,
              turns: conversation.turns.map((turn) =>
                turn.id !== turnId
                  ? turn
                  : {
                      ...turn,
                      activeVersion: Math.max(
                        0,
                        Math.min(turn.versions.length - 1, turn.activeVersion + direction),
                      ),
                    },
              ),
            },
      ),
    );
  };

  const cancelLongPress = () => {
    if (longPressTimerRef.current !== null) {
      window.clearTimeout(longPressTimerRef.current);
      longPressTimerRef.current = null;
    }
  };

  const startLongPress = (turnId: string, pointerType: string) => {
    cancelLongPress();
    if (pointerType !== "touch") return;
    longPressTimerRef.current = window.setTimeout(() => {
      setOpenMessageActions(turnId);
      longPressTimerRef.current = null;
    }, 500);
  };

  const sendMessage = async (event?: FormEvent) => {
    event?.preventDefault();
    const content = draft.trim();
    if (!content || !activeId || runningRequests[activeId] || !active) return;

    const userMessage: Message = { id: makeId(), role: "user", content };
    const assistantMessage: Message = {
      id: makeId(),
      role: "assistant",
      content: "",
      reasoning: "",
      thinkingEnabled: effectiveThinking,
      status: "streaming",
    };
    const conversationId = active.id;
    const editingTurnIndex = editingTurnId
      ? active.turns.findIndex((turn) => turn.id === editingTurnId)
      : -1;
    const contextTurns = editingTurnIndex >= 0 ? active.turns.slice(0, editingTurnIndex) : active.turns;
    const requestMessages = contextTurns
      .flatMap((turn) => {
        const version = turn.versions[turn.activeVersion];
        return [version.user, version.assistant];
      })
      .concat(userMessage)
      .filter((message) => message.content.trim())
      .map(({ role, content: messageContent }) => ({ role, content: messageContent }));

    setConversations((current) =>
      current.map((conversation) =>
        conversation.id === conversationId
          ? {
              ...conversation,
              title:
                conversation.turns.length === 0 ? content.slice(0, 42) : conversation.title,
              turns:
                editingTurnIndex >= 0
                  ? conversation.turns.map((turn, index) =>
                      index === editingTurnIndex
                        ? {
                            ...turn,
                            versions: [
                              ...turn.versions,
                              { id: makeId(), user: userMessage, assistant: assistantMessage },
                            ],
                            activeVersion: turn.versions.length,
                          }
                        : turn,
                    )
                  : [
                      ...conversation.turns,
                      {
                        id: makeId(),
                        versions: [{ id: makeId(), user: userMessage, assistant: assistantMessage }],
                        activeVersion: 0,
                      },
                    ],
            }
          : conversation,
      ),
    );
    setDraft("");
    setEditingTurnId(null);
    setOpenMessageActions(null);

    const controller = new AbortController();
    const requestThinkingStartedAt = effectiveThinking ? performance.now() : null;
    let requestThinkingFinished = false;
    activeRequestRef.current[conversationId] = {
      conversationId,
      messageId: assistantMessage.id,
      controller,
    };
    setRunningRequests((current) => ({ ...current, [conversationId]: assistantMessage.id }));
    if (requestThinkingStartedAt !== null) {
      thinkingStartedAtRef.current[conversationId] = requestThinkingStartedAt;
      setThinkingNow(0);
      setThinkingMessageIds((current) => ({ ...current, [conversationId]: assistantMessage.id }));
    }

    let streamError = false;
    try {
      const accessToken = await getAccessToken();
      if (!accessToken) throw new Error("Your session expired. Please sign in again.");
      if (controller.signal.aborted || activeRequestRef.current[conversationId]?.messageId !== assistantMessage.id) {
        return;
      }

      const request = {
        messages: requestMessages,
        systemPrompt: settings.systemPrompt,
        userPresence: settings.userPresence,
        model,
        thinking: effectiveThinking,
        reasoningEffort: effectiveEffort,
      };

      setWaitingMessageIds((current) => ({ ...current, [conversationId]: assistantMessage.id }));
      for await (const event of streamChatResponse(request, accessToken, controller.signal)) {
        if (event.type === "reasoning") {
          setWaitingMessageIds((current) => {
            if (current[conversationId] !== assistantMessage.id) return current;
            const next = { ...current };
            delete next[conversationId];
            return next;
          });
          updateMessage(conversationId, assistantMessage.id, (message) => ({
            ...message,
            reasoning: `${message.reasoning ?? ""}${event.delta}`,
          }));
        } else if (event.type === "content") {
          setWaitingMessageIds((current) => {
            if (current[conversationId] !== assistantMessage.id) return current;
            const next = { ...current };
            delete next[conversationId];
            return next;
          });
          if (requestThinkingStartedAt !== null && !requestThinkingFinished) {
            const duration = performance.now() - requestThinkingStartedAt;
            requestThinkingFinished = true;
            if (activeRequestRef.current[conversationId]?.messageId === assistantMessage.id) {
              thinkingStartedAtRef.current[conversationId] = null;
              setThinkingMessageIds((current) => {
                const next = { ...current };
                delete next[conversationId];
                return next;
              });
            }
            updateMessage(conversationId, assistantMessage.id, (message) => ({
              ...message,
              thinkingDurationMs: duration,
              content: `${message.content}${event.delta}`,
            }));
          } else {
            updateMessage(conversationId, assistantMessage.id, (message) => ({
              ...message,
              content: `${message.content}${event.delta}`,
            }));
          }
        } else if (event.type === "error") {
          setWaitingMessageIds((current) => {
            if (current[conversationId] !== assistantMessage.id) return current;
            const next = { ...current };
            delete next[conversationId];
            return next;
          });
          streamError = true;
          updateMessage(conversationId, assistantMessage.id, (message) => ({
            ...message,
            status: "error",
            error: event.message,
          }));
        } else if (event.type === "done") {
          setWaitingMessageIds((current) => {
            if (current[conversationId] !== assistantMessage.id) return current;
            const next = { ...current };
            delete next[conversationId];
            return next;
          });
          updateMessage(conversationId, assistantMessage.id, (message) => ({
            ...message,
            status: streamError ? "error" : "complete",
          }));
        }
      }
    } catch (error: unknown) {
      if (controller.signal.aborted) {
        updateMessage(conversationId, assistantMessage.id, (message) => ({
          ...message,
          status: "cancelled",
        }));
      } else {
        updateMessage(conversationId, assistantMessage.id, (message) => ({
          ...message,
          status: "error",
          error: error instanceof Error ? error.message : "The response failed.",
        }));
      }
    } finally {
      const isCurrentRequest = activeRequestRef.current[conversationId]?.messageId === assistantMessage.id;
      if (isCurrentRequest) {
        delete activeRequestRef.current[conversationId];
        setRunningRequests((current) => {
          const next = { ...current };
          delete next[conversationId];
          return next;
        });
        setWaitingMessageIds((current) => {
          if (current[conversationId] !== assistantMessage.id) return current;
          const next = { ...current };
          delete next[conversationId];
          return next;
        });
        thinkingStartedAtRef.current[conversationId] = null;
        setThinkingMessageIds((current) => {
          if (current[conversationId] !== assistantMessage.id) return current;
          const next = { ...current };
          delete next[conversationId];
          return next;
        });
      }
      if (requestThinkingStartedAt !== null && !requestThinkingFinished) {
        const duration = performance.now() - requestThinkingStartedAt;
        updateMessage(conversationId, assistantMessage.id, (message) => ({
          ...message,
          thinkingDurationMs: duration,
        }));
      }
    }
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      void sendMessage();
    }
  };

  if (!ready || !active) return <main className="loading-shell" aria-label="Loading chat" />;

  const hasMessages = active.turns.length > 0;
  const drawerProgress = drawerDragProgress ?? (sidebarOpen ? 1 : 0);
  const drawerStyle = {
    "--drawer-progress": drawerProgress,
  } as CSSProperties;
  const closeSettings = () => {
    setSettingsOpen(false);
    requestAnimationFrame(() => settingsButtonRef.current?.focus());
  };

  return (
    <main className="app-shell">
      <button
        className="mobile-menu"
        type="button"
        aria-label="Open conversation menu"
        aria-expanded={sidebarOpen}
        onClick={() => setSidebarSettled(!sidebarOpen)}
      >
        <span />
        <span />
      </button>

      <button
        type="button"
        className={`sidebar-scrim ${drawerDragProgress !== null ? "sidebar-scrim-dragging" : ""}`}
        aria-label="Close conversation menu"
        aria-hidden={drawerProgress === 0}
        tabIndex={drawerProgress > 0 ? 0 : -1}
        style={{
          "--drawer-progress": drawerProgress,
          pointerEvents: drawerProgress > 0 ? "auto" : "none",
        } as CSSProperties}
        onClick={handleScrimClick}
        onPointerDown={beginDrawerGesture}
        onPointerMove={updateDrawerGesture}
        onPointerUp={finishDrawerGesture}
        onPointerCancel={cancelDrawerGesture}
      />

      <aside
        ref={sidebarRef}
        className={`sidebar ${sidebarOpen ? "sidebar-open" : ""} ${drawerDragProgress !== null ? "sidebar-dragging" : ""}`}
        style={drawerStyle}
        onPointerDown={beginDrawerGesture}
        onPointerMove={updateDrawerGesture}
        onPointerUp={finishDrawerGesture}
        onPointerCancel={cancelDrawerGesture}
      >
        <div className="sidebar-top">
          <div className="product-name">Chat</div>
          <button type="button" className="square-button" aria-label="Collapse sidebar" onClick={() => setSidebarSettled(false)}>
            <span className="panel-icon" />
          </button>
        </div>

        <button type="button" className="new-chat-button" onClick={startNewChat}>
          <span className="plus-icon">+</span>
          <span>New chat</span>
          <kbd>Ctrl K</kbd>
        </button>

        <div className="history-label">Recent</div>
        <nav className="conversation-list" aria-label="Recent conversations">
          {conversations.map((conversation) => (
            <button
              key={conversation.id}
              type="button"
              className={`conversation-item ${conversation.id === activeId ? "active" : ""}`}
              onClick={() => {
                setActiveId(conversation.id);
                setSidebarSettled(false);
              }}
            >
              <span className="conversation-title">{conversation.title}</span>
              {runningRequests[conversation.id] && (
                <span
                  className="conversation-streaming-indicator"
                  role="status"
                  aria-label="Streaming response"
                />
              )}
            </button>
          ))}
        </nav>

        <div className="sidebar-footer">
          <button
            ref={settingsButtonRef}
            type="button"
            className="settings-button"
            aria-label="Open settings"
            onClick={() => setSettingsOpen(true)}
          >
            <span className="settings-icon" aria-hidden="true">⚙</span>
          </button>
          <div className="account-details">
            <div className="account-name">{user.email}</div>
            <div className="account-note">Magic link account</div>
          </div>
          <button
            className="sign-out-button"
            type="button"
            aria-label="Sign out"
            onClick={() => void onSignOut()}
          >
            Sign out
          </button>
        </div>
      </aside>

      {settingsOpen && (
        <SettingsModal
          settings={settings}
          onClose={closeSettings}
          onSave={(nextSettings) => {
            setSettings(nextSettings);
            try {
              localStorage.setItem(settingsStorageKeyFor(user.id), JSON.stringify(nextSettings));
            } catch {
              // Keep the setting active for this session if storage is unavailable.
            }
            closeSettings();
          }}
        />
      )}

      <section
        className={`chat-area ${hasMessages ? "chat-active" : ""} ${
          openMessageActions ? "message-actions-active" : ""
        }`}
        onPointerDown={beginDrawerGesture}
        onPointerMove={updateDrawerGesture}
        onPointerUp={finishDrawerGesture}
        onPointerCancel={cancelDrawerGesture}
      >
        {openMessageActions && (
          <button
            type="button"
            className="message-actions-backdrop"
            aria-label="Close prompt actions"
            onClick={() => setOpenMessageActions(null)}
          />
        )}
        {!hasMessages ? (
          <div className="empty-state">
            <div className="spark-mark" aria-hidden="true">✦</div>
            <h1>What can I help with?</h1>
            <p>Start a conversation below.</p>
          </div>
          ) : (
          <div
            className="transcript"
            aria-live="polite"
            onScroll={() => setOpenMessageActions(null)}
          >
            {active.turns.map((turn) => {
              const version = turn.versions[turn.activeVersion];
              const userMessage = version.user;
              const assistantMessage = version.assistant;
              const actionsOpen = openMessageActions === turn.id;
              return (
                <article
                  key={turn.id}
                  className={`message-pair ${actionsOpen ? "message-actions-open" : ""}`}
                  onContextMenu={(event) => {
                    event.preventDefault();
                    setOpenMessageActions(turn.id);
                  }}
                  onPointerDown={(event) => startLongPress(turn.id, event.pointerType)}
                  onPointerUp={cancelLongPress}
                  onPointerCancel={cancelLongPress}
                  onPointerMove={cancelLongPress}
                >
                  <div className="message-user-container">
                  <article className="message user">
                    <div className="message-label">You</div>
                    <div className="message-bubble">{userMessage.content}</div>
                    {turn.versions.length > 1 && (
                      <div className="version-controls" aria-label="Prompt versions">
                        <button type="button" aria-label="Previous prompt version" disabled={turn.activeVersion === 0 || isStreaming} onClick={() => selectVersion(turn.id, -1)}>‹</button>
                        <span>{turn.activeVersion + 1} / {turn.versions.length}</span>
                        <button type="button" aria-label="Next prompt version" disabled={turn.activeVersion === turn.versions.length - 1 || isStreaming} onClick={() => selectVersion(turn.id, 1)}>›</button>
                      </div>
                    )}
                  </article>
                  {actionsOpen && (
                    <div className="message-action-popover" role="menu" aria-label="Prompt actions">
                      <div className="message-action-meta">Prompt actions</div>
                      <button
                        type="button"
                        role="menuitem"
                        onClick={() => {
                          void copyPrompt(userMessage);
                          setOpenMessageActions(null);
                        }}
                      >
                        <span className="message-action-icon" aria-hidden="true">▣</span>
                        <span>{copiedMessageId === userMessage.id ? "Copied" : "Copy"}</span>
                      </button>
                      <button
                        type="button"
                        role="menuitem"
                        onClick={() => {
                          editTurn(turn);
                          setOpenMessageActions(null);
                        }}
                      >
                        <span className="message-action-icon" aria-hidden="true">⌕</span>
                        <span>Edit</span>
                      </button>
                      <button
                        type="button"
                        role="menuitem"
                        onClick={() => {
                          void sharePrompt(userMessage);
                          setOpenMessageActions(null);
                        }}
                      >
                        <span className="message-action-icon" aria-hidden="true">↥</span>
                        <span>Share prompt</span>
                      </button>
                    </div>
                  )}
                  </div>
                  <article className="message assistant">
                    <div className="message-label">Response</div>
                    {Boolean(assistantMessage.reasoning) && (
                      <ReasoningBlock
                        message={assistantMessage}
                        liveDurationMs={thinkingMessageId === assistantMessage.id ? Math.max(0, thinkingNow) : undefined}
                      />
                    )}
                    <div className="message-bubble">
                      {assistantMessage.content ? (
                        <AssistantResponse content={assistantMessage.content} />
                      ) : !assistantMessage.thinkingEnabled && waitingMessageId === assistantMessage.id ? (
                        <CallActivityIndicator />
                      ) : null}
                    </div>
                    {assistantMessage.error && <div className="message-error">{assistantMessage.error}</div>}
                    {assistantMessage.status === "cancelled" && <div className="message-note">Response stopped.</div>}
                  </article>
                </article>
              );
            })}
            {/* legacy renderer retained only in history-compatible source context
              <article key={message.id} className={`message ${message.role}`}>
                <div className="message-label">
                  {message.role === "user" ? "You" : "Response"}
                </div>
                {message.role === "assistant" && Boolean(message.reasoning) && (
                    <ReasoningBlock
                      message={message}
                      liveDurationMs={
                        thinkingMessageId === message.id ? Math.max(0, thinkingNow) : undefined
                      }
                    />
                  )}
                <div className="message-bubble">
                  {message.content ? (
                    message.role === "assistant" ? (
                      <AssistantResponse content={message.content} />
                    ) : (
                      message.content
                    )
                  ) : !message.thinkingEnabled && message.status === "streaming" ? (
                    <CallActivityIndicator />
                  ) : null}
                </div>
                {message.error && <div className="message-error">{message.error}</div>}
                {message.status === "cancelled" && (
                  <div className="message-note">Response stopped.</div>
                )}
              </article>
            */}
            <div ref={endRef} />
          </div>
        )}

        <ChatComposer
          draft={draft}
          setDraft={setDraft}
          textareaRef={textareaRef}
          isStreaming={isStreaming}
          models={models}
          model={model}
          setModel={setModel}
          selectedModel={selectedModel}
          openMenu={openMenu}
          setOpenMenu={setOpenMenu}
          thinking={thinking}
          setThinking={setThinking}
          effort={effort}
          setEffort={setEffort}
          supportedEfforts={supportedEfforts}
          canThink={canThink}
          effectiveThinking={effectiveThinking}
          effectiveEffort={effectiveEffort}
          editing={editingTurnId !== null}
          onCancelEdit={() => {
            setEditingTurnId(null);
            setDraft("");
          }}
          onSubmit={(event) => void sendMessage(event)}
          onKeyDown={handleKeyDown}
          onStop={stopStreaming}
        />
      </section>
    </main>
  );
}

function SettingsModal({
  settings,
  onClose,
  onSave,
}: {
  settings: ChatSettings;
  onClose: () => void;
  onSave: (settings: ChatSettings) => void;
}) {
  const [draft, setDraft] = useState(settings);
  const dialogRef = useRef<HTMLElement>(null);

  useEffect(() => {
    dialogRef.current?.querySelector<HTMLTextAreaElement>("textarea")?.focus();
    const closeOnEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") onClose();
      if (event.key !== "Tab" || !dialogRef.current) return;
      const focusable = Array.from(
        dialogRef.current.querySelectorAll<HTMLElement>("button, textarea"),
      ).filter((element) => !element.hasAttribute("disabled"));
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", closeOnEscape);
    return () => document.removeEventListener("keydown", closeOnEscape);
  }, [onClose]);

  return (
    <div className="settings-overlay" role="presentation" onMouseDown={(event) => {
      if (event.target === event.currentTarget) onClose();
    }}>
      <section ref={dialogRef} className="settings-dialog" role="dialog" aria-modal="true" aria-labelledby="settings-title">
        <div className="settings-header">
          <div>
            <div className="settings-kicker">Preferences</div>
            <h2 id="settings-title">Settings</h2>
          </div>
          <button type="button" className="settings-close" aria-label="Close settings" onClick={onClose}>×</button>
        </div>
        <label className="settings-field">
          <span>System prompt</span>
          <textarea
            value={draft.systemPrompt}
            maxLength={12000}
            onChange={(event) => setDraft((current) => ({ ...current, systemPrompt: event.target.value }))}
            rows={7}
          />
        </label>
        <label className="settings-field">
          <span>User presence</span>
          <textarea
            value={draft.userPresence}
            maxLength={12000}
            onChange={(event) => setDraft((current) => ({ ...current, userPresence: event.target.value }))}
            rows={5}
            placeholder="Optional context about you"
          />
        </label>
        <div className="settings-actions">
          <button type="button" className="settings-cancel" onClick={onClose}>Cancel</button>
          <button
            type="button"
            className="settings-save"
            disabled={!draft.systemPrompt.trim()}
            onClick={() => onSave({
              systemPrompt: draft.systemPrompt.trim(),
              userPresence: draft.userPresence.trim(),
            })}
          >
            Save
          </button>
        </div>
      </section>
    </div>
  );
}

function CallActivityIndicator() {
  return (
    <div className="call-activity-indicator" role="status" aria-label="Waiting for response">
      <span aria-hidden="true">✦</span>
    </div>
  );
}

function ReasoningBlock({
  message,
  liveDurationMs,
}: {
  message: Message;
  liveDurationMs?: number;
}) {
  const [open, setOpen] = useState(false);
  const duration = message.thinkingDurationMs ?? liveDurationMs;
  const isThinking = message.status === "streaming" && !message.content;

  return (
    <div className={`reasoning-block ${open ? "reasoning-open" : ""}`}>
      <button
        type="button"
        className="reasoning-summary"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
      >
        <span className="reasoning-chevron" aria-hidden="true">›</span>
        <span>{isThinking ? "Thinking" : "Thought process"}</span>
        {duration !== undefined && <span className="reasoning-duration">{formatDuration(duration)}</span>}
      </button>
      {open && (
        <div className="reasoning-content">
          {message.reasoning}
        </div>
      )}
    </div>
  );
}
