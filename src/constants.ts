/**
 * ChordLens core 定数
 * src/ 配下の解析モジュールが参照する定数のみを定義する
 */

/**
 * A4 の周波数（Hz）
 * 平均律の基準として用いる
 */
export const A4_FREQ = 442;

/**
 * 解析対象とする音名のリスト
 */
export const PITCH_NAME_LIST: string[] = [
  "C",
  "C#",
  "D",
  "Eb",
  "E",
  "F",
  "F#",
  "G",
  "G#",
  "A",
  "Bb",
  "B",
];

/**
 * 音名をピッチクラスに変換するための対応表
 */
export const PITCH_CLASSES = {
  C: 0,
  "C#": 1,
  Db: 1,
  D: 2,
  "D#": 3,
  Eb: 3,
  E: 4,
  F: 5,
  "F#": 6,
  Gb: 6,
  G: 7,
  "G#": 8,
  Ab: 8,
  A: 9,
  "A#": 10,
  Bb: 10,
  B: 11,
};

// コード定義リスト：[名前, 構成音程(Set), スコア]
// 🧠 このリストが推定器の「頭脳」です。スコアと定義を調整して挙動をカスタマイズします。
export const CHORD_DEFINITIONS = [
  // 三和音 (高スコア)
  ["Major", new Set([0, 4, 7]), 100],
  ["Minor", new Set([0, 3, 7]), 99],
  ["Sus4", new Set([0, 5, 7]), 95],
  ["Sus2", new Set([0, 2, 7]), 94],

  // 四和音 (中スコア)
  ["Dominant 7th", new Set([0, 4, 7, 10]), 80],
  // セブンスの省略形: 5度欠け/3度欠け (3音でも根音推定できるようにする)
  // 注意: 3度欠けは種類の判別が曖昧になりやすいため、ラベルは汎用表現にする
  ["Dominant 7th (No 5th)", new Set([0, 4, 10]), 72],
  ["7th (No 3rd)", new Set([0, 7, 10]), 71],
  ["Major 7th", new Set([0, 4, 7, 11]), 79],
  ["Major 7th (No 5th)", new Set([0, 4, 11]), 70],
  ["Maj7 (No 3rd)", new Set([0, 7, 11]), 69],
  ["Minor 7th", new Set([0, 3, 7, 10]), 78],
  ["Minor 7th (No 5th)", new Set([0, 3, 10]), 68],
  ["Minor Major 7th", new Set([0, 3, 7, 11]), 75],
  ["Minor Major 7th (No 5th)", new Set([0, 3, 11]), 66],

  // やや特殊な和音 (低スコア)
  ["Major 6th", new Set([0, 4, 7, 9]), 60],
  ["Minor 6th", new Set([0, 3, 7, 9]), 59],
  ["Half-Diminished 7th", new Set([0, 3, 6, 10]), 55],
  ["Half-Diminished 7th (No 5th)", new Set([0, 3, 10]), 53],
  ["Diminished 7th", new Set([0, 3, 6, 9]), 54],
  ["Augmented", new Set([0, 4, 8]), 50],
  ["Diminished", new Set([0, 3, 6]), 49],
  ["Minor Augmented", new Set([0, 3, 8]), 40],
].sort((a, b) => Number(b[2]) - Number(a[2])); // スコアの高い順にソートしておく

/**
 * オクターブ番号のリスト
 */
export const OCTAVE_NUM_LIST: number[] = [1, 2, 3, 4, 5, 6];

/**
 * 純正律を構成する周波数比のリスト
 */
export const JUST_RATIOS: number[] = [
  1,
  16 / 15,
  9 / 8,
  6 / 5,
  5 / 4,
  4 / 3,
  45 / 32,
  3 / 2,
  8 / 5,
  5 / 3,
  16 / 9,
  15 / 8,
];


// --- 純正律偏差の計測 (evaluateSpectrum) の検出判定 ---

/**
 * 局所ノイズフロアの推定に使う範囲 (半音)。
 * 目標周波数 ±この半音数に入るビンの dB 値の中央値をノイズフロアとする
 * (構成音の探索窓 + 主ローブ幅のビンは除く)
 */
export const NOISE_FLOOR_RANGE_SEMITONES = 4;

/**
 * 局所ノイズフロアの推定に必要な最小ビン数。
 * 構成音の探索窓を除いた残りがこれに満たないとき (fftSize が小さい・低音域で和音が密) は
 * 推定不能として、ノイズフロア基準の判定を行わない (絶対値のしきい値だけで判定する)
 */
export const NOISE_FLOOR_MIN_BINS = 5;

/**
 * 窓関数の主ローブの半幅 (ビン)。AnalyserNode の Blackman 窓は主ローブが ±3 ビン。
 * 正弦波 1 本のエネルギーは、ピーク位置からこのビン数の範囲に集中する
 */
export const MAIN_LOBE_HALF_WIDTH_BINS = 3;

/**
 * 検出マージンの既定値 (dB)。
 * 探索窓内のピークが「局所ノイズフロア + この値」以上のときだけ鳴っていると判定する。
 * 絶対値のしきい値 (evalThreshold) だけでは、ノイズフロアがしきい値より高い環境で
 * 鳴っていない構成音にも偏差を出してしまうため、ノイズフロア基準の判定を併用する
 */
export const EVAL_MARGIN_DB_DEFAULT = 15;

/**
 * 範囲外判定のガード帯 (セント)。
 * 探索窓 (±evalRangeCents) の外側、目標周波数 ±この値までを調べ、検出判定を満たす成分が
 * あれば「探索窓の外にずれて鳴っている」と判定する (isOutOfRange)。
 * 100 セント = 半音。これより離れた成分は別の音とみなす
 */
export const OUT_OF_RANGE_GUARD_CENTS = 100;
