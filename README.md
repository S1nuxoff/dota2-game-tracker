# Dota 2 Game Tracker

Exports the whole of Dota 2 from the game files to public Hugging Face datasets, and keeps them up to date after every game update: every model, texture, picture, video, sound, particle effect, map, script and text, at the game's own paths and in ordinary formats (glTF, PNG, MP3, JSON). [Dotadex](https://s1nuxoff.github.io/Dotadex/) is built on them, and they are open to everyone.

| Dataset | What |
|---|---|
| [dota2-data](https://huggingface.co/datasets/Sqls1/dota2-data) | every script and text as JSON (items_game, heroes, abilities, 28 languages); `dotadex/`: files made for the site |
| [dota2-images](https://huggingface.co/datasets/Sqls1/dota2-images) | every picture of the interface (icons, portraits, loading screens) |
| [dota2-videos](https://huggingface.co/datasets/Sqls1/dota2-videos) | every video of the interface |
| [dota2-models](https://huggingface.co/datasets/Sqls1/dota2-models) | every 3D model as `.glb`, with its animations, cloth, faces, attachments |
| [dota2-textures](https://huggingface.co/datasets/Sqls1/dota2-textures) | every texture of the 3D world, on its own, as PNG |
| [dota2-particles](https://huggingface.co/datasets/Sqls1/dota2-particles) | every particle system and its textures, the engine's defaults |
| [dota2-sounds](https://huggingface.co/datasets/Sqls1/dota2-sounds) | every sound, and the sound events |
| [dota2-maps](https://huggingface.co/datasets/Sqls1/dota2-maps) | every map and scene as `.glb` |

[DATA.md](DATA.md) maps every file: which dataset holds it, which script writes it, what reads it. Each dataset also has `files.json` (every file with its size) at its root, and the pictures and models a `names.json` (the names people know).

## Layout

```
export.js    the whole export in one process (what the workflow runs)
exporters/   one script per kind of data, each can also run on its own:
             models.js, data.js, gamefiles.js, images.js, textures.js, videos.js, sounds.js,
             audio.js, particles.js, scenes.js, names.js, files-list.js
lib/         what they share: reading the game (source.js, steam.js), Valve's formats
             (keyvalues.js, kv3.js, resource.js, vpk-writer.js), uploading (hf.js), and the
             parts of a model's export (skins, cloth, flex, materials, web-glb, summons, ...)
tools/       run by hand: cards.js (the datasets' cards), stage-upload.js (big uploads),
             web-glb-backfill.js (lighter copies of glb files uploaded before they existed)
state/       what each exporter already did (CRCs, hashes, the game version), so a run exports
             only what changed; committed after every run
export-local.ps1, Update.cmd, Restore everything.cmd   everything from this PC, with one click
```

Every script runs from the repository's root: `node exporters/<name>.js ...`.

## How it runs

The **Export** workflow runs every six hours with two jobs side by side:

- **export**: `export.js`, every exporter in one process (models, game data, scripts and texts, pictures, textures, videos, sounds, particles, voice lines, names, the lists of files) with one Steam login and the game opened once. When neither the game's version nor the code changed since the last full run (`state/run.json`), it stops at once without downloading anything; otherwise each exporter exports what changed against its own state file and removes what the game removed. `EXPORT_STEPS=images,videos` (the workflow's `steps` input) runs only some.
- **scenes**: the maps and scenes. Map packages are big and slow to convert, so they get their own job (and its own 5.5-hour budget) and never hold up the rest; it stops starting new maps after five hours and goes on in the next run.

Both commit their state files back to `main` at the end.

Secrets: `USERNAME` and `PASSWORD` of a Steam account without Steam Guard, `HF_TOKEN` with write access on Hugging Face.

## Running locally

Needed: Node.js 22, [Source2Viewer-CLI](https://github.com/ValveResourceFormat/ValveResourceFormat) (the release the workflow names) in `./vrf`, a Hugging Face token with write access, and Dota 2 installed (a local install is much faster than downloading from Steam).

```bash
npm ci
HF_TOKEN=... node exporters/models.js --game "<steam library>/steamapps/common/dota 2 beta/game/dota"
```

Every exporter takes `--game <path>` (or a Steam login), `--force` (everything again) and most `--no-upload` (write to `temp/` only). Commit the changed files in `state/` afterwards, so the workflow does not do the same again.

- **`Update.cmd`** exports and uploads what the game changed since the last export.
- **`Restore everything.cmd`** exports and uploads everything again (many hours), for when the datasets are lost.

Both run `export-local.ps1`: it finds Dota 2 through Steam (or asks), takes the token from `temp/hf_token.txt` (or asks), runs every exporter in order and commits the state files (not pushed).

### Big uploads

Hugging Face allows about 128 commits an hour per dataset. For a big first export, set `HF_STAGE_DIR=<folder>`: the exporters then put their files in `<folder>/<dataset>/...` instead of sending them, and `node tools/stage-upload.js <folder>` sends each folder with `hf upload` (many connections, large commits, resumable). `MODEL_SHARD=k/n` splits the models between n parallel runs. Many small files (textures, particles) go best in one `hf upload`; parallel ones run into the commit limit.
