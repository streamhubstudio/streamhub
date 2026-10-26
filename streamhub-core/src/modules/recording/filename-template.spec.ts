/**
 * Unit specs for the recording/snapshot filename templating (module recording).
 * Pure string logic — no infra. Locks the token dialect, the UTC date formatter
 * and (critically) the path-traversal sanitizer.
 */
import {
  formatDate,
  renderFilenameTemplate,
  sanitizeSegment,
  type TemplateTokens,
} from './filename-template';

const AT = new Date(Date.UTC(2026, 6, 13, 9, 5, 7)); // 2026-07-13T09:05:07Z

function tok(over: Partial<TemplateTokens> = {}): TemplateTokens {
  return {
    app: 'live',
    streamId: 'live-lobby/cam1',
    room: 'live-lobby',
    type: 'mp4',
    now: AT,
    ...over,
  };
}

describe('filename-template', () => {
  describe('formatDate', () => {
    it('expands yyyy/yy/MM/dd/HH/mm/ss against a UTC date', () => {
      expect(formatDate('yyyy-MM-dd', AT)).toBe('2026-07-13');
      expect(formatDate('yy', AT)).toBe('26');
      expect(formatDate('HH:mm:ss', AT)).toBe('09:05:07');
    });
    it('passes non-token characters through literally', () => {
      expect(formatDate('yyyy_x', AT)).toBe('2026_x');
    });
  });

  describe('sanitizeSegment', () => {
    it('collapses path separators to a dash (no directories)', () => {
      expect(sanitizeSegment('a/b\\c')).toBe('a-b-c');
    });
    it('neutralizes .. traversal sequences', () => {
      expect(sanitizeSegment('..')).toBe('');
      expect(sanitizeSegment('a/../b')).toBe('a-.-b');
      expect(sanitizeSegment('....')).toBe('');
    });
    it('trims leading/trailing dots and dashes', () => {
      expect(sanitizeSegment('--x--')).toBe('x');
      expect(sanitizeSegment('..x..')).toBe('x');
    });
  });

  describe('renderFilenameTemplate', () => {
    it('returns "" for an empty/blank template (fallback to default naming)', () => {
      expect(renderFilenameTemplate('', tok())).toBe('');
      expect(renderFilenameTemplate('   ', tok())).toBe('');
      expect(renderFilenameTemplate(undefined, tok())).toBe('');
    });

    it('expands the core tokens', () => {
      expect(renderFilenameTemplate('${app}-${room}', tok())).toBe('live-live-lobby');
      expect(renderFilenameTemplate('${type}', tok())).toBe('mp4');
      expect(renderFilenameTemplate('${ts}', tok())).toBe(
        String(Math.floor(AT.getTime() / 1000)),
      );
    });

    it('sanitizes a slash-bearing streamId into one safe segment', () => {
      // streamId is `live-lobby/cam1` — the `/` must NOT create a subdir.
      expect(renderFilenameTemplate('${streamId}', tok())).toBe('live-lobby-cam1');
    });

    it('expands ${date:FORMAT}', () => {
      expect(renderFilenameTemplate('rec-${date:yyyy-MM-dd}', tok())).toBe(
        'rec-2026-07-13',
      );
    });

    it('expands ${var.NAME} from the variables map, missing → empty', () => {
      expect(
        renderFilenameTemplate('${var.site}-${app}', tok({ variables: { site: 'HQ' } })),
      ).toBe('HQ-live');
      expect(renderFilenameTemplate('x${var.nope}y', tok())).toBe('xy');
    });

    it('drops unknown tokens instead of leaking the literal', () => {
      expect(renderFilenameTemplate('a${bogus}b', tok())).toBe('ab');
    });

    it('is traversal-proof even when a variable carries a path', () => {
      const out = renderFilenameTemplate('${var.evil}', tok({
        variables: { evil: '../../etc/passwd' },
      }));
      expect(out).not.toContain('/');
      expect(out).not.toContain('..');
      // becomes a flat, safe segment
      expect(out).toBe('etc-passwd');
    });

    it('renders a realistic StoreHub-style template', () => {
      const out = renderFilenameTemplate('${app}_${room}_${date:yyyyMMdd-HHmmss}', tok());
      expect(out).toBe('live_live-lobby_20260713-090507');
    });
  });
});
