# EmberWatch handoff: Sessions 1-3 -> Session 4 (frontend)

Project: EVS course project. Global wildfire decision-support dashboard from NASA FIRMS VIIRS.
Target ~7h (not a hard cap). Used so far ~4.75h by estimate. Frontend est. 2.5-3h -> ~8h total.
Stack: Python, pandas, geopandas for processing. Frontend = hand-coded HTML/CSS/JS in VS Code with
Leaflet + Chart.js. NO Streamlit, NO folium. (requirements.txt: delete streamlit/folium/streamlit-folium.)

## Status
| Phase | State |
|---|---|
| 0-1 setup, load, drop low confidence (data.py) | DONE |
| 2-3 spatial join + daily aggregation (join.py) | DONE |
| 4 decision layer: trend, priority score, summary, suggested checks (data.py) | DONE |
| build_data.py -> data/meta.json, regions.json, cells.json | DONE, run on real data 2026-11-15 |
| 5 frontend (index.html, style.css, app.js) | NEXT |
| Report, 5-min pitch, Q&A | after frontend |

Next session: frontend only. Do not touch the pipeline unless the scoring change below is chosen.

## Run
```
python build_data.py            # cached CSVs / joined parquet reused when fresh
python build_data.py --force    # re-download FIRMS
python -m http.server           # then open http://localhost:8000  (file:// blocks fetch())
python tests/test_join.py ; python tests/test_decision.py   # both end with PASS
```
Tests passed in my sandbox; confirm they pass on Dikshant's machine (output not seen yet).
FIRMS cannot be downloaded from the Claude workspace (403): Dikshant runs build_data.py locally and
attaches/pastes the output.

## Real run, 2026-11-15 (Dikshant's machine)
- Sources: NOAA-20 (N20) + NOAA-21 (N21) VIIRS 375 m. Suomi-NPP is dead since 2026-11-02.
- raw 760,021 (N20 386,936 / N21 373,085) | valid 760,021 | kept 667,266 | dropped 92,755 low = 12.2%
- confidence: nominal 627,452 / low 92,755 / high 39,814
- Dates (UTC): 2026-11-08 -> 2026-11-15. First detection 2026-11-08 00:00 (complete day).
  Last detection 2026-11-15 11:12 -> **2026-11-15 is PARTIAL, excluded from the trend.**
  7 complete days: recent = 11-13, 11-14; prior = 11-08..11-12 (full "last 2 vs prior 5").
  The window rolls: partial days are re-detected on every run (an older file had both ends partial,
  which gives only 4 prior days).
- Join: 14 s for 667,266 points. Unassigned: country 5,078 (0.76%), state 5,078 (0.76%). snap_deg = 0 (off).
- File sizes: meta.json 2.2 KB | regions.json 2,371 KB | cells.json 1,128 KB. Cell row count is in meta.json counts.
- regions.json: 2,283 regions = 181 countries + 2,102 states/provinces (only regions with >=1 detection).
  Flags: Rising 469, Stable 153, Falling 576, Insufficient data 1,085.
  Tiers: High 337, Medium 1,022, Low 924. 5 regions are Rising with null pct (no baseline detections).
  India: 30 states with detections.
- Checked in regions.json: strict JSON (no NaN), no duplicate ids, no "Unassigned" entries, all 8-day
  series, every Insufficient entry has trend_pct null, ranks run 1..n per group, no "protocol" anywhere.

## Files
```
emberwatch/
  data.py          loaders + decision layer (constants at the top of the decision section)
  join.py          add_region(), aggregate()  (unchanged since Session 2)
  build_data.py    writes the 3 JSON files
  tests/           test_data.py (S1), test_join.py (S2), test_decision.py (S3)
  data/            boundaries/*.geojson, viirs_noaa20_7d.csv, viirs_noaa21_7d.csv,
                   fires_joined_snap0.parquet (cache), meta.json, regions.json, cells.json
  index.html style.css app.js    <- Session 4
```
Frontend only reads data/*.json. Raw points are never exported.

## Pipeline rules (so the numbers can be explained)
- Low confidence dropped; nominal + high kept. Join: point-in-polygon `within` on Natural Earth 10 m
  Admin 0 then Admin 1 (make_valid first). Misses -> "Unassigned" (ocean, coast, border). Unassigned
  regions are not in regions.json but stay in country totals and in cells.json (index -1).
- `iso_a3` is Natural Earth ADM0_A3 (not strictly ISO). Filter states by iso_a3, not name (two Punjabs).
- Trend: mean daily value of the last 2 complete days vs the prior 5 (zero-filled days), for count and for
  FRP; trend_pct = average of the two % changes. > +15% Rising, < -15% Falling, else Stable.
  < 10 detections in the comparison window -> "Insufficient data" with trend_pct null.
  No baseline but activity in last 2 days -> Rising with trend_pct null.
  Call it a "short-term signal", never a "trend".
- Priority score: percentile rank (within level: countries vs states) of total FRP, fire count, trend %
  (clipped -100..+300), blended 0.5 / 0.2 / 0.3 (WEIGHTS in data.py), 0-100. Insufficient-data regions
  drop the trend term (weights re-normalised). Tiers: High >= 75, Medium >= 40, Low.
  Rank: countries worldwide; states within their country.
- Totals (fire_count, total_frp) cover every date in the file including the partial one.
- Summary text states facts only, no cause. Suggested checks = tier list + trend-flag list; wording is
  "suggested checks", never "protocol".

## JSON schemas (real example entries)
meta.json (keys; show `limitations` next to every summary box):
```
built_utc, data_newest_utc, data_oldest_utc, source,
rows{raw,valid,kept,dropped_low_confidence,per_satellite_raw{N20,N21}},
unassigned{country_count,country_share_pct,state_count,state_share_pct},
dates{all[],complete[],partial[],trend_recent[],trend_prior[]},
trend{threshold_pct,min_detections,labels[]}, score{weights{frp,count,trend},tiers[{min_score,name}]},
counts{countries,states,cells}, limitations[10 strings]
```
regions.json = list, one entry per region (country entries: id = code, state = null):
```
{"id":"IND|Madhya Pradesh","level":"state","iso_a3":"IND","country":"India","state":"Madhya Pradesh",
 "fire_count":7492,"total_frp":39252.6,"trend_flag":"Stable","trend_pct":9.4,
 "priority_score":87.2,"tier":"High","rank":1,"rank_of":30,
 "summary":"Madhya Pradesh (India): 7,492 fire detections and 39,253 MW total FRP between 2026-11-08 and 2026-11-15 (UTC). Short-term signal: Stable (+9% average daily detections and FRP, last 2 complete days vs the prior 5). Ranks #1 of 30 states or provinces in India with detections by priority score (87/100, High tier).",
 "suggested_checks":["Look at the newest FIRMS passes for this area to see which cells are active now.",
   "Check the land cover of the densest cells (cropland, forest, grassland, industry).",
   "Compare with the same area in earlier weeks if you have that data."],
 "series":[{"date":"2026-11-08","count":630,"frp":3321.4}, ... 8 entries, incl. the partial last date]}
```
cells.json (0.25 deg grid, cell centre; border cells have one row per region):
```
{"grid_deg":0.25,"fields":["lat","lon","count","frp","country","state"],"note":"...",
 "countries":["AFG",...],   "states":["AFG|Badakhshan",...],
 "cells":[[5.125,23.625,38,198.5,26,226], ...]}
```
country / state = index into `countries` / `states` (region ids); -1 = Unassigned.
state ids match regions.json `id`; country ids match country entries' `id`.

## Real results to sanity-check the UI against
India top 10 states by total FRP (MW) | trend | score | rank in India:
Madhya Pradesh 39,253 Stable 87.2 #1 | Punjab 18,535 Falling 73.5 #13 | Uttar Pradesh 11,363 Stable 83.7 #2 |
Telangana 9,830 Stable 83.2 #3 | Rajasthan 9,162 Falling 74.8 #11 | Maharashtra 6,013 Stable 82.9 #4 |
Odisha 4,178 Stable 82.2 #6 | Gujarat 3,819 Stable 81.6 #7 | Jharkhand 3,322 Stable 82.4 #5 |
Chhattisgarh 2,345 Falling 76.3 #9.
Countries by priority rank: #1 Burkina Faso (141,311 MW, Rising +49%), #2 Brazil (499,607, Stable),
#3 Nigeria, #4 Cameroon, #5 Iran, #6 South Sudan (886,454, Falling). Australia has the highest total FRP
(1,280,994 MW) but is Falling -51% and ranks #26 of 181.

## Decision made: priority score vs total FRP
Percentiles saturate: big regions all sit near the 99th percentile for FRP and count, so the 0.3 trend
weight does the sorting (Australia #26, Punjab #13 in India). Dikshant chose to KEEP the scoring and
show both sorts in the UI. Not validated: say so in the report. (Cheaper fixes if he changes his mind:
log-scale FRP and count before percentiling, about 15 min, then re-run build_data.py.)

## Frontend spec (Session 4)
Hand-coded index.html, style.css, app.js. Designed by Dikshant, not a framework default look
(optional: Helix UI design system if he asks). Build in small pieces, test each in the browser:
1. Load the 3 JSON files + country dropdown + state dropdown (filtered by country; sort A-Z).
2. Leaflet map from cells.json. Filter by selection (country idx / state idx), zoom to its cells.
   Warn: tens of thousands of cell rows. Use a canvas renderer (L.canvas) and draw only the selection,
   or a world overview with count-scaled circles; do not create one DOM marker per cell.
3. Priority table: show BOTH Total FRP (MW) and Priority score, plus trend flag + %. Toggle sorts by
   "Priority score" (default) or "Total FRP". Rank number = position in the current sort. Countries listed
   worldwide; states listed within the selected country. Note under the table: "Priority score blends FRP,
   detection count and short-term change; a large region that is Falling can rank below a smaller one that
   is Rising. Sort by Total FRP to see raw burning."
4. Chart.js daily trend (count and FRP) for the selection; draw dates in meta.dates.partial dashed or grey.
5. Summary box: region.summary + suggested_checks (heading "Suggested checks") + meta.limitations.
   Show data_newest_utc and the unassigned share somewhere visible.
Honesty in the UI: "fire detections", never "wildfires"; never state a cause; trend = "short-term signal".

## Known issues / limitations (carry into the report)
- Not every detection is a wildfire: agricultural burns, gas flares, industrial heat. India's top states
  (Madhya Pradesh, Punjab, Uttar Pradesh) look more like crop-residue burning than forest fire; unconfirmed,
  list it as a limitation, never as a cause.
- Few passes per day, cloud and smoke hide fires, ~375 m pixel. NRT data, not science-quality.
- Two satellites ~50 min apart: one fire can appear twice. Counts are detections, not unique fires.
- 7-day window: short-term signal only. A noisy 2-day window can swing the flag.
- Priority weights (0.5/0.2/0.3), the +/-15% threshold and tier cutoffs are a starting choice, not validated.
- Total FRP is approximate: neighbouring pixels often share identical FRP (cause unconfirmed).
- Days are UTC (late-evening India detections fall on the next UTC day).
- Natural Earth 10 m boundaries: coastal/border/offshore fires can be Unassigned (0.76% now).
- 7 Admin 0 entries have no Admin 1 rows (BJN, BRI, BRT, CNM, SCR, SER, SPI); their detections count at
  country level only.
- Cosmetic: the "dates (UTC)" line prints twice during build_data.py.
- join cache is keyed on row count + newest timestamp (fires_joined_snap0.parquet); delete it to force a re-join.
- pandas 3 / pyarrow: never concatenate string columns with `+`.
- Boundary files: Natural Earth 10 m GeoJSON (nvkelso/natural-earth-vector). admin0 258 rows, admin1 4,596 rows;
  1 invalid geometry in each, fixed by make_valid() in join.py.

## Session 4 starting prompt (paste with data.py, join.py, build_data.py, meta.json, regions.json)
We're on scope step 5 (frontend), est. 2.5-3h. Read HANDOFF.md (pipeline is done; the data layer is
frozen). Build hand-coded index.html, style.css, app.js with Leaflet + Chart.js, no framework. Follow
"Frontend spec" in the handoff exactly, in the 5 pieces listed, and test each in the browser via
python -m http.server before moving on. Warn me about map performance and give the fix. End with a
handoff note: how to run it, known bugs, load time.
