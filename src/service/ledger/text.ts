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

/** 章节正文里单独一行的判断引用（`> ^d1`、`> ^n3`、`> ^j12`、`> ^new1`），D61 起可写在正文任意位置。 */
const REFERENCE_LINE = /^ {0,3}>\s*\^([A-Za-z]*\d+)\s*$/;

/** 把正文引用行里的编号换成另一套编号；围栏内是示例文字，不换。返回 undefined 的引用行去掉。 */
export function mapReferenceLines(text: string, resolve: (token: string) => string | undefined): string {
  return markdownLines(text.split('\n')).flatMap(({ line, code }) => {
    const ref = !code && REFERENCE_LINE.exec(line);
    if (!ref) return [line];
    const id = resolve(ref[1]);
    return id ? [`> ^${id}`] : [];
  }).join('\n');
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
