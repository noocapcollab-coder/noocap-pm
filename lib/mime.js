// Builds a complete email (RFC 822) so Gmail's API can send it as-is, as a reply in the right thread, with attachments.
import crypto from 'node:crypto';

const encWord = (s) => (/^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${Buffer.from(s, 'utf8').toString('base64')}?=`);
const wrap76 = (b64) => b64.replace(/.{1,76}/g, (m) => m + '\r\n').trimEnd();
const cleanList = (s) => String(s || '').split(/[,;]/).map((x) => x.trim()).filter((x) => /@/.test(x)).join(', ');

export function buildMime({ to, cc, subject, text, html, inReplyTo, attachment }) {
  const mixed = 'mixed_' + crypto.randomBytes(8).toString('hex');
  const alt = 'alt_' + crypto.randomBytes(8).toString('hex');
  const headers = [
    `To: ${cleanList(to)}`,
    ...(cleanList(cc) ? [`Cc: ${cleanList(cc)}`] : []),
    `Subject: ${encWord(subject || '')}`,
    'MIME-Version: 1.0',
    ...(inReplyTo ? [`In-Reply-To: ${inReplyTo}`, `References: ${inReplyTo}`] : []),
    `Content-Type: multipart/mixed; boundary="${mixed}"`,
  ];
  const parts = [
    `--${mixed}`,
    `Content-Type: multipart/alternative; boundary="${alt}"`,
    '',
    `--${alt}`,
    'Content-Type: text/plain; charset="UTF-8"',
    'Content-Transfer-Encoding: base64',
    '',
    wrap76(Buffer.from(text || '', 'utf8').toString('base64')),
    `--${alt}`,
    'Content-Type: text/html; charset="UTF-8"',
    'Content-Transfer-Encoding: base64',
    '',
    wrap76(Buffer.from(html || '', 'utf8').toString('base64')),
    `--${alt}--`,
  ];
  if (attachment?.data) {
    const name = String(attachment.filename || 'attachment').replace(/"/g, '');
    parts.push(
      `--${mixed}`,
      `Content-Type: ${attachment.mimeType || 'application/octet-stream'}; name="${name}"`,
      `Content-Disposition: attachment; filename="${name}"`,
      'Content-Transfer-Encoding: base64',
      '',
      wrap76(attachment.data),
    );
  }
  parts.push(`--${mixed}--`, '');
  const raw = headers.join('\r\n') + '\r\n\r\n' + parts.join('\r\n');
  return Buffer.from(raw, 'utf8').toString('base64url');
}

export const threadSubject = (s) => String(s || '').replace(/^\s*((re|fwd?|fw)\s*:\s*)+/i, '').trim();
