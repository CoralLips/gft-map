/**
 * What a running model call has written so far, read as edit actions the page can
 * show while it waits. Only complete tags and lines count; nothing here is applied.
 */
const ACTION =
  /<(merge|add|drop|revise|link|unlink)\b([^>]*?)\/>|<prose\b([^>]*)>|^###\s*[◆◇？✗⏸]?\s*(\S.*)$/gm;

const attributes = text =>
  Object.fromEntries([...(text || '').matchAll(/(\w+)="([^"]*)"/g)].map(m => [m[1], m[2]]));

/** `aliases` maps the call's short judgment names (n1, n2…) to node ids. */
export function progressOf(text, aliases = {}) {
  const ids = (...names) =>
    names
      .flatMap(name => (name || '').split(','))
      .map(name => aliases[name.trim()])
      .filter(Boolean);
  const actions = [];
  for (const match of text.matchAll(ACTION)) {
    const [whole, kind, tagAttributes, proseAttributes, heading] = match;
    if (heading !== undefined) {
      // A heading counts once its line is finished.
      if (text[match.index + whole.length] === '\n')
        actions.push({ kind: 'node', title: heading.trim() });
      continue;
    }
    if (proseAttributes !== undefined) {
      const { domain } = attributes(proseAttributes);
      if (domain && domain !== '主题') actions.push({ kind: 'prose', domain });
      continue;
    }
    const a = attributes(tagAttributes);
    if (kind === 'merge') actions.push({ kind, title: a.title, ids: ids(a.members) });
    else if (kind === 'add') actions.push({ kind, title: a.title, ids: [] });
    else if (kind === 'drop') actions.push({ kind, ids: ids(a.id) });
    else if (kind === 'revise') actions.push({ kind, title: a.title, ids: ids(a.id) });
    else actions.push({ kind, ids: ids(a.from, a.to) });
  }
  return actions;
}
