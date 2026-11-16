import { evaluateSpectrum } from "../src/justAnalyze";
import type { Pitch } from "../src/types";
import { makeFreqBins, simulateAnalyserSpectrum } from "./helpers/analyserNodeSim";
import { legacyEvaluateSpectrum } from "./helpers/legacyEvaluateSpectrum";

/**
 * AnalyserNode 再現ヘルパー自体の検証。
 * 以降の evaluateSpectrum のテストはこのヘルパーが作るスペクトルを前提にする
 */
describe("simulateAnalyserSpectrum (AnalyserNode 再現ヘルパー)", () => {
  const SAMPLE_RATE = 48000;
  const FFT_SIZE = 32768;
  const base = {
    sampleRate: SAMPLE_RATE,
    fftSize: FFT_SIZE,
    smoothingTimeConstant: 0.8,
  };
  const binHz = SAMPLE_RATE / FFT_SIZE;

  const median = (values: ArrayLike<number>): number => {
    const sorted = Array.from(values).sort((a, b) => a - b);
    const mid = sorted.length >> 1;
    return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  };

  it("ビン中心の正弦波は指定した peakDb でピークになる", () => {
    const k = 300;
    const spec = simulateAnalyserSpectrum({
      ...base,
      tones: [{ freqHz: k * binHz, peakDb: -40 }],
      frames: 2,
    });
    expect(spec).toHaveLength(FFT_SIZE / 2);
    expect(spec[k]).toBeCloseTo(-40, 2);
    // Blackman 窓の主ローブ: 隣のビンは a1/2 / a0 = 0.25/0.42 → 約 -4.5 dB
    expect(spec[k + 1] - spec[k]).toBeCloseTo(20 * Math.log10(0.25 / 0.42), 1);
    expect(spec[k - 1]).toBeCloseTo(spec[k + 1], 1);
    // 主ローブ (±3 ビン) の外は -58 dB 以下のサイドローブ
    expect(spec[k + 6]).toBeLessThan(-40 - 58);
  });

  it("白色ノイズはビン中央値が指定した noiseFloorDb になる", () => {
    const spec = simulateAnalyserSpectrum({
      ...base,
      tones: [],
      noiseFloorDb: -90,
    });
    expect(Math.abs(median(spec.subarray(100, 8000)) - -90)).toBeLessThan(1);
  });

  it("warmStart=false では起動直後と同じく (1 - τ^frames) 倍に立ち上がる", () => {
    const k = 300;
    const spec = simulateAnalyserSpectrum({
      ...base,
      tones: [{ freqHz: k * binHz, peakDb: -40 }],
      frames: 3,
      warmStart: false,
    });
    expect(spec[k]).toBeCloseTo(-40 + 20 * Math.log10(1 - 0.8 ** 3), 1);
  });

  it("同じシードなら同じスペクトルを返す", () => {
    const options = { ...base, tones: [], noiseFloorDb: -90, frames: 2, seed: 7 };
    const a = simulateAnalyserSpectrum(options);
    const b = simulateAnalyserSpectrum(options);
    expect(Array.from(a.subarray(0, 64))).toEqual(Array.from(b.subarray(0, 64)));
  });
});

describe("legacyEvaluateSpectrum (旧実装の凍結コピー)", () => {
  it("旧挙動に切り替えた evaluateSpectrum と同じ出力を返す", () => {
    const freq = makeFreqBins(48000, 32768);
    const pitchList: Pitch[] = [
      { pitchName: "C", octaveNum: 4, isRoot: true, enabled: true },
      { pitchName: "E", octaveNum: 4, isRoot: false, enabled: true },
      { pitchName: "G", octaveNum: 4, isRoot: false, enabled: false },
    ];
    const spec = simulateAnalyserSpectrum({
      sampleRate: 48000,
      fftSize: 32768,
      smoothingTimeConstant: 0.8,
      tones: [
        { freqHz: 263.5, peakDb: -40 },
        { freqHz: 330.2, peakDb: -45 },
      ],
      noiseFloorDb: -90,
    });
    const current = evaluateSpectrum(spec, freq, pitchList, 50, 442, -100, {
      evalMarginDb: null,
    });
    const legacy = legacyEvaluateSpectrum(spec, freq, pitchList, 50, 442, -100);
    expect(legacy).toEqual(
      current.map((r) => ({
        deviation: r.deviation,
        centDeviation: r.centDeviation,
      }))
    );
  });
});
