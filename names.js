// The names people know for the datasets' files, from the game's English texts: names.json at the
// root of dota2-images and dota2-models, { "<path in the dataset>": [name, kind] }, kind one of
// hero, cosmetic, ability, item, unit. What has no name in the game (props, interface pictures) is
// left out. A page that lists a dataset (files.json) shows these instead of the paths.
//   heroes      heroes/, heroes/selection/, heroes/icons/ portraits (alternate looks too) and models
//   cosmetics   items_game: each item's inventory picture and the models it shows (model_player
//               and its visuals' model swaps), by its item_name
//   abilities   spellicons/: by DOTA_Tooltip_ability_<name>, through each ability's AbilityTextureName
//               (npc_abilities.txt and each hero's AbilityDefinitions)
//   items       items/: the shop's items, by DOTA_Tooltip_Ability_item_<name>
//   units       scripts/npc/npc_units.txt: each unit's model, by its name
// Runs only when the game changed (names-state.json).
//
//   HF_TOKEN=... node names.js --game "<...>/dota 2 beta/game/dota" [--no-upload] [--force]
//   HF_TOKEN=... node names.js <STEAM USERNAME> <STEAM PASSWORD>   (GitHub Actions)
const fs = require("fs");
const path = require("path");
const hf = require("./hf");
const { localSource, steamSource } = require("./source");
const { parse } = require("./keyvalues");
const { loadItemsGame } = require("./itemsgame");

const temp = "./temp/names";
const STATE_FILE = "names-state.json";
// Raised when the names written change, so a game version already done is done again
const VERSION = 1;
const LOCALIZATION = /^resource\/localization\/(items|dota|abilities)_english\.txt$/;
const HERO_FILES = /^scripts\/npc\/(npc_heroes\.txt|heroes\/npc_dota_hero_\w+\.txt)$/;
const ABILITY_FILES = /^scripts\/npc\/(npc_abilities\.txt|heroes\/npc_dota_hero_\w+\.txt|items\.txt)$/;
const UNITS_FILE = "scripts/npc/npc_units.txt";

function argValue(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

// The dataset path of a game picture (images.js): a name ending in _jpg is a .jpg
const imagePath = (file) => {
  const base = file.replace(/\.vtex_c$/, "");
  return `${base}.${base.endsWith("_jpg") ? "jpg" : "png"}`;
};
const modelPath = (model) => model.toLowerCase().replace(/\.vmdl$/, ".glb");

async function main() {
  const game = argValue("--game");
  const [username, password] = process.argv.slice(2).filter((arg, index, args) => !arg.startsWith("--") && args[index - 1] !== "--game");
  const upload = !process.argv.includes("--no-upload");
  const force = process.argv.includes("--force");
  if ((!game && !password) || (upload && !process.env.HF_TOKEN)) {
    console.error('Usage: HF_TOKEN=... node names.js --game "<...>/dota 2 beta/game/dota" | <STEAM USERNAME> <STEAM PASSWORD>');
    process.exit(1);
  }
  fs.mkdirSync(temp, { recursive: true });
  const source = game ? localSource(game) : await steamSource(username, password, temp);
  const state = fs.existsSync(STATE_FILE) && !force ? JSON.parse(fs.readFileSync(STATE_FILE, "utf8")) : {};
  if (!force && source.manifestId && state.manifest === source.manifestId && state.version === VERSION) {
    console.log(`Names of manifest ${source.manifestId} are already made.`);
    return;
  }
  const { vpkDir } = source;
  const read = async (pattern) => {
    const files = new Map();
    await source.readFiles(vpkDir.files.filter((file) => pattern.test(file)), files);
    return [...files.values()].map((buffer) => parse(buffer).root);
  };

  // Every English text by its key, any case; a hero's name is under "<key>:n"
  const tokens = new Map();
  for (const root of await read(LOCALIZATION)) {
    for (const [key, value] of Object.entries(root.lang?.Tokens ?? {})) {
      if (!tokens.has(key.toLowerCase())) tokens.set(key.toLowerCase(), value);
    }
  }
  const text = (key) => {
    if (!key) return null;
    const bare = key.replace(/^#/, "").toLowerCase();
    return tokens.get(`${bare}:n`) ?? tokens.get(bare) ?? null;
  };

  const images = {};
  const models = {};
  const name = (table, file, value, kind) => {
    if (value && !table[file]) table[file] = [value, kind];
  };
  const pictures = vpkDir.files.filter((file) => /^panorama\/images\/.+\.vtex_c$/.test(file));

  // Heroes: their portraits (each look) and models
  for (const file of pictures) {
    const hero = file.match(/^panorama\/images\/heroes\/(?:selection\/|icons\/)?(npc_dota_hero_\w+?)_png\.vtex_c$/)?.[1];
    if (hero) name(images, imagePath(file), text(hero), "hero");
  }
  for (const root of await read(HERO_FILES)) {
    for (const [key, hero] of Object.entries(root.DOTAHeroes ?? {})) {
      if (key.startsWith("npc_dota_hero_") && hero?.Model) name(models, modelPath(hero.Model), text(key), "hero");
    }
  }

  // Cosmetics: the inventory picture and the models of each item
  const { items_game: itemsGame } = await loadItemsGame(source);
  for (const item of Object.values(itemsGame.items ?? {})) {
    const label = text(item.item_name) ?? item.name;
    if (!label) continue;
    if (item.image_inventory) {
      name(images, imagePath(`panorama/images/${item.image_inventory.toLowerCase()}.vtex_c`.replace(/\.vtex_c$/, "_png.vtex_c")), label, "cosmetic");
    }
    if (item.model_player) name(models, modelPath(item.model_player), label, "cosmetic");
    for (const [key, value] of Object.entries(item.visuals ?? {})) {
      if (key.startsWith("asset_modifier") && typeof value?.modifier === "string" && value.modifier.endsWith(".vmdl")) {
        name(models, modelPath(value.modifier), label, "cosmetic");
      }
    }
  }

  // Abilities and shop items, through the picture each one names
  for (const root of await read(ABILITY_FILES)) {
    // A hero's own file keeps its abilities in AbilityDefinitions
    const heroAbilities = Object.values(root.DOTAHeroes ?? {}).map((hero) => hero?.AbilityDefinitions ?? {});
    for (const [key, ability] of Object.entries(Object.assign({}, root.DOTAAbilities, ...heroAbilities))) {
      if (typeof ability !== "object") continue;
      const isItem = key.startsWith("item_");
      const label = text(`DOTA_Tooltip_ability_${key}`);
      const picture = (ability.AbilityTextureName ?? key).toLowerCase();
      const file = isItem
        ? `panorama/images/items/${picture.replace(/^item_/, "")}_png.vtex_c`
        : `panorama/images/spellicons/${picture}_png.vtex_c`;
      if (vpkDir.tree[file]) name(images, imagePath(file), label, isItem ? "item" : "ability");
    }
  }

  // Units: their models
  for (const root of await read(new RegExp(`^${UNITS_FILE.replace(/[./]/g, "\\$&")}$`))) {
    for (const [key, unit] of Object.entries(root.DOTAUnits ?? {})) {
      if (unit?.Model) name(models, modelPath(unit.Model), text(key), "unit");
    }
  }
  source.release();

  const count = (table) => Object.values(table).reduce((counts, [, kind]) => ({ ...counts, [kind]: (counts[kind] ?? 0) + 1 }), {});
  console.log("dota2-images:", Object.keys(images).length, count(images));
  console.log("dota2-models:", Object.keys(models).length, count(models));

  const write = (dataset, table) => {
    const file = path.join(temp, `${dataset}.json`);
    fs.writeFileSync(file, JSON.stringify(Object.fromEntries(Object.entries(table).sort(([a], [b]) => (a < b ? -1 : 1)))));
    return file;
  };
  const files = { "dota2-images": write("dota2-images", images), "dota2-models": write("dota2-models", models) };
  if (upload) {
    for (const [dataset, file] of Object.entries(files)) {
      const repo = await hf.prepareRepo(process.env.HF_TOKEN, dataset);
      await hf.upload(repo, process.env.HF_TOKEN, [{ path: "names.json", file }], "Update the names of the files");
    }
    fs.writeFileSync(STATE_FILE, JSON.stringify({ version: VERSION, manifest: source.manifestId }));
  } else {
    console.log(`Written to ${temp}`);
  }
}

main().then(
  () => process.exit(0),
  (error) => {
    console.error(error);
    process.exit(1);
  }
);
