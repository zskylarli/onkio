# Onkio

A client-side web app that turns a music collection export into a navigable 2D
map, built primarily for constructing DJ sets by walking a path through the
map. It reads a **rekordbox collection XML** (preferred) or an Apple Music
`Library.xml`.

**Trust model:** static site, no backend. Nothing leaves the browser except
metadata lookups keyed on artist/title strings. No audio, no file contents,
no file paths.

## Quick start

```bash
npm install
npm run dev     # development server at http://localhost:5173
npm test        # vitest suite (351 tests incl. full-scale pipeline)
npm run build   # type-check + production build to dist/
npm run preview # preview production build at http://localhost:4173
```

Open the app and drop a collection XML on the sidebar. The format is detected
from the file, and the map renders immediately from parse-time data.

## Where BPM and key come from

**Use a rekordbox export.** In rekordbox: *File → Export Collection in xml
format*. Its `AverageBpm` and `Tonality` are your own analysis of the actual
audio, so they are taken as ground truth (confidence 1, source `rekordbox`) and
only a manual override outranks them. On the reference collection this is 100%
BPM and 100% key coverage at import, with no network calls at all.

Online lookups are the fallback and are demoted to a collapsed **Online lookups
(advanced)** panel. They are best-effort: no free API reliably knows the BPM of
a DJ edit and none of the reachable ones return key (see the source table
below), so an Apple Music export alone will leave the map largely uncolored.

Notes on the rekordbox format, since they are easy to get wrong:

- `TotalTime` is **seconds**, where Apple's `Total Time` is milliseconds.
- `Tonality` follows the user's key-display setting — classical (`Am`),
  Camelot (`8A`), or Open Key (`1m`). All three normalize through `toCamelot`.
- There is no Persistent ID, so `pid` is `rb:` + a hash of the decoded file
  path. The path survives a re-export; `TrackID` is a database row id and does
  not, which matters because overrides are keyed on `pid`.
- Playlists are a `NODE` tree; folders flatten into `Folder / Playlist` names.
- The Pioneer sampler one-shots that ship in every collection (`NOISE`,
  `SINEWAVE`, drum hits — a few seconds long, no BPM) are dropped and counted,
  rather than left to distort the map.

## Architecture

```
/src
  /parse      streaming plist + rekordbox XML parsers (workers) → Track[]
  /music      Camelot key normalization, cyclic encoding, adjacency
  /enrich     normalization, IndexedDB-cached lookup adapter, priority queue
  /dsp        FFT, tempo (spectral flux + autocorrelation), key (chroma +
              Krumhansl-Schmuckler), timbre (MFCC + spectral shape + onsets),
              worker pool
  /features   Track[] → scaled feature matrix (TF-IDF playlists, genre, tags,
              BPM/key/year/duration, timbre) with the mixability⟷taste and
              sound-influence sliders
  /embed      SVD → seeded UMAP → seeded k-means (worker)
  /render     deck.gl scatter + binned color palettes (cluster/BPM/key/decade)
  /views      set builder (+M3U8/text export), taste, gaps (enclosed-KDE),
              track search and highlight precedence
  /local      File System Access folder walk + pure trailing-segment path
              matching from export Location to file on disk
  /store      IndexedDB: lookup cache, manual overrides, queue state, library,
              music folder handle
```

Key design decisions, per the plan this implements:

- **Parsing** is a hand-rolled streaming plist tokenizer in a worker; track
  dicts are emitted in batches and never accumulated, so memory stays flat.
  Playlists are joined via `Track ID → Persistent ID`; all caching is keyed on
  Persistent ID (stable across exports). Auto playlists (`Library`, `Music`,
  `Downloaded`, `Recently Added`, master/distinguished flags, exact-duplicate
  membership) are dropped and reported.
- **Sparsity mitigations** (82% of playlisted tracks sit in exactly one
  playlist): TF-IDF weighting of the incidence matrix, per-block RMS scaling,
  artist propagation, and external tags carrying full weight.
- **Key is encoded cyclically** (sin/cos of Camelot wheel position + a
  major/minor bit) — 12A and 1A are adjacent, as they must be.
- **BPM** additionally gets an octave-folded encoding so half/double-time
  variants land together; suspected half-time values are flagged in the UI,
  never silently doubled.
- **Determinism:** UMAP and k-means run with a seeded PRNG; the map is stable
  across runs.
- **Every color mode is binned**, never a continuous ramp: 24 Camelot slots on
  a hand-spaced hue set (minor deep, major bright), one bin per decade, and
  adaptive BPM groups. At 6k points a smooth gradient can't be read back, so
  each mode ships discrete classes plus a live legend with counts.
- **BPM bin width follows the collection.** Fixed 10-BPM groups suit a general
  library but collapse a single-genre crate into one color — 77% of the
  reference rekordbox collection is 120–130. The width is picked from the 5th–
  95th percentile spread (round numbers only, 1–10 BPM), so that crate bins at
  2 BPM and its largest bin holds 27% instead of 77%. Outliers are absorbed by
  the end bins, which label themselves `<120` / `134+`.
- **Gaps live on the map, not in a list.** Toggling `Gaps` rings each
  enclosed empty region; clicking one zooms in, names the neighborhoods on
  either side, and offers search queries that blend them.
- **One highlight channel.** Searching, suggestion mode and the playlist
  filter all light points up the same way, so they resolve by precedence in
  `views/highlight.ts` instead of overwriting each other, and the sidebar says
  which one won and what it paused. Search matches every track, not only the
  20 it lists, so searching an artist shows where that artist lives.

## Laying the map out by how tracks actually sound

By default the map is drawn from metadata, which means it can only ever
rearrange judgments already in the collection — playlists, genre strings, BPM.
The **Sound** panel adds a term computed from the audio itself, so two tracks
can land together because they share a character no field records.

The audio is a local file where a music folder is connected (see below), and
otherwise the same 30-second iTunes preview already fetched for hover playback.
A file is cut to a 30-second excerpt taken a third of the way in before it is
measured, because both kinds of vector are standardized against each other in
one feature matrix: measuring whole masters beside short previews would give the
map an axis that separates tracks by where their audio came from rather than by
how they sound. Each excerpt is decoded once and
reduced to a 38-number fingerprint: 13 MFCCs with their frame-to-frame
variation, spectral centroid / rolloff / flatness / bandwidth, zero-crossing
rate, loudness spread, onset rate, and a percussivity ratio. Frames below a
loudness floor are skipped, so a long ambient intro doesn't drag a whole track
toward "quiet".

**Measured on 31 real previews across four deliberately distant genres** (each
verified against the requested artist, because iTunes will answer "Lamb of God"
with a worship cover and quietly poison the labels): the nearest neighbour in
timbre space shares its genre for **27 of 31 tracks**, against a 23% chance
rate, with mean within-genre distance 6.05 versus 8.85 across genres. The raw
features order themselves the way the physics demands — mean spectral centroid
runs 1053 Hz for classical, 1697 for R&B, 2791 for metal, 2859 for house, and
house carries the most onsets per second. Classical and metal separate
perfectly (8/8 each); house is the weakest at 5/8, and its confusions are with
metal and R&B rather than anything random, which is the honest limit of a
loudness-and-brightness description of dense, heavily compressed music.

Two consequences shape the design:

- **Sound is a weighted term, not the layout.** A single slider runs its
  influence from off to dominant, defaulting low. A 38-number average over 30
  seconds is a real signal, not a "sounds like" oracle, and on a crate that is
  nearly all house it discriminates less than the collection's own 68 rekordbox
  genre strings do. Blending beats replacing.
- **Missing audio must not become a musical property.** Previews exist for
  about two thirds of the crate and never for the user's own bounces, and a
  music folder is not always connected. The
  timbre block is standardized over only the tracks that have it and left at
  the mean for the rest, so an unanalyzed track is pulled by its metadata alone
  instead of drifting toward other unanalyzed tracks. `timbreEmbedding.test.ts`
  runs the real pipeline at 60% coverage and asserts no k-means cluster exceeds
  90% unanalyzed — without this, the map grows a "tracks we couldn't hear"
  island that is indistinguishable from a genuine region.

Analyzed tracks draw solid; tracks placed from metadata alone draw as hollow
rings, so it is always visible which parts of the map were heard.

## Playing your own files

A 30-second preview only exists for catalogue releases, which caps hover
playback at roughly 60% of a DJ crate and at 0% of personal edits and
unreleased bounces. The **Music folder** panel closes that gap: the user grants
one folder, and tracks are matched to files automatically using the `Location`
path the collection export already carries. There is no per-track attachment.

- **Mechanism** is the File System Access API (`showDirectoryPicker`, then
  recursive `entries()`), so it is **Chromium only**. Firefox and Safari have no
  directory picker; the panel says so and previews keep working there.
- **Matching** (`src/local/match.ts`) scores every file sharing a track's
  filename by how many *trailing* path segments agree, because the exported
  root is usually gone while the tail survives a move to another machine. A bare filename match
  is just the weakest score, not a separate rule. Comparison folds case and
  Unicode composition, since macOS stores filenames decomposed while an export
  may carry the composed form. **A tie at the best score is reported as
  ambiguous and left unresolved** — one `Intro.mp3` per album is normal, and a
  wrongly bound file would be played, analyzed and embedded as if it were the
  track. The readout names resolved, ambiguous and not-found separately.
- **Persistence**: directory handles are structured-cloneable, so the folder
  itself is remembered in IndexedDB (`src/store/db.ts`). Permission is not:
  every reload starts at `queryPermission`, and re-reading needs one click
  through `requestPermission` from a user gesture.
- **Availability is never written into the library.** It is only true while a
  folder is authorized, so `collectionCoverage` takes the resolved pids as an
  argument rather than reading a field, and a saved library can never claim
  local audio for a folder that has since moved.
- **One object URL at a time.** A blob URL pins its whole file in memory, so
  playback holds exactly one and revokes it on every switch; analysis revokes
  as soon as the decode is done.

### How audio gets triggered

Clicking a dot pins its popover, whose Play button always plays. Hover autoplay
is a separate opt-in: the **Browsing** toggle in the map toolbar, persisted in
`localStorage` and **off by default**, because playing on every hover is
intrusive and a hover can now read a whole file off disk.

The policy is pure and tested in `src/views/hoverPlay.ts`, since each of these is
only noticeable by ear:

- **Hover audio is transient; click audio is deliberate.** Pointer movement
  silences what a hover started and never touches what a click started, so
  moving the pointer does not cut off the track whose Play button was pressed.
- **Never restart what is already playing.** `deck.gl` fires `onHover` on every
  pointer move, not on entering a dot, and assigning `src` restarts from zero
  even when the value is unchanged. A dot already playing is left alone, and a
  dot left and re-entered resumes where it paused.
- **The dwell is the throttle.** Every pointer move cancels a dwell that has not
  fired, so a sweep across a dense region issues no file reads at all. A local
  file waits 550 ms against a preview's 350 ms, because a file read and decode
  cannot be abandoned once begun.
- **A dwell can outlive its dot.** Opening a file takes long enough for the
  pointer to move on, so hover playback re-checks what is under the pointer after
  the read and drops the result if it has changed.
- **Autoplay policy.** Audio is blocked until the page has been clicked;
  enabling Browsing mode is itself that click. The gap is a reload that restored
  the setting as on and was hovered before anything was clicked, which shows a
  toolbar note instead of failing silently. `NotAllowedError` is distinguished
  from the `AbortError` a superseded load raises mid-sweep.

## External sources (all behind `src/enrich/adapter.ts`)

Verified 2026-08-11; GetSongBPM re-verified 2026-08-12:

| Source | Status | Notes |
|---|---|---|
| Deezer public API | alive, no auth | `bpm` only on `/track/{id}` (search→detail, 2 calls per hit); no CORS headers → JSONP; ~50 req/5 s |
| GetSongBPM | alive, free key | served from `api.getsong.co`, **not** the documented `api.getsongbpm.com` (403 behind a Cloudflare challenge for every non-browser client); sends `access-control-allow-origin: *`, so the browser calls it directly and a proxy is only an override; `/search/` already returns tempo + key, so 1 call per hit; user-supplied key in localStorage; attribution backlink required (present in UI); ~3000 req/h |
| iTunes Search | alive, no auth | ~20 req/min hard limit (403 beyond); per-term poisoned CORS cache → JSONP; source of `previewUrl` for DSP + hover playback |
| MusicBrainz | alive, no auth | CORS ok, 1 req/s; tags essentially absent for dance music |
| Discogs | needs a token | unauthenticated search returns an empty result set, not an error |
| Spotify audio-features | **dead** | deprecated 2024-11-27, do not revisit |
| AcousticBrainz | **dead** | API shut down, do not revisit |

**GetSongBPM against a real Apple library** (1,000 tracks, seeded sample,
`scripts/measure-getsongbpm.ts`; raw results in
`test/fixtures/getsongbpm-results.json`): 31.2% of tracks matched, and nearly
all of those carried both tempo and key. That is the ceiling for a library the
DJ never analyzed, and it is the only source of key that does not require
listening to audio.

The other 3,381 tracks were swept afterwards (`--n=all --exclude=` the trial's
checkpoint, raw results in `test/fixtures/getsongbpm-results-remainder.json`)
and came back at 31.0%, which says the seeded sample was an honest one. The two
checkpoints together resolve 1,351 tracks of the library to a trustworthy BPM
and key; `scripts/emit-analyzed-rekordbox.ts --full` writes them as
`test/fixtures/apple_getsongbpm_analyzed_full.xml`, beside the 311-track file
the trial alone produced.

Two things the trial found that the code now depends on. Search results already
carry `tempo`, `key_of` and `open_key` for every match, so the per-song detail
call was pure duplicated cost and is gone — one request per track instead of
two. And `artistScore` in `src/enrich/match.ts` was accepting plain substring
containment, which matched "eli" (the normalized primary of "Eli & Fur") inside
"feliciano" and "ksi" inside "quicksilver": six confidently wrong matches, and
since `match.ts` is shared, the same hole was open on Deezer. Containment now
has to land on whole words and the contained name has to be at least four
characters. `test/getsongbpm.test.ts` replays the recorded trial and pins which
matches that drops.

A title-only fallback was measured and **rejected**: it lifts the apparent hit
rate by ~4pp, but 54 of the 59 extra matches were wrong (BTS to 家入レオ, Dua
Lipa to 本田雅人). A bare title is ambiguous enough that the wrong song
outranks nothing at all, and the cross-script rule — which waives artist
agreement when two names use different alphabets, so that 米津玄師 can match
Kenshi Yonezu — then waves them through. It survives only behind `--fallback`
in the measurement script. Every source in `src/enrich` queries with the artist
it has, which is what keeps that waiver honest.

**Measured catalogue coverage** on a 24-track stride sample of the reference
rekordbox crate — the number that decides whether any online-metadata feature
is worth building:

| | track match | useful descriptor |
|---|---|---|
| iTunes | 58% | genre string + release year + preview URL |
| Deezer | 21% | `gain` (loudness), `rank` (popularity), preview |
| MusicBrainz | 17% | tags on 4% |
| Deezer artist-level | 50% | fan count |
| any track-level | 67% | — |

Two conclusions. Deezer's `bpm` is 0 even for catalogue staples, so it is not a
tempo source at any coverage. And an online genre string is a *downgrade* on a
DJ crate: iTunes returns 9 coarse genres ("Dance", "Electronic") where the
collection's own rekordbox `Genre` field is 85% populated across 68 specific
ones ("Tech House", "Bass House", "UK Garage / Bassline"). The missing third is
pool-only edits and the user's own bounces, which no catalogue will ever hold.

The one thing an online source gives that metadata cannot is the preview URL,
which is why iTunes stays in the cascade at 58% coverage: it is the input to
the DSP below, not a metadata source worth trusting.

In-browser DSP (per-track ~1 s on a 30 s preview, in a 2–4 worker pool;
essentia.js was rejected — AGPL, 9.7 MB, unstable API): tempo via spectral-flux
onset envelope + autocorrelation with parabolic peak interpolation; key via
averaged chroma correlated against Krumhansl-Schmuckler profiles; timbre as
described above. Manual overrides and rekordbox values always win and are never
overwritten by any later pass — on a rekordbox import the DSP runs only for
timbre, which nothing else provides.

## Test fixtures

`test/fixtures/Adryft_recordbox_collection_metadata.xml` is a real rekordbox
export (1,079 entries; 1,059 after sampler one-shots, 29 playlists, ~98% BPM
and key, all `Tonality` values already in Camelot). The rekordbox tests assert
against it directly and skip if it is absent.

`scripts/generate-fixture.mjs` synthesizes a `Library.xml` reproducing the
reference library's measured shape: 6,263 tracks, 147 real + 3 auto
playlists, 93% playlist coverage, ~77% single-playlist membership, 100% genre
coverage with 45% Pop/Alternative, 2 tracks with `Location`, 0 BPM/key,
8.8% Date Added, CJK titles/artists, entity-escaped names.

The pipeline test asserts the §9 anti-circularity property: clusters must
combine tracks from playlists that were never combined by hand (measured:
15/16 clusters mix ≥2 playlists; genre purity 0.52 vs 0.26 chance).

## Features

- **Multiple file import**: Load Apple Music and Rekordbox XMLs together, each as its own collection
- **Audio playback**: Hover or click to play 30-second previews, or connect a local music folder for full tracks
- **Sound-based embedding**: Analyze audio to place tracks by timbre, not just metadata
- **Set builder**: Walk paths through the map to construct DJ sets with smooth transitions
- **Gap detection**: Find holes in your collection and get suggestions to fill them
- **Dark/light mode**: Warm sepia light mode alongside the default dark theme

## Known limits

- Sound analysis describes 30 seconds of a track, not its full arrangement
- Sound analysis describes 30 seconds of a track, not its arrangement; a
  breakdown-heavy record is judged on whichever section is sampled. Without a
  music folder it reaches only tracks with a findable preview (~two thirds of
  the reference crate).
- Playing and analyzing your own files needs a Chromium browser. Firefox and
  Safari ship no directory picker, and the `<input webkitdirectory>` fallback is
  not worth having: it copies the library into memory and forgets it on reload.
- Files are matched by path tail, so two files with the same name in folders that
  both fail to match the export are left unresolved rather than guessed. A track
  renamed on disk since the export will not be found.
- The sound term is only as good as timbre-space nearest neighbours, measured at
  27/31 across distant genres but weaker within a single-genre crate. It is not
  a substitute for listening.
- M3U8 entries reference "Artist - Title" strings unless a track has a local
  `Location`; players resolve by metadata.
