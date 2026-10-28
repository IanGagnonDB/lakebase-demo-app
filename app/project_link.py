"""Resolve console project identities once per app process."""
import logging
from functools import cache

log = logging.getLogger(__name__)


@cache
def project_uid(client, project: str) -> str | None:
    """Console routes use the immutable UID, not the API resource name."""
    try:
        uid = client.postgres.get_project(name=f"projects/{project}").uid
        if not uid:
            raise ValueError("Lakebase project response has no UID")
        return uid
    except Exception:
        log.exception("Unable to resolve Lakebase project UID; linking to projects list")
        return None


def project_url(host: str, uid: str | None) -> str:
    return f"{host.rstrip('/')}/lakebase/projects" + (f"/{uid}" if uid else "")
