import type { Provider } from '@nestjs/common';
import { FirestoreService } from '../cache/firestore.service.js';

export const PRODUCT_OBSERVABILITY_FIRESTORE = Symbol(
  'PRODUCT_OBSERVABILITY_FIRESTORE',
);
/** Shares the existing configured client, including project and emulator settings. */
export const ObservabilityFirestoreProvider: Provider = {
  provide: PRODUCT_OBSERVABILITY_FIRESTORE,
  inject: [FirestoreService],
  useFactory: (store: FirestoreService) => store.getClient(),
};
