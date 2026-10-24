// The cloth, hair and beards the game moves on its own (a model's PHYS block: m_pFeModel, the
// "finite element" model of Source 2's cloth: nodes on the model's bones and vertices, rods
// between them, how heavy and damped each is). Source2Viewer leaves it out of the glTF, so each
// model that has one gets <model>.cloth.json next to its glb, and models/cloth.json lists them:
//   ["models/heroes/void_spirit/void_spirit.glb", ...]
// A model whose cloth has effects (m_Effects: wind, stiffening) also gets the animation events that
// start them (AE_CL_CLOTH_EFFECT) in its file, as `events`:
//   { "<animation>": [[cycle, effect name, peak, tail, end (seconds), operation], ...] }
//
// models.js reads it for the models of each batch it exports. For models exported before this,
// run it once over the whole state (--effects: again over the models with cloth, uploading those
// whose cloth has effects, after `events` was added):
//   HF_TOKEN=... node lib/cloth.js --game "<...>/dota 2 beta/game/dota" [--effects] [--no-upload]
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const { writeVpk } = require("./vpk-writer");
const { parse } = require("./kv3");

// Kept out of the files: SIMD copies of other arrays, hashes of names given as text anyway
const DROPPED = /^m_Simd|^m_CtrlHash$|^m_TreeCollisionMasks$/;
const CHUNK = 300;

// Whether a compiled resource has a block of the given type
function hasBlock(buffer, type) {
  const blocksStart = 8 + buffer.readUInt32LE(8);
  const blockCount = buffer.readUInt32LE(12);
  for (let i = 0; i < blockCount; i++) {
    const block = blocksStart + i * 12;
    if (buffer.toString("ascii", block, block + 4) === type) return true;
  }
  return false;
}

// Numbers to 6 significant digits, empty arrays and the dropped keys left out
function trim(value) {
  if (typeof value === "number") return Number.isInteger(value) ? value : Number(value.toPrecision(6));
  if (Array.isArray(value)) return value.map(trim);
  if (value && typeof value === "object") {
    const result = {};
    for (const [key, item] of Object.entries(value)) {
      if (DROPPED.test(key) || (Array.isArray(item) && item.length === 0)) continue;
      result[key] = trim(item);
    }
    return result;
  }
  return value;
}

// The cloth effects each animation of a model starts, from its printed blocks: an animation's
// m_name (three tabs in) comes before its m_eventArray, whose events give m_flCycle and their keys
function clothEvents(text) {
  const result = {};
  let animation = null;
  let inEvents = false;
  let event = null;
  for (const line of text.split("\n")) {
    const name = line.match(/^\t\t\tm_name = "([^"]+)"/);
    if (name) {
      animation = name[1];
      continue;
    }
    if (/^\t\t\tm_eventArray =/.test(line)) {
      inEvents = true;
      continue;
    }
    if (inEvents && /^\t\t\t[^\t]/.test(line) && !/^\t\t\t[[\]]/.test(line)) inEvents = false;
    if (!inEvents) continue;
    if (/^\t\t\t\t\{/.test(line)) {
      event = {};
      continue;
    }
    if (!event) continue;
    let match;
    if ((match = line.match(/^\t{5}m_flCycle = ([-\d.e]+)/))) event.cycle = Number(match[1]);
    else if ((match = line.match(/^\t{6}FeEffectName = "([^"]*)"/))) event.name = match[1];
    else if ((match = line.match(/^\t{6}Operation = (\d+)/))) event.operation = Number(match[1]);
    else if ((match = line.match(/^\t{6}peaktailend = \[ ([^\]]+) \]/))) event.envelope = match[1].split(",").map(Number);
    else if ((match = line.match(/^\t{5}m_sEventName = "([^"]+)"/))) {
      if (match[1] === "AE_CL_CLOTH_EFFECT" && event.name && animation) {
        (result[animation] ??= []).push(trim([event.cycle ?? 0, event.name, ...(event.envelope ?? [0, 0, 0]), event.operation ?? 0]));
      }
      event = null;
    }
  }
  return result;
}

// { "models/....vmdl": feModel } for the models among `buffers` (Map of "<model>_c" to its bytes)
// whose physics has nodes that move; the rest are left out
function readCloth(buffers, decompiler, work) {
  const withPhysics = new Map([...buffers].filter(([, buffer]) => buffer && hasBlock(buffer, "PHYS")));
  const result = {};
  if (!withPhysics.size) return result;
  fs.rmSync(work, { recursive: true, force: true });
  fs.mkdirSync(work, { recursive: true });
  const pack = path.join(work, "physics.vpk");
  writeVpk(pack, withPhysics);
  const printed = spawnSync(decompiler, ["-i", pack, "-e", "vmdl_c", "-b", "PHYS"], { encoding: "utf8", maxBuffer: 2 * 1024 * 1024 * 1024 });
  if (printed.error) throw printed.error;
  // One file alone is printed without its "[1/1] name" line
  const chunks = withPhysics.size === 1 ? [`${[...withPhysics.keys()][0]}\n${printed.stdout}`] : printed.stdout.split(/\n\[\d+\/\d+\] /).slice(1);
  for (const chunk of chunks) {
    const name = chunk.slice(0, chunk.indexOf("\n")).trim().replace(/_c$/, "").toLowerCase();
    const start = chunk.indexOf("<!-- kv3");
    if (start < 0) continue;
    try {
      const fe = parse(chunk.slice(start)).m_pFeModel;
      if (fe && fe.m_nNodeCount > (fe.m_nStaticNodes ?? 0)) result[name] = trim(fe);
    } catch (error) {
      console.log(`  Cloth of ${name} not read: ${error.message}`);
    }
  }
  for (const [name, fe] of Object.entries(result)) {
    if (!fe.m_Effects) continue;
    const animations = spawnSync(decompiler, ["-i", pack, "-f", `${name}_c`, "-a"], { encoding: "utf8", maxBuffer: 1024 * 1024 * 1024 });
    if (animations.error) throw animations.error;
    const events = clothEvents(animations.stdout);
    if (Object.keys(events).length) fe.events = events;
  }
  return result;
}

const clothPath = (model) => model.replace(/\.vmdl$/, ".cloth.json");
const glbPath = (model) => model.replace(/\.vmdl$/, ".glb");

// Writes each model's cloth to <dist>/<model>.cloth.json; returns the files to upload
function writeCloth(cloth, distDir) {
  return Object.entries(cloth).map(([model, fe]) => {
    const file = path.join(distDir, clothPath(model));
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(fe));
    return { path: clothPath(model), file };
  });
}

// models/cloth.json from the state: the glbs whose models have cloth
function clothList(state, temp) {
  const file = path.join(temp, "cloth.json");
  const list = Object.keys(state.models).filter((model) => state.models[model].cloth).map(glbPath).sort();
  fs.writeFileSync(file, JSON.stringify(list));
  return { path: "models/cloth.json", file, count: list.length };
}

async function backfill() {
  const { localSource } = require("./source");
  const hf = require("./hf");
  const game = process.argv[process.argv.indexOf("--game") + 1];
  const upload = !process.argv.includes("--no-upload");
  if (!process.argv.includes("--game") || (upload && !process.env.HF_TOKEN)) {
    console.error('Usage: HF_TOKEN=... node lib/cloth.js --game "<...>/dota 2 beta/game/dota" [--no-upload]');
    process.exit(1);
  }
  const decompiler = path.resolve("vrf", process.platform === "win32" ? "Source2Viewer-CLI.exe" : "Source2Viewer-CLI");
  const temp = "./temp/cloth";
  const distDir = path.join(temp, "dist");
  fs.rmSync(temp, { recursive: true, force: true });
  fs.mkdirSync(distDir, { recursive: true });
  const stateFile = "state/models.json";
  const state = JSON.parse(fs.readFileSync(stateFile, "utf8"));
  const source = localSource(game);
  const repo = upload ? await hf.prepareRepo(process.env.HF_TOKEN, process.env.HF_REPO) : null;
  const effects = process.argv.includes("--effects");
  const todo = Object.keys(state.models).filter(
    (model) => (effects ? state.models[model].cloth : state.models[model].cloth === undefined) && source.vpkDir.tree[`${model}_c`]
  );
  console.log(`${todo.length} models to read for cloth`);
  let found = 0;
  for (let i = 0; i < todo.length; i += CHUNK) {
    const batch = todo.slice(i, i + CHUNK);
    const buffers = new Map();
    await source.readFiles(batch.map((model) => `${model}_c`), buffers);
    const cloth = readCloth(buffers, decompiler, path.join(temp, "work"));
    if (effects) {
      for (const model of Object.keys(cloth)) if (!cloth[model].m_Effects) delete cloth[model];
    }
    const files = writeCloth(cloth, distDir);
    if (upload && files.length) await hf.upload(repo, process.env.HF_TOKEN, files, `Cloth of ${files.length} models`);
    if (!effects) for (const model of batch) state.models[model].cloth = Boolean(cloth[model]);
    found += files.length;
    if (upload) fs.writeFileSync(stateFile, JSON.stringify(state, null, 1));
    console.log(`${Math.min(i + CHUNK, todo.length)}/${todo.length} read, ${found} with cloth${effects ? " effects" : ""}`);
  }
  if (effects) return;
  const list = clothList(state, temp);
  if (upload) await hf.upload(repo, process.env.HF_TOKEN, [list], "Models with cloth");
  console.log(`${list.count} models with cloth in all${upload ? "" : ` (written to ${distDir}, state not saved)`}`);
}

if (require.main === module) {
  backfill().then(
    () => process.exit(0),
    (error) => {
      console.error(error);
      process.exit(1);
    }
  );
}

module.exports = { readCloth, writeCloth, clothList };
