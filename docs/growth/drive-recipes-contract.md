# Drive recipe extension (schema 1, backwards compatible)

Existing configure PATCH `/api/integrations/drive/connections/:id` retains `{expectedVersion,inputFolderId,outputFolderId,labelSize,recipeVersion,enabled}` and adds optional `recipe`:

```ts
type DriveRecipe =
  | { kind: 'zpl' }
  | { kind: 'pdf'; presetId: string; presetVersion: number }
  | { kind: 'template'; templateId: string; templateVersion: number;
      format: 'csv' | 'xlsx'; mapping: {fields: Record<string,string>; quantityColumn?:string};
      delimiter?: ',' | ';' | '\t'; decimalSeparator?: '.' | ',';
      hasHeader?: boolean; sheet?: string | number };
```

Missing recipe means `{kind:'zpl'}` for existing clients. `labelSize` remains required for compatibility and ZPL input; PDF uses the selected preset recipe and template input uses its immutable version size. Every output is PDF. PDF and template recipes require their respective server feature flags in addition to folder automation.

Server resolves the exact owned version while configuring and snapshots its content privately. Future files and already queued runs preserve that recipe version even after the original template/preset changes or is archived. Changing recipe/content/folders/size requires increasing `recipeVersion`; CAS `expectedVersion` still protects the connection. Configure resolves the chosen version again, so archiving prevents newly configuring that choice. Pausing/resuming an unchanged recipe uses POST `/api/integrations/drive/connections/:id/state` with `{expectedVersion,enabled}` and does not re-resolve sources.

Connection and run responses expose `recipe` (the reference/options above), never the private materialized snapshot. Discovery accepts ZPL text/binary up to1MiB; PDF up to20MiB; CSV or XLSX up to5MiB according to the selected format. Unsupported formats are skipped, eligible malformed files fail visibly with a safe error code. Source revision/checksum, output exclusion, run identity and retry fencing remain unchanged. PDF page/crop bounds are revalidated against each input; failures do not silently drop pages or change dimensions. CSV/XLSX uses the existing typed parser, mapping, quantities and injection protection, with no formula/macro execution.

Preview/test connection only tests access to selected folders. Successful folder execution remains the authoritative usage event, with one durable conversion quota reservation per job; selecting/configuring a recipe is not activation.

The state endpoint returns the updated Connection with incremented version and the same recipeVersion/snapshot. It requires no provider call and only accepts currently active/paused connections; revoked/unconfigured connections conflict.
