"""build_data.py - fetch FIRMS, run the pipeline, write small JSON files for the dashboard.

    python build_data.py            # uses cached CSVs / joined parquet when fresh
    python build_data.py --force    # re-download FIRMS

Writes data/meta.json, data/regions.json, data/cells.json. The frontend only reads these.
Serve it with `python -m http.server` (opening index.html via file:// blocks fetch()).
"""
import argparse
import json
from datetime import datetime, timezone
from pathlib import Path

import numpy as np

import data
import join

GRID_DEG = 0.25

LIMITATIONS = [
    "Not every detection is a wildfire: agricultural burns, gas flares and industrial heat "
    "are also detected. Nothing here states a cause.",
    "Satellite limits: a place is seen only a few times per day, cloud and thick smoke hide "
    "fires, and each pixel is about 375 m wide.",
    "NOAA-20 and NOAA-21 fly about 50 minutes apart, so one fire can appear twice. Counts "
    "are detections, not unique fires.",
    "This is near-real-time (NRT) data, not science-quality data.",
    "The window is only about 7 days. The trend flag is a short-term signal, not a trend.",
    "Priority score weights (0.5 FRP, 0.2 count, 0.3 trend) are a starting choice, not "
    "validated. The score ranks regions against each other; it is not a risk measure.",
    "Total FRP is approximate: neighbouring pixels often share identical FRP values "
    "(cause unconfirmed).",
    "Days are UTC. Late-evening detections in India fall on the next UTC day.",
    "Regions come from Natural Earth 10 m boundaries. Fires on the coast, offshore or on a "
    "border can be left Unassigned.",
    "Suggested checks are prompts for a human to look at, not official protocols.",
]


def _dump(obj, path):
    tmp = path.with_suffix(".tmp")
    with open(tmp, "w", encoding="utf-8") as f:
        # allow_nan=False: a stray NaN would make invalid JSON, so fail loudly instead
        json.dump(obj, f, separators=(",", ":"), ensure_ascii=False, allow_nan=False)
    tmp.replace(path)
    return path.stat().st_size


def grid_cells(df, step=GRID_DEG):
    """Aggregate detections to a step-degree grid, split by region.

    A cell that straddles a border gets one row per (country, state), so filtering the
    map by region stays exact. The cell position is its centre.
    """
    g = (df.assign(clat=np.round(np.floor(df["latitude"] / step) * step + step / 2, 3),
                   clon=np.round(np.floor(df["longitude"] / step) * step + step / 2, 3))
         .groupby(["clat", "clon", "iso_a3", "state"])["frp"]
         .agg(["size", "sum"]).reset_index().sort_values(["clat", "clon"]))
    return g


def build(fires, out_dir=None, snap_deg=0, use_cache=True):
    out_dir = Path(out_dir or data.DATA_DIR)
    out_dir.mkdir(parents=True, exist_ok=True)
    stats = dict(fires.attrs)

    cov = data.day_coverage(fires)
    print(f"dates (UTC): {cov['dates'][0]} -> {cov['dates'][-1]} "
          f"| first detection {cov['first_detection_utc']}, last {cov['last_detection_utc']}")
    for d in cov["dates"][::len(cov["dates"]) - 1 or 1]:
        print(f"  {d}: {'PARTIAL' if d in cov['partial'] else 'complete'}")
    print("partial days excluded from the trend:", cov["partial"] or "none")

    joined = join.add_region(fires, snap_deg=snap_deg, use_cache=use_cache)
    n = len(joined)
    un_c = int((joined["country"] == join.UNASSIGNED).sum())
    un_s = int((joined["state"] == join.UNASSIGNED).sum())

    regions = data.build_regions(join.aggregate(joined, "country"),
                                 join.aggregate(joined, "state"), cov)

    # --- cells.json: compact rows [lat, lon, count, frp, country_idx, state_idx] -------
    g = grid_cells(joined)
    countries = sorted(r["iso_a3"] for r in regions if r["level"] == "country")
    state_ids = sorted(r["id"] for r in regions if r["level"] == "state")
    c_idx = {k: i for i, k in enumerate(countries)}
    s_idx = {k: i for i, k in enumerate(state_ids)}
    ci = [c_idx.get(c, -1) for c in g["iso_a3"]]
    si = [s_idx.get(f"{c}|{s}", -1) for c, s in zip(g["iso_a3"], g["state"])]
    cells = {
        "grid_deg": GRID_DEG,
        "fields": ["lat", "lon", "count", "frp", "country", "state"],
        "note": "country = index into `countries` (region id, -1 = Unassigned); "
                "state = index into `states` (region id 'ISO|name', -1 = Unassigned)",
        "countries": countries,
        "states": state_ids,
        "cells": [list(r) for r in zip(g["clat"].tolist(), g["clon"].tolist(),
                                       g["size"].tolist(), np.round(g["sum"], 1).tolist(),
                                       ci, si)],
    }

    # --- meta.json ---------------------------------------------------------------------
    recent = cov["complete"][-data.TREND_RECENT_DAYS:]
    prior = cov["complete"][-(data.TREND_RECENT_DAYS + data.TREND_PRIOR_DAYS):
                            -data.TREND_RECENT_DAYS]
    meta = {
        "built_utc": datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M"),
        "data_newest_utc": cov["last_detection_utc"],
        "data_oldest_utc": cov["first_detection_utc"],
        "source": "NASA FIRMS VIIRS 375 m near-real-time, NOAA-20 + NOAA-21, 7-day global files",
        "rows": {
            "raw": stats.get("n_raw"),
            "valid": stats.get("n_valid"),
            "kept": stats.get("n_kept", n),
            "dropped_low_confidence": (stats["n_raw"] - stats["n_kept"]
                                       if "n_raw" in stats else None),
            "per_satellite_raw": stats.get("sat_raw"),
        },
        "unassigned": {"country_count": un_c, "country_share_pct": round(100 * un_c / n, 2),
                       "state_count": un_s, "state_share_pct": round(100 * un_s / n, 2)},
        "dates": {"all": cov["dates"], "complete": cov["complete"], "partial": cov["partial"],
                  "trend_recent": recent, "trend_prior": prior},
        "trend": {"threshold_pct": data.TREND_THRESHOLD_PCT,
                  "min_detections": data.MIN_DETECTIONS, "labels":
                  ["Rising", "Stable", "Falling", data.INSUFFICIENT]},
        "score": {"weights": data.WEIGHTS,
                  "tiers": [{"min_score": c, "name": nme} for c, nme in data.TIERS]},
        "counts": {"countries": len(countries), "states": len(state_ids),
                   "cells": len(cells["cells"])},
        "limitations": LIMITATIONS,
    }

    sizes = {"meta.json": _dump(meta, out_dir / "meta.json"),
             "regions.json": _dump(regions, out_dir / "regions.json"),
             "cells.json": _dump(cells, out_dir / "cells.json")}
    print(f"unassigned: country {un_c:,} ({meta['unassigned']['country_share_pct']}%), "
          f"state {un_s:,} ({meta['unassigned']['state_share_pct']}%)")
    for name, b in sizes.items():
        print(f"{name:14s}{b / 1024:10.1f} KB")
    return meta, regions, cells, sizes


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--force", action="store_true", help="re-download FIRMS CSVs")
    args = ap.parse_args()
    _meta, _regions, _cells, _ = build(data.load_fires(force=args.force))
    top = next((r for r in _regions if r["level"] == "state" and r["iso_a3"] == "IND"), None)
    print("\nexample region:", json.dumps(top, ensure_ascii=False))
    print("example cell row:", _cells["fields"], _cells["cells"][len(_cells["cells"]) // 2])
    print("top 10 states in India by FRP:")
    ind = sorted((r for r in _regions if r["level"] == "state" and r["iso_a3"] == "IND"),
                 key=lambda r: -r["total_frp"])[:10]
    for r in ind:
        print(f'  {r["state"]:<22}{r["total_frp"]:>10,.0f} MW  {r["trend_flag"]:<17}'
              f'{r["priority_score"]:>5.1f}  #{r["rank"]}')
