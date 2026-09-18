// This subprocess receives a synthetic CLAUDE_CONFIG_DIR from source-readers.test.mjs.
import { pathToFileURL } from 'node:url';
const moduleUrl = process.argv[4] ? pathToFileURL(process.argv[4]).href : new URL('../../sourceReaders.mjs', import.meta.url).href;
const { readChatDelta } = await import(moduleUrl);
const result = await readChatDelta({ provider: 'claude', id: process.argv[2], cwd: process.argv[3] });
console.log(JSON.stringify({ ids: result.messages.map(message => message.id), hasMore: result.hasMore }));
