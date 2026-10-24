# Dota 2 Model Tracker

Exports every Dota 2 item and hero model from the game files to glTF (`.glb`), with materials, textures (inside the file) and animations, using [Source 2 Viewer](https://github.com/ValveResourceFormat/ValveResourceFormat), and uploads them to a Hugging Face dataset.

Only the files a model needs are downloaded from Steam: the model, its meshes, materials, textures and animations, found by following each file's references. Item models come from `items_game.json` of [dota2-file-tracker](https://github.com/S1nuxoff/dota2-file-tracker), hero models from `scripts/npc/npc_heroes.txt`.

Which dataset holds what, which script writes it and what the site reads: [DATA.md](DATA.md).

## Using the models

The dataset keeps the game's paths, with `.glb` instead of `.vmdl`:

```
https://huggingface.co/datasets/<user>/dota2-models/resolve/main/models/heroes/pudge/pudge.glb
```

Next to each `.glb` is a `.glb.gz` for web pages: gunzipped it is the same model as a valid `.glb`, with the animation channels that hold a bone at rest dropped, shared accessors merged and keyframes that interpolation gives back removed (`web-glb.js`). It is about a tenth of the size for heroes. `node web-glb-backfill.js` makes them for models uploaded before they existed.

The index and data files (a JSON at most one folder deep, such as `exported.json` or `data/heroes.json`, and the translations in `data/i18n/`) have a gzipped copy next to them too, `<file>.json.gz`, uploaded with each (`hf.js`): Hugging Face serves files uncompressed. `node json-gz-backfill.js` makes them for files uploaded before.

`index.json` in the dataset lists which models show each item and hero:

```json
{
  "heroes": { "npc_dota_hero_pudge": "models/heroes/pudge/pudge.glb" },
  "items": { "4007": { "name": "Dragonclaw Hook", "models": ["models/items/pudge/pudge_skeleton_hook_body.glb"] } }
}
```

A hero model is the bare body: arms, weapons and other parts are default items worn on top, like any other cosmetic.

## Material variants and styles

Items that show a model with another material (golden versions and the like) or have styles get `<model>.skins.json` next to the model: the swapped materials with their textures in `textures/`. Models of styles are exported too and listed per item in `index.json`.

## Running locally

A first full export is much faster from a local Dota 2 install than from Steam:

```bash
HF_TOKEN=... node index.js --game "<steam library>/steamapps/common/dota 2 beta/game/dota"
```

with Source2Viewer-CLI in `./vrf`. `--hero pudge` exports one hero with its items, `--limit N` stops after N models. Commit `state.json` afterwards so the workflow only exports what changes later. An `items_game.json` next to the script is read instead of downloading it.

### Everything from this PC, with one click

- **`Update.cmd`** exports and uploads what the game changed since the last export.
- **`Restore everything.cmd`** exports and uploads everything again, as on the first run: for when the datasets are lost. It takes many hours.

Both run `export-local.ps1`: it finds Dota 2 through Steam's libraries (or asks), takes the Hugging Face token from `temp/hf_token.txt` (or asks), then runs the models (`index.js`, with the materials' dynamic parameters, cube maps and cloth), the game data (`data.js`), the sounds (`sounds.js`), the particles (`particles.js`), the voice lines and sound lists (`audio.js`, which need the sounds uploaded), the scenes (`scenes.js`) and the models the particles listed. A failed step does not stop the others; a table at the end says how each went. The state files are committed (not pushed). Every script also takes `--force` on its own to do everything again.

Needed: Node.js, Source2Viewer-CLI (the release the workflow names, win-x64) in `./vrf`, a Hugging Face token with write access. The datasets: `<user>/dota2-models`, `<user>/dota2-sounds`, `<user>/dota2-scenes`.

## How it runs

The **Export Models** workflow runs every six hours and exports the models that are new or whose game files changed (`state.json` keeps the files each model was made from), in batches of 100, continuing in the next run if it takes longer than five hours. The index is updated after every batch, so the viewer shows new models as they arrive. The game data, sounds, particles and voice lines follow in the same job; the scenes run in a job of their own (`scenes.js`, the map packages downloaded from Steam with the files they use from the game's VPKs), also stopping after five hours and going on next time.

Secrets: `USERNAME` and `PASSWORD` of a Steam account without Steam Guard, `HF_TOKEN` with write access on Hugging Face.
