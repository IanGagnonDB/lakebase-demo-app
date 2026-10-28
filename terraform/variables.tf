variable "aws_region" {
  description = "AWS region of the Databricks workspace."
  type        = string
}

variable "aws_profile" {
  description = "Optional AWS shared configuration profile; null uses the default credential chain."
  type        = string
  default     = null
}

variable "databricks_profile" {
  description = "Optional Databricks CLI workspace profile."
  type        = string
  default     = null
}

variable "databricks_host" {
  description = "Optional workspace URL; may instead be supplied by the profile or DATABRICKS_HOST."
  type        = string
  default     = null
}

variable "bucket_name" {
  description = "Globally unique S3 bucket name, in the workspace region."
  type        = string
}

variable "catalog_name" {
  description = "UC data catalog; matches the bundle's default catalog variable."
  type        = string
  default     = "lakebase_demo"
}

variable "name_prefix" {
  description = "Prefix for IAM and Unity Catalog storage resources."
  type        = string
  default     = "lakebase-demo"
}

variable "force_destroy" {
  description = "Allow Terraform to delete a nonempty S3 bucket. Enable only for disposable demo data."
  type        = bool
  default     = false
}

variable "tags" {
  description = "AWS resource tags."
  type        = map(string)
  default     = { demo = "lakebase" }
}
