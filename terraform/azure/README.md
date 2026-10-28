# Azure external storage prerequisite

Run this configuration from `terraform/azure`. It creates a dedicated resource
group, ADLS Gen2 storage account and private container, Databricks Access Connector
with a system-assigned managed identity, container-scoped Storage Blob Data
Contributor assignment, account-scoped Storage Blob Delegator assignment for user
delegation keys, Unity Catalog storage credential, external location, and
the demo data catalog in an **existing Azure Databricks workspace**.

Requires Terraform >= 1.5 and an Azure workspace/region with serverless compute,
Apps, Lakebase Autoscaling, and the previews listed in the [root README](../../README.md).
Use the workspace's Azure region. This does not create a new workspace.

## Authentication and permissions

- Authenticate Azure with `az login` (or the AzureRM provider's service principal /
  workload identity environment variables). Supply `subscription_id` explicitly.
- The Azure deployer needs permission to create the resource group, storage account,
  container, and Access Connector, plus `Microsoft.Authorization/roleAssignments/write`
  (for example Owner, or Contributor plus Role Based Access Control Administrator).
- The provider uses Microsoft Entra authentication for storage; the Terraform runner
  also needs **Storage Blob Data Contributor** on the account or an ancestor scope
  to create/delete containers. Control-plane Contributor alone is insufficient.
  Have an Azure admin grant this at subscription scope before applying, or at the
  dedicated resource group after it exists, then rerun the plan/apply.
- Authenticate Databricks with `databricks auth login --host <workspace-url>
  --profile <azure-workspace-profile>` (on one line). Set that profile in
  `terraform.tfvars`. The Databricks identity needs metastore privileges to create
  storage credentials, external locations, and catalogs, and permission to use the
  Access Connector (Azure Reader or higher on it).

The storage account disables public blob access and shared keys. Its network
endpoint remains reachable so serverless compute and the Terraform runner can
access it; environments requiring firewalls/private endpoints need their own
network configuration. The default endpoint targets Azure public cloud.

## Provision and deploy

```bash
cd terraform/azure
cp terraform.tfvars.example terraform.tfvars
# Edit terraform.tfvars with the subscription, region, unique names, and workspace profile.
terraform init
terraform plan
terraform apply
terraform output -raw catalog_name
```

Azure RBAC waits 60 seconds before the external location validates access. If
propagation takes longer, wait and rerun `terraform apply`; validation stays enabled.
The Access Connector identity receives blob data access only to the demo container,
plus permission to request user delegation keys at storage-account scope.

Then return to the repository root and follow the [bundle deployment commands](../../README.md#deploy-once-15-min)
with the same workspace profile and output catalog. The bundle creates the app,
Lakebase project, SQL warehouse, schemas, and setup job; run setup and start the
app, then verify the Readiness page and first synced-table sync before benchmarks.

See [shared instructions](../README.md) for grants and cleanup. Destroying this
configuration removes the dedicated resource group and its demo storage/data;
keep unrelated resources out of it. Existing AWS resources are independent.
