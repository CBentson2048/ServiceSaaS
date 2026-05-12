# CRM V1 Implementation Note

CRM V1 adds staff-facing client records for the web dashboard and API. It covers client profile search, client detail, visit history summaries, operational notes, allergy records, patch-test records, message log reads, visit-photo metadata, and GDPR request scaffolding.

Permission boundaries follow the existing canonical roles:

- `owner`: business-wide CRM access.
- `manager`: CRM access scoped to assigned locations.
- `stylist`: read access limited to assigned scope or client records connected to their own appointment/visit history.
- `client`: no staff CRM access; client-facing history must use separate client-safe endpoints.

Client visibility remains deliberately narrow. CRM visit history exposes service summaries and client-visible summaries only; formula ingredients, product costs, and Sheer Lab internals must stay out of client-facing responses.

CRM stores no raw payment card data. If payment context is needed in later phases, only safe references such as Stripe IDs, payment status, deposit status, and timestamps should be stored.

Later phases should add full GDPR export/delete workflows, storage upload signing for visit photos, deeper mobile staff views, and executable Jest coverage once the Supabase service test harness is available.
