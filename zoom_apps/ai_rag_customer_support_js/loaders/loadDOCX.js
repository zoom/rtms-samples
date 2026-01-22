// loaders/loadDOCX.js
import fs from 'fs/promises';
import mammoth from 'mammoth';

export async function loadDOCX(filePath) {
  const buffer = await fs.readFile(filePath);
  const result = await mammoth.extractRawText({ buffer });
  return result.value;
}
