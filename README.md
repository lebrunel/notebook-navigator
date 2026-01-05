Read in your language: [English](https://notebooknavigator.com/docs.html) • [العربية](https://notebooknavigator.com/ar/docs.html) • [Deutsch](https://notebooknavigator.com/de/docs.html) • [Español](https://notebooknavigator.com/es/docs.html) • [فارسی](https://notebooknavigator.com/fa/docs.html) • [Français](https://notebooknavigator.com/fr/docs.html) • [Bahasa Indonesia](https://notebooknavigator.com/id/docs.html) • [Italiano](https://notebooknavigator.com/it/docs.html) • [Nederlands](https://notebooknavigator.com/nl/docs.html) • [Polski](https://notebooknavigator.com/pl/docs.html) • [Português](https://notebooknavigator.com/pt/docs.html) • [Português (Brasil)](https://notebooknavigator.com/pt-br/docs.html) • [Русский](https://notebooknavigator.com/ru/docs.html) • [ไทย](https://notebooknavigator.com/th/docs.html) • [Türkçe](https://notebooknavigator.com/tr/docs.html) • [Українська](https://notebooknavigator.com/uk/docs.html) • [Tiếng Việt](https://notebooknavigator.com/vi/docs.html) • [日本語](https://notebooknavigator.com/ja/docs.html) • [한국어](https://notebooknavigator.com/ko/docs.html) • [中文简体](https://notebooknavigator.com/zh-cn/docs.html) • [中文繁體](https://notebooknavigator.com/zh-tw/docs.html)

![Obsidian Downloads](https://img.shields.io/badge/dynamic/json?logo=obsidian&color=%23483699&label=Downloads&query=%24%5B%22notebook-navigator%22%5D.downloads&url=https%3A%2F%2Fraw.githubusercontent.com%2Fobsidianmd%2Fobsidian-releases%2Fmaster%2Fcommunity-plugin-stats.json)
![Obsidian Compatibility](https://img.shields.io/badge/Obsidian-v1.8.7+-483699?logo=obsidian&style=flat-square)
[![Discord](https://img.shields.io/discord/1405458145974943846?color=7289da&label=Discord&logo=discord&logoColor=white)](https://discord.gg/6eeSUvzEJr)

![Notebook Navigator Screenshot](https://github.com/johansan/notebook-navigator/blob/main/images/notebook-navigator.png?raw=true)

Notebook Navigator is a plugin for [Obsidian](https://obsidian.md) that replaces the default file explorer with a Notes-style interface with a dual-pane layout.

If you love using Notebook Navigator, please consider [☕️ Buying me a coffee](https://buymeacoffee.com/johansan) or [Sponsor on GitHub ❤️](https://github.com/sponsors/johansan).

<a href="https://www.buymeacoffee.com/johansan" target="_blank"><img src="https://cdn.buymeacoffee.com/buttons/v2/default-yellow.png" alt="Buy Me A Coffee" style="height: 60px !important;width: 217px !important;" ></a>

<br>

<!-- DOCUMENTATION_START -->

## 1 Installation

1. **Install Obsidian** - Download and install from [obsidian.md](https://obsidian.md/)
2. **Enable community plugins** - Go to Settings → Community plugins → Turn on community plugins
3. **Install Notebook Navigator** - Click "Browse" → Search for "Notebook Navigator" → Install
4. **Install Style Settings (optional)** - For customizing colors and appearance, install [Style Settings](https://github.com/mgmeyers/obsidian-style-settings) plugin by searching for "Style Settings" in Community plugins

For precise image management, consider also installing [Pixel Perfect Image](https://github.com/johansan/pixel-perfect-image) which lets you resize images to exact pixel dimensions and perform advanced image operations.

<br>

## 2 Getting started

Here is the official tutorial for installing and mastering Notebook Navigator:

[![Still Using Default File View in Obsidian? Watch This](https://raw.githubusercontent.com/johansan/notebook-navigator/main/images/youtube-thumbnail.jpg)](https://www.youtube.com/watch?v=BewIlG8wLAM)

The tutorial has subtitles in 21 languages, same as Notebook Navigator.

<br>

## 3 Features

### 3.1 Interface

- **Dual-pane layout** - Navigation pane (folders/tags) and list pane (files)
- **Single-pane mode** - Navigation and list views with animated transitions
- **Resizable panes** - Horizontal or vertical split orientation
- **Independent UI zoom** - Scale Notebook Navigator without changing Obsidian zoom
- **Startup view** - Navigation-first or list-first
- **Multi-language support** - 21 languages with RTL layout support
- **Interface icon set** - Customizable UI icons across the plugin

### 3.2 Navigation

- **Vault profiles** - Multiple filtered views with per-profile hidden folders/tags/notes, file visibility, banner, and shortcuts
- **Shortcuts** - Notes, folders, tags, and saved searches with pinning and reordering
- **Recent notes/files** - Recent items section stored per vault profile, optionally pinned with shortcuts
- **Folder tree** - Expand/collapse navigation with manual root folder ordering
- **Tag tree** - Hierarchical tags with configurable root tag ordering
- **Auto-reveal active file** - Folder expansion and scroll-to-selection
- **Keyboard and commands** - Configurable hotkeys, next/previous file commands, open shortcut 1–9 commands

### 3.3 Organization

- **Pin notes** - Keep important notes at the top of folders and tags
- **Folder notes** - Set/detach folder notes and pin folder notes
- **Tag operations** - Add/remove/clear tags, rename/delete tags, drag-and-drop tag hierarchy
- **Custom sort and grouping** - Override sort/group settings per folder or tag
- **Per-folder/tag appearances** - Title rows, preview rows, compact mode, descendants toggle
- **Hidden content** - Hidden folders/tags/notes/files with patterns and frontmatter properties
- **Color and icon system** - Folder/tag/file colors, icon packs, emoji/Lucide icons, frontmatter read/write, icon mapping by file name and file type category
- **Name warnings** - Warn about forbidden filesystem characters and characters that break Obsidian links when naming files and folders

### 3.4 File display

- **Note previews** - 1–5 preview lines with optional HTML stripping
- **Thumbnails** - Featured images plus auto-generated thumbnails stored in the metadata cache
- **External images** - Optional downloads for external images and YouTube thumbnails
- **Date grouping** - Group notes by Today, Yesterday, Previous 7 days, Previous 30 days, months, and years when sorted by date
- **Frontmatter support** - Read note names and timestamps from frontmatter fields
- **Note metadata** - Show modification date and tags in the file list
- **Compact mode** - Compact display when preview, date, and images are disabled
- **Clickable tags** - Tags in file list navigate directly to that tag

### 3.5 Productivity

- **Search** - Filename and tag filtering with AND/OR/exclusions, tag multi-selection, fuzzy tag search
- **Omnisearch integration** - Full-text search via [Omnisearch](https://github.com/scambier/obsidian-omnisearch)
- **Drag and drop** - File moves, tagging, shortcut assignment, tag tree reparenting, spring-loaded folders
- **Context menus** - Create notes/folders/canvases/bases/drawings and run file/tag actions
- **Drawings** - Create Excalidraw and Tldraw drawings from navigation and list pane menus
- **Templates** - New note from template commands with the Templater plugin
- **File operations** - Create, rename, duplicate, move, trash files and folders
- **Filtering** - Folder/tag/note/file exclusions with patterns and frontmatter properties

### 3.6 Advanced theming support on GitHub

- **Style Settings integration** - Full support for the [Style Settings](https://github.com/mgmeyers/obsidian-style-settings) plugin
- **CSS variables** - `--nn-theme-*` variables for colors, backgrounds, separators, and mobile surface tokens
- **Light/dark mode support** - Separate theming for light and dark modes
- **[Complete theming guide](docs/theming-guide.md)** - Detailed documentation with examples

### 3.7 Developer API on GitHub

- **Public API for JavaScript/TypeScript** - API for plugins and scripts to interact with Notebook Navigator
- **Metadata control** - Set folder/tag colors, icons, and manage pinned notes programmatically
- **Navigation & selection** - Navigate to files, folders, and tags, and query current selections
- **Event subscriptions** - Subscribe to Notebook Navigator events
- **Full type definitions** - Complete TypeScript support
- **[Complete API documentation](docs/api-reference.md)** - Detailed reference with examples

<br>

## 4 Documentation

- [**API Reference**](docs/api-reference.md) - Public API documentation. Covers metadata management, navigation control and event subscriptions for JavaScript/TypeScript developers.

- [**Theming Guide**](docs/theming-guide.md) - Guide for theme developers. Includes CSS class reference, custom
  properties, and theme examples for light and dark modes.

- [**Startup Process**](docs/startup-process.md) - Plugin initialization sequence. Cold boot vs warm boot flows,
  metadata cache resolution, deferred cleanup, and content generation pipeline. Includes Mermaid diagrams.

- [**Storage Architecture**](docs/storage-architecture.md) - Guide to storage containers (IndexedDB, Local Storage,
  Memory Cache, Settings). Data flow patterns and usage guidelines.

- [**Rendering Architecture**](docs/rendering-architecture.md) - React component hierarchy, virtual scrolling with
  TanStack Virtual, performance optimizations, and data flow.

- [**Scroll Orchestration**](docs/scroll-orchestration.md) - How the plugin ensures accurate scrolling when tree structures change (tag visibility, settings, etc.)

- [**Service Architecture**](docs/service-architecture.md) - Business logic layer: MetadataService, FileSystemOperations, ContentProviderRegistry. Dependency injection patterns and service data flow.

<br>

## 5 Keyboard shortcuts

| Key                                         | Action                                                                                                            |
| ------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| ↑/↓                                         | Navigate up/down in current pane                                                                                  |
| ←                                           | In navigation pane: collapse or go to parent<br>In list pane: switch to navigation pane                           |
| →                                           | In navigation pane: expand or switch to list pane<br>In list pane: switch to editor                               |
| Tab                                         | In navigation pane: switch to list pane<br>In list pane: switch to editor<br>In search field: switch to list pane |
| Shift+Tab                                   | In list pane: switch to navigation pane<br>In search field: switch to navigation pane                             |
| Enter                                       | In search field: switch to list pane                                                                              |
| Escape                                      | In search field: close search and focus list pane                                                                 |
| PageUp/PageDown                             | Scroll up/down in navigation pane and list pane                                                                   |
| Home/End                                    | Jump to first/last item in current pane                                                                           |
| Delete (Windows/Linux)<br>Backspace (macOS) | Delete selected item                                                                                              |
| Cmd/Ctrl+A                                  | Select all notes in current folder                                                                                |
| Cmd/Ctrl+Click                              | Toggle notes selection                                                                                            |
| Shift+Click                                 | Select a range of notes                                                                                           |
| Shift+Home/End                              | Select from current position to first/last item                                                                   |
| Shift+↑/↓                                   | Extend selection up/down                                                                                          |

**Note:** All keyboard shortcuts can be customized by editing the `keyboardShortcuts` section in `.obsidian/plugins/notebook-navigator/data.json`. You can add VIM-style navigation (h,j,k,l) or assign multiple keys to the same command.

<br>

## 6 Commands

Set custom hotkeys for these commands in Obsidian's Hotkeys settings:

**View & navigation**

- `Notebook Navigator: Open` Opens Notebook Navigator in left sidebar. If already open, focuses the file list pane. **Suggestion:** Bind to a shortcut key like `Cmd/Ctrl+Shift+E` to move keyboard focus to the list pane - **this is essential for full keyboard navigation**
- `Notebook Navigator: Open homepage` Opens the Notebook Navigator view and loads the homepage file configured in settings
- `Notebook Navigator: Select vault profile` Opens modal to switch between vault profiles
- `Notebook Navigator: Reveal file` Reveals current file in navigator. Expands parent folders and scrolls to file. This command is useful if you have the setting `Auto-reveal active note` switched off and want to reveal notes manually
- `Notebook Navigator: Navigate to folder` Search dialog to jump to any folder
- `Notebook Navigator: Navigate to tag` Search dialog to jump to any tag
- `Notebook Navigator: Add to shortcuts` Adds the current file, folder, or tag to shortcuts
- `Notebook Navigator: Open shortcut 1-9` Opens shortcut by its position in the shortcuts list
- `Notebook Navigator: Search` Opens quick search field or focuses it if already open. Search persists between sessions. **Suggestion:** Bind to a shortcut key like `Cmd/Ctrl+Shift+F` for quick file filtering

**Selection**

- `Notebook Navigator: Select next file` Moves selection to the next file in the current folder or tag view.
- `Notebook Navigator: Select previous file` Moves selection to the previous file in the current folder or tag view.

**Layout & display**

- `Notebook Navigator: Toggle dual pane layout` Toggle single/dual-pane layout (desktop)
- `Notebook Navigator: Toggle descendants` Toggle descendants notes display for both folders and tags. **Suggestion:** Bind to a shortcut key like `Cmd/Ctrl+Shift+S` to quickly toggle display of notes from descendants
- `Notebook Navigator: Toggle hidden items` Show or hide hidden folders, tags, and notes
- `Notebook Navigator: Toggle tag sort` Toggle between alphabetical and frequency-based tag sorting
- `Notebook Navigator: Collapse / expand all items` Collapse or expand all items based on the current state. When `Keep selected item expanded` is enabled (default on), all folders except the current one will be collapsed. This is super handy to keep the navigation tree tidy when searching for documents. **Suggestion:** Bind to a shortcut key like `Cmd/Ctrl+Shift+C` to quickly collapse non-selected items

**File operations**

**Note:** When creating new notes in Obsidian you can choose the `Default location for new notes` in Obsidian settings. This can be the the root folder, same folder as current file, or a specific folder. When working with Notebook Navigator, especially with the setting `Show notes from descendants` enabled, none of these options are preferred. Instead you always want to create new notes in the currently selected folder (for example if you have `Show notes from descendants` on, and have a note in a descendant folder selected, you do not want the new note to appear in the descendant folder). The same also applies to moving and deleting files. This is why you should use these commands instead of the built-in Obsidian commands when using Notebook Navigator.

- `Notebook Navigator: Create new note` Create note in currently selected folder. **Suggestion:** Bind `Cmd/Ctrl+N` to this command (unbind from Obsidian's default "Create new note" first)
- `Notebook Navigator: Create new note from template` Create note from template in currently selected folder (requires Templater)
- `Notebook Navigator: Move files` Move selected files to another folder. Selects next file in current folder
- `Notebook Navigator: Convert to folder note` Create a folder matching the file name and move the file inside as the folder note
- `Notebook Navigator: Set as folder note` Rename the active file to its folder note name
- `Notebook Navigator: Detach folder note` Detach the folder note in the selected folder and rename it
- `Notebook Navigator: Pin all folder notes` Add all folder notes to shortcuts. Command only visible when folder notes are enabled and at least one unpinned folder note exists
- `Notebook Navigator: Delete files` Delete selected files. Selects next file in current folder

**Tag operations**

- `Notebook Navigator: Add tag to selected files` Dialog to add tag to selected files. Supports creating new tags
- `Notebook Navigator: Remove tag from selected files` Dialog to remove specific tag. Removes immediately if only one tag
- `Notebook Navigator: Remove all tags from selected files` Clear all tags from selected files with confirmation

**Maintenance**

- `Notebook Navigator: Rebuild cache` Rebuilds the local Notebook Navigator cache. Use this if you experience missing tags, incorrect previews or missing feature images

### 6.1 Command IDs

| Command ID                                  | Command name                                                                                         |
| ------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `notebook-navigator:open`                   | Notebook Navigator: Open                                                                             |
| `notebook-navigator:open-homepage`          | Notebook Navigator: Open homepage                                                                    |
| `notebook-navigator:select-profile`         | Notebook Navigator: Select vault profile                                                             |
| `notebook-navigator:select-profile-1`       | Notebook Navigator: Select vault profile 1                                                           |
| `notebook-navigator:select-profile-2`       | Notebook Navigator: Select vault profile 2                                                           |
| `notebook-navigator:select-profile-3`       | Notebook Navigator: Select vault profile 3                                                           |
| `notebook-navigator:reveal-file`            | Notebook Navigator: Reveal file                                                                      |
| `notebook-navigator:navigate-to-folder`     | Notebook Navigator: Navigate to folder                                                               |
| `notebook-navigator:navigate-to-tag`        | Notebook Navigator: Navigate to tag                                                                  |
| `notebook-navigator:add-shortcut`           | Notebook Navigator: Add to shortcuts                                                                 |
| `notebook-navigator:open-shortcut-1`        | Notebook Navigator: Open shortcut 1                                                                  |
| `notebook-navigator:open-shortcut-2`        | Notebook Navigator: Open shortcut 2                                                                  |
| `notebook-navigator:open-shortcut-3`        | Notebook Navigator: Open shortcut 3                                                                  |
| `notebook-navigator:open-shortcut-4`        | Notebook Navigator: Open shortcut 4                                                                  |
| `notebook-navigator:open-shortcut-5`        | Notebook Navigator: Open shortcut 5                                                                  |
| `notebook-navigator:open-shortcut-6`        | Notebook Navigator: Open shortcut 6                                                                  |
| `notebook-navigator:open-shortcut-7`        | Notebook Navigator: Open shortcut 7                                                                  |
| `notebook-navigator:open-shortcut-8`        | Notebook Navigator: Open shortcut 8                                                                  |
| `notebook-navigator:open-shortcut-9`        | Notebook Navigator: Open shortcut 9                                                                  |
| `notebook-navigator:search`                 | Notebook Navigator: Search                                                                           |
| `notebook-navigator:toggle-dual-pane`       | Notebook Navigator: Toggle dual pane layout                                                          |
| `notebook-navigator:toggle-descendants`     | Notebook Navigator: Toggle descendants                                                               |
| `notebook-navigator:toggle-hidden`          | Notebook Navigator: Toggle hidden items (folders, tags, notes)                                       |
| `notebook-navigator:toggle-tag-sort`        | Notebook Navigator: Toggle tag sort                                                                  |
| `notebook-navigator:collapse-expand`        | Notebook Navigator: Collapse / expand all items                                                      |
| `notebook-navigator:new-note`               | Notebook Navigator: Create new note                                                                  |
| `notebook-navigator:new-note-from-template` | Notebook Navigator: Create new note from template                                                    |
| `notebook-navigator:move-files`             | Notebook Navigator: Move files                                                                       |
| `notebook-navigator:select-next-file`       | Notebook Navigator: Select next file                                                                 |
| `notebook-navigator:select-previous-file`   | Notebook Navigator: Select previous file                                                             |
| `notebook-navigator:convert-to-folder-note` | Notebook Navigator: Convert to folder note                                                           |
| `notebook-navigator:set-as-folder-note`     | Notebook Navigator: Set as folder note                                                               |
| `notebook-navigator:detach-folder-note`     | Notebook Navigator: Detach folder note                                                               |
| `notebook-navigator:pin-all-folder-notes`   | Notebook Navigator: Pin all folder notes (requires folder notes enabled and an unpinned folder note) |
| `notebook-navigator:delete-files`           | Notebook Navigator: Delete files                                                                     |
| `notebook-navigator:add-tag`                | Notebook Navigator: Add tag to selected files                                                        |
| `notebook-navigator:remove-tag`             | Notebook Navigator: Remove tag from selected files                                                   |
| `notebook-navigator:remove-all-tags`        | Notebook Navigator: Remove all tags from selected files                                              |
| `notebook-navigator:rebuild-cache`          | Notebook Navigator: Rebuild cache                                                                    |

<br>

## 7 About

Notebook Navigator is built and maintained by [Johan Sanneblad](https://www.linkedin.com/in/johansan/). Johan has a PhD
in Software Development and has worked with innovation development for companies such as Apple, Electronic Arts, Google, Microsoft, Lego, SKF, Volvo Cars, Volvo Group and Yamaha.

Feel free to connect with me on [LinkedIn](https://www.linkedin.com/in/johansan/).

<br>

## 8 Network Usage Disclosure

Notebook Navigator runs locally, but some features make HTTP requests from Obsidian.

### 8.1 Release update checks (Optional)

- **Setting:** "Check for new version on start"
- **Request:** `https://api.github.com/repos/johansan/notebook-navigator/releases/latest`
- **Frequency:** At most once per 24 hours, on startup
- **Data:** Sends standard HTTP metadata; does not include vault content

### 8.2 Icon pack downloads (Optional)

- **Setting:** Enable an icon pack in the Icon Packs tab
- **Requests:** `https://raw.githubusercontent.com/johansan/notebook-navigator/main/icon-assets/...` (manifest, font, metadata)
- **Storage:** Stored locally in IndexedDB

### 8.3 External images and YouTube thumbnails

- **Feature images (Optional):** Controlled by the "Download external images" setting. Downloads remote images and YouTube thumbnails for feature images and stores them locally in IndexedDB.
- **Welcome modal (First launch):** Loads a static thumbnail from `https://raw.githubusercontent.com/johansan/notebook-navigator/main/images/youtube-thumbnail.jpg`.
- **What’s new modal (On update / when opened):** Loads YouTube thumbnails from `https://img.youtube.com/vi/<id>/...` for release notes that include a YouTube link.

### 8.4 Privacy and data handling

- Notebook Navigator does not send note content, file names, or tags to a Notebook Navigator server.
- Requests to GitHub, YouTube, and any external image host are made directly from your device and include standard HTTP metadata (IP address, user-agent, and similar).
- Downloaded icon packs and images are stored locally (IndexedDB). Recent notes/files and UI state are stored locally (Obsidian local storage).
  <br>

## 9 Questions or issues?

**[Join our Discord](https://discord.gg/6eeSUvzEJr)** for support and discussions, or open an issue on the
[GitHub repository](https://github.com/johansan/notebook-navigator).

<br>

## 10 License

This project is licensed under the GNU General Public License v3.0 - see the [LICENSE](https://github.com/johansan/notebook-navigator/blob/main/LICENSE) file for details.
