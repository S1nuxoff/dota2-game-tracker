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
const { summonsOf, UNITS_FILE } = require("./summons");
const { loadItemsGame } = require("./itemsgame");

const temp = "./temp/data";
const DECOMPILER = path.resolve("vrf", process.platform === "win32" ? "Source2Viewer-CLI.exe" : "Source2Viewer-CLI");
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
  // The same for the Armory's scene (#CollectionSceneBody)
  "panorama/images/masks/hero_model_preview_mask_psd",
  // The rock texture of the dashboard's bottom left panel (#FriendlistBottom)
  "panorama/images/textures/miniprofile_rock_darker_psd",
  // The interface's vector icons (the hero page's full screen button), kept as SVG
  "panorama/images/control_icons/24px/",
  // The CUSTOMIZE picker's cards (DOTAEconItemAnimated): each hero's card background
  // (collection_shared's .HeroBackgroundImage), the mask a set's portrait fades through at the
  // bottom, the corner of the equipped card and the "In Treasure" button's chest
  "materials/portraits_card/portrait_backgrounds/",
  "panorama/images/masks/set_thumbnail_mask_psd",
  "panorama/images/status_icons/econtooltip_equipped",
  "panorama/images/icon_treasure_button_png",
  // The settings window (popup_settings_reborn): the navigation's rock texture, the mask its list
  // scrolls through, the search box's clear button, the courier shown when nothing is found, and
  // the drop-downs' arrow
  "panorama/images/settings/settings_rock_texture_png",
  "panorama/images/masks/soft_top_bottom_vscroll_psd",
  "panorama/images/control_icons/x_close_filled_png",
  "panorama/images/hud/icon_courier_dead_settings_png",
  "panorama/images/control_icons/arrow_dropdown_png",
  // The Items page (dashboard_page_game_items, ability_details, ui_game_item_table,
  // ui_game_neutral_item_table, shop_item_combines): the details panel's and the tooltip's grounds,
  // the description's Active / Passive / Use headers, the gold, cooldown, mana, health and cast
  // range icons, the shops' icons, the Secret Shop keeper behind the basics, the tier clock, the
  // secret shop mark on a tile and the combines' recessed ground
  "panorama/images/hud/reborn/bg_tooltip_no_bevel_psd",
  "panorama/images/hud/ability_tooltip_psd",
  "panorama/images/hud/item_tooltip_",
  "panorama/images/hud/icon_gold_psd",
  "panorama/images/status_icons/ability_",
  "panorama/images/control_icons/shop_icon_",
  "panorama/images/textures/secret_shop_psd",
  "panorama/images/status_icons/clock_psd",
  "panorama/images/hud/secret_psd",
  "panorama/images/hud/reborn/bg_item_breakdown_recessed_psd",
  // The item tooltip's ground and its "More Details" Alt key
  "panorama/images/hud/reborn/bg_tooltip_psd",
  "panorama/images/control_icons/alt_key_png",
  // The Armory's emoticons (scripts/emoticons.txt names their pictures, strips of frames)
  "panorama/images/emoticons/",
  // The chat wheel's sprays (data/chat-wheel.json names them, from the audio export)
  "panorama/images/sprays/",
];
// The backdrops behind the hero page, 4K in the game, drawn blurred: kept as 1920 wide JPGs
const BACKGROUND_FOLDER = "panorama/images/loadout_backgrounds/";
const BACKGROUND_STYLES = "panorama/styles/hero_loadout_background_images.vcss_c";
// The picker cards' backgrounds per hero (.<hero> .HeroBackgroundImage)
const CARD_STYLES = "panorama/styles/collection_shared.vcss_c";
// Raised when the export gains something, so a game version already exported is exported again
const DATA_VERSION = 22;
const STATE_FILE = "data-state.json";
const SHOPS_FILE = "scripts/shops.txt";
// The emoticons: their ids, pictures, frame times and aliases (the Armory's Emoticons)
const EMOTICON_FILES = /^scripts\/emoticons(\.txt|\/[^/]+\.txt)$/;
// A loading screen item names its picture under panorama/images, the texture's name with or
// without its source format
const LOADING_SCREEN_SUFFIXES = ["", "_png", "_tga", "_psd", "_jpg"];
// The animated portraits the hero grid plays under the pointer; loose files of the depot, not in the VPK
const VIDEO_FOLDER = "panorama/videos/heroes/";
// The cursor packs (the Armory's Cursor Packs): loose BMPs of the depot, one folder a pack, with
// each cursor's hot spot in its cursor.res
const CURSOR_FOLDER = "resource/cursor/valve/";

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
  // --force: everything again, the images and videos too, as on the first run
  const state = fs.existsSync(STATE_FILE) && !force ? JSON.parse(fs.readFileSync(STATE_FILE, "utf8")) : { images: {} };
  if (!force && source.manifestId && state.manifest === source.manifestId && state.version === DATA_VERSION) {
    console.log(`Game data of manifest ${source.manifestId} is already exported.`);
    return;
  }
  const files = new Map();
  const wanted = source.vpkDir.files.filter(
    (file) =>
      file.startsWith("scripts/npc/") || file === SHOPS_FILE || EMOTICON_FILES.test(file) || /^resource\/localization\/(abilities|dota|hero_lore)_\w+\.txt$/.test(file)
  );
  await source.readFiles(wanted, files);
  const read = (file) => parse(files.get(file));

  const { heroes, heroAbilities } = readHeroes(read, files);
  const abilities = { ...omit(read("scripts/npc/npc_abilities.txt").root.DOTAAbilities, ["Version"]), ...heroAbilities };
  const items = omit(read("scripts/npc/items.txt").root.DOTAAbilities, ["Version"]);
  const neutralItems = read("scripts/npc/neutral_items.txt").root;
  const shops = readShops(files.get(SHOPS_FILE));
  const itemsGame = (await loadItemsGame(source)).items_game;
  const treasures = readTreasures(itemsGame);
  const loadingScreens = loadingScreenFiles(itemsGame, source.vpkDir);
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
    write("data/shops.json", shops),
    write("data/treasures.json", treasures),
    ...Object.entries(i18n).map(([language, tokens]) => write(`data/i18n/${language}.json`, tokens)),
    write("data/loadout_backgrounds.json", await readBackgrounds(source)),
    write("data/loadout_portraits.json", readPortraits(read, files, read(UNITS_FILE).root.DOTAUnits ?? {})),
    write("data/emoticons.json", readEmoticons(read, files)),
    // The Armory's pictures by item: a loading screen's full picture
    write("data/armory.json", { loadingScreens: Object.fromEntries(Object.entries(loadingScreens).map(([id, file]) => [id, pictureName(file)])) }),
    write("data/manifest.json", {
      manifest: source.manifestId,
      updated: new Date().toISOString(),
      languages: Object.keys(i18n).sort(),
    }),
  ];

  uploads.push(...(await portraitAtlas(source)));
  const images = await exportImages(source, state.images ?? {}, new Set(Object.values(loadingScreens)));
  console.log(`${images.files.length} new or changed portraits and icons`);
  const videos = await exportVideos(source, state.videos ?? {});
  console.log(`${videos.files.length} new or changed hero animations`);
  const cursors = await exportCursors(source);
  uploads.push(...cursors);
  console.log(`${cursors.length - 1} cursor pictures`);

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

// The shop's categories (scripts/shops.txt): { consumables: ["item_tpscroll", ...], ... }. Every
// item is an "item" key of its category, which the KeyValues reader would keep only the first of.
function readShops(buffer) {
  const shops = {};
  let category = null;
  const text = buffer.toString("utf8").replace(/\/\/[^\n]*/g, "");
  for (const [, key, value, open, close] of text.matchAll(/"([^"]*)"(?:\s*"([^"]*)")?|(\{)|(\})/g)) {
    if (open || close) {
      category = close ? null : category;
    } else if (value !== undefined && category) {
      shops[category].push(value);
    } else if (value === undefined && key !== "dota_shops") {
      category = key;
      shops[category] = [];
    }
  }
  return shops;
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

// Each loading screen item's picture in the VPK: { itemId: "panorama/images/....vtex_c" }
function loadingScreenFiles(itemsGame, vpkDir) {
  const files = {};
  for (const [id, item] of Object.entries(itemsGame.items)) {
    const visual = item.prefab === "loading_screen" && Object.values(item.visuals ?? {}).find((entry) => entry?.type === "loading_screen");
    if (!visual || typeof visual.asset !== "string") {
      continue;
    }
    const name = visual.asset.toLowerCase().replace(/\.(png|tga|psd|jpg|vtex)$/, "");
    const file = LOADING_SCREEN_SUFFIXES.map((suffix) => `panorama/images/${name}${suffix}.vtex_c`).find((candidate) => vpkDir.tree[candidate]);
    if (file) {
      files[id] = file;
    }
  }
  return files;
}

// Where a full picture is in the dataset: images/<its path under panorama/images>.webp
function pictureName(file) {
  return `images/${file.replace(/^panorama\/images\//, "").replace(/\.vtex_c$/, "")}.webp`;
}

// Every emoticon by its id (scripts/emoticons.txt and the event files in scripts/emoticons/):
// { id: { image: "images/emoticons/<name>.png", ms_per_frame, aliases: [...], ... } }
function readEmoticons(read, files) {
  const emoticons = {};
  for (const file of [...files.keys()].filter((name) => EMOTICON_FILES.test(name)).sort()) {
    for (const [id, entry] of Object.entries(read(file).root.emoticons ?? {})) {
      if (!entry || typeof entry !== "object" || typeof entry.image_name !== "string") {
        continue;
      }
      const { image_name: image, aliases, ...rest } = entry;
      emoticons[id] = {
        ...rest,
        image: `images/emoticons/${image.toLowerCase().replace(/\.(png|tga|psd)$/, "")}_png.png`,
        aliases: Object.values(aliases ?? {}),
      };
    }
  }
  return emoticons;
}

// Each chest names a loot list, which lists items by name or other lists (its tiers)
function readTreasures(itemsGame) {
  const { items, loot_lists: lists = {} } = itemsGame;
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
    const keep = kind === "dota" ? Object.entries(tokens).filter(([key]) => /^npc_dota_hero_|facet|herorole|^loadoutslot_/i.test(key)) : Object.entries(tokens);
    Object.assign((result[language] ??= {}), Object.fromEntries(keep));
  }
  return result;
}

// Each hero's page scene as the game sets it: the pedestal, the light, the camera of the page,
// of the set picker and of each slot. Positions in game units, angles in degrees.
// groundfog: the color the game puts in control point 1 of the pedestal's ground fog (and the dust
// it raises as it turns), 0 to 1. map: the page's map, whose effects particles/map-effects.json lists.
// summons: [{ unit, model, modelScale, position, angles, scale }], the units beside the hero.
// { npc_dota_hero_lion: { pedestal, light: { position, angles, color, scale, fov, distance }, ambient: { color, scale, direction }, shadow, groundfog, cameras: { default: { position, angles, fov } } } }
function readPortraits(read, files, units) {
  const file = "scripts/npc/portraits_full_body_loadout.txt";
  if (!files.has(file)) {
    return {};
  }
  const all = read(file).root.DOTAFullBodyLoadoutPortraitInfo ?? {};
  const vector = (value) => (value ?? "").trim().split(/\s+/).map(Number);
  const color = (value) => vector(value).map((channel) => channel / 255);
  const result = {};
  for (const [key, entry] of Object.entries(all)) {
    // A hero that flies (Lina, Batrider, Phoenix…) has no pedestal, but its light and cameras all the same
    if (typeof entry !== "object" || !(entry.PortraitBackgroundModel || entry.PortraitLightPosition)) {
      continue;
    }
    result[key] = {
      ...(entry.PortraitBackgroundModel ? { pedestal: entry.PortraitBackgroundModel.toLowerCase().replace(/\.vmdl$/, ".glb") } : {}),
      ...(entry.PortraitBackgroundMap ? { map: entry.PortraitBackgroundMap.toLowerCase() } : {}),
      light: {
        position: vector(entry.PortraitLightPosition),
        angles: vector(entry.PortraitLightAngles),
        color: color(entry.PortraitLightColor),
        scale: Number(entry.PortraitLightScale ?? 1),
        // The shadow's cone in degrees and its far plane (client.dll 0x181b358d0 makes the global
        // light's perspective shadow of them; defaults 15 and 250)
        ...(entry.PortraitLightFOV ? { fov: Number(entry.PortraitLightFOV) } : {}),
        ...(entry.PortraitLightDistance ? { distance: Number(entry.PortraitLightDistance) } : {}),
      },
      // direction: angles in degrees the second light points along
      ambient: {
        color: color(entry.PortraitAmbientColor),
        scale: Number(entry.PortraitAmbientScale ?? 1),
        ...(entry.PortraitAmbientDirection ? { direction: vector(entry.PortraitAmbientDirection) } : {}),
      },
      // The fill hero.vfx adds where the key light's shadow falls (cb2[6] color, cb2[6].w scale);
      // client.dll's defaults when a key is missing: 89 89 89, 1.5, 1.5
      shadow: {
        color: color(entry.PortraitShadowColor ?? "89 89 89"),
        scale: Number(entry.PortraitShadowScale ?? 1.5),
        ground: Number(entry.PortraitGroundShadowScale ?? 1.5),
      },
      ...(entry.GroundfogFXColor ? { groundfog: vector(entry.GroundfogFXColor) } : {}),
      // The units on the pedestal beside the hero (summons.js)
      ...(summonsOf(entry, units).length ? { summons: summonsOf(entry, units) } : {}),
      cameras: Object.fromEntries(
        // far: the camera's far plane (client.dll's default 1000), which bounds the sun's shadow
        // fitted to the view; shadowFar: PortraitShadowFarZ, its own bound when given
        Object.entries(entry.cameras ?? {}).map(([name, camera]) => [
          name,
          {
            position: vector(camera.PortraitPosition),
            angles: vector(camera.PortraitAngles),
            fov: Number(camera.PortraitFOV),
            far: Number(camera.PortraitFar ?? 1000),
            ...(Number(camera.PortraitShadowFarZ) > 0 ? { shadowFar: Number(camera.PortraitShadowFarZ) } : {}),
          },
        ])
      ),
    };
  }
  return result;
}

// A stylesheet of the game, decompiled to its CSS text
async function readStyles(source, file, name) {
  const files = new Map();
  await source.readFiles([file], files);
  const input = path.join(temp, "styles");
  fs.mkdirSync(input, { recursive: true });
  const compiled = path.join(input, `${name}.vcss_c`);
  fs.writeFileSync(compiled, files.get(file));
  const result = spawnSync(DECOMPILER, ["-i", compiled, "-o", input, "-d"], { encoding: "utf8" });
  if (result.error) {
    throw result.error;
  }
  return fs.readFileSync(path.join(input, `${name}.css`), "utf8");
}

// Which backdrop each hero's page has, its tint and the gradient under it, from the game's
// stylesheet, and the background of the hero's cards in the CUSTOMIZE picker:
// { mask, heroes: { lion: { image, wash, from, to } }, cards: { lion: image } }
async function readBackgrounds(source) {
  const css = await readStyles(source, BACKGROUND_STYLES, "backgrounds");

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
  // collection_shared: ".lion #HeroBackgroundImage, ..., .lion .HeroBackgroundImage { background-image }"
  const cards = {};
  const shared = await readStyles(source, CARD_STYLES, "collection_shared");
  for (const [, selectors, body] of shared.matchAll(/([^{}]+)\{([^}]*)\}/g)) {
    const url = body.match(/background-image:\s*url\("s2r:\/\/([^"]+)\.vtex"\)/)?.[1];
    const hero = selectors.split(",").map((selector) => selector.trim().match(/^\.(\w+)\s+\.HeroBackgroundImage$/)?.[1]).find((name) => name && !name.startsWith("npc_"));
    if (url && hero) {
      cards[hero] = `images/${url.replace(/^panorama\/images\//, "")}.png`;
    }
  }
  return { mask, heroes, cards };
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

// A BMP of 24 or 32 bits a pixel (the cursors) as raw RGBA for sharp; rows bottom up unless the
// height is negative
function readBmp(buffer) {
  const offset = buffer.readUInt32LE(10);
  const width = buffer.readInt32LE(18);
  const rawHeight = buffer.readInt32LE(22);
  const bits = buffer.readUInt16LE(28);
  const height = Math.abs(rawHeight);
  const bytes = bits / 8;
  const stride = Math.ceil((width * bytes) / 4) * 4;
  const pixels = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++) {
    const row = offset + (rawHeight > 0 ? height - 1 - y : y) * stride;
    for (let x = 0; x < width; x++) {
      const from = row + x * bytes;
      const to = (y * width + x) * 4;
      pixels[to] = buffer[from + 2];
      pixels[to + 1] = buffer[from + 1];
      pixels[to + 2] = buffer[from];
      pixels[to + 3] = bytes === 4 ? buffer[from + 3] : 255;
    }
  }
  return { pixels, width, height };
}

// Every cursor pack as PNGs (images/cursors/<pack>/<cursor>.png) and data/cursors.json
// { pack: { cursor: [hot x, hot y] } }; small enough to be written whole each run
async function exportCursors(source) {
  const entries = source.looseFiles(CURSOR_FOLDER);
  const packs = {};
  const files = [];
  const out = path.join(temp, "cursors");
  for (const entry of entries) {
    const [, pack, name] = entry.path.match(/^resource\/cursor\/valve\/([^/]+)\/([^/]+)\.(bmp|res)$/) ?? [];
    if (!pack) continue;
    packs[pack] ??= {};
    const buffer = await source.readLoose(entry);
    if (entry.path.endsWith(".res")) {
      for (const [cursor, spot] of Object.entries(parse(buffer).root["resource/cursor/cursor.res"] ?? {})) {
        packs[pack][cursor] = [Number(spot?.hotx) || 0, Number(spot?.hoty) || 0, ...(packs[pack][cursor]?.slice(2) ?? [])];
      }
      continue;
    }
    const { pixels, width, height } = readBmp(buffer);
    const file = path.join(out, pack, `${name}.png`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    await sharp(pixels, { raw: { width, height, channels: 4 } }).png().toFile(file);
    files.push({ path: `images/cursors/${pack}/${name}.png`, file });
    packs[pack][name] ??= [0, 0];
  }
  // Only the cursors that have a picture
  const pictures = new Set(files.map((entry) => entry.path));
  for (const [pack, cursors] of Object.entries(packs)) {
    for (const cursor of Object.keys(cursors)) {
      if (!pictures.has(`images/cursors/${pack}/${cursor}.png`)) delete cursors[cursor];
    }
  }
  const json = path.join(temp, "out/data/cursors.json");
  fs.mkdirSync(path.dirname(json), { recursive: true });
  fs.writeFileSync(json, JSON.stringify(packs));
  return [{ path: "data/cursors.json", file: json }, ...files];
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

// pictures: textures written as 1920 wide WebP (the loading screens' full pictures)
async function exportImages(source, known, pictures) {
  const { vpkDir } = source;
  const all = vpkDir.files.filter((file) => (/\.(vtex|vsvg)_c$/.test(file) && IMAGE_FOLDERS.some((folder) => file.startsWith(folder))) || pictures.has(file));
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
    if (file.endsWith(".vsvg_c")) {
      const svg = path.join(out, file.replace(/\.vsvg_c$/, ".svg"));
      if (fs.existsSync(svg)) {
        images.push({ path: `images/${file.replace(/^panorama\/images\//, "").replace(/\.vsvg_c$/, "")}.svg`, file: svg });
      }
      continue;
    }
    // Source2Viewer writes a texture made from a JPG as .jpeg, the others as .png
    const png = [".png", ".jpeg"].map((extension) => path.join(out, file.replace(/\.vtex_c$/, extension))).find((candidate) => fs.existsSync(candidate));
    if (!png) {
      continue;
    }
    const name = `images/${file.replace(/^panorama\/images\//, "").replace(/\.vtex_c$/, "")}`;
    if (pictures.has(file)) {
      const webp = png.replace(/\.(png|jpeg)$/, ".webp");
      await sharp(png).resize({ width: 1920, withoutEnlargement: true }).webp({ quality: 80 }).toFile(webp);
      images.push({ path: pictureName(file), file: webp });
    } else if (file.startsWith(BACKGROUND_FOLDER) && !/mask/.test(file)) {
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
