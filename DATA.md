# The map of the data

Where every file Dotadex reads lives, which script writes it, and which part of the site reads it.
Kept current with every step of the plan in Dotadex's `TASKS.md` (section "Data: the whole game
in datasets"); the site names every source once in `src/datasets.js`.

State on 2026-10-24: eight Hugging Face datasets under `Sqls1/`, the price tracker on GitHub, and Steam's CDN for one kind of picture.

## Sources

| Source | Written by | Holds |
|---|---|---|
| HF `dota2-data` | this repo: `gamefiles.js`; `models.js`, `data.js`, `audio.js` for `dotadex/` | every script and localization of the game as JSON, at its game path; under `dotadex/` the files made for the site |
| HF `dota2-images` | this repo: `images.js` | every picture of the game's interface as the game keeps it |
| HF `dota2-videos` | this repo: `videos.js` | every video of the game's interface as the game keeps it |
| HF `dota2-models` | this repo: `models.js`, `particles.js` (sequences, attachments) | every model of the game with its materials and textures |
| HF `dota2-textures` | this repo: `textures.js` | every texture outside the interface, on its own, as PNG |
| HF `dota2-particles` | this repo: `particles.js` | every particle system of the game, their textures, bundles, the engine's schema |
| HF `dota2-sounds` | this repo: `sounds.js`, `audio.js` | every sound, sound events, phonemes |
| HF `dota2-maps` (was dota2-scenes) | this repo: `scenes.js` | scenes and maps as glb |
| GitHub `dota2-price-tacker` `static/prices/latest.json` | dota2-price-tacker, every 20 minutes | market prices (not from the game) |
| Steam CDN `cdn.steamstatic.com/apps/dota2/images/dota_react/` | Valve | the heroes' square crops (the Wardrobe), which the game has no copy of |

Every JSON at most one folder deep (and `data/i18n/`) has a gzipped copy `<file>.json.gz` next to it
(`hf.js`); the site asks for that first (`src/fetchData.js`). Every model has `<model>.glb.gz`
(`web-glb.js`).

Every dataset has `files.json` (+ `.gz`) at its root: every file with its size, and the dataset's
revision it was listed from (`files-list.js`, against `state/files.json`).

## dota2-data

Every file of `scripts/` and `resource/` that is text (and the kinds below), at its game path (`gamefiles.js`, only what
changed, against `state/gamefiles.json`). No gzipped copies: pages do not load these.

| Path | What it is | Read by |
|---|---|---|
| `<path>.json` for KeyValues text (`.txt`, `.res`, `.vdf`, events) | blocks as objects, values as strings; a repeated key's next values as `<key>#2`, `<key>#3`; `#base` and `#include` kept as pairs; `[$PLATFORM]` conditions dropped. A `.txt` in KV3 (`soundmixers.txt`) is its KV3 as JSON | `scripts/items/items_game.txt.json` and `resource/localization/items_english.txt.json`: `scripts/build-catalog.mjs` |
| `<path>.json` for a compiled resource (`<path>_c`: `.vdata_c`, `.vrr_c`, `.herolist_c`, ...) | Source2Viewer's decompiled KV3 as JSON | |
| `<path>` | a text file that is not KeyValues (old VGUI `.res` with `key=value`, QC templates, `.htm`, `.styles`), as UTF-8 | |

Every material is `<path>.vmat.json` (from `.vmat_c`, wherever the game keeps it: `materials/`, `models/.../materials`, `maps/...`): `{ "Layer0": { shader, F_* flags, g_* parameters, the textures it names } }`; every sound event file is `soundevents/<file>.vsndevts.json` (each event's `vsnd_files`, volume, pitch, mixgroup, distance, layers).

Also, decompiled the same way: `patchnotes/patchnotes.vdpn.json` (the in-game patch notes), `novels/<event>.vdvn.json` (the events' visual novels), `scenes/<hero>/<line>.vcd.json` (each voice line's choreography: timed flex animations and gestures; `scenes/<hero>.vcdlist` the lists, as text), `soundstacks/` and `sounds/graphs/` (the sound mixer: `.vsndstck`, `.vdsp`, `.vmix`, `.vdata`), and the files at the game's root and in `cfg/` (`matchmodes.txt.json`, `cfg/dotakeys.lst`, ...; `stringtokendatabase.txt` is binary, kept byte for byte).

`panorama/` holds the client's interface: layouts (`.xml`), styles (`.css`) and scripts (`.js`, TypeScript ones compiled) decompiled from `.vxml_c`, `.vcss_c`, `.vjs_c`, `.vts_c`; `resource/*.otf` and `resource/*.ttf` (from `.vfont`) are Dota's own fonts. The Windows fonts in `vgui/fonts` are left out.

The exporters of this repo read items_game from the game itself (`itemsgame.js`, the same shape).

`catalog/catalog.json` (+ `.gz`, `exporters/catalog.js`, the last step of `export.js`): the download site's catalog. Every hero (name, the tokens that name its folders and files, abilities, personas, its items) and every item of items_game with its game names (slot, type, rarity, set) and its files as path prefixes per dataset. Read by the download site (dota2-files).

### dotadex/: the files made for the site

Made by this repo's exporters out of the game files, in the shape the site reads; each JSON at most
one folder deep under `dotadex/` (and `data/i18n/`) has a `.json.gz` copy. The site reads them
from `DOTADEX_BASE`.

| Path | Script | What it is | Read by (site) |
|---|---|---|---|
| `dotadex/index.json` | `models.js` | which models show each hero and item: `{ heroes: { key: glb }, items: { id: { name, models } } }` | `scripts/build-catalog.mjs`, `src/catalog.js` |
| `dotadex/exported.json` | `models.js` | the models exported so far | `src/catalog.js` |
| `dotadex/data/heroes.json`, `abilities.json`, `items.json`, `neutral_items.json`, `shops.json`, `treasures.json` | `data.js` | heroes, abilities, shop items, treasure chests | `src/gamedata.js`, `scripts/build-catalog.mjs` |
| `dotadex/data/armory.json`, `emoticons.json`, `cursors.json`, `loadout_backgrounds.json`, `loadout_portraits.json`, `manifest.json` | `data.js` | the Armory's categories, emoticons, cursor packs, hero page backgrounds and portrait setups, the game version | `src/components/*`, `src/App.jsx` |
| `dotadex/data/i18n/<language>.json` | `data.js` | every text the site shows, per language | `src/gamedata.js` |
| `dotadex/images/...`: `loadout_backgrounds/*.jpg`, `loadingscreens/**/*.webp`, `materials/portraits_card/...png`, `heroes/selection_atlas.webp` + `.json`, `cursors/<pack>/*.png` | `data.js` | pictures made from the game's for the site: the hero page backdrops at 1920 wide, the loading screens at 1920 wide, the CUSTOMIZE cards' backgrounds (materials, not interface pictures), every hero grid portrait in one atlas, the cursor packs (BMPs in the game) | `HeroPage.jsx`, `ItemDetails.jsx`, `CosmeticPicker.jsx`, `HeroGrid.jsx` |
| `dotadex/data/animsounds.json`, `animsound-events.json`, `abilitysounds.json`, `voices/<hero>.json`, `portrait-speech.json`, `audio-library.json`, `ui-sounds.json`, `chat-wheel.json` | `audio.js` | which sounds play when: animations, abilities, voice lines, music and announcer packs, the menu, the chat wheel | `src/components/Viewer.jsx`, `Voice.jsx`, `HeroPage.jsx`, `ChatWheel*.jsx`, `ItemDetails.jsx`, `src/uiSounds.js` |

## dota2-images and dota2-videos

The interface's pictures and videos at their game paths, as the game keeps them (`images.js`,
`videos.js`, only what changed, against `state/images.json` and `state/videos.json`).

| Path | What it is | Read by (site) |
|---|---|---|
| dota2-images `panorama/images/<path>.png` or `.jpg` | a texture (`<path>.vtex_c`): the PNG or JPEG it holds, byte for byte, or for the other formats its pixels decoded to PNG. A name ending in `_jpg` is a `.jpg`, every other a `.png` | `panoramaImage(name)` and `dataImage(image)` in `src/datasets.js`, used all over the site |
| dota2-images `panorama/images/<path>.svg` | a vector picture (`.vsvg_c`) | `panoramaFile(file)` |
| dota2-videos `panorama/videos/<path>` | `.webm` (loose in the depot), `.mov`, `.mp4`, `.vtt` subtitles (in the VPK) | `VIDEOS_BASE`: the hero grid's animated portraits |

## dota2-textures

Every texture of the game outside `panorama/` (`materials/`, `models/`, `maps/`, ...), at its game path as `<name>.png` for `<name>.vtex_c` (EXR for high dynamic range ones), the pixels the game draws at full size. A texture of several pictures is several files: a sheet's `<name>_seq<n>.png` (or `_seq<n>_<frame>`) with `<name>.mks`, a cube map's six faces `_bk _dn _ft _lf _rt _up`, a volume's slices `_z000...` (`exporters/textures.js`, run by `images.js`'s code, against `state/textures.json`). The site does not read it; the models carry their own textures.

## dota2-models

| Path | Script | What it is | Read by (site) |
|---|---|---|---|
| `models/<path>.glb`, `.glb.gz` | `models.js`, `web-glb.js` | a model with its textures and animations; `.gz` is the site's lighter copy | `src/viewer/stage.js` |
| `models/<path>.skins.json`, `textures/` | `skins.js` | material variants (styles, golden versions) and their textures | `src/viewer/stage.js` |
| `models/<path>.sequences.json` | `particles.js` | a model's sequences, activities, and the effects and speech its animations start | `src/viewer/stage.js`, `src/viewer/particles/manager.js` |
| `models/<path>.flex.json`, `models/flex.json` | `flex.js` | face controllers and morph rules; the list of models that have them | `src/viewer/face.js` |
| `models/<path>.cloth.json`, `models/cloth.json` | `cloth.js` | cloth, hair and beard simulation; the list | `src/viewer/cloth.js` |
| `materials/dynamic.json` | `materials.js` | materials' per-frame parameters | `src/viewer/materialPrograms.js` |
| `cubemaps/`, `cubemaps/index.json` | `materials.js` (run by `models.js`) | the environment cube maps materials use | `src/viewer/dotaMaterial.js` |
| `previews/<model path>.webp` | `previews.js` | a 320 px picture of every model for the download site, drawn in headless Chrome; new and changed models after each update | dota2-files |
| `previews/embeddings.json`, `previews/embeddings.bin` | `embeddings.js` | a CLIP vector of every preview, for the download site's search by picture and by words | dota2-files |

## dota2-particles

Every particle system and snapshot of the game, wherever the game keeps it (most under `particles/`, some under `models/` and `maps/`, at their game paths) (`particles.js`, only what changed, against `state/particles.json`). Models the game keeps under `particles/` (and their sequences, attachments, cloth) stay in dota2-models with the other models. The site reads it from `PARTICLES_BASE`.

| Path | Script | What it is | Read by (site) |
|---|---|---|---|
| `particles/<path>.json`, `particles/bundles/`, `particles/textures/`, `.vsnap.json` | `particles.js` | particle systems, effects with all they spawn, their textures, snapshots | `src/viewer/particles/` |
| `particles/model-effects.json`, `map-effects.json`, `map-cameras.json`, `attached-models.json`, `schema.json`, `coverage.json` | `particles.js` | effects models and maps start on their own, the hero page cameras, models effects attach, the engine's defaults | `src/viewer/stage.js`, `src/viewer/cardEdges.js`, `src/viewer/particles/` |

## dota2-sounds

| Path | Script | What it is | Read by (site) |
|---|---|---|---|
| `sounds/<path>.mp3` (or `.wav`) | `sounds.js` | every sound of the game | `src/components/Voice.jsx`, `Viewer.jsx`, `Music.jsx`, `src/uiSounds.js` |
| `soundevents.json` | `audio.js` | every sound event with its files, volume and pitch | `src/uiSounds.js` |
| `sounds/<folder>/phonemes.json`, `phonemes.json`, `expressions/heroes/phonemes.json` | `phonemes.js` | voice lines' phonemes for lip sync | `src/viewer/face.js`, `stage.js`, `src/components/Viewer.jsx` |

## dota2-maps

| Path | Script | What it is | Read by (site) |
|---|---|---|---|
| `scenes/<path>.glb` | `scenes.js` | a scene or map with its textures | `src/viewer/stage.js` (through `catalog.scenesBase`) |
| `scenes.json` | `scenes.js` | the scenes with their lights and cameras | `scripts/build-catalog.mjs` |

## State files (this repo)

`state/`: what each exporter already did, so a run exports only what changed, one file each (`models.json`, `data.json`, `gamefiles.json`, `images.json`, `textures.json`, `videos.json`, `sounds.json`, `audio.json`, `particles.json` with `particle-models.json`, `scenes.json`, `names.json`, `files.json`, `catalog.json`, `previews.json`, `embeddings.json`; `run.json` the game version and code of the last full run). The workflow commits them after each run.
