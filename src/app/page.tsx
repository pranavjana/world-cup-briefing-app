"use client";

import {
  FormEvent,
  KeyboardEvent,
  type ReactNode,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import Image from "next/image";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import type { BriefingPayload, VideoCandidate } from "@/lib/demo-data";

type SearchResponse = {
  mode: string;
  query: string;
  source: string;
  error?: string;
  results: VideoCandidate[];
};

type ToolStep = {
  id: string;
  name: string;
  status: "queued" | "running" | "done" | "error";
  summary: string;
  details?: unknown;
};

type AgentFinishData = {
  mode: "agent" | "agent-error";
  model?: string;
  prompt: string;
  toolCalls: ToolStep[];
  search: SearchResponse | null;
  selectedVideo: VideoCandidate | null;
  briefing: BriefingPayload | null;
};

type AgentStreamEvent =
  | { type: "meta"; model: string; prompt: string }
  | { type: "text-delta"; text: string }
  | { type: "tool"; toolCall: ToolStep }
  | { type: "finish"; data: AgentFinishData }
  | { type: "error"; error: string; data: AgentFinishData };

type ChatItem =
  | { kind: "text"; id: string; text: string }
  | { kind: "tool"; id: string; step: ToolStep };

type ChatEntry = {
  id: string;
  role: "user" | "assistant";
  items: ChatItem[];
  pending?: boolean;
  model?: string;
  search?: SearchResponse | null;
  selectedVideo?: VideoCandidate | null;
  briefing?: BriefingPayload | null;
};

const examples = [
  "highlights of fouls from USA vs Paraguay",
  "all yellow cards from Brazil vs Morocco",
  "penalty moments from Mexico vs South Africa",
];

// The timeline is strictly chronological: text and tool items render in
// arrival order. Consecutive text-deltas extend the latest text item; a tool
// update replaces its existing item in place (keeping its original position).
function appendText(items: ChatItem[], text: string): ChatItem[] {
  const last = items[items.length - 1];
  if (last?.kind === "text") {
    return [...items.slice(0, -1), { ...last, text: last.text + text }];
  }
  return [...items, { kind: "text", id: crypto.randomUUID(), text }];
}

function upsertToolStep(items: ChatItem[], step: ToolStep): ChatItem[] {
  const index = items.findIndex((item) => item.kind === "tool" && item.step.id === step.id);
  if (index === -1) return [...items, { kind: "tool", id: step.id, step }];
  return items.map((item, itemIndex) =>
    itemIndex === index ? { kind: "tool" as const, id: step.id, step } : item,
  );
}

export default function Home() {
  const [prompt, setPrompt] = useState("");
  const [messages, setMessages] = useState<ChatEntry[]>([]);
  const [isRunning, setIsRunning] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);
  const stickToBottomRef = useRef(true);

  const hasRun = messages.length > 0;

  useEffect(() => {
    function onScroll() {
      const distanceFromBottom =
        document.documentElement.scrollHeight - window.scrollY - window.innerHeight;
      stickToBottomRef.current = distanceFromBottom < 120;
    }
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  useEffect(() => {
    if (stickToBottomRef.current) {
      bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
    }
  }, [messages]);

  const payload = useMemo(() => {
    const latestAssistant = [...messages].reverse().find((message) => message.role === "assistant");
    if (latestAssistant?.briefing) return JSON.stringify(latestAssistant.briefing, null, 2);
    if (latestAssistant?.search) return JSON.stringify(latestAssistant.search, null, 2);
    return "";
  }, [messages]);

  async function run(event: FormEvent) {
    event.preventDefault();
    const request = prompt.trim();
    if (!request || isRunning) return;

    const userMessage: ChatEntry = {
      id: crypto.randomUUID(),
      role: "user",
      items: [{ kind: "text", id: crypto.randomUUID(), text: request }],
    };
    const assistantId = crypto.randomUUID();
    const pendingAssistant: ChatEntry = {
      id: assistantId,
      role: "assistant",
      items: [],
      pending: true,
      search: null,
      selectedVideo: null,
      briefing: null,
    };

    stickToBottomRef.current = true;
    setMessages((current) => [...current, userMessage, pendingAssistant]);
    setPrompt("");
    setIsRunning(true);
    let errorShown = false;

    try {
      const agentResponse = await fetch("/api/agent", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt: request }),
      });

      if (!agentResponse.body) {
        throw new Error("Agent stream was empty.");
      }

      const reader = agentResponse.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { value, done } = await reader.read();
        buffer += decoder.decode(value || new Uint8Array(), { stream: !done });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
          if (!line.trim()) continue;
          const event = JSON.parse(line) as AgentStreamEvent;

          if (event.type === "meta") {
            setMessages((current) =>
              current.map((message) =>
                message.id === assistantId ? { ...message, model: event.model } : message,
              ),
            );
          }

          if (event.type === "text-delta") {
            setMessages((current) =>
              current.map((message) =>
                message.id === assistantId
                  ? {
                      ...message,
                      items: appendText(message.items, event.text),
                      pending: false,
                    }
                  : message,
              ),
            );
          }

          if (event.type === "tool") {
            setMessages((current) =>
              current.map((message) =>
                message.id === assistantId
                  ? {
                      ...message,
                      items: upsertToolStep(message.items, event.toolCall),
                      pending: false,
                    }
                  : message,
              ),
            );
          }

          if (event.type === "finish") {
            setMessages((current) =>
              current.map((message) =>
                message.id === assistantId
                  ? {
                      ...message,
                      pending: false,
                      items: event.data.toolCalls.reduce(upsertToolStep, message.items),
                      search: event.data.search,
                      selectedVideo: event.data.selectedVideo,
                      briefing: event.data.briefing,
                    }
                  : message,
              ),
            );
          }

          if (event.type === "error") {
            setMessages((current) =>
              current.map((message) =>
                message.id === assistantId
                  ? {
                      ...message,
                      pending: false,
                      items: appendText(
                        event.data.toolCalls.reduce(upsertToolStep, message.items),
                        `\n\n${event.error}`,
                      ),
                      search: event.data.search,
                      selectedVideo: event.data.selectedVideo,
                      briefing: event.data.briefing,
                    }
                  : message,
              ),
            );
            errorShown = true;
            throw new Error(event.error);
          }
        }

        if (done) break;
      }
    } catch (error) {
      if (!errorShown) {
        const message = error instanceof Error ? error.message : "Run failed.";
        setMessages((current) =>
          current.map((entry) =>
            entry.id === assistantId
              ? {
                  ...entry,
                  pending: false,
                  items: appendText(entry.items, `\n\n${message}`),
                }
              : entry,
          ),
        );
      }
    } finally {
      setIsRunning(false);
    }
  }

  return (
    <main className="min-h-screen bg-[#fbfbf7] text-[#1f1f1e]">
      <div className="mx-auto flex min-h-screen w-full max-w-4xl flex-col px-4">
        <header className="sticky top-0 z-20 -mx-4 flex h-14 items-center justify-between bg-[#fbfbf7]/85 px-4 backdrop-blur-md">
          <div className="flex items-center gap-2.5">
            <Image
              src="/brand/TF_Horizontal_BLK.svg"
              alt="TinyFish"
              width={102}
              height={22}
              priority
            />
            <span className="text-[13px] text-[#8a857c]">× VideoDB</span>
          </div>
          <span className="flex items-center gap-1.5 text-[12px] text-[#8a857c]">
            <span
              className={`size-1.5 rounded-full transition-colors duration-300 ${
                isRunning ? "status-dot-running bg-[#FF6700]" : "bg-[#1B7064]"
              }`}
            />
            {isRunning ? "Working" : "Ready"}
          </span>
        </header>

        {!hasRun ? (
          <section className="flex flex-1 flex-col items-center justify-center pb-24">
            <div className="animate-rise w-full max-w-2xl">
              <h1 className="font-display mb-2 text-center text-4xl tracking-tight text-[#1f1f1e]">
                What match moments do you want?
              </h1>
              <p className="mb-8 text-center text-[15px] text-[#8a857c]">
                Ask for fouls, goals, cards, or penalties — get back a playable reel.
              </p>
              <CommandForm
                prompt={prompt}
                setPrompt={setPrompt}
                isRunning={isRunning}
                onSubmit={run}
                autoFocus
              />
              <div className="mt-5 flex flex-wrap justify-center gap-2">
                {examples.map((example, index) => (
                  <button
                    key={example}
                    type="button"
                    onClick={() => setPrompt(example)}
                    style={{ animationDelay: `${120 + index * 70}ms` }}
                    className="animate-rise rounded-full border border-[#e5e1d8] bg-white px-3.5 py-2 text-[13px] text-[#625d55] transition-all duration-200 hover:-translate-y-0.5 hover:border-[#FECB8B] hover:text-[#20201f] hover:shadow-[0_4px_14px_rgba(255,103,0,0.12)] active:translate-y-0"
                  >
                    {example}
                  </button>
                ))}
              </div>
            </div>
          </section>
        ) : (
          <section className="flex flex-1 flex-col">
            <div className="mx-auto w-full max-w-3xl flex-1 pt-8 pb-40">
              <div className="space-y-7">
                {messages.map((message) =>
                  message.role === "user" ? (
                    <ChatMessage key={message.id} role="user">
                      {message.items[0]?.kind === "text" ? message.items[0].text : ""}
                    </ChatMessage>
                  ) : (
                    <AssistantMessage key={message.id} message={message} />
                  ),
                )}
              </div>

              {payload ? (
                <details className="group/payload mt-8 border-t border-[#eceae3] pt-4">
                  <summary className="flex cursor-pointer list-none items-center gap-2 text-[13px] font-medium text-[#8a857c] transition-colors hover:text-[#4a463f]">
                    <Chevron />
                    Raw payload
                  </summary>
                  <pre className="animate-rise mt-3 max-h-[360px] overflow-auto rounded-2xl bg-[#141413] p-4 font-mono text-[12px] leading-5 text-[#d6d3ca]">
                    {payload}
                  </pre>
                </details>
              ) : null}
              <div ref={bottomRef} />
            </div>

            <div className="composer-dock fixed inset-x-0 bottom-0 z-10">
              <div className="mx-auto w-full max-w-3xl px-4 pb-5 pt-10">
                <CommandForm
                  prompt={prompt}
                  setPrompt={setPrompt}
                  isRunning={isRunning}
                  onSubmit={run}
                />
                <p className="mt-2.5 text-center text-[11px] text-[#a8a399]">
                  TinyFish finds the source video · VideoDB indexes and cuts the reel
                </p>
              </div>
            </div>
          </section>
        )}
      </div>
    </main>
  );
}

function ChatMessage({
  role,
  children,
}: {
  role: "user" | "assistant";
  children: ReactNode;
}) {
  return (
    <div
      className={`animate-message flex w-full ${role === "user" ? "justify-end" : "justify-start"}`}
    >
      <div
        className={
          role === "user"
            ? "max-w-[82%] rounded-3xl rounded-br-lg bg-[#E9E9DC] px-4.5 py-3 text-[15px] leading-6 text-[#26241f]"
            : "w-full"
        }
      >
        {children}
      </div>
    </div>
  );
}

function AssistantMessage({ message }: { message: ChatEntry }) {
  const selected = message.selectedVideo;
  const briefing = message.briefing;

  return (
    <ChatMessage role="assistant">
      <div className="space-y-3">
        {message.pending && !message.items.length ? <ThinkingShimmer /> : null}

        {message.items.map((item) =>
          item.kind === "text" ? (
            <div key={item.id} className="text-[15px] leading-7 text-[#2f2e2c]">
              <Markdown content={item.text} />
            </div>
          ) : (
            <ToolCall key={item.id} step={item.step} />
          ),
        )}

        {selected ? (
          <div className="animate-rise rounded-2xl border border-[#eceae3] bg-white p-4">
            <p className="text-[11px] font-medium uppercase tracking-[0.08em] text-[#a8a399]">
              Selected source
            </p>
            <div className="mt-1.5 flex flex-col gap-0.5">
              <a
                href={selected.url}
                target="_blank"
                rel="noreferrer"
                className="text-sm font-medium text-[#20201f] underline-offset-2 hover:underline"
              >
                {selected.title}
              </a>
              <p className="text-[13px] text-[#8a857c]">
                {selected.source} · {selected.duration} · {selected.videoType}
              </p>
            </div>
          </div>
        ) : null}

        {briefing ? (
          <div className="animate-rise space-y-5">
            <div className="aspect-video overflow-hidden rounded-2xl bg-[#141413] shadow-[0_1px_2px_rgba(32,32,31,0.06),0_12px_32px_rgba(32,32,31,0.12)]">
              <iframe
                src={briefing.playerUrl}
                title="Generated highlight reel"
                className="h-full w-full"
                allow="autoplay; fullscreen; picture-in-picture"
              />
            </div>

            <div>
              <p className="text-[11px] font-medium uppercase tracking-[0.08em] text-[#a8a399]">
                Timestamps
              </p>
              <div className="mt-2.5">
                {briefing.events.length ? (
                  briefing.events.map((event) => (
                    <div
                      key={`${event.label}-${event.timestamp}`}
                      className="-mx-2 grid grid-cols-[64px_1fr] gap-3 rounded-xl px-2 py-2 text-sm transition-colors duration-150 hover:bg-[#f3f1ea]"
                    >
                      <span className="pt-0.5 font-mono text-[12px] text-[#8a857c]">
                        {event.timestamp}
                      </span>
                      <span>
                        <span className="block font-medium text-[#26241f]">{event.label}</span>
                        <span className="block text-[12px] text-[#8a857c]">{event.query}</span>
                      </span>
                    </div>
                  ))
                ) : (
                  <p className="text-sm text-[#8a857c]">
                    No high-confidence timestamps were found.
                  </p>
                )}
              </div>
            </div>
          </div>
        ) : null}
      </div>
    </ChatMessage>
  );
}

const markdownComponents: Components = {
  p: ({ children }) => <p className="my-2 first:mt-0 last:mb-0">{children}</p>,
  strong: ({ children }) => <strong className="font-semibold text-[#1f1f1e]">{children}</strong>,
  em: ({ children }) => <em>{children}</em>,
  a: ({ href, children }) => (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className="break-all font-medium text-[#1f1f1e] underline decoration-[#FECB8B] underline-offset-2 transition-colors hover:decoration-[#FF6700]"
    >
      {children}
    </a>
  ),
  ul: ({ children }) => (
    <ul className="my-2 list-disc space-y-1 pl-5 marker:text-[#a8a399] first:mt-0 last:mb-0">
      {children}
    </ul>
  ),
  ol: ({ children }) => (
    <ol className="my-2 list-decimal space-y-1 pl-5 marker:text-[#a8a399] first:mt-0 last:mb-0">
      {children}
    </ol>
  ),
  li: ({ children }) => <li className="pl-1">{children}</li>,
  h1: ({ children }) => (
    <h3 className="mt-4 mb-1.5 text-[16px] font-semibold text-[#1f1f1e] first:mt-0">{children}</h3>
  ),
  h2: ({ children }) => (
    <h3 className="mt-4 mb-1.5 text-[16px] font-semibold text-[#1f1f1e] first:mt-0">{children}</h3>
  ),
  h3: ({ children }) => (
    <h3 className="mt-4 mb-1.5 text-[15px] font-semibold text-[#1f1f1e] first:mt-0">{children}</h3>
  ),
  code: ({ children, className }) =>
    className ? (
      <code className={className}>{children}</code>
    ) : (
      <code className="rounded-md bg-[#f0eee8] px-1.5 py-0.5 font-mono text-[13px] text-[#37342f]">
        {children}
      </code>
    ),
  pre: ({ children }) => (
    <pre className="my-3 max-h-72 overflow-auto rounded-xl bg-[#141413] p-3.5 font-mono text-[12px] leading-5 text-[#d6d3ca] first:mt-0 last:mb-0">
      {children}
    </pre>
  ),
  blockquote: ({ children }) => (
    <blockquote className="my-2 border-l-2 border-[#dcd8cf] pl-3 text-[#55504a]">
      {children}
    </blockquote>
  ),
  hr: () => <hr className="my-4 border-[#eceae3]" />,
};

function Markdown({ content }: { content: string }) {
  return (
    <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
      {content}
    </ReactMarkdown>
  );
}

function ThinkingShimmer() {
  return (
    <div aria-label="Thinking" className="flex items-center py-1">
      <span className="thinking-shimmer text-[15px] font-medium">Thinking</span>
      <span className="thinking-dots ml-0.5 text-[15px] font-medium text-[#8a857c]">
        <span>.</span>
        <span>.</span>
        <span>.</span>
      </span>
    </div>
  );
}

function CommandForm({
  prompt,
  setPrompt,
  isRunning,
  onSubmit,
  autoFocus,
}: {
  prompt: string;
  setPrompt: (value: string) => void;
  isRunning: boolean;
  onSubmit: (event: FormEvent) => void;
  autoFocus?: boolean;
}) {
  function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      event.currentTarget.form?.requestSubmit();
    }
  }

  return (
    <form
      onSubmit={onSubmit}
      className="flex min-h-14 items-center gap-2 rounded-[28px] border border-[#e8e4db] bg-white px-3 pl-5 shadow-[0_1px_2px_rgba(32,32,31,0.04),0_12px_40px_rgba(32,32,31,0.08)] transition-shadow duration-300 focus-within:border-[#FECB8B] focus-within:shadow-[0_1px_2px_rgba(32,32,31,0.05),0_16px_48px_rgba(255,103,0,0.10)]"
    >
      <input
        value={prompt}
        onChange={(event) => setPrompt(event.target.value)}
        onKeyDown={onKeyDown}
        autoFocus={autoFocus}
        placeholder="Ask for any match moment…"
        className="min-w-0 flex-1 bg-transparent py-4 text-[15px] outline-none placeholder:text-[#a8a399]"
      />
      <button
        type="submit"
        disabled={isRunning || !prompt.trim()}
        aria-label="Send"
        className="grid size-9 shrink-0 place-items-center rounded-full bg-[#FF6700] text-white transition-all duration-200 hover:bg-[#e35c00] active:scale-95 disabled:cursor-not-allowed disabled:bg-[#E9E9DC] disabled:text-[#a8a399]"
      >
        {isRunning ? <Spinner /> : <ArrowUp />}
      </button>
    </form>
  );
}

type ToolStepDetails = {
  query?: string;
  source?: string;
  results?: {
    id?: string;
    title: string;
    url: string;
    source?: string;
    site?: string;
    videoType?: string;
    confidence?: number;
  }[];
  stages?: string[];
  events?: { label: string; timestamp: string; query: string }[];
  summary?: string;
};

function ToolCall({ step }: { step: ToolStep }) {
  const details = (step.details || {}) as ToolStepDetails;
  const isRunning = step.status === "running";
  const stages = details.stages || [];

  const header = (
    <>
      <StatusIcon status={step.status} />
      <span className="min-w-0 flex-1 truncate">
        <span className="font-medium text-[#34322f]">{step.name}</span>
        <span className={`ml-2 ${isRunning ? "thinking-shimmer inline-block" : "text-[#8a857c]"}`}>
          {step.summary}
        </span>
      </span>
    </>
  );

  // While VideoDB works, show its pipeline stages live instead of hiding
  // everything behind a generic "thinking" state.
  if (isRunning) {
    return (
      <div className="animate-rise -mx-2 rounded-xl px-2">
        <div className="flex items-center gap-2.5 py-2 text-[13px]">{header}</div>
        {stages.length > 1 ? (
          <div className="mb-2 ml-[26px] space-y-1.5 border-l border-[#eceae3] pl-3">
            {stages.slice(0, -1).map((stage) => (
              <div key={stage} className="flex items-center gap-2 text-[12px] text-[#8a857c]">
                <StatusIcon status="done" />
                {stage}
              </div>
            ))}
          </div>
        ) : null}
      </div>
    );
  }

  const candidates = details.results || [];
  const moments = details.events || [];
  const hasExpandable = candidates.length > 0 || moments.length > 0;

  if (!hasExpandable) {
    return (
      <div className="animate-rise -mx-2 flex items-center gap-2.5 rounded-xl px-2 py-2 text-[13px]">
        {header}
      </div>
    );
  }

  return (
    <details className="animate-rise group -mx-2 rounded-xl px-2 transition-colors duration-150 open:bg-[#f7f5ef] hover:bg-[#f7f5ef]">
      <summary className="flex cursor-pointer list-none items-center gap-2.5 py-2 text-[13px]">
        {header}
        <Chevron />
      </summary>
      <div className="mb-2 ml-[26px] space-y-1.5 border-l border-[#eceae3] pl-3">
        {candidates.map((candidate) => {
          const meta = [
            candidate.source || candidate.site,
            candidate.videoType,
            candidate.confidence !== undefined
              ? `${Math.round(candidate.confidence * 100)}%`
              : undefined,
          ].filter(Boolean);
          return (
            <div key={candidate.id || candidate.url} className="text-[12px] leading-5">
              <a
                href={candidate.url}
                target="_blank"
                rel="noreferrer"
                className="font-medium text-[#34322f] underline-offset-2 hover:underline"
              >
                {candidate.title}
              </a>
              {meta.length ? (
                <span className="ml-2 text-[#a8a399]">{meta.join(" · ")}</span>
              ) : null}
            </div>
          );
        })}
        {moments.map((moment) => (
          <div
            key={`${moment.label}-${moment.timestamp}`}
            className="flex items-baseline gap-2 text-[12px] leading-5"
          >
            <span className="font-mono text-[#8a857c]">{moment.timestamp}</span>
            <span className="text-[#34322f]">{moment.label}</span>
          </div>
        ))}
      </div>
    </details>
  );
}

function StatusIcon({ status }: { status: ToolStep["status"] }) {
  if (status === "running") return <Spinner className="text-[#FF6700]" />;
  if (status === "done") {
    return (
      <svg viewBox="0 0 16 16" className="size-4 shrink-0 text-[#1B7064]" fill="none">
        <path
          d="M3.5 8.5l3 3 6-6.5"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    );
  }
  if (status === "error") {
    return (
      <svg viewBox="0 0 16 16" className="size-4 shrink-0 text-[#dc2626]" fill="none">
        <path
          d="M4.5 4.5l7 7m0-7l-7 7"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
        />
      </svg>
    );
  }
  return <span className="size-1.5 shrink-0 rounded-full bg-[#c9c3b8]" />;
}

function Spinner({ className = "" }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" className={`size-4 shrink-0 animate-spin ${className}`} fill="none">
      <circle cx="8" cy="8" r="6" stroke="currentColor" strokeOpacity="0.25" strokeWidth="2" />
      <path
        d="M14 8a6 6 0 00-6-6"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
      />
    </svg>
  );
}

function ArrowUp() {
  return (
    <svg viewBox="0 0 16 16" className="size-4" fill="none">
      <path
        d="M8 13V3m0 0L3.5 7.5M8 3l4.5 4.5"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function Chevron() {
  return (
    <svg
      viewBox="0 0 16 16"
      className="size-3.5 shrink-0 text-[#a8a399] transition-transform duration-200 group-open:rotate-90 group-open/payload:rotate-90"
      fill="none"
    >
      <path
        d="M6 4l4 4-4 4"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
