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
  const cap = flat(caption), fn = flat(filename);
  // The contract text is matched on whole words (system check, Nov 17): squashed into one string, a 4-letter brand like
  // "holo" turned up across word breaks in the Atoms agreement (Automate AI Consulting x Auremere), and the signed
  // contract auto-sent to Holo AI x Chris's agency instead of waiting for "share this with atoms".
  const words = ' ' + lc(String(text).slice(0, 20000)).replace(/[^a-z0-9]+/g, ' ') + ' ';
  const inText = (name) => { const w = lc(name).replace(/[^a-z0-9]+/g, ' ').trim(); return w.length >= 3 && words.includes(` ${w} `); };
  const scored = [];
  // A paused copy of a deal on the same Gmail thread is a duplicate, not a second candidate. Topview AI x Lindsay, Nov 22:
  // BD-95 (paused by the Nov 21 check as a duplicate of BD-94, same thread) tied with BD-94, so Harsh's signed
  // "Influencer Services Agreement - Topview AI x Lindsay Gonzales (signed).pdf" got "Which brand is this for?" and his
  // answer "Topview" would have tied the same way (system check).
  const open = deals.filter((x) => !DONE.includes(x.stage));
  const live = open.filter((x) => !x.paused);
  const pool = open.filter((x) => !x.paused || !x.threadId || !live.some((y) => y.threadId === x.threadId));
  for (const d of pool) {
    const k = brandKey(d.brand);
    if (k.length < 3) continue;
    let s = 0;
    if (cap.includes(k)) s += 6;
    if (fn.includes(k)) s += 4;
    if (inText(d.brand) || inText(String(d.brand || '').replace(/\.(ai|io|app|co|com)\b|\b(ai|inc|llc|ltd|app|the|team|io|hq|labs?|studio)\b/gi, ' '))) s += 3;
    const dom = (String(d.brandEmail || '').match(/@([\w-]+)\./) || [])[1];
    if (dom && dom.length >= 4 && inText(dom)) s += 2;
    if (!s) continue;
    const cr = flat(d.creator);
    if (cr && (cap.includes(cr) || fn.includes(cr) || inText(d.creator))) s += 2;
    if (['Price Agreed', 'Signed', 'Brief Received', 'Negotiating'].includes(d.stage)) s += 1;
    scored.push({ d, s });
  }
  scored.sort((a, b) => b.s - a.s);
  if (!scored.length || scored[0].s < 3) return null;
  if (scored[1] && scored[1].s >= scored[0].s - 1) return null; // two deals look the same: ask
  return scored[0].d;
}

// Who a contract is for, from its own text: each creator's legal or company names (never bare first names, which turn up
// anywhere). Nov 16: the Atoms agreement names "Automate AI Consulting" (Lindsay) and still went to Holo AI x Chris.
// Harsh answered "which brand?" with only the creator ("it's duncan", Nov 22): pick that creator's deal from the
// contract itself (its text and file name), among that creator's open deals only. Pure.
// Returns { deal, creator, options } — deal is null when the contract doesn't point at one of them.
const FIRST_NAMES = { brad: 'Brad', chris: 'Chris', lindsay: 'Lindsay', emtech: 'Emtech', duncan: 'Duncan', valeri: 'Valeri', valerie: 'Valeri', david: 'David Iya', nicole: 'Nicole', dmytro: 'Dmytro', dymtro: 'Dmytro', jonathan: 'Jonathan', harsh: 'Harsh' };
export function dealFromCreatorAnswer(hint, { filename = '', text = '' } = {}, deals = []) {
  const named = [...new Set((lc(hint).match(/[a-z]+/g) || []).map((w) => FIRST_NAMES[w]).filter(Boolean))];
  if (named.length !== 1) return { deal: null, creator: null, options: [] };
  const creator = named[0];
  const mine = deals.filter((d) => !DONE.includes(d.stage) && lc(d.creator).split(/\s+/)[0] === lc(creator).split(/\s+/)[0]);
  // The file name is not used: brands reuse one file name for every creator ("…-thechriscordero.pdf" held Duncan's Fotor agreement)
  const deal = matchDeal({ caption: '', filename: '', text }, mine);
  return { deal, creator, options: mine };
}

export const CREATOR_IDS = {
  Lindsay: ['automate ai consulting', 'automateaiconsulting', 'lindsay gonzales'],
  Chris: ['chris cordero', 'christopher allen', 'chriscordero', 'thechriscordero'],
  Brad: ['brad gaines', 'ninja ai tools', 'ninjaaitools'],
  Duncan: ['duncan rogoff', 'buildroom'],
  Valeri: ['valchy', 'valeridoesai'],
  'David Iya': ['david iya'],
};
const creatorKey = (name) => Object.keys(CREATOR_IDS).find((k) => lc(name).includes(lc(k)) || lc(k).includes(lc(name).trim() || '#')) || '';
export function creatorsNamed(text) {
  const words = ' ' + lc(String(text).slice(0, 20000)).replace(/[^a-z0-9]+/g, ' ') + ' ';
  const squashed = flat(String(text).slice(0, 20000));
  return Object.entries(CREATOR_IDS).filter(([, ids]) => ids.some((id) => (id.includes(' ') ? words.includes(` ${id} `) : squashed.includes(id)))).map(([k]) => k);
}

// The checks a signed contract passes before it goes to a brand with nobody looking. Pure. Returns the reasons it can't
// go on its own (empty = safe to send):
//   1. the brand is named by Harsh (his message, the file name, or his answer to "which brand?"), not only guessed from the text
//   2. the contract doesn't name a different creator than the deal's (a hard stop, even when Harsh named the brand)
//   3. the brand actually sent us a contract for this deal that is still waiting for our signature (CONTRACTS table),
//      unless Harsh named the brand himself
//   4. the deal has the brand's email and thread to reply in
export function contractChecks(deal, { caption = '', filename = '', text = '', answered = false, openRows = [] } = {}) {
  const why = [];
  const k = brandKey(deal.brand);
  const inText = creatorsNamed(text);
  const mine = creatorKey(deal.creator);
  const waiting = (openRows || []).some((r) => (r.dealIds || []).includes(deal.id) || (deal.threadId && r.threadId === deal.threadId));
  // The contract proves itself when its own text names this deal's creator by legal name AND the brand sent us a contract
  // for this deal that is still waiting for our signature, and the text names the brand (or its agency's domain): then a
// bare "here you go" is enough (Luma AI x Lindsay, Nov 21:
  // the signed agreement names Lindsay Gonzales and NJ Agency's contract was open, yet it waited for the brand's name).
  // The Atoms case (Nov 16) still stops: that text named a different creator than the deal's.
  const words = ' ' + lc(String(text).slice(0, 20000)).replace(/[^a-z0-9]+/g, ' ') + ' ';
  const bare = lc(String(deal.brand || '').replace(/\.(ai|io|app|co|com)\b|\b(ai|inc|llc|ltd|app|the|team|io|hq|labs?|studio)\b/gi, ' ')).replace(/[^a-z0-9]+/g, ' ').trim();
  const dom = (String(deal.brandEmail || '').match(/@([\w-]+)\./) || [])[1];
  const brandInText = (bare.length >= 3 && words.includes(` ${bare} `)) || (!!dom && dom.length >= 4 && words.includes(` ${lc(dom)} `));
  const proves = !!mine && inText.length > 0 && inText.every((c) => c === mine) && waiting && brandInText;
  const named = answered || proves || (k.length >= 3 && [caption, filename].some((s) => flat(s).includes(k)));
  if (!named) why.push(`the brand isn't named in your message or the file name`);
  if (inText.length && mine && !inText.includes(mine)) why.push(`the contract is for ${inText.join(' / ')}, but ${deal.brand} is ${deal.creator}'s deal`);
  if (!waiting && !answered) why.push(`${deal.brand} hasn't sent us a contract that's waiting for a signature`);
  if (!deal.brandEmail || !(deal.threadId || deal.messageRfc)) why.push(`the deal has no email thread with ${deal.brand} to reply in`);
  return why;
}
export const hardStop = (why) => why.some((w) => /^the contract is for|no email thread/.test(w));

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
  const { createDraft, autoSend } = await import('./outbox.js');
  const r = await createDraft({ kind: 'Other', deal, subject: `Re: ${deal.threadSubject || deal.brand}`, body: contractEmail(deal), attach: 'File', sendFile, video: deal.linkedVideo,
    why: `Signed contract sent from WhatsApp (sends on its own): ${deal.brand} × ${deal.creator}`, notify: false });
  if (!r?.created || !r.id) throw new Error(r?.reason || 'the email could not be prepared');
  const sent = await autoSend(r.id);
  if (sent?.held) throw new Error(`the email was held for you: ${sent.why}`);
  // The deal moves to Signed once our signed copy is back with the brand
  if (['Inbound', 'Negotiating', 'Price Agreed'].includes(deal.stage)) await notion('PATCH', `/pages/${deal.id}`, { properties: { 'Deal Stage': { select: { name: 'Signed' } } } }).catch(() => {});
  try { const T = await import('./contracttrack.js'); await T.markSigned({ threadId: deal.threadId, dealId: deal.id, how: 'Signed copy sent to the brand from WhatsApp' }); } catch (e) { console.error('contract marked signed', e.message); }
  return { to: deal.brandEmail, brand: deal.brand, creator: deal.creator };
}
