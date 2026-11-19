# EmberWatch

Global fire-detection decision-support dashboard built from NASA FIRMS VIIRS data (EVS course project; SDG 15, 13, 11).

Raw satellite fire data is hard for non-experts to use. EmberWatch turns it into country- and state-level insight: where detections are concentrated, which regions to look at first, whether activity is rising or falling in the short term, and what to check next. It is a screening aid, not a confirmed-fire map.

> **Wording rule for everyone:** say "fire detections", never "wildfires". Never state a cause. Call the trend flag a "short-term signal", not a "trend". Call suggestions "suggested checks", not "protocols".

## Current progress

| Phase | State |
|---|---|
| 0-1 Setup, load FIRMS, drop low-confidence detections (`data.py`) | Done |
| 2-3 Spatial join to country and state, daily aggregation (`join.py`) | Done |
| 4 Decision layer: short-term signal, priority score, summary text, suggested checks (`data.py`) | Done |
| `build_data.py` writes `data/meta.json`, `regions.json`, `cells.json` | Done (last real run: 2026-11-15) |
| 5 Frontend: dropdowns, map, priority table, daily chart, summary box | Done, tested headless; not yet tested by hand in Safari, with keyboard only, or with a screen reader |
| Report (problem, solution, SDG mapping, method, limitations, future work) | **Not started** |
| 5-minute pitch and likely Q&A | **Not started** |
| Stretch: briefing download button, seasonal comparison | Not started |

## Run it

```
pip install -r requirements.txt
python -m http.server
```
Open http://localhost:8000. Opening `index.html` directly (file://) will not work because the browser blocks `fetch()`.

The page needs internet for Leaflet, Chart.js and the Fontshare fonts.

The small JSON files in `data/` are committed, so you can run the dashboard without running the pipeline.

To refresh the data (needs internet; FIRMS downloads can be slow):
```
python build_data.py            # reuses cached CSVs / joined data when fresh
python build_data.py --force    # re-download FIRMS
```
Only one person should rebuild and commit `data/*.json`. These files are generated, and two people regenerating them will cause merge conflicts.

Tests (each should end with PASS):
```
python test_data.py
python test_join.py
python test_decision.py
```

## How it works

```
NASA FIRMS VIIRS 375 m (NOAA-20 + NOAA-21, 7-day files)
  -> data.py        load, drop low confidence, decision layer
  -> join.py        point-in-polygon join to Natural Earth Admin 0 / Admin 1 (GeoPandas)
  -> build_data.py  writes meta.json, regions.json, cells.json
  -> index.html + style.css + app.js   (Leaflet + Chart.js, reads only those JSON files)
```

The one new concept is the **spatial join**: each detection point is matched to the country and state polygon that contains it.

Raw points are never exported. The map uses a 0.25 degree grid (about 28 km cells).

### Rules (so the numbers can be explained)
- **Filter:** low-confidence detections dropped; nominal and high kept.
- **Short-term signal:** mean daily value of the last 2 complete days vs the prior 5, for detection count and for FRP; `trend_pct` is the average of the two % changes. Above +15% is Rising, below -15% is Falling, otherwise Stable. Fewer than 10 detections in the comparison window gives "Insufficient data". The partial last UTC day is excluded.
- **Priority score (0-100):** percentile ranks (within countries, or within states) of total FRP, detection count and short-term change, blended 0.5 / 0.2 / 0.3. Tiers: High >= 75, Medium >= 40, Low below that.
- **Unassigned:** detections that fall in no polygon (ocean, coast, border) stay in country totals but are not listed as regions (0.76% in the last run).

All tunable numbers are constants at the top of the decision section in `data.py`.

### Files
```
data.py            loaders + decision layer
join.py            add_region(), aggregate()
build_data.py      writes the 3 JSON files
make_borders.py    builds the map outlines in data/borders/ (already committed; only re-run if needed)
index.html, style.css, app.js    dashboard
test_data.py, test_join.py, test_decision.py
data/              meta.json, regions.json, cells.json, borders/
HANDOFF.md         pipeline handoff notes (Sessions 1-3)
```
FIRMS CSVs, the joined-data cache and Natural Earth boundaries are not in git. `build_data.py` downloads them as needed.

## Limitations (these must appear in the report)
- Not every detection is a wildfire: agricultural burns, gas flares and industrial heat are also detected. In India, the top states (Madhya Pradesh, Punjab, Uttar Pradesh) may be crop-residue burning; this is unconfirmed and is listed as a limitation only, never as a cause.
- Satellites pass a place only a few times a day, cloud and smoke hide fires, and each pixel is about 375 m.
- NOAA-20 and NOAA-21 fly about 50 minutes apart, so one fire can appear twice. Counts are detections, not unique fires.
- Near-real-time data, not science-quality.
- 7-day window: the signal is short-term, and a noisy 2-day window can swing the flag.
- **Priority weights (0.5 / 0.2 / 0.3), the +/-15% threshold and the tier cutoffs are a starting choice and are not validated.** Big regions all sit near the 99th percentile for FRP and count, so the trend term does most of the sorting (Australia has the highest total FRP but ranks #26 of 181 because it is Falling). This is why the table can sort by Total FRP as well.
- Total FRP is approximate (neighbouring pixels often share identical FRP values; cause unconfirmed).
- Days are UTC, so late-evening India detections fall on the next UTC day.
- Natural Earth 10 m boundaries: coastal, offshore and border fires can be Unassigned. Seven Admin 0 entries have no Admin 1 rows (BJN, BRI, BRT, CNM, SCR, SER, SPI) and count at country level only.

## What's next

**Must do (before submission)**
1. Write the report: problem, solution, SDG mapping, method, limitations, future work. The limitations above, and the data freshness date, must be in it.
2. Write the 5-minute pitch and likely Q&A (scoring choice, why spatial joins, why not every detection is a wildfire, what the signal can and cannot say).
3. Confirm the three tests pass on every teammate's machine.
4. Clean up `requirements.txt` (remove `streamlit`, `folium`, `streamlit-folium`).
5. Re-run `python build_data.py --force` shortly before the demo so the data is fresh.

**Should do**
- Test the dashboard in more browsers (Safari), with keyboard only, and with a screen reader.
- Check the Fontshare font licence before hosting the page publicly.
- Check that the page looks right on the real map (the build tested headless only).

**Could do (only if time remains)**
- Briefing download button.
- Seasonal comparison (needs more than 7 days of data).
- Make the score less saturated: log-scale FRP and count before taking percentiles (about 15 minutes, then re-run `build_data.py`). The weights would still be unvalidated.
- A basemap with roads and place names (OpenStreetMap tiles with a dark CSS filter). The map currently draws only land and borders.

**Known small issues**
- The "dates (UTC)" line prints twice during `build_data.py` (cosmetic).
- One state id (`CNM|Nicosia`) has no outline on the map.
- Countries with far territories (USA, France, Russia) zoom out to include all cells.
- The join cache is keyed on row count and newest timestamp. Delete `data/fires_joined_snap0.parquet` to force a re-join.

## Working together
- Pull before you start: `git pull`.
- Work on a branch: `git checkout -b <name>/<task>`, then open a pull request into `main`.
- Do not hand-edit `data/*.json`.
- Suggested split: one person on the report, one on the pitch and Q&A, one on testing and polish.
- pandas 3 / pyarrow note: never join string columns with `+`; build values from numbers instead.

## Data sources
- NASA FIRMS VIIRS 375 m active fire, NOAA-20 and NOAA-21 (Suomi-NPP stopped delivering on 2026-11-02).
- Natural Earth 10 m Admin 0 and Admin 1 boundaries.
