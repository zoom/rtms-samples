// // loaders/loadPDF.js
// import PDFParser from 'pdf2json';

// export async function loadPDF(filePath) {
//   return new Promise((resolve, reject) => {
//     const pdfParser = new PDFParser();

//     pdfParser.on('pdfParser_dataError', err => {
//       reject(err.parserError || err);
//     });

//     pdfParser.on('pdfParser_dataReady', pdfData => {
//       if (!pdfData.formImage || !pdfData.formImage.Pages) {
//         return reject(new Error('No readable text found in PDF (formImage.Pages missing).'));
//       }

//       const pages = pdfData.formImage.Pages;
//       const text = pages.map(page =>
//         page.Texts.map(t => decodeURIComponent(t.R[0].T)).join(' ')
//       ).join('\n\n');

//       resolve(text.trim());
//     });

//     pdfParser.loadPDF(filePath);
//   });
// }


// loaders/loadPDF.js
import fs from 'fs/promises';
import pdf from 'pdf-parse';

/**
 * Load and extract text from a PDF using pdf-parse.
 * Works for searchable PDFs (not scanned images).
 * @param {string} filePath
 * @returns {Promise<string>}
 */
export async function loadPDF(filePath) {
  try {
    const dataBuffer = await fs.readFile(filePath);
    const parsed = await pdf(dataBuffer);

    if (!parsed.text || parsed.text.trim().length === 0) {
      throw new Error('❌ PDF has no extractable text.');
    }

    console.log(`✅ PDF loaded with ${parsed.numpages} pages and ~${parsed.text.length} chars.`);
    return parsed.text;
  } catch (err) {
    console.error(`❌ Failed to load ${filePath}: ${err.message}`);
    throw err;
  }
}
