# The map of the data

Where every file Dotadex reads lives, which script writes it, and which part of the site reads it.
Kept current with every step of the plan in Dotadex's `TASKS.md` (section "Data: the whole game
in datasets"); the site names every source once in `src/datasets.js`.

State on 2026-10-24: four Hugging Face datasets under `Sqls1/`, the image tracker on GitHub, Steam's CDN.

## Sources

| Source | Written by | Holds |
|---|---|---|
| HF `dota2-data` | this repo: `gamefiles.js`; `index.js`, `data.js`, `audio.js` for `dotadex/` | every script and localization of the game as JSON, at its game path; under `dotadex/` the files made for the site |
| HF `dota2-models` | this repo: `index.js`, `data.js`, `particles.js` | models, panorama pictures the site uses, particles |
| HF `dota2-sounds` | this repo: `sounds.js`, `audio.js` | every sound, sound events, phonemes |
| HF `dota2-scenes` | this repo: `scenes.js` | scenes and maps as glb |
| GitHub `dota2-image-tracker` `static/` | dota2-image-tracker | ~20k panorama pictures as PNG |
| GitHub `dota2-price-tacker` `static/prices/latest.json` | dota2-price-tacker, every 20 minutes | market prices (not from the game) |
| Steam CDN `cdn.steamstatic.com/apps/dota2/images/dota_react/` | Valve | hero portraits and crops, attribute icons |

Every JSON at most one folder deep (and `data/i18n/`) has a gzipped copy `<file>.json.gz` next to it
(`hf.js`); the site asks for that first (`src/fetchData.js`). Every model has `<model>.glb.gz`
(`web-glb.js`).

## dota2-data

Every file of `scripts/` and `resource/` that is text, at its game path (`gamefiles.js`, only what
changed, against `gamefiles-state.json`). No gzipped copies: pages do not load these.

| Path | What it is | Read by |
|---|---|---|
| `<path>.json` for KeyValues text (`.txt`, `.res`, `.vdf`, events) | blocks as objects, values as strings; a repeated key's next values as `<key>#2`, `<key>#3`; `#base` and `#include` kept as pairs; `[$PLATFORM]` conditions dropped. A `.txt` in KV3 (`soundmixers.txt`) is its KV3 as JSON | `scripts/items/items_game.txt.json` and `resource/localization/items_english.txt.json`: `scripts/build-catalog.mjs` |
| `<path>.json` for a compiled resource (`<path>_c`: `.vdata_c`, `.vrr_c`, `.herolist_c`, ...) | Source2Viewer's decompiled KV3 as JSON | |
| `<path>` | a text file that is not KeyValues (old VGUI `.res` with `key=value`, QC templates, `.htm`, `.styles`), as UTF-8 | |

The exporters of this repo read items_game from the game itself (`itemsgame.js`, the same shape).

### dotadex/: the files made for the site

Made by this repo's exporters out of the game files, in the shape the site reads; each JSON at most
one folder deep under `dotadex/` (and `data/i18n/`) has a `.json.gz` copy. The site reads them
from `DOTADEX_BASE`.

| Path | Script | What it is | Read by (site) |
|---|---|---|---|
| `dotadex/index.json` | `index.js` | which models show each hero and item: `{ heroes: { key: glb }, items: { id: { name, models } } }` | `scripts/build-catalog.mjs`, `src/catalog.js` |
| `dotadex/exported.json` | `index.js` | the models exported so far | `src/catalog.js` |
| `dotadex/data/heroes.json`, `abilities.json`, `items.json`, `neutral_items.json`, `shops.json`, `treasures.json` | `data.js` | heroes, abilities, shop items, treasure chests | `src/gamedata.js`, `scripts/build-catalog.mjs` |
| `dotadex/data/armory.json`, `emoticons.json`, `cursors.json`, `loadout_backgrounds.json`, `loadout_portraits.json`, `manifest.json` | `data.js` | the Armory's categories, emoticons, cursor packs, hero page backgrounds and portrait setups, the game version | `src/components/*`, `src/App.jsx` |
| `dotadex/data/i18n/<language>.json` | `data.js` | every text the site shows, per language | `src/gamedata.js` |
| `dotadex/data/animsounds.json`, `animsound-events.json`, `abilitysounds.json`, `voices/<hero>.json`, `portrait-speech.json`, `audio-library.json`, `ui-sounds.json`, `chat-wheel.json` | `audio.js` | which sounds play when: animations, abilities, voice lines, music and announcer packs, the menu, the chat wheel | `src/components/Viewer.jsx`, `Voice.jsx`, `HeroPage.jsx`, `ChatWheel*.jsx`, `ItemDetails.jsx`, `src/uiSounds.js` |

## dota2-models

| Path | Script | What it is | Read by (site) |
|---|---|---|---|
| `models/<path>.glb`, `.glb.gz` | `index.js`, `web-glb.js` | a model with its textures and animations; `.gz` is the site's lighter copy | `src/viewer/stage.js` |
| `models/<path>.skins.json`, `textures/` | `skins.js` | material variants (styles, golden versions) and their textures | `src/viewer/stage.js` |
| `models/<path>.sequences.json` | `particles.js` | a model's sequences, activities, and the effects and speech its animations start | `src/viewer/stage.js`, `src/viewer/particles/manager.js` |
| `models/<path>.flex.json`, `models/flex.json` | `flex.js` | face controllers and morph rules; the list of models that have them | `src/viewer/face.js` |
| `models/<path>.cloth.json`, `models/cloth.json` | `cloth.js` | cloth, hair and beard simulation; the list | `src/viewer/cloth.js` |
| `materials/dynamic.json` | `materials.js` | materials' per-frame parameters | `src/viewer/materialPrograms.js` |
| `cubemaps/`, `cubemaps/index.json` | `materials.js` (run by `index.js`) | the environment cube maps materials use | `src/viewer/dotaMaterial.js` |
| `images/...png`, `.svg`, `.webp`, `images/heroes/selection_atlas.*`, `images/cursors/` | `data.js` | panorama pictures in `IMAGE_FOLDERS`, the hero grid atlas, cursors | most components (`imageUrl` in `src/gamedata.js`) |
| `videos/heroes/` | `data.js` | the heroes' animated portraits | `src/components/HeroGrid.jsx` |
| `particles/<path>.json`, `particles/bundles/`, `particles/textures/`, `.vsnap.json` | `particles.js` | particle systems, effects with all they spawn, their textures, snapshots | `src/viewer/particles/` |
| `particles/model-effects.json`, `map-effects.json`, `map-cameras.json`, `attached-models.json`, `schema.json`, `coverage.json` | `particles.js` | effects models and maps start on their own, the hero page cameras, models effects attach, the engine's defaults | `src/viewer/stage.js`, `src/viewer/cardEdges.js`, `src/viewer/particles/` |

## dota2-sounds

| Path | Script | What it is | Read by (site) |
|---|---|---|---|
| `sounds/<path>.mp3` (or `.wav`) | `sounds.js` | every sound of the game | `src/components/Voice.jsx`, `Viewer.jsx`, `Music.jsx`, `src/uiSounds.js` |
| `soundevents.json` | `audio.js` | every sound event with its files, volume and pitch | `src/uiSounds.js` |
| `sounds/<folder>/phonemes.json`, `phonemes.json`, `expressions/heroes/phonemes.json` | `phonemes.js` | voice lines' phonemes for lip sync | `src/viewer/face.js`, `stage.js`, `src/components/Viewer.jsx` |

## dota2-scenes

| Path | Script | What it is | Read by (site) |
|---|---|---|---|
| `scenes/<path>.glb` | `scenes.js` | a scene or map with its textures | `src/viewer/stage.js` (through `catalog.scenesBase`) |
| `scenes.json` | `scenes.js` | the scenes with their lights and cameras | `scripts/build-catalog.mjs` |

## State files (this repo)

What each exporter already did, so a run exports only what changed: `state.json` (models),
`data-state.json`, `gamefiles-state.json`, `sounds-state.json`, `audio-state.json`, `particles-state.json`,
`particle-models.json`, `scenes-state.json`. The workflow commits them after each run.
