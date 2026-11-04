# chordlens-core

Reference implementation of the acoustic analysis described in

> Moriguchi, Sawada, Higuchi, Katsurada, Ohmura,
> "Just Intonation Pitch Control Support System for Ensemble Chord Practice by Beginners,"
> APSIPA ASC 2026.

Given a chord (pitch names, octaves) and one magnitude spectrum, it computes how far
each chord tone deviates, in cents, from its **just-intonation (JI)** target
relative to the chord root. The code is platform independent TypeScript
(no DOM / Web Audio / Node.js APIs), so the spectrum can come from any source
that satisfies the input assumptions below.

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
| `src/constants.ts` | Pitch names, pitch classes, chord definitions, octave range, JI ratios |
| `src/types.ts` | `Pitch` type and its zod schema (`FormSchema`) |
| `__tests__/` | Unit tests (vitest) |

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
import { estimateRoot } from "@chordlens/core/rootEstimation";
import { evaluateSpectrum } from "@chordlens/core/justAnalyze";
import type { Pitch } from "@chordlens/core/types";

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

## Development

Requires Node.js 20+ and pnpm.

```sh
pnpm install
pnpm test       # vitest
pnpm typecheck  # tsc --noEmit (no DOM lib)
```

## Citation

See [`CITATION.cff`](CITATION.cff).

## License

[MIT](LICENSE)
