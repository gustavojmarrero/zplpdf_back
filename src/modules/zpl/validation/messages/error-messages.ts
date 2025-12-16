/**
 * Mensajes de error bilingues para validacion ZPL
 */

export interface ErrorMessages {
  // Structure
  missingXA: string;
  missingXZ: string;
  multipleXA: string;
  multipleXZ: string;
  suggestXA: string;
  suggestXZ: string;
  suggestSplitBlocks: string;

  // Field
  fdFsImbalance: (fdCount: number, fsCount: number) => string;
  emptyFd: string;
  fdWithoutPosition: string;
  suggestCheckFdFs: string;
  suggestRemoveEmptyFd: string;
  suggestAddPosition: string;

  // Position
  foMissingCoords: string;
  ftMissingCoords: string;
  negativeCoords: string;
  largeCoords: string;
  suggestFoFormat: string;
  suggestFtFormat: string;
  suggestPositiveCoords: string;
  suggestCheckLabelSize: string;

  // Barcode
  unsupportedBarcode: (cmd: string) => string;
  invalidOrientation: (orient: string) => string;
  invalidQRModel: string;
  invalidBarWidth: string;
  emptyBarcodeData: string;
  suggestSupportedBarcodes: string;
  suggestOrientations: string;
  suggestQRModels: string;
  suggestBarWidth: string;
  suggestAddBarcodeData: string;

  // Command
  unsupportedCommand: (cmd: string) => string;
  deprecatedCommand: (cmd: string) => string;
  invalidGraphicBox: string;
  unknownFont: (font: string) => string;
  suggestRemoveCommand: (cmd: string) => string;
  suggestAlternative: (cmd: string) => string;
  suggestGBParams: string;
  suggestFonts: string;
}

export const messagesES: ErrorMessages = {
  // Structure
  missingXA: 'Falta el comando de inicio de etiqueta ^XA',
  missingXZ: 'Falta el comando de fin de etiqueta ^XZ',
  multipleXA: 'Se encontraron multiples comandos ^XA en un solo bloque',
  multipleXZ: 'Se encontraron multiples comandos ^XZ en un solo bloque',
  suggestXA: 'Agregue ^XA al inicio de cada etiqueta',
  suggestXZ: 'Agregue ^XZ al final de cada etiqueta',
  suggestSplitBlocks: 'Separe cada etiqueta en bloques individuales ^XA...^XZ',

  // Field
  fdFsImbalance: (fd, fs) =>
    `Desequilibrio de campos: ${fd} ^FD encontrados pero ${fs} ^FS`,
  emptyFd: 'Campo de datos vacio (^FD sin contenido)',
  fdWithoutPosition: '^FD sin comando de posicion previo (^FO o ^FT)',
  suggestCheckFdFs: 'Verifique que cada ^FD tenga su correspondiente ^FS',
  suggestRemoveEmptyFd: 'Elimine el campo vacio o agregue contenido',
  suggestAddPosition: 'Agregue ^FO o ^FT antes de ^FD para definir la posicion',

  // Position
  foMissingCoords: '^FO requiere coordenadas X,Y',
  ftMissingCoords: '^FT requiere coordenadas X,Y',
  negativeCoords: 'Coordenadas negativas pueden causar recorte',
  largeCoords: 'Coordenadas muy grandes pueden estar fuera de la etiqueta',
  suggestFoFormat: 'Use el formato ^FOx,y (ej: ^FO50,100)',
  suggestFtFormat: 'Use el formato ^FTx,y (ej: ^FT50,100)',
  suggestPositiveCoords: 'Use coordenadas positivas dentro del area de impresion',
  suggestCheckLabelSize:
    'Verifique que las coordenadas esten dentro del tamano de etiqueta',

  // Barcode
  unsupportedBarcode: (cmd) => `Tipo de codigo de barras ${cmd} no soportado`,
  invalidOrientation: (orient) => `Orientacion '${orient}' no valida`,
  invalidQRModel: 'Modelo de QR debe ser 1 o 2',
  invalidBarWidth: 'Ancho de barra fuera de rango (1-10)',
  emptyBarcodeData: 'Codigo de barras sin datos',
  suggestSupportedBarcodes: 'Use: ^BC (Code128), ^BQ (QR), ^B3 (Code39)',
  suggestOrientations: 'Orientaciones validas: N (normal), R (90), I (180), B (270)',
  suggestQRModels: 'Use modelo 2 para mejor compatibilidad',
  suggestBarWidth: 'Ancho recomendado: 2-4',
  suggestAddBarcodeData:
    'Agregue datos en ^FD despues del comando de codigo de barras',

  // Command
  unsupportedCommand: (cmd) => `Comando ${cmd} no soportado por Labelary`,
  deprecatedCommand: (cmd) => `Comando ${cmd} esta deprecado`,
  invalidGraphicBox: 'Caja grafica con dimensiones invalidas',
  unknownFont: (font) => `Fuente '${font}' no reconocida`,
  suggestRemoveCommand: (cmd) => `Elimine ${cmd} ya que no afectara la salida`,
  suggestAlternative: () => `Considere usar una alternativa moderna`,
  suggestGBParams: '^GB requiere al menos ancho o alto mayor a 0',
  suggestFonts: 'Fuentes validas: 0, A-V',
};

export const messagesEN: ErrorMessages = {
  // Structure
  missingXA: 'Missing label start command ^XA',
  missingXZ: 'Missing label end command ^XZ',
  multipleXA: 'Multiple ^XA commands found in single block',
  multipleXZ: 'Multiple ^XZ commands found in single block',
  suggestXA: 'Add ^XA at the beginning of each label',
  suggestXZ: 'Add ^XZ at the end of each label',
  suggestSplitBlocks: 'Separate each label into individual ^XA...^XZ blocks',

  // Field
  fdFsImbalance: (fd, fs) => `Field imbalance: ${fd} ^FD found but ${fs} ^FS`,
  emptyFd: 'Empty data field (^FD without content)',
  fdWithoutPosition: '^FD without preceding position command (^FO or ^FT)',
  suggestCheckFdFs: 'Verify each ^FD has a corresponding ^FS',
  suggestRemoveEmptyFd: 'Remove empty field or add content',
  suggestAddPosition: 'Add ^FO or ^FT before ^FD to define position',

  // Position
  foMissingCoords: '^FO requires X,Y coordinates',
  ftMissingCoords: '^FT requires X,Y coordinates',
  negativeCoords: 'Negative coordinates may cause clipping',
  largeCoords: 'Large coordinates may be outside label area',
  suggestFoFormat: 'Use format ^FOx,y (e.g., ^FO50,100)',
  suggestFtFormat: 'Use format ^FTx,y (e.g., ^FT50,100)',
  suggestPositiveCoords: 'Use positive coordinates within print area',
  suggestCheckLabelSize: 'Verify coordinates are within label size',

  // Barcode
  unsupportedBarcode: (cmd) => `Barcode type ${cmd} not supported`,
  invalidOrientation: (orient) => `Orientation '${orient}' is not valid`,
  invalidQRModel: 'QR model must be 1 or 2',
  invalidBarWidth: 'Bar width out of range (1-10)',
  emptyBarcodeData: 'Barcode without data',
  suggestSupportedBarcodes: 'Use: ^BC (Code128), ^BQ (QR), ^B3 (Code39)',
  suggestOrientations: 'Valid orientations: N (normal), R (90), I (180), B (270)',
  suggestQRModels: 'Use model 2 for better compatibility',
  suggestBarWidth: 'Recommended width: 2-4',
  suggestAddBarcodeData: 'Add data in ^FD after barcode command',

  // Command
  unsupportedCommand: (cmd) => `Command ${cmd} not supported by Labelary`,
  deprecatedCommand: (cmd) => `Command ${cmd} is deprecated`,
  invalidGraphicBox: 'Graphic box with invalid dimensions',
  unknownFont: (font) => `Font '${font}' not recognized`,
  suggestRemoveCommand: (cmd) => `Remove ${cmd} as it won't affect output`,
  suggestAlternative: () => `Consider using a modern alternative`,
  suggestGBParams: '^GB requires at least width or height greater than 0',
  suggestFonts: 'Valid fonts: 0, A-V',
};

export function getMessages(language: 'es' | 'en'): ErrorMessages {
  return language === 'es' ? messagesES : messagesEN;
}
