# Third-party agent connection and observability

This sample demonstrates one Agent 365 workflow shared by a browser UI and the
Agent 365 CLI:

1. Create a third-party provider connection.
2. Discover every provider agent across paged results.
3. Bulk import agents into Agent 365 Registry with stable observability IDs.
4. Synchronize provider telemetry to Maven observability.

The included AWS adapter is deterministic so the full workflow runs without a
cloud account. It uses the production-shaped contracts from
`microsoft-agents-a365-runtime`; replace the demo adapters with authenticated
Connect, Registry, AWS, and Maven HTTP adapters for deployment.

## Run

From this directory, install the matching local runtime branch and the sample:

```powershell
python -m venv .venv
.\.venv\Scripts\Activate.ps1
$env:PYTHONPATH = "$(Resolve-Path ..\..\..\Agent365-python\libraries\microsoft-agents-a365-runtime);$PWD"
pip install fastapi httpx "uvicorn[standard]" pytest pytest-asyncio PyJWT
uvicorn third_party_connect_sample.app:app --reload --port 8000
```

Open `http://localhost:8000`. The UI and `a365 3p connect` both call
`POST /api/3p/connections`.

## Test

```powershell
pytest -q
```

No credentials are stored by this demo. Production connection secrets belong
in the existing Agent 365 connection service and should be referenced by
connection ID.