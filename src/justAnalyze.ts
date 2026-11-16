import { getJustFrequencies } from "./calcJustFreq";
import {
  EVAL_MARGIN_DB_DEFAULT,
  HARMONIC_INTERFERENCE_MAX_ORDER,
  HARMONIC_INTERFERENCE_MIN_ORDER,
  INTERPOLATION_MODE_DEFAULT,
  LOW_RESOLUTION_BIN_CENTS,
  MAIN_LOBE_HALF_WIDTH_BINS,
  NOISE_FLOOR_MIN_BINS,
  NOISE_FLOOR_RANGE_SEMITONES,
  OUT_OF_RANGE_GUARD_CENTS,
} from "./constants";
import {
  quadraticInterpolation,
  type InterpolationMode,
} from "./peakInterpolation";
import type { Pitch } from "./types";

/**
 * 演奏された音の評価結果
 */
export interface EvaluationResult {
  /** deviation値（-1.0〜1.0、正規化された値） */
  deviation: number | null;
  /** セント単位の誤差（生の値） */
  centDeviation: number | null;

  /**
   * 探索窓 (±evalRangeCents) の外にずれた成分があるとき true。次のいずれか:
   * - 探索窓内の最大ビンが検出判定を満たすが、スペクトル全体の局所最大でない
   *   (窓の外にあるピークの裾)、または補間後の周波数が探索窓の外にある
   * - 探索窓内は検出判定を満たさないが、窓の外側 ±OUT_OF_RANGE_GUARD_CENTS までに
   *   検出判定を満たす成分がある
   * このとき deviation / centDeviation は null (evalMarginDb=null のときは
   * 見直し前と同じ値を出したまま、このフラグだけを立てる)
   */
  isOutOfRange: boolean;

  /**
   * 他の構成音の倍音 (第 2〜第 8) がこの音の探索窓に入るとき true。
   * 倍音が自分の音と同じかそれ以上の音量だと、倍音の方を捕捉して偏差を取り違える
   * 可能性がある (例: 根音 C3 に対する G4・C4)。構成音リストだけで決まり、
   * スペクトルには依存しない。計測対象外 (enabled=false) の音は false
   */
  isAmbiguous: boolean;

  /**
   * この音の高さで FFT の 1 ビンの幅 (セント換算) が LOW_RESOLUTION_BIN_CENTS を
   * 超えるとき true。探索窓に入るビンが少なく、近接する成分 (隣の構成音・倍音) を
   * 分離できないため、偏差の信頼性が下がる。fftSize・サンプリング周波数と音の高さだけで
   * 決まり、スペクトルには依存しない。計測対象外 (enabled=false) の音は false
   */
  lowResolution: boolean;

  /**
   * 探索窓内の最大ビンのレベル (dB)。
   * 計測対象外 (enabled=false)・探索窓が空のときは null
   */
  peakDb: number | null;
  /**
   * 局所ノイズフロアの推定値 (dB)。目標周波数 ±NOISE_FLOOR_RANGE_SEMITONES 半音の
   * dB スペクトルの中央値 (全構成音の探索窓 + 主ローブ幅のビンは除く)。
   * 計測対象外・探索窓が空・推定に使えるビンが足りないときは null
   */
  noiseFloorDb: number | null;

  /** デバッグ用: ピーク探索範囲の情報 (options.includeDebug 指定時のみ) */
  debug?: {
    estFreqHz: number;
    range: {
      minIdx: number;
      maxIdx: number;
      minFreqHz: number;
      maxFreqHz: number;
    };
    peak: {
      idx: number;
      freqHz: number;
      db: number;
    };
  };
}

export interface EvaluateSpectrumOptions {
  includeDebug?: boolean;
  /**
   * 検出マージン (dB)。探索窓内のピークが「局所ノイズフロア + evalMarginDb」に
   * 満たないときは鳴っていないと判定して null を返す。
   * ノイズフロアを推定できないとき (noiseFloorDb=null) はこの判定を行わない。
   * 省略時は EVAL_MARGIN_DB_DEFAULT。
   *
   * null を渡すと検出判定を見直し前の挙動に戻す: ノイズフロア基準の判定を行わず
   * 絶対値のしきい値 (evalThreshold) だけで判定し、探索窓の外にずれた成分 (isOutOfRange)
   * でも null にせず窓内の最大ビンから値を出す
   */
  evalMarginDb?: number | null;
  /**
   * ピーク周波数のパラボラ補間をどの尺度の振幅で行うか。
   * 省略時は INTERPOLATION_MODE_DEFAULT ("db")。"linear" は見直し前の方式
   */
  interpolationMode?: InterpolationMode;
}

/**
 * 周波数 freqHz の位置で、FFT の 1 ビンの幅をセントに換算する。
 * @param freqHz 音の周波数 (Hz)
 * @param binWidthHz ビン幅 (Hz) = サンプリング周波数 / fftSize
 */
export function binWidthCents(freqHz: number, binWidthHz: number): number {
  return 1200 * Math.log2(1 + binWidthHz / freqHz);
}

/**
 * 周波数 freqHz の音が低分解能 (ビン幅が LOW_RESOLUTION_BIN_CENTS セントを超える) かを返す
 */
export function isLowResolution(freqHz: number, binWidthHz: number): boolean {
  return (
    freqHz > 0 &&
    binWidthHz > 0 &&
    binWidthCents(freqHz, binWidthHz) > LOW_RESOLUTION_BIN_CENTS
  );
}

/**
 * 構成音リストの各音が低分解能かを返す (UI での事前表示用)。
 * 根音が未設定などで期待周波数を計算できないときは、全要素 false を返す
 */
export function getLowResolutionFlags(
  pitchNameList: Pitch[],
  a4Freq: number,
  binWidthHz: number
): boolean[] {
  // 根音が 1 つでないと getJustFrequencies がエラーを出力するので先に弾く
  if (pitchNameList.filter((p) => p.isRoot).length !== 1) {
    return pitchNameList.map(() => false);
  }
  const estFreqs = getJustFrequencies(pitchNameList, a4Freq);
  if (estFreqs.length !== pitchNameList.length) {
    return pitchNameList.map(() => false);
  }
  return estFreqs.map((f) => isLowResolution(f, binWidthHz));
}

/** 倍音干渉の内容: どの構成音の第何倍音が探索窓に入るか */
export interface HarmonicInterference {
  /** 干渉する側の構成音のインデックス (構成音リスト内) */
  sourceIndex: number;
  /** 倍音次数 (2〜8) */
  harmonic: number;
}

/**
 * 倍音干渉の組合せを求める。
 * 各構成音について、他の構成音の第 2〜第 8 倍音が自分の探索窓 (±evalRangeCents) に
 * 入るかを調べ、入るものがあれば最初に見つかった 1 つを返す。
 *
 * @param estFreqs 各構成音の期待周波数 (Hz)
 * @param evalRangeCents 探索窓の半幅 (セント)
 * @returns 構成音ごとの干渉内容。干渉がなければ null
 */
export function findHarmonicInterference(
  estFreqs: number[],
  evalRangeCents: number
): (HarmonicInterference | null)[] {
  const ratio = 2 ** (evalRangeCents / 1200);
  return estFreqs.map((target, i) => {
    const lo = target / ratio;
    const hi = target * ratio;
    for (let j = 0; j < estFreqs.length; j++) {
      if (j === i) continue;
      const source = estFreqs[j];
      if (!(source > 0)) continue;
      for (
        let harmonic = HARMONIC_INTERFERENCE_MIN_ORDER;
        harmonic <= HARMONIC_INTERFERENCE_MAX_ORDER;
        harmonic++
      ) {
        const harmonicFreq = source * harmonic;
        if (harmonicFreq > hi) break;
        if (harmonicFreq >= lo) return { sourceIndex: j, harmonic };
      }
    }
    return null;
  });
}

/**
 * 構成音リストから倍音干渉の組合せを求める (UI での事前表示用)。
 * 根音が未設定などで期待周波数を計算できないときは、全要素 null を返す
 */
export function getHarmonicInterference(
  pitchNameList: Pitch[],
  a4Freq: number,
  evalRangeCents: number
): (HarmonicInterference | null)[] {
  // 根音が 1 つでないと getJustFrequencies がエラーを出力するので先に弾く
  if (pitchNameList.filter((p) => p.isRoot).length !== 1) {
    return pitchNameList.map(() => null);
  }
  const estFreqs = getJustFrequencies(pitchNameList, a4Freq);
  if (estFreqs.length !== pitchNameList.length) {
    return pitchNameList.map(() => null);
  }
  return findHarmonicInterference(estFreqs, evalRangeCents);
}

/** 中央値計算の作業用バッファ (毎フレームの確保を避けるため使い回す) */
let medianScratch = new Float32Array(1024);

/**
 * a[0..n) を並べ替え、k 番目に小さい値を a[k] に置く (Hoare の quickselect)。
 * 全体をソートせず、必要な側だけ分割を進めるので平均 O(n)
 */
function quickselect(a: Float32Array, n: number, k: number): void {
  let left = 0;
  let right = n - 1;
  while (left < right) {
    const pivot = a[(left + right) >> 1];
    let i = left;
    let j = right;
    while (i <= j) {
      while (a[i] < pivot) i++;
      while (a[j] > pivot) j--;
      if (i <= j) {
        const tmp = a[i];
        a[i] = a[j];
        a[j] = tmp;
        i++;
        j--;
      }
    }
    if (k <= j) {
      right = j;
    } else if (k >= i) {
      left = i;
    } else {
      return;
    }
  }
}

/** ビン番号の閉区間 [start, end] */
export type BinRange = readonly [number, number];

/**
 * 構成音の探索窓 (±evalRangeCents) に主ローブ幅を足したビン範囲を求め、
 * 開始位置の昇順に並べて重なりを結合する。
 * ノイズフロア推定から「構成音が鳴っていれば信号が乗るビン」を除くために使う
 */
function buildToneBinRanges(
  estFreqs: number[],
  freq: number[],
  evalRangeCents: number
): BinRange[] {
  if (freq.length < 2) return [];
  const freqStep = freq[1] - freq[0];
  if (!(freqStep > 0)) return [];

  const ratio = 2 ** (evalRangeCents / 1200);
  const ranges: [number, number][] = estFreqs.map((f) => [
    Math.floor((f / ratio - freq[0]) / freqStep) - MAIN_LOBE_HALF_WIDTH_BINS,
    Math.ceil((f * ratio - freq[0]) / freqStep) + MAIN_LOBE_HALF_WIDTH_BINS,
  ]);
  ranges.sort((a, b) => a[0] - b[0]);

  const merged: [number, number][] = [];
  for (const range of ranges) {
    const last = merged[merged.length - 1];
    if (last && range[0] <= last[1] + 1) {
      if (range[1] > last[1]) last[1] = range[1];
    } else {
      merged.push([range[0], range[1]]);
    }
  }
  return merged;
}

/**
 * 局所ノイズフロアを推定する。
 * 中心周波数 ±rangeSemitones 半音に入るビンの dB 値の中央値を返す。
 *
 * excludeRanges を渡すと、その範囲のビンを中央値の計算から除く。
 * evaluateSpectrum は全構成音の探索窓 + 主ローブ幅を除外する。構成音のピークが
 * 範囲内のビンの半数近くを占める条件 (fftSize が小さい・低音域で和音が密) では、
 * 除外しないと中央値がピークの裾に乗り、鳴っている音まで不検出になるため。
 *
 * @param spec dB スペクトル (getFloatFrequencyData の結果)
 * @param freq 等間隔の周波数ビン配列
 * @param centerFreqHz 中心周波数 (構成音の期待周波数)
 * @param rangeSemitones 範囲 (半音)。省略時は NOISE_FLOOR_RANGE_SEMITONES
 * @param excludeRanges 除外するビン範囲 (開始位置の昇順・重なりなし)
 * @returns ノイズフロア (dB)。使えるビンが NOISE_FLOOR_MIN_BINS 未満のときは null
 */
export function estimateLocalNoiseFloorDb(
  spec: Float32Array,
  freq: number[],
  centerFreqHz: number,
  rangeSemitones: number = NOISE_FLOOR_RANGE_SEMITONES,
  excludeRanges: readonly BinRange[] = []
): number | null {
  if (freq.length < 2) return null;
  const freqStep = freq[1] - freq[0];
  if (!(freqStep > 0)) return null;

  const ratio = 2 ** (rangeSemitones / 12);
  const lo = Math.max(0, Math.ceil((centerFreqHz / ratio - freq[0]) / freqStep));
  const hi = Math.min(
    spec.length - 1,
    Math.floor((centerFreqHz * ratio - freq[0]) / freqStep)
  );
  if (hi < lo) return null;

  if (medianScratch.length < hi - lo + 1) {
    medianScratch = new Float32Array((hi - lo + 1) * 2);
  }
  const a = medianScratch;

  // 除外範囲の隙間だけを作業用バッファに詰める
  let n = 0;
  let cursor = lo;
  for (const [start, end] of excludeRanges) {
    if (end < cursor) continue;
    if (start > hi) break;
    if (start > cursor) {
      a.set(spec.subarray(cursor, start), n);
      n += start - cursor;
    }
    cursor = end + 1;
  }
  if (cursor <= hi) {
    a.set(spec.subarray(cursor, hi + 1), n);
    n += hi + 1 - cursor;
  }
  if (n < NOISE_FLOOR_MIN_BINS) return null;

  const k = n >> 1;
  quickselect(a, n, k);
  if (n % 2 === 1) return a[k];

  // 偶数個のときは中央 2 値の平均。quickselect 後は a[0..k) がすべて a[k] 以下なので、
  // その最大値が (k-1) 番目の値になる
  let lower = a[0];
  for (let i = 1; i < k; i++) {
    if (a[i] > lower) lower = a[i];
  }
  return (lower + a[k]) / 2;
}

/**
 * 探索窓の外側 (ガード帯) の最大レベル (dB) を返す。
 *
 * ガード帯は目標周波数 ±OUT_OF_RANGE_GUARD_CENTS のうち探索窓 [windowMin, windowMax) の
 * 外にあるビン。ただし他の構成音の探索窓 + 主ローブ幅には踏み込まない
 * (半音で隣り合う構成音を、この音が範囲外にずれたものと取り違えないため)。
 *
 * @returns ガード帯の最大 dB。ガード帯にビンがないときは -Infinity
 */
function maxInGuardBand(
  spec: Float32Array,
  freq: number[],
  estFreqs: number[],
  index: number,
  evalRangeCents: number,
  windowMin: number,
  windowMax: number
): number {
  if (freq.length < 2) return -Infinity;
  const freqStep = freq[1] - freq[0];
  if (!(freqStep > 0)) return -Infinity;

  const est = estFreqs[index];
  const guardRatio = 2 ** (OUT_OF_RANGE_GUARD_CENTS / 1200);
  const rangeRatio = 2 ** (evalRangeCents / 1200);
  const lobeHz = MAIN_LOBE_HALF_WIDTH_BINS * freqStep;

  let lowFreq = est / guardRatio;
  let highFreq = est * guardRatio;
  for (let j = 0; j < estFreqs.length; j++) {
    const other = estFreqs[j];
    if (other < est) {
      lowFreq = Math.max(lowFreq, other * rangeRatio + lobeHz);
    } else if (other > est) {
      highFreq = Math.min(highFreq, other / rangeRatio - lobeHz);
    }
  }

  const lo = Math.max(0, Math.ceil((lowFreq - freq[0]) / freqStep));
  const hi = Math.min(
    spec.length - 1,
    Math.floor((highFreq - freq[0]) / freqStep)
  );

  let max = -Infinity;
  for (let idx = lo; idx < windowMin; idx++) {
    if (spec[idx] > max) max = spec[idx];
  }
  for (let idx = Math.max(windowMax, 0); idx <= hi; idx++) {
    if (spec[idx] > max) max = spec[idx];
  }
  return max;
}

/**
 * 演奏された音の評価
 * @param spec 各周波数に対するスペクトル（強さ）- AnalyserNode.getFloatFrequencyData() の結果
 * @param freq 周波数ビン配列 - AnalyserNode から計算
 * @param pitchNameList 評価する音名データ
 * @param evalRangeCents 評価範囲（セント）
 * @param a4Freq 基準となるA4の周波数
 * @param evalThreshold スペクトル評価の閾値 (絶対値 dB)
 * @param options 検出マージン・デバッグ情報の指定
 * @returns 各音のdeviation値とセント誤差を含む評価結果
 */
export function evaluateSpectrum(
  spec: Float32Array, // AnalyserNode から取得する生データ
  freq: number[],
  pitchNameList: Pitch[],
  evalRangeCents: number,
  a4Freq: number, // A4_FREQ を引数に追加
  evalThreshold: number, // EVAL_THRESHOLD を引数に追加
  options: EvaluateSpectrumOptions = {}
): EvaluationResult[] {
  const estFreqs = getJustFrequencies(pitchNameList, a4Freq); // a4Freq を渡す

  if (estFreqs.length === 0) {
    return [];
  }

  const evalMarginDb =
    options.evalMarginDb === undefined
      ? EVAL_MARGIN_DB_DEFAULT
      : options.evalMarginDb;

  const interpolationMode =
    options.interpolationMode ?? INTERPOLATION_MODE_DEFAULT;

  // ノイズフロア推定から除くビン範囲 (計測対象外の音も鳴っている前提で含める)
  const toneBinRanges = buildToneBinRanges(estFreqs, freq, evalRangeCents);

  // 倍音干渉 (構成音リストだけで決まる)
  const interference = findHarmonicInterference(estFreqs, evalRangeCents);

  const evalList: EvaluationResult[] = [];

  for (let i = 0; i < estFreqs.length; i++) {
    const est_f = estFreqs[i];
    const pitch = pitchNameList[i];

    // 計測対象外の場合はスキップ
    if (pitch.enabled === false) {
      evalList.push({
        deviation: null,
        centDeviation: null,
        isOutOfRange: false,
        isAmbiguous: false,
        lowResolution: false,
        peakDb: null,
        noiseFloorDb: null,
      });
      continue;
    }

    let targetFreq = 1e10;
    let targetIdx = -1;

    // 周波数ビンの中から最も近いものを探索
    for (let idx = 0; idx < freq.length; idx++) {
      const f = freq[idx];
      if (Math.abs(est_f - f) < Math.abs(est_f - targetFreq)) {
        targetFreq = f;
        targetIdx = idx;
      } else {
        // 周波数がソートされている前提で、近くなった時点で探索終了
        break;
      }
    }

    // ±evalRangeCents の周波数範囲を計算
    const minFreq = est_f * 2 ** (-evalRangeCents / 1200);
    const maxFreq = est_f * 2 ** (evalRangeCents / 1200);

    // 周波数範囲に対応するスペクトルインデックスの範囲を計算
    // freq[1] - freq[0] は周波数ビンの刻み幅
    const freqStep = freq.length > 1 ? freq[1] - freq[0] : 1; // 0除算対策

    // 中央のビンを基準に範囲を調整
    // targetIdx を中心とした近似的な範囲
    const rangeMinIdxApprox =
      targetIdx - Math.floor((targetFreq - minFreq) / freqStep);
    const rangeMaxIdxApprox =
      targetIdx + Math.ceil((maxFreq - targetFreq) / freqStep);

    const lowResolution = isLowResolution(est_f, freqStep);

    // 探索窓は [evalRangeMin, evalRangeMax)
    const evalRangeMin = Math.max(0, rangeMinIdxApprox);
    const evalRangeMax = Math.min(spec.length, rangeMaxIdxApprox);

    const debugRange = {
      minIdx: evalRangeMin,
      maxIdx: evalRangeMax,
      minFreqHz: freq[evalRangeMin] ?? 0,
      maxFreqHz: freq[Math.max(evalRangeMin, evalRangeMax - 1)] ?? 0,
    };

    if (evalRangeMax <= evalRangeMin) {
      const base: EvaluationResult = {
        deviation: null,
        centDeviation: null,
        isOutOfRange: false,
        isAmbiguous: interference[i] !== null,
        lowResolution,
        peakDb: null,
        noiseFloorDb: null,
      };
      if (options.includeDebug) {
        base.debug = {
          estFreqHz: est_f,
          range: debugRange,
          peak: {
            idx: Math.max(0, Math.min(spec.length - 1, targetIdx)),
            freqHz: freq[Math.max(0, Math.min(freq.length - 1, targetIdx))] ?? 0,
            db: spec[Math.max(0, Math.min(spec.length - 1, targetIdx))] ?? -Infinity,
          },
        };
      }
      evalList.push(base);
      continue;
    }

    // 探索窓内で最も強いビンを取得 (同値のときは低い方)
    let peakIdx = evalRangeMin;
    let maxVal = spec[evalRangeMin];
    for (let idx = evalRangeMin + 1; idx < evalRangeMax; idx++) {
      if (spec[idx] > maxVal) {
        maxVal = spec[idx];
        peakIdx = idx;
      }
    }

    // 局所ノイズフロア (ログ出力にも使うため、判定が無効でも求める)
    const noiseFloorDb = estimateLocalNoiseFloorDb(
      spec,
      freq,
      est_f,
      NOISE_FLOOR_RANGE_SEMITONES,
      toneBinRanges
    );

    // 検出判定: 絶対値のしきい値と、ノイズフロア基準のマージンの両方を満たすこと
    const marginFloorDb =
      evalMarginDb === null || noiseFloorDb === null
        ? -Infinity
        : noiseFloorDb + evalMarginDb;
    const isDetected = !(maxVal < evalThreshold) && !(maxVal < marginFloorDb);

    // 実際の周波数を計算（パラボラ補間でサブビン精度の周波数を推定）
    const actualFreq = quadraticInterpolation(
      spec,
      peakIdx,
      freq,
      interpolationMode
    );

    // 範囲内判定: 最大ビンがスペクトル全体で局所最大 (両隣より大きい) で、
    // かつ補間後の周波数が探索窓に収まること。
    // 窓の外にずれた音は主ローブの裾が窓の端のビンを最大にするので、局所最大にならない
    const isLocalPeak =
      peakIdx > 0 &&
      peakIdx < spec.length - 1 &&
      maxVal > spec[peakIdx - 1] &&
      maxVal > spec[peakIdx + 1];
    const isPeakInRange =
      isLocalPeak && actualFreq >= minFreq && actualFreq <= maxFreq;

    let isOutOfRange: boolean;
    if (isDetected) {
      isOutOfRange = !isPeakInRange;
    } else {
      // 窓内は不検出。窓の外側 (ガード帯) に検出判定を満たす成分があれば範囲外とする
      const guardMaxDb = maxInGuardBand(
        spec,
        freq,
        estFreqs,
        i,
        evalRangeCents,
        evalRangeMin,
        evalRangeMax
      );
      isOutOfRange =
        !(guardMaxDb < evalThreshold) && !(guardMaxDb < marginFloorDb);
    }

    const result: EvaluationResult = {
      deviation: null,
      centDeviation: null,
      isOutOfRange,
      isAmbiguous: interference[i] !== null,
      lowResolution,
      peakDb: maxVal,
      noiseFloorDb,
    };

    // evalMarginDb=null (見直し前の検出判定) では範囲外でも値を出す
    if (isDetected && (isPeakInRange || evalMarginDb === null)) {
      // セント単位の誤差を計算: cent = 1200 * log2(actual / expected)
      const centDeviation = 1200 * Math.log2(actualFreq / est_f);

      // deviation値（-1.0〜1.0）
      // これまではピークbin位置から算出していたが、bin飛びや評価範囲の変動で針が大きく跳ねやすい。
      // ここでは周波数から算出した centDeviation を evalRangeCents で正規化して安定させる。
      const rawDeviation = evalRangeCents === 0 ? 0 : centDeviation / evalRangeCents;
      result.deviation = Math.max(-1, Math.min(1, Math.round(rawDeviation * 1000) / 1000));
      result.centDeviation = centDeviation;
    }

    if (options.includeDebug) {
      result.debug = {
        estFreqHz: est_f,
        range: debugRange,
        peak: {
          idx: peakIdx,
          freqHz: actualFreq,
          db: maxVal,
        },
      };
    }

    evalList.push(result);
  }

  return evalList;
}
