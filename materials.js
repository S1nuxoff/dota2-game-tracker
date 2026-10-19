const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const { spawnSync } = require("child_process");
const { writeVpk } = require("./vpk-writer");
const sharp = require("sharp");

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

// The cube maps the exported models' materials reflect (g_tCubeMap), all six faces: Source2Viewer
// puts a single face of one in the model's glTF (often a black one). Each is written as a strip
// of its faces in the texture's own order, rt lf bk ft up dn (D3D's +X -X +Y -Y +Z -Z, in the
// game's axes), as cubemaps/<texture path>.png, and cubemaps/index.json maps the textures' file
// names (as the glTF's images name them) to the strips: { "glossy_orange_cube_tga_77c22107.vtex":
// "cubemaps/materials/models/cubemaps/glossy_orange_cube_tga_77c22107.png" }.
// state.cubeMaps = { materials, files, hash }: a hash of the materials' CRCs, the cube maps they
// named, and a hash of those cube maps' CRCs. The materials are read again only when one of them
// changed; otherwise the cube maps found before are checked by their CRCs alone.
// Returns { uploads, record } (the record kept in the state as cubeMaps), or null when nothing changed.
const CUBE_FACES = ["rt", "lf", "bk", "ft", "up", "dn"];
const crcHash = (source, files) => zlib.crc32(files.map((file) => `${file}:${source.vpkDir.tree[file].crc}`).join("\n")).toString(16);
async function exportCubeMaps({ state, source, decompiler, temp }) {
  const vmats = [...new Set(Object.values(state.models).flatMap((model) => (model.deps ?? []).filter((file) => file.endsWith(".vmat_c"))))]
    .filter((file) => source.vpkDir.tree[file])
    .sort();
  const materialsHash = crcHash(source, vmats);
  const work = path.join(temp, "cubemaps");
  fs.rmSync(work, { recursive: true, force: true });
  fs.mkdirSync(work, { recursive: true });
  let files;
  if (state.cubeMaps?.materials === materialsHash && Array.isArray(state.cubeMaps.files)) {
    files = state.cubeMaps.files.filter((file) => source.vpkDir.tree[file]);
  } else {
    const materials = new Map();
    await source.readFiles(vmats, materials);
    const pack = path.join(work, "materials.vpk");
    writeVpk(pack, materials);
    const printed = spawnSync(decompiler, ["-i", pack, "-e", "vmat_c", "-b", "DATA"], { encoding: "utf8", maxBuffer: 1024 * 1024 * 1024 });
    if (printed.error) {
      throw printed.error;
    }
    const cubes = new Set();
    for (const match of printed.stdout.matchAll(/m_pValue = resource_name:"([^"]+\.vtex)"\s*m_name = resource:"g_tCubeMap"/g)) {
      cubes.add(`${match[1].toLowerCase()}_c`);
    }
    files = [...cubes].filter((file) => source.vpkDir.tree[file]).sort();
  }
  const hash = crcHash(source, files);
  const record = { materials: materialsHash, files, hash };
  if (state.cubeMaps?.hash === hash) {
    // The cube maps are as they were; the materials' hash and list kept up to date
    state.cubeMaps = record;
    return null;
  }
  console.log(`Cube maps: ${files.length} reflected by ${vmats.length} materials`);
  const textures = new Map();
  await source.readFiles(files, textures);
  const input = path.join(work, "in");
  for (const [file, buffer] of textures) {
    fs.mkdirSync(path.dirname(path.join(input, file)), { recursive: true });
    fs.writeFileSync(path.join(input, file), buffer);
  }
  const output = path.join(work, "out");
  const result = spawnSync(decompiler, ["-i", input, "--recursive", "-o", output, "-d"], { encoding: "utf8", maxBuffer: 1024 * 1024 * 1024 });
  if (result.error) {
    throw result.error;
  }
  const index = {};
  const uploads = [];
  for (const file of files) {
    const base = path.join(output, file.replace(/\.vtex_c$/, ""));
    const faces = CUBE_FACES.map((face) => `${base}_${face}.png`);
    if (!faces.every((face) => fs.existsSync(face))) {
      console.log(`  ${file}: not a cube map`);
      continue;
    }
    const meta = await sharp(faces[0]).metadata();
    const strip = path.join(work, "strips", file.replace(/\.vtex_c$/, ".png"));
    fs.mkdirSync(path.dirname(strip), { recursive: true });
    await sharp({ create: { width: meta.width * 6, height: meta.height, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 1 } } })
      .composite(faces.map((face, i) => ({ input: face, left: i * meta.width, top: 0 })))
      .png()
      .toFile(strip);
    const published = `cubemaps/${file.replace(/\.vtex_c$/, ".png")}`;
    index[path.basename(file).replace(/_c$/, "")] = published;
    uploads.push({ path: published, file: strip });
  }
  const indexFile = path.join(work, "index.json");
  fs.writeFileSync(indexFile, JSON.stringify(index));
  uploads.push({ path: "cubemaps/index.json", file: indexFile });
  console.log(`  ${uploads.length - 1} cube maps written`);
  return { uploads, record };
}

module.exports = { exportDynamicMaterials, exportCubeMaps, parseDataBlocks, decode };
