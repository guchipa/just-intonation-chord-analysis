# Just Intonation Chord Analysis

Reference implementation of the acoustic analysis described in

> Moriguchi, Sawada, Higuchi, Katsurada, Ohmura,
> "Just Intonation Pitch Control Support System for Ensemble Chord Practice by Beginners,"
> APSIPA ASC 2026.

Given a chord (pitch names, octaves) and one magnitude spectrum, it computes how far
each chord tone deviates, in cents, from its **just-intonation (JI)** target
relative to the chord root. The code is platform independent TypeScript
(no DOM / Web Audio / Node.js APIs), so the spectrum can come from any source
that satisfies the input assumptions below.

The repository also contains an automatic **chord tone detection** module
(`src/chord_detection/`) that identifies which notes are being played.
It is **not part of the paper**; see [Chord tone detection](#chord-tone-detection-not-in-the-paper).
The code exactly as published with the paper is tagged
[`APSIPA2026`](https://github.com/guchipa/just-intonation-chord-analysis/tree/APSIPA2026).

## Processing pipeline and correspondence to the paper

Processing runs in this order (the JI target depends on the root, so root estimation runs first):

| Step | Paper | Function | File |
|------|-------|----------|------|
| 1 | Root estimation | `estimateRoot` | `src/rootEstimation.ts` |
| 2 | JI target frequency | `getJustFrequencies` | `src/calcJustFreq.ts` |
| 3 | Peak search in a ±50 cent window | `evaluateSpectrum` | `src/justAnalyze.ts` |
| 4 | Parabolic interpolation | `quadraticInterpolation` | `src/peakInterpolation.ts` |
| 5 | Cent deviation | `evaluateSpectrum` | `src/justAnalyze.ts` |

1. **Root estimation**: converts the chord tones to pitch classes, tries each
   tone as the root candidate, and matches the interval set against
   `CHORD_DEFINITIONS` (triads, sevenths, sixths and their omitted-5th/3rd forms).
   The candidate with the highest score is marked `isRoot: true`.
2. **JI target frequency**: the root's frequency is its 12-TET frequency
   computed from A4 (`a4Freq`, e.g. 442 Hz). Every other tone gets
   `f_root × JUST_RATIOS[interval mod 12] × 2^floor(interval / 12)`.
3. **Peak search**: around each JI target `f_JI`, the bins in
   `[f_JI · 2^(−c/1200), f_JI · 2^(c/1200)]` (`c = evalRangeCents`, 50 in the paper)
   are searched for the maximum. If that maximum is below `evalThreshold` (dB),
   the tone is reported as not detected (`null`).
4. **Parabolic interpolation**: the peak bin and its two neighbours are converted
   from dB to linear amplitude and fitted with a parabola to get a sub-bin
   frequency estimate `f_peak`.
5. **Cent deviation**: `1200 · log2(f_peak / f_JI)`. A normalized value
   (`centDeviation / evalRangeCents`, clipped to −1…1) is also returned.

## Files

| File | Role |
|------|------|
| `src/justAnalyze.ts` | `evaluateSpectrum`: per-tone peak search, interpolation, cent deviation |
| `src/calcJustFreq.ts` | JI / 12-TET target frequencies and their cent differences |
| `src/peakInterpolation.ts` | Parabolic interpolation (used by `evaluateSpectrum`); spectral centroid as an alternative |
| `src/rootEstimation.ts` | Chord root estimation from pitch classes |
| `src/constants.ts` | A4 default (442 Hz), pitch names, pitch classes, chord definitions, octave range, JI ratios |
| `src/types.ts` | `Pitch` type and its zod schema (`FormSchema`) |
| `__tests__/` | Unit tests (vitest) |

Files for chord tone detection are listed in [Chord tone detection](#chord-tone-detection-not-in-the-paper).

## Input spectrum assumptions

`evaluateSpectrum` expects the spectrum produced by the Web Audio API in the
original system:

- `spec`: result of `AnalyserNode.getFloatFrequencyData()` (dB, length `fftSize / 2`)
- `fftSize`: 32768
- Sampling frequency: 48 kHz (bin spacing 48000 / 32768 ≈ 1.46 Hz)
- Window: Blackman, as specified for `AnalyserNode` in the Web Audio API
- `freq`: centre frequency of each bin, `freq[i] = i · sampleRate / fftSize`, ascending

Any other source (offline FFT, native audio API) works if it provides the same
dB-scaled, Blackman-windowed spectrum and matching bin frequencies.

## Usage

```ts
import { estimateRoot } from "just-intonation-chord-analysis/rootEstimation";
import { evaluateSpectrum } from "just-intonation-chord-analysis/justAnalyze";
import type { Pitch } from "just-intonation-chord-analysis/types";

const sampleRate = 48000;
const fftSize = 32768;
const binCount = fftSize / 2;
const freq = Array.from({ length: binCount }, (_, i) => (i * sampleRate) / fftSize);

// spec: Float32Array(binCount) filled by analyserNode.getFloatFrequencyData(spec)
declare const spec: Float32Array;

let chord: Pitch[] = [
  { pitchName: "C", octaveNum: 4, isRoot: false, enabled: true },
  { pitchName: "E", octaveNum: 4, isRoot: false, enabled: true },
  { pitchName: "G", octaveNum: 4, isRoot: false, enabled: true },
];

// 1. Mark the root (here: C4)
estimateRoot(chord, (updated) => {
  chord = updated;
});

// 2–5. Deviation of each tone from its JI target
const results = evaluateSpectrum(
  spec,
  freq,
  chord,
  50,   // evalRangeCents: search window ±50 cent
  442,  // a4Freq [Hz]
  -100, // evalThreshold [dB]: peaks below this are treated as not detected
);

for (const [i, r] of results.entries()) {
  // r.centDeviation: cents from the JI target (null if not detected or disabled)
  // r.deviation: centDeviation / evalRangeCents, clipped to [-1, 1]
  console.log(chord[i].pitchName, r.centDeviation);
}
```

`evaluateSpectrum(spec, freq, pitchNameList, evalRangeCents, a4Freq, evalThreshold, options?)`
returns one `EvaluationResult` per input tone, in input order. Tones with
`enabled: false` return `null`. If the chord does not have exactly one root,
the result is an empty array. Pass `{ includeDebug: true }` as `options` to also
get the search range and peak bin of each tone.

Pitch names are `C C# D Eb E F F# G G# A Bb B`; octaves are 1–6.

## Chord tone detection (not in the paper)

`src/chord_detection/` estimates the chord tones (pitch names and octaves)
from raw mono PCM, so that the chord to be evaluated can follow the ensemble
automatically. It only **identifies notes**; the JI deviation is still measured
by `evaluateSpectrum` above.

### Pipeline

| Stage | Module | What it does |
|-------|--------|--------------|
| ① Frame analysis | `HarmonicNoteDetector` (`noteDetection.ts`) | Detects the notes in each 0.25 s frame |
| ② Temporal aggregation | `noteEventsToPitchList` (`chordToneEstimation.ts`) | Selects the chord tones from the note events in a window and marks the root |
| ③ Streaming hysteresis | `StreamingChordTracker` (`streamingChordTracker.ts`) | Runs ①② on a sliding 1 s window and confirms a chord after 2 consistent cycles |

**① Frame analysis** (per 0.25 s frame; the frame length is the minimum that
separates adjacent semitones around C2):

1. Frames with RMS < 0.01 are skipped. Input of 48 kHz or more is decimated by 2.
2. **Measurement**: the power at each semitone of C2–B6 (and the harmonic
   positions above them) is measured with the Goertzel algorithm (single-bin
   DFT, `goertzel.ts`) on a Hann-windowed frame. Each note is measured at several
   detuned offsets up to ±45 cent and the maximum is taken, because players
   deviate from the equal-tempered grid.
3. **Noise-floor normalization**: each bin is converted to dB SNR over a local
   noise floor (median over ±6 semitones) and mapped to 0–1 with 40 dB headroom.
   Floors more than 45 dB below the frame maximum are raised to that level.
   This keeps a quiet player detectable next to a loud one.
4. **Candidate selection**: a candidate must be a local peak over its neighbouring
   semitones. Below G3 it must also have harmonic support at 2f or 3f, which
   rejects mains hum and low-frequency rumble.
5. **Harmonic-sum salience and greedy subtraction**: the salience of a candidate is the
   weighted sum of its 1f–6f harmonics (weights 1, 0.6, 0.45, 0.35, 0.3, 0.25).
   The most salient candidate is accepted. If the note an octave (or a twelfth)
   below has a strong fundamental and comparable salience, that lower note is
   accepted instead. The harmonics (1f–12f) of the accepted note are then
   subtracted from the residual: 90 % if the note has harmonics, 30 % if it is a
   pure tone. This repeats on the residual, up to 6 notes per frame, which removes
   overtones that are stronger than their fundamental.

**② Temporal aggregation**: events are grouped by MIDI note and scored by
total duration × maximum amplitude. Adjacent semitones are merged into the
stronger one. A note is dropped if its score is below 50 % of the note an
octave or a twelfth below it (residual overtone), or below 40 % of the note an
octave above it (difference-tone ghost of a just fifth). Notes are kept
relative to the strongest one, up to 6. The root comes from `estimateRoot`,
or is the lowest note if no chord definition matches.

**③ Streaming**: PCM chunks of any size are pushed into a ring buffer
(`float32RingBuffer.ts`). Each frame runs ①, ② runs on the last 1 s of
events, and a new chord is confirmed when the same result appears twice in a
row. Typical latency is about 0.6 s, and about 1 s when the chord changes.

Known limitations (by design, to suppress false positives):

- Octave doublings (e.g. C3 + C4) resolve to the lower note.
- Chords that contain a minor second cannot be detected.
- Notes below C2, and low pure tones without harmonics, are not detected.
- Notes more than 45 dB weaker than the loudest player are not detected.

The default parameters (`NOTE_DETECTION_DEFAULTS`, `CHORD_TONE_ESTIMATION_DEFAULTS`,
`STREAMING_CHORD_ESTIMATION_DEFAULTS`) were tuned on 61 recordings of
wind-instrument ensembles. The recordings are not included in this repository.

### Files

| File | Role |
|------|------|
| `src/chord_detection/noteDetection.ts` | `HarmonicNoteDetector`: frame analysis ① |
| `src/chord_detection/chordToneEstimation.ts` | `noteEventsToPitchList`: temporal aggregation ② |
| `src/chord_detection/streamingChordTracker.ts` | `StreamingChordTracker`: streaming hysteresis ③ |
| `src/chord_detection/goertzel.ts` | Goertzel single-bin power |
| `src/chord_detection/float32RingBuffer.ts` | PCM ring buffer for streaming |
| `src/chord_detection/noteDetector.ts` | `NoteDetector` interface and `DetectedNoteEvent` type |
| `src/chord_detection/pitchListKey.ts` | Order-independent key used to compare chords |
| `scripts/` | Evaluation CLIs on recordings (Node.js, ffmpeg) |

### Usage

```ts
import {
  HarmonicNoteDetector,
  NOTE_DETECTION_ESTIMATION_OPTIONS,
} from "just-intonation-chord-analysis/chord_detection/noteDetection";
import { noteEventsToPitchList } from "just-intonation-chord-analysis/chord_detection/chordToneEstimation";
import { StreamingChordTracker } from "just-intonation-chord-analysis/chord_detection/streamingChordTracker";

const sampleRate = 48000; // pass the actual capture rate
const detector = new HarmonicNoteDetector({ sampleRate });

// Batch: a recorded mono buffer → chord tones (root marked with isRoot)
declare const recording: Float32Array;
const events = await detector.detectNotes(recording);
const chord = noteEventsToPitchList(events, NOTE_DETECTION_ESTIMATION_OPTIONS);

// Streaming: push PCM chunks as they arrive, then poll
const tracker = new StreamingChordTracker({ detector, sampleRate });
declare const chunk: Float32Array;
tracker.push(chunk);
const update = await tracker.poll();
if (update.changed) {
  // update.changed: newly confirmed chord tones (Pitch[])
}
// update.pending: the latest estimate differs from the confirmed chord
// update.silent: no note was detected in the latest frame
```

If the chord is changed outside the tracker (e.g. edited by hand), call
`tracker.syncConfirmedPitchList(pitchList)` so that tracking resumes correctly.

### Evaluation on recordings

```sh
pnpm eval:chords <recording-dir> --root-optional
pnpm eval:chords <recording-dir> --root-optional --attenuate 6   # one tone 6 dB weaker
pnpm eval:ablation <recording-dir> --root-optional               # contribution of each mechanism
```

- The ground truth is taken from the last block of each file name, root first:
  `..._Cm_C4-Eb4-G4.webm` means C4 (root), Eb4, G4. Any format that ffmpeg can
  decode is accepted.
- `--root-optional` scores the root as optional (neither missing nor extra),
  for recordings in which the root player may be absent.
- `--attenuate <dB>` weakens each correct tone in turn (only its 1f–6f bands,
  with one FFT per file) to test robustness to level imbalance between players.
- Both the batch path (whole file) and the streaming path (the chord confirmed
  for the longest time) are scored with exact match, note-level F1,
  missing / extra notes, and the root-is-lowest rate.

## Development

Requires Node.js 20+ and pnpm.

```sh
pnpm install
pnpm test       # vitest
pnpm typecheck  # src without DOM / Node.js types, then tests and scripts with Node.js types
```

## Citation

See [`CITATION.cff`](CITATION.cff).

## License

[MIT](LICENSE)
