import type { TemplateField, TemplateKind } from './label-templates.types.js';

export interface BuiltinTemplate {
  kind: TemplateKind;
  name: string;
  labelSize: string;
  fields: TemplateField[];
  zplTemplate: string;
}

/**
 * Las tres plantillas iniciales del MVP: producto, ubicación y lote.
 *
 * Son definiciones de partida, no una plantilla del usuario: `POST
 * /label-templates` con `fromBuiltin` crea una copia propia de la cuenta y su
 * versión 1, que a partir de ahí es inmutable como cualquier otra. Un diseñador
 * visual general queda fuera de esta fase.
 *
 * Cada marcador aparece exactamente como `^FD{{clave}}^FS`: es la forma que el
 * validador exige y la que permite sustituirlo por un campo escapado con `^FH`.
 */
export const BUILTIN_TEMPLATES: Record<TemplateKind, BuiltinTemplate> = {
  product: {
    kind: 'product',
    name: 'Etiqueta de producto',
    labelSize: '2x1',
    fields: [
      {
        key: 'sku',
        label: 'SKU',
        type: 'code',
        required: true,
        maxLength: 32,
        charset: 'alnum_dash',
      },
      {
        key: 'name',
        label: 'Nombre',
        type: 'text',
        required: true,
        maxLength: 60,
      },
      { key: 'price', label: 'Precio', type: 'decimal', required: false },
      {
        key: 'barcode',
        label: 'Código de barras',
        type: 'barcode',
        required: true,
        maxLength: 32,
        barcodeSymbology: 'code128',
      },
    ],
    zplTemplate: [
      '^XA',
      '^CI28',
      '^FO12,12^A0N,28,28^FD{{name}}^FS',
      '^FO12,48^A0N,22,22^FD{{sku}}^FS',
      '^FO280,48^A0N,26,26^FD{{price}}^FS',
      '^FO12,80^BY2,2,60^BCN,60,Y,N,N^FD{{barcode}}^FS',
      '^XZ',
    ].join('\n'),
  },

  location: {
    kind: 'location',
    name: 'Etiqueta de ubicación',
    labelSize: '4x2',
    fields: [
      {
        key: 'location_code',
        label: 'Código de ubicación',
        type: 'code',
        required: true,
        maxLength: 24,
        charset: 'alnum_dash',
      },
      {
        key: 'warehouse',
        label: 'Almacén',
        type: 'text',
        required: true,
        maxLength: 40,
      },
      {
        key: 'aisle',
        label: 'Pasillo',
        type: 'code',
        required: true,
        maxLength: 8,
        charset: 'alnum_dash',
      },
      {
        key: 'rack',
        label: 'Estante',
        type: 'code',
        required: true,
        maxLength: 8,
        charset: 'alnum_dash',
      },
      {
        key: 'level',
        label: 'Nivel',
        type: 'code',
        required: true,
        maxLength: 8,
        charset: 'alnum_dash',
      },
    ],
    zplTemplate: [
      '^XA',
      '^CI28',
      '^FO20,18^A0N,44,44^FD{{location_code}}^FS',
      '^FO20,72^A0N,28,28^FD{{warehouse}}^FS',
      '^FO20,110^A0N,24,24^FD{{aisle}}^FS',
      '^FO170,110^A0N,24,24^FD{{rack}}^FS',
      '^FO320,110^A0N,24,24^FD{{level}}^FS',
      '^FO20,150^BY3,2,90^BCN,90,Y,N,N^FD{{location_code}}^FS',
      '^XZ',
    ].join('\n'),
  },

  lot: {
    kind: 'lot',
    name: 'Etiqueta de lote',
    labelSize: '4x2',
    fields: [
      {
        key: 'lot',
        label: 'Lote',
        type: 'code',
        required: true,
        maxLength: 32,
        charset: 'alnum_dash',
      },
      {
        key: 'product',
        label: 'Producto',
        type: 'text',
        required: true,
        maxLength: 60,
      },
      {
        key: 'expires_at',
        label: 'Caducidad',
        type: 'date',
        required: true,
      },
      {
        key: 'quantity',
        label: 'Cantidad por etiqueta',
        type: 'integer',
        required: false,
      },
    ],
    zplTemplate: [
      '^XA',
      '^CI28',
      '^FO20,15^A0N,34,34^FD{{product}}^FS',
      '^FO20,58^A0N,26,26^FD{{lot}}^FS',
      '^FO20,92^A0N,26,26^FD{{expires_at}}^FS',
      '^FO300,92^A0N,26,26^FD{{quantity}}^FS',
      '^FO20,128^BY3,2,80^BCN,80,Y,N,N^FD{{lot}}^FS',
      '^XZ',
    ].join('\n'),
  },
};

export const BUILTIN_KINDS = Object.keys(BUILTIN_TEMPLATES) as TemplateKind[];
