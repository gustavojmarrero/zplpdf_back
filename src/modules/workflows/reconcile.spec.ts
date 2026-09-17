import { ReconcileInputError, reconcileWorkflow } from './reconcile.js';
import { parseZplLabels } from './zpl-label-parser.js';
import type { WorkflowLabelRecord } from './workflows.types.js';

function labelsFrom(zpl: string): WorkflowLabelRecord[] {
  return parseZplLabels(zpl).map((label) => ({
    labelId: `lbl_${label.sequence}`,
    workflowId: 'wf_1',
    accountId: 'alice',
    sequence: label.sequence,
    zpl: label.zpl,
    copies: label.copies,
    contentHash: label.contentHash,
    groupId: label.groupId,
    byteSize: label.byteSize,
    fields: label.fields,
    serialized: label.serialized,
  }));
}

const CSV = 'pedido_id,guia\nPED-001,GU1\nPED-002,GU2\nPED-003,GU3\n';

describe('reconcileWorkflow', () => {
  it('cruza pedido y guía y marca faltantes', () => {
    const labels = labelsFrom('^XA^FDPED-001^FS^XZ^XA^FDGU2^FS^XZ');

    const { state } = reconcileWorkflow({
      format: 'pedido_id_guia_v1',
      csvContent: CSV,
      labels,
    });

    expect(state.counts.matched).toBe(2);
    expect(state.counts.missing).toBe(1);
    expect(state.missingRows).toEqual([
      { rowNumber: 3, orderId: 'PED-003', tracking: 'GU3' },
    ]);
    expect(state.byLabel['lbl_1']).toEqual({
      status: 'matched',
      orderId: 'PED-001',
      tracking: 'GU1',
    });
    // La segunda etiqueta se identificó por la guía, no por el pedido.
    expect(state.byLabel['lbl_2'].orderId).toBe('PED-002');
  });

  it('marca la repetición sin borrarla y no confunde las copias ^PQ', () => {
    const labels = labelsFrom(
      '^XA^FDPED-001^FS^PQ5^XZ^XA^FDPED-001^FS^XZ^XA^FDPED-002^FS^XZ',
    );

    const { state } = reconcileWorkflow({
      format: 'pedido_id_guia_v1',
      csvContent: CSV,
      labels,
    });

    // Cinco copias de la primera etiqueta son UNA coincidencia, no cinco.
    expect(state.byLabel['lbl_1'].status).toBe('matched');
    expect(state.byLabel['lbl_2'].status).toBe('duplicate');
    expect(state.counts.matched).toBe(2);
    expect(state.counts.duplicate).toBe(1);
    expect(state.duplicateRows).toEqual([
      { rowNumber: 1, orderId: 'PED-001', labelIds: ['lbl_1', 'lbl_2'] },
    ]);
    // Nada se ha eliminado: siguen las tres etiquetas con su diagnóstico.
    expect(Object.keys(state.byLabel)).toHaveLength(3);
  });

  it('distingue no identificado de sobrante', () => {
    const labels = labelsFrom(
      '^XA^FDPED-999^FS^XZ^XA^FO10,10^GB100,100,2^FS^XZ',
    );

    const { state } = reconcileWorkflow({
      format: 'pedido_id_guia_v1',
      csvContent: CSV,
      labels,
    });

    // Tiene un valor legible que no está en el archivo: sobrante.
    expect(state.byLabel['lbl_1'].status).toBe('extra');
    // No tiene ningún valor del que partir: no identificado.
    expect(state.byLabel['lbl_2'].status).toBe('unidentified');
    expect(state.counts.extra).toBe(1);
    expect(state.counts.unidentified).toBe(1);
  });

  it('el resultado no depende del orden actual del lote', () => {
    const labels = labelsFrom('^XA^FDPED-001^FS^XZ^XA^FDPED-001^FS^XZ');
    const reversed = [...labels].reverse();

    const direct = reconcileWorkflow({
      format: 'pedido_id_guia_v1',
      csvContent: CSV,
      labels,
    });
    const shuffled = reconcileWorkflow({
      format: 'pedido_id_guia_v1',
      csvContent: CSV,
      labels: reversed,
    });

    expect(shuffled.state.byLabel).toEqual(direct.state.byLabel);
    expect(direct.state.byLabel['lbl_1'].status).toBe('matched');
  });

  it('conserva los ceros iniciales del identificador', () => {
    const labels = labelsFrom('^XA^FD00751^FS^XZ^XA^FD751^FS^XZ');

    const { state } = reconcileWorkflow({
      format: 'order_id_tracking_v1',
      csvContent: 'order_id,tracking\n00751,T1\n',
      labels,
    });

    expect(state.byLabel['lbl_1']).toMatchObject({
      status: 'matched',
      orderId: '00751',
    });
    // `751` no es `00751`: no se normaliza a número en ningún punto.
    expect(state.byLabel['lbl_2'].status).toBe('extra');
  });

  it('acepta `;` como separador y columnas extra, informándolas', () => {
    const labels = labelsFrom('^XA^FDPED-001^FS^XZ');

    const { state, ignoredColumns } = reconcileWorkflow({
      format: 'pedido_id_guia_v1',
      csvContent: 'pedido_id;guia;transportista\nPED-001;GU1;DHL\n',
      labels,
    });

    expect(state.counts.matched).toBe(1);
    expect(ignoredColumns).toEqual(['transportista']);
  });

  it('rechaza una cabecera que no corresponde al formato declarado', () => {
    expect(() =>
      reconcileWorkflow({
        format: 'order_id_tracking_v1',
        csvContent: CSV,
        labels: labelsFrom('^XA^FDPED-001^FS^XZ'),
      }),
    ).toThrow(ReconcileInputError);
  });

  it('rechaza un separador ambiguo en vez de adivinarlo', () => {
    expect(() =>
      reconcileWorkflow({
        format: 'pedido_id_guia_v1',
        csvContent: 'pedido_id\nPED-001\n',
        labels: labelsFrom('^XA^FDPED-001^FS^XZ'),
      }),
    ).toThrow(/separador/i);
  });

  it('informa las filas vacías y sigue adelante', () => {
    const labels = labelsFrom('^XA^FDPED-001^FS^XZ');

    const { state } = reconcileWorkflow({
      format: 'pedido_id_guia_v1',
      csvContent: 'pedido_id,guia\nPED-001,GU1\n,\n',
      labels,
    });

    expect(state.rowCount).toBe(1);
    expect(state.counts.matched).toBe(1);
  });

  it('rechaza el archivo cuando una fila no tiene pedido', () => {
    try {
      reconcileWorkflow({
        format: 'pedido_id_guia_v1',
        csvContent: 'pedido_id,guia\n,GU1\nPED-002,GU2\n',
        labels: labelsFrom('^XA^FDPED-002^FS^XZ'),
      });
      fail('debería haber lanzado');
    } catch (error) {
      expect(error).toBeInstanceOf(ReconcileInputError);
      expect((error as ReconcileInputError).code).toBe('RECONCILE_ROW_ERRORS');
      expect((error as ReconcileInputError).data.rows).toEqual([
        {
          rowNumber: 1,
          column: 'pedido_id',
          code: 'ROW_REQUIRED_MISSING',
          message: 'La columna pedido_id es obligatoria',
        },
      ]);
    }
  });

  it('rechaza un pedido repetido dentro del propio archivo', () => {
    try {
      reconcileWorkflow({
        format: 'pedido_id_guia_v1',
        csvContent: 'pedido_id,guia\nPED-001,GU1\nPED-001,GU9\n',
        labels: labelsFrom('^XA^FDPED-001^FS^XZ'),
      });
      fail('debería haber lanzado');
    } catch (error) {
      expect((error as ReconcileInputError).data.rows[0]).toMatchObject({
        rowNumber: 2,
        code: 'ROW_DUPLICATE_KEY',
      });
    }
  });
});
