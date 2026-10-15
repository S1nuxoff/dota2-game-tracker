// Game data for Dotadex: heroes with their abilities, shared abilities and talents,
// shop and neutral items, treasure chests with what drops from them, the texts of
// all of this in every language, and hero portraits and icons.
//
//   HF_TOKEN=... node data.js --game "<...>/dota 2 beta/game/dota" [--no-upload]
//
// Uploads to the dataset: data/*.json, data/i18n/<language>.json, images/...png
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const hf = require("./hf");
const { localSource } = require("./source");
const { parse } = require("./keyvalues");

const temp = "./temp/data";
const DECOMPILER = path.resolve("vrf", process.platform === "win32" ? "Source2Viewer-CLI.exe" : "Source2Viewer-CLI");
const ITEMS_GAME_URL = "https://raw.githubusercontent.com/S1nuxoff/dota2-file-tracker/main/static/items_game.json";
const IMAGE_FOLDERS = ["panorama/images/heroes/", "panorama/images/spellicons/", "panorama/images/items/"];

function argValue(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

async function main() {
  const game = argValue("--game");
  const upload = !process.argv.includes("--no-upload");
  if (!game || (upload && !process.env.HF_TOKEN)) {
    console.error('Usage: HF_TOKEN=... node data.js --game "<...>/dota 2 beta/game/dota" [--no-upload]');
    process.exit(1);
  }

  fs.rmSync(temp, { recursive: true, force: true });
  fs.mkdirSync(temp, { recursive: true });
  const source = localSource(game);
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
    write("data/manifest.json", {
      manifest: source.manifestId,
      updated: new Date().toISOString(),
      languages: Object.keys(i18n).sort(),
    }),
  ];

  const images = exportImages(path.join(game, "pak01_dir.vpk"));
  console.log(`${images.length} portraits and icons`);

  if (upload) {
    const repo = await hf.prepareRepo(process.env.HF_TOKEN, process.env.HF_REPO);
    await hf.upload(repo, process.env.HF_TOKEN, uploads, "Update game data");
    await hf.upload(repo, process.env.HF_TOKEN, images, "Update portraits and icons");
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

// Portraits, hero icons, ability and item icons as PNGs, converted from the install
function exportImages(vpkPath) {
  const out = path.join(temp, "images");
  const result = spawnSync(
    DECOMPILER,
    ["-i", vpkPath, "-f", IMAGE_FOLDERS.join(","), "-e", "vtex_c", "-o", out, "-d", "--threads", "8"],
    { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 }
  );
  if (result.error) {
    throw result.error;
  }
  const images = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.name.endsWith(".png")) {
        images.push({ path: `images/${path.relative(out, full).split(path.sep).join("/").replace(/^panorama\/images\//, "")}`, file: full });
      }
    }
  };
  if (fs.existsSync(out)) {
    walk(out);
  }
  return images;
}

main().then(
  () => process.exit(0),
  (error) => {
    console.error(error);
    process.exit(1);
  }
);
