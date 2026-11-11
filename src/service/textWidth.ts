/**
 * Length in Chinese-character widths: characters below the CJK blocks (Latin letters, digits,
 * spaces) take half a width, so a limit written for Chinese gives other languages a comparable line.
 */
export const textWidth = (text: string): number =>
  Array.from(text).reduce((n, ch) => n + (ch.codePointAt(0)! < 0x2e80 ? 0.5 : 1), 0);
