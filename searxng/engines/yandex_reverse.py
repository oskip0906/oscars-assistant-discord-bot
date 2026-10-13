# SPDX-License-Identifier: AGPL-3.0-or-later
"""Yandex reverse image search: the query is an image URL, the results are the
pages that carry matching images (with those images), and Yandex's best guesses
at what the picture shows come back as suggestions.

Not an upstream SearXNG engine. searxng/Dockerfile and scripts/ensure-searxng.sh
copy it into searx/engines, the only place SearXNG loads engines from. Google
Lens can't stand in: its results page is built by JavaScript, so a plain HTTP
engine gets nothing, while Yandex renders its matches into the page.
"""

import json
import re
from html import unescape
from urllib.parse import urlencode

from searx.result_types import EngineResults

about = {
    "website": "https://yandex.com/images/",
    "wikidata_id": "Q1915523",
    "official_api_documentation": None,
    "use_official_api": False,
    "require_api_key": False,
    "results": "HTML",
}

engine_type = "online_url_search"
categories = ["images"]
paging = False
base_url = "https://yandex.com/images/search"
max_results = 15

# The page's app state, an HTML-escaped JSON attribute; the reverse search's lives in initialState.
STATE = re.compile(r'data-state="([^"]*cbirSites[^"]*)"')


def request(query, params):
    params["url"] = f"{base_url}?{urlencode({'rpt': 'imageview', 'url': params['search_urls']['http']})}"
    return params


def response(resp) -> EngineResults:
    results = EngineResults()
    match = STATE.search(resp.text)
    if not match:
        return results
    state = json.loads(unescape(match.group(1))).get("initialState", {})
    for tag in state.get("cbirTags", {}).get("tags", []):
        if tag.get("text"):
            results.add(results.types.LegacyResult(suggestion=tag["text"]))
    for site in state.get("cbirSites", {}).get("sites", [])[:max_results]:
        image = (site.get("originalImage") or {}).get("url") or ""
        if not site.get("url") or not image:
            continue
        thumb = (site.get("thumb") or {}).get("url") or image
        results.add(
            results.types.Image(
                url=site["url"],
                title=site.get("title") or site.get("domain") or "",
                content=site.get("description") or "",
                img_src=image,
                thumbnail_src=f"https:{thumb}" if thumb.startswith("//") else thumb,
            )
        )
    return results
