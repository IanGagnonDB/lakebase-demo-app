data "aws_caller_identity" "current" {}
data "aws_partition" "current" {}

locals {
  role_name = "${var.name_prefix}-storage"
  # Compute up front so credential creation does not depend on the IAM role.
  role_arn = "arn:${data.aws_partition.current.partition}:iam::${data.aws_caller_identity.current.account_id}:role/${local.role_name}"
}

resource "aws_s3_bucket" "data" {
  bucket        = var.bucket_name
  force_destroy = var.force_destroy
}

resource "aws_s3_bucket_public_access_block" "data" {
  bucket                  = aws_s3_bucket.data.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

# Bootstrap without validation: the credential's external ID is needed to build
# the role's final trust policy. External location creation validates it later.
resource "databricks_storage_credential" "data" {
  name = "${var.name_prefix}-storage"
  aws_iam_role {
    role_arn = local.role_arn
  }
  skip_validation = true
  comment         = "External storage for the Lakebase demo data catalog"
}

data "databricks_aws_unity_catalog_assume_role_policy" "data" {
  aws_account_id        = data.aws_caller_identity.current.account_id
  role_name             = local.role_name
  external_id           = databricks_storage_credential.data.aws_iam_role[0].external_id
  unity_catalog_iam_arn = databricks_storage_credential.data.aws_iam_role[0].unity_catalog_iam_arn
}

data "databricks_aws_unity_catalog_policy" "data" {
  aws_account_id = data.aws_caller_identity.current.account_id
  bucket_name    = aws_s3_bucket.data.id
  role_name      = local.role_name
}

resource "aws_iam_role" "data" {
  name               = local.role_name
  assume_role_policy = data.databricks_aws_unity_catalog_assume_role_policy.data.json
}

resource "aws_iam_role_policy" "data" {
  name   = "${var.name_prefix}-storage"
  role   = aws_iam_role.data.id
  policy = data.databricks_aws_unity_catalog_policy.data.json
}

resource "time_sleep" "iam_propagation" {
  depends_on      = [aws_iam_role_policy.data, aws_s3_bucket_public_access_block.data]
  create_duration = "60s"
  triggers = {
    trust_policy  = aws_iam_role.data.assume_role_policy
    access_policy = aws_iam_role_policy.data.policy
  }
}

resource "databricks_external_location" "data" {
  name            = "${var.name_prefix}-storage"
  url             = "s3://${aws_s3_bucket.data.id}/"
  credential_name = databricks_storage_credential.data.name
  depends_on      = [time_sleep.iam_propagation]
}

resource "databricks_catalog" "data" {
  name         = var.catalog_name
  storage_root = "${trimsuffix(databricks_external_location.data.url, "/")}/catalog"
  comment      = "Lakebase demo data on external storage"
}
