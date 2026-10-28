variable "subscription_id" {
  description = "Azure subscription in which to create prerequisite storage."
  type        = string
}

variable "location" {
  description = "Azure region of the Databricks workspace (for example eastus2)."
  type        = string
}

variable "resource_group_name" {
  description = "Name of a new dedicated resource group owned by this configuration."
  type        = string
}

variable "storage_account_name" {
  description = "Globally unique ADLS Gen2 storage account name (3–24 lowercase letters or digits)."
  type        = string
  validation {
    condition     = can(regex("^[a-z0-9]{3,24}$", var.storage_account_name))
    error_message = "Use 3–24 lowercase letters or digits."
  }
}

variable "container_name" {
  description = "Private ADLS Gen2 container for demo data."
  type        = string
  default     = "lakebase-demo"
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

variable "catalog_name" {
  description = "UC data catalog; matches the bundle's default catalog variable."
  type        = string
  default     = "lakebase_demo"
}

variable "name_prefix" {
  description = "Prefix for the Access Connector and Unity Catalog storage resources."
  type        = string
  default     = "lakebase-demo"
}

variable "tags" {
  description = "Azure resource tags."
  type        = map(string)
  default     = { demo = "lakebase" }
}

variable "deployer_principal" {
  description = "Optional deployer user email, group name, or service principal application ID. Null skips all deployer grants."
  type        = string
  default     = null
}

variable "grant_create_catalog" {
  description = "Grant CREATE_CATALOG on the current metastore when deployer_principal is set. Requires a metastore admin to apply."
  type        = bool
  default     = false
}
