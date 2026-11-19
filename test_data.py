"""Offline test for load_fires using rows copied from the real FIRMS file (2026-10-01 sample).
Run: python tests/test_data.py
"""
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import data  # noqa: E402

HEADER = "latitude,longitude,bright_ti4,scan,track,acq_date,acq_time,satellite,confidence,version,bright_ti5,frp,daynight"
ROWS = [
    "-22.36604,18.63301,304.71,0.47,0.64,2026-10-01,0054,N,nominal,2.0NRT,285.25,0.1,N",   # keep; leading-zero time
    "-40.81296,175.8764,356.7,0.48,0.64,2026-10-01,0128,N,low,2.0NRT,287.2,18.09,D",        # drop: low
    "31.36334,6.04605,367,0.57,0.69,2026-10-01,0039,N,high,2.0NRT,291.69,4.9,N",            # keep: high
    "10.0,20.0,300,0.4,0.4,2026-10-01,0100,N,nominal,2.0NRT,285,,N",                        # drop: missing frp
    "11.0,21.0,300,0.4,0.4,2026-10-02,2359,N,Nominal ,2.0NRT,285,1.5,D",                    # keep: messy case/space
]


def main():
    with tempfile.TemporaryDirectory() as d:
        p = Path(d) / "t.csv"
        p.write_text(HEADER + "\n" + "\n".join(ROWS) + "\n")
        df = data.load_fires(path=p)
    assert len(df) == 3, len(df)
    assert set(df["confidence"]) == {"nominal", "high"}
    assert df["acq_time"].iloc[0] == "0054"
    assert str(df["acq_dt"].iloc[0]) == "2026-10-01 00:54:00+00:00"
    print("OK: 5 raw -> 3 kept")


if __name__ == "__main__":
    main()
