const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const { spawnSync } = require("child_process");
const { writeVpk } = require("./vpk-writer");

// Materials whose parameters the game works out every frame (DynamicParams in a .vmat: a detail
// texture scrolling, a glow pulsing). Source2Viewer leaves them out of the glTF, so they are
// written for every material the exported models use as materials/dynamic.json:
//   { "materials/....vmat": { "g_vDetailTexCoordOffset": [0.055, 0, "float2", "time", "*", "frac"], ... } }
// Each a program for a small stack machine, read off the compiled expression: numbers are pushed,
// "+", "-", "*", "/" and "neg" work on the top of the stack, a function name calls it with as
// many values as it takes, "set N" and "get N" keep and read a local value. An expression that
// reads a value the game sets (a team's color, whether a gem is worn) is left out: the material
// keeps its fixed value there.

// The compiled expression's functions, by their number
const FUNCTIONS = ["sin", "cos", "tan", "frac", "floor", "ceil", "saturate", "clamp", "lerp", "dot4", "dot3", "dot2", "log", "log2", "log10", "exp", "exp2", "sqrt", "rsqrt", "sign", "abs", "pow", "step", "smoothstep", "float4", "float3", "float2", "time", "min", "max", "SrgbLinearToGamma", "SrgbGammaToLinear", "random", "normalize", "length", "sqr", "TextureSize"];
const OPERATORS = { 0x13: "+", 0x14: "-", 0x15: "*", 0x16: "/", 0x17: "%", 0x18: "neg", 0x0c: "!", 0x0d: "==", 0x0e: "!=", 0x0f: ">", 0x10: ">=", 0x11: "<", 0x12: "<=" };

// The program of one compiled expression, or null where it reads the game's values or has
// something this does not know
function decode(bytes) {
  const program = [];
  let i = 0;
  while (i < bytes.length) {
    const op = bytes[i++];
    if (op === 0x00) return program;
    if (op === 0x07) {
      program.push(Number(Buffer.from(bytes.slice(i, i + 4)).readFloatLE(0).toPrecision(7)));
      i += 4;
    } else if (op === 0x06) {
      const name = FUNCTIONS[bytes[i] | (bytes[i + 1] << 8)];
      if (!name) return null;
      program.push(name);
      i += 2;
    } else if (OPERATORS[op]) {
      program.push(OPERATORS[op]);
    } else if (op === 0x08 || op === 0x09) {
      program.push(`${op === 0x08 ? "set" : "get"} ${bytes[i++]}`);
    } else {
      // 0x19 a value the game sets, 0x1f whether it sets one, and anything else
      return null;
    }
  }
  return program;
}

// The dynamic parameters of each material in Source2Viewer's print of their DATA blocks
function parseDataBlocks(text) {
  const result = {};
  for (const chunk of text.split(/\n\[\d+\/\d+\] /).slice(1)) {
    const name = chunk.slice(0, chunk.indexOf("\n")).trim().replace(/_c$/, "");
    const block = chunk.match(/m_dynamicParams = \n\t\[([\s\S]*?)\n\t\]/);
    if (!block) continue;
    const params = {};
    for (const entry of block[1].split(/\n\t\t\},?/)) {
      const value = entry.match(/m_value = \s*#\[([0-9A-F\s]*)\]/);
      const key = entry.match(/m_name = (?:resource:)?"([^"]+)"/);
      if (!value || !key) continue;
      const program = decode(value[1].trim().split(/\s+/).filter(Boolean).map((byte) => parseInt(byte, 16)));
      if (program?.length) params[key[1]] = program;
    }
    if (Object.keys(params).length) result[name.toLowerCase()] = params;
  }
  return result;
}

// state: the export's state (each model's game files); written again only when one of the
// materials changed. Returns { upload: { path, file }, hash } (the hash kept in the state as
// dynamicMaterials), or null when nothing changed.
async function exportDynamicMaterials({ state, source, decompiler, temp }) {
  const vmats = [...new Set(Object.values(state.models).flatMap((model) => (model.deps ?? []).filter((file) => file.endsWith(".vmat_c"))))]
    .filter((file) => source.vpkDir.tree[file])
    .sort();
  const hash = zlib.crc32(vmats.map((file) => `${file}:${source.vpkDir.tree[file].crc}`).join("\n")).toString(16);
  if (state.dynamicMaterials === hash) {
    return null;
  }
  console.log(`Dynamic material parameters: reading ${vmats.length} materials`);
  const work = path.join(temp, "dynamic");
  fs.rmSync(work, { recursive: true, force: true });
  fs.mkdirSync(work, { recursive: true });
  const files = new Map();
  await source.readFiles(vmats, files);
  const pack = path.join(work, "materials.vpk");
  writeVpk(pack, files);
  const printed = spawnSync(decompiler, ["-i", pack, "-e", "vmat_c", "-b", "DATA"], { encoding: "utf8", maxBuffer: 1024 * 1024 * 1024 });
  if (printed.error) {
    throw printed.error;
  }
  const dynamic = parseDataBlocks(printed.stdout);
  const file = path.join(work, "dynamic.json");
  fs.writeFileSync(file, JSON.stringify(dynamic));
  console.log(`  ${Object.keys(dynamic).length} materials with parameters that change`);
  return { upload: { path: "materials/dynamic.json", file }, hash };
}

module.exports = { exportDynamicMaterials, parseDataBlocks, decode };
