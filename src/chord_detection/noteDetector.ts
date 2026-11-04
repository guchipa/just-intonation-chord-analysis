/**
 * NoteDetector - プラットフォーム非依存の構成音検出抽象
 *
 * 録音済みのモノラル音声バッファから構成音 (MIDI ノートイベント) を推定する契約。
 * 推定結果は chordToneEstimation.ts の noteEventsToPitchList で
 * 構成音リスト (Pitch[]) に変換する。
 *
 * 実装は HarmonicNoteDetector (noteDetection.ts) のみ。
 * 別方式の検出器を差し込めるようにインターフェースとして分離している
 */

export interface DetectedNoteEvent {
  /** MIDI ノート番号 (A4 = 69)。平均律基準の半音格子 */
  midiNote: number;
  /** ノート開始時刻 (秒、バッファ先頭基準) */
  startTimeSeconds: number;
  /** ノート長 (秒) */
  durationSeconds: number;
  /** 音量・信頼度 (0〜1) */
  amplitude: number;
  /**
   * フレームの採択閾値に届かなかった候補の連続サリエンス標本。
   * scoreMode "medianSalience" の集約でのみ使い、確定検出として扱わない
   */
  provisional?: boolean;
}

export interface NoteDetector {
  /** detectNotes に渡す音声バッファの要求サンプルレート (Hz) */
  readonly requiredSampleRate: number;

  /**
   * モノラル音声バッファから構成音のノートイベントを推定する。
   * @param monoAudio requiredSampleRate でサンプリングされたモノラル PCM
   */
  detectNotes(monoAudio: Float32Array): Promise<DetectedNoteEvent[]>;
}
