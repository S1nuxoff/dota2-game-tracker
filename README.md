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

## How it runs

The **Export Models** workflow exports the models that are new or whose game files changed (`state.json` keeps the files each model was made from), in batches of 100, and continues in the next run if it takes longer than five hours.

Secrets: `USERNAME` and `PASSWORD` of a Steam account without Steam Guard, `HF_TOKEN` with write access on Hugging Face.
