/**
 * evaluateSpectrum の検出判定・補間精度を、AnalyserNode を再現した合成スペクトルで検証する。
 *
 * 条件は実機に合わせる: 48 kHz / fftSize 32768 / smoothingTimeConstant 0.8 /
 * evalRangeCents 50 / evalThreshold -100 dB / A4 = 442 Hz。
 * 奏者音のピークは -40 dB、ノイズフロア (ビン中央値) は -90 dB とする
 * (ノイズフロアが絶対値のしきい値 -100 dB より高い、実録音で多い状況)。
 */
import { getJustFrequencies } from "../src/calcJustFreq";
import {
  EVAL_MARGIN_DB_DEFAULT,
  NOISE_FLOOR_MIN_BINS,
  NOISE_FLOOR_RANGE_SEMITONES,
} from "../src/constants";
import {
  estimateLocalNoiseFloorDb,
  evaluateSpectrum,
  findHarmonicInterference,
  getHarmonicInterference,
} from "../src/justAnalyze";
import type { EvaluateSpectrumOptions } from "../src/justAnalyze";
import type { Pitch } from "../src/types";
import {
  makeFreqBins,
  simulateAnalyserSpectrum,
  type SimTone,
} from "./helpers/analyserNodeSim";
import { legacyEvaluateSpectrum } from "./helpers/legacyEvaluateSpectrum";

const SAMPLE_RATE = 48000;
const FFT_SIZE = 32768;
const SMOOTHING = 0.8;
const EVAL_RANGE_CENTS = 50;
const EVAL_THRESHOLD = -100;
const A4 = 442;
const TONE_DB = -40;
const NOISE_DB = -90;

const freq = makeFreqBins(SAMPLE_RATE, FFT_SIZE);

const pitch = (pitchName: string, octaveNum: number, isRoot = false): Pitch => ({
  pitchName,
  octaveNum,
  isRoot,
  enabled: true,
});

/** 周波数を cents セントだけずらす */
const detune = (freqHz: number, cents: number): number =>
  freqHz * 2 ** (cents / 1200);

const simulate = (
  tones: SimTone[],
  seed = 1,
  noiseFloorDb: number | null = NOISE_DB
): Float32Array =>
  simulateAnalyserSpectrum({
    sampleRate: SAMPLE_RATE,
    fftSize: FFT_SIZE,
    smoothingTimeConstant: SMOOTHING,
    tones,
    noiseFloorDb,
    seed,
  });

const evaluate = (
  spec: Float32Array,
  pitchList: Pitch[],
  options?: EvaluateSpectrumOptions
) => evaluateSpectrum(spec, freq, pitchList, EVAL_RANGE_CENTS, A4, EVAL_THRESHOLD, options);

const legacy = (spec: Float32Array, pitchList: Pitch[]) =>
  legacyEvaluateSpectrum(spec, freq, pitchList, EVAL_RANGE_CENTS, A4, EVAL_THRESHOLD);

describe("estimateLocalNoiseFloorDb", () => {
  it("目標周波数 ±4 半音のビンの中央値を返す (奇数個・偶数個)", () => {
    // ビン幅 10 Hz。1000 Hz ±4 半音 = 793.7〜1259.9 Hz → ビン 80〜125 (46 個)
    const f = Array.from({ length: 200 }, (_, i) => i * 10);
    const spec = new Float32Array(200).fill(-200);
    for (let i = 80; i <= 125; i++) spec[i] = -100 + (i - 80); // -100, -99, ..., -55
    expect(estimateLocalNoiseFloorDb(spec, f, 1000)).toBeCloseTo((-78 + -77) / 2, 5);

    // ±1 半音 = 943.9〜1059.5 Hz → ビン 95〜105 (11 個) の中央は 100 番 = -80
    expect(estimateLocalNoiseFloorDb(spec, f, 1000, 1)).toBeCloseTo(-80, 5);
  });

  it("範囲内のピークに引きずられない", () => {
    const f = Array.from({ length: 200 }, (_, i) => i * 10);
    const spec = new Float32Array(200).fill(-90);
    for (let i = 98; i <= 102; i++) spec[i] = -20;
    expect(estimateLocalNoiseFloorDb(spec, f, 1000)).toBeCloseTo(-90, 5);
  });

  it("除外範囲のビンは中央値に含めない", () => {
    // ビン 80〜125 のうち 80〜110 がピークの裾 (-30 dB)、残りがノイズ (-90 dB)
    const f = Array.from({ length: 200 }, (_, i) => i * 10);
    const spec = new Float32Array(200).fill(-90);
    for (let i = 80; i <= 110; i++) spec[i] = -30;
    // 除外しないと過半数を占めるピークの裾が中央値になる
    expect(estimateLocalNoiseFloorDb(spec, f, 1000)).toBeCloseTo(-30, 5);
    expect(
      estimateLocalNoiseFloorDb(spec, f, 1000, NOISE_FLOOR_RANGE_SEMITONES, [
        [70, 95],
        [96, 110],
      ])
    ).toBeCloseTo(-90, 5);
  });

  it("使えるビンが NOISE_FLOOR_MIN_BINS 未満なら null を返す", () => {
    const f = Array.from({ length: 200 }, (_, i) => i * 10);
    const spec = new Float32Array(200).fill(-90);
    // 範囲外
    expect(estimateLocalNoiseFloorDb(spec, f, 5000)).toBeNull();
    expect(estimateLocalNoiseFloorDb(spec, [0], 0)).toBeNull();
    // ビン 80〜125 (46 個) のうち 4 個だけ残す
    expect(
      estimateLocalNoiseFloorDb(spec, f, 1000, NOISE_FLOOR_RANGE_SEMITONES, [
        [80, 80 + 46 - NOISE_FLOOR_MIN_BINS],
      ])
    ).toBeNull();
    expect(
      estimateLocalNoiseFloorDb(spec, f, 1000, NOISE_FLOOR_RANGE_SEMITONES, [
        [80, 80 + 45 - NOISE_FLOOR_MIN_BINS],
      ])
    ).toBeCloseTo(-90, 5);
  });

  it("合成スペクトルで白色ノイズのレベルを推定できる", () => {
    const spec = simulate([{ freqHz: 262.8, peakDb: TONE_DB }]);
    const floor = estimateLocalNoiseFloorDb(spec, freq, 262.8);
    expect(floor).not.toBeNull();
    expect(Math.abs(floor! - NOISE_DB)).toBeLessThan(2);
  });
});

describe("evaluateSpectrum: ノイズフロア基準の検出判定 (evalMarginDb)", () => {
  const triad = [pitch("C", 4, true), pitch("E", 4), pitch("G", 4)];
  const [c4, e4, g4] = getJustFrequencies(triad, A4);
  const SEEDS = Array.from({ length: 20 }, (_, i) => i + 1);

  it("既定値は 15 dB", () => {
    expect(EVAL_MARGIN_DB_DEFAULT).toBe(15);
  });

  it("鳴っていない構成音は null になる (他の構成音は鳴っている)", () => {
    for (const seed of SEEDS) {
      const spec = simulate(
        [
          { freqHz: c4, peakDb: TONE_DB },
          { freqHz: g4, peakDb: TONE_DB },
        ],
        seed
      );
      const [c, e, g] = evaluate(spec, triad);
      expect(c.centDeviation).not.toBeNull();
      expect(g.centDeviation).not.toBeNull();
      expect(e.centDeviation).toBeNull();
      expect(e.deviation).toBeNull();
    }
  });

  it("evalMarginDb=null では絶対値のしきい値だけで判定し、鳴っていない音にも値を出す (旧挙動)", () => {
    let detected = 0;
    for (const seed of SEEDS) {
      const spec = simulate(
        [
          { freqHz: c4, peakDb: TONE_DB },
          { freqHz: g4, peakDb: TONE_DB },
        ],
        seed
      );
      const result = evaluate(spec, triad, { evalMarginDb: null });
      if (result[1].centDeviation !== null) detected++;
    }
    // ノイズフロア -90 dB はしきい値 -100 dB より高いので、ノイズを拾って必ず値が出る
    expect(detected).toBe(SEEDS.length);
  });

  it("全パートが無音 (ノイズのみ) なら全構成音が null になる", () => {
    for (const seed of SEEDS) {
      const result = evaluate(simulate([], seed), triad);
      expect(result.map((r) => r.centDeviation)).toEqual([null, null, null]);
    }
  });

  it("ノイズフロアより 20 dB 上の弱い音は検出し、10 dB 上の音は検出しない", () => {
    for (const seed of SEEDS) {
      const tones = (weakDb: number): SimTone[] => [
        { freqHz: c4, peakDb: TONE_DB },
        { freqHz: detune(e4, 10), peakDb: weakDb },
        { freqHz: g4, peakDb: TONE_DB },
      ];
      const strong = evaluate(simulate(tones(NOISE_DB + 20), seed), triad)[1];
      expect(strong.centDeviation).not.toBeNull();
      expect(Math.abs(strong.centDeviation! - 10)).toBeLessThan(2);

      const weak = evaluate(simulate(tones(NOISE_DB + 10), seed), triad)[1];
      expect(weak.centDeviation).toBeNull();
    }
  });

  it("evalMarginDb を下げると、より弱い音まで検出する", () => {
    const spec = simulate([
      { freqHz: c4, peakDb: TONE_DB },
      { freqHz: e4, peakDb: NOISE_DB + 12 },
      { freqHz: g4, peakDb: TONE_DB },
    ]);
    expect(evaluate(spec, triad, { evalMarginDb: 15 })[1].centDeviation).toBeNull();
    expect(evaluate(spec, triad, { evalMarginDb: 8 })[1].centDeviation).not.toBeNull();
  });

  it("絶対値のしきい値 (evalThreshold) も併用する", () => {
    // ノイズなし・ピーク -110 dB: ノイズフロアからは十分高いが、しきい値 -100 dB 未満
    const spec = simulate([{ freqHz: c4, peakDb: -110 }], 1, null);
    const result = evaluate(spec, [pitch("C", 4, true)]);
    expect(result[0].centDeviation).toBeNull();
    expect(result[0].peakDb).toBeLessThan(EVAL_THRESHOLD);
  });

  it("peakDb と noiseFloorDb を結果に含める (null のときも)", () => {
    const spec = simulate([
      { freqHz: c4, peakDb: TONE_DB },
      { freqHz: g4, peakDb: TONE_DB },
    ]);
    const [c, e] = evaluate(spec, triad);
    // ピークがビンの中間に落ちるとスカロップ損失で最大 1.1 dB 下がる
    expect(c.peakDb!).toBeGreaterThan(TONE_DB - 1.5);
    expect(c.peakDb!).toBeLessThanOrEqual(TONE_DB + 0.5);
    expect(Math.abs(c.noiseFloorDb! - NOISE_DB)).toBeLessThan(2);

    expect(e.centDeviation).toBeNull();
    expect(e.peakDb!).toBeLessThan(e.noiseFloorDb! + EVAL_MARGIN_DB_DEFAULT);
  });

  it("構成音のピークはノイズフロア推定に混ざらない (低音域で和音が密でも鳴っている音を落とさない)", () => {
    // C3-E3-G3: ±4 半音に 3 音の主ローブが入る。E3 は他より 15 dB 弱い
    const low = [pitch("C", 3, true), pitch("E", 3), pitch("G", 3)];
    const tones = getJustFrequencies(low, A4).map((freqHz, i) => ({
      freqHz,
      peakDb: i === 1 ? TONE_DB - 15 : TONE_DB,
    }));
    const result = evaluate(simulate(tones), low);
    for (const r of result) {
      expect(r.centDeviation).not.toBeNull();
      expect(Math.abs(r.noiseFloorDb! - NOISE_DB)).toBeLessThan(4);
    }
  });

  it("ノイズフロアを推定できるビンが足りないときは絶対値のしきい値だけで判定する", () => {
    // fftSize 4096 ではビン幅 11.7 Hz。C4-E4-G4 の探索窓 + 主ローブで ±4 半音がほぼ埋まる
    const smallFft = 4096;
    const smallFreq = makeFreqBins(SAMPLE_RATE, smallFft);
    const spec = simulateAnalyserSpectrum({
      sampleRate: SAMPLE_RATE,
      fftSize: smallFft,
      smoothingTimeConstant: SMOOTHING,
      tones: [c4, e4, g4].map((freqHz) => ({ freqHz, peakDb: TONE_DB })),
      noiseFloorDb: NOISE_DB,
    });
    const result = evaluateSpectrum(spec, smallFreq, triad, EVAL_RANGE_CENTS, A4, EVAL_THRESHOLD);
    expect(result[0].noiseFloorDb).toBeNull();
    for (const r of result) {
      expect(r.centDeviation).not.toBeNull();
    }
  });

  it("計測対象外 (enabled=false) の音は peakDb / noiseFloorDb も null", () => {
    const list = [pitch("C", 4, true), { ...pitch("E", 4), enabled: false }];
    const spec = simulate([{ freqHz: c4, peakDb: TONE_DB }]);
    expect(evaluate(spec, list)[1]).toMatchObject({
      deviation: null,
      centDeviation: null,
      peakDb: null,
      noiseFloorDb: null,
    });
  });
});

describe("evaluateSpectrum: 探索窓の外にずれた音 (isOutOfRange)", () => {
  const NOTES: [string, number][] = [
    ["G", 2],
    ["C", 3],
    ["C", 4],
    ["A", 4],
    ["C", 6],
  ];

  /** 単音 (根音のみ) を cents セントずらして鳴らしたときの評価結果 */
  const evaluateDetuned = (
    name: string,
    octave: number,
    cents: number,
    options?: EvaluateSpectrumOptions
  ) => {
    const list = [pitch(name, octave, true)];
    const [f0] = getJustFrequencies(list, A4);
    const spec = simulate([{ freqHz: detune(f0, cents), peakDb: TONE_DB }]);
    return { result: evaluate(spec, list, options)[0], spec, list };
  };

  it.each(NOTES)("%s%i: +70 / -70 セントのずれは null かつ isOutOfRange=true", (name, octave) => {
    for (const cents of [70, -70]) {
      const { result } = evaluateDetuned(name, octave, cents);
      expect(result.centDeviation).toBeNull();
      expect(result.deviation).toBeNull();
      expect(result.isOutOfRange).toBe(true);
    }
  });

  it.each(NOTES)("%s%i: +45 セントのずれは誤差 3 セント以内で値を出す", (name, octave) => {
    const { result } = evaluateDetuned(name, octave, 45);
    expect(result.centDeviation).not.toBeNull();
    expect(Math.abs(result.centDeviation! - 45)).toBeLessThanOrEqual(3);
    expect(result.isOutOfRange).toBe(false);
  });

  it("窓の端のビンが最大でも、真のピークなら値を出す (C4 の ±40 セント)", () => {
    // C4 の +40 セントは探索窓の最後のビンがピークになる
    for (const cents of [40, -40]) {
      const { result } = evaluateDetuned("C", 4, cents);
      expect(result.centDeviation).not.toBeNull();
      expect(Math.abs(result.centDeviation! - cents)).toBeLessThan(0.5);
      expect(result.isOutOfRange).toBe(false);
    }
  });

  it("探索窓の外 (52〜95 セント) では窓の端付近の値を出さない", () => {
    for (const [name, octave] of [
      ["C", 4],
      ["A", 4],
    ] as [string, number][]) {
      for (const cents of [52, 55, 60, 65, 80, 95, -52, -55, -60, -65, -80, -95]) {
        const { result } = evaluateDetuned(name, octave, cents);
        expect(result.centDeviation).toBeNull();
        expect(result.isOutOfRange).toBe(true);
      }
    }
  });

  it("範囲内の音・鳴っていない音は isOutOfRange=false", () => {
    const triad = [pitch("C", 4, true), pitch("E", 4), pitch("G", 4)];
    const [c4, , g4] = getJustFrequencies(triad, A4);
    for (let seed = 1; seed <= 10; seed++) {
      const spec = simulate(
        [
          { freqHz: detune(c4, 12), peakDb: TONE_DB },
          { freqHz: detune(g4, -8), peakDb: TONE_DB },
        ],
        seed
      );
      const result = evaluate(spec, triad);
      expect(result.map((r) => r.isOutOfRange)).toEqual([false, false, false]);
      expect(result[1].centDeviation).toBeNull();
    }
  });

  it("半音で隣り合う構成音を、鳴っていない音の範囲外ずれと取り違えない", () => {
    // C メジャーセブンス (B3 と C4 が約 112 セント差)。B3 を鳴らさない
    const maj7 = [pitch("C", 4, true), pitch("B", 3), pitch("E", 4), pitch("G", 4)];
    const [c4, b3, e4, g4] = getJustFrequencies(maj7, A4);
    expect(1200 * Math.log2(c4 / b3)).toBeCloseTo(111.7, 1);
    // C4 が B3 側へ 10 セント低くても、C4 自身の探索窓の中なら B3 の範囲外にしない
    const spec = simulate([
      { freqHz: detune(c4, -10), peakDb: TONE_DB },
      { freqHz: e4, peakDb: TONE_DB },
      { freqHz: g4, peakDb: TONE_DB },
    ]);
    const result = evaluate(spec, maj7);
    expect(result[1].centDeviation).toBeNull();
    expect(result[1].isOutOfRange).toBe(false);
    expect(result[0].centDeviation).toBeCloseTo(-10, 0);
  });

  it("evalMarginDb=null では範囲外でも旧実装と同じ値を出し、isOutOfRange だけ立てる", () => {
    // +55 セント: 窓の端のビン (主ローブの裾) を拾って ±50 セント付近の値になる
    const { spec, list } = evaluateDetuned("A", 4, 55);
    const result = evaluate(spec, list, { evalMarginDb: null })[0];
    expect(result.centDeviation).not.toBeNull();
    expect(result.centDeviation!).toBeGreaterThan(40);
    expect(result.centDeviation!).toBeLessThan(51);
    expect(result.isOutOfRange).toBe(true);
  });
});

describe("evaluateSpectrum: 補間方式 (interpolationMode)", () => {
  /** 98 Hz (G2) 以上の音。A4 = 442 Hz */
  const NOTES: [string, number][] = [
    ["G", 2],
    ["Bb", 2],
    ["C", 3],
    ["G", 3],
    ["Bb", 3],
    ["C", 4],
    ["E", 4],
    ["A", 4],
    ["C", 5],
    ["G", 5],
    ["C", 6],
  ];
  const DETUNES = [-40, -30, -20, -10, 0, 10, 20, 30, 40];

  /** 単音を各ずれで鳴らしたときの |推定値 - 真値| の最大 (不検出があれば Infinity) */
  const maxError = (
    name: string,
    octave: number,
    noiseFloorDb: number | null,
    options?: EvaluateSpectrumOptions
  ): number => {
    const list = [pitch(name, octave, true)];
    const [f0] = getJustFrequencies(list, A4);
    let max = 0;
    for (const cents of DETUNES) {
      const spec = simulate(
        [{ freqHz: detune(f0, cents), peakDb: TONE_DB }],
        1000 + cents,
        noiseFloorDb
      );
      const result = evaluate(spec, list, options)[0];
      if (result.centDeviation === null) return Infinity;
      max = Math.max(max, Math.abs(result.centDeviation - cents));
    }
    return max;
  };

  it("既定 ('db'): -40 dB の正弦波 + ノイズフロア -90 dB を全音域・±40 セントで検出する", () => {
    for (const [name, octave] of NOTES) {
      expect(maxError(name, octave, NOISE_DB)).toBeLessThan(Infinity);
    }
  });

  it("既定 ('db'): 98 Hz 以上・ずれ ±40 セント以内の補間誤差は 0.2 セント以下 (ノイズなし)", () => {
    for (const [name, octave] of NOTES) {
      expect(maxError(name, octave, null)).toBeLessThanOrEqual(0.2);
    }
  });

  it("既定 ('db'): ノイズフロア -90 dB でも C4 以上は 0.2 セント以下、98 Hz 以上は 0.35 セント以下", () => {
    // ノイズによるばらつきはビン幅 (セント) に比例するため、低音ほど大きい
    for (const [name, octave] of NOTES) {
      const [f0] = getJustFrequencies([pitch(name, octave, true)], A4);
      expect(maxError(name, octave, NOISE_DB)).toBeLessThanOrEqual(f0 >= 262 ? 0.2 : 0.35);
    }
  });

  it("'linear' (見直し前) は低音域で 0.9 セントを超える偏りが出る", () => {
    expect(maxError("G", 2, null, { interpolationMode: "linear" })).toBeGreaterThan(0.9);
    expect(maxError("C", 3, null, { interpolationMode: "linear" })).toBeGreaterThan(0.8);
    // 'db' は同じ条件で 1/5 以下
    expect(maxError("G", 2, null, { interpolationMode: "db" })).toBeLessThan(0.2);
  });

  it("純正な和音の平均誤差は 'db' の方が 'linear' より小さい", () => {
    const chords: Pitch[][] = [
      [pitch("C", 4, true), pitch("E", 4), pitch("G", 4)],
      [pitch("Bb", 3, true), pitch("D", 4), pitch("F", 4)],
      [pitch("C", 3, true), pitch("G", 3), pitch("E", 4), pitch("Bb", 4)],
    ];
    const meanError = (mode: "db" | "linear"): number => {
      let sum = 0;
      let count = 0;
      chords.forEach((list, chordIdx) => {
        const freqs = getJustFrequencies(list, A4);
        const offsets = list.map((_, i) => ((chordIdx * 7 + i * 11) % 31) - 15);
        const spec = simulate(
          freqs.map((f, i) => ({ freqHz: detune(f, offsets[i]), peakDb: TONE_DB })),
          chordIdx + 1
        );
        evaluate(spec, list, { interpolationMode: mode }).forEach((r, i) => {
          expect(r.centDeviation).not.toBeNull();
          sum += Math.abs(r.centDeviation! - offsets[i]);
          count++;
        });
      });
      return sum / count;
    };
    const db = meanError("db");
    expect(db).toBeLessThan(meanError("linear"));
    expect(db).toBeLessThan(0.2);
  });
});

describe("evaluateSpectrum: 旧挙動の再現 (interpolationMode='linear' かつ evalMarginDb=null)", () => {
  const LEGACY: EvaluateSpectrumOptions = {
    interpolationMode: "linear",
    evalMarginDb: null,
  };
  const triad = [pitch("C", 4, true), pitch("E", 4), pitch("G", 4)];
  const [c4, e4, g4] = getJustFrequencies(triad, A4);

  /** deviation / centDeviation が旧実装と完全に一致することを確かめる */
  const expectSameAsLegacy = (spec: Float32Array, list: Pitch[]) => {
    const current = evaluate(spec, list, LEGACY).map((r) => ({
      deviation: r.deviation,
      centDeviation: r.centDeviation,
    }));
    expect(current).toEqual(legacy(spec, list));
  };

  it("鳴っている和音 (ずれあり) で一致する", () => {
    for (let seed = 1; seed <= 5; seed++) {
      const spec = simulate(
        [
          { freqHz: detune(c4, seed * 3), peakDb: TONE_DB },
          { freqHz: detune(e4, -seed * 4), peakDb: TONE_DB - 10 },
          { freqHz: detune(g4, seed * 7), peakDb: TONE_DB - 5 },
        ],
        seed
      );
      expectSameAsLegacy(spec, triad);
    }
  });

  it("鳴っていない構成音・ノイズのみでも一致する (旧実装はノイズから値を出す)", () => {
    for (let seed = 1; seed <= 5; seed++) {
      const absent = simulate(
        [
          { freqHz: c4, peakDb: TONE_DB },
          { freqHz: g4, peakDb: TONE_DB },
        ],
        seed
      );
      expectSameAsLegacy(absent, triad);
      expect(evaluate(absent, triad, LEGACY)[1].centDeviation).not.toBeNull();
      expectSameAsLegacy(simulate([], seed), triad);
    }
  });

  it("探索窓の外にずれた音でも一致する (旧実装は窓の端付近の値を出す)", () => {
    for (const cents of [-100, -70, -55, -50, -48, -45, 45, 48, 50, 55, 70, 100]) {
      const spec = simulate([
        { freqHz: detune(c4, cents), peakDb: TONE_DB },
        { freqHz: detune(g4, -cents), peakDb: TONE_DB },
      ]);
      expectSameAsLegacy(spec, triad);
    }
  });

  it("絶対値のしきい値未満・計測対象外・低音域・fftSize が小さい場合でも一致する", () => {
    // しきい値未満 (ノイズなし・-110 dB)
    expectSameAsLegacy(simulate([{ freqHz: c4, peakDb: -110 }], 1, null), triad);

    // 計測対象外を含む
    const withDisabled = [triad[0], { ...triad[1], enabled: false }, triad[2]];
    expectSameAsLegacy(simulate([{ freqHz: c4, peakDb: TONE_DB }]), withDisabled);

    // 低音域 (探索窓が 2〜3 ビン)
    const low = [pitch("C", 2, true), pitch("G", 2), pitch("E", 3)];
    const lowFreqs = getJustFrequencies(low, A4);
    expectSameAsLegacy(
      simulate(lowFreqs.map((f, i) => ({ freqHz: detune(f, i * 17 - 20), peakDb: TONE_DB }))),
      low
    );

    // fftSize 4096
    const smallFreq = makeFreqBins(SAMPLE_RATE, 4096);
    const smallSpec = simulateAnalyserSpectrum({
      sampleRate: SAMPLE_RATE,
      fftSize: 4096,
      smoothingTimeConstant: SMOOTHING,
      tones: [
        { freqHz: detune(c4, 20), peakDb: TONE_DB },
        { freqHz: detune(g4, -30), peakDb: TONE_DB },
      ],
      noiseFloorDb: NOISE_DB,
    });
    expect(
      evaluateSpectrum(smallSpec, smallFreq, triad, EVAL_RANGE_CENTS, A4, EVAL_THRESHOLD, LEGACY).map(
        (r) => ({ deviation: r.deviation, centDeviation: r.centDeviation })
      )
    ).toEqual(
      legacyEvaluateSpectrum(smallSpec, smallFreq, triad, EVAL_RANGE_CENTS, A4, EVAL_THRESHOLD)
    );
  });

  it("既定のオプションでは旧実装と異なる (鳴っていない音を null にする)", () => {
    const spec = simulate([
      { freqHz: c4, peakDb: TONE_DB },
      { freqHz: g4, peakDb: TONE_DB },
    ]);
    expect(legacy(spec, triad)[1].centDeviation).not.toBeNull();
    expect(evaluate(spec, triad)[1].centDeviation).toBeNull();
  });
});

describe("evaluateSpectrum: 倍音干渉の警告 (isAmbiguous)", () => {
  it("根音 C3 と G4: G4 に C3 の第 3 倍音が重なる", () => {
    const list = [pitch("C", 3, true), pitch("G", 4)];
    const [c3, g4] = getJustFrequencies(list, A4);
    expect(c3 * 3).toBeCloseTo(g4, 6);

    const spec = simulate([
      { freqHz: c3, peakDb: TONE_DB },
      { freqHz: g4, peakDb: TONE_DB },
    ]);
    const result = evaluate(spec, list);
    expect(result[0].isAmbiguous).toBe(false);
    expect(result[1].isAmbiguous).toBe(true);
    expect(getHarmonicInterference(list, A4, EVAL_RANGE_CENTS)).toEqual([
      null,
      { sourceIndex: 0, harmonic: 3 },
    ]);
  });

  it("根音 C3 と C4 (オクターブ重複): C4 に C3 の第 2 倍音が重なる", () => {
    const list = [pitch("C", 3, true), pitch("C", 4)];
    const result = evaluate(simulate([]), list);
    expect(result.map((r) => r.isAmbiguous)).toEqual([false, true]);
    expect(getHarmonicInterference(list, A4, EVAL_RANGE_CENTS)[1]).toEqual({
      sourceIndex: 0,
      harmonic: 2,
    });
  });

  it("1 オクターブ内の三和音には倍音干渉がない", () => {
    const list = [pitch("C", 4, true), pitch("E", 4), pitch("G", 4)];
    const result = evaluate(simulate([]), list);
    expect(result.map((r) => r.isAmbiguous)).toEqual([false, false, false]);
  });

  it("探索窓の幅で判定が変わる (C3 の第 7 倍音と純正律の Bb5 は 27 セント差)", () => {
    const list = [pitch("C", 3, true), pitch("Bb", 5)];
    const [c3, bb5] = getJustFrequencies(list, A4);
    expect(1200 * Math.log2((c3 * 7) / bb5)).toBeCloseTo(-27.3, 1);
    expect(getHarmonicInterference(list, A4, 50)[1]).toEqual({ sourceIndex: 0, harmonic: 7 });
    expect(getHarmonicInterference(list, A4, 20)[1]).toBeNull();
  });

  it("第 8 倍音までを調べ、第 9 倍音以上・基音どうしは対象にしない", () => {
    expect(findHarmonicInterference([100, 800], 50)[1]).toEqual({ sourceIndex: 0, harmonic: 8 });
    expect(findHarmonicInterference([100, 900], 50)[1]).toBeNull();
    // 同じ高さの 2 音 (基音どうし) は倍音干渉ではない
    expect(findHarmonicInterference([100, 100], 50)).toEqual([null, null]);
  });

  it("計測対象外の音も干渉源になる。計測対象外の音自身は false", () => {
    const list = [{ ...pitch("C", 3, true), enabled: false }, pitch("G", 4)];
    expect(evaluate(simulate([]), list).map((r) => r.isAmbiguous)).toEqual([false, true]);

    const disabledTarget = [pitch("C", 3, true), { ...pitch("G", 4), enabled: false }];
    expect(evaluate(simulate([]), disabledTarget).map((r) => r.isAmbiguous)).toEqual([false, false]);
  });

  it("根音が未設定のリストでは全要素 null (エラーにしない)", () => {
    const list = [pitch("C", 3), pitch("G", 4)];
    expect(getHarmonicInterference(list, A4, EVAL_RANGE_CENTS)).toEqual([null, null]);
  });

  it("警告の対象: 同じ音量の倍音が重なると、ずれた基音ではなく倍音を捕捉する", () => {
    // G4 を +20 セントで演奏。C3 の第 3 倍音 (純正な G4 の位置) が同じ音量で鳴っている
    const list = [pitch("C", 3, true), pitch("G", 4)];
    const [c3, g4] = getJustFrequencies(list, A4);
    const spec = simulate([
      { freqHz: c3, peakDb: TONE_DB },
      { freqHz: c3 * 3, peakDb: TONE_DB + 1 },
      { freqHz: detune(g4, 20), peakDb: TONE_DB },
    ]);
    const g = evaluate(spec, list)[1];
    // アルゴリズムは変えていないので取り違えは起きる。フラグで利用側に知らせる
    expect(Math.abs(g.centDeviation!)).toBeLessThan(2);
    expect(g.isAmbiguous).toBe(true);
  });
});
