#!/usr/bin/env node

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
 *
 * Video Script Converter for ElevenLabs V3
 * Reads the intro video script markdown and extracts the voiceover
 * content, formatted for ElevenLabs V3 TTS.
 *
 * Usage:
 *   node scripts/video-script.js              # Output to stdout
 *   node scripts/video-script.js --sections   # Output with section markers
 *   node scripts/video-script.js --file       # Output to docs/intro-video-tts.txt
 */

const fs = require('fs');
const path = require('path');

const scriptPath = path.join(__dirname, '..', 'docs', 'intro-video-script.md');
const outputPath = path.join(__dirname, '..', 'docs', 'intro-video-tts.txt');

// Parse command line arguments
const args = process.argv.slice(2);
const includeSections = args.includes('--sections');
const outputToFile = args.includes('--file');

// Read the markdown file
let content;
try {
    content = fs.readFileSync(scriptPath, 'utf8');
} catch (error) {
    console.error(`Could not read ${scriptPath}: ${error.message}`);
    process.exit(1);
}

// Split into sections by ## followed by number and title
const sectionRegex = /^## (\d+) (.+)$/gm;
const sections = [];
let match;
let lastIndex = 0;

// Find all section headers
const headers = [];
while ((match = sectionRegex.exec(content)) !== null) {
    headers.push({
        number: match[1],
        name: match[2],
        index: match.index,
        endIndex: match.index + match[0].length
    });
}

if (headers.length === 0) {
    console.error('No sections found in script');
    process.exit(1);
}

// Extract content between headers
for (let i = 0; i < headers.length; i++) {
    const header = headers[i];
    const nextHeader = headers[i + 1];
    const contentStart = header.endIndex;
    const contentEnd = nextHeader ? nextHeader.index : content.length;

    let sectionContent = content.slice(contentStart, contentEnd).trim();

    // Remove trailing --- separator
    sectionContent = sectionContent.replace(/\n---\s*$/, '').trim();

    sections.push({
        number: header.number,
        name: header.name,
        content: sectionContent
    });
}

const output = [];

for (const section of sections) {
    let voiceover = section.content;

    // Clean up the voiceover text for ElevenLabs V3:
    // - Keep [pause], [short pause], [long pause], [excited], etc.
    // - Keep ellipses (...)
    // - Keep CAPS for emphasis
    // - Remove markdown formatting
    // - Join lines for better flow

    // Remove any remaining markdown formatting (bold, italic, links)
    voiceover = voiceover
        .replace(/\*\*([^*]+)\*\*/g, '$1') // Remove bold
        .replace(/\*([^*]+)\*/g, '$1') // Remove italic
        .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1'); // Remove links

    // Normalize whitespace but preserve paragraph breaks
    voiceover = voiceover
        .split(/\n\n+/)
        .map(para => para.replace(/\n/g, ' ').replace(/\s+/g, ' ').trim())
        .filter(para => para.length > 0)
        .join('\n\n');

    if (includeSections) {
        output.push(`=== ${section.name} ===\n`);
    }

    output.push(voiceover);
    output.push(''); // Empty line between sections
}

const result = output.join('\n').trim() + '\n';

if (outputToFile) {
    try {
        fs.writeFileSync(outputPath, result);
        console.log(`Written to ${outputPath}`);
        console.log(`Total characters: ${result.length}`);
    } catch (error) {
        console.error(`Could not write ${outputPath}: ${error.message}`);
        process.exit(1);
    }
} else {
    console.log(result);
}
