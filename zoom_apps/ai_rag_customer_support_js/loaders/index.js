import path from 'path';
import fs from 'fs';
import { loadPDF } from './loadPDF.js';
import { loadTXT } from './loadTXT.js';
import { loadDOCX } from './loadDOCX.js';
import { loadMD } from './loadMD.js';

export const SUPPORTED_EXTENSIONS = new Set(['.pdf', '.txt', '.docx', '.md']);

const loaderMap = {
  '.pdf': loadPDF,
  '.txt': loadTXT,
  '.docx': loadDOCX,
  '.md': loadMD,
};

/**
 * Load all supported documents and return an array of:
 *   { file: string, fileName: string, ext: string, content: string }
 * Skips dotfiles (e.g. .gitkeep) and directories cleanly.
 * @param {string[]} filePaths
 */
export async function loadDocuments(filePaths) {
  const results = [];

  for (const filePath of filePaths || []) {
    const baseName = path.basename(filePath);
    if (baseName.startsWith('.')) continue;

    try {
      const stat = fs.statSync(filePath);
      if (!stat.isFile()) continue;
    } catch {
      continue;
    }

    const ext = path.extname(filePath).toLowerCase();
    const loader = loaderMap[ext];

    if (!loader) {
      console.warn(`[Loaders] Skipping unsupported file type: ${baseName}`);
      continue;
    }

    try {
      const content = await loader(filePath);
      if (content && content.trim().length > 0) {
        results.push({ file: filePath, fileName: baseName, ext, content });
      }
    } catch (err) {
      console.error(`[Loaders] Failed to load ${baseName}:`, err.message);
    }
  }

  return results;
}
