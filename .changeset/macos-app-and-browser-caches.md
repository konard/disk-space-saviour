---
'disk-space-saviour': minor
---

Find more regenerable data on developer Macs. New rules cover app updates
staged by Sparkle and Squirrel (ShipIt), Chrome, Yandex Browser and Firefox
HTTP caches, the Discord cache, Cursor, Windsurf and Qoder caches, the
TypeScript type acquisition cache, the rust-script cache, old playwright-go
drivers, Claude Code MCP logs and abandoned Codex runtime installs. Each
browser and updater has its own busy check, so a running Chrome does not hold
back the Firefox cache. Browser, editor and Claude Code paths are also listed
for Linux (`~/.cache`, `~/.config`) and Windows (`%LOCALAPPDATA%`, `%APPDATA%`).

Extension folders of VS Code forks (`.windsurf`, `.codeium`, `.qoder`, `.kiro`,
`.trae`) are no longer searched for projects: their bundled `node_modules`
were reported as removable, and deleting them breaks the extension.
