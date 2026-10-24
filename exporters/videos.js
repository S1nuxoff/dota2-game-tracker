// Every video of the game's interface, as the game keeps it, for anyone to use: the
// <user>/dota2-videos dataset, at the game's paths:
//   panorama/videos/<path>.webm    loose in the depot (hero portraits, events, ability previews)
//   panorama/videos/<path>.mov, .mp4, .vtt   in the VPK, with the subtitles of the videos
// Only files whose SHA-1 (loose) or CRC (VPK) changed since the last run are uploaded again
// (state/videos.json); files the game removed are removed. The state is saved after each batch,
// so a stopped run goes on where it was. The pictures are in dota2-images (images.js).
//
//   HF_TOKEN=... node exporters/videos.js --game "<...>/dota 2 beta/game/dota" [--no-upload] [--force]
//   HF_TOKEN=... node exporters/videos.js <STEAM USERNAME> <STEAM PASSWORD>   (GitHub Actions)
const fs = require("fs");
const path = require("path");
const hf = require("../lib/hf");
const { localSource, steamSource } = require("../lib/source");

const temp = "./temp/videos";
const DATASET = process.env.HF_VIDEOS_REPO || "dota2-videos";
// Raised when the files written change, so a game version already exported is exported again
const VERSION = 1;
const STATE_FILE = "state/videos.json";
const FOLDER = "panorama/videos";
const VIDEOS = /^panorama\/videos\/.+\.(webm|mov|mp4|vtt)$/;
// Some are hundreds of MB; a batch's commits are sent three at a time
const BATCH = 60;

function argValue(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

async function main() {
  const game = argValue("--game");
  const [username, password] = process.argv.slice(2).filter((arg, index, args) => !arg.startsWith("--") && args[index - 1] !== "--game");
  const upload = !process.argv.includes("--no-upload");
  const force = process.argv.includes("--force");
  if ((!game && !password) || (upload && !process.env.HF_TOKEN)) {
    console.error('Usage: HF_TOKEN=... node exporters/videos.js --game "<...>/dota 2 beta/game/dota" | <STEAM USERNAME> <STEAM PASSWORD>');
    process.exit(1);
  }

  fs.rmSync(temp, { recursive: true, force: true });
  fs.mkdirSync(temp, { recursive: true });
  const source = game ? localSource(game) : await steamSource(username, password, temp);
  let state = fs.existsSync(STATE_FILE) && !force ? JSON.parse(fs.readFileSync(STATE_FILE, "utf8")) : {};
  if (state.version !== VERSION) {
    state = { files: {} };
  }
  if (!force && source.manifestId && state.manifest === source.manifestId) {
    console.log(`Videos of manifest ${source.manifestId} are already exported.`);
    return;
  }

  // What the game has now: loose files by SHA-1, VPK files by CRC
  const now = {};
  const loose = new Map();
  for (const entry of source.looseFiles(FOLDER)) {
    if (VIDEOS.test(entry.path)) {
      now[entry.path] = entry.sha;
      loose.set(entry.path, entry);
    }
  }
  const packed = source.vpkDir.files.filter((file) => VIDEOS.test(file) && !loose.has(file));
  for (const file of packed) now[file] = String(source.vpkDir.tree[file].crc);

  const changed = Object.keys(now).filter((file) => state.files[file] !== now[file]);
  const removed = Object.keys(state.files).filter((file) => !(file in now));
  console.log(`${Object.keys(now).length} videos, ${changed.length} to export, ${removed.length} removed`);

  const repo = upload ? await hf.prepareRepo(process.env.HF_TOKEN, DATASET) : null;
  const save = () => fs.writeFileSync(STATE_FILE, JSON.stringify({ version: VERSION, manifest: state.manifest, files: state.files }));
  const out = path.join(temp, "out");
  let done = 0;
  let bytes = 0;
  for (let start = 0; start < changed.length; start += BATCH) {
    const batch = changed.slice(start, start + BATCH);
    const buffers = new Map();
    await source.readFiles(batch.filter((file) => !loose.has(file)), buffers);
    const written = [];
    for (const file of batch) {
      const local = path.join(out, file);
      fs.mkdirSync(path.dirname(local), { recursive: true });
      fs.writeFileSync(local, loose.has(file) ? await source.readLoose(loose.get(file)) : buffers.get(file));
      written.push({ path: file, file: local });
      bytes += fs.statSync(local).size;
    }
    if (upload) {
      await hf.upload(repo, process.env.HF_TOKEN, written, "Update the game's videos", { gzip: false, maxBytes: 200 * 1e6, parallel: 3 });
      for (const file of batch) state.files[file] = now[file];
      save();
      fs.rmSync(out, { recursive: true, force: true });
    }
    done += batch.length;
    console.log(`${done} of ${changed.length} done, ${(bytes / 1e9).toFixed(2)} GB`);
  }
  source.release();

  if (upload) {
    if (removed.length) {
      await hf.remove(repo, process.env.HF_TOKEN, removed, "Remove what the game removed");
      for (const file of removed) delete state.files[file];
    }
    state.manifest = source.manifestId;
    save();
  } else {
    console.log(`Written to ${out}`);
  }
}

main().then(
  () => process.exit(0),
  (error) => {
    console.error(error);
    process.exit(1);
  }
);
