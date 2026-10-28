"""Lakebase Demo App — FastAPI entry point (`uvicorn main:app`)."""
import threading
from pathlib import Path

import features
import demo_reset
import h2h
import provision
import readiness
import sync_demo
from db import S, w
from project_link import project_uid, project_url
from fastapi import FastAPI, HTTPException
from fastapi.encoders import jsonable_encoder
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles

app = FastAPI(title="Lakebase Demo App", default_response_class=JSONResponse)
app.include_router(h2h.router)
app.include_router(features.router)
app.include_router(sync_demo.router)
app.include_router(demo_reset.router)


@app.middleware("http")
async def reset_gate(request, call_next):
    if not request.url.path.startswith("/api/") or request.url.path in {"/api/demo/reset", "/api/meta", "/api/readiness"}:
        return await call_next(request)
    try:
        with demo_reset.request_access():
            return await call_next(request)
    except HTTPException as exc:
        return JSONResponse(status_code=exc.status_code, content={"detail": exc.detail})


WORKSPACE_URL = w.config.host.rstrip("/")
WORKSPACE_ID = w.get_workspace_id()
DOCS = ("https://learn.microsoft.com/en-us/azure/databricks/oltp/projects"
        if w.config.is_azure else "https://docs.databricks.com/aws/en/oltp/projects")


@app.on_event("startup")
def startup():
    threading.Thread(target=provision.run, daemon=True).start()  # serve /api/meta while provisioning runs


@app.get("/api/meta")
def meta():
    o, c, b = f"?o={WORKSPACE_ID}", S["CATALOG"], S["BRONZE_SCHEMA"]
    uid = project_uid(w, S["LAKEBASE_PROJECT"])
    return jsonable_encoder({
        "workspace_url": WORKSPACE_URL, "workspace_id": WORKSPACE_ID, "lakebase_project_uid": uid, "provisioning": provision.STATUS,
        "links": {
            "bronze_history": f"{WORKSPACE_URL}/explore/data/{c}/{b}/lb_activities_history{o}",
            "synced_targets": f"{WORKSPACE_URL}/explore/data/{S['LAKEBASE_CATALOG']}/ref/targets{o}",
            "delta_targets": f"{WORKSPACE_URL}/explore/data/{c}/{S['SCHEMA']}/targets{o}",
            "sql_editor": f"{WORKSPACE_URL}/sql/editor{o}",
            "warehouse": f"{WORKSPACE_URL}/sql/warehouses/{S['DATABRICKS_WAREHOUSE_ID']}{o}",
            "lakebase_project": project_url(WORKSPACE_URL, uid),
            "docs_synced_tables": f"{DOCS}/sync-tables", "docs_cdf": f"{DOCS}/lakebase-cdf",
            "docs_branches": f"{DOCS}/branches", "docs_pitr": f"{DOCS}/point-in-time-restore",
            "docs_scale_to_zero": f"{DOCS}/scale-to-zero", "docs_autoscaling": f"{DOCS}/autoscaling",
            "docs_ha": f"{DOCS}/manage-high-availability", "docs_data_api": f"{DOCS}/data-api",
        },
    })


@app.get("/api/readiness")
def readiness_status():
    return readiness.service.get(readiness.checks(w, S))


app.mount("/", StaticFiles(directory=Path(__file__).parent / "static", html=True), name="static")
