"""join.py - EmberWatch steps 2-3.

add_region(df)  -> df + country, iso_a3, state  (spatial join, cached to parquet)
aggregate(df)   -> fire count + total FRP per region per day

Rule from Session 1: no string "+" on DataFrame columns (pandas 3 / pyarrow).
"""
import time
import warnings

import geopandas as gpd
import pandas as pd

from data import DATA_DIR, ensure_boundaries

UNASSIGNED = "Unassigned"


# --- 1. boundaries ----------------------------------------------------------
def _fix(gdf):
    """Repair invalid geometries (Session 1 found 1 in each file)."""
    bad = ~gdf.is_valid
    if bad.any():
        gdf.loc[bad, "geometry"] = gdf.loc[bad, "geometry"].make_valid()
        print(f"make_valid: repaired {int(bad.sum())} geometry(ies)")
    return gdf


def _load_boundaries():
    """Returns (admin0, admin1) with the same lowercase, short column names."""
    p = ensure_boundaries()
    # Column case differs between the files (see HANDOFF): Admin 0 UPPER, Admin 1 lower.
    a0 = gpd.read_file(p["admin0"], columns=["ADMIN", "ADM0_A3"], engine="pyogrio")
    a1 = gpd.read_file(p["admin1"], columns=["name", "name_en", "adm0_a3", "admin"],
                       engine="pyogrio")
    a0.columns = a0.columns.str.lower()
    a1.columns = a1.columns.str.lower()
    a0 = a0.rename(columns={"admin": "country", "adm0_a3": "iso_a3"})
    # Admin 1 has 7 null names: fall back to name_en, then "Unknown".
    a1["state"] = a1["name"].fillna(a1["name_en"]).fillna("Unknown")
    a1 = a1.rename(columns={"adm0_a3": "iso_fb", "admin": "country_fb"})
    a1 = a1[["state", "iso_fb", "country_fb", "geometry"]]
    return _fix(a0), _fix(a1)


# --- 2. the spatial join ----------------------------------------------------
def _within(pts, polys, snap_deg=0):
    """For each point, copy the attributes of the polygon that contains it.

    Unmatched points get NaN. Optionally snap them to the nearest polygon
    within snap_deg degrees (~111 km per degree; 0.05 is ~5 km).
    """
    cols = [c for c in polys.columns if c != "geometry"]
    j = gpd.sjoin(pts, polys, how="left", predicate="within")
    # A point inside overlapping polygons would be returned twice: keep the first.
    j = j[~j.index.duplicated(keep="first")]
    if snap_deg:
        miss = j.index[j[cols[0]].isna()]
        if len(miss):
            with warnings.catch_warnings():
                warnings.simplefilter("ignore")  # "distance in geographic CRS" warning
                near = gpd.sjoin_nearest(pts.loc[miss], polys, how="inner",
                                         max_distance=snap_deg)
            near = near[~near.index.duplicated(keep="first")]
            j.loc[near.index, cols] = near[cols]
    return j[cols]


def add_region(df, snap_deg=0, use_cache=True):
    """Add country, iso_a3, state to the fire table. Unmatched -> 'Unassigned'."""
    cache = DATA_DIR / f"fires_joined_snap{snap_deg}.parquet"
    if use_cache and cache.exists():
        c = pd.read_parquet(cache)
        # Same rows as the input? (a fresh FIRMS download changes these)
        if len(c) == len(df) and c["acq_dt"].max() == df["acq_dt"].max():
            print(f"loaded joined data from cache ({cache.name})")
            return c

    t0 = time.time()
    a0, a1 = _load_boundaries()
    pts = gpd.GeoDataFrame(geometry=gpd.points_from_xy(df["longitude"], df["latitude"]),
                           index=df.index, crs="EPSG:4326")
    c0 = _within(pts, a0, snap_deg)   # country, iso_a3
    c1 = _within(pts, a1, snap_deg)   # state, iso_fb, country_fb

    out = df.copy()
    # Country from Admin 0; if Admin 0 missed but Admin 1 hit, borrow Admin 1's country.
    out["country"] = c0["country"].fillna(c1["country_fb"]).fillna(UNASSIGNED)
    out["iso_a3"] = c0["iso_a3"].fillna(c1["iso_fb"]).fillna(UNASSIGNED)
    out["state"] = c1["state"].fillna(UNASSIGNED)

    secs = time.time() - t0
    n = len(out)
    print(f"join runtime: {secs:.0f}s for {n:,} points")
    print(f"country Unassigned: {(out['country'] == UNASSIGNED).sum():,} "
          f"({100 * (out['country'] == UNASSIGNED).mean():.2f}%)")
    print(f"state   Unassigned: {(out['state'] == UNASSIGNED).sum():,} "
          f"({100 * (out['state'] == UNASSIGNED).mean():.2f}%)")
    cache.parent.mkdir(parents=True, exist_ok=True)
    out.to_parquet(cache, index=False)
    return out


# --- 3. aggregation ---------------------------------------------------------
def aggregate(df, level="state"):
    """Fire count and total FRP (MW) per region per UTC day.

    level='state'   -> one row per (country, state, day)
    level='country' -> one row per (country, day)
    Counts are detections, not unique fires (two satellites, see HANDOFF).
    """
    keys = ["iso_a3", "country", "acq_date"]
    if level == "state":
        keys = ["iso_a3", "country", "state", "acq_date"]
    g = df.groupby(keys, as_index=False).agg(
        fires=("frp", "size"), frp_sum=("frp", "sum"))
    g["frp_sum"] = g["frp_sum"].round(1)
    return g


if __name__ == "__main__":
    from data import load_fires

    d = add_region(load_fires())
    print(aggregate(d, "country").groupby("country").frp_sum.sum().nlargest(5))
    print(d[d.iso_a3 == "IND"].groupby("state").frp.sum().round(0).nlargest(10))
