// The whole export in one process: one Steam login, the game opened once, every exporter after it
// sharing it (the maps run on their own, exporters/scenes.js, in the workflow's other job).
//
// First the game's version is read (Steam's depot manifest, or the install's): when neither it nor
// this repository's code changed since the last full run (state/run.json), nothing more is done,
// no download. Otherwise every exporter runs in turn; each still checks its own state and exports
// only what changed. One that fails does not stop the others; the run fails at the end if any did.
//
//   HF_TOKEN=... STEAM_USERNAME=... STEAM_PASSWORD=... node export.js [--force]   (GitHub Actions)
//   HF_TOKEN=... node export.js --game "<...>/dota 2 beta/game/dota" [--force] [--no-upload]
//   EXPORT_STEPS=images,videos node export.js ...   only these exporters
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { gameVersion, steamLogin } = require("./lib/source");

const STATE_FILE = "state/run.json";
// In this order: the models first (the site shows new ones soonest), the files the site reads, the
// game's own files, the sounds and particles, what is made from them, the lists last
const STEPS = ["models", "data", "gamefiles", "images", "textures", "videos", "sounds", "particles", "audio", "names", "previews", "files-list", "embeddings", "catalog"];

function argValue(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

// What the code that exports is: a change to it (a new kind of file, a fix) runs the export again
function codeKey() {
  const hash = crypto.createHash("sha1");
  for (const folder of ["exporters", "lib"]) {
    for (const name of fs.readdirSync(folder).filter((file) => file.endsWith(".js")).sort()) {
      // Line ends as git keeps them, so a copy on Windows gives the same key
      hash.update(name).update(fs.readFileSync(path.join(folder, name), "utf8").replace(/\r\n/g, "\n"));
    }
  }
  return hash.digest("hex");
}

async function main() {
  const game = argValue("--game");
  if (!game && !steamLogin()) {
    console.error('Usage: HF_TOKEN=... STEAM_USERNAME=... STEAM_PASSWORD=... node export.js | --game "<...>/dota 2 beta/game/dota" [--force] [--no-upload]');
    process.exit(1);
  }
  const force = process.argv.includes("--force");
  // Some exporters only (EXPORT_STEPS; the workflow passes it empty for all)
  const only = (process.env.EXPORT_STEPS ?? "").split(",").map((step) => step.trim()).filter(Boolean);
  const partial = only.length > 0;
  const steps = partial ? STEPS.filter((step) => only.includes(step)) : STEPS;

  const version = await gameVersion(game);
  const code = codeKey();
  const last = fs.existsSync(STATE_FILE) ? JSON.parse(fs.readFileSync(STATE_FILE, "utf8")) : {};
  if (!force && !partial && version && last.manifest === version && last.code === code) {
    console.log(`The game (manifest ${version}) and the code are as at the last full run: nothing to export.`);
    return;
  }
  console.log(`Game manifest ${version}${last.manifest === version ? "" : ` (was ${last.manifest ?? "none"})`}, code ${last.code === code ? "unchanged" : "changed"}: running ${steps.join(", ")}`);

  const results = [];
  for (const step of steps) {
    console.log(`\n::group::${step}`);
    const started = Date.now();
    let result;
    try {
      const outcome = await require(`./exporters/${step}`).main();
      result = { step, ok: true, unfinished: Boolean(outcome?.unfinished) };
    } catch (error) {
      console.error(error);
      result = { step, ok: false };
    }
    result.seconds = Math.round((Date.now() - started) / 1000);
    results.push(result);
    console.log("::endgroup::");
  }

  console.log("");
  for (const { step, ok, unfinished, seconds } of results) {
    console.log(`${step.padEnd(11)} ${ok ? (unfinished ? "unfinished" : "ok") : "FAILED"}  ${seconds} s`);
  }
  const failed = results.filter((result) => !result.ok);
  const done = !failed.length && !results.some((result) => result.unfinished);
  // Only a full run that got through everything marks the game version and code done
  if (done && !partial) {
    fs.writeFileSync(STATE_FILE, JSON.stringify({ manifest: version, code, at: new Date().toISOString() }, null, 1));
  }
  if (failed.length) {
    throw new Error(`${failed.length} of ${steps.length} exporters failed: ${failed.map((result) => result.step).join(", ")}`);
  }
}

main().then(
  () => process.exit(0),
  (error) => {
    console.error(error.message ?? error);
    process.exit(1);
  }
);
