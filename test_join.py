"""Offline test for join.py: tiny synthetic world, no downloads."""
import sys
from pathlib import Path

import geopandas as gpd
import pandas as pd
from shapely.geometry import box

sys.path.insert(0, str(Path(__file__).parent.parent))
import join  # noqa: E402


def fake_boundaries():
    # Country AAA = x 0..10, BBB = x 10..20 (BBB has NO admin1 rows, like the 7 gaps).
    a0 = gpd.GeoDataFrame(
        {"country": ["Aland", "Bland"], "iso_a3": ["AAA", "BBB"]},
        geometry=[box(0, 0, 10, 10), box(10, 0, 20, 10)], crs="EPSG:4326")
    a1 = gpd.GeoDataFrame(
        {"state": ["A-west", "A-east"], "iso_fb": ["AAA", "AAA"],
         "country_fb": ["Aland", "Aland"]},
        geometry=[box(0, 0, 5, 10), box(5, 0, 10, 10)], crs="EPSG:4326")
    return a0, a1


def fires():
    pts = [(2, 5, 10.0), (7, 5, 20.0), (7, 6, 30.0), (15, 5, 5.0),   # A-west, A-east x2, Bland
           (-5, 5, 1.0),       # open ocean
           (-0.02, 5, 2.0)]    # just offshore (coast mismatch)
    df = pd.DataFrame(pts, columns=["longitude", "latitude", "frp"])
    df["acq_date"] = ["2026-11-10", "2026-11-10", "2026-11-11", "2026-11-11",
                      "2026-11-11", "2026-11-11"]
    df["acq_dt"] = pd.to_datetime(df["acq_date"], utc=True)
    return df


def run(tmp, snap):
    join.DATA_DIR = tmp
    join._load_boundaries = fake_boundaries
    return join.add_region(fires(), snap_deg=snap)


def test_all(tmp_path):
    # default: ocean + offshore are Unassigned
    d = run(tmp_path, 0)
    assert list(d["state"]) == ["A-west", "A-east", "A-east", "Unassigned",
                                "Unassigned", "Unassigned"]
    assert list(d["country"]) == ["Aland", "Aland", "Aland", "Bland",
                                  "Unassigned", "Unassigned"]
    # Bland has no admin1 -> country assigned, state Unassigned
    # snap 0.05 deg rescues the offshore point but not open ocean
    s = run(tmp_path, 0.05)
    assert s.loc[5, "state"] == "A-west" and s.loc[5, "country"] == "Aland"
    assert s.loc[4, "country"] == "Unassigned"
    # cache: second call must not call the boundary loader
    join._load_boundaries = lambda: (_ for _ in ()).throw(AssertionError("not cached"))
    c = join.add_region(fires(), snap_deg=0.05)
    assert len(c) == 6
    # aggregate
    g = join.aggregate(s, "state")
    row = g[(g.state == "A-east") & (g.acq_date == "2026-11-11")].iloc[0]
    assert row.fires == 1 and row.frp_sum == 30.0
    row = g[(g.state == "A-west") & (g.acq_date == "2026-11-10")].iloc[0]
    assert row.fires == 1 and row.frp_sum == 10.0
    assert g.fires.sum() == 6
    k = join.aggregate(s, "country")
    assert k.fires.sum() == 6


if __name__ == "__main__":
    import tempfile
    test_all(Path(tempfile.mkdtemp()))
    print("PASS")
