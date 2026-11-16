/**
 * テスト用ヘルパー: 検出判定・補間方式を見直す前の evaluateSpectrum / quadraticInterpolation
 * (コミット 160e33a 時点) の凍結コピー。
 *
 * 現行実装を interpolationMode="linear" かつ evalMarginDb=null で呼んだときに
 * 旧実装と同じ出力になること (過去の実験ログの再現性) を回帰テストで確かめるために置く。
 * 比較の基準なので、このファイルは編集しない。
 */
import { getJustFrequencies } from "../../src/calcJustFreq";
import type { Pitch } from "../../src/types";

export interface LegacyEvaluationResult {
  deviation: number | null;
  centDeviation: number | null;
}

export function legacyQuadraticInterpolation(
  spec: Float32Array,
  peakIdx: number,
  freq: number[]
): number {
  if (peakIdx <= 0 || peakIdx >= spec.length - 1) {
    return freq[peakIdx];
  }

  const alpha = spec[peakIdx - 1];
  const beta = spec[peakIdx];
  const gamma = spec[peakIdx + 1];

  if (beta <= alpha || beta <= gamma) {
    return freq[peakIdx];
  }

  const alphaLinear = Math.pow(10, alpha / 20);
  const betaLinear = Math.pow(10, beta / 20);
  const gammaLinear = Math.pow(10, gamma / 20);

  const denominator = alphaLinear - 2 * betaLinear + gammaLinear;
  if (Math.abs(denominator) < 1e-10) {
    return freq[peakIdx];
  }

  const delta = (0.5 * (alphaLinear - gammaLinear)) / denominator;
  if (Math.abs(delta) > 0.5) {
    return freq[peakIdx];
  }

  const freqStep = freq.length > 1 ? freq[1] - freq[0] : 0;
  return freq[peakIdx] + delta * freqStep;
}

export function legacyEvaluateSpectrum(
  spec: Float32Array,
  freq: number[],
  pitchNameList: Pitch[],
  evalRangeCents: number,
  a4Freq: number,
  evalThreshold: number
): LegacyEvaluationResult[] {
  const estFreqs = getJustFrequencies(pitchNameList, a4Freq);

  if (estFreqs.length === 0) {
    return [];
  }

  const evalList: LegacyEvaluationResult[] = [];

  for (let i = 0; i < estFreqs.length; i++) {
    const est_f = estFreqs[i];
    const pitch = pitchNameList[i];

    if (pitch.enabled === false) {
      evalList.push({ deviation: null, centDeviation: null });
      continue;
    }

    let targetFreq = 1e10;
    let targetIdx = -1;

    for (let idx = 0; idx < freq.length; idx++) {
      const f = freq[idx];
      if (Math.abs(est_f - f) < Math.abs(est_f - targetFreq)) {
        targetFreq = f;
        targetIdx = idx;
      } else {
        break;
      }
    }

    const minFreq = est_f * 2 ** (-evalRangeCents / 1200);
    const maxFreq = est_f * 2 ** (evalRangeCents / 1200);
    const freqStep = freq.length > 1 ? freq[1] - freq[0] : 1;

    const rangeMinIdxApprox =
      targetIdx - Math.floor((targetFreq - minFreq) / freqStep);
    const rangeMaxIdxApprox =
      targetIdx + Math.ceil((maxFreq - targetFreq) / freqStep);

    const evalRangeMin = Math.max(0, rangeMinIdxApprox);
    const evalRangeMax = Math.min(spec.length, rangeMaxIdxApprox);

    const evalSpec = spec.slice(evalRangeMin, evalRangeMax);

    if (evalSpec.length === 0) {
      evalList.push({ deviation: null, centDeviation: null });
      continue;
    }

    let specMax = 0;
    let maxVal = evalSpec[0];
    for (let j = 1; j < evalSpec.length; j++) {
      if (evalSpec[j] > maxVal) {
        maxVal = evalSpec[j];
        specMax = j;
      }
    }

    if (maxVal < evalThreshold) {
      evalList.push({ deviation: null, centDeviation: null });
    } else {
      const actualFreqIdx = evalRangeMin + specMax;
      const actualFreq = legacyQuadraticInterpolation(spec, actualFreqIdx, freq);
      const centDeviation = 1200 * Math.log2(actualFreq / est_f);
      const rawDeviation =
        evalRangeCents === 0 ? 0 : centDeviation / evalRangeCents;
      const deviation = Math.max(
        -1,
        Math.min(1, Math.round(rawDeviation * 1000) / 1000)
      );
      evalList.push({ deviation, centDeviation });
    }
  }

  return evalList;
}
