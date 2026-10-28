# External storage prerequisite (AWS or Azure)

Choose the configuration matching your **existing** Databricks workspace:

| Cloud | Terraform root | Storage | Unity Catalog identity |
| --- | --- | --- | --- |
| AWS | [`aws/`](aws/README.md) | S3 bucket | IAM role |
| Azure | [`azure/`](azure/README.md) | ADLS Gen2 account and container | Access Connector managed identity |

Both create a storage credential, an external location, and a catalog with an
explicit managed storage root. CDF requires this instead of default storage.
They do not create a workspace or deploy the app. Follow the [app deployment
instructions](../README.md) after applying the appropriate configuration.

Use separate Terraform state and provider credentials for each cloud. Set
`databricks_profile` to the intended workspace profile, or provide
`databricks_host` and unified authentication environment variables. Use the same
profile for the bundle commands. Never share cloud state or reuse names of
existing resources. Keep state securely outside version control; it is required
for cleanup. These examples use local state; configure a secure remote backend
if sharing the deployment with others.

## Existing AWS checkout migration

The previous root configuration now lives under `terraform/aws` with unchanged
resource addresses. Move any local `terraform.tfstate*`, `terraform.tfvars`,
and `.terraform/` from `terraform/` into `terraform/aws/` before using it.
Do not apply the AWS configuration with an empty state against existing resources.
Run `terraform init` and review `terraform plan` from `terraform/aws` before any
apply. For a remote backend, retain its configuration and existing state key.
Discard saved plans and generate a new plan after moving the configuration.

## Optional deployer grants

Set `deployer_principal` (default null) for catalog `USE_CATALOG`, `CREATE_SCHEMA`,
and `MANAGE`. Optionally set `grant_create_catalog = true` for metastore
`CREATE_CATALOG` (requires a metastore admin to apply).
Singular `databricks_grant` preserves other principals' grants but manages this
principal's entire privilege set per securable, including revocation on destroy;
avoid existing grants for that same principal/securable pair.

## Cleanup

Destroy the bundle first, using the original workspace profile and catalog:

```bash
# From the repository root:
databricks bundle destroy --profile <workspace-profile> -t workshop --var="catalog=<catalog>"
# Select the cloud root that created the storage/catalog:
terraform -chdir=terraform/<aws-or-azure> destroy
```

Destroying prerequisite storage deletes demo data. Review the destroy plan.
Azure owns a dedicated resource group; keep unrelated resources out of it.
