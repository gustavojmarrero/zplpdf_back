# BE07 persistent PDF presets — schemaVersion 1

Firebase bearer auth and `pdf_preparation` flag required. Base path `/api/pdf-preparation/presets`.

- GET base -> `{schemaVersion:1,presets:Preset[]}` (at most50 active presets, newest updated first).
- POST base `{id:UUIDv4,name:string,recipe:PdfRecipe}` -> `{schemaVersion:1,preset:Preset}`. Same ID + identical initial input replays version1; changed input conflicts409.
- GET `/:id/versions` -> `{schemaVersion:1,versions:Preset[]}` (latest200, descending version).
- POST `/:id/versions` `{expectedVersion:number,name:string,recipe:PdfRecipe}` -> `{schemaVersion:1,preset:Preset}`. CAS creates a new immutable version; an exact retry with the same expectedVersion/body returns that created version.
- POST `/:id/archive` `{expectedVersion:number}` -> `{schemaVersion:1,preset:Preset}`. CAS; existing versions remain immutable. Archived presets cannot create new versions.

`Preset = {id,name,version,recipe,status:'active'|'archived',createdAt,updatedAt}`. Version starts at1; `recipe` is the existing exact PdfRecipe including selections, crop/rotation and physical layout. Presets retain the complete recipe; when applying to another PDF the existing export revalidates page bounds and crop against that file. Show validation errors rather than silently skipping pages or changing size.

Saved presets do not expire with uploaded source files. Maximum50 active presets per account and200 immutable versions per preset. Names trimmed1–120 chars. Resource IDs belonging to another user return404. All mutations check account deletion in the transaction. No filenames, source bytes or signed URLs are stored in a preset. Existing export accepts the materialized recipe unchanged; frontend records the chosen preset/version locally for display, with no claim that selecting a preset caused a payment.
