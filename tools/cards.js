// The datasets' cards (README.md at each dataset's root, what Hugging Face shows on its page): what is
// inside, how to get it, how it stays current, credit. Counts and sizes come from each dataset's
// files.json (files-list.js), so running this again after an update keeps the numbers true.
//
//   HF_TOKEN=... node tools/cards.js [dataset ...] [--no-upload]
// Without names: every dataset. --no-upload writes them to temp/cards to read first.
const fs = require("fs");
const path = require("path");
const sharp = require("sharp");
const hf = require("../lib/hf");

const OWNER = "Sqls1";
const SITE = "https://s1nuxoff.github.io/Dotadex/";
const TRACKER = "https://github.com/S1nuxoff/dota2-game-tracker";
const S2V = "https://github.com/ValveResourceFormat/ValveResourceFormat";
const temp = "./temp/cards";

const base = (dataset) => `https://huggingface.co/datasets/${OWNER}/${dataset}/resolve/main/`;
const page = (dataset) => `https://huggingface.co/datasets/${OWNER}/${dataset}`;
const picture = (file) => `${base("dota2-images")}panorama/images/${file}`;
const site = (file) => `${base("dota2-data")}dotadex/${file}`;

// A row of pictures for a card's top. Hugging Face shows each <img> of a card on its own line, so the
// rows are put together into one picture, assets/banner.png in the dataset (banner()); a card
// holds a mark for each row until then
// opaque: drop the pictures' alpha (textures keep masks there)
const row = (pictures, height, opaque = false) => `<!--row ${JSON.stringify({ pictures: pictures.map(([src]) => src), height, opaque })}-->`;
const ROWS = /<!--row (.*?)-->/g;

// The card's rows as one picture, at twice their size for sharp screens: [file, width to show]
async function banner(card, dataset) {
  const rows = [...card.matchAll(ROWS)].map(([, json]) => JSON.parse(json));
  if (!rows.length) return null;
  const GAP = 12;
  const built = [];
  for (const { pictures, height, opaque } of rows) {
    const h = height * 2;
    const tiles = [];
    for (const src of pictures) {
      const data = Buffer.from(await (await fetch(src)).arrayBuffer());
      const image = sharp(data).resize({ height: h });
      const { data: tile, info } = await (opaque ? image.removeAlpha() : image).png().toBuffer({ resolveWithObject: true });
      tiles.push({ tile, width: info.width });
    }
    const width = tiles.reduce((sum, tile) => sum + tile.width, 0) + GAP * (tiles.length - 1);
    built.push({ tiles, width, height: h });
  }
  const width = Math.max(...built.map((line) => line.width));
  const height = built.reduce((sum, line) => sum + line.height, 0) + GAP * 2 * (built.length - 1);
  const composite = [];
  let top = 0;
  for (const line of built) {
    let left = Math.round((width - line.width) / 2);
    for (const { tile, width: tileWidth } of line.tiles) {
      composite.push({ input: tile, left, top });
      left += tileWidth + GAP;
    }
    top += line.height + GAP * 2;
  }
  const file = path.join(temp, `${dataset}-banner.png`);
  await sharp({ create: { width, height, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
    .composite(composite)
    .png({ compressionLevel: 9 })
    .toFile(file);
  return [file, Math.round(width / 2)];
}
const HEROES = ["pudge", "invoker", "juggernaut", "lina", "crystal_maiden", "nevermore", "phantom_assassin", "axe"];
const PORTRAITS = row(HEROES.map((hero) => [picture(`heroes/selection/npc_dota_hero_${hero}_png.png`), hero]), 120);
const ICONS = row(
  [
    ["items/blink_png.png", "Blink Dagger"],
    ["items/black_king_bar_png.png", "Black King Bar"],
    ["items/ultimate_scepter_png.png", "Aghanim's Scepter"],
    ["items/rapier_png.png", "Divine Rapier"],
    ["spellicons/pudge_meat_hook_png.png", "Meat Hook"],
    ["spellicons/invoker_sun_strike_png.png", "Sun Strike"],
    ["spellicons/crystal_maiden_freezing_field_png.png", "Freezing Field"],
    ["spellicons/juggernaut_omni_slash_png.png", "Omnislash"],
    ["econ/items/pudge/pudge_skeleton_hook_body_png.png", "Dragonclaw Hook"],
  ].map(([file, alt]) => [picture(file), alt]),
  56
);
const ARTWORK = row(
  [
    "images/loadingscreens/eldertitan_worldforger/loadingscreen_tga.webp",
    "images/loadingscreens/greatcalamityti4_loadingscreen/loadingscreen_tga.webp",
    "images/loadingscreens/timberthaw_loadingscreen/loadingscreen_tga.webp",
  ].map((file) => [site(file), "Dota 2 loading screen"]),
  150
);

// Every dataset of the family, for the links at the bottom of each card
const FAMILY = [
  ["dota2-data", "every script and text of the game as JSON (items, heroes, abilities, 28 languages)"],
  ["dota2-images", "every picture of the interface: icons, portraits, loading screens"],
  ["dota2-videos", "every video of the interface: animated hero portraits, trailers"],
  ["dota2-models", "every 3D model: heroes, cosmetics, units, buildings, props"],
  ["dota2-textures", "every texture of the 3D models and maps, on its own"],
  ["dota2-particles", "every particle effect system and its textures"],
  ["dota2-sounds", "every sound: voice lines, abilities, music, announcers"],
  ["dota2-maps", "every map and scene: the main map, events, backgrounds, MVP screens"],
];

const CREDIT = `## License and credit

Everything here is **Valve's** content (and the Dota 2 Workshop authors' for cosmetics), taken from the game files and shared for reference, research, fan sites, art and other non-commercial community projects. Dota 2 is a registered trademark of Valve Corporation. This is an unofficial, fan-made dataset, not affiliated with or endorsed by Valve. If you use it, please credit Valve and Dota 2.`;

// How a card ends: how it is made, the other datasets, credit
function footer(dataset, how) {
  return `## How it stays up to date

${how} The [tracker](${TRACKER}) checks Steam every six hours; after a game update it exports only what changed and removes what the game removed. Everything at the game's own paths, so a file you know from the game is easy to find.

Made for [Dotadex](${SITE}), a site that shows every Dota 2 hero and cosmetic in 3D as the game does, and open to everyone.

## The whole family

${FAMILY.map(([name, what]) => (name === dataset ? `- **${name}**: ${what} (this one)` : `- [${name}](${page(name)}): ${what}`)).join("\n")}

${CREDIT}
`;
}

// The ways to get files, for one example path and one example folder
function usage(dataset, file, folder) {
  return `## How to use it

**One file, straight from its link** (works in a browser, an \`<img>\`, \`fetch\`; served with CORS):

\`\`\`
${base(dataset)}${file}
\`\`\`

**Python** ([huggingface_hub](https://huggingface.co/docs/huggingface_hub)):

\`\`\`python
from huggingface_hub import hf_hub_download, snapshot_download

# one file
path = hf_hub_download("${OWNER}/${dataset}", "${file}", repo_type="dataset")

# a whole folder
snapshot_download("${OWNER}/${dataset}", repo_type="dataset", allow_patterns="${folder}/*", local_dir="${dataset}")
\`\`\`

**Command line** (\`pip install -U huggingface_hub\`):

\`\`\`bash
hf download ${OWNER}/${dataset} --repo-type dataset --include "${folder}/*" --local-dir ${dataset}
\`\`\`

**Find anything:** \`files.json\` at the root lists every file with its size, one download instead of walking the folders:

\`\`\`js
const { files } = await (await fetch("${base(dataset)}files.json")).json(); // [[path, size], ...]
\`\`\``;
}

// "12,345 files, 6.9 GB", and a table of the biggest folders at a depth
function stats(list, depth, describe) {
  const files = list.files.filter(([file]) => !/^(files|names)\.json/.test(file) && file !== "README.md");
  const bytes = files.reduce((sum, [, size]) => sum + size, 0);
  const folders = new Map();
  for (const [file, size] of files) {
    const parts = file.split("/");
    // Files right in a folder of the table's depth share a row (scenes/*: the maps themselves)
    const key = parts.length > depth ? `${parts.slice(0, depth).join("/")}/` : parts.length === depth && depth > 1 ? `${parts.slice(0, depth - 1).join("/")}/*` : file;
    const entry = folders.get(key) ?? { count: 0, bytes: 0 };
    entry.count++;
    entry.bytes += size;
    folders.set(key, entry);
  }
  const rows = [...folders]
    .filter(([key]) => key.endsWith("/") || key.endsWith("/*"))
    .sort((a, b) => b[1].count - a[1].count)
    .slice(0, 14)
    .map(([key, { count, bytes }]) => `| \`${key}\` | ${describe(key) ?? ""} | ${count.toLocaleString("en")} | ${size(bytes)} |`);
  return {
    count: files.length,
    bytes,
    summary: `${files.length.toLocaleString("en")} files, ${size(bytes)}`,
    table: `| Folder | What | Files | Size |\n|---|---|---:|---:|\n${rows.join("\n")}`,
  };
}
const size = (bytes) => (bytes >= 1e9 ? `${(bytes / 1e9).toFixed(1)} GB` : `${Math.max(1, Math.round(bytes / 1e6))} MB`);
const sizeCategory = (count) => (count < 1e3 ? "n<1K" : count < 1e4 ? "1K<n<10K" : count < 1e5 ? "10K<n<100K" : "100K<n<1M");

function header({ pretty, tags, count }) {
  return `---
pretty_name: ${pretty}
license: other
license_name: valve-content
tags:
${["dota-2", "dota2", "game-assets", ...tags].map((tag) => `  - ${tag}`).join("\n")}
size_categories:
  - ${sizeCategory(count)}
---
`;
}

// The cards, by dataset
const CARDS = {
  "dota2-data": (s) => `${header({ pretty: "Dota 2 Game Data and Texts", tags: ["json", "text", "localization", "game-data"], count: s.count })}
# Dota 2 Game Data and Texts

${PORTRAITS}

**Every script and text file of Dota 2 as JSON**: all items and cosmetics (\`items_game\`), heroes, abilities, units, shops, events, emoticons, chat wheel, voice line rules, and every localization of the game in all 28 languages. Straight from the game files, updated after every patch. ${s.summary}.

## What's inside

${s.table}

- **\`scripts/\`, \`resource/\`**: the game's own files at their own paths, \`<path>.json\` for \`<path>\` in the game. KeyValues text becomes JSON objects with string values; a key a block repeats keeps every value, the next ones as \`key#2\`, \`key#3\` (items' \`visuals\` repeat \`asset_modifier\`). KeyValues3 and compiled resources (\`.vdata_c\`, response rules \`.vrr_c\`, ...) are decompiled to JSON. The few text files that are not KeyValues are kept as they are.
- **\`dotadex/\`**: files made from those for the [Dotadex](${SITE}) site, handy on their own: \`dotadex/data/heroes.json\`, \`abilities.json\`, \`items.json\`, \`treasures.json\` (chests and what drops from them), \`voices/<hero>.json\` (voice lines with their sound files), \`i18n/<language>.json\` (every text the site shows), and lighter pictures (\`dotadex/images/\`: loading screens and hero page backdrops at 1920 px, the hero grid in one atlas, cursor packs).

Popular files:

| File | What |
|---|---|
| \`scripts/items/items_game.txt.json\` | Every item, cosmetic, set, treasure and their visuals |
| \`scripts/npc/npc_heroes.txt.json\`, \`scripts/npc/heroes/*.json\` | Heroes and their abilities |
| \`scripts/npc/npc_abilities.txt.json\`, \`scripts/npc/items.txt.json\` | Abilities and shop items |
| \`scripts/npc/npc_units.txt.json\` | Creeps, summons, buildings, Roshan |
| \`resource/localization/<file>_<language>.txt.json\` | Every text of the game (\`items_\`, \`abilities_\`, \`dota_\`, \`hero_lore_\`, ...) |

${usage("dota2-data", "scripts/items/items_game.txt.json", "resource/localization")}

${footer("dota2-data", "Read from the game files by `gamefiles.js` (scripts and texts) and `data.js`, `audio.js`, `models.js` (the `dotadex/` files).")}`,

  "dota2-images": (s) => `${header({ pretty: "Dota 2 Images", tags: ["image", "icons", "png"], count: s.count })}
# Dota 2 Images

${PORTRAITS}
${ICONS}

**Every picture of the Dota 2 interface**: hero portraits in every style, ability and item icons, every cosmetic's inventory icon, loading screens, emoticons, sprays, event and battle pass art, interface icons. ${s.summary}, as the game keeps them: the PNG or JPEG inside each texture taken out byte for byte, the others decoded to PNG, vector icons as SVG.

## What's inside

${s.table}

Everything is under \`panorama/images/\`, at the game's paths. A texture \`<name>.vtex_c\` in the game is \`<name>.png\` here, or \`<name>.jpg\` when its name ends in \`_jpg\`.

| Path | What |
|---|---|
| \`heroes/npc_dota_hero_<hero>_png.png\` | Hero portraits (also \`selection/\` tall ones, \`icons/\` small ones, and every alternate look) |
| \`spellicons/<ability>_png.png\` | Ability icons |
| \`items/<item>_png.png\` | Shop item icons |
| \`econ/...\` | Every cosmetic's inventory icon, sets, couriers, wards, tools |
| \`loadingscreens/...\` | Loading screens, full size |
| \`emoticons/\`, \`sprays/\` | Emoticons (animated strips) and sprays |

**Names people know:** \`names.json\` maps a path to its name in the game: \`"panorama/images/spellicons/invoker_sun_strike_png.png": ["Sun Strike", "ability"]\` (kinds: hero, ability, item, cosmetic).

${usage("dota2-images", "panorama/images/heroes/npc_dota_hero_pudge_png.png", "panorama/images/heroes")}

${footer("dota2-images", "Exported from the game files by `images.js`.")}`,

  "dota2-videos": (s) => `${header({ pretty: "Dota 2 Videos", tags: ["video", "webm"], count: s.count })}
# Dota 2 Videos

${PORTRAITS}

**Every video of the Dota 2 interface**: the animated hero portraits of the hero picker (every hero), event and battle pass trailers with their subtitles in every language, the tutorial, promos, seasonal and healthbar animations. ${s.summary}, as the game keeps them (\`.webm\`, \`.mp4\`, \`.mov\`, subtitles \`.vtt\`).

## What's inside

${s.table}

| Path | What |
|---|---|
| \`panorama/videos/heroes/npc_dota_hero_<hero>.webm\` | A hero's animated portrait (the hero grid) |
| \`panorama/videos/<event>/*.webm\`, \`*_<language>.vtt\` | Event trailers and their subtitles |
| \`panorama/videos/promo/\`, \`tutorial_video/\` | Promos and the tutorial |

${usage("dota2-videos", "panorama/videos/heroes/npc_dota_hero_pudge.webm", "panorama/videos/heroes")}

${footer("dota2-videos", "Exported from the game files by `videos.js`.")}`,

  "dota2-models": (s) => `${header({ pretty: "Dota 2 3D Models", tags: ["3d", "gltf", "glb", "models", "animation"], count: s.count })}
# Dota 2 3D Models

${PORTRAITS}

**Every 3D model of Dota 2 as glTF (\`.glb\`)**: all heroes, every cosmetic item and style, couriers, wards, creeps, Roshan, buildings, map props, event and interface models, with their skeletons, animations and materials, textures inside each file. ${s.summary}. Open them in Blender, three.js, Babylon.js, any glTF viewer, or see them all in 3D on **[Dotadex](${SITE})**.

## What's inside

${s.table}

| Path | What |
|---|---|
| \`models/<path>.glb\` | A model: meshes, skeleton, animations, materials, textures inside |
| \`models/<path>.glb.gz\` | The same model lighter for web pages (gunzip it: a valid \`.glb\`) |
| \`models/<path>.sequences.json\` | Its animations: looping or not, activities (\`ACT_DOTA_IDLE\`), effects and lines they start |
| \`models/<path>.attachments.json\` | Attachment points (\`attach_hitloc\`, \`attach_weapon\`, ...): bones, offsets, rotations |
| \`models/<path>.cloth.json\` | Cloth, hair and beard physics as the game simulates them |
| \`models/<path>.flex.json\` | Face controllers and their morph rules (lip sync) |
| \`models/<path>.skins.json\`, \`textures/\` | Material variants (golden versions and the like) and their textures |
| \`materials/dynamic.json\`, \`cubemaps/\` | Materials the game animates; the cube maps they reflect |

A hero model is the bare body: arms, weapons and the rest are cosmetics worn on top, each its own file (\`models/items/<hero>/...\`), bound to the hero's bones by name, as in the game. The glTF files are in metres, y up; the JSON files keep the game's units (inches, z up). Materials keep Dota's shader parameters in \`extras.vmat\`.

**Names people know:** \`names.json\` maps a model to its name in the game: \`"models/items/pudge/pudge_skeleton_hook_body.glb": ["Dragonclaw Hook", "cosmetic"]\` (kinds: hero, cosmetic, unit).

${usage("dota2-models", "models/heroes/pudge/pudge.glb", "models/heroes/pudge")}

${footer("dota2-models", `Converted from the game files by \`models.js\` with [Source 2 Viewer](${S2V}) (models), \`particles.js\` (sequences, attachments), \`cloth.js\`, \`flex.js\`, \`skins.js\`, \`materials.js\`.`)}`,

  "dota2-textures": (s) => `${header({ pretty: "Dota 2 Textures", tags: ["image", "textures", "png", "3d"], count: s.count })}
# Dota 2 Textures

${row(
    [
      "models/heroes/pudge/pudge2_body_color_psd_e676b3c.png",
      "models/heroes/axe/axe_bare_color_psd_f3eac904.png",
      "models/heroes/lina/lina2_color_psd_ad5b14a1.png",
      "models/heroes/nevermore/nevermore_color_psd_a53f1f33.png",
      "models/heroes/juggernaut/juggernaut_fur_color_psd_d9300f6c.png",
      "models/heroes/invoker/invoker_bracer_color_psd_e68dac0b.png",
    ].map((file) => [`${base("dota2-textures")}materials/${file}`, "texture"]),
    130,
    true
  )}

**Every texture of Dota 2's 3D world on its own**: the colour maps, normal maps and masks of every hero, cosmetic, unit, building, prop and map, the particles' textures, skyboxes. ${s.summary}, as PNG with the pixels the game draws (decoded from the GPU's block compression; full size), high dynamic range ones as EXR. The 3D models in [dota2-models](${page("dota2-models")}) already hold theirs inside; here each is a file for your own renders, mods and art.

## What's inside

${s.table}

At the game's paths: \`<name>.vtex_c\` in the game is \`<name>.png\` here. A texture of several pictures is several files: an animated sheet as \`<name>_seq<n>.png\` (or a file a frame, \`_seq<n>_<frame>\`) with \`<name>.mks\` describing its frames, a cube map as its six faces \`_bk _dn _ft _lf _rt _up\`, a volume as its slices \`_z000\`, \`_z001\`, ...

Dota's hero textures come in sets: \`_color\` (colour, alpha often a mask), \`_normal\`, \`_masks1\` / \`_masks2\` (detail, metalness, self-illumination, specular, rim, tint by channel), \`_specexp\`, \`_rimmask\`.

${usage("dota2-textures", "materials/models/heroes/pudge/pudge2_body_color_psd_e676b3c.png", "materials/models/heroes/pudge")}

${footer("dota2-textures", "Exported from the game files by `textures.js`.")}`,

  "dota2-particles": (s) => `${header({ pretty: "Dota 2 Particle Effects", tags: ["particles", "vfx", "json"], count: s.count })}
# Dota 2 Particle Effects

${row(
    [
      "spellicons/invoker_sun_strike_png.png",
      "spellicons/lina_laguna_blade_png.png",
      "spellicons/zuus_thundergods_wrath_png.png",
      "spellicons/crystal_maiden_freezing_field_png.png",
      "spellicons/phoenix_supernova_png.png",
      "spellicons/enigma_black_hole_png.png",
      "spellicons/faceless_void_chronosphere_png.png",
      "spellicons/earthshaker_echo_slam_png.png",
    ].map((file) => [picture(file), "ability"]),
    64
  )}

**Every particle system of Dota 2** (abilities, cosmetics, units, buildings, maps, the interface, events) as JSON, with the textures they draw and the engine's defaults for the fields a system leaves out. ${s.summary}. See them played as the game does on **[Dotadex](${SITE})**.

## What's inside

${s.table}

| Path | What |
|---|---|
| \`particles/<path>.json\` | One system (\`particles/<path>.vpcf\` in the game) as its KeyValues3 give it |
| \`particles/bundles/<path>.json\` | An effect heroes and items show, with every system it spawns, in one file |
| \`particles/textures/<path>.png\`, \`.json\` | A texture particles draw as an atlas, and its sheet (sequences, frames) |
| \`particles/<path>.vsnap.json\` | A snapshot: points placed on a model, by stream |
| \`particles/schema.json\` | The engine's particle classes with their fields' defaults |
| \`particles/model-effects.json\`, \`map-effects.json\`, \`map-cameras.json\` | Effects models and maps start on their own; the interface scenes' cameras |

Positions are in the game's units (inches) and axes (z up).

${usage("dota2-particles", "particles/bundles/units/heroes/hero_invoker/invoker_sun_strike.json", "particles/units/heroes/hero_invoker")}

${footer("dota2-particles", "Exported from the game files by `particles.js` (the schema by `particle-schema.js`).")}`,

  "dota2-sounds": (s) => `${header({ pretty: "Dota 2 Sounds", tags: ["audio", "mp3", "voice", "music"], count: s.count })}
# Dota 2 Sounds

${row(HEROES.map((hero) => [picture(`heroes/icons/npc_dota_hero_${hero}_png.png`), hero]), 40)}

**Every sound of Dota 2**: every hero's voice lines, attacks and abilities, music and music packs, announcer packs, items, the interface, ambience, events. ${s.summary}, as the game keeps them (the MP3 or WAV inside each sound file).

## What's inside

${s.table}

| Path | What |
|---|---|
| \`sounds/vo/<hero>/*.mp3\` | A hero's voice lines |
| \`sounds/vo/announcer*/\` | Announcer packs |
| \`sounds/weapons/...\` | Attacks, abilities, hero sounds |
| \`sounds/music/...\` | Music and music packs |
| \`soundevents.json\` | Every sound event the game plays (\`Hero_Pudge.Attack\`) with its files, volume, pitch, layers |
| \`sounds/<folder>/phonemes.json\` | The voice lines' phonemes (lip sync) |

The game rarely plays a file by name: it plays a sound event, which picks one of its files. \`soundevents.json\` maps each event to its files; [dota2-data](${page("dota2-data")}) \`dotadex/data/voices/<hero>.json\` lists each hero's lines.

${usage("dota2-sounds", "sounds/vo/pudge/pud_attack_01.mp3", "sounds/vo/pudge")}

${footer("dota2-sounds", `Converted from the game files by \`sounds.js\` with [Source 2 Viewer](${S2V}).`)}`,

  "dota2-maps": (s) => `${header({ pretty: "Dota 2 Maps and Scenes", tags: ["3d", "gltf", "glb", "maps", "scenes"], count: s.count })}
# Dota 2 Maps and Scenes

${ARTWORK}

**Every map and scene of Dota 2 as glTF (\`.glb\`)**: the main map and its seasonal versions (winter, spring, summer, autumn, desert, jungle, reef, cavern, TI10, Crownfall...), event and tutorial maps, the hero page backgrounds, MVP screens, treasure openings, main menu, battle pass and event scenes, terrain previews. Meshes, materials and textures inside each file. ${s.summary}.

## What's inside

${s.table}

| Path | What |
|---|---|
| \`scenes/<map>.glb\` | A map package (\`maps/<map>.vpk\` in the game) |
| \`scenes.json\` | The scenes the site uses, with their lights, cameras and fog |

Some scenes are frames the game fills by code (a camera, lights, the spot where a hero stands) and come out empty; the models they place are in [dota2-models](${page("dota2-models")}).

${usage("dota2-maps", "scenes/dota.glb", "scenes/backgrounds")}

${footer("dota2-maps", `Converted from the game's map packages by \`scenes.js\` with [Source 2 Viewer](${S2V}).`)}`,
};

// What a folder holds, for the tables
const DESCRIBE = {
  "dota2-data": { "scripts/": "the game's scripts", "resource/": "texts in every language, interface resources", "dotadex/": "files made for the Dotadex site" },
  "dota2-models": { "models/items/": "cosmetics", "models/heroes/": "heroes", "models/props_structures/": "buildings", "models/creeps/": "creeps, Roshan", "models/courier/": "couriers", "models/events/": "events", "models/particle/": "models particles draw", "models/props_gameplay/": "gameplay props", "models/props_tree/": "trees", "models/ui/": "interface models", "textures/": "material variants' textures", "materials/": "animated materials", "cubemaps/": "cube maps" },
  "dota2-images": { "panorama/images/econ/": "cosmetics' icons", "panorama/images/teamfancontent/": "team fan content", "panorama/images/events/": "events", "panorama/images/spellicons/": "ability icons", "panorama/images/emoticons/": "emoticons", "panorama/images/loadingscreens/": "loading screens", "panorama/images/heroes/": "hero portraits", "panorama/images/items/": "item icons", "panorama/images/compendium/": "compendiums", "panorama/images/hud/": "the HUD" },
  "dota2-sounds": { "sounds/vo/": "voice lines, announcers", "sounds/weapons/": "attacks, abilities", "sounds/music/": "music", "sounds/ui/": "interface", "sounds/items/": "items", "sounds/ambient/": "ambience", "sounds/teamfancontent/": "team fan content", "sounds/talentcontent/": "talent content" },
  "dota2-particles": { "particles/econ/": "cosmetics' effects", "particles/units/": "heroes' and units' effects", "particles/bundles/": "effects in one file", "particles/textures/": "textures", "particles/models/": "model effects", "particles/items_fx/": "items", "particles/items2_fx/": "items" },
};
Object.assign(DESCRIBE["dota2-images"], { "panorama/images/talentcontent/": "talent and caster content", "panorama/images/leaf_pages/": "event pages", "panorama/images/teams/": "team logos", "panorama/images/control_icons/": "interface icons" });
DESCRIBE["dota2-maps"] = { "scenes/*": "the main map, its seasonal versions, event and tutorial maps", "scenes/scenes/": "MVP screens, treasures, menus, events", "scenes/backgrounds/": "hero page and menu backgrounds", "scenes/terrain_previews/": "terrain previews", "scenes/events/": "event maps", "scenes/prefabs/": "prefabs", "scenes/ui/": "interface scenes", "scenes/crownfall_assets/": "Crownfall", "scenes/tilesets/": "tilesets" };
Object.assign(DESCRIBE["dota2-particles"], { "particles/events/": "events", "particles/ui/": "the interface", "particles/neutral_fx/": "neutral creeps and items", "particles/ui_mouseactions/": "clicks and pings", "particles/generic_gameplay/": "gameplay", "particles/items4_fx/": "items", "particles/items5_fx/": "items" });
Object.assign(DESCRIBE["dota2-sounds"], { "sounds/misc/": "misc", "sounds/physics/": "physics", "sounds/npc/": "units", "sounds/diagnostics/": "tests", "sounds/addons/": "custom game modes", "sounds/tools/": "tools" });
DESCRIBE["dota2-videos"] = { "panorama/videos/heroes/": "animated hero portraits", "panorama/videos/events/": "events", "panorama/videos/healthbar_deaths/": "healthbar deaths", "panorama/videos/seasonal/": "seasonal", "panorama/videos/tutorial_video/": "the tutorial, with subtitles", "panorama/videos/promo/": "promos", "panorama/videos/onstage/": "on stage", "panorama/videos/international2022/": "TI 2022" };
for (const event of ["crownfall", "diretide2020", "continuum_conundrum", "spring2021", "aghanims_labyrinth", "dark_carnival"]) DESCRIBE["dota2-videos"][`panorama/videos/${event}/`] = "event trailer, subtitles";

DESCRIBE["dota2-textures"] = { "materials/models/items/": "cosmetics", "materials/models/heroes/": "heroes", "materials/vgui/hud/": "the HUD", "materials/particle/sprays/": "sprays", "materials/models/props_structures/": "buildings", "materials/models/creeps/": "creeps, Roshan", "materials/models/courier/": "couriers", "materials/models/props_gameplay/": "gameplay props", "materials/models/events/": "events", "materials/skybox/": "skyboxes" };

const DEPTH = { "dota2-data": 1, "dota2-images": 3, "dota2-videos": 3, "dota2-models": 2, "dota2-textures": 3, "dota2-particles": 2, "dota2-sounds": 2, "dota2-maps": 2 };

async function main() {
  const upload = !process.argv.includes("--no-upload");
  const names = process.argv.slice(2).filter((arg) => !arg.startsWith("--"));
  if (upload && !process.env.HF_TOKEN) {
    console.error("Usage: HF_TOKEN=... node tools/cards.js [dataset ...] [--no-upload]");
    process.exit(1);
  }
  fs.mkdirSync(temp, { recursive: true });
  for (const dataset of names.length ? names : Object.keys(CARDS)) {
    const list = await (await fetch(`${base(dataset)}files.json`)).json();
    const s = stats(list, DEPTH[dataset], (key) => DESCRIBE[dataset]?.[key] ?? (/\/stickers\//.test(key) ? "stickers" : /\/props_/.test(key) ? "map props" : /^textures\//.test(key) ? "material variants' textures" : null));
    let card = CARDS[dataset](s);
    const made = await banner(card, dataset);
    const uploads = [];
    if (made) {
      const [bannerFile, width] = made;
      // The first row's mark becomes the banner, the others go
      let first = true;
      card = card
        .replace(ROWS, () => {
          if (!first) return "";
          first = false;
          return `<p align="center"><img src="${base(dataset)}assets/banner.png" alt="Dota 2" width="${Math.min(width, 900)}"></p>`;
        })
        .replace(/\n{3,}/g, "\n\n");
      uploads.push({ path: "assets/banner.png", file: bannerFile });
    }
    const file = path.join(temp, `${dataset}.md`);
    fs.writeFileSync(file, card);
    uploads.push({ path: "README.md", file });
    console.log(`${dataset}: ${s.summary}`);
    if (upload) {
      const repo = await hf.prepareRepo(process.env.HF_TOKEN, dataset);
      await hf.upload(repo, process.env.HF_TOKEN, uploads, "Update the dataset card", { gzip: false });
    }
  }
  if (!upload) console.log(`Written to ${temp}`);
}

main().then(
  () => process.exit(0),
  (error) => {
    console.error(error);
    process.exit(1);
  }
);
