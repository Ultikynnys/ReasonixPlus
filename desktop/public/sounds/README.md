# Feedback cue sounds

Static audio for the desktop **feedback cues** (plan complete, task complete,
needs attention, guard/error). Played by `desktop/src/feedback-sounds.ts`.

These replaced the previous in-code WebAudio oscillator synthesis, which sounded
thin and harsh.

## Source

**Kenney — Interface Sounds** (2020), obtained as individual OGG files from the
CC0 Sounds mirror:

- Pack: <https://kenney.nl/assets/interface-sounds>
- Mirror: <https://cc0-sounds.exi.software/collection/kenney_interfacesounds/>
- Re-fetch: `node desktop/scripts/fetch-feedback-sounds.mjs`

## License

**CC0 1.0 Universal (public domain).** Free for personal and commercial use; no
attribution required. Credit to Kenney (`kenney.nl`) is appreciated but not
mandatory. Full terms: <https://creativecommons.org/publicdomain/zero/1.0/>

## Files

| File | Cue | Notes |
| --- | --- | --- |
| `confirmation_001.ogg` | `taskComplete` | short, crisp positive confirm |
| `confirmation_002.ogg` | `planComplete` | fuller positive confirm |
| `question_001.ogg` | `inputRequired` | "needs your attention" |
| `error_001.ogg` | `guardTriggered` | error / guard tone |

`SOURCES` in `desktop/src/feedback-sounds.ts`, the `FILES` list in
`desktop/scripts/fetch-feedback-sounds.mjs`, and this table must stay in sync.
