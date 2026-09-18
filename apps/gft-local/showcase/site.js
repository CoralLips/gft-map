document.querySelectorAll('[data-agent]').forEach(button => button.addEventListener('click', () => {
  const agent = button.dataset.agent;
  document.querySelectorAll('[data-agent]').forEach(tab => tab.setAttribute('aria-pressed', String(tab === button)));
  document.getElementById('install-command').textContent = `npx skills add CoralLips/gft-map --skill gft-map --agent ${agent} --global`;
  document.getElementById('agent-note').textContent = agent === 'codex'
    ? 'Codex 页面执行已做真实任务验收。安装 Skill 后可能需要重新打开会话。'
    : 'Claude Code 的 Skill 安装与聊天来源可用；Claude ACP 模型执行及跨客户端续接仍为实验性。也可用 Codex 执行器处理所选 Claude 聊天。';
}));
document.querySelectorAll('[data-copy]').forEach(button => button.addEventListener('click', async () => {
  const label = button.textContent;
  try { await navigator.clipboard.writeText(document.getElementById(button.dataset.copy).textContent); button.textContent = '已复制'; }
  catch { button.textContent = '请选中文字复制'; }
  setTimeout(() => { button.textContent = label; }, 2500);
}));
