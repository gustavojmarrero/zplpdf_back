/**
 * Inspección del directorio central de un ZIP, sin descomprimir nada.
 *
 * Un .xlsx es un ZIP, y un ZIP de 5 MB puede descomprimirse en varios GB. El
 * tope de bytes de entrada no basta como límite: hace falta saber cuánto va a
 * ocupar **antes** de pedirle a la librería que lo abra. El directorio central
 * declara el tamaño sin comprimir de cada entrada y su nombre, así que se lee
 * de ahí: son unos pocos cientos de bytes y evita abrir una bomba.
 *
 * También es la forma correcta de detectar macros: el nombre de entrada
 * `vbaProject.bin` aparece en el directorio, no hay que buscarlo a ciegas en el
 * contenido.
 */
export interface ZipInventory {
  entries: { name: string; uncompressedSize: number }[];
  totalUncompressedSize: number;
  /** true si alguna entrada declara su tamaño en formato ZIP64. */
  hasUnknownSizes: boolean;
}

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const EOCD_MIN_SIZE = 22;
const MAX_COMMENT_SIZE = 0xffff;
const ZIP64_MARKER = 0xffffffff;

export class ZipFormatError extends Error {}

function findEndOfCentralDirectory(buffer: Buffer): number {
  const start = Math.max(0, buffer.length - (EOCD_MIN_SIZE + MAX_COMMENT_SIZE));
  for (
    let offset = buffer.length - EOCD_MIN_SIZE;
    offset >= start;
    offset -= 1
  ) {
    if (buffer.readUInt32LE(offset) === EOCD_SIGNATURE) return offset;
  }
  throw new ZipFormatError('No se encontró el directorio central del ZIP');
}

export function readZipInventory(
  buffer: Buffer,
  maxEntries: number,
): ZipInventory {
  if (buffer.length < EOCD_MIN_SIZE) {
    throw new ZipFormatError('El archivo es demasiado corto para ser un ZIP');
  }

  const eocd = findEndOfCentralDirectory(buffer);
  const entryCount = buffer.readUInt16LE(eocd + 10);
  let offset = buffer.readUInt32LE(eocd + 16);

  if (entryCount > maxEntries) {
    throw new ZipFormatError(
      `El archivo tiene ${entryCount} entradas; el máximo es ${maxEntries}`,
    );
  }

  const entries: ZipInventory['entries'] = [];
  let totalUncompressedSize = 0;
  let hasUnknownSizes = false;

  for (let index = 0; index < entryCount; index += 1) {
    if (offset + 46 > buffer.length) {
      throw new ZipFormatError('El directorio central del ZIP está truncado');
    }
    if (buffer.readUInt32LE(offset) !== CENTRAL_SIGNATURE) {
      throw new ZipFormatError('El directorio central del ZIP no es válido');
    }

    const uncompressedSize = buffer.readUInt32LE(offset + 24);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const name = buffer
      .subarray(offset + 46, offset + 46 + nameLength)
      .toString('utf8');

    if (uncompressedSize === ZIP64_MARKER) {
      // El tamaño real vive en un campo extra ZIP64. En un .xlsx de pocos MB no
      // tiene sentido: se trata como desconocido y quien llama lo rechaza.
      hasUnknownSizes = true;
    } else {
      totalUncompressedSize += uncompressedSize;
    }

    entries.push({ name, uncompressedSize });
    offset += 46 + nameLength + extraLength + commentLength;
  }

  return { entries, totalUncompressedSize, hasUnknownSizes };
}
