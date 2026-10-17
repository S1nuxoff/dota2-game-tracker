const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

// Material variants of models ("skins"): a model lists material groups, each with the
// same number of materials, and an item's skin N swaps the default group for group N.
// Source2Viewer exports only the default group, so for the skins items use, the swapped
// materials are written as <model>.skins.json with their textures as PNGs:
//   { "1": { "<default material name>": { ShaderName, IntParams, FloatParams, VectorParams,
//            TextureParams: { g_tColor: "textures/....png", ... } } } }
// which is the shape of the vmat data Source2Viewer keeps in the glTF, so the viewer
// builds these materials the same way.

function run(decompiler, args) {
  const result = spawnSync(decompiler, args, { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
  if (result.error) {
    throw result.error;
  }
  return `${result.stdout}${result.stderr}`;
}

// [{ name, materials: ["materials/....vmat", ...] }] from the model's DATA block
function materialGroups(decompiler, modelFile) {
  const text = run(decompiler, ["-i", modelFile, "-b", "DATA"]);
  const start = text.indexOf("m_materialGroups");
  const open = start < 0 ? -1 : text.indexOf("[", start);
  if (open < 0) {
    return [];
  }
  let depth = 0;
  let end = open;
  for (; end < text.length; end++) {
    if (text[end] === "[") depth++;
    if (text[end] === "]" && --depth === 0) break;
  }

  const groups = [];
  const pattern = /m_name\s*=\s*"([^"]*)"|(?:resource:)?"([^"]+\.vmat)"/g;
  for (const match of text.slice(open, end).matchAll(pattern)) {
    if (match[1] !== undefined) {
      groups.push({ name: match[1], materials: [] });
    } else if (groups.length > 0) {
      groups.at(-1).materials.push(match[2].toLowerCase());
    }
  }
  return groups;
}

// A decompiled .vmat (KeyValues text) into the glTF extras shape, with its path as Name (as
// Source2Viewer gives it, for materials/dynamic.json). Only the material's own values and its
// compiled textures are read: the expressions in DynamicParams are not values (taken as
// vectors they came out as [null, null])
function parseVmat(text, name) {
  const values = {};
  const compiled = {};
  let block = null;
  let depth = 0;
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "{") {
      depth++;
      continue;
    }
    if (trimmed === "}") {
      depth--;
      if (depth <= 1) block = null;
      continue;
    }
    const section = trimmed.match(/^"([^"]+)"$/);
    if (section) {
      if (depth === 1) block = section[1];
      continue;
    }
    const pair = line.match(/^\s*"([^"]+)"\s+"([^"]*)"/);
    if (pair && depth === 1 && !block) {
      values[pair[1]] = pair[2];
    } else if (pair && block === "Compiled Textures") {
      compiled[pair[1]] = pair[2];
    }
  }

  const vmat = { Name: name, ShaderName: values.shader, IntParams: {}, FloatParams: {}, VectorParams: {}, TextureParams: {} };
  for (const [key, value] of Object.entries(values)) {
    if (key.startsWith("F_")) {
      vmat.IntParams[key] = Number(value);
    } else if (key.startsWith("g_fl")) {
      vmat.FloatParams[key] = parseFloat(value);
    } else if (key.startsWith("g_v")) {
      vmat.VectorParams[key] = value.replace(/[[\]]/g, "").trim().split(/\s+/).map(Number);
    }
  }
  for (const [key, value] of Object.entries(compiled)) {
    vmat.TextureParams[key] = value.toLowerCase();
  }
  return vmat;
}

function writeTree(root, files) {
  fs.rmSync(root, { recursive: true, force: true });
  for (const [file, buffer] of files) {
    const target = path.join(root, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, buffer);
  }
}

// wanted: Map model -> Set of skin numbers. files: the game files read so far.
// collect(paths): reads more game files (with their dependencies) into files.
// Returns { json: [{ path, file }], textures: [{ path, file }] } to upload.
async function exportSkins({ wanted, files, collect, decompiler, temp, distDir }) {
  const work = path.join(temp, "skins");
  fs.rmSync(work, { recursive: true, force: true });

  // Which materials each wanted skin swaps
  const swaps = new Map();
  for (const [model, skins] of wanted) {
    const modelFile = path.join(work, "models", `${model}_c`);
    fs.mkdirSync(path.dirname(modelFile), { recursive: true });
    fs.writeFileSync(modelFile, files.get(`${model}_c`));
    const groups = materialGroups(decompiler, modelFile);
    if (groups.length < 2) {
      continue;
    }
    const perSkin = {};
    for (const skin of skins) {
      const group = groups[skin];
      if (!group) {
        continue;
      }
      perSkin[skin] = groups[0].materials
        .map((material, index) => ({ from: material, to: group.materials[index] }))
        .filter((swap) => swap.to && swap.to !== swap.from);
    }
    swaps.set(model, perSkin);
  }

  const vmats = [
    ...new Set(
      [...swaps.values()].flatMap((perSkin) => Object.values(perSkin).flatMap((list) => list.map((swap) => `${swap.to}_c`)))
    ),
  ];
  if (vmats.length === 0) {
    return { json: [], textures: [] };
  }
  await collect(vmats);

  // Decompile the swapped materials to read their parameters and textures
  writeTree(path.join(work, "vmat"), vmats.filter((file) => files.has(file)).map((file) => [file, files.get(file)]));
  run(decompiler, ["-i", path.join(work, "vmat"), "--recursive", "-d", "-o", path.join(work, "vmat_out")]);
  const parsed = new Map();
  for (const file of vmats) {
    const text = path.join(work, "vmat_out", file.replace(/_c$/, ""));
    if (fs.existsSync(text)) {
      parsed.set(file.replace(/_c$/, ""), parseVmat(fs.readFileSync(text, "utf8"), file.replace(/_c$/, "")));
    }
  }

  // Their textures as PNGs
  const vtexes = [
    ...new Set([...parsed.values()].flatMap((vmat) => Object.values(vmat.TextureParams).map((texture) => `${texture}_c`))),
  ].filter((file) => files.has(file));
  writeTree(path.join(work, "vtex"), vtexes.map((file) => [file, files.get(file)]));
  run(decompiler, ["-i", path.join(work, "vtex"), "--recursive", "-d", "-o", path.join(work, "vtex_out"), "--threads", "4"]);
  const textures = [];
  const textureUrl = {};
  for (const file of vtexes) {
    const vtex = file.replace(/_c$/, "");
    const png = path.join(work, "vtex_out", vtex.replace(/\.vtex$/, ".png"));
    if (fs.existsSync(png)) {
      textureUrl[vtex] = `textures/${vtex.replace(/\.vtex$/, ".png")}`;
      textures.push({ path: textureUrl[vtex], file: png });
    }
  }

  const json = [];
  for (const [model, perSkin] of swaps) {
    const result = {};
    for (const [skin, list] of Object.entries(perSkin)) {
      for (const { from, to } of list) {
        const vmat = parsed.get(to);
        if (!vmat) {
          continue;
        }
        const textureParams = {};
        for (const [param, vtex] of Object.entries(vmat.TextureParams)) {
          if (textureUrl[vtex]) {
            textureParams[param] = textureUrl[vtex];
          }
        }
        (result[skin] ??= {})[path.basename(from, ".vmat")] = { ...vmat, TextureParams: textureParams };
      }
    }
    if (Object.keys(result).length > 0) {
      const datasetPath = model.replace(/\.vmdl$/, ".skins.json");
      const file = path.join(distDir, datasetPath);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify(result));
      json.push({ path: datasetPath, file });
    }
  }
  return { json, textures };
}

module.exports = { exportSkins, materialGroups, parseVmat };
