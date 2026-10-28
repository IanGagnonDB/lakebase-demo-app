"""Small SELECT-only probes. Both warehouse and Lakebase compute may wake."""
import time
from contextlib import contextmanager

import psycopg
from psycopg.rows import dict_row


class ReadFailure(Exception):
    def __init__(self, status, detail):
        self.status, self.detail = status, detail
        super().__init__(detail)


class Reads:
    def __init__(self, workspace, settings):
        self.w, self.s = workspace, settings

    @contextmanager
    def postgres(self):
        endpoint = self.w.postgres.get_endpoint(name=self.s['LAKEBASE_ENDPOINT'])
        # Existing application credentials in deployment; current user only for local verification.
        user = self.s.get('PGUSER') or self.w.current_user.me().user_name
        token = self.w.postgres.generate_database_credential(endpoint=endpoint.name).token
        try:
            with psycopg.connect(host=endpoint.status.hosts.host, dbname=self.s['PGDATABASE'],
                                  user=user, password=token, sslmode='require', connect_timeout=5,
                                  options='-c default_transaction_read_only=on -c statement_timeout=5000',
                                  row_factory=dict_row) as conn:
                yield conn
        except (psycopg.errors.UndefinedTable, psycopg.errors.InvalidSchemaName) as exc:
            raise ReadFailure('not_ready', 'A required PostgreSQL table or schema is missing.') from exc
        except psycopg.errors.InsufficientPrivilege as exc:
            raise ReadFailure('unable_to_verify', 'The app identity cannot SELECT the required PostgreSQL data.') from exc

    def pg(self, query):
        with self.postgres() as conn:
            return conn.execute(query).fetchall()

    def sql(self, query):
        deadline = time.monotonic() + 9
        response = self.w.statement_execution.execute_statement(
            statement=query, warehouse_id=self.s['DATABRICKS_WAREHOUSE_ID'], wait_timeout='0s',
            row_limit=1, byte_limit=8192)
        while getattr(response.status.state, 'value', response.status.state) in {'PENDING', 'RUNNING'}:
            if time.monotonic() >= deadline:
                raise TimeoutError('Read-only warehouse probe is still starting or running')
            time.sleep(.25)
            response = self.w.statement_execution.get_statement(response.statement_id)
        if getattr(response.status.state, 'value', response.status.state) != 'SUCCEEDED':
            error = response.status.error
            code = getattr(getattr(error, 'error_code', None), 'value', getattr(error, 'error_code', None))
            # Do not classify arbitrary SQL failures as missing resources.
            if code in {'TABLE_OR_VIEW_NOT_FOUND', 'SCHEMA_NOT_FOUND'}:
                raise ReadFailure('not_ready', 'A required SQL table or schema is missing.')
            raise ReadFailure('unable_to_verify', 'The read-only SQL probe failed; verify warehouse and table SELECT access.')
        if not response.result or not response.result.data_array:
            return []
        columns = response.manifest.schema.columns
        return [dict(zip([c.name for c in columns], row)) for row in response.result.data_array]
