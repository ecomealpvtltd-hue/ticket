// Content-based file type detection. We decide what a file IS from its bytes,
// never from the browser-supplied MIME type or the extension alone.

export interface DetectedType { mime: string; ext: string }

function startsWith(buf: Uint8Array, bytes: number[], offset = 0): boolean {
  if (buf.length < offset + bytes.length) return false;
  return bytes.every((b, i) => buf[offset + i] === b);
}

function ascii(buf: Uint8Array, start: number, end: number): string {
  return String.fromCharCode(...buf.subarray(start, Math.min(end, buf.length)));
}

function looksLikeText(buf: Uint8Array): boolean {
  const sample = buf.subarray(0, 8192);
  for (const b of sample) {
    if (b === 0) return false; // binary
  }
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(sample.length === buf.length ? sample : buf.subarray(0, 8000));
  } catch {
    return false;
  }
  const head = new TextDecoder().decode(sample).trimStart().toLowerCase();
  // Refuse markup that a browser might render as a document.
  if (head.startsWith('<!doctype') || head.startsWith('<html') || head.startsWith('<svg') || head.startsWith('<?xml') || head.startsWith('<script')) {
    return false;
  }
  return true;
}

/**
 * Detect an allowed file type. Returns null for anything we refuse
 * (executables, HTML, SVG, archives, unknown binaries).
 */
export function detectFileType(buf: Uint8Array, fileName: string): DetectedType | null {
  const ext = (fileName.split('.').pop() ?? '').toLowerCase();

  if (startsWith(buf, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return { mime: 'image/png', ext: 'png' };
  if (startsWith(buf, [0xff, 0xd8, 0xff])) return { mime: 'image/jpeg', ext: 'jpg' };
  if (ascii(buf, 0, 4) === 'RIFF' && ascii(buf, 8, 12) === 'WEBP') return { mime: 'image/webp', ext: 'webp' };
  if (ascii(buf, 0, 6) === 'GIF87a' || ascii(buf, 0, 6) === 'GIF89a') return { mime: 'image/gif', ext: 'gif' };
  if (ascii(buf, 0, 5) === '%PDF-') return { mime: 'application/pdf', ext: 'pdf' };

  // Office Open XML files are ZIP containers. Accept only with the matching extension and
  // the expected internal part name somewhere in the first chunk.
  if (startsWith(buf, [0x50, 0x4b, 0x03, 0x04])) {
    const head = ascii(buf, 0, 4096);
    if (ext === 'docx' && head.includes('word/')) {
      return { mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', ext: 'docx' };
    }
    if (ext === 'xlsx' && (head.includes('xl/') || head.includes('[Content_Types].xml'))) {
      return { mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', ext: 'xlsx' };
    }
    return null;
  }

  if ((ext === 'txt' || ext === 'csv' || ext === 'log') && looksLikeText(buf)) {
    return ext === 'csv' ? { mime: 'text/csv', ext: 'csv' } : { mime: 'text/plain', ext: ext === 'log' ? 'log' : 'txt' };
  }
  return null;
}

/** Keep names readable but harmless: no paths, control chars, or shell/HTML metacharacters. */
export function sanitizeFileName(name: string, detectedExt: string): string {
  const base = name.split(/[\\/]/).pop() ?? 'file';
  let stem = base.replace(/\.[^.]*$/, '');
  stem = stem
    .normalize('NFKC')
    .replace(/[\u0000-\u001f\u007f<>:"|?*`$&;{}[\]\\]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);
  if (!stem || /^\.+$/.test(stem)) stem = 'attachment';
  return `${stem}.${detectedExt}`;
}
