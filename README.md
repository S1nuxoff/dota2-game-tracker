# Dota 2 Model Tracker

Exports every Dota 2 item and hero model from the game files to glTF (`.glb`), with materials, textures (inside the file) and animations, using [Source 2 Viewer](https://github.com/ValveResourceFormat/ValveResourceFormat), and uploads them to a Hugging Face dataset.

Only the files a model needs are downloaded from Steam: the model, its meshes, materials, textures and animations, found by following each file's references. Item models come from `items_game.json` of [dota2-file-tracker](https://github.com/S1nuxoff/dota2-file-tracker), hero models from `scripts/npc/npc_heroes.txt`.

## Using the models

The dataset keeps the game's paths, with `.glb` instead of `.vmdl`:

```
https://huggingface.co/datasets/<user>/dota2-models/resolve/main/models/heroes/pudge/pudge.glb
```

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

## How it runs

The **Export Models** workflow runs every six hours and exports the models that are new or whose game files changed (`state.json` keeps the files each model was made from), in batches of 100, continuing in the next run if it takes longer than five hours. The index is updated after every batch, so the viewer shows new models as they arrive.

Secrets: `USERNAME` and `PASSWORD` of a Steam account without Steam Guard, `HF_TOKEN` with write access on Hugging Face.
