# AWS external storage prerequisite

Run this configuration from `terraform/aws`. It creates an S3 bucket, an IAM
role trusted by Unity Catalog, a storage credential, an external location, and
the demo data catalog in an existing AWS Databricks workspace. IAM propagation
waits 60 seconds before external location validation.

Requires Terraform >= 1.5, AWS credentials that can create S3/IAM resources, and
Databricks metastore privileges to create storage credentials, external locations,
and catalogs. The bucket must be in the workspace region.

```bash
cd terraform/aws
cp terraform.tfvars.example terraform.tfvars
# Edit terraform.tfvars and authenticate both providers.
terraform init
terraform plan
terraform apply
terraform output -raw catalog_name
```

Use the resulting catalog with the bundle commands in the [root README](../../README.md).
See [shared instructions](../README.md) for permissions, state, migration, and cleanup.
The bucket defaults to `force_destroy = false`; empty it before destroying or
explicitly opt in to deleting disposable demo objects.
