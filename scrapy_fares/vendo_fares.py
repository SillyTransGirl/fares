#!/usr/bin/env python3
"""Vendo Backend Bridge: calls app.services-bahn.de/mob (DB Navigator API)."""
import json
import sys
import uuid
from datetime import datetime, timezone

try:
    from curl_cffi import requests as cc_requests
except ImportError:
    print(json.dumps({"error": "curl_cffi not installed"}))
    sys.exit(1)

BASE = "https://app.services-bahn.de/mob"
SEARCH_MEDIA = "application/x.db.vendo.mob.verbindungssuche.v9+json"
RECON_MEDIA = "application/x.db.vendo.mob.recon.v1+json"

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
    "8000098": "A=1@O=Essen Hbf@X=6995469@Y=51453989@U=80@L=8000098@",
    "8000152": "A=1@O=Hannover Hbf@X=9736782@Y=52376751@U=80@L=8000152@",
    "8000050": "A=1@O=Bremen Hbf@X=8808206@Y=53082527@U=80@L=8000050@",
    "8000080": "A=1@O=Dortmund Hbf@X=7451134@Y=51514965@U=80@L=8000080@",
    "8000244": "A=1@O=Mannheim Hbf@X=8466355@Y=49479756@U=80@L=8000244@",
    "8000191": "A=1@O=Karlsruhe Hbf@X=8405119@Y=48993750@U=80@L=8000191@",
    "8000260": "A=1@O=Wuerzburg Hbf@X=9930462@Y=49795572@U=80@L=8000260@",
    "8000013": "A=1@O=Augsburg Hbf@X=10885802@Y=48365456@U=80@L=8000013@",
    "8010099": "A=1@O=Erfurt Hbf@X=11028511@Y=50974341@U=80@L=8010099@",
    "8010147": "A=1@O=Halle(Saale)Hbf@X=11986441@Y=51483167@U=80@L=8010147@",
    "8000199": "A=1@O=Kiel Hbf@X=10131976@Y=54314982@U=80@L=8000199@",
    "8070003": "A=1@O=Frankfurt(Main)Flughafen Fernbf@X=8670068@Y=50050282@U=80@L=8070003@",
    "8011113": "A=1@O=Berlin Sudkreuz@X=13440829@Y=52476911@U=80@L=8011113@",
    "8103000": "A=1@O=Wien Hbf@X=163708860@Y=48184790@U=80@L=8103000@",
    "5400001": "A=1@O=Praha hl.n.@X=14423027@Y=50085783@U=80@L=5400001@",
    "8503000": "A=1@O=Zuerich HB@X=8565247@Y=47378543@U=80@L=8503000@",
    "8100002": "A=1@O=Salzburg Hbf@X=13034555@Y=47812570@U=80@L=8100002@",
    "8100124": "A=1@O=Innsbruck Hbf@X=11394775@Y=47260753@U=80@L=8100124@",
    "5500003": "A=1@O=Budapest-Keleti@X=19087585@Y=47498884@U=80@L=5500003@",
    "5600001": "A=1@O=Bratislava hl.st.@X=17109094@Y=48143005@U=80@L=5600001@",
    "5100048": "A=1@O=Warszawa Centralna@X=20998049@Y=52228032@U=80@L=5100048@",
    "8100153": "A=1@O=Klagenfurt Hbf@X=14322325@Y=46636840@U=80@L=8100153@",
    "8100118": "A=1@O=Graz Hbf@X=15435823@Y=47069767@U=80@L=8100118@",
    "8100013": "A=1@O=Linz Hbf@X=14274514@Y=48292384@U=80@L=8100013@",
}


def make_headers(media):
    return {
        "Accept": media,
        "Content-Type": media,
        "Accept-Language": "de",
        "User-Agent": "DBNavigator/Android/26.9.0",
        "X-App-Version": "26.9.0",
        "X-Correlation-ID": f"{uuid.uuid4()}_{uuid.uuid4()}",
    }


def build_traveller(age=None, bahncard=None):
    typ = "ERWACHSENER"
    if age is not None:
        if age < 5: typ = "KLEINKIND"
        elif age < 15: typ = "KIND"
        elif age < 27: typ = "JUGENDLICH"
        elif age >= 65: typ = "SENIOR"
    erm = "KEINE_ERMAESSIGUNG KLASSENLOS"
    if bahncard:
        bc = bahncard.upper().replace("BAHN_CARD_", "").replace("BC", "")
        if bc in ("25_1", "251"): erm = "BAHNCARD25 KLASSE_2"
        elif bc in ("25_2", "252"): erm = "BAHNCARD25 KLASSE_1"
        elif bc in ("50_1", "501"): erm = "BAHNCARD50 KLASSE_2"
        elif bc in ("50_2", "502"): erm = "BAHNCARD50 KLASSENLOS"
    return [{"reisendenTyp": typ, "ermaessigungen": [erm]}]


def search_fares(from_eva, to_eva, date_str, time_str="10:00:00", age=None, bahncard=None):
    from_loc = EVA_LOC.get(from_eva, f"A=1@L={from_eva}@")
    to_loc = EVA_LOC.get(to_eva, f"A=1@L={to_eva}@")
    reiseDatum = datetime.strptime(f"{date_str}T{time_str}", "%Y-%m-%dT%H:%M:%S").replace(tzinfo=timezone.utc).isoformat()

    payload = {
        "autonomeReservierung": False,
        "einstiegsTypList": ["STANDARD"],
        "fahrverguenstigungen": {
            "deutschlandTicketVorhanden": False,
            "nurDeutschlandTicketVerbindungen": False,
        },
        "klasse": "KLASSE_2",
        "reiseHin": {"wunsch": {
            "abgangsLocationId": from_loc,
            "alternativeHalteBerechnung": True,
            "verkehrsmittel": ["ALL"],
            "zeitWunsch": {"reiseDatum": reiseDatum, "zeitPunktArt": "ABFAHRT"},
            "zielLocationId": to_loc,
        }},
        "reisendenProfil": {"reisende": build_traveller(age, bahncard)},
        "reservierungsKontingenteVorhanden": False,
    }

    try:
        r = cc_requests.post(
            f"{BASE}/angebote/fahrplan",
            json=payload, headers=make_headers(SEARCH_MEDIA),
            impersonate="chrome", timeout=30,
        )
        if r.status_code != 200:
            return {"error": f"vendo: HTTP {r.status_code}"}
        d = r.json()
        return parse_vendo_connections(d.get("verbindungen", []))
    except Exception as e:
        return {"error": f"vendo: {str(e)[:200]}"}


def parse_vendo_connections(conns):
    offers = []
    for c in conns[:8]:
        v = c.get("verbindung", {})
        segs = v.get("verbindungsAbschnitte", [])
        if not segs:
            continue
        first = segs[0]
        last = segs[-1]
        vm = first.get("verkehrsmittel", {})
        dep = first.get("halte", [{}])[0].get("abgangsDatum") if first.get("halte") else None
        arr_halt = last.get("halte", [{}])
        arr = arr_halt[-1].get("ankunftsDatum") if arr_halt else None
        preis = c.get("angebote", {}).get("preise", {}).get("gesamt", {}).get("ab", {})
        kontext = v.get("kontext", "")
        offers.append({
            "verbindung": v,
            "departure": dep,
            "arrival": arr,
            "product": first.get("mitteltext") or first.get("kurztext") or vm.get("name"),
            "price": preis.get("betrag"),
            "currency": preis.get("waehrung", "EUR"),
            "kontext": kontext,
        })
    return {"offers": offers}


def search_recon(kontext, age=None, bahncard=None):
    payload = {
        "klasse": "KLASSE_2",
        "reisende": build_traveller(age, bahncard),
        "kontext": kontext,
        "deutschlandTicketVorhanden": False,
    }
    try:
        r = cc_requests.post(
            f"{BASE}/angebote/recon",
            json=payload, headers=make_headers(RECON_MEDIA),
            impersonate="chrome", timeout=20,
        )
        if r.status_code != 200:
            return {"error": f"vendo-recon: HTTP {r.status_code}"}
        return r.json()
    except Exception as e:
        return {"error": f"vendo-recon: {str(e)[:200]}"}


def main():
    import argparse
    parser = argparse.ArgumentParser()
    parser.add_argument("--from-eva", required=True)
    parser.add_argument("--to-eva", required=True)
    parser.add_argument("--date", required=True)
    parser.add_argument("--time", default="10:00:00")
    parser.add_argument("--age", default=None, type=int)
    parser.add_argument("--bahncard", default=None)
    args = parser.parse_args()

    result = search_fares(args.from_eva, args.to_eva, args.date, args.time, args.age, args.bahncard)
    print(json.dumps(result, ensure_ascii=False))


if __name__ == "__main__":
    main()
