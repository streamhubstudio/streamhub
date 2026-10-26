/**
 * Unit spec — portable workflow export/import (Streamflow). Pure: no NestJS/IO.
 * Locks: round-trip fidelity (boxes+edges), unknown box type → GraphImportError,
 * secret-ish config redaction on export, and `{{secret.X}}` refs preserved.
 */
import { BOX_CATALOGUE } from './catalogue';
import {
  exportWorkflow,
  GraphImportError,
  importWorkflow,
  PORTABLE_VERSION,
  stripSecretishConfig,
} from './portable';

const graph = {
  boxes: [
    { id: 't', type: 'trigger.event', config: { event: 'plate.detected' }, position: { x: 1, y: 2 } },
    { id: 'h', type: 'action.http', config: { url: 'https://hook/x', apiKey: 'sk-LIVEabc1234567890', token: '{{secret.HOOK}}' } },
    { id: 'n', type: 'action.notify', config: { title: 'hi' } },
  ],
  edges: [
    { from: 't', to: 'h', fromPort: 'out', toPort: 'in' },
    { from: 'h', to: 'n', fromPort: 'out', toPort: 'in' },
  ],
};

describe('exportWorkflow', () => {
  it('produces versioned, round-trip-faithful portable JSON', () => {
    const p = exportWorkflow({ name: 'Flow', graph });
    expect(p.streamflow).toBe(PORTABLE_VERSION);
    expect(p.name).toBe('Flow');
    expect(p.graph.boxes).toHaveLength(3);
    expect(p.graph.edges).toHaveLength(2);
    // positions preserved
    expect(p.graph.boxes[0].config).toEqual({ event: 'plate.detected' });
  });

  it('redacts secret-ish config values but keeps {{secret.X}} refs', () => {
    const p = exportWorkflow({ name: 'Flow', graph });
    const httpBox = p.graph.boxes.find((b) => b.id === 'h')!;
    // literal key value stripped
    expect(httpBox.config.apiKey).toBe('');
    // template ref kept verbatim (it is a ref, not a value)
    expect(httpBox.config.token).toBe('{{secret.HOOK}}');
    // non-secret value untouched
    expect(httpBox.config.url).toBe('https://hook/x');
    expect(p.redactions).toContain('h.apiKey');
  });
});

describe('stripSecretishConfig', () => {
  it('redacts by sensitive key name and literal value, keeps templates', () => {
    const { config, redactions } = stripSecretishConfig(
      { password: 'p4ssw0rd-real-value', keep: 'plain', ref: '{{secret.A}}', body: 'sk-verylongkeyvalue0000000000000000000000' },
      'x',
    );
    expect(config.password).toBe('');
    expect(config.keep).toBe('plain');
    expect(config.ref).toBe('{{secret.A}}');
    expect(config.body).toBe(''); // literal-key heuristic
    expect(redactions.sort()).toEqual(['x.body', 'x.password']);
  });
});

describe('importWorkflow', () => {
  it('round-trips an exported workflow through the catalogue', () => {
    const p = exportWorkflow({ name: 'Flow', graph });
    const { name, graph: g } = importWorkflow(p, BOX_CATALOGUE);
    expect(name).toBe('Flow');
    expect(g.boxes).toHaveLength(3);
    expect(g.edges).toHaveLength(2);
  });

  it('throws GraphImportError for an unknown box type', () => {
    const bad = {
      streamflow: 1,
      name: 'X',
      graph: { boxes: [{ id: 'a', type: 'action.evil', config: {} }], edges: [] },
    };
    expect(() => importWorkflow(bad, BOX_CATALOGUE)).toThrow(GraphImportError);
    try {
      importWorkflow(bad, BOX_CATALOGUE);
    } catch (e) {
      expect((e as GraphImportError).unknownTypes).toEqual(['action.evil']);
    }
  });

  it('rejects an empty graph and a cyclic graph', () => {
    expect(() => importWorkflow({ name: 'e', graph: { boxes: [], edges: [] } }, BOX_CATALOGUE)).toThrow(/no boxes/);
    const cyclic = {
      name: 'c',
      graph: {
        boxes: [
          { id: 'a', type: 'action.notify', config: {} },
          { id: 'b', type: 'action.notify', config: {} },
        ],
        edges: [
          { from: 'a', to: 'b' },
          { from: 'b', to: 'a' },
        ],
      },
    };
    expect(() => importWorkflow(cyclic, BOX_CATALOGUE)).toThrow();
  });

  it('falls back to a default name when none is provided', () => {
    const { name } = importWorkflow(
      { graph: { boxes: [{ id: 'a', type: 'action.notify', config: {} }], edges: [] } },
      BOX_CATALOGUE,
      'Fallback',
    );
    expect(name).toBe('Fallback');
  });
});
