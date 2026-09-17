import type { ColumnMapping } from './label-templates.types.js';

/** Strip transport DTO prototypes before a mapping enters persisted state. */
export function plainColumnMapping(mapping: ColumnMapping): ColumnMapping {
  return {
    fields: { ...mapping.fields },
    ...(mapping.quantityColumn !== undefined
      ? { quantityColumn: mapping.quantityColumn }
      : {}),
  };
}
