<p align="center"><strong>English</strong> · <a href="README_ZH.md">简体中文</a></p>

# GFT Map

## Pick up where the conversation left off.

A new chat can lose track of earlier decisions and why you made them. You can't easily see what the AI remembers.

**GFT Map turns those decisions, reasons, and open questions into context you can inspect, correct, and take with you.** Your agent can read it when needed and continue the work in another conversation.

[Explore examples](https://corallips.github.io/gft-map/) · [Get started](#get-started) · [Everyday use](#everyday-use)

[![GFT Map: explore a map, edit its document, preview context, and export it](https://raw.githubusercontent.com/CoralLips/gft-map/main/apps/gft-local/showcase/assets/walkthrough.gif)](https://corallips.github.io/gft-map/demo.html?case=product)

### See it in use

| Product decisions | Writing | Technical planning |
|---|---|---|
| [![A map of product decisions](https://raw.githubusercontent.com/CoralLips/gft-map/main/apps/gft-local/showcase/assets/product.png)](https://corallips.github.io/gft-map/demo.html?case=product) | [![An editable writing document](https://raw.githubusercontent.com/CoralLips/gft-map/main/apps/gft-local/showcase/assets/writing.png)](https://corallips.github.io/gft-map/demo.html?case=writing&view=doc) | [![Technical constraints and a validation plan](https://raw.githubusercontent.com/CoralLips/gft-map/main/apps/gft-local/showcase/assets/engineering.png)](https://corallips.github.io/gft-map/demo.html?case=engineering) |
| Keep the tradeoffs and their reasons. | Organize ideas and clarify your position. | Keep track of constraints and open questions. |
| [Open example →](https://corallips.github.io/gft-map/demo.html?case=product) | [Open example →](https://corallips.github.io/gft-map/demo.html?case=writing&view=doc) | [Open example →](https://corallips.github.io/gft-map/demo.html?case=engineering) |

The examples use prewritten material, currently in Chinese. Edit and export them without installing anything or calling a model. AI-powered Update, Tidy, and Redraw require the local app.

<a id="第一次使用"></a>
<a id="开始使用"></a>

## Get started

### 1. Install the skill and open the panel

You'll need **Node.js 22.20+** and your agent's CLI installed and signed in. Choose your agent:

**Codex**

```sh
npx skills add CoralLips/gft-map --skill gft-map --agent codex --global
```

**Claude Code**

```sh
npx skills add CoralLips/gft-map --skill gft-map --agent claude-code --global
```

AI actions in the panel have been tested with Codex. With Claude Code, they require additional setup and are experimental. See [installation and configuration (Chinese)](https://github.com/CoralLips/gft-map/blob/main/apps/gft-local/ADVANCED.md#installation).

After installing, reopen your agent conversation and ask:

> Use gft-map to check my environment, start the local panel with Update, Tidy, and Redraw enabled, and open the page for me.

The panel usually runs at `http://127.0.0.1:4317/`; use the address your agent returns. To change the panel language, open **Settings → Language**.

### 2. Connect a conversation and create a map

1. Create a new map in the panel and click **Update**.
2. Select a Codex or Claude Code conversation. Choose **Include existing content** to import its past messages.
3. Read and edit the document in **Doc**; explore decisions and relationships in **Map**.

Later, click **Update** again to bring in only new messages.

### 3. Continue with your agent

In your current or a new agent conversation, say which map to read and what you want to do next. For example:

> Use gft-map to connect to and read “Product launch plan.” Help me plan next week's work based on the current progress.

Replace the name and task with your own. The agent first checks a brief index of connected maps, then decides which content to read for the task. Panel edits don't automatically wake the chat; ask the agent to read again when needed.

<a id="日常使用"></a>

## Everyday use

Each saved map includes **Doc for writing, Map for relationships, and Log for source material**. Its editable topic scope defines what belongs in Doc and Map; Log keeps all the sources received, regardless of that scope.

Edit the topic, document, or Log directly. Click outside the editor or press Ctrl+S to save.

| What you want to do | Action |
|---|---|
| Bring in new progress from a conversation | **Update**: receive new messages and update Doc / Map. |
| Clarify your notes and combine repeated ideas | **Tidy**: organize the current topic, document, and nodes. |
| Change the focus and revisit existing material | Edit the topic, then **Redraw**: generate Doc / Map from Log using the current topic. |

**Take your work with you**

- **Copy**: copy the current Doc for someone else or another agent.
- **Download**: save the complete map file. Use **Settings → Import maps** in another GFT Map installation to keep working.

No GFT account is needed for local use. Optionally sign in to the [GFT platform](https://gitforthought.com) in Settings for automatic two-way sync. [Sync details (Chinese)](https://github.com/CoralLips/gft-map/blob/main/apps/gft-local/ADVANCED.md#account)

---

[Detailed guide (Chinese)](https://github.com/CoralLips/gft-map/blob/main/apps/gft-local/ADVANCED.md) · [Contributing (Chinese)](https://github.com/CoralLips/gft-map/blob/main/apps/gft-local/CONTRIBUTING.md) · [Report an issue](https://github.com/CoralLips/gft-map/issues) · [MIT License](https://github.com/CoralLips/gft-map/blob/main/LICENSE)

If something goes wrong, include the steps you took and any error message. Remove private conversations and credentials before sharing.
