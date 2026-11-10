// The last check every brand email passes before it leaves (Harsh, Nov 10: "fix all of those bugs at once").
// Each rule here is a mistake that reached a brand at least once. What can be put right safely is put right; what can't
// holds the email with the reason, and it is never sent half-right.
//   thread   a reply lands in the deal's own Gmail thread, replying to the brand's latest email (Bluehost × Chris,
//            Nov 2 and 9: two follow-ups started their own thread under a made-up subject)
//   subject  a reply keeps the thread's subject ("Re: <their subject>")
//   cc       everyone on the brand's thread stays copied in (the creator's inbox was dropped on Bluehost)
//   body     no HTML tags or markdown as text (ElevenLabs, CapCut, Gamut, Nov 9-10: "<br />" in the email), no
//            placeholders, no empty email
const OK_NEW_THREAD = new Set(['Quote', 'Counter', 'Close deal', 'Rate hold', 'Decline', 'Lead follow-up']); // lead emails thread through the lead
const hex = (s) => /^[0-9a-f]{10,}$/i.test(String(s || ''));
const addrs = (s) => (String(s || '').match(/[\w.+'-]+@[\w-]+(?:\.[\w-]+)+/g) || []).map((a) => a.toLowerCase());
const baseSubject = (s) => String(s || '').replace(/^\s*((re|fw|fwd)\s*:\s*)+/i, '').trim();
const PLACEHOLDER = /\{\{(?!invoice_link\}\})[^}]*\}\}|\[(?:name|brand|creator|link|date|insert[^\]]*|your [^\]]*)\]|\b(?:undefined|NaN)\b|\bTBD\b|\bXX+\b|lorem ipsum/i;

export function cleanBody(body) {
  return String(body || '')
    .replace(/\\n/g, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>\s*<p[^>]*>/gi, '\n\n')
    .replace(/<\/?(p|div|span|b|strong|i|em|u)(\s[^>]*)?>/gi, '')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&#39;|&apos;/g, "'").replace(/&quot;/g, '"')
    .replace(/\*\*([^*\n]+)\*\*/g, '$1')
    .replace(/\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/g, (m, label, url) => (label.trim() === url ? url : `${label}: ${url}`))
    .replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

// d: the draft (kind, to, cc, subject, body, replyTo, threadId, leadId, sendFrom); deal: its deal (threadId, messageRfc,
// threadCc, threadSubject) or null. Returns the corrected draft, what was corrected, and why it must wait (if it must).
export function preflight(d, deal, { ownAddress = '', cleanCc = (cc) => cc } = {}) {
  const out = { ...d };
  const fixed = [];
  const hold = [];
  const isLead = !!d.leadId || OK_NEW_THREAD.has(d.kind);

  if (deal && !isLead) {
    // Thread: the deal's own thread and the brand's latest email win over whatever the draft was made with. A Reply
    // answers one particular email (it can sit in a second thread the brand started), so it keeps its own
    const answersOne = ['Reply', 'Other'].includes(d.kind) && !!d.replyTo;
    if (!answersOne && hex(deal.threadId) && hex(out.threadId) && out.threadId !== deal.threadId) { fixed.push(`moved into the deal's thread (was ${out.threadId})`); out.threadId = deal.threadId; if (deal.messageRfc) out.replyTo = deal.messageRfc; }
    if (!out.threadId && hex(deal.threadId)) { out.threadId = deal.threadId; fixed.push("put in the deal's thread"); }
    if (!out.replyTo && deal.messageRfc) { out.replyTo = deal.messageRfc; fixed.push("replying to the brand's latest email"); }
    if (!out.replyTo && !hex(out.threadId)) hold.push("the deal has no email thread from the brand to reply in, so this would start a new email under a new subject. Link the deal to the brand's email first");
    // Subject: a reply keeps the thread's subject
    const want = baseSubject(deal.threadSubject);
    if (want && !answersOne && (out.replyTo || hex(out.threadId)) && baseSubject(out.subject).toLowerCase() !== want.toLowerCase()) { fixed.push(`subject set to the thread's ("Re: ${want}")`); out.subject = `Re: ${want}`; }
    // CC: everyone on the brand's thread stays copied in
    const have = new Set([...addrs(out.to), ...addrs(out.cc), ...addrs(ownAddress)]);
    const add = addrs(deal.threadCc).filter((a) => !have.has(a) && !/^noocapcollab@/i.test(a));
    if (add.length) {
      // the same filter as when the draft was made: the sending inbox and other creators' inboxes never get copied
      const before = new Set(addrs(out.cc));
      out.cc = cleanCc([String(out.cc || '').trim(), ...add].filter(Boolean).join(', '), out.to, out.sendFrom, deal.creator);
      const added = addrs(out.cc).filter((a) => !before.has(a));
      if (added.length) fixed.push(`copied in ${added.join(', ')} from the thread`);
    }
  }

  // Body: plain text only, nothing left to fill in, never empty
  const clean = cleanBody(out.body);
  if (clean !== String(out.body || '').trim()) fixed.push('HTML or markdown removed from the text');
  out.body = clean;
  const ph = clean.match(PLACEHOLDER);
  if (ph) hold.push(`it still has "${ph[0]}" in it`);
  if (clean.replace(/\s+/g, ' ').length < 25) hold.push('the email is empty or nearly empty');
  return { draft: out, fixed, hold };
}
