// Game data for Dotadex: heroes with their abilities, shared abilities and talents,
// shop and neutral items, treasure chests with what drops from them, the texts of
// all of this in every language, and hero portraits and icons.
//
//   HF_TOKEN=... node data.js --game "<...>/dota 2 beta/game/dota" [--no-upload] [--force]
//   HF_TOKEN=... node data.js <STEAM USERNAME> <STEAM PASSWORD>   (GitHub Actions)
//
// Uploads to the dataset: data/*.json, data/i18n/<language>.json, images/...png, videos/heroes/...webm.
// Nothing is done when the game did not update since the last run (data-state.json),
// and only new or changed images are converted again.
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const sharp = require("sharp");
const hf = require("./hf");
const { localSource, steamSource } = require("./source");
const { parse } = require("./keyvalues");

const temp = "./temp/data";
const DECOMPILER = path.resolve("vrf", process.platform === "win32" ? "Source2Viewer-CLI.exe" : "Source2Viewer-CLI");
const ITEMS_GAME_URL = "https://raw.githubusercontent.com/S1nuxoff/dota2-file-tracker/main/static/items_game.json";
const IMAGE_FOLDERS = [
  "panorama/images/heroes/",
  "panorama/images/spellicons/",
  "panorama/images/items/",
  "panorama/images/loadout_backgrounds/",
  // The interface's own pictures the site draws after the game: the top bar, the filter and role
  // icons, attributes, complexity, the stat icons
  "panorama/images/topbar/",
  "panorama/images/control_icons/filter_",
  "panorama/images/control_icons/arrow_solid_",
  "panorama/images/control_icons/gear_png",
  "panorama/images/control_icons/quit_psd",
  "panorama/images/primary_attribute_icons/",
  "panorama/images/hero_complexity_",
  "panorama/images/hud/reborn/icon_",
  // The mask the hero page's scene is seen through, fading its sides and floor into the dark
  "panorama/images/masks/hero_model_preview_mask_loadout_psd",
];
// The backdrops behind the hero page, 4K in the game, drawn blurred: kept as 1920 wide JPGs
const BACKGROUND_FOLDER = "panorama/images/loadout_backgrounds/";
const BACKGROUND_STYLES = "panorama/styles/hero_loadout_background_images.vcss_c";
// Raised when the export gains something, so a game version already exported is exported again
const DATA_VERSION = 9;
const STATE_FILE = "data-state.json";
// The animated portraits the hero grid plays under the pointer; loose files of the depot, not in the VPK
const VIDEO_FOLDER = "panorama/videos/heroes/";

function argValue(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

async function main() {
  const game = argValue("--game");
  const [username, password] = process.argv.slice(2).filter((arg, index, args) => !arg.startsWith("--") && args[index - 1] !== "--game");
  const upload = !process.argv.includes("--no-upload");
  const force = process.argv.includes("--force");
  if ((!game && !password) || (upload && !process.env.HF_TOKEN)) {
    console.error('Usage: HF_TOKEN=... node data.js --game "<...>/dota 2 beta/game/dota" | <STEAM USERNAME> <STEAM PASSWORD>');
    process.exit(1);
  }

  fs.rmSync(temp, { recursive: true, force: true });
  fs.mkdirSync(temp, { recursive: true });
  const source = game ? localSource(game) : await steamSource(username, password, temp);
  const state = fs.existsSync(STATE_FILE) ? JSON.parse(fs.readFileSync(STATE_FILE, "utf8")) : { images: {} };
  if (!force && source.manifestId && state.manifest === source.manifestId && state.version === DATA_VERSION) {
    console.log(`Game data of manifest ${source.manifestId} is already exported.`);
    return;
  }
  const files = new Map();
  const wanted = source.vpkDir.files.filter(
    (file) => file.startsWith("scripts/npc/") || /^resource\/localization\/(abilities|dota|hero_lore)_\w+\.txt$/.test(file)
  );
  await source.readFiles(wanted, files);
  const read = (file) => parse(files.get(file));

  const { heroes, heroAbilities } = readHeroes(read, files);
  const abilities = { ...omit(read("scripts/npc/npc_abilities.txt").root.DOTAAbilities, ["Version"]), ...heroAbilities };
  const items = omit(read("scripts/npc/items.txt").root.DOTAAbilities, ["Version"]);
  const neutralItems = read("scripts/npc/neutral_items.txt").root;
  const treasures = await readTreasures();
  const i18n = readTexts(read, files);

  console.log(
    `${Object.keys(heroes).length} heroes, ${Object.keys(abilities).length} abilities, ${Object.keys(items).length} items, ` +
      `${treasures.length} treasures, ${Object.keys(i18n).length} languages`
  );

  const out = path.join(temp, "out");
  const write = (name, value) => {
    const file = path.join(out, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(value));
    return { path: name, file };
  };
  const uploads = [
    write("data/heroes.json", heroes),
    write("data/abilities.json", abilities),
    write("data/items.json", items),
    write("data/neutral_items.json", neutralItems),
    write("data/treasures.json", treasures),
    ...Object.entries(i18n).map(([language, tokens]) => write(`data/i18n/${language}.json`, tokens)),
    write("data/loadout_backgrounds.json", await readBackgrounds(source)),
    write("data/loadout_portraits.json", readPortraits(read, files)),
    write("data/manifest.json", {
      manifest: source.manifestId,
      updated: new Date().toISOString(),
      languages: Object.keys(i18n).sort(),
    }),
  ];

  uploads.push(...(await portraitAtlas(source)));
  const images = await exportImages(source, state.images ?? {});
  console.log(`${images.files.length} new or changed portraits and icons`);
  const videos = await exportVideos(source, state.videos ?? {});
  console.log(`${videos.files.length} new or changed hero animations`);

  if (upload) {
    const repo = await hf.prepareRepo(process.env.HF_TOKEN, process.env.HF_REPO);
    await hf.upload(repo, process.env.HF_TOKEN, uploads, "Update game data");
    await hf.upload(repo, process.env.HF_TOKEN, images.files, "Update portraits and icons");
    await hf.upload(repo, process.env.HF_TOKEN, videos.files, "Update hero animations");
    fs.writeFileSync(STATE_FILE, JSON.stringify({ version: DATA_VERSION, manifest: source.manifestId, images: images.crcs, videos: videos.shas }));
  } else {
    console.log(`Written to ${out}`);
  }
}

function omit(object, keys) {
  return Object.fromEntries(Object.entries(object).filter(([key]) => !keys.includes(key)));
}

// Heroes inherit npc_dota_hero_base; each hero's file also defines its abilities
function readHeroes(read, files) {
  const main = read("scripts/npc/npc_heroes.txt");
  const base = main.root.DOTAHeroes?.npc_dota_hero_base ?? {};
  const heroes = {};
  const heroAbilities = {};

  for (const include of main.bases) {
    const file = `scripts/npc/${include}`;
    if (!files.has(file)) {
      continue;
    }
    for (const [key, hero] of Object.entries(read(file).root.DOTAHeroes ?? {})) {
      if (!key.startsWith("npc_dota_hero_") || key === "npc_dota_hero_base") {
        continue;
      }
      for (const [name, ability] of Object.entries(hero.AbilityDefinitions ?? {})) {
        heroAbilities[name] = { ...ability, Hero: key };
      }
      heroes[key] = { ...base, ...omit(hero, ["AbilityDefinitions"]) };
    }
  }
  return { heroes, heroAbilities };
}

// Each chest names a loot list, which lists items by name or other lists (its tiers)
async function readTreasures() {
  const data = fs.existsSync("items_game.json")
    ? JSON.parse(fs.readFileSync("items_game.json", "utf8"))
    : await (await fetch(ITEMS_GAME_URL)).json();
  const { items, loot_lists: lists = {} } = data.items_game;
  const idByName = new Map(Object.entries(items).map(([id, item]) => [item.name, id]));

  const itemsOf = (list, seen = new Set()) => {
    if (seen.has(list) || !lists[list]) {
      return [];
    }
    seen.add(list);
    return Object.keys(lists[list]).flatMap((entry) =>
      lists[entry] ? itemsOf(entry, seen) : idByName.has(entry) ? [idByName.get(entry)] : []
    );
  };

  const treasures = [];
  for (const [id, item] of Object.entries(items)) {
    // Usually { attribute_class, value }, in older chests just the name
    const attribute = item.static_attributes?.["treasure loot list"];
    const list = typeof attribute === "object" ? attribute?.value : attribute;
    if (!/treasure_chest/.test(item.prefab ?? "") || !list || !lists[list]) {
      continue;
    }
    // Lists inside the chest's list are its tiers; items directly in it are one tier
    const tiers = [];
    const direct = [];
    for (const entry of Object.keys(lists[list])) {
      if (lists[entry]) {
        tiers.push({ name: entry, items: [...new Set(itemsOf(entry))] });
      } else if (idByName.has(entry)) {
        direct.push(idByName.get(entry));
      }
    }
    if (direct.length) {
      tiers.unshift({ name: list, items: direct });
    }
    treasures.push({
      id,
      name: item.name,
      rarity: item.item_rarity,
      date: item.creation_date,
      icon: item.image_inventory,
      retired: item.prefab === "retired_treasure_chest",
      tiers: tiers.filter((tier) => tier.items.length > 0),
    });
  }
  return treasures;
}

// Texts per language: abilities and items, hero names, facets and lore
function readTexts(read, files) {
  const result = {};
  for (const file of files.keys()) {
    const match = file.match(/^resource\/localization\/(abilities|dota|hero_lore)_(\w+)\.txt$/);
    if (!match) {
      continue;
    }
    const [, kind, language] = match;
    const tokens = read(file).root.lang?.Tokens ?? {};
    const keep = kind === "dota" ? Object.entries(tokens).filter(([key]) => /^npc_dota_hero_|facet|herorole/i.test(key)) : Object.entries(tokens);
    Object.assign((result[language] ??= {}), Object.fromEntries(keep));
  }
  return result;
}

// Each hero's page scene as the game sets it: the pedestal, the light, the camera of the page,
// of the set picker and of each slot. Positions in game units, angles in degrees.
// groundfog: the color the game puts in control point 1 of the pedestal's ground fog (and the dust
// it raises as it turns), 0 to 1. map: the page's map, whose effects particles/map-effects.json lists.
// { npc_dota_hero_lion: { pedestal, light: { position, angles, color, scale }, ambient: { color, scale, direction }, shadow, groundfog, cameras: { default: { position, angles, fov } } } }
function readPortraits(read, files) {
  const file = "scripts/npc/portraits_full_body_loadout.txt";
  if (!files.has(file)) {
    return {};
  }
  const all = read(file).root.DOTAFullBodyLoadoutPortraitInfo ?? {};
  const vector = (value) => (value ?? "").trim().split(/\s+/).map(Number);
  const color = (value) => vector(value).map((channel) => channel / 255);
  const result = {};
  for (const [key, entry] of Object.entries(all)) {
    if (typeof entry !== "object" || !entry.PortraitBackgroundModel) {
      continue;
    }
    result[key] = {
      pedestal: entry.PortraitBackgroundModel.toLowerCase().replace(/\.vmdl$/, ".glb"),
      ...(entry.PortraitBackgroundMap ? { map: entry.PortraitBackgroundMap.toLowerCase() } : {}),
      light: {
        position: vector(entry.PortraitLightPosition),
        angles: vector(entry.PortraitLightAngles),
        color: color(entry.PortraitLightColor),
        scale: Number(entry.PortraitLightScale ?? 1),
      },
      // direction: angles in degrees the second light points along
      ambient: {
        color: color(entry.PortraitAmbientColor),
        scale: Number(entry.PortraitAmbientScale ?? 1),
        ...(entry.PortraitAmbientDirection ? { direction: vector(entry.PortraitAmbientDirection) } : {}),
      },
      shadow: { color: color(entry.PortraitShadowColor), ground: Number(entry.PortraitGroundShadowScale ?? 1) },
      ...(entry.GroundfogFXColor ? { groundfog: vector(entry.GroundfogFXColor) } : {}),
      cameras: Object.fromEntries(
        Object.entries(entry.cameras ?? {}).map(([name, camera]) => [
          name,
          { position: vector(camera.PortraitPosition), angles: vector(camera.PortraitAngles), fov: Number(camera.PortraitFOV) },
        ])
      ),
    };
  }
  return result;
}

// Which backdrop each hero's page has, its tint and the gradient under it, from the game's
// stylesheet: { mask, heroes: { lion: { image, wash, from, to } } }
async function readBackgrounds(source) {
  const files = new Map();
  await source.readFiles([BACKGROUND_STYLES], files);
  const input = path.join(temp, "styles");
  fs.mkdirSync(input, { recursive: true });
  const compiled = path.join(input, "backgrounds.vcss_c");
  fs.writeFileSync(compiled, files.get(BACKGROUND_STYLES));
  const result = spawnSync(DECOMPILER, ["-i", compiled, "-o", input, "-d"], { encoding: "utf8" });
  if (result.error) {
    throw result.error;
  }
  const css = fs.readFileSync(path.join(input, "backgrounds.css"), "utf8");

  const defines = Object.fromEntries([...css.matchAll(/@define\s+(\w+):\s*(#[0-9a-f]+);/gi)].map((match) => [match[1], match[2]]));
  const color = (value) => {
    const [name, alpha] = value.trim().split("&");
    const hex = defines[name] ?? name;
    return alpha ? hex + alpha : hex;
  };
  const image = (url) => `images/${url.replace(/^s2r:\/\/panorama\/images\//, "").replace(/\.vtex$/, "")}${/mask/.test(url) ? ".png" : ".jpg"}`;
  const heroes = {};
  let mask = null;
  for (const [, selectors, body] of css.matchAll(/([^{}]+)\{([^}]*)\}/g)) {
    const url = body.match(/background-image:\s*url\("([^"]+)"\)/)?.[1];
    const wash = body.match(/wash-color:\s*([^;]+);/)?.[1];
    const gradient = body.match(/from\(\s*(#[0-9a-f]+)\s*\),\s*to\(\s*(#[0-9a-f]+)\s*\)/i);
    const opacityMask = body.match(/opacity-mask:\s*url\("([^"]+)"\)/)?.[1];
    if (opacityMask && !mask) {
      mask = image(opacityMask);
    }
    for (const selector of selectors.split(",")) {
      const hero = selector.trim().match(/^\.(\w+)\s+#HeroLoadoutBackgroundImageContainer(\s+#HeroLoadoutBackgroundImage)?$/);
      if (!hero) {
        continue;
      }
      const entry = (heroes[hero[1]] ??= {});
      if (hero[2] && url) {
        entry.image = image(url);
      }
      if (hero[2] && wash) {
        entry.wash = color(wash);
      }
      if (!hero[2] && gradient) {
        entry.from = gradient[1];
        entry.to = gradient[2];
      }
    }
  }
  return { mask, heroes };
}

// The heroes' animated portraits as they are, .webm; only those whose content changed
async function exportVideos(source, known) {
  const all = source.looseFiles(VIDEO_FOLDER).filter((entry) => entry.path.endsWith(".webm"));
  const shas = Object.fromEntries(all.map((entry) => [entry.path, entry.sha]));
  const files = [];
  const out = path.join(temp, "videos");
  for (const entry of all.filter((entry) => known[entry.path] !== entry.sha)) {
    const file = path.join(out, path.basename(entry.path));
    fs.mkdirSync(out, { recursive: true });
    fs.writeFileSync(file, await source.readLoose(entry));
    files.push({ path: `videos/heroes/${path.basename(entry.path)}`, file });
  }
  return { files, shas };
}

// Portraits, hero icons, ability and item icons as PNGs; only those whose CRC changed
// Every hero's tall portrait of the hero grid in one image, so the grid loads in one request:
// images/heroes/selection_atlas.webp and .json { "<hero>": [x, y, width, height], width, height }
async function portraitAtlas(source) {
  const pattern = /^panorama\/images\/heroes\/selection\/npc_dota_hero_(\w+)_png\.vtex_c$/;
  const wanted = source.vpkDir.files.filter((file) => pattern.test(file));
  if (wanted.length === 0) {
    return [];
  }
  const files = new Map();
  await source.readFiles(wanted, files);
  const input = path.join(temp, "portraits");
  const out = path.join(temp, "portraits-out");
  for (const [file, buffer] of files) {
    fs.mkdirSync(path.dirname(path.join(input, file)), { recursive: true });
    fs.writeFileSync(path.join(input, file), buffer);
  }
  const result = spawnSync(DECOMPILER, ["-i", input, "--recursive", "-o", out, "-d", "--threads", "8"], { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
  if (result.error) {
    throw result.error;
  }
  const portraits = wanted
    .map((file) => [file.match(pattern)[1], path.join(out, file.replace(/\.vtex_c$/, ".png"))])
    .filter(([, png]) => fs.existsSync(png))
    .sort(([a], [b]) => a.localeCompare(b));
  if (portraits.length === 0) {
    return [];
  }
  const { width: cellWidth, height: cellHeight } = await sharp(portraits[0][1]).metadata();
  const columns = Math.ceil(Math.sqrt(portraits.length * (cellHeight / cellWidth)));
  const rows = Math.ceil(portraits.length / columns);
  const sheet = { width: columns * cellWidth, height: rows * cellHeight };
  const composites = [];
  for (const [index, [hero, png]] of portraits.entries()) {
    const left = (index % columns) * cellWidth;
    const top = Math.floor(index / columns) * cellHeight;
    sheet[hero] = [left, top, cellWidth, cellHeight];
    composites.push({ input: await sharp(png).resize(cellWidth, cellHeight, { fit: "fill" }).toBuffer(), left, top });
  }
  const image = path.join(temp, "out/images/heroes/selection_atlas.webp");
  fs.mkdirSync(path.dirname(image), { recursive: true });
  await sharp({ create: { width: sheet.width, height: sheet.height, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
    .composite(composites)
    .webp({ quality: 90 })
    .toFile(image);
  const json = image.replace(/\.webp$/, ".json");
  fs.writeFileSync(json, JSON.stringify(sheet));
  console.log(`Hero grid portraits: ${portraits.length} in one atlas`);
  return [
    { path: "images/heroes/selection_atlas.webp", file: image },
    { path: "images/heroes/selection_atlas.json", file: json },
  ];
}

async function exportImages(source, known) {
  const { vpkDir } = source;
  const all = vpkDir.files.filter((file) => file.endsWith(".vtex_c") && IMAGE_FOLDERS.some((folder) => file.startsWith(folder)));
  const crcs = Object.fromEntries(all.map((file) => [file, vpkDir.tree[file].crc]));
  const changed = all.filter((file) => known[file] !== crcs[file]);
  if (changed.length === 0) {
    return { files: [], crcs };
  }

  const files = new Map();
  await source.readFiles(changed, files);
  const input = path.join(temp, "vtex");
  for (const [file, buffer] of files) {
    fs.mkdirSync(path.dirname(path.join(input, file)), { recursive: true });
    fs.writeFileSync(path.join(input, file), buffer);
  }
  const out = path.join(temp, "images");
  const result = spawnSync(DECOMPILER, ["-i", input, "--recursive", "-o", out, "-d", "--threads", "8"], {
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
  });
  if (result.error) {
    throw result.error;
  }

  const images = [];
  for (const file of changed) {
    // Source2Viewer writes a texture made from a JPG as .jpeg, the others as .png
    const png = [".png", ".jpeg"].map((extension) => path.join(out, file.replace(/\.vtex_c$/, extension))).find((candidate) => fs.existsSync(candidate));
    if (!png) {
      continue;
    }
    const name = `images/${file.replace(/^panorama\/images\//, "").replace(/\.vtex_c$/, "")}`;
    if (file.startsWith(BACKGROUND_FOLDER) && !/mask/.test(file)) {
      const jpg = png.replace(/\.(png|jpeg)$/, ".jpg");
      await sharp(png).resize({ width: 1920, withoutEnlargement: true }).jpeg({ quality: 82, mozjpeg: true }).toFile(jpg);
      images.push({ path: `${name}.jpg`, file: jpg });
    } else {
      images.push({ path: `${name}.png`, file: png });
    }
  }
  return { files: images, crcs };
}

main().then(
  () => process.exit(0),
  (error) => {
    console.error(error);
    process.exit(1);
  }
);
