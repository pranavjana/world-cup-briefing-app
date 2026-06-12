import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { stepCountIs, streamText, tool } from "ai";
import { NextRequest } from "next/server";
import { z } from "zod";
import type { BriefingPayload, VideoCandidate } from "@/lib/demo-data";
import {
  buildLiveOrFallbackBriefing,
  inferIntent,
  researchMatchInfo,
  searchWorldCupVideos,
  type SearchResponse,
} from "@/lib/video-pipeline";

export const runtime = "nodejs";
// Vercel Hobby plan caps Serverless Function duration at 300s.
export const maxDuration = 300;

type AgentToolCall = {
  id: string;
  name: string;
  status: "running" | "done" | "error";
  summary: string;
  details?: unknown;
};

type StreamEvent =
  | { type: "meta"; model: string; prompt: string }
  | { type: "text-delta"; text: string }
  | { type: "tool"; toolCall: AgentToolCall }
  | {
      type: "finish";
      data: {
        mode: "agent";
        model: string;
        prompt: string;
        toolCalls: AgentToolCall[];
        search: SearchResponse | null;
        selectedVideo: VideoCandidate | null;
        briefing: BriefingPayload | null;
      };
    }
  | {
      type: "error";
      error: string;
      data: {
        mode: "agent-error";
        prompt: string;
        toolCalls: AgentToolCall[];
        search: SearchResponse | null;
        selectedVideo: VideoCandidate | null;
        briefing: BriefingPayload | null;
      };
    };

const videoCandidateSchema = z.object({
  id: z.string(),
  title: z.string(),
  url: z.string().url(),
  source: z.string(),
  duration: z.string(),
  teams: z.array(z.string()),
  match: z.string(),
  videoType: z.enum(["match highlights", "press conference", "analysis", "fan reaction"]),
  confidence: z.number(),
});

function getModel() {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    throw new Error("OPENROUTER_API_KEY is not configured");
  }

  const openrouter = createOpenRouter({ apiKey });
  return openrouter(process.env.OPENROUTER_MODEL || "openai/gpt-5.4-mini");
}

function summarizeSearch(search: SearchResponse) {
  return {
    mode: search.mode,
    query: search.query,
    source: search.source,
    error: search.error,
    results: search.results.slice(0, 6),
  };
}

function shouldCreateReel(prompt: string) {
  return /\b(foul|fouls|goal|goals|card|cards|yellow|red|penalt|highlight|highlights|reel|clip|clips|moment|moments|match|game|world cup|soccer|football)\b/i.test(
    prompt,
  );
}

function writeEvent(controller: ReadableStreamDefaultController<Uint8Array>, event: StreamEvent) {
  controller.enqueue(new TextEncoder().encode(`${JSON.stringify(event)}\n`));
}

// AI SDK stream error parts carry `unknown`, and OpenRouter failures are often
// plain objects — extract something readable instead of "Agent run failed".
function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  if (
    error &&
    typeof error === "object" &&
    "message" in error &&
    typeof (error as { message: unknown }).message === "string"
  ) {
    return (error as { message: string }).message;
  }
  try {
    return JSON.stringify(error);
  } catch {
    return "Agent run failed";
  }
}

export async function POST(request: NextRequest) {
  const body = (await request.json().catch(() => null)) as { prompt?: string } | null;
  const prompt = body?.prompt?.trim() || "highlights of fouls from USA vs Paraguay";
  const modelName = process.env.OPENROUTER_MODEL || "openai/gpt-5.4-mini";
  const toolCalls: AgentToolCall[] = [];
  let search: SearchResponse | null = null;
  let selectedVideo: VideoCandidate | null = null;
  let briefing: BriefingPayload | null = null;

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      writeEvent(controller, { type: "meta", model: modelName, prompt });

      try {
    const intent = inferIntent(prompt);
    const result = streamText({
      model: getModel(),
      stopWhen: stepCountIs(7),
      system: `You are the assistant inside a football moments reel maker.

The product helps users ask for moments from a football match, such as fouls, goals, cards, penalties, celebrations, or tactical highlights. TinyFish finds useful web video sources. VideoDB uploads the selected video, indexes visual scenes, searches for event timestamps, and compiles a playable highlight reel.

Be conversational first. If the user greets you, asks what this app does, asks for help, or gives a vague non-football request, respond normally and briefly. Explain that you can create football moment reels when they provide a match and moment type.

Use tools only when the user is clearly asking to create/find a football video reel or football match moments. Do not call tools for greetings, small talk, or general explanation questions.

Tool workflow (follow exactly):
1. Call tinyfishResearch first (1-2 calls max) to gather ground truth about the requested moments from match reports and live-commentary timelines. Information that helps VideoDB the most:
   - the match minute of each requested event (e.g. "red card 63'"),
   - the players involved,
   - which half it happened in,
   - how many events of the requested type occurred in total,
   - the final score for context.
   Good queries look like "Mexico South Africa red cards minute match report". Skip research when the user's request is vague (e.g. just "highlights") — go straight to step 2.
2. After research, write 1-2 short sentences telling the user what you found BEFORE calling the next tool — e.g. "Found it: 3 red cards in this match — Zwane (61'), Ramírez (88'), Mokoena (90+2'). Grabbing the match video now." If research found nothing, say that briefly too. Never skip this narration.
3. Call tinyfishSearch once. The query must name both teams (and competition if given), e.g. "USA vs Paraguay World Cup highlights". Do not include the moment type (fouls/cards) in the search query — that filtering happens later in VideoDB.
4. Pick ONE candidate: prefer videoType "match highlights", then the highest confidence. Avoid press conferences, analysis, and fan reactions unless the user asked for them. Before calling videoDbCreateReel, write one short sentence naming which video you picked and why — e.g. "Using FIFA's official extended highlights — building the reel now."
5. Call videoDbCreateReel exactly once with the user's original request as topic and the selected candidate object passed through unchanged (do not edit its fields). If research found concrete events, fill knownEvents — one entry per event, label like "Red card — Player Name", minute as a plain number when known. Only include events you actually found evidence for; never invent them. If research found nothing reliable, omit knownEvents entirely.
6. Write the final reply.

Final reply rules:
- Use plain, friendly markdown. Short intro sentence, then a bulleted list of the moments with their timestamps exactly as returned (label — timestamp). Do not repeat the same timestamp twice.
- Only state facts returned by the tools. Never invent timestamps, player names, scores, or URLs.
- Do not paste the raw player or stream URL; the app renders the player below your message automatically.
- If the tool result has mode "live-error" or mentions a fallback, tell the user plainly that live processing failed and demo/fallback data is shown, and include the error reason.
- If some moment categories were missed (see the "integration" or "missed" fields), mention that honestly instead of padding the list.
- Reel creation takes a minute or two; never claim it is still processing — by the time you reply, the tool has finished.`,
      prompt: `User request: ${prompt}

Detected event type: ${intent.eventType}
Preferred VideoDB scene searches: ${intent.searches
        .map(([label, queries]) => `${label}: ${queries.join(", ")}`)
        .join(" | ")}`,
      tools: {
        tinyfishResearch: tool({
          description:
            "Research match facts on the web with TinyFish: event timelines, match minutes, players involved, scorelines. Returns search snippets plus the content of the top match-report pages.",
          inputSchema: z.object({
            query: z
              .string()
              .describe(
                'A focused web query for match facts, e.g. "Mexico South Africa red cards minute match report".',
              ),
          }),
          execute: async ({ query }) => {
            writeEvent(controller, {
              type: "tool",
              toolCall: {
                id: "tinyfish-research",
                name: "TinyFish research",
                status: "running",
                summary: `Researching: "${query}"`,
              },
            });
            try {
              const research = await researchMatchInfo(query);
              toolCalls.push({
                id: "tinyfish-research",
                name: "TinyFish research",
                status: "done",
                summary: research.note
                  ? research.note
                  : `Read ${research.pages.length} match report${research.pages.length === 1 ? "" : "s"} from ${research.results.length} results.`,
                details: { query, results: research.results },
              });
              writeEvent(controller, {
                type: "tool",
                toolCall: toolCalls[toolCalls.length - 1],
              });
              return research;
            } catch (error) {
              const message =
                error instanceof Error ? error.message : "TinyFish research failed";
              toolCalls.push({
                id: "tinyfish-research",
                name: "TinyFish research",
                status: "error",
                summary: message,
              });
              writeEvent(controller, {
                type: "tool",
                toolCall: toolCalls[toolCalls.length - 1],
              });
              // Research is best-effort: report the failure to the model so it
              // can continue without ground truth instead of aborting the run.
              return { query, results: [], pages: [], note: message };
            }
          },
        }),
        tinyfishSearch: tool({
          description:
            "Search the web with TinyFish for candidate YouTube football match videos.",
          inputSchema: z.object({
            query: z.string().describe("A concise search query for the target football match video."),
          }),
          execute: async ({ query }) => {
            try {
              writeEvent(controller, {
                type: "tool",
                toolCall: {
                  id: "tinyfish",
                  name: "TinyFish search",
                  status: "running",
                  summary: `Searching the web: "${query}"`,
                },
              });
              search = await searchWorldCupVideos(query);
              selectedVideo = search.results[0] || null;
              toolCalls.push({
                id: "tinyfish",
                name: "TinyFish search",
                status: search.mode === "live-error" ? "error" : "done",
                summary:
                  search.mode === "live-error"
                    ? `TinyFish returned fallback candidates: ${search.error}`
                    : `Returned ${search.results.length} candidate videos.`,
                details: summarizeSearch(search),
              });
              writeEvent(controller, {
                type: "tool",
                toolCall: toolCalls[toolCalls.length - 1],
              });

              return summarizeSearch(search);
            } catch (error) {
              const message = error instanceof Error ? error.message : "TinyFish search failed";
              toolCalls.push({
                id: "tinyfish",
                name: "TinyFish search",
                status: "error",
                summary: message,
              });
              writeEvent(controller, {
                type: "tool",
                toolCall: toolCalls[toolCalls.length - 1],
              });
              throw error;
            }
          },
        }),
        videoDbCreateReel: tool({
          description:
            "Use VideoDB to upload a selected video, index visual scenes, search timestamped events, and compile a playable stream.",
          inputSchema: z.object({
            topic: z.string().describe("The original user request."),
            video: videoCandidateSchema.describe("The selected candidate video returned by TinyFish."),
            knownEvents: z
              .array(
                z.object({
                  label: z
                    .string()
                    .describe('Short event label, e.g. "Red card — Player Name".'),
                  minute: z
                    .number()
                    .optional()
                    .describe("Match minute the event happened, when research found it."),
                  half: z.enum(["1st", "2nd"]).optional(),
                }),
              )
              .optional()
              .describe(
                "Ground-truth events found via tinyfishResearch. Only include events with real evidence.",
              ),
          }),
          execute: async ({ topic, video, knownEvents }) => {
            selectedVideo = video;
            const stages: string[] = [];
            briefing = await buildLiveOrFallbackBriefing(
              topic,
              video,
              (stage) => {
                stages.push(stage);
                writeEvent(controller, {
                  type: "tool",
                  toolCall: {
                    id: "videodb",
                    name: "VideoDB reel",
                    status: "running",
                    summary: stage,
                    details: { stages: [...stages] },
                  },
                });
              },
              knownEvents,
            );
            toolCalls.push({
              id: "videodb",
              name: "VideoDB reel",
              status: briefing.mode === "live-error" ? "error" : "done",
              summary:
                briefing.mode === "live-error"
                  ? `VideoDB fell back after an error: ${briefing.error}`
                  : `Compiled ${briefing.events.length} timestamped moments.`,
              details: {
                stages,
                events: briefing.events,
                summary: briefing.summary,
                integration: briefing.integration,
              },
            });
            writeEvent(controller, {
              type: "tool",
              toolCall: toolCalls[toolCalls.length - 1],
            });

            return {
              mode: briefing.mode,
              status: briefing.status,
              selectedVideo: briefing.selectedVideo,
              events: briefing.events,
              streamUrl: briefing.streamUrl,
              playerUrl: briefing.playerUrl,
              summary: briefing.summary,
              error: briefing.error,
            };
          },
        }),
      },
    });

    // The client concatenates consecutive text-deltas, so insert a paragraph
    // break when the model resumes narrating after a tool call.
    let emittedText = false;
    let toolSinceText = false;
    // Don't kill the run on a model/tool error — record it and let the
    // deterministic fallback pipeline below finish the reel anyway.
    let streamError: string | null = null;
    for await (const part of result.fullStream) {
      if (part.type === "text-delta") {
        const text = toolSinceText && emittedText ? `\n\n${part.text}` : part.text;
        emittedText = true;
        toolSinceText = false;
        writeEvent(controller, { type: "text-delta", text });
      }
      if (part.type === "tool-call" || part.type === "tool-result") {
        toolSinceText = true;
      }
      if (part.type === "error" || part.type === "tool-error") {
        streamError = errorMessage(part.error);
        break;
      }
    }

    if (!search && shouldCreateReel(prompt)) {
      search = await searchWorldCupVideos(prompt);
      selectedVideo = search.results[0] || null;
      toolCalls.push({
        id: "tinyfish-fallback",
        name: "TinyFish search",
        status: search.mode === "live-error" ? "error" : "done",
        summary:
          search.mode === "live-error"
            ? `TinyFish returned fallback candidates: ${search.error}`
            : `Returned ${search.results.length} candidate videos.`,
        details: summarizeSearch(search),
      });
      writeEvent(controller, {
        type: "tool",
        toolCall: toolCalls[toolCalls.length - 1],
      });
    }

    if (!briefing && selectedVideo) {
      const stages: string[] = [];
      briefing = await buildLiveOrFallbackBriefing(prompt, selectedVideo, (stage) => {
        stages.push(stage);
        writeEvent(controller, {
          type: "tool",
          toolCall: {
            id: "videodb-fallback",
            name: "VideoDB reel",
            status: "running",
            summary: stage,
            details: { stages: [...stages] },
          },
        });
      });
      toolCalls.push({
        id: "videodb-fallback",
        name: "VideoDB reel",
        status: briefing.mode === "live-error" ? "error" : "done",
        summary:
          briefing.mode === "live-error"
            ? `VideoDB fell back after an error: ${briefing.error}`
            : `Compiled ${briefing.events.length} timestamped moments.`,
        details: {
          stages,
          events: briefing.events,
          summary: briefing.summary,
          integration: briefing.integration,
        },
      });
      writeEvent(controller, {
        type: "tool",
        toolCall: toolCalls[toolCalls.length - 1],
      });
    }

        if (streamError && !briefing) {
          throw new Error(streamError);
        }
        if (streamError && briefing) {
          writeEvent(controller, {
            type: "text-delta",
            text: `${emittedText ? "\n\n" : ""}The AI planner hit an error (${streamError}), so the reel was completed with the standard pipeline instead.`,
          });
        }

        writeEvent(controller, {
          type: "finish",
          data: {
            mode: "agent",
            model: modelName,
            prompt,
            toolCalls,
            search,
            selectedVideo,
            briefing,
          },
        });
      } catch (error) {
        writeEvent(controller, {
          type: "error",
          error: errorMessage(error),
          data: {
            mode: "agent-error",
            prompt,
            toolCalls,
            search,
            selectedVideo,
            briefing,
          },
        });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-cache",
    },
  });
}
