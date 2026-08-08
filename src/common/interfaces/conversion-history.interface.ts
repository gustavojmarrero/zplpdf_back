export interface ConversionHistory {
  userId: string;
  jobId: string;
  labelCount: number;
  labelSize: string;
  status: 'completed' | 'failed';
  outputFormat: 'pdf' | 'png' | 'jpeg';
  fileUrl?: string;
  createdAt: Date;
}

/**
 * Registro de historial tal y como vive en Firestore: incluye el id del
 * documento, necesario para las acciones por fila del frontend.
 */
export interface ConversionHistoryRecord extends ConversionHistory {
  id: string;
}
