/**
 * ChordLens core 型定義
 */

import { z } from "zod";
import { PITCH_NAME_LIST } from "./constants";

/**
 * 構成音 1 つ分の入力スキーマ
 */
export const FormSchema = z.object({
  pitchName: z.string().refine((val) => PITCH_NAME_LIST.includes(val), {
    message: "音名を選択してください",
  }),
  octaveNum: z.coerce.number({
    required_error: "オクターブ番号を選択してください",
  }),
  isRoot: z.boolean().optional(),
  enabled: z.boolean().default(true),
});

/**
 * ピッチ（音高）を表す型
 * 音名、オクターブ番号、根音フラグ、計測対象フラグから構成される
 * z.output を使用して default が適用された後の型を取得
 */
export type Pitch = z.output<typeof FormSchema>;
