<p align="center"><strong>English</strong> · <a href="README_ZH.md">简体中文</a></p>

# GFT-Map

## Don't lose what you worked out with AI.

**Turn the ideas and decisions from your AI conversations into a working document you can read, edit, and take with you.**

As a conversation grows, it gets harder to find what you decided, why, and what remains unresolved. GFT-Map puts those ideas into an editable document and relationship map, so you can review the reasoning, correct a decision, and keep thinking.

Your work is saved locally. Export it to share with someone else, or let an agent read it in your next conversation.

[Explore examples](https://corallips.github.io/gft-map/index.en.html) · [Get started](#get-started) · [Everyday use](#everyday-use)

[![GFT-Map: explore a map, edit its document, preview context, and export it](https://raw.githubusercontent.com/CoralLips/gft-map/main/apps/gft-local/showcase/assets/product.en.png)](https://corallips.github.io/gft-map/demo.html?lang=en&case=product)

### See it in use

| Product decisions | Writing | Technical planning |
|---|---|---|
| [![A map of product decisions](https://raw.githubusercontent.com/CoralLips/gft-map/main/apps/gft-local/showcase/assets/product.en.png)](https://corallips.github.io/gft-map/demo.html?lang=en&case=product) | [![An editable writing document](https://raw.githubusercontent.com/CoralLips/gft-map/main/apps/gft-local/showcase/assets/writing.en.png)](https://corallips.github.io/gft-map/demo.html?lang=en&case=writing&view=doc) | [![Technical constraints and a validation plan](https://raw.githubusercontent.com/CoralLips/gft-map/main/apps/gft-local/showcase/assets/engineering.en.png)](https://corallips.github.io/gft-map/demo.html?lang=en&case=engineering) |
| Keep the tradeoffs and their reasons. | Organize ideas and clarify your position. | Keep track of constraints and open questions. |
| [Open example →](https://corallips.github.io/gft-map/demo.html?lang=en&case=product) | [Open example →](https://corallips.github.io/gft-map/demo.html?lang=en&case=writing&view=doc) | [Open example →](https://corallips.github.io/gft-map/demo.html?lang=en&case=engineering) |

The examples use prewritten material, with English and Chinese versions. Edit and export them without installing anything or calling a model. AI-powered Update, Tidy, and Redraw require the local app.

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

With Claude Code, run `claude auth login` once in a terminal first. First use needs internet access to prepare connection components; the page and saved content can open while preparation runs.

After installing, reopen your agent conversation and ask:

> Open gft-map for me.

The panel usually runs at `http://127.0.0.1:4317/`; use the address your agent returns. To change the panel language, open **Settings → Language**.

Choose Codex or Claude Code in **Settings → AI processing**. Page AI actions use that agent's account quota. The provider-recommended model is the default, and you can pick another one there; effort always stays the chosen model's default. The conversations you bring in can come from either agent; for example, Claude Code can process a Codex conversation. [Agent and usage details (Chinese)](https://github.com/CoralLips/gft-map/blob/main/apps/gft-local/ADVANCED.md#installation)

### 2. Connect a conversation and create a map

1. Create a new map in the panel and click **Update**.
2. Select a Codex or Claude Code conversation. Choose **Include existing content** to import its past messages.
3. Read and edit the document in **Doc**; explore decisions and relationships in **Map**.

Later, click **Update** to read all conversations connected to this map in sequence, bringing in only new messages. Long conversations, including oversized individual messages, are processed in batches. Stop at any time; the next update resumes after the completed batches.

**Already have a file?** Click **Import** at the top right to add UTF-8 text, Markdown, or chat records. Materials are organized by topic in batches, with each result appearing in Doc/Map. **Pause or continue** at any time. [Large-file details (Chinese)](https://github.com/CoralLips/gft-map/blob/main/apps/gft-local/ADVANCED.md#materials)

### 3. Keep thinking, with your agent alongside

In your current or a new agent conversation, say which map to read and what you want to do next. For example:

> Use gft-map to connect to and read “Product launch plan.” Help me plan next week's work based on the current progress.

Replace the name and task with your own. The agent first checks a brief index of connected maps, then decides which content to read for the task. Panel edits don't automatically wake the chat; ask the agent to read again when needed.

<a id="日常使用"></a>

## Everyday use

Each map includes **Doc for writing, Map for relationships, and Log for source material**. The topic decides what belongs in Doc and Map; Log keeps the original material you received.

| What you want to do | Action |
|---|---|
| Bring in new progress from a conversation | **Update**: receive new messages and update Doc / Map. |
| Clarify your notes and combine repeated ideas | **Tidy**: organize the document and nodes within the topic; keep the existing topic text unchanged. |
| Change the focus and revisit existing material | Edit the topic, then **Redraw**: generate Doc / Map from Log using the current topic. |

**What Tidy changes:** with one node selected, only that node's title and explanation change, not Doc. With several selected, it revises those ideas and their related text. With nothing selected, it tidies the whole map. Click again to stop.

**Edit directly:** the topic, document, and Log are all editable; click outside the editor or press Ctrl+S to save. In Map, click a node to edit its title and explanation, or click a line to edit how one idea leads to the next. [Editing and selection details (Chinese)](https://github.com/CoralLips/gft-map/blob/main/apps/gft-local/ADVANCED.md#editing)

**Tasks and undo:** switching maps, refreshing, or closing the page does not stop an AI task that has started; come back to see its progress or stop it. While it runs, the button shows the edit the AI is writing, such as which items it merges or which chapter it rewrites. **Ctrl+Z** undoes changes in order and **Ctrl+Y** redoes them, even after a refresh, and **Operation history** in Settings shows and undoes the latest 30 changes. Undoing a chat update keeps the original material, and the next update reads those messages again.

**Take your work with you**

- **Copy**: copy the current Doc for someone else or another agent.
- **Download**: save the complete map file, then use **Import** in another GFT-Map installation to keep working. For a map with file materials, pause processing and download its `.gftpack` to carry the originals, edits, and progress.

No GFT account is needed for local use; use Download and Import to move between computers. Cloud sync is not currently a recommended workflow; existing account users can check its behavior in the [detailed guide (Chinese)](https://github.com/CoralLips/gft-map/blob/main/apps/gft-local/ADVANCED.md#account).

**Where does your data go?** Maps and received chat text stay on your computer. AI-powered Update, Tidy, and Redraw send the materials needed for the task to your selected agent's model service, using its account quota. If you sign in to GFT, your maps, including Log, sync to GFT's cloud. GFT-Map does not scan or upload all your project files or conversations.

## Open, close, and update

Ask your agent to **open or close GFT-Map**. Closing the page leaves the service running. After restarting your computer, or if the page is unavailable, ask your agent to open GFT-Map again. [Service and troubleshooting details (Chinese)](https://github.com/CoralLips/gft-map/blob/main/apps/gft-local/ADVANCED.md#打开本地页面)

<a id="update-your-installation"></a>

**To update**, ask your agent:

> Use gft-map to update to the latest stable release. Keep my maps, chat connections, and settings. Restart the panel and verify that the running version matches the installed version.

Pause file processing and finish or cancel other running tasks before updating. Existing data and progress are preserved. [Update and recovery details (Chinese)](https://github.com/CoralLips/gft-map/blob/main/apps/gft-local/ADVANCED.md#upgrade)

## Project status and feedback

The current stable release is [v0.3.13](https://github.com/CoralLips/gft-map/releases/latest). The current feature set is complete; work now focuses on fixes and maintenance.

Sibling tool: [GFT-Merge](https://github.com/CoralLips/gft-merge) combines several Claude Code and Codex sessions and starts a new session that carries their context.

Try it with your own writing, decisions, or technical discussions. Share your use case, problems, or a document you made in [Issues](https://github.com/CoralLips/gft-map/issues). If it helps you, a Star is welcome too.

---

[Detailed guide (Chinese)](https://github.com/CoralLips/gft-map/blob/main/apps/gft-local/ADVANCED.md) · [Contributing (Chinese)](https://github.com/CoralLips/gft-map/blob/main/apps/gft-local/CONTRIBUTING.md) · [Report an issue](https://github.com/CoralLips/gft-map/issues) · [MIT License](https://github.com/CoralLips/gft-map/blob/main/LICENSE)

If something goes wrong, include the steps you took and any error message. Remove private conversations and credentials before sharing.
