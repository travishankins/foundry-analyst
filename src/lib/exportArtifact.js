const slug = (title) => title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'artifact';

async function capture(node) {
  const { toPng } = await import('html-to-image');
  const background = getComputedStyle(node).backgroundColor || '#ffffff';
  return toPng(node, { pixelRatio: 2, backgroundColor: background, cacheBust: true });
}

function download(href, filename) {
  const a = document.createElement('a');
  a.href = href;
  a.download = filename;
  a.click();
}

export async function exportPng(node, title) {
  download(await capture(node), `${slug(title)}.png`);
}

const loadImage = (src) =>
  new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('Could not read the captured image'));
    img.src = src;
  });

async function buildPdf(node) {
  const [{ jsPDF }, dataUrl] = await Promise.all([import('jspdf'), capture(node)]);
  const img = await loadImage(dataUrl);
  const pdf = new jsPDF({ orientation: 'portrait', unit: 'pt', format: 'a4' });
  const pageW = pdf.internal.pageSize.getWidth();
  const pageH = pdf.internal.pageSize.getHeight();
  const margin = 24;
  const imgW = pageW - margin * 2;
  const usableH = pageH - margin * 2;
  // Source pixels that fit on one page at the scaled width
  const sliceH = Math.floor((usableH * img.width) / imgW);

  // Crop one page-sized slice at a time so page margins stay clean
  for (let y = 0, page = 0; y < img.height; y += sliceH, page++) {
    const h = Math.min(sliceH, img.height - y);
    const canvas = document.createElement('canvas');
    canvas.width = img.width;
    canvas.height = h;
    canvas.getContext('2d').drawImage(img, 0, y, img.width, h, 0, 0, img.width, h);
    if (page > 0) pdf.addPage();
    pdf.addImage(canvas.toDataURL('image/jpeg', 0.85), 'JPEG', margin, margin, imgW, (h * imgW) / img.width);
  }
  return pdf;
}

export async function exportPdf(node, title) {
  (await buildPdf(node)).save(`${slug(title)}.pdf`);
}

/** Base64 PDF (no data-URI prefix) for sending to the share API. */
export async function pdfBase64(node) {
  const uri = (await buildPdf(node)).output('datauristring');
  return uri.slice(uri.indexOf('base64,') + 7);
}
