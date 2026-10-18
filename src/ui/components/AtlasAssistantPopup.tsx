import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { motion, useDragControls, useMotionValue } from "motion/react";
import {
  ArrowUp,
  Bot,
  CheckCircle2,
  ChevronDown,
  Loader2,
  Mic,
  MoreHorizontal,
  Plus,
  ShieldCheck,
  X,
} from "lucide-react";

import { useAuth } from "@/auth";
import { buildConversionRates } from "@/lib/budget";
import { cn } from "@/lib/utils";
import { resolveIsolatedTextDirection } from "@/lib/textDirection";
import {
  answerAssistantQuery,
  assistantIntentCatalog,
  createAtlasSpeechAdapter,
  type AssistantAnswer,
  type AssistantLanguage,
  type AssistantSpeechAvailability,
} from "@/lib/atlasAssistant";
import { useExchangeRate } from "@/context/ExchangeRateContext";
import { useWorkspace } from "@/workspace/WorkspaceContext";
import { useWorkspacePermissions } from "@/permissions";
import { Button } from "./button";

const POSITION_KEY = "atlas-assistant-popup-position";
const DEFAULT_WIDTH = 464;
const MIN_MARGIN = 12;

interface AtlasAssistantPopupProps {
  open: boolean;
  initialQuery?: string;
  onClose: () => void;
}

interface PopupPosition {
  x: number;
  y: number;
}

interface ConversationItem {
  id: string;
  query: string;
  answer: AssistantAnswer;
}

type SpeechPhase = "idle" | "recording" | "processing";

function getDefaultPosition(): PopupPosition {
  if (typeof window === "undefined") {
    return { x: 320, y: 420 };
  }

  const width = Math.min(DEFAULT_WIDTH, window.innerWidth - MIN_MARGIN * 2);
  return {
    x: Math.max(MIN_MARGIN, Math.round((window.innerWidth - width) / 2)),
    y: Math.max(MIN_MARGIN, window.innerHeight - 132),
  };
}

function clampPosition(position: PopupPosition, width = DEFAULT_WIDTH) {
  if (typeof window === "undefined") return position;
  const effectiveWidth = Math.min(width, window.innerWidth - MIN_MARGIN * 2);
  const maxX = Math.max(MIN_MARGIN, window.innerWidth - effectiveWidth - MIN_MARGIN);
  const maxY = Math.max(MIN_MARGIN, window.innerHeight - 112);
  return {
    x: Math.min(Math.max(position.x, MIN_MARGIN), maxX),
    y: Math.min(Math.max(position.y, MIN_MARGIN), maxY),
  };
}

function loadPosition() {
  try {
    const raw = localStorage.getItem(POSITION_KEY);
    if (!raw) return getDefaultPosition();
    const parsed = JSON.parse(raw) as Partial<PopupPosition>;
    if (typeof parsed.x === "number" && typeof parsed.y === "number") {
      return clampPosition({ x: parsed.x, y: parsed.y });
    }
  } catch {
    // Ignore corrupted local positioning.
  }
  return getDefaultPosition();
}

function statusColor(status: AssistantAnswer["status"]) {
  if (status === "answered") return "text-emerald-300";
  if (status === "no_access" || status === "error") return "text-red-300";
  if (status === "needs_clarification" || status === "unsupported") return "text-amber-300";
  return "text-zinc-300";
}

function getSpeechErrorMessage(error: unknown, fallback: string) {
  if (error instanceof Error && error.message) {
    return error.message;
  }
  if (typeof error === "string" && error.trim()) {
    return error.trim();
  }
  try {
    const serialized = JSON.stringify(error);
    if (serialized && serialized !== "{}") {
      return serialized;
    }
  } catch {
    // Keep the fallback.
  }
  return fallback;
}

export function AtlasAssistantPopup({ open, initialQuery, onClose }: AtlasAssistantPopupProps) {
  const { t, i18n } = useTranslation();
  const catalogLang: AssistantLanguage = i18n.language === "ar" ? "ar" : i18n.language === "ku" ? "ku" : "en";
  const { user } = useAuth();
  const { activeWorkspace, features, hasFeature } = useWorkspace();
  const { hasPermission } = useWorkspacePermissions();
  const { exchangeData, eurRates, tryRates } = useExchangeRate();
  const dragControls = useDragControls();
  const [position, setPosition] = useState<PopupPosition>(() => loadPosition());
  const dragX = useMotionValue(position.x);
  const dragY = useMotionValue(position.y);
  const [query, setQuery] = useState("");
  const [items, setItems] = useState<ConversationItem[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [quickPromptsOpen, setQuickPromptsOpen] = useState(false);
  const [speechNotice, setSpeechNotice] = useState<string | null>(null);
  const [speechAvailability, setSpeechAvailability] = useState<AssistantSpeechAvailability | null>(null);
  const [isCheckingSpeech, setIsCheckingSpeech] = useState(false);
  const [speechPhase, setSpeechPhase] = useState<SpeechPhase>("idle");
  const inputRef = useRef<HTMLInputElement>(null);
  const popupRef = useRef<HTMLDivElement>(null);
  const autoContainerRef = useRef<HTMLDivElement>(null);
  const [autoFocused, setAutoFocused] = useState(false);
  const [justAutoSelected, setJustAutoSelected] = useState(false);
  const speechAdapter = useMemo(() => createAtlasSpeechAdapter(), []);

  const workspaceId = activeWorkspace?.id || user?.workspaceId;
  const isExpanded = items.length > 0 || isLoading;
  const isRecordingSpeech = speechPhase === "recording";
  const isProcessingSpeech = speechPhase === "processing";
  const rates = useMemo(
    () => buildConversionRates(exchangeData, eurRates, tryRates),
    [exchangeData, eurRates, tryRates],
  );

  useEffect(() => {
    if (!open) return;
    setPosition((current) => {
      const clamped = clampPosition(current, popupRef.current?.getBoundingClientRect().width ?? DEFAULT_WIDTH);
      dragX.set(clamped.x);
      dragY.set(clamped.y);
      return clamped;
    });
    window.setTimeout(() => inputRef.current?.focus(), 40);
  }, [dragX, dragY, open]);

  useEffect(() => {
    if (!open) return;

    let cancelled = false;
    setIsCheckingSpeech(true);
    speechAdapter
      .getAvailability(true)
      .then((availability) => {
        if (!cancelled) {
          setSpeechAvailability(availability);
        }
      })
      .catch((error) => {
        console.error("[Atlas Voice] availability check failed", error);
        if (!cancelled) {
          setSpeechAvailability({
            available: false,
            status: "error",
            message: getSpeechErrorMessage(
              error,
              "KurdishTTS website transcription availability could not be checked.",
            ),
          });
        }
      })
      .finally(() => {
        if (!cancelled) {
          setIsCheckingSpeech(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [open, speechAdapter]);

  useEffect(() => {
    if (open && initialQuery) {
      setQuery(initialQuery);
    }
  }, [initialQuery, open]);

  useEffect(() => {
    localStorage.setItem(POSITION_KEY, JSON.stringify(position));
  }, [position]);

  useEffect(() => {
    if (!open) return;
    const handleResize = () => setPosition((current) => {
      const clamped = clampPosition(current, popupRef.current?.getBoundingClientRect().width ?? DEFAULT_WIDTH);
      dragX.set(clamped.x);
      dragY.set(clamped.y);
      return clamped;
    });
    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, [dragX, dragY, open]);

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (autoContainerRef.current && !autoContainerRef.current.contains(event.target as Node)) {
        setAutoFocused(false);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  useEffect(() => {
    if (justAutoSelected) {
      const timeout = setTimeout(() => setJustAutoSelected(false), 200);
      return () => clearTimeout(timeout);
    }
  }, [justAutoSelected]);

  useEffect(() => {
    if (!open) return;

    const handleRecordingStopped = (event: Event) => {
      const detail = (event as CustomEvent<{ reason?: "silence" | "limit" }>).detail;
      setSpeechPhase((current) => current === "recording" ? "processing" : current);
      setSpeechNotice(
        detail?.reason === "silence"
          ? t("assistant.voiceSilenceProcessing", "Silence detected. Processing voice with KurdishTTS...")
          : t("assistant.voiceProcessing", "Processing voice with KurdishTTS..."),
      );
    };

    window.addEventListener("atlas-assistant-voice-recording-stopped", handleRecordingStopped);
    return () => window.removeEventListener("atlas-assistant-voice-recording-stopped", handleRecordingStopped);
  }, [open, t]);

  const submitQuery = useCallback(async (value: string) => {
    const trimmed = value.trim();
    if (!trimmed || !workspaceId || isLoading) return;

    setIsLoading(true);
    setQuery("");
    setQuickPromptsOpen(false);
    setSpeechNotice(null);

    const answer = await answerAssistantQuery(trimmed, {
      workspaceId,
      defaultCurrency: features.default_currency,
      iqdDisplayPreference: features.iqd_display_preference,
      rates,
      hasFeature,
      hasPermission,
    });

    setItems((current) => [
      {
        id: `${Date.now()}-${current.length}`,
        query: trimmed,
        answer,
      },
      ...current,
    ].slice(0, 8));
    setIsLoading(false);
  }, [
    features.default_currency,
    features.iqd_display_preference,
    hasFeature,
    hasPermission,
    isLoading,
    rates,
    workspaceId,
  ]);

  const handleDragEnd = useCallback(() => {
    const clamped = clampPosition(
      {
        x: dragX.get(),
        y: dragY.get(),
      },
      popupRef.current?.getBoundingClientRect().width ?? DEFAULT_WIDTH,
    );
    dragX.set(clamped.x);
    dragY.set(clamped.y);
    setPosition(clamped);
  }, [dragX, dragY]);

  const handleSpeechClick = useCallback(async () => {
    if (isCheckingSpeech || isProcessingSpeech) {
      return;
    }

    if (isRecordingSpeech) {
      const stopped = speechAdapter.stopDictation?.() ?? false;
      if (stopped) {
        setSpeechPhase("processing");
        setSpeechNotice(t("assistant.voiceProcessing", "Processing voice with KurdishTTS..."));
      } else {
        setSpeechNotice(t("assistant.voiceStarting", "Recording is starting. Click again in a moment to stop."));
      }
      return;
    }

    const availability = speechAvailability ?? await speechAdapter.getAvailability(true);
    setSpeechAvailability(availability);

    if (!availability.available) {
      setSpeechNotice(t(
        "assistant.voiceUnavailable",
        availability.message || "Voice-to-text is available only in the Tauri desktop app.",
      ));
      return;
    }

    setSpeechPhase("recording");
    setSpeechNotice(t(
      "assistant.voiceListening",
      "Recording... it will stop after 1 second of silence, or click the mic again to stop.",
    ));

    try {
      const result = await speechAdapter.startDictation();
      setQuery(result.transcript);
      setSpeechNotice(
        result.confidence == null
          ? t("assistant.voiceTranscriptReady", "Transcript is ready. Review it, then send.")
          : t(
            "assistant.voiceTranscriptReadyWithConfidence",
            {
              defaultValue: "Transcript is ready. Confidence: {{confidence}}%.",
              confidence: Math.round(result.confidence * 100),
            },
          ),
      );
      inputRef.current?.focus();
    } catch (error) {
      console.error("[Atlas Voice] transcription failed", error);
      setSpeechNotice(getSpeechErrorMessage(
        error,
        t("assistant.voiceFailed", "KurdishTTS transcription failed. Type your question for now."),
      ));
    } finally {
      setSpeechPhase("idle");
    }
  }, [isCheckingSpeech, isProcessingSpeech, isRecordingSpeech, speechAdapter, speechAvailability, t]);

  const promptExamples = useMemo(
    () => assistantIntentCatalog.slice(0, 6).map((entry) => entry.phrases[catalogLang][0]),
    [],
  );

  const filteredCatalog = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q || q.length < 1) return [];
    return assistantIntentCatalog
      .filter((entry) =>
        Object.values(entry.phrases).flat().some((phrase) =>
          phrase.toLowerCase().includes(q),
        ),
      )
      .slice(0, 8);
  }, [query]);

  const showAutoComplete = autoFocused && !justAutoSelected && filteredCatalog.length > 0;

  const handleSelectCatalog = useCallback((entry: typeof assistantIntentCatalog[number]) => {
    setJustAutoSelected(true);
    setQuery(entry.phrases[catalogLang][0]);
    setAutoFocused(false);
    inputRef.current?.focus();
  }, []);

  if (!open) return null;

  const latestAnswer = items[0]?.answer;
  const speechTitle = isRecordingSpeech
    ? t("assistant.voiceStop", "Stop recording and transcribe")
    : isProcessingSpeech
      ? t("assistant.voiceProcessing", "Processing voice with KurdishTTS...")
      : speechAvailability?.available
        ? t("assistant.voiceReady", "Record a Sorani voice question")
        : t(
          "assistant.voiceUnavailable",
          speechAvailability?.message || "Voice-to-text is available only in the Tauri desktop app.",
        );

  return (
    <div className="fixed inset-0 z-[120] pointer-events-none">
      <motion.div
        ref={popupRef}
        drag
        dragControls={dragControls}
        dragListener={false}
        dragMomentum={false}
        onDragEnd={handleDragEnd}
        initial={{ opacity: 0, scale: 0.96 }}
        animate={{ opacity: 1, scale: 1 }}
        exit={{ opacity: 0, scale: 0.96 }}
        className="pointer-events-auto absolute max-w-[calc(100vw-24px)] select-none"
        style={{
          left: 0,
          top: 0,
          x: dragX,
          y: dragY,
          width: `min(${DEFAULT_WIDTH}px, calc(100vw - 24px))`,
        }}
      >
        {isExpanded && (
          <div className="absolute bottom-[calc(100%+0.5rem)] left-0 right-0 overflow-hidden rounded-[22px] border border-white/10 bg-zinc-950/95 text-zinc-100 shadow-2xl shadow-black/40 backdrop-blur-xl">
            <div className="flex items-center justify-between border-b border-white/10 px-4 py-2">
              <div className="flex items-center gap-2 text-xs font-medium text-zinc-300">
                <Bot className="h-4 w-4 text-orange-300" />
                <span>{t("assistant.title", "Atlas Assistant")}</span>
                {latestAnswer && (
                  <span className={cn("inline-flex items-center gap-1", statusColor(latestAnswer.status))}>
                    <CheckCircle2 className="h-3 w-3" />
                    {latestAnswer.status.replace(/_/g, " ")}
                  </span>
                )}
              </div>
              <button
                type="button"
                onClick={onClose}
                className="rounded-full p-1 text-zinc-500 transition-colors hover:bg-white/10 hover:text-zinc-100"
                aria-label={t("common.close", "Close")}
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <div className="max-h-[min(420px,calc(100vh-180px))] overflow-y-auto p-3 custom-scrollbar">
              {isLoading && (
                <div className="flex items-center gap-2 rounded-xl bg-white/[0.04] px-3 py-3 text-sm text-zinc-300">
                  <Loader2 className="h-4 w-4 animate-spin text-orange-300" />
                  {t("assistant.thinking", "Checking local Atlas data...")}
                </div>
              )}

              <div className="space-y-3">
                {items.map((item) => (
                  <div key={item.id} className="space-y-2 rounded-2xl bg-white/[0.04] p-3">
                    <div
                      className="text-xs text-zinc-400"
                      dir={resolveIsolatedTextDirection(item.query)}
                    >
                      {item.query}
                    </div>
                    <div className="space-y-2" dir={i18n.dir()}>
                      <div className="flex items-start justify-between gap-3">
                        <div>
                          <div className="text-sm font-semibold text-zinc-50">{item.answer.title}</div>
                          <p className="mt-1 text-sm leading-5 text-zinc-300">{item.answer.summary}</p>
                        </div>
                        <span className="shrink-0 rounded-full bg-white/10 px-2 py-1 text-[10px] font-semibold text-zinc-300">
                          {Math.round(item.answer.confidence * 100)}%
                        </span>
                      </div>

                      {item.answer.metrics && item.answer.metrics.length > 0 && (
                        <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
                          {item.answer.metrics.map((metric) => (
                            <div key={`${item.id}-${metric.label}`} className="min-w-0 rounded-xl bg-black/30 px-3 py-2">
                              <div className="truncate text-[10px] uppercase text-zinc-500">{metric.label}</div>
                              <div className={cn(
                                "truncate text-sm font-semibold text-zinc-100",
                                metric.tone === "positive" && "text-emerald-300",
                                metric.tone === "negative" && "text-red-300",
                                metric.tone === "warning" && "text-amber-300",
                              )}>
                                {metric.value}
                              </div>
                            </div>
                          ))}
                        </div>
                      )}

                      {item.answer.rows && item.answer.rows.length > 0 && (
                        <div className="divide-y divide-white/10 overflow-hidden rounded-xl border border-white/10">
                          {item.answer.rows.slice(0, 8).map((row) => (
                            <div key={`${item.id}-${row.id}`} className="grid grid-cols-[1fr_auto] gap-3 px-3 py-2 text-sm">
                              <div className="min-w-0">
                                <div className="truncate text-zinc-100">{row.label}</div>
                                {row.detail && <div className="truncate text-xs text-zinc-500">{row.detail}</div>}
                              </div>
                              <div className="max-w-[150px] truncate text-right font-medium text-zinc-200">{row.value}</div>
                            </div>
                          ))}
                        </div>
                      )}

                      {item.answer.routePath && (
                        <Button
                          size="sm"
                          variant="outline"
                          className="h-8 rounded-full border-white/10 bg-white/[0.04] text-xs text-zinc-200 hover:bg-white/10"
                          onClick={() => {
                            window.location.hash = item.answer.routePath || "/";
                          }}
                        >
                          {t("assistant.openModule", "Open module")}
                        </Button>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}

        <div ref={autoContainerRef} className="relative">
          {showAutoComplete ? (
            <div className="absolute bottom-full left-4 right-4 z-[200] mb-2 max-h-56 overflow-y-auto rounded-xl border border-white/10 bg-zinc-950 p-1 shadow-lg">
              {filteredCatalog.map((entry) => (
                <button
                  key={entry.id}
                  type="button"
                  className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm text-zinc-300 transition-colors hover:bg-white/10 hover:text-zinc-50"
                  onMouseDown={(e) => {
                    e.preventDefault();
                    handleSelectCatalog(entry);
                  }}
                >
                  <div className="min-w-0 flex-1">
                    <div className="truncate font-medium text-zinc-100">{entry.phrases[catalogLang][0]}</div>
                  </div>
                  <span className="shrink-0 rounded-full bg-white/10 px-2 py-0.5 text-[10px] font-semibold text-zinc-400">
                    {entry.module}
                  </span>
                </button>
              ))}
            </div>
          ) : null}

          <div className="rounded-[30px] border border-white/10 bg-[#101010] text-zinc-100 shadow-2xl shadow-black/40">
            <form
              className="px-4 pb-2 pt-2"
              onSubmit={(event) => {
                event.preventDefault();
                void submitQuery(query);
              }}
            >
              <div className="relative">
                <input
                  ref={inputRef}
                  value={query}
                  onChange={(event) => {
                    setJustAutoSelected(false);
                    setQuery(event.target.value);
                  }}
                  onFocus={() => setAutoFocused(true)}
                  placeholder={t("assistant.placeholder", "Ask Atlas anything locally")}
                  className="h-10 w-full bg-transparent text-sm text-zinc-100 outline-none placeholder:text-zinc-500"
                  dir={resolveIsolatedTextDirection(query)}
                  autoComplete="off"
                  spellCheck={false}
                />
              </div>

              <div className="relative flex items-center justify-between gap-2">
                <div className="flex items-center gap-1">
                  <button
                    type="button"
                    onClick={() => setQuickPromptsOpen((value) => !value)}
                    className="rounded-full p-2 text-zinc-400 transition-colors hover:bg-white/10 hover:text-zinc-100"
                    title={t("assistant.quickPrompts", "Quick prompts")}
                    aria-label={t("assistant.quickPrompts", "Quick prompts")}
                  >
                    <Plus className="h-4 w-4" />
                  </button>
                  <span
                    className="inline-flex items-center gap-1 rounded-full px-2 py-1 text-[11px] font-medium text-orange-300"
                    title={t("assistant.localRulesOnly", "Local deterministic rules only")}
                  >
                    <ShieldCheck className="h-3.5 w-3.5" />
                    <ChevronDown className="h-3 w-3" />
                  </span>
                </div>

                <div className="flex items-center gap-1">
                  <span className="rounded-full px-2 py-1 text-xs font-semibold text-zinc-200">Local</span>
                  <button
                    type="button"
                    className="rounded-full p-2 text-zinc-500 transition-colors hover:bg-white/10 hover:text-zinc-100"
                    title={t("assistant.more", "More")}
                    aria-label={t("assistant.more", "More")}
                  >
                    <MoreHorizontal className="h-4 w-4" />
                  </button>
                  <button
                    type="button"
                    onClick={handleSpeechClick}
                    className={cn(
                      "rounded-full p-2 transition-colors hover:bg-white/10",
                      speechAvailability?.available
                        ? "text-emerald-300 hover:text-emerald-100"
                        : "text-zinc-500 hover:text-zinc-100",
                      isRecordingSpeech && "bg-red-500/15 text-red-200",
                      isProcessingSpeech && "bg-amber-500/15 text-amber-200",
                    )}
                    title={speechTitle}
                    aria-label={t("assistant.voice", "Voice-to-text")}
                  >
                    {isCheckingSpeech || isProcessingSpeech
                      ? <Loader2 className="h-4 w-4 animate-spin" />
                      : <Mic className="h-4 w-4" />}
                  </button>
                  <button
                    type="submit"
                    disabled={!query.trim() || isLoading || !workspaceId}
                    className="inline-flex h-9 w-9 items-center justify-center rounded-full bg-zinc-200 text-zinc-950 transition-colors hover:bg-white disabled:cursor-not-allowed disabled:opacity-50"
                    title={t("assistant.send", "Send")}
                    aria-label={t("assistant.send", "Send")}
                  >
                    {isLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : <ArrowUp className="h-4 w-4" />}
                  </button>
                </div>

                {quickPromptsOpen && (
                  <div className="absolute bottom-full left-0 mb-3 w-[min(360px,calc(100vw-40px))] overflow-hidden rounded-2xl border border-white/10 bg-zinc-950 p-2 shadow-2xl">
                    {promptExamples.map((prompt) => (
                      <button
                        key={prompt}
                        type="button"
                        className="block w-full rounded-xl px-3 py-2 text-left text-xs text-zinc-300 transition-colors hover:bg-white/10 hover:text-zinc-50"
                        onClick={() => {
                          setQuery(prompt);
                          setQuickPromptsOpen(false);
                          inputRef.current?.focus();
                        }}
                      >
                        {prompt}
                      </button>
                    ))}
                  </div>
                )}
              </div>

              {speechNotice && (
                <div className="mt-2 rounded-full bg-amber-500/10 px-3 py-1 text-[11px] text-amber-200">
                  {speechNotice}
                </div>
              )}
            </form>
            <div className="flex justify-center pb-2">
              <button
                type="button"
                className="h-1.5 w-[25rem] max-w-[85%] cursor-grab rounded-full bg-zinc-500/70 transition-colors hover:bg-zinc-300/80 active:cursor-grabbing"
                onPointerDown={(event) => dragControls.start(event)}
                title={t("assistant.dragHandle", "Drag assistant")}
                aria-label={t("assistant.dragHandle", "Drag assistant")}
              />
            </div>
          </div>
        </div>
      </motion.div>
    </div>
  );
}
