// Signed contracts from WhatsApp (Harsh, Nov 12): the creator signs, Harsh drops the PDF into the NOOCAP MEDIA chat, and
// the PM works out which deal it belongs to and emails it to the brand in the deal's own thread, without an approval step.
// Which deal: the brand's name in the caption, the file name or the contract text (and the creator's name). When it
// can't tell, it asks "which brand?" and sends once Harsh answers. Nothing is sent to a guess.
import { notion } from './notion.js';

const lc = (s) => String(s || '').toLowerCase();
export const brandKey = (x) => lc(x).replace(/\.(ai|io|app|co|com)\b/g, ' ').replace(/\b(ai|inc|llc|ltd|app|the|team|io|hq|labs?|studio)\b/g, ' ').replace(/[^a-z0-9]/g, '');
const flat = (s) => lc(s).replace(/[^a-z0-9]/g, '');
const DONE = ['Paid', 'Lost'];

// Does this file look like a contract?
export function looksLikeContract(filename, text = '', caption = '') {
  return /contract|agreement|signed|\bsow\b|\bnda\b|\bmsa\b|terms/i.test(`${filename} ${caption}`)
    || /\b(this (influencer |creator |collaboration |services )?agreement|hereinafter|the parties|in witness whereof|terms and conditions)\b/i.test(String(text).slice(0, 6000));
}

// The deal a contract belongs to, or null when it isn't clear. Pure: deals are passed in.
export function matchDeal({ caption = '', filename = '', text = '' }, deals) {
  const cap = flat(caption), fn = flat(filename), tx = flat(String(text).slice(0, 20000));
  const scored = [];
  for (const d of deals.filter((x) => !DONE.includes(x.stage))) {
    const k = brandKey(d.brand);
    if (k.length < 3) continue;
    let s = 0;
    if (cap.includes(k)) s += 6;
    if (fn.includes(k)) s += 4;
    if (tx.includes(k)) s += 3;
    const dom = (String(d.brandEmail || '').match(/@([\w-]+)\./) || [])[1];
    if (dom && dom.length >= 4 && tx.includes(flat(dom))) s += 2;
    if (!s) continue;
    const cr = flat(d.creator);
    if (cr && (cap.includes(cr) || fn.includes(cr) || tx.includes(cr))) s += 2;
    if (['Price Agreed', 'Signed', 'Brief Received', 'Negotiating'].includes(d.stage)) s += 1;
    scored.push({ d, s });
  }
  scored.sort((a, b) => b.s - a.s);
  if (!scored.length || scored[0].s < 3) return null;
  if (scored[1] && scored[1].s >= scored[0].s - 1) return null; // two deals look the same: ask
  return scored[0].d;
}

const firstName = (email) => { const l = String(email || '').split('@')[0].split(/[._-]/)[0]; return /^[a-z]{3,12}$/i.test(l) && !/^(info|hello|team|partner|partners|partnerships|collab|collabs|marketing|brand|brands|creator|creators|influencer|business|contact|support|admin|sales|growth|media|campaigns?|outreach|finance)$/i.test(l) ? l[0].toUpperCase() + l.slice(1).toLowerCase() : ''; };

export function contractEmail(deal) {
  const nm = firstName(deal.brandEmail);
  return `${nm ? `Hi ${nm},` : 'Hi there,'}\n\nPlease find the signed contract attached. Let us know if you need anything else from our side.\n\nBest,\n${deal.creator || 'NOOCAP'}'s Team`;
}

// Email the signed contract to the brand now. file: { mediaId, filename, mime }
export async function sendSignedContract(deal, file) {
  const W = await import('./whatsapp.js');
  const { uploadToNotion } = await import('./briefs.js');
  const got = await W.downloadMedia(file.mediaId);
  const up = await uploadToNotion({ filename: file.filename, mimeType: file.mime || got.mimeType, data: got.data });
  if (!up) throw new Error('could not save the file for the email');
  const sendFile = [{ type: 'file_upload', file_upload: { id: up }, name: String(file.filename || 'signed-contract.pdf').slice(0, 100) }];
  const { createDraft, approveAndSend } = await import('./outbox.js');
  const r = await createDraft({ kind: 'Other', deal, subject: `Re: ${deal.threadSubject || deal.brand}`, body: contractEmail(deal), attach: 'File', sendFile, video: deal.linkedVideo,
    why: `Signed contract sent from WhatsApp (sends on its own): ${deal.brand} × ${deal.creator}`, notify: false });
  if (!r?.created || !r.id) throw new Error(r?.reason || 'the email could not be prepared');
  await approveAndSend(r.id);
  // The deal moves to Signed once our signed copy is back with the brand
  if (['Inbound', 'Negotiating', 'Price Agreed'].includes(deal.stage)) await notion('PATCH', `/pages/${deal.id}`, { properties: { 'Deal Stage': { select: { name: 'Signed' } } } }).catch(() => {});
  return { to: deal.brandEmail, brand: deal.brand, creator: deal.creator };
}
