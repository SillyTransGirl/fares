import requests
import os
import json
import sys

proxy_user = os.environ.get("OXYLABS_USER", "")
proxy_pass = os.environ.get("OXYLABS_PASS", "")
proxy = f"http://{proxy_user}:{proxy_pass}@unblock.oxylabs.io:60000"
proxies = {"http": proxy, "https": proxy}

headers = {
    "Content-Type": "application/json; charset=UTF-8",
    "Accept": "application/json",
    "X-Oxylabs-Geo-Location": "Germany",
    "Origin": "https://www.bahn.de",
    "Referer": "https://www.bahn.de/buchung/fahrplan/suche",
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
}

payload = {
    "abfahrtsHalt": "A=1@L=8000105@",
    "anfrageZeitpunkt": "2026-09-20T10:00:00",
    "ankunftsHalt": "A=1@L=8002549@",
    "ankunftSuche": "ABFAHRT",
    "klasse": "KLASSE_2",
    "produktgattungen": ["ICE", "EC_IC", "IR", "REGIONAL", "SBAHN"],
    "reisende": [{"typ": "ERWACHSENER", "ermaessigungen": [{"art": "KEINE_ERMAESSIGUNG", "klasse": "KLASSENLOS"}], "anzahl": 1, "alter": [30]}],
    "schnelleVerbindungen": True,
    "deutschlandTicketVorhanden": False,
}

try:
    r = requests.post(
        "https://www.bahn.de/web/api/angebote/fahrplan",
        json=payload, headers=headers, proxies=proxies, timeout=30,
        verify=False,
    )
    print(f"Status: {r.status_code}")
    d = r.json()
    if "status" in d and d["status"] == "ERROR":
        print(f"Error: {d.get('code')}")
    else:
        vb = d.get("verbindungen", [])
        print(f"Connections: {len(vb)}")
        for v in vb[:3]:
            vm = v.get("verbindungsAbschnitte", [{}])[0].get("verkehrsmittel", {})
            p = v.get("angebotsPreis", {})
            print(f"  {vm.get('name', '?')} | {p.get('betrag', 'no price')} {p.get('waehrung', '')}")
except Exception as e:
    print(f"Exception: {e}")
