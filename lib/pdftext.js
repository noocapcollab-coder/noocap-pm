// PDFs attached to brand emails (contracts, media kits, briefs) used to go to the AI whole, and the API bills every
// PDF page as text plus a picture of the page: a 20-page contract cost more than the rest of the email. Now only the
// text is read out here, for free, and a capped amount of it goes to the AI. Scanned PDFs with no text are left out.
const MAX = 8000;
export async function pdfText(base64, max = MAX) {
  try {
    const { getDocumentProxy, extractText } = await import('unpdf');
    const pdf = await getDocumentProxy(new Uint8Array(Buffer.from(base64, 'base64')));
    const { text } = await extractText(pdf, { mergePages: true });
    const t = String(Array.isArray(text) ? text.join('\n') : text || '').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
    return t ? t.slice(0, max) : null;
  } catch { return null; }
}
// The text of up to two PDF attachments, labelled with their file names, ready to add to a prompt
export async function attachmentText(attachments = [], max = MAX) {
  const out = [];
  for (const a of (attachments || []).filter((x) => x.data && /pdf/i.test(x.mimeType || x.filename || '')).slice(0, 2)) {
    const t = await pdfText(a.data, max);
    if (t) out.push(`--- Text of the attached PDF "${a.filename || 'file.pdf'}" ---\n${t}`);
  }
  return out.join('\n\n');
}
