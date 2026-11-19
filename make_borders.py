"""make_borders.py - one-off: simplified boundary files for the map (not part of the data pipeline).

    python make_borders.py

Reads the Natural Earth 10 m files that data.py already downloads (data/boundaries/*.geojson)
and writes small files the browser can load:
    data/borders/countries.json          all countries, simplified      (id = ADM0_A3)
    data/borders/admin1/<ISO>.json       states/provinces of one country (id = "ISO|state name")

Ids are built the same way as join.py / regions.json, so the map can highlight the selected region.
The 10 m originals are 13 MB and 41 MB: far too big to load in a browser, hence this script.
Run it once; build_data.py never touches these files.
"""
import json
import sys
from pathlib import Path

import geopandas as gpd
import numpy as np
import shapely

HERE = Path(__file__).parent
SRC = Path(sys.argv[1]) if len(sys.argv) > 1 else HERE / "data" / "boundaries"
OUT = HERE / "data" / "borders"
TOL = 0.02          # degrees (~2 km): keeps coastlines recognisable, drops tiny detail
DECIMALS = 2        # ~1 km coordinate precision


def clean(gdf):
    gdf = gdf.copy()
    gdf["geometry"] = gdf.geometry.make_valid().simplify(TOL, preserve_topology=True)
    gdf = gdf[~gdf.geometry.is_empty & gdf.geometry.notna()]
    gdf["geometry"] = gdf.geometry.apply(
        lambda g: shapely.transform(g, lambda c: np.round(c, DECIMALS)))
    return gdf


def write(gdf, path):
    feats = [{"type": "Feature", "properties": {"id": i}, "geometry": shapely.geometry.mapping(g)}
             for i, g in zip(gdf["id"], gdf.geometry)]
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps({"type": "FeatureCollection", "features": feats},
                               separators=(",", ":")), encoding="utf-8")
    return path.stat().st_size


a0 = gpd.read_file(SRC / "admin0.geojson", columns=["ADM0_A3"], engine="pyogrio")
a0 = a0.rename(columns={"ADM0_A3": "id"})
n0 = write(clean(a0), OUT / "countries.json")
print(f"countries.json  {n0 / 1024:8.0f} KB")

a1 = gpd.read_file(SRC / "admin1.geojson", columns=["name", "name_en", "adm0_a3"], engine="pyogrio")
# same fallbacks as join.py: name -> name_en -> "Unknown"
a1["state"] = a1["name"].fillna(a1["name_en"]).fillna("Unknown")
a1["id"] = a1["adm0_a3"] + "|" + a1["state"]
a1 = clean(a1)
total = 0
for iso, g in a1.groupby("adm0_a3"):
    total += write(g, OUT / "admin1" / f"{iso}.json")
print(f"admin1/*.json   {total / 1024:8.0f} KB in {a1['adm0_a3'].nunique()} files "
      f"(largest {max(p.stat().st_size for p in (OUT / 'admin1').glob('*.json')) / 1024:.0f} KB)")
