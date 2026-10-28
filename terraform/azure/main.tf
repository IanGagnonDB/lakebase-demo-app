resource "azurerm_resource_group" "data" {
  name     = var.resource_group_name
  location = var.location
  tags     = var.tags
}

resource "azurerm_storage_account" "data" {
  name                            = var.storage_account_name
  resource_group_name             = azurerm_resource_group.data.name
  location                        = azurerm_resource_group.data.location
  account_tier                    = "Standard"
  account_replication_type        = "LRS"
  is_hns_enabled                  = true
  min_tls_version                 = "TLS1_2"
  shared_access_key_enabled       = false
  allow_nested_items_to_be_public = false
  tags                            = var.tags
}

resource "azurerm_storage_container" "data" {
  name                  = var.container_name
  storage_account_id    = azurerm_storage_account.data.id
  container_access_type = "private"
}

resource "azurerm_databricks_access_connector" "data" {
  name                = "${var.name_prefix}-storage"
  resource_group_name = azurerm_resource_group.data.name
  location            = azurerm_resource_group.data.location
  identity {
    type = "SystemAssigned"
  }
  tags = var.tags
}

# Scope the connector's data access to this container only.
resource "azurerm_role_assignment" "data" {
  scope                = azurerm_storage_container.data.id
  role_definition_name = "Storage Blob Data Contributor"
  principal_id         = azurerm_databricks_access_connector.data.identity[0].principal_id
  principal_type       = "ServicePrincipal"
}

resource "databricks_storage_credential" "data" {
  name = "${var.name_prefix}-storage"
  azure_managed_identity {
    access_connector_id = azurerm_databricks_access_connector.data.id
  }
  comment = "External storage for the Lakebase demo data catalog"
}

# Azure RBAC is eventually consistent; external location creation validates access.
resource "time_sleep" "rbac_propagation" {
  depends_on      = [azurerm_role_assignment.data]
  create_duration = "60s"
  triggers = {
    role_assignment_id = azurerm_role_assignment.data.id
  }
}

resource "databricks_external_location" "data" {
  name            = "${var.name_prefix}-storage"
  url             = "abfss://${azurerm_storage_container.data.name}@${azurerm_storage_account.data.name}.dfs.core.windows.net/"
  credential_name = databricks_storage_credential.data.name
  depends_on      = [time_sleep.rbac_propagation]
}

resource "databricks_catalog" "data" {
  name         = var.catalog_name
  storage_root = "${trimsuffix(databricks_external_location.data.url, "/")}/catalog"
  comment      = "Lakebase demo data on external storage"
}

# Singular grants preserve other principals' grants, but manage this principal's
# entire privilege set on each securable; do not manage that same pair elsewhere.
resource "databricks_grant" "deployer_catalog" {
  count = var.deployer_principal != null ? 1 : 0

  catalog    = databricks_catalog.data.name
  principal  = var.deployer_principal
  privileges = ["USE_CATALOG", "CREATE_SCHEMA", "MANAGE"]
}

data "databricks_current_metastore" "deployer" {
  count = var.deployer_principal != null && var.grant_create_catalog ? 1 : 0
}

resource "databricks_grant" "deployer_metastore" {
  count = var.deployer_principal != null && var.grant_create_catalog ? 1 : 0

  metastore  = data.databricks_current_metastore.deployer[0].id
  principal  = var.deployer_principal
  privileges = ["CREATE_CATALOG"]
}
