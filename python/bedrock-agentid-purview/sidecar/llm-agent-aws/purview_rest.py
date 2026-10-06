"""
purview_rest.py — Microsoft Purview over plain Microsoft Graph REST.

No Purview SDK, no Agent Framework, no azure-identity. Uses only `requests`
(already in llm-agent-aws/requirements.txt) and the Python standard library.

Token
-----
Every function takes the delegated Agent Identity token (TR) that the Entra
sidecar returns from /AuthorizationHeader/graph:
    aud   = https://graph.microsoft.com
    idtyp = user
    scp   = ... ProtectionScopes.Compute.User Content.Process.User
              SensitivityLabel.Read SensitivityLabel.Evaluate Files.Read.All Sites.Read.All
The token may be passed with or without the leading "Bearer ".

Graph APIs used
---------------
DLP (Purview Developer Platform)
  POST /me/dataSecurityAndGovernance/protectionScopes/compute      (v1.0)
  POST /me/dataSecurityAndGovernance/processContent                (beta)
Sensitivity labels
  GET  /security/dataSecurityAndGovernance/sensitivityLabels        (v1.0)
  POST /sites/{site-id}/drive/root:/{path}:/extractSensitivityLabels   (v1.0)  (or /me/drive/...)
  GET  /security/dataSecurityAndGovernance/sensitivityLabels/computeInheritance(...)  (v1.0)
Files (SharePoint site document library, or OneDrive)
  GET  /sites/{hostname}:/sites/{site}                              (v1.0)  resolve site
  GET  /sites/{site-id}/drive/root:/{path}                          (v1.0)  (or /me/drive/...)
"""

import io
import json
import uuid
import zipfile
import urllib.parse
import xml.etree.ElementTree as ET
from datetime import datetime, timezone

import requests

GRAPH_BETA = "https://graph.microsoft.com/beta"
GRAPH_V1 = "https://graph.microsoft.com/v1.0"
_W = "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}"


class PurviewError(Exception):
    """Raised when Graph returns an error. Carries the Client-Request-Id for support."""

    def __init__(self, message, request_id=None, status=None, body=None):
        super().__init__(message)
        self.request_id = request_id
        self.status = status
        self.body = body


# ---------------------------------------------------------------------------
# Low-level helper
# ---------------------------------------------------------------------------
def _bearer(token: str) -> str:
    return token if token.startswith("Bearer ") else f"Bearer {token}"


def _graph(method: str, url: str, token: str, body=None, headers=None, timeout=25):
    """Call Graph. Returns (status_code, json_or_{}, etag, client_request_id)."""
    rid = str(uuid.uuid4())
    h = {"Authorization": _bearer(token), "Client-Request-Id": rid}
    if headers:
        h.update(headers)
    data = None
    if body is not None:
        h["Content-Type"] = "application/json"
        data = json.dumps(body)
    r = requests.request(method, url, headers=h, data=data, timeout=timeout)
    if r.status_code >= 400:
        raise PurviewError(
            f"Graph {method} {url.split('?')[0]} -> HTTP {r.status_code}: {r.text[:400]}",
            request_id=rid, status=r.status_code, body=r.text[:400],
        )
    payload = {}
    if r.content and "json" in r.headers.get("Content-Type", ""):
        payload = r.json()
    return r.status_code, payload, r.headers.get("ETag"), rid


def app_location(app_id: str) -> dict:
    """policyLocationApplication — the Entra app the DLP policy is scoped to."""
    return {"@odata.type": "microsoft.graph.policyLocationApplication", "value": app_id}


# ---------------------------------------------------------------------------
# DLP — protection scopes + process content
# ---------------------------------------------------------------------------
def compute_scopes(token: str, location_app_id: str, app_name: str) -> dict:
    """Ask Purview which activities need evaluation for this user + this app.

    Returns {"activities": set(...), "etag": str|None, "raw": [...], "request_id": str}
    An empty `activities` set means no policy currently targets this app/user.
    """
    body = {
        "activities": "uploadText,downloadText",
        "locations": [app_location(location_app_id)],
        "integratedAppMetadata": {"name": app_name, "version": "1.0"},
    }
    _, resp, etag, rid = _graph(
        "POST", f"{GRAPH_V1}/me/dataSecurityAndGovernance/protectionScopes/compute", token, body
    )
    activities = set()
    for scope in resp.get("value", []):
        for a in str(scope.get("activities", "")).split(","):
            if a.strip():
                activities.add(a.strip())
    return {"activities": activities, "etag": etag, "raw": resp.get("value", []), "request_id": rid}


def process_content(token: str, text: str, activity: str, *, location_app_id: str, app_name: str,
                    conversation_id: str, sequence: int, etag: str = None,
                    agent: dict = None, ip: str = None, accessed_resources: list = None) -> dict:
    """Evaluate one piece of text against the user's Purview DLP policies.

    activity: "uploadText" for the user's prompt, "downloadText" for the model's response.
    agent:    optional {"identifier": <agent identity id>, "blueprintId": <blueprint app id>,
              "name": ..., "version": ...} — attributes the interaction to the Entra Agent ID.

    Returns {"blocked": bool, "actions": [...], "scope_changed": bool, "status": int,
             "request_id": str, "processing_errors": [...]}
    """
    now = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    entry = {
        "@odata.type": "microsoft.graph.processConversationMetadata",
        "identifier": str(uuid.uuid4()),
        "content": {"@odata.type": "microsoft.graph.textContent", "data": text},
        "name": f"{app_name} {'prompt' if activity == 'uploadText' else 'response'}",
        "correlationId": conversation_id,   # same id for prompt + response = one conversation
        "sequenceNumber": sequence,
        "isTruncated": False,
        "createdDateTime": now,
        "modifiedDateTime": now,
    }
    if agent:
        entry["agents"] = [{"@odata.type": "microsoft.graph.aiAgentInfo", **agent}]
    if accessed_resources:
        entry["accessedResources_v2"] = accessed_resources

    body = {"contentToProcess": {
        "contentEntries": [entry],
        "activityMetadata": {"activity": activity},
        "deviceMetadata": {
            "ipAddress": ip,
            "operatingSystemSpecifications": {
                "operatingSystemPlatform": "Linux",
                "operatingSystemVersion": "Container",
            },
        },
        "protectedAppMetadata": {
            "name": app_name, "version": "1.0",
            "applicationLocation": app_location(location_app_id),
        },
        "integratedAppMetadata": {"name": app_name, "version": "1.0"},
    }}
    headers = {"If-None-Match": etag} if etag else None
    status, resp, _, rid = _graph(
        "POST", f"{GRAPH_BETA}/me/dataSecurityAndGovernance/processContent", token, body, headers
    )
    actions = resp.get("policyActions", []) if status == 200 else []   # 202/204 => nothing inline
    return {
        "blocked": is_block(actions),
        "actions": actions,
        "scope_changed": resp.get("protectionScopeState") == "modified",
        "status": status,
        "request_id": rid,
        "processing_errors": resp.get("processingErrors", []),
    }


def is_block(actions: list) -> bool:
    return any(
        a.get("action") == "restrictAccess" and a.get("restrictionAction") == "block"
        for a in actions or []
    )


# ---------------------------------------------------------------------------
# Sensitivity labels
# ---------------------------------------------------------------------------
def list_labels(token: str) -> dict:
    """Label catalogue: id -> {name, color, priority}. Sub-labels flattened as 'Parent / Child'."""
    _, resp, _, _ = _graph("GET", f"{GRAPH_V1}/security/dataSecurityAndGovernance/sensitivityLabels", token)
    out = {}
    for lbl in resp.get("value", []):
        out[lbl["id"]] = {"name": lbl.get("name"), "color": lbl.get("color"), "priority": lbl.get("priority")}
        for sub in lbl.get("sublabels") or []:
            out[sub["id"]] = {
                "name": f"{lbl.get('name')} / {sub.get('name')}",
                "color": sub.get("color") or lbl.get("color"),
                "priority": sub.get("priority"),
            }
    return out


def resolve_site_drive(token: str, site_url: str) -> dict:
    """Resolve a SharePoint site URL (https://contoso.sharepoint.com/sites/PurviewDemo) to its
    default document library. Returns {"site_id", "site_name", "web_url", "drive_base"} where
    drive_base is the Graph path prefix to use, e.g. "/sites/{site-id}/drive".
    Needs Sites.Read.All (delegated) — the user must have access to the site."""
    u = urllib.parse.urlparse(site_url)
    _, site, _, _ = _graph("GET", f"{GRAPH_V1}/sites/{u.netloc}:{u.path.rstrip('/')}", token)
    return {"site_id": site["id"], "site_name": site.get("displayName"), "web_url": site.get("webUrl"),
            "drive_base": f"/sites/{site['id']}/drive"}


def get_drive_item(token: str, path: str, drive_base: str = "/me/drive") -> dict:
    """driveItem metadata (incl. download URL). drive_base: "/me/drive" (OneDrive) or
    "/sites/{site-id}/drive" (a SharePoint site's default document library)."""
    _, item, _, _ = _graph("GET", f"{GRAPH_V1}{drive_base}/root:/{urllib.parse.quote(path)}", token)
    return item


def extract_file_labels(token: str, path: str, drive_base: str = "/me/drive") -> list:
    """Sensitivity label ids applied to a file (Office / PDF only). Prefer extract_file_label_info()."""
    return extract_file_label_info(token, path, drive_base)["ids"]


def extract_file_label_info(token: str, path: str, drive_base: str = "/me/drive") -> dict:
    """Sensitivity label(s) on a file: {"ids": [...], "names": {id: display name}, "source": "..."}.

    1. POST .../extractSensitivityLabels  (reads the label from the file content)
    2. Fallback: the SharePoint list-item columns _IpLabelId / _DisplayName — SharePoint records the
       label as metadata even when the file is encrypted and extraction returns nothing.
    """
    ids, names, source = [], {}, "extractSensitivityLabels"
    try:
        _, resp, _, _ = _graph(
            "POST", f"{GRAPH_V1}{drive_base}/root:/{urllib.parse.quote(path)}:/extractSensitivityLabels", token, body={}
        )
        ids = [l["sensitivityLabelId"].lower() for l in resp.get("value", {}).get("labels", [])]
    except PurviewError as e:
        if e.status not in (400, 423):     # 423 = file locked/encrypted for extraction
            raise
    if not ids:
        _, item, _, _ = _graph(
            "GET",
            f"{GRAPH_V1}{drive_base}/root:/{urllib.parse.quote(path)}:/listItem"
            "?$expand=fields($select=_DisplayName,_IpLabelId,_IpLabelAssignmentMethod)",
            token,
        )
        f = item.get("fields", {}) or {}
        if f.get("_IpLabelId"):
            ids = [f["_IpLabelId"].lower()]
            if f.get("_DisplayName"):
                names[ids[0]] = f["_DisplayName"].replace("\\", " / ")
            source = "SharePoint list-item metadata (_IpLabelId / _DisplayName)"
    return {"ids": ids, "names": names, "source": source}


def compute_inheritance(token: str, label_ids: list) -> dict:
    """The single label an AI output should carry, given the labels of its inputs."""
    ids = ",".join(json.dumps(i) for i in label_ids)
    fn = f"(labelIds=[{ids}],locale='en-US',contentFormats=[\"File\"])"
    url = (f"{GRAPH_V1}/security/dataSecurityAndGovernance/sensitivityLabels/computeInheritance"
           + urllib.parse.quote(fn, safe="(),=[]':"))
    _, resp, _, _ = _graph("GET", url, token)
    return resp


def docx_text(download_url: str, max_chars: int = 6000) -> str:
    """Plain text of a .docx (zip + xml; no python-docx). Raises ValueError if encrypted."""
    r = requests.get(download_url, timeout=30)      # pre-authenticated URL — no bearer needed
    r.raise_for_status()
    try:
        with zipfile.ZipFile(io.BytesIO(r.content)) as z:
            root = ET.fromstring(z.read("word/document.xml"))
    except (zipfile.BadZipFile, KeyError):
        raise ValueError("file content is encrypted or not a readable .docx")
    paragraphs = ("".join(t.text or "" for t in p.iter(_W + "t")) for p in root.iter(_W + "p"))
    text = "\n".join(p for p in paragraphs if p.strip())
    return text[:max_chars]
