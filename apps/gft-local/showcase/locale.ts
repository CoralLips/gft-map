export type ShowcaseLanguage = 'zh' | 'en';

export function initialLanguage(): ShowcaseLanguage {
  const explicit = new URLSearchParams(location.search).get('lang');
  if (explicit === 'en' || explicit === 'zh') return explicit;
  try {
    const saved = localStorage.getItem('gft_showcase_lang');
    if (saved === 'en' || saved === 'zh') return saved;
  } catch { /* Browser storage is optional. */ }
  return navigator.language.toLowerCase().startsWith('zh') ? 'zh' : 'en';
}

export const english: Record<string, string> = {
  '关闭': 'Close', '关闭提示': 'Dismiss', 'Log · 来源': 'Log',
  '切换浅色': 'Switch to light mode', '切换深色': 'Switch to dark mode',
  '选择样例': 'Choose an example', '在本地使用': 'Use locally',
  '可编辑的产品示例': 'Editable example', '体验步骤': 'Explore the example',
  '看清已经想到哪儿': 'See the current decisions', '点节点，查看决定和理由': 'Open a node to read its reasoning',
  '把理解改成你的': 'Make a correction', '直接编辑主题、正文和判断': 'Edit the topic, document, and decisions',
  '交给下一场聊天': 'Continue in another chat', '预览索引与当前正文': 'Preview the index and current content',
  '带到自己的本地面板': 'Take it to your local app', '下载、导入，继续使用': 'Download, import, and keep working',
  '这里使用本地版同一套图文组件。案例为人工编写的示例，不是真实用户聊天，也不是模型效果评测。': 'This uses the same document and map components as the local app. The examples are authored material, not real user chats or model evaluations.',
  '编辑仅保存在此浏览器标签页；在线示例不连接你的聊天或模型。更新、整理、重画请在本地版使用。': 'Edits stay in this browser tab. The demo does not access your chats or call a model. Use the local app for Update, Tidy, and Redraw.',
  '中英文示例分别保留试改；切换语言不会翻译或覆盖你的编辑。': 'Each language keeps its own edits. Switching languages does not translate or overwrite your work.',
  '恢复本例': 'Reset example', '恢复这份示例的初始内容，放弃本例尚未导出的试改。其他脉络不变。': 'Restore this example to its original content and discard edits that have not been exported. Other maps stay unchanged.',
  '恢复': 'Reset', '已恢复本例。': 'Example reset.', '查看源码': 'View source',
  'GFT Map 可交互面板': 'Interactive GFT Map panel', '示例': ' example', '浏览器内试用': 'Browser demo',
  'Log · 收到的来源材料': 'Log · Received sources',
  '这份示例的原始讨论保留在这里。主题筛选影响 Doc／Map，来源不会随主题改变而删掉。': 'The original example discussion is kept here. The topic filters Doc and Map, without removing sources from Log.',
  '尚无来源材料。': 'No sources yet.', '下一场聊天，能读到什么？': 'What can the next chat read?',
  'Agent 先取得已连接主题的简短索引，再按当前任务选择正文。这里展示读取内容，不启动模型或代替 Agent 作答。': 'The agent checks a brief index of connected maps, then chooses what to read for its task. This is a content preview, not a live agent response.',
  '主题索引 · 当前版本': 'Map index · Current version', '范围：': 'Scope: ', '当前主线：': 'Current direction: ', '尚未填写': 'Not set',
  '收起正文': 'Hide content', '预览按需读取的正文': 'Preview content available to the agent',
  '在本地 Agent 里这样继续': 'Continue with your local agent', '使用 gft-map，': 'Use gft-map to ',
  '先把这份脉络包导入本地版，再在那场聊天连接它。右侧更新不会自动唤醒聊天；再次读取时会得到当前内容。': 'Import this map into the local app, then connect it in your chat. Updates do not automatically wake the chat; reading again returns the current content.',
  '把这份上下文带走': 'Take this context with you',
  '导出的是当前版本，包含你刚才的修改，以及主题、Doc、Map 和已接收的 Log。': 'The download includes the current topic, Doc, Map, and Log, including your edits.',
  '下载当前脉络包 .json': 'Download this map (.json)',
  '打开本地 GFT Map。在设置里选择「导入脉络」。': 'Open your local GFT Map. Choose Import maps in Settings.',
  '选中刚下载的文件。它会成为一份新脉络，原来的内容不会被覆盖。': 'Select the downloaded file. It creates a new map without replacing existing content.',
  '在新的聊天中连接这份脉络，让 Agent 按需读取。': 'Connect this map in a new chat so your agent can read it when needed.',
  '也可以在本页左上角的脉络菜单中重新导入文件，试一次完整来回。': 'You can also import the file in this demo to try the full round trip.',
  '连接关系、聊天读取进度和账号凭证不随文件迁移。在线文件只在浏览器内读取，不上传服务器。': 'Chat connections, reading progress, and credentials are not included. Files in this demo are read locally in your browser, not uploaded.',
  '还没安装？查看本地使用步骤': 'Not installed yet? See the setup steps',
  '示例材料': 'Example material',
  '在线示例不连接模型。安装本地版后，重画会按当前主题重新筛选 Log，生成新的 Doc 和 Map。': 'This demo does not call a model. In the local app, Redraw rebuilds Doc and Map from Log using the current topic.',
  '浏览器暂时无法保存这份试改。当前页面仍可使用，请导出脉络包保留修改。': 'Browser storage is unavailable. You can keep working, but download the map to keep your edits.',
  '这是可编辑的浏览器示例，不连接模型或本机聊天。安装本地版后，可执行更新、整理和重画。': 'This editable demo does not access a model or local chats. Install the local app to use Update, Tidy, and Redraw.',
  '至少保留一份示例；可以用“恢复本例”重新开始。': 'Keep at least one map. Use Reset example to start again.',
  '已导入为一份新脉络，原来的示例仍保留。文件只在此浏览器中读取。': 'Imported as a new map. The original example is preserved; the file was read only in this browser.',
  '在线示例不运行模型。请安装本地版后使用这项操作；当前修改已保留。': 'This demo does not run a model. Install the local app to use this action. Your edits are kept.',
};

export function translator(lang: ShowcaseLanguage) {
  return (text: string) => lang === 'en' ? english[text] ?? text : text;
}
