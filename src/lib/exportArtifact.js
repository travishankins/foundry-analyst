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

export async function exportPdf(node, title) {
  const [{ jsPDF }, dataUrl] = await Promise.all([import('jspdf'), capture(node)]);
  const pdf = new jsPDF({ orientation: 'portrait', unit: 'pt', format: 'a4' });
  const pageW = pdf.internal.pageSize.getWidth();
  const pageH = pdf.internal.pageSize.getHeight();
  const margin = 24;
  const { width, height } = pdf.getImageProperties(dataUrl);
  const imgW = pageW - margin * 2;
  const imgH = (height * imgW) / width;
  const usableH = pageH - margin * 2;

  // Long reports: place the same image on each page, shifted up by one page height
  for (let offset = 0; offset < imgH; offset += usableH) {
    if (offset > 0) pdf.addPage();
    pdf.addImage(dataUrl, 'PNG', margin, margin - offset, imgW, imgH);
  }
  pdf.save(`${slug(title)}.pdf`);
}
