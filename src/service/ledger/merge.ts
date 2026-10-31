import { markdownLines } from './text';
import { isLedgerBoundary, parseLedger } from './parse';

const DEFINITION = /^(?:[◆◇？?✗⏸⊃]\s+|走向\s+)([jpc]\d+)\b/m;
const definitions = (text: string): string[] => text.split('\n').flatMap(line => {
  const m = DEFINITION.exec(line);
  return m ? [m[1]] : [];
});

/** 只改语法中的编号，正文、标题里的 jN 和重复句子都原样保留。 */
function remap(text: string, ids: Map<string, string>): string {
  const id = (s: string) => ids.get(s) ?? s;
  return markdownLines(text.split('\n'), isLedgerBoundary).map(({ line, code }) => {
    // 章节正文中的节点引用也要随并发编号重映射；普通正文里的 jN 不动。
    if (!code && /^>\s*\^j\d+\s*$/.test(line)) return line.replace(/j\d+/, id);
    if (DEFINITION.test(line)) {
      const m = DEFINITION.exec(line)!;
      line = line.slice(0, m.index) + line.slice(m.index).replace(m[1], id(m[1]));
      return line.replace(/( = )((?:[jc]\d+\s*)+)(?=\s+@|$)/, (_, sep: string, refs: string) => sep + refs.replace(/[jc]\d+/g, id));
    }
    if (/^←\s/.test(line)) return line.replace(/[jc]\d+/g, id);
    const action = /^(本人|AI)\s+(改|删|接|断|序|拍|否|标|域|拆|并)\s+([jpc]\d+)(.*)$/.exec(line);
    if (!action) return line;
    const tail = ['接', '断', '序', '并'].includes(action[2])
      ? action[4].replace(/^(\s+(?:[jpc]\d+\s*)+)/, refs => refs.replace(/[jpc]\d+/g, id)) : action[4];
    return `${action[1]} ${action[2]} ${id(action[3])}${tail}`;
  }).join('\n');
}

// 同一来源场次稳定地产生替代编号，重复同步不继续改号。
function replacementId(header: string, original: string, used: Set<string>): string {
  for (let salt = 0; ; salt++) {
    let hash = 14695981039346656037n;
    for (const c of `${header}\0${original}\0${salt}`) hash = BigInt.asUintN(48, (hash ^ BigInt(c.codePointAt(0)!)) * 1099511628211n);
    const candidate = `${original[0]}${Number(hash) + 1_000_000_000_000}`;
    if (!used.has(candidate)) return candidate;
  }
}

/** 按完整场次合并；分叉新增编号重映射，后续行为与边跟随来源，绝不逐行去重。 */
export function mergeLedgers(local: string, remote: string): string {
  if (!local) return remote;
  if (!remote || local === remote) return local;
  if (local.startsWith(remote)) return local;
  if (remote.startsWith(local)) return remote;
  return merge(local, remote, { used: new Set(definitions(local)), assigned: new Map() });
}

/**
 * 一场操作（如整理）基于 base 算出 lines，期间账已被追加到 current（D63）：
 * 两边碰到的已有编号不重叠，就返回可接到最新账后的行（两边新开的编号撞了，这一场改用新编号）；
 * 碰了同一批判断或章节、或账被改写过（撤回、同步覆盖），返回 null，由调用方按最新内容重做。
 */
export function rebaseSession(base: string, current: string, lines: string[]): string[] | null {
  if (!current.startsWith(base)) return null;
  const refs = (text: string) => new Set(text.match(/\b[jpc]\d+\b/g) ?? []);
  let session = lines.join('\n');
  const created = definitions(session);
  const theirs = refs(current.slice(base.length));
  for (const id of refs(session)) if (!created.includes(id) && theirs.has(id)) return null;
  let next = Math.max(parseLedger(current).nextNum, ...created.map(id => Number(id.slice(1)) + 1));
  for (const id of created) if (theirs.has(id)) session = session.replace(new RegExp(`\\b${id}\\b`, 'g'), `${id[0]}${next++}`);
  return session.split('\n');
}

interface MergeIds { used: Set<string>; assigned: Map<string, string> }
const blocks = (text: string) => text.trimEnd().split(/(?=^\[场次\s)/m).filter(Boolean).map(b => b.trimEnd());
const header = (b: string) => b.startsWith('[场次 ') ? b.split('\n')[0] : '';

/** 在途读取遇到新草稿：只带回远端变化，远端未变的旧场次沿用用户现在的版本。 */
export function rebaseRemoteLedger(before: string, current: string, remote: string): string {
  if (before === current) return remote;
  const original = new Map(blocks(before).map(block => [header(block), block]));
  const edited = new Map(blocks(current).map(block => [header(block), block]));
  return blocks(remote).flatMap(block => {
    const previous = original.get(header(block));
    const latest = edited.get(header(block));
    if (previous === undefined || previous === latest) return [block];
    // 远端相对保存前的快照没有新行，不能重放已撤销或原位改过的内容。
    if (previous === block || previous.startsWith(`${block}\n`)) return latest ? [latest] : [];
    // 同一场次只追加了新行：保留本地正文，再带上追加部分。
    if (block.startsWith(`${previous}\n`)) return [[latest ?? header(block), block.slice(previous.length + 1)].filter(Boolean).join('\n')];
    // 两端都原位改同一场次，交给合账报告冲突，不猜哪份正确。
    return [block];
  }).join('\n');
}

function merge(local: string, remote: string, shared: MergeIds): string {
  const localBlocks = blocks(local);
  const known = new Map(localBlocks.map(b => [header(b), b]));
  const { used, assigned } = shared;
  const ids = new Map<string, string>();
  const tail: string[] = [];
  let extended = false;
  for (const block of blocks(remote)) {
    const key = header(block);
    const existing = known.get(key);
    const incomingIds = definitions(block);
    if (existing !== undefined) {
      const existingIds = definitions(existing);
      incomingIds.forEach((ref, i) => {
        if (existingIds[i]) {
          ids.set(ref, existingIds[i]);
          assigned.set(`${key}\0${ref}`, existingIds[i]);
        }
      });
      for (const ref of incomingIds.slice(existingIds.length)) {
        const identity = `${key}\0${ref}`;
        const mapped = assigned.get(identity) ?? (used.has(ref) ? replacementId(key, ref, used) : ref);
        ids.set(ref, mapped);
        assigned.set(identity, mapped);
        used.add(mapped);
      }
      const mapped = remap(block, ids);
      if (existing.startsWith(mapped)) continue; // 另一端仍是同一场次较早的快照。
      if (!mapped.startsWith(existing)) throw new Error('同一场次存在不同修改，已保留本地内容，请核对后再同步。');
      localBlocks[localBlocks.indexOf(existing)] = mapped;
      known.set(key, mapped);
      extended = true;
      continue;
    }
    for (const ref of incomingIds) {
      const identity = `${key}\0${ref}`;
      const mapped = assigned.get(identity) ?? (used.has(ref) ? replacementId(key, ref, used) : ref);
      ids.set(ref, mapped);
      assigned.set(identity, mapped);
      used.add(mapped);
    }
    const mapped = remap(block, ids);
    tail.push(mapped);
    known.set(key, mapped);
  }
  const base = extended ? localBlocks.join('\n') : local;
  return tail.length ? [base.trimEnd(), ...tail].filter(Boolean).join('\n') : base;
}
