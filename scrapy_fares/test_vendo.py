"""Test Vendo backend with correct payload format."""
import json
import uuid
from datetime import datetime, timezone
from curl_cffi import requests

SOCKS5 = "socks5://100.127.147.36:1080"
media = "application/x.db.vendo.mob.verbindungssuche.v9+json"

def vendo_headers(media_type):
    return {
        "Accept": media_type,
        "Content-Type": media_type,
        "Accept-Language": "de",
        "User-Agent": "DBNavigator/Android/26.9.0",
        "X-App-Version": "26.9.0",
        "X-Correlation-ID": f"{uuid.uuid4()}_{uuid.uuid4()}",
    }

# Location IDs in the Vendo format (same as bahn.de location format)
FRANKFURT_LOC = "A=1@O=Frankfurt(Main)Hbf@X=8665093@Y=50107097@U=80@L=8000105@"
HAMBURG_LOC = "A=1@O=Hamburg Hbf@X=10006909@Y=53552733@U=80@L=8002549@"

reiseDatum = datetime(2026, 9, 20, 10, 0, 0, tzinfo=timezone.utc).isoformat()

payload = {
    "autonomeReservierung": False,
    "einstiegsTypList": ["STANDARD"],
    "fahrverguenstigungen": {
        "deutschlandTicketVorhanden": False,
        "nurDeutschlandTicketVerbindungen": False,
    },
    "klasse": "KLASSE_2",
    "reiseHin": {"wunsch": {
        "abgangsLocationId": FRANKFURT_LOC,
        "alternativeHalteBerechnung": True,
        "verkehrsmittel": ["ALL"],
        "zeitWunsch": {
            "reiseDatum": reiseDatum,
            "zeitPunktArt": "ABFAHRT",
        },
        "zielLocationId": HAMBURG_LOC,
    }},
    "reisendenProfil": {"reisende": [{
        "ermaessigungen": ["KEINE_ERMAESSIGUNG KLASSENLOS"],
        "reisendenTyp": "ERWACHSENER",
    }]},
    "reservierungsKontingenteVorhanden": False,
}

print("=== 1. Vendo backend via HOME proxy ===")
try:
    r = requests.post(
        "https://app.services-bahn.de/mob/angebote/fahrplan",
        json=payload, headers=vendo_headers(media),
        impersonate="chrome", timeout=25,
        proxy=SOCKS5,
    )
    print(f"Status: {r.status_code}")
    d = r.json()
    if "status" in d and d["status"] == "ERROR":
        print(f"Error: {d.get('code')} ref={d.get('errorRefId','')}")
    else:
        conns = d.get("verbindungen", [])
        print(f"Connections: {len(conns)}")
        for c in conns[:5]:
            v = c.get("verbindung", {})
            segs = v.get("verbindungsAbschnitte", [])
            vm = segs[0].get("verkehrsmittel", {}) if segs else {}
            preis = c.get("angebote", {}).get("preise", {}).get("gesamt", {}).get("ab", {})
            print(f"  {vm.get('name','?')} | {preis.get('betrag','no price')} {preis.get('waehrung','')}")
except Exception as e:
    print(f"Exception: {e}")

print("\n=== 2. Vendo backend DIRECT (no proxy) ===")
try:
    r = requests.post(
        "https://app.services-bahn.de/mob/angebote/fahrplan",
        json=payload, headers=vendo_headers(media),
        impersonate="chrome", timeout=25,
    )
    print(f"Status: {r.status_code}")
    d = r.json()
    if "status" in d and d["status"] == "ERROR":
        print(f"Error: {d.get('code')} ref={d.get('errorRefId','')}")
    else:
        conns = d.get("verbindungen", [])
        print(f"Connections: {len(conns)}")
        for c in conns[:3]:
            v = c.get("verbindung", {})
            segs = v.get("verbindungsAbschnitte", [])
            vm = segs[0].get("verkehrsmittel", {}) if segs else {}
            preis = c.get("angebote", {}).get("preise", {}).get("gesamt", {}).get("ab", {})
            print(f"  {vm.get('name','?')} | {preis.get('betrag','no price')} {preis.get('waehrung','')}")
except Exception as e:
    print(f"Exception: {e}")
