output "catalog_name" {
  description = "Pass this catalog to the Databricks bundle."
  value       = databricks_catalog.data.name
}
