/**
 * src が前提とする最小限のホスト環境グローバル。
 * console はブラウザ / Node.js / React Native (Hermes) のすべてに存在する。
 * DOM lib・@types/node を読み込まない tsconfig.json のための宣言。
 */
declare const console: {
  log(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
};
