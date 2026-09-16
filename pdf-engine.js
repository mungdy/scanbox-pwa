(function (global) {
  'use strict';

  const encoder = new TextEncoder();

  function ascii(str) {
    return encoder.encode(str);
  }

  function concatBytes(chunks) {
    let total = 0;
    for (const c of chunks) total += c.length;
    const out = new Uint8Array(total);
    let off = 0;
    for (const c of chunks) {
      out.set(c, off);
      off += c.length;
    }
    return out;
  }

  function fmt(n) {
    if (!Number.isFinite(n)) return '0';
    const s = Number(n.toFixed(3)).toString();
    return s === '-0' ? '0' : s;
  }

  function utf16beHex(text, withBom) {
    let hex = withBom ? 'FEFF' : '';
    for (const ch of String(text || '')) {
      const cp = ch.codePointAt(0);
      if (cp > 0xFFFF) {
        const v = cp - 0x10000;
        const hi = 0xD800 + (v >> 10);
        const lo = 0xDC00 + (v & 0x3FF);
        hex += hi.toString(16).padStart(4, '0').toUpperCase();
        hex += lo.toString(16).padStart(4, '0').toUpperCase();
      } else {
        hex += cp.toString(16).padStart(4, '0').toUpperCase();
      }
    }
    return hex;
  }

  function ucs2Hex(text) {
    let hex = '';
    for (const ch of String(text || '')) {
      const cp = ch.codePointAt(0);
      if (cp === 0 || cp > 0xFFFF) continue;
      hex += cp.toString(16).padStart(4, '0').toUpperCase();
    }
    return hex;
  }

  function collectBmpChars(pages) {
    const set = new Set();
    for (const page of pages) {
      for (const ch of String(page.ocrTextOverride || '')) { const cp = ch.codePointAt(0); if (cp > 0 && cp <= 0xFFFF) set.add(cp); }
      for (const word of page.ocrWords || []) {
        for (const ch of String(word.text || '')) {
          const cp = ch.codePointAt(0);
          if (cp > 0 && cp <= 0xFFFF) set.add(cp);
        }
      }
    }
    return Array.from(set).sort((a, b) => a - b);
  }

  function makeToUnicodeCMap(codepoints) {
    const lines = [
      '/CIDInit /ProcSet findresource begin',
      '12 dict begin',
      'begincmap',
      '/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def',
      '/CMapName /ScanBox-UCS2 def',
      '/CMapType 2 def',
      '1 begincodespacerange',
      '<0000> <FFFF>',
      'endcodespacerange'
    ];

    for (let i = 0; i < codepoints.length; i += 100) {
      const batch = codepoints.slice(i, i + 100);
      lines.push(`${batch.length} beginbfchar`);
      for (const cp of batch) {
        const h = cp.toString(16).padStart(4, '0').toUpperCase();
        lines.push(`<${h}> <${h}>`);
      }
      lines.push('endbfchar');
    }

    lines.push(
      'endcmap',
      'CMapName currentdict /CMap defineresource pop',
      'end',
      'end'
    );
    return ascii(lines.join('\n') + '\n');
  }

  class PdfWriter {
    constructor() {
      this.objects = [null];
    }
    add(body) {
      this.objects.push(body);
      return this.objects.length - 1;
    }
    set(id, body) {
      this.objects[id] = body;
    }
    stream(dict, bytes) {
      return { type: 'stream', dict: dict || '', bytes: bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes) };
    }
    build(rootId, infoId) {
      const chunks = [];
      const offsets = new Array(this.objects.length).fill(0);
      let cursor = 0;
      const push = (bytes) => { chunks.push(bytes); cursor += bytes.length; };
      push(ascii('%PDF-1.7\n%ScanBox\n'));

      for (let id = 1; id < this.objects.length; id++) {
        offsets[id] = cursor;
        push(ascii(`${id} 0 obj\n`));
        const body = this.objects[id];
        if (body && body.type === 'stream') {
          push(ascii(`<<${body.dict ? ' ' + body.dict : ''} /Length ${body.bytes.length} >>\nstream\n`));
          push(body.bytes);
          push(ascii('\nendstream\nendobj\n'));
        } else {
          push(ascii(String(body || '<<>>') + '\nendobj\n'));
        }
      }

      const xrefOffset = cursor;
      push(ascii(`xref\n0 ${this.objects.length}\n`));
      push(ascii('0000000000 65535 f \n'));
      for (let id = 1; id < this.objects.length; id++) {
        push(ascii(String(offsets[id]).padStart(10, '0') + ' 00000 n \n'));
      }
      const infoPart = infoId ? ` /Info ${infoId} 0 R` : '';
      push(ascii(`trailer\n<< /Size ${this.objects.length} /Root ${rootId} 0 R${infoPart} >>\nstartxref\n${xrefOffset}\n%%EOF\n`));
      return concatBytes(chunks);
    }
  }

  function safeWord(word) {
    const text = String(word && word.text || '').replace(/[\u0000-\u001F\u007F]/g, '').trim();
    if (!text) return null;
    const x = Number(word.x || 0);
    const y = Number(word.y || 0);
    const w = Math.max(1, Number(word.w || 1));
    const h = Math.max(1, Number(word.h || 1));
    if (![x, y, w, h].every(Number.isFinite)) return null;
    return { text, x, y, w, h };
  }

  function buildPdf(options) {
    const pages = Array.isArray(options && options.pages) ? options.pages : [];
    if (!pages.length) throw new Error('PDF에 넣을 페이지가 없습니다.');
    const searchable = !!(options && options.searchable);
    const title = String(options && options.title || 'ScanBox');
    const pageSize = ['fit','a3','a4','a5','b4','b5','letter','legal'].includes(options && options.pageSize) ? options.pageSize : 'fit';
    const writer = new PdfWriter();

    const pagesRootId = writer.add('<<>>');
    let fontId = null;

    if (searchable) {
      const chars = collectBmpChars(pages);
      const toUnicodeId = writer.add(writer.stream('', makeToUnicodeCMap(chars)));
      const cidFontId = writer.add(
        '<< /Type /Font /Subtype /CIDFontType0 /BaseFont /HYGoThic-Medium ' +
        '/CIDSystemInfo << /Registry (Adobe) /Ordering (Korea1) /Supplement 2 >> /DW 1000 >>'
      );
      fontId = writer.add(
        `<< /Type /Font /Subtype /Type0 /BaseFont /HYGoThic-Medium /Encoding /UniKS-UCS2-H ` +
        `/DescendantFonts [${cidFontId} 0 R] /ToUnicode ${toUnicodeId} 0 R >>`
      );
    }

    const pageIds = [];
    for (const page of pages) {
      const imageBytes = page.jpegBytes instanceof Uint8Array ? page.jpegBytes : new Uint8Array(page.jpegBytes || []);
      const imgW = Math.max(1, Number(page.width || 1));
      const imgH = Math.max(1, Number(page.height || 1));
      if (!imageBytes.length) throw new Error('빈 이미지 페이지가 있습니다.');

      const portrait = imgH >= imgW;
      let pw, ph, dw, dh, dx = 0, dy = 0;
      if (pageSize === 'fit') {
        const longEdge = 841.89;
        if (portrait) { ph = longEdge; pw = longEdge * (imgW / imgH); }
        else { pw = longEdge; ph = longEdge * (imgH / imgW); }
        dw = pw; dh = ph;
      } else {
        // points (1 pt = 1/72 in). B4/B5는 국내 복합기에서 흔한 JIS 규격을 사용합니다.
        const PAGE_POINTS = {
          a3: [841.89, 1190.551],
          a4: [595.276, 841.89],
          a5: [419.528, 595.276],
          b4: [728.504, 1031.811],   // 257 × 364 mm
          b5: [515.906, 728.504],    // 182 × 257 mm
          letter: [612, 792],
          legal: [612, 1008],
        };
        const base = PAGE_POINTS[pageSize] || PAGE_POINTS.a4;
        pw = portrait ? base[0] : base[1];
        ph = portrait ? base[1] : base[0];
        // 사용자가 규격을 명시적으로 선택한 경우 여백 없이 페이지 전체를 채웁니다.
        dw = pw; dh = ph;
      }
      const scaleX = dw / imgW;
      const scaleY = dh / imgH;

      const imageId = writer.add(writer.stream(
        `/Type /XObject /Subtype /Image /Width ${Math.round(imgW)} /Height ${Math.round(imgH)} ` +
        '/ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode',
        imageBytes
      ));

      const content = [];
      content.push(`q ${fmt(dw)} 0 0 ${fmt(dh)} ${fmt(dx)} ${fmt(dy)} cm /Im0 Do Q`);

      if (searchable && fontId) {
        const override = page.ocrTextOverride == null ? null : String(page.ocrTextOverride);
        if (override != null) {
          const safe = override.replace(/[\u0000-\u001F\u007F]/g, ' ').trim();
          if (safe) {
            const actual = utf16beHex(safe, true);
            content.push(`/Span << /ActualText <${actual}> >> BDC`);
            content.push(`BT /F0 2 Tf 3 Tr 1 0 0 1 1 1 Tm <0020> Tj ET`);
            content.push('EMC');
          }
        } else {
        let count = 0;
        for (const rawWord of page.ocrWords || []) {
          if (count++ > 12000) break;
          const word = safeWord(rawWord);
          if (!word) continue;
          const hex = ucs2Hex(word.text);
          if (!hex) continue;

          const x = dx + word.x * scaleX;
          const baselineY = ph - (dy + (word.y + word.h) * scaleY) + Math.max(0.5, word.h * scaleY * 0.08);
          const fontSize = Math.max(2, word.h * scaleY * 0.92);
          const actual = utf16beHex(word.text, true);
          content.push(`/Span << /ActualText <${actual}> >> BDC`);
          content.push(`BT /F0 ${fmt(fontSize)} Tf 3 Tr 1 0 0 1 ${fmt(x)} ${fmt(baselineY)} Tm <${hex}> Tj ET`);
          content.push('EMC');
        }
        }
      }

      const contentId = writer.add(writer.stream('', ascii(content.join('\n') + '\n')));
      const resources = searchable && fontId
        ? `<< /ProcSet [/PDF /Text /ImageC] /XObject << /Im0 ${imageId} 0 R >> /Font << /F0 ${fontId} 0 R >> >>`
        : `<< /ProcSet [/PDF /ImageC] /XObject << /Im0 ${imageId} 0 R >> >>`;
      const pageId = writer.add(
        `<< /Type /Page /Parent ${pagesRootId} 0 R /MediaBox [0 0 ${fmt(pw)} ${fmt(ph)}] ` +
        `/Resources ${resources} /Contents ${contentId} 0 R >>`
      );
      pageIds.push(pageId);
    }

    writer.set(pagesRootId, `<< /Type /Pages /Count ${pageIds.length} /Kids [${pageIds.map(id => `${id} 0 R`).join(' ')}] >>`);
    const catalogId = writer.add(`<< /Type /Catalog /Pages ${pagesRootId} 0 R /MarkInfo << /Marked true >> >>`);
    const infoId = writer.add(
      `<< /Title <${utf16beHex(title, true)}> /Producer (ScanBox PDF Engine) /Creator (ScanBox PWA) >>`
    );
    return writer.build(catalogId, infoId);
  }

  global.ScanBoxPDF = Object.freeze({ build: buildPdf });
})(typeof window !== 'undefined' ? window : globalThis);
