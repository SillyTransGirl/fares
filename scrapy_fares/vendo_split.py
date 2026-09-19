#!/usr/bin/env python3
"""Split Ticketing: finds cheaper intermediate stops for DB fares."""
import json
import sys
import uuid
import time
from datetime import datetime, timezone

try:
    from curl_cffi import requests as cc_requests
except ImportError:
    print(json.dumps({"error": "curl_cffi not installed"}))
    sys.exit(1)

BASE = "https://app.services-bahn.de/mob"
SEARCH_MEDIA = "application/x.db.vendo.mob.verbindungssuche.v9+json"

EVA_LOC = {
    "8011160": "A=1@O=Berlin Hbf@X=13369549@Y=52525589@U=80@L=8011160@",
    "8000261": "A=1@O=Muenchen Hbf@X=11558339@Y=48140229@U=80@L=8000261@",
    "8002549": "A=1@O=Hamburg Hbf@X=10006909@Y=53552733@U=80@L=8002549@",
    "8000105": "A=1@O=Frankfurt(Main)Hbf@X=8665093@Y=50107097@U=80@L=8000105@",
    "8000207": "A=1@O=Koeln Hbf@X=6956201@Y=50943087@U=80@L=8000207@",
    "8000096": "A=1@O=Stuttgart Hbf@X=9181635@Y=48784084@U=80@L=8000096@",
    "8010085": "A=1@O=Dresden Hbf@X=13732284@Y=51034432@U=80@L=8010085@",
    "8010205": "A=1@O=Leipzig Hbf@X=12380126@Y=51343698@U=80@L=8010205@",
    "8000284": "A=1@O=Nuernberg Hbf@X=11082726@Y=49445614@U=80@L=8000284@",
    "8000085": "A=1@O=Duesseldorf Hbf@X=6794279@Y=51220109@U=80@L=8000085@",
    "8000152": "A=1@O=Hannover Hbf@X=9736782@Y=52376751@U=80@L=8000152@",
    "8000080": "A=1@O=Dortmund Hbf@X=7451134@Y=51514965@U=80@L=8000080@",
    "8000191": "A=1@O=Karlsruhe Hbf@X=8405119@Y=48993750@U=80@L=8000191@",
    "8000260": "A=1@O=Wuerzburg Hbf@X=9930462@Y=49795572@U=80@L=8000260@",
    "8010099": "A=1@O=Erfurt Hbf@X=11028511@Y=50974341@U=80@L=8010099@",
    "8000115": "A=1@O=Fulda@X=9684169@Y=50554902@U=80@L=8000115@",
    "8000128": "A=1@O=Goettingen@X=9926069@Y=51536812@U=80@L=8000128@",
    "8003200": "A=1@O=Kassel-Wilhelmshoehe@X=9655194@Y=51311134@U=80@L=8003200@",
    "8000064": "A=1@O=Celle@X=10116352@Y=52624070@U=80@L=8000064@",
    "8000010": "A=1@O=Aschaffenburg Hbf@X=9140213@Y=49979508@U=80@L=8000010@",
    "8103000": "A=1@O=Wien Hbf@X=163708860@Y=48184790@U=80@L=8103000@",
    "5400001": "A=1@O=Praha hl.n.@X=14423027@Y=50085783@U=80@L=5400001@",
    "8503000": "A=1@O=Zuerich HB@X=8565247@Y=47378543@U=80@L=8503000@",
}


def resolve_loc(station):
    """Resolve station to Vendo location ID. Accepts EVA code or name."""
    if station in EVA_LOC:
        return EVA_LOC[station]
    if station.isdigit():
        return f"A=1@L={station}@"
    return f"A=1@O={station}@"

def make_headers():
    return {
        "Accept": SEARCH_MEDIA,
        "Content-Type": SEARCH_MEDIA,
        "Accept-Language": "de",
        "User-Agent": "DBNavigator/Android/26.9.0",
        "X-App-Version": "26.9.0",
        "X-Correlation-ID": f"{uuid.uuid4()}_{uuid.uuid4()}",
    }


def build_payload(from_loc, to_loc, reiseDatum):
    return {
        "autonomeReservierung": False,
        "einstiegsTypList": ["STANDARD"],
        "fahrverguenstigungen": {"deutschlandTicketVorhanden": False, "nurDeutschlandTicketVerbindungen": False},
        "klasse": "KLASSE_2",
        "reiseHin": {"wunsch": {
            "abgangsLocationId": from_loc,
            "alternativeHalteBerechnung": True,
            "verkehrsmittel": ["ALL"],
            "zeitWunsch": {"reiseDatum": reiseDatum, "zeitPunktArt": "ABFAHRT"},
            "zielLocationId": to_loc,
        }},
        "reisendenProfil": {"reisende": [{"ermaessigungen": ["KEINE_ERMAESSIGUNG KLASSENLOS"], "reisendenTyp": "ERWACHSENER"}]},
        "reservierungsKontingenteVorhanden": False,
    }


def vendo_search(from_loc, to_loc, reiseDatum, retries=2):
    for attempt in range(retries + 1):
        try:
            r = cc_requests.post(
                f"{BASE}/angebote/fahrplan",
                json=build_payload(from_loc, to_loc, reiseDatum),
                headers=make_headers(),
                impersonate="chrome", timeout=45,
            )
            if r.status_code == 200:
                d = r.json()
                results = []
                for c in d.get("verbindungen", [])[:5]:
                    v = c.get("verbindung", {})
                    preis = c.get("angebote", {}).get("preise", {}).get("gesamt", {}).get("ab", {})
                    segs = v.get("verbindungsAbschnitte", [])
                    halte = []
                    for seg in segs:
                        for h in seg.get("halte", []):
                            eva = h.get("ort", {}).get("evaNr")
                            name = h.get("ort", {}).get("name")
                            if eva and name:
                                halte.append({"eva": eva, "name": name})
                    results.append({
                        "price": preis.get("betrag"),
                        "duration": v.get("reiseDauer", 0),
                        "stops": halte,
                    })
                return results
        except Exception as e:
            if attempt < retries:
                time.sleep(2)
    return []


def get_intermediate_stops(connections):
    """Extract unique intermediate stops from connections."""
    all_stops = []
    for c in connections:
        seen = set()
        for stop in c.get("stops", []):
            eva = stop["eva"]
            if eva not in seen:
                seen.add(eva)
                all_stops.append(stop)
    return all_stops


def find_split_tickets(from_station, to_station, date_str, time_str="10:00:00", max_splits=5):
    from_loc = resolve_loc(from_station)
    to_loc = resolve_loc(to_station)
    reiseDatum = datetime.strptime(f"{date_str}T{time_str}", "%Y-%m-%dT%H:%M:%S").replace(tzinfo=timezone.utc).isoformat()

    # Step 1: Get direct connections to find intermediate stops
    direct = vendo_search(from_loc, to_loc, reiseDatum)
    if not direct:
        return {"error": "no direct connections found"}

    # Step 2: Extract intermediate stops
    intermediates = get_intermediate_stops(direct)
    # Filter: only stops that are NOT origin or destination
    candidates = [s for s in intermediates if s["name"] != from_station and s["name"] != to_station]
    # Limit to max_splits most common stops
    candidates = candidates[:max_splits]

    if not candidates:
        return {"direct_price": direct[0]["price"], "splits": [], "best_saving": 0}

    # Step 3: Query fares for each split
    splits = []
    for stop in candidates:
        time.sleep(0.5)  # Rate limit
        seg1 = vendo_search(from_loc, resolve_loc(stop["name"]), reiseDatum)
        time.sleep(0.5)
        seg2 = vendo_search(resolve_loc(stop["name"]), to_loc, reiseDatum)

        p1 = seg1[0]["price"] if seg1 else None
        p2 = seg2[0]["price"] if seg2 else None
        total = (p1 or 0) + (p2 or 0)

        splits.append({
            "split_point": stop["name"],
            "split_eva": stop["eva"],
            "seg1_price": p1,
            "seg2_price": p2,
            "total_price": total if total > 0 else None,
        })

    # Step 4: Calculate savings
    direct_price = direct[0]["price"] if direct else None
    for s in splits:
        if direct_price and s["total_price"]:
            s["saving"] = round(direct_price - s["total_price"], 2)
        else:
            s["saving"] = None

    # Sort by saving (best first)
    splits.sort(key=lambda x: x["saving"] or 0, reverse=True)

    best = splits[0] if splits else None
    return {
        "direct_price": direct_price,
        "splits": splits,
        "best_saving": best["saving"] if best else 0,
        "best_split": best["split_point"] if best else None,
    }


def main():
    import argparse
    parser = argparse.ArgumentParser()
    parser.add_argument("--from-eva", default=None)
    parser.add_argument("--to-eva", default=None)
    parser.add_argument("--from", dest="from_name", default=None)
    parser.add_argument("--to", dest="to_name", default=None)
    parser.add_argument("--date", required=True)
    parser.add_argument("--time", default="10:00:00")
    parser.add_argument("--max-splits", default=5, type=int)
    args = parser.parse_args()

    from_station = args.from_name or args.from_eva
    to_station = args.to_name or args.to_eva
    if not from_station or not to_station:
        print(json.dumps({"error": "need --from/--to or --from-eva/--to-eva"}))
        sys.exit(1)

    result = find_split_tickets(from_station, to_station, args.date, args.time, args.max_splits)
    print(json.dumps(result, ensure_ascii=False))


if __name__ == "__main__":
    main()
