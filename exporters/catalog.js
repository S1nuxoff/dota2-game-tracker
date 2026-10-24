// The download site's catalog: every hero and every item of items_game with the files of the
// datasets that belong to it, so a page can show "Invoker" with all his models, personas, items,
// sounds and effects instead of folders. Written to dota2-data as catalog/catalog.json (+ .gz):
//   {
//     updated,
//     heroes: [{ id, name, model, look, tokens, abilities, personas: [{ id, name, model, look }], items: [item id] }],
//     items: { id: { name, prefab, slot, type, rarity, heroes, set, icon, refs: { <dataset>: [prefix] } } },
//     sets: { key: { name, items, icon } },
//     rarities: { key: { name, color, order } },
//     prefabs: { prefab: its name in the game }
//   }
// A hero's own files are found by the page from tokens (its name in the game, its models' and its
// items' folders), matched against the datasets' files.json; an item's are listed as refs: path
// prefixes in each dataset (a whole folder, or a model's files sharing its name), all from what the
// item names in items_game. Everything comes from the datasets, so it runs after them:
//
// A step of export.js after files-list (the lists it reads); uploaded again only when it changed.
//
//   HF_TOKEN=... node exporters/catalog.js [--no-upload] [--force]
const fs = require("fs");
const path = require("path");
const hf = require("../lib/hf");
const { DATASETS } = require("../lib/datasets");

const OWNER = "Sqls1";
const OUT = "catalog/catalog.json";
const STATE_FILE = "state/catalog.json";
const temp = "./temp/catalog";

const url = (repo, file) => `https://huggingface.co/datasets/${OWNER}/${repo}/resolve/main/${file}`;

async function getJson(repo, file) {
  // The gzipped copy where the tracker made one, else the file itself
  for (const [name, gz] of [[`${file}.gz`, true], [file, false]]) {
    const res = await fetch(url(repo, name));
    if (!res.ok) continue;
    const body = Buffer.from(await res.arrayBuffer());
    return JSON.parse(gz ? require("zlib").gunzipSync(body) : body);
  }
  throw new Error(`${repo}/${file} not found`);
}

const tokensOf = (lang) => {
  const out = new Map();
  for (const [k, v] of Object.entries(lang.lang?.Tokens || lang.Tokens || {})) out.set(k.toLowerCase(), v);
  return out;
};
const localize = (tokens, key) => (key && key.startsWith("#") ? tokens.get(key.slice(1).toLowerCase()) : undefined);

// Every string value under an item (styles, asset modifiers...), lower case; not the portrait setups,
// which name only the shared icon backdrop
function strings(value, out = new Set()) {
  if (typeof value === "string") out.add(value.toLowerCase().replace(/\\/g, "/"));
  else if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) if (k !== "portraits") strings(v, out);
  }
  return out;
}

const stripExt = (p) => p.replace(/\.[a-z0-9_]+$/, "");

// The first of the sorted paths not below prefix (files.json is sorted by path)
function lowerBound(sorted, prefix) {
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (sorted[mid] < prefix) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

async function main() {
  const accessToken = process.env.HF_TOKEN;
  const upload = !process.argv.includes("--no-upload");
  if (upload && !accessToken) {
    console.error("Usage: HF_TOKEN=... node exporters/catalog.js [--no-upload]");
    process.exit(1);
  }
  fs.mkdirSync(temp, { recursive: true });

  const lists = {};
  for (const [id, repo] of Object.entries(DATASETS)) lists[id] = (await getJson(repo, "files.json")).files.map(([p]) => p);
  const sets = Object.fromEntries(Object.entries(lists).map(([id, files]) => [id, new Set(files)]));
  const imageNames = await getJson(DATASETS.images, "names.json");
  const itemsGame = (await getJson(DATASETS.data, "scripts/items/items_game.txt.json")).items_game;
  const heroesData = await getJson(DATASETS.data, "dotadex/data/heroes.json");
  const itemTokens = tokensOf(await getJson(DATASETS.data, "resource/localization/items_english.txt.json"));
  for (const [k, v] of tokensOf(await getJson(DATASETS.data, "resource/localization/dota_english.txt.json"))) if (!itemTokens.has(k)) itemTokens.set(k, v);
  const soundEvents = await getJson(DATASETS.sounds, "soundevents.json");
  const events = new Map(Object.entries(soundEvents).map(([k, v]) => [k.toLowerCase(), v.files || []]));

  // A picture by the name the game gives it (econ/items/x/y): its file is <name>_png.png, _jpg.jpg, _psd.png...
  const images = new Map();
  for (const p of lists.images) {
    const m = /^panorama\/images\/(.+)_(png|jpg|jpeg|psd|tga)\.(png|jpg)$/.exec(p);
    if (m) images.set(m[1], p);
  }
  const imageOf = (s) => images.get(s.replace(/^panorama\/images\//, "").replace(/\.(vtex|vtex_c|png|jpg|psd|tga)$/, ""));

  // An item's files, as prefixes per dataset
  function refsOf(item) {
    const refs = {};
    const add = (ds, prefix) => (refs[ds] ??= new Set()).add(prefix);
    for (const s of strings(item)) {
      const image = imageOf(s);
      if (image) add("images", image);
      if (events.has(s)) for (const f of events.get(s)) if (sets.sounds.has(f)) add("sounds", f);
      if (!s.includes("/")) continue;
      if (s.endsWith(".vmdl")) {
        const stem = stripExt(s);
        if (sets.models.has(`${stem}.glb`)) add("models", `${stem}.`);
        // A model in a folder of its own (models/items/<hero>/<item>/) takes the folder's textures,
        // one among the hero's own takes the textures named after it
        const dir = path.posix.dirname(stem);
        const own = dir.split("/").length >= 4 && dir.startsWith("models/items/");
        add("textures", own ? `materials/${dir}/` : `materials/${stem}`);
      } else if (s.endsWith(".vpcf")) {
        const json = `${stripExt(s)}.json`;
        if (sets.particles.has(json)) add("particles", json);
      } else if (s.endsWith(".vsndevts")) {
        if (sets.data.has(`${s}.json`)) add("data", `${s}.json`);
      } else if (/\.(vtex|vmat)$/.test(s)) {
        const png = `${stripExt(s)}.png`;
        if (sets.textures.has(png)) add("textures", png);
        if (sets.data.has(`${s}.json`)) add("data", `${s}.json`);
      }
    }
    // Prefixes that match nothing are dropped (a texture folder the export has no pictures for)
    const out = {};
    for (const [ds, prefixes] of Object.entries(refs)) {
      const kept = [...prefixes].filter((pre) => lists[ds][lowerBound(lists[ds], pre)]?.startsWith(pre)).sort();
      if (kept.length) out[ds] = kept;
    }
    return out;
  }

  const colors = itemsGame.colors || {};
  const rarities = {};
  for (const [key, r] of Object.entries(itemsGame.rarities || {})) {
    rarities[key] = {
      name: localize(itemTokens, `#${r.loc_key}`) || key,
      color: colors[r.color]?.hex_color || "",
      order: Number(r.value) || 0,
    };
  }

  // Sets list their items by item name
  const byName = new Map();
  const items = {};
  for (const [id, item] of Object.entries(itemsGame.items)) {
    if (id === "default" || !item || typeof item !== "object") continue;
    const refs = refsOf(item);
    if (!Object.keys(refs).length) continue;
    const icon = item.image_inventory ? imageOf(item.image_inventory.toLowerCase()) : undefined;
    const type = localize(itemTokens, item.item_type_name);
    items[id] = {
      name: localize(itemTokens, item.item_name) || item.name || id,
      prefab: item.prefab || "",
      // The names the game shows: the slot of the hero's loadout (LoadoutSlot_<slot>), the item's type
      slot: item.item_slot ? localize(itemTokens, `#LoadoutSlot_${item.item_slot}`) || item.item_slot : "",
      type: type ? type[0].toUpperCase() + type.slice(1) : "",
      rarity: item.item_rarity || "",
      heroes: Object.keys(item.used_by_heroes || {}),
      icon: icon || refs.images?.[0] || "",
      refs,
    };
    if (item.name) byName.set(item.name.toLowerCase(), id);
  }
  const itemSets = {};
  for (const [key, set] of Object.entries(itemsGame.item_sets || {})) {
    const ids = Object.keys(set.items || {}).map((n) => byName.get(n.toLowerCase())).filter(Boolean);
    if (!ids.length) continue;
    itemSets[key] = { name: localize(itemTokens, set.name) || key, items: ids, icon: set.portrait_image ? imageOf(set.portrait_image.toLowerCase()) || "" : "" };
    for (const id of ids) items[id].set ??= key;
  }

  // The hero's model in dota2-models (.vmdl -> .glb), when it was exported
  const glbOf = (model) => {
    const glb = model ? `${stripExt(model.toLowerCase())}.glb` : "";
    return sets.models.has(glb) ? glb : "";
  };
  const folderOf = (model) => (model ? model.toLowerCase().split("/")[2] : undefined);
  const heroes = [];
  for (const [id, hero] of Object.entries(heroesData)) {
    if (!id.startsWith("npc_dota_hero_") || hero.Enabled === "0") continue;
    const key = id.slice("npc_dota_hero_".length);
    const name = imageNames[`panorama/images/heroes/${id}_png.png`]?.[0];
    if (!name) continue;
    const own = Object.entries(items).filter(([, it]) => it.heroes.includes(id));
    // The folders the hero's items live in (models/items/<x>/, particles/econ/items/<x>/), when most say so
    const folders = new Map();
    for (const [, it] of own) {
      for (const pre of [...(it.refs.models || []), ...(it.refs.particles || [])]) {
        const m = /^(?:models\/items|particles\/econ\/items)\/([^/]+)\//.exec(pre);
        if (m) folders.set(m[1], (folders.get(m[1]) || 0) + 1);
      }
    }
    const top = [...folders.entries()].filter(([, n]) => n >= Math.max(3, own.length / 4)).map(([f]) => f);
    // The models the hero wears by default (its default items), and each persona's (slots <slot>_persona_<n>);
    // summoned units are not worn
    const lookOf = (n) =>
      own
        .map(([itemId]) => itemsGame.items[itemId])
        .filter((it) => it.prefab === "default_item" && it.model_player && !(it.item_slot || "").startsWith("summon"))
        .filter((it) => (n ? (it.item_slot || "").endsWith(`_persona_${n}`) : !/_persona_\d+$/.test(it.item_slot || "")))
        .map((it) => glbOf(it.model_player))
        .filter(Boolean);
    const personas = Object.entries(hero.Persona || {}).map(([n, p]) => ({
      look: lookOf(n),
      id: p.name,
      name: imageNames[`panorama/images/heroes/${p.name}_png.png`]?.[0] || p.name,
      folder: folderOf(p.Model),
      model: glbOf(p.Model),
    }));
    const tokens = [...new Set([key, folderOf(hero.Model), ...personas.map((p) => p.folder), ...top].filter(Boolean))];
    const abilities = Object.entries(hero)
      .filter(([k, v]) => /^Ability\d+$/.test(k) && v && !v.startsWith("generic_") && !v.startsWith("special_bonus"))
      .map(([, v]) => v);
    heroes.push({
      id,
      name,
      model: glbOf(hero.Model),
      tokens,
      abilities,
      look: lookOf(""),
      personas: personas.map(({ id: pid, name: pname, model, look }) => ({ id: pid, name: pname, model, look })),
      items: own.map(([itemId]) => itemId),
    });
  }
  heroes.sort((a, b) => a.name.localeCompare(b.name));

  // A kind of item (prefab) by the game's name of it (DOTA_WearableType_<prefab>: loading_screen ->
  // Loading Screen) when that name says the same words (default_item's says Roshan), else its own words
  const titleCase = (s) => s.replace(/_/g, " ").replace(/\b[a-z]/g, (c) => c.toUpperCase());
  const prefabs = {};
  for (const prefab of new Set(Object.values(items).map((it) => it.prefab).filter(Boolean))) {
    const game = localize(itemTokens, `#DOTA_WearableType_${prefab}`);
    const words = prefab.replace(/_/g, " ");
    prefabs[prefab] = titleCase(game && game.toLowerCase().replace(/_/g, " ") === words ? game : words);
  }

  const body = { heroes, items, sets: itemSets, rarities, prefabs };
  // Uploaded only when it changed (state/catalog.json keeps the hash of the last upload)
  const hash = require("crypto").createHash("sha1").update(JSON.stringify(body)).digest("hex");
  const state = fs.existsSync(STATE_FILE) ? JSON.parse(fs.readFileSync(STATE_FILE, "utf8")) : {};
  const local = path.join(temp, "catalog.json");
  fs.writeFileSync(local, JSON.stringify({ updated: new Date().toISOString(), ...body }));
  console.log(`catalog: ${heroes.length} heroes, ${Object.keys(items).length} items, ${Object.keys(itemSets).length} sets, ${(fs.statSync(local).size / 1e6).toFixed(1)} MB`);
  if (state.hash === hash && !process.argv.includes("--force")) {
    console.log("catalog: unchanged since its last upload");
    return;
  }
  if (upload) {
    const repo = await hf.prepareRepo(accessToken, DATASETS.data);
    await hf.upload(repo, accessToken, [{ path: OUT, file: local }], "Update the download site's catalog");
    fs.writeFileSync(STATE_FILE, JSON.stringify({ hash }, null, 1));
  }
}

module.exports = { main };

if (require.main === module) {
  main().then(
    () => process.exit(0),
    (error) => {
      console.error(error);
      process.exit(1);
    }
  );
}
