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
import { estimateLocalNoiseFloorDb, evaluateSpectrum } from "../src/justAnalyze";
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
      expect(result[1].centDeviation).toBe(legacy(spec, triad)[1].centDeviation);
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
