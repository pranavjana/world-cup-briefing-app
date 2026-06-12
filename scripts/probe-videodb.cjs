/* Diagnostic probe: inspect collection state and reproduce the search calls
   the app makes, printing real API behavior. Read-only except searches. */
const fs = require("fs");
const path = require("path");

for (const line of fs
  .readFileSync(path.join(__dirname, "..", ".env.local"), "utf8")
  .split("\n")) {
  const match = line.match(/^([A-Z_]+)=(.*)$/);
  if (match) process.env[match[1]] = match[2].trim();
}

const { connect } = require("videodb");

async function main() {
  const conn = connect(process.env.VIDEO_DB_API_KEY);
  const coll = await conn.getCollection();
  console.log("collection:", coll.id, coll.name || "");

  const videos = await coll.getVideos();
  console.log(`videos in collection: ${videos.length}`);
  for (const v of videos.slice(0, 5)) {
    console.log(` - ${v.id} | ${Math.round(v.length)}s | ${v.name}`);
  }
  if (!videos.length) return;

  const video = videos[0];
  const indexes = await video.listSceneIndex();
  console.log(`\nscene indexes on ${video.id}:`);
  for (const ix of indexes) {
    console.log(` - ${ix.sceneIndexId} | status=${ix.status} | ${ix.name}`);
  }

  const readyIndex = indexes[0];
  if (readyIndex) {
    try {
      const records = await video.getSceneIndex(readyIndex.sceneIndexId);
      console.log(`\nscene records in ${readyIndex.sceneIndexId}: ${records.length}`);
      for (const r of records.slice(0, 6)) {
        console.log(` [${r.start}-${r.end}]`, String(r.description).slice(0, 110));
      }
    } catch (e) {
      console.log("getSceneIndex error:", e.message);
    }
  }

  console.log("\n--- collection.search (what the app does) ---");
  try {
    const res = await coll.search(
      "FOUL referee whistle",
      "semantic",
      "scene",
      3,
      0.1,
      undefined,
      undefined,
      "start",
      undefined,
      readyIndex && readyIndex.sceneIndexId,
    );
    console.log(
      "shots:",
      res.shots.map((s) => `${s.videoId} ${s.start}-${s.end} score=${s.searchScore} ix=${s.sceneIndexId}`),
    );
  } catch (e) {
    console.log("collection.search ERROR:", e.message, e.response?.data ? JSON.stringify(e.response.data).slice(0, 300) : "");
  }

  console.log("\n--- video.search (canonical per docs) ---");
  try {
    const res = await video.search("FOUL referee whistle", "semantic", "scene", 3, 0.1);
    console.log(
      "shots:",
      res.shots.map((s) => `${s.videoId} ${s.start}-${s.end} score=${s.searchScore} ix=${s.sceneIndexId}`),
    );
  } catch (e) {
    console.log("video.search ERROR:", e.message, e.response?.data ? JSON.stringify(e.response.data).slice(0, 300) : "");
  }
}

main().catch((e) => {
  console.error("fatal:", e.message);
  process.exit(1);
});
