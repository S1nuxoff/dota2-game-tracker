# The map of the data

Where every file Dotadex reads lives, which script writes it, and which part of the site reads it.
Kept current with every step of the plan in Dotadex's `TASKS.md` (section "Data: the whole game
in datasets"); the site names every source once in `src/datasets.js`.

State on 2026-10-24: three Hugging Face datasets under `Sqls1/`, two GitHub trackers, Steam's CDN.

## Sources

| Source | Written by | Holds |
|---|---|---|
| HF `dota2-models` | this repo: `index.js`, `data.js`, `particles.js`, `audio.js` | models, game data for the site, panorama pictures the site uses, particles |
| HF `dota2-sounds` | this repo: `sounds.js`, `audio.js` | every sound, sound events, phonemes |
| HF `dota2-scenes` | this repo: `scenes.js` | scenes and maps as glb |
| GitHub `dota2-file-tracker` `static/` | dota2-file-tracker | `items_game.json`, the 30 localizations |
| GitHub `dota2-image-tracker` `static/` | dota2-image-tracker | ~20k panorama pictures as PNG |
| GitHub `dota2-price-tacker` `static/prices/latest.json` | dota2-price-tacker, every 20 minutes | market prices (not from the game) |
| Steam CDN `cdn.steamstatic.com/apps/dota2/images/dota_react/` | Valve | hero portraits and crops, attribute icons |

Every JSON at most one folder deep (and `data/i18n/`) has a gzipped copy `<file>.json.gz` next to it
(`hf.js`); the site asks for that first (`src/fetchData.js`). Every model has `<model>.glb.gz`
(`web-glb.js`).

## dota2-models

| Path | Script | What it is | Read by (site) |
|---|---|---|---|
| `index.json` | `index.js` | which models show each hero and item: `{ heroes: { key: glb }, items: { id: { name, models } } }` | `scripts/build-catalog.mjs`, `src/catalog.js`, `src/viewer/dotaMaterial.js` |
| `exported.json` | `index.js` | the models exported so far | `src/catalog.js` |
| `models/<path>.glb`, `.glb.gz` | `index.js`, `web-glb.js` | a model with its textures and animations; `.gz` is the site's lighter copy | `src/viewer/stage.js` |
| `models/<path>.skins.json`, `textures/` | `skins.js` | material variants (styles, golden versions) and their textures | `src/viewer/stage.js` |
| `models/<path>.sequences.json` | `particles.js` | a model's sequences, activities, and the effects and speech its animations start | `src/viewer/stage.js`, `src/viewer/particles/manager.js` |
| `models/<path>.flex.json`, `models/flex.json` | `flex.js` | face controllers and morph rules; the list of models that have them | `src/viewer/face.js` |
| `models/<path>.cloth.json`, `models/cloth.json` | `cloth.js` | cloth, hair and beard simulation; the list | `src/viewer/cloth.js` |
| `materials/dynamic.json` | `materials.js` | materials' per-frame parameters | `src/viewer/materialPrograms.js` |
| `cubemaps/`, `cubemaps/index.json` | `materials.js` (run by `index.js`) | the environment cube maps materials use | `src/viewer/dotaMaterial.js` |
| `data/heroes.json`, `abilities.json`, `items.json`, `neutral_items.json`, `shops.json`, `treasures.json` | `data.js` | heroes, abilities, shop items, treasure chests | `src/gamedata.js`, `scripts/build-catalog.mjs` |
| `data/armory.json`, `emoticons.json`, `cursors.json`, `loadout_backgrounds.json`, `loadout_portraits.json`, `manifest.json` | `data.js` | the Armory's categories, emoticons, cursor packs, hero page backgrounds and portrait setups, the game version | `src/components/*`, `src/App.jsx` |
| `data/i18n/<language>.json` | `data.js` | every text the site shows, per language | `src/gamedata.js` |
| `data/animsounds.json`, `animsound-events.json`, `abilitysounds.json`, `voices/<hero>.json`, `portrait-speech.json`, `audio-library.json`, `ui-sounds.json`, `chat-wheel.json` | `audio.js` | which sounds play when: animations, abilities, voice lines, music and announcer packs, the menu, the chat wheel | `src/components/Viewer.jsx`, `Voice.jsx`, `HeroPage.jsx`, `ChatWheel*.jsx`, `ItemDetails.jsx`, `src/uiSounds.js` |
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
`data-state.json`, `sounds-state.json`, `audio-state.json`, `particles-state.json`,
`particle-models.json`, `scenes-state.json`. The workflow commits them after each run.
