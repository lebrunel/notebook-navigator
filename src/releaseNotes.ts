/*
 * Notebook Navigator - Plugin for Obsidian
 * Copyright (c) 2025 Johan Sanneblad
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <https://www.gnu.org/licenses/>.
 */

/**
 * Release Notes System
 *
 * This module manages the "What's new" feature that shows users what has changed
 * between plugin versions. The system works as follows:
 *
 * 1. On plugin load, it compares the current version with the last shown version
 * 2. If version increased, it shows all release notes between versions
 * 3. If downgraded or same version, it shows the latest 5 releases
 * 4. Individual releases can be marked with showOnUpdate: false to skip auto-display
 * 5. Users can always manually access release notes via plugin settings
 *
 * The lastShownVersion is stored in plugin settings to track what the user has seen.
 */

/**
 * Formatting in release notes
 *
 * Supported inline formats in both info and list items:
 * - Bold text: **text**
 * - Critical emphasis (red + bold): ==text==
 * - Markdown link: [label](https://example.com)
 * - Auto-link: https://example.com
 *
 * Not supported:
 * - Italics, headings, inline code, HTML
 *
 * Writing rules:
 * - Use factual, concise statements
 * - Avoid benefit language and subjective adjectives
 * - Keep to the categories: new, improved, changed, fixed
 */

/**
 * Represents a single release note entry
 */
export interface ReleaseNote {
    version: string;
    date: string;
    /** If false, skip automatic modal display for this version during startup */
    showOnUpdate?: boolean;
    /** Optional YouTube video URL shown above the release notes for this version */
    youtubeUrl?: string;
    info?: string; // General information about the release, shown at top without bullets
    new?: string[];
    improved?: string[];
    changed?: string[];
    fixed?: string[];
}

/**
 * All release notes for the plugin, ordered from newest to oldest.
 *
 * When adding a new release:
 * 1. Add it at the beginning of the array (newest first)
 * 2. Categorize features into: new, improved, changed, or fixed arrays
 */
const RELEASE_NOTES: ReleaseNote[] = [
    {
        version: '2.0.5',
        date: '2026-01-12',
        showOnUpdate: true,
        new: [
        ],
        improved: [
            'Improved cache rebuild performance by slowing down tag tree updates during the process.'
        ],
        changed: [
        ],
        fixed: [
        ]
    },
    {
        version: '2.0.4',
        date: '2026-01-05',
        showOnUpdate: true,
        youtubeUrl: 'https://www.youtube.com/watch?v=BewIlG8wLAM',
        new: [
            '==The user interface now has a slight transparency== for all overlay elements. This can be modified or disabled in Style Settings.',
            'New theme variables: ==--nn-theme-pane-overlay-opacity== and ==--nn-theme-pane-overlay-filter==. Set pane overlay stack opacity and backdrop filter.',
            'When installing for the first time, new users will now be presented with a ==Welcome to Notebook Navigator modal== that helps them get started.',
            'Settings > General now shows a link to the video =="Mastering Notebook Navigator"== on YouTube. The video has subtitles in 21 languages, the same as Notebook Navigator supports.',
            'New setting: ==General > Vault title placement==. You can now show the vault title either in the header or in the navigation pane (new default).',
            'Notebook Navigator now has its own icon! 🎉'
        ],
        improved: [
            'Recent files are now saved per vault profile.',
            'Feature images now treat .md files as Excalidraw drawings when **excalidraw-plugin** is set in frontmatter.',
            'You can now ==rename shortcuts== by right clicking and selecting "Rename shortcut".',
            'You can now quickly ==remove shortcuts by clicking on the (X)== on the right side of each shortcut.',
            'Shortcuts and recent notes with truncated titles now show full title on hover with a tooltip.',
            'List pane can now be shrunk down to 150px width, same as navigation pane.'
        ],
        changed: [
            '==Minimum required Obsidian version is now 1.8.7== due to the updated notice system.',
            'The ==Pin shortcuts toolbar button was removed==. Pin shortcuts using the pin button next to the Shortcuts header, or right-click Shortcuts and select "Pin shortcuts".',
            'Changed the default navigation pane width from 300px to 200px so it is smaller than the default width for left panel. This should help with people not finding the list pane when enabling dual pane mode.',
            'Changed the Shortcuts icon to Star to keep it visually distinct from Obsidian Bookmarks.'
        ],
        fixed: [
            'Fixed pinned shortcuts sometimes appearing blank on mobile after switching from editor to side pane.',
            'Duplicating a file now correctly selects the new file in the list pane.'
        ]
    },
    {
        version: '2.0.3',
        date: '2025-12-31',
        showOnUpdate: true,
        new: [],
        improved: [
            'Improved preview text render performance - preview text is now asyncronously filling up a memory cache after startup, so text is instantly available.',
            'Added HEIC and HEIF image support for feature images (common on Apple devices). We now support PNG, JPEG, GIF, WebP, AVIF, HEIC, HEIF, SVG, and BMP formats for feature images.',
            'Shortcuts to hidden files, folders and tags are now shown dimmed.'
        ],
        changed: ['Bumped DB_CONTENT_VERSION so feature image thumbnails will be re-built on upgrade.'],
        fixed: [
            'Feature images now display correctly when servers return incorrect Content-Type headers.',
            'iOS-optimized PNG files (with CgBI chunks) are now parsed correctly.',
            'Improved AVIF/HEIF dimension parsing for images with crop metadata.'
        ]
    },
    {
        version: '2.0.2',
        date: '2025-12-30',
        showOnUpdate: true,
        info: '==Significantly improved startup performance!== You should see a massive improvement in startup time, especially on mobile devices. License is back to GPL-3 and Style Settings works again!',
        new: [],
        improved: [
            '**License is back to GPL 3** after clarifications from the Obsidian team.',
            'Internal: Deferred icon initialization from onload() to runAsyncAction() to improve startup time.',
            'Internal: Deferred IndexedDB initialization from onload() to runAsyncAction() to improve startup time.',
            'Internal: Improved database hydration performance moving from cursor to batched reads.',
            'Internal: Moved preview text to a separate cache store which is now loaded on demand.'
        ],
        changed: [],
        fixed: [
            'Fixed **Style settings** not opening due to misaligned CSS variable names.',
            '**Navigation Pane > Appearance > Root item spacing** now properly updates the view when changed.',
            'Fixed chevrons sometimes briefly appearing in tag tree for tags that do not have children. Thanks @bwya77 for reporting and proposing the fix!',
            'Internal: Normalized **content-type headers** for better external image support (e.g. some web sites provide image/jpg for JPEG or image/x-png for PNG).',
            'Internal: Hardened the **thumbnail LRU cache** to prevent possible race conditions after invalidation.'
        ]
    },
    {
        version: '2.0.0',
        date: '2025-12-29',
        showOnUpdate: true,
        info: '==Notebook Navigator 2.0== is here and there are so many new features! First off: ==Notebook Navigator now automatically creates thumbnails for all your notes== and saves them to the metadata cache database for super fast scrolling! 🎉 If enabled, Notebook Navigator will now also download external images and YouTube thumbnails for feature images! We also have ==Templater support!== You can now create new notes from templates directly in the navigation pane or in the current folder / tag using the new command! Also there are lots of other improvements in this release like a new ==visual editor for file icons== and the option to ==change all user interface icons==! Happy new year! 🎉',
        new: [
            'Notebook Navigator will now ==automatically create thumbnails for all your notes== and store them in the metadata cache database for super fast scrolling in the list pane! You no longer need the plugin **Featured Image** installed! You can still use a custom property for feature image if you want, otherwise the first image, external link or Youtube thumbnail in each document will be used.',
            'New setting: ==Notes > Appearance > Download external images==. If enabled, Notebook Navigator will download external images and YouTube thumbnails to use as feature images in the list pane. Default enabled.',
            'New setting: ==General > Icons > Interface icons==. You can now customize all icons used in the Notebook Navigator interface, like pinned section icon, shortcuts icon, recent notes icon, folder expand/collapse icons, all toolbar buttons, and more.',
            '==File name icons and file type icons can now be edited with a new visual editor==. Just click the new **edit button** next to each text field in Settings > Notes > Icons.',
            '==You can now use icons from icon packs for file name icons and file type icons==.',
            'New menu command: ==New file from template==. If you have the plugin **Templater** installed you can now create new notes with templates directly from the navigation pane!',
            'New command: ==Create new note from template==. If you have the plugin **Templater** installed you can now create a new note with template in the current folder or tag.',
            'New commands: ==Open shortcut 1-9==. Use this to quickly open your shortcut files, navigate to folders/tags, or load a custom search filter. Tip: Bind them to CMD+1 etc for quick file and folder access!',
            'New setting: Navigation pane > Shortcuts & recent items > ==Shortcut badge==. You can now choose to show index number (1-9) to help with shortcut commands, show item count or show no badge next to shortcuts. Default is index (1-9).',
            'New setting: General > Behavior > ==Single pane animation==. You can now customize the new animation speed when switching between navigation pane and list pane.',
            'New theme variable: ==--nn-theme-mobile-bg== to change mobile background color. Set it in Style settings or through themes / CSS.'
        ],
        improved: [
            '==Links to external images and YouTube videos now show as feature images== in the list pane, as long as you prefix them with !.',
            '==PDF files and inline PDF documents such as ![[mydocument.pdf]] now show the first page as a feature image== in the list pane.',
            '==Excalidraw drawings now show as feature images== in the list pane.',
            '**Significantly improved scrolling performance** since all feature images are now rendered from thumbnails with a fast LRU memory cache.',
            'Switching between navigation pane and list pane on desktop in single pane mode **is now animated**.',
            'On iOS devices you can now swipe anywhere to go from the list pane to navigation pane, this matches Obsidian default behavior.',
            "You can now use spaces in file icon mappings, e.g. 'ai ' to prevent matching titles like 'mail'.",
            'Improved toolbar button layout on all Android devices and iOS devices running Obsidian 1.10 and earlier.',
            'Notebook Navigator is now fully compatible with Obsidian 1.11 and later, including the new Liquid Glass theme style.'
        ],
        changed: [
            'The setting **List pane > Appearance > Optimize note height** no longer decreases vertical height for notes with feature images.',
            'Removed the "Reset" button next to the file name and file icon mapping text fields to avoid removing mappings by accident.',
            'Removed the theming variable --nn-theme-mobile-toolbar-border-color since it is no longer used.',
            'Removed the theming variable --nn-style-pinned-section-icon. Use General > Icons > Interface icons to change the pinned icon.',
            'Updated the Notebook Navigator licensing agreement. Developers can no longer submit forks of Notebook Navigator to the Obsidian community plugins list without my permission.'
        ],
        fixed: [
            'Fixed vertical text alignment in tag pills for certain fonts by adding explicit line-height.',
            'Fixed "New Tldraw drawing" failing after a Tldraw plugin update.',
            'You can now collapse and expand the Tags virtual folder with the keyboard.'
        ]
    },
    {
        version: '1.9.3',
        date: '2025-12-23',
        showOnUpdate: true,
        info: 'The two major improvements in this release are 1: ==File icons==. You can now define rules so file names with certain text and extensions now show specific icons. 2. You can now ==Resize the pinned shortcuts area==. This makes it much easier to manage a large set of shortcuts. Merry Christmas!',
        new: [
            'New setting: Notes > Appearance > ==Icons by file name==. Map file name substrings to icons. Default disabled.',
            'New setting: Notes > Appearance > ==Icons by file type==. If enabled show category icons for all files. Default disabled.',
            'New setting: Notes > Appearance > ==File name icon map==. You can now set custom icon mappings for text in file names, text=icon.',
            'New setting: Notes > Appearance > ==File type icon map==. You can now set custom icon mappings for file types, extension=icon.',
            'New setting: Folders & tags > ==Spring-loaded folders==. Expand folders and tags on hover during drag operations. Default enabled.',
            'When spring-loaded folders is enabled you now have two new sub-settings: ==First expand delay== and ==Subsequent expand delay== to configure how long to hover before a folder/tag expands during drag operations.',
            'New command: ==Set as folder note==. Renames the active file to its folder note name.',
            'New command: ==Detach folder note==. Detaches and renames the active folder note to a new name.',
            'Public API: Added **navigation.navigateToFolder(folder)** and **navigation.navigateToTag(tag)**.'
        ],
        improved: [
            '==You can now resize the pinned shortcuts area== by dragging the separator line.',
            '==You can now add multiple files to shortcuts== using multi-selection and context menu.',
            '==You can now remove all shortcuts== using the new "Remove all shortcuts" option in the shortcuts context menu.',
            'If you use metadata from frontmatter, you can now enter ==multiple fields for name from frontmatter== such as title, name.'
        ],
        fixed: []
    },
    {
        version: '1.9.2',
        date: '2025-12-17',
        showOnUpdate: true,
        new: [
            'New setting: Notes > Appearance > ==Strip HTML in previews==. Default enabled - removes html tags like <br>, <ul> etc from note previews in list pane.',
            'New setting: General > Filtering > ==Hide files==. You can now hide filenames by pattern, like temp-* or *.png.'
        ],
        improved: [
            'Settings now support the new ==SettingGroup API== in Obsidian 1.11 and later. Settings groups are now clearly outlined in settings.',
            '==Toolbar buttons in iOS== now uses the Liquid Glass style in Obsidian 1.11 and later.',
            'Commands: ==Select next file== and ==Select previous file== no longer reveal the Notebook Navigator view.'
        ],
        changed: ['Bumped DB_CONTENT_VERSION to support HTML tag removal from note previews. Cache will be rebuilt on next startup.'],
        fixed: ['Folders and tags placed in shortcuts no longer show "Add separator" / "Remove separator" menu options']
    },
    {
        version: '1.9.1',
        date: '2025-12-07',
        showOnUpdate: true,
        info: 'Lots of internal improvements in this release. The mobile drag and drop functionality was rewritten from the ground up, pattern matching for hidden folders and tags was greatly improved in performance, and lots of other internal improvements.\n\nThank you all the feedback and suggestions, and thank you for using Notebook Navigator!',
        new: [
            'New setting: **Navigation pane > Behavior > Pin recent notes with shortcuts**. Enable this to pin both shortcuts and recent notes to the top of the navigation pane. Default disabled.',
            'New style setting: **Navigation file text color** (--nn-theme-navitem-file-name-color). Customize the color of files shown in shortcuts and recent files in navigation pane.'
        ],
        improved: [
            "==Creating new Excalidraw and Tldraw documents== now use the names and templates configured in each plugin's settings.",
            '==Drag and drop finally works on all Android devices!== 🎉 Due to persistent issues with HTML5 drag-and-drop on certain Android devices, the entire mobile drag-and-drop implementation for shortcuts and reorder root items was rebuilt from the ground up to use the library **dnd-kit**, https://github.com/clauderic/dnd-kit.',
            '==Android users can now swipe in the middle of the view== to go from list pane to navigation pane.',
            'File operations like **move, delete, create, pin/unpin** now keeps current list scroll position when nothing is selected in the list pane.',
            'Notebook Navigator now also supports **AVIF images** for image previews in list pane.'
        ],
        changed: [
            '==Active vault profile is no longer synced between devices==, so you can have different active vault profiles on different devices.',
            '==Moved zoom level, tag sort order, recent colors, search provider and release check timestamp== from **synced settings** to **local storage**. Settings file is now only used for configuration settings, not UX state.',
            'Significantly optimized **hidden folder** and **hidden tag** pattern matching performance.'
        ],
        fixed: [
            'Creating new notes with "Reading mode" enabled prevented the plugin Templater from inserting templates. This has been fixed by always opening new notes in "Editing mode", just like the built-in file explorer does it.'
        ]
    },
    {
        version: '1.9.0',
        date: '2025-11-30',
        showOnUpdate: true,
        new: [
            '==Tldraw support==. If you have the plugin Tldraw installed you can now create new Tldraw drawings directly from the navigation pane in Notebook Navigator!',
            'New setting: Settings > Folders & tags > Tags > ==Inherit tag colors==. Disable this to prevent tags from inheriting colors from parent tags. Default enabled.',
            'Notebook Navigator has been translated to Russian, Turkish, Ukrainian, Vietnamese, Portuguese, Indonesian, Thai, Persian (Farsi), and Italian. ==Notebook Navigator now supports 21 languages!=='
        ],
        improved: [
            '==The color picker== has been greatly enhanced! You can now toggle between **default colors** and **custom colors**, you can copy and paste colors in the dialog, you can drag and drop colors, and you can even double click to set color and close dialog! Thanks @alltiagocom for your ideas!',
            'You can now ==copy and paste styles like icons and colors== between folders, tags and files! Just use the new **Style menu**!',
            'You can now easily ==remove icons, colors or all styles== from a folder, tag or file using the new **Style menu**.',
            'You can now ==apply colors and icons to multiple files== at once! You can even paste styles to multiple files!',
            'You can now ==reorder vault profiles== in **Settings > General > Filtering**. Click **Edit profiles** to add, rename, delete, or reorder vault profiles.',
            '==Improved the way file tags are rendered== in the list pane. They now respect background color and text color and it just looks so much better!',
            '==Improved Excalidraw support==. When you create a new Excalidraw drawing from the navigation pane, it now opens immediately in drawing mode.',
            '==Duplicating a folder== will now also duplicate icon and color settings for the folder and all subfolders.',
            'Android: Drag and drop now works in shortcuts and reorder root items mode on newer Android devices.',
            'Android: Notebook Navigator now handles custom system font sizes correctly.',
            '"Settings > Folders & tags > Expand on selection" will now also collapse tags and folders on single click.'
        ],
        fixed: ['Fixed an issue where the context menu in navigation pane did not hide if clicking on a folder title.']
    },
    {
        version: '1.8.9',
        date: '2025-11-25',
        showOnUpdate: true,
        new: [
            '==Customizable user colors in the color picker==. The color picker now has 20 editable color slots. Click a slot to select it, then use the picker to change it. Your colors are saved and synced automatically. Use the new toolbar buttons to copy, paste, or reset the palette.',
            'Notebook Navigator has been translated to ==Arabic (ar)==.'
        ],
        fixed: [
            'Notebook Navigator no longer listens to Obsidian workspace "quit" commands, since they apparantly are sent to all plugins when receiving obsidian://open-url requests. This means the plugin thought it was going to quit while Obsidian never shut it down.',
            'Fixed an issue with font scaling on Android devices overriding plugin font sizes.'
        ]
    },
    {
        version: '1.8.8',
        date: '2025-11-24',
        showOnUpdate: true,
        new: [
            'New setting: ==List pane > Appearance > Default list mode==. Choose the default list layout between **standard** and **compact**. **Standard** shows title, date, description, and preview text. **Compact** only shows title. You can override the appearance for each folder or tag.',
            'New setting: ==Notes > Appearance > Show file icons==. Disable to hide all file icons and avoid the indentation in the list pane.'
        ],
        improved: [
            'If you change filename color in Style Settings, that color is now also used in shortcuts and recent notes.',
            'In single pane mode with the setting **Folders & tags > Expand on selection** enabled, first click on a folder or tag with children now expands them in navigation pane, second click shows files pane. This makes it easier to navigate the trees on mobile devices.'
        ],
        changed: [],
        fixed: [
            'Improved Chinese translation for "Reveal" functionality. Now uses "定位" (locate) instead of "显示" (show) to better convey the meaning of revealing/locating files in folders.',
            'Fixed a crash when using tags named "constructor", "toString", or other special JavaScript words. These tag names now work correctly without causing the view to blank out.',
            'Fixed a crash when entering invalid date or time format strings in settings. Invalid formats now fall back to default formatting instead of crashing.',
            'Fixed an issue where multiple menus would show if right clicking many times in the folder tree.'
        ]
    }
];

/**
 * Gets all release notes between two versions (inclusive).
 * Used when upgrading to show what's changed since the last version.
 *
 * @param fromVersion - The starting version (usually the previously shown version)
 * @param toVersion - The ending version (usually the current version)
 * @returns Array of release notes between the versions, or latest notes if versions not found
 */
export function getReleaseNotesBetweenVersions(fromVersion: string, toVersion: string): ReleaseNote[] {
    const fromIndex = RELEASE_NOTES.findIndex(note => note.version === fromVersion);
    const toIndex = RELEASE_NOTES.findIndex(note => note.version === toVersion);

    // If either version is not found, fall back to showing latest releases
    if (fromIndex === -1 || toIndex === -1) {
        return getLatestReleaseNotes();
    }

    const startIndex = Math.min(fromIndex, toIndex);
    const endIndex = Math.max(fromIndex, toIndex);

    return RELEASE_NOTES.slice(startIndex, endIndex + 1);
}

/**
 * Gets the most recent release notes.
 * Used for manual "What's new" access and as fallback.
 *
 * @param count - Number of latest releases to return (defaults to 5)
 * @returns Array of the most recent release notes
 */
export function getLatestReleaseNotes(count: number = 5): ReleaseNote[] {
    return RELEASE_NOTES.slice(0, count);
}

/**
 * Compares two semantic version strings.
 *
 * @param v1 - First version string (e.g., "1.2.3")
 * @param v2 - Second version string (e.g., "1.2.4")
 * @returns 1 if v1 > v2, -1 if v1 < v2, 0 if equal
 */
export function compareVersions(v1: string, v2: string): number {
    const parts1 = v1.split('.').map(Number);
    const parts2 = v2.split('.').map(Number);

    for (let i = 0; i < Math.max(parts1.length, parts2.length); i++) {
        const part1 = parts1[i] || 0;
        const part2 = parts2[i] || 0;

        if (part1 > part2) return 1;
        if (part1 < part2) return -1;
    }

    return 0;
}

/**
 * Determines whether release notes for the given version should appear automatically on update.
 */
export function isReleaseAutoDisplayEnabled(version: string): boolean {
    const note = RELEASE_NOTES.find(entry => entry.version === version);
    if (!note) {
        return true;
    }
    return note.showOnUpdate !== false;
}
