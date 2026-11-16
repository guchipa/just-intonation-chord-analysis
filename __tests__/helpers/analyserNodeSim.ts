/**
 * テスト用ヘルパー: Web Audio API の AnalyserNode.getFloatFrequencyData() を再現する。
 *
 * 仕様 (https://webaudio.github.io/web-audio-api/#fft-windowing-and-smoothing-over-time):
 *   1. 直近 fftSize サンプルに Blackman 窓 (a0=0.42, a1=0.5, a2=0.08) を掛ける
 *   2. FFT して |X[k]| / N を取る
 *   3. 時間平滑化 X̂[k] = τ·X̂₋₁[k] + (1−τ)·|X[k]|
 *   4. 20·log10 で dB に変換する
 *
 * 合成信号 (正弦波 + 白色ノイズ) からこの手順でスペクトルを作り、
 * evaluateSpectrum の精度・検出判定を実機と同じ条件で検証する。
 */
import { radix2FFT } from "../../scripts/lib/fft";

const BLACKMAN_A0 = 0.42;
const BLACKMAN_A1 = 0.5;
const BLACKMAN_A2 = 0.08;

/** Blackman 窓の Σw²/N (白色ノイズのビン振幅の換算に使う) */
const BLACKMAN_POWER_GAIN =
  BLACKMAN_A0 ** 2 + BLACKMAN_A1 ** 2 / 2 + BLACKMAN_A2 ** 2 / 2;

/** レイリー分布の中央値 / 尺度母数 = sqrt(2·ln2) */
const RAYLEIGH_MEDIAN_FACTOR = Math.sqrt(2 * Math.LN2);

export interface SimTone {
  /** 周波数 (Hz) */
  freqHz: number;
  /** スペクトル上のピークレベル (dB)。ビン中心に乗ったときの getFloatFrequencyData の値 */
  peakDb: number;
  /** 初期位相 (rad)。省略時 0 */
  phase?: number;
}

export interface AnalyserSimOptions {
  sampleRate: number;
  fftSize: number;
  /** AnalyserNode.smoothingTimeConstant (0〜1) */
  smoothingTimeConstant: number;
  /** 鳴っている正弦波成分 */
  tones: SimTone[];
  /**
   * 白色ノイズのレベル。スペクトルのビン中央値がこの dB になるよう分散を決める。
   * null / 省略でノイズなし
   */
  noiseFloorDb?: number | null;
  /** 時間平滑化に通すフレーム数 (既定 8) */
  frames?: number;
  /** フレーム間のサンプル数 (既定: 60fps 相当 = sampleRate / 60) */
  hopSize?: number;
  /** ノイズの乱数シード (既定 1) */
  seed?: number;
  /**
   * true (既定) なら 1 フレーム目の振幅を平滑化の初期値にする (十分長く動かした後の定常状態)。
   * false なら AnalyserNode の起動直後と同じく 0 から立ち上げる
   */
  warmStart?: boolean;
}

/** 等間隔の周波数ビン配列 (AnalyserNode の各ビンの中心周波数) */
export function makeFreqBins(sampleRate: number, fftSize: number): number[] {
  const binCount = fftSize / 2;
  const step = sampleRate / fftSize;
  return Array.from({ length: binCount }, (_, i) => i * step);
}

/** 再現可能な一様乱数 (mulberry32) */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const windowCache = new Map<number, Float64Array>();

function blackmanWindow(n: number): Float64Array {
  let w = windowCache.get(n);
  if (!w) {
    w = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      const x = (2 * Math.PI * i) / n;
      w[i] = BLACKMAN_A0 - BLACKMAN_A1 * Math.cos(x) + BLACKMAN_A2 * Math.cos(2 * x);
    }
    windowCache.set(n, w);
  }
  return w;
}

/** ピークレベル (dB) から正弦波の時間領域振幅を求める (|X|/N のピーク = 振幅·a0/2) */
function peakDbToAmplitude(peakDb: number): number {
  return Math.pow(10, peakDb / 20) / (BLACKMAN_A0 / 2);
}

/** ビン中央値 (dB) から白色ガウスノイズの標準偏差を求める */
function noiseFloorDbToSigma(noiseFloorDb: number, fftSize: number): number {
  // |X|/N はレイリー分布 (尺度 s)。s² = σ²·Σw² / (2N²) = σ²·G / (2N)
  const s = Math.pow(10, noiseFloorDb / 20) / RAYLEIGH_MEDIAN_FACTOR;
  return s * Math.sqrt((2 * fftSize) / BLACKMAN_POWER_GAIN);
}

/**
 * 合成信号から AnalyserNode.getFloatFrequencyData() 相当の dB スペクトルを生成する。
 * @returns 長さ fftSize/2 の dB スペクトル
 */
export function simulateAnalyserSpectrum(options: AnalyserSimOptions): Float32Array {
  const {
    sampleRate,
    fftSize,
    smoothingTimeConstant: tau,
    tones,
    noiseFloorDb = null,
    frames = 8,
    hopSize = Math.round(sampleRate / 60),
    seed = 1,
    warmStart = true,
  } = options;

  const totalLen = fftSize + (frames - 1) * hopSize;
  const signal = new Float64Array(totalLen);

  for (const tone of tones) {
    const amp = peakDbToAmplitude(tone.peakDb);
    const w = (2 * Math.PI * tone.freqHz) / sampleRate;
    const phase = tone.phase ?? 0;
    for (let n = 0; n < totalLen; n++) {
      signal[n] += amp * Math.sin(w * n + phase);
    }
  }

  if (noiseFloorDb !== null) {
    const sigma = noiseFloorDbToSigma(noiseFloorDb, fftSize);
    const rand = mulberry32(seed);
    // Box-Muller 法 (2 個ずつ生成)
    for (let n = 0; n < totalLen; n += 2) {
      const u1 = Math.max(rand(), 1e-12);
      const u2 = rand();
      const r = sigma * Math.sqrt(-2 * Math.log(u1));
      signal[n] += r * Math.cos(2 * Math.PI * u2);
      if (n + 1 < totalLen) signal[n + 1] += r * Math.sin(2 * Math.PI * u2);
    }
  }

  const window = blackmanWindow(fftSize);
  const binCount = fftSize / 2;
  const smoothed = new Float64Array(binCount);
  const re = new Float64Array(fftSize);
  const im = new Float64Array(fftSize);

  for (let f = 0; f < frames; f++) {
    const offset = f * hopSize;
    for (let n = 0; n < fftSize; n++) {
      re[n] = signal[offset + n] * window[n];
      im[n] = 0;
    }
    radix2FFT(re, im);
    for (let k = 0; k < binCount; k++) {
      const mag = Math.hypot(re[k], im[k]) / fftSize;
      smoothed[k] =
        f === 0 && warmStart ? mag : tau * smoothed[k] + (1 - tau) * mag;
    }
  }

  const spec = new Float32Array(binCount);
  for (let k = 0; k < binCount; k++) {
    spec[k] = 20 * Math.log10(smoothed[k]);
  }
  return spec;
}
