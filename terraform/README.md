# Optional external storage prerequisite (AWS)

Requires Terraform >= 1.5, AWS credentials that can create S3/IAM resources, and
Databricks workspace authentication with metastore privileges to create storage
credentials, external locations, and catalogs. Use the workspace's AWS region.
The generated trust policy includes the Unity Catalog master role and the role
itself, constrained by the storage credential's external ID. IAM propagation
waits 60 seconds before external location validation.

```bash
cd terraform
cp terraform.tfvars.example terraform.tfvars
# Edit terraform.tfvars for your environment and authenticate both providers.
terraform init
terraform plan
terraform apply
CATALOG=$(terraform output -raw catalog_name)
cd ..
databricks bundle deploy -t workshop --var="catalog=$CATALOG"
```

Keep Terraform state securely: it is required for cleanup. To remove everything,
first run `databricks bundle destroy -t workshop --var="catalog=$CATALOG"`
from the bundle root, then `cd terraform && terraform destroy`. The bucket defaults
to `force_destroy = false`; empty it first or explicitly opt in to deleting demo
objects. This Terraform owns only the prerequisite catalog/storage, not bundle
resources. Do not reuse names of existing resources.

Set `deployer_principal` (default null) for catalog `USE_CATALOG`, `CREATE_SCHEMA`, `MANAGE`; optionally set `grant_create_catalog = true` for metastore `CREATE_CATALOG` (requires a metastore admin to apply).
Singular `databricks_grant` preserves other principals' grants but manages this principal's entire privilege set per securable, including revocation on destroy; avoid existing grants for that same principal/securable pair.
