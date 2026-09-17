import { validate as isUuid, version as uuidVersion } from 'uuid';
import { deterministicUuidV4 } from './deterministic-uuid.js';

describe('deterministicUuidV4', () => {
  it('tiene forma de UUID v4 válida', () => {
    const id = deterministicUuidV4('export:alice:k1');
    expect(isUuid(id)).toBe(true);
    expect(uuidVersion(id)).toBe(4);
  });

  it('la misma semilla da el mismo identificador', () => {
    expect(deterministicUuidV4('a')).toBe(deterministicUuidV4('a'));
  });

  it('semillas distintas dan identificadores distintos', () => {
    expect(deterministicUuidV4('export:alice:k1')).not.toBe(
      deterministicUuidV4('export:bob:k1'),
    );
    expect(deterministicUuidV4('export:alice:k1')).not.toBe(
      deterministicUuidV4('export:alice:k2'),
    );
  });
});
