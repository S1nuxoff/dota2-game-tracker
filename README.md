# Dota 2 Model Tracker

Exports Dota 2 item models from the game files to glTF (`.glb`) with their materials, textures and animations, using [Source 2 Viewer](https://github.com/ValveResourceFormat/ValveResourceFormat).

Only the files a model needs are downloaded from Steam: the model, its meshes, materials, textures and animations, found by following each file's references. Item models come from `items_game.json` of [dota2-file-tracker](https://github.com/S1nuxoff/dota2-file-tracker).

## Running

Run the **Export Models** workflow from the Actions tab with a comma separated list of:

- item IDs, e.g. `4007`
- item names, e.g. `Dragonclaw Hook`
- model paths, e.g. `models/heroes/pudge/pudge.vmdl`

The `.glb` files and `summary.txt` (files used, sizes, anything missing) are attached to the run as the `models` artifact.

The workflow needs `USERNAME` and `PASSWORD` secrets of a Steam account without Steam Guard.
