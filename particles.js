// Particles for Dotadex: every particle system the heroes and their items show (their ambient
// effects and the cosmetics' own), with all the systems they spawn, as JSON, and the textures
// they draw as atlases with their frames. Only what changed since the last run is converted and
// uploaded again (particles-state.json keeps the CRCs and what each system refers to).
//
//   HF_TOKEN=... node particles.js --game "<...>/dota 2 beta/game/dota"
//   HF_TOKEN=... node particles.js <STEAM USERNAME> <STEAM PASSWORD>   (GitHub Actions)
//
// Uploads to the models dataset:
//   particles/<path>.json                    a system (particles/<path>.vpcf in the game), as KV3 gives it
//   particles/textures/<path>.png, .json     a texture (<path>.vtex) and its sheet: sequences of frames
//   particles/bundles/<path>.json            an effect items show with every system it spawns, in one file
//   particles/<path>.vsnap.json              a snapshot: points placed on a model ({ position: [[x, y, z]],
//                                            radius: [r], ... } by stream, in the model's space), the
//                                            effects' own and those items put in their place
//   models/<path>.sequences.json            a model particles draw: its sequences, whether each loops and
//                                            its activities ({ name: { looping, activities } })
//   particles/coverage.json                  how often each operator class is used, for the viewer to
//                                            know what it does not draw yet
// and lists the models the particles draw in particle-models.json, for index.js to export.
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const sharp = require("sharp");
const hf = require("./hf");
const kv3 = require("./kv3");
const { localSource, steamSource } = require("./source");

const temp = "./temp/particles";
const STATE_FILE = "particles-state.json";
const MODELS_FILE = "particle-models.json";
// Raised when the bundles change shape, to make them all again
const BUNDLE_VERSION = 1;
const ITEMS_GAME_URL = "https://raw.githubusercontent.com/S1nuxoff/dota2-file-tracker/main/static/items_game.json";
const DECOMPILER = path.resolve("vrf", process.platform === "win32" ? "Source2Viewer-CLI.exe" : "Source2Viewer-CLI");
const BATCH = 2000;
// Models print their whole mesh data, so fewer at a time
const MODEL_BATCH = 300;
// Atlases larger than this are scaled down; the particles are small on screen
const MAX_ATLAS = 4096;

function argValue(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function* walk(dir) {
  if (!fs.existsSync(dir)) {
    return;
  }
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* walk(full);
    } else {
      yield full;
    }
  }
}

// Writes game files as loose files and converts them with Source2Viewer; returns the output folder
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

let itemsGame = null;
async function loadItemsGame() {
  itemsGame ??= fs.existsSync("items_game.json")
    ? JSON.parse(fs.readFileSync("items_game.json", "utf8"))
    : await (await fetch(ITEMS_GAME_URL)).json();
  return itemsGame;
}

// The particle systems items show: created alongside them, or put in place of others
async function rootSystems() {
  const data = await loadItemsGame();
  const roots = new Set();
  for (const item of Object.values(data.items_game.items)) {
    for (const visual of Object.values(item.visuals ?? {})) {
      if (visual && typeof visual === "object" && /particle/.test(visual.type ?? "")) {
        for (const key of ["modifier", "asset"]) {
          if (typeof visual[key] === "string" && visual[key].toLowerCase().endsWith(".vpcf")) {
            roots.add(visual[key].toLowerCase());
          }
        }
      }
    }
  }
  return [...roots];
}

// The snapshots items put in place of others (particle_snapshot: a weapon's own points for the
// default weapon's glow); no .vpcf refers to them
async function itemSnapshots() {
  const data = await loadItemsGame();
  const snapshots = new Set();
  for (const item of Object.values(data.items_game.items)) {
    for (const visual of Object.values(item.visuals ?? {})) {
      if (visual?.type === "particle_snapshot" && typeof visual.modifier === "string") {
        snapshots.add(visual.modifier.toLowerCase());
      }
    }
  }
  return [...snapshots];
}

// One data block of models as Source2Viewer prints it: Map(model => [the block's KV3, one for each
// time it is there (a mesh each for MDAT)])
function readBlocks(files, name) {
  const input = path.join(temp, "models-in");
  fs.rmSync(input, { recursive: true, force: true });
  for (const [file, buffer] of files) {
    fs.mkdirSync(path.dirname(path.join(input, file)), { recursive: true });
    fs.writeFileSync(path.join(input, file), buffer);
  }
  const result = spawnSync(DECOMPILER, ["-i", input, "--recursive", "-b", name], { encoding: "utf8", maxBuffer: 2048 * 1024 * 1024 });
  if (result.error) {
    throw result.error;
  }
  const found = new Map();
  // "[3/100] <path>" starts each file, "--- Data for block "MDAT" ---" each of its blocks
  for (const part of result.stdout.split(/^\[\d+\/\d+\] /m).slice(1)) {
    const file = path.relative(input, part.slice(0, part.indexOf("\n")).trim()).split(path.sep).join("/").replace(/_c$/, "");
    const blocks = [];
    for (const block of part.split(`--- Data for block "${name}" ---`).slice(1)) {
      try {
        blocks.push(kv3.parse(block));
      } catch {
        continue;
      }
    }
    found.set(file, blocks);
  }
  return found;
}

// The attachments of models, from their mesh data blocks:
// Map(model => { attach_hitloc: { bones: [[name, weight, [x, y, z], [x, y, z, w]]], ignoreRotation } })
// with offsets and rotations in the bones' own space, in the game's units
function readAttachments(files) {
  const found = new Map();
  for (const [file, blocks] of readBlocks(files, "MDAT")) {
    const attachments = {};
    for (const data of blocks) {
      for (const { key, value } of data?.m_attachments ?? []) {
        const count = value.m_nInfluences ?? 1;
        attachments[key] = {
          bones: Array.from({ length: count }, (_, index) => [
            value.m_influenceNames[index],
            value.m_influenceWeights[index],
            value.m_vInfluenceOffsets[index],
            value.m_vInfluenceRotations[index],
          ]),
          ignoreRotation: Boolean(value.m_bIgnoreRotation),
        };
      }
    }
    if (Object.keys(attachments).length) {
      found.set(file, attachments);
    }
  }
  return found;
}

// The sequences of models, from their sequence data block (the glb has their animations, not
// how they play): Map(model => { game_idle: { looping: true, activities: ["ACT_DOTA_IDLE"] } })
function readSequences(files) {
  const found = new Map();
  for (const [file, blocks] of readBlocks(files, "ASEQ")) {
    const sequences = {};
    for (const data of blocks) {
      for (const sequence of data?.m_localS1SeqDescArray ?? []) {
        if (!sequence?.m_sName) continue;
        const activities = (sequence.m_activityArray ?? []).map((activity) => activity?.m_name).filter(Boolean);
        sequences[sequence.m_sName] = { looping: Boolean(sequence.m_flags?.m_bLooping), ...(activities.length && { activities }) };
      }
    }
    if (Object.keys(sequences).length) {
      found.set(file, sequences);
    }
  }
  return found;
}

// What a system refers to, and its operators by class
function describe(system) {
  const children = new Set();
  const textures = new Set();
  const models = new Set();
  const snapshots = new Set();
  const classes = {};
  const visit = (value) => {
    if (typeof value === "string") {
      const lower = value.toLowerCase();
      if (lower.endsWith(".vpcf")) children.add(lower);
      else if (lower.endsWith(".vtex")) textures.add(lower);
      else if (lower.endsWith(".vmdl")) models.add(lower);
      else if (lower.endsWith(".vsnap")) snapshots.add(lower);
    } else if (Array.isArray(value)) {
      value.forEach(visit);
    } else if (value && typeof value === "object") {
      if (typeof value._class === "string" && value._class !== "CParticleSystemDefinition") {
        classes[value._class] = (classes[value._class] ?? 0) + 1;
      }
      Object.values(value).forEach(visit);
    }
  };
  visit(system);
  return { children: [...children], textures: [...textures], models: [...models], snapshots: [...snapshots], classes };
}

// A texture's frames from the .mks Source2Viewer writes next to them:
// [{ frames: [{ file, duration }], flags }], each sequence at its number. A sheet packed as
// "rgb+a" names them sequence-rgb and sequence-a; their frames are written with both, so they
// are read like the others
function readSheet(mksFile) {
  const sequences = [];
  let current = null;
  for (const line of fs.readFileSync(mksFile, "utf8").split("\n")) {
    const words = line.trim().split(/\s+/);
    if (/^sequence(-rgb|-a)?$/.test(words[0])) {
      current = { frames: [], flags: [] };
      const index = Number(words[1]);
      sequences[Number.isInteger(index) && index >= 0 ? index : sequences.length] = current;
    } else if (words[0] === "frame" && current) {
      current.frames.push({ file: words[1], duration: Number(words[2] ?? 1) });
    } else if (words[0] && !words[0].startsWith("//") && words[0] !== "packmode" && current) {
      current.flags.push(words[0]);
    }
  }
  // A number skipped leaves an empty sequence, not a hole
  return Array.from(sequences, (sequence) => sequence ?? { frames: [], flags: [] });
}

// A texture as one image: its own, or its frames laid in a grid; and its sheet in pixels:
// { width, height, sequences: [{ frames: [[x, y, w, h, duration]], loop }] }
async function buildTexture(out, texture, dist) {
  const base = path.join(out, texture.replace(/\.vtex$/, ""));
  const image = path.join(dist, "particles/textures", texture.replace(/\.vtex$/, ".png"));
  const sheetFile = image.replace(/\.png$/, ".json");
  fs.mkdirSync(path.dirname(image), { recursive: true });

  const mks = `${base}.mks`;
  if (!fs.existsSync(mks)) {
    const single = [".png", ".jpeg", ".jpg"].map((extension) => base + extension).find((file) => fs.existsSync(file));
    if (!single) {
      return null;
    }
    const meta = await sharp(single).metadata();
    const scale = Math.min(1, MAX_ATLAS / Math.max(meta.width, meta.height));
    await sharp(single).resize(Math.round(meta.width * scale), Math.round(meta.height * scale)).png().toFile(image);
    const width = Math.round(meta.width * scale);
    const height = Math.round(meta.height * scale);
    fs.writeFileSync(sheetFile, JSON.stringify({ width, height, sequences: [{ frames: [[0, 0, width, height, 1]], loop: true }] }));
    return [image, sheetFile];
  }

  const sequences = readSheet(mks);
  const folder = path.dirname(base);
  const frames = sequences.flatMap((sequence) => sequence.frames).filter((frame) => fs.existsSync(path.join(folder, frame.file)));
  if (frames.length === 0) {
    return null;
  }
  const first = await sharp(path.join(folder, frames[0].file)).metadata();
  const columns = Math.ceil(Math.sqrt(frames.length));
  const rows = Math.ceil(frames.length / columns);
  const scale = Math.min(1, MAX_ATLAS / Math.max(columns * first.width, rows * first.height));
  const cellWidth = Math.max(1, Math.floor(first.width * scale));
  const cellHeight = Math.max(1, Math.floor(first.height * scale));
  const placed = new Map();
  const composites = [];
  for (const [index, frame] of frames.entries()) {
    const x = (index % columns) * cellWidth;
    const y = Math.floor(index / columns) * cellHeight;
    placed.set(frame.file, [x, y, cellWidth, cellHeight]);
    composites.push({ input: await sharp(path.join(folder, frame.file)).resize(cellWidth, cellHeight, { fit: "fill" }).png().toBuffer(), left: x, top: y });
  }
  const width = columns * cellWidth;
  const height = rows * cellHeight;
  await sharp({ create: { width, height, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
    .composite(composites)
    .png()
    .toFile(image);
  const sheet = {
    width,
    height,
    sequences: sequences.map((sequence) => ({
      frames: sequence.frames.filter((frame) => placed.has(frame.file)).map((frame) => [...placed.get(frame.file), frame.duration]),
      loop: !sequence.flags.some((flag) => /clamp/i.test(flag)),
    })),
  };
  fs.writeFileSync(sheetFile, JSON.stringify(sheet));
  return [image, sheetFile];
}

async function main() {
  const game = argValue("--game");
  const [username, password] = process.argv.slice(2).filter((arg, index, args) => !arg.startsWith("--") && args[index - 1] !== "--game");
  const accessToken = process.env.HF_TOKEN;
  const upload = !process.argv.includes("--no-upload");
  if ((!game && !password) || (upload && !accessToken)) {
    console.error('Usage: HF_TOKEN=... node particles.js --game "<...>/dota 2 beta/game/dota" | <STEAM USERNAME> <STEAM PASSWORD> [--no-upload]');
    process.exit(1);
  }
  fs.rmSync(temp, { recursive: true, force: true });
  fs.mkdirSync(temp, { recursive: true });
  const source = game ? localSource(game) : await steamSource(username, password, temp);
  const { vpkDir } = source;
  const repo = upload ? await hf.prepareRepo(accessToken, process.env.HF_REPO) : null;
  const dist = path.join(temp, "dist");

  const state = fs.existsSync(STATE_FILE) ? JSON.parse(fs.readFileSync(STATE_FILE, "utf8")) : { systems: {}, textures: {} };
  const crcOf = (file) => vpkDir.tree[`${file}_c`]?.crc;

  // Every system reachable from the items', converted where it changed; an unchanged one's
  // references come from the state without reading it
  const reached = new Set();
  let frontier = await rootSystems();
  console.log(`${frontier.length} particle systems shown by items`);
  const uploads = [];
  let converted = 0;
  while (frontier.length) {
    const next = new Set();
    const fresh = [...new Set(frontier)].filter((file) => !reached.has(file) && crcOf(file) !== undefined);
    fresh.forEach((file) => reached.add(file));
    // Read again where the state was kept before snapshots were listed
    const todo = fresh.filter((file) => state.systems[file]?.crc !== crcOf(file) || !state.systems[file].snapshots);
    for (let i = 0; i < todo.length; i += BATCH) {
      const batch = todo.slice(i, i + BATCH);
      const files = new Map();
      await source.readFiles(batch.map((file) => `${file}_c`), files);
      const out = convert(files, "systems");
      source.release();
      for (const file of batch) {
        const text = path.join(out, file);
        if (!fs.existsSync(text) || fs.statSync(text).size === 0) {
          continue;
        }
        const system = kv3.parse(fs.readFileSync(text, "utf8"));
        const json = path.join(dist, file.replace(/\.vpcf$/, ".json"));
        fs.mkdirSync(path.dirname(json), { recursive: true });
        fs.writeFileSync(json, JSON.stringify(system));
        uploads.push({ path: file.replace(/\.vpcf$/, ".json"), file: json });
        state.systems[file] = { crc: crcOf(file), ...describe(system) };
        converted++;
      }
    }
    for (const file of fresh) {
      for (const child of state.systems[file]?.children ?? []) {
        if (!reached.has(child)) {
          next.add(child);
        }
      }
    }
    frontier = [...next];
  }
  console.log(`${reached.size} systems reached, ${converted} converted`);

  // Each effect an item shows with every system it spawns in one file, so the site loads an
  // effect in one request: particles/bundles/<root>.json = { "<path>.vpcf": system, ... }.
  // Made again whenever a system changed, from all of them
  const roots = await rootSystems();
  const rootsKey = roots.slice().sort().join("|");
  if (converted > 0 || state.bundles !== BUNDLE_VERSION || state.rootsKey !== rootsKey) {
    const all = new Map();
    const missing = [...reached].filter((file) => {
      const json = path.join(dist, file.replace(/\.vpcf$/, ".json"));
      if (fs.existsSync(json)) {
        all.set(file, JSON.parse(fs.readFileSync(json, "utf8")));
        return false;
      }
      return true;
    });
    for (let i = 0; i < missing.length; i += BATCH) {
      const batch = missing.slice(i, i + BATCH);
      const files = new Map();
      await source.readFiles(batch.map((file) => `${file}_c`), files);
      const out = convert(files, "systems");
      source.release();
      for (const file of batch) {
        const text = path.join(out, file);
        if (fs.existsSync(text) && fs.statSync(text).size > 0) {
          all.set(file, kv3.parse(fs.readFileSync(text, "utf8")));
        }
      }
    }
    for (const root of roots) {
      if (!all.has(root)) continue;
      const bundle = {};
      const queue = [root];
      while (queue.length) {
        const file = queue.pop();
        if (bundle[file] || !all.has(file)) continue;
        bundle[file] = all.get(file);
        queue.push(...(state.systems[file]?.children ?? []));
      }
      const name = `particles/bundles/${root.replace(/^particles\//, "").replace(/\.vpcf$/, ".json")}`;
      const json = path.join(dist, name);
      fs.mkdirSync(path.dirname(json), { recursive: true });
      fs.writeFileSync(json, JSON.stringify(bundle));
      uploads.push({ path: name, file: json });
    }
    state.bundles = BUNDLE_VERSION;
    state.rootsKey = rootsKey;
    console.log(`${roots.length} effects bundled with the systems they spawn`);
  }

  // The textures they draw
  const textures = [...new Set([...reached].flatMap((file) => state.systems[file]?.textures ?? []))].filter((texture) => crcOf(texture) !== undefined);
  const textureTodo = textures.filter((texture) => state.textures[texture] !== crcOf(texture));
  console.log(`${textures.length} textures, ${textureTodo.length} new or changed`);
  for (let i = 0; i < textureTodo.length; i += BATCH) {
    const batch = textureTodo.slice(i, i + BATCH);
    const files = new Map();
    await source.readFiles(batch.map((file) => `${file}_c`), files);
    const out = convert(files, "textures");
    source.release();
    for (const texture of batch) {
      const built = await buildTexture(out, texture, dist).catch((error) => {
        console.log(`  ${texture}: ${error.message}`);
        return null;
      });
      if (built) {
        for (const file of built) {
          uploads.push({ path: path.relative(dist, file).split(path.sep).join("/"), file });
        }
        state.textures[texture] = crcOf(texture);
      }
    }
  }

  // The snapshots they place particles by: each stream's values by its name
  state.snapshots ??= {};
  const snapshotFiles = [...new Set([...[...reached].flatMap((file) => state.systems[file]?.snapshots ?? []), ...(await itemSnapshots())])].filter((file) => crcOf(file) !== undefined);
  const snapshotTodo = snapshotFiles.filter((file) => state.snapshots[file] !== crcOf(file));
  console.log(`${snapshotFiles.length} snapshots, ${snapshotTodo.length} new or changed`);
  for (let i = 0; i < snapshotTodo.length; i += BATCH) {
    const batch = snapshotTodo.slice(i, i + BATCH);
    const files = new Map();
    await source.readFiles(batch.map((file) => `${file}_c`), files);
    const out = convert(files, "snapshots");
    source.release();
    for (const file of batch) {
      const text = path.join(out, file);
      if (!fs.existsSync(text) || fs.statSync(text).size === 0) {
        continue;
      }
      const streams = {};
      for (const stream of kv3.parse(fs.readFileSync(text, "utf8"))?.stream_data?.streams ?? []) {
        if (stream?.name && Array.isArray(stream.values) && stream.values.length) {
          streams[stream.name] = stream.values;
        }
      }
      const json = path.join(dist, `${file}.json`);
      fs.mkdirSync(path.dirname(json), { recursive: true });
      fs.writeFileSync(json, JSON.stringify(streams));
      uploads.push({ path: `${file}.json`, file: json });
      state.snapshots[file] = crcOf(file);
    }
  }

  // How often each operator class is used across what is reached
  const classes = {};
  for (const file of reached) {
    for (const [name, count] of Object.entries(state.systems[file]?.classes ?? {})) {
      classes[name] = (classes[name] ?? 0) + count;
    }
  }
  const coverage = path.join(dist, "particles/coverage.json");
  fs.mkdirSync(path.dirname(coverage), { recursive: true });
  fs.writeFileSync(coverage, JSON.stringify({ systems: reached.size, classes: Object.fromEntries(Object.entries(classes).sort((a, b) => b[1] - a[1])) }));
  uploads.push({ path: "particles/coverage.json", file: coverage });

  const models = [...new Set([...reached].flatMap((file) => state.systems[file]?.models ?? []))].sort();
  fs.writeFileSync(MODELS_FILE, JSON.stringify(models, null, 1));
  console.log(`${models.length} models drawn by particles listed in ${MODELS_FILE}`);

  // The attachments of every exported model, which the particles are bound to, and the list of
  // models that have them (state.attached), so the site asks only for files that are there.
  // Before that list was kept, it starts from the attachment files the dataset has.
  state.attachments ??= {};
  if (!state.attached) {
    state.attached = {};
    for (const file of repo ? await hf.filesIn(repo, accessToken, "models", /\.attachments\.json$/) : []) {
      state.attached[file.replace(/\.attachments\.json$/, ".vmdl")] = true;
    }
    console.log(`${Object.keys(state.attached).length} models with attachments in the dataset`);
  }
  const exported = fs.existsSync("state.json") ? Object.keys(JSON.parse(fs.readFileSync("state.json", "utf8")).models ?? {}) : [];
  const modelTodo = exported.filter((model) => crcOf(model) !== undefined && state.attachments[model] !== crcOf(model));
  console.log(`${exported.length} models, ${modelTodo.length} with new or changed attachments`);
  for (let i = 0; i < modelTodo.length; i += MODEL_BATCH) {
    const batch = modelTodo.slice(i, i + MODEL_BATCH);
    const files = new Map();
    await source.readFiles(batch.map((model) => `${model}_c`), files);
    source.release();
    const found = readAttachments(files);
    for (const [model, attachments] of found) {
      const json = path.join(dist, model.replace(/\.vmdl$/, ".attachments.json"));
      fs.mkdirSync(path.dirname(json), { recursive: true });
      fs.writeFileSync(json, JSON.stringify(attachments));
      uploads.push({ path: model.replace(/\.vmdl$/, ".attachments.json"), file: json });
    }
    for (const model of batch) {
      state.attachments[model] = crcOf(model);
      if (found.has(model)) {
        state.attached[model] = true;
      } else {
        delete state.attached[model];
      }
    }
  }
  // How the models particles draw play their sequences (looping, activities)
  state.sequences ??= {};
  const sequenceTodo = models.filter((model) => crcOf(model) !== undefined && state.sequences[model] !== crcOf(model));
  console.log(`${models.length} particle models, ${sequenceTodo.length} with new or changed sequences`);
  for (let i = 0; i < sequenceTodo.length; i += MODEL_BATCH) {
    const batch = sequenceTodo.slice(i, i + MODEL_BATCH);
    const files = new Map();
    await source.readFiles(batch.map((model) => `${model}_c`), files);
    source.release();
    for (const [model, sequences] of readSequences(files)) {
      const json = path.join(dist, model.replace(/\.vmdl$/, ".sequences.json"));
      fs.mkdirSync(path.dirname(json), { recursive: true });
      fs.writeFileSync(json, JSON.stringify(sequences));
      uploads.push({ path: model.replace(/\.vmdl$/, ".sequences.json"), file: json });
    }
    for (const model of batch) {
      state.sequences[model] = crcOf(model);
    }
  }

  const attachedList = path.join(dist, "particles/attached-models.json");
  fs.writeFileSync(attachedList, JSON.stringify(Object.keys(state.attached).sort().map((model) => model.replace(/\.vmdl$/, ".attachments.json"))));
  uploads.push({ path: "particles/attached-models.json", file: attachedList });

  if (upload) {
    await hf.upload(repo, accessToken, uploads, "Update particles");
    fs.writeFileSync(STATE_FILE, JSON.stringify(state));
  } else {
    console.log(`${uploads.length} files written to ${dist}`);
  }
}

main().then(
  () => process.exit(0),
  (error) => {
    console.error(error);
    process.exit(1);
  }
);
