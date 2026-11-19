"""Offline tests for the decision layer + build_data.py (tiny fake world, no downloads)."""
import json
import sys
import tempfile
from pathlib import Path

import numpy as np
import pandas as pd

HERE = Path(__file__).parent
sys.path.insert(0, str(HERE.parent))
sys.path.insert(0, str(HERE))
import build_data  # noqa: E402
import data  # noqa: E402
import join  # noqa: E402
from test_join import fake_boundaries  # noqa: E402

DATES = [f"2026-11-{d:02d}" for d in range(6, 14)]  # 8 UTC dates, like the real file


def make_fires(first_start_h=6, last_end_h=12):
    """A-west rising, A-east falling, Aland overall flat, Bland tiny, plus open ocean.
    Date 1 starts at first_start_h and the last date ends at last_end_h (partial days)."""
    plan = {  # (lon, lat): counts for the 8 dates
        (2.5, 5): [4, 10, 10, 10, 10, 20, 20, 5],    # A-west: +100%
        (7.5, 5): [8, 20, 20, 20, 20, 10, 10, 5],    # A-east: -50%
        (15, 5): [1, 1, 1, 1, 1, 1, 1, 1],           # Bland: 6 in window -> insufficient
        (-5, 5): [1, 0, 0, 0, 0, 0, 0, 0],           # ocean: Unassigned
    }
    rows = []
    for (lon, lat), counts in plan.items():
        for i, (d, n) in enumerate(zip(DATES, counts)):
            lo = first_start_h if i == 0 else 0
            hi = last_end_h if i == len(DATES) - 1 else 23
            for k in range(n):
                h = lo + (hi - lo) * k / max(n - 1, 1)
                rows.append((lon, lat, 10.0, d, pd.Timestamp(d, tz="UTC")
                             + pd.Timedelta(minutes=int(h * 60))))
    df = pd.DataFrame(rows, columns=["longitude", "latitude", "frp", "acq_date", "acq_dt"])
    df.attrs.update(n_raw=len(df) + 5, n_valid=len(df) + 5, n_kept=len(df),
                    sat_raw={"N20": len(df)})
    return df


def test_day_coverage():
    cov = data.day_coverage(make_fires())
    assert cov["partial"] == [DATES[0], DATES[-1]], cov
    assert cov["complete"] == DATES[1:-1]
    full = data.day_coverage(make_fires(first_start_h=0, last_end_h=23))
    assert full["partial"] == [], full


def test_trend_cases():
    cols = [f"d{i}" for i in range(7)]
    cnt = pd.DataFrame(
        [[10] * 5 + [20, 20],      # +100%
         [20] * 5 + [10, 10],      # -50%
         [10] * 7,                 # 0%
         [0] * 5 + [10, 10],       # nothing before -> Rising, no %
         [2] * 7],                 # 14 detections, small but >= 10 -> Stable
        columns=cols, index=list("abcde"))
    t, recent, prior = data.region_trends(cnt, cnt * 10.0, cols)
    assert recent == cols[-2:] and prior == cols[:5]
    assert list(t["trend_flag"]) == ["Rising", "Falling", "Stable", "Rising", "Stable"]
    assert t.loc["a", "trend_pct"] == 100 and t.loc["b", "trend_pct"] == -50
    assert np.isnan(t.loc["d", "trend_pct"])
    few, _, _ = data.region_trends(cnt.iloc[[2]], cnt.iloc[[2]], cols[:4])  # only 2 prior days
    assert few["trend_flag"].iloc[0] == data.INSUFFICIENT
    small = cnt.iloc[[4]].copy()
    small[:] = 0
    small.iloc[0, 5] = 3
    s, _, _ = data.region_trends(small, small, cols)
    assert s["trend_flag"].iloc[0] == data.INSUFFICIENT      # 3 detections < MIN_DETECTIONS


def test_build_end_to_end():
    fires = make_fires()
    tmp = Path(tempfile.mkdtemp())
    join.DATA_DIR = tmp
    join._load_boundaries = fake_boundaries
    meta, regions, cells, sizes = build_data.build(fires, out_dir=tmp, use_cache=False)
    by = {r["id"]: r for r in regions}
    assert set(by) == {"AAA", "BBB", "AAA|A-west", "AAA|A-east"}   # no Unassigned entries
    assert by["AAA|A-west"]["trend_flag"] == "Rising" and by["AAA|A-west"]["trend_pct"] == 100
    assert by["AAA|A-east"]["trend_flag"] == "Falling" and by["AAA|A-east"]["trend_pct"] == -50
    assert by["AAA"]["trend_flag"] == "Stable" and by["AAA"]["trend_pct"] == 0
    assert by["BBB"]["trend_flag"] == data.INSUFFICIENT and by["BBB"]["trend_pct"] is None
    assert by["AAA"]["rank"] == 1 and by["BBB"]["rank"] == 2 and by["BBB"]["rank_of"] == 2
    assert {by["AAA|A-west"]["rank"], by["AAA|A-east"]["rank"]} == {1, 2}
    assert all(0 <= r["priority_score"] <= 100 for r in regions)
    assert len(by["AAA"]["series"]) == 8 and by["AAA"]["series"][0]["date"] == DATES[0]
    assert by["AAA"]["fire_count"] == by["AAA|A-west"]["fire_count"] + by["AAA|A-east"]["fire_count"]
    text = json.dumps(regions).lower()
    assert "protocol" not in text and "caused by" not in text
    # cells: nothing lost, no raw points
    assert sum(c[2] for c in cells["cells"]) == len(fires)
    assert len(cells["cells"]) < len(fires)
    assert meta["dates"]["partial"] == [DATES[0], DATES[-1]]
    assert meta["rows"]["dropped_low_confidence"] == 5
    assert meta["unassigned"]["country_count"] == 1
    for name in ("meta.json", "regions.json", "cells.json"):   # valid strict JSON
        json.loads((tmp / name).read_text(encoding="utf-8"),
                   parse_constant=lambda c: (_ for _ in ()).throw(ValueError(c)))


if __name__ == "__main__":
    test_day_coverage()
    test_trend_cases()
    test_build_end_to_end()
    print("PASS")
