/**
 * Unit spec — box catalogue flag gating. Dangerous execution boxes appear ONLY
 * when `{ dangerous: true }`; the default palette hides them.
 */
import { boxCatalogue, BOX_CATALOGUE, DANGEROUS_BOXES } from './catalogue';

const DANGEROUS_TYPES = ['action.code', 'action.shell', 'action.ssh', 'action.db'];

describe('boxCatalogue', () => {
  it('hides dangerous boxes by default (dangerous off)', () => {
    const types = boxCatalogue().map((b) => b.type);
    for (const t of DANGEROUS_TYPES) expect(types).not.toContain(t);
    expect(boxCatalogue()).toBe(BOX_CATALOGUE);
  });

  it('includes dangerous boxes (flagged) when dangerous:true', () => {
    const cat = boxCatalogue({ dangerous: true });
    const types = cat.map((b) => b.type);
    for (const t of DANGEROUS_TYPES) expect(types).toContain(t);
    // Every dangerous box is marked so the UI can badge it.
    expect(DANGEROUS_BOXES.every((b) => b.dangerous === true)).toBe(true);
    // ssh/db reference secrets via {{secret.NAME}} help, never an inline field default.
    const ssh = DANGEROUS_BOXES.find((b) => b.type === 'action.ssh')!;
    expect(ssh.fields.find((f) => f.key === 'key')?.help).toMatch(/secret/i);
  });
});
