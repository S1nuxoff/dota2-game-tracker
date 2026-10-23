// Sounds for Dotadex: every sound of the game as MP3 (voice lines, abilities and attacks,
// music packs, announcers, ...) and the sound events that tie names the game uses
// (Hero_Pudge.Attack) to those files. Only sounds that changed since the last run are
// converted and uploaded again (sounds-state.json keeps their CRCs).
//
//   HF_TOKEN=... node sounds.js --game "<...>/dota 2 beta/game/dota"
//   HF_TOKEN=... node sounds.js <STEAM USERNAME> <STEAM PASSWORD>   (GitHub Actions)
//
// Uploads to the <user>/dota2-sounds dataset: sounds/...mp3 or .wav and soundevents.json, and the
// voice lines' phonemes (phonemes.js). --phonemes: the phonemes of every folder again, not only
// of the folders whose sounds changed.
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const hf = require("./hf");
const { localSource, steamSource } = require("./source");
const { sentenceOf, ctrlSentences, phonemeClasses, writePhonemes, FOLDER_FILE, CLASSES_FILE } = require("./phonemes");

const temp = "./temp/sounds";
const STATE_FILE = "sounds-state.json";
const DECOMPILER = path.resolve("vrf", process.platform === "win32" ? "Source2Viewer-CLI.exe" : "Source2Viewer-CLI");
const BATCH = 3000;

function argValue(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function* walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* walk(full);
    } else {
      yield full;
    }
  }
}

// Writes game files as loose files and converts them; returns the output folder
function convert(files, name) {
  const input = path.join(temp, `${name}-in`);
  const out = path.join(temp, `${name}-out`);
  fs.rmSync(input, { recursive: true, force: true });
  fs.rmSync(out, { recursive: true, force: true });
  for (const [file, buffer] of files) {
    fs.mkdirSync(path.dirname(path.join(input, file)), { recursive: true });
    fs.writeFileSync(path.join(input, file), buffer);
  }
  const result = spawnSync(DECOMPILER, ["-i", input, "--recursive", "-o", out, "-d", "--threads", "8"], {
    encoding: "utf8",
    maxBuffer: 512 * 1024 * 1024,
  });
  if (result.error) {
    throw result.error;
  }
  return out;
}

// { "Hero_Pudge.Attack": { files: [...paths in the dataset], volume, pitch, layers: [...] } }
function parseSoundEvents(text, events, soundPaths) {
  const pattern = /^\t([\w.\-/]+) =\s*\{([\s\S]*?)^\t\}/gm;
  for (const [, name, body] of text.matchAll(pattern)) {
    const files = [...body.matchAll(/"(sounds\/[^"]+)\.vsnd"/g)].map((match) => soundPaths.get(match[1])).filter(Boolean);
    const number = (key) => {
      const value = body.match(new RegExp(`^\\t\\t${key} = ([-\\d.]+)`, "m"))?.[1];
      return value === undefined ? undefined : Number(value);
    };
    const layers = [...body.matchAll(/^\t\tsoundevent_layer\d+ = "([^"]+)"/gm)].map((match) => match[1]);
    if (files.length || layers.length) {
      events[name] = { files, volume: number("volume"), pitch: number("pitch"), ...(layers.length && { layers }) };
    }
  }
}

async function main() {
  const game = argValue("--game");
  const [username, password] = process.argv.slice(2).filter((arg, index, args) => !arg.startsWith("--") && args[index - 1] !== "--game");
  const accessToken = process.env.HF_TOKEN;
  if ((!game && !password) || !accessToken) {
    console.error('Usage: HF_TOKEN=... node sounds.js --game "<...>/dota 2 beta/game/dota" | <STEAM USERNAME> <STEAM PASSWORD>');
    process.exit(1);
  }
  fs.rmSync(temp, { recursive: true, force: true });
  fs.mkdirSync(temp, { recursive: true });
  const source = game ? localSource(game) : await steamSource(username, password, temp);
  const { vpkDir } = source;

  const repo = await hf.prepareRepo(accessToken, process.env.HF_SOUNDS_REPO || "dota2-sounds");
  console.log(`Dataset: https://huggingface.co/datasets/${repo.name}`);

  // --force: everything again, as on the first run
  const state = fs.existsSync(STATE_FILE) && !process.argv.includes("--force") ? JSON.parse(fs.readFileSync(STATE_FILE, "utf8")) : {};
  const changed = (file) => state[file] !== vpkDir.tree[file].crc;
  const sounds = vpkDir.files.filter((file) => file.startsWith("sounds/") && file.endsWith(".vsnd_c"));
  const todo = sounds.filter(changed);
  console.log(`${sounds.length} sounds, ${todo.length} new or changed.`);
  const folderOf = (file) => file.slice(0, file.lastIndexOf("/"));
  // Phonemes of the sounds read so far; folders with a changed sound that has some are written again
  const sentences = new Map();
  const touched = new Set(process.argv.includes("--phonemes") ? sounds.map(folderOf) : []);
  const readSentences = (files) => {
    const fromCtrl = ctrlSentences(files, DECOMPILER, path.join(temp, "sentences"));
    for (const [file, buffer] of files) {
      if (!file.endsWith(".vsnd_c")) continue;
      const entry = file in fromCtrl ? fromCtrl[file] : sentenceOf(buffer);
      sentences.set(file, entry);
      if (entry) touched.add(folderOf(file));
    }
  };

  const started = Date.now();
  for (let i = 0; i < todo.length; i += BATCH) {
    const batch = todo.slice(i, i + BATCH);
    const files = new Map();
    await source.readFiles(batch, files);
    readSentences(files);
    const out = convert(files, "sounds");
    source.release();

    // Source2Viewer writes the audio (mp3 or wav) next to text dumps of the resource
    const audio = [];
    for (const file of walk(out)) {
      if (/\.(mp3|wav)$/.test(file)) {
        audio.push({ path: path.relative(out, file).split(path.sep).join("/"), file });
      }
    }
    await hf.upload(repo, accessToken, audio, `Sounds ${i + 1}-${i + batch.length}`);
    // Only sounds that came out are done; the rest are tried again next time
    const done = new Set(audio.map((entry) => entry.path.replace(/\.(mp3|wav)$/, "")));
    for (const file of batch) {
      if (done.has(file.replace(/\.vsnd_c$/, ""))) {
        state[file] = vpkDir.tree[file].crc;
      }
    }
    fs.writeFileSync(STATE_FILE, JSON.stringify(state));

    const count = i + batch.length;
    const minutes = (Date.now() - started) / 60000;
    console.log(`Progress: ${count}/${todo.length} sounds, ${Math.round(minutes)} min so far, about ${Math.round((minutes / count) * (todo.length - count))} min left`);
  }

  // Phonemes, a file per folder, read again in full for each folder touched
  if (touched.size) {
    const rest = sounds.filter((file) => touched.has(folderOf(file)) && !sentences.has(file));
    for (let i = 0; i < rest.length; i += BATCH) {
      const files = new Map();
      await source.readFiles(rest.slice(i, i + BATCH), files);
      source.release();
      readSentences(files);
      console.log(`Phonemes: ${Math.min(i + BATCH, rest.length)}/${rest.length} more sounds read`);
    }
    const folders = {};
    for (const [file, entry] of sentences) {
      if (entry) (folders[folderOf(file)] ??= {})[file.slice(file.lastIndexOf("/") + 1).replace(/\.vsnd_c$/, "")] = entry;
    }
    const distDir = path.join(temp, "phonemes");
    const files = writePhonemes(folders, distDir);
    await hf.upload(repo, accessToken, files, `Phonemes of ${files.length} folders`);
    const listed = (await hf.filesIn(repo, accessToken, "sounds", new RegExp(`/${FOLDER_FILE}$`))).map(folderOf).sort();
    const listFile = path.join(temp, FOLDER_FILE);
    fs.writeFileSync(listFile, JSON.stringify(listed));
    await hf.upload(repo, accessToken, [{ path: FOLDER_FILE, file: listFile }], "Folders with phonemes");
    console.log(`Phonemes of ${files.length} folders written, ${listed.length} folders have them`);
  }

  // How each phoneme moves the face, when the game's file changed
  if (vpkDir.tree[CLASSES_FILE] && (changed(CLASSES_FILE) || process.argv.includes("--phonemes"))) {
    const files = new Map();
    await source.readFiles([CLASSES_FILE], files);
    const file = path.join(temp, "phoneme-classes.json");
    fs.writeFileSync(file, JSON.stringify(phonemeClasses(files.get(CLASSES_FILE).toString("utf8"))));
    await hf.upload(repo, accessToken, [{ path: CLASSES_FILE.replace(/\.txt$/, ".json"), file }], "Phoneme classes");
    state[CLASSES_FILE] = vpkDir.tree[CLASSES_FILE].crc;
    fs.writeFileSync(STATE_FILE, JSON.stringify(state));
  }

  // Sound events, all in one file, when any of them changed
  const eventFiles = vpkDir.files.filter((file) => file.startsWith("soundevents/") && file.endsWith(".vsndevts_c"));
  if (eventFiles.some(changed)) {
    const files = new Map();
    await source.readFiles(eventFiles, files);
    const out = convert(files, "events");
    const events = {};
    const soundPaths = await hf.soundPaths(accessToken, repo.name);
    for (const file of walk(out)) {
      if (file.endsWith(".vsndevts")) {
        parseSoundEvents(fs.readFileSync(file, "utf8"), events, soundPaths);
      }
    }
    const eventsFile = path.join(temp, "soundevents.json");
    fs.writeFileSync(eventsFile, JSON.stringify(events));
    await hf.upload(repo, accessToken, [{ path: "soundevents.json", file: eventsFile }], "Update sound events");
    for (const file of eventFiles) {
      state[file] = vpkDir.tree[file].crc;
    }
    fs.writeFileSync(STATE_FILE, JSON.stringify(state));
    console.log(`${Object.keys(events).length} sound events`);
  }
}

main().then(
  () => process.exit(0),
  (error) => {
    console.error(error);
    process.exit(1);
  }
);
