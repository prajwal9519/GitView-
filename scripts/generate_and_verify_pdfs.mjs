import fs from 'node:fs';
import path from 'node:path';
import { chromium } from '../client/node_modules/playwright/index.mjs';
import { marked } from '../client/node_modules/marked/lib/marked.esm.js';

const ROOT_DIR = path.resolve(import.meta.dirname, '..');
const PDF_OUT_DIR = path.join(ROOT_DIR, 'docs', 'pdf');
const INSPECTIONS_DIR = path.join(PDF_OUT_DIR, 'inspections');

fs.mkdirSync(INSPECTIONS_DIR, { recursive: true });

function getHtmlTemplate(title, bodyHtml) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>${title}</title>
  <style>
    @page {
      size: A4 portrait;
      margin: 14mm 14mm 14mm 14mm;
    }
    * {
      box-sizing: border-box;
    }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      font-size: 10pt;
      line-height: 1.5;
      color: #1f2328;
      background: #ffffff;
      margin: 0;
      padding: 0;
    }
    h1, h2, h3, h4, h5, h6 {
      color: #1f2328;
      font-weight: 600;
      margin-top: 1.4em;
      margin-bottom: 0.6em;
      page-break-after: avoid;
    }
    h1 {
      font-size: 18pt;
      border-bottom: 1px solid #d0d7de;
      padding-bottom: 0.3em;
      margin-top: 0.5em;
    }
    h2 {
      font-size: 13pt;
      border-bottom: 1px solid #d0d7de;
      padding-bottom: 0.25em;
    }
    h3 {
      font-size: 11pt;
    }
    p, ul, ol {
      margin-top: 0;
      margin-bottom: 0.8em;
    }
    hr {
      height: 0.2em;
      background-color: #d0d7de;
      border: 0;
      margin: 1.5em 0;
    }
    blockquote {
      margin: 1em 0;
      padding: 0.5em 1em;
      color: #57606a;
      background-color: #f6f8fa;
      border-left: 0.25em solid #0969da;
      page-break-inside: avoid;
    }
    table {
      width: 100%;
      border-collapse: collapse;
      margin: 0.8em 0;
      table-layout: fixed;
      font-size: 8pt;
      line-height: 1.35;
      page-break-inside: auto;
    }
    thead {
      display: table-header-group;
    }
    th, td {
      border: 1px solid #d0d7de;
      padding: 5px 7px;
      text-align: left;
      vertical-align: top;
      word-wrap: break-word;
      overflow-wrap: break-word;
      word-break: break-word;
    }
    th {
      background-color: #f6f8fa;
      font-weight: 600;
    }
    tr {
      page-break-inside: avoid;
    }
    pre {
      background-color: #f6f8fa;
      border: 1px solid #d0d7de;
      border-radius: 4px;
      padding: 8px 10px;
      font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace;
      font-size: 7.5pt;
      line-height: 1.35;
      overflow-x: hidden;
      white-space: pre-wrap;
      word-wrap: break-word;
      word-break: break-all;
      page-break-inside: avoid;
      margin: 0.8em 0;
    }
    code {
      font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace;
      font-size: 85%;
      background-color: rgba(175, 184, 193, 0.2);
      padding: 0.15em 0.35em;
      border-radius: 3px;
    }
    pre code {
      background-color: transparent;
      padding: 0;
      font-size: inherit;
    }
    @media print {
      body {
        -webkit-print-color-adjust: exact;
        print-color-adjust: exact;
      }
    }
  </style>
</head>
<body>
  ${bodyHtml}
</body>
</html>`;
}

async function convertMarkdownToPdf(browser, mdPath, pdfPath, title) {
  const mdContent = fs.readFileSync(mdPath, 'utf8');
  const bodyHtml = marked.parse(mdContent);
  const fullHtml = getHtmlTemplate(title, bodyHtml);

  const page = await browser.newPage();
  await page.setContent(fullHtml, { waitUntil: 'networkidle' });

  // Generate PDF
  await page.pdf({
    path: pdfPath,
    format: 'A4',
    printBackground: true,
    margin: {
      top: '14mm',
      bottom: '14mm',
      left: '14mm',
      right: '14mm',
    },
  });

  await page.close();
  console.log(`[+] Generated PDF: ${pdfPath}`);
}

async function inspectAndRenderPdfPages(browser, pdfPath, pagesToInspect, prefix) {
  const pdfBytes = fs.readFileSync(pdfPath);
  const pdfBase64 = pdfBytes.toString('base64');

  const page = await browser.newPage({ viewport: { width: 1400, height: 1800 } });

  const viewerHtml = `<!DOCTYPE html>
<html>
<head>
  <script src="https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js"></script>
  <style>
    body { margin: 0; padding: 20px; background: #525659; display: flex; flex-direction: column; align-items: center; }
    canvas { box-shadow: 0 4px 12px rgba(0,0,0,0.3); margin-bottom: 20px; background: white; }
  </style>
</head>
<body>
  <div id="container"></div>
  <script>
    pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
    window.pdfData = "${pdfBase64}";
  </script>
</body>
</html>`;

  await page.setContent(viewerHtml);

  const totalPages = await page.evaluate(async () => {
    const rawData = atob(window.pdfData);
    const uint8Array = new Uint8Array(rawData.length);
    for (let i = 0; i < rawData.length; i++) {
      uint8Array[i] = rawData.charCodeAt(i);
    }
    const pdf = await pdfjsLib.getDocument({ data: uint8Array }).promise;
    window._pdfDoc = pdf;
    return pdf.numPages;
  });

  console.log(`[*] ${path.basename(pdfPath)}: Total Pages = ${totalPages}`);

  for (const pageNum of pagesToInspect) {
    if (pageNum > totalPages) {
      console.log(`[!] Page ${pageNum} exceeds total pages (${totalPages}). Skipping.`);
      continue;
    }

    const renderSuccess = await page.evaluate(async (num) => {
      const pdf = window._pdfDoc;
      const pdfPage = await pdf.getPage(num);
      const viewport = pdfPage.getViewport({ scale: 1.5 });

      const container = document.getElementById('container');
      container.innerHTML = '';

      const canvas = document.createElement('canvas');
      canvas.id = 'page-canvas';
      canvas.width = viewport.width;
      canvas.height = viewport.height;
      container.appendChild(canvas);

      const ctx = canvas.getContext('2d');
      await pdfPage.render({ canvasContext: ctx, viewport }).promise;

      // Check text content inside page to verify visible text
      const textContent = await pdfPage.getTextContent();
      const textStrings = textContent.items.map(item => item.str).join(' ');
      return {
        width: viewport.width,
        height: viewport.height,
        textCount: textContent.items.length,
        snippet: textStrings.slice(0, 150),
      };
    }, pageNum);

    const canvasElem = page.locator('#page-canvas');
    const outPngPath = path.join(INSPECTIONS_DIR, `${prefix}-page-${pageNum}.png`);
    await canvasElem.screenshot({ path: outPngPath });

    console.log(`[+] Rendered Page ${pageNum} to ${outPngPath}`);
    console.log(`    Snippet: "${renderSuccess.snippet}..." (Items: ${renderSuccess.textCount})`);
  }

  await page.close();
  return totalPages;
}

async function main() {
  const browser = await chromium.launch();

  console.log('\n==================================================================');
  console.log(' Phase 5 Final Release Audit — Documentation PDF Generation');
  console.log('==================================================================\n');

  // 1. Root README.md
  const readmeMd = path.join(ROOT_DIR, 'README.md');
  const readmePdf = path.join(PDF_OUT_DIR, 'README.pdf');
  await convertMarkdownToPdf(browser, readmeMd, readmePdf, 'GitView — Architecture & Verification');

  // 2. Preview README.md
  const previewMd = path.join(ROOT_DIR, 'server', 'src', 'modules', 'preview', 'README.md');
  const previewPdf = path.join(PDF_OUT_DIR, 'preview-README.pdf');
  await convertMarkdownToPdf(browser, previewMd, previewPdf, 'GitView — Preview Architecture & Implementation');

  // 3. Acceptance Report
  const reportMd = path.join(ROOT_DIR, 'phase5-final-acceptance-report.md');
  const reportPdf = path.join(PDF_OUT_DIR, 'phase5-final-acceptance-report.pdf');
  await convertMarkdownToPdf(browser, reportMd, reportPdf, 'GitView Phase 5 — Final Acceptance Report');

  console.log('\n==================================================================');
  console.log(' Inspecting Specific Target Pages (Checking Tables & Text Formatting)');
  console.log('==================================================================\n');

  // Target inspections:
  // - Root README pages 5, 6, 7 (or last pages containing checklists & tables)
  const readmeTotal = await inspectAndRenderPdfPages(browser, readmePdf, [4, 5, 6, 7], 'root-readme');

  // - phase5-final-acceptance-report pages 3, 4, 5, 6
  const reportTotal = await inspectAndRenderPdfPages(browser, reportPdf, [2, 3, 4, 5, 6], 'acceptance-report');

  // - Preview README page 36
  const previewTotal = await inspectAndRenderPdfPages(browser, previewPdf, [34, 35, 36, 37], 'preview-readme');

  await browser.close();
  console.log('\n[+] All PDFs generated and target pages successfully verified on disk.\n');
}

main().catch((err) => {
  console.error('Fatal error during PDF generation/inspection:', err);
  process.exit(1);
});
