// Particles for Dotadex: every particle system of the game, those the heroes and their items show
// (their ambient effects and the cosmetics' own) first, with all the systems they spawn, as JSON, and the textures
// they draw as atlases with their frames. Only what changed since the last run is converted and
// uploaded again (state/particles.json keeps the CRCs and what each system refers to).
//
//   HF_TOKEN=... node exporters/particles.js --game "<...>/dota 2 beta/game/dota"
//   HF_TOKEN=... node exporters/particles.js <STEAM USERNAME> <STEAM PASSWORD>   (GitHub Actions)
//
// Uploads to the dota2-particles dataset (the particles/ paths) and the models dataset (models/):
//   particles/<path>.json                    a system (particles/<path>.vpcf in the game), as KV3 gives it
//   particles/textures/<path>.png, .json     a texture (<path>.vtex) and its sheet: sequences of frames
//   particles/bundles/<path>.json            an effect items show with every system it spawns, in one file
//   particles/<path>.vsnap.json              a snapshot: points placed on a model ({ position: [[x, y, z]],
//                                            radius: [r], ... } by stream, in the model's space), the
//                                            effects' own and those items put in their place
//   models/<path>.sequences.json            an exported model or one particles draw: its sequences, whether
//                                            each loops, its activities, the animation it plays (the glb's
//                                            clip, where not its name), the particle effects its
//                                            animations start and what they say ({ name: { looping, activities,
//                                            clip, effects: [{ at, system, config, stopOnChange, immediately,
//                                            stop }], speech: [{ at, concept, criteria }] } })
//   particles/model-effects.json             the effects models start on their own (the pedestals'
//                                            ground fog): { "<model>.vmdl": [{ system, config }] }
//   particles/map-effects.json               the effects the heroes' page maps start (the god rays over
//                                            the pedestal): { "<map>.vmap": [{ system, name, origin, angles }] },
//                                            and every effect of the UI scenes (card edges), start: false
//                                            on those the game's code starts by name
//   particles/map-cameras.json               the UI scenes' cameras: { "<map>.vmap": { <name>: { origin,
//                                            angles, fov, near, far } } }
//   particles/coverage.json                  how often each operator class is used, for the viewer to
//                                            know what it does not draw yet
//   particles/schema.json                    the engine's particle classes with their fields' defaults,
//                                            for the fields a .vpcf leaves out (particle-schema.js)
// and lists the models the particles draw in state/particle-models.json, for models.js to export.
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { spawn, spawnSync } = require("child_process");
const readline = require("readline");
const sharp = require("sharp");
const hf = require("../lib/hf");
const kv3 = require("../lib/kv3");
const { openSource } = require("../lib/source");
const { loadItemsGame } = require("../lib/itemsgame");
const { parse } = require("../lib/keyvalues");
const { exportSchema } = require("../lib/particle-schema");

const temp = "./temp/particles";
const STATE_FILE = "state/particles.json";
const MODELS_FILE = "state/particle-models.json";
const LOADOUT_PORTRAITS = "scripts/npc/portraits_full_body_loadout.txt";
// Particle-only scenes the game's panels show, whose effects its code starts by name: the card
// edges (ui_econ_item_animated.xml #ArcanaBackgroundEffect; client.dll starts armory_edge_set on
// set tiles, armory_edge_icon on animated item tiles once the card's scene is loaded)
const UI_MAPS = ["maps/scenes/armory/ui_armory_edges.vmap"];
// Raised when the bundles change shape, to make them all again
const BUNDLE_VERSION = 1;
// Raised when textures are built another way, so all of them are built again (2: sheet frames at their own sizes; 3: each in its whole cell)
const TEXTURE_VERSION = 3;
const DECOMPILER = path.resolve("vrf", process.platform === "win32" ? "Source2Viewer-CLI.exe" : "Source2Viewer-CLI");
const BATCH = 2000;
// What a sprite or trail (a soft white dot) and a rope draw where a layer names no texture
const DEFAULT_TEXTURES = ["materials/particle/base_sprite.vtex", "materials/particle/base_rope.vtex"];
// Raised when the models' sequence files change shape, to read them all again (2: the animation
// each plays and the particle effects it starts; 3: what it says)
const SEQUENCE_FORMAT = 3;
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

// The weather items' effects by their weather_type (client.dll's table at 0x184945790, 0 none)
const WEATHER_SYSTEMS = [
  "particles/rain_fx/econ_snow.vpcf",
  "particles/rain_fx/econ_rain.vpcf",
  "particles/rain_fx/econ_moonlight.vpcf",
  "particles/rain_fx/econ_weather_pestilence.vpcf",
  "particles/rain_fx/econ_weather_harvest.vpcf",
  "particles/rain_fx/econ_weather_sirocco.vpcf",
  "particles/rain_fx/econ_weather_spring.vpcf",
  "particles/rain_fx/econ_weather_ash.vpcf",
  "particles/rain_fx/econ_weather_aurora.vpcf",
];

// The particle systems items show: created alongside them, put in place of others, or named by
// any other modifier (a kill streak's, an emblem's), and the weather's
async function rootSystems(source) {
  const data = await loadItemsGame(source);
  const roots = new Set(WEATHER_SYSTEMS);
  for (const item of Object.values(data.items_game.items)) {
    for (const visual of Object.values(item.visuals ?? {})) {
      if (visual && typeof visual === "object") {
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

// The effects the heroes' pages show on the hero (npc_dota_hero_*'s RenderablePortrait Particles:
// Broodmother's web, Void Spirit's loadout glow), which data/heroes.json gives the site
async function portraitSystems(source) {
  const files = new Map();
  await source.readFiles(source.vpkDir.files.filter((file) => file.startsWith("scripts/npc/heroes/") || file === "scripts/npc/npc_heroes.txt"), files);
  source.release();
  const systems = new Set();
  for (const buffer of files.values()) {
    for (const hero of Object.values(parse(buffer).root.DOTAHeroes ?? {})) {
      for (const system of Object.keys(hero?.RenderablePortrait?.Particles ?? {})) {
        if (system.toLowerCase().endsWith(".vpcf")) systems.add(system.toLowerCase());
      }
    }
  }
  return [...systems];
}

// The effects models start on their own (a particle_cfg in the model's game data), for the
// pedestals the heroes' pages stand on: the loadout pedestal's ground fog and the dust it raises
// as it turns. { "<model>.vmdl": [{ system, config }] }
async function modelEffects(source) {
  if (!source.vpkDir.tree[LOADOUT_PORTRAITS]) {
    return {};
  }
  const portraits = new Map();
  await source.readFiles([LOADOUT_PORTRAITS], portraits);
  const text = portraits.get(LOADOUT_PORTRAITS).toString("utf8");
  const models = [...new Set([...text.matchAll(/"PortraitBackgroundModel"\s+"([^"]+\.vmdl)"/gi)].map((match) => match[1].toLowerCase()))].filter(
    (model) => source.vpkDir.tree[`${model}_c`]
  );
  const files = new Map();
  await source.readFiles(models.map((model) => `${model}_c`), files);
  const out = convert(files, "model-effects");
  source.release();
  const found = {};
  for (const model of models) {
    const file = path.join(out, model);
    if (!fs.existsSync(file)) {
      continue;
    }
    const effects = [];
    const visit = (node) => {
      if (node?.game_class === "particle_cfg" && typeof node.game_keys?.name === "string") {
        effects.push({ system: node.game_keys.name.toLowerCase(), ...(node.game_keys.config ? { config: node.game_keys.config } : {}) });
      }
      for (const child of node?.children ?? []) visit(child);
    };
    visit(kv3.parse(fs.readFileSync(file, "utf8"))?.rootNode);
    if (effects.length) {
      found[model] = effects;
    }
  }
  return found;
}

// The effects the maps of the heroes' pages start themselves (PortraitBackgroundMap: their
// info_particle_system entities, e.g. the god rays over the pedestal on dota_hud_loadout_2022),
// read from each map's own VPK beside the game's. { "<map>.vmap": [{ system, name, origin, angles }] },
// name the entity's (the game's code finds it by that), origin in game units, angles in degrees.
// The UI_MAPS give all their effects, those the code starts with start: false, and their
// point_camera entities in cameras: { "<map>.vmap": { <name>: { origin, angles, fov, near, far } } }
async function mapEffects(source) {
  const found = {};
  const cameras = {};
  if (!source.vpkDir.tree[LOADOUT_PORTRAITS]) {
    return { found, cameras };
  }
  const portraits = new Map();
  await source.readFiles([LOADOUT_PORTRAITS], portraits);
  const text = portraits.get(LOADOUT_PORTRAITS).toString("utf8");
  const pageMaps = [...new Set([...text.matchAll(/"PortraitBackgroundMap"\s+"([^"]+\.vmap)"/gi)].map((match) => match[1].toLowerCase()))];
  const maps = [...pageMaps, ...UI_MAPS];
  const loose = source.looseFiles("maps/");
  const folder = path.join(temp, "maps");
  fs.mkdirSync(folder, { recursive: true });
  const run = (args) => spawnSync(DECOMPILER, args, { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 }).stdout ?? "";
  const numbers = (value) => (typeof value === "string" ? value.trim().split(/\s+/).map(Number) : [0, 0, 0]);
  for (const map of maps) {
    const entry = loose.find((file) => file.path.toLowerCase() === map.replace(/\.vmap$/, ".vpk"));
    if (!entry) {
      console.log(`${map}: its VPK is not in the game`);
      continue;
    }
    const file = path.join(folder, path.basename(entry.path));
    fs.writeFileSync(file, await source.readLoose(entry));
    const effects = [];
    for (const lump of run(["-i", file, "-l"]).match(/^\S+\.vents_c/gm) ?? []) {
      for (const [, body] of run(["-i", file, "-f", lump, "-b", "DATA"]).matchAll(/values = \s*\{([^{}]*)\}/g)) {
        const entity = {};
        for (const [, key, value] of body.matchAll(/^\s*(\w+) = (.+)$/gm)) {
          entity[key.toLowerCase()] = value.startsWith('"') ? value.slice(1, -1) : value;
        }
        const name = (entity.targetname ?? "").replace(/^\[PR#\]/, "");
        const ui = UI_MAPS.includes(map);
        if (entity.classname === "info_particle_system" && entity.effect_name && (ui || entity.start_active !== "false")) {
          effects.push({
            system: entity.effect_name.toLowerCase(),
            name,
            origin: numbers(entity.origin),
            angles: numbers(entity.angles),
            ...(entity.start_active === "false" ? { start: false } : {}),
          });
        }
        if (ui && entity.classname === "point_camera") {
          cameras[map] ??= {};
          cameras[map][name] = {
            origin: numbers(entity.origin),
            angles: numbers(entity.angles),
            fov: Number(entity.fov),
            near: Number(entity.znear),
            far: Number(entity.zfar),
          };
        }
      }
    }
    if (effects.length) {
      found[map] = effects;
    }
  }
  return { found, cameras };
}

// The snapshots items put in place of others (particle_snapshot: a weapon's own points for the
// default weapon's glow); no .vpcf refers to them
async function itemSnapshots(source) {
  const data = await loadItemsGame(source);
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

// The particle and speech events of each animation of the models in folder (written there by readBlocks),
// from their printed ANIM blocks: Map(model => { "<animation>": [event, ...] }) with each event
// as KV3 gives it (m_sEventName, m_flCycle, m_EventData). A hero's ANIM block prints tens of
// megabytes (every bone's bounds), so the print is read line by line, keeping only the events.
function readAnimationEvents(folder) {
  return new Promise((resolve, reject) => {
    const found = new Map();
    const child = spawn(DECOMPILER, ["-i", folder, "--recursive", "-b", "ANIM"]);
    const lines = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
    let file = null;
    let animation = null;
    let inEvents = false;
    let event = null;
    lines.on("line", (line) => {
      const start = line.match(/^\[\d+\/\d+\] (.+)$/);
      if (start) {
        file = path.relative(folder, start[1].trim()).split(path.sep).join("/").replace(/_c$/, "");
        animation = null;
        inEvents = false;
        return;
      }
      // An animation's m_name (three tabs in) comes before its m_eventArray, whose events are
      // objects four tabs in
      const name = line.match(/^\t\t\tm_name = "([^"]*)"/);
      if (name) {
        animation = name[1];
        return;
      }
      if (/^\t\t\tm_eventArray =/.test(line)) {
        inEvents = true;
        return;
      }
      if (!inEvents) return;
      if (/^\t\t\t[^\t[\]]/.test(line)) {
        inEvents = false;
        return;
      }
      if (/^\t\t\t\t\{/.test(line)) {
        event = [line];
      } else if (event && /^\t\t\t\t\},?$/.test(line)) {
        event.push("}");
        const text = event.join("\n");
        event = null;
        if (!/PARTICLE|AE_CL_SPEECH/.test(text) || !file || !animation) return;
        try {
          const parsed = kv3.parse(text);
          if (!found.has(file)) found.set(file, {});
          (found.get(file)[animation] ??= []).push(parsed);
        } catch {
          // An event KV3 cannot read is left out
        }
      } else if (event) {
        event.push(line);
      }
    });
    child.on("error", reject);
    lines.on("close", () => resolve(found));
  });
}

// What a particle event of an animation does on the site, or null for others:
//   { at: cycle, system, config, stopOnChange, immediately }   starts an effect (its control
//                                                               point configuration by name)
//   { at: cycle, system, stop: true, immediately }              ends the effects of that system
function animationEffect(event) {
  const data = event.m_EventData ?? {};
  const system = typeof data.name === "string" ? data.name.toLowerCase() : null;
  if (!system?.endsWith(".vpcf")) return null;
  const at = Number(event.m_flCycle) || 0;
  if (/^AE_CL_CREATE_PARTICLE_EFFECT/.test(event.m_sEventName)) {
    return {
      at,
      system,
      ...(data.config && { config: data.config }),
      ...(data.attachment && { attachment: data.attachment }),
      ...(data.attachType && { attachType: data.attachType }),
      ...(data.stop_on_seq_change && { stopOnChange: true }),
      ...(data.stop_immediately && { immediately: true }),
    };
  }
  if (/^AE_CL_STOP_PARTICLE_EFFECT/.test(event.m_sEventName)) {
    return { at, system, stop: true, ...(data.stop_immediately && { immediately: true }) };
  }
  return null;
}

// What a speech event of an animation says, or null for others: { at: cycle, concept, criteria:
// { key: value } } (Void Spirit's loadout spawn: TLK_DOTA_CUSTOM, special_spawn=
// void_spirit_loadout_spawn), which the hero's response rules turn into a line
function animationSpeech(event) {
  if (event.m_sEventName !== "AE_CL_SPEECH" || typeof event.m_EventData?.concept !== "string") return null;
  const criteria = {};
  for (const pair of String(event.m_EventData.criteria ?? "").split(",")) {
    const [key, ...value] = pair.split("=");
    if (key.trim()) criteria[key.trim()] = value.join("=").trim();
  }
  return { at: Number(event.m_flCycle) || 0, concept: event.m_EventData.concept, criteria };
}

// The sequences of models, from their sequence data block (the glb has their animations, not
// how they play): Map(model => { game_idle: { looping: true, activities: ["ACT_DOTA_IDLE"],
// clip: "@game_idle", effects: [...] } }). `clip` is the animation the sequence plays (the glb's
// clips are named by the animations), given where it is not the sequence's own name; `effects`
// the particle effects its animations start and stop (animationEffect), by their cycle.
async function readSequences(files) {
  const found = new Map();
  const blocks = readBlocks(files, "ASEQ");
  const events = await readAnimationEvents(path.join(temp, "models-in"));
  for (const [file, list] of blocks) {
    const sequences = {};
    const animations = events.get(file) ?? {};
    for (const data of list) {
      const names = data?.m_localSequenceNameArray ?? [];
      for (const sequence of data?.m_localS1SeqDescArray ?? []) {
        if (!sequence?.m_sName) continue;
        const activities = (sequence.m_activityArray ?? []).map((activity) => activity?.m_name).filter(Boolean);
        const clips = [...new Set((sequence.m_fetch?.m_localReferenceArray ?? []).map((index) => names[index]).filter(Boolean))];
        const clip = clips[0];
        const effects = clips
          .flatMap((name) => (animations[name] ?? []).map(animationEffect))
          .filter(Boolean)
          .filter((effect, index, all) => all.findIndex((other) => JSON.stringify(other) === JSON.stringify(effect)) === index)
          .sort((a, b) => a.at - b.at);
        const speech = clips.flatMap((name) => (animations[name] ?? []).map(animationSpeech)).filter(Boolean).sort((a, b) => a.at - b.at);
        sequences[sequence.m_sName] = {
          looping: Boolean(sequence.m_flags?.m_bLooping),
          ...(activities.length && { activities }),
          ...(clip && clip !== sequence.m_sName && { clip }),
          ...(effects.length && { effects }),
          ...(speech.length && { speech }),
        };
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

// Each sheet's frames as the game draws them, from Source2Viewer's print of the textures' DATA:
// Map(texture => { width, height, frames: Map("s.f" => { cropped, cell }) }), uv rectangles
// [x0, y0, x1, y1]. The game draws a frame's whole cell (cell), the picture (cropped) at its
// place in it with clear space round; the exported frame images are the cropped part alone.
function readSheetCells(input) {
  const result = spawnSync(DECOMPILER, ["-i", input, "--recursive", "-b", "DATA"], { encoding: "utf8", maxBuffer: 2048 * 1024 * 1024 });
  if (result.error) {
    throw result.error;
  }
  const sheets = new Map();
  const rect = (text) => text.match(/-?[\d.]+/g).map(Number);
  // "[3/100] <file>" starts each file, its path under the input folder
  for (const chunk of result.stdout.split(/(?:^|\n)\[\d+\/\d+\] /).slice(1)) {
    const file = chunk.slice(0, chunk.indexOf("\n")).trim();
    const name = path.relative(input, path.resolve(input, file)).replace(/_c$/, "").toLowerCase().split(path.sep).join("/");
    const width = Number(chunk.match(/\bWidth\s*=\s*(\d+)/)?.[1]);
    const height = Number(chunk.match(/\bHeight\s*=\s*(\d+)/)?.[1]);
    const frames = new Map();
    for (const match of chunk.matchAll(/\[(\d+)\.(\d+)\.0\] uvCropped\s*=\s*(\{[^}]*\})\s*\n\s*\[\1\.\2\.0\] uvUncropped\s*=\s*(\{[^}]*\})/g)) {
      frames.set(`${match[1]}.${match[2]}`, { cropped: rect(match[3]), cell: rect(match[4]) });
    }
    if (width && height && frames.size) sheets.set(name, { width, height, frames });
  }
  return sheets;
}

// A texture as one image: its own, or its frames laid in a grid; and its sheet in pixels:
// { width, height, sequences: [{ frames: [[x, y, w, h, duration]], loop }] }
async function buildTexture(out, texture, dist, cells) {
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
  // Frames are packed at their own sizes, which differ within a sheet (a fire's first frame is a
  // spark of 15x22, its flames up to 103x110); all of them were squeezed to the first one's.
  // Rows of frames by height, a gap between them so the smaller mips do not bleed into neighbours.
  const files = [...new Set(frames.map((frame) => frame.file))];
  const sizes = new Map();
  // Each frame in its whole cell where the texture says where it lies in it (<name>_seq<s>_<f>.png)
  const images = new Map();
  for (const file of files) {
    const meta = await sharp(path.join(folder, file)).metadata();
    const place = cells?.frames.get(file.match(/_seq(\d+)_(\d+)\.\w+$/)?.slice(1, 3).join("."));
    if (place) {
      const [cx0, cy0, cx1, cy1] = place.cropped;
      const [ux0, uy0, ux1, uy1] = place.cell;
      const cellWidth = Math.max(1, Math.round((ux1 - ux0) * cells.width));
      const cellHeight = Math.max(1, Math.round((uy1 - uy0) * cells.height));
      const left = Math.min(Math.max(Math.round((cx0 - ux0) * cells.width), 0), cellWidth - 1);
      const top = Math.min(Math.max(Math.round((cy0 - uy0) * cells.height), 0), cellHeight - 1);
      const w = Math.min(Math.max(1, Math.round((cx1 - cx0) * cells.width)), cellWidth - left);
      const h = Math.min(Math.max(1, Math.round((cy1 - cy0) * cells.height)), cellHeight - top);
      const picture = await sharp(path.join(folder, file)).resize(w, h, { fit: "fill" }).png().toBuffer();
      images.set(
        file,
        await sharp({ create: { width: cellWidth, height: cellHeight, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
          .composite([{ input: picture, left, top }])
          .png()
          .toBuffer()
      );
      sizes.set(file, [cellWidth, cellHeight]);
    } else {
      sizes.set(file, [meta.width, meta.height]);
    }
  }
  const GAP = 2;
  const area = files.reduce((sum, file) => sum + (sizes.get(file)[0] + GAP) * (sizes.get(file)[1] + GAP), 0);
  const widest = Math.max(...files.map((file) => sizes.get(file)[0] + GAP));
  const pack = (scale) => {
    const rowWidth = Math.max(Math.ceil(widest * scale), Math.ceil(Math.sqrt(area) * scale * 1.1));
    const spots = new Map();
    let x = 0;
    let y = 0;
    let rowHeight = 0;
    let width = 0;
    for (const file of files.slice().sort((a, b) => sizes.get(b)[1] - sizes.get(a)[1])) {
      const w = Math.max(1, Math.round(sizes.get(file)[0] * scale));
      const h = Math.max(1, Math.round(sizes.get(file)[1] * scale));
      if (x > 0 && x + w > rowWidth) {
        x = 0;
        y += rowHeight + GAP;
        rowHeight = 0;
      }
      spots.set(file, [x, y, w, h]);
      x += w + GAP;
      rowHeight = Math.max(rowHeight, h);
      width = Math.max(width, x - GAP);
    }
    return { spots, width, height: y + rowHeight };
  };
  let packed = pack(1);
  for (let scale = 0.9; Math.max(packed.width, packed.height) > MAX_ATLAS; scale *= 0.9) packed = pack(scale);
  const { spots: placed, width, height } = packed;
  const composites = [];
  for (const file of files) {
    const [x, y, w, h] = placed.get(file);
    const [ow, oh] = sizes.get(file);
    const source = images.get(file) ?? path.join(folder, file);
    const input = ow === w && oh === h ? source : await sharp(source).resize(w, h, { fit: "fill" }).png().toBuffer();
    composites.push({ input, left: x, top: y });
  }
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
    console.error('Usage: HF_TOKEN=... node exporters/particles.js --game "<...>/dota 2 beta/game/dota" | <STEAM USERNAME> <STEAM PASSWORD> [--no-upload]');
    process.exit(1);
  }
  fs.rmSync(temp, { recursive: true, force: true });
  fs.mkdirSync(temp, { recursive: true });
  const source = await openSource(game, username, password);
  const { vpkDir } = source;
  // The particle files to dota2-particles, what belongs to a model (sequences, attachments) next to
  // the model in the models dataset
  const repo = upload ? await hf.prepareRepo(accessToken, process.env.HF_REPO) : null;
  const particlesRepo = upload ? await hf.prepareRepo(accessToken, process.env.HF_PARTICLES_REPO || "dota2-particles") : null;
  const dist = path.join(temp, "dist");

  // --force: everything again, as on the first run
  const state = fs.existsSync(STATE_FILE) && !process.argv.includes("--force") ? JSON.parse(fs.readFileSync(STATE_FILE, "utf8")) : { systems: {}, textures: {} };
  const crcOf = (file) => vpkDir.tree[`${file}_c`]?.crc;

  // Every system reachable from the items', converted where it changed; an unchanged one's
  // references come from the state without reading it
  const reached = new Set();
  const itemRoots = await rootSystems(source);
  const portraits = await portraitSystems(source);
  const effectsOfModels = await modelEffects(source);
  const { found: effectsOfMaps, cameras: camerasOfMaps } = await mapEffects(source);
  const started = [...Object.values(effectsOfModels), ...Object.values(effectsOfMaps)].flatMap((effects) => effects.map((effect) => effect.system));
  const uploads = [];

  // How each model plays its sequences (looping, activities, the animation each plays, the
  // particle effects its animations start: Void Spirit's portal on his loadout spawn), for every
  // exported model and every model particles draw; what those animations start is shown too.
  // state.sequenceEffects keeps each model's systems, so an unchanged model is not read again.
  const exported = fs.existsSync("state/models.json") ? Object.keys(JSON.parse(fs.readFileSync("state/models.json", "utf8")).models ?? {}) : [];
  if (state.sequenceFormat !== SEQUENCE_FORMAT) {
    state.sequences = {};
    state.sequenceEffects = {};
    state.sequenceFormat = SEQUENCE_FORMAT;
  }
  state.sequenceEffects ??= {};
  const exportSequences = async (list) => {
    const todo = [...new Set(list)].filter((model) => crcOf(model) !== undefined && state.sequences[model] !== crcOf(model));
    console.log(`${todo.length} models with new or changed sequences`);
    for (let i = 0; i < todo.length; i += MODEL_BATCH) {
      const batch = todo.slice(i, i + MODEL_BATCH);
      const files = new Map();
      await source.readFiles(batch.map((model) => `${model}_c`), files);
      source.release();
      const found = await readSequences(files);
      for (const [model, sequences] of found) {
        const json = path.join(dist, model.replace(/\.vmdl$/, ".sequences.json"));
        fs.mkdirSync(path.dirname(json), { recursive: true });
        fs.writeFileSync(json, JSON.stringify(sequences));
        uploads.push({ path: model.replace(/\.vmdl$/, ".sequences.json"), file: json });
      }
      for (const model of batch) {
        state.sequences[model] = crcOf(model);
        const systems = [...new Set(Object.values(found.get(model) ?? {}).flatMap((sequence) => (sequence.effects ?? []).filter((effect) => !effect.stop).map((effect) => effect.system)))];
        if (systems.length) {
          state.sequenceEffects[model] = systems;
        } else {
          delete state.sequenceEffects[model];
        }
      }
      process.stdout.write(`\r${Math.min(i + MODEL_BATCH, todo.length)}/${todo.length} models' sequences read`);
    }
    if (todo.length) console.log();
  };
  const knownParticleModels = fs.existsSync(MODELS_FILE) ? JSON.parse(fs.readFileSync(MODELS_FILE, "utf8")) : [];
  await exportSequences([...exported, ...knownParticleModels]);
  const animated = [...new Set(Object.values(state.sequenceEffects).flat())];

  const roots = [...new Set([...itemRoots, ...portraits, ...started, ...animated])];
  console.log(`${itemRoots.length} particle systems shown by items, ${roots.length - itemRoots.length} more shown on the heroes' pages, started by the pedestals, the page maps and the models' animations`);
  // Then every other particle system of the game (abilities, units, buildings, maps, the interface,
  // events), so the dataset holds them all; bundles stay for the effects above, which the site
  // starts whole
  const everySystem = vpkDir.files.filter((file) => file.endsWith(".vpcf_c")).map((file) => file.slice(0, -2));
  let frontier = [...roots, ...everySystem];
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
  // With the ones the game draws where a renderer's layer names no texture
  const textures = [...new Set([...[...reached].flatMap((file) => state.systems[file]?.textures ?? []), ...DEFAULT_TEXTURES])].filter((texture) => crcOf(texture) !== undefined);
  if (state.textureVersion !== TEXTURE_VERSION) {
    state.textures = {};
  }
  const textureTodo = textures.filter((texture) => state.textures[texture] !== crcOf(texture));
  console.log(`${textures.length} textures, ${textureTodo.length} new or changed`);
  for (let i = 0; i < textureTodo.length; i += BATCH) {
    const batch = textureTodo.slice(i, i + BATCH);
    const files = new Map();
    await source.readFiles(batch.map((file) => `${file}_c`), files);
    const out = convert(files, "textures");
    const cells = readSheetCells(path.join(temp, "textures-in"));
    source.release();
    for (const texture of batch) {
      const built = await buildTexture(out, texture, dist, cells.get(texture.toLowerCase())).catch((error) => {
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

  state.textureVersion = TEXTURE_VERSION;

  // The snapshots they place particles by: each stream's values by its name
  state.snapshots ??= {};
  const snapshotFiles = [...new Set([...[...reached].flatMap((file) => state.systems[file]?.snapshots ?? []), ...(await itemSnapshots(source))])].filter((file) => crcOf(file) !== undefined);
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
  const modelEffectsFile = path.join(dist, "particles/model-effects.json");
  fs.mkdirSync(path.dirname(modelEffectsFile), { recursive: true });
  fs.writeFileSync(modelEffectsFile, JSON.stringify(effectsOfModels));
  uploads.push({ path: "particles/model-effects.json", file: modelEffectsFile });
  const mapEffectsFile = path.join(dist, "particles/map-effects.json");
  fs.writeFileSync(mapEffectsFile, JSON.stringify(effectsOfMaps));
  uploads.push({ path: "particles/map-effects.json", file: mapEffectsFile });
  const mapCamerasFile = path.join(dist, "particles/map-cameras.json");
  fs.writeFileSync(mapCamerasFile, JSON.stringify(camerasOfMaps));
  uploads.push({ path: "particles/map-cameras.json", file: mapCamerasFile });

  const coverage = path.join(dist, "particles/coverage.json");
  fs.mkdirSync(path.dirname(coverage), { recursive: true });
  fs.writeFileSync(coverage, JSON.stringify({ systems: reached.size, classes: Object.fromEntries(Object.entries(classes).sort((a, b) => b[1] - a[1])) }));
  uploads.push({ path: "particles/coverage.json", file: coverage });

  // The engine's defaults for what the files leave out, uploaded when the dump has changed
  const schemaFile = path.join(dist, "particles/schema.json");
  const schema = exportSchema(schemaFile, path.join(temp, "schema-dump"));
  if (schema) {
    const schemaKey = crypto.createHash("sha1").update(fs.readFileSync(schemaFile)).digest("hex");
    console.log(`Particle schema: ${Object.keys(schema.classes).length} classes, build ${schema.source.build}${state.schema === schemaKey ? ", unchanged" : ""}`);
    if (state.schema !== schemaKey) {
      uploads.push({ path: "particles/schema.json", file: schemaFile });
      state.schema = schemaKey;
    }
  }

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
  // The sequences of models particles draw that were not listed before (their animations'
  // effects are shown from the next run)
  await exportSequences(models);

  const attachedList = path.join(dist, "particles/attached-models.json");
  fs.writeFileSync(attachedList, JSON.stringify(Object.keys(state.attached).sort().map((model) => model.replace(/\.vmdl$/, ".attachments.json"))));
  uploads.push({ path: "particles/attached-models.json", file: attachedList });

  if (upload) {
    // A model's own files go next to the model, also for the models the game keeps under particles/
    const particleFile = (entry) => entry.path.startsWith("particles/") && !/\.(sequences|attachments)\.json$/.test(entry.path);
    await hf.upload(particlesRepo, accessToken, uploads.filter(particleFile), "Update particles");
    await hf.upload(repo, accessToken, uploads.filter((entry) => !particleFile(entry)), "Update the models' sequences and attachments");
    fs.writeFileSync(STATE_FILE, JSON.stringify(state));
  } else {
    console.log(`${uploads.length} files written to ${dist}`);
  }
}

if (require.main === module) {
  main().then(
    () => process.exit(0),
    (error) => {
      console.error(error);
      process.exit(1);
    }
  );
}

module.exports = { buildTexture, readSheetCells, readSequences, main };
