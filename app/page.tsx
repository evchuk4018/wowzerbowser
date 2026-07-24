"use client";

import {
  FormEvent,
  KeyboardEvent,
  MouseEvent as ReactMouseEvent,
  PointerEvent as ReactPointerEvent,
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
import {
  AssistantActivityTimeline,
  type AssistantActivity,
} from "./chat/assistant-activity";
import {
  MOBILE_HISTORY_CLICK_SUPPRESSION_MS,
  MobileHistorySwipeGesture,
} from "./chat/mobile-history-swipe";
import type {
  ChatAssistantRound,
  ChatArtifact,
  ChatMessageInput,
  ChatModelId,
  ChatReasoningEffort,
} from "../lib/chat-protocol";
import { DEFAULT_CHAT_MODELS } from "../lib/chat-protocol";

type Message = {
  id: string;
  role: "user" | "assistant";
  content: string;
  reasoning?: string;
  activities?: AssistantActivity[];
  artifacts?: ChatArtifact[];
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

function normalizeStoredMessage(message: Message): Message {
  if (message.role !== "assistant") return message;
  const loadedAt = Date.now();
  const freezeDuration = (startedAt?: number, durationMs?: number) =>
    durationMs ??
    (typeof startedAt === "number" && Number.isFinite(startedAt)
      ? Math.max(0, loadedAt - startedAt)
      : undefined);

  return {
    ...message,
    status: message.status === "streaming" ? "cancelled" : message.status,
    activities: message.activities?.map((activity) => {
      if (activity.kind === "reasoning" && activity.status === "running") {
        return {
          ...activity,
          status: "complete",
          durationMs: freezeDuration(activity.startedAt, activity.durationMs),
        };
      }
      if (activity.kind === "python" && activity.status === "running") {
        return {
          ...activity,
          status: "failed",
          durationMs: freezeDuration(activity.startedAt, activity.durationMs),
        };
      }
      return activity;
    }),
  };
}

function toChatMessageInput(message: Message): ChatMessageInput | null {
  const content = message.content.trim();
  if (!content) return null;
  if (message.role === "user" || !message.activities?.length) {
    return { role: message.role, content };
  }

  const rounds: ChatAssistantRound[] = [];
  const roundIndexes = new Map<number, number>();
  for (const activity of message.activities) {
    let roundIndex = roundIndexes.get(activity.round);
    if (roundIndex === undefined) {
      roundIndex = rounds.length;
      roundIndexes.set(activity.round, roundIndex);
      rounds.push({ content: "" });
    }
    const round = rounds[roundIndex];
    if (activity.kind === "reasoning") {
      round.reasoning = `${round.reasoning ?? ""}${activity.content}`;
    } else {
      const result =
        activity.result ??
        {
          id: activity.call.id,
          name: activity.call.name,
          ok: false,
          stdout: "",
          stderr: "Python execution was interrupted before a result was returned.",
        };
      round.toolCalls = [
        ...(round.toolCalls ?? []),
        {
          ...activity.call,
          result,
        },
      ];
    }
  }

  if (!rounds.length) return { role: "assistant", content };
  rounds[rounds.length - 1] = {
    ...rounds[rounds.length - 1],
    content,
  };
  return { role: "assistant", content, rounds };
}

function migrateConversation(value: unknown): Conversation | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Partial<Conversation> & { messages?: Message[] };
  if (typeof candidate.id !== "string" || typeof candidate.title !== "string") return null;
  if (Array.isArray(candidate.turns)) {
    return {
      id: candidate.id,
      title: candidate.title,
      turns: candidate.turns.map((turn) => ({
        ...turn,
        versions: turn.versions.map((version) => ({
          ...version,
          user: normalizeStoredMessage(version.user),
          assistant: normalizeStoredMessage(version.assistant),
        })),
      })),
    };
  }
  if (!Array.isArray(candidate.messages)) return null;

  const turns: ConversationTurn[] = [];
  for (let index = 0; index < candidate.messages.length; index += 2) {
    const user = candidate.messages[index];
    const assistant = candidate.messages[index + 1];
    if (!user || user.role !== "user" || !assistant || assistant.role !== "assistant") continue;
    turns.push({
      id: makeId(),
      versions: [{
        id: makeId(),
        user: normalizeStoredMessage(user),
        assistant: normalizeStoredMessage(assistant),
      }],
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
  const [ready, setReady] = useState(false);
  const [models, setModels] = useState(DEFAULT_CHAT_MODELS);
  const [model, setModel] = useState<ChatModelId>("deepseek-v4-flash");
  const [thinking, setThinking] = useState(false);
  const [effort, setEffort] = useState<ChatReasoningEffort>("high");
  const [streamingMessageId, setStreamingMessageId] = useState<string | null>(null);
  const [waitingMessageId, setWaitingMessageId] = useState<string | null>(null);
  const [thinkingMessageId, setThinkingMessageId] = useState<string | null>(null);
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
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const thinkingStartedAtRef = useRef<number | null>(null);
  const longPressTimerRef = useRef<number | null>(null);
  const mobileHistorySwipeRef = useRef(new MobileHistorySwipeGesture());
  const swipeClickResetTimerRef = useRef<number | null>(null);
  const activeRequestRef = useRef<{
    conversationId: string;
    messageId: string;
    controller: AbortController;
  } | null>(null);

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
  const latestActivity = latestMessage?.activities?.[latestMessage.activities.length - 1];
  const latestActivityContentLength =
    latestActivity?.kind === "reasoning" ? latestActivity.content.length : 0;
  const isStreaming = streamingMessageId !== null;
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
    if (!thinkingMessageId || thinkingStartedAtRef.current === null) return;
    const update = () => {
      const startedAt = thinkingStartedAtRef.current;
      if (startedAt !== null) setThinkingNow(performance.now() - startedAt);
    };
    update();
    const timer = window.setInterval(update, 100);
    return () => window.clearInterval(timer);
  }, [thinkingMessageId]);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [
    active?.turns.length,
    latestActivity?.kind,
    latestActivity?.status,
    latestActivityContentLength,
    latestMessage?.activities?.length,
    latestMessage?.artifacts?.length,
    latestMessage?.content.length,
    latestMessage?.reasoning?.length,
  ]);

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
    return () => activeRequestRef.current?.controller.abort();
  }, []);

  useEffect(() => {
    const resetMobileHistorySwipe = () => {
      mobileHistorySwipeRef.current.cancel();
      if (swipeClickResetTimerRef.current !== null) {
        window.clearTimeout(swipeClickResetTimerRef.current);
        swipeClickResetTimerRef.current = null;
      }
    };
    window.addEventListener("blur", resetMobileHistorySwipe);
    window.addEventListener("resize", resetMobileHistorySwipe);
    return () => {
      window.removeEventListener("blur", resetMobileHistorySwipe);
      window.removeEventListener("resize", resetMobileHistorySwipe);
      resetMobileHistorySwipe();
    };
  }, []);

  useEffect(() => {
    if (settingsOpen) mobileHistorySwipeRef.current.cancel();
  }, [settingsOpen]);

  const handleMobileHistoryPointerDown = (event: ReactPointerEvent<HTMLElement>) => {
    mobileHistorySwipeRef.current.begin({
      clientX: event.clientX,
      clientY: event.clientY,
      disabled: settingsOpen,
      isPrimary: event.isPrimary,
      pointerId: event.pointerId,
      pointerType: event.pointerType,
      sidebarOpen,
      viewportWidth: window.innerWidth,
    });
  };

  const handleMobileHistoryPointerMove = (event: ReactPointerEvent<HTMLElement>) => {
    const hasHorizontalIntent = mobileHistorySwipeRef.current.move({
      clientX: event.clientX,
      clientY: event.clientY,
      pointerId: event.pointerId,
    });
    if (hasHorizontalIntent && event.cancelable) event.preventDefault();
  };

  const scheduleSwipeClickReset = () => {
    if (!mobileHistorySwipeRef.current.hasClickSuppression()) return;
    if (swipeClickResetTimerRef.current !== null) {
      window.clearTimeout(swipeClickResetTimerRef.current);
    }
    swipeClickResetTimerRef.current = window.setTimeout(() => {
      mobileHistorySwipeRef.current.clearClickSuppression();
      swipeClickResetTimerRef.current = null;
    }, MOBILE_HISTORY_CLICK_SUPPRESSION_MS);
  };

  const handleMobileHistoryPointerUp = (event: ReactPointerEvent<HTMLElement>) => {
    if (!mobileHistorySwipeRef.current.isTrackingPointer(event.pointerId)) return;
    const action = mobileHistorySwipeRef.current.end({
      clientX: event.clientX,
      clientY: event.clientY,
      pointerId: event.pointerId,
    });
    if (action === "open") {
      setOpenMenu(null);
      setOpenMessageActions(null);
      setSidebarOpen(true);
    } else if (action === "close") {
      setSidebarOpen(false);
    }
    scheduleSwipeClickReset();
  };

  const handleMobileHistoryPointerCancel = (event: ReactPointerEvent<HTMLElement>) => {
    mobileHistorySwipeRef.current.cancel(event.pointerId);
  };

  const handleMobileHistoryClickCapture = (event: ReactMouseEvent<HTMLElement>) => {
    if (!mobileHistorySwipeRef.current.consumeClickSuppression()) return;
    event.preventDefault();
    event.stopPropagation();
  };

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
    setSidebarOpen(false);
    requestAnimationFrame(() => textareaRef.current?.focus());
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
    const activeRequest = activeRequestRef.current;
    if (!activeRequest) return;
    activeRequest.controller.abort();
    updateMessage(activeRequest.conversationId, activeRequest.messageId, (message) => ({
      ...message,
      status: "cancelled",
    }));
    activeRequestRef.current = null;
    setStreamingMessageId(null);
    setWaitingMessageId(null);
    setThinkingMessageId(null);
    thinkingStartedAtRef.current = null;
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
    if (!content || !activeId || isStreaming || !active) return;

    const userMessage: Message = { id: makeId(), role: "user", content };
    const assistantMessage: Message = {
      id: makeId(),
      role: "assistant",
      content: "",
      reasoning: "",
      activities: [],
      artifacts: [],
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
      .map(toChatMessageInput)
      .filter((message): message is ChatMessageInput => message !== null);

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
    activeRequestRef.current = {
      conversationId,
      messageId: assistantMessage.id,
      controller,
    };
    setStreamingMessageId(assistantMessage.id);
    if (requestThinkingStartedAt !== null) {
      thinkingStartedAtRef.current = requestThinkingStartedAt;
      setThinkingNow(0);
      setThinkingMessageId(assistantMessage.id);
    }

    let streamError = false;
    let currentRound = 1;
    const finishRunningActivities = (
      message: Message,
      failed = false,
    ): Message => ({
      ...message,
      activities: message.activities?.map((activity) => {
        if (activity.kind === "reasoning" && activity.status === "running") {
          return {
            ...activity,
            status: "complete" as const,
            durationMs:
              activity.durationMs ??
              (activity.startedAt === undefined ? undefined : Date.now() - activity.startedAt),
          };
        }
        if (activity.kind === "python" && activity.status === "running" && failed) {
          return {
            ...activity,
            status: "failed" as const,
            durationMs:
              activity.durationMs ??
              (activity.startedAt === undefined ? undefined : Date.now() - activity.startedAt),
          };
        }
        return activity;
      }),
    });
    try {
      const accessToken = await getAccessToken();
      if (!accessToken) throw new Error("Your session expired. Please sign in again.");
      if (controller.signal.aborted || activeRequestRef.current?.messageId !== assistantMessage.id) {
        return;
      }

      const request = {
        messages: requestMessages,
        systemPrompt: settings.systemPrompt,
        userPresence: settings.userPresence,
        model,
        thinking: effectiveThinking,
        reasoningEffort: effectiveEffort,
        conversationId,
      };

      setWaitingMessageId(assistantMessage.id);
      for await (const event of streamChatResponse(request, accessToken, controller.signal)) {
        if (event.type === "round") {
          updateMessage(conversationId, assistantMessage.id, (message) =>
            finishRunningActivities(message),
          );
          currentRound = event.round;
        } else if (event.type === "reasoning") {
          setWaitingMessageId((current) =>
            current === assistantMessage.id ? null : current,
          );
          updateMessage(conversationId, assistantMessage.id, (message) => {
            const activities = [...(message.activities ?? [])];
            const latest = activities[activities.length - 1];
            if (
              latest?.kind === "reasoning" &&
              latest.round === currentRound &&
              latest.status === "running"
            ) {
              activities[activities.length - 1] = {
                ...latest,
                content: `${latest.content}${event.delta}`,
              };
            } else {
              activities.push({
                id: makeId(),
                kind: "reasoning",
                round: currentRound,
                content: event.delta,
                status: "running",
                startedAt: Date.now(),
              });
            }
            return {
              ...message,
              reasoning: `${message.reasoning ?? ""}${event.delta}`,
              activities,
            };
          });
        } else if (event.type === "tool_call") {
          setWaitingMessageId((current) =>
            current === assistantMessage.id ? null : current,
          );
          updateMessage(conversationId, assistantMessage.id, (message) => {
            const finished = finishRunningActivities(message);
            return {
              ...finished,
              activities: [
                ...(finished.activities ?? []),
                {
                  id: event.call.id,
                  kind: "python",
                  round: currentRound,
                  call: event.call,
                  status: "running",
                  startedAt: Date.now(),
                },
              ],
            };
          });
        } else if (event.type === "tool_result") {
          updateMessage(conversationId, assistantMessage.id, (message) => ({
            ...message,
            activities: message.activities?.map((activity) =>
              activity.kind === "python" && activity.call.id === event.result.id
                ? {
                    ...activity,
                    result: event.result,
                    status: event.result.ok ? "completed" : "failed",
                    durationMs:
                      event.result.durationMs ??
                      (activity.startedAt === undefined
                        ? undefined
                        : Date.now() - activity.startedAt),
                  }
                : activity,
            ),
            artifacts: [
              ...(message.artifacts ?? []),
              ...(event.result.artifacts ?? []).filter(
                (artifact) =>
                  !(message.artifacts ?? []).some((existing) => existing.id === artifact.id),
              ),
            ],
          }));
        } else if (event.type === "artifact") {
          updateMessage(conversationId, assistantMessage.id, (message) => ({
            ...message,
            artifacts: (message.artifacts ?? []).some(
              (artifact) => artifact.id === event.artifact.id,
            )
              ? message.artifacts
              : [...(message.artifacts ?? []), event.artifact],
          }));
        } else if (event.type === "content") {
          setWaitingMessageId((current) =>
            current === assistantMessage.id ? null : current,
          );
          if (requestThinkingStartedAt !== null && !requestThinkingFinished) {
            const duration = performance.now() - requestThinkingStartedAt;
            requestThinkingFinished = true;
            if (activeRequestRef.current?.messageId === assistantMessage.id) {
              thinkingStartedAtRef.current = null;
              setThinkingMessageId(null);
            }
            updateMessage(conversationId, assistantMessage.id, (message) => ({
              ...finishRunningActivities(message, true),
              thinkingDurationMs: duration,
              content: `${message.content}${event.delta}`,
            }));
          } else {
            updateMessage(conversationId, assistantMessage.id, (message) => ({
              ...finishRunningActivities(message, true),
              content: `${message.content}${event.delta}`,
            }));
          }
        } else if (event.type === "error") {
          setWaitingMessageId((current) =>
            current === assistantMessage.id ? null : current,
          );
          streamError = true;
          updateMessage(conversationId, assistantMessage.id, (message) => ({
            ...finishRunningActivities(message, true),
            status: "error",
            error: event.message,
          }));
        } else if (event.type === "done") {
          setWaitingMessageId((current) =>
            current === assistantMessage.id ? null : current,
          );
          updateMessage(conversationId, assistantMessage.id, (message) => ({
            ...finishRunningActivities(message, true),
            status: streamError ? "error" : "complete",
          }));
        }
      }
    } catch (error: unknown) {
      if (controller.signal.aborted) {
        updateMessage(conversationId, assistantMessage.id, (message) => ({
          ...finishRunningActivities(message, true),
          status: "cancelled",
        }));
      } else {
        updateMessage(conversationId, assistantMessage.id, (message) => ({
          ...finishRunningActivities(message, true),
          status: "error",
          error: error instanceof Error ? error.message : "The response failed.",
        }));
      }
    } finally {
      const isCurrentRequest = activeRequestRef.current?.messageId === assistantMessage.id;
      if (isCurrentRequest) {
        activeRequestRef.current = null;
        setStreamingMessageId(null);
        setWaitingMessageId((current) =>
          current === assistantMessage.id ? null : current,
        );
        thinkingStartedAtRef.current = null;
        setThinkingMessageId(null);
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
  const closeSettings = () => {
    setSettingsOpen(false);
    requestAnimationFrame(() => settingsButtonRef.current?.focus());
  };

  return (
    <main
      className="app-shell"
      onClickCapture={handleMobileHistoryClickCapture}
      onPointerCancel={handleMobileHistoryPointerCancel}
      onPointerDown={handleMobileHistoryPointerDown}
      onPointerMove={handleMobileHistoryPointerMove}
      onPointerUp={handleMobileHistoryPointerUp}
    >
      <button
        className="mobile-menu"
        type="button"
        aria-label="Open conversation menu"
        aria-expanded={sidebarOpen}
        onClick={() => setSidebarOpen((open) => !open)}
      >
        <span />
        <span />
      </button>

      {sidebarOpen && (
        <button
          type="button"
          className="sidebar-scrim"
          aria-label="Close conversation menu"
          onClick={() => setSidebarOpen(false)}
        />
      )}

      <aside className={`sidebar ${sidebarOpen ? "sidebar-open" : ""}`}>
        <div className="sidebar-top">
          <div className="product-name">Chat</div>
          <button
            type="button"
            className="square-button"
            aria-label="Collapse sidebar"
            onClick={() => setSidebarOpen(false)}
          >
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
                setSidebarOpen(false);
              }}
            >
              {conversation.title}
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
                    {(assistantMessage.activities?.length ?? 0) > 0 ||
                    (assistantMessage.artifacts?.length ?? 0) > 0 ? (
                      <AssistantActivityTimeline
                        activities={assistantMessage.activities ?? []}
                        content={assistantMessage.content}
                        artifacts={assistantMessage.artifacts ?? []}
                        getAccessToken={getAccessToken}
                      />
                    ) : (
                      <>
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
                      </>
                    )}
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
