// The face of a model, as the game moves it while a hero speaks: its flex controllers (jawOpen,
// lipPuckerer, ... the knobs voice lines and scenes turn) and the rules that make the mesh's morph
// targets (flex descriptors) out of them. Each mesh's morph block (MRPH) carries them; Source2Viewer
// keeps the morph targets in the glTF (each named in its accessor) but not the rules, so each
// model that has them gets <model>.flex.json next to its glb, and models/flex.json lists them:
//   { controllers: [[name, min, max], ...], rules: { "<descriptor>": [op, ...] } }
// An op is [code, value]: the game's FLEX_OP_ without its prefix, in lower case; the value of a
// "const" is its float, of a "fetch1" a controller index, of a "fetch2" a descriptor name.
//
// models.js reads it for the models of each batch it exports. For models exported before this,
// run it once over the whole state:
//   HF_TOKEN=... node lib/flex.js --game "<...>/dota 2 beta/game/dota" [--no-upload]
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const { writeVpk } = require("./vpk-writer");
const { parse } = require("./kv3");
const { DATASETS } = require("./datasets");

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

const floatOf = (bits) => {
  const buffer = Buffer.alloc(4);
  buffer.writeInt32LE(bits);
  return Number(buffer.readFloatLE(0).toPrecision(6));
};

// One model's flex from its meshes' printed morph blocks. Controllers are the model's (the same in
// every block); descriptors are per mesh and indexed in the block's own order, so rules go by name.
function modelFlex(blocks, name) {
  let controllers = null;
  const rules = {};
  for (const block of blocks) {
    const descriptors = (block.m_FlexDesc ?? []).map((desc) => desc.m_szFacs);
    const own = (block.m_FlexControllers ?? []).map((controller) => [controller.m_szName, controller.min, controller.max]);
    if (!own.length) continue;
    if (!controllers) controllers = own;
    else if (JSON.stringify(controllers) !== JSON.stringify(own)) console.log(`  Flex of ${name}: meshes differ in controllers, the first kept`);
    for (const rule of block.m_FlexRules ?? []) {
      const descriptor = descriptors[rule.m_nFlex];
      const ops = (rule.m_FlexOps ?? []).map(({ m_OpCode: code, m_Data: data }) => {
        const op = code.replace(/^FLEX_OP_/, "").toLowerCase();
        return [op, op === "const" ? floatOf(data) : op === "fetch2" ? descriptors[data] : data];
      });
      if (descriptor && !rules[descriptor]) rules[descriptor] = ops;
    }
  }
  return controllers && Object.keys(rules).length ? { controllers, rules } : null;
}

// { "models/....vmdl": flex } for the models among `buffers` (Map of "<model>_c" to its bytes)
// whose meshes have flex rules; the rest are left out
function readFlex(buffers, decompiler, work) {
  const withMorphs = new Map([...buffers].filter(([, buffer]) => buffer && hasBlock(buffer, "MRPH")));
  const result = {};
  if (!withMorphs.size) return result;
  fs.rmSync(work, { recursive: true, force: true });
  fs.mkdirSync(work, { recursive: true });
  const pack = path.join(work, "morphs.vpk");
  writeVpk(pack, withMorphs);
  const printed = spawnSync(decompiler, ["-i", pack, "-e", "vmdl_c", "-b", "MRPH"], { encoding: "utf8", maxBuffer: 2 * 1024 * 1024 * 1024 });
  if (printed.error) throw printed.error;
  // One file alone is printed without its "[1/1] name" line
  const chunks = withMorphs.size === 1 ? [`${[...withMorphs.keys()][0]}\n${printed.stdout}`] : printed.stdout.split(/\n\[\d+\/\d+\] /).slice(1);
  for (const chunk of chunks) {
    const name = chunk.slice(0, chunk.indexOf("\n")).trim().replace(/_c$/, "").toLowerCase();
    try {
      const blocks = chunk
        .split('--- Data for block "MRPH" ---')
        .slice(1)
        .map((text) => parse(text.slice(text.indexOf("<!-- kv3"))));
      const flex = modelFlex(blocks, name);
      if (flex) result[name] = flex;
    } catch (error) {
      console.log(`  Flex of ${name} not read: ${error.message}`);
    }
  }
  return result;
}

const flexPath = (model) => model.replace(/\.vmdl$/, ".flex.json");
const glbPath = (model) => model.replace(/\.vmdl$/, ".glb");

// Writes each model's flex to <dist>/<model>.flex.json; returns the files to upload
function writeFlex(flex, distDir) {
  return Object.entries(flex).map(([model, data]) => {
    const file = path.join(distDir, flexPath(model));
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(data));
    return { path: flexPath(model), file };
  });
}

// models/flex.json from the state: the glbs whose models have flex
function flexList(state, temp) {
  const file = path.join(temp, "flex.json");
  const list = Object.keys(state.models).filter((model) => state.models[model].flex).map(glbPath).sort();
  fs.writeFileSync(file, JSON.stringify(list));
  return { path: "models/flex.json", file, count: list.length };
}

async function backfill() {
  const { localSource } = require("./source");
  const hf = require("./hf");
  const game = process.argv[process.argv.indexOf("--game") + 1];
  const upload = !process.argv.includes("--no-upload");
  if (!process.argv.includes("--game") || (upload && !process.env.HF_TOKEN)) {
    console.error('Usage: HF_TOKEN=... node lib/flex.js --game "<...>/dota 2 beta/game/dota" [--no-upload]');
    process.exit(1);
  }
  const decompiler = path.resolve("vrf", process.platform === "win32" ? "Source2Viewer-CLI.exe" : "Source2Viewer-CLI");
  const temp = "./temp/flex";
  const distDir = path.join(temp, "dist");
  fs.rmSync(temp, { recursive: true, force: true });
  fs.mkdirSync(distDir, { recursive: true });
  const stateFile = "state/models.json";
  const state = JSON.parse(fs.readFileSync(stateFile, "utf8"));
  const source = localSource(game);
  const repo = upload ? await hf.prepareRepo(process.env.HF_TOKEN, DATASETS.models) : null;
  const todo = Object.keys(state.models).filter((model) => state.models[model].flex === undefined && source.vpkDir.tree[`${model}_c`]);
  console.log(`${todo.length} models to read for flex`);
  let found = 0;
  for (let i = 0; i < todo.length; i += CHUNK) {
    const batch = todo.slice(i, i + CHUNK);
    const buffers = new Map();
    await source.readFiles(batch.map((model) => `${model}_c`), buffers);
    const flex = readFlex(buffers, decompiler, path.join(temp, "work"));
    const files = writeFlex(flex, distDir);
    if (upload && files.length) await hf.upload(repo, process.env.HF_TOKEN, files, `Flex of ${files.length} models`);
    if (upload) for (const model of batch) state.models[model].flex = Boolean(flex[model]);
    found += files.length;
    if (upload) fs.writeFileSync(stateFile, JSON.stringify(state, null, 1));
    console.log(`${Math.min(i + CHUNK, todo.length)}/${todo.length} read, ${found} with flex`);
  }
  if (!upload) {
    console.log(`${found} models with flex (written to ${distDir}, state not saved)`);
    return;
  }
  const list = flexList(state, temp);
  await hf.upload(repo, process.env.HF_TOKEN, [list], "Models with flex");
  console.log(`${list.count} models with flex in all`);
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

module.exports = { readFlex, writeFlex, flexList };
