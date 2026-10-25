// The download site's catalog: every hero and every item of items_game with the files of the
// datasets that belong to it, so a page can show "Invoker" with all his models, personas, items,
// sounds and effects instead of folders. Written to dota2-data as catalog/catalog.json (+ .gz):
//   {
//     updated,
//     heroes: [{ id, name, model, look, tokens, abilities, personas: [{ id, name, model, look }], items: [item id] }],
//     items: { id: { name, prefab, slot, slotKey, type, rarity, heroes, set, icon, refs: { <dataset>: [prefix] } } },
//     sets: { key: { name, items, icon } },
//     rarities: { key: { name, color, order } },
//     prefabs: { prefab: its name in the game }
//   }
// A hero's own files are found by the page from tokens (its name in the game, its models' and its
// items' folders), matched against the datasets' files.json; an item's are listed as refs: path
// prefixes in each dataset (a whole folder, or a model's files sharing its name), all from what the
// item names in items_game. Everything comes from the datasets, so it runs after them:
//
// Also catalog/models.json, every 3D model sorted for the site's 3D page (modelIndex below).
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
const MODELS_OUT = "catalog/models.json";
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

// An item's loadout slot; a hero's wearable without one goes in the weapon slot, as in the game
const slotOf = (item) => item.item_slot || (["wearable", "default_item"].includes(item.prefab) ? "weapon" : "");

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

// Every 3D model of dota2-models and dota2-maps, sorted the way people look for one: by what it is
// (type: heroes, cosmetics, units, world, effects, scenes, technical) and a group within it, and by
// where it comes from (theme: an event, an area of the map); with its hero and item where it has one,
// its measures (previews.js), its textures in dota2-textures, and a variant key that puts numbered
// copies (rock_01 ... rock_09, _legacy) under one card. Rules by folder, not by model:
// TYPE_BY_FOLDER is the top folder under models/ (or maps/<x>/models/)
const TYPE_BY_FOLDER = [
  [/^(heroes|items)$/, "cosmetics", ""],
  [/^courier$/, "cosmetics", "couriers"],
  [/^pets$/, "cosmetics", "pets"],
  [/^(creeps|npc_minions|units|mh_monsters|roshan)$/, "units", ""],
  [/^buildings$/, "units", "buildings"],
  [/^props$/, "world", ""],
  [/^props_(.+)$/, "world", "$1"],
  [/^architecture$/, "world", "structures"],
  [/^gameplay$/, "world", "gameplay"],
  [/^(.+)_assets$/, "world", ""],
  [/^dark_carnival$/, "world", ""],
  [/^(particle|particles|effects|items\d*_fx|projectiles)$/, "effects", ""],
  [/^(backgrounds|versus|mvp|ui|layout|scenes|battlepass|promotional|trophies|vr_env|econ|skybox)$/, "scenes", "$1"],
  [/^(dev|development|test|editor|controllers)$/, "technical", ""],
];
// Words that name where a model comes from: an event, an area, a season
const THEME = /^(?:(.+)_assets|frostivus|diretide|winter|crownfall|nemestice|ti\d+|dark_carnival|summer|fall|desert|reef|cavern|jungle|journey|keen|mines|garden|fade)$/;
const TECHNICAL = /(^|_)(camera|dummy|test|placeholder|null|proxy)(_|$)/;
const words = (s) => s.replace(/_/g, " ").trim();

function modelIndex({ lists, modelNames, items, heroes, meta }) {
  const byStem = new Map();
  for (const [id, item] of Object.entries(items)) for (const pre of item.refs.models || []) if (!byStem.has(pre)) byStem.set(pre, id);
  const bodies = new Map();
  for (const h of heroes) {
    const key = h.id.slice("npc_dota_hero_".length);
    if (h.model) bodies.set(h.model, [key, "hero"]);
    for (const p of h.personas) if (p.model) bodies.set(p.model, [key, "persona"]);
  }
  const heroByToken = new Map();
  for (const h of heroes) for (const t of h.tokens) heroByToken.set(t, h.id.slice("npc_dota_hero_".length));
  // Textures by their name in the game (<name>_<hash>), as the glb files name them
  const textureByName = new Map();
  for (const p of lists.textures) {
    const m = /\/([^/]+)\.(png|exr)$/.exec(p);
    if (m && !textureByName.has(m[1])) textureByName.set(m[1], p);
  }
  const textureList = [];
  const textureIndex = new Map();
  const textureRef = (p) => {
    if (!textureIndex.has(p)) {
      textureIndex.set(p, textureList.length);
      textureList.push(p);
    }
    return textureIndex.get(p);
  };

  const rows = [];
  for (const [ds, list] of [["models", lists.models], ["maps", lists.maps]]) {
    for (const p of list) {
      if (!p.endsWith(".glb") || p.startsWith("previews/")) continue;
      const seg = p.split("/");
      const file = seg[seg.length - 1].slice(0, -4);
      // The folders that say what it is: models/<top>/<below>/..., maps/<top>/models/<below>/...
      // (a map's own models: cavern_assets, backgrounds), particles/models/... (effects' models)
      const inModels = seg.indexOf("models");
      const mapModels = seg[0] === "maps" && seg[2] === "models";
      const top = mapModels || seg[0] === "particles" ? seg[mapModels ? 1 : 0] : inModels >= 0 ? seg[inModels + 1] || "" : seg[1] || "";
      const below = mapModels ? seg[3] || "" : inModels >= 0 ? seg[inModels + 2] || "" : seg[2] || "";
      let type = "other";
      let group = "";
      let hero = "";
      for (const [re, t, g] of TYPE_BY_FOLDER) {
        if (re.test(top)) {
          type = t;
          group = g.includes("$") ? top.replace(re, g) : g;
          break;
        }
      }
      if (type === "world" && !group) group = below.endsWith(".glb") ? top : below;
      const theme = seg.slice(0, -1).map((x) => THEME.exec(x)).find(Boolean);
      let themeName = theme ? words(theme[1] || theme[0]) : "";
      if (top === "events") {
        // models/events/<event>/<what>/...
        themeName = words(below);
        type = "world";
        group = words(seg[inModels + 3] && !seg[inModels + 3].endsWith(".glb") ? seg[inModels + 3] : below);
      }
      const itemId = byStem.get(`${p.slice(0, -4)}.`) || "";
      const item = itemId ? items[itemId] : null;
      if (ds === "maps") {
        type = "scenes";
        group = "maps";
      } else if (bodies.has(p)) {
        [hero, group] = bodies.get(p);
        type = "heroes";
      } else if (item) {
        type = "cosmetics";
        group = item.prefab === "courier" ? "couriers" : item.prefab === "ward" ? "wards" : item.slot || words(item.prefab);
        hero = (item.heroes.find((h) => h.startsWith("npc_dota_hero_")) || "").replace("npc_dota_hero_", "");
      } else if (modelNames[p]?.[1] === "unit") {
        type = "units";
      } else if (modelNames[p]?.[1] === "hero") {
        type = "heroes";
        group = "hero";
      }
      if ((top === "heroes" || top === "items") && !hero) hero = heroByToken.get(below) || "";
      // Parts of a hero's items that no item names (styles' extra pieces)
      if (type === "cosmetics" && !group) group = "parts";
      if (type !== "heroes" && TECHNICAL.test(file)) type = "technical";
      if (type === "units" && !group) group = below.endsWith(".glb") ? top : below;
      // Numbered copies and old versions of one model share a card
      const variant = `${seg.slice(0, -1).join("/")}/${file.replace(/(_?\d+[a-z]?|_legacy|_alt\d*|_lod\d+|_style\d+|_v\d+)+$/, "")}`;
      const m = meta[p] || [];
      const textures = (m[6] || []).map((n) => textureByName.get(n)).filter(Boolean).map(textureRef);
      rows.push([ds, p, type, words(group), themeName, hero, itemId, m[1] ?? null, m[2] ?? null, m[3] ?? null, m[4] ?? null, m[5] ?? null, variant, textures]);
    }
  }
  return {
    fields: ["dataset", "path", "type", "group", "theme", "hero", "item", "width", "height", "depth", "triangles", "animations", "variant", "textures"],
    textures: textureList,
    models: rows,
  };
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
      slot: slotOf(item) ? localize(itemTokens, `#LoadoutSlot_${slotOf(item)}`) || slotOf(item) : "",
      // The slot as items_game names it (head, weapon, back_persona_1), as Dotadex's links take it
      slotKey: slotOf(item),
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
  const previewState = fs.existsSync("state/previews.json") ? JSON.parse(fs.readFileSync("state/previews.json", "utf8")) : {};
  const modelNames = await getJson(DATASETS.models, "names.json");
  const models = modelIndex({ lists, modelNames, items, heroes, meta: previewState.meta || {} });
  // Uploaded only when it changed (state/catalog.json keeps the hash of the last upload)
  const hash = require("crypto").createHash("sha1").update(JSON.stringify(body)).update(JSON.stringify(models)).digest("hex");
  const state = fs.existsSync(STATE_FILE) ? JSON.parse(fs.readFileSync(STATE_FILE, "utf8")) : {};
  const local = path.join(temp, "catalog.json");
  fs.writeFileSync(local, JSON.stringify({ updated: new Date().toISOString(), ...body }));
  const modelsLocal = path.join(temp, "models.json");
  fs.writeFileSync(modelsLocal, JSON.stringify(models));
  const types = {};
  for (const row of models.models) types[row[2]] = (types[row[2]] || 0) + 1;
  console.log(`models: ${models.models.length} (${Object.entries(types).map(([t, n]) => `${t} ${n}`).join(", ")}), ${(fs.statSync(modelsLocal).size / 1e6).toFixed(1)} MB`);
  console.log(`catalog: ${heroes.length} heroes, ${Object.keys(items).length} items, ${Object.keys(itemSets).length} sets, ${(fs.statSync(local).size / 1e6).toFixed(1)} MB`);
  if (state.hash === hash && !process.argv.includes("--force")) {
    console.log("catalog: unchanged since its last upload");
    return;
  }
  if (upload) {
    const repo = await hf.prepareRepo(accessToken, DATASETS.data);
    await hf.upload(repo, accessToken, [{ path: OUT, file: local }, { path: MODELS_OUT, file: modelsLocal }], "Update the download site's catalog");
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
