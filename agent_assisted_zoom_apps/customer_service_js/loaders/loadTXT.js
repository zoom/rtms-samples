// loaders/loadTXT.js
import fs from 'fs/promises';

export async function loadTXT(filePath) {
  return await fs.readFile(filePath, 'utf8');
}
