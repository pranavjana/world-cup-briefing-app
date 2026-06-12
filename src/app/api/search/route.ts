import { NextRequest, NextResponse } from "next/server";
import { searchWorldCupVideos } from "@/lib/video-pipeline";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  const body = (await request.json().catch(() => null)) as { query?: string } | null;
  const query = body?.query?.trim() || "USA vs Paraguay World Cup highlights";

  return NextResponse.json(await searchWorldCupVideos(query));
}
