/** 正文的账语法转义：普通文字与路径原样写，只给指令样行加一个反斜杠。 */
const RESERVED_LINE = /^(?:\[场次\s|走向(?:\s|\[)|[◆◇？?✗⏸⊃←]\s|(?:本人|AI)\s|重画\s*$)/;
const needsEscape = (line: string) => RESERVED_LINE.test(line.replace(/^\\+/, ''));

export function bodyLines(text: string): string[] {
  return text.replace(/\n+$/, '').split('\n').map(line =>
    needsEscape(line) ? `\\${line}` : line,
  );
}

/** undefined 表示未转义；解码后的行只能进入正文，不能再解释为操作。 */
export function literalLine(line: string): string | undefined {
  if (!line.startsWith('\\')) return undefined;
  const body = line.slice(1);
  return needsEscape(body) ? body : undefined;
}

/** Markdown 围栏内的标题、节点引用都是示例文字；兼容反引号、波浪线和较长围栏。 */
export function markdownLines(lines: string[], boundary?: (line: string) => boolean): Array<{ line: string; code: boolean }> {
  let fence: string | undefined;
  return lines.map(line => {
    // 账的下一块拥有独立正文，上一块未闭合的 Markdown 不能越过真实操作边界。
    if (boundary?.(line)) fence = undefined;
    const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (fence) {
      if (marker && marker[1][0] === fence[0] && marker[1].length >= fence.length && !marker[2].trim()) fence = undefined;
      return { line, code: true };
    }
    if (marker && (marker[1][0] !== '`' || !marker[2].includes('`'))) {
      fence = marker[1];
      return { line, code: true };
    }
    return { line, code: false };
  });
}
