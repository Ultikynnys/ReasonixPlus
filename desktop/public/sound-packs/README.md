# Sound packs

One folder per pack. A folder holds a `pack.json` manifest and the audio files it
names. Played by `desktop/src/feedback-sounds.ts` through the specs in
`desktop/src/sound-packs.ts`.

Nothing about a pack is hardcoded elsewhere: the Settings cards, the cue to file
table and the audio URLs all come from these folders. Adding a pack is a folder
plus `npm run providers:sync`.

## Layout

```
sound-packs/
  default/
    pack.json
    question_001.ogg
    confirmation_001.ogg
    confirmation_002.ogg
    error_001.ogg
  halo/
    pack.json
    InputRequired.ogg
    ...
```

Audio is served root-absolute from this folder, so `question_001.ogg` inside
`default/` is fetched as `/sound-packs/default/question_001.ogg`.

## Adding a pack

1. Create `sound-packs/<id>/` and drop the audio files in it.
2. Add `pack.json` declaring the same `id`.
3. Run `npm run providers:sync`.
4. Run `npm test`.

`providers:sync` rewrites `../../src/sound-packs.generated.ts`, which embeds every
manifest and lists the files each folder holds. Skipping step 3 fails
`tests/sound-pack-files.test.ts`.

## Removing a pack

Delete the folder, run `npm run providers:sync`, run `npm test`. The cards
disappear and the id leaves the `SoundPackID` union, so a stale reference fails to
compile instead of silently resolving to another pack. A persisted selection that
points at a deleted pack falls back to the default pack.

## Fields

| Field | Type | Meaning |
| --- | --- | --- |
| `id` | string | Declaration id and folder name: lowercase letters, digits and `-` |
| `label` | string | Card title |
| `description` | string | One-line description inside the card |
| `order` | number | Card order, ascending |
| `sounds` | object | Cue id to file name in this folder. Every file must exist; cues may be omitted |

Cue ids are the ones the wire protocol declares: `inputRequired`, `taskComplete`,
`planComplete`, `guardTriggered`. The audio types a pack may hold, and the id the app
reserves for itself, live in `packages/core-utils/src/sound-pack-contract.json`, which the
runtime, the user-pack store and the sync script all read.

## The implicit Nothing pack

The desktop declares one pack of its own, `nothing`, which plays no audio at all.
It has no folder, no manifest and no files, it is always the first card, and it is
the default selection: a fresh install is silent until a real pack is chosen.
Notifications are not audio, so they keep working while `nothing` is active.

`nothing` is therefore a reserved id. A folder of that name fails the sync rather
than rendering a second card with the same id.

## Per-pack audio settings

Each pack stores its own cue sound switch and volume per cue, so switching packs
restores that pack's tuning instead of sharing one global matrix. A cue a pack does
not ship renders as "not in this pack" and its controls stay disabled.

The notification switch per cue is not per pack: it is one list of cues that raise
a desktop notification, so choosing another pack can never silence notifications.

## Licenses

`default/` vendors **Kenney - Interface Sounds** (2020) as individual OGG files
from the CC0 Sounds mirror, licensed **CC0 1.0 Universal** (public domain, no
attribution required; credit to `kenney.nl` appreciated):

- Pack: <https://kenney.nl/assets/interface-sounds>
- Mirror: <https://cc0-sounds.exi.software/collection/kenney_interfacesounds/>
- Re-fetch: `node desktop/scripts/fetch-feedback-sounds.mjs`

`halo/` holds Halo voice lines supplied with the project.
