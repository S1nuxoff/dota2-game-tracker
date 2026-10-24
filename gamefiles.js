// The game's scripts and texts, whole, for anyone to read: every file of scripts/ and resource/
// that is text or KeyValues (items_game, npc_*, every localization, events, response rules, ...),
// at its game path in the <user>/dota2-data dataset:
//   <path>.json        a KeyValues text file (.txt, .res, .vdf, events) as JSON: blocks are objects,
//                      values strings; a key the block repeats keeps every value, the next ones
//                      as "<key>#2", "<key>#3"; #base and #include stay pairs; [$PLATFORM]
//                      conditions are dropped
//                      (a .txt in KV3 the same, its KV3 as JSON)
//   <path>.json        a compiled resource (<path>_c: .vdata_c, .vrr_c, ...) as Source2Viewer
//                      decompiles it, its KV3 as JSON
//   <path>             any other text file (or a .txt that is not KeyValues), as UTF-8
// Pictures, fonts and binary files are left out (pictures go to dota2-images). The game's own
// files win over core's, as the game reads them. Only files whose CRC changed since the last run
// are converted and uploaded again (gamefiles-state.json); files the game removed are removed.
//
//   HF_TOKEN=... node gamefiles.js --game "<...>/dota 2 beta/game/dota" [--no-upload] [--force]
//   HF_TOKEN=... node gamefiles.js <STEAM USERNAME> <STEAM PASSWORD>   (GitHub Actions)
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const hf = require("./hf");
const kv3 = require("./kv3");
const { localSource, steamSource } = require("./source");
const { parse, decode } = require("./keyvalues");

const temp = "./temp/gamefiles";
const DECOMPILER = path.resolve("vrf", process.platform === "win32" ? "Source2Viewer-CLI.exe" : "Source2Viewer-CLI");
const DATASET = process.env.HF_DATA_REPO || "dota2-data";
// Raised when the files written change, so a game version already exported is exported again
const VERSION = 1;
const STATE_FILE = "gamefiles-state.json";

const FOLDERS = /^(scripts|resource)\//;
// KeyValues text
const KEYVALUES = /\.(txt|res|vdf|gameevents|lst|caverndef|eventactions|eventdef|eventincludes|seasondef)$/;
// Text kept as it is
const TEXT = /\.(json|htm|html|styles|cfg|csv|xml)$/;
// Compiled resources Source2Viewer turns into KV3 text
const COMPILED = /\.(vdata|vrr|herolist|vcd|vrman)_c$/;
// Not text: left out on purpose (anything else is reported, so a new kind is noticed)
const BINARY = /\.(png|jpg|tga|psd|bmp|otf|ttf|vfont|dmx|dem|bin|vtex_c|vpcf_c|vmat_c|vsnd_c)$/;

function argValue(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

// The dataset path a game file is kept at, or null when it is left out
function datasetPath(file) {
  if (KEYVALUES.test(file)) return `${file}.json`;
  if (COMPILED.test(file)) return `${file.replace(/_c$/, "")}.json`;
  if (TEXT.test(file)) return file;
  return null;
}

// A local file holding what is uploaded for a text or KeyValues game file
function convertText(file, buffer, out) {
  const text = decode(buffer);
  let target = file;
  let content = text;
  if (KEYVALUES.test(file)) {
    // Some .txt files are KV3 (soundmixers.txt, sound_operator_stacks.txt)
    if (text.trimStart().startsWith("<!-- kv3")) {
      target = `${file}.json`;
      content = JSON.stringify(kv3.parse(text));
    } else {
      const { root, skipped } = parse(text, { raw: true });
      if (skipped === 0) {
        target = `${file}.json`;
        content = JSON.stringify(root);
      }
    }
  }
  const local = path.join(out, target);
  fs.mkdirSync(path.dirname(local), { recursive: true });
  fs.writeFileSync(local, content);
  return { path: target, file: local };
}

// Compiled resources: decompiled by Source2Viewer, their KV3 as JSON (or the text it wrote, when
// that is not KV3)
function convertCompiled(files, out) {
  const input = path.join(temp, "compiled-in");
  const decompiled = path.join(temp, "compiled-out");
  for (const [file, buffer] of files) {
    fs.mkdirSync(path.dirname(path.join(input, file)), { recursive: true });
    fs.writeFileSync(path.join(input, file), buffer);
  }
  const result = spawnSync(DECOMPILER, ["-i", input, "--recursive", "-o", decompiled, "-d", "--threads", "8"], {
    encoding: "utf8",
    maxBuffer: 512 * 1024 * 1024,
  });
  if (result.error) {
    throw result.error;
  }
  const uploads = [];
  const failed = [];
  for (const file of files.keys()) {
    const written = path.join(decompiled, file.replace(/_c$/, ""));
    if (!fs.existsSync(written)) {
      failed.push(file);
      continue;
    }
    const text = fs.readFileSync(written, "utf8");
    let target = `${file.replace(/_c$/, "")}.json`;
    let content;
    try {
      content = JSON.stringify(kv3.parse(text));
    } catch {
      target = file.replace(/_c$/, "");
      content = text;
    }
    const local = path.join(out, target);
    fs.mkdirSync(path.dirname(local), { recursive: true });
    fs.writeFileSync(local, content);
    uploads.push({ game: file, path: target, file: local });
  }
  return { uploads, failed };
}

async function main() {
  const game = argValue("--game");
  const [username, password] = process.argv.slice(2).filter((arg, index, args) => !arg.startsWith("--") && args[index - 1] !== "--game");
  const upload = !process.argv.includes("--no-upload");
  const force = process.argv.includes("--force");
  if ((!game && !password) || (upload && !process.env.HF_TOKEN)) {
    console.error('Usage: HF_TOKEN=... node gamefiles.js --game "<...>/dota 2 beta/game/dota" | <STEAM USERNAME> <STEAM PASSWORD>');
    process.exit(1);
  }

  fs.rmSync(temp, { recursive: true, force: true });
  fs.mkdirSync(temp, { recursive: true });
  const source = game ? localSource(game) : await steamSource(username, password, temp);
  const state = fs.existsSync(STATE_FILE) && !force ? JSON.parse(fs.readFileSync(STATE_FILE, "utf8")) : { files: {} };
  if (state.version !== VERSION) {
    state.files = {};
  }
  if (!force && source.manifestId && state.manifest === source.manifestId && state.version === VERSION) {
    console.log(`Game files of manifest ${source.manifestId} are already exported.`);
    return;
  }

  const files = source.vpkDir.files.filter((file) => FOLDERS.test(file));
  const kept = files.filter((file) => datasetPath(file));
  const unknown = files.filter((file) => !datasetPath(file) && !BINARY.test(file));
  if (unknown.length) {
    const kinds = [...new Set(unknown.map((file) => path.extname(file)))];
    console.log(`Left out ${unknown.length} files of kinds not known yet: ${kinds.join(" ")}`);
  }

  const crcs = Object.fromEntries(kept.map((file) => [file, source.vpkDir.tree[file].crc]));
  const changed = kept.filter((file) => state.files[file]?.crc !== crcs[file]);
  // What the game no longer has, by the path it was uploaded at
  const removed = Object.entries(state.files).filter(([file]) => !(file in crcs)).map(([, entry]) => entry.path);
  console.log(`${kept.length} game files, ${changed.length} new or changed, ${removed.length} removed`);

  const out = path.join(temp, "out");
  const uploads = [];
  const compiled = new Map();
  const next = { ...state.files };
  // Read in batches, so the whole set is never in memory at once
  for (let start = 0; start < changed.length; start += 500) {
    const buffers = new Map();
    await source.readFiles(changed.slice(start, start + 500), buffers);
    for (const [file, buffer] of buffers) {
      if (COMPILED.test(file)) {
        compiled.set(file, buffer);
      } else {
        const entry = convertText(file, buffer, out);
        uploads.push(entry);
        next[file] = { crc: crcs[file], path: entry.path };
      }
    }
  }
  if (compiled.size) {
    const { uploads: decompiled, failed } = convertCompiled(compiled, out);
    for (const { game: file, ...entry } of decompiled) {
      uploads.push(entry);
      next[file] = { crc: crcs[file], path: entry.path };
    }
    if (failed.length) {
      console.log(`Source2Viewer did not decompile ${failed.length}: ${failed.slice(0, 10).join(", ")}`);
    }
  }
  source.release();
  for (const file of Object.keys(next)) {
    if (!(file in crcs)) delete next[file];
  }

  const asText = uploads.filter((entry) => !entry.path.endsWith(".json")).length;
  const bytes = uploads.reduce((sum, entry) => sum + fs.statSync(entry.file).size, 0);
  console.log(`${uploads.length} files to upload (${asText} kept as text), ${(bytes / 1e6).toFixed(1)} MB`);

  if (upload) {
    const repo = await hf.prepareRepo(process.env.HF_TOKEN, DATASET);
    await hf.upload(repo, process.env.HF_TOKEN, uploads, "Update the game's scripts and texts", { gzip: false, maxBytes: 50 * 1e6 });
    if (removed.length) {
      await hf.remove(repo, process.env.HF_TOKEN, removed, "Remove what the game removed");
    }
    fs.writeFileSync(STATE_FILE, JSON.stringify({ version: VERSION, manifest: source.manifestId, files: next }));
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
