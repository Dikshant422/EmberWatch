"""data.py - EmberWatch data layer (step 1).

load_fires()        -> cleaned VIIRS 7-day detections as a DataFrame
ensure_boundaries() -> downloads Natural Earth Admin 0 / Admin 1 (for step 2)

NOTE: Suomi-NPP stopped delivering data on 2026-11-02 (its 7-day file is header-only),
so we use NOAA-20 + NOAA-21 VIIRS 375 m instead. Same columns, `satellite` = N20 / N21.
"""
import time
from pathlib import Path

import numpy as np
import pandas as pd
import requests

DATA_DIR = Path(__file__).parent / "data"

# --- NASA FIRMS keyless 7-day global CSVs, VIIRS 375 m ----------------------
_FIRMS = "https://firms.modaps.eosdis.nasa.gov/data/active_fire/"
SOURCES = {
    "noaa20": _FIRMS + "noaa-20-viirs-c2/csv/J1_VIIRS_C2_Global_7d.csv",
    "noaa21": _FIRMS + "noaa-21-viirs-c2/csv/J2_VIIRS_C2_Global_7d.csv",
}
KEEP = {"nominal", "high"}  # 'low' is dropped
MIN_BYTES = 1_000_000       # anything smaller is not a real global 7-day file
EXPECTED_COLS = ["latitude", "longitude", "bright_ti4", "scan", "track",
                 "acq_date", "acq_time", "satellite", "confidence", "version",
                 "bright_ti5", "frp", "daynight"]

# --- Natural Earth, 10 m, GeoJSON mirror on GitHub -------------------------
_NE = "https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/"
BOUNDARIES = {
    "admin0": ("ne_10m_admin_0_countries.geojson", DATA_DIR / "boundaries" / "admin0.geojson"),
    "admin1": ("ne_10m_admin_1_states_provinces.geojson", DATA_DIR / "boundaries" / "admin1.geojson"),
}


def _download(url, dest, timeout=300):
    """Stream to a .part file, then rename, so a failed download never leaves a corrupt cache."""
    dest.parent.mkdir(parents=True, exist_ok=True)
    tmp = dest.with_suffix(dest.suffix + ".part")
    with requests.get(url, stream=True, timeout=timeout) as r:
        r.raise_for_status()
        with open(tmp, "wb") as f:
            for chunk in r.iter_content(1 << 20):
                f.write(chunk)
    tmp.replace(dest)
    return dest


def download_firms(force=False, max_age_h=6):
    """Fetch each FIRMS CSV (cached locally). Returns {name: Path} for the good ones."""
    paths = {}
    for name, url in SOURCES.items():
        dest = DATA_DIR / f"viirs_{name}_7d.csv"
        fresh = (dest.exists() and dest.stat().st_size > MIN_BYTES
                 and time.time() - dest.stat().st_mtime < max_age_h * 3600)
        if force or not fresh:
            _download(url, dest, timeout=120)
            size = dest.stat().st_size
            if size < MIN_BYTES:
                head = dest.read_text(errors="replace")[:200]
                dest.unlink()
                print(f"WARNING: {name} download too small ({size} bytes), skipped. "
                      f"Start: {head!r}")
                continue
        paths[name] = dest
    if not paths:
        raise RuntimeError("No FIRMS source returned data. Check "
                           "https://firms.modaps.eosdis.nasa.gov/active_fire/ ")
    return paths


def ensure_boundaries():
    """Download Admin 0 / Admin 1 once. Returns {'admin0': Path, 'admin1': Path}."""
    out = {}
    for key, (fname, dest) in BOUNDARIES.items():
        if not dest.exists():
            print(f"downloading {fname} ...")
            _download(_NE + fname, dest)
        out[key] = dest
    return out


def _read_csv(path):
    # acq_time must stay text: '0054' is 00:54 UTC, not the number 54.
    df = pd.read_csv(path, dtype={"acq_time": str, "confidence": str})
    missing = set(EXPECTED_COLS) - set(df.columns)
    if missing:
        raise ValueError(f"{path} is missing columns: {sorted(missing)}")
    return df


def load_fires(path=None, force=False):
    """Load VIIRS 7-day CSV(s) and drop low-confidence / invalid rows.

    path: read this one local CSV instead of downloading (used by tests).
    """
    if path:
        frames = [_read_csv(path)]
    else:
        frames = []
        for name, p in download_firms(force).items():
            f = _read_csv(p)
            if len(f) == 0:
                print(f"WARNING: {name} has 0 data rows, skipped.")
                p.unlink(missing_ok=True)
                continue
            frames.append(f)
        if not frames:
            raise ValueError("All FIRMS files were empty.")
    df = pd.concat(frames, ignore_index=True)
    n_raw = len(df)
    if n_raw == 0:
        raise ValueError("0 data rows loaded.")
    sat_raw = df["satellite"].value_counts().to_dict()
    print("raw rows per satellite:", sat_raw)

    df["confidence"] = df["confidence"].str.strip().str.lower()
    print("confidence values:", df["confidence"].value_counts(dropna=False).to_dict())

    df = df.dropna(subset=["latitude", "longitude", "frp"])
    n_valid = len(df)
    df = df[df["confidence"].isin(KEEP)].copy()

    df["acq_time"] = df["acq_time"].str.zfill(4)
    # Build the timestamp from numbers, not string concatenation: string "+" breaks on
    # pandas 3 / pyarrow-backed string columns (ArrowNotImplementedError).
    hh = pd.to_numeric(df["acq_time"].str.slice(0, 2)).astype("int64")
    mm = pd.to_numeric(df["acq_time"].str.slice(2, 4)).astype("int64")
    df["acq_dt"] = (pd.to_datetime(df["acq_date"], format="%Y-%m-%d", utc=True)
                    + pd.to_timedelta(hh * 60 + mm, unit="min"))

    dropped = n_raw - len(df)
    print(f"raw: {n_raw:,} | valid: {n_valid:,} | kept: {len(df):,} "
          f"(dropped {dropped:,}, {100 * dropped / n_raw:.1f}%)")
    print("dates (UTC):", df["acq_date"].min(), "->", df["acq_date"].max())

    if len(df):
        age = (pd.Timestamp.now(tz="UTC").normalize()
               - df["acq_dt"].max().normalize()).days
        if age > 2:
            print(f"WARNING: newest detection is {age} days old. "
                  "Stale file? Try load_fires(force=True).")
    out = df.reset_index(drop=True)
    # Row counts travel with the frame so build_data.py can put them in meta.json.
    out.attrs.update(n_raw=int(n_raw), n_valid=int(n_valid), n_kept=int(len(out)),
                     sat_raw={k: int(v) for k, v in sat_raw.items()})
    return out


# =============================================================================
# Decision-support layer (rule-based, no ML)
# Every tunable number is a constant here, so it is easy to change and to explain.
# =============================================================================
UNASSIGNED = "Unassigned"        # same label join.py uses
INSUFFICIENT = "Insufficient data"
WEIGHTS = {"frp": 0.5, "count": 0.2, "trend": 0.3}   # my starting choice, NOT validated
TIERS = [(75, "High"), (40, "Medium"), (0, "Low")]    # score >= cutoff -> tier
TREND_RECENT_DAYS = 2        # "last 2 complete days"
TREND_PRIOR_DAYS = 5         # "prior 5 days" (fewer are used if the file has fewer)
TREND_MIN_PRIOR_DAYS = 3     # fewer prior days than this -> nobody gets a trend flag
TREND_THRESHOLD_PCT = 15.0   # change beyond +/- this = Rising / Falling
MIN_DETECTIONS = 10          # fewer in the comparison window -> "Insufficient data"
TREND_CLIP = (-100.0, 300.0)  # stops one huge % from dominating the percentile rank


def day_coverage(df, edge_hours=1):
    """Split the file's UTC dates into complete and partial days.

    Why: the 7-day file is a rolling window, so only its first and last date can be
    cut off. A date counts as partial if detections start more than `edge_hours` after
    00:00 UTC (first date) or stop more than `edge_hours` before 24:00 UTC (last date).
    Partial days have fewer detections, and would fake a "Falling" signal if used.
    """
    dates = sorted(df["acq_date"].unique())
    first, last = df["acq_dt"].min(), df["acq_dt"].max()
    start = pd.Timestamp(dates[0], tz="UTC")
    end = pd.Timestamp(dates[-1], tz="UTC") + pd.Timedelta(days=1)
    gap = pd.Timedelta(hours=edge_hours)
    partial = []
    if first - start > gap:
        partial.append(dates[0])
    if end - last > gap and dates[-1] not in partial:
        partial.append(dates[-1])
    return {"dates": dates, "partial": partial,
            "complete": [d for d in dates if d not in partial],
            "first_detection_utc": first.strftime("%Y-%m-%d %H:%M"),
            "last_detection_utc": last.strftime("%Y-%m-%d %H:%M")}


def _flag(n_window, pct):
    if n_window < MIN_DETECTIONS:
        return INSUFFICIENT
    if pd.isna(pct):            # nothing in the baseline days, activity only in the last 2
        return "Rising"
    if pct > TREND_THRESHOLD_PCT:
        return "Rising"
    if pct < -TREND_THRESHOLD_PCT:
        return "Falling"
    return "Stable"


def region_trends(cnt, frp, complete):
    """Short-term signal per region.

    cnt / frp: DataFrames, one row per region, one column per date, zero-filled
    (a day with no detections must count as 0, not be skipped, or averages are inflated).
    Compares the mean daily value of the last 2 complete days with the prior 5, for
    detection count and for FRP, and averages the two % changes into trend_pct.
    Returns (DataFrame[n_window, trend_pct, trend_flag], recent_days, prior_days).
    """
    recent = complete[-TREND_RECENT_DAYS:]
    prior = complete[-(TREND_RECENT_DAYS + TREND_PRIOR_DAYS):-TREND_RECENT_DAYS]
    out = pd.DataFrame(index=cnt.index)
    if len(recent) < TREND_RECENT_DAYS or len(prior) < TREND_MIN_PRIOR_DAYS:
        out["n_window"], out["trend_pct"], out["trend_flag"] = 0, np.nan, INSUFFICIENT
        return out, recent, prior

    def change(t):  # % change of the mean daily value; NaN when the baseline is 0
        r, p = t[recent].mean(axis=1), t[prior].mean(axis=1)
        return (r - p) / p.where(p > 0) * 100

    out["n_window"] = cnt[recent + prior].sum(axis=1)
    out["trend_pct"] = pd.concat([change(cnt), change(frp)], axis=1).mean(axis=1)
    out["trend_flag"] = [_flag(n, p) for n, p in zip(out["n_window"], out["trend_pct"])]
    out.loc[out["trend_flag"] == INSUFFICIENT, "trend_pct"] = np.nan  # don't show a guess
    return out, recent, prior


def priority_scores(reg):
    """0-100 score per region: weighted blend of percentile ranks.

    Why percentiles: FRP, counts and % change have different units and wild outliers;
    ranking puts them on one 0-100 scale. Percentiles are taken within `reg` only, so
    call this separately for countries and for states. Regions flagged "Insufficient
    data" get no trend term: the weights are re-normalised over FRP and count.
    """
    pct = lambda s: s.rank(pct=True) * 100  # noqa: E731
    ok = reg["trend_flag"] != INSUFFICIENT
    t = reg["trend_pct"].clip(*TREND_CLIP).fillna(TREND_CLIP[1]).where(ok)
    w = WEIGHTS
    num = (w["frp"] * pct(reg["total_frp"]) + w["count"] * pct(reg["fire_count"])
           + w["trend"] * pct(t).fillna(0))
    den = w["frp"] + w["count"] + w["trend"] * ok
    return (num / den).round(1)


def tier_of(score):
    return next(name for cutoff, name in TIERS if score >= cutoff)


# "Suggested checks": plain prompts for a human, keyed on score tier + trend flag.
# They name things to look at; they never name a cause and are not official protocols.
CHECKS_TIER = {
    "High": ["Look at the newest FIRMS passes for this area to see which cells are active now.",
             "Check the land cover of the densest cells (cropland, forest, grassland, industry)."],
    "Medium": ["Check whether the densest cells repeat on several days or appear once."],
    "Low": ["Re-check after the next data refresh; no strong signal yet."],
}
CHECKS_FLAG = {
    "Rising": ["Check whether the rise comes from one cluster of cells or from many.",
               "Check weather and local agency or news updates for the area."],
    "Stable": ["Compare with the same area in earlier weeks if you have that data."],
    "Falling": ["Check cloud cover and passes: fewer detections can mean fewer observations."],
    INSUFFICIENT: ["Too few detections for a short-term signal; wait for more data."],
}


def suggested_checks(flag, tier):
    if flag == INSUFFICIENT:      # keep these short: the tier text adds nothing here
        return CHECKS_FLAG[flag] + CHECKS_TIER["Low"]
    return CHECKS_TIER[tier] + CHECKS_FLAG[flag]


def make_summary(r, span, n_recent, n_prior):
    """Template summary: facts only (counts, FRP, signal, rank). No cause is stated."""
    if r["level"] == "country":
        name, group = r["country"], "countries"
    else:
        name, group = f'{r["state"]} ({r["country"]})', f'states or provinces in {r["country"]}'
    s = (f'{name}: {r["fire_count"]:,} fire detections and {r["total_frp"]:,.0f} MW total FRP '
         f'between {span}. ')
    if r["trend_flag"] == INSUFFICIENT:
        s += "Too few detections for a short-term signal. "
    elif r["trend_pct"] is None:
        s += (f"Short-term signal: Rising (no detections in the {n_prior} days "
              f"before the last {n_recent}). ")
    else:
        s += (f'Short-term signal: {r["trend_flag"]} ({r["trend_pct"]:+.0f}% average daily '
              f"detections and FRP, last {n_recent} complete days vs the prior {n_prior}). ")
    s += (f'Ranks #{r["rank"]} of {r["rank_of"]} {group} with detections by priority score '
          f'({r["priority_score"]:.0f}/100, {r["tier"]} tier).')
    return s


def build_regions(agg_country, agg_state, cov):
    """One record per country and per state/province that has at least 1 detection.

    agg_*: output of join.aggregate(df, "country" / "state"); cov: day_coverage() result.
    Regions labelled "Unassigned" are left out (they stay in the country totals).
    """
    dates, complete = cov["dates"], cov["complete"]
    span = f'{dates[0]} and {dates[-1]} (UTC)'
    levels = (
        ("country", agg_country[agg_country["country"] != UNASSIGNED], ["iso_a3", "country"]),
        ("state", agg_state[(agg_state["country"] != UNASSIGNED)
                            & (agg_state["state"] != UNASSIGNED)],
         ["iso_a3", "country", "state"]),
    )
    records = []
    for level, agg, keys in levels:
        if agg.empty:
            continue

        def pivot(col):
            return (agg.groupby(keys + ["acq_date"])[col].sum()
                    .unstack("acq_date", fill_value=0).reindex(columns=dates, fill_value=0))

        cnt, frp = pivot("fires"), pivot("frp_sum")
        reg = pd.DataFrame(index=cnt.index)
        reg["fire_count"] = cnt.sum(axis=1)
        reg["total_frp"] = frp.sum(axis=1)
        trend, recent, prior = region_trends(cnt, frp, complete)
        reg = reg.join(trend)
        reg["priority_score"] = priority_scores(reg)
        reg["_pos"] = np.arange(len(reg))          # row position in cnt / frp
        reg = reg.reset_index()
        reg["level"] = level
        if level == "state":
            reg["state"] = reg["state"].astype(object)
        else:
            reg["state"] = None
        # rank: countries among all countries, states among the states of their country
        reg["_grp"] = reg["iso_a3"] if level == "state" else "world"
        reg = reg.sort_values(["priority_score", "total_frp"], ascending=False)
        reg["rank"] = reg.groupby("_grp").cumcount() + 1
        reg["rank_of"] = reg.groupby("_grp")["_grp"].transform("size")

        cnt_np, frp_np = cnt.to_numpy(), frp.to_numpy()
        for r in reg.to_dict("records"):
            pos = r["_pos"]
            rec = {
                "id": r["iso_a3"] if level == "country" else f'{r["iso_a3"]}|{r["state"]}',
                "level": level,
                "iso_a3": r["iso_a3"],
                "country": r["country"],
                "state": r["state"],
                "fire_count": int(r["fire_count"]),
                "total_frp": round(float(r["total_frp"]), 1),
                "trend_flag": r["trend_flag"],
                "trend_pct": None if pd.isna(r["trend_pct"]) else round(float(r["trend_pct"]), 1),
                "priority_score": float(r["priority_score"]),
                "tier": tier_of(r["priority_score"]),
                "rank": int(r["rank"]),
                "rank_of": int(r["rank_of"]),
            }
            rec["summary"] = make_summary(rec, span, len(recent), len(prior))
            rec["suggested_checks"] = suggested_checks(rec["trend_flag"], rec["tier"])
            rec["series"] = [{"date": d, "count": int(c), "frp": round(float(f), 1)}
                             for d, c, f in zip(dates, cnt_np[pos], frp_np[pos])]
            records.append(rec)
    return records


if __name__ == "__main__":
    import matplotlib.pyplot as plt

    df = load_fires()
    ensure_boundaries()
    ax = df.plot.scatter("longitude", "latitude", s=0.2, alpha=0.4, figsize=(12, 6))
    ax.set_title(f"VIIRS detections kept: {len(df):,}")
    plt.savefig(DATA_DIR / "raw_points.png", dpi=150)
    print("saved", DATA_DIR / "raw_points.png")
