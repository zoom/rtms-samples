// loaders/loadMD.js
import fs from 'fs/promises';

export async function loadMD(filePath) {
  return await fs.readFile(filePath, 'utf8');
}
